const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');
class History {
  constructor(dir) { this.store = new JsonStore(dir, 'history', []); }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  record(url, title) {
    if (!/^https?:\/\//.test(url)) return null;
    const entry = { id: randomUUID(), url, title: title || url, visitedAt: Date.now() };
    this.store.data.unshift(entry);
    this.store.data.length = Math.min(this.store.data.length, 50000);
    this.schedule();
    return entry.id;
  }
  title(id, title) {
    const entry = this.store.data.find(item => item.id === id);
    if (entry) { entry.title = String(title).slice(0, 1000); this.schedule(); }
  }
  search(query = '', limit = 500) {
    const q = String(query).toLowerCase();
    return this.store.data.filter(item => (item.url + ' ' + item.title).toLowerCase().includes(q)).slice(0, limit);
  }
  suggest(query, bookmarks) {
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    const unique = new Map();
    for (const item of [...bookmarks.map(b => ({ ...b, source: 'bookmark' })), ...this.search(q, 200).map(h => ({ ...h, source: 'history' }))]) {
      if ((item.url + ' ' + item.title).toLowerCase().includes(q) && !unique.has(item.url)) unique.set(item.url, item);
      if (unique.size >= 8) break;
    }
    return [...unique.values()];
  }
  remove(id) { this.store.data = this.store.data.filter(item => item.id !== id); this.flush(); }
  clear() { this.store.data = []; this.flush(); }
  flush() { clearTimeout(this.timer); this.store.save(); }
}
module.exports = { History };
