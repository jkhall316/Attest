// Custom audio player: seek bar with a loaded-buffer indicator and hover preview, play/pause,
// -15s / +15s, speed toggle, and a tiny event bus so the transcript can follow playback and
// seek on click. It wraps a hidden <audio>, so streaming and codecs are the browser's own.
// When the transcript has timed segments, the seek bar is a waveform drawn from them: each bar
// is how much of that slice of time had speech, coloured by whoever spoke most in it. It is real
// data from the transcript, not decoded audio, so it costs nothing to draw on a two-hour file.

import { icon } from './icons.js';
import { fmtClock, displayNames, speakerColor } from './format.js';

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
const BARS = 96;

// A speaker's colour: their talk-balance colour when listed there, else a stable hue from the name.
export function waveColor(name, stats = []) {
  const i = stats.findIndex((s) => s.name === name);
  if (i >= 0) return speakerColor(i);
  let h = 0;
  for (const c of String(name || '?')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 64%)`;
}

// segments -> [{h: 0..1, who}] x BARS. Pure, for tests. Empty when there is nothing timed.
// Height is the share of the slice with speech, scaled by how fast words came (characters per
// second, relative to the busiest slice), so a meeting with no silences still has a shape.
export function waveBars(segments, speakers, duration = 0, n = BARS) {
  const segs = (segments || []).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  const total = segs.reduce((m, s) => Math.max(m, s.end), duration || 0);
  if (!segs.length || !(total > 0)) return [];
  const names = displayNames(speakers);
  const step = total / n;
  const bins = Array.from({ length: n }, () => ({ speech: 0, chars: 0, by: new Map() }));
  for (const s of segs) {
    const who = names.get(s.speaker)?.shown || s.speaker || 'Speaker';
    for (let i = Math.floor(s.start / step); i < n && i * step < s.end; i++) {
      const lo = Math.max(s.start, i * step), hi = Math.min(s.end, (i + 1) * step);
      if (hi <= lo) continue;
      bins[i].speech += hi - lo;
      bins[i].chars += String(s.text || '').length * ((hi - lo) / (s.end - s.start));
      bins[i].by.set(who, (bins[i].by.get(who) || 0) + (hi - lo));
    }
  }
  const rate = (b) => (b.speech ? b.chars / b.speech : 0);
  const peak = Math.max(...bins.map(rate)) || 1;
  return bins.map((b) => {
    let who = '', best = 0;
    for (const [k, v] of b.by) if (v > best) { best = v; who = k; }
    const share = Math.min(1, b.speech / step);
    return { h: Math.round(share * (0.35 + 0.65 * (rate(b) / peak)) * 100) / 100, who };
  });
}

function waveHtml(bars, stats) {
  // Silence still gets a short tick so the timeline reads as continuous.
  const row = bars.map((b) => `<i style="--h:${Math.round(12 + b.h * 88)}%;${b.who ? `--wc:${waveColor(b.who, stats)}` : ''}"></i>`).join('');
  return `<div class="pl-wave" aria-hidden="true">${row}</div><div class="pl-wave played" aria-hidden="true">${row}</div>`;
}
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
  const bars = waveBars(r.segments, r.speakers, (r.duration_ms || 0) / 1000);
  return `<div class="player" id="player" role="group" aria-label="Audio player">
    <audio id="pl-audio" preload="metadata" src="/api/recordings/${r.id}/audio" hidden></audio>
    <button class="pl-btn" data-skip="-15" aria-label="Back 15 seconds" title="Back 15 seconds">${icon('back15', 20)}</button>
    <button class="pl-btn pl-play" id="pl-play" aria-label="Play" title="Play / pause">${icon('play', 18)}</button>
    <button class="pl-btn" data-skip="15" aria-label="Forward 15 seconds" title="Forward 15 seconds">${icon('fwd15', 20)}</button>
    <div class="pl-track${bars.length ? ' has-wave' : ''}" id="pl-track" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      ${bars.length ? waveHtml(bars, r.talk_stats || []) : ''}<div class="pl-rail"><div class="pl-buf" id="pl-buf"></div><div class="pl-prog" id="pl-prog"></div></div>
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
    track.style.setProperty('--p', pct + '%');
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
