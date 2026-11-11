// Speaker naming, layer 1 (#4): the `people` memory nameSpeakers() reads for context,
// plus the confirm-a-chip PATCH that turns an inferred-or-unknown label into a name a
// human actually vouched for. That PATCH is the only path that sets confirmed:true.

import { json, fail, uid } from '../http.js';
import { readRow } from '../db.js';
import { rebuildTranscript } from '../speakers.js';
import { suggestMerges, renameSpeaker, mergeAliases } from '../people.js';
import { safeParse } from '../text.js';
import { VOICE_MODEL } from '../config.js';
import { normalizeEmbedding, MIN_VOICEPRINT_MS, MAX_VOICEPRINT_MS, MAX_VOICEPRINT_BYTES, wavDurationMs } from '../voiceprints.js';

export async function listPeople(env, owner) {
  // voiceprint_count (#14) is a plain LEFT JOIN count, not selectVoiceprints() --
  // this is "how many clips does this person have", not "which clips go on the wire".
  const rows = (await env.DB.prepare(
    `SELECT people.id, people.name, people.aliases, people.notes, people.created_at,
            COUNT(voiceprints.id) AS voiceprint_count
       FROM people LEFT JOIN voiceprints
         ON voiceprints.person_id = people.id AND voiceprints.owner = people.owner
      WHERE people.owner = ?
      GROUP BY people.id
      ORDER BY people.name`
  ).bind(owner).all()).results;
  // How many recordings each person is named in, and likely duplicates to offer merging.
  const recs = (await env.DB.prepare('SELECT id, speakers FROM recordings WHERE owner = ?').bind(owner).all()).results || [];
  const counts = new Map();
  for (const r of recs) {
    for (const name of new Set((safeParse(r.speakers) || []).map((x) => x?.name).filter(Boolean))) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const people = rows.map((p) => ({ ...p, recordings: counts.get(p.name) || 0 }));
  return json({ people, suggestions: suggestMerges(people) });
}

// Upsert on (owner, name): confirming the same name twice (e.g. across recordings)
// should not create duplicate people rows.
export async function createPerson(request, env, owner) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return fail('name required');
  const aliases = body.aliases ? String(body.aliases).trim() : null;
  const notes = body.notes ? String(body.notes).trim() : null;

  const existing = await env.DB.prepare('SELECT id FROM people WHERE owner = ? AND name = ?')
    .bind(owner, name).first();
  const id = existing?.id || uid();
  await env.DB.prepare(
    `INSERT INTO people (id, owner, name, aliases, notes, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(owner, name) DO UPDATE SET aliases = COALESCE(excluded.aliases, people.aliases),
                                            notes = COALESCE(excluded.notes, people.notes)`
  ).bind(id, owner, name, aliases, notes, Date.now()).run();
  return json({ id, name, aliases, notes });
}

// PATCH /api/recordings/:id/speakers: {label, name}. `label` is the raw diarizer
// label (the same one nameSpeakers()/applySpeakerNames() use), not the "Unknown N"
// text the UI displays -- the chip carries it in a data attribute for this reason.
export async function confirmSpeaker(request, env, owner, id) {
  const body = await request.json().catch(() => ({}));
  const label = String(body.label || '');
  const name = String(body.name || '').trim();
  if (!label || !name) return fail('label and name required');
  if (name.length > 80 || /^(unknown|speaker)\s*\d*$/i.test(name)) return fail('that is not a usable name');

  const rec = await readRow(env, id, owner);
  if (!rec) return fail('not found', 404);
  if (!(rec.speakers || []).some((s) => s.label === label)) return fail('no such speaker on this recording', 404);

  const existing = await env.DB.prepare('SELECT id FROM people WHERE owner = ? AND name = ?')
    .bind(owner, name).first();
  await env.DB.prepare(
    `INSERT INTO people (id, owner, name, created_at) VALUES (?,?,?,?)
     ON CONFLICT(owner, name) DO NOTHING`
  ).bind(existing?.id || uid(), owner, name, Date.now()).run();

  // A human vouched for this one label -- every other label's name/evidence is
  // untouched, confirmed stays whatever it already was for them.
  const speakers = (rec.speakers || []).map((s) =>
    s.label === label ? { ...s, name, confirmed: true } : s);
  const transcript = rebuildTranscript(rec.segments, speakers, rec.transcript);

  await env.DB.batch([
    env.DB.prepare('UPDATE recordings SET speakers = ?, transcript = ? WHERE id = ? AND owner = ?')
      .bind(JSON.stringify(speakers), transcript, id, owner),
    env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
    env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)')
      .bind(id, rec.title, transcript),
  ]);
  return json(await readRow(env, id, owner));
}

/* --- #14 voiceprint enrollment --- */
// POST /api/people/:id/voiceprint: multipart `file`, a 2-10s WAV clip (the browser
// builds it via decodeAudioData + encodeWav -- see public/index.html). Duration is
// read from the WAV header itself, not trusted from the client, with the posted
// `duration_ms` field only as a fallback if the header cannot be parsed.
export async function enrollVoiceprint(request, env, owner, personId) {
  const person = await env.DB.prepare('SELECT id, name FROM people WHERE id = ? AND owner = ?')
    .bind(personId, owner).first();
  if (!person) return fail('person not found', 404);

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('file field required');

  // A voiceprint is only as good as the name behind it: enroll only from a speaker a human
  // confirmed on a recording this owner has, never from an inferred or voice-matched label.
  const rec = await readRow(env, String(form.get('recording_id') || ''), owner);
  const sp = (rec?.speakers || []).find((s) => s.label === String(form.get('label') || ''));
  if (!sp?.confirmed || sp.name !== person.name) return fail('only a confirmed speaker can be enrolled', 403);
  if (file.size > MAX_VOICEPRINT_BYTES) return fail(`voiceprint clip must be under ${MAX_VOICEPRINT_BYTES / 1024}KB`, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const durationMs = wavDurationMs(bytes) ?? (Number(form.get('duration_ms')) || null);
  if (!durationMs || durationMs < MIN_VOICEPRINT_MS || durationMs > MAX_VOICEPRINT_MS) {
    return fail(`voiceprint clip must be ${MIN_VOICEPRINT_MS / 1000}-${MAX_VOICEPRINT_MS / 1000}s, got ${durationMs ? Math.round(durationMs / 1000) + 's' : 'unknown length'}`);
  }

  const id = uid();
  const key = `vp/${personId}/${uid()}`;
  await env.AUDIO.put(key, bytes, { httpMetadata: { contentType: 'audio/wav' } });
  // Optional local embedding (#24), made in the browser. Ignored unless it is for the model
  // this deploy matches with; the backfill in the browser fills in a missing one later.
  let embedding = null;
  if (String(form.get('embedding_model') || '') === VOICE_MODEL) {
    let arr; try { arr = JSON.parse(String(form.get('embedding') || '')); } catch { arr = null; }
    const n = normalizeEmbedding(arr);
    if (n) embedding = JSON.stringify(roundVec(n));
  }
  await env.DB.prepare(
    'INSERT INTO voiceprints (id, owner, person_id, r2_key, duration_ms, created_at, embedding, embedding_model) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, owner, personId, key, durationMs, Date.now(), embedding, embedding ? VOICE_MODEL : null).run();

  const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM voiceprints WHERE person_id = ? AND owner = ?')
    .bind(personId, owner).first();
  return json({ id, duration_ms: durationMs, voiceprint_count: count });
}

// DELETE /api/voiceprints/:id: owner-scoped, R2 object first so a crash between the
// two never leaves a D1 row pointing at audio that is already gone.
export async function deleteVoiceprint(env, owner, id) {
  const vp = await env.DB.prepare('SELECT r2_key FROM voiceprints WHERE id = ? AND owner = ?')
    .bind(id, owner).first();
  if (!vp) return fail('not found', 404);
  await env.AUDIO.delete(vp.r2_key);
  await env.DB.prepare('DELETE FROM voiceprints WHERE id = ? AND owner = ?').bind(id, owner).run();
  return json({ ok: true });
}

// DELETE /api/people/:id/voiceprints: forget every enrolled clip for one person, the
// recovery path for a bad enrollment.
export async function clearVoiceprints(env, owner, personId) {
  const rows = (await env.DB.prepare('SELECT id, r2_key FROM voiceprints WHERE person_id = ? AND owner = ?')
    .bind(personId, owner).all()).results;
  for (const r of rows) await env.AUDIO.delete(r.r2_key);
  await env.DB.prepare('DELETE FROM voiceprints WHERE person_id = ? AND owner = ?').bind(personId, owner).run();
  return json({ ok: true, removed: rows.length });
}
/* --- /#14 voiceprint enrollment --- */

/* --- #24 provider-independent voice matching --- */
const roundVec = (v) => Array.from(v, (x) => Math.round(x * 1e6) / 1e6);

// GET /api/voiceprints: which enrolled clips already have an embedding for the current model.
export async function listVoiceprints(env, owner) {
  const rows = (await env.DB.prepare(
    `SELECT voiceprints.id AS id, voiceprints.person_id AS person_id, people.name AS name,
            voiceprints.embedding_model AS embedding_model
       FROM voiceprints JOIN people ON people.id = voiceprints.person_id
      WHERE voiceprints.owner = ? AND people.owner = ?
      ORDER BY voiceprints.created_at`
  ).bind(owner, owner).all()).results || [];
  const voiceprints = rows.map((r) => ({
    id: r.id, person_id: r.person_id, name: r.name, has_embedding: r.embedding_model === VOICE_MODEL,
  }));
  return json({ model: VOICE_MODEL, voiceprints, embedded_count: voiceprints.filter((v) => v.has_embedding).length });
}

// GET /api/voiceprints/:id/audio: the enrolled WAV, so the browser can backfill its embedding.
export async function voiceprintAudio(env, owner, id) {
  const vp = await env.DB.prepare('SELECT r2_key FROM voiceprints WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!vp) return fail('not found', 404);
  const obj = await env.AUDIO.get(vp.r2_key);
  if (!obj) return fail('audio missing', 404);
  return new Response(obj.body, { headers: { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=3600' } });
}

// PUT /api/voiceprints/:id/embedding {model, embedding}
export async function putVoiceprintEmbedding(request, env, owner, id) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail('bad request');
  if (body.model !== VOICE_MODEL) return fail(`voice model must be ${VOICE_MODEL}`);
  const n = normalizeEmbedding(body.embedding);
  if (!n) return fail('bad embedding');
  const vp = await env.DB.prepare('SELECT id FROM voiceprints WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!vp) return fail('not found', 404);
  await env.DB.prepare('UPDATE voiceprints SET embedding = ?, embedding_model = ? WHERE id = ? AND owner = ?')
    .bind(JSON.stringify(roundVec(n)), VOICE_MODEL, id, owner).run();
  return json({ ok: true });
}
/* --- /#24 provider-independent voice matching --- */

// Statements that rename `from` to `to` in every recording's speakers and transcript (search
// index refreshed, vec_chunks cleared so the scheduled run re-indexes the passages that quote
// the old name). Names are the join key between people and recordings.
async function renameInRecordings(env, owner, fromName, toName) {
  const recs = (await env.DB.prepare(
    'SELECT id, title, speakers, segments, transcript, vec_chunks FROM recordings WHERE owner = ?'
  ).bind(owner).all()).results || [];
  const stmts = [];
  let renamed = 0;
  for (const r of recs) {
    const { speakers, changed } = renameSpeaker(safeParse(r.speakers) || [], fromName, toName);
    if (!changed) continue;
    renamed++;
    const transcript = rebuildTranscript(safeParse(r.segments), speakers, r.transcript);
    stmts.push(
      env.DB.prepare('UPDATE recordings SET speakers = ?, transcript = ?, vec_chunks = ? WHERE id = ? AND owner = ?')
        .bind(JSON.stringify(speakers), transcript, null, r.id, owner),
      env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(r.id),
      env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(r.id, r.title, transcript),
    );
  }
  return { stmts, renamed };
}

// PATCH /api/people/:id {name}: rename a person everywhere (recordings, transcripts, remembered
// facts). It is a correction, not a merge: the old name is NOT kept as an alias, because it was
// wrong. If another person already has the new name, that is a merge, so it is refused.
export async function renamePerson(request, env, owner, id) {
  const body = await request.json().catch(() => null);
  const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return fail('name required');
  if (name.length > 80 || /^(unknown|speaker)\s*\d*$/i.test(name)) return fail('that is not a usable name');
  const person = await env.DB.prepare('SELECT id, name FROM people WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!person) return fail('person not found', 404);
  if (person.name === name) return json({ ok: true, id, name, recordings_updated: 0 });
  const all = (await env.DB.prepare('SELECT id, name FROM people WHERE owner = ?').bind(owner).all()).results || [];
  const clash = all.find((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase());
  if (clash) return fail(`“${name}” is already someone else in People. To combine them, merge them instead.`, 409);

  const { stmts, renamed } = await renameInRecordings(env, owner, person.name, name);
  stmts.push(
    env.DB.prepare('UPDATE facts SET person = ? WHERE owner = ? AND person = ?').bind(name, owner, person.name),
    env.DB.prepare('UPDATE people SET name = ? WHERE id = ? AND owner = ?').bind(name, id, owner),
  );
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return json({ ok: true, id, name, recordings_updated: renamed });
}

// POST /api/people/merge {from_id, into_id}: fold one person into another. Renames them in
// every recording (speakers and transcript, search index refreshed), moves their saved voice
// samples and remembered facts, keeps the old name as an alias, deletes the old person.
// Names are the join key between people and recordings, so this is the only way to keep
// them consistent. It cannot be undone, and the UI says so.
export async function mergePeople(request, env, owner) {
  const body = await request.json().catch(() => null);
  const fromId = String(body?.from_id || ''), intoId = String(body?.into_id || '');
  if (!fromId || !intoId || fromId === intoId) return fail('from_id and into_id required, and different');
  const from = await env.DB.prepare('SELECT id, name, aliases, notes FROM people WHERE id = ? AND owner = ?').bind(fromId, owner).first();
  const into = await env.DB.prepare('SELECT id, name, aliases, notes FROM people WHERE id = ? AND owner = ?').bind(intoId, owner).first();
  if (!from || !into) return fail('person not found', 404);

  const { stmts, renamed } = await renameInRecordings(env, owner, from.name, into.name);
  stmts.push(
    env.DB.prepare('UPDATE facts SET person = ? WHERE owner = ? AND person = ?').bind(into.name, owner, from.name),
    env.DB.prepare('UPDATE voiceprints SET person_id = ? WHERE owner = ? AND person_id = ?').bind(into.id, owner, from.id),
    env.DB.prepare('UPDATE people SET aliases = ?, notes = ? WHERE id = ? AND owner = ?')
      .bind(mergeAliases(into.aliases, [from.name, ...String(from.aliases || '').split(',')], into.name) || null,
        into.notes || from.notes || null, into.id, owner),
    env.DB.prepare('DELETE FROM people WHERE id = ? AND owner = ?').bind(from.id, owner),
  );
  // D1 batches are atomic; keep each under a safe size by splitting on recording boundaries.
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return json({ ok: true, into: { id: into.id, name: into.name }, recordings_updated: renamed });
}
