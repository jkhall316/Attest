// Voice matching orchestration (#24): decide whether a recording should be matched, make the
// embeddings in this tab, and ask the Worker to do the (suggestion-only) matching. Matching
// is strictly best-effort: every failure is logged and swallowed so it can never block a
// recording from being transcribed or summarized.

import { api } from './api.js';
import { state } from './state.js';
import { downmixMono } from './voiceprints.js';
import { embedWindow, speakerEmbeddings, AUTO_MAX_MS, MAX_DECODE_MS, EMBED_MODEL } from './voiceembed.js';

// 16 kHz mono Float32Array from encoded audio. An OfflineAudioContext at 16 kHz makes the
// browser resample while decoding, so no separate resampler runs over an hour of audio.
export async function decode16k(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  return buf.numberOfChannels === 1 ? buf.getChannelData(0) : downmixMono(buf, 0, buf.length);
}

// A run that failed, was cancelled or found nothing to do is remembered per recording (in this
// browser) so opening it again does not retry by itself. The "Recognise voices" button still can.
const skipKey = (id) => `attest.vmskip.${id}`;
export const skipped = (id) => { try { return Boolean(localStorage.getItem(skipKey(id))); } catch { return false; } };
export const markSkipped = (id) => { try { localStorage.setItem(skipKey(id), String(Date.now())); } catch { /* private window */ } };
const clearSkipped = (id) => { try { localStorage.removeItem(skipKey(id)); } catch { /* private window */ } };

const running = new Set(); // recording ids being matched right now: one run at a time each

// Cheap checks only; no network. The setting is on, there are diarized segments, and at least
// one label a human has not confirmed. `manual` is a person pressing the button: it lifts the
// 15-minute automatic limit (up to the decode ceiling) and ignores an earlier skip.
export function eligible(r, { manual = false } = {}) {
  if (!state.META?.voice_match_enabled) return false;
  if (!r?.segments?.length || r.has_audio === false || !r.speakers?.some((s) => !s.confirmed)) return false;
  if (running.has(r.id)) return false;
  if (!manual && skipped(r.id)) return false;
  if (r.duration_ms && r.duration_ms > (manual ? MAX_DECODE_MS : AUTO_MAX_MS)) return false;
  return true;
}

// A recording that would be matched, except that it is too long to do unasked.
export function needsManual(r) {
  return Boolean(!r?.voice_match && r?.status === 'ready' && r.duration_ms > AUTO_MAX_MS && eligible(r, { manual: true }));
}

// Make sure every enrolled clip has an embedding for the current model (clips enrolled before
// this feature, or whose embedding failed). Returns how many enrolled embeddings exist.
export async function ensureEnrolledEmbeddings(onStatus) {
  const list = await api('/voiceprints');
  let count = list.embedded_count;
  for (const v of list.voiceprints.filter((x) => !x.has_embedding)) {
    try {
      onStatus?.(`preparing saved voice for ${v.name}…`);
      const res = await fetch(`/api/voiceprints/${v.id}/audio`);
      if (!res.ok) continue;
      const emb = await embedWindow(await decode16k(await res.arrayBuffer()), onStatus);
      await api(`/voiceprints/${v.id}/embedding`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: list.model || EMBED_MODEL, embedding: Array.from(emb) }),
      });
      count++;
    } catch (e) {
      console.warn('voice backfill failed for', v.id, e);
    }
  }
  return count;
}

const postVoiceMatch = (r, speakers) => api(`/recordings/${r.id}/voice-match`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: state.META.voice_model || EMBED_MODEL,
    speakers: speakers.map((s) => ({ ...s, embedding: Array.from(s.embedding) })),
  }),
});

// Match enrolled voices from embeddings that already exist (local speaker detection made them),
// so no model runs are needed. Best effort: null when nobody is enrolled or it fails.
export async function matchFromEmbeddings(r, speakers, onStatus) {
  try {
    if (!state.META?.voice_match_enabled || !speakers?.length || !r.speakers?.some((s) => !s.confirmed)) return null;
    if (!(await ensureEnrolledEmbeddings(onStatus))) return null;
    onStatus?.('Recognising voices…');
    return await postVoiceMatch(r, speakers);
  } catch (e) {
    console.warn('voice matching skipped:', e);
    return null;
  }
}

// Returns the updated row (with voice_changed), or null when nothing was done / it failed.
// opts.manual: started by the button. opts.job: {cancel:true} stops it between windows.
export async function matchRecording(r, onStatus, opts = {}) {
  if (!eligible(r, { manual: opts.manual })) return null;
  running.add(r.id);
  try {
    if (!(await ensureEnrolledEmbeddings(onStatus))) { markSkipped(r.id); return null; } // nobody enrolled: skip the audio work
    onStatus?.('Recognising voices… loading audio');
    const res = await fetch(`/api/recordings/${r.id}/audio`);
    if (!res.ok) throw new Error('could not load the recording audio');
    const samples = await decode16k(await res.arrayBuffer());
    const labels = r.speakers.filter((s) => !s.confirmed).map((s) => s.label);
    const speakers = await speakerEmbeddings(samples, r.segments, labels, {
      job: opts.job,
      onProgress: (done, total) => onStatus?.(`Recognising voices… ${done}/${total}`),
    });
    if (!speakers.length) { markSkipped(r.id); return null; }
    const out = await postVoiceMatch(r, speakers);
    clearSkipped(r.id);
    return out;
  } catch (e) {
    markSkipped(r.id);
    if (e?.cancelled) { onStatus?.('Voice recognition cancelled.'); return null; }
    console.warn('voice matching skipped:', e);
    onStatus?.(`Voice matching skipped: ${e.message}`);
    return null;
  } finally {
    running.delete(r.id);
  }
}
