// Recording lifecycle: upload -> transcribe -> summarize -> read/delete.

import { llmFetch, sttFetch, sttUrl, withRateLimitRetry } from '../llm.js';
import { sttDiarizes, openRouterSegments, localSegments, usesOpenRouterStt } from '../stt.js';
import { jsonAudioBody, base64Length, withLength } from '../stream.js';
import { MAX_UPLOAD, MIN_SEGMENTS_FOR_TURNS, contextChars, localDiarize, maxUpload, modelById, transcriberById, previewTranscriber, defaultModel, effectiveTranscriber } from '../config.js';
import { json, fail, uid, ownerOf } from '../http.js';
import { readRow, resolveTemplate } from '../db.js';
import { diarizeToText, parseJsonLoose, STALE_PROCESSING_MS } from '../text.js';
import { buildSystemPrompt } from '../prompts.js';
import { guardOn, cleanText, cleanSegments } from '../hallucination.js';
import { nameSpeakers, rebuildTranscript, anonymousSpeakers, reassignSegments } from '../speakers.js';
import { selectVoiceprints, speakerRefsForm, matchedSpeakerRefs, normalizeEmbedding, matchVoices, applyVoiceMatches } from '../voiceprints.js';
import { VOICE_MODEL } from '../config.js';
import { normalizeFacts } from '../memory.js';
import { saveFacts, loadFacts } from './memory.js';
import { indexRecording, deleteRecordingVectors } from '../vectors.js';

/* --- #7 live transcription --- */
const MAX_LIVE_CHUNK = 2 * 1024 * 1024; // 5s of audio/webm is well under this
/* --- /#7 live transcription --- */

const partsPrefix = (id) => `rec/${id}.parts/`;
const pad = (n) => String(n).padStart(6, '0');

export async function upload(request, env, owner = ownerOf(request)) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('file field required');
  if (file.size > maxUpload(env)) return fail(`audio must be under ${maxUpload(env) / 1048576}MB`, 413);

  // Device apps (the pendant) upload from an outbox that retries, so a repeat of the same ingest_id
  // answers with the row it already made instead of creating a second copy.
  const ingestId = String(form.get('ingest_id') || '').trim().slice(0, 120) || null;
  if (ingestId) {
    const dup = await env.DB.prepare('SELECT id FROM recordings WHERE owner = ? AND ingest_id = ?').bind(owner, ingestId).first();
    if (dup) return json({ id: dup.id, duplicate: true });
  }
  // When it was actually captured (a drained pendant recording is hours old). Only believed if it is
  // plausible: after 2020 and not in the future.
  const cap = Number(form.get('created_at'));
  const createdAt = cap > 1577836800000 && cap < Date.now() + 60000 ? Math.round(cap) : Date.now();

  const id = uid();
  const key = `rec/${id}`;
  await env.AUDIO.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'audio/webm' },
  });
  const templateKey = String(form.get('template') || '');
  const resolvedTemplate = await resolveTemplate(env, owner, templateKey);
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO recordings (id, owner, title, created_at, duration_ms, r2_key, content_type,
                             status, template, model, transcriber, ingest_id)
     VALUES (?,?,?,?,?,?,?,'uploaded',?,?,?,?)`
  ).bind(
    id, owner,
    String(form.get('title') || '').trim() || 'Untitled recording',
    createdAt,
    Number(form.get('duration_ms')) || null,
    key, file.type || 'audio/webm',
    resolvedTemplate ? templateKey : 'meeting',
    modelById(form.get('model'), env)?.id || null,
    transcriberById(form.get('transcriber'), env).id,
    ingestId,
  ).run();
  if (ins?.meta?.changes === 0) { // two retries raced: keep the first, drop this audio
    await env.AUDIO.delete(key);
    const first = await env.DB.prepare('SELECT id FROM recordings WHERE owner = ? AND ingest_id = ?').bind(owner, ingestId).first();
    return json({ id: first?.id, duplicate: true });
  }
  return json({ id });
}

/* --- #7 live transcription --- */
// Creates the recording row before any audio exists, so chunks posted while still
// talking have somewhere to append their text. r2_key is reserved up front (same
// shape as upload()'s) even though /audio does not write to it until the stop.
export async function liveStart(request, env, owner) {
  const body = await request.json().catch(() => ({}));
  const id = uid();
  const templateKey = String(body.template || '');
  const resolvedTemplate = await resolveTemplate(env, owner, templateKey);
  await env.DB.prepare(
    `INSERT INTO recordings (id, owner, title, created_at, r2_key, content_type,
                             status, template, model, transcriber, live_transcript, status_at)
     VALUES (?,?,?,?,?,?,'recording',?,?,?,'',?)`
  ).bind(
    id, owner,
    String(body.title || '').trim() || 'Untitled recording',
    Date.now(),
    `rec/${id}`, 'audio/webm',
    resolvedTemplate ? templateKey : 'meeting',
    modelById(body.model, env)?.id || null,
    transcriberById(body.transcriber, env).id,
    Date.now(),
  ).run();
  return json({ id });
}

// One standalone preview chunk (the client restarts a short-lived MediaRecorder per
// chunk so each blob is a complete webm), transcribed alone with the gpt-transcribe model --
// no diarization, this is a preview, not the record of truth. 404s for anything not
// owned or no longer status='recording' in one query. The append is a single SQL
// statement so two racing chunks cannot overwrite each other's text.
export async function liveChunk(request, env, owner, id) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_LIVE_CHUNK) return fail('chunk too large', 413);

  const rec = await env.DB.prepare(
    "SELECT id FROM recordings WHERE id = ? AND owner = ? AND status = 'recording'"
  ).bind(id, owner).first();
  if (!rec) return fail('not found', 404);

  const fd = new FormData();
  fd.append('file', new File([buf], 'chunk.webm', { type: 'audio/webm' }));
  fd.append('model', previewTranscriber(env));
  fd.append('response_format', 'json');
  const tr = await sttFetch(env, fd);
  if (!tr.ok) return fail(`transcribe ${tr.status}: ${(await tr.text()).slice(0, 300)}`, 502);
  const text = ((await tr.json()).text || '').trim();
  if (text) {
    await env.DB.prepare(
      `UPDATE recordings SET status_at = ?, live_transcript = substr(
         CASE WHEN coalesce(live_transcript, '') = '' THEN ? ELSE live_transcript || ' ' || ? END, -20000)
       WHERE id = ? AND owner = ? AND status = 'recording'`
    ).bind(Date.now(), text, text, id, owner).run();
  }
  const row = await env.DB.prepare('SELECT live_transcript FROM recordings WHERE id = ? AND owner = ?')
    .bind(id, owner).first();
  return json({ live_transcript: row?.live_transcript || '' });
}

// POST /:id/part?n=N: one 5s slice of the REAL recording, stored as it arrives. The
// slices of a single MediaRecorder timeslice stream concatenate into a valid webm, so if
// the tab dies, /recover can rebuild the audio from them instead of losing the meeting.
export async function livePart(request, env, owner, id) {
  const nRaw = new URL(request.url).searchParams.get('n');
  const n = nRaw === null || nRaw === '' ? NaN : Number(nRaw);
  if (!Number.isInteger(n) || n < 0 || n > 999999) return fail('n required');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_LIVE_CHUNK) return fail('chunk too large', 413);
  const res = await env.DB.prepare(
    "UPDATE recordings SET status_at = ? WHERE id = ? AND owner = ? AND status = 'recording'"
  ).bind(Date.now(), id, owner).run();
  if (res?.meta?.changes === 0) return fail('not found', 404);
  await env.AUDIO.put(`${partsPrefix(id)}${pad(n)}`, buf);
  return json({ ok: true });
}

async function deleteParts(env, id) {
  const listed = await env.AUDIO.list?.({ prefix: partsPrefix(id) });
  const keys = (listed?.objects || []).map((o) => o.key);
  for (const k of keys) await env.AUDIO.delete(k);
}

// POST /:id/recover: rebuild rec/<id> from the stored parts of an interrupted recording
// and mark it 'uploaded' so the normal process flow can take over.
export async function liveRecover(env, owner, id) {
  const rec = await env.DB.prepare(
    "SELECT id FROM recordings WHERE id = ? AND owner = ? AND status = 'recording'"
  ).bind(id, owner).first();
  if (!rec) return fail('not found', 404);
  const listed = await env.AUDIO.list({ prefix: partsPrefix(id) });
  const keys = (listed?.objects || []).map((o) => o.key).sort();
  if (!keys.length) return fail('no audio was saved for this recording', 404);

  const chunks = [];
  let total = 0;
  for (const k of keys) {
    const obj = await env.AUDIO.get(k);
    if (!obj) continue;
    const b = new Uint8Array(await obj.arrayBuffer());
    if (total + b.length > maxUpload(env)) break;
    chunks.push(b); total += b.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  const key = `rec/${id}`;
  await env.AUDIO.put(key, out, { httpMetadata: { contentType: 'audio/webm' } });
  await env.DB.prepare(
    "UPDATE recordings SET r2_key = ?, content_type = 'audio/webm', status = 'uploaded', status_at = ? WHERE id = ? AND owner = ?"
  ).bind(key, Date.now(), id, owner).run();
  await deleteParts(env, id);
  return json({ id });
}

// Finalizes the row liveStart() created: the full-length blob replaces whatever the
// parts were built from. Only a row still at status='recording' can be finalized, so a
// stale or retried PUT can never overwrite a recording that is processing or ready.
export async function liveAudio(request, env, owner, id) {
  const rec = await env.DB.prepare(
    "SELECT id FROM recordings WHERE id = ? AND owner = ? AND status = 'recording'"
  ).bind(id, owner).first();
  if (!rec) return fail('not found', 404);

  if (Number(request.headers.get('content-length')) > maxUpload(env)) {
    return fail(`audio must be under ${maxUpload(env) / 1048576}MB`, 413);
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxUpload(env)) return fail(`audio must be under ${maxUpload(env) / 1048576}MB`, 413);
  const contentType = request.headers.get('content-type') || 'audio/webm';
  const key = `rec/${id}`;
  await env.AUDIO.put(key, buf, { httpMetadata: { contentType } });

  const durationMs = Number(new URL(request.url).searchParams.get('duration_ms')) || null;
  await env.DB.prepare(
    "UPDATE recordings SET r2_key = ?, content_type = ?, duration_ms = ?, status = 'uploaded', status_at = ? WHERE id = ? AND owner = ? AND status = 'recording'"
  ).bind(key, contentType, durationMs, Date.now(), id, owner).run();
  await deleteParts(env, id);
  return json({ id });
}
/* --- /#7 live transcription --- */

const httpError = (message, status) => Object.assign(new Error(message), { status });

const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };

// Over the 25MB multipart cap (OpenRouter only): stream R2 -> base64 -> JSON `input_audio`,
// never holding the file in memory. Same diarize + fallback behaviour as the small path.
async function transcribeBig(env, rec) {
  const model = rec.transcriber;
  const format = AUDIO_EXT[(rec.content_type || '').split(';')[0]] || 'webm';
  const send = async (diarize) => {
    const obj = await env.AUDIO.get(rec.r2_key);
    if (!obj) throw new Error('audio object missing from R2');
    const meta = { model, response_format: diarize ? 'verbose_json' : 'json',
      ...(diarize ? { diarize: true, timestamp_granularities: ['word', 'segment'] } : {}) };
    const head = JSON.stringify(meta).slice(0, -1) + `,"input_audio":{"format":"${format}","data":"`;
    const tail = '"}}';
    const body = withLength(jsonAudioBody(obj.body, head, tail),
      new TextEncoder().encode(head + tail).length + base64Length(obj.size));
    return fetch(sttUrl(env), {
      method: 'POST', headers: { authorization: `Bearer ${env.STT_API_KEY || env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body,
    });
  };
  const sendRetrying = (diarize) => withRateLimitRetry(() => send(diarize));
  const boom = async (r) => { throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 300)}`); };
  if (sttDiarizes(env, model)) {
    let r = await sendRetrying(true);
    if (r.ok) {
      const tj = await r.json();
      const segments = openRouterSegments(tj);
      return segments.length ? { tj: { ...tj, segments }, sent: [], diarized: true } : { tj, sent: [], diarized: false };
    }
    if (r.status < 400 || r.status >= 500 || r.status === 429) await boom(r);
    console.error('diarize rejected on large file, retrying without:', r.status, (await r.text()).slice(0, 300));
  }
  const r = await sendRetrying(false);
  if (!r.ok) await boom(r);
  return { tj: await r.json(), sent: [], diarized: false };
}

async function transcribe(env, rec, buf, refs) {
  rec = { ...rec, transcriber: effectiveTranscriber(env, rec.transcriber) };
  if (buf === null) return transcribeBig(env, rec);
  const diarized = rec.transcriber === 'gpt-4o-transcribe-diarize';
  const build = (withRefs) => {
    const fd = new FormData();
    // OpenAI sniffs the format from the filename extension, so match it to the stored type.
    const ext = ({ 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
      'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' })[(rec.content_type || '').split(';')[0]] || 'webm';
    // Bare MIME type: some providers 400 on a `;codecs=opus` suffix.
    fd.append('file', new File([buf], `audio.${ext}`, { type: (rec.content_type || 'audio/webm').split(';')[0].trim() }));
    fd.append('model', rec.transcriber);
    fd.append('response_format', diarized ? 'diarized_json' : 'json');
    if (diarized) fd.append('chunking_strategy', 'auto');
    // Whisper detects the language from the first seconds; a wrong guess (e.g. Russian on an
    // English call) makes it loop. STT_LANGUAGE (ISO-639-1, e.g. "en") pins it.
    if (env.STT_LANGUAGE && !diarized) fd.append('language', String(env.STT_LANGUAGE).trim());
    return { fd, sent: withRefs ? withRefs(fd) : [] };
  };

  // Voiceprint references (layer 2, #14): the newest clip of up to 4 people, resent on
  // every diarize call -- OpenAI stores nothing, the clips in R2 are the persistence.
  // The wire format is unverified, so a 4xx WITH references retries once WITHOUT them:
  // a secondary feature must never cost the user the transcription.
  let sent = [];
  let req;
  if (diarized && refs.length) {
    const blobs = await Promise.all(refs.map(async (r) => {
      const o = await env.AUDIO.get(r.r2_key);
      return o ? o.arrayBuffer() : new ArrayBuffer(0);
    }));
    req = build((fd) => speakerRefsForm(fd, refs, blobs));
    sent = req.sent;
  } else {
    req = build(null);
  }
  const call = async (fd) => {
    const r = await sttFetch(env, fd);
    if (!r.ok) console.error('stt failed:', r.status, rec.transcriber, rec.content_type, buf.byteLength, (await r.clone().text()).slice(0, 300));
    return r;
  };

  // OpenRouter models that label speakers (Scribe, Voxtral, MAI...): ask for diarization,
  // then fold the per-word speaker ids into turns. If the model rejects the options or
  // returns no speaker data, fall back to a plain transcript rather than failing.
  if (sttDiarizes(env, rec.transcriber)) {
    const mk = (diarize) => {
      const { fd } = build(null);
      fd.set('response_format', diarize ? 'verbose_json' : 'json');
      if (diarize) { fd.append('diarize', 'true'); fd.append('timestamp_granularities[]', 'word'); fd.append('timestamp_granularities[]', 'segment'); }
      return fd;
    };
    let r = await call(mk(true));
    if (r.ok) {
      const tj = await r.json();
      const segments = openRouterSegments(tj);
      if (segments.length) return { tj: { ...tj, segments }, sent: [], diarized: true };
      console.error('diarize requested but the response had no speaker data; using plain text');
      return { tj, sent: [], diarized: false };
    }
    if (r.status < 400 || r.status >= 500 || r.status === 429) throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 300)}`);
    console.error('diarize rejected, retrying without:', r.status, (await r.text()).slice(0, 300));
    r = await call(mk(false));
    if (!r.ok) throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return { tj: await r.json(), sent: [], diarized: false };
  }
  // Local server (e.g. Whisper on oMLX): ask for timestamped segments so the browser can
  // split speakers by voice. Servers that ignore the field still answer with plain text.
  if (localDiarize(env)) req.fd.set('response_format', 'verbose_json');
  let tr = await call(req.fd);
  if (!tr.ok && sent.length && tr.status >= 400 && tr.status < 500) {
    console.error('transcribe with voiceprint refs rejected, retrying without:', tr.status, (await tr.text()).slice(0, 300));
    sent = [];
    tr = await call(build(null).fd);
  }
  if (!tr.ok) throw new Error(`transcribe ${tr.status}: ${(await tr.text()).slice(0, 300)}`);
  const tj = await tr.json();
  if (localDiarize(env)) {
    // Keep the timestamps either way (every segment becomes speaker "A", so a voice can be
    // enrolled from it). Only a recording long enough for the browser to split speakers waits for
    // that; a short one is named by the normal evidence pass straight away.
    const segments = localSegments(tj);
    if (segments.length >= 1) return { tj: { ...tj, segments }, sent: [], diarized: true, pendingTurns: segments.length >= MIN_SEGMENTS_FOR_TURNS };
  }
  return { tj, sent, diarized };
}

// A Whisper hallucination loop: a long transcript made of a few phrases repeated over and over.
export function isLooped(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 60) return false;
  const grams = new Set();
  for (let i = 0; i + 3 <= words.length; i++) grams.add(words.slice(i, i + 3).join(' '));
  return grams.size / (words.length - 2) < 0.15;
}

export async function process(env, id, owner, { stopAfter, force } = {}) {
  const rec = await readRow(env, id, owner);
  if (!rec) throw httpError('recording not found', 404);
  if (rec.status === 'ready' && (rec.speakers || []).some((s) => s.confirmed)) {
    // Re-diarizing can permute the A/B labels, which would re-attach a human's
    // confirmed names to the wrong voices. Refuse rather than risk mislabeling.
    throw httpError('recording has confirmed speaker names; delete it to reprocess', 409);
  }
  // Claim the row. A concurrent process() (second tab, double click) loses here instead
  // of double-billing; a row stuck at 'processing' past STALE_PROCESSING_MS is reclaimable.
  const now = Date.now();
  const claim = await env.DB.prepare(
    `UPDATE recordings SET status='processing', error=NULL, status_at=?
      WHERE id=? AND owner=? AND status != 'recording'
        AND (status != 'processing' OR coalesce(status_at, created_at) < ?)`
  ).bind(now, id, owner, force ? now + 1 : now - STALE_PROCESSING_MS).run();
  if (claim?.meta?.changes === 0) throw httpError('recording is not ready to process (already processing, or still recording)', 409);

  try {
    // A previous attempt that got as far as saving the transcript and failed in the
    // summarize step resumes from that transcript instead of paying for diarization again.
    // A 'transcribed' row (process stopped after the transcript so the browser could match
    // voices before summarizing, #24) resumes the same way.
    // `force` (the Retry button) also resumes a row stuck at 'processing' that already saved its transcript.
    const resume = Boolean(rec.transcript) && (rec.status === 'transcribed'
      || (force && rec.status === 'processing')
      || (rec.status === 'error' && /^summarize/.test(rec.error || '')));
    let segments, transcript, speakers, tokensIn = 0, tokensOut = 0;

    if (resume) {
      segments = rec.segments || [];
      transcript = rec.transcript;
      speakers = rec.speakers || [];
    } else {
      if (!rec.r2_key) throw new Error('no audio or transcript to work from');
      const obj = await env.AUDIO.get(rec.r2_key);
      if (!obj) throw new Error('audio object missing from R2');
      // Over the multipart cap on OpenRouter: leave the audio in R2 and stream it.
      const buf = usesOpenRouterStt(env) && obj.size > MAX_UPLOAD ? null : await obj.arrayBuffer();
      const openaiDiarize = effectiveTranscriber(env, rec.transcriber) === 'gpt-4o-transcribe-diarize';
      const refs = openaiDiarize ? await selectVoiceprints(env, owner, 4) : [];
      const { tj, sent, diarized, pendingTurns } = await transcribe(env, rec, buf, refs);
      segments = tj.segments || [];
      if (guardOn(env)) {
        tj.text = cleanText(tj.text, env.STT_LANGUAGE);
        segments = cleanSegments(segments, env.STT_LANGUAGE);
      }
      const rawTranscript = diarized ? diarizeToText(segments) : (tj.text || '').trim();
      if (!rawTranscript) throw new Error(guardOn(env) ? 'transcription had no real speech (only noise the hallucination guard removed)' : 'transcription came back empty');
      if (guardOn(env) && isLooped(rawTranscript)) throw new Error('transcription looped on repeated phrases (a speech-model hallucination). Retry, or set STT_LANGUAGE to pin the language.');
      tokensIn += tj.usage?.input_tokens || 0;
      tokensOut += tj.usage?.output_tokens || 0;

      // Speaker naming (#4/#14). `segments` keep their raw diarizer labels; only the text
      // we summarize/search/show is rebuilt with names, so a later PATCH can still match
      // by original label. A failed naming pass degrades to anonymous labels -- never
      // loses the transcription, never guesses.
      try {
        // pendingTurns: one provisional speaker for the whole recording. Naming it now would
        // pin any name said anywhere on everyone, so it waits for the real turns (POST /speaker-turns).
        speakers = pendingTurns
          ? anonymousSpeakers(segments)
          : await nameSpeakers(env, owner, segments, rawTranscript, matchedSpeakerRefs(segments, sent), sent.length > 0);
      } catch (e) {
        console.error('speaker naming failed, keeping anonymous labels:', e?.message || e);
        speakers = anonymousSpeakers(segments);
      }
      transcript = speakers.length ? rebuildTranscript(segments, speakers, rawTranscript) : rawTranscript;

      // Persist the transcription NOW, before the summarize step that can still fail.
      await env.DB.batch([
        env.DB.prepare(
          'UPDATE recordings SET transcript=?, segments=?, speakers=?, tokens_in=?, tokens_out=?, status_at=? WHERE id=? AND owner=?'
        ).bind(transcript, JSON.stringify(segments), JSON.stringify(speakers), tokensIn, tokensOut, Date.now(), id, owner),
        env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
        env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(id, rec.title, transcript),
      ]);
    }

    if (stopAfter === 'transcript') {
      await env.DB.prepare("UPDATE recordings SET status='transcribed', status_at=? WHERE id=? AND owner=?")
        .bind(Date.now(), id, owner).run();
      return readRow(env, id, owner);
    }

    await summarize(env, rec, id, owner, { transcript, accumulate: resume, tokensIn, tokensOut });
    return readRow(env, id, owner);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    await env.DB.prepare("UPDATE recordings SET status='error', error=?, status_at=? WHERE id=? AND owner=?")
      .bind(msg, Date.now(), id, owner).run();
    throw e;
  }
}

// Summarize `transcript` with the recording's template and model, then mark it ready.
// Shared by process() and resummarize(). `accumulate` adds this call's tokens to the stored
// totals instead of replacing them.
async function summarize(env, rec, id, owner, { transcript, accumulate, tokensIn = 0, tokensOut = 0 }) {
  const tmpl = await resolveTemplate(env, owner, rec.template);
  const sr = await llmFetch(env, {
    model: rec.model || defaultModel(env),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt(tmpl) },
      { role: 'user', content: `Transcript:\n\n${transcript.slice(0, contextChars(env))}` },
    ],
  });
  if (!sr.ok) throw new Error(`summarize ${sr.status}: ${(await sr.text()).slice(0, 300)}`);
  const sjr = await sr.json();
  const sj = parseJsonLoose(sjr.choices[0].message.content);
  if (!sj || typeof sj !== 'object') throw new Error('summarize returned invalid JSON');
  tokensIn += sjr.usage?.prompt_tokens || 0;
  tokensOut += sjr.usage?.completion_tokens || 0;

  // Items the user already ticked stay ticked when the same task comes back (re-summarize).
  const doneTasks = new Set((Array.isArray(rec.action_items) ? rec.action_items : [])
    .filter((a) => a?.done && a.task).map((a) => String(a.task).trim().toLowerCase()));
  const items = (Array.isArray(sj.action_items) ? sj.action_items : []).filter((a) => a && typeof a === 'object')
    .map((a) => (doneTasks.has(String(a.task || '').trim().toLowerCase()) ? { ...a, done: true } : a));
  const unanswered = (Array.isArray(sj.unanswered) ? sj.unanswered : [])
    .map((q) => String(q || '').trim()).filter(Boolean).slice(0, 10);

  await env.DB.prepare(
    `UPDATE recordings SET status='ready', summary=?, action_items=?, mindmap=?, mindmaps=?, unanswered=?,
                           tokens_in=coalesce(tokens_in,0)*? + ?, tokens_out=coalesce(tokens_out,0)*? + ?
     WHERE id=? AND owner=?`
  ).bind(
    sj.summary || '', JSON.stringify(items),
    sj.mindmaps?.topic || sj.mindmap || '', JSON.stringify(sj.mindmaps || {}), JSON.stringify(unanswered),
    accumulate ? 1 : 0, tokensIn, accumulate ? 1 : 0, tokensOut, id, owner,
  ).run();

  // Memory (facts + semantic index). Best effort: it must never fail a finished summary.
  try {
    const facts = normalizeFacts(sj.facts, transcript);
    await saveFacts(env, owner, rec, facts);
    await indexRecording(env, owner, { ...rec, summary: sj.summary || '', transcript }, facts);
  } catch (e) {
    console.error('memory update failed:', e?.message || e);
  }
}

// PATCH /:id/actions {i, done}: tick or untick one action item. Persisted inside the
// action_items JSON so it survives reloads and feeds the Today screen.
export async function setActionDone(request, env, owner, id) {
  const body = await request.json().catch(() => null);
  const rec = await readRow(env, id, owner);
  if (!rec) return fail('not found', 404);
  const items = Array.isArray(rec.action_items) ? rec.action_items : [];
  if (!body || !Number.isInteger(body.i) || body.i < 0 || body.i >= items.length || typeof body.done !== 'boolean')
    return fail('i and done required');
  const next = items.map((a, k) => (k === body.i ? { ...a, done: body.done } : a));
  await env.DB.prepare('UPDATE recordings SET action_items = ? WHERE id = ? AND owner = ?')
    .bind(JSON.stringify(next), id, owner).run();
  return json({ ok: true, done: body.done });
}

// POST /:id/speaker-turns {assign:[n,...]} (local mode): one speaker number per stored segment,
// worked out in the browser by clustering voice embeddings. Relabels the segments A, B, C...,
// runs the evidence-only naming pass for labels nobody has confirmed, and rebuilds the
// transcript. Names a human CONFIRMED stay on their label (the browser lines the new clusters
// up with the old labels by overlap, so a person keeps their letter); if a confirmed speaker ends
// up with no segments at all, their name is reported in `dropped_names`. A ready recording is
// told to re-summarize with the new turns.
export async function speakerTurns(request, env, owner, id) {
  const body = await request.json().catch(() => null);
  const rec = await readRow(env, id, owner);
  if (!rec) return fail('not found', 404);
  if (!['ready', 'transcribed'].includes(rec.status)) return fail('recording is not ready', 409);
  const segs = Array.isArray(rec.segments) ? rec.segments : [];
  const assign = body?.assign;
  if (!segs.length || !Array.isArray(assign) || assign.length !== segs.length) return fail('assign must have one entry per segment');
  if (assign.some((n) => !Number.isInteger(n) || n < 0 || n > 11)) return fail('speaker numbers are 0-11');

  const letter = (n) => String.fromCharCode(65 + n);
  const segments = segs.map((s, i) => ({ ...s, speaker: letter(assign[i]) }));
  const raw = diarizeToText(segments);
  let speakers;
  try { speakers = await nameSpeakers(env, owner, segments, raw); }
  catch (e) { console.error('speaker naming failed, keeping anonymous labels:', e?.message || e); speakers = anonymousSpeakers(segments); }

  // Confirmed names survive: restore them on their label, and never hand the same name to a
  // second label through the naming pass.
  const confirmed = (rec.speakers || []).filter((sp) => sp.confirmed && sp.name);
  const live = new Set(speakers.map((sp) => sp.label));
  const taken = new Set(confirmed.filter((c) => live.has(c.label)).map((c) => c.name.toLowerCase()));
  speakers = speakers.map((sp) => {
    const keep = confirmed.find((c) => c.label === sp.label);
    if (keep) return keep;
    return sp.name && taken.has(sp.name.toLowerCase()) ? { ...sp, name: null, evidence: '' } : sp;
  });
  const dropped = confirmed.filter((c) => !live.has(c.label)).map((c) => c.name);

  const transcript = rebuildTranscript(segments, speakers, raw);
  await env.DB.batch([
    env.DB.prepare('UPDATE recordings SET segments = ?, speakers = ?, transcript = ?, voice_match = ? WHERE id = ? AND owner = ?')
      .bind(JSON.stringify(segments), JSON.stringify(speakers), transcript, null, id, owner),
    env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
    env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(id, rec.title, transcript),
  ]);
  return json({ ...(await readRow(env, id, owner)), voice_changed: rec.status === 'ready', dropped_names: dropped });
}

// POST /:id/reassign {segments:[i,...], to:"B"|"new"}: move transcript turns to another speaker,
// or to a brand new one. This is how a wrong turn is fixed by hand, and how one person who was
// split into two speakers is merged (move all of one speaker's segments to the other). Names
// and confirmations are untouched; a speaker left with nothing is removed.
export async function reassign(request, env, owner, id) {
  const body = await request.json().catch(() => null);
  const rec = await readRow(env, id, owner);
  if (!rec) return fail('not found', 404);
  if (!['ready', 'transcribed'].includes(rec.status)) return fail('recording is not ready', 409);
  if (!Array.isArray(rec.segments) || !rec.segments.length) return fail('this recording has no timed turns to move', 409);
  const out = reassignSegments(rec.segments, rec.speakers, body?.segments, body?.to);
  if (out.error) return fail(out.error);

  const transcript = rebuildTranscript(out.segments, out.speakers, rec.transcript);
  await env.DB.batch([
    env.DB.prepare('UPDATE recordings SET segments = ?, speakers = ?, transcript = ?, voice_match = ? WHERE id = ? AND owner = ?')
      .bind(JSON.stringify(out.segments), JSON.stringify(out.speakers), transcript, null, id, owner),
    env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
    env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(id, rec.title, transcript),
  ]);
  return json({ ...(await readRow(env, id, owner)), voice_changed: rec.status === 'ready', moved_to: out.target, removed_speakers: out.removed });
}

// POST /:id/resummarize: summarize again from the stored transcript (e.g. after late voice
// matches added names). Never re-transcribes or re-diarizes, so it is allowed on recordings
// with confirmed speakers. A failure leaves the existing summary in place.
export async function resummarize(env, id, owner) {
  const rec = await readRow(env, id, owner);
  if (!rec) return fail('not found', 404);
  if (rec.status !== 'ready' || !rec.transcript) return fail('recording is not ready', 409);
  try {
    await summarize(env, rec, id, owner, { transcript: rec.transcript, accumulate: true });
  } catch (e) {
    return fail(String(e?.message || e).slice(0, 300), 502);
  }
  return json(await readRow(env, id, owner));
}

// POST /:id/reset-speakers: clear every speaker name on this recording, confirmed ones too,
// back to Unknown 1..N. The speaker split (segments) is untouched. voice_match is set to a
// marker rather than null so opening the recording does not immediately re-suggest names;
// "Re-detect speakers" still can. A ready recording is told to re-summarize with the new names.
export async function resetSpeakers(env, owner, id) {
  const rec = await readRow(env, id, owner);
  if (!rec) return fail('not found', 404);
  if (!['ready', 'transcribed'].includes(rec.status)) return fail('recording is not ready', 409);
  const segments = Array.isArray(rec.segments) ? rec.segments : [];
  if (!segments.length) return fail('recording has no speakers to reset', 409);
  const speakers = anonymousSpeakers(segments);
  const transcript = rebuildTranscript(segments, speakers, rec.transcript);
  await env.DB.batch([
    env.DB.prepare('UPDATE recordings SET speakers = ?, transcript = ?, voice_match = ? WHERE id = ? AND owner = ?')
      .bind(JSON.stringify(speakers), transcript, JSON.stringify({ reset: true, at: Date.now(), scores: [] }), id, owner),
    env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
    env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(id, rec.title, transcript),
  ]);
  return json({ ...(await readRow(env, id, owner)), voice_changed: rec.status === 'ready' });
}

// POST /:id/voice-match {model, speakers:[{label, embedding, speech_ms}]} (#24). The browser
// computed the embeddings; this decides. Matches are SUGGESTIONS (confirmed:false): they
// name only unnamed labels and null out an LLM name the voice contradicts.
export async function voiceMatch(request, env, owner, id) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail('bad request');
  if (body.model !== VOICE_MODEL) return fail(`voice model must be ${VOICE_MODEL}`);
  const rec = await readRow(env, id, owner);
  if (!rec) return fail('not found', 404);
  if (!rec.segments?.length || !rec.speakers?.length) return fail('recording has no speakers to match', 409);

  const given = Array.isArray(body.speakers) ? body.speakers : [];
  if (!given.length || given.length > 12) return fail('1-12 speakers required');
  const known = new Set(rec.speakers.map((s) => s.label));
  const labels = [];
  for (const g of given) {
    const embedding = normalizeEmbedding(g?.embedding);
    if (!embedding) return fail('bad embedding');
    if (!known.has(g.label)) return fail(`no such speaker: ${String(g.label).slice(0, 40)}`);
    labels.push({ label: g.label, embedding, speech_ms: Number(g.speech_ms) || 0 });
  }

  const rows = (await env.DB.prepare(
    `SELECT voiceprints.person_id AS person_id, people.name AS name, voiceprints.embedding AS embedding
       FROM voiceprints JOIN people ON people.id = voiceprints.person_id
      WHERE voiceprints.owner = ? AND people.owner = ? AND voiceprints.embedding_model = ?`
  ).bind(owner, owner, VOICE_MODEL).all()).results || [];
  const byPerson = new Map();
  for (const r of rows) {
    let arr; try { arr = JSON.parse(r.embedding); } catch { continue; }
    if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, { person_id: r.person_id, name: r.name, embeddings: [] });
    byPerson.get(r.person_id).embeddings.push(arr);
  }
  const people = [...byPerson.values()];

  // Confirmed labels keep their names and their people are not offered again.
  const confirmed = rec.speakers.filter((s) => s.confirmed && s.name);
  const exclude = new Set(people.filter((p) => confirmed.some((s) => s.name === p.name)).map((p) => p.person_id));
  const open = labels.filter((l) => !rec.speakers.find((s) => s.label === l.label)?.confirmed);
  const { assignments, scores } = matchVoices(open, people, { exclude });
  const { speakers, changed } = applyVoiceMatches(rec.speakers, assignments);
  const transcript = rebuildTranscript(rec.segments, speakers, rec.transcript);
  const voice = { model: VOICE_MODEL, at: Date.now(), scores };

  await env.DB.batch([
    env.DB.prepare('UPDATE recordings SET speakers = ?, transcript = ?, voice_match = ? WHERE id = ? AND owner = ?')
      .bind(JSON.stringify(speakers), transcript, JSON.stringify(voice), id, owner),
    env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
    env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(id, rec.title, transcript),
  ]);
  return json({ ...(await readRow(env, id, owner)), voice_changed: changed });
}

// Serves the stored audio with HTTP Range support, so the player can seek anywhere without
// downloading everything before it (R2 reads just the requested bytes).
export async function audio(env, id, owner, request) {
  const r = await readRow(env, id, owner);
  if (!r) return fail('not found', 404);
  if (!r.r2_key) return fail('this recording has no audio', 404);
  const headers = { 'content-type': r.content_type, 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(request?.headers?.get('range') || '');
  if (m && (m[1] !== '' || m[2] !== '')) {
    const head = await env.AUDIO.head?.(r.r2_key);
    const total = head?.size;
    if (total != null) {
      let start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
      if (start >= total || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
      const part = await env.AUDIO.get(r.r2_key, { range: { offset: start, length: end - start + 1 } });
      if (!part) return fail('audio missing', 404);
      return new Response(part.body, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) } });
    }
  }
  const obj = await env.AUDIO.get(r.r2_key);
  if (!obj) return fail('audio missing', 404);
  return new Response(obj.body, { headers });
}

export async function remove(env, id, owner) {
  const r = await readRow(env, id, owner);
  if (!r) return fail('not found', 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM transcript_fts WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM facts WHERE recording_id = ? AND owner = ?').bind(id, owner),
    env.DB.prepare('DELETE FROM recordings WHERE id = ? AND owner = ?').bind(id, owner),
  ]);
  try { await deleteRecordingVectors(env, id, r.vec_chunks); } catch (e) { console.error('vector delete failed:', e?.message || e); }
  if (r.r2_key) await env.AUDIO.delete(r.r2_key);
  await deleteParts(env, id);
  return json({ ok: true });
}
