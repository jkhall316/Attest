// The two sidebar lists. Kept separate from the detail views so recordings.js and
// chats.js can both refresh the sidebar without importing each other.

import { $, esc } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { groupByDate, fmtDuration, STATUS_LABEL, initials, avatarStyle } from './format.js';

export const avatarCluster = (names) => {
  const list = (names || []).slice(0, 3);
  return list.length ? `<span class="avs" title="${esc((names || []).join(', '))}">${list.map((n) => `<span class="av" style="${avatarStyle(n)}">${esc(initials(n))}</span>`).join('')}</span>` : '';
};

export function recordingCard(r, activeId) {
  const d = new Date(r.created_at);
  const dur = fmtDuration(r.duration_ms);
  return `<div class="card ${r.id === activeId ? 'active' : ''}" data-id="${r.id}" ${r.error ? `title="${esc(r.error)}"` : ''}>
    <div class="t">${esc(r.title)}</div>
    <div class="rmeta">${avatarCluster(r.people)}${dur ? `<span title="Duration">${dur}</span>` : ''}
      <span>${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><span class="sp"></span>
      <span class="pill ${r.status}">${STATUS_LABEL[r.status] || esc(r.status)}</span></div>
  </div>`;
}

export async function refresh() {
  const onRecording = Boolean(state.current);
  $('home')?.classList.toggle('active', !onRecording && state.screen === 'today');
  $('nav-ask')?.classList.toggle('active', !onRecording && state.screen === 'ask');
  const { recordings } = await api('/recordings');
  $('count').textContent = recordings.length ? `(${recordings.length})` : '';
  $('list').innerHTML = groupByDate(recordings).map((g) =>
    `<div class="group-title">${g.label}</div>${g.items.map((r) => recordingCard(r, state.current)).join('')}`).join('')
    || '<div class="muted">Nothing yet.</div>';
}

// Rendered into the Ask screen's list when that screen is showing; otherwise a no-op.
export async function refreshChats() {
  const box = $('chat-list');
  if (!box) return;
  const { chats } = await api('/chats');
  box.innerHTML = chats.map((c) => `<div class="task chatrow" data-chat-id="${c.id}" style="cursor:pointer">
      <span class="body"><b>${esc(c.title)}</b>
        <span class="meta"><span>${c.message_count} message${c.message_count === 1 ? '' : 's'}</span><span>${new Date(c.created_at).toLocaleDateString()}</span></span></span></div>`).join('')
    || '<div class="muted" style="padding:12px 0">No chats yet. Ask a question above and it starts one.</div>';
}
