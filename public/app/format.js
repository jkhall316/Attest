// Presentation helpers (pure, no DOM): friendly model names, date grouping, durations,
// avatar colors, speaker display names, and splitting an AI note into labelled sections.

const UPPER = new Set(['gpt', 'mai', 'oss', 'llm', 'stt', 'asr', 'api', 'ai']);

// "openai/gpt-oss-20b" -> "GPT-OSS 20B". The raw id is for tooltips, never for display.
export function friendlyModel(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const parts = raw.split('/').pop().split(/[-_\s]+/).filter(Boolean).map((p) => {
    const l = p.toLowerCase();
    if (UPPER.has(l)) return l.toUpperCase();
    if (/^\d+(\.\d+)?b$/.test(l)) return l.toUpperCase();
    if (/^v?\d/.test(l)) return l;
    return l[0].toUpperCase() + l.slice(1);
  });
  const i = parts.findIndex((w, k) => w === 'GPT' && parts[k + 1] === 'OSS');
  if (i >= 0) parts.splice(i, 2, 'GPT-OSS');
  return parts.join(' ');
}

const pad = (n) => String(n).padStart(2, '0');

// 329000 -> "5:29"; 3725000 -> "1h 02m"; nothing -> "".
export function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${pad(m)}m` : `${m}:${pad(s % 60)}`;
}

// seconds -> "m:ss" (or "h:mm:ss"), for the player and transcript timestamps.
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// Today / Yesterday / Last 7 days / Earlier, by the viewer's local calendar days.
export function groupByDate(items, now = new Date(), key = (x) => x.created_at) {
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOf(now);
  const groups = [{ label: 'Today', items: [] }, { label: 'Yesterday', items: [] }, { label: 'Last 7 days', items: [] }, { label: 'Earlier', items: [] }];
  for (const it of items || []) {
    const age = Math.round((today - startOf(new Date(key(it)))) / 86400000);
    groups[age <= 0 ? 0 : age === 1 ? 1 : age <= 7 ? 2 : 3].items.push(it);
  }
  return groups.filter((g) => g.items.length);
}

export const STATUS_LABEL = { ready: 'Ready', error: 'Failed', recording: 'Recording', uploaded: 'Processing', processing: 'Processing', transcribed: 'Processing' };

export function initials(name) {
  const n = String(name || '').trim();
  if (!n || /^(unknown|speaker)\b/i.test(n)) return '?';
  const w = n.split(/\s+/).filter(Boolean);
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

// Talk-balance colours, by rank; the player's waveform uses the same ones so the two read together.
export const speakerColor = (i) => `hsl(${(235 + i * 67) % 360} 70% 64%)`;

// A stable avatar color per name, as inline CSS custom properties.
export function avatarStyle(name) {
  let h = 0;
  for (const c of String(name || '?')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `--av:hsl(${h} 42% 30%);--av-fg:hsl(${h} 85% 85%)`;
}

// label -> {shown, idx, confirmed}, with "Unknown N" numbered in order like the chips.
export function displayNames(speakers) {
  const map = new Map();
  let unknown = 0;
  (speakers || []).forEach((s, idx) => {
    map.set(s.label, { shown: s.name || `Unknown ${++unknown}`, idx, confirmed: Boolean(s.confirmed && s.name) });
  });
  return map;
}

const ICON_FOR = [
  [/commit|promis|owe|open item|action/i, 'check'], [/depend|waiting|wait on/i, 'link'], [/block|risk|issue|problem/i, 'alert'],
  [/decision|decid/i, 'flag'], [/question|unresolved|unanswered|open/i, 'help'], [/next|focus|today|plan/i, 'target'],
  [/theme|overview|summary|takeaway|main/i, 'layers'],
];
export const iconForSection = (title) => (ICON_FOR.find(([re]) => re.test(title)) || [null, 'dot'])[1];

// Splits an AI note into [{title, body}] when it has recognisable headings: "# Title",
// a whole-line "**Title**", or "(1) Title". Returns null with fewer than two sections, so a
// plain paragraph is left alone. Text before the first heading comes back with title ''.
export function sections(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let cur = { title: '', body: [] };
  const heading = (l) => {
    let m;
    if ((m = l.match(/^#{1,4}\s+(.+?)\s*#*$/))) return m[1];
    if ((m = l.match(/^\*\*([^*]{3,80})\*\*:?\s*$/))) return m[1];
    if ((m = l.match(/^\(\d{1,2}\)\s+(\S.{1,80})$/))) return m[1];
    return null;
  };
  for (const raw of lines) {
    const t = heading(raw.trim());
    if (t) { out.push(cur); cur = { title: t.replace(/\*\*/g, ''), body: [] }; } else cur.body.push(raw);
  }
  out.push(cur);
  const real = out.filter((s) => s.title);
  if (real.length < 2) return null;
  return out.map((s) => ({ title: s.title, body: s.body.join('\n').trim() })).filter((s) => s.title || s.body);
}
