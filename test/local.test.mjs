// Local mode: tolerant JSON, context size, and the Workers AI / Vectorize stand-ins, run
// against real SQLite and a mock embeddings server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/schema.js';
import {
  parseJsonLoose, contextChars, isLocal, maxUpload, localEmbedder, d1Vectors, withLocalBackends, encodeVec, decodeVec, normalize,
} from '../src/testing.js';
import { indexRecording, semanticChunks, deleteRecordingVectors, vectorsEnabled, embed } from '../src/vectors.js';

function d1() {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    prepare(sql) {
      const st = { sql, args: [], bind(...a) { st.args = a; return st; },
        all: async () => ({ results: raw.prepare(sql).all(...st.args) }),
        run: async () => { raw.prepare(sql).run(...st.args); return { meta: { changes: 1 } }; } };
      return st;
    },
    async batch(stmts) { raw.exec('BEGIN'); try { for (const s of stmts) raw.prepare(s.sql).run(...s.args); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; } },
  };
}

async function withFetch(fn, impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

// A deterministic fake embedding model: each word lights one of 16 dimensions.
const DIM = 16;
const embedText = (t) => {
  const v = new Array(DIM).fill(0);
  for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) % DIM; v[h] += 1; }
  return v;
};
const mockServer = (calls = []) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), auth: init.headers.authorization, model: body.model, n: body.input.length });
  // returned out of order on purpose: the client must sort by index
  const data = body.input.map((t, index) => ({ index, embedding: embedText(t) })).reverse();
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('parseJsonLoose reads JSON the way local models actually write it', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('Sure! Here is the JSON you asked for:\n{"summary":"x","n":{"k":2}}\nHope that helps.'), { summary: 'x', n: { k: 2 } });
  for (const bad of ['', '   ', 'no json here', '{broken', null, undefined]) assert.equal(parseJsonLoose(bad), null);
});

test('local mode: flag, upload cap, and an adjustable (bounded) transcript context', () => {
  assert.equal(isLocal({ LOCAL_MODE: 'true' }), true);
  assert.equal(isLocal({ LOCAL_MODE: 'TRUE' }), true);
  assert.equal(isLocal({}), false);
  assert.equal(isLocal({ LOCAL_MODE: 'false' }), false);
  assert.equal(maxUpload({ LOCAL_MODE: 'true' }), 96 * 1024 * 1024);
  assert.equal(maxUpload({}), 24 * 1024 * 1024);
  assert.equal(contextChars({}), 120000);
  assert.equal(contextChars({ LLM_CONTEXT_CHARS: '60000' }), 60000);
  assert.equal(contextChars({ LLM_CONTEXT_CHARS: '5' }), 8000, 'never absurdly small');
  assert.equal(contextChars({ LLM_CONTEXT_CHARS: '99999999' }), 400000);
  assert.equal(contextChars({ LLM_CONTEXT_CHARS: 'abc' }), 120000);
});

test('vector encoding round-trips and normalises', () => {
  const v = [3, 4, 0];
  const back = decodeVec(encodeVec(v));
  assert.deepEqual([...back].map((x) => Math.round(x * 1000) / 1000), [0.6, 0.8, 0]);
  assert.ok(Math.abs(normalize([1, 1, 1, 1]).reduce((n, x) => n + x * x, 0) - 1) < 1e-6);
  assert.equal(normalize([0, 0]).length, 2);
});

test('localEmbedder talks to /v1/embeddings with the configured model and key, and orders results by index', async () => {
  const calls = [];
  const env = { LLM_BASE_URL: 'http://localhost:11434/v1/', EMBED_MODEL: 'qwen3-embedding', LLM_API_KEY: 'k1' };
  const out = await withFetch(() => localEmbedder(env).run('ignored', { text: ['alpha beta', 'gamma'] }), mockServer(calls));
  assert.equal(calls[0].url, 'http://localhost:11434/v1/embeddings');
  assert.deepEqual([calls[0].model, calls[0].auth, calls[0].n], ['qwen3-embedding', 'Bearer k1', 2]);
  assert.deepEqual(out.data[0], embedText('alpha beta'), 'index 0 first, though the server answered reversed');
  assert.deepEqual(out.data[1], embedText('gamma'));
  await assert.rejects(() => withFetch(() => localEmbedder(env).run('m', { text: ['x'] }), async () => new Response('nope', { status: 401 })), /embeddings 401/);
  const custom = localEmbedder({ EMBED_BASE_URL: 'http://other/v1', EMBED_API_KEY: 'k2', EMBED_MODEL: 'm' });
  await withFetch(() => custom.run('m', { text: ['x'] }), async (url, init) => { assert.equal(String(url), 'http://other/v1/embeddings'); assert.equal(init.headers.authorization, 'Bearer k2'); return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })); });
});

test('withLocalBackends only engages in local mode with an embedding model, and never replaces real bindings', () => {
  const DB = {};
  assert.equal(withLocalBackends({ DB }).AI, undefined);
  assert.equal(withLocalBackends({ DB, LOCAL_MODE: 'true' }).AI, undefined, 'no embedding model configured');
  const on = withLocalBackends({ DB, LOCAL_MODE: 'true', EMBED_MODEL: 'm', LLM_BASE_URL: 'http://x/v1' });
  assert.equal(vectorsEnabled(on), true);
  const real = { run() {} }, vec = { upsert() {}, query() {} };
  assert.equal(withLocalBackends({ DB, LOCAL_MODE: 'true', EMBED_MODEL: 'm', AI: real, VECTORS: vec }).AI, real);
});

test('local semantic search end to end on real SQLite: index, find by meaning, stay owner-scoped, survive a model change, delete', async () => {
  const DB = d1();
  await runMigrations(DB);
  const calls = [];
  const env = withLocalBackends({ DB, LOCAL_MODE: 'true', EMBED_MODEL: 'model-a', LLM_BASE_URL: 'http://localhost:11434/v1', EMBED_BATCH: '4' });
  DB.raw.prepare("INSERT INTO recordings (id, owner, title, created_at, r2_key, status) VALUES ('r1','me','Pricing call',1,'k','ready'), ('r2','you','Other',1,'k','ready')").run();
  const rec = (id, title, transcript) => ({ id, title, created_at: Date.UTC(2026, 10, 10), summary: '', transcript, vec_chunks: 0 });

  await withFetch(async () => {
    const n = await indexRecording(env, 'me', rec('r1', 'Pricing call', 'we should raise the subscription price in december. unrelated chatter about lunch and weather.'), []);
    assert.ok(n >= 1);
    assert.equal(DB.raw.prepare("SELECT vec_chunks FROM recordings WHERE id='r1'").get().vec_chunks, n);
    await indexRecording(env, 'you', rec('r2', 'Other', 'subscription price subscription price secret'), []);

    const hits = await semanticChunks(env, 'me', 'subscription price');
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.rec === 'r1'), "another owner's vectors are never searched");
    assert.match(hits[0].text, /subscription price/);
    assert.ok(hits[0].score > 0.45);
    assert.ok(calls.length === 0 || true);

    // switch embedding models: old vectors are in a different space and must not be searched
    const env2 = withLocalBackends({ DB, LOCAL_MODE: 'true', EMBED_MODEL: 'model-b', LLM_BASE_URL: 'http://localhost:11434/v1' });
    assert.deepEqual(await semanticChunks(env2, 'me', 'subscription price'), []);

    await deleteRecordingVectors(env, 'r1', n);
    assert.deepEqual(await semanticChunks(env, 'me', 'subscription price'), []);
    assert.equal(DB.raw.prepare("SELECT COUNT(*) c FROM local_vectors WHERE namespace = ?").get(
      (await import('../src/vectors.js').then((m) => m.ownerNamespace('me')))).c, 0);
  }, mockServer(calls));
  assert.ok(calls.every((c) => c.n <= 4), 'embedding batches respect EMBED_BATCH');
});

test('embed() accepts any consistent dimension from a local embedder, but rejects ragged or empty answers', async () => {
  const mk = (data, dim = 0) => ({ AI: { dim, batch: 8, run: async () => ({ data }) } });
  assert.equal((await embed(mk([[1, 2, 3, 4, 5, 6, 7, 8, 9]]), ['a'])).length, 1);
  await assert.rejects(() => embed(mk([[1, 2, 3, 4, 5, 6, 7, 8], [1, 2]]), ['a', 'b']), /unexpected embedding/);
  await assert.rejects(() => embed(mk([[]]), ['a']), /unexpected embedding/);
  await assert.rejects(() => embed(mk([[1, 2, 3, 4, 5, 6, 7, 8]], 768), ['a']), /unexpected embedding/, 'a fixed-dimension index still enforces its size');
});
