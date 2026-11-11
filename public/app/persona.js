// "Speaking as": the active persona, in the header. It is stored only in this browser and
// makes "I" / "me" / "my" in briefs and prompts mean you, puts your action items first on
// Today, and tags you in talk balance.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { getMe, setMe } from './me.js';
import { icon } from './icons.js';
import { initials, avatarStyle } from './format.js';
import { showToday } from './today.js';

export function renderPersona() {
  const me = getMe();
  const av = $('persona-av');
  av.textContent = me ? initials(me) : '?';
  av.setAttribute('style', me ? avatarStyle(me) : '');
  $('persona-name').textContent = me || 'Set who you are';
}

const close = () => { $('persona-pop').hidden = true; $('persona').setAttribute('aria-expanded', 'false'); };

function choose(name) {
  const was = getMe();
  setMe(name);
  renderPersona();
  close();
  if (getMe() !== was && !state.current && state.screen === 'today') showToday({ regenerate: Boolean(getMe()) });
}

async function open() {
  const pop = $('persona-pop');
  const me = getMe();
  pop.hidden = false;
  $('persona').setAttribute('aria-expanded', 'true');
  let people = [];
  try { people = (await api('/people')).people || []; } catch { /* best effort */ }
  pop.innerHTML = `
    <div class="blurb">Speaking as the person “I”, “me” and “my” mean in your briefs and prompts. It also puts your action items first on Today. Saved in this browser only.</div>
    ${people.map((p) => `<button class="opt${p.name === me ? ' on' : ''}" data-name="${esc(p.name)}"><span class="av" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span>${esc(p.name)}${p.name === me ? `<span style="margin-left:auto">${icon('check', 15)}</span>` : ''}</button>`).join('')}
    <hr>
    <div class="row" style="flex-wrap:nowrap;padding:0 4px 4px"><input id="persona-in" placeholder="Not listed? Type your name" value="${people.some((p) => p.name === me) ? '' : esc(me)}" style="flex:1"><button class="primary small" id="persona-set">Set</button></div>
    ${me ? '<button class="opt" id="persona-clear" style="margin-top:4px">Clear</button>' : ''}`;
  pop.onclick = (e) => {
    const o = e.target.closest('.opt[data-name]');
    if (o) return choose(o.dataset.name);
    if (e.target.closest('#persona-set')) return choose($('persona-in').value);
    if (e.target.closest('#persona-clear')) return choose('');
  };
  $('persona-in').onkeydown = (e) => { if (e.key === 'Enter') choose($('persona-in').value); };
}

export function wirePersona() {
  renderPersona();
  $('persona').onclick = (e) => { e.stopPropagation(); $('persona-pop').hidden ? open() : close(); };
  document.addEventListener('click', (e) => { if (!$('persona-pop').hidden && !e.target.closest('#persona-pop')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
