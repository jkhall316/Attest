// The Today screen: open action items (overdue / slipping first), cached auto briefs, and
// the one endpoint every prefilled prompt runs through.

import { json, fail } from '../http.js';
import { areaClause, normalizeArea } from '../areas.js';
import { VISIBLE } from '../conversations.js';
import { isListedFact } from '../memory.js';
import { defaultModel } from '../config.js';
import { llmFetch } from '../llm.js';
import { safeParse } from '../text.js';
import {
  DAY, AUTO_PROMPTS, validDate, weekStart, openItems, buildContext, insightSystem, groundTruth, isMeName,
} from '../insights.js';

const MAX_PROMPT = 1500;
const MAX_NAME = 80;
export const ACK_TTL = 7 * DAY; // acknowledged brief items come back (if still true) after a week

// Drops expired acknowledgements and returns the live ones, newest first.
async function liveAcks(env, owner) {
  await env.DB.prepare('DELETE FROM brief_acks WHERE owner = ? AND created_at < ?').bind(owner, Date.now() - ACK_TTL).run();
  return ((await env.DB.prepare('SELECT key FROM brief_acks WHERE owner = ? ORDER BY created_at DESC LIMIT 40').bind(owner).all()).results || []).map((r) => r.key);
}

// Ready recordings, newest first, with the JSON columns parsed.
async function readyRows(env, owner, limit = 200, area = '') {
  const ac = areaClause(area);
  const rows = (await env.DB.prepare(
    `SELECT id, title, created_at, summary, transcript, action_items, speakers, unanswered
       FROM recordings WHERE owner = ? AND status = 'ready'${VISIBLE}${ac.sql} ORDER BY created_at DESC LIMIT ${limit}`
  ).bind(owner, ...ac.binds).all()).results || [];
  // Facts ride along so the model can read a few lines per recording instead of transcript.
  const facts = (await env.DB.prepare(
    'SELECT recording_id, kind, person, text, quote, done, created_at FROM facts WHERE owner = ? ORDER BY created_at DESC LIMIT 800'
  ).bind(owner).all()).results || [];
  const byRec = new Map();
  const ids = new Set(rows.map((r) => r.id));
  const now = Date.now();
  // facts about unnamed speakers older than a week are not highlighted (they stay stored and searchable)
  for (const f of facts) { if (!ids.has(f.recording_id) || !isListedFact(f, now)) continue; if (!byRec.has(f.recording_id)) byRec.set(f.recording_id, []); byRec.get(f.recording_id).push(f); }
  return rows.map((r) => ({
    ...r,
    facts: byRec.get(r.id) || [],
    action_items: safeParse(r.action_items) || [],
    speakers: safeParse(r.speakers) || [],
    unanswered: safeParse(r.unanswered) || [],
  }));
}

// Briefs are cached per area as well as per day/week: the unfiltered one keeps its plain key.
const periodKey = (period, area) => (normalizeArea(area) ? `${period}|${normalizeArea(area)}` : period);

async function cachedBrief(env, owner, kind, period) {
  const row = await env.DB.prepare('SELECT content, created_at FROM briefs WHERE owner = ? AND kind = ? AND period = ?')
    .bind(owner, kind, period).first();
  return row ? { content: row.content, created_at: row.created_at } : null;
}

// The shared engine: a time window of the owner's recordings + one instruction -> markdown.
// No recordings in the window means no model call (and nothing to cache).
export async function runInsight(env, owner, { prompt, person, days, date, me, deep, handled, area, ground }) {
  const since = Date.now() - days * DAY;
  const rows = await readyRows(env, owner, deep ? 120 : 80, area);
  const { text, sources } = buildContext(rows, { since, person, deep, question: prompt });
  if (!sources.length) {
    return { answer: `No finished recordings${person ? ` involving ${person}` : ''} in the last ${days} day${days === 1 ? '' : 's'}.`, sources: [], empty: true };
  }
  let personNotes = '';
  if (person) {
    const p = await env.DB.prepare('SELECT notes FROM people WHERE owner = ? AND name = ?').bind(owner, person).first();
    personNotes = (p?.notes || '').slice(0, 500);
  }
  const res = await llmFetch(env, {
    model: defaultModel(env),
    messages: [
      { role: 'system', content: insightSystem({ today: date, me, personNotes, handled }) },
      { role: 'user', content: `${text}\n\n${ground ? groundTruth(openItems(rows, date), date, me, isMeName) + '\n\n' : ''}${person ? `Focus on: ${person}\n` : ''}Request: ${prompt}` },
    ],
  });
  if (!res.ok) throw new Error(`insight ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { answer: (await res.json()).choices[0].message.content, sources, empty: false };
}

function cleanName(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= MAX_NAME ? s : '';
}

// GET /api/today?date=YYYY-MM-DD
export async function today(request, env, owner) {
  const date = validDate(new URL(request.url).searchParams.get('date'));
  if (!date) return fail('date=YYYY-MM-DD required');
  const area = normalizeArea(new URL(request.url).searchParams.get('area'));
  const rows = await readyRows(env, owner, 200, area);
  const items = openItems(rows, date);
  const newest = rows[0]?.created_at || 0;
  const wk = weekStart(date);
  const decorate = (b) => (b ? { ...b, stale: newest > b.created_at } : null);
  const people = (await env.DB.prepare('SELECT id, name FROM people WHERE owner = ? ORDER BY name').bind(owner).all()).results || [];
  return json({
    date, week_start: wk,
    open_count: items.length,
    overdue_count: items.filter((x) => x.overdue).length,
    slipping_count: items.filter((x) => x.slipping).length,
    open: items.slice(0, 60),
    area,
    brief: decorate(await cachedBrief(env, owner, 'today', periodKey(date, area))),
    weekly: decorate(await cachedBrief(env, owner, 'weekly', periodKey(wk, area))),
    has_recordings: rows.length > 0,
    people,
    acks: await liveAcks(env, owner),
  });
}

// POST /api/today/ack {key}: hide one brief item. DELETE /api/today/ack: bring them all back.
export async function ackBrief(request, env, owner) {
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM brief_acks WHERE owner = ?').bind(owner).run();
    return json({ ok: true });
  }
  const body = await request.json().catch(() => null);
  const key = typeof body?.key === 'string' ? body.key.trim().slice(0, 300) : '';
  if (!key) return fail('key required');
  await env.DB.prepare('DELETE FROM brief_acks WHERE owner = ? AND created_at < ?').bind(owner, Date.now() - ACK_TTL).run();
  await env.DB.prepare('INSERT OR IGNORE INTO brief_acks (owner, key, created_at) VALUES (?,?,?)').bind(owner, key, Date.now()).run();
  return json({ ok: true });
}

// POST /api/today/brief {kind:'today'|'weekly', date, me?, force?}: generate (or return the
// cached) auto brief. Cached per day / per Monday-based week, so opening the app twice
// costs one call. An empty window is not cached.
export async function brief(request, env, owner) {
  const body = await request.json().catch(() => null);
  const date = validDate(body?.date);
  const kind = body?.kind;
  if (!date || !AUTO_PROMPTS[kind]) return fail('kind (today|weekly) and date required');
  const area = normalizeArea(body.area);
  const period = periodKey(kind === 'weekly' ? weekStart(date) : date, area);
  if (!body.force) {
    const hit = await cachedBrief(env, owner, kind, period);
    if (hit) {
      const newest = (await readyRows(env, owner, 1, area))[0]?.created_at || 0;
      if (newest <= hit.created_at) return json({ ...hit, stale: false, cached: true });
    }
  }
  let out;
  try {
    out = await runInsight(env, owner, { ...AUTO_PROMPTS[kind], date, area, me: cleanName(body.me), handled: await liveAcks(env, owner) });
  } catch (e) {
    return fail(String(e?.message || e).slice(0, 300), 502);
  }
  if (out.empty) return json({ content: out.answer, created_at: Date.now(), stale: false, empty: true });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM briefs WHERE owner = ? AND kind = ? AND period = ?').bind(owner, kind, period),
    env.DB.prepare('INSERT INTO briefs (owner, kind, period, content, created_at) VALUES (?,?,?,?,?)')
      .bind(owner, kind, period, out.answer, now),
  ]);
  return json({ content: out.answer, created_at: now, stale: false, sources: out.sources });
}

// POST /api/insight {prompt, person?, days?, date, me?, deep?}: any prefilled (or edited) prompt.
export async function insight(request, env, owner) {
  const body = await request.json().catch(() => null);
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const date = validDate(body?.date);
  if (!prompt || prompt.length > MAX_PROMPT) return fail(`prompt required (max ${MAX_PROMPT} characters)`);
  if (!date) return fail('date=YYYY-MM-DD required');
  const days = Math.min(60, Math.max(1, Math.floor(Number(body.days)) || 14));
  try {
    return json(await runInsight(env, owner, {
      prompt, date, days, area: normalizeArea(body.area), person: cleanName(body.person), me: cleanName(body.me), deep: body.deep === true,
    }));
  } catch (e) {
    return fail(String(e?.message || e).slice(0, 300), 502);
  }
}
