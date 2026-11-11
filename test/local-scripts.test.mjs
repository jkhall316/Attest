// The local setup tooling (scripts/lib/omlx.mjs, scripts/local-check.mjs), against a mock
// oMLX-style server on a real local port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECOMMENDED, recommendationsText, recommendedIndex, missingRecommended, explainSttError, WHISPER_PROCESSOR_FILES,
  normalizeBase, guessRole, detectBase, listModels, probeChat, probeEmbeddings, probeStt, parseDevVars, mergeDevVars, buildLocalVars,
} from '../scripts/lib/omlx.mjs';
import { check } from '../scripts/local-check.mjs';

// opts: strictJson (400 on response_format), fenced (wrap JSON in a code fence), timestamps, embedDim, sttStatus
function mockServer(opts = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'] });
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer secret') return send(401, { error: { message: 'API key required' } });
    if (req.url === '/v1/models') return send(200, { data: (opts.models || ['chat-model', 'bge-embed', 'whisper-turbo', 'bge-reranker']).map((id) => ({ id })) });
    if (req.url === '/v1/embeddings') {
      const body = JSON.parse(raw);
      return send(200, { data: body.input.map((_, index) => ({ index, embedding: new Array(opts.embedDim || 12).fill(0.1) })) });
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      if (opts.strictJson && body.response_format) return send(400, { error: 'response_format not supported' });
      const json = '{"ok": true, "word": "pong"}';
      return send(200, { choices: [{ message: { content: opts.fenced ? `Sure!\n\`\`\`json\n${json}\n\`\`\`` : json } }] });
    }
    if (req.url === '/v1/audio/transcriptions') {
      if (opts.sttStatus) return send(opts.sttStatus, { error: { message: opts.sttError || 'no such model' } });
      const segments = opts.timestamps === false ? [] : [{ start: 0, end: 2.5, text: ' hello there' }, { start: 2.5, end: 5, text: ' general kenobi' }];
      return send(200, { text: 'hello there general kenobi', segments });
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}/v1`, port: server.address().port, seen, close: () => new Promise((r) => server.close(r)),
  })));
}
const withServer = async (opts, fn) => { const s = await mockServer(opts); try { return await fn(s); } finally { await s.close(); } };

test('normalizeBase adds the scheme and /v1 and drops trailing slashes', () => {
  assert.equal(normalizeBase('localhost:11434'), 'http://localhost:11434/v1');
  assert.equal(normalizeBase('http://localhost:8000/'), 'http://localhost:8000/v1');
  assert.equal(normalizeBase('http://localhost:8000/v1/'), 'http://localhost:8000/v1');
  assert.equal(normalizeBase('https://mac.local:8000/v1'), 'https://mac.local:8000/v1');
  assert.equal(normalizeBase(''), '');
});

test('guessRole sorts model ids into chat / embedding / transcription', () => {
  for (const id of ['mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ', 'bge-small-en', 'nomic-embed-text', 'all-MiniLM-L6-v2']) assert.equal(guessRole(id), 'embedding', id);
  for (const id of ['mlx-community/whisper-large-v3-turbo', 'parakeet-tdt', 'Qwen3-ASR']) assert.equal(guessRole(id), 'stt', id);
  for (const id of ['mlx-community/gpt-oss-20b-MXFP4-Q8', 'llama-3.3-70b', 'qwen3-32b']) assert.equal(guessRole(id), 'chat', id);
  assert.equal(guessRole('bge-reranker-v2'), 'other', 'a reranker is neither an embedder nor a chat model');
});

test('detectBase finds the server that answers, even if it answers 401', async () => {
  await withServer({}, async (s) => {
    assert.equal(await detectBase([1, s.port]), `http://localhost:${s.port}/v1`);
  });
  assert.equal(await detectBase([1]), '');
});

test('listModels: ids on success, a plain reason for a wrong key or an unreachable server', async () => {
  await withServer({}, async (s) => {
    const ok = await listModels(s.base, 'secret');
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ids, ['chat-model', 'bge-embed', 'whisper-turbo', 'bge-reranker']);
    const bad = await listModels(s.base, 'wrong');
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 401);
    assert.match(bad.error, /API key/);
    assert.equal(s.seen.at(-1).auth, 'Bearer wrong');
  });
  const down = await listModels('http://127.0.0.1:1/v1', 'k');
  assert.equal(down.ok, false);
  assert.match(down.error, /could not reach/);
});

test('probeEmbeddings reports the vector size; probeChat copes with fenced JSON and with a server that rejects response_format', async () => {
  await withServer({ embedDim: 24 }, async (s) => assert.deepEqual(await probeEmbeddings(s.base, 'secret', 'bge-embed'), { ok: true, dim: 24 }));
  await withServer({ embedDim: 3 }, async (s) => assert.equal((await probeEmbeddings(s.base, 'secret', 'm')).ok, false));
  await withServer({}, async (s) => assert.equal((await probeEmbeddings(s.base, 'nope', 'm')).ok, false));

  await withServer({}, async (s) => {
    const c = await probeChat(s.base, 'secret', 'chat-model');
    assert.deepEqual([c.ok, c.jsonMode], [true, true]);
  });
  await withServer({ strictJson: true, fenced: true }, async (s) => {
    const c = await probeChat(s.base, 'secret', 'chat-model');
    assert.equal(c.ok, true, 'fenced JSON after a sentence still parses');
    assert.equal(c.jsonMode, false, 'and we know the server ignores or rejects response_format');
  });
});

test('probeStt uploads multipart, and says whether timestamps were really checked', async () => {
  await withServer({}, async (s) => {
    const tone = await probeStt(s.base, 'secret', 'whisper-turbo', null);
    assert.equal(tone.ok, true);
    assert.equal(tone.timestampsChecked, false, 'a synthetic tone proves nothing about timestamps');
    assert.match(s.seen.at(-1).ctype, /^multipart\/form-data/);
    const real = await probeStt(s.base, 'secret', 'whisper-turbo', new Uint8Array([1, 2, 3]));
    assert.deepEqual([real.ok, real.timestampsChecked, real.hasTimestamps, real.segments], [true, true, true, 2]);
  });
  await withServer({ timestamps: false }, async (s) => {
    const r = await probeStt(s.base, 'secret', 'w', new Uint8Array([1]));
    assert.deepEqual([r.ok, r.hasTimestamps], [true, false]);
  });
  await withServer({ sttStatus: 404 }, async (s) => assert.match((await probeStt(s.base, 'secret', 'w', null)).error, /404/));
});

test('.dev.vars: parsed, merged without touching other lines, replaced (not duplicated) on re-run', () => {
  const before = '# my notes\nOPENAI_API_KEY=sk-keep\nLLM_MODELS=old\nPOCKET_API_KEY=pk_x\n';
  const vars = buildLocalVars({ base: 'http://localhost:8000/v1', key: 'k', chat: 'c1', embed: 'e1', stt: 'w1', diarize: true, contextTokens: 32768 });
  const once = mergeDevVars(before, vars);
  const parsed = parseDevVars(once);
  assert.equal(parsed.OPENAI_API_KEY, 'sk-keep');
  assert.equal(parsed.POCKET_API_KEY, 'pk_x');
  assert.equal(parsed.LLM_MODELS, 'c1', 'the old value of a key we set is replaced');
  assert.equal((once.match(/LLM_MODELS=/g) || []).length, 1);
  assert.match(once, /# my notes/);
  const twice = mergeDevVars(once, { ...vars, DEFAULT_MODEL: 'c2' });
  assert.equal((twice.match(/Attest local mode \(written/g) || []).length, 1, 'one block, however many runs');
  assert.equal(parseDevVars(twice).DEFAULT_MODEL, 'c2');
  assert.equal(parseDevVars(mergeDevVars('', { A: '1' })).A, '1');
  assert.deepEqual(parseDevVars('X="quoted"\n# C=1\nbad line\nY = 2'), { X: 'quoted', Y: '2' });
});

test('buildLocalVars: only what was chosen, diarize and context sized sensibly', () => {
  const full = buildLocalVars({ base: 'http://l/v1', key: 'k', chat: 'c', embed: 'e', stt: 's', diarize: true, contextTokens: 16000 });
  assert.deepEqual([full.LOCAL_MODE, full.REQUIRE_ACCESS, full.LLM_MODELS, full.EMBED_MODEL, full.STT_MODELS, full.LOCAL_DIARIZE], ['true', 'false', 'c', 'e', 's', 'true']);
  assert.equal(full.STT_BASE_URL, 'http://l/v1');
  assert.equal(full.LLM_CONTEXT_CHARS, '48000');
  const bare = buildLocalVars({ base: 'http://l/v1', chat: 'c' });
  assert.equal(bare.EMBED_MODEL, undefined);
  assert.equal(bare.STT_MODELS, undefined);
  assert.equal(bare.LOCAL_DIARIZE, undefined);
  assert.equal(bare.LLM_API_KEY, 'local');
  const other = buildLocalVars({ base: 'http://l/v1', chat: 'c', stt: 's', sttBase: 'http://whisper/v1', sttKey: 'w' });
  assert.deepEqual([other.STT_BASE_URL, other.STT_API_KEY], ['http://whisper/v1', 'w']);
});

test('local:check reads .dev.vars and tests each capability against the server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attest-'));
  const file = join(dir, '.dev.vars');
  const write = (s, vars) => writeFileSync(file, mergeDevVars('', buildLocalVars({ base: s.base, key: 'secret', chat: 'chat-model', embed: 'bge-embed', stt: 'whisper-turbo', diarize: true, ...vars })));

  await withServer({}, async (s) => {
    write(s);
    const r = await check({ file, log: false });
    assert.equal(r.ok, true, JSON.stringify(r.items.filter((i) => !i.pass)));
    assert.deepEqual(r.items.map((i) => i.name.replace(/".*?"/g, '""')), ['server ' + s.base, 'chat model "" is installed', 'chat model answers in JSON', 'embedding model ""', 'transcription model ""']);
  });
  await withServer({ timestamps: false }, async (s) => {
    write(s);
    const sample = join(dir, 'speech.wav');
    writeFileSync(sample, Buffer.from([1, 2, 3, 4]));
    const r = await check({ file, audio: sample, log: false });
    assert.equal(r.ok, false, 'with a real sample and no timestamps back, speaker detection cannot work');
  });
  await withServer({}, async (s) => {
    write(s, { chat: 'not-installed' });
    const r = await check({ file, log: false });
    assert.equal(r.items.find((i) => i.name.includes('is installed')).pass, false);
  });
  await withServer({}, async (s) => {
    writeFileSync(file, mergeDevVars('', buildLocalVars({ base: s.base, key: 'WRONG', chat: 'chat-model' })));
    const r = await check({ file, log: false });
    assert.equal(r.ok, false);
    assert.match(r.items[0].detail, /API key/);
  });
  writeFileSync(file, 'OPENAI_API_KEY=sk-x\n');
  assert.equal((await check({ file, log: false })).ok, false, 'not local mode');
  assert.equal((await check({ file: join(dir, 'missing'), log: false })).ok, false);
  assert.match(readFileSync(file, 'utf8'), /sk-x/);
});

test('the setup script leads with the recommended models, sizes and purposes, so they can be downloaded first', () => {
  const text = recommendationsText();
  for (const r of Object.values(RECOMMENDED)) { assert.ok(text.includes(r.id), r.id); assert.ok(text.includes(r.size), r.size); }
  assert.match(text, /Chat is required/);
  assert.match(text, /Embeddings are optional/);
  assert.match(text, /embeddinggemma-300m-4bit/, 'the fallback embedding model is named');
  assert.match(text, /timestamps/, 'says why Whisper is wanted');
  assert.ok(text.indexOf('Chat') < text.indexOf('Transcription') && text.indexOf('Transcription') < text.indexOf('Embeddings'));
});

test('recommendedIndex finds an installed copy of each recommended model by name, and reports what is missing', () => {
  const ids = ['some-other', 'mlx-community/whisper-large-v3-turbo-asr-4bit', 'GPT-OSS-20B-mxfp4', 'bge-small'];
  assert.equal(recommendedIndex(ids, 'chat'), 3, 'matches whatever the repo is called, case-insensitive');
  assert.equal(recommendedIndex(ids, 'stt'), 2);
  assert.equal(recommendedIndex(ids, 'embedding'), 0, 'bge-small is an embedder but not the recommended one');
  assert.deepEqual(missingRecommended(ids), ['embedding']);
  assert.deepEqual(missingRecommended([]), ['chat', 'stt', 'embedding']);
  assert.deepEqual(missingRecommended(['gpt-oss-20b', 'whisper-large-v3-turbo-asr-fp16', 'Qwen3-Embedding-0.6B-4bit-DWQ']), []);
  assert.equal(recommendedIndex(ids, 'nope'), 0);
});

test('the recommended Whisper is the "-asr" build that ships tokenizer files; plain MLX conversions are not marked recommended', () => {
  assert.match(RECOMMENDED.stt.id, /whisper-large-v3-turbo-asr/);
  assert.match(recommendationsText(), /-asr/);
  assert.equal(recommendedIndex(['mlx-community/whisper-large-v3-turbo-4bit', 'mlx-community/whisper-large-v3-turbo'], 'stt'), 0, 'neither of those loads in oMLX');
  assert.equal(recommendedIndex(['x', 'mlx-community/whisper-large-v3-turbo-asr-4bit'], 'stt'), 2);
});

test('explainSttError turns the real oMLX load failure into the fix, with the model folder filled in', () => {
  const real = `HTTP 500: {"error":{"message":"Model 'whisper-large-v3-turbo-4bit' is unavailable after a previous load failure: STT model '/Users/me/.omlx/models/mlx-community/whisper-large-v3-turbo-4bit' is missing the HuggingFace processor / feature-extractor configuration (preprocessor_config.json and/or tokenizer files). MLX-converted repositories sometimes omit these."}}`;
  const fix = explainSttError(real);
  assert.match(fix, /cd "\/Users\/me\/\.omlx\/models\/mlx-community\/whisper-large-v3-turbo-4bit"/);
  for (const f of WHISPER_PROCESSOR_FILES) assert.ok(fix.includes(f), f);
  assert.match(fix, /openai\/whisper-large-v3-turbo\/resolve\/main/);
  assert.match(fix, /whisper-large-v3-turbo-asr-fp16/);
  assert.match(fix, /npm run local:check/);
  assert.match(explainSttError('missing the HuggingFace processor / feature-extractor configuration'), /copy the tokenizer and processor files/, 'no folder in the message: generic advice');
  const gone = explainSttError('HTTP 404: {"error":{"message":"Model \'whisper-large-v3-turbo-4bit\' not found. Available: Qwen3.8-27B-4bit, Qwen3-Embedding-0.6B-4bit-DWQ","type":"not_found_error"}}');
  assert.match(gone, /does not have "whisper-large-v3-turbo-4bit" installed/);
  assert.match(gone, /It has: Qwen3\.8-27B-4bit, Qwen3-Embedding-0\.6B-4bit-DWQ\./);
  assert.match(gone, /whisper-large-v3-turbo-asr-fp16/);
  assert.equal(explainSttError('HTTP 404: no such model'), null);
  assert.equal(explainSttError(''), null);
  assert.equal(explainSttError(undefined), null);
});

test('local:check prints the fix when transcription fails to load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attest-'));
  const file = join(dir, '.dev.vars');
  await withServer({ sttStatus: 500, sttError: "STT model '/m/whisper-4bit' is missing the HuggingFace processor / feature-extractor configuration (preprocessor_config.json and/or tokenizer files)." }, async (s) => {
    writeFileSync(file, mergeDevVars('', buildLocalVars({ base: s.base, key: 'secret', chat: 'chat-model', stt: 'whisper-turbo' })));
    const r = await check({ file, log: false });
    assert.equal(r.ok, false);
    assert.match(r.fix, /cd "\/m\/whisper-4bit"/);
  });
});

test('deploy config merge: a local name replaces the Worker name, the vector index is overridable, and the wizard keeps both', async () => {
  const { mergeConfig, localOverrides, overrideLines, DEFAULT_VECTOR_INDEX, vectorToml } = await import('../scripts/lib/merge.mjs');
  const base = 'name = "attest"\nmain = "src/index.js"\n';
  const plain = 'routes = [{ pattern = "a.example.com", custom_domain = true }]\n';
  assert.equal(mergeConfig(plain, base), plain + '\n' + base, 'no override: the base name stays');
  const legacy = plain + 'name = "old-worker"\n# vectorize_index = old-index\n';
  const merged = mergeConfig(legacy, base, 'old-index');
  assert.equal((merged.match(/^name\s*=/gm) || []).length, 1, 'TOML allows one name');
  assert.match(merged, /name = "old-worker"/);
  assert.doesNotMatch(merged, /attest"/);
  assert.match(merged, /index_name = "old-index"/);
  assert.deepEqual(localOverrides(legacy), { name: 'old-worker', vectorIndex: 'old-index' });
  assert.deepEqual(localOverrides(plain), { name: '', vectorIndex: '' });
  assert.equal(overrideLines(legacy), 'name = "old-worker"\n# vectorize_index = old-index');
  assert.equal(overrideLines(plain), '');
  assert.equal(DEFAULT_VECTOR_INDEX, 'attest-memory');
  assert.match(vectorToml(DEFAULT_VECTOR_INDEX), /index_name = "attest-memory"/);
  assert.equal(mergeConfig('', base), base, 'no local file: just the base');
});
