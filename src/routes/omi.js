// Import conversations from Omi (docs.omi.me/doc/developer/api/conversations), which is also where a
// Limitless pendant ends up when it is paired with the Omi phone app.
// Pull-based for the same reason as Pocket: a webhook receiver would have to be reachable without
// Cloudflare Access. Omi's Developer API returns TRANSCRIPTS, not audio, so an imported row has no
// audio in R2 (r2_key ''), already carries Omi's transcript and speaker turns, and is saved as
// 'transcribed'; the normal /process route then skips speech-to-text and only summarizes.
// Audio comes from the Bluetooth path (ios/) instead.

import { json, fail, uid } from '../http.js';
import { anonymousSpeakers, rebuildTranscript } from '../speakers.js';

const BASE = 'https://api.omi.me/v1/dev/user';
const BATCH = 3;      // conversations fetched with transcripts per call; the client calls again while `remaining` > 0
const MAX_PAGES = 10; // x200 ids per page
const DEFAULT_DAYS = 7;
const LABELS = 'ABCDEFGHIJKL';

const omi = (env, path) =>
  fetch(BASE + path, { headers: { authorization: `Bearer ${env.OMI_API_KEY}`, accept: 'application/json' } });

const bad = (message, status) => Object.assign(new Error(message), { status });
function checkStatus(r, what) {
  if (r.status === 401) throw bad('Omi rejected that API key. Check it in Settings (the gear icon).', 502);
  if (r.status === 403) throw bad('That Omi key cannot read conversations. Create one with the conversations:read scope.', 502);
  if (r.status === 429) throw bad('Omi rate limit; try again shortly', 429);
  if (!r.ok) throw bad(`omi ${what} ${r.status}`, 502);
}

// "Speaker 0" / "SPEAKER_01" are placeholders, not names.
const PLACEHOLDER = /^\s*(speaker|spk|unknown|user)[\s_-]*\d*\s*$/i;

// Pure. Omi conversation (with transcript_segments) -> the columns an Attest row needs, or null
// when there is nothing to summarize. Speakers become A, B, C... in order of first appearance.
export function omiToRow(conv) {
  const raw = (Array.isArray(conv?.transcript_segments) ? conv.transcript_segments : [])
    .filter((s) => s && String(s.text || '').trim())
    .map((s) => ({ ...s, start: Number(s.start) || 0, end: Number(s.end) || 0 }))
    .sort((a, b) => a.start - b.start);
  if (!raw.length) return null;

  const key = (s) => (s.speaker_id != null ? `id:${s.speaker_id}` : s.speaker ? `s:${s.speaker}` : 'unknown');
  const order = [];
  const names = new Map();
  for (const s of raw) {
    const k = key(s);
    if (!order.includes(k)) order.push(k);
    const n = String(s.speaker_name || '').trim();
    if (n && !PLACEHOLDER.test(n) && !names.has(k)) names.set(k, n.slice(0, 80));
  }
  const label = (k) => LABELS[Math.min(order.indexOf(k), LABELS.length - 1)];
  const segments = raw.map((s) => ({ speaker: label(key(s)), text: String(s.text).trim(), start: s.start, end: s.end }));

  // Names Omi already knows (the user tagged the voice there) are kept, unconfirmed, with their source as evidence.
  const speakers = anonymousSpeakers(segments).map((sp) => {
    const n = names.get(order[LABELS.indexOf(sp.label)]);
    return n ? { ...sp, name: n, evidence: 'Named in Omi' } : sp;
  });
  const transcript = rebuildTranscript(segments, speakers, '');

  const started = Date.parse(conv.started_at || conv.created_at);
  const finished = Date.parse(conv.finished_at);
  const lastEnd = Math.max(...segments.map((s) => s.end));
  const duration = finished > started ? finished - started : lastEnd > 0 ? Math.round(lastEnd * 1000) : null;
  return {
    title: String(conv.structured?.title || '').trim().slice(0, 200) || 'Omi conversation',
    created_at: started || Date.parse(conv.created_at) || Date.now(),
    duration_ms: duration,
    segments, speakers, transcript,
  };
}

// Ids of recent conversations. Without transcripts Omi pages by cursor, which is cheap.
async function listRecent(env, days) {
  const start = new Date(Date.now() - days * 86400000).toISOString();
  const out = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = `?limit=200&offset=0&include_transcript=false&start_date=${encodeURIComponent(start)}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await omi(env, '/conversations' + q);
    checkStatus(r, 'list');
    const rows = await r.json();
    out.push(...(Array.isArray(rows) ? rows : []));
    cursor = r.headers.get('x-omi-next-cursor') || '';
    if (r.headers.get('x-omi-has-more') !== 'true' || !cursor) break;
  }
  return out;
}

export async function importOmi(request, env, owner) {
  if (!env.OMI_API_KEY) return fail('No Omi API key yet. Add it in Settings (the gear icon, top right).', 400);
  const body = await request.json().catch(() => ({}));
  return json(await importNew(env, owner, Number(body.days) || DEFAULT_DAYS, BATCH));
}

// Shared by the button (importOmi) and the scheduled run (src/cron.js).
export async function importNew(env, owner, daysIn = DEFAULT_DAYS, batch = BATCH) {
  const days = Math.min(Math.max(daysIn, 1), 90);
  const known = new Set(
    ((await env.DB.prepare('SELECT omi_id FROM recordings WHERE owner = ? AND omi_id IS NOT NULL')
      .bind(owner).all()).results || []).map((r) => r.omi_id)
  );
  const fresh = (await listRecent(env, days)).filter((c) => c?.id && !known.has(c.id));

  const imported = [];
  const skipped = [];
  for (const c of fresh.slice(0, batch)) {
    const r = await omi(env, `/conversations/${encodeURIComponent(c.id)}?include_transcript=true`);
    if (r.status === 404) { skipped.push({ omi_id: c.id, title: c.structured?.title, reason: 'gone from Omi' }); continue; }
    checkStatus(r, 'get');
    const row = omiToRow(await r.json());
    if (!row) { skipped.push({ omi_id: c.id, title: c.structured?.title, reason: 'no transcript' }); continue; }

    const id = uid();
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO recordings (id, owner, title, created_at, duration_ms, r2_key, content_type, status,
                                         template, omi_id, status_at, transcript, segments, speakers)
       VALUES (?,?,?,?,?,'','audio/none','transcribed','meeting',?,?,?,?,?)`
    ).bind(id, owner, row.title, row.created_at, row.duration_ms, c.id, Date.now(),
      row.transcript, JSON.stringify(row.segments), JSON.stringify(row.speakers)).run();
    if (res?.meta?.changes === 0) continue; // raced a concurrent import
    await env.DB.prepare('INSERT INTO transcript_fts (id, title, transcript) VALUES (?,?,?)').bind(id, row.title, row.transcript).run();
    imported.push({ id, title: row.title });
  }
  return { imported, skipped, remaining: Math.max(0, fresh.length - batch) };
}
