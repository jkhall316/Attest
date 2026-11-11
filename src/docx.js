// Minimal WordprocessingML (.docx) writer. No template engine: three XML parts
// built by string concatenation, zipped STORED via ./zip.js. Mirrors the content
// shape of recordingToMarkdown() in src/text.js (title, metadata, summary,
// action items, mind maps, transcript) but emits <w:p> paragraphs instead of markdown.

import { zip } from './zip.js';
import { TEMPLATES } from './templates.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MINDMAP_ORIENTATIONS = [['topic', 'Topic'], ['driver', 'Driver'], ['people', 'People']];
const INDENT_PER_DEPTH = 360; // twips (~0.25in) per nested outline level

// XML 1.0 forbids most control characters outright; one stray \x0b in a transcript would
// make Word call the whole file corrupt.
const XML_INVALID = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g;

function escapeXml(s) {
  return String(s).replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeParse(v) {
  try { return JSON.parse(v); } catch { return null; }
}

// Back-compat: old rows only have the single `mindmap` column (stored as the topic tree).
function mindmapsOf(r) {
  const raw = typeof r.mindmaps === 'string' ? safeParse(r.mindmaps) : r.mindmaps;
  return (raw && Object.keys(raw).length ? raw : null) || (r.mindmap ? { topic: r.mindmap } : null);
}

// A single <w:r><w:t>...</w:t></w:r>. xml:space="preserve" only when the text
// has leading/trailing whitespace Word would otherwise collapse.
function run(text, rPr = '') {
  const t = String(text ?? '');
  const preserve = /^\s|\s$/.test(t) ? ' xml:space="preserve"' : '';
  return `<w:r>${rPr}<w:t${preserve}>${escapeXml(t)}</w:t></w:r>`;
}

// One paragraph. `indentLeft` is written even when 0 so sibling paragraphs at
// different outline depths always carry a distinguishable w:ind value.
function para(text, { style, indentLeft, muted } = {}) {
  const pprParts = [];
  if (style) pprParts.push(`<w:pStyle w:val="${style}"/>`);
  if (indentLeft !== undefined) pprParts.push(`<w:ind w:left="${indentLeft}"/>`);
  const pPr = pprParts.length ? `<w:pPr>${pprParts.join('')}</w:pPr>` : '';
  const rPr = muted ? '<w:rPr><w:i/><w:color w:val="666666"/></w:rPr>' : '';
  return `<w:p>${pPr}${run(text, rPr)}</w:p>`;
}

// Split on newlines; every line becomes its own <w:p> (never a raw newline in <w:t>).
function paragraphs(text, opts) {
  return String(text ?? '').split('\n').map((line) => para(line, opts)).join('');
}

// Plain-text rendering of markdown: drop a leading "#..." heading marker and paired
// **bold** / __bold__ / *em* markers. Lone _ * # are left alone so "my_file.txt" and
// "C#" survive. Not a markdown renderer.
function stripMd(line) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/^(\s*)\*\s+/, '$1- ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\W)__(.+?)__(?=\W|$)/g, '$1$2')
    .replace(/(^|\W)\*(\S(?:.*?\S)?)\*(?=\W|$)/g, '$1$2')
    .trim();
}

function summaryParagraphs(text) {
  return String(text ?? '').split('\n').map((line) => para(stripMd(line))).join('');
}

// Outline depth comes from the leading whitespace in front of a "-" bullet
// (2 spaces per level); heading lines ("#", "##") sit at depth 0.
function mindmapParagraphs(text) {
  return String(text ?? '').split('\n').map((raw) => {
    const bullet = raw.match(/^(\s*)-\s?/);
    const depth = bullet ? Math.floor(bullet[1].length / 2) : 0;
    const rest = bullet ? raw.slice(bullet[0].length) : raw;
    return para(stripMd(rest), { indentLeft: depth * INDENT_PER_DEPTH });
  }).join('');
}

function actionItemParagraphs(items) {
  return items.map((a) => {
    const meta = [a.owner, a.due].filter(Boolean).join(', ');
    return para(`\u2610 ${a.task}${meta ? ` \u2014 ${meta}` : ''}`);
  }).join('');
}

function buildBody(recording, labels) {
  const parts = [para(String(recording.title).replace(/\s+/g, ' '), { style: 'Heading1' })];

  const date = new Date(recording.created_at).toISOString().slice(0, 16).replace('T', ' ');
  const templateLabel = (labels || TEMPLATES)[recording.template]?.label || recording.template;
  parts.push(para(`${date} \u00b7 ${templateLabel}`, { muted: true }));

  if (recording.summary) {
    parts.push(para('Summary', { style: 'Heading2' }));
    parts.push(summaryParagraphs(recording.summary));
  }

  const items = typeof recording.action_items === 'string'
    ? safeParse(recording.action_items)
    : recording.action_items;
  if (items?.length) {
    parts.push(para('Action items', { style: 'Heading2' }));
    parts.push(actionItemParagraphs(items));
  }

  const mm = mindmapsOf(recording);
  for (const [key, label] of MINDMAP_ORIENTATIONS) {
    if (mm?.[key]) {
      parts.push(para(`Mind map \u2014 ${label}`, { style: 'Heading2' }));
      parts.push(mindmapParagraphs(mm[key]));
    }
  }

  if (recording.transcript) {
    parts.push(para('Transcript', { style: 'Heading2' }));
    parts.push(paragraphs(recording.transcript));
  }

  parts.push('<w:sectPr/>');
  return parts.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// Build a minimal .docx (WordprocessingML) package for one recording row.
// `recording` is the shape readRow() in src/db.js returns: title, created_at,
// template, summary, action_items (array or JSON string), mindmaps
// ({topic,driver,people} or null), legacy mindmap (string), transcript.
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// Without this part Heading1/Heading2 resolve to nothing and headings render as body text.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;

export function docx(recording, labels) {
  if (!recording || !recording.title) {
    throw new Error('docx() requires a recording with a title');
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${buildBody(recording, labels)}</w:body></w:document>`;

  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
  ]);
}
