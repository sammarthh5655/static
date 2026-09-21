'use strict';

const path = require('node:path');
const { WebContentsView } = require('electron');
const ipc = require('../../main/ipc');
const { isInternalUrl, INTERNAL_SCHEME } = require('../../main/lib/url');
const { buildTabContextMenu } = require('../../main/context-menu');

/**
 * Tabs feature.
 *
 * Each tab is a `WebContentsView` (the modern replacement for BrowserView)
 * owned by one `BrowserWindowController`. Only the *active* tab's view is
 * attached to `win.contentView`; inactive tabs stay alive (audio keeps
 * playing, loads continue) but are detached so they cost no paint work.
 *
 * All rendering of the strip happens in the UI renderer, driven purely by
 * `tabs:changed` snapshots. Main never tells the renderer "tab X changed
 * title" — it sends the whole list, which keeps the renderer a dumb function
 * of state and makes reorder/close races impossible.
 */

// Built by scripts/build-preload.js (npm run build:preload).
const TAB_PRELOAD = path.join(__dirname, '..', '..', '..', 'dist', 'tab-preload.js');
const ERROR_PAGE = `${INTERNAL_SCHEME}://error/`;

/** Network-ish error codes where retrying a bare host over http makes sense. */
const FALLBACK_ERRORS = new Set([
  -2,   // ERR_FAILED
  -102, // ERR_CONNECTION_REFUSED
  -105, // ERR_NAME_NOT_RESOLVED
  -113, // ERR_SSL_VERSION_OR_CIPHER_MISMATCH
  -118, // ERR_CONNECTION_TIMED_OUT
  -200, // ERR_CERT_COMMON_NAME_INVALID
  -201, // ERR_CERT_DATE_INVALID
  -202, // ERR_CERT_AUTHORITY_INVALID
  -501, // ERR_INSECURE_RESPONSE
]);

class Tab {
  /**
   * @param {import('../../main/window').BrowserWindowController} controller
   * @param {{url?: string}} opts
   */
  constructor(controller, opts = {}) {
    this.controller = controller;
    this.ctx = controller.ctx;

    this.view = new WebContentsView({
      webPreferences: {
        // Security defaults for ALL web content — never relax these.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        session: this.ctx.tabSession,
        // Exposes `window.staticPages` ONLY on static:// internal pages.
        preload: TAB_PRELOAD,
        scrollBounce: true,
      },
    });
    this.wc = this.view.webContents;
    this.id = this.wc.id;

    this.title = '';
    this.favicon = '';
    this.loading = false;
    /** When an error page is shown, the URL the user actually asked for. */
    this.errorUrl = null;
    /** http:// retry for https:// guesses (see lib/url.js). */
    this.pendingFallback = null;
    /** URL to display while a load is in flight (before commit). */
    this.pendingUrl = null;

    this._wire();
    if (opts.url) this.navigate(opts.url);
  }

  /** What the omnibox should show. */
  get url() {
    if (this.errorUrl) return this.errorUrl;
    const current = this.wc.getURL();
    if (!current && this.pendingUrl) return this.pendingUrl;
    return current;
  }

  navigate(url, { fallbackUrl = null } = {}) {
    this.pendingFallback = fallbackUrl;
    this.errorUrl = null;
    this.pendingUrl = url;
    this.wc.loadURL(url).catch(() => {
      // Rejections here are already surfaced via did-fail-load.
    });
  }

  reload() {
    if (this.errorUrl) return this.navigate(this.errorUrl);
    this.wc.reload();
  }

  /** Security indicator state for the omnibox. */
  get security() {
    const url = this.url || '';
    if (isInternalUrl(url) || url.startsWith('chrome-extension:')) return 'internal';
    if (url.startsWith('https:')) return 'secure';
    if (url.startsWith('http:')) return 'insecure';
    if (url.startsWith('file:')) return 'file';
    return 'none';
  }

  snapshot() {
    return {
      id: this.id,
      url: this.url,
      title: this.title || titleFromUrl(this.url),
      favicon: this.favicon,
      loading: this.loading,
      security: this.security,
      canGoBack: this.wc.navigationHistory.canGoBack(),
      canGoForward: this.wc.navigationHistory.canGoForward(),
      bookmarked: this.ctx.bookmarks.has(this.url),
      audible: this.wc.isCurrentlyAudible(),
      muted: this.wc.isAudioMuted(),
    };
  }

  _wire() {
    const wc = this.wc;
    const changed = () => this.controller.tabs.emitChanged();

    wc.on('did-start-loading', () => { this.loading = true; changed(); });
    wc.on('did-stop-loading', () => { this.loading = false; changed(); });

    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      this.ctx.history.updateTitle(wc.getURL(), title);
      changed();
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = favicons[0] || '';
      changed();
    });

    // Top-level navigation committed: reset per-navigation state, log history.
    wc.on('did-navigate', (_e, url) => {
      this.pendingUrl = null;
      if (!url.startsWith(ERROR_PAGE)) {
        this.errorUrl = null;
        this.pendingFallback = null;
      }
      this.favicon = '';
      this.title = '';
      this.ctx.history.add(url, '');
      changed();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.ctx.history.add(url, this.title);
      changed();
    });

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ERR_ABORTED: user navigated away */) return;

      // https:// guess for a bare host failed -> try http:// once.
      if (this.pendingFallback && FALLBACK_ERRORS.has(code)) {
        const fallback = this.pendingFallback;
        this.pendingFallback = null;
        this.navigate(fallback);
        return;
      }

      this.errorUrl = url;
      const q = new URLSearchParams({ code: String(code), desc, url });
      wc.loadURL(`${ERROR_PAGE}?${q}`);
      changed();
    });

    wc.on('audio-state-changed', changed);
    wc.on('media-started-playing', changed);
    wc.on('media-paused', changed);

    // Links that want a new window become tabs (Chrome behaviour for
    // target=_blank). Extension popups and window.open with features still go
    // through here; a real popup window is a natural later enhancement.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const active = disposition !== 'background-tab';
      this.controller.tabs.create({ url, active, openerId: this.id });
      return { action: 'deny' };
    });

    wc.on('context-menu', (_e, params) => {
      buildTabContextMenu(this, params).popup({ window: this.controller.win });
    });

    // HTML5 fullscreen (video players): give the tab the whole window.
    wc.on('enter-html-full-screen', () => this.controller.setContentFullscreen(true));
    wc.on('leave-html-full-screen', () => this.controller.setContentFullscreen(false));

    wc.on('before-input-event', (event, input) => {
      if (this.ctx.shortcuts.handle(this.controller, input)) event.preventDefault();
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'killed' || details.reason === 'clean-exit') return;
      this.errorUrl = wc.getURL();
      const q = new URLSearchParams({ code: 'crash', desc: `Renderer ${details.reason}`, url: this.errorUrl });
      wc.loadURL(`${ERROR_PAGE}?${q}`);
    });
  }

  destroy() {
    if (this.wc.isDestroyed()) return;
    this.wc.close();
  }
}

class TabManager {
  /** @param {import('../../main/window').BrowserWindowController} controller */
  constructor(controller) {
    this.controller = controller;
    this.ctx = controller.ctx;
    /** @type {Tab[]} ordered as displayed */
    this.tabs = [];
    this.activeId = null;
    /** Recently closed URLs for Ctrl+Shift+T. */
    this.closedStack = [];
    this._emitScheduled = false;
  }

  get active() {
    return this.get(this.activeId);
  }

  get(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  fromWebContents(wc) {
    return this.tabs.find((t) => t.wc === wc) || null;
  }

  /**
   * @param {{url?: string, active?: boolean, index?: number, openerId?: number}} opts
   */
  create(opts = {}) {
    const url = opts.url || this.ctx.settings.newTabUrl();
    const tab = new Tab(this.controller, { url });

    let index = typeof opts.index === 'number' ? opts.index : this.tabs.length;
    // Chrome opens links from a tab right next to it.
    if (opts.openerId && typeof opts.index !== 'number') {
      const openerIdx = this.tabs.findIndex((t) => t.id === opts.openerId);
      if (openerIdx !== -1) index = openerIdx + 1;
    }
    this.tabs.splice(index, 0, tab);

    // Register with the extension system so chrome.tabs.* sees it.
    this.ctx.extensions?.addTab(tab.wc, this.controller.win);

    if (opts.active !== false) this.select(tab.id);
    else this.emitChanged();
    return tab;
  }

  select(id) {
    const tab = this.get(id);
    if (!tab) return;
    const prev = this.active;
    if (prev === tab) {
      this.controller.attachTabView(tab.view);
      return;
    }
    this.activeId = tab.id;
    // Swap views: detach the old one, attach and size the new one.
    if (prev) this.controller.detachTabView(prev.view);
    this.controller.attachTabView(tab.view);
    tab.wc.focus();
    this.ctx.extensions?.selectTab(tab.wc);
    this.emitChanged();
  }

  close(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];

    if (tab.url && tab.url !== 'about:blank') {
      this.closedStack.push(tab.url);
      if (this.closedStack.length > 25) this.closedStack.shift();
    }

    this.tabs.splice(idx, 1);
    this.ctx.extensions?.removeTab(tab.wc);

    if (this.activeId === tab.id) {
      this.controller.detachTabView(tab.view);
      this.activeId = null;
      // Chrome activates the tab to the right, else the one to the left.
      const next = this.tabs[idx] || this.tabs[idx - 1];
      if (next) this.select(next.id);
    }
    tab.destroy();

    // Last tab closed -> close the window, like Chrome.
    if (this.tabs.length === 0) {
      this.controller.win.close();
      return;
    }
    this.emitChanged();
  }

  closeOthers(id) {
    for (const t of this.tabs.slice()) if (t.id !== id) this.close(t.id);
  }

  closeToRight(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    for (const t of this.tabs.slice(idx + 1)) this.close(t.id);
  }

  duplicate(id) {
    const tab = this.get(id);
    if (tab) this.create({ url: tab.url, openerId: id });
  }

  reopenClosed() {
    const url = this.closedStack.pop();
    if (url) this.create({ url });
  }

  /** New order given as an array of tab ids (from the drag-reorder UI). */
  reorder(ids) {
    const byId = new Map(this.tabs.map((t) => [t.id, t]));
    const next = [];
    for (const id of ids) {
      const t = byId.get(id);
      if (t) { next.push(t); byId.delete(id); }
    }
    // Any tab the renderer didn't know about yet keeps its relative place.
    for (const t of this.tabs) if (byId.has(t.id)) next.push(t);
    this.tabs = next;
    this.emitChanged();
  }

  /** Cycle relative to the active tab (Ctrl+Tab / Ctrl+Shift+Tab). */
  selectRelative(delta) {
    if (!this.tabs.length) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = (idx + delta + this.tabs.length) % this.tabs.length;
    this.select(this.tabs[next].id);
  }

  selectIndex(i) {
    const tab = i === 'last' ? this.tabs[this.tabs.length - 1] : this.tabs[i];
    if (tab) this.select(tab.id);
  }

  snapshot() {
    return { tabs: this.tabs.map((t) => t.snapshot()), activeId: this.activeId };
  }

  /** Coalesce bursts of events into one `tabs:changed` per tick. */
  emitChanged() {
    if (this._emitScheduled) return;
    this._emitScheduled = true;
    setImmediate(() => {
      this._emitScheduled = false;
      if (this.controller.win.isDestroyed()) return;
      ipc.send(this.controller.win.webContents, 'tabs:changed', this.snapshot());
    });
  }

  destroyAll() {
    for (const t of this.tabs) {
      this.ctx.extensions?.removeTab(t.wc);
      t.destroy();
    }
    this.tabs = [];
  }
}

function titleFromUrl(url) {
  if (!url) return 'New Tab';
  if (url.startsWith(`${INTERNAL_SCHEME}://newtab`)) return 'New Tab';
  try {
    const u = new URL(url);
    if (u.protocol === `${INTERNAL_SCHEME}:`) return u.hostname[0].toUpperCase() + u.hostname.slice(1);
    return u.host || url;
  } catch {
    return url;
  }
}

/**
 * IPC handlers for the tabs feature. Every handler resolves the window from
 * the sender so multiple windows work without any per-window registration.
 * @param {import('../../main/window-manager').WindowManager} windows
 */
function registerIpc(windows) {
  const tabsOf = (event) => windows.fromWebContents(event.sender)?.tabs;

  ipc.handle('tabs:list', (e) => tabsOf(e)?.snapshot());
  ipc.handle('tabs:new', (e, opts) => {
    const tabs = tabsOf(e);
    const tab = tabs?.create(opts || {});
    return tab?.id;
  });
  ipc.handle('tabs:close', (e, id) => tabsOf(e)?.close(id));
  ipc.handle('tabs:select', (e, id) => tabsOf(e)?.select(id));
  ipc.handle('tabs:reorder', (e, ids) => tabsOf(e)?.reorder(ids));
  ipc.handle('tabs:duplicate', (e, id) => tabsOf(e)?.duplicate(id));
  ipc.handle('tabs:reopen-closed', (e) => tabsOf(e)?.reopenClosed());

  // `id` optional: defaults to the active tab. Internal pages navigate the
  // tab they live in (their sender *is* the tab webContents).
  const target = (e, id) => {
    const tabs = tabsOf(e);
    if (!tabs) return null;
    if (typeof id === 'number') return tabs.get(id);
    return tabs.fromWebContents(e.sender) || tabs.active;
  };

  ipc.handle('tabs:navigate', (e, url, id) => target(e, id)?.navigate(url));
  ipc.handle('tabs:back', (e, id) => target(e, id)?.wc.navigationHistory.goBack());
  ipc.handle('tabs:forward', (e, id) => target(e, id)?.wc.navigationHistory.goForward());
  ipc.handle('tabs:reload', (e, id) => target(e, id)?.reload());
  ipc.handle('tabs:stop', (e, id) => target(e, id)?.wc.stop());
  ipc.handle('tabs:home', (e, id) => target(e, id)?.navigate(windows.ctx.settings.homepageUrl()));

  ipc.handle('tabs:context-menu', (e, id) => {
    const controller = windows.fromWebContents(e.sender);
    if (controller) controller.showTabStripMenu(id);
  });
}

module.exports = { Tab, TabManager, registerIpc };
