// Deciding where a conversation starts and ends (pure -- no I/O, easy to test).
//
//   trim   dead air before the first word and after the last is cut (keeping a few seconds of padding)
//   split  a long silence between two stretches of speech means two different conversations
//   merge  recordings the source app chopped up that are really one call (gap of a few minutes at most)
//
// Everything is derived from transcript timestamps (segments, in seconds) or recording times, never
// from the provider's own boundaries.

export const VISIBLE = ' AND hidden = 0';

export const DEFAULTS = {
  trimMinMs: 30_000,      // dead air at either end must be longer than this to be cut
  padMs: 3_000,           // ...and this much is kept around the speech
  splitGapMs: 5 * 60_000, // silence this long between speech = a different conversation
  softGapMs: 60_000,      // a piece longer than maxPieceMs may also be cut at a pause this long
  maxPieceMs: 100 * 60_000,
  minWords: 15,           // a stray piece with fewer words (and under minSpeechMs) joins its neighbour
  minSpeechMs: 30_000,
  mergeGapMs: 3 * 60_000, // recordings closer than this are one call
  maxMergeMs: 3 * 3600_000,
};

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// Tunables from the environment (minutes/seconds, like the other settings). RESHAPE=off disables it all.
export function shapeOptions(env = {}) {
  return {
    enabled: String(env.RESHAPE ?? '').toLowerCase() !== 'off',
    ...DEFAULTS,
    splitGapMs: num(env.SPLIT_GAP_MIN, DEFAULTS.splitGapMs / 60_000) * 60_000,
    trimMinMs: num(env.TRIM_MIN_SEC, DEFAULTS.trimMinMs / 1000) * 1000,
    mergeGapMs: num(env.MERGE_GAP_MIN, DEFAULTS.mergeGapMs / 60_000) * 60_000,
  };
}

const words = (s) => (String(s || '').match(/[\p{L}\p{N}']+/gu) || []).length;

// segments [{start,end,text,speaker}] in seconds -> speech spans in ms, in order.
function spans(segments) {
  return (segments || [])
    .map((s, i) => ({ i, a: Math.round(Number(s.start) * 1000), b: Math.round(Number(s.end) * 1000), w: words(s.text) }))
    .filter((x) => x.w > 0 && Number.isFinite(x.a) && Number.isFinite(x.b) && x.b > x.a)
    .sort((p, q) => p.a - q.a);
}

// Plans the pieces of one recording. `durationMs` is the audio length (null if unknown: then the end
// is not trimmed). Returns null when nothing should change, else
// [{startMs, endMs, segments}] -- segments are the originals, with times still on the old clock.
export function planShape(segments, durationMs, opts = DEFAULTS) {
  const sp = spans(segments);
  if (sp.length < 1) return null;
  const total = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;

  // 1. cut points: every long silence, then pauses inside any piece that is still too long
  const cuts = [];
  for (let k = 0; k + 1 < sp.length; k++) {
    const gap = sp[k + 1].a - sp[k].b;
    if (gap >= opts.splitGapMs) cuts.push({ at: Math.round((sp[k].b + sp[k + 1].a) / 2), after: k });
  }
  const splitLong = () => {
    const bounds = [-1, ...cuts.map((c) => c.after), sp.length - 1];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const from = bounds[i] + 1, to = bounds[i + 1];
      if (sp[to].b - sp[from].a <= opts.maxPieceMs) continue;
      let best = null;
      for (let k = from; k < to; k++) {
        const gap = sp[k + 1].a - sp[k].b;
        if (gap >= opts.softGapMs && (!best || gap > best.gap)) best = { gap, at: Math.round((sp[k].b + sp[k + 1].a) / 2), after: k };
      }
      if (!best) continue;
      cuts.push(best);
      cuts.sort((p, q) => p.after - q.after);
      return true;
    }
    return false;
  };
  for (let guard = 0; guard < 50 && splitLong(); guard++);

  // 2. group the speech spans into pieces
  let groups = [];
  let prev = -1;
  for (const c of [...cuts, { after: sp.length - 1 }]) { groups.push(sp.slice(prev + 1, c.after + 1)); prev = c.after; }

  // 3. a stray scrap of speech is not a conversation: fold it into the nearer neighbour
  const tiny = (g) => g.reduce((n, x) => n + x.w, 0) < opts.minWords && g[g.length - 1].b - g[0].a < opts.minSpeechMs;
  for (let again = true; again && groups.length > 1;) {
    again = false;
    for (let i = 0; i < groups.length; i++) {
      if (!tiny(groups[i])) continue;
      const left = i > 0 ? groups[i][0].a - groups[i - 1][groups[i - 1].length - 1].b : Infinity;
      const right = i < groups.length - 1 ? groups[i + 1][0].a - groups[i][groups[i].length - 1].b : Infinity;
      const into = left <= right ? i - 1 : i + 1;
      groups[into] = [...groups[into], ...groups[i]].sort((p, q) => p.a - q.a);
      groups.splice(i, 1);
      again = true;
      break;
    }
  }

  // 4. each piece runs from the middle of the silence before it to the middle of the silence after,
  //    then dead air at either end is trimmed
  const pieces = groups.map((g, i) => {
    const first = g[0].a, last = g[g.length - 1].b;
    const lo = i === 0 ? 0 : Math.round((groups[i - 1][groups[i - 1].length - 1].b + first) / 2);
    const hi = i === groups.length - 1 ? total : Math.round((last + groups[i + 1][0].a) / 2);
    const startMs = first - lo > opts.trimMinMs ? first - opts.padMs : lo;
    let endMs = hi;
    if (hi === null) endMs = last + opts.padMs; // unknown length: keep the speech and a little after, cut nothing real
    else if (hi - last > opts.trimMinMs) endMs = last + opts.padMs;
    return { startMs: Math.max(0, startMs), endMs: Math.min(total ?? Infinity, endMs), speech: g };
  });

  const only = pieces.length === 1 && pieces[0].startMs === 0 && (total === null ? true : pieces[0].endMs >= total);
  if (only) return null;
  // a piece owns the segments that start inside it
  return pieces.map((p) => ({
    startMs: p.startMs,
    endMs: p.endMs,
    segments: (segments || []).filter((s) => {
      const a = Number(s.start) * 1000;
      return a >= p.startMs - 1 && a < p.endMs;
    }),
  }));
}

// A piece's segments on its own clock (seconds from the piece start).
export const rebase = (segments, startMs) => segments.map((s) => ({
  ...s, start: Math.max(0, Number(s.start) - startMs / 1000), end: Math.max(0, Number(s.end) - startMs / 1000),
}));

/* ---------- merging ---------- */

// Recordings the source app chopped into pieces of one call. `rows` are visible, untranscribed
// recordings that have audio and a source ('device' for the pendant app, 'pocket'); only the same
// source and the same audio type chain together. Returns groups of 2+ rows, oldest first.
export function planMerge(rows, opts = DEFAULTS) {
  const usable = rows
    .filter((r) => r.src && r.r2_key && r.status === 'uploaded' && !r.hidden && Number(r.duration_ms) > 0)
    .sort((a, b) => a.created_at - b.created_at);
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length > 1) groups.push(cur); cur = []; };
  for (const r of usable) {
    const last = cur[cur.length - 1];
    const sameKind = last && last.src === r.src && baseType(last.content_type) === baseType(r.content_type);
    const gap = last ? r.created_at - (last.created_at + last.duration_ms) : 0;
    const len = cur.reduce((n, x) => n + x.duration_ms, 0) + r.duration_ms;
    if (last && sameKind && gap <= opts.mergeGapMs && len <= opts.maxMergeMs) cur.push(r);
    else { flush(); cur = [r]; }
  }
  flush();
  return groups;
}
const baseType = (t) => String(t || '').split(';')[0].trim().toLowerCase();

// Background processing waits a moment on the newest piece of a source's stream: another piece of the
// same call may still be on its way.
export const holdForMerge = (row, now, opts = DEFAULTS) =>
  Boolean(row.src) && Number(row.duration_ms) > 0 && row.created_at + row.duration_ms > now - opts.mergeGapMs;
