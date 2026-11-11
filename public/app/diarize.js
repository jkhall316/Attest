// Speaker labels without a diarizing transcriber (local mode): work out who spoke when by
// clustering voice embeddings of the transcript's segments, with the same in-browser voice
// model that recognises enrolled people. The pure parts (picking segments, clustering,
// assigning every segment a speaker) are unit-tested; the model runs in a Web Worker (see
// voiceembed.js), so the page stays responsive however long this takes.
//
// It is a heuristic, not a trained diarizer: it is good when speakers take turns of a few
// seconds or more, and weaker on quick back-and-forth and overlapping speech. Every label it
// makes is only a suggestion until you name the speaker.

import { api } from './api.js';
import { state } from './state.js';
import { embedWindow, meanNormalize, RATE, AUTO_MAX_MS, MAX_DECODE_MS } from './voiceembed.js';
import { decode16k, skipped, markSkipped, matchFromEmbeddings } from './voicematch.js';

export const DIARIZE = {
  maxWindows: 100,      // fewest model runs for any recording (about 2.5 minutes of work at ~1.5 s a window)
  windowsPerMin: 4,     // a long call gets more, so the whole of it is sampled, not just its longest monologues
  maxWindowsCap: 240,   // ...up to about 6 minutes of work
  minSegSec: 1.2,       // shorter than this is too little voice to embed
  maxSpeakers: 8,
  threshold: 0.35,      // average cosine between clusters, below which they stay separate. Measured on a real
                        // two-person call: different speakers <= 0.26, one speaker's short windows ~0.38, long ~0.74
  minClusterSec: 6,     // a "speaker" with less speech than this is folded into the nearest one
  minMembers: 2,        // ...and so is one built from a single window: a real speaker has more than one (on a real
                        // call the quiet second speaker had 2; a lone stray window made a phantom third)
  smoothSec: 2.5,       // a turn this short between two turns by the same speaker is theirs too
  autoMaxMs: 10 * 60 * 1000,
  minSegments: 4,       // fewer than this and the server names the recording itself (MIN_SEGMENTS_FOR_TURNS in src/config.js)
};

const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

// Whisper invents text in silence and noise: "Thank you." again and again, "Yeah.", "you". Those
// segments are not a person talking, and embedding them makes a fake speaker out of the noise
// (it did, on a real call: 5 phantom "Thank you." segments became a third speaker). They are kept
// in the transcript but ignored for clustering. Two signs: a tiny stock phrase, or any very short
// text that repeats three or more times in one recording. Whisper's no_speech_prob does not help
// here: it reported ~1e-11 (certain it was speech) for every one of them.
const STOCK = /^(thank you|thanks|thank you for watching|thanks for watching|you|bye|bye bye|okay|ok|yeah|um|uh|mm|hmm|subscribe|please subscribe)\W*$/i;
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
const wordCount = (t) => (norm(t) ? norm(t).split(' ').length : 0);

export function hallucinatedSegments(segments) {
  const counts = new Map();
  for (const s of segments || []) { const k = norm(s.text); if (k && wordCount(k) <= 4) counts.set(k, (counts.get(k) || 0) + 1); }
  const out = new Set();
  (segments || []).forEach((s, i) => {
    const n = wordCount(s.text);
    if ((n <= 3 && STOCK.test(String(s.text ?? '').trim())) || (n >= 1 && n <= 4 && counts.get(norm(s.text)) >= 3)) out.add(i);
  });
  return out;
}

// Which segments to embed: those with enough voice, the longest ones when there are more than
// the budget allows. One window each (the first 6 s of the segment, a little trimmed).
export function pickAnchors(segments, { maxWindows, minSegSec = DIARIZE.minSegSec } = {}) {
  const cands = [];
  const skip = hallucinatedSegments(segments);
  let span = 0;
  (segments || []).forEach((s, i) => {
    const dur = s.end - s.start;
    if (Number.isFinite(s.end)) span = Math.max(span, s.end);
    if (skip.has(i)) return;
    if (Number.isFinite(s.start) && Number.isFinite(s.end) && dur >= minSegSec - 1e-6) cands.push({ i, dur, start: s.start });
  });
  // Budget grows with the call: 4 windows a minute, between 100 and 240.
  const budget = maxWindows ?? Math.min(DIARIZE.maxWindowsCap, Math.max(DIARIZE.maxWindows, Math.round((span / 60) * DIARIZE.windowsPerMin)));
  let chosen;
  if (cands.length <= budget) chosen = cands;
  else {
    // Over budget: take the longest segment in each equal slice of the call, so every stretch of
    // it is sampled. (The longest overall would all sit in a few long monologues, and every quick
    // exchange between two of them would be labelled as the speaker before it.) Slices with no
    // candidate are skipped; leftover budget goes to the longest segments not yet taken.
    const width = Math.max(span, 1e-6) / budget, best = new Map();
    for (const c of cands) {
      const b = Math.min(budget - 1, Math.floor(c.start / width));
      if (!best.has(b) || c.dur > best.get(b).dur) best.set(b, c);
    }
    chosen = [...best.values()];
    if (chosen.length < budget) {
      const taken = new Set(chosen.map((c) => c.i));
      chosen.push(...cands.filter((c) => !taken.has(c.i)).sort((a, b) => b.dur - a.dur).slice(0, budget - chosen.length));
    }
  }
  const keep = chosen.sort((a, b) => a.i - b.i);
  return keep.map(({ i }) => {
    const s = segments[i];
    const start = s.start + Math.min(0.1, (s.end - s.start) / 10);
    return { i, start, end: Math.min(s.end - 0.05, start + 6) };
  });
}

// Average-linkage agglomerative clustering of unit vectors. Merges the most similar pair
// until none is above `threshold`, then keeps merging while there are more than maxSpeakers,
// then folds near-empty clusters (too little speech, or a single window) into their nearest neighbour. Returns one cluster number
// per input, numbered by first appearance.
export function clusterSpeakers(embs, durs, { threshold = DIARIZE.threshold, maxSpeakers = DIARIZE.maxSpeakers, minClusterSec = DIARIZE.minClusterSec, minMembers = DIARIZE.minMembers } = {}) {
  const n = embs.length;
  if (!n) return [];
  let clusters = embs.map((_, i) => ({ members: [i], sec: durs[i] || 0 }));
  // sim[a][b] between active clusters, kept as a Map for cheap deletion
  const sim = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sim[i][j] = sim[j][i] = dot(embs[i], embs[j]);
  const id = clusters.map((_, i) => i); // cluster -> row in sim
  const size = clusters.map(() => 1);

  const best = () => {
    let bi = -1, bj = -1, bs = -Infinity;
    for (let a = 0; a < clusters.length; a++) for (let b = a + 1; b < clusters.length; b++) {
      const s = sim[id[a]][id[b]];
      if (s > bs) { bs = s; bi = a; bj = b; }
    }
    return { bi, bj, bs };
  };
  const merge = (a, b) => {
    const ra = id[a], rb = id[b], sa = size[ra], sb = size[rb];
    for (let c = 0; c < clusters.length; c++) {
      if (c === a || c === b) continue;
      const rc = id[c];
      const s = (sa * sim[ra][rc] + sb * sim[rb][rc]) / (sa + sb); // average linkage
      sim[ra][rc] = sim[rc][ra] = s;
    }
    size[ra] = sa + sb;
    clusters[a] = { members: [...clusters[a].members, ...clusters[b].members], sec: clusters[a].sec + clusters[b].sec };
    clusters.splice(b, 1); id.splice(b, 1);
  };

  while (clusters.length > 1) {
    const { bi, bj, bs } = best();
    if (bs < threshold && clusters.length <= maxSpeakers) break;
    merge(bi, bj);
  }
  // fold near-empty clusters (a stray cough or one short phrase) into the nearest real speaker
  while (clusters.length > 1) {
    let small = -1;
    const tiny = (c) => c.members.length < minMembers || c.sec < minClusterSec;
    clusters.forEach((c, k) => { if (tiny(c) && (small < 0 || c.sec < clusters[small].sec)) small = k; });
    if (small < 0) break;
    let nearest = -1, ns = -Infinity;
    clusters.forEach((_, k) => { if (k !== small && sim[id[small]][id[k]] > ns) { ns = sim[id[small]][id[k]]; nearest = k; } });
    merge(Math.min(small, nearest), Math.max(small, nearest));
  }

  const out = new Array(n);
  clusters.forEach((c, k) => c.members.forEach((m) => { out[m] = k; }));
  const order = new Map();
  return out.map((k) => { if (!order.has(k)) order.set(k, order.size); return order.get(k); });
}

// A fresh clustering numbers speakers by first appearance, which would shuffle the letters a
// human has already attached names to. The stored segments are the same ones, so each new cluster
// can be lined up with the confirmed speaker whose old turns it covers: that cluster takes that
// speaker's number, and the rest take the free ones. Only a clear overlap counts (at least half of
// the smaller side), so a cluster is never glued to a name on a few stray segments.
// assign: number per segment. speakers: the recording's speakers. Returns a new assign.
export function alignToConfirmed(segments, assign, speakers) {
  const letters = 'ABCDEFGHIJKL';
  const confirmed = new Set((speakers || []).filter((x) => x.confirmed && x.name && letters.includes(x.label)).map((x) => x.label));
  if (!confirmed.size || !assign?.length) return assign;
  // Weighted by speech time, not segment count: a cluster of many one-second "Yeah."s must not
  // outweigh the person who actually talked for half an hour.
  const w = (i) => { const d = (segments[i]?.end ?? NaN) - (segments[i]?.start ?? NaN); return Number.isFinite(d) && d > 0 ? d : 1; };
  const oldSize = new Map(), newSize = new Map(), both = new Map();
  assign.forEach((k, i) => {
    const L = segments[i]?.speaker, x = w(i);
    newSize.set(k, (newSize.get(k) || 0) + x);
    if (!confirmed.has(L)) return;
    oldSize.set(L, (oldSize.get(L) || 0) + x);
    both.set(`${k}|${L}`, (both.get(`${k}|${L}`) || 0) + x);
  });
  // The name follows the new cluster that holds most of that person's old speech. It must also be a real
  // share of the old speaker (a quarter), so a small cluster that happens to sit inside their talk
  // (whoever opened the call) is never handed the name of the person who talked most.
  const pairs = [...both].map(([key, n]) => { const [k, L] = key.split('|'); return { k: Number(k), L, n }; })
    .filter(({ k, L, n }) => n / Math.min(newSize.get(k), oldSize.get(L)) >= 0.5 && n / oldSize.get(L) >= 0.25)
    .sort((a, b) => b.n - a.n);
  const map = new Map(), usedLetter = new Set();
  for (const { k, L } of pairs) { if (!map.has(k) && !usedLetter.has(L)) { map.set(k, letters.indexOf(L)); usedLetter.add(L); } }
  const claimed = new Set(map.values());
  let next = 0;
  for (const k of new Set(assign)) {
    if (map.has(k)) continue;
    while (claimed.has(next)) next++;
    map.set(k, next); claimed.add(next);
  }
  return assign.map((k) => Math.min(11, map.get(k)));
}

// A speaker number for EVERY segment: anchors take their cluster's; the rest (too short to
// embed, or past the budget) take the previous anchor's, else the next one's. A short turn
// sandwiched between two turns by one speaker is theirs, which removes one-word flicker.
export function assignSegments(segments, anchors, anchorLabels, { smoothSec = DIARIZE.smoothSec } = {}) {
  const n = (segments || []).length;
  if (!n) return [];
  const byIndex = new Map(anchors.map((a, k) => [a.i, anchorLabels[k]]));
  const out = new Array(n).fill(null);
  let last = null;
  for (let i = 0; i < n; i++) { if (byIndex.has(i)) last = byIndex.get(i); out[i] = last; }
  let next = null;
  for (let i = n - 1; i >= 0; i--) { if (byIndex.has(i)) next = byIndex.get(i); if (out[i] == null) out[i] = next; }
  for (let i = 1; i < n - 1; i++) {
    const dur = segments[i].end - segments[i].start;
    if (dur < smoothSec && out[i - 1] === out[i + 1] && out[i] !== out[i - 1]) out[i] = out[i - 1];
  }
  const order = new Map();
  return out.map((k) => { const v = k ?? 0; if (!order.has(v)) order.set(v, order.size); return Math.min(11, order.get(v)); });
}

// Per-speaker mean embedding (weighted by how long each anchor window is) for voice matching,
// so recognising enrolled people costs no extra model runs.
export function speakerEmbeddingsFrom(anchors, anchorEmbs, assign) {
  const by = new Map();
  anchors.forEach((a, k) => {
    const label = String.fromCharCode(65 + assign[a.i]);
    if (!by.has(label)) by.set(label, { embs: [], ms: 0 });
    const g = by.get(label);
    const sec = a.end - a.start;
    for (let t = 0; t < Math.max(1, Math.round(sec)); t++) g.embs.push(anchorEmbs[k]); // longer windows weigh more
    g.ms += sec * 1000;
  });
  return [...by].map(([label, g]) => ({ label, embedding: meanNormalize(g.embs), speech_ms: Math.round(g.ms) }));
}

// ---- eligibility ----

const running = new Set();

// One provisional speaker over several segments, nobody named by a human.
export const needsTurns = (r) => Boolean(
  r?.segments?.length >= DIARIZE.minSegments && r.speakers?.length === 1 && !r.speakers[0].confirmed && ['ready', 'transcribed'].includes(r.status));

// Any recording with timed segments can be detected again. Names a human confirmed are kept:
// alignToConfirmed() hands each new cluster the letter of the confirmed speaker it overlaps most.
export const canRedetect = (r) => Boolean(
  r?.segments?.length >= DIARIZE.minSegments && r.speakers?.length && ['ready', 'transcribed'].includes(r.status));

export function diarizeEligible(r, { manual = false } = {}) {
  if (!state.META?.diarize_local || !(manual ? canRedetect(r) : needsTurns(r)) || running.has(r.id)) return false;
  if (!manual && skipped(r.id)) return false;
  return !r.duration_ms || r.duration_ms <= (manual ? MAX_DECODE_MS : DIARIZE.autoMaxMs);
}

// Too long to do unasked, otherwise eligible: the "Detect speakers" button.
export const needsDiarizeManual = (r) => Boolean(r?.duration_ms > DIARIZE.autoMaxMs && diarizeEligible(r, { manual: true }));

// ---- the run ----

const tick = () => new Promise((r) => setTimeout(r, 0));

// Returns {row, speakers} (the updated recording and per-speaker embeddings for voice
// matching), or null when it could not or should not. Never throws: a failure is remembered.
export async function diarizeRecording(r, opts = {}) {
  if (!diarizeEligible(r, { manual: opts.manual })) return null;
  running.add(r.id);
  try {
    opts.onStatus?.('Detecting speakers… loading audio');
    const res = await fetch(`/api/recordings/${r.id}/audio`);
    if (!res.ok) throw new Error('could not load the recording audio');
    const samples = await decode16k(await res.arrayBuffer());
    const anchors = pickAnchors(r.segments);
    if (anchors.length < 2) { markSkipped(r.id); opts.onStatus?.('Not enough speech to tell speakers apart.'); return null; }

    const embs = [];
    for (const a of anchors) {
      if (opts.job?.cancel) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const from = Math.max(0, Math.floor(a.start * RATE)), to = Math.min(samples.length, Math.ceil(a.end * RATE));
      embs.push(await embedWindow(samples.slice(from, Math.max(to, from + RATE))));
      opts.onStatus?.(`Detecting speakers… ${embs.length}/${anchors.length}`);
      await tick();
    }
    const labels = clusterSpeakers(embs, anchors.map((a) => a.end - a.start));
    const assign = alignToConfirmed(r.segments, assignSegments(r.segments, anchors, labels), r.speakers);
    const row = await api(`/recordings/${r.id}/speaker-turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assign }),
    });
    return { row, speakers: speakerEmbeddingsFrom(anchors, embs, assign) };
  } catch (e) {
    markSkipped(r.id);
    if (e?.cancelled) opts.onStatus?.('Speaker detection cancelled.');
    else { console.warn('speaker detection skipped:', e); opts.onStatus?.(`Speaker detection skipped: ${e.message}`); }
    return null;
  } finally {
    running.delete(r.id);
  }
}

// Diarize, then recognise enrolled voices using the embeddings just made. Returns the final
// row (with voice_changed true if names or turns changed) or null.
export async function detectAndMatch(r, opts = {}) {
  const out = await diarizeRecording(r, opts);
  if (!out) return null;
  let row = out.row;
  const matched = await matchFromEmbeddings(row, out.speakers, opts.onStatus);
  if (matched) row = { ...matched, voice_changed: Boolean(matched.voice_changed || row.voice_changed) };
  return row;
}

export { AUTO_MAX_MS };
