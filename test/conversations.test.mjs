import test from 'node:test';
import assert from 'node:assert/strict';
import { planShape, rebase, planMerge, holdForMerge, shapeOptions, DEFAULTS } from '../src/conversations.js';

// speech: a segment of n words from s to e seconds
const seg = (s, e, who = 'A', n = 20) => ({ start: s, end: e, speaker: who, text: Array.from({ length: n }, (_, i) => `w${i}`).join(' ') });
const min = (m) => m * 60;

test('a normal call with no dead air is left alone', () => {
  assert.equal(planShape([seg(0, 600), seg(601, 1800)], 1800_000), null);
});

test('dead air before the first word and after the last is trimmed, keeping a few seconds', () => {
  const p = planShape([seg(90, 600), seg(601, 1500)], 1800_000);
  assert.equal(p.length, 1);
  assert.equal(p[0].startMs, 87_000);
  assert.equal(p[0].endMs, 1503_000);
  assert.equal(p[0].segments.length, 2);
});

test('short lead-in and tail (under the threshold) are kept as they are', () => {
  assert.equal(planShape([seg(20, 600), seg(601, 1790)], 1800_000), null);
});

test('a 5 minute silence in the middle makes two conversations, each trimmed to its speech', () => {
  const p = planShape([seg(0, 1200), seg(1201, 1500), seg(1500 + min(8), 1500 + min(8) + 1800, 'B')], 6000_000);
  assert.equal(p.length, 2);
  assert.deepEqual([p[0].startMs, p[0].endMs], [0, 1503_000]);
  assert.equal(p[1].startMs, (1500 + 480) * 1000 - 3000);
  assert.equal(p[1].endMs, (1500 + 480 + 1800) * 1000 + 3000);
  assert.equal(p[0].segments.length, 2);
  assert.equal(p[1].segments.length, 1);
});

test('a pause shorter than the split gap never splits', () => {
  assert.equal(planShape([seg(0, 600), seg(600 + min(4), 1800)], 1800_000), null);
});

test('a stray scrap of speech joins its neighbour instead of becoming a conversation', () => {
  const p = planShape([seg(0, 1200), seg(1200 + min(6), 1200 + min(6) + 5, 'A', 4), seg(1200 + min(30), 1200 + min(30) + 1200)], 8000_000);
  assert.equal(p.length, 2); // the scrap sits closer to the first piece
  assert.equal(p[0].segments.length, 2);
});

test('a very long continuous piece is cut at its longest pause of a minute or more', () => {
  const segs = [seg(0, min(60)), seg(min(60) + 100, min(110)), seg(min(110) + 70, min(150))];
  const p = planShape(segs, min(150) * 1000);
  assert.equal(p.length, 2);
  assert.equal(p[0].segments.length, 1); // the 100 s pause after the first block is the longest
  assert.equal(p[1].segments.length, 2);
});

test('no timestamps, no plan: plain-text transcripts are never reshaped', () => {
  assert.equal(planShape([], 1800_000), null);
  assert.equal(planShape([{ text: 'hello there', speaker: 'A' }], 1800_000), null);
});

test('unknown audio length still trims the front but never invents a tail cut', () => {
  const p = planShape([seg(120, 600)], null);
  assert.equal(p[0].startMs, 117_000);
});

test('rebase moves segment times onto the piece clock', () => {
  assert.deepEqual(rebase([seg(100, 110)], 90_000).map((s) => [s.start, s.end]), [[10, 20]]);
});

const row = (id, at, durMin, extra = {}) => ({ id, created_at: at * 60_000, duration_ms: durMin * 60_000, src: 'device', r2_key: `rec/${id}`, status: 'uploaded', content_type: 'audio/webm', hidden: 0, ...extra });

test('planMerge chains pieces of one call with a small gap and leaves distant ones apart', () => {
  const g = planMerge([row('a', 0, 15), row('b', 16, 15), row('c', 32, 10), row('d', 200, 15)]);
  assert.deepEqual(g.map((x) => x.map((r) => r.id)), [['a', 'b', 'c']]);
});

test('planMerge does not mix sources or audio types, or touch transcribed / hidden / sourceless rows', () => {
  assert.deepEqual(planMerge([row('a', 0, 15), row('b', 16, 15, { src: 'pocket' })]), []);
  assert.deepEqual(planMerge([row('a', 0, 15), row('b', 16, 15, { content_type: 'audio/mpeg' })]), []);
  assert.deepEqual(planMerge([row('a', 0, 15), row('b', 16, 15, { status: 'ready' })]), []);
  assert.deepEqual(planMerge([row('a', 0, 15), row('b', 16, 15, { hidden: 1 })]), []);
  assert.deepEqual(planMerge([row('a', 0, 15), row('b', 16, 15, { src: null })]), []);
});

test('planMerge stops at the three hour cap', () => {
  const rows = Array.from({ length: 14 }, (_, i) => row(`r${i}`, i * 16, 15));
  const g = planMerge(rows);
  assert.ok(g[0].length <= 12);
});

test('holdForMerge waits on a piece that ended moments ago, not on an old one', () => {
  const now = 100 * 60_000;
  assert.equal(holdForMerge(row('a', 80, 19), now), true);
  assert.equal(holdForMerge(row('a', 10, 15), now), false);
  assert.equal(holdForMerge({ ...row('a', 99, 1), src: null }, now), false);
});

test('shapeOptions reads minutes and seconds from the environment and honours RESHAPE=off', () => {
  assert.equal(shapeOptions({}).splitGapMs, DEFAULTS.splitGapMs);
  const o = shapeOptions({ SPLIT_GAP_MIN: '10', TRIM_MIN_SEC: '45', MERGE_GAP_MIN: '2', RESHAPE: 'off' });
  assert.deepEqual([o.splitGapMs, o.trimMinMs, o.mergeGapMs, o.enabled], [600_000, 45_000, 120_000, false]);
  assert.equal(shapeOptions({ SPLIT_GAP_MIN: 'x' }).splitGapMs, DEFAULTS.splitGapMs);
});
