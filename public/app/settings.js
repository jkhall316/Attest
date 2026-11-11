// Gear icon (bottom left) -> settings dialog: pick the AI provider and models, optionally
// replace the API key, Save. Changes apply immediately; no redeploy. The key is write-only:
// the server only says whether one is set.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { renderTranscriberNote } from './templates.js';
import { friendlyModel } from './format.js';

let S = null; // last /api/settings payload

// (Re)build the model + transcriber dropdowns on the main screen from /api/meta.
// A curated label ("GPT-6 Luna — cheap, high volume") is kept; a bare model id becomes a
// friendly name ("GPT-OSS 20B"). The raw id is always in the tooltip.
const nice = (x) => (x.label && x.label !== x.id ? x.label : friendlyModel(x.id));

export function fillSelects() {
  const m = state.META;
  const prevModel = $('model').value;
  $('model').innerHTML = m.models
    .map((x) => `<option value="${esc(x.id)}" title="${esc(x.id)}"${x.id === m.default_model ? ' selected' : ''}>${esc(nice(x))}</option>`).join('');
  if (m.models.some((x) => x.id === prevModel)) $('model').value = prevModel;
  $('transcriber').innerHTML = m.transcribers
    .map((t) => `<option value="${esc(t.id)}" title="${esc(t.id)}">${esc(nice(t))}${m.deprecations?.[t.id] ? ' ⚠' : ''}</option>`).join('');
  $('transcriber').onchange = () => { renderTranscriberNote(); optionPills(); };
  $('model').onchange = optionPills;
  renderTranscriberNote();
  optionPills();
}

// The collapsed "Recording options" row: the two models in play, as friendly pills.
export function optionPills() {
  const pill = (sel, kind) => {
    const o = sel.options[sel.selectedIndex];
    return o ? `<span class="pill model" title="${esc(kind)}: ${esc(o.value)}">${esc(o.textContent.split(' — ')[0])}</span>` : '';
  };
  $('opts-pills').innerHTML = `${pill($('transcriber'), 'Transcription')}${pill($('model'), 'Summary model')}` || 'Recording options';
}

const checked = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.checked).map((e) => e.value);

// A list of checkboxes plus "other model id" input. `picked` are ids that start ticked.
function modelList(name, options, picked) {
  const known = new Set(options.map((o) => o.id));
  const extras = picked.filter((id) => !known.has(id));
  const rows = [...options, ...extras.map((id) => ({ id, note: 'your own model id' }))];
  return rows.map((o) => `
    <label class="opt"><input type="checkbox" class="${name}" value="${esc(o.id)}"${picked.includes(o.id) ? ' checked' : ''}>
      <span><b>${esc(o.id)}</b><br><span class="muted">${esc(o.note)}</span></span></label>`).join('')
    + `<input id="${name}-extra" placeholder="Add another model id (openrouter.ai/models)" style="margin-top:6px">`;
}

// Voice recognition and the Pocket key: the two settings that apply however Attest is run.
export function extrasHtml(s = {}) {
  return `<h3>Voice recognition</h3>
    <label class="opt"><input type="checkbox" id="set-voice"${s.voice_match !== false ? ' checked' : ''}>
      <span>Recognise enrolled voices <span class="muted">(downloads a 49MB voice model once; runs in your browser, works with any provider)</span></span></label>
    <h3>Pocket</h3>
    <input id="set-pocket" type="password" autocomplete="off" placeholder="${s.has_pocket_key ? 'A key is saved. Leave blank to keep it.' : 'Paste your Pocket API key (optional)'}">
    <div class="muted" style="margin-top:4px">Lets “Import from Pocket” and the background sync pull your Pocket recordings. Stored in your database and never shown again.</div>
    ${s.has_pocket_key ? '<label class="opt"><input type="checkbox" id="set-pocket-clear"><span>Remove the saved Pocket key</span></label>' : ''}`;
}

function render() {
  const p = $('set-provider').value;
  const cat = S.catalog[p];
  const chatPicked = p === S.provider ? S.chat_models : cat.chat.slice(0, 1).map((o) => o.id);
  const sttPicked = p === 'openrouter'
    ? (p === S.provider && S.stt_models.length ? S.stt_models : cat.stt.slice(0, 1).map((o) => o.id)) : [];
  const def = chatPicked.includes(S.default_model) && p === S.provider ? S.default_model : chatPicked[0];

  $('set-body').innerHTML = `
    <h3>Chat models <span class="muted" style="text-transform:none;letter-spacing:0">(summaries, mind maps, ask)</span></h3>
    ${modelList('set-chat', cat.chat, chatPicked)}
    <label class="muted" style="display:block;margin-top:8px">Default model
      <select id="set-default" style="width:100%"></select></label>
    ${p === 'openrouter' ? `<h3>Transcription models</h3>${modelList('set-stt', cat.stt, sttPicked)}
      <div class="muted" style="margin-top:6px">Models marked LABELS SPEAKERS (MAI-Transcribe 2, Voxtral, Scribe) give you speaker names in transcripts. Whisper gives plain text. </div>` : ''}
    ${extrasHtml(S)}
    <h3>${p === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key</h3>
    <input id="set-key" type="password" autocomplete="off" placeholder="${(p === S.provider ? S.has_key : false) ? 'A key is saved. Leave blank to keep it.' : 'Paste your key'}">
    <div class="muted" style="margin-top:4px">Stored in your Worker's database and never shown again.</div>`;

  const syncDefault = () => {
    const ids = [...new Set([...checked('.set-chat'), $('set-chat-extra').value.trim()].filter(Boolean))];
    const cur = $('set-default').value || def;
    $('set-default').innerHTML = ids.map((id) => `<option${id === cur ? ' selected' : ''}>${esc(id)}</option>`).join('');
  };
  syncDefault();
  $('set-body').onchange = $('set-body').oninput = syncDefault;
}

async function save() {
  const p = $('set-provider').value;
  const extra = (id) => $(id).value.trim();
  const body = {
    provider: p,
    chat_models: [...checked('.set-chat'), extra('set-chat-extra')].filter(Boolean),
    default_model: $('set-default').value,
    stt_models: p === 'openrouter' ? [...checked('.set-stt'), extra('set-stt-extra')].filter(Boolean) : [],
    api_key: $('set-key').value,
    voice_match: $('set-voice').checked ? 'on' : 'off',
    pocket_api_key: $('set-pocket').value,
    pocket_clear: Boolean($('set-pocket-clear')?.checked),
  };
  $('set-status').textContent = 'Saving…';
  try {
    S = await api('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    state.META = await api('/meta');
    fillSelects();
    $('set-status').textContent = 'Saved. New recordings use these settings.';
    $('set-provider').value = S.provider === 'custom' ? 'openai' : S.provider;
    render();
  } catch (e) {
    $('set-status').textContent = e.message;
  }
}

// Running locally (`npm run local`): the models come from .dev.vars, and the provider form only
// knows OpenAI and OpenRouter, so saving it would overwrite them. Explain that instead, and
// offer the two settings that still apply: voice recognition and the Pocket key.
export function localSettingsHtml(meta, s = {}) {
  return `<div class="banner">Attest is running <b>locally</b>, so its models are set in <code>.dev.vars</code>, not here.
    Run <code>npm run setup:local</code> to change them, and <code>npm run local:check</code> to test them.</div>
    <div class="muted" style="margin-top:10px"><b>Search:</b> ${meta?.vectors_enabled ? 'by meaning (local embeddings)' : 'by keywords (add an embedding model to .dev.vars for semantic search)'}<br>
    <b>Speakers:</b> ${meta?.diarize_local ? 'detected in your browser by clustering voices' : 'from the transcriber, if it labels speakers'}</div>
    ${extrasHtml(s)}`;
}

async function renderLocal() {
  const got = await api('/settings');
  S = got;
  $('set-body').innerHTML = localSettingsHtml(state.META, got);
}

async function saveLocal() {
  const body = {
    pocket_api_key: $('set-pocket').value,
    pocket_clear: Boolean($('set-pocket-clear')?.checked),
    voice_match: $('set-voice').checked ? 'on' : 'off',
  };
  $('set-status').textContent = 'Saving…';
  try {
    await api('/settings/extras', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    state.META = await api('/meta');
    await renderLocal();
    $('set-status').textContent = 'Saved.';
  } catch (e) {
    $('set-status').textContent = e.message;
  }
}

export function wireSettings() {
  // Open first, load second: whatever goes wrong shows up inside the dialog instead of
  // the click appearing to do nothing.
  $('settings').onclick = async () => {
    $('set-body').innerHTML = '';
    $('set-custom').textContent = '';
    $('set-status').textContent = 'Loading…';
    $('settings-dialog').showModal();
    if (state.META?.local_mode) {
      $('set-provider').closest('label').style.display = 'none';
      try { await renderLocal(); $('set-status').textContent = ''; }
      catch (e) { $('set-body').innerHTML = localSettingsHtml(state.META); $('set-status').textContent = `Could not load settings: ${e.message}`; }
      return;
    }
    try {
      const got = await api('/settings');
      if (!got || typeof got !== 'object' || !got.catalog) {
        throw new Error('Unexpected response from /api/settings. Redeploy (npm run deploy) and hard-refresh the page.');
      }
      S = got;
      $('set-provider').value = S.provider === 'openrouter' ? 'openrouter' : 'openai';
      $('set-custom').textContent = S.provider === 'custom' ? 'Your deploy uses a custom provider URL. Saving here replaces it.' : '';
      render();
      $('set-status').textContent = '';
    } catch (e) {
      console.error('settings:', e);
      $('set-status').textContent = `Could not load settings: ${e.message}`;
    }
  };
  $('set-provider').onchange = () => { try { render(); } catch (e) { $('set-status').textContent = e.message; } };
  $('set-save').onclick = () => (state.META?.local_mode ? saveLocal() : save());
  $('set-close').onclick = () => $('settings-dialog').close();
}
