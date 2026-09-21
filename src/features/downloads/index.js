'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, shell, dialog, BrowserWindow } = require('electron');
const { JsonStore } = require('../../main/lib/json-store');
const ipc = require('../../main/ipc');

/**
 * Downloads feature.
 *
 * Electron surfaces downloads through `session.on('will-download')`. We keep
 * the live `DownloadItem` objects in memory (for cancel/pause/resume) and a
 * serialisable record per download in `userData/downloads.json` so completed
 * downloads survive a restart.
 *
 * Record shape: { id, url, filename, savePath, state, receivedBytes,
 *                 totalBytes, startTime, endTime, mime }
 * state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
 */
class Downloads {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new JsonStore('downloads', { items: [] });
    this._nextId = this.store.data.items.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1;
    /** @type {Map<number, Electron.DownloadItem>} */
    this.live = new Map();

    // Anything still marked progressing from a previous run was interrupted.
    for (const d of this.store.data.items) {
      if (d.state === 'progressing') d.state = 'interrupted';
    }
  }

  attach(tabSession) {
    tabSession.on('will-download', (event, item, wc) => this._onWillDownload(item, wc));
  }

  _onWillDownload(item, wc) {
    const record = {
      id: this._nextId++,
      url: item.getURL(),
      filename: item.getFilename(),
      savePath: '',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startTime: Date.now(),
      endTime: null,
      mime: item.getMimeType(),
      paused: false,
    };

    // Chrome-like default: save straight into ~/Downloads with a unique name,
    // unless the user opted into "ask where to save" (then Electron shows the
    // native save dialog because we don't call setSavePath).
    if (!this.ctx.settings.get('askWhereToSave')) {
      const dir = app.getPath('downloads');
      item.setSavePath(uniquePath(dir, item.getFilename()));
    } else {
      const win = BrowserWindow.fromWebContents(wc);
      if (win) item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    }

    this.store.data.items.unshift(record);
    this.live.set(record.id, item);
    this._changed();

    item.on('updated', (_e, state) => {
      record.savePath = item.getSavePath();
      record.filename = path.basename(record.savePath || record.filename);
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.paused = item.isPaused();
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      this._changed();
    });

    item.once('done', (_e, state) => {
      record.savePath = item.getSavePath();
      record.filename = path.basename(record.savePath || record.filename);
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.state = state; // completed | cancelled | interrupted
      record.endTime = Date.now();
      record.paused = false;
      this.live.delete(record.id);
      this._changed();
    });
  }

  list() {
    return this.store.data.items.slice(0, 500);
  }

  _find(id) {
    return this.store.data.items.find((d) => d.id === id);
  }

  async open(id) {
    const d = this._find(id);
    if (!d || d.state !== 'completed' || !d.savePath) return false;
    const err = await shell.openPath(d.savePath);
    return !err;
  }

  showInFolder(id) {
    const d = this._find(id);
    if (!d || !d.savePath) return false;
    if (fs.existsSync(d.savePath)) shell.showItemInFolder(d.savePath);
    else shell.openPath(path.dirname(d.savePath));
    return true;
  }

  cancel(id) {
    const item = this.live.get(id);
    if (item) item.cancel();
    return !!item;
  }

  pause(id) {
    const item = this.live.get(id);
    if (item && !item.isPaused()) item.pause();
    return !!item;
  }

  resume(id) {
    const item = this.live.get(id);
    if (item && item.canResume()) item.resume();
    return !!item;
  }

  /** Remove a single entry from the list (does not delete the file). */
  remove(id) {
    this.cancel(id);
    const items = this.store.data.items;
    const idx = items.findIndex((d) => d.id === id);
    if (idx !== -1) items.splice(idx, 1);
    this._changed();
  }

  /** Clear finished entries; in-progress downloads stay. */
  clearList() {
    this.store.data.items = this.store.data.items.filter((d) => d.state === 'progressing');
    this._changed();
  }

  _changed() {
    this.store.save();
    ipc.broadcast('downloads:changed', this.list());
  }

  registerIpc() {
    ipc.handle('downloads:list', () => this.list());
    ipc.handle('downloads:open', (_e, id) => this.open(id));
    ipc.handle('downloads:show-in-folder', (_e, id) => this.showInFolder(id));
    ipc.handle('downloads:cancel', (_e, id) => this.cancel(id));
    ipc.handle('downloads:pause', (_e, id) => this.pause(id));
    ipc.handle('downloads:resume', (_e, id) => this.resume(id));
    ipc.handle('downloads:remove', (_e, id) => this.remove(id));
    ipc.handle('downloads:clear', () => this.clearList());
  }
}

/** "file.zip" -> "file (1).zip" if needed. */
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n++})${ext}`);
  }
  return candidate;
}

module.exports = { Downloads };
