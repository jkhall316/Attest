// Speaker labels from OpenRouter speech-to-text models. OpenRouter has a unified
// `diarize` option: send diarize=true with response_format=verbose_json and word
// timestamps, and each word comes back with an integer `speaker` (and sometimes a string
// `speaker_label`). We fold those words into the same {speaker, text, start, end} turns
// the OpenAI diarize path produces, so naming, summaries, search and export need no
// changes. (Voiceprints stay OpenAI-only: they rely on OpenAI's reference-clip format.)

import { DIARIZING_STT } from './config.js';

export const usesOpenRouterStt = (env) => (env.STT_BASE_URL || '').includes('openrouter.ai');
export const sttDiarizes = (env, modelId) => usesOpenRouterStt(env) && DIARIZING_STT.has(modelId);

const letter = (n) => (n < 26 ? String.fromCharCode(65 + n) : `S${n + 1}`);

// verbose_json -> turns, or [] when the response carries no usable speaker data.
export function openRouterSegments(tj) {
  const ids = new Map(); // provider speaker id -> A, B, C in order of first appearance
  const label = (x) => {
    const key = String(x.speaker ?? x.speaker_label ?? '');
    if (key === '' || key === 'undefined') return null;
    if (!ids.has(key)) ids.set(key, letter(ids.size));
    return ids.get(key);
  };
  const units = Array.isArray(tj?.words) && tj.words.some((w) => w.speaker != null || w.speaker_label != null)
    ? tj.words.filter((w) => w.type !== 'audio_event').map((w) => ({ who: label(w), text: w.word ?? w.text ?? '', start: w.start, end: w.end, join: ' ' }))
    : (tj?.segments || []).map((s) => ({ who: label(s), text: s.text ?? '', start: s.start, end: s.end, join: ' ' }));
  if (!units.some((u) => u.who)) return [];

  const turns = [];
  let prev = 'A';
  for (const u of units) {
    const text = String(u.text).trim();
    if (!text) continue;
    const who = u.who || prev; // an unlabeled word joins the turn it sits in
    prev = who;
    const last = turns[turns.length - 1];
    if (last && last.speaker === who) { last.text += ' ' + text; last.end = u.end ?? last.end; }
    else turns.push({ speaker: who, text, start: u.start, end: u.end });
  }
  return turns;
}

// Local transcription with timestamps but no speaker labels (a plain Whisper server). Each
// segment becomes a turn by one provisional speaker "A"; the browser later splits them into
// real speakers by voice. [] when the server returned no usable timestamps.
export function localSegments(tj) {
  const out = [];
  for (const s of Array.isArray(tj?.segments) ? tj.segments : []) {
    const text = String(s?.text ?? '').trim();
    const start = Number(s?.start), end = Number(s?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ speaker: 'A', text, start, end });
  }
  return out;
}
