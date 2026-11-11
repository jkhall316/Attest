// Summary template catalog (#5): 88 builtins from src/templates.js plus per-owner
// rows in custom_templates. resolveTemplate() itself lives in ../db.js because the
// recordings routes need it too.

import { TEMPLATES } from '../templates.js';
import { json, fail, uid } from '../http.js';

function slugifyTemplateKey(label) {
  return String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom';
}

// Dedupe against builtin keys first (they are reserved), then against this owner's
// existing custom keys, appending _2, _3, ... until it is unique.
async function uniqueTemplateKey(env, owner, label) {
  const base = slugifyTemplateKey(label);
  for (let n = 1, key = base; ; key = `${base}_${++n}`) {
    if (TEMPLATES[key]) continue;
    const existing = await env.DB.prepare(
      'SELECT 1 FROM custom_templates WHERE owner = ? AND key = ?'
    ).bind(owner, key).first();
    if (!existing) return key;
  }
}

export async function listTemplates(env, owner) {
  const rows = (await env.DB.prepare(
    'SELECT id, key, label, style, length FROM custom_templates WHERE owner = ? ORDER BY created_at'
  ).bind(owner).all()).results;
  const custom = {};
  for (const row of rows) {
    custom[row.key] = { label: row.label, style: row.style, length: row.length || undefined, group: 'custom', id: row.id };
  }
  return { ...TEMPLATES, ...custom };
}

export async function createTemplate(request, env, owner) {
  const body = await request.json().catch(() => ({}));
  const label = String(body.label || '').trim();
  const style = String(body.style || '').trim();
  if (!label || !style) return fail('label and style required');
  const length = body.length ? String(body.length).trim() : null;
  const key = await uniqueTemplateKey(env, owner, label);
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO custom_templates (id, owner, key, label, style, length, created_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, owner, key, label, style, length, Date.now()).run();
  return json({ id, key, label, style, length, group: 'custom' });
}

export async function deleteTemplate(env, owner, id) {
  const res = await env.DB.prepare('DELETE FROM custom_templates WHERE id = ? AND owner = ?')
    .bind(id, owner).run();
  // Report a miss instead of a false ok, so the UI can drop a stale row.
  if (!res?.meta?.changes) return fail('not found', 404);
  return json({ ok: true });
}
