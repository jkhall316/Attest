// Local mode: run Attest on your own machine (`npm run local`) against a local OpenAI-compatible
// server such as oMLX. Cloudflare's Workers AI and Vectorize do not exist there, so this file
// supplies stand-ins with the same shape, and the rest of the app does not know the difference:
//   env.AI.run(model, {text})   -> embeddings from the server's /v1/embeddings
//   env.VECTORS                 -> a vector index in the local D1 (table local_vectors)
// Search is brute-force cosine over the owner's vectors: plenty for a personal corpus (a few
// thousand passages), and no extra service to run.

import { isLocal } from './config.js';

const bytesToB64 = (u8) => {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64ToF32 = (b64) => {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
};

export function normalize(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(vec, (v) => v / n);
}

export const encodeVec = (vec) => bytesToB64(new Uint8Array(normalize(vec).buffer));
export const decodeVec = b64ToF32;

// Same call shape as Workers AI: run(model, {text: string[]}) -> {data: number[][]}.
// `dim: 0` tells vectors.js the size is whatever the local model returns.
export function localEmbedder(env) {
  const base = String(env.EMBED_BASE_URL || env.LLM_BASE_URL || '').replace(/\/+$/, '');
  return {
    dim: Number(env.EMBED_DIM) || 0,
    batch: Number(env.EMBED_BATCH) || 16, // local servers are happier with small batches
    async run(_model, { text }) {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.EMBED_API_KEY || env.LLM_API_KEY || 'local'}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.EMBED_MODEL, input: text, encoding_format: 'float' }),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const rows = (await res.json()).data || [];
      return { data: [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => r.embedding) };
    },
  };
}

// Vectorize-shaped index over D1. Vectors are tagged with the embedding model, so changing
// models never mixes spaces: old vectors are simply not searched until the recording is
// re-indexed (Memory, then "Rebuild search index").
export function d1Vectors(env) {
  const model = String(env.EMBED_MODEL || '');
  const db = env.DB;
  return {
    async upsert(vectors) {
      for (let i = 0; i < vectors.length; i += 50) {
        await db.batch(vectors.slice(i, i + 50).map((v) => db.prepare(
          'INSERT OR REPLACE INTO local_vectors (id, namespace, model, dim, vec, metadata) VALUES (?,?,?,?,?,?)'
        ).bind(v.id, v.namespace, model, v.values.length, encodeVec(v.values), JSON.stringify(v.metadata || {}))));
      }
      return { count: vectors.length };
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += 50) {
        await db.batch(ids.slice(i, i + 50).map((id) => db.prepare('DELETE FROM local_vectors WHERE id = ?').bind(id)));
      }
      return { count: ids.length };
    },
    async query(vec, { topK = 10, namespace } = {}) {
      const q = normalize(vec);
      const rows = (await db.prepare(
        'SELECT id, dim, vec, metadata FROM local_vectors WHERE namespace = ? AND model = ? LIMIT 50000'
      ).bind(namespace, model).all()).results || [];
      const scored = [];
      for (const r of rows) {
        if (r.dim !== q.length) continue;
        const v = decodeVec(r.vec);
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
        scored.push({ id: r.id, score: dot, metadata: JSON.parse(r.metadata || '{}') });
      }
      scored.sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, topK), count: scored.length };
    },
  };
}

// env + the stand-ins, when LOCAL_MODE is on and an embedding model is configured.
export function withLocalBackends(env) {
  if (!isLocal(env) || !env.EMBED_MODEL || env.VECTORS) return env;
  return { ...env, AI: localEmbedder(env), VECTORS: d1Vectors(env) };
}
