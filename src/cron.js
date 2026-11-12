// Scheduled background run (Cron Trigger): catch old recordings up on memory, import new
// Pocket recordings and Omi conversations, then process the ones waiting. Small fixed batches keep each tick inside the free plan's
// subrequest limit; whatever is left is picked up on the next tick.
// Rows that error are NOT retried automatically (that would re-bill OpenAI every tick);
// open the recording and press Retry.

import { importNew as importPocketNew } from './routes/pocket.js';
import { importNew as importOmiNew } from './routes/omi.js';
import { process as processRecording } from './routes/recordings.js';
import { runBackfill } from './routes/memory.js';
import { sourcesOf } from './sources.js';

const IMPORT_PER_TICK = 2;
const PROCESS_PER_TICK = 2;

export async function runScheduled(env) {
  const owner = env.OWNER_EMAIL || 'local';
  // Memory catch-up: two older recordings per tick (facts + semantic index) until none are
  // left, then it is a single cheap query. Runs with or without Pocket.
  try { await runBackfill(env, owner); }
  catch (e) { console.error('scheduled memory backfill failed:', e?.message || e); }
  const on = sourcesOf(env);
  const pocket = on.includes('pocket') && env.POCKET_API_KEY, omi = on.includes('omi') && env.OMI_API_KEY;
  if (!pocket && !omi) return;
  if (pocket) {
    try { await importPocketNew(env, owner, 3, IMPORT_PER_TICK); }
    catch (e) { console.error('scheduled pocket import failed:', e?.message || e); }
  }
  if (omi) {
    try { await importOmiNew(env, owner, 3, IMPORT_PER_TICK); }
    catch (e) { console.error('scheduled omi import failed:', e?.message || e); }
  }
  const waiting = (await env.DB.prepare(
    `SELECT id FROM recordings WHERE owner = ? AND (pocket_id IS NOT NULL OR omi_id IS NOT NULL)
        AND status IN ('uploaded', 'transcribed')
      ORDER BY created_at DESC LIMIT ?`
  ).bind(owner, PROCESS_PER_TICK).all()).results || [];
  for (const { id } of waiting) {
    try { await processRecording(env, id, owner); }
    catch (e) { console.error('scheduled process failed:', id, e?.message || e); }
  }
}
