// Structured memory: save/list/edit facts, and the backfill that builds memory (and the
// semantic index) for recordings made before these features existed.

import { areaClause } from '../areas.js';
import { json, fail, uid } from '../http.js';
import { readRow } from '../db.js';
import { llmFetch } from '../llm.js';
import { defaultModel, contextChars } from '../config.js';
import { parseJsonLoose } from '../text.js';
import { normalizeFacts, factsSystemPrompt, FACT_KINDS, isListedFact } from '../memory.js';
import { indexRecording, vectorsEnabled } from '../vectors.js';

const BACKFILL_PER_CALL = 2; // each recording costs ~3 subrequests; stay far inside the free plan's 50

export async function loadFacts(env, owner, recordingId) {
  return (await env.DB.prepare(
    'SELECT id, kind, person, text, quote, done FROM facts WHERE owner = ? AND recording_id = ?'
  ).bind(owner, recordingId).all()).results || [];
}

// Replace a recording's facts with `facts`, keeping a tick the user made on a commitment when
// the same text comes back. Also stamps facts_at so backfill knows it is done.
export async function saveFacts(env, owner, rec, facts) {
  const prior = await loadFacts(env, owner, rec.id);
  const done = new Set(prior.filter((f) => f.done).map((f) => `${f.kind}|${f.text.trim().toLowerCase()}`));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM facts WHERE recording_id = ? AND owner = ?').bind(rec.id, owner),
    ...facts.map((f) => env.DB.prepare(
      'INSERT INTO facts (id, owner, recording_id, kind, person, text, quote, done, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(uid(), owner, rec.id, f.kind, f.person, f.text, f.quote,
      done.has(`${f.kind}|${f.text.trim().toLowerCase()}`) ? 1 : 0, rec.created_at)),
    env.DB.prepare('UPDATE recordings SET facts_at = ? WHERE id = ? AND owner = ?').bind(Date.now(), rec.id, owner),
  ]);
}

// One standalone extraction call (for recordings summarized before facts existed).
async function extractFacts(env, rec) {
  const res = await llmFetch(env, {
    model: rec.model || defaultModel(env),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: factsSystemPrompt() },
      { role: 'user', content: `Transcript:\n\n${rec.transcript.slice(0, contextChars(env))}` },
    ],
  });
  if (!res.ok) throw new Error(`facts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const parsed = parseJsonLoose((await res.json()).choices[0].message.content);
  return normalizeFacts(parsed?.facts, rec.transcript);
}

// Brings one recording up to date: facts if missing, vectors if enabled and missing.
async function memorize(env, owner, rec) {
  let facts;
  if (!rec.facts_at) { facts = await extractFacts(env, rec); await saveFacts(env, owner, rec, facts); }
  if (vectorsEnabled(env) && rec.vec_chunks == null) {
    await indexRecording(env, owner, rec, facts || await loadFacts(env, owner, rec.id));
  }
}

// Ready recordings that still need work, newest first. Light columns only (no transcripts).
async function pending(env, owner) {
  const rows = (await env.DB.prepare(
    "SELECT id, facts_at, vec_chunks FROM recordings WHERE owner = ? AND status = 'ready' AND hidden = 0 ORDER BY created_at DESC LIMIT 2000"
  ).bind(owner).all()).results || [];
  const vec = vectorsEnabled(env);
  return {
    total: rows.length,
    todo: rows.filter((r) => !r.facts_at || (vec && r.vec_chunks == null)),
    withFacts: rows.filter((r) => r.facts_at).length,
    indexed: rows.filter((r) => r.vec_chunks != null).length,
  };
}

// POST /api/memory/backfill: process a couple of recordings, report what is left. The page
// calls it in a loop with a progress line.
export async function backfill(env, owner) {
  return json(await runBackfill(env, owner));
}

// The work itself, shared with the 15-minute cron so old recordings catch up on their own.
export async function runBackfill(env, owner) {
  const p = await pending(env, owner);
  let processed = 0;
  const errors = [];
  for (const { id } of p.todo.slice(0, BACKFILL_PER_CALL)) {
    const rec = await readRow(env, id, owner);
    if (!rec?.transcript) continue;
    try { await memorize(env, owner, rec); processed++; } catch (e) { errors.push(String(e?.message || e).slice(0, 200)); }
  }
  return { processed, remaining: Math.max(0, p.todo.length - processed), errors, vectors_enabled: vectorsEnabled(env) };
}

// GET /api/memory?person=&kind=
export async function listMemory(request, env, owner) {
  const u = new URL(request.url);
  const person = (u.searchParams.get('person') || '').trim().toLowerCase();
  const kind = u.searchParams.get('kind') || '';
  const ac = areaClause(u.searchParams.get('area'), 'r.area');
  const now = Date.now();
  const rows = ((await env.DB.prepare(
    `SELECT f.id, f.recording_id, f.kind, f.person, f.text, f.quote, f.done, f.created_at FROM facts f
       ${ac.sql ? 'JOIN recordings r ON r.id = f.recording_id' : ''} WHERE f.owner = ?${ac.sql} ORDER BY f.created_at DESC LIMIT 1000`
  ).bind(owner, ...ac.binds).all()).results || []).filter((f) => isListedFact(f, now)); // untagged and older than a week: kept and searchable, just not listed
  const titles = new Map(((await env.DB.prepare('SELECT id, title FROM recordings WHERE owner = ?').bind(owner).all()).results || [])
    .map((r) => [r.id, r.title]));
  const facts = rows
    .filter((f) => (!kind || f.kind === kind) && (!person || (f.person || '').toLowerCase().includes(person)))
    .slice(0, 100)
    .map((f) => ({ ...f, done: Boolean(f.done), title: titles.get(f.recording_id) || '' }));
  const p = await pending(env, owner);
  return json({
    facts,
    kinds: FACT_KINDS,
    people: [...new Set(rows.map((f) => f.person).filter(Boolean))].sort(),
    total_facts: rows.length,
    status: { recordings: p.total, with_facts: p.withFacts, indexed: p.indexed, remaining: p.todo.length, vectors_enabled: vectorsEnabled(env) },
  });
}

// PATCH /api/memory/:id {done}  /  DELETE /api/memory/:id
export async function patchFact(request, env, owner, id) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.done !== 'boolean') return fail('done required');
  const f = await env.DB.prepare('SELECT id FROM facts WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!f) return fail('not found', 404);
  await env.DB.prepare('UPDATE facts SET done = ? WHERE id = ? AND owner = ?').bind(body.done ? 1 : 0, id, owner).run();
  return json({ ok: true });
}

export async function deleteFact(env, owner, id) {
  const f = await env.DB.prepare('SELECT id FROM facts WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!f) return fail('not found', 404);
  await env.DB.prepare('DELETE FROM facts WHERE id = ? AND owner = ?').bind(id, owner).run();
  return json({ ok: true });
}
