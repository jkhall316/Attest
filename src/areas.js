// Areas: a coarse life/work split for recordings (#5). One per recording, auto-chosen from the
// template group and then from the content, always changeable by hand (area_source = 'manual'
// then protects it from every later automatic pass).

import { TEMPLATES } from './templates.js';

export const AREAS = ['work', 'personal', 'health', 'learning'];
export const DEFAULT_AREA = 'work';

// Template group -> area. 'custom' (and anything unknown) has no opinion.
const GROUP_AREA = {
  work: 'work', sales: 'work', people: 'work',
  personal: 'personal', media: 'personal',
  health: 'health',
  education: 'learning', research: 'learning',
};

// A valid area, or '' (so `All`, missing and junk values all mean "no filter").
export const normalizeArea = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return AREAS.includes(s) ? s : '';
};

// The area a builtin template implies, or '' for custom/unknown templates.
export const areaForTemplate = (key) => GROUP_AREA[TEMPLATES[key]?.group] || '';

// SQL for "only this area". `col` is the column (with table alias if joined). Empty = all areas.
export const areaClause = (area, col = 'area') => {
  const a = normalizeArea(area);
  return a ? { sql: ` AND ${col} = ?`, binds: [a] } : { sql: '', binds: [] };
};

// Initial area for a new recording: an explicit valid choice is manual; otherwise infer.
export function initialArea(explicit, templateKey) {
  const manual = normalizeArea(explicit);
  if (manual) return { area: manual, area_source: 'manual' };
  return { area: areaForTemplate(templateKey) || DEFAULT_AREA, area_source: 'auto' };
}
