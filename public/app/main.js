// Boot + the only place that wires DOM events to modules.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { refresh } from './lists.js';
import { open } from './recordings.js';
import { showAsk } from './chats.js';
import { startStop, submit } from './recorder.js';
import { renderSources } from './sources.js';
import { wireTabbar } from './tabbar.js';
import { loadTemplates, wireTemplateDialog } from './templates.js';
import { fillSelects, wireSettings } from './settings.js';
import { showToday } from './today.js';
import { wirePalette } from './palette.js';
import { wirePersona } from './persona.js';
import { wireScope, areaQuery } from './scope.js';

(async () => {
  state.META = await api('/meta');
  await loadTemplates();

  fillSelects();
  wireSettings();

  wireTemplateDialog();

  $('rec').onclick = startStop;
  $('file').onchange = (e) => e.target.files[0] && submit(e.target.files[0]);
  renderSources(state.META.sources);
  $('export-all').onclick = () => location.href = '/api/export' + areaQuery();
  $('export-zip').onclick = () => location.href = '/api/export?format=zip' + areaQuery('&');

  $('list').onclick = (e) => {
    const card = e.target.closest('.card');
    if (card) open(card.dataset.id);
  };
  wirePalette();
  wirePersona();
  // Changing the area reloads the sidebar and whichever top-level screen is showing. A recording
  // that is open stays open (it belongs to whatever area it is in).
  wireScope(async () => {
    await refresh();
    if (state.current) return;
    if (state.screen === 'ask') showAsk(); else showToday();
  });
  $('home').onclick = showToday;
  $('brand').onclick = showToday;
  $('nav-ask').onclick = showAsk;
  wireTabbar();
  wireSideToggle();

  await refresh();
  showToday();
})();

// Desktop: collapse the sidebar to give a recording the full width. Remembered per browser.
function wireSideToggle() {
  const btn = $('side-toggle');
  if (!btn) return;
  const KEY = 'attest.side';
  const apply = (collapsed) => {
    document.body.classList?.toggle('side-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = btn.ariaLabel = collapsed ? 'Show sidebar' : 'Collapse sidebar';
  };
  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch { /* private window */ }
  apply(saved === 'collapsed');
  btn.onclick = () => {
    const collapsed = !document.body.classList?.contains('side-collapsed');
    apply(collapsed);
    try { localStorage.setItem(KEY, collapsed ? 'collapsed' : ''); } catch { /* private window */ }
  };
}
