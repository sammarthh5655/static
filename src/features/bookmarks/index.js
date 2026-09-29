const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');
const { allowedURL } = require('../../shared/urls');
class Bookmarks {
  constructor(dir) { this.store = new JsonStore(dir, 'bookmarks', []); }
  list() { return this.store.data; }
  toggle(url, title) {
    if (!allowedURL(url)) throw new Error('This page cannot be bookmarked.');
    const exists = this.list().find(item => item.url === url);
    if (exists) this.remove(exists.id);
    else this.store.save([...this.list(), { id: randomUUID(), url, title: String(title || url).slice(0, 1000), createdAt: Date.now() }]);
  }
  remove(id) { this.store.save(this.list().filter(item => item.id !== id)); }
  /** Add many at once (an import). Web pages only; ones already here are skipped. */
  importMany(items, source) {
    const have = new Set(this.list().map(item => item.url));
    const added = [];
    for (const item of items || []) {
      const url = String(item?.url || '');
      if (!/^https?:\/\//i.test(url) || !allowedURL(url) || have.has(url)) continue;
      have.add(url);
      added.push({ id: randomUUID(), url, title: String(item.title || url).slice(0, 1000),
        folder: String(item.folder || '').slice(0, 200) || undefined, source, createdAt: Number(item.createdAt) || Date.now() });
    }
    if (added.length) this.store.save([...this.list(), ...added]);
    return added.length;
  }
}
module.exports = { Bookmarks };
