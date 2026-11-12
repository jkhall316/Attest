// "Import from Omi": the server copies new Omi conversations in (transcripts only) a few at a
// time; this loops until none remain, then runs the normal /process on each, which summarizes
// from the imported transcript. Progress shows in the same status line as Pocket.

import { $ } from './dom.js';
import { api } from './api.js';
import { refresh } from './lists.js';
import { open } from './recordings.js';

export async function importOmi() {
  const btn = $('omi'), out = $('pocket-status');
  btn.disabled = true;
  const ids = [];
  const skipped = [];
  try {
    for (;;) {
      out.textContent = `Fetching from Omi… ${ids.length} so far`;
      const r = await api('/omi/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      ids.push(...r.imported.map((x) => x.id));
      skipped.push(...r.skipped);
      // Stop when nothing new came in, otherwise permanently skipped items loop forever.
      if (!r.imported.length || !r.remaining) break;
    }
    await refresh();
    for (let i = 0; i < ids.length; i++) {
      out.textContent = `Summarizing ${i + 1} of ${ids.length}… (keep this tab open)`;
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
