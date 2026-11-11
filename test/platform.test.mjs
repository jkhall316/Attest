// scripts/lib/platform.mjs and the Windows/Linux model recommendations. Every case passes the
// platform explicitly, so this file checks Mac, Windows and Linux behaviour on any OS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain, npxSpawn, machineLabel, defaultPorts } from '../scripts/lib/platform.mjs';
import {
  RECOMMENDED, RECOMMENDED_PC, recommendedFor, suggestedModels, recommendationsText, recommendedIndex, missingRecommended,
} from '../scripts/lib/omlx.mjs';

test('isMain matches the script it was started as, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attest-main-'));
  const file = join(dir, 'script.mjs'), other = join(dir, 'other.mjs');
  writeFileSync(file, ''); writeFileSync(other, '');
  const url = pathToFileURL(file).href;
  assert.equal(isMain(url, file), true);
  assert.equal(isMain(url, other), false);
  assert.equal(isMain(url, ''), false, 'no argv[1] (a REPL, -e) is never main');
  if (process.platform === 'win32') assert.notEqual(url, `file://${file}`, 'the old check could never match on Windows');
});

// Needs a real Windows filesystem: elsewhere a case-flipped path is a different (missing) file.
test('isMain ignores drive-letter and file-name case on Windows', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'attest-case-'));
  const file = join(dir, 'Script.mjs');
  writeFileSync(file, '');
  const url = pathToFileURL(file).href;
  const flipDrive = file.replace(/[A-Za-z]/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  assert.equal(isMain(url, flipDrive, 'win32'), true);
  assert.equal(isMain(url, join(dir, 'SCRIPT.MJS'), 'win32'), true);
});

test('npxSpawn: an args array on macOS/Linux, one quoted command line through a shell on Windows', () => {
  assert.deepEqual(npxSpawn(['wrangler', 'deploy'], 'darwin'), { command: 'npx', args: ['wrangler', 'deploy'], shell: false });
  assert.deepEqual(npxSpawn(['wrangler', 'deploy'], 'linux'), { command: 'npx', args: ['wrangler', 'deploy'], shell: false });
  const win = npxSpawn(['wrangler', 'deploy', '-c', '.wrangler.merged.toml', '--name', 'my app', 'say "hi"'], 'win32');
  assert.equal(win.shell, true);
  assert.deepEqual(win.args, [], 'no args array with shell:true (DEP0190)');
  assert.equal(win.command, 'npx wrangler deploy -c .wrangler.merged.toml --name "my app" "say ""hi"""');
  assert.equal(npxSpawn(['wrangler', 'deploy', 'C:\\My Dir\\'], 'win32').command, 'npx wrangler deploy "C:\\My Dir\\\\"', 'a trailing backslash must not escape the closing quote');
  assert.equal(npxSpawn(['wrangler', 'vectorize', 'create', 'attest-memory', '--dimensions=768', '--metric=cosine'], 'win32').command,
    'npx wrangler vectorize create attest-memory --dimensions=768 --metric=cosine');
});

test('machineLabel and defaultPorts follow the platform', () => {
  assert.equal(machineLabel('darwin'), 'this Mac');
  assert.equal(machineLabel('win32'), 'this computer');
  assert.equal(machineLabel('linux'), 'this computer');
  assert.equal(defaultPorts('darwin')[0], 8000, 'oMLX first on a Mac');
  assert.deepEqual(defaultPorts('win32').slice(0, 2), [1234, 11434], 'LM Studio, then Ollama, before Speaches\' 8000');
  for (const p of ['darwin', 'win32', 'linux']) assert.ok(defaultPorts(p).includes(1234) && defaultPorts(p).includes(11434), p);
});

test('recommendations: the Mac set by default, GGUF / Whisper-server models elsewhere', () => {
  assert.equal(recommendedFor(), RECOMMENDED, 'no platform: unchanged Mac behaviour');
  assert.equal(recommendedFor('darwin'), RECOMMENDED);
  assert.equal(recommendedFor('win32'), RECOMMENDED_PC);
  assert.equal(recommendedFor('linux'), RECOMMENDED_PC);
  assert.deepEqual(Object.keys(RECOMMENDED_PC), Object.keys(RECOMMENDED));
  for (const r of Object.values(RECOMMENDED_PC)) assert.doesNotMatch(r.id, /mlx/i, r.id);
  assert.equal(suggestedModels('win32').chat, RECOMMENDED_PC.chat.id);
  const text = recommendationsText('win32');
  for (const r of Object.values(RECOMMENDED_PC)) { assert.ok(text.includes(r.id), r.id); assert.ok(text.includes(r.size), r.size); }
  assert.match(text, /LM Studio or Ollama/);
  assert.doesNotMatch(text, /oMLX first/);
  assert.match(recommendationsText(), /oMLX/, 'Mac text unchanged');
});

test('recommendedIndex on Windows finds LM Studio and Ollama names for the same models', () => {
  const lmstudio = ['openai/gpt-oss-20b', 'text-embedding-qwen3-embedding-0.6b', 'qwen/qwen3-8b'];
  assert.equal(recommendedIndex(lmstudio, 'chat', 'win32'), 1);
  assert.equal(recommendedIndex(lmstudio, 'embedding', 'win32'), 2);
  const ollama = ['llama3.2:3b', 'gpt-oss:20b', 'qwen3-embedding:0.6b'];
  assert.equal(recommendedIndex(ollama, 'chat', 'win32'), 2);
  assert.equal(recommendedIndex(ollama, 'embedding', 'win32'), 3);
  assert.equal(recommendedIndex(['Systran/faster-whisper-large-v3'], 'stt', 'win32'), 1);
  assert.equal(recommendedIndex(['Systran/faster-whisper-small'], 'stt', 'win32'), 0);
  assert.deepEqual(missingRecommended(ollama, 'win32'), ['stt'], 'transcription is on a separate server');
  assert.deepEqual(missingRecommended(['Systran/faster-whisper-large-v3']), ['chat', 'stt', 'embedding'], 'no platform: judged by the Mac list, where only the -asr Whisper counts');
});
