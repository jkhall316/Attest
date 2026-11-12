// Recording detail view: open, render, speaker chips, mind map tabs, process.

import { $, esc, md } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { refresh, refreshChats } from './lists.js';
import { doAsk, deepToggle, deepHint, wireDeep } from './ask.js';
import { getMe, isMe } from './me.js';
import { AREAS } from './scope.js';
import { icon } from './icons.js';
import { friendlyModel, sections, iconForSection, avatarStyle, displayNames, initials } from './format.js';
import { playerHtml, wirePlayer, clearTicks } from './player.js';
import { transcriptCard, wireTranscript } from './transcript.js';
import { mindmapCard, wireMindmaps } from './mindmap.js';
import { openMenu, closeMenu } from './menu.js';
import { wireVoiceprintButtons } from './voiceprints.js';
import { eligible, matchRecording, needsManual } from './voicematch.js';
import { diarizeEligible, detectAndMatch, needsTurns } from './diarize.js';
import { planEstimate, etaText, loadRates, reportTiming } from './eta.js';

export async function open(id) {
  state.current = id;
  state.currentChat = null;
  await refresh();
  await refreshChats();
  const r = await api('/recordings/' + id);
  if (r.status === 'uploaded') return process(r);
  render(r);
  // Opened an older (or Pocket/cron) recording that was never voice-matched: do it now, in
  // the background. Names that change offer a "Re-summarize with names" button.
  const note = (t) => { if (state.current === id && $('vm-status')) $('vm-status').textContent = t; };
  if (r.status === 'ready' && diarizeEligible(r)) {
    // Local mode: one provisional speaker. Work out the real turns, then recognise voices.
    const row = await detectAndMatch(r, { onStatus: note });
    if (state.current !== id) return;
    if (row) render(row); else note('');
  } else if (r.status === 'ready' && !r.voice_match && eligible(r)) {
    const matched = await matchRecording(r, note);
    if (state.current !== id) return;
    if (matched) render(matched);
    else note('');
  }
}

// Rebuilds the audio of an interrupted live recording from the parts the server kept,
// then processes it.
async function recover(r) {
  $('main').innerHTML = `<h2>${esc(r.title)}</h2><div class="muted">Recovering audio…</div>`;
  try {
    await api(`/recordings/${r.id}/recover`, { method: 'POST' });
    refresh();
    return process({ ...r, status: 'uploaded' });
  } catch (e) {
    render({ ...r, error: e.message });
  }
}

export async function process(r, { force = false } = {}) {
  const q = force ? '?force=1' : '';
  const audio = r.duration_ms || 0;
  const local = Boolean(state.META?.diarize_local);
  const twoStep = Boolean(state.META?.voice_match_enabled || local);
  const modelKey = r.model || state.META?.default_model || '';
  // The steps this run will take, in order, for the time estimate. A forced retry reuses the saved transcript.
  const stages = twoStep
    ? [...(force ? [] : [['transcribe', r.transcriber || '']]), [local ? 'diarize' : 'match', ''], ['summarize', modelKey]]
    : [['full', modelKey]];
  const plan = planEstimate(stages, audio, await loadRates());
  let at = 0, stepStart = Date.now(), timer = null;
  const stop = () => { clearInterval(timer); timer = null; };
  const paintEta = () => {
    if (!$('eta')) return stop();
    $('eta').textContent = etaText(plan, Math.min(at, plan.steps.length - 1), Date.now() - stepStart);
  };
  // Starts a step: `name` picks which estimate step is running; repeated calls with the same name only retitle.
  const step = (t, name) => {
    const idx = name ? stages.findIndex(([s]) => s === name) : at;
    if (idx >= 0 && idx !== at) { at = idx; stepStart = Date.now(); }
    $('main').innerHTML = `<h2>${esc(r.title)}</h2><div class="muted">${esc(t)} This runs in your browser tab, so leave it open.</div>
      <div class="muted" id="eta" style="margin-top:6px"></div>
      <div class="row" style="margin-top:12px"><button id="retry-now" class="small" title="Stuck? Start this step again. A saved transcript is reused.">Retry</button></div>`;
    $('retry-now').onclick = () => { stop(); process(r, { force: true }); };
    paintEta();
    if (!timer) timer = setInterval(paintEta, 1000);
  };
  // Records how long a finished step took, for the next estimate. A forced retry is not representative.
  const done = (stage, key, started) => { if (!force) reportTiming(stage, key, audio, Date.now() - started); };
  try {
    if (twoStep) {
      // Transcribe, work out speakers and match voices in this tab, THEN summarize, so names
      // reach the summary.
      step('Transcribing…');
      let t0 = Date.now();
      const first = await api(`/recordings/${r.id}/process?stop_after=transcript${force ? '&force=1' : ''}`, { method: 'POST' });
      done('transcribe', r.transcriber || '', t0);
      // A long recording may have come back as several conversations (or trimmed): carry each through.
      const kids = first.split_into || [first.id];
      let out = null, shown = null;
      for (const [k, kid] of kids.entries()) {
        const t = kid === first.id ? first : await api('/recordings/' + kid);
        const of = kids.length > 1 ? ` (${k + 1} of ${kids.length})` : '';
        t0 = Date.now();
        if (local && needsTurns(t) && (diarizeEligible(t) || diarizeEligible(t, { manual: true }))) {
          step('Detecting speakers…' + of, 'diarize');
          const row = await detectAndMatch(t, { manual: true, onStatus: (m) => step(m + of, 'diarize') });
          if (row) done('diarize', '', t0);
        } else if (diarizeEligible(t)) {
          await detectAndMatch(t, { onStatus: (m) => step(m + of, 'diarize') });
        } else if (eligible(t)) {
          await matchRecording(t, (m) => step(m + of, 'match'));
          done('match', '', t0);
        }
        step('Summarizing…' + of, 'summarize');
        t0 = Date.now();
        out = await api(`/recordings/${t.id}/process${kid === r.id ? q : ''}`, { method: 'POST' });
        done('summarize', modelKey, t0);
        shown = shown || out;
      }
      if (shown.id !== r.id) { state.current = shown.id; await refresh(); }
      stop();
      render(shown);
    } else {
      step('Transcribing and summarizing…', 'full');
      const t0 = Date.now();
      const out = await api(`/recordings/${r.id}/process${q}`, { method: 'POST' });
      done('full', modelKey, t0);
      stop();
      if (out.id !== r.id) { state.current = out.id; await refresh(); } // it was split into several: show the first
      render(out);
    }
  } catch (e) {
    stop();
    render({ ...r, status: 'error', error: e.message });
  }
  refresh();
}

// An AI note as sectioned, collapsible cards when it has headings, else plain prose.
export function noteHtml(md_, open_ = true) {
  const parts = sections(md_);
  if (!parts) return `<div class="md">${md(md_)}</div>`;
  return parts.map((p) => !p.title
    ? `<div class="md" style="margin-bottom:10px">${md(p.body)}</div>`
    : `<details class="sect"${open_ ? ' open' : ''}><summary><span class="tag">${icon(iconForSection(p.title), 15)}</span>${esc(p.title)}<span class="chev">${icon('chevron', 16)}</span></summary>
        <div class="sect-body md">${md(p.body)}</div></details>`).join('');
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export function taskRow(a, i) {
  const late = typeof a.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a.due) && a.due.slice(0, 10) < todayISO() && !a.done;
  return `<label class="task${a.done ? ' done' : ''}"><input type="checkbox" data-i="${i}"${a.done ? ' checked' : ''}>
    <span class="body">${esc(a.task)}
      <span class="meta">${a.owner ? `<span class="tag who">${icon('user', 12)} ${esc(a.owner)}</span>` : ''}${a.due ? `<span class="tag due${late ? ' late' : ''}">${icon('calendar', 12)} ${esc(a.due)}${late ? ' · overdue' : ''}</span>` : ''}</span></span></label>`;
}

// What shaping did to this recording, and the buttons to do it by hand or take it back.
function shapeNote(r) {
  const L = r.lineage;
  if (r.hidden) {
    return `<div class="banner" style="margin-top:12px">This recording was split, trimmed or joined into other recordings.
      <button id="undo-shape" class="small" style="margin-left:8px">Undo and bring it back</button></div>`;
  }
  if (!L) return '';
  const text = L.kind === 'split' ? `Part ${L.part} of ${L.of}, split from one longer recording at a long silence.`
    : L.kind === 'merge' ? `Joined from ${L.from.length} recordings that were one call.`
    : 'Dead air at the start and end was trimmed.';
  return `<div class="row" style="margin-top:8px;gap:8px"><span class="muted" style="font-size:12px">${esc(text)}${L.audio === false ? ' The sound stays on the original (undo to listen).' : ''}</span>
    <button id="undo-shape" class="small">Undo</button></div>`;
}
function shapeButtons(r) {
  if (r.hidden || r.status !== 'ready') return '';
  const idx = (state.recordings || []).findIndex((x) => x.id === r.id);
  const older = idx >= 0 ? state.recordings[idx + 1] : null;
  return [
    !r.lineage && (r.segments || []).length > 1
      ? '<button id="reshape" class="small" title="Cuts dead air at the start and end, and splits the recording wherever there is a long silence between conversations. The original is kept and can be restored.">Split by silence</button>' : '',
    older ? `<button id="join-prev" class="small" title="Joins this with the recording before it as one call. The joined audio is transcribed again.">Join with previous</button>` : '',
  ].join('');
}

export function render(r) {
  const tasks = r.action_items || [];
  clearTicks();
  // The live preview is only useful while recording; once any recording's real
  // transcript is on screen, clear it so it cannot be mistaken for this one.
  if ($('live')) $('live').textContent = '';

  $('main').innerHTML = `<div class="page">
    <a href="#" class="crumb" id="back-today">${icon('arrow', 14).replace('<svg', '<svg style="transform:rotate(180deg)"')} Today</a>
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px">
      <h2 style="margin:0;flex:1;min-width:240px">${esc(r.title)}</h2>
      <div class="row" style="gap:6px">
        <a href="/api/export?id=${r.id}" download><button class="small">Export .md</button></a>
        <a href="/api/export?id=${r.id}&format=docx" download><button class="small">Export .docx</button></a>
        <a href="/api/export?id=${r.id}&format=html" target="_blank" rel="noopener"><button class="small">Print / PDF</button></a>
        ${shapeButtons(r)}
        <button id="del" class="small">Delete</button>
      </div>
    </div>
    <div class="row" style="margin-top:8px;gap:6px">
      <span class="pill">${icon('calendar', 12)} ${esc(new Date(r.created_at).toLocaleString())}</span>
      <span class="pill">${esc(state.TPL?.[r.template]?.label || r.template)}</span>
      <select id="area-pick" class="scope" title="${r.area_source === 'manual' ? 'Area you chose' : 'Area picked automatically. Change it and it stays put.'}" aria-label="Area">${AREAS.map(([k, l]) => `<option value="${k}"${k === r.area ? ' selected' : ''}>${l}</option>`).join('')}${r.area_source === 'manual' ? '<option value="auto">Auto-pick again</option>' : ''}</select>
      ${r.area_source === 'manual' ? '' : '<span class="muted" style="font-size:11px">auto</span>'}
      ${r.model ? `<span class="pill model" title="${esc(r.model)}">${esc(friendlyModel(r.model))}</span>` : ''}
      ${r.tokens_in ? `<span class="pill" title="Input plus output tokens">${r.tokens_in + (r.tokens_out || 0)} tokens</span>` : ''}
    </div>
    ${shapeNote(r)}
    ${r.error ? `<div class="banner" style="margin-top:12px">${esc(r.error)}</div>` : ''}
    ${r.recoverable ? '<div class="row" style="margin-top:8px"><button class="primary" id="recover">Recover audio</button></div>'
      : (r.status === 'error' || r.status === 'processing' || r.status === 'transcribed') ? '<div class="row" style="margin-top:8px"><button class="primary" id="retry">Retry</button></div>' : ''}
    ${r.status === 'recording' || r.has_audio === false ? '' : playerHtml(r)}
    ${r.status !== 'ready' ? `<h3>Status</h3><div class="muted">${esc(r.status)}…</div>` : ''}
    ${r.summary ? `<h3>Summary</h3><div class="card-box">${noteHtml(r.summary)}</div>` : ''}
    ${tasks.length ? `<h3>Action items</h3><div class="list">${tasks.map(taskRow).join('')}</div>` : ''}
    ${mindmapCard(r.mindmaps)}
    ${renderUnanswered(r.unanswered)}
    ${renderSpeakerChips(r.speakers, r.status === 'ready')}
    ${renderTalk(r.talk_stats, getMe())}
    <div class="row" style="margin-top:6px"><span class="muted" id="vm-status"></span>${r.voice_changed
      ? '<button id="resum" class="primary">Re-summarize with names</button>' : ''}${r.status === 'ready' && r.speakers?.some((s) => s.name)
      ? '<button id="reset-names" class="small" title="Sets every speaker back to Unknown, including names you confirmed. The summary is not changed until you re-summarize.">Clear speaker names</button>' : ''}${needsManual(r)
      ? '<button id="vm-run" class="small" title="Matches the voices in this recording to the people you enrolled. Runs in the background, about 30 seconds; your audio stays in this browser.">Recognise voices</button>' : ''}${diarizeEligible(r, { manual: true }) && !diarizeEligible(r)
      ? `<button id="dz-run" class="small" title="Works out who is speaking when, from their voices, then recognises people you enrolled. Runs in the background, up to a few minutes on a long recording; your audio stays in this browser.">${needsTurns(r) ? 'Detect speakers' : 'Re-detect speakers'}</button>` : ''}</div>
    ${transcriptCard(r)}
    <h3>Ask Attest</h3>
    <div class="card-box">
      <div class="muted" style="margin-bottom:10px">Searches all your recordings, not just this one.</div>
      <div class="omnibar" style="margin:0">${icon('search', 18)}<input id="q" placeholder="What did we decide about pricing?">
        ${deepToggle('q-deep')}
        <button class="primary" id="ask">Ask</button></div>
      ${deepHint('q-deep')}
      <div id="ask-out" style="margin-top:14px"></div>
    </div></div>`;
  wireDeep('q-deep');
  $('back-today').onclick = (e) => { e.preventDefault(); import('./today.js').then((m) => m.showToday()); };

  wirePlayer((r.duration_ms || 0) / 1000);
  wireTranscript(r, (row) => {
    render(row);
    refresh();
    if (row.removed_speakers?.length && $('vm-status')) $('vm-status').textContent = `Removed ${row.removed_speakers.join(', ')}: no turns left.`;
  });
  wireMindmaps(r.mindmaps, r.title);
  $('main').querySelectorAll('.task input[data-i]').forEach((box) => {
    box.onchange = async () => {
      try {
        await api(`/recordings/${r.id}/actions`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ i: Number(box.dataset.i), done: box.checked }),
        });
        box.closest('.task').classList.toggle('done', box.checked);
        import('./today.js').then((m) => m.loadBadge());
      } catch (e) { box.checked = !box.checked; alert(e.message); }
    };
  });
  // "Recognise voices" / "Detect speakers": a long job with progress, and a Cancel in place of the button.
  const runButton = (id, label, run) => {
    const btn = $(id);
    if (!btn) return;
    btn.onclick = async () => {
      const job = { cancel: false };
      btn.textContent = 'Cancel';
      btn.onclick = () => { job.cancel = true; };
      const note = (t) => { if ($('vm-status')) $('vm-status').textContent = t; };
      const out = await run({ manual: true, job, onStatus: note });
      if (state.current !== r.id) return;
      if (out) { render(out); if (out.dropped_names?.length && $('vm-status')) note(`${out.dropped_names.join(', ')} no longer has any turns, so that name was removed.`); }
      else { btn.textContent = label; btn.onclick = null; if ($('vm-status') && !$('vm-status').textContent) note('Nothing to change.'); }
    };
  };
  runButton('vm-run', 'Recognise voices', (o) => matchRecording(r, o.onStatus, o));
  runButton('dz-run', needsTurns(r) ? 'Detect speakers' : 'Re-detect speakers', (o) => detectAndMatch(r, o));
  if ($('recover')) $('recover').onclick = () => recover(r);
  if ($('retry')) $('retry').onclick = () => process(r, { force: true });
  if ($('reset-names')) $('reset-names').onclick = async () => {
    if (!confirm('Clear all speaker names on this recording, including ones you confirmed?')) return;
    $('reset-names').disabled = true;
    try {
      render(await api(`/recordings/${r.id}/reset-speakers`, { method: 'POST' }));
      refresh();
    } catch (e) {
      $('reset-names').disabled = false;
      $('vm-status').textContent = e.message;
    }
  };
  if ($('resum')) $('resum').onclick = async () => {
    $('resum').disabled = true;
    $('vm-status').textContent = 'Summarizing…';
    try {
      render(await api(`/recordings/${r.id}/resummarize`, { method: 'POST' }));
      refresh();
    } catch (e) {
      $('resum').disabled = false;
      $('vm-status').textContent = e.message;
    }
  };
  // Changing the area is sticky (the server marks it manual); "Auto-pick again" hands it back.
  $('area-pick').onchange = async (e) => {
    try {
      const out = await api(`/recordings/${r.id}/area`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ area: e.target.value }),
      });
      r.area = out.area; r.area_source = out.area_source;
      await refresh();
      render(r);
    } catch (err) { alert(err.message); }
  };
  const undo = $('undo-shape');
  if (undo) undo.onclick = async () => {
    if (!confirm('Undo this? The pieces made from it are removed and the original comes back.')) return;
    try {
      const out = await api(`/recordings/${r.id}/undo-reshape`, { method: 'POST' });
      state.current = out.restored[0];
      await refresh();
      render(await api('/recordings/' + out.restored[0]));
    } catch (e) { alert(e.message); }
  };
  const reshape = $('reshape');
  if (reshape) reshape.onclick = async () => {
    if (!confirm('Split this wherever there is a long silence, and trim dead air at the start and end? Each piece is summarized again.')) return;
    reshape.disabled = true; reshape.textContent = 'Working…';
    try {
      const out = await api(`/recordings/${r.id}/reshape`, { method: 'POST' });
      if (!out.changed) { reshape.textContent = 'Nothing to split'; return; }
      state.current = out.id;
      await refresh();
      render(out);
    } catch (e) { alert(e.message); reshape.disabled = false; reshape.textContent = 'Split by silence'; }
  };
  const joinPrev = $('join-prev');
  if (joinPrev) joinPrev.onclick = async () => {
    const idx = state.recordings.findIndex((x) => x.id === r.id);
    const older = state.recordings[idx + 1];
    if (!older || !confirm(`Join this with "${older.title}" as one call? The joined audio is transcribed and summarized again, and the two originals are kept so you can undo.`)) return;
    try {
      const out = await api('/recordings/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [older.id, r.id] }) });
      state.current = out.id;
      await refresh();
      open(out.id);
    } catch (e) { alert(e.message); }
  };
  $('del').onclick = async () => {
    if (!confirm('Delete this recording and its audio?')) return;
    await fetch('/api/recordings/' + r.id, { method: 'DELETE' });
    state.current = null;
    $('main').innerHTML = '<div class="empty">Deleted.</div>';
    refresh();
  };
  $('main').querySelectorAll('.chip[data-label]').forEach((chip) => {
    chip.onclick = () => openNameMenu(r, chip);
  });
  $('ask').onclick = doAsk;
  $('q').onkeydown = (e) => { if (e.key === 'Enter') doAsk(); };
  wireVoiceprintButtons(r).catch(() => {});
}

// "Who is this?": a dropdown from a speaker chip. Pick someone Attest already knows, or add a new
// person. Choosing confirms the name for that speaker (the same PATCH as before).
export function nameMenuHtml(people, speakers, label) {
  const names = displayNames(speakers);
  const me = (speakers || []).find((x) => x.label === label);
  const other = new Map((speakers || []).filter((x) => x.name && x.label !== label).map((x) => [x.name.toLowerCase(), names.get(x.label)?.shown]));
  const opts = (people || []).map((p) => {
    const here = me?.name && me.name.toLowerCase() === p.name.toLowerCase();
    const elsewhere = other.get(p.name.toLowerCase());
    return `<button class="opt${here ? ' on' : ''}" data-name="${esc(p.name)}"><span class="av" style="${avatarStyle(p.name)}">${esc(initials(p.name))}</span>${esc(p.name)}${here ? `<span style="margin-left:auto">${icon('check', 15)}</span>` : elsewhere ? `<span class="muted" style="margin-left:auto">also ${esc(elsewhere)}</span>` : ''}</button>`;
  }).join('');
  return `<div class="blurb">Who is ${esc(names.get(label)?.shown || label)}?</div>
    ${opts || '<div class="blurb">No one yet. Add the first person below.</div>'}
    <hr><div class="blurb">Someone new</div>
    <div class="row" style="flex-wrap:nowrap;padding:0 4px 4px"><input id="nm-new" placeholder="Their name" maxlength="80" style="flex:1" autocomplete="off"><button class="primary small" id="nm-add">Add</button></div>
    <div class="blurb" id="nm-err" style="color:var(--bad)" hidden></div>`;
}

async function openNameMenu(r, chip) {
  let people = [];
  try { people = (await api('/people')).people || []; } catch { /* the new-person field still works */ }
  const label = chip.dataset.label;
  const choose = async (name, menu) => {
    const err = menu.querySelector('#nm-err');
    if (!name) { err.textContent = 'Type a name first.'; err.hidden = false; return; }
    try {
      const row = await api(`/recordings/${r.id}/speakers`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, name }),
      });
      closeMenu();
      render(row);
      refresh();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  const menu = openMenu(chip, nameMenuHtml(people, r.speakers, label), {
    label: 'Who is this speaker?',
    onClick: (e, el) => {
      const o = e.target.closest('.opt[data-name]');
      if (o) return choose(o.dataset.name, el);
      if (e.target.closest('#nm-add')) choose(el.querySelector('#nm-new').value.trim(), el);
    },
  });
  const input = menu.querySelector('#nm-new');
  input.onkeydown = (e) => { if (e.key === 'Enter') choose(input.value.trim(), menu); };
  if (!people.length) input.focus();
}

// Speaker naming (#4/#14). One chip per distinct label, in nameSpeakers()'s first-appearance
// order, and EVERY chip is clickable so a wrong name can always be corrected:
//   "Sam ✓"        a human confirmed it (the only state that may enroll a voiceprint)
//   "Sam ?"        inferred or voice-matched, NOT vouched for -- hover shows the evidence
//   "Unknown N ?"  no name
// `ready` gates the voice buttons: enrollment slices the finished audio.
export function renderSpeakerChips(speakers, ready) {
  if (!speakers?.length) return '';
  let nextUnknown = 0;
  const chips = speakers.map((s) => {
    const shown = s.name || `Unknown ${++nextUnknown}`;
    const mark = s.name && s.confirmed ? '✓' : '?';
    const cls = s.name && s.confirmed ? 'chip' : 'chip unconfirmed';
    const voice = (ready && s.name && s.confirmed)
      ? ` <button class="enroll-voice small" data-label="${esc(s.label)}" data-name="${esc(s.name)}">Enroll voice</button>` +
        ` <button class="clear-voice small" data-name="${esc(s.name)}">Clear voices</button>`
      : '';
    return `<span class="${cls}" data-label="${esc(s.label)}" data-name="${esc(s.name || '')}" data-shown="${esc(shown)}" title="${esc(s.evidence || '')}">${esc(shown)} ${mark}</span>${voice}`;
  }).join(' ');
  return `<h3>Speakers</h3><div class="row" style="gap:8px">${chips}</div>`;
}

// Questions someone asked that never got a clear answer (#14).
export function renderUnanswered(list) {
  if (!list?.length) return '';
  return `<h3>Unanswered questions</h3><div class="card-box"><ul class="md" style="margin:0;padding-left:20px">${list.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>`;
}

// Talk balance (#11), measured from the stored turns, not inferred: one split bar for the
// whole conversation, then each speaker's numbers as chips.
export { speakerColor } from './format.js';
import { speakerColor } from './format.js';

export function renderTalk(stats, me = '') {
  if (!stats?.length) return '';
  const bar = stats.map((s, i) => `<span style="flex:${Math.max(s.share, 0.01)};background:${speakerColor(i)}" title="${esc(s.name)}: ${Math.round(s.share * 100)}%"></span>`).join('');
  const rows = stats.map((s, i) => `<div class="talk-row">
      <div class="nm-col"><div class="nm"><span class="dot" style="background:${speakerColor(i)}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span>${me && isMe(s.name, me) ? ' <span class="pill you">you</span>' : ''}<span class="pct">${Math.round(s.share * 100)}%</span></div>
        <div class="talk-meter" role="progressbar" aria-label="${esc(s.name)} share of talk time" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(s.share * 100)}"><span style="width:${Math.max(1, Math.round(s.share * 100))}%;background:${speakerColor(i)}"></span></div></div>
      <div class="chips"><span class="metric"><b>${Math.round(s.share * 100)}%</b> of talk time</span><span class="metric"><b>${s.turns}</b> turn${s.turns === 1 ? '' : 's'}</span>
        <span class="metric"><b>${s.questions}</b> question${s.questions === 1 ? '' : 's'}</span><span class="metric">longest <b>${s.longest_s}s</b></span><span class="metric"><b>${s.overlaps}</b> cut-in${s.overlaps === 1 ? '' : 's'}</span></div></div>`).join('');
  return `<h3>Talk balance</h3><div class="card-box"><div class="talk-bar" role="img" aria-label="Share of talk time by speaker">${bar}</div><div class="talk-legend">${rows}</div></div>`;
}
