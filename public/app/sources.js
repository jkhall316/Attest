// The sidebar follows the sources the person chose (Settings, or setup): no buttons for devices they
// do not use. Every source that can import gets a button; with two or more there is also "Import from
// all". `sources` is /api/meta's list: [{id, label, pull, ready}].

import { $, esc } from './dom.js';
import { state } from './state.js';
import { importPocket } from './pocket.js';
import { importOmi } from './omi.js';

const IMPORTERS = {
  pocket: { label: 'Pocket', run: importPocket, tip: 'Pull new recordings from your Pocket account and process them' },
  omi: { label: 'Omi', run: importOmi, tip: 'Pull new conversations from your Omi account (transcripts) and summarize them' },
};

// Pure, so it can be tested: what the sidebar shows for a given choice of sources.
export function sidebarPlan(sources = []) {
  const has = (id) => sources.some((s) => s.id === id);
  const imports = sources.filter((s) => s.pull && IMPORTERS[s.id]);
  const ready = imports.filter((s) => s.ready);
  return {
    mic: has('mic'),
    imports: imports.map((s) => ({ id: s.id, label: IMPORTERS[s.id].label, tip: IMPORTERS[s.id].tip, ready: s.ready })),
    all: ready.length > 1,
    pendant: has('pendant'),
    empty: sources.length === 0,
  };
}

export function renderSources(sources) {
  const plan = sidebarPlan(sources);
  $('mic-block').hidden = !plan.mic;
  if ($('tab-record')) $('tab-record').hidden = !plan.mic; // no Record button on the bar if you never record in the app
  $('import-row').innerHTML = plan.imports.map((b) =>
    `<button id="${b.id}" class="small" title="${esc(b.ready ? b.tip : 'Add the key in Settings first')}"${b.ready ? '' : ' data-needs-key="1"'}>Import from ${esc(b.label)}${b.ready ? '' : ' (add key)'}</button>`).join('')
    + (plan.all ? '<button id="import-all" class="small" title="Pull from every connected source">Import from all</button>' : '');
  for (const b of plan.imports) {
    $(b.id).onclick = b.ready ? IMPORTERS[b.id].run : () => $('settings')?.click();
  }
  if (plan.all) $('import-all').onclick = importAll;
  $('source-hint').textContent = plan.empty ? 'No sources chosen. Pick yours in Settings (the gear icon).'
    : plan.pendant ? 'Pendant: recordings arrive from the Attest app on your Mac or iPhone.' : '';
}

// One after another: each importer shares the status line and does its own refresh.
export async function importAll() {
  for (const s of state.META.sources) {
    if (s.pull && s.ready && IMPORTERS[s.id]) await IMPORTERS[s.id].run();
  }
}
