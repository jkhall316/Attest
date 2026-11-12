// Row access shared across route modules. Every query is owner-scoped.

import { TEMPLATES } from './templates.js';
import { safeParse, effectiveStatus } from './text.js';
import { talkStats } from './insights.js';

export async function readRow(env, id, owner) {
  const r = await env.DB.prepare('SELECT * FROM recordings WHERE id = ? AND owner = ?')
    .bind(id, owner).first();
  if (!r) return null;
  return {
    ...r,
    ...effectiveStatus(r),
    has_audio: Boolean(r.r2_key), // false for rows imported as transcripts (Omi)
    segments: safeParse(r.segments),
    action_items: safeParse(r.action_items),
    mindmaps: safeParse(r.mindmaps) || (r.mindmap ? { topic: r.mindmap } : null),
    speakers: safeParse(r.speakers) || [], // [{label,name,evidence,confirmed}] (#4)
    voice_match: safeParse(r.voice_match), // {model, at, scores} or null (#24)
    unanswered: safeParse(r.unanswered) || [],
    lineage: safeParse(r.lineage), // {kind: trim|split|merge, from: [ids], ...} on a recording made by shaping
    hidden: Boolean(r.hidden),
    talk_stats: talkStats(safeParse(r.segments), safeParse(r.speakers) || []),
  };
}

// Builtin TEMPLATES[key] or an owner's row from custom_templates, shaped the same way
// ({label, style, length}) so buildSystemPrompt() never has to know which it got.
export async function resolveTemplate(env, owner, key) {
  if (!key) return null;
  if (TEMPLATES[key]) return TEMPLATES[key];
  const row = await env.DB.prepare(
    'SELECT label, style, length FROM custom_templates WHERE owner = ? AND key = ?'
  ).bind(owner, key).first();
  if (!row) return null;
  return { label: row.label, style: row.style, length: row.length || undefined };
}
