// Voiceprints, two layers.
//  (a) OpenAI refs (#14): clips resent as `known_speaker_references` on every diarize call.
//  (b) Local embeddings (#24, provider-independent): the browser turns each enrolled clip and
//      each speaker in a recording into a 192-d voice embedding; matchVoices() below compares
//      them. Works with any transcriber that labels speakers.
// Both only ever SUGGEST a name (confirmed:false); a human click confirms.
//
// Voiceprint enrollment, layer 2 (#14). A voiceprint is a 2-10s WAV clip of one
// named speaker, kept in R2 (`vp/<personId>/<uuid>`) and rowed in D1. OpenAI's
// `known_speaker_references` API stores nothing between calls, so the clips
// themselves -- not a server-side model -- are the stickiness: every diarize call
// resends the top few most-recently-enrolled clips.
//
// The rule this layer must not break (see src/speakers.js): a label is only ever
// named from a reference match; everything else stays anonymous. This file never
// assigns a name on its own -- it only builds the request OpenAI sees and reads back
// which labels it says matched, handing a {label,name} pledge to nameSpeakers().

import { VOICE_DIM, VOICE_MATCH } from './config.js';

export const MIN_VOICEPRINT_MS = 2000;
export const MAX_VOICEPRINT_MS = 10000;
export const MAX_VOICEPRINT_BYTES = 1 * 1024 * 1024; // 1MB -- a 10s 16kHz mono WAV is ~320KB

// Pure: duration straight from the RIFF header's byteRate + data chunk size, not a
// client-supplied field -- a clip's declared length is the one thing enrollment must
// not take on faith, since it gates whether the clip is even in the 2-10s window.
// Returns null for anything that is not a well-formed PCM WAV.
export function wavDurationMs(bytes) {
  const view = new DataView(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength ?? bytes.length);
  const str4 = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (view.byteLength < 44 || str4(0) !== 'RIFF' || str4(8) !== 'WAVE') return null;

  let offset = 12, byteRate = null, dataSize = null;
  while (offset + 8 <= view.byteLength) {
    const id = str4(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && size >= 16 && offset + 8 + 16 <= view.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') dataSize = size;
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!byteRate || dataSize == null) return null;
  return Math.round((dataSize / byteRate) * 1000);
}

// Pure: canonical 16-bit PCM mono WAV (RIFF/WAVE). `samples` is a Float32Array in
// [-1, 1] -- the shape decodeAudioData's getChannelData gives back after downmix and
// resample -- clamped and scaled to Int16 here, nowhere else. Mirrored by hand in
// public/index.html (no build step there to share this module with the browser);
// keep the two in lockstep if either changes.
export function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2; // 16-bit mono
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);  // PCM fmt chunk size
  view.setUint16(20, 1, true);   // audio format = PCM
  view.setUint16(22, 1, true);   // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true);   // block align (mono, 16-bit)
  view.setUint16(34, 16, true);  // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// Pure: the clip window for enrollment is a speaker's single longest continuous turn
// (never a collage stitched from multiple turns -- that risks crossing into another
// speaker's words at a merge seam), capped at maxMs. Segment times are SECONDS, as
// diarized_json reports them; the returned window is in seconds too. A turn shorter
// than minMs cannot be stretched without crossing into someone else's speech, so it
// returns null and the caller tells the user why. Mirrored by hand in
// public/app/voiceprints.js; see encodeWav's comment for why.
export function pickClipWindow(segments, label, minMs, maxMs) {
  const turns = (segments || []).filter((s) =>
    (s.speaker || 'Speaker') === label && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  if (!turns.length) return null;
  const longest = turns.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const end = Math.min(longest.end, longest.start + maxMs / 1000);
  if ((end - longest.start) * 1000 < minMs) return null;
  return { start: longest.start, end };
}

// The `limit` most-recently-enrolled voiceprints, ONE PER PERSON (the newest clip of
// each), joined to `people` for the name OpenAI needs alongside each reference. Two
// clips of one person would send a duplicate name and crowd out other speakers.
export async function selectVoiceprints(env, owner, limit = 4) {
  const rows = (await env.DB.prepare(
    `SELECT voiceprints.id, voiceprints.person_id, people.name AS name,
            voiceprints.r2_key, voiceprints.duration_ms, voiceprints.created_at
       FROM voiceprints JOIN people ON people.id = voiceprints.person_id
      WHERE voiceprints.owner = ? AND people.owner = ?
      ORDER BY voiceprints.created_at DESC LIMIT 200`
  ).bind(owner, owner).all()).results;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.person_id)) continue;
    seen.add(r.person_id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Wire shape for OpenAI's diarize transcription: parallel `known_speaker_names[]` and
// `known_speaker_references[]` fields, the references being base64 `data:` URLs of the
// 2-10s clips. Unverified against a live call (it cannot be unit-tested here), which is
// why process() retries without references if the API rejects them. Refs whose blob is
// empty are skipped; the refs actually sent are returned so the caller matches against
// exactly those.
export function speakerRefsForm(fd, refs, blobs) {
  const sent = [];
  refs.forEach((ref, i) => {
    const size = blobs[i]?.byteLength ?? blobs[i]?.length ?? 0;
    if (!size) return;
    fd.append('known_speaker_names[]', ref.name);
    fd.append('known_speaker_references[]', `data:audio/wav;base64,${toBase64(blobs[i])}`);
    sent.push(ref);
  });
  return sent;
}

// Pure: reads back which labels the diarize call matched. A matched label comes back as
// the reference's own name instead of a raw diarizer letter, so a label only counts if
// it is literally one of the names we sent. Anything else is left for nameSpeakers() to
// treat as unmatched -> Unknown N, never guessed from voice.
export function matchedSpeakerRefs(segments, refs) {
  if (!refs?.length) return [];
  const labels = new Set((segments || []).map((s) => s.speaker || 'Speaker'));
  return refs.filter((r) => labels.has(r.name)).map((r) => ({ label: r.name, name: r.name }));
}

/* --- #24 provider-independent voice matching --- */

// Validates and L2-normalises an embedding. Null unless it is exactly VOICE_DIM finite
// numbers with a non-zero norm.
export function normalizeEmbedding(arr) {
  if (!arr || typeof arr.length !== 'number' || arr.length !== VOICE_DIM) return null;
  const out = new Float64Array(VOICE_DIM);
  let norm = 0;
  for (let i = 0; i < VOICE_DIM; i++) {
    const v = arr[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[i] = v; norm += v * v;
  }
  if (!(norm > 0)) return null;
  norm = Math.sqrt(norm);
  for (let i = 0; i < VOICE_DIM; i++) out[i] /= norm;
  return out;
}

// Both inputs normalised, so cosine similarity is the dot product.
export function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// labels: [{label, embedding, speech_ms}]   people: [{person_id, name, embeddings:[...]}]
// A person's score for a label is the best cosine over their enrolled clips. One-to-one
// greedy assignment, highest score first; a pair is accepted only above `threshold` AND
// when it beats that label's next-best other person by `margin`. `opts.exclude` is a set of
// person ids that may not be assigned (already confirmed elsewhere in the recording).
export function matchVoices(labels, people, opts = {}) {
  const { threshold, margin, minSpeechMs } = { ...VOICE_MATCH, ...opts };
  const exclude = opts.exclude || new Set();
  const cands = (people || []).filter((p) => !exclude.has(p.person_id));
  const eligible = (labels || []).filter((l) => (l.speech_ms || 0) >= minSpeechMs);
  const table = []; // {label, person, score}
  const scores = [];
  for (const l of eligible) {
    const emb = normalizeEmbedding(l.embedding);
    if (!emb) continue;
    const row = [];
    for (const p of cands) {
      let best = -Infinity;
      for (const e of p.embeddings || []) {
        const n = normalizeEmbedding(e);
        if (n) best = Math.max(best, cosine(emb, n));
      }
      if (best > -Infinity) row.push({ label: l.label, person: p, score: best });
    }
    row.sort((a, b) => b.score - a.score);
    for (const c of row) {
      const other = row.find((o) => o.person !== c.person);
      c.margin = c.score - (other ? other.score : 0);
    }
    table.push(...row);
    for (const c of row.slice(0, 3)) scores.push({ label: c.label, name: c.person.name, score: Math.round(c.score * 1000) / 1000 });
  }
  table.sort((a, b) => b.score - a.score);
  const usedLabels = new Set(), usedPeople = new Set(), assignments = [];
  for (const c of table) {
    if (c.score < threshold || c.margin < margin) continue;
    if (usedLabels.has(c.label) || usedPeople.has(c.person.person_id)) continue;
    usedLabels.add(c.label); usedPeople.add(c.person.person_id);
    assignments.push({ label: c.label, name: c.person.name, person_id: c.person.person_id, score: Math.round(c.score * 1000) / 1000 });
  }
  return { assignments, scores };
}

// Folds voice assignments into the speaker list. Pure; never touches confirmed labels.
//  - LLM already named the label the same -> keep, evidence gains the voice score
//  - LLM named it differently            -> name null ("anonymous beats wrong")
//  - unnamed                             -> suggested name, confirmed:false
// A name already held by another label is never given out twice.
export function applyVoiceMatches(speakers, assignments) {
  const lc = (n) => String(n || '').trim().toLowerCase();
  const byLabel = new Map((assignments || []).map((a) => [a.label, a]));
  let changed = false;
  const out = (speakers || []).map((s) => {
    const a = byLabel.get(s.label);
    if (!a || s.confirmed) return s;
    const holder = (speakers || []).some((o) => o !== s && o.name && lc(o.name) === lc(a.name));
    const pct = a.score.toFixed(2);
    if (s.name && lc(s.name) === lc(a.name)) return { ...s, evidence: `voice match ${pct} + transcript` };
    if (s.name) {
      changed = true;
      return { ...s, name: null, evidence: `conflict: transcript says ${s.name}, voice says ${a.name}`, confirmed: false };
    }
    if (holder) return s;
    changed = true;
    return { ...s, name: a.name, evidence: `voice match ${pct}`, confirmed: false };
  });
  return { speakers: out, changed };
}
/* --- /#24 provider-independent voice matching --- */
