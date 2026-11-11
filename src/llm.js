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
export const sttFetch = (env, fd) => fetch(sttUrl(env), {
  method: 'POST', headers: { authorization: `Bearer ${env.STT_API_KEY || env.OPENAI_API_KEY}` }, body: fd,
});

export const llmFetch = (env, body) =>
  fetch(llmUrl(env), { method: 'POST', headers: llmHeaders(env), body: JSON.stringify(body) });
