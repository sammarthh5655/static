'use strict';

const { BrowserWindow } = require('electron');
const { BrowserWindowController } = require('./window');
const ipc = require('./ipc');
const { registerIpc: registerTabsIpc } = require('../features/tabs');
const { getEngine, buildSearchUrl } = require('./lib/search-engines');

/**
 * Tracks every open browser window and resolves IPC senders back to the
 * controller that owns them (UI chrome webContents, dropdown overlay, or a
 * tab's webContents — internal pages call IPC from inside their tab).
 */
class WindowManager {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {BrowserWindowController[]} */
    this.controllers = [];
  }

  createWindow(opts = {}) {
    const controller = new BrowserWindowController(this.ctx, opts);
    this.controllers.push(controller);
    return controller;
  }

  remove(controller) {
    this.controllers = this.controllers.filter((c) => c !== controller);
  }

  /** @returns {BrowserWindowController|null} */
  fromWebContents(wc) {
    for (const c of this.controllers) {
      if (c.win.isDestroyed()) continue;
      if (c.win.webContents === wc) return c;
      if (c.dropdown && c.dropdown.webContents === wc) return c;
      if (c.tabs.fromWebContents(wc)) return c;
    }
    return null;
  }

  /** @returns {BrowserWindowController|null} */
  fromBrowserWindow(win) {
    return this.controllers.find((c) => c.win === win) || null;
  }

  focused() {
    const win = BrowserWindow.getFocusedWindow();
    return (win && this.fromBrowserWindow(win)) || this.controllers[0] || null;
  }

  /** Re-send tab snapshots to every window (e.g. after bookmarks change). */
  broadcastTabs() {
    for (const c of this.controllers) c.tabs.emitChanged();
  }

  registerIpc() {
    registerTabsIpc(this);

    ipc.handle('ui:layout', (e, { height }) => this.fromWebContents(e.sender)?.setChromeHeight(height));
    ipc.handle('ui:app-menu', (e, { x, y }) => this.fromWebContents(e.sender)?.showAppMenu(x, y));
    ipc.handle('ui:focus-tab', (e) => this.fromWebContents(e.sender)?.focusActiveTab());
    ipc.handle('ui:platform', () => ({
      platform: process.platform,
      searchEngine: getEngine(this.ctx.settings.get('searchEngine')).name,
    }));
  }
}

/** Convenience helpers hung off ctx so menus can build search URLs. */
function attachSearchHelpers(ctx) {
  ctx.searchEngineName = () => getEngine(ctx.settings.get('searchEngine')).name;
  ctx.searchUrl = (q) => buildSearchUrl(ctx.settings.get('searchEngine'), q);
}

module.exports = { WindowManager, attachSearchHelpers };
