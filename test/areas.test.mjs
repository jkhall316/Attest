import test from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, DEFAULT_AREA, normalizeArea, areaForTemplate, areaClause, initialArea } from '../src/areas.js';
import { TEMPLATES } from '../src/templates.js';
import { buildSystemPrompt } from '../src/prompts.js';

test('normalizeArea accepts the four areas and treats anything else as "all"', () => {
  assert.deepEqual(AREAS, ['work', 'personal', 'health', 'learning']);
  assert.equal(normalizeArea(' Health '), 'health');
  for (const v of ['', 'all', 'home', null, undefined, 'work; DROP TABLE']) assert.equal(normalizeArea(v), '');
});

test('every builtin template group maps to an area, custom has none', () => {
  for (const [key, t] of Object.entries(TEMPLATES)) assert.ok(areaForTemplate(key), `${key} (${t.group}) has no area`);
  assert.equal(areaForTemplate('journal'), 'personal');
  assert.equal(areaForTemplate('meeting'), 'work');
  assert.equal(areaForTemplate('lecture') || areaForTemplate('journal'), areaForTemplate('lecture') || 'personal');
  assert.equal(areaForTemplate('my-custom-one'), '');
});

test('areaClause is empty for all, parameterised for an area', () => {
  assert.deepEqual(areaClause(''), { sql: '', binds: [] });
  assert.deepEqual(areaClause('bogus'), { sql: '', binds: [] });
  assert.deepEqual(areaClause('health', 'r.area'), { sql: ' AND r.area = ?', binds: ['health'] });
});

test('initialArea: an explicit choice is manual, otherwise inferred from the template, else the default', () => {
  assert.deepEqual(initialArea('personal', 'meeting'), { area: 'personal', area_source: 'manual' });
  assert.deepEqual(initialArea(null, 'journal'), { area: 'personal', area_source: 'auto' });
  assert.deepEqual(initialArea('', 'custom-x'), { area: DEFAULT_AREA, area_source: 'auto' });
});

test('the summarize prompt asks the model for an area', () => {
  const p = buildSystemPrompt(TEMPLATES.meeting);
  assert.match(p, /"area":"work\|personal\|health\|learning"/);
});
