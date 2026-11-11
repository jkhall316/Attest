// Custom audio player: seek bar with a loaded-buffer indicator and hover preview, play/pause,
// -15s / +15s, speed toggle, and a tiny event bus so the transcript can follow playback and
// seek on click. It wraps a hidden <audio>, so streaming and codecs are the browser's own.

import { icon } from './icons.js';
import { fmtClock } from './format.js';

const SPEEDS = [1, 1.25, 1.5, 2];
const ticks = new Set();
let current = null; // { audio, duration }

export const onTick = (fn) => { ticks.add(fn); return () => ticks.delete(fn); };
export const clearTicks = () => ticks.clear();
export function seekTo(sec, play = true) {
  if (!current) return;
  current.audio.currentTime = Math.max(0, sec);
  if (play) current.audio.play().catch(() => {});
}

export function playerHtml(r) {
  return `<div class="player" id="player" role="group" aria-label="Audio player">
    <audio id="pl-audio" preload="metadata" src="/api/recordings/${r.id}/audio" hidden></audio>
    <button class="pl-btn" data-skip="-15" aria-label="Back 15 seconds" title="Back 15 seconds">${icon('back15', 20)}</button>
    <button class="pl-btn pl-play" id="pl-play" aria-label="Play" title="Play / pause">${icon('play', 18)}</button>
    <button class="pl-btn" data-skip="15" aria-label="Forward 15 seconds" title="Forward 15 seconds">${icon('fwd15', 20)}</button>
    <div class="pl-track" id="pl-track" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="pl-rail"><div class="pl-buf" id="pl-buf"></div><div class="pl-prog" id="pl-prog"></div></div>
      <div class="pl-thumb" id="pl-thumb"></div><div class="pl-tip" id="pl-tip">0:00</div>
    </div>
    <span class="pl-time"><span id="pl-cur">0:00</span> / <span id="pl-rem">-0:00</span></span>
    <button class="pl-speed" id="pl-speed" title="Playback speed" aria-label="Playback speed">1×</button>
  </div>`;
}

// `fallbackSec` covers MediaRecorder webm files, whose <audio>.duration is Infinity.
export function wirePlayer(fallbackSec = 0) {
  const audio = document.getElementById('pl-audio');
  const track = document.getElementById('pl-track');
  if (!audio || !track) return;
  const $ = (id) => document.getElementById(id);
  const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackSec || 0);
  current = { audio, dur };

  let raf = 0;
  const paint = () => {
    const d = dur(), t = audio.currentTime;
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    $('pl-prog').style.width = pct + '%';
    $('pl-thumb').style.left = pct + '%';
    $('pl-cur').textContent = fmtClock(t);
    $('pl-rem').textContent = d ? '-' + fmtClock(Math.max(0, d - t)) : '';
    track.setAttribute('aria-valuenow', String(Math.round(pct)));
    if (audio.buffered.length && d) $('pl-buf').style.width = Math.min(100, (audio.buffered.end(audio.buffered.length - 1) / d) * 100) + '%';
    for (const fn of ticks) fn(t);
  };
  const loop = () => { paint(); if (!audio.paused) raf = requestAnimationFrame(loop); };

  audio.addEventListener('play', () => { $('pl-play').innerHTML = icon('pause', 18); $('pl-play').setAttribute('aria-label', 'Pause'); cancelAnimationFrame(raf); loop(); });
  audio.addEventListener('pause', () => { $('pl-play').innerHTML = icon('play', 18); $('pl-play').setAttribute('aria-label', 'Play'); });
  for (const ev of ['timeupdate', 'loadedmetadata', 'durationchange', 'progress', 'seeked']) audio.addEventListener(ev, paint);
  $('pl-play').onclick = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());
  document.querySelectorAll('#player [data-skip]').forEach((b) => {
    b.onclick = () => { audio.currentTime = Math.max(0, Math.min(dur() || Infinity, audio.currentTime + Number(b.dataset.skip))); };
  });
  let si = 0;
  $('pl-speed').onclick = () => {
    si = (si + 1) % SPEEDS.length;
    audio.playbackRate = SPEEDS[si];
    $('pl-speed').textContent = SPEEDS[si] + '×';
  };

  const at = (e) => { const b = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)); };
  track.addEventListener('pointermove', (e) => {
    const f = at(e);
    $('pl-tip').style.left = f * 100 + '%';
    $('pl-tip').textContent = fmtClock(f * dur());
  });
  const scrub = (e) => { if (dur()) audio.currentTime = at(e) * dur(); };
  track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); scrub(e); track.onpointermove = (ev) => { if (ev.buttons) scrub(ev); }; });
  track.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0;
    if (step) { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime + step); }
    if (e.key === ' ') { e.preventDefault(); $('pl-play').click(); }
  });
  paint();
}
