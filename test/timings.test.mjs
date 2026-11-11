import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/schema.js';
import { rates, addTiming, getTimings } from '../src/timings.js';
import { planEstimate, etaText, formatLeft } from '../public/app/eta.js';

const MIN = 60000;

function d1() {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    prepare(sql) {
      const st = { args: [], bind(...a) { st.args = a; return st; },
        all: async () => ({ results: raw.prepare(sql).all(...st.args) }),
        run: async () => { raw.prepare(sql).run(...st.args); return {}; }, sql };
      return st;
    },
    async batch(stmts) { for (const s of stmts) raw.prepare(s.sql).run(...s.args); },
  };
}
const post = (body) => new Request('http://x/api/timings', { method: 'POST', body: JSON.stringify(body) });

test('rates is total work over total audio, so a long call outweighs a short one', () => {
  const r = rates([
    { stage: 'summarize', key: 'm', audio_ms: 60 * MIN, work_ms: 120 * MIN / 60 },   // 2 s per audio minute
    { stage: 'summarize', key: 'm', audio_ms: 1 * MIN, work_ms: 20000 },              // a memo that was slow
  ]);
  assert.equal(r['summarize|m'].runs, 2);
  assert.ok(Math.abs(r['summarize|m'].ms_per_min - ((120 * MIN / 60 + 20000) / 61)) < 1.5);
});

test('rates keeps stages and models apart and only averages the newest 10 runs', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ stage: 'transcribe', key: 'w', audio_ms: MIN, work_ms: 1000 });
  for (let i = 0; i < 10; i++) rows.push({ stage: 'transcribe', key: 'w', audio_ms: MIN, work_ms: 9000 }); // older, ignored
  rows.push({ stage: 'transcribe', key: 'other', audio_ms: MIN, work_ms: 5000 });
  const r = rates(rows);
  assert.equal(r['transcribe|w'].ms_per_min, 1000);
  assert.equal(r['transcribe|w'].runs, 10);
  assert.equal(r['transcribe|other'].ms_per_min, 5000);
});

test('timings endpoints store runs, ignore tiny clips and bad stages, and cap history', async () => {
  const db = d1(); await runMigrations(db);
  const env = { DB: db };
  assert.equal((await addTiming(post({ stage: 'nope', audio_ms: 5 * MIN, work_ms: 1000 }), env, 'a')).status, 400);
  assert.equal((await (await addTiming(post({ stage: 'summarize', key: 'm', audio_ms: 5000, work_ms: 1000 }), env, 'a')).json()).skipped, true);
  for (let i = 0; i < 25; i++) await addTiming(post({ stage: 'summarize', key: 'm', audio_ms: 10 * MIN, work_ms: 30000 }), env, 'a');
  assert.equal(db.raw.prepare('SELECT count(*) c FROM process_timings').get().c, 20);
  const g = await (await getTimings(env, 'a')).json();
  assert.equal(g.rates['summarize|m'].ms_per_min, 3000);
  assert.deepEqual((await (await getTimings(env, 'someone-else')).json()).rates, {});
});

test('planEstimate scales per-minute rates by the recording length; no history means no estimate', () => {
  const p = planEstimate([['transcribe', 'w'], ['summarize', 'm']], 60 * MIN,
    { 'transcribe|w': { ms_per_min: 2000, runs: 3 }, 'summarize|m': { ms_per_min: 1000, runs: 5 } });
  assert.deepEqual(p.steps.map((s) => s.ms), [120000, 60000]); // 60 audio minutes x 2 s and x 1 s
  assert.equal(p.known, true);
  assert.equal(planEstimate([['summarize', 'x']], 60 * MIN, {}).known, false);
});

test('etaText counts down, admits overruns, and stays honest without history', () => {
  const plan = planEstimate([['transcribe', 'w'], ['summarize', 'm']], 10 * MIN,
    { 'transcribe|w': { ms_per_min: 6000, runs: 3 }, 'summarize|m': { ms_per_min: 3000, runs: 1 } }); // 60 s + 30 s
  assert.match(etaText(plan, 0, 0), /about 2 min left \(from your last 1 run\)/);
  assert.match(etaText(plan, 1, 10000), /under a minute left/);
  assert.match(etaText(plan, 0, 5 * MIN), /longer than usual/);
  assert.match(etaText(planEstimate([['summarize', 'm']], 10 * MIN, {}), 0, 0), /No time estimate yet/);
  assert.equal(formatLeft(3 * 3600000 + 5 * MIN), 'about 3 h 5 min');
});
