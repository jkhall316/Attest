// One export endpoint, four formats (#8): md (default), html (print -> PDF),
// docx (single recording), zip (every recording as .docx in one archive).

import { docx } from '../docx.js';
import { zip } from '../zip.js';
import { readRow } from '../db.js';
import { fail } from '../http.js';
import { listTemplates } from './templates.js';
import { safeParse, recordingToMarkdown, recordingToHtml, safeFilename } from '../text.js';

export async function exportAll(env, owner, id, format) {
  const rows = id
    ? [(await readRow(env, id, owner))].filter(Boolean)
    : (await env.DB.prepare(
        "SELECT * FROM recordings WHERE owner = ? AND status = 'ready' ORDER BY created_at"
      ).bind(owner).all()).results.map((r) => ({ ...r, action_items: safeParse(r.action_items) }));
  if (!rows.length) return fail('nothing to export', 404);
  // html and docx are single-document formats; without an id they used to silently
  // return only the oldest recording.
  if (!id && (format === 'html' || format === 'docx')) return fail(`format=${format} needs an id`);

  // Resolved once so custom templates export their real label, not their slug key.
  const labels = await listTemplates(env, owner);

  if (format === 'html') {
    return new Response(recordingToHtml(rows[0], labels), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  if (format === 'docx') {
    return new Response(docx(rows[0], labels), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-disposition': `attachment; filename="${safeFilename(rows[0].title)}.docx"`,
      },
    });
  }

  if (format === 'zip') {
    const files = rows.map((r) => ({ name: `${safeFilename(r.title)}.docx`, data: docx(r, labels) }));
    return new Response(zip(files), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="attest-export.zip"',
      },
    });
  }

  return new Response(rows.map((r) => recordingToMarkdown(r, labels)).join('\n\n---\n\n'), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${id ? 'recording' : 'attest-export'}.md"`,
    },
  });
}
