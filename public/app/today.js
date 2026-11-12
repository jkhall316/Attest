// The Today screen (home): auto briefs, open action items, and the prefilled prompt box.

import { getArea, areaQuery } from './scope.js';
import { BUCKETS, groupReminders } from './reminders.js';
import { $, esc, md } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { refresh } from './lists.js';
import { open } from './recordings.js';
import { GROUPS, PROMPTS, RUNNABLE, fillPrompt } from './prompts.js';
import { getMe, setMe, isMe } from './me.js';
import { deepToggle, deepHint, wireDeep } from './ask.js';
import { startChat } from './chats.js';
import { icon } from './icons.js';
import { noteHtml } from './recordings.js';

let acks = new Set(); // brief items the owner has acknowledged (hidden), keyed by normalized text
let token = 0; // bumps on every showToday(), so a slow response cannot paint over a newer screen

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const store = {
  get(k, dflt = '') { try { return localStorage.getItem('attest.' + k) ?? dflt; } catch { return dflt; } },
  set(k, v) { try { localStorage.setItem('attest.' + k, v); } catch { /* private window */ } },
};
const autoOn = () => store.get('auto', 'on') !== 'off';

const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function badgeText(d) {
  const n = (d?.overdue_count || 0) + (d?.slipping_count || 0);
  return n ? String(n) : '';
}

// Count on the sidebar Today button. Best effort.
export async function loadBadge() {
  try {
    const d = await api('/today?date=' + localDate() + areaQuery('&'));
    if ($('badge')) $('badge').textContent = badgeText(d);
    return d;
  } catch { return null; }
}

function itemRow(x) {
  const who = x.owner ? `<span class="tag who">${icon('user', 12)} ${esc(x.owner)}</span>` : '';
  const due = x.due ? `<span class="tag due${x.overdue ? ' late' : ''}">${icon('calendar', 12)} ${esc(x.due)}${x.overdue ? ' · overdue' : ''}</span>` : '';
  const age = x.slipping ? `<span class="tag age">open ${x.age_days}d</span>` : '';
  return `<label class="task" data-rec="${esc(x.rec_id)}" data-i="${x.i}">
    <input type="checkbox">
    <span class="body">${esc(x.task)}
      <span class="meta">${who}${due}${age}<a href="#" class="open-rec" title="${esc(x.title)}">${esc(x.title)}</a></span></span></label>`;
}

const ackKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 200);

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'has', 'have', 'not', 'but', 'you', 'your', 'about', 'still', 'open']);
const tokens = (k) => new Set(k.split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
// True when `key` is an acknowledged item, or says nearly the same thing in other words
// (80% of the shorter wording's content words shared, and at least 3 of them).
export function isAcked(key, set) {
  if (set.has(key)) return true;
  const a = tokens(key);
  if (a.size < 3) return false;
  for (const other of set) {
    const b = tokens(other);
    if (b.size < 3) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    if (shared >= 3 && shared / Math.min(a.size, b.size) >= 0.8) return true;
  }
  return false;
}

// Adds a ✓ to every bullet in a brief card and hides the ones already acknowledged.
function decorateBrief(id) {
  const card = $(id);
  if (!card) return;
  let hidden = 0;
  for (const li of card.querySelectorAll('li')) {
    const key = ackKey(li.textContent || '');
    if (!key) continue;
    if (isAcked(key, acks)) {
      const ul = li.parentElement;
      li.remove(); hidden++;
      if (ul && !ul.children.length) ul.remove();
      continue;
    }
    li.insertAdjacentHTML('afterbegin', `<button class="ack" data-key="${esc(key)}" title="Acknowledge: hide this item" aria-label="Acknowledge">✓</button>`);
  }
  if (hidden) card.insertAdjacentHTML('beforeend', `<div class="muted ack-note">${hidden} acknowledged item${hidden === 1 ? '' : 's'} hidden · <a href="#" class="ack-restore">Show all</a></div>`);
}

function wireAcks(id) {
  const card = $(id);
  if (!card) return;
  card.onclick = async (e) => {
    const restore = e.target.closest('.ack-restore');
    if (restore) {
      e.preventDefault();
      try { await api('/today/ack', { method: 'DELETE' }); } catch (err) { return alert(err.message); }
      acks = new Set(); return showToday();
    }
    const btn = e.target.closest('.ack');
    if (!btn) return;
    const key = btn.dataset.key;
    try { await post('/today/ack', { key }); } catch (err) { return alert(err.message); }
    acks.add(key);
    for (const c of ['brief-card', 'weekly-card']) {
      const el = $(c);
      if (!el) continue;
      for (const b of el.querySelectorAll('.ack')) if (b.dataset.key === key) {
        const li = b.closest('li'); const ul = li?.parentElement;
        li?.remove(); if (ul && !ul.children.length) ul.remove();
      }
    }
  };
}

function briefHtml(b, emptyMsg) {
  if (!b) return `<div class="muted">${esc(emptyMsg)}</div>`;
  return `${noteHtml(b.content)}
    <div class="muted" style="margin-top:12px">${b.empty ? '' : 'Generated ' + new Date(b.created_at).toLocaleString()}</div>`;
}

export async function showToday(opts) {
  const mine = ++token;
  state.current = null; state.currentChat = null; state.screen = 'today';
  refresh();
  const date = localDate();
  $('main').innerHTML = '<div class="muted">Loading Today…</div>';
  let d;
  try { d = await api('/today?date=' + date + areaQuery('&')); } catch (e) {
    $('main').innerHTML = `<div class="banner">${esc(e.message)}</div>`; return;
  }
  if (mine !== token) return;
  $('badge').textContent = badgeText(d);

  const personOpts = '<option value="">Anyone</option>' + d.people.map((p) => `<option>${esc(p.name)}</option>`).join('');
  const chips = Object.entries(GROUPS).map(([g, label]) => `
    <div class="group-label">${esc(label)}</div>
    <div class="row">${RUNNABLE.filter((p) => p.group === g).map((p) =>
      `<button class="chipbtn" data-id="${p.id}" title="${esc(p.prompt)}">${esc(p.label.replace('{person}', 'a person'))}</button>`).join('')}</div>`).join('');
  const autoNotes = PROMPTS.filter((p) => p.auto).map((p) => `<li><b>${esc(p.label)}.</b> ${esc(p.auto)}</li>`).join('');

  acks = new Set(d.acks || []);
  openData = d.open;
  const me = getMe();
  const mineCount = me ? d.open.filter((x) => isMe(x.owner, me)).length : 0;
  if (!store.get('items')) store.set('items', me && mineCount ? 'mine' : 'all');

  $('main').innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-end">
      <h2 style="margin:0">Today <span class="muted">${esc(new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</span></h2>
      <label class="muted" style="display:flex;align-items:center;gap:6px" title="Write today's brief and the weekly review automatically when you open Attest. Each costs one small model call.">
        <input type="checkbox" id="auto-on" ${autoOn() ? 'checked' : ''}> Write briefs automatically</label>
    </div>
    ${d.has_recordings ? '' : '<div class="empty">Record or upload something and your day will start to fill in here.</div>'}
    <div class="today-grid">
      <div class="today-main">
        <div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">Today's brief</h3><button id="brief-refresh" class="small">Refresh</button></div>
        <div id="today-stats" class="stats"></div>
        <div class="card-box brief-hero" id="brief-card">${briefHtml(d.brief, d.has_recordings ? 'Generating…' : 'Nothing to brief yet.')}</div>
        ${omnibarHtml(d.people)}
        <details style="margin-top:20px" ${d.weekly ? 'open' : ''}><summary><b>Weekly review</b> <span class="muted">(week of ${esc(d.week_start)})</span></summary>
          <div class="card-box brief-hero" id="weekly-card" style="margin-top:8px">${briefHtml(d.weekly, d.has_recordings ? 'Generating…' : 'Nothing to review yet.')}</div>
          <button id="weekly-refresh" class="small" style="margin-top:6px">Refresh</button>
        </details>
      </div>
      <div class="today-side">
        <div class="row" style="justify-content:space-between;align-items:flex-end">
          <h3 style="margin:0">Needs you <span class="muted" style="font-weight:400">(${d.open_count})</span></h3>
          <div class="row" id="items-filter"></div>
        </div>
        <div id="open-items" class="list reminders"></div>
      </div>
    </div>
    <h3>Prompts for your day</h3>
    <div class="muted" style="margin-bottom:8px">One-click prompts over your recent recordings. Pick a person and a time window, choose a prompt, edit it if you like, then Run.</div>
    <div class="row"><select id="p-person">${personOpts}</select>
      <select id="p-days"><option value="1">last day</option><option value="7">last 7 days</option><option value="14" selected>last 14 days</option><option value="30">last 30 days</option><option value="60">last 60 days</option></select></div>
    ${chips}
    <textarea id="p-text" rows="3" style="width:100%;margin-top:10px" placeholder="Pick a prompt above, or write your own…"></textarea>
    <div class="row" style="margin-top:6px"><button class="primary" id="p-run">Run</button><span class="muted" id="p-status"></span></div>
    <div id="p-out" style="margin-top:12px"></div>
    <h3>People</h3>
    <div class="muted" style="margin-bottom:8px">Everyone Attest knows by name. If you named the same person two ways (for example “Jeff” and “Jeff Eberhard”), merge them so their recordings, voice samples and memory become one person.</div>
    <div id="people-suggest"></div>
    <div id="people-list" class="list"><div class="muted" style="padding:12px 0">Loading…</div></div>
    <h3>Memory</h3>
    <div class="muted" id="mem-status">Loading…</div>
    <div class="muted" style="font-size:12px;margin-top:2px">Facts about someone Attest could not name stay here for a week so you can tag the speaker. After that they leave this list but stay searchable in Ask.</div>
    <div class="row" style="margin:8px 0"><select id="mem-kind"><option value="">All kinds</option></select>
      <select id="mem-person"><option value="">Anyone</option></select>
      <button id="mem-build" class="small" hidden></button></div>
    <div id="mem-list" class="list"></div>
    <details style="margin-top:22px"><summary class="muted">What runs on its own</summary><ul class="muted">${autoNotes}</ul></details>`;

  wire(d, mine, date);
  for (const id of ['brief-card', 'weekly-card']) { wireAcks(id); decorateBrief(id); }
  renderOpenItems();
  loadPeople(mine);
  loadMemory(mine);
  autoGenerate(d, mine, date, opts?.regenerate === true);
}

// The Ask omnibar. Modifiers are chip pills under the input: Deep reasoning, a date window and
// a speaker. With no date or speaker it opens a chat thread over everything; with either one it
// answers right here from just those recordings (the same scoped call the prompts below use).
export const DAY_CHOICES = [['', 'Any time'], ['1', 'Last day'], ['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days'], ['60', 'Last 60 days']];
export function omnibarHtml(people = []) {
  const chip = (id, ic, label, opts, aria) => `<label class="chip-select" id="${id}-chip">${icon(ic, 13)}<span>${esc(label)}</span>${icon('chevron', 12)}<select id="${id}" aria-label="${aria}">${opts}</select></label>`;
  const days = DAY_CHOICES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const who = '<option value="">Any speaker</option>' + people.map((p) => `<option>${esc(p.name)}</option>`).join('');
  return `<div class="omni">
    <div class="omnibar">${icon('search', 18)}
      <input id="t-ask" placeholder="Ask anything about everything you have recorded…" aria-label="Ask Attest" enterkeyhint="search">
      <button class="primary" id="t-ask-go">Ask</button>
    </div>
    <div class="omni-chips">${deepToggle('t-deep')}
      ${chip('t-days', 'calendar', 'Any time', days, 'Date filter')}
      ${people.length ? chip('t-who', 'users', 'Any speaker', who, 'Speaker filter') : ''}
      <span class="omni-scope" id="t-scope"></span></div>
    ${deepHint('t-deep')}
    <div id="t-ask-out"></div></div>`;
}

// What the chips mean, in words, or '' when nothing narrows the question. Pure, for tests.
export function omniScope(days, who) {
  if (!days && !who) return '';
  const span = days ? (days === '1' ? 'the last day' : `the last ${days} days`) : 'the last 60 days';
  return `Answers here, from ${span}${who ? ` with ${who}` : ''}.`;
}

function wireOmnibar(date, mine) {
  wireDeep('t-deep');
  const sync = () => {
    for (const id of ['t-days', 't-who']) {
      const sel = $(id);
      if (!sel) continue;
      $(id + '-chip').classList.toggle('on', Boolean(sel.value));
      $(id + '-chip').querySelector('span').textContent = sel.selectedOptions[0]?.textContent || '';
    }
    $('t-scope').textContent = omniScope($('t-days').value, $('t-who')?.value || '');
  };
  for (const id of ['t-days', 't-who']) if ($(id)) $(id).onchange = sync;
  const askGo = async () => {
    const q = $('t-ask').value.trim();
    if (!q) return;
    const days = $('t-days').value, person = $('t-who')?.value || '', deep = $('t-deep').checked;
    if (!days && !person) return startChat(q, deep);
    const out = $('t-ask-out');
    $('t-ask-go').disabled = true;
    out.innerHTML = `<div class="muted">${deep ? 'Researching…' : 'Thinking…'}</div>`;
    try {
      const r = await post('/insight', { prompt: q, person, days: Number(days) || 60, date, area: getArea() || undefined, me: getMe(), deep });
      if (mine !== token) return;
      out.innerHTML = `<div class="panel"><div class="md">${md(r.answer)}</div></div>` +
        (r.sources?.length ? `<div class="muted" style="margin-top:8px">From: ${r.sources.map((x) => esc(x.title)).join(' · ')}</div>` : '');
    } catch (e) {
      if (mine === token) out.innerHTML = `<div class="banner">${esc(e.message)}</div>`;
    }
    if (mine === token) $('t-ask-go').disabled = false;
  };
  $('t-ask-go').onclick = askGo;
  $('t-ask').onkeydown = (e) => { if (e.key === 'Enter') askGo(); };
}

function wire(d, mine, date) {
  wireOmnibar(date, mine);
  $('auto-on').onchange = () => store.set('auto', $('auto-on').checked ? 'on' : 'off');
  $('brief-refresh').onclick = () => generate('today', date, mine, true);
  $('weekly-refresh').onclick = () => generate('weekly', date, mine, true);

  $('open-items').onclick = async (e) => {
    const link = e.target.closest('.open-rec');
    if (link) { e.preventDefault(); return open(link.closest('.task').dataset.rec); }
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    const row = box.closest('.task');
    try {
      await api(`/recordings/${row.dataset.rec}/actions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ i: Number(row.dataset.i), done: box.checked }),
      });
      row.classList.toggle('done', box.checked);
      loadBadge();
    } catch (err) { box.checked = !box.checked; alert(err.message); }
  };

  const setPrompt = (p) => {
    $('p-text').value = p.prompt;
    if (p.days) $('p-days').value = String(p.days);
    $('p-text').dataset.deep = p.deep ? '1' : '';
    $('p-status').textContent = p.person === 'required' ? 'Choose a person above, then Run.' : '';
  };
  $('main').querySelectorAll('.chipbtn[data-id]').forEach((b) => { b.onclick = () => setPrompt(RUNNABLE.find((p) => p.id === b.dataset.id)); });
  if (state.pendingPrompt) {   // chosen in the command palette
    const p = RUNNABLE.find((x) => x.id === state.pendingPrompt);
    state.pendingPrompt = null;
    if (p) { setPrompt(p); $('p-text').scrollIntoView({ block: 'center' }); $('p-text').focus(); }
  }
  $('p-run').onclick = () => runPrompt(date, mine);
}

async function runPrompt(date, mine) {
  const person = $('p-person').value;
  const text = fillPrompt($('p-text').value.trim(), person);
  if (!$('p-text').value.trim()) return;
  if (text === null) { $('p-status').textContent = 'Choose a person first.'; return; }
  $('p-run').disabled = true; $('p-status').textContent = 'Thinking…'; $('p-out').innerHTML = '';
  try {
    const out = await post('/insight', {
      prompt: text, person, days: Number($('p-days').value), date, area: getArea() || undefined, me: getMe(), deep: $('p-text').dataset.deep === '1',
    });
    if (mine !== token) return;
    $('p-out').innerHTML = `<div class="panel"><div class="md">${md(out.answer)}</div></div>` +
      (out.sources?.length ? `<div class="muted" style="margin-top:8px">From: ${out.sources.map((s) => esc(s.title)).join(' · ')}</div>` : '');
    $('p-status').textContent = '';
  } catch (e) {
    if (mine === token) { $('p-status').textContent = ''; $('p-out').innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
  }
  if (mine === token) $('p-run').disabled = false;
}

async function generate(kind, date, mine, force = false) {
  const card = $(kind === 'today' ? 'brief-card' : 'weekly-card');
  if (!card) return;
  card.innerHTML = '<div class="muted">Generating…</div>';
  try {
    const b = await post('/today/brief', { kind, date, area: getArea() || undefined, me: getMe(), force });
    if (mine === token) { card.innerHTML = briefHtml(b, 'Nothing to show.'); decorateBrief(card.id || (kind === 'today' ? 'brief-card' : 'weekly-card')); }
  } catch (e) {
    if (mine === token) card.innerHTML = `<div class="muted">Could not generate: ${esc(e.message)}</div>`;
  }
}

// Auto-run: a brief that is missing, or older than the newest recording. One at a time.
async function autoGenerate(d, mine, date, regenerate = false) {
  if (!autoOn() || !d.has_recordings) {
    if (!d.brief && $('brief-card')) $('brief-card').innerHTML = '<div class="muted">Press Refresh to generate.</div>';
    if (!d.weekly && $('weekly-card')) $('weekly-card').innerHTML = '<div class="muted">Press Refresh to generate.</div>';
    return;
  }
  for (const [kind, b] of [['today', d.brief], ['weekly', d.weekly]]) {
    if (mine !== token) return;
    if (!b || b.stale || (regenerate && kind === 'today')) await generate(kind, date, mine, regenerate && kind === 'today');
  }
}

/* ---- Memory: facts remembered across recordings ---- */

const KIND_LABEL = { commitment: 'promise', decision: 'decision', preference: 'preference', relationship: 'relationship', fact: 'fact' };

export function factRow(f) {
  return `<div class="task" data-id="${esc(f.id)}" data-rec="${esc(f.recording_id)}">
    ${f.kind === 'commitment' ? `<input type="checkbox" class="fact-done"${f.done ? ' checked' : ''}>` : '<span class="gap"></span>'}
    <span class="body"${f.done ? ' style="opacity:.5;text-decoration:line-through"' : ''}>${f.person ? `<b>${esc(f.person)}</b> · ` : ''}${esc(f.text)}
      <span class="meta"><span class="pill">${esc(KIND_LABEL[f.kind] || f.kind)}</span><span>“${esc(f.quote)}”</span>
      <a href="#" class="open-rec" title="${esc(f.title || 'recording')}">${esc(f.title || 'recording')}</a><a href="#" class="fact-del">forget</a></span></span></div>`;
}

async function loadMemory(mine) {
  if (!$('mem-list')) return;
  const kind = $('mem-kind').value, person = $('mem-person').value;
  let m;
  try { m = await api('/memory?' + new URLSearchParams({ kind, person, area: getArea() })); } catch (e) {
    if (mine === token) $('mem-status').textContent = 'Could not load memory: ' + e.message; return;
  }
  if (mine !== token) return;
  const st = m.status;
  $('mem-status').textContent = `${m.total_facts} facts from ${st.with_facts} of ${st.recordings} recordings · semantic search ${st.vectors_enabled ? `on (${st.indexed} indexed)` : 'off (keyword search only; see the README to turn it on)'}`;
  const kinds = $('mem-kind'), people = $('mem-person');
  if (!kinds.dataset.filled) {
    kinds.dataset.filled = '1';
    kinds.innerHTML = '<option value="">All kinds</option>' + m.kinds.map((k) => `<option value="${esc(k)}">${esc(KIND_LABEL[k] || k)}</option>`).join('');
    people.innerHTML = '<option value="">Anyone</option>' + m.people.map((p) => `<option>${esc(p)}</option>`).join('');
  }
  $('mem-list').innerHTML = m.facts.map(factRow).join('') || '<div class="muted" style="padding:12px 0">Nothing remembered yet. New recordings add facts automatically.</div>';
  const build = $('mem-build');
  build.hidden = !st.remaining;
  build.textContent = `Build memory from ${st.remaining} past recording${st.remaining === 1 ? '' : 's'}`;
  build.onclick = () => buildMemory(mine);
  kinds.onchange = people.onchange = () => loadMemory(mine);
  $('mem-list').onclick = async (e) => {
    const row = e.target.closest('.task');
    if (!row) return;
    if (e.target.closest('.open-rec')) { e.preventDefault(); return open(row.dataset.rec); }
    if (e.target.closest('.fact-del')) {
      e.preventDefault();
      if (!confirm('Forget this fact? It stays in the recording.')) return;
      await api('/memory/' + row.dataset.id, { method: 'DELETE' }).catch((err) => alert(err.message));
      return loadMemory(mine);
    }
    const box = e.target.closest('.fact-done');
    if (box) await api('/memory/' + row.dataset.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: box.checked }) }).catch((err) => { box.checked = !box.checked; alert(err.message); });
  };
}

// Two recordings per call, looped, so a long history never hits one request's limits.
async function buildMemory(mine) {
  const build = $('mem-build');
  build.disabled = true;
  try {
    for (;;) {
      const r = await post('/memory/backfill', {});
      if (mine !== token) return;
      build.textContent = `Building… ${r.remaining} left`;
      if (r.errors?.length) $('mem-status').textContent = 'Stopped: ' + r.errors[0];
      if (!r.remaining || !r.processed) break;
    }
  } catch (e) { $('mem-status').textContent = 'Stopped: ' + e.message; }
  build.disabled = false;
  loadMemory(mine);
}

/* ---- open items, filtered to yours ---- */

let openData = [];

export function renderOpenItems() {
  const box = $('open-items');
  if (!box) return;
  const me = getMe();
  const mine = me ? openData.filter((x) => isMe(x.owner, me)) : [];
  const mode = me && store.get('items') === 'mine' ? 'mine' : 'all';
  const shown = mode === 'mine' ? mine : openData;
  $('items-filter').innerHTML = me
    ? `<button class="small chipbtn${mode === 'mine' ? ' on' : ''}" data-mode="mine">Mine (${mine.length})</button>
       <button class="small chipbtn${mode === 'all' ? ' on' : ''}" data-mode="all">Everyone (${openData.length})</button>`
    : '<a href="#" class="muted" id="set-me-link">Show only my items: set who you are in Settings</a>';
  $('items-filter').onclick = (e) => {
    if (e.target.closest('#set-me-link')) { e.preventDefault(); $('settings').click(); return; }
    const b = e.target.closest('[data-mode]');
    if (b) { store.set('items', b.dataset.mode); renderOpenItems(); }
  };
  // Group by what needs doing when. With a name set, the "Everyone" view puts other people's items under
  // "Waiting on others" instead of mixing them in with yours.
  const today = localDate();
  const mineOf = (x) => !me || !x.owner || isMe(x.owner, me);
  const groups = groupReminders(shown, today, mineOf);
  box.innerHTML = BUCKETS.filter(([k]) => groups.get(k)?.length).map(([k, label]) =>
    `<div class="bucket bucket-${k}"><div class="bucket-h">${esc(label)} <span class="muted">${groups.get(k).length}</span></div>${groups.get(k).map(itemRow).join('')}</div>`).join('')
    || `<div class="muted" style="padding:12px 0">${mode === 'mine' ? 'Nothing assigned to you.' : 'Nothing open. Action items from your recordings show up here.'}</div>`;
  // The at-a-glance row above the brief
  const all = groupReminders(openData, today, mineOf);
  const chip = (k, label, cls) => (all.get(k)?.length ? `<span class="stat ${cls}"><b>${all.get(k).length}</b> ${label}</span>` : '');
  const stats = $('today-stats');
  if (stats) stats.innerHTML = chip('overdue', 'overdue', 'bad') + chip('today', 'due today', 'warn') + chip('week', 'this week', '') + chip('slipping', 'slipping', 'warn') + chip('waiting', 'waiting on others', '');
}

/* ---- people: see everyone, merge duplicates ---- */

export function personRow(p, others) {
  const bits = [`${p.recordings} recording${p.recordings === 1 ? '' : 's'}`, `${p.voiceprint_count} voice sample${p.voiceprint_count === 1 ? '' : 's'}`];
  if (p.aliases) bits.push(`also: ${p.aliases}`);
  return `<div class="task" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
    <span class="body"><b class="pname">${esc(p.name)}</b>${isMe(p.name) ? ' <span class="pill">you</span>' : ''}
      <span class="meta"><span>${esc(bits.join(' · '))}</span></span></span>
    <button class="small rename-go" title="Correct this person's name everywhere it appears">Rename</button>
    ${others.length ? `<span class="row"><select class="merge-into" aria-label="Merge ${esc(p.name)} into"><option value="">Merge into…</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select><button class="small merge-go" disabled>Merge</button></span>` : ''}
  </div>`;
}

async function doMerge(fromId, fromName, intoId, intoName, mine) {
  if (!confirm(`Merge “${fromName}” into “${intoName}”?\n\nEvery recording, saved voice sample and remembered fact for “${fromName}” becomes “${intoName}”, and “${fromName}” is kept as an alias. This cannot be undone.`)) return;
  try {
    const r = await post('/people/merge', { from_id: fromId, into_id: intoId });
    if ($('people-list') && mine === token) {
      $('people-suggest').innerHTML = `<div class="banner" style="border-color:#2c5c42;background:#10201a;color:#b8ecd0">Merged “${esc(fromName)}” into “${esc(intoName)}” (${r.recordings_updated} recording${r.recordings_updated === 1 ? '' : 's'} updated).</div>`;
    }
    refresh();
    await loadPeople(mine, true);
    loadMemory(mine);
  } catch (e) { alert(e.message); }
}

// Rename in place: the name becomes a text box. A correction, applied to every recording, transcript and
// remembered fact. A name that already belongs to someone else is refused (that is a merge).
function startRename(row, mine) {
  const b = row.querySelector('.pname');
  if (!b || row.querySelector('.rename-in')) return;
  const old = row.dataset.name;
  b.outerHTML = `<span class="row" style="flex-wrap:nowrap;gap:6px"><input class="rename-in" value="${esc(old)}" maxlength="80" aria-label="New name for ${esc(old)}" style="min-width:180px"><button class="small primary rename-save">Save</button><button class="small rename-cancel">Cancel</button></span>`;
  const input = row.querySelector('.rename-in');
  input.focus(); input.select();
  const save = async () => {
    const name = input.value.trim();
    if (!name || name === old) return loadPeople(mine);
    try {
      const r = await api('/people/' + row.dataset.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (isMe(old)) setMe(r.name);
      refresh();
      await loadPeople(mine);
      loadMemory(mine);
    } catch (e) { alert(e.message); input.focus(); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') loadPeople(mine); };
  row.querySelector('.rename-save').onclick = save;
  row.querySelector('.rename-cancel').onclick = () => loadPeople(mine);
}

async function loadPeople(mine, keepNotice = false) {
  if (!$('people-list')) return;
  let out;
  try { out = await api('/people' + areaQuery()); } catch (e) { if (mine === token) $('people-list').innerHTML = `<div class="muted" style="padding:12px 0">Could not load people: ${esc(e.message)}</div>`; return; }
  if (mine !== token) return;
  const { people = [], suggestions = [] } = out;
  if (!keepNotice) {
    $('people-suggest').innerHTML = suggestions.map((x) => `<div class="banner" data-from="${esc(x.from_id)}" data-into="${esc(x.into_id)}" data-from-name="${esc(x.from_name)}" data-into-name="${esc(x.into_name)}" style="display:flex;gap:12px;align-items:center;justify-content:space-between">
      <span>“${esc(x.from_name)}” and “${esc(x.into_name)}” look like the same person.</span>
      <button class="small suggest-go">Merge “${esc(x.from_name)}” into “${esc(x.into_name)}”</button></div>`).join('');
  }
  $('people-list').innerHTML = people.map((p) => personRow(p, people.filter((o) => o.id !== p.id))).join('')
    || '<div class="muted" style="padding:12px 0">No one yet. People appear here when you name a speaker on a recording.</div>';
  if (typeof location !== 'undefined' && location.hash === '#people') $('people-list').scrollIntoView(); // a link straight to this section

  $('people-suggest').onclick = (e) => {
    const b = e.target.closest('.suggest-go');
    if (!b) return;
    const row = b.closest('[data-from]');
    doMerge(row.dataset.from, row.dataset.fromName, row.dataset.into, row.dataset.intoName, mine);
  };
  $('people-list').onchange = (e) => {
    const sel = e.target.closest('.merge-into');
    if (sel) sel.closest('.task').querySelector('.merge-go').disabled = !sel.value;
  };
  $('people-list').onclick = (e) => {
    const rn = e.target.closest('.rename-go');
    if (rn) return startRename(rn.closest('.task'), mine);
    const go = e.target.closest('.merge-go');
    if (!go) return;
    const row = go.closest('.task');
    const sel = row.querySelector('.merge-into');
    doMerge(row.dataset.id, row.dataset.name, sel.value, sel.options[sel.selectedIndex].text, mine);
  };
}
