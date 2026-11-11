// DOM + escaping helpers. Everything that touches innerHTML goes through esc().

export const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

// ponytail: minimal markdown renderer. Swap for marked+DOMPurify if you ever
// render transcripts from anyone but your own LLM. Everything is escaped FIRST, then block
// structure (headings, lists, paragraphs) and **bold** / `code` are added on top, so model
// output can never inject markup.
const inline = (t) => t
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>')   // models often write *italic* with single asterisks
  .replace(/`([^`]+)`/g, '<code>$1</code>');

export const md = (src) => {
  const lines = esc(src).split('\n');
  const out = [];
  let list = null; // {tag, items, start}
  let para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}${list.tag === 'ol' && list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flushPara(); continue; } // a blank line does not end a list: models put them between bullets
    if ((m = line.match(/^#{1,6} (.+)$/))) { flushPara(); flushList(); out.push(`<p class="md-h"><strong>${inline(m[1])}</strong></p>`); continue; }
    if ((m = line.match(/^\s*(?:[-*]|- \[ \]) (.+)$/))) {
      flushPara();
      if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]); continue;
    }
    if ((m = line.match(/^\s*(\d+)\. (.+)$/))) {
      flushPara();
      if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [], start: Number(m[1]) }; }
      list.items.push(m[2]); continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
};
