// Command palette (Cmd/Ctrl+K): jump anywhere, run a prompt, or ask Attest. Typing a question
// makes "Ask Attest" the first result; the Deep chip is a modifier on that ask.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { icon } from './icons.js';
import { RUNNABLE } from './prompts.js';
import { DEEP_HELP } from './ask.js';
import { open as openRecording } from './recordings.js';
import { showToday } from './today.js';
import { showAsk, startChat } from './chats.js';
import { startStop } from './recorder.js';

// items: [{label, sub?, group, icon, run}]. Every query word must appear in the label.
// Starts-with beats contains; the original order breaks ties.
export function rankItems(items, q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items
    .map((it, i) => ({ it, i, hay: it.label.toLowerCase() }))
    .filter(({ hay }) => terms.every((t) => hay.includes(t)))
    .sort((a, b) => (Number(b.hay.startsWith(terms[0])) - Number(a.hay.startsWith(terms[0]))) || a.i - b.i)
    .map(({ it }) => it);
}

let items = [], shown = [], sel = 0, recs = [];

function commands() {
  return [
    { group: 'Go to', label: 'Today', icon: 'target', run: () => showToday() },
    { group: 'Go to', label: 'Ask & chats', icon: 'sparkles', run: () => showAsk() },
    { group: 'Go to', label: 'Settings', icon: 'list', run: () => $('settings').click() },
    { group: 'Go to', label: 'Speaking as…', icon: 'user', run: () => $('persona').click() },
    { group: 'Do', label: state.recorder ? 'Stop recording' : 'Start recording', icon: 'mic', run: () => startStop() },
    ...RUNNABLE.map((p) => ({ group: 'Prompts', label: p.label.replace('{person}', 'a person'), sub: p.days ? `last ${p.days}d` : '', icon: 'sparkles',
      run: () => { state.pendingPrompt = p.id; return showToday(); } })),
    ...recs.map((r) => ({ group: 'Recordings', label: r.title, sub: new Date(r.created_at).toLocaleDateString(), icon: 'clock', run: () => openRecording(r.id) })),
  ];
}

function paint() {
  const q = $('pal-q').value;
  const ask = q.trim() ? [{ group: 'Ask Attest', label: `Ask: “${q.trim()}”`, icon: 'sparkles', ask: true }] : [];
  shown = [...ask, ...rankItems(items, q)].slice(0, 40);
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  let last = '';
  $('pal-list').innerHTML = shown.map((it, i) => {
    const head = it.group !== last ? `<div class="pal-group">${esc(it.group)}</div>` : '';
    last = it.group;
    return `${head}<button class="pal-item" role="option" data-i="${i}" aria-selected="${i === sel}">${icon(it.icon, 17)}<span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</button>`;
  }).join('') || '<div class="muted" style="padding:16px">Nothing matches. Press Enter to ask Attest instead.</div>';
  $('pal-list').querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
}

function choose(it) {
  if (!it) { const q = $('pal-q').value.trim(); if (q) it = { ask: true }; else return; }
  const deep = $('pal-deep').checked;
  const q = $('pal-q').value.trim();
  $('palette').close();
  if (it.ask) startChat(q, deep); else it.run();
}

function ensure() {
  if ($('palette')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="palette" aria-label="Command palette">
      <div class="pal-top">${icon('search', 18)}<input id="pal-q" placeholder="Ask anything, or jump to a recording, prompt or page…" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="pal-list"></div>
      <div class="pal-chips"><label class="chip-toggle" title="${esc(DEEP_HELP)}"><input type="checkbox" id="pal-deep"><span>Deep reasoning</span><span class="info" aria-hidden="true">?</span></label>
        <span class="muted">Applies when you ask Attest</span></div>
      <div class="pal-list" id="pal-list" role="listbox"></div>
      <div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> select</span><span><kbd>Esc</kbd> close</span></div>
    </dialog>`);
  $('pal-q').oninput = () => { sel = 0; paint(); };
  $('pal-q').onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[sel]); }
  };
  $('pal-list').onclick = (e) => { const b = e.target.closest('.pal-item'); if (b) choose(shown[Number(b.dataset.i)]); };
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) $('palette').close(); });
}

export async function openPalette(preset = '') {
  ensure();
  $('pal-q').value = preset;
  sel = 0;
  items = commands();
  paint();
  $('palette').showModal();
  $('pal-q').focus();
  api('/recordings').then(({ recordings }) => { recs = recordings.slice(0, 60); items = commands(); if ($('palette').open) paint(); }).catch(() => {});
}

export function wirePalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('palette')?.open ? $('palette').close() : openPalette(); }
  });
  $('cmdk').onclick = () => openPalette();
}
