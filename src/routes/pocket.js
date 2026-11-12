// Import recordings from a Pocket device/app (docs.heypocketai.com/docs/api).
// Pull-based on purpose: a webhook receiver would have to be reachable without
// Cloudflare Access, which would punch a hole in the single-user auth model.
// Pocket records on the device and syncs through its phone app; this copies the AUDIO
// into R2 so Attest's own diarize -> summarize pipeline runs on it (the client then calls
// the normal /process route for each imported row).

import { maxUpload } from '../config.js';
import { json, fail, uid } from '../http.js';
import { consolidate } from './reshape.js';

const BASE = 'https://public.heypocketai.com/api/v1/public';
// Each import downloads whole audio files into Worker memory, so keep a call small and
// let the client call again while `remaining` > 0.
const BATCH = 3;
const MAX_PAGES = 5; // x100 per page
const DEFAULT_DAYS = 7;

const pocket = (env, path) =>
  fetch(BASE + path, { headers: { authorization: `Bearer ${env.POCKET_API_KEY}` } });

// The audio-url docs do not name the field that holds the URL, so accept a bare string
// or the first http(s) string value in an object.
export function extractUrl(data) {
  if (typeof data === 'string') return /^https?:\/\//.test(data) ? data : null;
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      const u = extractUrl(v);
      if (u) return u;
    }
  }
  return null;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function listRecent(env, days) {
  const start = isoDay(Date.now() - days * 86400000);
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await pocket(env, `/recordings?start_date=${start}&page=${page}&limit=100`);
    if (r.status === 401) throw Object.assign(new Error('Pocket rejected that API key. Check it in Settings (the gear icon).'), { status: 502 });
    if (r.status === 429) throw Object.assign(new Error('Pocket rate limit; try again shortly'), { status: 429 });
    if (!r.ok) throw Object.assign(new Error(`pocket list ${r.status}`), { status: 502 });
    const j = await r.json();
    out.push(...(j.data || []));
    if (!j.pagination?.has_more) break;
  }
  return out;
}

async function fetchAudio(env, rec) {
  const u = await pocket(env, `/recordings/${encodeURIComponent(rec.id)}/audio-url?expires_in=600`);
  if (u.status === 404) return { skip: 'no audio available yet' };
  if (!u.ok) return { skip: `audio-url ${u.status}` };
  const url = extractUrl((await u.json()).data);
  if (!url) return { skip: 'audio-url response had no URL' };
  // Pre-signed S3 URL: no Authorization header, the signature is in the query string.
  const a = await fetch(url);
  if (!a.ok) return { skip: `audio download ${a.status}` };
  const cap = maxUpload(env);
  if (Number(a.headers.get('content-length')) > cap)
    return { skip: `audio over ${cap / 1048576}MB (upload limit)` };
  const buf = await a.arrayBuffer();
  if (buf.byteLength > cap) return { skip: `audio over ${cap / 1048576}MB (upload limit)` };
  const type = (a.headers.get('content-type') || '').split(';')[0].trim();
  return { buf, type: type.startsWith('audio/') ? type : 'audio/mpeg' };
}

export async function importPocket(request, env, owner) {
  if (!env.POCKET_API_KEY) return fail('No Pocket API key yet. Add it in Settings (the gear icon, top right).', 400);
  const body = await request.json().catch(() => ({}));
  return json(await importNew(env, owner, Number(body.days) || DEFAULT_DAYS, BATCH));
}

// Shared by the button (importPocket) and the scheduled run (src/cron.js).
export async function importNew(env, owner, daysIn = DEFAULT_DAYS, batch = BATCH) {
  const days = Math.min(Math.max(daysIn, 1), 90);

  const known = new Set(
    ((await env.DB.prepare('SELECT pocket_id FROM recordings WHERE owner = ? AND pocket_id IS NOT NULL')
      .bind(owner).all()).results || []).map((r) => r.pocket_id)
  );
  const fresh = (await listRecent(env, days)).filter((r) => r?.id && !known.has(r.id));

  const imported = [];
  const skipped = [];
  for (const rec of fresh.slice(0, batch)) {
    const got = await fetchAudio(env, rec);
    if (got.skip) { skipped.push({ pocket_id: rec.id, title: rec.title, reason: got.skip }); continue; }

    const id = uid();
    const key = `rec/${id}`;
    await env.AUDIO.put(key, got.buf, { httpMetadata: { contentType: got.type } });
    const created = Date.parse(rec.recording_at || rec.created_at) || Date.now();
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO recordings (id, owner, title, created_at, duration_ms, r2_key,
                                         content_type, status, template, pocket_id, status_at, src)
       VALUES (?,?,?,?,?,?,?,'uploaded','meeting',?,?,'pocket')`
    ).bind(
      id, owner, String(rec.title || '').trim() || 'Pocket recording', created,
      Number(rec.duration) > 0 ? Math.round(Number(rec.duration) * 1000) : null,
      key, got.type, rec.id, Date.now(),
    ).run();
    if (res?.meta?.changes === 0) { await env.AUDIO.delete(key); continue; } // raced a concurrent import
    imported.push({ id, title: rec.title || 'Pocket recording' });
  }
  // Skipped rows stay "fresh" until they succeed, so only count the ones not attempted.
  const remaining = Math.max(0, fresh.length - batch);
  // Pocket chops long calls into recordings of its own choosing: join the ones that are one call.
  try {
    const moved = await consolidate(env, owner);
    if (moved.size) {
      const seen = new Set();
      const next = [];
      for (const r of imported) {
        const id = moved.get(r.id) || r.id;
        if (!seen.has(id)) { seen.add(id); next.push({ ...r, id }); }
      }
      imported.splice(0, imported.length, ...next);
    }
  } catch (e) { console.error('merge after Pocket import failed:', e?.message || e); }
  return { imported, skipped, remaining };
}
