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
}
module.exports = { Bookmarks };
