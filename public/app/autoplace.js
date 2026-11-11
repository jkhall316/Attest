// "I don't know": when a turn is on the wrong speaker and the right one is not obvious (or not
// named yet), let the voice decide. The turn's audio is compared with every OTHER speaker in the
// recording; it goes to the closest one if it sounds clearly like them, otherwise to a new
// unnamed speaker. Everything runs in this browser; only the chosen label is sent.

import { decode16k } from './voicematch.js';
import { embedWindow, speakerEmbeddings, meanNormalize, RATE } from './voiceembed.js';

export const MATCH_MIN = 0.4; // cosine between the turn and a speaker's voice, below which it is nobody we know

const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

// The closest speaker's label, or null when none reaches `min`. `speakers`: [{label, embedding}].
export function closestSpeaker(emb, speakers, exclude, min = MATCH_MIN) {
  let best = null, bs = -Infinity;
  for (const s of speakers || []) {
    if (s.label === exclude) continue;
    const c = dot(emb, s.embedding);
    if (c > bs) { bs = c; best = s.label; }
  }
  return bs >= min ? best : null;
}

// Up to two windows of the turn's own speech: its longest segments (at least 1 s), 6 s at most each.
export function turnWindows(segments, idx, { max = 2, minSec = 1 } = {}) {
  return (idx || []).map((i) => segments?.[i]).filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= minSec)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, max)
    .map((s) => ({ start: s.start, end: Math.min(s.end, s.start + 6) }));
}

// Returns the label to move the turn to ("new" when it sounds like nobody else).
export async function placeByVoice(r, turn, onStatus = () => {}) {
  const wins = turnWindows(r.segments, turn.idx);
  if (!wins.length) return 'new';
  onStatus('Loading audio…');
  const res = await fetch(`/api/recordings/${r.id}/audio`);
  if (!res.ok) throw new Error('could not load the recording audio');
  const samples = await decode16k(await res.arrayBuffer());
  onStatus('Listening to this turn…');
  const embs = [];
  for (const w of wins) {
    const a = Math.max(0, Math.floor(w.start * RATE)), b = Math.min(samples.length, Math.ceil(w.end * RATE));
    if (b - a >= RATE) embs.push(await embedWindow(samples.slice(a, b)));
  }
  if (!embs.length) return 'new';
  const others = (r.speakers || []).map((s) => s.label).filter((l) => l !== turn.label);
  if (!others.length) return 'new';
  onStatus('Comparing with the other speakers…');
  const voices = await speakerEmbeddings(samples, r.segments, others);
  return closestSpeaker(meanNormalize(embs), voices, turn.label) || 'new';
}
