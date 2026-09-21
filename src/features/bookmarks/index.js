'use strict';

const { JsonStore } = require('../../main/lib/json-store');
const ipc = require('../../main/ipc');

/**
 * Bookmarks feature — flat list persisted to `userData/bookmarks.json`.
 * Each item: `{ id, url, title, favicon, added }`. Folders are intentionally left out
 * for now; add a `parentId` field when the time comes.
 */
class Bookmarks {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new JsonStore('bookmarks', { items: [] });
    this._nextId = this.store.data.items.reduce((m, b) => Math.max(m, b.id || 0), 0) + 1;
  }

  get items() {
    return this.store.data.items;
  }

  list() {
    return this.items.slice();
  }

  find(url) {
    return this.items.find((b) => b.url === url) || null;
  }

  has(url) {
    return !!this.find(url);
  }

  add(url, title, favicon = '') {
    if (!url) return null;
    const existing = this.find(url);
    if (existing) return existing;
    const item = { id: this._nextId++, url, title: title || url, favicon: favicon || '', added: Date.now() };
    this.items.push(item);
    this._changed();
    return item;
  }

  remove(id) {
    const idx = this.items.findIndex((b) => b.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this._changed();
    return true;
  }

  update(id, patch) {
    const item = this.items.find((b) => b.id === id);
    if (!item) return null;
    if (typeof patch.title === 'string' && patch.title) item.title = patch.title;
    if (typeof patch.url === 'string' && patch.url) item.url = patch.url;
    this._changed();
    return item;
  }

  /** Star button: returns `{ bookmarked, item }` after toggling. */
  toggle(url, title, favicon = '') {
    const existing = this.find(url);
    if (existing) {
      this.remove(existing.id);
      return { bookmarked: false, item: null };
    }
    return { bookmarked: true, item: this.add(url, title, favicon) };
  }

  /** Omnibox suggestions from bookmarks. */
  suggest(query, limit = 3) {
    const q = query.toLowerCase();
    return this.items
      .filter((b) => b.url.toLowerCase().includes(q) || b.title.toLowerCase().includes(q))
      .slice(0, limit);
  }

  _changed() {
    this.store.save();
    ipc.broadcast('bookmarks:changed', this.list());
    // The star in the omnibox is derived from tab state; refresh it.
    this.ctx.windows?.broadcastTabs();
  }

  registerIpc() {
    ipc.handle('bookmarks:list', () => this.list());
    ipc.handle('bookmarks:add', (_e, url, title, favicon) => this.add(url, title, favicon));
    ipc.handle('bookmarks:remove', (_e, id) => this.remove(id));
    ipc.handle('bookmarks:update', (_e, id, patch) => this.update(id, patch || {}));
    ipc.handle('bookmarks:toggle', (_e, url, title, favicon) => this.toggle(url, title, favicon));
  }
}

module.exports = { Bookmarks };
