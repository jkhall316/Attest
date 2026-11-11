// Boot + the only place that wires DOM events to modules.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { refresh } from './lists.js';
import { open } from './recordings.js';
import { showAsk } from './chats.js';
import { startStop, submit } from './recorder.js';
import { importPocket } from './pocket.js';
import { loadTemplates, wireTemplateDialog } from './templates.js';
import { fillSelects, wireSettings } from './settings.js';
import { showToday } from './today.js';
import { wirePalette } from './palette.js';
import { wirePersona } from './persona.js';

(async () => {
  state.META = await api('/meta');
  await loadTemplates();

  fillSelects();
  wireSettings();

  wireTemplateDialog();

  $('rec').onclick = startStop;
  $('file').onchange = (e) => e.target.files[0] && submit(e.target.files[0]);
  $('pocket').onclick = importPocket;
  $('export-all').onclick = () => location.href = '/api/export';
  $('export-zip').onclick = () => location.href = '/api/export?format=zip';

  $('list').onclick = (e) => {
    const card = e.target.closest('.card');
    if (card) open(card.dataset.id);
  };
  wirePalette();
  wirePersona();
  $('home').onclick = showToday;
  $('brand').onclick = showToday;
  $('nav-ask').onclick = showAsk;

  await refresh();
  showToday();
})();
