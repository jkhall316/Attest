// The per-recording "Ask Attest" panel. Stateless: no thread, no persistence.

import { $, esc, md } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';

// What "Deep" means, shown wherever the checkbox appears (tooltip, and a line when ticked).
export const DEEP_HELP = 'Deep research splits your question into up to 4 sub-questions, searches your recordings for each, and combines what it finds (up to 12 recordings) into one answer that also says what it could not find. It is slower and uses 2 model calls instead of 1, so use it for broad questions like "what has changed since March?" rather than quick lookups.';

export const deepToggle = (id) =>
  `<label class="chip-toggle" title="${esc(DEEP_HELP)}"><input type="checkbox" id="${id}"><span>Deep reasoning</span><span class="info" aria-hidden="true">?</span></label>`;
export const deepHint = (id) => `<div class="hint muted" id="${id}-hint" hidden>${esc(DEEP_HELP)}</div>`;
export function wireDeep(id) {
  const box = $(id);
  if (box) box.onchange = () => { const h = $(id + '-hint'); if (h) h.hidden = !box.checked; };
}

export async function doAsk() {
  const q = $('q')?.value.trim();
  if (!q || state.asking) return;
  state.asking = true;
  const deep = $('q-deep')?.checked;
  const out = $('ask-out');
  out.innerHTML = `<div class="muted">${deep ? 'Researching… (3 passes)' : 'Thinking…'}</div>`;
  try {
    const { answer, sources, sub_questions } = await api('/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: q, mode: deep ? 'deep' : undefined }),
    });
    out.innerHTML = `<div class="md">${md(answer)}</div>` +
      (sub_questions?.length ? `<div class="muted" style="margin-top:10px">Searched for: ${sub_questions.map(esc).join(' · ')}</div>` : '') +
      (sources.length ? `<div class="muted" style="margin-top:10px">Sources: ${sources.map(s => esc(s.title)).join(' · ')}</div>` : '');
  } catch (e) {
    out.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  }
  state.asking = false;
}
