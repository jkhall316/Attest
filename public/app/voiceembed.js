// Voice embeddings in the browser (#24): ReDimNet2-B6 (MIT, Hugging Face soniqo/ReDimNet2-B6-ONNX-FP32,
// pinned commit) run with onnxruntime-web. Input is a 6 s window of 16 kHz mono raw waveform,
// output a 192-d L2-normalised speaker embedding. Nothing here talks to the Worker, and the
// audio never leaves the browser: only the 192 numbers per speaker are sent.
//
// The pure helpers (fitWindow, planWindows, meanNormalize) are unit-tested; the ort/model
// parts only run in a real browser.

export const EMBED_MODEL = 'redimnet2-b6@e911e3f';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const MODEL_URL = 'https://huggingface.co/soniqo/ReDimNet2-B6-ONNX-FP32/resolve/e911e3f063899805f3d94ee5d1db53fff8e9f3e8/ReDimNet2B6.onnx';
const MODEL_SHA256 = 'd960e9f713eaba712f44498e82221b6fc12fcd7eaacd367c9eac45d3a6ce59ec';
const CACHE_NAME = 'attest-voice-model-v1';
export const RATE = 16000;
export const WINDOW = 96000; // 6 s
// Decoding the whole file to 16 kHz mono costs ~3.8MB per minute (about 350MB at 90 min, and
// more at the peak), so there is a ceiling. Matching runs by itself only up to AUTO_MAX_MS; a
// longer recording gets a "Recognise voices" button instead of freezing the tab unasked.
export const AUTO_MAX_MS = 15 * 60 * 1000;
export const MAX_DECODE_MS = 90 * 60 * 1000;
// Hard budget on model runs per recording. One window is ~1.5 s of CPU, so 24 windows is about
// 35 s in the background worker however many "speakers" the diarizer invented (it made 6 out of
// one person on a 41-minute import). Up to 8 speakers are matched, the ones who talk the most.
export const MAX_LABELS = 8;
export const MAX_WINDOWS = 24;
export const WINDOWS_PER_LABEL = 3;

/* ---- pure helpers ---- */

// Exactly WINDOW samples: shorter input is tiled, longer is centre-cropped.
export function fitWindow(samples) {
  const out = new Float32Array(WINDOW);
  const n = samples.length;
  if (!n) return out;
  if (n >= WINDOW) {
    out.set(samples.subarray(Math.floor((n - WINDOW) / 2), Math.floor((n - WINDOW) / 2) + WINDOW));
  } else {
    for (let i = 0; i < WINDOW; i++) out[i] = samples[i % n];
  }
  return out;
}

// Windows (seconds) to embed for one speaker label. Turns of at least 2.5 s (2 s left after
// trimming 0.25 s of crosstalk off each end), longest first, at most 6 turns and 8 windows;
// a trimmed turn over 6 s yields up to 2 non-overlapping 6 s windows.
export function planWindows(segments, label, { minTurn = 2.5, trim = 0.25, maxTurns = 6, maxWindows = 8 } = {}) {
  const turns = (segments || [])
    .filter((s) => (s.speaker || 'Speaker') === label && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= minTurn)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, maxTurns);
  const out = [];
  for (const t of turns) {
    const start = t.start + trim, len = t.end - t.start - 2 * trim;
    const n = len > 6 ? Math.min(2, Math.floor(len / 6)) : 1;
    for (let i = 0; i < n && out.length < maxWindows; i++) out.push({ start: start + i * 6, end: start + i * 6 + Math.min(6, len) });
  }
  return out;
}

// What to embed for a whole recording, within the budget: the speakers who talk the most
// (at most MAX_LABELS, each with enough speech to be matched), WINDOWS_PER_LABEL windows
// each, and MAX_WINDOWS in total, dealt out round-robin so every chosen speaker is covered.
// Returns [{label, windows}] in speaking-time order.
export function planWork(segments, labels, { minSpeechSec = 4 } = {}) {
  const talk = (label) => (segments || []).filter((s) => (s.speaker || 'Speaker') === label && Number.isFinite(s.start) && Number.isFinite(s.end))
    .reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  const ranked = (labels || []).map((label) => ({ label, sec: talk(label) }))
    .filter((x) => x.sec >= minSpeechSec).sort((a, b) => b.sec - a.sec).slice(0, MAX_LABELS);
  const plans = ranked.map(({ label }) => ({ label, windows: planWindows(segments, label, { maxWindows: WINDOWS_PER_LABEL }), taken: [] }));
  let budget = MAX_WINDOWS;
  for (let i = 0; budget > 0; i++) {
    let any = false;
    for (const p of plans) {
      if (budget > 0 && i < p.windows.length) { p.taken.push(p.windows[i]); budget--; any = true; }
    }
    if (!any) break;
  }
  return plans.filter((p) => p.taken.length).map((p) => ({ label: p.label, windows: p.taken }));
}

// Average of embeddings, re-normalised to unit length.
export function meanNormalize(embs) {
  const out = new Float32Array(embs[0].length);
  for (const e of embs) for (let i = 0; i < out.length; i++) out[i] += e[i];
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/* ---- model + runtime (browser only) ---- */

let sessionPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error('could not load the voice runtime (onnxruntime-web)'));
    document.head.appendChild(el);
  });
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function modelBytes(onStatus) {
  const cache = await caches.open(CACHE_NAME);
  let res = await cache.match(MODEL_URL);
  if (!res) {
    onStatus?.('downloading voice model (49MB, once)…');
    const net = await fetch(MODEL_URL);
    if (!net.ok) throw new Error(`voice model download failed (${net.status})`);
    const bytes = await net.arrayBuffer();
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== MODEL_SHA256) throw new Error('voice model failed its integrity check');
    await cache.put(MODEL_URL, new Response(bytes));
    return bytes;
  }
  const bytes = await res.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== MODEL_SHA256) {
    await cache.delete(MODEL_URL);
    throw new Error('cached voice model failed its integrity check; it was removed, try again');
  }
  return bytes;
}

// Lazy and memoised; a failure clears the memo so the next attempt retries.
export function loadModel(onStatus) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!window.ort) await loadScript(`${ORT_BASE}ort.wasm.min.js`);
      const ort = window.ort;
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1; // no SharedArrayBuffer: the app sends no COOP/COEP headers
      // proxy = run the model in a Web Worker. On the page's own thread each 6 s window held
      // the UI for ~1.5 s, back to back, which froze the tab on long recordings. In a worker
      // the page stalled 1 ms in measurement. If the worker cannot start, fall back to inline.
      ort.env.wasm.proxy = true;
      const bytes = new Uint8Array(await modelBytes(onStatus));
      let session;
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      } catch (e) {
        console.warn('voice model worker unavailable, running inline:', e);
        ort.env.wasm.proxy = false;
        session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      }
      if (session.inputNames[0] !== 'audio' || session.outputNames[0] !== 'embedding') {
        throw new Error('unexpected voice model signature');
      }
      return session;
    })().catch((e) => { sessionPromise = null; throw e; });
  }
  return sessionPromise;
}

// 16 kHz mono samples (any length) -> Float32Array(192).
export async function embedWindow(samples16k, onStatus) {
  const session = await loadModel(onStatus);
  const input = new window.ort.Tensor('float32', fitWindow(samples16k), [1, WINDOW]);
  const out = await session.run({ audio: input });
  return Float32Array.from(out.embedding.data);
}

const tick = () => new Promise((r) => setTimeout(r, 0)); // let the page paint and take input

// Whole recording -> speaker embeddings, within planWork()'s budget. `labels` are the raw
// diarizer labels that segments carry. speech_ms is the audio actually embedded.
// opts.onProgress(done, total) reports progress; opts.job.cancel = true stops between windows.
export async function speakerEmbeddings(samples16k, segments, labels, opts = {}) {
  const plan = planWork(segments, labels);
  const total = plan.reduce((n, p) => n + p.windows.length, 0);
  const result = [];
  let done = 0;
  for (const { label, windows } of plan) {
    const embs = [];
    let ms = 0;
    for (const w of windows) {
      if (opts.job?.cancel) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const a = Math.max(0, Math.floor(w.start * RATE)), b = Math.min(samples16k.length, Math.ceil(w.end * RATE));
      done++;
      if (b - a >= RATE) {
        embs.push(await embedWindow(samples16k.slice(a, b))); // a copy: the worker takes ownership of what it is sent
        ms += ((b - a) / RATE) * 1000;
      }
      opts.onProgress?.(done, total);
      await tick();
    }
    if (embs.length) result.push({ label, embedding: meanNormalize(embs), speech_ms: Math.round(ms) });
  }
  return result;
}
