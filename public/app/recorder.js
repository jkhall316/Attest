// Recording: MediaRecorder + the #7 live preview + the final upload.
//
// Two recorders share one mic stream:
//  - the MAIN recorder (timeslice 5s) is the record of truth. Every slice is kept in
//    memory AND stored on the server as a "part", so a dead tab can be recovered.
//  - a PREVIEW recorder is restarted every 5s so each blob is a complete, standalone
//    webm that the mini transcriber can decode (slices 2+ of a timeslice stream have no
//    header). Its only job is the live text.
// Everything an async callback needs is captured in a per-recording `rec` object, never
// read back from the shared `state` after an await.

import { getArea } from './scope.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { refresh } from './lists.js';
import { open } from './recordings.js';

const SLICE_MS = 5000;
// Stop 2MB short of the server's upload cap (24MB, or 48MB on OpenRouter; from /api/meta).
const maxBytes = () => (state.META?.max_upload || 24 * 1024 * 1024) - 2 * 1024 * 1024;
const POST_TIMEOUT_MS = 20000;

const withTimeout = (opts = {}) => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  return { ...opts, signal: ctl.signal };
};

// Drives the Record button's pulse ring from the live mic level. Purely cosmetic: any failure
// (no AudioContext, a suspended context) just leaves the CSS pulse running.
function startLevel(stream, btn, rec) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      btn.style.setProperty('--level', String(Math.min(1, peak / 64)));
      raf = requestAnimationFrame(tick);
    };
    tick();
    rec.stopLevel = () => { cancelAnimationFrame(raf); ctx.close?.(); };
  } catch { /* cosmetic only */ }
}

export async function startStop() {
  if (state.recorder) {
    state.recorder.stop();
    return;
  }
  if (state.finishing) return; // previous recording is still uploading
  const btn = $('rec');
  btn.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    btn.disabled = false;
    return alert('Microphone permission denied.');
  }

  // Build the recorder BEFORE creating the server row so a browser that cannot record
  // webm fails without leaving a hot mic or an orphan row behind.
  let recorder;
  try {
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    // 32 kbps opus is plenty for speech and keeps an hour near 14MB, under the 24MB upload
    // cap (hours of call fit). It is a hint: Chrome/Edge follow it, Safari may ignore it.
    recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32000 });
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    btn.disabled = false;
    return alert(`This browser cannot record audio/webm (${e.message}). Use "upload audio" instead.`);
  }

  const rec = { id: null, chunks: [], bytes: 0, queue: Promise.resolve(), parts: Promise.resolve(), n: 0, startedAt: Date.now(), previewOn: true, stream };
  $('live').textContent = '';
  try {
    const { id } = await api('/recordings/live', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: $('title').value, template: $('template').value, area: getArea() || undefined,
        model: $('model').value, transcriber: $('transcriber').value,
      }),
    });
    rec.id = id;
  } catch {
    rec.id = null; // no preview and no crash recovery, but the final upload still works
  }

  state.recorder = recorder;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    rec.chunks.push(e.data);
    rec.bytes += e.data.size;
    if (rec.id) rec.parts = rec.parts.then(() => postPart(rec, e.data, rec.n++));
    if (rec.bytes > maxBytes() && recorder.state === 'recording') {
      alert('Reached the maximum recording size; stopping and saving.');
      recorder.stop();
    }
  };
  recorder.onstop = () => finish(rec);
  recorder.start(SLICE_MS);
  startPreview(rec);

  btn.disabled = false;
  btn.classList.add('on');
  btn.textContent = '■ Stop';
  startLevel(stream, btn, rec);
  state.tick = setInterval(() => {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}

// Restarts a short-lived recorder every SLICE_MS; each stop yields one complete webm.
function startPreview(rec) {
  if (!rec.id) return;
  const loop = () => {
    if (!rec.previewOn) return;
    let r;
    try { r = new MediaRecorder(rec.stream); } catch { rec.previewOn = false; return; }
    const bits = [];
    r.ondataavailable = (e) => e.data.size && bits.push(e.data);
    r.onstop = () => {
      if (bits.length && rec.previewOn) {
        const blob = new Blob(bits, { type: 'audio/webm' });
        rec.queue = rec.queue.then(() => postLiveChunk(rec, blob));
      }
      loop();
    };
    r.start();
    setTimeout(() => r.state === 'recording' && r.stop(), SLICE_MS);
  };
  loop();
}

// A preview failure only turns the preview off; it never touches the audio or the row.
async function postLiveChunk(rec, blob) {
  if (!rec.previewOn || !rec.id) return;
  try {
    const { live_transcript } = await api(`/recordings/${rec.id}/live`, withTimeout({ method: 'POST', body: blob }));
    $('live').textContent = live_transcript;
  } catch {
    rec.previewOn = false;
  }
}

// Best-effort, retried: these parts are the crash-recovery copy of the audio.
async function postPart(rec, blob, n) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api(`/recordings/${rec.id}/part?n=${n}`, withTimeout({ method: 'POST', body: blob }));
      return;
    } catch { /* retry */ }
  }
}

async function finish(rec) {
  state.finishing = true;
  state.recorder = null;
  rec.previewOn = false;
  clearInterval(state.tick);
  rec.stream.getTracks().forEach((t) => t.stop());
  const ms = Date.now() - rec.startedAt;
  $('rec').classList.remove('on');
  $('rec').style.removeProperty('--level');
  rec.stopLevel?.();
  $('rec').textContent = '● Record';
  $('rec').disabled = true;
  $('timer').textContent = 'Uploading…';
  try {
    await rec.queue;
    await rec.parts;
    await finishRecording(rec, new Blob(rec.chunks, { type: 'audio/webm' }), ms);
  } finally {
    $('timer').textContent = '';
    $('rec').disabled = false;
    state.finishing = false;
  }
}

// Finalizes the row liveStart() created. Falls back to the plain upload path if live
// creation never succeeded; if the full-blob PUT fails, asks the server to rebuild the
// audio from the stored parts instead of losing the recording.
async function finishRecording(rec, blob, durationMs) {
  if (!rec.id) return submit(blob, durationMs);
  try {
    const qs = durationMs ? `?duration_ms=${durationMs}` : '';
    try {
      await api(`/recordings/${rec.id}/audio${qs}`, { method: 'PUT', body: blob });
    } catch {
      await api(`/recordings/${rec.id}/recover`, { method: 'POST' });
    }
    $('title').value = '';
    $('live').textContent = '';
    state.current = rec.id;
    await refresh();
    await open(rec.id);
  } catch (e) {
    alert(`${e.message}. The audio is saved on the server; open the recording and use "Recover audio".`);
    refresh();
  }
}

export async function submit(blob, durationMs) {
  const fd = new FormData();
  fd.append('file', blob, 'audio.webm');
  fd.append('title', $('title').value);
  fd.append('template', $('template').value);
  fd.append('model', $('model').value);
  fd.append('transcriber', $('transcriber').value);
  if (getArea()) fd.append('area', getArea());
  if (durationMs) fd.append('duration_ms', String(durationMs));
  try {
    const { id } = await api('/recordings', { method: 'POST', body: fd });
    $('title').value = '';
    state.current = id;
    await refresh();
    await open(id);
  } catch (e) {
    alert(e.message);
  }
}
