const fs = require('node:fs');
const { shell } = require('electron');
const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');
class Downloads {
  /**
   * @param {Function} changed  the list changed
   * @param {Function} [started]  (record, webContents) a download began, so
   *   its window can show it arriving
   */
  constructor(dir, session, changed, started = () => {}) {
    this.store = new JsonStore(dir, 'downloads', []);
    this.items = new Map();
    this.changed = changed;
    this.started = started;
    this.store.data.forEach(d => { if (d.state === 'progressing') d.state = 'interrupted'; });
    // A download Safe Browsing stopped before it began is not one (features/netguard).
    session.on('will-download', (event, item, contents) => {
      if (event.defaultPrevented) return;
      const record = this.track(item);
      this.started(record, contents);
    });
  }
  track(item) {
    const record = { id: randomUUID(), name: item.getFilename(), url: item.getURL(), path: '', received: 0, total: item.getTotalBytes(), state: 'progressing', startedAt: Date.now() };
    this.store.data.unshift(record);
    this.items.set(record.id, item);
    const refresh = () => {
      record.path = item.getSavePath();
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      this.changed();
    };
    item.on('updated', (_event, state) => { record.state = state; refresh(); });
    item.once('done', (_event, state) => {
      record.state = state; refresh(); this.items.delete(record.id); this.store.save(); this.changed();
    });
    this.changed();
    return record;
  }
  list() { return this.store.data; }
  reveal(id) {
    const item = this.list().find(d => d.id === id);
    if (item?.path) shell.showItemInFolder(item.path);
  }
  /** Open a finished download with its usual app, as a click in Chrome's list does. */
  async open(id) {
    const item = this.list().find(d => d.id === id);
    if (!item?.path || item.state !== 'completed' || !fs.existsSync(item.path)) return { ok: false, error: 'This file has been moved or deleted.' };
    const error = await shell.openPath(item.path);
    return error ? { ok: false, error } : { ok: true };
  }
  cancel(id) { this.items.get(id)?.cancel(); }
  clear() {
    this.store.save(this.list().filter(d => this.items.has(d.id)));
    this.changed();
  }
  flush() { this.store.save(); }
}
module.exports = { Downloads };
