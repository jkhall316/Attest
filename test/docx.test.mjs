import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docx } from '../src/docx.js';

function hasOnPath(bin) {
  try {
    execFileSync(bin, bin === 'unzip' ? ['-v'] : ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const baseRecording = () => ({
  title: 'Weekly sync',
  created_at: Date.UTC(2024, 0, 15, 9, 30),
  template: 'meeting',
  summary: '# Overview\n\nWe **shipped** the _export_ feature.',
  action_items: [{ task: 'Write docs', owner: 'Jess', due: '2024-01-20' }],
  mindmaps: {
    topic: '# Root\n- bullet\n  - nested bullet',
  },
  mindmap: null,
  transcript: 'Alex: hello\n\nJess: hi there',
});

test('docx() returns bytes starting with the ZIP local file header signature', () => {
  const out = docx(baseRecording());
  assert.equal(out[0], 0x50); // P
  assert.equal(out[1], 0x4b); // K
  assert.equal(out[2], 0x03);
  assert.equal(out[3], 0x04);
});

test('docx() is deterministic across calls with the same input', () => {
  const a = docx(baseRecording());
  const b = docx(baseRecording());
  assert.deepEqual([...a], [...b]);
});

test('docx() archive contains the required parts, including styles', () => {
  const out = docx(baseRecording());
  const names = extractAllNames(out);
  assert.deepEqual(
    [...names].sort(),
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'].sort()
  );
});

test('docx() throws a clear error when recording is missing or untitled', () => {
  assert.throws(() => docx(null), /title/);
  assert.throws(() => docx({}), /title/);
  assert.throws(() => docx({ title: '' }), /title/);
});

test('docx() XML-escapes the title and never emits raw angle brackets', () => {
  const out = docx({ ...baseRecording(), title: 'A & B <c>' });
  const xml = new TextDecoder().decode(out);
  assert.ok(xml.includes('A &amp; B &lt;c&gt;'), 'expected escaped title in the archive bytes');
  assert.ok(!xml.includes('<c>'), 'raw "<c>" must never appear in the document');
});

test('docx() renders action items with the checkbox marker and owner/due suffix', () => {
  const out = docx(baseRecording());
  const xml = new TextDecoder().decode(out);
  assert.ok(xml.includes('\u2610 Write docs'), 'expected a checkbox-prefixed task line');
  assert.ok(xml.includes('Jess, 2024-01-20'), 'expected owner and due date in the suffix');
});

test('docx() indents nested mind map bullets differently from top-level bullets', () => {
  const out = docx(baseRecording());
  const xml = new TextDecoder().decode(out);
  const indents = [...xml.matchAll(/<w:ind w:left="(\d+)"\/>/g)].map((m) => m[1]);
  assert.ok(indents.includes('0'), 'expected a depth-0 indent value');
  assert.ok(indents.some((v) => v !== '0'), 'expected a deeper, non-zero indent value');
  assert.notDeepEqual(new Set(indents).size, 1, 'expected more than one distinct indent value');
});

test('docx() defines the Heading1/Heading2 styles the body references', () => {
  const xml = new TextDecoder().decode(docx(baseRecording()));
  assert.ok(xml.includes('w:styleId="Heading1"') && xml.includes('w:styleId="Heading2"'));
  assert.ok(xml.includes('w:pStyle w:val="Heading1"'));
});

test('docx() uses the label map for custom templates, falling back to builtins', () => {
  const rec = { ...baseRecording(), template: 'court_hearing' };
  const labelled = new TextDecoder().decode(docx(rec, { court_hearing: { label: 'Court hearing' } }));
  assert.ok(labelled.includes('Court hearing'));
  const slug = new TextDecoder().decode(docx(rec));
  assert.ok(slug.includes('court_hearing'));
});

test('docx() stripMd keeps lone _ * # in legitimate text but drops paired emphasis', () => {
  const xml = new TextDecoder().decode(docx({
    ...baseRecording(),
    summary: 'See my_file_name.txt and C# notes. We **shipped** it.',
  }));
  assert.ok(xml.includes('my_file_name.txt'), 'underscores in a filename must survive');
  assert.ok(xml.includes('C# notes'), 'a lone # must survive');
  assert.ok(xml.includes('We shipped it.') && !xml.includes('**shipped**'));
});

test('docx() strips XML-invalid control characters and flattens title newlines', () => {
  const xml = new TextDecoder().decode(docx({
    ...baseRecording(), title: 'Line one\nLine two', transcript: 'bad\x0bchar\x00here',
  }));
  assert.ok(xml.includes('badcharhere'), 'control chars must be stripped, text kept');
  assert.ok(xml.includes('Line one Line two'));
});

test('unzip -t validates the archive when unzip is available on PATH', { skip: !hasOnPath('unzip') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'docx-test-'));
  const file = join(dir, 'out.docx');
  try {
    writeFileSync(file, docx(baseRecording()));
    const result = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(result, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('python3 zipfile.testzip() reports no bad entries when python3 is available', { skip: !hasOnPath('python3') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'docx-test-py-'));
  const file = join(dir, 'out.docx');
  try {
    writeFileSync(file, docx(baseRecording()));
    const result = execFileSync(
      'python3',
      ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip())`, file],
      { encoding: 'utf8' }
    ).trim();
    assert.equal(result, 'None');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- test helpers (not exported from src/docx.js) -----------------------

// Walks every local file header from offset 0, following compressed-size-based
// jumps, and returns the filenames in order (same approach as test/zip.test.mjs).
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
