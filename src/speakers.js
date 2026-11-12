// Speaker naming, layer 1 (#4): evidence-only LLM inference over a diarized
// transcript plus the `people` table as memory. Layer 2 (#14, voiceprints) will add
// `refs` -- this file already has the seam for it (see the `refs` branch below) but
// does not implement voiceprint matching itself.
//
// The rule that must not break: never mislabel a voice. A wrong name poisons
// summaries, action-item owners and search. Anonymous ("Unknown N") beats
// confidently wrong every time -- that is why every name is checked against a
// verbatim quote from the transcript before it is trusted.

import { parseJsonLoose, diarizeToText, isPlaceholderName } from './text.js';
import { defaultModel, contextChars } from './config.js';
import { llmFetch } from './llm.js';

function distinctLabels(segments) {
  const seen = [];
  for (const s of segments || []) {
    const label = s.speaker || 'Speaker';
    if (!seen.includes(label)) seen.push(label);
  }
  return seen;
}

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const UNKNOWN_NAME = /^\s*(unknown|speaker|null|none|n\/a)\s*\d*\s*$/i;

// Anonymous placeholders, one per distinct label. Used when naming is skipped or fails,
// so the chips still exist and a human can name each speaker.
export function anonymousSpeakers(segments) {
  return distinctLabels(segments).map((label) => ({ label, name: null, evidence: '', confirmed: false }));
}

// Pure: a name is only as good as its evidence. Three checks, all required:
//  1. `evidence` is a verbatim quote that appears in the transcript;
//  2. the quote actually contains the name (any 2+ char part of it) -- a quote with no
//     name in it proves nothing;
//  3. when segments + label are given, the quote sits in a turn BY that label (a
//     self-introduction) or in a turn directly before/after one (being addressed) -- a
//     real quote lifted from some other speaker's turn does not vouch for this label.
// Anything less is dropped: anonymous beats confidently wrong.
export function filterSpeakerGuess(guess, transcript, label, segments) {
  const none = { name: null, evidence: '' };
  const name = guess?.name == null ? '' : String(guess.name).trim();
  const evidence = guess?.evidence ? String(guess.evidence) : '';
  if (!name || name.length > 80 || UNKNOWN_NAME.test(name)) return none;
  const ev = normalizeForMatch(evidence);
  if (!ev || !normalizeForMatch(transcript).includes(ev)) return none;
  const parts = normalizeForMatch(name).split(' ').filter((p) => p.length >= 2);
  if (!parts.some((p) => ev.includes(p))) return none;
  if (label != null && segments?.length) {
    const norm = segments.map((seg) => normalizeForMatch(seg.text));
    const near = new Set();
    segments.forEach((seg, i) => {
      if ((seg.speaker || 'Speaker') !== label) return;
      near.add(i - 1); near.add(i); near.add(i + 1);
    });
    if (![...near].some((i) => i >= 0 && i < norm.length && norm[i].includes(ev))) return none;
  }
  return { name, evidence };
}

function speakerNamingPrompt(labels, people) {
  const memory = people.length
    ? `Known people for this user, to match spoken names against (do not assume a speaker IS one of these without evidence): ${
        people.map((p) => (p.aliases ? `${p.name} (aka ${p.aliases})` : p.name)).join(', ')
      }.`
    : 'No known people yet.';
  return [
    'You are labeling speakers in a diarized meeting transcript.',
    `Speaker labels present: ${labels.join(', ')}.`,
    memory,
    'For EACH speaker label, assign a name ONLY on direct evidence: the speaker',
    'introduces themselves ("I\'m Sam"), another speaker addresses them by name',
    '("thanks, Sam"), or the speaker states a role that unambiguously identifies them.',
    'If there is no such direct evidence, set name to null. Never guess from voice,',
    'topic, or turn order -- a wrong name is worse than no name.',
    'Return strict JSON: {"speakers":[{"label":"A","name":"Sam"|null,"evidence":"<verbatim quote from the transcript, or empty string>"}]}.',
    'One entry per speaker label. evidence must be copied exactly from the transcript --',
    'it is checked against the transcript and the name is discarded if it does not match.',
  ].join('\n');
}

// env/owner/segments/transcript -> [{label, name, evidence, confirmed:false}, ...],
// one per distinct label, never dropping a label the diarizer produced.
//
// refs (layer 2, #14): when references were SENT with the transcription (refsSent, even
// if none matched), a label is named ONLY if a ref matches it -- every other label
// stays anonymous and inference is skipped entirely, per "never mislabel a voice".
// refs are {label, name} pledges read back by matchedSpeakerRefs(). A voiceprint match
// is machine-made, so it is confirmed:false like an inference; only a human PATCH
// sets confirmed:true.
export async function nameSpeakers(env, owner, segments, transcript, refs = [], refsSent = false) {
  const labels = distinctLabels(segments);
  if (!labels.length) return [];

  if (refsSent || refs.length) {
    const byRefLabel = new Map(refs.map((r) => [r.label, r.name]));
    return labels.map((label) => byRefLabel.has(label)
      ? { label, name: byRefLabel.get(label), evidence: 'voiceprint match', confirmed: false }
      : { label, name: null, evidence: '', confirmed: false });
  }

  const people = (await env.DB.prepare(
    'SELECT name, aliases FROM people WHERE owner = ? ORDER BY created_at'
  ).bind(owner).all()).results;

  const res = await llmFetch(env, {
    model: defaultModel(env),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: speakerNamingPrompt(labels, people) },
      { role: 'user', content: `Transcript:\n\n${transcript.slice(0, contextChars(env))}` },
    ],
  });
  if (!res.ok) throw new Error(`speaker naming ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const parsed = parseJsonLoose((await res.json()).choices[0].message.content);
  const byLabel = new Map((parsed?.speakers || []).map((sp) => [sp.label, sp]));

  const guessed = labels.map((label) => {
    const { name, evidence } = filterSpeakerGuess(byLabel.get(label), transcript, label, segments);
    return { label, name, evidence, confirmed: false };
  });
  // The same name on two labels means at least one is wrong (or the diarizer split one
  // person); either way neither is trustworthy.
  const count = new Map();
  for (const g of guessed) if (g.name) count.set(g.name.toLowerCase(), (count.get(g.name.toLowerCase()) || 0) + 1);
  return guessed.map((g) => (g.name && count.get(g.name.toLowerCase()) > 1 ? { ...g, name: null, evidence: '' } : g));
}

// Pure: rewrites segments[i].speaker from the diarizer's raw label to either a
// confirmed/inferred name, or a stable "Unknown N" numbered by first appearance
// among the labels that still have no name. Returns new segment objects; never
// mutates (process() and the PATCH route both rely on the old array staying intact).
// Pure: the transcript text for a set of segments + speaker map. Non-diarized
// transcribers store no segments, so rebuilding from them would blank the transcript
// (and the FTS row) -- fall back to the text we already had instead.
export function rebuildTranscript(segments, speakers, fallback) {
  return (segments || []).length
    ? diarizeToText(applySpeakerNames(segments, speakers))
    : fallback;
}

export function applySpeakerNames(segments, speakers) {
  const byLabel = new Map((speakers || []).map((s) => [s.label, s]));
  const unknownNumbers = new Map(); // raw label -> stable N, assigned on first sight
  let nextUnknown = 1;
  return (segments || []).map((seg) => {
    const label = seg.speaker || 'Speaker';
    const name = byLabel.get(label)?.name;
    if (name && !isPlaceholderName(name)) return { ...seg, speaker: name };
    if (!unknownNumbers.has(label)) unknownNumbers.set(label, nextUnknown++);
    return { ...seg, speaker: `Unknown ${unknownNumbers.get(label)}` };
  });
}

// Moves the segments at `indices` to speaker `to`: an existing label, or "new" for the first
// unused letter (A-L). Pure. Returns {segments, speakers, target, removed} or {error}.
//  - speakers are re-ordered by first appearance, which is the order "Unknown N" is numbered in
//  - a speaker left with no segments is dropped and reported in `removed` (their names, if any)
//  - everyone else keeps their name and confirmed flag untouched
export function reassignSegments(segments, speakers, indices, to) {
  const segs = Array.isArray(segments) ? segments : [];
  const idx = new Set((Array.isArray(indices) ? indices : []).filter((i) => Number.isInteger(i)));
  if (!idx.size || [...idx].some((i) => i < 0 || i >= segs.length)) return { error: 'no such segments' };
  const labelOf = (seg) => seg.speaker || 'Speaker';
  const known = new Set([...(speakers || []).map((sp) => sp.label), ...segs.map(labelOf)]);
  let target = String(to);
  if (target === 'new') {
    target = 'ABCDEFGHIJKL'.split('').find((l) => !known.has(l));
    if (!target) return { error: 'too many speakers' };
  } else if (!known.has(target)) return { error: 'no such speaker' };

  const moved = segs.map((seg, i) => (idx.has(i) ? { ...seg, speaker: target } : seg));
  const order = [];
  for (const seg of moved) { const l = labelOf(seg); if (!order.includes(l)) order.push(l); }
  const byLabel = new Map((speakers || []).map((sp) => [sp.label, sp]));
  const next = order.map((label) => byLabel.get(label) || { label, name: null, evidence: '', confirmed: false });
  const removed = (speakers || []).filter((sp) => !order.includes(sp.label) && sp.name).map((sp) => sp.name);
  return { segments: moved, speakers: next, target, removed };
}
