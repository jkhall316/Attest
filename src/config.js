// Model + transcriber catalog. Labels are UI only; ids are what we send to OpenAI.

export const MAX_UPLOAD = 24 * 1024 * 1024; // OpenAI transcription cap is 25MB
// OpenRouter models take bigger files (MAI-Transcribe 2: 300MB / 2h) as streamed base64 JSON,
// so only Attest's own buffering limits uploads there: the upload handlers hold the file in
// memory (128MB Worker limit), so stay well under half of it.
export const MAX_UPLOAD_OPENROUTER = 48 * 1024 * 1024;
// Local mode (npm run local, with oMLX or similar): no provider cap, only the Worker's memory.
export const MAX_UPLOAD_LOCAL = 96 * 1024 * 1024;
export const isLocal = (env) => String(env?.LOCAL_MODE || '').toLowerCase() === 'true';
// Local mode with no diarizing transcriber: the browser works out who spoke when, by clustering
// voice embeddings of the transcript's segments (public/app/diarize.js), and posts the result.
// Below this many segments the browser does not try to tell speakers apart (public/app/diarize.js
// has the same number), so a short recording is named by the normal evidence pass at once.
export const MIN_SEGMENTS_FOR_TURNS = 4;
export const localDiarize = (env) => isLocal(env) && String(env?.LOCAL_DIARIZE || '').toLowerCase() === 'true';
export const maxUpload = (env) => (isLocal(env) ? MAX_UPLOAD_LOCAL : (env?.STT_BASE_URL || '').includes('openrouter.ai') ? MAX_UPLOAD_OPENROUTER : MAX_UPLOAD);

// How much transcript goes to the chat model in one call. Hosted models take 120k characters
// comfortably; a local model has a context window to respect, so LLM_CONTEXT_CHARS lowers it.
export const contextChars = (env) => Math.min(400000, Math.max(8000, Number(env?.LLM_CONTEXT_CHARS) || 120000));

// Frontier tiers, cheapest first. Labeled objects rather than bare ids so the
// dropdown can say what the tradeoff is.
export const MODELS = [
  { id: 'gpt-6-luna',    label: 'GPT-6 Luna — cheap, high volume' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra — fast' },
  { id: 'gpt-6.1-sol',   label: 'GPT-6.1 Sol — balanced' },
  { id: 'gpt-6-astra',   label: 'GPT-6 Astra — most capable' },
];

// OpenAI retires whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe and
// gpt-4o-transcribe-diarize on 2027-02-26 (deprecations page, checked 2026-11-06). The
// supported replacement for plain transcription is gpt-transcribe. NOTHING OpenAI offers
// replaces diarization: gpt-transcribe / gpt-live-transcribe return text only. The diarize
// model is kept, flagged, as the only speaker-labeling option until it is switched off.
export const TRANSCRIBERS = [
  { id: 'gpt-4o-transcribe-diarize', label: 'Diarize — speaker labels', deprecated: true },
  { id: 'gpt-transcribe',            label: 'GPT Transcribe — text only, no speaker labels' },
];

export const defaultModel = (env) => env?.DEFAULT_MODEL || modelsFor(env)[0].id;
// LLM_MODELS (comma-separated ids, e.g. "openai/gpt-5-mini,anthropic/claude-sonnet-4.5")
// replaces the dropdown list; needed with LLM_BASE_URL, whose ids differ from OpenAI's.
export const modelsFor = (env) => {
  const ids = (env?.LLM_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids.map((id) => ({ id, label: id })) : MODELS;
};
export const modelById = (id, env) => modelsFor(env).find((m) => m.id === id) || null;
// OpenRouter STT models that can label speakers (per OpenRouter's speech-to-text collection
// page, 2026-11-10). With these, Attest asks for diarization and builds speaker turns from it.
export const DIARIZING_STT = new Set([
  'elevenlabs/scribe-v2', 'elevenlabs/scribe-v2-medical',
  'mistralai/voxtral-mini-transcribe-3-0', 'mistralai/voxtral-small-transcribe-3-0',
  'microsoft/mai-transcribe-2', 'nvidia/nemotron-3.5-transcribe',
  'x-ai/grok-stt-1.0', 'x-ai/grok-stt-2.0', 'google/gemini-3.5-transcribe', 'fish-audio/transcribe-1-pro',
]);

// STT_MODELS (comma-separated ids, e.g. "openai/whisper-large-v3-turbo") replaces the list
// when transcription goes to another provider via STT_BASE_URL. Those models return plain
// text: no OpenAI diarize wire format, so no speaker labels or voiceprints.
export const transcribersFor = (env) => {
  const ids = (env?.STT_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids.map((id) => ({ id, label: DIARIZING_STT.has(id) ? `${id} — speaker labels` : id })) : TRANSCRIBERS;
};
export const transcriberById = (id, env) => {
  const list = transcribersFor(env);
  return list.find((t) => t.id === id) || list[0];
};
// The transcriber to actually use for a stored id: applies the post-cut-off fallback, then
// maps an id the current provider does not offer (a recording or Pocket import saved with
// the OpenAI default, now on OpenRouter, or the reverse) to the first configured model.
export const effectiveTranscriber = (env, id, now = Date.now()) => transcriberById(liveTranscriberId(id, now), env).id;

// Model for the live-preview chunks: the first configured STT model, else gpt-transcribe.
// On OpenRouter the preview always uses cheap plain-text Whisper (~$0.012/audio hour), never
// the first model in the list: the recommended MAI-Transcribe 2 costs ~$0.10/hour, and the
// preview would otherwise double the transcription bill for text that is thrown away.
export const PREVIEW_OPENROUTER = 'openai/whisper-large-v3-turbo';
export const previewTranscriber = (env) =>
  (env?.STT_BASE_URL || '').includes('openrouter.ai') ? PREVIEW_OPENROUTER
    : env?.STT_MODELS ? transcribersFor(env)[0].id : 'gpt-transcribe';

// Hard cut-offs we know about (#16). Surfaced through /api/meta so the UI can warn
// before a deploy silently loses a feature. Add a row here when a provider announces one.
export const TRANSCRIBER_DEPRECATIONS = {
  'gpt-4o-transcribe-diarize': {
    cutoff: '2027-02-26',
    note: 'OpenAI has no diarizing successor: gpt-transcribe returns text without speaker labels. After the cut-off, recordings are transcribed without speakers.',
  },
};

// After a transcriber's cut-off the API will refuse it, so recordings made (or retried)
// then fall back to gpt-transcribe: transcript and summary keep working, speaker labels
// and voiceprints stop. `now` is injectable for tests.
export function liveTranscriberId(id, now = Date.now()) {
  const dep = TRANSCRIBER_DEPRECATIONS[id];
  return dep && deprecationState(dep, now).level === 'retired' ? 'gpt-transcribe' : id;
}

// Warning level for one deprecation. <=180 days is "soon", <=0 is "retired".
// `now` is injectable so the test does not depend on the wall clock.
export function deprecationState(dep, now = Date.now()) {
  const days = Math.ceil((Date.parse(`${dep.cutoff}T00:00:00Z`) - now) / 86400000);
  if (days <= 0) return { days, level: 'retired' };
  if (days <= 180) return { days, level: 'soon' };
  return { days, level: 'watch' };
}

// /api/meta payload: cutoff, note, days remaining and level, precomputed server-side so
// the no-build browser script does not have to duplicate the date maths.
export function deprecations(now = Date.now()) {
  const out = {};
  for (const [id, dep] of Object.entries(TRANSCRIBER_DEPRECATIONS)) {
    out[id] = { ...dep, ...deprecationState(dep, now) };
  }
  return out;
}

// OpenRouter menus shown by `npm run setup` and the in-app settings. Prices are from
// OpenRouter's models API on 2026-11-10 and will drift; any model id is also accepted.
export const OPENROUTER_CHAT = [
  { id: 'openai/gpt-oss-20b',         note: '$0.03 in / $0.13 out per 1M tokens. Cheapest that does JSON output. Basic summaries.' },
  { id: 'deepseek/deepseek-v4-flash', note: '$0.09 / $0.18. Still very cheap, stronger writing.' },
  { id: 'anthropic/claude-haiku-5.5', note: '$0.10 / $0.50. Best quality per dollar of these.' },
  { id: 'openai/gpt-5-mini',          note: '$0.25 / $2.00. Solid all-rounder.' },
];
export const OPENROUTER_STT = [
  { id: 'microsoft/mai-transcribe-2',            note: 'RECOMMENDED. $0.10 per audio hour. LABELS SPEAKERS. Cheapest model that does.' },
  { id: 'openai/whisper-large-v3-turbo',         note: '~$0.012 per audio hour. Cheapest overall. Plain text, no speaker labels.' },
  { id: 'openai/whisper-large-v3',               note: '~$0.027 per audio hour. A bit more accurate than turbo. Plain text.' },
  { id: 'mistralai/voxtral-mini-transcribe-3-0', note: '~$0.21 per audio hour. LABELS SPEAKERS.' },
  { id: 'elevenlabs/scribe-v2',                  note: '~$0.22 per audio hour. High accuracy. LABELS SPEAKERS.' },
];
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
export const OPENAI_URL = 'https://api.openai.com/v1';

// Provider-independent voice matching (#24). The embedding model runs in the browser
// (public/app/voiceembed.js); the Worker stores the fingerprints and decides matches.
// Changing VOICE_MODEL orphans stored embeddings on purpose: they are re-made from the
// kept WAV clips. Thresholds are a starting point; every score is kept in
// recordings.voice_match so they can be tuned on real data.
export const VOICE_MODEL = 'redimnet2-b6@e911e3f';
export const VOICE_DIM = 192;
// threshold: measured on real recordings, the same person scored 0.59-0.81 against an enrolled
// clip from a different recording, and a different person at most 0.28. 0.50 sits well clear of
// the second and tolerates a different mic or room. A match is only ever a suggestion.
export const VOICE_MATCH = { threshold: 0.50, margin: 0.10, minSpeechMs: 4000 };
