// In-app settings (the gear icon). Stored in D1 and overlaid on the Worker env on every
// request, so provider/model/key changes need no redeploy. A saved value beats the same
// name set at deploy time (secrets / [vars]); an empty saved value means "unset it".
//
// API keys are kept in the database and are never sent back to the browser: GET only
// reports whether one is set. Anyone who can read your D1 database can read them, same
// as anyone with access to your Cloudflare account can read the Worker secrets.

import { json, fail } from './http.js';
import {
  MODELS, OPENROUTER_CHAT, OPENROUTER_STT, OPENROUTER_URL, OPENAI_URL, modelsFor, transcribersFor, defaultModel,
} from './config.js';

export const SETTING_KEYS = [
  'OPENAI_API_KEY', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODELS', 'DEFAULT_MODEL',
  'STT_BASE_URL', 'STT_API_KEY', 'STT_MODELS', 'VOICE_MATCH', 'POCKET_API_KEY',
];

// env + saved settings. Never throws: a missing table must not take the app down.
export async function withSettings(env) {
  try {
    const rows = (await env.DB.prepare('SELECT key, value FROM settings').all()).results || [];
    const over = {};
    for (const r of rows) if (SETTING_KEYS.includes(r.key)) over[r.key] = r.value;
    return Object.keys(over).length ? { ...env, ...over } : env;
  } catch {
    return env;
  }
}

const ID_RE = /^[A-Za-z0-9._:~\/-]{1,100}$/;
const cleanIds = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 12);

const providerOf = (env) => {
  const u = env.LLM_BASE_URL || '';
  return !u || u.startsWith(OPENAI_URL) ? 'openai' : u.startsWith(OPENROUTER_URL) ? 'openrouter' : 'custom';
};

export function describe(env) {
  const provider = providerOf(env);
  return {
    provider,
    voice_match: env.VOICE_MATCH !== 'off',
    has_pocket_key: Boolean(env.POCKET_API_KEY), // never the key itself
    chat_models: modelsFor(env).map((m) => m.id),
    default_model: defaultModel(env),
    stt_models: (env.STT_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
    has_key: provider === 'openrouter' ? Boolean(env.LLM_API_KEY) : Boolean(env.OPENAI_API_KEY),
    // Always true or false: whether transcription has a usable key right now.
    has_stt_key: Boolean(env.STT_API_KEY || env.OPENAI_API_KEY),
    catalog: {
      openai: { chat: MODELS.map((m) => ({ id: m.id, note: m.label })), stt: [] },
      openrouter: { chat: OPENROUTER_CHAT, stt: OPENROUTER_STT },
    },
  };
}

export const getSettings = (env) => json(describe(env));

const notOwner = (env, owner) => env.OWNER_EMAIL && owner.toLowerCase() !== String(env.OWNER_EMAIL).toLowerCase();

// The Pocket key and the voice-recognition switch, from a request body. `pocket_api_key` sets
// it (a non-empty string) and `pocket_clear: true` removes it. Returns {kv} or {error}.
function extrasFrom(body) {
  const kv = {};
  const pk = typeof body.pocket_api_key === 'string' ? body.pocket_api_key.trim() : '';
  if (pk && (pk.length > 300 || /\s/.test(pk))) return { error: 'that does not look like a Pocket API key' };
  if (pk) kv.POCKET_API_KEY = pk;
  else if (body.pocket_clear === true) kv.POCKET_API_KEY = '';
  if (body.voice_match === 'on' || body.voice_match === 'off') kv.VOICE_MATCH = body.voice_match;
  return { kv };
}

async function writeSettings(env, kv) {
  const now = Date.now();
  await env.DB.batch(Object.entries(kv).flatMap(([k, v]) => [
    env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(k),
    env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)').bind(k, v, now),
  ]));
}

// PUT /api/settings/extras {pocket_api_key?, pocket_clear?, voice_match?}: just these, without
// the provider and model form. Used when running locally, where the models live in .dev.vars
// and the form is not offered, but the Pocket key still has to go somewhere.
export async function saveExtras(request, env, owner) {
  if (notOwner(env, owner)) return fail('only the owner can change settings', 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail('bad request');
  const { kv, error } = extrasFrom(body);
  if (error) return fail(error);
  if (!Object.keys(kv).length) return fail('nothing to save');
  await writeSettings(env, kv);
  return json(describe({ ...env, ...kv }));
}

export async function saveSettings(request, env, owner) {
  if (notOwner(env, owner)) return fail('only the owner can change settings', 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail('bad request');

  const provider = body.provider;
  if (provider !== 'openai' && provider !== 'openrouter') return fail('provider must be openai or openrouter');
  const chat = cleanIds(body.chat_models);
  const stt = cleanIds(body.stt_models);
  for (const id of [...chat, ...stt]) if (!ID_RE.test(id)) return fail(`bad model id: ${id.slice(0, 40)}`);
  if (!chat.length) return fail('choose at least one chat model');
  if (provider === 'openrouter' && !stt.length) return fail('choose at least one transcription model');
  const def = chat.includes(body.default_model) ? body.default_model : chat[0];
  const key = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (key && (key.length > 300 || /\s/.test(key))) return fail('that does not look like an API key');

  const kv = provider === 'openrouter'
    ? { LLM_BASE_URL: OPENROUTER_URL, STT_BASE_URL: OPENROUTER_URL, LLM_MODELS: chat.join(','), DEFAULT_MODEL: def, STT_MODELS: stt.join(',') }
    // OpenAI: transcription keeps its built-in list (the diarizing model), so STT_* are cleared.
    : { LLM_BASE_URL: '', STT_BASE_URL: '', LLM_API_KEY: '', STT_API_KEY: '', LLM_MODELS: chat.join(','), DEFAULT_MODEL: def, STT_MODELS: '' };
  if (key) {
    if (provider === 'openrouter') Object.assign(kv, { LLM_API_KEY: key, STT_API_KEY: key });
    else kv.OPENAI_API_KEY = key;
  }
  // Switching to OpenRouter with no key anywhere would break every call; say so now.
  const merged = { ...env, ...kv };
  if (provider === 'openrouter' && !merged.LLM_API_KEY) return fail('enter your OpenRouter API key');
  if (provider === 'openai' && !merged.OPENAI_API_KEY) return fail('enter your OpenAI API key');

  const extras = extrasFrom(body);
  if (extras.error) return fail(extras.error);
  Object.assign(kv, extras.kv);
  await writeSettings(env, kv);
  return json(describe({ ...merged, ...extras.kv }));
}
