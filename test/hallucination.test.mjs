import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, cleanSegments, guardOn, dropRepeatedRuns } from '../src/hallucination.js';

test('drops long repeated runs, keeps speech', () => {
  const t = 'Hello there. ' + 'Thank you. '.repeat(30) + 'Let us start the exam.';
  assert.equal(cleanText(t, ''), 'Hello there. Let us start the exam.');
});
test('keeps short natural repeats', () => {
  assert.equal(dropRepeatedRuns('no no no it is fine'), 'no no no it is fine');
});
test('English expected drops other scripts', () => {
  assert.equal(cleanText('я я не а Good morning 静 か に doctor', 'en'), 'Good morning doctor');
  assert.match(cleanText('Привет friend', ''), /Привет/);
});
test('segments: empty turns removed', () => {
  const out = cleanSegments([{ speaker: 'A', text: 'Good morning. '.repeat(20) }, { speaker: 'B', text: 'Real words' }], 'en');
  assert.deepEqual(out.map((s) => s.text), ['Real words']);
});
test('guard defaults on, off only when set', () => {
  assert.equal(guardOn({}), true);
  assert.equal(guardOn({ HALLUCINATION_GUARD: 'off' }), false);
});
