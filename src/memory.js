// Structured memory (a small ontology of your conversations): durable facts pulled out of
// each recording and kept as rows, so "what has Ben promised me?" is a lookup, not a
// re-read of transcripts. Pure helpers only (validation, chunking, prompts); storage is in
// routes/memory.js and semantic indexing in vectors.js.
//
// The rule from speaker naming applies here too: a fact is kept only if its `quote` is a
// verbatim piece of the transcript. A model that paraphrases or invents loses the fact.

export const FACT_KINDS = ['commitment', 'decision', 'preference', 'relationship', 'fact'];
export const MAX_FACTS = 25;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const UNKNOWN = /^\s*(unknown|speaker|null|none|n\/a)\s*\d*\s*$/i;

// raw: whatever the model returned under "facts". Returns clean [{kind, person, text, quote}].
export function normalizeFacts(raw, transcript) {
  if (!Array.isArray(raw)) return [];
  const haystack = norm(transcript);
  const seen = new Set();
  const out = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const kind = String(f.kind || '').toLowerCase().trim();
    const text = String(f.text || '').replace(/\s+/g, ' ').trim();
    const quote = String(f.quote || '').replace(/\s+/g, ' ').trim();
    if (!FACT_KINDS.includes(kind) || !text || text.length > 300 || !quote || quote.length > 300) continue;
    if (!haystack.includes(norm(quote))) continue; // not verbatim: drop
    let person = f.person == null ? '' : String(f.person).trim();
    if (!person || person.length > 80 || UNKNOWN.test(person)) person = '';
    const key = `${kind}|${norm(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, person: person || null, text, quote });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

// The facts rules, shared by the summarize prompt (inline) and the backfill prompt.
export const FACT_RULES = [
  'Facts are durable things worth remembering about the people and the work, not a recap:',
  'commitment (someone promised to do something), decision (something was decided),',
  'preference (how a person likes to work or communicate), relationship (who someone is to',
  'the speakers), fact (a concrete date, number, plan or event).',
  '"person" is the person it is about or who made the commitment, only if the transcript names them, else null.',
  '"quote" MUST be copied word for word from the transcript (under 200 characters); a fact without an exact quote is discarded.',
  'At most 25 facts. Return [] if there is nothing durable. Never infer or invent.',
].join(' ');

export function factsSystemPrompt() {
  return [
    'You extract durable facts from a conversation transcript.',
    FACT_RULES,
    'Reply with ONLY JSON: {"facts":[{"kind":"commitment|decision|preference|relationship|fact","person":"Name"|null,"text":"<one short sentence>","quote":"<verbatim from the transcript>"}]}',
  ].join('\n');
}

// Splits text into overlapping chunks at whitespace, so each embeds one coherent passage.
export function chunkText(text, size = 900, overlap = 150, max = 120) {
  const t = String(text || '').replace(/[ \t]+/g, ' ').trim();
  const out = [];
  let i = 0;
  while (i < t.length && out.length < max) {
    let end = Math.min(t.length, i + size);
    if (end < t.length) {
      const cut = t.lastIndexOf(' ', end);
      if (cut > i + size / 2) end = cut;
    }
    out.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out.filter(Boolean);
}

// Everything worth finding by meaning for one recording: its summary, its facts (short and
// high-signal), and overlapping transcript passages. ids are `<recordingId>:<n>`, stable, so
// a re-index overwrites in place and a delete knows what to remove.
export function buildChunks(rec, facts) {
  const date = new Date(rec.created_at).toISOString().slice(0, 10);
  const chunks = [];
  if (rec.summary) chunks.push({ kind: 'summary', text: `Summary of "${rec.title}" (${date}): ${String(rec.summary).slice(0, 1500)}` });
  for (const f of facts || []) {
    chunks.push({ kind: 'fact', text: `${f.kind}${f.person ? ` (${f.person})` : ''}: ${f.text} -- "${f.quote}"` });
  }
  for (const c of chunkText(rec.transcript)) chunks.push({ kind: 'transcript', text: c });
  return chunks.map((c, n) => ({ ...c, id: `${rec.id}:${n}`, text: c.text.slice(0, 1500) }));
}
