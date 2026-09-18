const { shell } = require('electron');
const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');
class Downloads {
  constructor(dir, session, changed) {
    this.store = new JsonStore(dir, 'downloads', []);
    this.items = new Map();
    this.changed = changed;
    this.store.data.forEach(d => { if (d.state === 'progressing') d.state = 'interrupted'; });
    session.on('will-download', (_event, item) => this.track(item));
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
  }
  list() { return this.store.data; }
  reveal(id) {
    const item = this.list().find(d => d.id === id);
    if (item?.path) shell.showItemInFolder(item.path);
  }
  cancel(id) { this.items.get(id)?.cancel(); }
  clear() {
    this.store.save(this.list().filter(d => this.items.has(d.id)));
    this.changed();
  }
  flush() { this.store.save(); }
}
module.exports = { Downloads };
