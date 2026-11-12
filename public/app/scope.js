// The area filter (#5): All / Work / Personal / Health / Learning. Stored only in this browser,
// like "Speaking as". '' means all areas. The server treats a missing or unknown area as all.

import { $ } from './dom.js';
import { state } from './state.js';

export const AREAS = [['work', 'Work'], ['personal', 'Personal'], ['health', 'Health'], ['learning', 'Learning']];
export const areaLabel = (a) => AREAS.find(([k]) => k === a)?.[1] || '';

const KEY = 'attest.area';

export const getArea = () => {
  try { const v = localStorage.getItem(KEY) || ''; return AREAS.some(([k]) => k === v) ? v : ''; } catch { return ''; }
};
export const setArea = (v) => { try { localStorage.setItem(KEY, AREAS.some(([k]) => k === v) ? v : ''); } catch { /* private window */ } };

// "?area=work" / "&area=work" to append to a URL, or '' when showing everything.
export const areaQuery = (lead = '?') => (getArea() ? `${lead}area=${getArea()}` : '');

export function renderScope() {
  const sel = $('area-scope');
  if (!sel) return;
  sel.innerHTML = `<option value="">All areas</option>${AREAS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}`;
  sel.value = getArea();
}

// onChange runs after the choice is saved, so the screen in view can reload.
export function wireScope(onChange) {
  renderScope();
  $('area-scope').onchange = (e) => { setArea(e.target.value); state.areaChanged = true; onChange(); };
}
