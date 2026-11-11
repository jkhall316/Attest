// Ask threads (#2): thread list lives in lists.js, this is the conversation view.

import { $, esc, md } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { refresh, refreshChats } from './lists.js';
import { open } from './recordings.js';
import { deepToggle, deepHint, wireDeep } from './ask.js';

// The Ask screen (sidebar "Ask & chats"): one prominent question box, and your past chats.
export async function showAsk() {
  state.current = null; state.currentChat = null; state.screen = 'ask';
  refresh();
  $('main').innerHTML = `
    <h2>Ask Attest</h2>
    <div class="muted" style="margin-bottom:12px">Ask anything across everything you have recorded. Answers cite the recordings they came from.
      ${state.META?.vectors_enabled ? 'Searching <b>by meaning</b>, so you do not need the exact words.' : 'Searching by keywords (turn on semantic search to search by meaning; see the README).'}</div>
    <div class="row"><input id="ask-q" style="flex:1" placeholder="What did we decide about pricing? Who owes me a reply?" autofocus>
      ${deepToggle('ask-deep')}
      <button class="primary" id="ask-go">Ask</button></div>
    ${deepHint('ask-deep')}
    <h3>Your chats</h3>
    <div id="chat-list" class="list"><div class="muted" style="padding:12px 0">Loading…</div></div>`;
  wireDeep('ask-deep');
  const go = () => {
    const q = $('ask-q').value.trim();
    if (q) startChat(q, $('ask-deep').checked);
  };
  $('ask-go').onclick = go;
  $('ask-q').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  await refreshChats();
  $('chat-list').onclick = (e) => {
    const row = e.target.closest('[data-chat-id]');
    if (row) openChat(row.dataset.chatId);
  };
}

// New thread from a question typed anywhere (Ask screen, Today), answered right away.
export async function startChat(question, deep = false) {
  const chat = await api('/chats', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: question.slice(0, 60) }),
  });
  await openChat(chat.id);
  $('chat-q').value = question;
  if (deep) { $('chat-q-deep').checked = true; $('chat-q-deep-hint').hidden = false; }
  await sendChatMessage(chat.id);
}

export async function openChat(id) {
  state.currentChat = id;
  state.current = null;
  state.screen = 'ask';
  await refresh();
  const { chat, messages } = await api('/chats/' + id);
  renderChat(chat, messages);
}

function renderChat(chat, messages) {
  $('main').innerHTML = `
    <a href="#" class="crumb" id="back-ask">← Ask &amp; chats</a>
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <h2 style="margin:0">${esc(chat.title)}</h2>
      <button id="del-chat">Delete</button>
    </div>
    <div id="chat-messages" class="stack" style="margin-top:14px"></div>
    <div class="row" style="margin-top:14px">
      <input id="chat-q" style="flex:1" placeholder="Ask about any recording…">
      ${deepToggle('chat-q-deep')}
      <button class="primary" id="chat-send">Send</button>
    </div>
    ${deepHint('chat-q-deep')}`;
  wireDeep('chat-q-deep');
  $('back-ask').onclick = (e) => { e.preventDefault(); showAsk(); };
  renderChatMessages(messages);
  $('del-chat').onclick = async () => {
    if (!confirm('Delete this chat?')) return;
    await fetch('/api/chats/' + chat.id, { method: 'DELETE' });
    showAsk();
  };
  $('chat-send').onclick = () => sendChatMessage(chat.id);
  $('chat-q').onkeydown = (e) => { if (e.key === 'Enter') sendChatMessage(chat.id); };
}

function renderChatMessages(messages, subQuestions) {
  const box = $('chat-messages');
  // sub_questions is this turn's response only (not persisted on chat_messages), so it
  // only ever decorates the last assistant bubble, never a reloaded history.
  box.innerHTML = messages.map((msg, i) => `
    <div class="bubble ${msg.role}">
      <div class="md">${md(msg.content)}</div>
      ${i === messages.length - 1 && msg.role === 'assistant' && subQuestions?.length ?
        `<div class="muted" style="margin-top:6px">Searched for: ${subQuestions.map(esc).join(' · ')}</div>` : ''}
      ${msg.sources?.length ? `<div class="src">${msg.sources.map((s) =>
        `<a data-rec-id="${s.id}">${esc(s.title)}</a>`).join('')}</div>` : ''}
    </div>`).join('') || '<div class="muted">Say something.</div>';
  box.querySelectorAll('[data-rec-id]').forEach((a) => { a.onclick = () => open(a.dataset.recId); });
  box.scrollTop = box.scrollHeight;
}

async function sendChatMessage(chatId) {
  const input = $('chat-q');
  const q = input.value.trim();
  if (!q || state.chatSending) return;
  state.chatSending = true;
  const deep = $('chat-q-deep')?.checked;
  input.value = '';
  const box = $('chat-messages');
  box.insertAdjacentHTML('beforeend', `<div class="bubble user"><div class="md">${md(q)}</div></div>`);
  if (deep) box.insertAdjacentHTML('beforeend', '<div class="muted" id="chat-researching">Researching… (3 passes)</div>');
  box.scrollTop = box.scrollHeight;
  try {
    const { messages, sub_questions } = await api(`/chats/${chatId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: q, mode: deep ? 'deep' : undefined }),
    });
    $('chat-researching')?.remove();
    renderChatMessages(messages, sub_questions);
    refreshChats();
  } catch (e) {
    $('chat-researching')?.remove();
    box.insertAdjacentHTML('beforeend', `<div class="banner">${esc(e.message)}</div>`);
  }
  state.chatSending = false;
}
