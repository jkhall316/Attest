// Voiceprint enrollment, browser side (#14): slice a 2-10s clip of one speaker out of
// the finished recording, encode it as 16-bit mono WAV, POST it to the person.
//
// These helpers are mirrored by hand from src/voiceprints.js (same contract, unit
// tested there) because this script has no build step and cannot import server-side
// modules. Keep both copies in lockstep if either changes.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { embedWindow, EMBED_MODEL } from './voiceembed.js';

// Segment times are SECONDS (diarized_json); the window is returned in seconds. Null when
// the speaker's longest turn is shorter than minMs. Mirrors src/voiceprints.js exactly.
export function pickClipWindow(segments, label, minMs, maxMs) {
  const turns = (segments || []).filter((s) =>
    (s.speaker || 'Speaker') === label && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  if (!turns.length) return null;
  const longest = turns.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const end = Math.min(longest.end, longest.start + maxMs / 1000);
  if ((end - longest.start) * 1000 < minMs) return null;
  return { start: longest.start, end };
}

export function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// Downmix [start,end) (in samples, at the buffer's own rate) across all channels to
// one mono Float32Array -- averaging channels rather than taking just the first one
// so a stereo mic pair does not silently drop a side.
export function downmixMono(audioBuf, startSample, endSample) {
  const len = endSample - startSample;
  const out = new Float32Array(len);
  for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
    const data = audioBuf.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[startSample + i] / audioBuf.numberOfChannels;
  }
  return out;
}

// Linear-interpolation resample to 16kHz -- good enough for a voice reference clip;
// no need for a proper sinc filter here.
export function resampleTo16k(samples, sampleRate) {
  if (sampleRate === 16000) return samples;
  const ratio = sampleRate / 16000;
  const outLen = Math.round(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx), i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcIdx - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

// Resolves each voice button's name to a person id (voiceprint upload is person-scoped,
// but the chip only knows the name). Only chips a human confirmed render these buttons.
// What the voice buttons should say for a person, given how many voice samples are saved for
// them. "Enroll voice" is the first step, so it only reads that way when there is no sample yet;
// after that it is an optional "Add voice sample", and "Clear voices" only exists when there is
// something to clear.
export function voiceButtonState(person) {
  const n = Number(person?.voiceprint_count) || 0;
  const name = person?.name || 'this person';
  return n
    ? { enrolled: true, enroll: 'Add voice sample', clear: `Clear voices (${n})`, showClear: true, pill: `voice saved · ${n}`,
        enrollTitle: `${name}'s voice is already saved (${n} sample${n === 1 ? '' : 's'}). Adding another from this recording makes recognising them more reliable.` }
    : { enrolled: false, enroll: 'Enroll voice', clear: 'Clear voices', showClear: false, pill: '',
        enrollTitle: `Save ${name}'s voice from this recording so Attest recognises them in your other recordings.` };
}

// Brings every voice button and badge for `person` in line with `count` saved samples.
function refreshVoiceUi(person, count) {
  const st = voiceButtonState({ ...person, voiceprint_count: count });
  $('main').querySelectorAll('.enroll-voice, .clear-voice').forEach((btn) => {
    if (btn.dataset.name !== person.name) return;
    btn.disabled = false;
    if (btn.classList.contains('clear-voice')) { btn.hidden = !st.showClear; btn.textContent = st.clear; return; }
    btn.textContent = st.enroll;
    btn.title = st.enrollTitle;
    const prev = btn.previousElementSibling;
    const pill = prev?.classList.contains('voice-pill') ? prev : null;
    if (st.enrolled) {
      if (pill) pill.textContent = st.pill;
      else btn.insertAdjacentHTML('beforebegin', `<span class="pill ready voice-pill">${esc(st.pill)}</span> `);
    } else pill?.remove();
  });
}

// Resolves each voice button's name to a person id (voiceprint upload is person-scoped,
// but the chip only knows the name). Only chips a human confirmed render these buttons.
export async function wireVoiceprintButtons(r) {
  const btns = $('main').querySelectorAll('.enroll-voice, .clear-voice');
  if (!btns.length) return;
  let people;
  try { ({ people } = await api('/people')); } catch { return; }
  btns.forEach((btn) => {
    const person = people.find((p) => p.name === btn.dataset.name);
    if (!person) { btn.disabled = true; return; } // confirmed names always have a row; belt and braces
    btn.onclick = btn.classList.contains('clear-voice')
      ? () => clearVoices(person, btn)
      : () => enrollVoice(r, btn.dataset.label, person, btn);
    refreshVoiceUi(person, person.voiceprint_count);
  });
}

async function clearVoices(person, btn) {
  if (!confirm(`Forget every saved voice sample for ${person.name}?`)) return;
  try {
    const { removed } = await api(`/people/${person.id}/voiceprints`, { method: 'DELETE' });
    btn.textContent = `Cleared (${removed})`;
    setTimeout(() => refreshVoiceUi(person, 0), 1200);
  } catch (e) {
    alert(e.message);
  }
}

async function enrollVoice(r, label, person, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enrolling…';
  let ctx;
  try {
    const win = pickClipWindow(r.segments, label, 2000, 10000);
    if (!win) throw new Error('this speaker never talks for 2 seconds in a row, so there is no usable clip');
    const res = await fetch(`/api/recordings/${r.id}/audio`);
    if (!res.ok) throw new Error('could not load the recording audio');
    const buf = await res.arrayBuffer();
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await ctx.decodeAudioData(buf);
    const startSample = Math.max(0, Math.floor(win.start * audioBuf.sampleRate));
    const endSample = Math.min(audioBuf.length, Math.ceil(win.end * audioBuf.sampleRate));
    const mono = downmixMono(audioBuf, startSample, endSample);
    const resampled = resampleTo16k(mono, audioBuf.sampleRate);
    const wav = encodeWav(resampled, 16000);
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'voiceprint.wav');
    fd.append('duration_ms', String(Math.round((resampled.length / 16000) * 1000)));
    fd.append('recording_id', r.id);
    fd.append('label', label);
    // Local voice embedding (#24) so this clip can be matched in later recordings on any
    // provider. If it fails the WAV is still enrolled; the backfill makes it later.
    if (state.META?.voice_match_enabled) {
      try {
        btn.textContent = 'Loading voice model…';
        const emb = await embedWindow(resampled);
        fd.append('embedding', JSON.stringify(Array.from(emb)));
        fd.append('embedding_model', state.META.voice_model || EMBED_MODEL);
      } catch (e) { console.warn('voice embedding skipped:', e); }
      btn.textContent = 'Enrolling…';
    }
    const { voiceprint_count } = await api(`/people/${person.id}/voiceprint`, { method: 'POST', body: fd });
    btn.textContent = `Saved ✓ (${voiceprint_count})`;
    setTimeout(() => refreshVoiceUi(person, voiceprint_count), 1500);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert(e.message);
  } finally {
    ctx?.close?.();
  }
}
