import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, zip } from '../src/zip.js';

function hasUnzip() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('crc32 matches the known "123456789" check vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('crc32 of empty input is 0', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zip() of two small files has local headers, central dir, and a valid EOCD', () => {
  const out = zip([
    { name: 'a.txt', data: 'hello' },
    { name: 'b.txt', data: new TextEncoder().encode('world') },
  ]);

  assert.equal(out[0], 0x50); // 'P'
  assert.equal(out[1], 0x4b); // 'K'
  assert.equal(out[2], 0x03);
  assert.equal(out[3], 0x04);

  const centralSig = findSig(out, [0x50, 0x4b, 0x01, 0x02]);
  assert.notEqual(centralSig, -1, 'central directory signature found');

  // EOCD is the last 22 bytes (no comment is written).
  const eocd = out.subarray(out.length - 22);
  assert.equal(eocd[0], 0x50);
  assert.equal(eocd[1], 0x4b);
  assert.equal(eocd[2], 0x05);
  assert.equal(eocd[3], 0x06);

  const view = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  const totalEntries = view.getUint16(10, true);
  assert.equal(totalEntries, 2);
});

test('zip() is deterministic across calls', () => {
  const entries = [
    { name: 'one.txt', data: 'one' },
    { name: 'two.txt', data: 'two' },
  ];
  const a = zip(entries);
  const b = zip(entries);
  assert.deepEqual([...a], [...b]);
});

test('sanitizes a path traversal attempt', () => {
  const out = zip([{ name: '../etc/passwd', data: 'x' }]);
  const name = extractFirstName(out);
  assert.ok(!name.includes('..'), `expected no ".." segment, got ${name}`);
});

test('sanitizes characters illegal on Windows', () => {
  const out = zip([{ name: 'a<b>c.txt', data: 'x' }]);
  const name = extractFirstName(out);
  assert.ok(!name.includes('<') && !name.includes('>'), `expected no angle brackets, got ${name}`);
});

test('deduplicates colliding names with a " (2)" suffix', () => {
  const out = zip([
    { name: 'a.txt', data: 'one' },
    { name: 'a.txt', data: 'two' },
  ]);
  const names = extractAllNames(out);
  assert.deepEqual(names, ['a.txt', 'a (2).txt']);
});

test('empty entry list produces a 22-byte EOCD-only zip', () => {
  const out = zip([]);
  assert.equal(out.length, 22);
  assert.equal(out[0], 0x50);
  assert.equal(out[1], 0x4b);
  assert.equal(out[2], 0x05);
  assert.equal(out[3], 0x06);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(view.getUint16(10, true), 0);
});

test('throws on more than 65535 entries', () => {
  const entries = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
  assert.throws(() => zip(entries), /65535/);
});

test('zip -t validates the archive when unzip is available on PATH', { skip: !hasUnzip() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  const file = join(dir, 'out.zip');
  try {
    const out = zip([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.txt', data: 'world' },
    ]);
    writeFileSync(file, out);
    const result = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(result, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- test helpers (not exported from src/zip.js) -----------------------

function findSig(bytes, sig) {
  outer: for (let i = 0; i <= bytes.length - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (bytes[i + j] !== sig[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Reads the filename out of the first local file header (offset 0).
function extractFirstName(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = view.getUint16(26, true);
  const nameBytes = bytes.subarray(30, 30 + nameLen);
  return new TextDecoder().decode(nameBytes);
}

// Walks every local file header from offset 0, following compressed-size-based
// jumps, and returns the filenames in order.
function extractAllNames(bytes) {
  const names = [];
  let offset = 0;
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const sig = view.getUint32(0, true);
    if (sig !== 0x04034b50) break;
    const compressedSize = view.getUint32(18, true);
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    const nameBytes = bytes.subarray(offset + 30, offset + 30 + nameLen);
    names.push(new TextDecoder().decode(nameBytes));
    offset += 30 + nameLen + extraLen + compressedSize;
  }
  return names;
}

test('dedupes names case-insensitively (case-insensitive disks would overwrite)', () => {
  const names = extractAllNames(zip([
    { name: 'Standup.docx', data: 'a' },
    { name: 'standup.docx', data: 'b' },
  ]));
  assert.equal(names.length, 2);
  assert.notEqual(names[0].toLowerCase(), names[1].toLowerCase());
  assert.ok(names.every((n) => n.endsWith('.docx')));
});

// Runs in a child process with a hard timeout: a regression here is an infinite loop in
// the dedupe (suffix truncated away by the 255-byte fit), which would hang the whole suite.
test('over-long names are fitted to 255 bytes, keep the extension, and stay unique after dedupe', () => {
  const script = `
    import { zip } from ${JSON.stringify(new URL('../src/zip.js', import.meta.url).href)};
    const long = 'x'.repeat(300);
    const out = zip([{ name: long + '.docx', data: 'a' }, { name: long + '.docx', data: 'b' }]);
    const names = []; let o = 0;
    while (o < out.length) {
      const v = new DataView(out.buffer, out.byteOffset + o);
      if (v.getUint32(0, true) !== 0x04034b50) break;
      const n = v.getUint16(26, true);
      names.push(new TextDecoder().decode(out.subarray(o + 30, o + 30 + n)));
      o += 30 + n + v.getUint32(18, true);
    }
    console.log(JSON.stringify(names));`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  const names = JSON.parse(stdout);
  assert.equal(names.length, 2);
  for (const n of names) {
    assert.ok(new TextEncoder().encode(n).length <= 255, 'name exceeds 255 bytes');
    assert.ok(n.endsWith('.docx'), 'extension lost');
  }
  assert.notEqual(names[0], names[1]);
});
