// How long processing takes on THIS machine and model, learned from past runs, so the app can
// say "about 6 minutes left". The browser reports each finished stage (audio length, time it
// took); the estimate is the running average of work-time per audio-minute over the latest runs
// of the same stage and model, weighted by length (total time over total minutes), so one long
// call counts for more than a ten-second memo.

import { json, fail } from './http.js';

export const STAGES = ['transcribe', 'diarize', 'match', 'summarize', 'full'];
const KEEP = 20;     // runs kept per (stage, key)
const WINDOW = 10;   // runs averaged
const MIN_AUDIO_MS = 30_000; // a few seconds of audio says nothing about a rate (fixed overheads dominate)

// rows: [{stage, key, audio_ms, work_ms}] newest first. -> {"stage|key": {ms_per_min, runs}}
export function rates(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.stage}|${r.key || ''}`;
    if (!by.has(k)) by.set(k, []);
    if (by.get(k).length < WINDOW) by.get(k).push(r);
  }
  const out = {};
  for (const [k, list] of by) {
    const audio = list.reduce((a, r) => a + r.audio_ms, 0);
    const work = list.reduce((a, r) => a + r.work_ms, 0);
    if (audio > 0) out[k] = { ms_per_min: Math.round((work / audio) * 60000), runs: list.length };
  }
  return out;
}

export async function getTimings(env, owner) {
  const rows = (await env.DB.prepare(
    'SELECT stage, key, audio_ms, work_ms FROM process_timings WHERE owner = ? ORDER BY at DESC, id DESC LIMIT 400'
  ).bind(owner).all()).results || [];
  return json({ rates: rates(rows) });
}

export async function addTiming(request, env, owner) {
  const b = await request.json().catch(() => null);
  const audio = Number(b?.audio_ms), work = Number(b?.work_ms), key = String(b?.key || '').slice(0, 120);
  if (!b || !STAGES.includes(b.stage)) return fail('unknown stage');
  if (!Number.isFinite(audio) || !Number.isFinite(work) || work <= 0 || audio < MIN_AUDIO_MS) return json({ ok: true, skipped: true });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO process_timings (owner, stage, key, audio_ms, work_ms, at) VALUES (?,?,?,?,?,?)')
      .bind(owner, b.stage, key, Math.round(audio), Math.round(work), Date.now()),
    env.DB.prepare(
      `DELETE FROM process_timings WHERE owner = ? AND stage = ? AND key = ? AND id NOT IN
         (SELECT id FROM process_timings WHERE owner = ? AND stage = ? AND key = ? ORDER BY at DESC, id DESC LIMIT ?)`
    ).bind(owner, b.stage, key, owner, b.stage, key, KEEP),
  ]);
  return json({ ok: true });
}
