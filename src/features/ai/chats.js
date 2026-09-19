const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');

/**
 * Chat history for the AI page.
 *
 * One file holding every conversation, newest first. Each conversation is a
 * flat list of turns, because the AI page shows a linear transcript - there is
 * no branching to model.
 *
 * Conversations are capped so the file cannot grow without bound; a browser
 * should not accumulate an unbounded chat log on disk by default.
 */
const MAX_CHATS = 200;
const MAX_TURNS = 200;

/** Title generated from the first question, since users rarely name chats. */
function deriveTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + '…' : clean;
}

class Chats {
  constructor(dir) {
    this.store = new JsonStore(dir, 'ai-chats', { chats: [] });
    if (!Array.isArray(this.store.data.chats)) this.store.data.chats = [];
  }

  /** Summaries only - the AI page sidebar does not need full transcripts. */
  list() {
    return this.store.data.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      turns: chat.turns.length,
      pinned: !!chat.pinned,
    }));
  }

  get(id) {
    return this.store.data.chats.find((chat) => chat.id === id) || null;
  }

  create(now) {
    const chat = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      turns: [],
    };
    this.store.data.chats.unshift(chat);
    this.#trim();
    this.store.save();
    return chat;
  }

  /**
   * Append one turn. `role` is 'user' or 'model'.
   *
   * The first user turn also names the conversation, so a chat is identifiable
   * in the sidebar without the user having to title it.
   */
  addTurn(id, { role, text, model, now }) {
    const chat = this.get(id);
    if (!chat) return null;
    chat.turns.push({ role, text: String(text || ''), model: model || null, at: now });
    if (chat.turns.length > MAX_TURNS) chat.turns.splice(0, chat.turns.length - MAX_TURNS);
    if (role === 'user' && chat.title === 'New chat') chat.title = deriveTitle(text);
    chat.updatedAt = now;
    this.#touch(chat);
    this.store.save();
    return chat;
  }

  rename(id, title) {
    const chat = this.get(id);
    if (!chat) return null;
    chat.title = deriveTitle(title);
    this.store.save();
    return chat;
  }

  setPinned(id, pinned) {
    const chat = this.get(id);
    if (!chat) return null;
    chat.pinned = !!pinned;
    this.store.save();
    return chat;
  }

  remove(id) {
    const before = this.store.data.chats.length;
    this.store.data.chats = this.store.data.chats.filter((chat) => chat.id !== id);
    if (this.store.data.chats.length !== before) this.store.save();
    return { ok: true };
  }

  clear() {
    // Pinned conversations survive "clear all" - losing a kept chat to a
    // misclick is worse than leaving a few behind.
    this.store.data.chats = this.store.data.chats.filter((chat) => chat.pinned);
    this.store.save();
    return { ok: true };
  }

  /**
   * The turns to send as conversation context, oldest first, excluding the
   * question just asked. Capped: a long chat would otherwise grow every
   * request until it hit the model's input limit.
   */
  contextTurns(id, limit = 12) {
    const chat = this.get(id);
    if (!chat) return [];
    return chat.turns.slice(-limit).map((turn) => ({ role: turn.role, text: turn.text }));
  }

  /** Most recent first, pinned above the rest. */
  #touch(chat) {
    this.store.data.chats = [
      chat,
      ...this.store.data.chats.filter((other) => other.id !== chat.id),
    ];
  }

  #trim() {
    if (this.store.data.chats.length <= MAX_CHATS) return;
    // Never drop a pinned chat to make room.
    const pinned = this.store.data.chats.filter((chat) => chat.pinned);
    const rest = this.store.data.chats.filter((chat) => !chat.pinned);
    this.store.data.chats = [...pinned, ...rest].slice(0, MAX_CHATS);
  }

  flush() { this.store.save(); }
}

module.exports = { Chats, deriveTitle };
