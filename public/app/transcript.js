// Interactive transcript: conversation rows (avatar + name + timestamp chip on the left,
// prose on the right), live search with highlighting, and playback sync: the row being
// spoken highlights as audio plays, and clicking a timestamp seeks the player.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { openMenu, closeMenu } from './menu.js';
import { icon } from './icons.js';
import { fmtClock, initials, avatarStyle, displayNames } from './format.js';
import { onTick, seekTo } from './player.js';
import { placeByVoice } from './autoplace.js';

// Consecutive segments by one speaker become one turn. Segment times are seconds.
// Each turn also carries `idx`, the positions of its segments in the stored array, so a turn can
// be moved to another speaker.
export function buildTurns(segments, speakers) {
  const names = displayNames(speakers);
  const turns = [];
  (segments || []).forEach((s, i) => {
    const text = String(s.text || '').trim();
    if (!text) return;
    const label = s.speaker || 'Speaker';
    const last = turns[turns.length - 1];
    if (last && last.label === label) { last.text += ' ' + text; last.idx.push(i); if (Number.isFinite(s.end)) last.end = s.end; return; }
    turns.push({
      label, text, shown: names.get(label)?.shown || (label === 'Speaker' ? 'Speaker' : label), idx: [i],
      start: Number.isFinite(s.start) ? s.start : null, end: Number.isFinite(s.end) ? s.end : null,
    });
  });
  return turns;
}

// The "move to…" menu for one turn: this turn, or all of this speaker's turns, to another
// speaker, or to a new one. `speakers` is the recording's list, `turn` one of buildTurns().
export function moveMenuHtml(speakers, turn) {
  const names = displayNames(speakers);
  const others = (speakers || []).filter((sp) => sp.label !== turn.label);
  const opt = (to, who, scope) => `<button class="opt" data-to="${esc(to)}" data-scope="${scope}"><span class="av" style="${avatarStyle(who)}">${esc(initials(who))}</span>${esc(who)}</button>`;
  const list = (scope) => others.map((sp) => opt(sp.label, names.get(sp.label)?.shown || sp.label, scope)).join('');
  return `<div class="blurb">Move this turn to</div>${list('turn')}
    <button class="opt" data-to="new" data-scope="turn"><span class="av">+</span>New speaker</button>
    <button class="opt" data-to="auto" data-scope="turn" title="Not sure who it is, or not named yet: pick the closest voice among the other speakers, or a new one"><span class="av">?</span>I don't know: match by voice</button>
    ${others.length ? `<hr><div class="blurb">Move <b>all</b> of ${esc(turn.shown)}'s turns to</div>${list('all')}` : ''}`;
}

// text with every search term wrapped in <mark>; everything else escaped.
export function highlight(text, q) {
  const terms = String(q || '').trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return esc(text);
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

export const turnMatches = (turn, q) => {
  const terms = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${turn.shown} ${turn.text}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
};

export function transcriptCard(r) {
  const turns = buildTurns(r.segments, r.speakers);
  if (!r.transcript && !turns.length) return '';
  if (!turns.length) {
    return `<h3>Transcript</h3><div class="card-box"><div class="transcript">${esc(r.transcript)}</div></div>`;
  }
  const rows = turns.map((t, i) => `
    <div class="tx-row" data-i="${i}">
      <div class="tx-who"><span class="av lg" style="${avatarStyle(t.shown)}">${esc(initials(t.shown))}</span>
        <div><button class="nm tx-name" data-i="${i}" title="Move this turn to another speaker, or a new one" aria-haspopup="true">${esc(t.shown)} ${icon('chevron', 12)}</button>
          ${t.start != null ? `<button class="tx-ts" data-t="${t.start}" title="Play from here">${fmtClock(t.start)}</button>` : ''}</div></div>
      <div class="tx-text">${esc(t.text)}</div>
    </div>`).join('');
  return `<h3>Transcript</h3><div class="card-box">
    <div class="tx-tools">
      <label class="tx-search">${icon('search', 15)}<input id="tx-q" type="search" placeholder="Search this transcript" aria-label="Search transcript" autocomplete="off"></label>
      <label class="chip-toggle"><input type="checkbox" id="tx-only"><span>Only matches</span></label>
      <label class="chip-toggle"><input type="checkbox" id="tx-follow" checked><span>Follow audio</span></label>
      <span class="muted" id="tx-count"></span>
    </div>
    <div class="tx-stream" id="tx-stream">${rows}</div></div>`;
}

export function wireTranscript(r, onChange = () => {}) {
  const stream = $('tx-stream');
  if (!stream) return;
  const turns = buildTurns(r.segments, r.speakers);
  const rows = [...stream.querySelectorAll('.tx-row')];
  const textOf = (i) => rows[i].querySelector('.tx-text');

  const applySearch = () => {
    const q = $('tx-q').value, only = $('tx-only').checked;
    let n = 0;
    rows.forEach((row, i) => {
      const hit = !q.trim() || turnMatches(turns[i], q);
      if (hit && q.trim()) n++;
      row.hidden = only && !hit;
      textOf(i).innerHTML = q.trim() && hit ? highlight(turns[i].text, q) : esc(turns[i].text);
    });
    $('tx-count').textContent = q.trim() ? `${n} match${n === 1 ? '' : 'es'}` : '';
  };
  $('tx-q').oninput = applySearch;
  $('tx-only').onchange = applySearch;

  stream.onclick = (e) => {
    const b = e.target.closest('.tx-ts');
    if (b) return seekTo(Number(b.dataset.t));
    const who = e.target.closest('.tx-name');
    if (who) openMoveMenu(who, turns[Number(who.dataset.i)]);
  };

  function openMoveMenu(anchor, turn) {
    if (!['ready', 'transcribed'].includes(r.status)) return;
    openMenu(anchor, moveMenuHtml(r.speakers, turn), {
      label: 'Move to another speaker',
      onClick: async (e) => {
        const o = e.target.closest('.opt[data-to]');
        if (!o) return;
        closeMenu();
        let to = o.dataset.to;
        if (to === 'auto') {
          anchor.disabled = true;
          const was = anchor.innerHTML;
          try { to = await placeByVoice(r, turn, (m) => { anchor.textContent = m; }); }
          catch (err) { anchor.disabled = false; anchor.innerHTML = was; return alert(err.message); }
        }
        const idx = o.dataset.scope === 'all'
          ? turns.filter((t) => t.label === turn.label).flatMap((t) => t.idx)
          : turn.idx;
        try {
          onChange(await api(`/recordings/${r.id}/reassign`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ segments: idx, to }),
          }));
        } catch (err) { alert(err.message); }
      },
    });
  }

  let active = -1;
  onTick((t) => {
    let i = -1;
    for (let k = 0; k < turns.length; k++) { if (turns[k].start != null && turns[k].start <= t + 0.05) i = k; else if (turns[k].start != null) break; }
    if (i === active) return;
    if (active >= 0) rows[active]?.classList.remove('active');
    active = i;
    if (i < 0) return;
    rows[i].classList.add('active');
    if ($('tx-follow')?.checked && !$('pl-audio')?.paused) {
      const top = rows[i].offsetTop - stream.offsetTop;
      if (top < stream.scrollTop || top > stream.scrollTop + stream.clientHeight - 90) stream.scrollTo({ top: Math.max(0, top - 24), behavior: 'smooth' });
    }
  });
}
