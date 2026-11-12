// Phone layout: a small bottom tab bar (Home, Ask, Record, Recordings, Settings) in place of the
// sidebar-on-top. It only decides which pane is showing (body[data-tab], styled in app.css) and
// forwards to the existing screens, so desktop is untouched and there is one set of screens.

import { $ } from './dom.js';
import { icon } from './icons.js';
import { showToday } from './today.js';
import { showAsk } from './chats.js';

const bar = () => $('tabbar');

export function setTab(name) {
  document.body.dataset.tab = name;
  bar()?.querySelectorAll('button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
}

export function wireTabbar() {
  const b = bar();
  if (!b) return;
  b.querySelectorAll('.tab-ic').forEach((el) => { el.innerHTML = icon(el.dataset.icon, 22); });
  const go = {
    home: () => { setTab('home'); showToday(); },
    ask: () => { setTab('ask'); showAsk(); },
    recordings: () => setTab('recordings'),
    settings: () => $('settings').click(),
    // Recording happens from the Recordings pane (the timer and live transcript live there).
    record: () => { setTab('recordings'); $('rec').click(); },
  };
  b.onclick = (e) => { const t = e.target.closest('button[data-tab]'); if (t) go[t.dataset.tab]?.(); };
  // Opening a recording from the list shows it full-screen.
  $('list').addEventListener('click', (e) => { if (e.target.closest('.card')) setTab('detail'); }, true);
  // Mirror the Today badge, and the red state while recording.
  new MutationObserver(() => { $('tab-badge').textContent = $('badge').textContent; })
    .observe($('badge'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => $('tab-record').classList.toggle('on', $('rec').classList.contains('on')))
    .observe($('rec'), { attributes: true, attributeFilter: ['class'] });
  setTab('home');
}
