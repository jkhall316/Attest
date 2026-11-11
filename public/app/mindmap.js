// Mind maps on a dedicated dark canvas: Topic / Driver / People tabs, zoom, fit, and
// export as SVG or PNG. Each panel is drawn once, when first visible (a hidden panel has no
// size to fit to). The outline is LLM output, so "<" is escaped before markmap parses it as
// markdown (which would otherwise render raw HTML).

import { $, esc } from './dom.js';
import { icon } from './icons.js';

const ORIENT = [['topic', 'Topic'], ['driver', 'Driver'], ['people', 'People']];
const instances = new Map();

const available = (mm) => ORIENT.filter(([k]) => mm?.[k]);

export function mindmapCard(mindmaps) {
  const mm = (mindmaps && Object.keys(mindmaps).length) ? mindmaps : null;
  const avail = available(mm);
  if (!avail.length) return '';
  const tabs = avail.map(([k, label], i) => `<button class="mm-tab${i === 0 ? ' active' : ''}" data-k="${k}" role="tab">${label}</button>`).join('');
  const panels = avail.map(([k], i) => `<div class="markmap" data-k="${k}" style="${i === 0 ? '' : 'display:none'}"></div>`).join('');
  return `<h3>Mind map</h3><div class="card-box mm-card">
    <div class="mm-bar"><div class="mm-tabs" role="tablist">${tabs}</div>
      <div class="mm-tools">
        <button class="ghost icon" id="mm-out" title="Zoom out" aria-label="Zoom out">${icon('zoomOut', 17)}</button>
        <button class="ghost icon" id="mm-in" title="Zoom in" aria-label="Zoom in">${icon('zoomIn', 17)}</button>
        <button class="ghost icon" id="mm-fit" title="Fit to view" aria-label="Fit to view">${icon('fit', 17)}</button>
        <button class="ghost small" id="mm-svg" title="Download as SVG">${icon('download', 14)} SVG</button>
        <button class="ghost small" id="mm-png" title="Download as PNG">${icon('download', 14)} PNG</button>
      </div></div>
    ${panels}
    <div class="mm-hint">Scroll or pinch to zoom, drag to pan.</div></div>`;
}

async function draw(panel, text) {
  if (!text || panel.dataset.drawn) return;
  panel.dataset.drawn = '1';
  try {
    const loader = window.markmap?.autoLoader;
    await loader?.ready;
    const { Transformer, Markmap, deriveOptions } = window.markmap;
    const { root, frontmatter } = new Transformer().transform(String(text).replace(/</g, '&lt;'));
    panel.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'width:100%;height:100%');
    panel.appendChild(svg);
    const mm = Markmap.create(svg, { embedGlobalCSS: false, ...(deriveOptions ? deriveOptions(frontmatter?.markmap) : {}) });
    await mm.setData(root);
    await mm.fit();
    instances.set(panel.dataset.k, mm);
  } catch (e) {
    console.warn('mind map:', e);
    panel.dataset.drawn = '';
  }
}

const activePanel = () => [...document.querySelectorAll('.markmap[data-k]')].find((p) => p.style.display !== 'none');

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// The visible map as a standalone SVG: markmap's own stylesheet is inlined so it renders
// the same outside the page, on the same dark canvas.
function svgOf(panel) {
  const svg = panel?.querySelector('svg');
  if (!svg) return null;
  const { width, height } = svg.getBoundingClientRect();
  const c = svg.cloneNode(true);
  c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  c.setAttribute('width', Math.round(width)); c.setAttribute('height', Math.round(height));
  c.setAttribute('viewBox', `0 0 ${Math.round(width)} ${Math.round(height)}`);
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `${window.markmap?.globalCSS || ''} .markmap-foreign, .markmap-foreign * { color:#f4f4f5; font:14px system-ui,sans-serif }`;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#09090b');
  c.prepend(style, bg);
  return { xml: new XMLSerializer().serializeToString(c), width: Math.round(width), height: Math.round(height) };
}

export function wireMindmaps(mindmaps, title = 'mind-map') {
  instances.clear();
  const panels = [...document.querySelectorAll('.markmap[data-k]')];
  if (!panels.length) return;
  const first = panels.find((p) => p.style.display !== 'none');
  if (first) draw(first, mindmaps?.[first.dataset.k]);
  document.querySelectorAll('.mm-tab').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.mm-tab').forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((p) => {
        const on = p.dataset.k === btn.dataset.k;
        p.style.display = on ? '' : 'none';
        if (on) draw(p, mindmaps?.[p.dataset.k]).then(() => instances.get(p.dataset.k)?.fit());
      });
    };
  });
  const mm = () => instances.get(activePanel()?.dataset.k);
  $('mm-in').onclick = () => mm()?.rescale(1.3);
  $('mm-out').onclick = () => mm()?.rescale(1 / 1.3);
  $('mm-fit').onclick = () => mm()?.fit();
  const fname = (ext) => `${String(title).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'mind-map'}-${activePanel()?.dataset.k || 'map'}.${ext}`;
  $('mm-svg').onclick = () => { const s = svgOf(activePanel()); if (s) download(fname('svg'), new Blob([s.xml], { type: 'image/svg+xml' })); };
  $('mm-png').onclick = () => {
    const s = svgOf(activePanel());
    if (!s) return;
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = s.width * 2; cv.height = s.height * 2;
        const ctx = cv.getContext('2d'); ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
        cv.toBlob((b) => b && download(fname('png'), b), 'image/png');
      } catch { alert('This browser would not render the map to PNG. Use the SVG download instead.'); }
    };
    img.onerror = () => alert('Could not render the map to PNG. Use the SVG download instead.');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.xml);
  };
}
