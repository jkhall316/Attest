// Pure text helpers: no env, no DB, no network. Everything here is unit-tested.

import { TEMPLATES } from './templates.js';

export function safeParse(v) {
  try { return JSON.parse(v); } catch { return null; }
}

// JSON out of a model's reply. Hosted models obey "reply with ONLY JSON"; local ones often
// wrap it in a code fence or add a sentence before it. Tries the whole reply, then a fenced
// block, then the outermost {...}. Null when nothing parses.
export function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const tries = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) { try { return JSON.parse(t); } catch { /* next */ } }
  return null;
}

export function diarizeToText(segments) {
  const blocks = [];
  for (const s of segments || []) {
    const text = (s.text || '').trim();
    if (!text) continue;
    const who = s.speaker || 'Speaker';
    const last = blocks[blocks.length - 1];
    if (last && last.who === who) last.parts.push(text);
    else blocks.push({ who, parts: [text] });
  }
  return blocks.map((b) => `${b.who}: ${b.parts.join(' ')}`).join('\n\n');
}

// FTS5 MATCH is an expression language; strip it down to plain terms so a
// stray quote or paren from the user cannot become a syntax error.
export function ftsQuery(q) {
  const terms = (String(q).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 12);
  return terms.map((t) => `"${t}"`).join(' OR ');
}

export const MINDMAP_ORIENTATIONS = [['topic', 'Topic'], ['driver', 'Driver'], ['people', 'People']];

// Back-compat: old rows only have the single `mindmap` column (stored as the topic tree).
export function mindmapsOf(r) {
  const mm = typeof r.mindmaps === 'string' ? safeParse(r.mindmaps) : r.mindmaps;
  return (mm && Object.keys(mm).length ? mm : null) || (r.mindmap ? { topic: r.mindmap } : null);
}

// `labels` is the builtin + per-owner custom map (routes/templates.js listTemplates).
// Without it a custom template would export as its raw slug key instead of its label.
function templateLabel(r, labels) {
  const map = labels || TEMPLATES;
  return map[r.template]?.label || r.template;
}

export function recordingToMarkdown(r, labels) {
  const date = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [`# ${r.title}`, '', `_${date} · ${templateLabel(r, labels)}_`, ''];
  if (r.summary) lines.push('## Summary', '', r.summary, '');
  const items = typeof r.action_items === 'string' ? safeParse(r.action_items) : r.action_items;
  if (items?.length) {
    lines.push('## Action items', '');
    for (const a of items) {
      const meta = [a.owner, a.due].filter(Boolean).join(', ');
      lines.push(`- [ ] ${a.task}${meta ? ` _(${meta})_` : ''}`);
    }
    lines.push('');
  }
  const mm = mindmapsOf(r);
  for (const [key, label] of MINDMAP_ORIENTATIONS) {
    if (mm?.[key]) lines.push(`## Mind map — ${label}`, '', mm[key], '');
  }
  if (r.transcript) lines.push('## Transcript', '', r.transcript, '');
  return lines.join('\n');
}

// Print-ready HTML. The PDF story is the browser's own "Save as PDF" (#8) — no
// pdf-lib, no server-side renderer. @media print drops the chrome and the buttons.
export function recordingToHtml(r, labels) {
  const date = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const items = typeof r.action_items === 'string' ? safeParse(r.action_items) : r.action_items;
  const mm = mindmapsOf(r);
  const block = (title, body) => body ? `<h2>${esc(title)}</h2>${body}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title>
<style>
  body { font: 15px/1.55 -apple-system, system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #111 }
  h1 { font-size: 1.6rem; margin-bottom: .2rem }
  h2 { font-size: 1.05rem; margin-top: 1.6rem; border-bottom: 1px solid #ddd; padding-bottom: .2rem }
  .meta { color: #666; font-size: .85rem }
  pre { white-space: pre-wrap; font: inherit; margin: 0 }
  .task { margin: .2rem 0 }
  @media print { body { margin: 0; max-width: none } .noprint { display: none } }
</style></head><body>
<button class="noprint" onclick="print()">Save as PDF</button>
<h1>${esc(r.title)}</h1><div class="meta">${esc(date)} · ${esc(templateLabel(r, labels))}</div>
${block('Summary', r.summary ? `<pre>${esc(r.summary)}</pre>` : '')}
${block('Action items', items?.length ? items.map((a) => {
    const meta = [a.owner, a.due].filter(Boolean).join(', ');
    return `<div class="task">☐ ${esc(a.task)}${meta ? ` <em>(${esc(meta)})</em>` : ''}</div>`;
  }).join('') : '')}
${MINDMAP_ORIENTATIONS.map(([k, label]) => block(`Mind map — ${label}`, mm?.[k] ? `<pre>${esc(mm[k])}</pre>` : '')).join('')}
${block('Transcript', r.transcript ? `<pre>${esc(r.transcript)}</pre>` : '')}
</body></html>`;
}

// Filenames land in a Content-Disposition header and inside the zip, so keep them
// to a conservative ASCII set; zip() dedupes collisions on its own.
export function safeFilename(title) {
  return String(title || 'recording').replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 80) || 'recording';
}

// A live recording whose tab died would otherwise sit at status='recording' forever, and a
// process() request killed mid-flight at status='processing'. Both are judged by last
// activity (status_at, falling back to created_at): parts/chunks and process() touch it.
export const STALE_RECORDING_MS = 15 * 60 * 1000;
export const STALE_PROCESSING_MS = 20 * 60 * 1000;

export function effectiveStatus(row, now = Date.now()) {
  const last = row.status_at || row.created_at;
  if (row.status === 'recording' && now - last > STALE_RECORDING_MS) {
    return { status: 'error', error: row.error || 'recording was interrupted before it finished', recoverable: true };
  }
  if ((row.status === 'processing' || row.status === 'transcribed') && now - last > STALE_PROCESSING_MS) {
    return { status: 'error', error: row.error || 'processing timed out; retry', recoverable: false };
  }
  return { status: row.status, error: row.error, recoverable: false };
}

// New chat threads start untitled; the first question becomes the title (#2).
export function chatTitleFrom(question) {
  const t = String(question || '').trim().slice(0, 60).trim();
  return t || 'New chat';
}

// chat_messages rows -> {role,content} turns for the chat completion, oldest first.
// Capped to the last 10 so a long thread cannot blow out the context window.
export function historyToMessages(messages) {
  return (messages || [])
    .map((m) => ({ role: m.role, content: String(m.content || '').trim() }))
    .filter((m) => m.content)
    .slice(-10);
}

/* --- #7 live transcription --- */
// Appends one 5s chunk's text to the running live preview. Capped at ~20000 chars,
// keeping the tail (the start of a long meeting matters least for a live preview),
// so an hours-long recording cannot grow the row without bound.
export function appendLive(prev, next) {
  const joined = [String(prev || '').trim(), String(next || '').trim()].filter(Boolean).join(' ');
  return joined.length > 20000 ? joined.slice(-20000) : joined;
}
/* --- /#7 live transcription --- */
