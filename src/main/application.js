const path = require('node:path');
const { app, session, ipcMain, BaseWindow, WebContentsView, Menu, shell, clipboard } = require('electron');
const { requests, events } = require('../shared/channels');
const { ENGINES, internalPage, resolveInput, allowedURL } = require('../shared/urls');
const { Settings, DEFAULTS } = require('../features/settings');
const { Bookmarks } = require('../features/bookmarks');
const { History } = require('../features/history');
const { Downloads } = require('../features/downloads');
const { Extensions } = require('../features/extensions');
const { Tabs, NEW_TAB } = require('../features/tabs');

/** Height of the browser chrome (tab strip + toolbar). Mirrors renderer CSS. */
const CHROME_HEIGHT = 88;
/** Extra height when the bookmarks bar is visible. Mirrors renderer CSS. */
const BOOKMARKS_BAR_HEIGHT = 34;

/**
 * Top-level application object: owns the window, the chrome UI view, all
 * feature modules, and the IPC surface between them.
 *
 * Window composition (read before changing layout):
 *   BaseWindow.contentView
 *     +- chrome view   (our local UI: tab strip, omnibox, bookmarks bar)
 *     +- active tab view (managed by features/tabs, positioned below chrome)
 * The chrome is a WebContentsView like any tab, but it is the ONLY view with
 * a preload that exposes IPC. Tabs get a preload that exposes nothing unless
 * the page is a trusted browser:// internal page.
 */
class BrowserApplication {
  constructor() {
    this.dir = app.getPath('userData');
    this.window = null;
    this.chrome = null;
    this.tabs = null;
    this.extensions = null;
    this.session = session.defaultSession;
    this.notice = null;
  }

  async start() {
    this.settings = new Settings(this.dir);
    this.bookmarks = new Bookmarks(this.dir);
    this.history = new History(this.dir);
    this.downloads = new Downloads(this.dir, this.session, () => this.push());

    this.#hardenSession();
    this.ensureWindow();
    this.#registerIpc();
    this.#installMenu();

    // Extensions come last: they need the window to exist so popups and
    // chrome.tabs.create have somewhere to go.
    this.extensions = new Extensions({
      dir: this.dir,
      session: this.session,
      window: this.window,
      onChange: () => this.push(),
      createTab: (details) => {
        const id = this.tabs.create({ url: details?.url, background: details?.active === false });
        return this.tabs.tabs.get(id)?.view.webContents || null;
      },
      selectTab: (contents) => {
        const tab = this.#tabByContents(contents);
        if (tab) this.tabs.select(tab.id);
      },
      removeTab: (contents) => {
        const tab = this.#tabByContents(contents);
        if (tab) this.tabs.close(tab.id);
      },
    });
    this.tabs.extensions = this.extensions;

    try {
      await this.extensions.start();
    } catch (error) {
      // A failed extension subsystem must not take the whole browser down.
      console.error('Extension subsystem failed to start:', error);
      this.notify('Extensions failed to load: ' + error.message);
    }
  }

  /**
   * Session-wide security policy applied to ALL web content.
   * Permissions default to denied; only a small explicit set may even prompt.
   */
  #hardenSession() {
    const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
    this.session.setPermissionRequestHandler((contents, permission, callback) => {
      // Extension pages get their manifest-declared permissions from the
      // extensions library; everything else is denied unless allowlisted.
      const url = contents?.getURL?.() || '';
      if (url.startsWith('chrome-extension://')) return callback(true);
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    this.session.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission));

    // Block attaching a webview tag anywhere, and strip any preload a page
    // tries to smuggle in through window.open features.
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event) => event.preventDefault());
    });
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;

    this.window = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 640,
      minHeight: 420,
      title: 'static',
      backgroundColor: '#1f1f1f',
      show: false,
    });

    // The chrome UI. Its preload is the esbuild bundle (scripts/build.cjs)
    // because it must bundle electron-chrome-extensions' browser-action code.
    this.chrome = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.join(app.getAppPath(), 'build', 'chrome.preload.cjs'),
        session: this.session,
      },
    });
    this.window.contentView.addChildView(this.chrome);
    this.chrome.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    this.tabs = new Tabs({
      window: this.window,
      session: this.session,
      preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
      extensions: this.extensions,
      getEngine: () => this.settings.value.searchEngine,
      onChange: () => this.push(),
      onNavigate: (event) => {
        if (event.type === 'visit') return this.history.record(event.url, event.title);
        if (event.type === 'title') this.history.title(event.id, event.title);
        return null;
      },
    });

    this.window.on('resize', () => this.layout());
    this.window.on('close', () => this.flush());
    this.window.once('ready-to-show', () => this.window.show());

    // Chrome renders first; the tab view is positioned by layout().
    this.chrome.webContents.once('did-finish-load', () => {
      this.layout();
      if (!this.tabs.order.length) this.tabs.create({ url: this.#startUrl() });
      this.window.show();
      this.push();
    });

    this.layout();
    return this.window;
  }

  #startUrl() {
    const s = this.settings.value;
    return s.newTabBehavior === 'homepage' ? s.homepage : NEW_TAB;
  }

  /** Position the chrome across the top and give tabs the remaining area. */
  layout() {
    if (!this.window || this.window.isDestroyed()) return;
    const { width, height } = this.window.getContentBounds();
    const chromeHeight = CHROME_HEIGHT + (this.settings.value.bookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0);
    this.chrome.setBounds({ x: 0, y: 0, width, height: chromeHeight });
    this.tabs?.setBounds({
      x: 0,
      y: chromeHeight,
      width,
      height: Math.max(0, height - chromeHeight),
    });
  }

  #tabByContents(contents) {
    if (!contents) return null;
    for (const tab of this.tabs.tabs.values()) {
      if (tab.view.webContents === contents) return tab;
    }
    return null;
  }

  /** Full UI state. One shape, pushed on every change - the chrome is a pure
   *  render of this object, which keeps state bugs out of the renderer. */
  state() {
    return {
      platform: process.platform,
      tabs: this.tabs ? this.tabs.list() : [],
      active: this.tabs ? this.tabs.activeState() : {},
      bookmarks: this.bookmarks.list(),
      bookmarked: this.#activeIsBookmarked(),
      downloads: this.downloads.list().slice(0, 100),
      // The new tab page builds its most-visited grid from this slice.
      history: this.history.store.data.slice(0, 300),
      settings: this.settings.value,
      engines: Object.keys(ENGINES),
      extensions: this.extensions ? this.extensions.list() : [],
      notice: this.notice,
    };
  }

  #activeIsBookmarked() {
    const url = this.tabs?.activeState().url;
    return !!url && this.bookmarks.list().some(b => b.url === url);
  }

  /** Push state to the chrome renderer and any open internal pages. */
  push() {
    const payload = this.state();
    if (this.chrome && !this.chrome.webContents.isDestroyed()) {
      this.chrome.webContents.send('app:state', payload);
    }
    for (const tab of this.tabs?.tabs.values() || []) {
      const wc = tab.view.webContents;
      if (!wc.isDestroyed() && tab.state.internalUrl) wc.send('app:state', payload);
    }
  }

  notify(message) {
    this.notice = { message, at: Date.now() };
    this.push();
    setTimeout(() => {
      if (this.notice && Date.now() - this.notice.at >= 5000) { this.notice = null; this.push(); }
    }, 5200);
  }

  focus() {
    this.ensureWindow();
    if (this.window.isMinimized()) this.window.restore();
    this.window.focus();
  }

  /**
   * IPC. Every channel is declared in shared/channels.js and every handler is
   * wrapped by #guard, which rejects any sender that is not our chrome view or
   * a trusted browser:// internal page. A web page cannot reach these even if
   * it obtains an ipcRenderer reference.
   */
  #registerIpc() {
    const handlers = {
      'app:state': () => this.state(),

      'ui:layout': () => { this.layout(); return true; },
      'ui:menu': (_sender, payload) => this.#showAppMenu(payload),

      'tabs:new': (_sender, payload) => this.tabs.create({
        url: payload?.url,
        background: !!payload?.background,
        index: payload?.index,
      }),
      // No id means "the active tab" (Ctrl+W from anywhere).
      'tabs:close': (_sender, payload) => this.tabs.close(payload?.id || this.tabs.activeId),
      'tabs:select': (_sender, payload) => this.tabs.select(payload?.id),
      'tabs:reorder': (_sender, payload) => this.tabs.reorder(payload?.id, payload?.to),
      'tabs:navigate': (_sender, payload) => {
        const id = payload?.id || this.tabs.activeId;
        this.tabs.navigate(id, payload?.input);
      },

      'navigation:back': () => this.tabs.navigateActive('back'),
      'navigation:forward': () => this.tabs.navigateActive('forward'),
      'navigation:reload': () => this.tabs.navigateActive('reload'),
      'navigation:stop': () => this.tabs.navigateActive('stop'),
      'navigation:home': () => this.tabs.navigate(this.tabs.activeId, this.settings.value.homepage),

      'omnibox:suggest': (_sender, payload) =>
        this.history.suggest(payload?.query || '', this.bookmarks.list()),

      'bookmarks:toggle': (_sender, payload) => {
        const active = this.tabs.activeState();
        this.bookmarks.toggle(payload?.url || active.url, payload?.title || active.title);
        this.push();
      },
      'bookmarks:remove': (_sender, payload) => { this.bookmarks.remove(payload?.id); this.push(); },

      'history:search': (_sender, payload) => this.history.search(payload?.query || '', payload?.limit),
      'history:remove': (_sender, payload) => { this.history.remove(payload?.id); this.push(); },

      'extensions:load-unpacked': () => this.extensions.loadUnpacked(),
      'extensions:load-crx': () => this.extensions.loadCrx(),
      'extensions:set-enabled': (_sender, payload) =>
        this.extensions.setEnabled(payload?.id, !!payload?.enabled),
      'extensions:remove': (_sender, payload) => this.extensions.remove(payload?.id),
      'extensions:options': (_sender, payload) => {
        const url = this.extensions.optionsUrl(payload?.id);
        if (url) this.tabs.create({ url });
        return !!url;
      },

      'downloads:reveal': (_sender, payload) => this.downloads.reveal(payload?.id),
      'downloads:cancel': (_sender, payload) => { this.downloads.cancel(payload?.id); this.push(); },
      'downloads:clear': () => { this.downloads.clear(); this.push(); },

      'settings:update': (_sender, payload) => {
        const next = this.settings.update(payload);
        this.layout(); // bookmarks bar toggle changes the chrome height
        this.push();
        return next;
      },
      'settings:clear-data': (_sender, payload) => this.#clearData(payload),
    };

    for (const channel of requests) {
      const handler = handlers[channel];
      if (!handler) throw new Error('Missing IPC handler for declared channel: ' + channel);
      ipcMain.handle(channel, (event, payload) => {
        this.#guard(event);
        return handler(event.sender, payload);
      });
    }
  }

  /**
   * Sender validation. Two things must hold: the sender is one of our own
   * WebContents, AND its top frame is a URL we trust. Checking only the first
   * would let a compromised tab that navigated to a web page keep its access.
   */
  #guard(event) {
    const sender = event.sender;
    if (sender === this.chrome?.webContents) {
      const url = sender.getURL();
      if (url.startsWith('file://') && url.includes('/renderer/index.html')) return;
      throw new Error('Unauthorized sender');
    }
    const tab = this.#tabByContents(sender);
    // Internal pages are file:// loads that we tagged with a browser:// identity.
    if (tab && tab.state.internalUrl && internalPage(tab.state.internalUrl)) {
      if (!event.senderFrame || event.senderFrame.parent === null) return;
    }
    throw new Error('Unauthorized sender');
  }

  async #clearData(options = {}) {
    const { history: clearHistory, cookies, cache, downloads: clearDownloads } = options;
    if (clearHistory) this.history.clear();
    if (clearDownloads) this.downloads.clear();
    if (cookies) {
      await this.session.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
      });
    }
    if (cache) {
      await this.session.clearCache();
      await this.session.clearCodeCaches({});
    }
    this.push();
    return { ok: true };
  }

  /** Application menu: also where the real keyboard shortcuts are bound, so
   *  they work no matter which view (chrome or tab) holds focus. */
  #installMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => this.tabs.create({}) },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => this.tabs.close(this.tabs.activeId) },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => this.tabs.navigateActive('reload') },
          { label: 'Stop', accelerator: 'Esc', click: () => this.tabs.navigateActive('stop') },
          { type: 'separator' },
          { label: 'Back', accelerator: isMac ? 'Cmd+Left' : 'Alt+Left', click: () => this.tabs.navigateActive('back') },
          { label: 'Forward', accelerator: isMac ? 'Cmd+Right' : 'Alt+Right', click: () => this.tabs.navigateActive('forward') },
          { label: 'Home', accelerator: isMac ? 'Cmd+Shift+H' : 'Alt+Home', click: () => this.tabs.navigate(this.tabs.activeId, this.settings.value.homepage) },
          { type: 'separator' },
          { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => this.chrome?.webContents.send('ui:focus-address') },
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ],
      },
      {
        label: 'Tab',
        submenu: [
          { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => this.tabs.cycle(1) },
          { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => this.tabs.cycle(-1) },
        ],
      },
      {
        label: 'Bookmarks',
        submenu: [
          { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => {
            const active = this.tabs.activeState();
            if (active.url) { this.bookmarks.toggle(active.url, active.title); this.push(); }
          } },
          { label: 'Show All Bookmarks', click: () => this.tabs.create({ url: 'browser://bookmarks' }) },
        ],
      },
      {
        label: 'History',
        submenu: [
          { label: 'Show Full History', accelerator: 'CmdOrCtrl+Y', click: () => this.tabs.create({ url: 'browser://history' }) },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  /** The "..." button menu in the toolbar. */
  #showAppMenu() {
    const open = (url) => this.tabs.create({ url });
    const menu = Menu.buildFromTemplate([
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => this.tabs.create({}) },
      { type: 'separator' },
      { label: 'Bookmarks', click: () => open('browser://bookmarks') },
      { label: 'History', click: () => open('browser://history') },
      { label: 'Downloads', click: () => open('browser://downloads') },
      { label: 'Extensions', click: () => open('browser://extensions') },
      { type: 'separator' },
      { label: 'Settings', click: () => open('browser://settings') },
    ]);
    menu.popup({ window: this.window });
    return true;
  }

  flush() {
    this.history.flush();
    this.downloads.flush();
  }
}

module.exports = { BrowserApplication, CHROME_HEIGHT, BOOKMARKS_BAR_HEIGHT };
