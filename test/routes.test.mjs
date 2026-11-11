// Router wiring smoke tests. The fake DB/R2 below match on SQL substrings and
// return canned rows — enough to prove dispatch order, auth scoping and error
// shapes. It deliberately does NOT re-test SQL behaviour.
import { MIGRATIONS } from '../src/schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { encodeWav } from '../src/testing.js';

// A small in-memory SQL fake. It parses just enough of the statements this app issues
// (simple `col = ?` / `col = 'lit'` / `col != ...` WHERE conjunctions, INSERT, UPDATE,
// DELETE) to apply them to real rows, so owner scoping is enforced by the SQL under test
// rather than hard-coded in the fake. Any SELECT/UPDATE/DELETE against an owned table
// whose WHERE lacks `owner = ?` is recorded in `violations` -- tests assert it stays empty.
// Anything it does not understand throws, so unsupported SQL is loud, not silently empty.
const OWNED = new Set(['recordings', 'chats', 'people', 'voiceprints', 'custom_templates', 'briefs', 'brief_acks', 'facts']);

function splitTop(str, isSep) {
  const parts = []; let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'") inStr = !inStr;
    if (!inStr) { if (c === '(') depth++; if (c === ')') depth--; }
    const sepLen = !inStr && depth === 0 ? isSep(str, i) : 0;
    if (sepLen) { parts.push(cur); cur = ''; i += sepLen - 1; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}
const byComma = (str, i) => (str[i] === ',' ? 1 : 0);
const byAnd = (str, i) => (/^\s+AND\s+/i.exec(str.slice(i))?.[0].length || 0);
const countQ = (str) => (str.match(/\?/g) || []).length;
const lit = (tok, args) => {
  if (tok === '?') return args.shift();
  if (/^null$/i.test(tok)) return null;
  const m = tok.match(/^'(.*)'$/);
  if (m) return m[1];
  if (!Number.isNaN(Number(tok))) return Number(tok);
  throw new Error(`fake D1: unsupported value ${tok}`);
};

function whereOf(sql) {
  const m = sql.match(/\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bGROUP BY\b|\bLIMIT\b|$)/i);
  return m ? m[1].trim() : '';
}

function matcher(where, args) {
  const conds = where ? splitTop(where, byAnd) : [];
  const tests = conds.map((cond) => {
    const c = cond.replace(/^\((.*)\)$/s, '$1').trim();
    let m;
    if ((m = c.match(/^status != 'processing' OR coalesce\(status_at, created_at\) < \?$/))) {
      const v = args.shift();
      return (r) => r.status !== 'processing' || (r.status_at ?? r.created_at) < v;
    }
    if ((m = c.match(/^(?:\w+\.)?(\w+)\s*=\s*\?$/))) { const v = args.shift(); return (r) => r[m[1]] === v; }
    if ((m = c.match(/^(?:\w+\.)?(\w+)\s*!=\s*\?$/))) { const v = args.shift(); return (r) => r[m[1]] !== v; }
    if ((m = c.match(/^(?:\w+\.)?(\w+)\s*=\s*'([^']*)'$/))) return (r) => r[m[1]] === m[2];
    if ((m = c.match(/^(?:\w+\.)?(\w+)\s*!=\s*'([^']*)'$/))) return (r) => r[m[1]] !== m[2];
    throw new Error(`fake D1: unsupported condition: ${cond}`);
  });
  return (r) => tests.every((t) => t(r));
}

function fakeEnv({
  recordings = [], chats = [], messages = [], people = [], voiceprints = [], templates = [], facts = [],
  audio = {},
} = {}) {
  const store = {
    recordings, chats, chat_messages: messages, people, voiceprints, custom_templates: templates, settings: [], briefs: [], brief_acks: [], facts,
  };
  const violations = [];
  const toBuf = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));

  function exec(sql, args) {
    args = [...args];
    const op = sql.trim().split(/\s+/)[0].toUpperCase();
    const joined = /\bJOIN\b/i.test(sql);

    // Migration runner: pretend every migration is already applied.
    if (/schema_migrations/i.test(sql)) return { rows: MIGRATIONS.map((m) => ({ id: m.id })), changes: 0 };
    if (op === 'CREATE') return { rows: [], changes: 0 };

    if (op === 'INSERT') {
      const m = sql.match(/INSERT (?:OR IGNORE )?INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(?:ON CONFLICT|$)/i);
      const table = m[1];
      if (table === 'transcript_fts') return { rows: [], changes: 1 };
      const cols = m[2].split(',').map((c) => c.trim());
      const vals = splitTop(m[3], byComma).map((t) => lit(t, args));
      const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
      if (table === 'people' && store.people.some((p) => p.owner === row.owner && p.name === row.name)) {
        return { rows: [], changes: 0 };
      }
      store[table].push(row);
      return { rows: [], changes: 1 };
    }

    if (/FROM transcript_fts/i.test(sql) && op !== 'DELETE') return { rows: [], changes: 0 };
    if (op === 'DELETE' && /FROM transcript_fts/i.test(sql)) return { rows: [], changes: 0 };

    const table = (sql.match(/(?:FROM|UPDATE)\s+(\w+)/i) || [])[1];
    if (/COUNT\(\*\) AS count FROM voiceprints/i.test(sql)) {
      const [person, owner] = args;
      return { rows: [{ count: store.voiceprints.filter((v) => v.person_id === person && v.owner === owner).length }], changes: 0 };
    }
    if (/FROM chats c LEFT JOIN/i.test(sql)) {
      return { rows: store.chats.filter((c) => c.owner === args[0]).map((c) => ({ ...c, message_count: 0 })), changes: 0 };
    }
    if (/FROM people LEFT JOIN voiceprints/i.test(sql)) {
      return { rows: store.people.filter((p) => p.owner === args[0])
        .map((p) => ({ ...p, voiceprint_count: store.voiceprints.filter((v) => v.person_id === p.id && v.owner === p.owner).length })), changes: 0 };
    }
    if (/FROM voiceprints JOIN people/i.test(sql)) {
      const [owner, , model] = args;
      const rows = store.voiceprints
        .filter((v) => v.owner === owner && (model === undefined || v.embedding_model === model))
        .map((v) => ({ ...v, name: store.people.find((p) => p.id === v.person_id && p.owner === owner)?.name }))
        .filter((v) => v.name);
      return { rows, changes: 0 };
    }
    if (joined) return { rows: [], changes: 0 };
    if (!(table in store)) throw new Error(`fake D1: unknown table ${table} in: ${sql}`);

    const where = whereOf(sql);
    if (OWNED.has(table) && !/\bowner\s*=\s*\?/.test(where)) violations.push(sql.replace(/\s+/g, ' ').trim());

    if (op === 'UPDATE') {
      const setSql = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)[1];
      const assigns = splitTop(setSql, byComma).map((a) => {
        const k = a.indexOf('=');
        return [a.slice(0, k).trim(), a.slice(k + 1).trim()];
      });
      const sets = [];
      for (const [col, expr] of assigns) {
        if (col === 'live_transcript' && /substr/i.test(expr)) {
          const text = args.shift(); args.shift();
          sets.push([col, (prev) => (prev ? `${prev} ${text}` : text).slice(-20000)]);
        } else if (/[()+*]/.test(expr)) {
          for (let n = countQ(expr); n > 0; n--) args.shift(); // computed columns (tokens, ...) are not asserted
        } else {
          const v = lit(expr, args);
          sets.push([col, () => v]);
        }
      }
      const hit = store[table].filter(matcher(where, args));
      for (const r of hit) for (const [col, f] of sets) r[col] = f(r[col]);
      return { rows: [], changes: hit.length };
    }

    const hit = store[table].filter(matcher(where, args));
    if (op === 'DELETE') {
      for (const r of hit) store[table].splice(store[table].indexOf(r), 1);
      return { rows: [], changes: hit.length };
    }
    return { rows: hit.map((r) => ({ ...r })), changes: 0 };
  }

  const env = {
    DB: {
      prepare(sql) {
        const stmt = {
          args: [],
          bind(...a) { stmt.args = a; return stmt; },
          first: async () => exec(sql, stmt.args).rows[0] ?? null,
          all: async () => ({ results: exec(sql, stmt.args).rows }),
          run: async () => ({ success: true, meta: { changes: exec(sql, stmt.args).changes } }),
        };
        return stmt;
      },
      batch: async (stmts) => { for (const s of stmts) await s.run(); return []; },
    },
    AUDIO: {
      put: async (k, v) => { audio[k] = v; },
      get: async (k, opts) => (audio[k] == null ? null : {
        body: opts?.range ? toBuf(audio[k]).slice(opts.range.offset, opts.range.offset + opts.range.length) : audio[k],
        httpMetadata: {}, arrayBuffer: async () => toBuf(audio[k]).slice().buffer,
      }),
      head: async (k) => (audio[k] == null ? null : { size: toBuf(audio[k]).length }),
      delete: async (k) => { delete audio[k]; },
      list: async ({ prefix = '' } = {}) => ({ objects: Object.keys(audio).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    },
    OPENAI_API_KEY: 'test',
  };
  return { env, store, audio, violations };
}

const req = (path, init = {}, owner = 'me@x.com') =>
  new Request(`https://attest.test${path}`, {
    ...init,
    headers: { ...(owner ? { 'cf-access-authenticated-user-email': owner } : {}), ...(init.headers || {}) },
  });

const call = (path, init, env, owner) => worker.fetch(req(path, init, owner), env);

test('GET /api/meta exposes templates, models and transcribers', async () => {
  const { env } = fakeEnv();
  const body = await (await call('/api/meta', {}, env)).json();
  assert.equal(Object.keys(body.templates).length, 88);
  assert.equal(body.models[0].id, 'gpt-6-luna');
  assert.equal(body.transcribers[0].id, 'gpt-4o-transcribe-diarize');
});

test('unknown routes 404 and are not swallowed by the id route', async () => {
  const { env } = fakeEnv();
  assert.equal((await call('/api/nope', {}, env)).status, 404);
  assert.equal((await call('/api/recordings/', {}, env)).status, 404);
});

test('GET /api/recordings/:id/audio wins over the generic id route', async () => {
  const { env } = fakeEnv({
    recordings: [{ id: 'r1', owner: 'me@x.com', r2_key: 'rec/r1', content_type: 'audio/webm', title: 't' }],
    audio: { 'rec/r1': 'BYTES' },
  });
  const res = await call('/api/recordings/r1/audio', {}, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/webm');
  assert.equal(await res.text(), 'BYTES');
});

test('recordings are owner-scoped: another owner sees 404', async () => {
  const { env } = fakeEnv({
    recordings: [{ id: 'r1', owner: 'me@x.com', r2_key: 'rec/r1', content_type: 'audio/webm', title: 't' }],
    audio: { 'rec/r1': 'BYTES' },
  });
  assert.equal((await call('/api/recordings/r1', {}, env)).status, 200);
  assert.equal((await call('/api/recordings/r1', {}, env, 'someone@else.com')).status, 404);
  assert.equal((await call('/api/recordings/r1/audio', {}, env, 'someone@else.com')).status, 404);
});

test('POST /api/ask rejects a missing question before calling OpenAI', async () => {
  const { env } = fakeEnv();
  const res = await call('/api/ask', { method: 'POST', body: '{}' }, env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'question required');
});

test('ask with no recordings short-circuits without a network call', async () => {
  const { env } = fakeEnv();
  const res = await call('/api/ask', {
    method: 'POST', body: JSON.stringify({ question: 'what did we decide?' }),
  }, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sources.length, 0);
  assert.match(body.answer, /No recordings/);
});

test('POST /api/chats creates a thread and GET /api/chats lists it', async () => {
  const { env } = fakeEnv();
  const created = await (await call('/api/chats', { method: 'POST', body: '{}' }, env)).json();
  assert.equal(created.title, 'New chat');
  assert.ok(created.id);
});

test('POST /api/chats/:id/messages 404s for a thread the owner does not have', async () => {
  const { env } = fakeEnv({ chats: [{ id: 'c1', owner: 'me@x.com', title: 'New chat' }] });
  const res = await call('/api/chats/c1/messages', {
    method: 'POST', body: JSON.stringify({ question: 'hi' }),
  }, env, 'someone@else.com');
  assert.equal(res.status, 404);
});

test('POST /api/templates requires both label and style', async () => {
  const { env } = fakeEnv();
  const res = await call('/api/templates', {
    method: 'POST', body: JSON.stringify({ label: 'Court hearing' }),
  }, env);
  assert.equal(res.status, 400);
});

test('DELETE /api/templates/:id reports a miss instead of a false ok, and is owner-scoped', async () => {
  const { env, violations } = fakeEnv({ templates: [{ id: 'tpl1', owner: 'me@x.com', key: 'k', label: 'L', style: 's' }] });
  assert.equal((await call('/api/templates/tpl1', { method: 'DELETE' }, env, 'someone@else.com')).status, 404);
  assert.equal((await call('/api/templates/tpl1', { method: 'DELETE' }, env)).status, 200);
  assert.equal((await call('/api/templates/tpl1', { method: 'DELETE' }, env)).status, 404);
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// Review-fix coverage. The fake above applies the real SQL to real rows, so these
// assert on stored state, not on canned responses.
// ---------------------------------------------------------------------------
const ME = 'me@x.com', OTHER = 'someone@else.com';
const rec = (o = {}) => ({
  id: 'r1', owner: ME, title: 'T', created_at: Date.now(), status: 'recording', status_at: Date.now(),
  r2_key: 'rec/r1', content_type: 'audio/webm', template: 'meeting', transcriber: 'gpt-transcribe',
  live_transcript: '', ...o,
});
const post = (path, body, env, owner) => call(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}, env, owner);

async function withFetch(fn, impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('POST /api/recordings/live creates an owner-scoped recording row (not swallowed by /:id)', async () => {
  const { env, store, violations } = fakeEnv();
  const res = await post('/api/recordings/live', { title: 'Standup' }, env);
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.equal(store.recordings.length, 1);
  assert.deepEqual(
    { id: store.recordings[0].id, owner: store.recordings[0].owner, status: store.recordings[0].status },
    { id, owner: ME, status: 'recording' },
  );
  // a GET on the same literal path is NOT the live route
  assert.equal((await call('/api/recordings/live', {}, env)).status, 404);
  assert.deepEqual(violations, []);
});

test('POST /:id/part stores the slice, refreshes status_at, and is scoped to a status=recording row', async () => {
  const { env, store, audio, violations } = fakeEnv({ recordings: [rec({ status_at: 1 })] });
  const ok = await call('/api/recordings/r1/part?n=3', { method: 'POST', body: new Uint8Array([9, 9]) }, env);
  assert.equal(ok.status, 200);
  assert.ok(audio['rec/r1.parts/000003'], 'part not stored under the zero-padded key');
  assert.ok(store.recordings[0].status_at > 1, 'status_at should be bumped so the row never looks abandoned');

  assert.equal((await call('/api/recordings/r1/part', { method: 'POST', body: 'x' }, env)).status, 400); // n required
  assert.equal((await call('/api/recordings/r1/part?n=0', { method: 'POST', body: 'x' }, env, OTHER)).status, 404);
  store.recordings[0].status = 'uploaded';
  assert.equal((await call('/api/recordings/r1/part?n=1', { method: 'POST', body: 'x' }, env)).status, 404);
  assert.deepEqual(Object.keys(audio), ['rec/r1.parts/000003']); // nothing leaked from the refused calls
  assert.deepEqual(violations, []);
});

test('POST /:id/live appends preview text atomically and 404s unless status=recording and owned', async () => {
  const { env, store, violations } = fakeEnv({ recordings: [rec({ live_transcript: 'hello' })] });
  const transcribe = async () => new Response(JSON.stringify({ text: ' world ' }), { status: 200, headers: { 'content-type': 'application/json' } });
  await withFetch(async () => {
    const res = await call('/api/recordings/r1/live', { method: 'POST', body: new Uint8Array([1]) }, env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).live_transcript, 'hello world');
    assert.equal(store.recordings[0].live_transcript, 'hello world');

    assert.equal((await call('/api/recordings/r1/live', { method: 'POST', body: 'x' }, env, OTHER)).status, 404);
    store.recordings[0].status = 'processing';
    assert.equal((await call('/api/recordings/r1/live', { method: 'POST', body: 'x' }, env)).status, 404);
  }, transcribe);
  assert.deepEqual(violations, []);
});

test('POST /:id/live returns 502 on an OpenAI failure and leaves the row untouched', async () => {
  const { env, store } = fakeEnv({ recordings: [rec({ live_transcript: 'kept' })] });
  await withFetch(async () => {
    const res = await call('/api/recordings/r1/live', { method: 'POST', body: new Uint8Array([1]) }, env);
    assert.equal(res.status, 502);
  }, async () => new Response('nope', { status: 500 }));
  assert.equal(store.recordings[0].live_transcript, 'kept');
  assert.equal(store.recordings[0].status, 'recording');
});

test('PUT /:id/audio finalizes only a status=recording row and refuses to overwrite anything else', async () => {
  const { env, store, audio, violations } = fakeEnv({
    recordings: [rec(), rec({ id: 'r2', status: 'ready', r2_key: 'rec/r2' })],
    audio: { 'rec/r2': 'GOOD AUDIO', 'rec/r1.parts/000000': 'p' },
  });
  const put = (id, owner) => call(`/api/recordings/${id}/audio?duration_ms=4000`, {
    method: 'PUT', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([7, 7, 7]),
  }, env, owner);

  assert.equal((await put('r2')).status, 404, 'a ready recording must not be overwritable');
  assert.equal(audio['rec/r2'], 'GOOD AUDIO');
  assert.equal(store.recordings[1].status, 'ready');
  assert.equal((await put('r1', OTHER)).status, 404);

  assert.equal((await put('r1')).status, 200);
  assert.equal(store.recordings[0].status, 'uploaded');
  assert.equal(store.recordings[0].duration_ms, 4000);
  assert.deepEqual([...new Uint8Array(audio['rec/r1'])], [7, 7, 7]);
  assert.ok(!('rec/r1.parts/000000' in audio), 'parts should be cleaned up after a successful finalize');
  assert.equal((await put('r1')).status, 404, 'a second (stale/retried) PUT must be refused');
  assert.deepEqual(violations, []);
});

test('PUT /:id/audio rejects an oversize body by content-length before buffering', async () => {
  const { env } = fakeEnv({ recordings: [rec()] });
  const res = await worker.fetch(new Request('https://attest.test/api/recordings/r1/audio', {
    method: 'PUT', headers: { 'cf-access-authenticated-user-email': ME, 'content-length': String(25 * 1024 * 1024) }, body: 'x',
  }), env);
  assert.equal(res.status, 413);
});

test('POST /:id/recover rebuilds the audio from the stored parts in order and hands off to processing', async () => {
  const { env, store, audio, violations } = fakeEnv({
    recordings: [rec(), rec({ id: 'r2', status: 'uploaded' })],
    audio: {
      'rec/r1.parts/000001': new Uint8Array([3, 4]), 'rec/r1.parts/000000': new Uint8Array([1, 2]),
      'rec/r1.parts/000010': new Uint8Array([5]),
    },
  });
  assert.equal((await call('/api/recordings/r1/recover', { method: 'POST' }, env, OTHER)).status, 404);
  assert.equal((await call('/api/recordings/r2/recover', { method: 'POST' }, env)).status, 404, 'only an interrupted recording can be recovered');

  const res = await call('/api/recordings/r1/recover', { method: 'POST' }, env);
  assert.equal(res.status, 200);
  assert.deepEqual([...audio['rec/r1']], [1, 2, 3, 4, 5]);
  assert.equal(store.recordings[0].status, 'uploaded');
  assert.ok(Object.keys(audio).every((k) => !k.includes('.parts/')), 'parts deleted after recovery');

  const empty = fakeEnv({ recordings: [rec()] });
  assert.equal((await call('/api/recordings/r1/recover', { method: 'POST' }, empty.env)).status, 404);
  assert.deepEqual(violations, []);
});

test('listing marks a stale live recording as an error without touching the stored row', async () => {
  const { env, store } = fakeEnv({ recordings: [rec({ status_at: Date.now() - 3600_000, created_at: Date.now() - 3600_000 })] });
  const { recordings } = await (await call('/api/recordings', {}, env)).json();
  assert.equal(recordings[0].status, 'error');
  assert.equal(recordings[0].recoverable, true);
  assert.equal(store.recordings[0].status, 'recording', 'the projection must not leak into storage');
});

const speakerRec = (o = {}) => rec({
  status: 'ready', title: 'Sync',
  segments: JSON.stringify([{ speaker: 'A', text: 'hello', start: 0, end: 3 }, { speaker: 'B', text: 'hi', start: 3, end: 5 }]),
  transcript: 'Unknown 1: hello\n\nUnknown 2: hi',
  speakers: JSON.stringify([
    { label: 'A', name: 'Sam', evidence: "I'm Sam", confirmed: true },
    { label: 'B', name: null, evidence: '', confirmed: false },
  ]),
  ...o,
});

test('PATCH /:id/speakers 404s on a label the recording does not have and creates no person', async () => {
  const { env, store, violations } = fakeEnv({ recordings: [speakerRec()] });
  const patch = (body, owner) => call('/api/recordings/r1/speakers', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, env, owner);

  assert.equal((await patch({ label: 'ZZ', name: 'Pat' })).status, 404);
  assert.equal(store.people.length, 0, 'an unknown label must not create a people row');
  assert.equal((await patch({ label: 'B', name: 'Unknown 2' })).status, 400);
  assert.equal((await patch({ label: 'B', name: 'Pat' }, OTHER)).status, 404);

  const ok = await patch({ label: 'B', name: 'Pat' });
  assert.equal(ok.status, 200);
  const out = await ok.json();
  assert.deepEqual(out.speakers.find((s) => s.label === 'B'), { label: 'B', name: 'Pat', evidence: '', confirmed: true });
  assert.equal(out.speakers.find((s) => s.label === 'A').name, 'Sam');
  assert.equal(store.people.length, 1);
  assert.deepEqual(violations, []);
});

const wavBytes = (seconds) => encodeWav(new Float32Array(16000 * seconds), 16000);
const enroll = (env, personId, { recording_id, label, owner } = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([wavBytes(3)], { type: 'audio/wav' }), 'v.wav');
  if (recording_id) fd.append('recording_id', recording_id);
  if (label) fd.append('label', label);
  return call(`/api/people/${personId}/voiceprint`, { method: 'POST', body: fd }, env, owner);
};

test('voiceprint enrollment requires a human-confirmed speaker whose name matches the person', async () => {
  const { env, store, audio, violations } = fakeEnv({
    recordings: [speakerRec()],
    people: [{ id: 'p1', owner: ME, name: 'Sam' }, { id: 'p2', owner: ME, name: 'Pat' }],
  });
  assert.equal((await enroll(env, 'p1')).status, 403, 'no recording/label at all');
  assert.equal((await enroll(env, 'p1', { recording_id: 'r1', label: 'B' })).status, 403, 'unconfirmed label');
  assert.equal((await enroll(env, 'p2', { recording_id: 'r1', label: 'A' })).status, 403, 'confirmed, but for a different person');
  assert.equal((await enroll(env, 'p1', { recording_id: 'r1', label: 'A', owner: OTHER })).status, 404, 'other owner has no such person');
  assert.equal(store.voiceprints.length, 0);
  assert.equal(Object.keys(audio).length, 0);

  const ok = await enroll(env, 'p1', { recording_id: 'r1', label: 'A' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).voiceprint_count, 1);
  assert.equal(store.voiceprints[0].owner, ME);
  assert.ok(audio[store.voiceprints[0].r2_key], 'clip stored in R2 under the voiceprint key');
  assert.match(store.voiceprints[0].r2_key, /^vp\/p1\//);
  assert.deepEqual(violations, []);
});

test('DELETE /api/people/:id/voiceprints clears only the owner\'s clips; DELETE /api/voiceprints/:id is owner-scoped', async () => {
  const mk = () => fakeEnv({
    voiceprints: [
      { id: 'v1', owner: ME, person_id: 'p1', r2_key: 'vp/p1/a' },
      { id: 'v2', owner: ME, person_id: 'p1', r2_key: 'vp/p1/b' },
      { id: 'v3', owner: OTHER, person_id: 'p1', r2_key: 'vp/p1/c' },
    ],
    audio: { 'vp/p1/a': 'a', 'vp/p1/b': 'b', 'vp/p1/c': 'c' },
  });
  {
    const { env, store, audio, violations } = mk();
    const res = await call('/api/people/p1/voiceprints', { method: 'DELETE' }, env);
    assert.equal((await res.json()).removed, 2);
    assert.deepEqual(store.voiceprints.map((v) => v.id), ['v3']);
    assert.deepEqual(Object.keys(audio), ['vp/p1/c'], "another owner's clip must survive");
    assert.deepEqual(violations, []);
  }
  {
    const { env, store, audio } = mk();
    assert.equal((await call('/api/voiceprints/v1', { method: 'DELETE' }, env, OTHER)).status, 404);
    assert.equal(store.voiceprints.length, 3);
    assert.equal((await call('/api/voiceprints/v1', { method: 'DELETE' }, env)).status, 200);
    assert.ok(!('vp/p1/a' in audio));
  }
});

test('DELETE /api/chats/:id 404s for another owner and leaves their messages alone', async () => {
  const { env, store, violations } = fakeEnv({
    chats: [{ id: 'c1', owner: ME, title: 'x' }],
    messages: [{ id: 'm1', chat_id: 'c1', role: 'user', content: 'hi' }],
  });
  assert.equal((await call('/api/chats/c1', { method: 'DELETE' }, env, OTHER)).status, 404);
  assert.equal(store.chat_messages.length, 1, 'cross-tenant delete must not touch messages');
  assert.equal(store.chats.length, 1);
  assert.equal((await call('/api/chats/c1', { method: 'DELETE' }, env)).status, 200);
  assert.equal(store.chat_messages.length, 0);
  assert.deepEqual(violations, []);
});

test('export: html and docx need an id; md and zip work in bulk; custom template labels are used', async () => {
  const ready = rec({ status: 'ready', template: 'court', title: 'Hearing', summary: 'ok', transcript: 'A: hi' });
  const { env, violations } = fakeEnv({
    recordings: [ready],
    templates: [{ id: 't', owner: ME, key: 'court', label: 'Court hearing', style: 's' }],
  });
  assert.equal((await call('/api/export?format=html', {}, env)).status, 400);
  assert.equal((await call('/api/export?format=docx', {}, env)).status, 400);

  const md = await call('/api/export', {}, env);
  assert.equal(md.status, 200);
  assert.match(await md.text(), /Court hearing/);

  const zipRes = await call('/api/export?format=zip', {}, env);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  assert.ok(new TextDecoder().decode(new Uint8Array(await zipRes.arrayBuffer())).includes('Hearing.docx'));

  const html = await call('/api/export?id=r1&format=html', {}, env);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Court hearing/);
  const docxRes = await call('/api/export?id=r1&format=docx', {}, env);
  assert.match(new TextDecoder().decode(new Uint8Array(await docxRes.arrayBuffer())), /Court hearing/);
  assert.equal((await call('/api/export?id=r1', {}, env, OTHER)).status, 404);
  assert.deepEqual(violations, []);
});

test('cross-site writes are refused (CSRF); same-site writes and cross-site reads are not', async () => {
  const { env } = fakeEnv();
  const withSite = (site, init = {}) => ({ ...init, headers: { 'sec-fetch-site': site, ...(init.headers || {}) } });
  assert.equal((await call('/api/chats', withSite('cross-site', { method: 'POST', body: '{}' }), env)).status, 403);
  assert.equal((await call('/api/chats', withSite('same-origin', { method: 'POST', body: '{}' }), env)).status, 200);
  assert.equal((await call('/api/chats', withSite('none', { method: 'POST', body: '{}' }), env)).status, 200);
  assert.equal((await call('/api/chats', withSite('cross-site'), env)).status, 200);
});

test('REQUIRE_ACCESS=true refuses requests without the Access header instead of using the shared owner', async () => {
  const { env } = fakeEnv();
  env.REQUIRE_ACCESS = 'true';
  assert.equal((await call('/api/recordings', {}, env, null)).status, 401);
  assert.equal((await call('/api/recordings', {}, env)).status, 200);
  delete env.REQUIRE_ACCESS;
  assert.equal((await call('/api/recordings', {}, env, null)).status, 200); // local dev still works
});

test('POST /:id/process refuses (409) rather than double-bill when the claim fails', async () => {
  const fresh = Date.now();
  const cases = [
    ['already processing', rec({ status: 'processing', status_at: fresh })],
    ['still recording', rec({ status: 'recording' })],
    ['confirmed names would be re-attached to permuted labels', speakerRec()],
  ];
  for (const [why, row] of cases) {
    const { env, store } = fakeEnv({ recordings: [row] });
    await withFetch(async () => {
      const res = await call('/api/recordings/r1/process', { method: 'POST' }, env);
      assert.equal(res.status, 409, `${why}: ${res.status} ${res.status === 409 ? '' : await res.clone().text()}`);
    }, async () => { throw new Error('OpenAI must not be called'); });
    assert.equal(store.recordings[0].status, row.status, `${why}: status must be untouched`);
  }
  assert.equal((await call('/api/recordings/nope/process', { method: 'POST' }, fakeEnv().env)).status, 404);
  assert.equal((await call('/api/recordings/r1/process', { method: 'POST' }, fakeEnv({ recordings: [rec({ status: 'uploaded' })] }).env, OTHER)).status, 404);
});

test('sub-routes are dispatched to their own handlers, not the generic /:id routes', async () => {
  const { env, store } = fakeEnv({ recordings: [rec()] });
  // GET /:id/part would be readRow('r1/part') -> 404; POST /:id/part must reach livePart
  assert.equal((await call('/api/recordings/r1/part?n=0', { method: 'POST', body: 'x' }, env)).status, 200);
  assert.equal((await call('/api/recordings/r1/part?n=0', {}, env)).status, 404);
  // DELETE on a sub-route path must not delete the recording
  assert.equal((await call('/api/recordings/r1/part', { method: 'DELETE' }, env)).status, 404);
  assert.equal((await call('/api/recordings/r1/recover', { method: 'DELETE' }, env)).status, 404);
  assert.equal(store.recordings.length, 1);
  assert.equal((await call('/api/recordings/r1/speakers', { method: 'GET' }, env)).status, 404);
});

test('POST /api/pocket/import refuses cleanly without POCKET_API_KEY', async () => {
  const { env } = fakeEnv();
  const res = await call('/api/pocket/import', { method: 'POST', body: '{}' }, env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Pocket API key.*Settings/, 'points at Settings, not at a command-line secret');
});

test('pocket extractUrl finds the URL whatever field Pocket puts it in', async () => {
  const { extractUrl } = await import('../src/routes/pocket.js');
  assert.equal(extractUrl('https://s3.example/a.mp3?sig=1'), 'https://s3.example/a.mp3?sig=1');
  assert.equal(extractUrl({ url: 'https://s3.example/a' }), 'https://s3.example/a');
  assert.equal(extractUrl({ audio: { download_url: 'https://s3.example/b' }, expires_in: 600 }), 'https://s3.example/b');
  assert.equal(extractUrl({ expires_in: 600 }), null);
  assert.equal(extractUrl(null), null);
});

test('settings: PUT saves provider/models/key, applies on the next request, and never echoes the key', async () => {
  const { env, store } = fakeEnv();
  const put = (body, owner) => call('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env, owner);

  assert.equal((await put({ provider: 'bogus', chat_models: ['a'] })).status, 400);
  assert.equal((await put({ provider: 'openrouter', chat_models: ['openai/gpt-oss-20b'], stt_models: ['openai/whisper-large-v3-turbo'] })).status, 400); // no key anywhere

  const res = await put({
    provider: 'openrouter', api_key: 'sk-or-secret', default_model: 'openai/gpt-oss-20b',
    chat_models: ['openai/gpt-oss-20b', 'anthropic/claude-haiku-5.5'], stt_models: ['elevenlabs/scribe-v2'],
  });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.provider, 'openrouter');
  assert.equal(saved.has_key, true);
  assert.ok(!JSON.stringify(saved).includes('sk-or-secret'));

  const meta = await (await call('/api/meta', {}, env)).json();
  assert.deepEqual(meta.models.map((m) => m.id), ['openai/gpt-oss-20b', 'anthropic/claude-haiku-5.5']);
  assert.equal(meta.default_model, 'openai/gpt-oss-20b');
  assert.match(meta.transcribers[0].label, /speaker labels/);
  const got = await (await call('/api/settings', {}, env)).json();
  assert.ok(!JSON.stringify(got).includes('sk-or-secret'));
  assert.equal(got.provider, 'openrouter');

  // only the owner may change it once OWNER_EMAIL is set
  env.OWNER_EMAIL = ME;
  assert.equal((await put({ provider: 'openai', chat_models: ['gpt-6-luna'], api_key: 'k' }, OTHER)).status, 403);
  assert.equal(store.settings.filter((r) => r.key === 'LLM_API_KEY').length, 1);
});

test('process with an OpenRouter diarizing model sends diarize=true and stores speaker turns', async () => {
  const { env, store, audio } = fakeEnv({ recordings: [rec({ status: 'uploaded', transcriber: 'elevenlabs/scribe-v2' })] });
  Object.assign(env, { STT_BASE_URL: 'https://openrouter.ai/api/v1', STT_API_KEY: 'k', STT_MODELS: 'elevenlabs/scribe-v2' });
  audio['rec/r1'] = new Uint8Array([1, 2, 3]);
  let sttForm = null;
  const impl = async (url, init) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      sttForm = init.body;
      return new Response(JSON.stringify({ text: 'Hi there. Hello back.', words: [
        { word: 'Hi', start: 0, end: 1, speaker: 0 }, { word: 'there.', start: 1, end: 2, speaker: 0 },
        { word: 'Hello', start: 3, end: 4, speaker: 1 }, { word: 'back.', start: 4, end: 5, speaker: 1 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'T', summary: 's', action_items: [], speakers: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withFetch(() => call('/api/recordings/r1/process', { method: 'POST' }, env), impl);
  assert.equal(sttForm.get('diarize'), 'true');
  assert.equal(sttForm.get('response_format'), 'verbose_json');
  assert.equal(sttForm.get('model'), 'elevenlabs/scribe-v2');
  const t = store.recordings[0].transcript;
  assert.match(t, /Unknown 1: Hi there\./);
  assert.match(t, /Unknown 2: Hello back\./);
});

test('a recording saved with the OpenAI default transcriber is sent to OpenRouter with a model it offers', async () => {
  const { env, audio } = fakeEnv({ recordings: [rec({ status: 'uploaded', transcriber: 'gpt-4o-transcribe-diarize' })] });
  Object.assign(env, { STT_BASE_URL: 'https://openrouter.ai/api/v1', STT_API_KEY: 'k', STT_MODELS: 'openai/whisper-large-v3-turbo' });
  audio['rec/r1'] = new Uint8Array([1, 2, 3]);
  let sttForm = null;
  const impl = async (url, init) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      sttForm = init.body;
      return new Response(JSON.stringify({ text: 'hello there' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'T', summary: 's', action_items: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withFetch(() => call('/api/recordings/r1/process', { method: 'POST' }, env), impl);
  assert.equal(sttForm.get('model'), 'openai/whisper-large-v3-turbo');
  assert.equal(sttForm.get('response_format'), 'json');
  assert.equal(sttForm.get('chunking_strategy'), null);
});

test('OpenRouter audio over 24MB is streamed from R2 as base64 JSON input_audio, not loaded or sent as multipart', async () => {
  const bytes = new Uint8Array(25 * 1048576).fill(65);
  const { env, audio } = fakeEnv({ recordings: [rec({ status: 'uploaded', transcriber: 'microsoft/mai-transcribe-2', content_type: 'audio/mpeg' })] });
  Object.assign(env, { STT_BASE_URL: 'https://openrouter.ai/api/v1', STT_API_KEY: 'k', STT_MODELS: 'microsoft/mai-transcribe-2' });
  audio['rec/r1'] = bytes;
  env.AUDIO.get = async (k) => (k !== 'rec/r1' ? null : {
    size: bytes.length, body: new Blob([bytes]).stream(),
    arrayBuffer: async () => { throw new Error('must not buffer the big file'); },
  });
  let sent = null;
  const impl = async (url, init) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      sent = { ctype: init.headers['content-type'], text: await new Response(init.body).text() };
      return new Response(JSON.stringify({ text: 'ok', words: [
        { word: 'Hi', start: 0, end: 1, speaker: 0 }, { word: 'yo', start: 2, end: 3, speaker: 1 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'T', summary: 's', action_items: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withFetch(() => call('/api/recordings/r1/process', { method: 'POST' }, env), impl);
  assert.equal(sent.ctype, 'application/json');
  const body = JSON.parse(sent.text);
  assert.equal(body.model, 'microsoft/mai-transcribe-2');
  assert.equal(body.diarize, true);
  assert.equal(body.input_audio.format, 'mp3');
  assert.equal(body.input_audio.data, Buffer.from(bytes).toString('base64'));
});

/* --- #24 provider-independent voice matching --- */
import { VOICE_DIM } from '../src/config.js';
const VM = 'redimnet2-b6@e911e3f';
const basis = (i, noise = 0) => Array.from({ length: VOICE_DIM }, (_, k) => (k === i ? 1 : 0) + (k === (i + 1) % VOICE_DIM ? noise : 0));
const jpost = (path, body, env, owner) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env, owner);
const jput = (path, body, env, owner) => call(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env, owner);
const vmEnv = () => fakeEnv({
  recordings: [speakerRec({ speakers: JSON.stringify([
    { label: 'A', name: 'Sam', evidence: "I'm Sam", confirmed: true },
    { label: 'B', name: null, evidence: '', confirmed: false },
  ]) })],
  people: [{ id: 'p1', owner: ME, name: 'Sam' }, { id: 'p2', owner: ME, name: 'Pat' }],
  voiceprints: [
    { id: 'v1', owner: ME, person_id: 'p1', r2_key: 'vp/p1/x', embedding: JSON.stringify(basis(0)), embedding_model: VM },
    { id: 'v2', owner: ME, person_id: 'p2', r2_key: 'vp/p2/x', embedding: JSON.stringify(basis(5)), embedding_model: VM },
    { id: 'v3', owner: ME, person_id: 'p2', r2_key: 'vp/p2/y', embedding: null, embedding_model: null },
  ],
  audio: { 'vp/p2/y': 'WAVBYTES' },
});

test('POST /voice-match suggests a name (confirmed:false), rebuilds the transcript, never touches confirmed, is owner-scoped', async () => {
  const { env, store } = vmEnv();
  const res = await jpost('/api/recordings/r1/voice-match', { model: VM, speakers: [
    { label: 'A', embedding: basis(5), speech_ms: 9000 }, // confirmed Sam: untouched even though it sounds like Pat
    { label: 'B', embedding: basis(5, 0.1), speech_ms: 9000 },
  ] }, env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.voice_changed, true);
  assert.deepEqual(out.speakers.find((s) => s.label === 'A'), { label: 'A', name: 'Sam', evidence: "I'm Sam", confirmed: true });
  const b = out.speakers.find((s) => s.label === 'B');
  assert.equal(b.name, 'Pat');
  assert.equal(b.confirmed, false);
  assert.match(b.evidence, /^voice match 0\.99/);
  assert.match(out.transcript, /Pat: hi/);
  assert.equal(store.recordings[0].voice_match && JSON.parse(store.recordings[0].voice_match).model, VM);
  assert.equal((await jpost('/api/recordings/r1/voice-match', { model: VM, speakers: [{ label: 'B', embedding: basis(5), speech_ms: 9000 }] }, env, OTHER)).status, 404);
});

test('POST /voice-match rejects wrong model, bad embeddings and unknown labels; short speech stays unnamed', async () => {
  const { env } = vmEnv();
  const ok = { label: 'B', embedding: basis(5), speech_ms: 9000 };
  assert.equal((await jpost('/api/recordings/r1/voice-match', { model: 'other', speakers: [ok] }, env)).status, 400);
  assert.equal((await jpost('/api/recordings/r1/voice-match', { model: VM, speakers: [{ ...ok, embedding: [1, 2, 3] }] }, env)).status, 400);
  assert.equal((await jpost('/api/recordings/r1/voice-match', { model: VM, speakers: [{ ...ok, label: 'Z' }] }, env)).status, 400);
  const out = await (await jpost('/api/recordings/r1/voice-match', { model: VM, speakers: [{ ...ok, speech_ms: 1000 }] }, env)).json();
  assert.equal(out.voice_changed, false);
  assert.equal(out.speakers.find((s) => s.label === 'B').name, null);
});

test('GET /voiceprints, PUT /voiceprints/:id/embedding and GET /voiceprints/:id/audio are owner-scoped and validated', async () => {
  const { env, store } = vmEnv();
  const list = await (await call('/api/voiceprints', {}, env)).json();
  assert.equal(list.model, VM);
  assert.equal(list.embedded_count, 2);
  assert.deepEqual(list.voiceprints.map((v) => [v.id, v.has_embedding]), [['v1', true], ['v2', true], ['v3', false]]);
  assert.ok(!JSON.stringify(list).includes('"embedding"'));
  assert.equal((await (await call('/api/voiceprints', {}, env, OTHER)).json()).voiceprints.length, 0);

  assert.equal((await call('/api/voiceprints/v3/audio', {}, env, OTHER)).status, 404);
  assert.equal(await (await call('/api/voiceprints/v3/audio', {}, env)).text(), 'WAVBYTES');

  assert.equal((await jput('/api/voiceprints/v3/embedding', { model: VM, embedding: basis(9) }, env, OTHER)).status, 404);
  assert.equal((await jput('/api/voiceprints/v3/embedding', { model: 'old', embedding: basis(9) }, env)).status, 400);
  assert.equal((await jput('/api/voiceprints/v3/embedding', { model: VM, embedding: [0, 1] }, env)).status, 400);
  assert.equal((await jput('/api/voiceprints/v3/embedding', { model: VM, embedding: basis(9) }, env)).status, 200);
  assert.equal(store.voiceprints.find((v) => v.id === 'v3').embedding_model, VM);
});

test('process?stop_after=transcript stops at transcribed with no summary; the next process resumes without a second STT call', async () => {
  const { env, store, audio } = fakeEnv({ recordings: [rec({ status: 'uploaded', transcriber: 'elevenlabs/scribe-v2' })] });
  Object.assign(env, { STT_BASE_URL: 'https://openrouter.ai/api/v1', STT_API_KEY: 'k', STT_MODELS: 'elevenlabs/scribe-v2' });
  audio['rec/r1'] = new Uint8Array([1, 2, 3]);
  let stt = 0, llm = 0;
  const impl = async (url) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      stt++;
      return new Response(JSON.stringify({ text: 'Hi there. Hello back.', words: [
        { word: 'Hi', start: 0, end: 1, speaker: 0 }, { word: 'Hello', start: 3, end: 4, speaker: 1 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    llm++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'T', summary: 'the summary', action_items: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withFetch(async () => {
    const first = await (await call('/api/recordings/r1/process?stop_after=transcript', { method: 'POST' }, env)).json();
    assert.equal(first.status, 'transcribed');
    assert.ok(first.transcript);
    assert.ok(!first.summary);
    assert.equal(stt, 1);
    const cached = llm; // naming may use the LLM; summarize must not have run yet
    assert.ok(!store.recordings[0].summary);
    const second = await (await call('/api/recordings/r1/process', { method: 'POST' }, env)).json();
    assert.equal(second.status, 'ready');
    assert.equal(stt, 1, 'resumed from the stored transcript, no second transcription');
    assert.equal(llm, cached + 1);
  }, impl);
});

test('POST /resummarize re-summarizes a ready recording with confirmed speakers and never calls STT', async () => {
  const { env, store } = fakeEnv({ recordings: [speakerRec({ summary: 'old' })] });
  let stt = 0, prompt = '';
  const impl = async (url, init) => {
    if (String(url).includes('/audio/transcriptions')) { stt++; return new Response('{}', { status: 200 }); }
    prompt = JSON.parse(init.body).messages[1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'new', action_items: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withFetch(async () => {
    const res = await call('/api/recordings/r1/resummarize', { method: 'POST' }, env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).summary, 'new');
    assert.equal(stt, 0);
    assert.match(prompt, /Unknown 1: hello/);
    assert.equal((await call('/api/recordings/r1/resummarize', { method: 'POST' }, env, OTHER)).status, 404);
    store.recordings[0].status = 'error';
    assert.equal((await call('/api/recordings/r1/resummarize', { method: 'POST' }, env)).status, 409);
  }, impl);
});
/* --- /#24 --- */

/* --- Today screen --- */
const DAYMS = 86400000;
const NOW = Date.parse('2026-11-10T20:00:00Z');
const ago = (d) => NOW - d * DAYMS;
const todayRecs = () => [
  rec({ id: 'a', status: 'ready', title: 'Sync', created_at: ago(1), summary: 'we synced',
    transcript: 'Jeff: hi Ben. Ben: hello.',
    speakers: JSON.stringify([{ label: 'A', name: 'Jeff', confirmed: true }, { label: 'B', name: 'Ben', confirmed: true }]),
    action_items: JSON.stringify([{ task: 'Send deck', owner: 'Jeff', due: '2026-11-05' }, { task: 'Book room', owner: 'Ben', due: null, done: true }]) }),
  rec({ id: 'b', status: 'ready', title: 'Old chat', created_at: ago(12), summary: 'old',
    transcript: 'Solo notes.', speakers: JSON.stringify([]),
    action_items: JSON.stringify([{ task: 'Call vendor', owner: null, due: 'Friday' }]) }),
  rec({ id: 'c', status: 'ready', title: 'Other owner', owner: OTHER, created_at: ago(1), action_items: JSON.stringify([{ task: 'secret' }]) }),
];
const llmOk = (calls, text = 'BRIEF') => async (url, init) => {
  calls.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('GET /api/today lists open items (overdue, slipping), skips done and other owners, needs a date', async () => {
  const { env, violations } = fakeEnv({ recordings: todayRecs(), people: [{ id: 'p1', owner: ME, name: 'Ben' }] });
  assert.equal((await call('/api/today', {}, env)).status, 400);
  const out = await (await call('/api/today?date=2026-11-10', {}, env)).json();
  assert.deepEqual(out.open.map((x) => [x.task, x.overdue, x.slipping]), [['Send deck', true, false], ['Call vendor', false, true]]);
  assert.equal(out.overdue_count, 1);
  assert.equal(out.slipping_count, 1);
  assert.equal(out.week_start, '2026-11-09');
  assert.equal(out.brief, null);
  assert.deepEqual(out.people.map((p) => [p.id, p.name]), [['p1', 'Ben']]);
  assert.deepEqual(violations, []);
});

test('POST/DELETE /api/today/ack hides a brief item until restored', async () => {
  const { env, violations } = fakeEnv({ recordings: todayRecs() });
  const post = (b) => call('/api/today/ack', { method: 'POST', body: JSON.stringify(b) }, env);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ key: 'send the deck' })).status, 200);
  assert.deepEqual((await (await call('/api/today?date=2026-11-10', {}, env)).json()).acks, ['send the deck']);
  assert.equal((await call('/api/today/ack', { method: 'DELETE' }, env)).status, 200);
  assert.deepEqual((await (await call('/api/today?date=2026-11-10', {}, env)).json()).acks, []);
  assert.deepEqual(violations, []);
});

test('POST /api/today/brief generates once, serves the cache, regenerates on force or a newer recording', async () => {
  const recs = todayRecs();
  recs[0].created_at = Date.now() - 3600_000; // recent enough to be in the 7-day window
  const { env, store } = fakeEnv({ recordings: recs });
  const calls = [];
  await withFetch(async () => {
    const b = { kind: 'today', date: new Date().toISOString().slice(0, 10), me: 'Jeff' };
    const first = await (await post('/api/today/brief', b, env)).json();
    assert.equal(first.content, 'BRIEF');
    assert.equal(calls.length, 1);
    assert.match(calls[0].messages[0].content, /The user is Jeff/);
    assert.match(calls[0].messages[1].content, /Send deck/);
    assert.ok(!JSON.stringify(calls[0]).includes('secret'));
    assert.equal((await (await post('/api/today/brief', b, env)).json()).cached, true);
    assert.equal(calls.length, 1);
    await post('/api/today/brief', { ...b, force: true }, env);
    assert.equal(calls.length, 2);
    assert.equal(store.briefs.length, 1, 'one cached row per (owner, kind, period)');
    store.recordings[0].created_at = Date.now() + 1000; // newer than the brief: stale
    await post('/api/today/brief', b, env);
    assert.equal(calls.length, 3);
    assert.equal((await post('/api/today/brief', { kind: 'nope', date: b.date }, env)).status, 400);
  }, llmOk(calls));
});

test('an empty window makes no model call and is not cached', async () => {
  const { env, store } = fakeEnv({ recordings: [] });
  const calls = [];
  await withFetch(async () => {
    const out = await (await post('/api/today/brief', { kind: 'weekly', date: '2026-11-10' }, env)).json();
    assert.match(out.content, /No finished recordings/);
    assert.equal(calls.length, 0);
    assert.equal(store.briefs.length, 0);
  }, llmOk(calls));
});

test('POST /api/insight honours the day window and the person filter, validates input, and is owner-scoped', async () => {
  const recs = todayRecs();
  recs[0].created_at = Date.now() - DAYMS; recs[1].created_at = Date.now() - 12 * DAYMS; recs[2].created_at = Date.now() - DAYMS;
  const { env } = fakeEnv({ recordings: recs, people: [{ id: 'p1', owner: ME, name: 'Ben', notes: 'prefers email' }] });
  const calls = [];
  const date = '2026-11-10';
  await withFetch(async () => {
    const wide = await (await post('/api/insight', { prompt: 'what happened', date, days: 30 }, env)).json();
    assert.deepEqual(wide.sources.map((s) => s.title), ['Sync', 'Old chat']);
    const narrow = await (await post('/api/insight', { prompt: 'what happened', date, days: 7 }, env)).json();
    assert.deepEqual(narrow.sources.map((s) => s.title), ['Sync']);
    const person = await (await post('/api/insight', { prompt: 'prep me', date, days: 30, person: 'Ben' }, env)).json();
    assert.deepEqual(person.sources.map((s) => s.title), ['Sync']);
    assert.match(calls.at(-1).messages[0].content, /prefers email/);
    assert.match(calls.at(-1).messages[1].content, /Focus on: Ben/);
    const none = await (await post('/api/insight', { prompt: 'x', date, days: 30, person: 'Zed' }, env)).json();
    assert.equal(none.empty, true);
    const before = calls.length;
    assert.equal((await post('/api/insight', { prompt: '', date }, env)).status, 400);
    assert.equal((await post('/api/insight', { prompt: 'x'.repeat(1600), date }, env)).status, 400);
    assert.equal((await post('/api/insight', { prompt: 'x' }, env)).status, 400);
    assert.equal(calls.length, before);
    const theirs = await (await post('/api/insight', { prompt: 'x', date, days: 30 }, env, OTHER)).json();
    assert.deepEqual(theirs.sources.map((s) => s.title), ['Other owner']);
  }, llmOk(calls, 'ANSWER'));
});

test('PATCH /:id/actions persists done, is bounds-checked and owner-scoped', async () => {
  const { env, store } = fakeEnv({ recordings: todayRecs() });
  const patch = (body, owner) => call('/api/recordings/a/actions', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env, owner);
  assert.equal((await patch({ i: 0, done: true })).status, 200);
  assert.equal(JSON.parse(store.recordings[0].action_items)[0].done, true);
  assert.equal(JSON.parse(store.recordings[0].action_items)[1].done, true, 'other items untouched');
  assert.equal((await patch({ i: 0, done: false })).status, 200);
  assert.equal(JSON.parse(store.recordings[0].action_items)[0].done, false);
  assert.equal((await patch({ i: 9, done: true })).status, 400);
  assert.equal((await patch({ i: 0, done: 'yes' })).status, 400);
  assert.equal((await patch({ i: 0, done: true }, OTHER)).status, 404);
});

test('re-summarize keeps ticked items ticked and stores unanswered questions', async () => {
  const { env, store } = fakeEnv({ recordings: [speakerRec({
    summary: 'old', action_items: JSON.stringify([{ task: 'Send deck', owner: 'Jeff', done: true }, { task: 'Other', done: false }]) })] });
  const impl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: 'new', action_items: [{ task: 'send deck', owner: 'Jeff' }, { task: 'Fresh' }], unanswered: ['Who pays?', '', 'When?'] }) } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });
  await withFetch(() => call('/api/recordings/r1/resummarize', { method: 'POST' }, env), impl);
  const items = JSON.parse(store.recordings[0].action_items);
  assert.deepEqual(items.map((a) => [a.task, a.done === true]), [['send deck', true], ['Fresh', false]]);
  assert.deepEqual(JSON.parse(store.recordings[0].unanswered), ['Who pays?', 'When?']);
  const row = await (await call('/api/recordings/r1', {}, env)).json();
  assert.deepEqual(row.unanswered, ['Who pays?', 'When?']);
  assert.ok(Array.isArray(row.talk_stats));
});

/* --- structured memory + semantic index --- */
import { VECTOR_DIM } from '../src/vectors.js';
const FACTS_JSON = [
  { kind: 'commitment', person: 'Ben', text: 'Ben will send the contract', quote: 'I will send the contract on Friday' },
  { kind: 'decision', person: null, text: 'Launch moves to December', quote: 'we decided to launch in December' },
  { kind: 'decision', person: null, text: 'Made up', quote: 'this was never said' },
];
const memRec = (o = {}) => rec({ id: 'm1', status: 'ready', title: 'Planning', created_at: ago(2),
  transcript: 'Ben: I will send the contract on Friday. Jeff: ok, we decided to launch in December.',
  summary: 's', speakers: '[]', ...o });
const llmJson = (obj) => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });

// A fake Workers AI + Vectorize pair that records what happens.
function fakeVectors() {
  const log = { embedded: [], upserts: [], deleted: [], queries: [], store: [] };
  const vec = (text) => { const v = new Array(VECTOR_DIM).fill(0); v[(text.length * 7) % VECTOR_DIM] = 1; return v; };
  return {
    log,
    AI: { run: async (model, { text }) => { log.embedded.push(...text); return { data: text.map(vec) }; } },
    VECTORS: {
      upsert: async (vs) => { log.upserts.push(...vs); log.store.push(...vs); },
      deleteByIds: async (ids) => { log.deleted.push(...ids); },
      query: async (v, opts) => {
        log.queries.push(opts);
        return { matches: log.store.filter((x) => x.namespace === opts.namespace)
          .map((x) => ({ id: x.id, score: 0.8, metadata: x.metadata })).slice(0, opts.topK) };
      },
    },
  };
}

test('summarize stores verified facts (non-verbatim quotes are dropped), and a re-summarize keeps a ticked commitment', async () => {
  const { env, store } = fakeEnv({ recordings: [memRec()] });
  const body = { summary: 'new', action_items: [], facts: FACTS_JSON };
  await withFetch(() => call('/api/recordings/m1/resummarize', { method: 'POST' }, env), llmJson(body));
  assert.deepEqual(store.facts.map((f) => f.text), ['Ben will send the contract', 'Launch moves to December']);
  assert.equal(store.facts[0].person, 'Ben');
  assert.equal(store.facts[0].created_at, store.recordings[0].created_at);
  assert.ok(store.recordings[0].facts_at);
  store.facts[0].done = 1;
  await withFetch(() => call('/api/recordings/m1/resummarize', { method: 'POST' }, env), llmJson(body));
  assert.equal(store.facts.length, 2, 'replaced, not duplicated');
  assert.equal(store.facts.find((f) => f.kind === 'commitment').done, 1);
});

test('GET /api/memory filters by person and kind, is owner-scoped; PATCH ticks; DELETE removes', async () => {
  const mk = (id, owner, kind, person) => ({ id, owner, recording_id: 'm1', kind, person, text: id, quote: 'q', done: 0, created_at: 1 });
  const { env, store } = fakeEnv({ recordings: [memRec()], facts: [
    mk('f1', ME, 'commitment', 'Ben'), mk('f2', ME, 'decision', null), mk('f3', OTHER, 'decision', 'Ben')] });
  const all = await (await call('/api/memory', {}, env)).json();
  assert.deepEqual(all.facts.map((f) => f.id), ['f1', 'f2']);
  assert.equal(all.facts[0].title, 'Planning');
  assert.deepEqual(all.people, ['Ben']);
  assert.deepEqual((await (await call('/api/memory?person=ben', {}, env)).json()).facts.map((f) => f.id), ['f1']);
  assert.deepEqual((await (await call('/api/memory?kind=decision', {}, env)).json()).facts.map((f) => f.id), ['f2']);
  const patch = (id, owner) => call(`/api/memory/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) }, env, owner);
  assert.equal((await patch('f1', OTHER)).status, 404);
  assert.equal((await patch('f1')).status, 200);
  assert.equal(store.facts.find((f) => f.id === 'f1').done, 1);
  assert.equal((await call('/api/memory/f3', { method: 'DELETE' }, env)).status, 404);
  assert.equal((await call('/api/memory/f1', { method: 'DELETE' }, env)).status, 200);
  assert.equal(store.facts.some((f) => f.id === 'f1'), false);
});

test('POST /api/memory/backfill extracts facts for old recordings two at a time and reports what is left', async () => {
  const recs = ['a', 'b', 'c'].map((id, i) => memRec({ id, created_at: ago(i + 1) }));
  const { env, store } = fakeEnv({ recordings: [...recs, memRec({ id: 'done', facts_at: 5 }), memRec({ id: 'x', owner: OTHER })] });
  await withFetch(async () => {
    const first = await (await call('/api/memory/backfill', { method: 'POST' }, env)).json();
    assert.deepEqual([first.processed, first.remaining, first.vectors_enabled], [2, 1, false]);
    const second = await (await call('/api/memory/backfill', { method: 'POST' }, env)).json();
    assert.deepEqual([second.processed, second.remaining], [1, 0]);
    assert.equal(store.facts.length, 6);
    assert.ok(store.facts.every((f) => f.owner === ME));
  }, llmJson({ facts: FACTS_JSON }));
});

test('with AI + VECTORS bindings, summarize indexes the recording and delete removes the vectors', async () => {
  const v = fakeVectors();
  const { env, store } = fakeEnv({ recordings: [memRec()] });
  Object.assign(env, { AI: v.AI, VECTORS: v.VECTORS });
  await withFetch(() => call('/api/recordings/m1/resummarize', { method: 'POST' }, env), llmJson({ summary: 'new', action_items: [], facts: FACTS_JSON }));
  assert.ok(v.log.upserts.length >= 4, 'summary + 2 facts + transcript passage(s)');
  assert.deepEqual([...new Set(v.log.upserts.map((x) => x.metadata.kind))].sort(), ['fact', 'summary', 'transcript']);
  assert.ok(v.log.upserts.every((x) => x.id.startsWith('m1:') && x.namespace.length === 32 && x.metadata.rec === 'm1'));
  assert.equal(store.recordings[0].vec_chunks, v.log.upserts.length);
  const n = store.recordings[0].vec_chunks;
  assert.equal((await call('/api/recordings/m1', { method: 'DELETE' }, env)).status, 200);
  assert.equal(v.log.deleted.length, n);
  assert.equal(store.facts.length, 0);
});

test('Ask uses the semantic index when present, stays owner-scoped, and falls back to keywords if it breaks', async () => {
  const v = fakeVectors();
  const { env } = fakeEnv({ recordings: [memRec({ id: 'm1' })] });
  Object.assign(env, { AI: v.AI, VECTORS: v.VECTORS });
  await withFetch(() => call('/api/recordings/m1/resummarize', { method: 'POST' }, env), llmJson({ summary: 'new', action_items: [], facts: FACTS_JSON }));
  let prompt = '';
  const ask = (e, owner) => withFetch(async () => (await post('/api/ask', { question: 'who sends the contract' }, e, owner)).json(), async (url, init) => {
    prompt = JSON.parse(init.body).messages.at(-1).content;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ANSWER' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const out = await ask(env);
  assert.equal(out.answer, 'ANSWER');
  assert.deepEqual(out.sources.map((s) => s.title), ['Planning']);
  assert.match(prompt, /commitment \(Ben\)/);
  assert.equal(v.log.queries.at(-1).namespace.length, 32);
  assert.equal((await ask(env, OTHER)).answer, 'No recordings to search yet.', 'another owner shares nothing');
  env.VECTORS.query = async () => { throw new Error('index down'); };
  assert.equal((await ask(env)).answer, 'ANSWER', 'falls back to the keyword path');
});

test('insight context carries remembered facts and shrinks the transcript excerpt', async () => {
  const long = memRec({ id: 'L', created_at: Date.now() - 1000, transcript: 'word '.repeat(2000), speakers: '[]' });
  const { env } = fakeEnv({ recordings: [long], facts: [{ id: 'f', owner: ME, recording_id: 'L', kind: 'commitment', person: 'Ben', text: 'Ben sends contract', quote: 'q', done: 0, created_at: 1 }] });
  const calls = [];
  await withFetch(() => post('/api/insight', { prompt: 'what is open', date: '2026-11-10', days: 7 }, env), llmOk(calls));
  const ctx = calls[0].messages[1].content;
  assert.match(ctx, /Remembered facts:\n- \[commitment\] \(Ben\) Ben sends contract/);
  assert.ok(ctx.length < 3500, 'transcript capped when facts exist');
});

test('the scheduled run builds memory for old recordings, two per tick, without Pocket configured', async () => {
  const { runScheduled } = await import('../src/cron.js');
  const recs = ['a', 'b', 'c'].map((id, i) => memRec({ id, created_at: ago(i + 1) }));
  const { env, store } = fakeEnv({ recordings: recs });
  env.OWNER_EMAIL = ME; // no POCKET_API_KEY
  await withFetch(async () => {
    await runScheduled(env);
    assert.equal(store.recordings.filter((r) => r.facts_at).length, 2);
    await runScheduled(env);
    assert.equal(store.recordings.filter((r) => r.facts_at).length, 3);
    const before = store.facts.length;
    await runScheduled(env); // nothing left: no model call, no change
    assert.equal(store.facts.length, before);
  }, llmJson({ facts: FACTS_JSON }));
});

test('live preview uses cheap Whisper on OpenRouter (not the first, pricier model) and gpt-transcribe on OpenAI', async () => {
  const seen = [];
  const impl = async (url, init) => { seen.push(init.body.get('model')); return new Response(JSON.stringify({ text: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const a = fakeEnv({ recordings: [rec()] });
  Object.assign(a.env, { STT_BASE_URL: 'https://openrouter.ai/api/v1', STT_API_KEY: 'k', STT_MODELS: 'microsoft/mai-transcribe-2' });
  await withFetch(() => call('/api/recordings/r1/live', { method: 'POST', body: new Uint8Array([1]) }, a.env), impl);
  const b = fakeEnv({ recordings: [rec()] });
  await withFetch(() => call('/api/recordings/r1/live', { method: 'POST', body: new Uint8Array([1]) }, b.env), impl);
  assert.deepEqual(seen, ['openai/whisper-large-v3-turbo', 'gpt-transcribe']);
});

/* --- merging people --- */
test('POST /api/people/merge renames everywhere, moves voice samples and facts, keeps an alias, and is owner-scoped', async () => {
  const seg = (sp, text, a, b) => ({ speaker: sp, text, start: a, end: b });
  const mk = (id, owner, names) => rec({
    id, owner, status: 'ready', title: 'T' + id,
    segments: JSON.stringify([seg('A', 'hello', 0, 3), seg('B', 'hi', 3, 6)]),
    transcript: `${names[0]}: hello\n\n${names[1] || 'Unknown 1'}: hi`,
    speakers: JSON.stringify([{ label: 'A', name: names[0], confirmed: true }, { label: 'B', name: names[1] || null, confirmed: false }]),
    vec_chunks: 5,
  });
  const { env, store, violations } = fakeEnv({
    recordings: [mk('r1', ME, ['Jeff', 'Ben']), mk('r2', ME, ['Jeff Eberhard', 'Ben']), mk('r3', OTHER, ['Jeff', null])],
    people: [{ id: 'p1', owner: ME, name: 'Jeff', aliases: null, notes: 'old note' }, { id: 'p2', owner: ME, name: 'Jeff Eberhard', aliases: 'JE', notes: null },
      { id: 'p9', owner: OTHER, name: 'Jeff', aliases: null, notes: null }],
    voiceprints: [{ id: 'v1', owner: ME, person_id: 'p1', r2_key: 'vp/p1/a' }, { id: 'v2', owner: ME, person_id: 'p2', r2_key: 'vp/p2/a' }, { id: 'v3', owner: OTHER, person_id: 'p9', r2_key: 'x' }],
    facts: [{ id: 'f1', owner: ME, recording_id: 'r1', kind: 'commitment', person: 'Jeff', text: 't', quote: 'q', done: 0, created_at: 1 }],
  });
  const merge = (body, owner) => post('/api/people/merge', body, env, owner);

  assert.equal((await merge({ from_id: 'p1', into_id: 'p1' })).status, 400);
  assert.equal((await merge({ from_id: 'p1', into_id: 'p9' })).status, 404, "cannot merge into someone else's person");
  assert.equal((await merge({ from_id: 'p9', into_id: 'p2' })).status, 404);
  assert.equal(store.people.length, 3, 'rejected merges change nothing');

  const res = await merge({ from_id: 'p1', into_id: 'p2' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, into: { id: 'p2', name: 'Jeff Eberhard' }, recordings_updated: 1 });
  assert.deepEqual(store.people.filter((p) => p.owner === ME).map((p) => p.id), ['p2']);
  const r1 = store.recordings.find((r) => r.id === 'r1');
  assert.equal(JSON.parse(r1.speakers)[0].name, 'Jeff Eberhard');
  assert.equal(JSON.parse(r1.speakers)[0].confirmed, true, 'a confirmed name stays confirmed');
  assert.match(r1.transcript, /^Jeff Eberhard: hello/);
  assert.equal(r1.vec_chunks, null, 'queued for re-indexing');
  assert.equal(store.recordings.find((r) => r.id === 'r2').vec_chunks, 5, 'untouched recordings keep their index');
  assert.equal(JSON.parse(store.recordings.find((r) => r.id === 'r3').speakers)[0].name, 'Jeff', "another owner's recording is untouched");
  assert.equal(store.voiceprints.find((v) => v.id === 'v1').person_id, 'p2');
  assert.equal(store.voiceprints.find((v) => v.id === 'v3').person_id, 'p9');
  assert.equal(store.facts[0].person, 'Jeff Eberhard');
  const keep = store.people.find((p) => p.id === 'p2');
  assert.equal(keep.aliases, 'JE, Jeff');
  assert.equal(keep.notes, 'old note', 'notes are kept when the target had none');
  assert.deepEqual(violations, []);
});

test('PATCH /api/people/:id renames everywhere as a correction (no alias), refuses a taken name, and is owner-scoped', async () => {
  const seg = (sp, text, a, b) => ({ speaker: sp, text, start: a, end: b });
  const mk = (id, owner, name) => rec({
    id, owner, status: 'ready', title: 'T' + id,
    segments: JSON.stringify([seg('A', 'hello', 0, 3)]),
    transcript: `${name}: hello`,
    speakers: JSON.stringify([{ label: 'A', name, confirmed: true }]),
    vec_chunks: 5,
  });
  const { env, store, violations } = fakeEnv({
    recordings: [mk('r1', ME, 'Ulf'), mk('r2', ME, 'Ben'), mk('r3', OTHER, 'Ulf')],
    people: [{ id: 'p1', owner: ME, name: 'Ulf', aliases: null, notes: null }, { id: 'p2', owner: ME, name: 'Ben', aliases: null, notes: null },
      { id: 'p9', owner: OTHER, name: 'Ulf', aliases: null, notes: null }],
    facts: [{ id: 'f1', owner: ME, recording_id: 'r1', kind: 'commitment', person: 'Ulf', text: 't', quote: 'q', done: 0, created_at: 1 }],
  });
  const patch = (id, body, owner) => call('/api/people/' + id, { method: 'PATCH', body: JSON.stringify(body) }, env, owner);

  assert.equal((await patch('p1', { name: '  ' })).status, 400);
  assert.equal((await patch('p1', { name: 'Unknown 3' })).status, 400, 'a placeholder is not a name');
  assert.equal((await patch('p9', { name: 'Kai' })).status, 404, "cannot rename someone else's person");
  assert.equal((await patch('p1', { name: 'ben' })).status, 409, 'a name already in People is a merge, not a rename');
  assert.equal(store.people.find((p) => p.id === 'p1').name, 'Ulf', 'refused renames change nothing');

  const res = await patch('p1', { name: 'Kai Schmidt' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: 'p1', name: 'Kai Schmidt', recordings_updated: 1 });
  assert.equal(store.people.find((p) => p.id === 'p1').name, 'Kai Schmidt');
  assert.equal(store.people.find((p) => p.id === 'p1').aliases, null, 'the old name was wrong, so it is not kept as an alias');
  const r1 = store.recordings.find((r) => r.id === 'r1');
  assert.equal(JSON.parse(r1.speakers)[0].name, 'Kai Schmidt');
  assert.equal(JSON.parse(r1.speakers)[0].confirmed, true);
  assert.match(r1.transcript, /^Kai Schmidt: hello/);
  assert.equal(r1.vec_chunks, null);
  assert.equal(store.facts[0].person, 'Kai Schmidt');
  assert.equal(JSON.parse(store.recordings.find((r) => r.id === 'r3').speakers)[0].name, 'Ulf', "another owner's recording is untouched");
  assert.equal(JSON.parse(store.recordings.find((r) => r.id === 'r2').speakers)[0].name, 'Ben');
  assert.deepEqual(violations, []);
});

test('GET /api/people reports recording counts and likely duplicates', async () => {
  const mkr = (id, names) => rec({ id, status: 'ready', speakers: JSON.stringify(names.map((n, i) => ({ label: 'AB'[i], name: n }))) });
  const { env } = fakeEnv({
    recordings: [mkr('a', ['Jeff', 'Ben']), mkr('b', ['Jeff Eberhard']), mkr('c', ['Jeff'])],
    people: [{ id: 'p1', owner: ME, name: 'Jeff' }, { id: 'p2', owner: ME, name: 'Jeff Eberhard' }, { id: 'p3', owner: ME, name: 'Ben' }],
  });
  const out = await (await call('/api/people', {}, env)).json();
  const byName = Object.fromEntries(out.people.map((p) => [p.name, p.recordings]));
  assert.deepEqual(byName, { Jeff: 2, 'Jeff Eberhard': 1, Ben: 1 });
  assert.deepEqual(out.suggestions.map((x) => [x.from_name, x.into_name]), [['Jeff', 'Jeff Eberhard']]);
});

test('GET /:id/audio supports byte ranges for seeking: 206 with Content-Range, suffix ranges, 416, and full body otherwise', async () => {
  const { env } = fakeEnv({
    recordings: [rec({ status: 'ready', content_type: 'audio/webm' })],
    audio: { 'rec/r1': '0123456789' },
  });
  const get = (range, owner) => call('/api/recordings/r1/audio', { headers: range ? { range } : {} }, env, owner);

  const full = await get();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(await full.text(), '0123456789');

  const mid = await get('bytes=2-5');
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await mid.text(), '2345');

  const open = await get('bytes=7-');
  assert.equal(open.headers.get('content-range'), 'bytes 7-9/10');
  assert.equal(await open.text(), '789');

  const tail = await get('bytes=-3');
  assert.equal(tail.headers.get('content-range'), 'bytes 7-9/10');

  const clamped = await get('bytes=8-99');
  assert.equal(clamped.headers.get('content-range'), 'bytes 8-9/10');

  assert.equal((await get('bytes=50-60')).status, 416);
  assert.equal((await get('garbage')).status, 200, 'an unparseable Range header is ignored');
  assert.equal((await get('bytes=0-1', OTHER)).status, 404, 'ranges do not bypass owner scoping');
});

test('GET /api/recordings lists participant names for the sidebar, not the raw speaker rows', async () => {
  const { env } = fakeEnv({ recordings: [
    rec({ id: 'a', status: 'ready', speakers: JSON.stringify([{ label: 'A', name: 'Jeff' }, { label: 'B', name: null }, { label: 'C', name: 'Jeff' }]) }),
    rec({ id: 'b', status: 'ready', speakers: 'not json' }),
  ] });
  const { recordings } = await (await call('/api/recordings', {}, env)).json();
  assert.deepEqual(recordings.map((r) => [r.id, r.people]), [['a', ['Jeff']], ['b', []]]);
  assert.ok(recordings.every((r) => !('speakers' in r)));
});

/* --- local mode: speaker labels by voice --- */
const localEnvVars = { LOCAL_MODE: 'true', LOCAL_DIARIZE: 'true', STT_BASE_URL: 'http://localhost:11434/v1', STT_API_KEY: 'k', STT_MODELS: 'whisper-large-v3-turbo', LLM_BASE_URL: 'http://localhost:11434/v1', LLM_API_KEY: 'k' };

test('local transcription asks for timestamps, stores one provisional speaker, and does NOT run the naming pass on it', async () => {
  const { env, store, audio } = fakeEnv({ recordings: [rec({ status: 'uploaded', transcriber: 'whisper-large-v3-turbo' })] });
  Object.assign(env, localEnvVars);
  audio['rec/r1'] = new Uint8Array([1, 2, 3]);
  let sttForm = null, llmCalls = 0;
  const impl = async (url, init) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      sttForm = init.body;
      return new Response(JSON.stringify({ text: 'Hi I am Ben. Hello Ben, I am Jeff. Nice to meet you. You too.', segments: [
        { start: 0, end: 3, text: ' Hi I am Ben.' }, { start: 3.2, end: 6, text: ' Hello Ben, I am Jeff.' }, { start: 6, end: 6, text: 'zero length dropped' },
        { start: 6.5, end: 9, text: ' Nice to meet you.' }, { start: 9.2, end: 12, text: ' You too.' }, { start: 13, end: 14, text: '  ' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    llmCalls++;
    return new Response('{}', { status: 200 });
  };
  const out = await withFetch(async () => (await call('/api/recordings/r1/process?stop_after=transcript', { method: 'POST' }, env)).json(), impl);
  assert.equal(sttForm.get('response_format'), 'verbose_json');
  assert.equal(sttForm.get('model'), 'whisper-large-v3-turbo');
  assert.equal(llmCalls, 0, 'no LLM naming call: a single provisional speaker would be named from anything said anywhere');
  assert.equal(out.status, 'transcribed');
  assert.deepEqual(JSON.parse(store.recordings[0].segments).map((s) => [s.speaker, s.start, s.end]), [['A', 0, 3], ['A', 3.2, 6], ['A', 6.5, 9], ['A', 9.2, 12]]);
  const sp = JSON.parse(store.recordings[0].speakers);
  assert.deepEqual(sp.map((s) => [s.label, s.name]), [['A', null]]);
});

test('a short local recording keeps its timestamps as speaker A and is named normally, instead of waiting for speaker detection that will never run', async () => {
  const run = async (segments) => {
    const { env, store, audio } = fakeEnv({ recordings: [rec({ status: 'uploaded', transcriber: 'whisper-large-v3-turbo' })] });
    Object.assign(env, localEnvVars);
    audio['rec/r1'] = new Uint8Array([1, 2, 3]);
    let llm = 0;
    await withFetch(() => call('/api/recordings/r1/process?stop_after=transcript', { method: 'POST' }, env), async (url) => {
      if (String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: "Hi, I'm Jeff.", segments }), { status: 200, headers: { 'content-type': 'application/json' } });
      llm++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ speakers: [{ label: 'A', name: 'Jeff', evidence: "Hi, I'm Jeff." }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { segments: JSON.parse(store.recordings[0].segments), speakers: JSON.parse(store.recordings[0].speakers), llm };
  };
  const one = await run([{ start: 0, end: 4, text: " Hi, I'm Jeff." }]);
  assert.deepEqual(one.segments.map((s) => s.speaker), ['A'], 'the label is there, so Enroll voice can find the clip');
  assert.equal(one.llm, 1, 'a short recording is named straight away');
  assert.deepEqual(one.speakers.map((s) => [s.label, s.name]), [['A', 'Jeff']]);
  const three = await run([0, 1, 2].map((i) => ({ start: i * 4, end: i * 4 + 4, text: ' x' + i })));
  assert.equal(three.llm, 1, 'under 4 segments: no speaker detection will run, so name it now');
  const four = await run([0, 1, 2, 3].map((i) => ({ start: i * 4, end: i * 4 + 4, text: ' x' + i })));
  assert.equal(four.llm, 0, '4+ segments: wait for the browser to split speakers');
  assert.deepEqual(four.speakers.map((s) => s.name), [null]);
});

test('without local diarization (or with no timestamps) transcription is the plain path', async () => {
  const run = async (vars, body) => {
    const { env, store, audio } = fakeEnv({ recordings: [rec({ status: 'uploaded', transcriber: 'whisper-large-v3-turbo' })] });
    Object.assign(env, vars);
    audio['rec/r1'] = new Uint8Array([1, 2, 3]);
    let form;
    await withFetch(() => call('/api/recordings/r1/process?stop_after=transcript', { method: 'POST' }, env), async (url, init) => {
      if (String(url).endsWith('/audio/transcriptions')) { form = init.body; return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"speakers":[]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { form, segments: store.recordings[0].segments };
  };
  const base = { STT_BASE_URL: 'http://localhost:11434/v1', STT_API_KEY: 'k', STT_MODELS: 'whisper-large-v3-turbo' };
  assert.equal((await run(base, { text: 'hello there' })).form.get('response_format'), 'json');
  const noTs = await run({ ...base, ...localEnvVars }, { text: 'hello there' });
  assert.equal(noTs.form.get('response_format'), 'verbose_json');
  assert.ok(!noTs.segments || noTs.segments === '[]', 'no usable timestamps: nothing for the browser to cluster');
});

test('POST /:id/speaker-turns relabels segments, names from evidence, rebuilds the transcript, and is validated and owner-scoped', async () => {
  const seg = (t, a, b) => ({ speaker: 'A', text: t, start: a, end: b });
  const base = () => rec({ id: 'r1', status: 'ready', title: 'Call',
    segments: JSON.stringify([seg('Hi I am Ben.', 0, 3), seg('Hello Ben, I am Jeff.', 3, 6), seg('Nice to meet you.', 6, 9), seg('You too.', 9, 12)]),
    transcript: 'Unknown 1: all of it', speakers: JSON.stringify([{ label: 'A', name: null, evidence: '', confirmed: false }]), voice_match: '{"scores":[]}' });
  const { env, store } = fakeEnv({ recordings: [base()] });
  const turns = (assign, owner) => call('/api/recordings/r1/speaker-turns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assign }) }, env, owner);
  const naming = { choices: [{ message: { content: JSON.stringify({ speakers: [
    { label: 'A', name: 'Ben', evidence: 'Hi I am Ben.' }, { label: 'B', name: 'Jeff', evidence: 'I am Jeff.' }] }) } }] };

  assert.equal((await turns([0, 1])).status, 400, 'one entry per segment');
  assert.equal((await turns([0, 1, 0, 'x'])).status, 400);
  assert.equal((await turns([0, 1, 0, 99])).status, 400);
  assert.equal((await turns([0, 1, 0, 1], OTHER)).status, 404);
  assert.deepEqual(JSON.parse(store.recordings[0].segments).map((s) => s.speaker), ['A', 'A', 'A', 'A'], 'rejected requests change nothing');

  const res = await withFetch(() => turns([0, 1, 0, 1]), async () => new Response(JSON.stringify(naming), { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.segments.map((s) => s.speaker), ['A', 'B', 'A', 'B']);
  assert.deepEqual(out.speakers.map((s) => [s.label, s.name, s.confirmed]), [['A', 'Ben', false], ['B', 'Jeff', false]]);
  assert.match(out.transcript, /^Ben: Hi I am Ben\./);
  assert.match(out.transcript, /Jeff: Hello Ben, I am Jeff\./);
  assert.equal(out.voice_changed, true, 'a ready recording should be re-summarized with the new turns');
  assert.equal(store.recordings[0].voice_match, null, 'old voice-match scores are for the old labels');

  store.recordings[0].status = 'recording';
  store.recordings[0].speakers = JSON.stringify([{ label: 'A', name: null, confirmed: false }]);
  assert.equal((await turns([0, 0, 0, 0])).status, 409);
});

test('speaker-turns survives a failing naming call by keeping anonymous labels', async () => {
  const { env, store } = fakeEnv({ recordings: [rec({ id: 'r1', status: 'transcribed', title: 'T', segments: JSON.stringify([{ speaker: 'A', text: 'a', start: 0, end: 1 }, { speaker: 'A', text: 'b', start: 1, end: 2 }]), transcript: 'x', speakers: JSON.stringify([{ label: 'A', name: null, confirmed: false }]) })] });
  const res = await withFetch(() => call('/api/recordings/r1/speaker-turns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assign: [0, 1] }) }, env), async () => new Response('boom', { status: 500 }));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(store.recordings[0].speakers).map((s) => [s.label, s.name]), [['A', null], ['B', null]]);
  assert.match(store.recordings[0].transcript, /Unknown 1: a/);
  assert.match(store.recordings[0].transcript, /Unknown 2: b/);
});

test('settings extras: the Pocket key and voice switch save without the provider form, are write-only, and obey owner rules', async () => {
  const { env, store } = fakeEnv();
  const put = (body, owner) => call('/api/settings/extras', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env, owner);
  const get = async () => (await call('/api/settings', {}, env)).json();

  assert.equal((await get()).has_pocket_key, false);
  assert.equal((await call('/api/pocket/import', { method: 'POST', body: '{}' }, env)).status, 400, 'without a key it refuses');
  assert.equal((await put({})).status, 400, 'nothing to save');
  assert.equal((await put({ pocket_api_key: 'pk with space' })).status, 400);
  assert.equal((await put({ pocket_api_key: 'x'.repeat(301) })).status, 400);
  assert.equal(store.settings.length, 0, 'rejected requests save nothing');

  const res = await put({ pocket_api_key: '  pk_secret123  ', voice_match: 'off' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.has_pocket_key, true);
  assert.equal(out.voice_match, false);
  assert.ok(!JSON.stringify(out).includes('pk_secret123'), 'the key is never sent back');
  assert.equal(store.settings.find((r) => r.key === 'POCKET_API_KEY').value, 'pk_secret123', 'trimmed');
  assert.ok(!JSON.stringify(await get()).includes('pk_secret123'));
  assert.equal((await get()).has_pocket_key, true);

  // a request after saving sees the key: Import from Pocket no longer refuses for lack of one
  // (it gets past that check; the fake database then cannot run the import query, which is fine here)
  let outcome;
  try { outcome = (await withFetch(() => call('/api/pocket/import', { method: 'POST', body: '{}' }, env), async () => new Response('{}', { status: 200 }))).status; }
  catch (e) { outcome = String(e.message); }
  assert.notEqual(outcome, 400, 'the saved key was seen');
  assert.match(String(outcome), /pocket_id IS NOT NULL|^\d+$/, 'it ran the import itself (the fake database cannot execute that query)');

  await put({ pocket_clear: true });
  assert.equal((await get()).has_pocket_key, false);
  assert.equal(store.settings.filter((r) => r.key === 'POCKET_API_KEY').length, 1, 'one row, not a pile of them');

  env.OWNER_EMAIL = ME;
  assert.equal((await put({ pocket_api_key: 'pk_x' }, OTHER)).status, 403);
});

test('the provider form can also set the Pocket key in the same save', async () => {
  const { env, store } = fakeEnv();
  const res = await call('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    provider: 'openai', chat_models: ['gpt-6-luna'], api_key: 'sk-x', pocket_api_key: 'pk_one',
  }) }, env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.has_pocket_key, true);
  assert.ok(!JSON.stringify(out).includes('pk_one'));
  assert.equal(store.settings.find((r) => r.key === 'POCKET_API_KEY').value, 'pk_one');
  const bad = await call('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'openai', chat_models: ['gpt-6-luna'], api_key: 'sk-x', pocket_api_key: 'has space' }) }, env);
  assert.equal(bad.status, 400);
});

test('speaker-turns keeps names a human confirmed on their label, never gives that name to a second label, and reports a confirmed speaker who vanishes', async () => {
  const seg = (t, a) => ({ speaker: 'A', text: t, start: a, end: a + 3 });
  const base = () => rec({ id: 'r1', status: 'ready', title: 'Call',
    segments: JSON.stringify([seg('Hi I am Ben.', 0), seg('Hello Ben, I am Jeff.', 3), seg('Nice to meet you.', 6), seg('You too.', 9)]),
    transcript: 'x', speakers: JSON.stringify([{ label: 'A', name: 'Ben', evidence: '', confirmed: true }, { label: 'B', name: 'Pat', evidence: '', confirmed: true }]) });
  const naming = { choices: [{ message: { content: JSON.stringify({ speakers: [
    { label: 'A', name: 'Jeff', evidence: 'I am Jeff.' }, { label: 'B', name: 'Ben', evidence: 'Hi I am Ben.' }] }) } }] };
  const llm = async () => new Response(JSON.stringify(naming), { status: 200, headers: { 'content-type': 'application/json' } });
  const run = (assign, env) => withFetch(() => call('/api/recordings/r1/speaker-turns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assign }) }, env), llm);

  const { env } = fakeEnv({ recordings: [base()] });
  const res = await run([0, 1, 0, 1], env);
  assert.equal(res.status, 200, 'confirmed names no longer block a re-run');
  const out = await res.json();
  const by = Object.fromEntries(out.speakers.map((x) => [x.label, x]));
  assert.deepEqual([by.A.name, by.A.confirmed, by.B.name, by.B.confirmed], ['Ben', true, 'Pat', true], 'both confirmed names kept on their labels');
  assert.deepEqual(out.dropped_names, []);

  // naming wants to call label B "Ben", but Ben is confirmed on A: no duplicate
  const two = fakeEnv({ recordings: [base()] });
  two.store.recordings[0].speakers = JSON.stringify([{ label: 'A', name: 'Ben', evidence: '', confirmed: true }]);
  const o2 = await (await run([0, 1, 0, 1], two.env)).json();
  assert.deepEqual(o2.speakers.map((x) => [x.label, x.name]), [['A', 'Ben'], ['B', null]], 'the suggestion that repeats a confirmed name is dropped');

  // everything moved to B: the confirmed speaker on A has no turns left
  const three = fakeEnv({ recordings: [base()] });
  const o3 = await (await run([1, 1, 1, 1], three.env)).json();
  assert.deepEqual(o3.dropped_names, ['Ben'], 'the confirmed speaker who vanished is reported, not silently lost');
  assert.deepEqual(o3.speakers.map((x) => x.label), ['B']);
});

test('POST /:id/reassign moves turns to an existing or a new speaker, keeps names, removes an emptied speaker, and is validated and owner-scoped', async () => {
  const seg = (sp, t, a) => ({ speaker: sp, text: t, start: a, end: a + 3 });
  const mk = () => rec({ id: 'r1', status: 'ready', title: 'Call',
    segments: JSON.stringify([seg('A', 'one', 0), seg('B', 'two', 3), seg('A', 'three', 6), seg('C', 'four', 9)]),
    transcript: 'old', voice_match: '{"scores":[]}',
    speakers: JSON.stringify([{ label: 'A', name: 'Jeff', evidence: '', confirmed: true }, { label: 'B', name: null, evidence: '', confirmed: false }, { label: 'C', name: 'Kev', evidence: 'x', confirmed: false }]) });
  const { env, store } = fakeEnv({ recordings: [mk()] });
  const go = (body, owner) => call('/api/recordings/r1/reassign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env, owner);

  assert.equal((await go({ segments: [1], to: 'A' }, OTHER)).status, 404);
  assert.equal((await go({ segments: [], to: 'A' })).status, 400);
  assert.equal((await go({ segments: [9], to: 'A' })).status, 400);
  assert.equal((await go({ segments: [1], to: 'Z' })).status, 400, 'no such speaker');
  assert.deepEqual(JSON.parse(store.recordings[0].segments).map((x) => x.speaker), ['A', 'B', 'A', 'C'], 'rejected requests change nothing');

  const moved = await (await go({ segments: [1], to: 'A' })).json();
  assert.deepEqual(moved.segments.map((x) => x.speaker), ['A', 'A', 'A', 'C']);
  assert.deepEqual(moved.speakers.map((x) => x.label), ['A', 'C'], 'B had no turns left: removed');
  assert.deepEqual(moved.speakers.find((x) => x.label === 'A'), { label: 'A', name: 'Jeff', evidence: '', confirmed: true });
  assert.match(moved.transcript, /^Jeff: one/);
  assert.equal(moved.voice_changed, true);
  assert.equal(store.recordings[0].voice_match, null, 'scores for the old labels are stale');

  const fresh = await (await go({ segments: [2], to: 'new' })).json();
  assert.equal(fresh.moved_to, 'B', 'the first unused letter');
  assert.deepEqual(fresh.speakers.map((x) => [x.label, x.name, x.confirmed]), [['A', 'Jeff', true], ['B', null, false], ['C', 'Kev', false]]);
  assert.match(fresh.transcript, /Unknown 1: three/);

  const merged = await (await go({ segments: [3], to: 'A' })).json();
  assert.deepEqual(merged.removed_speakers, ['Kev'], 'a named speaker who is emptied is reported');

  store.recordings[0].status = 'recording';
  assert.equal((await go({ segments: [0], to: 'A' })).status, 409);
});
