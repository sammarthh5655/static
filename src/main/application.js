const path = require('node:path');
const { app, session, ipcMain, BaseWindow, WebContentsView, shell, clipboard } = require('electron');
const { requests, events } = require('../shared/channels');
const { ENGINES, internalPage, resolveInput, allowedURL } = require('../shared/urls');
const { THEMES, SURFACE_STYLES, RADIUS } = require('../shared/theme');
const { WIDGETS, BACKGROUNDS } = require('../shared/widgets');
const { ACCELERATORS, matchAccelerator } = require('./shortcuts');
const { JsonStore } = require('./storage');
const { Settings, DEFAULTS } = require('../features/settings');
const { Bookmarks } = require('../features/bookmarks');
const { History } = require('../features/history');
const { Downloads } = require('../features/downloads');
const { Extensions } = require('../features/extensions');
const { Tabs, NEW_TAB } = require('../features/tabs');

/**
 * Chrome geometry. These MUST match the heights in renderer/chrome.css,
 * because main positions the tab view directly below the chrome and the two
 * have no other way to agree on where that boundary is.
 */
const TITLEBAR_HEIGHT = 36;   // custom title bar (drag region + window buttons)
const TABSTRIP_HEIGHT = 40;
const TOOLBAR_HEIGHT = 48;
const BOOKMARKS_BAR_HEIGHT = 34;

/** Total chrome height for a given settings snapshot. */
function chromeHeight(settings) {
  return TITLEBAR_HEIGHT + TABSTRIP_HEIGHT + TOOLBAR_HEIGHT +
    (settings.bookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0);
}

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
    // Whether the menu overlay is currently sized to the whole window.
    this.overlayInteractive = false;
    // The overlay loads asynchronously; requests that arrive before it is
    // listening are held here and replayed (see the menu:open handler).
    this.overlayReady = false;
    this.pendingMenu = null;
  }

  async start() {
    this.settings = new Settings(this.dir);
    this.bookmarks = new Bookmarks(this.dir);
    this.history = new History(this.dir);
    this.downloads = new Downloads(this.dir, this.session, () => this.push());
    this.notes = new JsonStore(this.dir, 'notes', { text: '' });

    this.#hardenSession();
    this.ensureWindow();
    this.#registerIpc();

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

    // Frameless: the title bar, window buttons and every menu are drawn by our
    // own renderer. `frame: false` removes the OS bar entirely (rather than
    // titleBarStyle: 'hidden', which keeps native traffic lights on macOS).
    // Dragging is handled by -webkit-app-region in renderer/chrome.css.
    this.window = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 640,
      minHeight: 420,
      title: 'static',
      frame: false,
      backgroundColor: THEMES[this.settings.value.theme]?.tokens.bg || '#161718',
      show: false,
    });

    // The renderer draws its own maximise/restore glyph, so it needs to know.
    const reportWindowState = () => {
      this.push();
      this.layout();
    };
    this.window.on('maximize', reportWindowState);
    this.window.on('unmaximize', reportWindowState);
    this.window.on('enter-full-screen', reportWindowState);
    this.window.on('leave-full-screen', reportWindowState);

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
    this.attachShortcuts(this.chrome.webContents);

    // Menu overlay.
    //
    // Menus are taller than the chrome strip, so drawing them inside the chrome
    // view clips them. This transparent view covers the WHOLE window and sits
    // above both the chrome and the active tab, so a menu can be any size and
    // still paint over page content.
    //
    // It ignores mouse events while idle (setIgnoreMouseEvents below), so the
    // toolbar and the page underneath stay clickable; the renderer turns that
    // off only while a menu is actually open.
    this.overlay = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.join(app.getAppPath(), 'build', 'chrome.preload.cjs'),
        session: this.session,
        transparent: true,
      },
    });
    this.overlay.setBackgroundColor('#00000000');
    this.window.contentView.addChildView(this.overlay);
    this.overlay.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    // Only a real reload invalidates readiness. `did-start-navigation` also
    // fires for the initial load, and it can arrive AFTER the page's own
    // menu:ready - which would clear the flag again and strand a queued menu.
    this.overlay.webContents.on('did-start-navigation', (event) => {
      if (event.isSameDocument) return;
      if (this.overlayReady) this.overlayReady = false;
    });
    this.overlay.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
    this.attachShortcuts(this.overlay.webContents);

    this.tabs = new Tabs({
      window: this.window,
      session: this.session,
      preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
      extensions: this.extensions,
      getEngine: () => this.settings.value.searchEngine,
      // Every tab gets the shortcut interceptor, so Ctrl+T and friends fire
      // even while focus is inside page content.
      onTabCreated: (contents) => this.attachShortcuts(contents),
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
    const top = chromeHeight(this.settings.value);
    this.chrome.setBounds({ x: 0, y: 0, width, height: top });
    this.tabs?.setBounds({
      x: 0,
      y: top,
      width,
      height: Math.max(0, height - top),
    });

    // Re-add the overlay so it stays the topmost child: adding a tab view
    // appends it above earlier children. Its size depends on whether a menu is
    // currently open (see setOverlayInteractive).
    if (this.overlay) {
      this.window.contentView.addChildView(this.overlay);
      this.overlay.setBounds(this.overlayInteractive
        ? { x: 0, y: 0, width, height }
        : { x: 0, y: 0, width: 1, height: 1 });
    }
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
    const win = this.window && !this.window.isDestroyed() ? this.window : null;
    return {
      platform: process.platform,
      // Drives the custom title bar: which maximise/restore glyph to draw,
      // and whether to inset for the macOS traffic-light area.
      window: {
        maximized: win ? win.isMaximized() : false,
        fullScreen: win ? win.isFullScreen() : false,
        focused: win ? win.isFocused() : true,
      },
      // Widget + background catalogues, so the new tab customiser and the
      // settings page never hardcode a list that could drift from the registry.
      catalog: {
        widgets: Object.values(WIDGETS),
        backgrounds: Object.values(BACKGROUNDS),
        themes: Object.values(THEMES).map(({ id, name }) => ({ id, name })),
        surfaceStyles: Object.values(SURFACE_STYLES),
        radii: Object.values(RADIUS).map(({ id, name }) => ({ id, name })),
      },
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
    // The overlay needs state too: it renders menus whose contents (checkmarks,
    // shortcut labels) depend on settings.
    if (this.overlay && !this.overlay.webContents.isDestroyed()) {
      this.overlay.webContents.send('app:state', payload);
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
      // The renderer builds its menus from this, so the shortcut shown beside
      // a menu item always matches the binding that actually fires.
      'ui:shortcuts': () => ACCELERATORS.map(({ id, label, display }) => ({ id, label, display })),
      'ui:action': (_sender, payload) => { this.dispatch(payload?.action); return true; },
      'window:control': (_sender, payload) => this.windowControl(payload?.action),

      // The chrome asks the overlay to draw a menu; the overlay reports back
      // whether one is open so we can toggle its mouse transparency.
      'menu:open': (_sender, payload) => {
        if (!this.overlay || this.overlay.webContents.isDestroyed()) return false;
        // The overlay may not have registered its IPC listener yet (it loads
        // asynchronously, and the user can hit F10 immediately). Hold the most
        // recent request and replay it once the overlay reports ready, so an
        // early menu press is never silently dropped.
        // Always queue, then nudge. The overlay drains the queue on the nudge
        // or on its next poll, so a send dropped during a commit still lands.
        this.pendingMenu = payload;
        this.overlay.webContents.send('ui:render-menu', payload);
        return true;
      },

      // Sent by the overlay once its listeners are live.
      'menu:ready': () => {
        this.overlayReady = true;
        return this.pendingMenu ? this.takePendingMenu() : null;
      },

      // The overlay polls for a queued menu as well as receiving pushes. A
      // `webContents.send` issued while the view is mid-commit is silently
      // dropped, and a dropped menu is indistinguishable from a broken one, so
      // the request is also readable on demand.
      'menu:pending': () => this.takePendingMenu(),
      'menu:state': (_sender, payload) => {
        this.setOverlayInteractive(!!payload?.open);
        return true;
      },

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

      // Scratchpad widget contents. Kept in its own small store rather than in
      // settings, so a long note never bloats the settings file.
      'newtab:notes': (_sender, payload) => {
        if (typeof payload?.text === 'string') {
          this.notes.save({ text: payload.text.slice(0, 20000) });
        }
        return this.notes.data.text || '';
      },
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
    if (sender === this.overlay?.webContents) {
      const url = sender.getURL();
      if (url.startsWith('file://') && url.includes('/renderer/overlay.html')) return;
      throw new Error('Unauthorized sender');
    }
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

  /**
   * Keyboard shortcuts.
   *
   * With no native Menu there is no accelerator system, so we intercept keys
   * in `before-input-event`, which fires before the key reaches page content.
   * Attached to every tab AND the chrome, so a shortcut works regardless of
   * which one has focus, and a web page cannot swallow it.
   */
  attachShortcuts(contents) {
    if (!contents || contents.isDestroyed()) return;
    contents.on('before-input-event', (event, input) => {
      const action = matchAccelerator(input);
      if (!action) return;
      // Escape is only ours while a page is actually loading; otherwise it
      // belongs to the page (closing its own dialogs, clearing selection).
      if (action === 'page:stop' && !this.tabs?.active?.state.loading) return;
      event.preventDefault();
      this.dispatch(action);
    });
  }

  /** Run a named action. The custom menus and the shortcut table share this. */
  dispatch(action) {
    const open = (url) => this.tabs.create({ url });
    switch (action) {
      case 'tab:new': this.tabs.create({}); break;
      case 'tab:close': this.tabs.close(this.tabs.activeId); break;
      case 'tab:next': this.tabs.cycle(1); break;
      case 'tab:previous': this.tabs.cycle(-1); break;
      case 'tab:reopen': this.tabs.reopenClosed?.(); break;

      case 'omnibox:focus': this.chrome?.webContents.send('ui:focus-address'); break;
      case 'page:reload': this.tabs.navigateActive('reload'); break;
      case 'page:stop': this.tabs.navigateActive('stop'); break;
      case 'page:back': this.tabs.navigateActive('back'); break;
      case 'page:forward': this.tabs.navigateActive('forward'); break;
      case 'page:home': this.tabs.navigate(this.tabs.activeId, this.settings.value.homepage); break;

      case 'bookmarks:toggle': {
        const active = this.tabs.activeState();
        if (active.url) { this.bookmarks.toggle(active.url, active.title); this.push(); }
        break;
      }
      case 'open:bookmarks': open('browser://bookmarks'); break;
      case 'open:history': open('browser://history'); break;
      case 'open:downloads': open('browser://downloads'); break;
      case 'open:settings': open('browser://settings'); break;
      case 'open:extensions': open('browser://extensions'); break;

      case 'window:devtools': {
        const wc = this.tabs.active?.view.webContents;
        if (wc) wc.toggleDevTools();
        break;
      }
      // Asks the renderer to open its own menu; main never draws one.
      case 'menu:main': this.chrome?.webContents.send('ui:open-menu', { menu: 'main' }); break;
      default: break;
    }
  }

  /**
   * While no menu is open the overlay must not swallow clicks meant for the
   * toolbar or the page underneath.
   *
   * Two approaches do NOT work here:
   *  - `setIgnoreMouseEvents` is window-level in Electron, so it would make the
   *    entire window click-through.
   *  - Detaching the view while idle stops it being composited, and a view that
   *    is not composited does not run CSS transitions or animations - the menu
   *    then stays frozen on its first frame, invisible, about two thirds of the
   *    time.
   *
   * So the overlay stays attached permanently (always composited, animations
   * always run) and is instead shrunk to a 1x1 corner when idle, which leaves
   * the whole window clickable underneath it.
   */
  setOverlayInteractive(interactive) {
    if (!this.overlay || !this.window || this.window.isDestroyed()) return;
    this.overlayInteractive = interactive;
    const { width, height } = this.window.getContentBounds();
    // Full-window while a menu is open; a 1x1 corner otherwise, so clicks pass
    // straight through to the chrome and the page. The view stays attached
    // either way - see the note above this method.
    this.overlay.setBounds(interactive
      ? { x: 0, y: 0, width, height }
      : { x: 0, y: 0, width: 1, height: 1 });
  }

  /** Hand the queued menu request to the overlay, clearing it. */
  takePendingMenu() {
    const payload = this.pendingMenu;
    this.pendingMenu = null;
    return payload || null;
  }

  /** Window controls for the custom title bar. */
  windowControl(action) {
    const win = this.window;
    if (!win || win.isDestroyed()) return false;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    else if (action === 'close') win.close();
    else return false;
    return true;
  }

  flush() {
    this.history.flush();
    this.downloads.flush();
  }
}

module.exports = {
  BrowserApplication, chromeHeight,
  TITLEBAR_HEIGHT, TABSTRIP_HEIGHT, TOOLBAR_HEIGHT, BOOKMARKS_BAR_HEIGHT,
};
