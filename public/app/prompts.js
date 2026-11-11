// The 15 "run my day" prompts. `auto` ones run on their own (see today.js and the recording
// view); the rest are prefilled into the Today prompt box so the person can edit then run.
// Every prompt is answered from the recordings in the chosen day window.
//   person: 'required' | 'optional' | undefined      deep: wider sweep (20 recordings)

export const GROUPS = { day: 'Run your day', business: 'Run your business', people: 'Work with others' };

export const PROMPTS = [
  { n: 1, id: 'brief', group: 'day', label: "Today's brief", auto: 'Runs automatically once a day (and again after a new recording), shown at the top of Today.' },
  { n: 2, id: 'promises', group: 'day', label: 'What did I promise?', days: 30,
    prompt: 'List every commitment I made, and every action item assigned to me, that shows no sign of being finished. Group by who is waiting on me. Give the recording and date for each.' },
  { n: 3, id: 'overdue', group: 'day', label: 'Overdue and slipping', auto: 'Always on: open action items past their due date, or open for 7+ days, with a count on the Today button.' },
  { n: 4, id: 'prep', group: 'day', label: 'Prep me for {person}', days: 60, person: 'required',
    prompt: 'Prep me for my next conversation with {person}: the last few conversations in brief, open items in both directions, what they care about, and what I should raise or avoid.' },
  { n: 5, id: 'wrap', group: 'day', label: 'End-of-day wrap', days: 1,
    prompt: 'Wrap up my day: decisions made, new tasks and who owns them, anything left unresolved, and what to carry over to tomorrow.' },
  { n: 6, id: 'weekly', group: 'business', label: 'Weekly review', auto: 'Runs automatically once a week, shown on Today.' },
  { n: 7, id: 'decisions', group: 'business', label: 'Decisions log', days: 30,
    prompt: 'List every decision made, in date order: what was decided, who decided it, and the recording it came from. Flag any that were later contradicted.' },
  { n: 8, id: 'recurring', group: 'business', label: 'Recurring problems', days: 60, deep: true,
    prompt: 'Which problems or topics keep coming up across these recordings without being resolved? For each, say how often, over what period, and what has been tried.' },
  { n: 9, id: 'customers', group: 'business', label: 'Customer or client pulse', days: 30,
    prompt: 'What are customers or clients complaining about, asking for, or objecting to? Group the themes, with a short quote and the recording for each.' },
  { n: 10, id: 'changed', group: 'business', label: 'What changed?', days: 30, person: 'optional',
    prompt: 'Compare the earliest and the latest conversations in this window{ with person}. What has changed in positions, plans, priorities or commitments? What stayed the same?' },
  { n: 11, id: 'talk', group: 'people', label: 'How I show up', auto: 'Always on: every recording shows each speaker\'s share of talk time, turns, questions asked, longest turn and overlaps.' },
  { n: 12, id: 'comms', group: 'people', label: 'Communication advice for {person}', days: 60, person: 'required',
    prompt: 'How does {person} communicate, what do they respond to, and where has there been friction? Suggest how I should approach them next time. Back each point with a short quote, and say how thin the evidence is.' },
  { n: 13, id: 'followup', group: 'people', label: 'Follow-up draft to {person}', days: 14, person: 'required',
    prompt: 'Draft a short follow-up message to {person} that recaps our latest conversation and lists the action items that are theirs and mine. Plain text, ready for me to edit.' },
  { n: 14, id: 'unanswered', group: 'people', label: 'Unanswered questions', auto: 'Always on: each recording lists questions that were asked but never clearly answered.' },
  { n: 15, id: 'coach', group: 'people', label: 'Coach me', days: 30,
    prompt: 'Coach me: pick the one thing I should do differently in how I run conversations, based on these recordings. Quote the moment, say what to do instead, and keep it kind and specific.' },
];

export const RUNNABLE = PROMPTS.filter((p) => p.prompt);

// {person} -> the chosen name. For prompts with person optional, "{ with person}" collapses
// to " with Name", or to nothing when nobody is chosen. Returns null if a required name is missing.
export function fillPrompt(template, person) {
  const name = (person || '').trim();
  const t = template.replace(/\{ with person\}/g, name ? ` with ${name}` : '');
  if (!t.includes('{person}')) return t;
  return name ? t.replace(/\{person\}/g, name) : null;
}
