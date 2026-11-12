// Ask Attest Anything: keyword retrieval over FTS5, then one grounded completion.

import { ftsQuery, parseJsonLoose } from '../text.js';
import { defaultModel } from '../config.js';
import { llmFetch } from '../llm.js';
import { areaClause, normalizeArea } from '../areas.js';
import { vectorsEnabled, semanticChunks, chunksToHits } from '../vectors.js';

/* --- #3 deep research --- */
// Bounded 3-pass loop over the EXISTING FTS5 retrieval: decompose, retrieve per
// sub-question, synthesize. No new search backend, no embeddings. These are hard
// ceilings (not targets) so a runaway decomposition can't blow up cost or latency.
export const MAX_SUB_QUESTIONS = 4;
export const MAX_HITS = 12;
export const MAX_MODEL_CALLS = 2; // decompose + synthesize; retrieval is plain SQL
/* --- /#3 deep research --- */

// Keyword retrieval, split out of ask() so chat threads (#2) can run it once per
// turn and feed the same hits into answer() alongside prior conversation turns.
export async function retrieve(env, owner, question, area = '') {
  const ac = areaClause(area, 'r.area');
  const inArea = normalizeArea(area);
  // Meaning first when the vector index exists (only the matching passages go to the model,
  // which is also cheaper); keyword hits top it up. Any vector failure falls back to keywords.
  let semantic = [];
  if (vectorsEnabled(env)) {
    try {
      semantic = chunksToHits(await semanticChunks(env, owner, question));
      // The index knows nothing about areas, so keep only hits whose recording is in the chosen one.
      if (inArea && semantic.length) {
        const ok = new Set(((await env.DB.prepare(
          `SELECT id FROM recordings WHERE owner = ? AND area = ? AND id IN (${semantic.map(() => '?').join(',')})`
        ).bind(owner, inArea, ...semantic.map((h) => h.id)).all()).results || []).map((r) => r.id));
        semantic = semantic.filter((h) => ok.has(h.id));
      }
    }
    catch (e) { console.error('semantic search failed, using keywords:', e?.message || e); }
    if (semantic.length >= 4) return semantic;
  }
  const q = ftsQuery(question);
  let hits = [];
  if (q) {
    hits = (await env.DB.prepare(
      `SELECT r.id, r.title, r.transcript, r.summary
         FROM transcript_fts JOIN recordings r ON r.id = transcript_fts.id
        WHERE transcript_fts MATCH ? AND r.owner = ? AND r.hidden = 0${ac.sql}
        ORDER BY rank LIMIT 8`
    ).bind(q, owner, ...ac.binds).all()).results;
  }
  if (semantic.length) {
    const have = new Set(semantic.map((h) => h.id));
    return [...semantic, ...hits.filter((h) => !have.has(h.id))].slice(0, 8);
  }
  // keyword miss (and no vector index) falls back to recent recordings
  if (!hits.length) {
    hits = (await env.DB.prepare(
      `SELECT id, title, transcript, summary FROM recordings
        WHERE owner = ? AND status = 'ready' AND hidden = 0${areaClause(area).sql}
        ORDER BY created_at DESC LIMIT 5`
    ).bind(owner, ...areaClause(area).binds).all()).results;
  }
  return hits;
}

const EXCERPT_CHARS = 3000;

// Pure: the part of a transcript worth showing the model. Short transcripts go in whole;
// long ones get the opening plus a window centred on the first place any question term
// appears, so an answer buried an hour in is not cut off by a head-only slice.
export function excerpt(transcript, question, max = EXCERPT_CHARS) {
  const t = transcript || '';
  if (t.length <= max) return t;
  const lower = t.toLowerCase();
  const terms = (String(question || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  let at = -1;
  for (const term of terms) { const i = lower.indexOf(term); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const head = Math.floor(max / 4);
  if (at < 0 || at < max - head) return t.slice(0, max) + ' …';
  const body = max - head;
  const from = Math.max(head, at - Math.floor(body / 3));
  return `${t.slice(0, head)} … ${t.slice(from, from + body)} …`;
}

// hits -> the <recording> context block fed to the completion. Shared by answer()
// and deepResearch()'s synthesis pass so the two don't drift apart.
function hitsToContext(hits, question) {
  return hits.map((h) =>
    `<recording title="${h.title.replace(/"/g, "'")}">\n${h.summary ? `Summary: ${h.summary}\n` : ''}${excerpt(h.transcript, question)}\n</recording>`
  ).join('\n\n');
}

// The one chat-completion call behind answer() and deepResearch().
async function completion(env, messages, { json = false, label = 'ask' } = {}) {
  const res = await llmFetch(env, {
    model: defaultModel(env),
    messages,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices[0].message.content;
}

// hits -> {answer, sources}. history is prior {role,content} turns for this thread
// (#2), inserted between the system prompt and the final question so follow-up
// questions can refer back to earlier ones; capped here too in case a caller forgets.
export async function answer(env, hits, question, history = []) {
  if (!hits.length) return { answer: 'No recordings to search yet.', sources: [] };
  const text = await completion(env, [
    { role: 'system', content: 'Answer using ONLY the recordings below. Cite recording titles inline. If the answer is not there, say so plainly.' },
    ...history.slice(-10),
    { role: 'user', content: `${hitsToContext(hits, question)}\n\nQuestion: ${question}` },
  ]);
  return { answer: text, sources: hits.map(({ id, title }) => ({ id, title })) };
}

// Stateless /api/ask back-compat wrapper (#2 added chat threads, this stays as-is).
export async function ask(env, owner, question, area = '') {
  return answer(env, await retrieve(env, owner, question, area), question);
}

/* --- #3 deep research --- */
// Pure: dedupe hit lists from several retrieve() calls by recording id, first-seen
// order wins (earlier sub-questions are presumed more relevant), truncate to cap.
export function mergeHits(hitLists, cap) {
  const seen = new Set();
  const out = [];
  for (const hits of hitLists) {
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// Pass 1 (decompose) and pass 3 (synthesize) are model calls; pass 2 (retrieve) is plain
// FTS5 lookups -- so MAX_MODEL_CALLS is 2 and `model_calls` reports what actually ran.
export async function deepResearch(env, owner, question, history = [], area = '') {
  const decomposeRaw = await completion(env, [
    { role: 'system', content: `Split the user's question into up to ${MAX_SUB_QUESTIONS} standalone sub-questions whose answers together cover it (resolve pronouns and references using the prior conversation, if any). Respond with JSON {"sub_questions": ["..."]}.` },
    ...history.slice(-4),
    { role: 'user', content: question },
  ], { json: true, label: 'deep research' });

  let sub_questions = [];
  try {
    const parsed = parseJsonLoose(decomposeRaw)?.sub_questions;
    if (Array.isArray(parsed)) sub_questions = parsed;
  } catch { /* fall through to the [question] fallback below */ }
  sub_questions = [...new Set(sub_questions.map((q) => String(q || '').trim()).filter(Boolean))]
    .slice(0, MAX_SUB_QUESTIONS);
  if (!sub_questions.length) sub_questions = [question];

  const hitLists = await Promise.all(sub_questions.map((q) => retrieve(env, owner, q, area)));
  const hits = mergeHits(hitLists, MAX_HITS);

  if (!hits.length) {
    return { answer: 'No recordings to search yet.', sources: [], sub_questions, passes: 2, model_calls: 1 };
  }

  const synthesis = await completion(env, [
    {
      role: 'system',
      content: 'Answer the original question using ONLY the recordings below. Cite recording titles inline. ' +
        'Explicitly name any of the listed sub-questions the recordings could NOT answer. Never invent facts.',
    },
    ...history.slice(-10),
    {
      role: 'user',
      content: `${hitsToContext(hits, [question, ...sub_questions].join(' '))}\n\nOriginal question: ${question}\nSub-questions explored: ${sub_questions.join('; ')}`,
    },
  ], { label: 'deep research' });

  return {
    answer: synthesis,
    sources: hits.map(({ id, title }) => ({ id, title })),
    sub_questions,
    passes: 3,
    model_calls: 2,
  };
}
/* --- /#3 deep research --- */
