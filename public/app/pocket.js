// "Import from Pocket": the server copies new Pocket recordings into R2 a few at a
// time; this loops until none remain, then runs the normal /process on each.

import { $ } from './dom.js';
import { api } from './api.js';
import { refresh } from './lists.js';
import { open } from './recordings.js';

export async function importPocket() {
  const btn = $('pocket'), out = $('pocket-status');
  btn.disabled = true;
  const ids = [];
  const skipped = [];
  try {
    for (;;) {
      out.textContent = `Fetching from Pocket… ${ids.length} so far`;
      const r = await api('/pocket/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      ids.push(...r.imported.map((x) => x.id));
      skipped.push(...r.skipped);
      // Stop when nothing new came in, otherwise permanently skipped items loop forever.
      if (!r.imported.length || !r.remaining) break;
    }
    await refresh();
    for (let i = 0; i < ids.length; i++) {
      out.textContent = `Processing ${i + 1} of ${ids.length}… (keep this tab open)`;
      try { await api(`/recordings/${ids[i]}/process`, { method: 'POST' }); } catch { /* row shows its error */ }
      await refresh();
    }
    out.textContent = `Imported ${ids.length}` + (skipped.length ? `, skipped ${skipped.length} (${skipped[0].reason})` : '');
    if (ids.length) open(ids[0]);
  } catch (e) {
    out.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
