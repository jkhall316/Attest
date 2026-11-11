// Semantic search over everything you have recorded: Workers AI embeddings (bge-base, 768
// dimensions) stored in a Cloudflare Vectorize index. Optional: with no `AI` + `VECTORS`
// bindings every function here is a no-op and Ask falls back to keyword (FTS5) search.
// Vectors are namespaced by a hash of the owner, so one person's index is never searched for
// another's question.

import { buildChunks } from './memory.js';

export const EMBED_MODEL_ID = '@cf/baai/bge-base-en-v1.5';
export const VECTOR_DIM = 768;
const MIN_SCORE = 0.45;
const EMBED_BATCH = 50;
const UPSERT_BATCH = 100;

export const vectorsEnabled = (env) => Boolean(env?.AI?.run && env?.VECTORS?.upsert && env?.VECTORS?.query);

export async function ownerNamespace(owner) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(owner)));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// texts -> number[][] (768 each). Throws if the model's answer is not the shape we expect.
export async function embed(env, texts) {
  const out = [];
  const batchSize = env.AI.batch || EMBED_BATCH;
  // Workers AI: exactly VECTOR_DIM. A local embedder reports dim 0: any size, as long as the
  // whole answer agrees with itself.
  const fixed = env.AI.dim === 0 ? 0 : (env.AI.dim || VECTOR_DIM);
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await env.AI.run(EMBED_MODEL_ID, { text: batch });
    const data = res?.data;
    const size = data?.[0]?.length;
    if (!Array.isArray(data) || data.length !== batch.length || !size || size < 8
      || (fixed && size !== fixed) || data.some((v) => !Array.isArray(v) || v.length !== size)) {
      throw new Error('unexpected embedding response');
    }
    out.push(...data);
  }
  return out;
}

const idsFor = (recId, from, to) => Array.from({ length: Math.max(0, to - from) }, (_, k) => `${recId}:${from + k}`);

// (Re)index one recording. Returns the chunk count, or null when vectors are off. Stale
// chunks from a longer previous version are deleted.
export async function indexRecording(env, owner, rec, facts) {
  if (!vectorsEnabled(env)) return null;
  const chunks = buildChunks(rec, facts);
  const namespace = await ownerNamespace(owner);
  const values = chunks.length ? await embed(env, chunks.map((c) => c.text)) : [];
  const vectors = chunks.map((c, n) => ({
    id: c.id, namespace, values: values[n],
    metadata: { rec: rec.id, title: String(rec.title).slice(0, 120), kind: c.kind, t: rec.created_at, text: c.text },
  }));
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH) await env.VECTORS.upsert(vectors.slice(i, i + UPSERT_BATCH));
  const stale = idsFor(rec.id, chunks.length, rec.vec_chunks || 0);
  if (stale.length) await env.VECTORS.deleteByIds(stale);
  await env.DB.prepare('UPDATE recordings SET vec_chunks = ? WHERE id = ? AND owner = ?').bind(chunks.length, rec.id, owner).run();
  return chunks.length;
}

export async function deleteRecordingVectors(env, id, count) {
  if (!vectorsEnabled(env) || !count) return;
  const ids = idsFor(id, 0, count);
  for (let i = 0; i < ids.length; i += 500) await env.VECTORS.deleteByIds(ids.slice(i, i + 500));
}

// question -> [{rec, title, kind, text, score, t}], best first, owner-scoped, weak matches dropped.
export async function semanticChunks(env, owner, question, topK = 16) {
  if (!vectorsEnabled(env)) return [];
  const [vec] = await embed(env, [String(question).slice(0, 1000)]);
  const res = await env.VECTORS.query(vec, { topK, namespace: await ownerNamespace(owner), returnMetadata: 'all' });
  return (res?.matches || [])
    .filter((m) => m.score >= MIN_SCORE && m.metadata?.rec)
    .map((m) => ({ rec: m.metadata.rec, title: m.metadata.title, kind: m.metadata.kind, text: m.metadata.text, score: m.score, t: m.metadata.t }));
}

// Chunks -> the {id,title,summary,transcript} "hits" the answer code already understands:
// one hit per recording, its transcript field holding just the matching passages.
export function chunksToHits(chunks, maxRecordings = 8, maxChars = 2800) {
  const by = new Map();
  for (const c of chunks) {
    if (!by.has(c.rec)) by.set(c.rec, { id: c.rec, title: c.title, summary: null, parts: [] });
    by.get(c.rec).parts.push(c.text);
  }
  return [...by.values()].slice(0, maxRecordings).map((h) => ({
    id: h.id, title: h.title, summary: null, transcript: h.parts.join('\n…\n').slice(0, maxChars),
  }));
}
