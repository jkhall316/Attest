// Template dropdown (88 builtins + per-owner custom, #5) and the transcriber
// deprecation note (#16).

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';

const TPL_GROUPS = [
  ['work', 'Work'], ['sales', 'Sales'], ['research', 'Research'], ['people', 'People'],
  ['health', 'Health'], ['personal', 'Personal'], ['media', 'Media'], ['education', 'Education'],
  ['custom', 'Custom'],
];

export async function loadTemplates() {
  const { templates } = await api('/templates');
  state.TPL = templates;
  const groups = {};
  for (const [k, v] of Object.entries(templates)) (groups[v.group || 'custom'] ||= []).push([k, v]);
  $('template').innerHTML = TPL_GROUPS
    .filter(([g]) => groups[g]?.length)
    .map(([g, label]) => `<optgroup label="${esc(label)}">${groups[g].map(([k, v]) =>
      `<option value="${k}">${esc(v.label)}</option>`).join('')}</optgroup>`)
    .join('') + `<option value="__custom__">+ custom…</option>`;
}

// #16: warn before a transcriber sunsets. Days/level are computed server-side in
// /api/meta so this script does not duplicate the date maths.
export function renderTranscriberNote() {
  const d = state.META?.deprecations?.[$('transcriber').value];
  const el = $('transcriber-note');
  if (!el) return;
  if (!d) { el.innerHTML = ''; return; }
  el.innerHTML = d.level === 'retired'
    ? `<div class="banner" style="margin-top:8px;font-size:12px">Retired on ${d.cutoff}. Pick another transcriber. ${esc(d.note)}</div>`
    : `<div class="${d.level === 'soon' ? 'banner' : 'muted'}" style="margin-top:8px;font-size:12px">
         Sunsets ${d.cutoff} · ${d.days} days left. ${esc(d.note)}</div>`;
}

export function wireTemplateDialog() {
  $('template').addEventListener('change', () => {
    if ($('template').value === '__custom__') {
      $('tpl-label').value = '';
      $('tpl-style').value = '';
      $('tpl-dialog').showModal();
    }
  });

  $('tpl-dialog').addEventListener('close', async () => {
    if ($('tpl-dialog').returnValue !== 'save') {
      $('template').value = 'meeting';
      return;
    }
    const label = $('tpl-label').value.trim();
    const style = $('tpl-style').value.trim();
    if (!label || !style) { $('template').value = 'meeting'; return; }
    try {
      const t = await api('/templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, style }),
      });
      await loadTemplates();
      $('template').value = t.key;
    } catch (e) {
      alert(e.message);
      $('template').value = 'meeting';
    }
  });
}
