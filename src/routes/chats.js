// Ask threads (#2): a chat is a titled sequence of user/assistant messages.
// Retrieval is unchanged — each turn just reuses retrieve()/answer() with history.

import { json, fail, uid } from '../http.js';
import { safeParse, chatTitleFrom, historyToMessages } from '../text.js';
import { retrieve, answer, deepResearch } from './ask.js';

const chatMessageRow = (m) => ({ ...m, sources: safeParse(m.sources) || [] });

export async function listChats(env, owner) {
  return (await env.DB.prepare(
    `SELECT c.id, c.title, c.created_at, COUNT(m.id) AS message_count
       FROM chats c LEFT JOIN chat_messages m ON m.chat_id = c.id
      WHERE c.owner = ?
      GROUP BY c.id
      ORDER BY c.created_at DESC LIMIT 100`
  ).bind(owner).all()).results;
}

export async function createChat(request, env, owner) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim() || 'New chat';
  const id = uid();
  const created_at = Date.now();
  await env.DB.prepare('INSERT INTO chats (id, owner, title, created_at) VALUES (?,?,?,?)')
    .bind(id, owner, title, created_at).run();
  return json({ id, title, created_at });
}

export async function readChat(env, id, owner) {
  const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!chat) return null;
  const rows = (await env.DB.prepare(
    'SELECT id, role, content, sources, created_at FROM chat_messages WHERE chat_id = ? ORDER BY created_at'
  ).bind(id).all()).results;
  return { chat, messages: rows.map(chatMessageRow) };
}

export async function deleteChat(env, id, owner) {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!chat) return fail('not found', 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chat_messages WHERE chat_id = ?').bind(id),
    env.DB.prepare('DELETE FROM chats WHERE id = ? AND owner = ?').bind(id, owner),
  ]);
  return json({ ok: true });
}

export async function postChatMessage(request, env, owner, chatId) {
  const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ? AND owner = ?').bind(chatId, owner).first();
  if (!chat) return fail('not found', 404);
  const { question, mode, area } = await request.json().catch(() => ({}));
  if (!question || typeof question !== 'string') return fail('question required');

  const prior = (await env.DB.prepare(
    'SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY created_at'
  ).bind(chatId).all()).results;

  const userMessageId = uid();
  await env.DB.prepare(
    'INSERT INTO chat_messages (id, chat_id, role, content, created_at) VALUES (?,?,?,?,?)'
  ).bind(userMessageId, chatId, 'user', question, Date.now()).run();

  if (!prior.length && chat.title === 'New chat') {
    await env.DB.prepare('UPDATE chats SET title = ? WHERE id = ? AND owner = ?')
      .bind(chatTitleFrom(question), chatId, owner).run();
  }

  /* --- #3 deep research --- */
  // mode:'deep' runs the sub-question loop instead of the single-pass retrieve()+answer();
  // sub_questions is only returned for this turn's response, not persisted on the row
  // (chat_messages has no column for it — the message shape stays the same either way).
  let result;
  try {
    result = mode === 'deep'
      ? await deepResearch(env, owner, question, historyToMessages(prior), area)
      : await answer(env, await retrieve(env, owner, question, area), question, historyToMessages(prior));
  } catch (e) {
    // Do not leave a dangling user turn: the thread would show a question with no
    // reply, and the next turn's history would carry it as unanswered context.
    await env.DB.prepare('DELETE FROM chat_messages WHERE id = ? AND chat_id = ?')
      .bind(userMessageId, chatId).run();
    throw e;
  }
  const { answer: text, sources, sub_questions } = result;
  /* --- /#3 deep research --- */

  await env.DB.prepare(
    'INSERT INTO chat_messages (id, chat_id, role, content, sources, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(uid(), chatId, 'assistant', text, JSON.stringify(sources), Date.now()).run();

  const rows = (await env.DB.prepare(
    'SELECT id, role, content, sources, created_at FROM chat_messages WHERE chat_id = ? ORDER BY created_at'
  ).bind(chatId).all()).results;

  return json({ answer: text, sources, sub_questions, messages: rows.map(chatMessageRow) });
}
