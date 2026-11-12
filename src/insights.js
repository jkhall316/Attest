// "Run my day" insights (#today): pure helpers behind the Today screen. Nothing here calls
// a model or touches the database, so it is all unit-tested. The routes live in
// routes/today.js.

import { applySpeakerNames } from './speakers.js';
import { excerpt } from './routes/ask.js';

export const DAY = 86400000;
export const SLIPPING_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A client-supplied local date (YYYY-MM-DD) or null. The server never trusts its own clock
// for "today": the Worker runs in UTC, the user does not.
export function validDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}

// Monday of the week containing `date` (YYYY-MM-DD), as YYYY-MM-DD. Pure date maths in UTC.
export function weekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

const dayNumber = (ms) => Math.floor(ms / DAY);

// Open (not done) action items across recordings, oldest problems first.
//  overdue:  the due text is an ISO date that has passed
//  slipping: not overdue, but the recording is SLIPPING_DAYS+ days old and the item has no
//            future ISO due date -- it has been sitting open
// Free-text dues ("Friday") cannot be judged reliably, so they only ever count as slipping.
// rows: [{id, title, created_at, action_items:[{task,owner,due,done}]}]. today: YYYY-MM-DD.
export function openItems(rows, today) {
  const todayNum = dayNumber(Date.parse(`${today}T00:00:00Z`));
  const out = [];
  for (const r of rows || []) {
    (Array.isArray(r.action_items) ? r.action_items : []).forEach((a, i) => {
      if (!a || a.done || !a.task) return;
      const iso = typeof a.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a.due) ? a.due.slice(0, 10) : null;
      const age = Math.max(0, todayNum - dayNumber(r.created_at));
      const overdue = Boolean(iso && iso < today);
      const future = Boolean(iso && iso >= today);
      out.push({
        rec_id: r.id, title: r.title, created_at: r.created_at, i,
        task: String(a.task), owner: a.owner || null, due: a.due || null,
        age_days: age, overdue, slipping: !overdue && !future && age >= SLIPPING_DAYS,
      });
    });
  }
  const rank = (x) => (x.overdue ? 0 : x.slipping ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.age_days - a.age_days);
}

// Talk balance per speaker from the stored turns (#11). Measured, not guessed:
//  share      fraction of total speaking time
//  turns      number of turns
//  questions  count of '?' in what they said
//  longest_s  longest single turn, seconds
//  overlaps   times they started talking before the previous speaker had finished
// Names come from applySpeakerNames so it matches the transcript ("Unknown N" for anonymous).
export function talkStats(segments, speakers) {
  const segs = (segments || []).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  if (!segs.length) return [];
  const named = applySpeakerNames(segs, speakers);
  const by = new Map();
  let total = 0;
  named.forEach((s, i) => {
    const row = by.get(s.speaker) || { name: s.speaker, seconds: 0, turns: 0, questions: 0, longest_s: 0, overlaps: 0 };
    const d = s.end - s.start;
    row.seconds += d; total += d; row.turns += 1;
    row.questions += (String(s.text || '').match(/\?/g) || []).length;
    row.longest_s = Math.max(row.longest_s, d);
    const prev = named[i - 1];
    if (prev && prev.speaker !== s.speaker && s.start < prev.end - 0.25) row.overlaps += 1;
    by.set(s.speaker, row);
  });
  return [...by.values()].map((r) => ({
    name: r.name, share: total ? r.seconds / total : 0, turns: r.turns, questions: r.questions,
    longest_s: Math.round(r.longest_s), overlaps: r.overlaps,
  })).sort((a, b) => b.share - a.share);
}

const lc = (s) => String(s || '').toLowerCase();

// Does this recording involve `person`? Speaker name match first; failing that, a
// mention in the transcript (the diarizer may not have named them).
export function involves(row, person) {
  const p = lc(person).trim();
  if (!p) return true;
  if ((Array.isArray(row.speakers) ? row.speakers : []).some((s) => lc(s.name).includes(p))) return true;
  return lc(row.transcript).includes(p);
}

// The recordings handed to the model for one insight, newest first, within a character
// budget so the cost of any prompt is bounded. rows need parsed speakers/action_items/unanswered.
export function buildContext(rows, { since, person, deep = false, question = '' } = {}) {
  const cap = deep ? 20 : 12;
  const budget = deep ? 60000 : 36000;
  const picked = (rows || [])
    .filter((r) => r.created_at >= (since || 0) && involves(r, person))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, cap);
  const per = Math.max(800, Math.min(3500, Math.floor(budget / Math.max(1, picked.length))));
  const text = picked.map((r) => {
    const names = (Array.isArray(r.speakers) ? r.speakers : []).map((s) => s.name || 'Unknown').join(', ');
    const open = (Array.isArray(r.action_items) ? r.action_items : []).filter((a) => a && !a.done && a.task)
      .map((a) => `- ${a.task}${a.owner || a.due ? ` (${[a.owner, a.due].filter(Boolean).join(', ')})` : ''}`).join('\n');
    const facts = (r.facts || []).slice(0, 15)
      .map((f) => `- [${f.kind}${f.done ? ', done' : ''}]${f.person ? ` (${f.person})` : ''} ${f.text} -- "${f.quote}"`).join('\n');
    // Facts are the cheap, high-signal view of a recording; with them the raw transcript can shrink.
    const budget1 = facts ? Math.min(per, 1200) : per;
    const un = (Array.isArray(r.unanswered) ? r.unanswered : []).map((q) => `- ${q}`).join('\n');
    return [
      `<recording title="${String(r.title).replace(/"/g, "'")}" date="${new Date(r.created_at).toISOString().slice(0, 10)}">`,
      names && `Speakers: ${names}`,
      r.summary && `Summary: ${r.summary}`,
      open && `Open action items:\n${open}`,
      facts && `Remembered facts:\n${facts}`,
      un && `Unanswered questions:\n${un}`,
      `Transcript:\n${excerpt(r.transcript, question, budget1)}`,
      '</recording>',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return { text, sources: picked.map(({ id, title }) => ({ id, title })) };
}

export function insightSystem({ today, me, personNotes, handled }) {
  return [
    'You are a sharp chief of staff for one person. You help them run their day, their business and their working relationships, using ONLY the recordings below.',
    `Today is ${today}.`,
    me ? `The user is ${me}. Where they ask about "I", "me" or "my", that is ${me}.` : 'Do not assume which speaker is the user unless the text makes it obvious.',
    personNotes ? `Notes the user keeps about this person: ${personNotes}` : '',
    handled?.length ? `The user has already acknowledged these items, so do not list them again unless the recordings show something new about them:\n${handled.map((h) => `- ${h}`).join('\n')}` : '',
    'Be concise and concrete: lead with the answer, use short bullets, name people, dates and recording titles (e.g. "Weekly sync, Nov 10").',
    'For any claim about how a person behaves or communicates, give a brief quote as evidence. Advice about people is opinion resting on limited evidence; say so when it is thin.',
    'If the recordings do not contain the answer, say so plainly. Never invent facts, tasks, dates or quotes.',
    'You never send anything. A draft message is just text for the user to review.',
    'Speakers labeled "Unknown 1", "Unknown 2" etc. are unidentified: refer to them by that label and never guess a name.',
  ].filter(Boolean).join('\n');
}

// Does `name` (an action item's owner) refer to `me`? Whole words only, either way round, so "Jeff"
// matches "Jeff Eberhard" and "Al" never matches "Alex". Same rule as the browser's isMe().
export function isMeName(name, me) {
  const w = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const a = w(name), b = w(me);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((x) => long.includes(x));
}

// Which bucket an open item belongs in for reminders: the one place this is decided, so the brief
// and the Today screen agree. `today` is YYYY-MM-DD, `me` the viewer's name (or '').
export function reminderBucket(item, today, isMine = true) {
  const iso = typeof item.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(item.due) ? item.due.slice(0, 10) : null;
  if (!isMine) return 'waiting';
  if (item.overdue) return 'overdue';
  if (iso === today) return 'today';
  if (iso) {
    const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
    return days <= 7 ? 'week' : 'later';
  }
  return item.slipping ? 'slipping' : 'open';
}
export const BUCKETS = [
  ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'This week'], ['slipping', 'Slipping'],
  ['open', 'Open'], ['later', 'Later'], ['waiting', 'Waiting on others'],
];

// The facts the brief must start from, computed rather than left for the model to work out: what is
// overdue, due today and this week, slipping, and what others owe the user. `isMine(owner)` says
// whether an owner is the user (an item with no owner counts as theirs).
export function groundTruth(items, today, me, isMine) {
  const mine = (x) => !me || !x.owner || isMine(x.owner, me);
  const lines = {};
  for (const x of items) {
    const b = reminderBucket(x, today, mine(x));
    (lines[b] ||= []).push(`- ${x.task}${x.owner ? ` (${x.owner})` : ''}${x.due ? ` due ${x.due}` : ''} [${x.title}, ${x.age_days}d ago]`);
  }
  const out = BUCKETS.filter(([k]) => lines[k]?.length)
    .map(([k, label]) => `${label} (${lines[k].length}):\n${lines[k].slice(0, 12).join('\n')}`);
  return out.length ? `Open commitments already worked out from the recordings (authoritative; do not recount them):\n\n${out.join('\n\n')}` : '';
}

// The two prompts that run on their own, cached per day / per week in the briefs table.
export const AUTO_PROMPTS = {
  today: {
    days: 10,
    ground: true, // the open-commitment lists above are added to what the model sees
    prompt: [
      'Write my brief for today, as a chief of staff would hand it to me on my way into the day.',
      'Use exactly these markdown sections, in this order, and leave out any section with nothing real in it:',
      '## Do first: the three things that matter most today, each with why it is urgent now (a deadline, someone waiting, something blocked on it).',
      '## Due and overdue: dated commitments, soonest first, with the date and who is waiting.',
      '## Waiting on others: what other people owe me, who, since when, and a one-line nudge I could send.',
      '## Decide today: questions or decisions that are stuck, with the options raised in the recordings.',
      '## People: anyone I should reach out to or follow up with, and the reason.',
      '## Since yesterday: what changed in the last day that affects today\'s plans.',
      'Each bullet starts with the bold key noun or name, then one plain sentence, then the recording and date in parentheses.',
      'Weigh the last 48 hours most. Under 400 words. Where something is not in the recordings, say nothing rather than guess.',
    ].join('\n'),
  },
  weekly: {
    days: 7,
    prompt: 'Weekly review of the recordings in this window: the main themes, the decisions made, the questions still unresolved, and the one thing to focus on next week. Keep it under 300 words.',
  },
};
