// Conversation shaping, the part that touches the database and R2 (the decisions are in
// src/conversations.js, the byte work in src/audio/). Originals are never destroyed: they are hidden,
// and "undo" brings them back.

import { json, fail, uid } from '../http.js';
import { readRow } from '../db.js';
import { safeParse, diarizeToText } from '../text.js';
import { rebuildTranscript } from '../speakers.js';
import { deleteRecordingVectors } from '../vectors.js';
import { planShape, rebase, planMerge, shapeOptions } from '../conversations.js';
import { probeAudio, cutAudio, joinAudio, MAX_AUDIO_BYTES } from '../audio/index.js';

const MAX_JOIN_BYTES = 40 * 1024 * 1024; // inputs and output are both in memory

const COLS = `id, owner, title, created_at, duration_ms, r2_key, content_type, status, template, model, transcriber,
  area, area_source, src, lineage, status_at`;

// Text for a piece of a transcript: speaker-labelled turns when the segments carry speakers, else plain.
function pieceText(segments, speakers) {
  if (segments.length && segments.every((s) => s.speaker)) {
    return speakers.length ? rebuildTranscript(segments, speakers, '') : diarizeToText(segments);
  }
  return segments.map((s) => String(s.text || '').trim()).filter(Boolean).join(' ');
}

async function dropDerived(env, owner, id, vecChunks) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM facts WHERE recording_id = ? AND owner = ?').bind(id, owner),
  ]);
  try { await deleteRecordingVectors(env, id, vecChunks); } catch (e) { console.error('vector delete failed:', e?.message || e); }
}

/* ---------- after transcription: trim dead air, split different conversations ---------- */

// `rec` is the row being processed, `buf` its audio bytes (null if too big to hold), `segments` and
// `speakers` what transcription just produced. Returns null when nothing changes, else the new rows'
// ids (the original is hidden). Never throws for a plan it cannot carry out: it just leaves things alone.
export async function reshapeAfterTranscript(env, owner, rec, { segments, speakers, buf, tokensIn = 0, tokensOut = 0, keepStatus = false }) {
  const opts = shapeOptions(env);
  if (!opts.enabled || !segments?.length) return null;
  const probe = buf && buf.byteLength <= MAX_AUDIO_BYTES ? probeAudio(buf) : null;
  const duration = probe?.durationMs ?? (Number(rec.duration_ms) || null);
  const plan = planShape(segments, duration, opts);
  if (!plan) return null;
  const cuts = probe ? cutAudio(probe, plan.map((p) => ({ startMs: p.startMs, endMs: p.endMs }))) : null;
  // Without cuttable audio, trimming alone would only lose the recording's sound for nothing. A real
  // split still helps the summaries, so those pieces are kept as text and the original keeps its audio.
  if (!cuts && plan.length === 1) return null;

  const n = plan.length;
  const ids = plan.map(() => uid());
  const kind = n > 1 ? 'split' : 'trim';
  const written = [];
  try {
    if (cuts) {
      for (let i = 0; i < n; i++) {
        await env.AUDIO.put(`rec/${ids[i]}`, cuts[i].data, { httpMetadata: { contentType: cuts[i].contentType } });
        written.push(`rec/${ids[i]}`);
      }
    }
    const stmts = [];
    plan.forEach((piece, i) => {
      const segs = rebase(piece.segments, piece.startMs);
      const used = new Set(segs.map((s) => s.speaker));
      const sp = (speakers || []).filter((s) => used.has(s.label));
      const text = pieceText(segs, sp);
      const title = n > 1 ? `${rec.title} (${i + 1}/${n})` : rec.title;
      stmts.push(env.DB.prepare(
        `INSERT INTO recordings (id, owner, title, created_at, duration_ms, r2_key, content_type, status, template, model,
                                 transcriber, transcript, segments, speakers, tokens_in, tokens_out, area, area_source, src,
                                 lineage, status_at)
         VALUES (?,?,?,?,?,?,?,'transcribed',?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        ids[i], owner, title, Number(rec.created_at) + piece.startMs,
        cuts ? cuts[i].durationMs : piece.endMs - piece.startMs,
        cuts ? `rec/${ids[i]}` : '', cuts ? cuts[i].contentType : (rec.content_type || 'audio/webm'),
        rec.template, rec.model, rec.transcriber, text, JSON.stringify(segs), JSON.stringify(sp),
        i === 0 ? tokensIn : 0, i === 0 ? tokensOut : 0, rec.area || 'work', rec.area_source || 'auto', rec.src || null,
        JSON.stringify({ kind, from: [rec.id], part: i + 1, of: n, trimmed: { startMs: piece.startMs, endMs: piece.endMs }, audio: Boolean(cuts) }),
        Date.now(),
      ));
      stmts.push(env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(ids[i], title, text));
    });
    stmts.push(keepStatus
      ? env.DB.prepare('UPDATE recordings SET hidden = 1 WHERE id = ? AND owner = ?').bind(rec.id, owner)
      : env.DB.prepare("UPDATE recordings SET hidden = 1, status = 'transcribed', status_at = ? WHERE id = ? AND owner = ?").bind(Date.now(), rec.id, owner));
    await env.DB.batch(stmts);
  } catch (e) {
    for (const k of written) await env.AUDIO.delete(k).catch(() => {});
    console.error('reshape failed, keeping the recording as it was:', e?.message || e);
    return null;
  }
  await dropDerived(env, owner, rec.id, rec.vec_chunks);
  return ids;
}

/* ---------- merging pieces of one call ---------- */

// Joins the audio of `rows` (oldest first, all with audio) into one new recording waiting to be
// transcribed; the rows are hidden. Returns the new id, or null if the audio cannot be joined.
export async function mergeRows(env, owner, rows) {
  if (rows.length < 2) return null;
  const probes = [];
  let bytes = 0;
  for (const r of rows) {
    const o = await env.AUDIO.get(r.r2_key);
    if (!o) return null;
    bytes += o.size || 0;
    if (bytes > MAX_JOIN_BYTES) return null;
    const p = probeAudio(await o.arrayBuffer());
    if (!p) return null;
    probes.push(p);
  }
  const joined = joinAudio(probes);
  if (!joined) return null;

  const id = uid();
  const first = rows[0];
  const key = `rec/${id}`;
  let at = 0;
  const parts = rows.map((r, i) => { const part = { id: r.id, startMs: at, durationMs: probes[i].durationMs }; at += probes[i].durationMs; return part; });
  await env.AUDIO.put(key, joined.data, { httpMetadata: { contentType: joined.contentType } });
  try {
    const stmts = [
      env.DB.prepare(
        `INSERT INTO recordings (id, owner, title, created_at, duration_ms, r2_key, content_type, status, template, model,
                                 transcriber, area, area_source, src, lineage, status_at)
         VALUES (?,?,?,?,?,?,?,'uploaded',?,?,?,?,?,?,?,?)`
      ).bind(
        id, owner, first.title, first.created_at, joined.durationMs, key, joined.contentType,
        first.template, first.model, first.transcriber, first.area || 'work', first.area_source || 'auto', first.src || null,
        JSON.stringify({ kind: 'merge', from: rows.map((r) => r.id), parts }), Date.now(),
      ),
      ...rows.map((r) => env.DB.prepare('UPDATE recordings SET hidden = 1 WHERE id = ? AND owner = ?').bind(r.id, owner)),
    ];
    await env.DB.batch(stmts);
  } catch (e) {
    await env.AUDIO.delete(key).catch(() => {});
    throw e;
  }
  for (const r of rows) if (r.transcript || r.vec_chunks) await dropDerived(env, owner, r.id, r.vec_chunks);
  return id;
}

// Merges every run of untranscribed pieces from one source that are really one call. Returns
// Map(absorbed id -> new id) so a caller can follow the ids it was holding.
export async function consolidate(env, owner) {
  const opts = shapeOptions(env);
  const moved = new Map();
  if (!opts.enabled) return moved;
  const rows = (await env.DB.prepare(
    `SELECT ${COLS} FROM recordings WHERE owner = ? AND status = 'uploaded' AND hidden = 0 AND src IS NOT NULL
      ORDER BY created_at DESC LIMIT 300`
  ).bind(owner).all()).results || [];
  for (const group of planMerge(rows, opts)) {
    try {
      const id = await mergeRows(env, owner, group);
      if (id) for (const r of group) moved.set(r.id, id);
    } catch (e) { console.error('merge failed, leaving the pieces as they are:', e?.message || e); }
  }
  return moved;
}

// POST /api/recordings/merge {ids}: join recordings you say are one call, even if already transcribed.
// The joined audio is transcribed again from scratch (speakers are worked out across the whole call).
export async function mergeNow(request, env, owner) {
  const body = await request.json().catch(() => null);
  const ids = [...new Set(Array.isArray(body?.ids) ? body.ids.map(String) : [])];
  if (ids.length < 2 || ids.length > 12) return fail('ids: 2 to 12 recordings');
  const rows = [];
  for (const id of ids) {
    const r = await env.DB.prepare(`SELECT ${COLS}, transcript, vec_chunks, hidden FROM recordings WHERE id = ? AND owner = ?`).bind(id, owner).first();
    if (!r) return fail('not found', 404);
    if (r.hidden) return fail('that recording was already merged or split; undo that first', 409);
    if (!r.r2_key) return fail(`"${r.title}" has no audio to join`, 409);
    if (['recording', 'processing'].includes(r.status)) return fail(`"${r.title}" is still ${r.status}`, 409);
    rows.push(r);
  }
  rows.sort((a, b) => a.created_at - b.created_at);
  const newId = await mergeRows(env, owner, rows);
  if (!newId) return fail('these recordings cannot be joined (different or unsupported audio formats, or too large)', 422);
  return json({ id: newId });
}

/* ---------- undo ---------- */

// POST /api/recordings/:id/undo-reshape: works from either side (the new recording or a hidden original).
// Undoing a merge unwinds all the way back to the original pieces (pieces are joined one at a time, so
// the last merge is usually a merge of a merge), and marks them so they are not joined again.
export async function undoReshape(env, owner, id) {
  const out = await undoCore(env, owner, id);
  return out.error ? fail(out.error, out.status) : json({ ok: true, restored: out.restored });
}

async function undoCore(env, owner, id) {
  const row = await env.DB.prepare('SELECT id, hidden, lineage FROM recordings WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!row) return { error: 'not found', status: 404 };
  // Asked on a new recording: its sources are in its lineage. Asked on a hidden original: find the
  // recordings made from it (a merge lists several originals, so take the whole set from there).
  let sourceIds = new Set(row.lineage ? safeParse(row.lineage)?.from || [] : []);
  const cand = (await env.DB.prepare(`SELECT id, hidden, lineage, r2_key, vec_chunks FROM recordings WHERE owner = ? AND lineage LIKE ?`)
    .bind(owner, `%"${[...sourceIds][0] || id}"%`).all()).results || [];
  if (!sourceIds.size) {
    const made = cand.find((c) => (safeParse(c.lineage)?.from || []).includes(id));
    sourceIds = new Set(made ? safeParse(made.lineage).from : [id]);
  }
  const derived = cand.filter((c) => {
    const from = safeParse(c.lineage)?.from || [];
    return from.length === sourceIds.size && from.every((f) => sourceIds.has(f));
  });
  if (!derived.length) return { error: 'nothing to undo', status: 404 };
  if (derived.some((d) => d.hidden)) return { error: 'a later change was made on top of this; undo that one first', status: 409 };
  const wasMerge = safeParse(derived[0].lineage)?.kind === 'merge';

  for (const d of derived) {
    await dropDerived(env, owner, d.id, d.vec_chunks);
    await env.DB.prepare('DELETE FROM recordings WHERE id = ? AND owner = ?').bind(d.id, owner).run();
    if (d.r2_key) await env.AUDIO.delete(d.r2_key).catch(() => {});
  }
  let restored = [];
  for (const sid of sourceIds) {
    const s = await env.DB.prepare('SELECT id, title, transcript, summary, status, lineage FROM recordings WHERE id = ? AND owner = ?').bind(sid, owner).first();
    if (!s) continue;
    // facts_at / vec_chunks back to empty: the memory catch-up re-extracts them for a summarized original.
    // After undoing a merge, src is cleared so the automatic merge does not put the pieces back together.
    await env.DB.prepare(`UPDATE recordings SET hidden = 0, facts_at = NULL, vec_chunks = 0${wasMerge ? ', src = NULL' : ''} WHERE id = ? AND owner = ?`).bind(sid, owner).run();
    // (shaping used to leave a summarized original at 'transcribed', which reads as "Processing")
    if (s.status === 'transcribed' && s.summary) await env.DB.prepare("UPDATE recordings SET status = 'ready' WHERE id = ? AND owner = ?").bind(sid, owner).run();
    if (s.transcript) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(sid),
        env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(sid, s.title, s.transcript),
      ]);
    }
    if (wasMerge && safeParse(s.lineage)?.kind === 'merge') {
      const deeper = await undoCore(env, owner, sid); // a merge of merges: unwind it too
      restored = restored.concat(deeper.restored || [sid]);
    } else restored.push(sid);
  }
  return { restored };
}
