// Which reminder bucket an open item falls in. The same rule as reminderBucket() in src/insights.js,
// which the brief is written from, so the brief and this screen never disagree about what is overdue.

const DAY = 86400000;

export const BUCKETS = [
  ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'This week'], ['slipping', 'Slipping'],
  ['open', 'Open'], ['later', 'Later'], ['waiting', 'Waiting on others'],
];

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

// items -> Map(bucket -> items), `mineOf(item)` says whether it is the viewer's (no name set: all are).
export function groupReminders(items, today, mineOf = () => true) {
  const by = new Map();
  for (const x of items) {
    const b = reminderBucket(x, today, mineOf(x));
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(x);
  }
  return by;
}
