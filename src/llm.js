// Chat-completion endpoint for summaries, mind maps, ask and speaker naming. Defaults to
// OpenAI; set LLM_BASE_URL (+ LLM_API_KEY) to use any OpenAI-compatible API, e.g.
// OpenRouter. Transcription has its own STT_BASE_URL / STT_API_KEY below.

export const llmUrl = (env) => `${(env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;

export const llmHeaders = (env) => ({
  authorization: `Bearer ${env.LLM_API_KEY || env.OPENAI_API_KEY}`,
  'content-type': 'application/json',
});

// Speech-to-text endpoint. Defaults to OpenAI; set STT_BASE_URL (+ STT_API_KEY) for an
// OpenAI-compatible one such as OpenRouter's /audio/transcriptions.
export const sttUrl = (env) => `${(env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/transcriptions`;
// Providers (OpenRouter especially) answer 429 with a short Retry-After. Wait it out and
// try again a few times rather than failing the whole transcription. `attempt` must build a
// fresh request each call (a streamed body can't be re-sent).
export async function withRateLimitRetry(attempt, { tries = 4, maxWaitMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 1; ; i++) {
    const r = await attempt();
    if (r.status !== 429 || i >= tries) return r;
    const secs = Number(r.headers.get('retry-after'));
    const wait = Math.min(maxWaitMs, Math.max(1000, (Number.isFinite(secs) ? secs * 1000 : 0), 1000 * 2 ** (i - 1)));
    await r.body?.cancel?.().catch(() => {});
    await sleep(wait);
  }
}

export const sttFetch = (env, fd) => withRateLimitRetry(() => fetch(sttUrl(env), {
  method: 'POST', headers: { authorization: `Bearer ${env.STT_API_KEY || env.OPENAI_API_KEY}` }, body: fd,
}));

export const llmFetch = (env, body) =>
  fetch(llmUrl(env), { method: 'POST', headers: llmHeaders(env), body: JSON.stringify(body) });
