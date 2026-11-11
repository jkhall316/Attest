// "About N min left" for processing a recording, from how long the same steps took before on
// this machine and model (the server keeps the running average: src/timings.js). With no
// history for a step there is no honest estimate, so none is shown for it.

import { api } from './api.js';

// stages: [[stage, key], ...] in order. rates: {"stage|key": {ms_per_min, runs}}.
export function planEstimate(stages, audioMs, rates) {
  const mins = (audioMs || 0) / 60000;
  const steps = stages.map(([stage, key]) => {
    const r = rates?.[`${stage}|${key || ''}`];
    return { stage, key, ms: r && mins > 0 ? Math.round(r.ms_per_min * mins) : null, runs: r?.runs || 0 };
  });
  return { steps, known: steps.every((s) => s.ms != null) };
}

export function formatLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min`;
  return `about ${Math.floor(m / 60)} h ${m % 60} min`;
}

// What to say right now: `index` is the step in progress, `elapsedMs` how long it has run.
export function etaText(plan, index, elapsedMs) {
  if (!plan.known) return plan.steps.some((s) => s.ms != null) ? '' : 'No time estimate yet: this run teaches the next one.';
  const cur = plan.steps[index];
  const later = plan.steps.slice(index + 1).reduce((a, s) => a + s.ms, 0);
  const curLeft = cur.ms - elapsedMs;
  const runs = Math.min(...plan.steps.map((s) => s.runs));
  const basis = `from your last ${runs} run${runs === 1 ? '' : 's'}`;
  if (curLeft <= 0) return `Taking a little longer than usual. About ${formatLeft(later)} more after this step (${basis}).`;
  return `${formatLeft(curLeft + later)} left (${basis}).`;
}

export async function loadRates() {
  try { return (await api('/timings')).rates || {}; } catch { return {}; }
}

export const reportTiming = (stage, key, audioMs, workMs) =>
  api('/timings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage, key, audio_ms: audioMs, work_ms: workMs }) }).catch(() => {});
