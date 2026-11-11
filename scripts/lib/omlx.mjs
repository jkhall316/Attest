// Talking to a local OpenAI-compatible server (oMLX, or anything like it) for `npm run
// setup:local` and `npm run local:check`. Plain functions with an injectable fetch, so the
// tests can aim them at a mock server.

import { parseJsonLoose } from '../../src/text.js';
import { encodeWav } from '../../src/voiceprints.js';

export const DEFAULT_PORTS = [8000, 11434, 11436];

export function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return /\/v1$/i.test(u) ? u : `${u}/v1`;
}

const headers = (key) => ({ authorization: `Bearer ${key || 'local'}`, 'content-type': 'application/json' });

// Which role a model id probably has. A starting suggestion only; the person chooses.
export function guessRole(id) {
  const s = String(id).toLowerCase();
  if (/rerank/.test(s)) return 'other';
  if (/embed|bge|minilm|e5-|gte-|nomic|arctic-embed|sentence/.test(s)) return 'embedding';
  if (/whisper|parakeet|canary|asr|voxtral|speech|stt|transcrib/.test(s)) return 'stt';
  return 'chat';
}

// The first port that answers HTTP at all (a 401 means it is there and wants a key).
export async function detectBase(ports = DEFAULT_PORTS, f = fetch) {
  for (const port of ports) {
    const base = `http://localhost:${port}/v1`;
    try {
      const res = await f(`${base}/models`, { signal: AbortSignal.timeout(1500) });
      if (res.status) return base;
    } catch { /* not listening */ }
  }
  return '';
}

export async function listModels(base, key, f = fetch) {
  try {
    const res = await f(`${base}/models`, { headers: headers(key), signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: 'the server wants an API key (or the key is wrong)', ids: [] };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, ids: [] };
    const body = await res.json();
    const ids = (body.data || body.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
    return { ok: true, status: 200, ids };
  } catch (e) {
    return { ok: false, status: 0, error: `could not reach ${base} (${e.message})`, ids: [] };
  }
}

export async function probeEmbeddings(base, key, model, f = fetch) {
  try {
    const res = await f(`${base}/embeddings`, { method: 'POST', headers: headers(key), body: JSON.stringify({ model, input: ['hello world', 'a second sentence'], encoding_format: 'float' }), signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 700)}` };
    const rows = (await res.json()).data || [];
    const dim = rows[0]?.embedding?.length || 0;
    if (rows.length !== 2 || dim < 8 || rows[1].embedding.length !== dim) return { ok: false, error: 'the answer was not two equal-length vectors' };
    return { ok: true, dim };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Attest needs strict JSON back from the chat model. Reports whether the reply parsed, and
// whether the server accepts OpenAI's response_format (it works either way: Attest's parser is
// tolerant, this just says which case you are in).
export async function probeChat(base, key, model, f = fetch) {
  const ask = (extra) => f(`${base}/chat/completions`, {
    method: 'POST', headers: headers(key), signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: 'Reply with ONLY this JSON and nothing else: {"ok": true, "word": "pong"}' }], ...extra }),
  });
  try {
    let res = await ask({ response_format: { type: 'json_object' } });
    let jsonMode = true;
    if (res.status >= 400 && res.status < 500) { jsonMode = false; res = await ask({}); }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 700)}` };
    const text = (await res.json()).choices?.[0]?.message?.content || '';
    const parsed = parseJsonLoose(text);
    return { ok: Boolean(parsed), jsonMode, reply: text.slice(0, 80), error: parsed ? '' : 'the reply was not parseable JSON' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Does the transcription endpoint accept an upload, and does it return timestamped segments?
// A synthetic tone has no words, so with no --audio file `segments` may legitimately be empty;
// `timestampsChecked` says whether the answer means anything.
export async function probeStt(base, key, model, audioBytes, f = fetch) {
  const real = Boolean(audioBytes);
  const bytes = audioBytes || encodeWav(Float32Array.from({ length: 32000 }, (_, i) => Math.sin(i / 8) * 0.3), 16000);
  const fd = new FormData();
  fd.append('file', new File([bytes], real ? 'sample.wav' : 'tone.wav', { type: 'audio/wav' }));
  fd.append('model', model);
  fd.append('response_format', 'verbose_json');
  try {
    const res = await f(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key || 'local'}` }, body: fd, signal: AbortSignal.timeout(300000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 700)}` };
    const body = await res.json();
    const segs = (Array.isArray(body.segments) ? body.segments : []).filter((s) => Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)));
    return { ok: true, text: String(body.text || '').slice(0, 120), segments: segs.length, timestampsChecked: real, hasTimestamps: segs.length > 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---- .dev.vars ----

const MARK_START = '# --- Attest local mode (written by `npm run setup:local`; safe to edit) ---';
const MARK_END = '# --- end Attest local mode ---';

export function parseDevVars(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// Replaces the previous Attest local block (and any plain line setting one of the same names)
// and appends the new one. Everything else in the file is left alone.
export function mergeDevVars(existing, vars) {
  const keys = new Set(Object.keys(vars));
  const lines = String(existing || '').split('\n');
  const kept = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === MARK_START) { inBlock = true; continue; }
    if (line.trim() === MARK_END) { inBlock = false; continue; }
    if (inBlock) continue;
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m && keys.has(m[1])) continue;
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const block = [MARK_START, ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), MARK_END];
  return `${kept.join('\n')}${kept.length ? '\n\n' : ''}${block.join('\n')}\n`;
}

// What local mode needs in .dev.vars for these choices.
export function buildLocalVars({ base, key, chat, embed, stt, sttBase, sttKey, diarize, contextTokens }) {
  const v = {
    LOCAL_MODE: 'true',
    REQUIRE_ACCESS: 'false',
    LLM_BASE_URL: base, LLM_API_KEY: key || 'local', LLM_MODELS: chat, DEFAULT_MODEL: chat,
    LLM_CONTEXT_CHARS: String(Math.max(8000, Math.round((contextTokens || 32768) * 3))),
  };
  if (embed) { v.EMBED_MODEL = embed; }
  if (stt) {
    v.STT_BASE_URL = sttBase || base; v.STT_API_KEY = sttKey || key || 'local'; v.STT_MODELS = stt;
    if (diarize) v.LOCAL_DIARIZE = 'true';
  }
  return v;
}

// What we recommend, per role. `match` finds an installed copy whatever the exact repo name.
export const RECOMMENDED = {
  chat: {
    id: 'mlx-community/gpt-oss-20b-MXFP4-Q8', match: /gpt-oss-20b/i, size: 'about 12 GB',
    what: 'Writes the summaries, mind maps, answers and memory',
    note: 'Needs roughly 16 GB of RAM or more, plus room for a long context. Lighter and faster alternative: mlx-community/Qwen3.5-9B-MLX-4bit (about 5-6 GB)',
  },
  stt: {
    id: 'mlx-community/whisper-large-v3-turbo-asr-fp16', match: /whisper-large-v3-turbo-asr/i, size: 'about 1.6 GB',
    what: 'Turns audio into text with timestamps (Attest uses the timestamps to tell speakers apart)',
    note: 'Use the "-asr" version: it includes the Hugging Face tokenizer files oMLX needs. Plain mlx-community/whisper-* repos (and their -4bit builds) lack them and fail to load. mlx-community/whisper-large-v3-turbo-asr-4bit is the smaller one',
  },
  embedding: {
    id: 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ', match: /qwen3-embedding-0\.6b/i, size: 'under 1 GB',
    what: 'Lets Ask search by meaning instead of exact words (optional)',
    note: 'If your oMLX will not load it, try mlx-community/embeddinggemma-300m-4bit',
  },
};
export const SUGGESTED_MODELS = { chat: RECOMMENDED.chat.id, stt: RECOMMENDED.stt.id, embedding: RECOMMENDED.embedding.id };

// Shown before anything else, so the models can be downloaded first.
export function recommendationsText() {
  const row = (label, r) => `  ${label.padEnd(14)} ${r.id}\n  ${' '.repeat(14)} ${r.size}. ${r.what}.${r.note ? `\n  ${' '.repeat(14)} ${r.note}.` : ''}`;
  return [
    'Download these in oMLX first (admin page, Models, search Hugging Face):',
    '',
    row('Chat', RECOMMENDED.chat),
    row('Transcription', RECOMMENDED.stt),
    row('Embeddings', RECOMMENDED.embedding),
    '',
    'Chat is required. Transcription is needed to transcribe audio. Embeddings are optional.',
  ].join('\n');
}

// 1-based position of the recommended model for a role in `ids`, or 0 when it is not installed.
export function recommendedIndex(ids, role) {
  const r = RECOMMENDED[role];
  const i = r ? ids.findIndex((id) => r.match.test(id)) : -1;
  return i + 1;
}

// Roles whose recommended model is not among `ids`.
export const missingRecommended = (ids) => Object.keys(RECOMMENDED).filter((role) => !recommendedIndex(ids, role));

// The files oMLX's Whisper loader wants beside the weights. The MLX-only conversions omit them.
export const WHISPER_PROCESSOR_FILES = [
  'preprocessor_config.json', 'tokenizer.json', 'special_tokens_map.json', 'tokenizer_config.json',
  'vocab.json', 'merges.txt', 'added_tokens.json', 'normalizer.json',
];

// Turns oMLX's "STT model failed to load" error into something to act on. Null for any other error.
export function explainSttError(message) {
  const msg = String(message || '');
  const missing = msg.match(/Model '([^']+)' not found\.?\s*Available:\s*([^"}]*)/i);
  if (missing) {
    return [
      `oMLX does not have "${missing[1]}" installed (any more). It has: ${missing[2].trim() || 'no models'}.`,
      `Download a Whisper model in oMLX (recommended: ${RECOMMENDED.stt.id}), then run \`npm run setup:local\` again and choose it.`,
    ].join('\n');
  }
  if (!/preprocessor_config|feature-extractor|tokenizer files/i.test(msg)) return null;
  const dir = (msg.match(/STT model '([^']+)'/) || [])[1];
  const lines = [
    'oMLX could not load this Whisper model: it is an MLX-only conversion without the Hugging Face tokenizer files.',
    'Two ways to fix it:',
    `  1. In oMLX, download an "-asr" version instead (it includes the files): ${RECOMMENDED.stt.id}`,
    '     then run `npm run setup:local` again and choose it.',
    '  2. Or keep this model and add the files to it:',
  ];
  if (dir) {
    lines.push(`       cd "${dir}"`);
    lines.push(`       for f in ${WHISPER_PROCESSOR_FILES.join(' ')}; do curl -fLO https://huggingface.co/openai/whisper-large-v3-turbo/resolve/main/$f; done`);
    lines.push('     then reload the model in oMLX (admin page > Models) and run `npm run local:check` again.');
  } else {
    lines.push('       copy the tokenizer and processor files from https://huggingface.co/openai/whisper-large-v3-turbo into the model folder, then reload models in oMLX.');
  }
  return lines.join('\n');
}
