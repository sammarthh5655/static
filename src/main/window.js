'use strict';

const path = require('node:path');
const { app, BaseWindow, WebContentsView, screen } = require('electron');
const { THEMES } = require('../shared/theme');
const { Tabs } = require('../features/tabs');
const { siteOf } = require('../shared/tabsearch');
const { ACCEL } = require('./shortcuts');
const pageMenu = require('./page-menu');

/**
 * Chrome geometry. These MUST match the heights in renderer/chrome.css,
 * because main positions the tab view directly below the chrome and the two
 * have no other way to agree on where that boundary is.
 */
const TITLEBAR_HEIGHT = 36;   // custom title bar (drag region + window buttons)
const TABSTRIP_HEIGHT = 40;
const TOOLBAR_HEIGHT = 48;
const BOOKMARKS_BAR_HEIGHT = 34;

/** How much room the omnibox dropdown needs when it is open. */
const SUGGESTIONS_HEIGHT = 340;

/** Total chrome height for a given settings snapshot. */
function chromeHeight(settings) {
  // Vertical tabs take the strip out of the top bar entirely.
  return TITLEBAR_HEIGHT + (settings.tabLayout === 'vertical' ? 0 : TABSTRIP_HEIGHT) + TOOLBAR_HEIGHT +
    (settings.bookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0);
}

/** Width of the vertical tab list, open and folded to favicons. */
const VERTICAL_TABS_WIDTH = 248;
const VERTICAL_TABS_FOLDED = 56;

/**
 * Tab hover previews. The card's size is fixed (overlay.css draws it at
 * exactly this), so main can make room for it without measuring anything.
 * The picture is the top of the page at 16:9, kept at twice the card's
 * width so it stays sharp on a high-density screen, and is reused for a few
 * seconds rather than taken again on every hover.
 */
const PREVIEW_CARD = { width: 280, height: 238 };
const PREVIEW_SHOT_WIDTH = 560;
const PREVIEW_FRESH_MS = 3000;
const PREVIEW_KEEP = 40;
// How long a picture may take before it is given up on (see snapshot).
const PREVIEW_CAPTURE_MS = 1500;
// How long a page sits still on screen before its picture is taken, so a
// tab already has one by the time it is in the background (see settleSnapshot).
const PREVIEW_SETTLE_MS = 900;

/**
 * Each of a window's own views, and the page it must still be showing to be
 * trusted (see BrowserApplication#guard): a view somehow navigated anywhere
 * else loses its access rather than keeping it.
 */
const PANEL_PAGES = {
  chrome: '/renderer/index.html',
  overlay: '/renderer/overlay.html',
  sidebar: '/renderer/pages/sidebar.html',
  edgeStrip: '/renderer/pages/edge.html',
  splitDivider: '/renderer/pages/split.html',
  splitDrop: '/renderer/pages/splitdrop.html',
  vtabs: '/renderer/pages/vtabs.html',
  findBar: '/renderer/pages/find.html',
};

/** How far a new window steps down and to the right of the one it came from. */
const CASCADE = 28;

/**
 * A tab's favicon, for the overlay to show: the page chose it, so only a web
 * or inline image address gets through - never a file:// path or a script.
 */
function safeFavicon(url) {
  return typeof url === 'string' && url.length < 100000 && /^(https?:|data:image\/)/i.test(url) ? url : null;
}

/**
 * One browser window: its frame, its chrome, its menu overlay, its tabs and
 * everything laid out around them - the sidebar, the vertical tab list, the
 * find bar, split view, the hover cards.
 *
 * Window composition (read before changing layout):
 *   BaseWindow.contentView
 *     +- chrome view   (our local UI: tab strip, omnibox, bookmarks bar)
 *     +- active tab view (managed by features/tabs, positioned below chrome)
 *     +- side panels   (sidebar, vertical tabs, find bar, split handle)
 *     +- menu overlay  (always the topmost child)
 * The chrome is a WebContentsView like any tab, but it is one of the few
 * views with a preload that exposes IPC; main checks every message against
 * the window it came from (see BrowserApplication#guard).
 *
 * The services - settings, history, passwords, shields and the rest - are the
 * browser's, shared by every window; `this.browser` is where they live. What
 * is here is what a second window must not share: which tab is on show, which
 * menu is open, whether the sidebar is out.
 */
class AppWindow {
  /**
   * @param {object} browser the BrowserApplication
   * @param {object} options
   *   id        a number that names this window in IPC (the tab menu's "Move to")
   *   bounds    where it goes: { x, y, width, height }, any of them may be missing
   *   startup   the first window of a launch: it opens what Settings says to start with
   *   arriving  opened from inside Static: the chrome plays its short entrance
   *   behind    comes up without taking the front from the window in use (the
   *             other windows of a restored session)
   */
  constructor(browser, { id, bounds = {}, startup = false, arriving = false, behind = false } = {}) {
    this.browser = browser;
    this.id = id;
    this.startup = startup;
    this.arriving = arriving;
    this.behind = behind;
    this.openedAt = Date.now();
    this.closed = false;
    this.window = null;
    this.chrome = null;
    this.overlay = null;
    this.tabs = null;
    // Whether the menu overlay is currently sized to the whole window.
    this.overlayInteractive = false;
    this.overlayPassive = false;
    // The overlay loads asynchronously; requests that arrive before it is
    // listening are held here and replayed (see the menu:open handler).
    this.overlayReady = false;
    this.pendingMenu = null;
    this.lastMenu = null;
    this.lastPageMenu = null;
    this.contextTarget = null;
    this.notice = null;
    // The AI sidebar: a WebContentsView beside the tab, created on first use.
    this.sidebar = null;
    this.sidebarOpen = false;
    this.sidebarWidth = 380;
    // Whether the omnibox dropdown is showing, which changes the chrome's
    // height so the list is not clipped.
    this.suggestionsOpen = false;
    // The tab hover card on show, if any: { id, lane } (see tabPreview).
    this.preview = null;
    this.vtabs = null;
    this.findBar = null;
    this.findTabId = null;
    this.edgeStrip = null;
    this.splitDivider = null;
    this.splitDrop = null;
    this.splitDragId = null;
    this.htmlFullscreen = null;
    this.wasFullscreen = false;
    this.windowFullscreen = false;
    // The web page this window was last on, for "Read this page" and friends.
    this.lastWebTabId = null;
    // The question the overlay is asking right now, if any (see #prompt in main).
    this.promptOpen = null;
    this.#create(bounds);
  }

  /** A window's place when it is opened from another: a step down and right of it, on the same screen. */
  static cascadeFrom(other) {
    if (!other || other.isDestroyed()) return {};
    const from = other.isMaximized() || other.isFullScreen() ? other.getNormalBounds() : other.getBounds();
    const next = { x: from.x + CASCADE, y: from.y + CASCADE, width: from.width, height: from.height };
    try {
      const area = screen.getDisplayMatching(from).workArea;
      // Off the bottom or the right edge: back to the top corner of the screen.
      if (next.x + next.width > area.x + area.width || next.y + next.height > area.y + area.height) {
        next.x = area.x + CASCADE;
        next.y = area.y + CASCADE;
      }
      next.width = Math.min(next.width, area.width);
      next.height = Math.min(next.height, area.height);
    } catch { /* no screen to ask: the step alone will do */ }
    return next;
  }

  #create(bounds) {
    const browser = this.browser;
    const offscreen = process.env.STATIC_OFFSCREEN === '1';

    // Frameless: the title bar, window buttons and every menu are drawn by our
    // own renderer. `frame: false` removes the OS bar entirely (rather than
    // titleBarStyle: 'hidden', which keeps native traffic lights on macOS).
    // Dragging is handled by -webkit-app-region in renderer/chrome.css.
    // macOS gets `titleBarStyle: 'hiddenInset'` rather than `frame: false`.
    //
    // `frame: false` removes the OS bar entirely, and on macOS that takes the
    // TRAFFIC LIGHTS with it - a Mac user would have no way to close,
    // minimise or zoom the window, and no amount of drawing our own buttons
    // is a substitute for the ones every Mac app has in the same place.
    // 'hiddenInset' keeps the real traffic lights, inset into our own chrome,
    // which is what every Mac browser does.
    const mac = process.platform === 'darwin';
    this.window = new BaseWindow({
      ...bounds,
      width: bounds.width || 1280,
      height: bounds.height || 820,
      minWidth: 640,
      minHeight: 420,
      title: 'static',
      ...(mac
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 13, y: 13 } }
        : { frame: false }),
      backgroundColor: THEMES[browser.settings.value.theme]?.tokens.bg || '#161718',
      // Packaged builds take the icon from the executable; this is for running
      // from source, which would otherwise show Electron's.
      icon: path.join(app.getAppPath(), 'build', 'icon.png'),
      show: false,
      ...(offscreen ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
    });
    if (offscreen) {
      // Test runs must never appear on screen or take focus from whatever the
      // user is doing, however a probe asks for the window - and that holds
      // for every window, not just the first.
      this.window.show = () => this.window.showInactive();
      this.window.focus = () => {};
      this.window.setPosition(-32000, -32000);
    }

    // Two-finger swipe back and forward, which is how Mac users navigate.
    // Electron reports it on the window; everything else ignores it.
    this.window.on('swipe', (_event, direction) => {
      const wc = this.tabs?.active?.view?.webContents;
      if (!wc || wc.isDestroyed()) return;
      if (direction === 'left' && wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack();
      } else if (direction === 'right' && wc.navigationHistory.canGoForward()) {
        wc.navigationHistory.goForward();
      }
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
    // Whichever window was used last is the one the dock, a second launch and
    // anything without a window of its own (a notice, an extension) speak to.
    this.window.on('focus', () => browser.windowFocused(this));

    // The chrome UI. Its preload is the esbuild bundle (scripts/build.cjs)
    // because it must bundle electron-chrome-extensions' browser-action code.
    this.chrome = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.join(app.getAppPath(), 'build', 'chrome.preload.cjs'),
        session: browser.session,
      },
    });
    this.window.contentView.addChildView(this.chrome);
    this.chrome.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    browser.attachShortcuts(this.chrome.webContents);

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
        session: browser.session,
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
    browser.attachShortcuts(this.overlay.webContents);

    this.tabs = new Tabs({
      window: this.window,
      session: browser.session,
      preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
      extensions: browser.extensions,
      getEngine: () => browser.settings.value.searchEngine,
      onSelected: (id) => this.#selected(id),
      // Every tab gets the shortcut interceptor and the rest of its wiring,
      // which follows the tab if it moves to another window.
      onTabCreated: (contents) => browser.wireTab(contents),
      onChange: () => this.push(),
      onNavigate: (event) => browser.recordVisit(event),
    });
    // A file dropped onto a page opens in a new tab beside it, by token.
    this.tabs.onFileDropped = (tab, url) => browser.openDroppedFile(tab, url);
    // Its last tab closed: the window may close with it (see lastTabClosed).
    this.tabs.onEmpty = () => browser.lastTabClosed(this);

    this.window.on('resize', () => this.layout());
    // macOS enters fullscreen from its own menu and green button too.
    this.window.on('enter-full-screen', () => {
      if (!this.htmlFullscreen && !this.windowFullscreen) { this.windowFullscreen = true; this.layout(); }
    });
    this.window.on('leave-full-screen', () => {
      if (this.htmlFullscreen) this.leaveHtmlFullscreen();
      if (this.windowFullscreen) { this.windowFullscreen = false; this.layout(); }
    });
    this.window.on('close', () => browser.windowClosing(this));
    this.window.on('closed', () => browser.windowClosed(this));
    this.window.once('ready-to-show', () => this.window.show());

    // Chrome renders first; the tab view is positioned by layout().
    this.chrome.webContents.once('did-finish-load', () => {
      if (this.closed) return;
      this.applyTabLayout();
      this.layout();
      // The first window opens what Settings asks for (the last session, the
      // homepage, setup); any other starts with one new tab - unless it was
      // opened to take tabs that are already in it.
      if (!this.tabs.order.length) {
        if (this.startup) browser.openStartupTabs(this);
        else this.tabs.create({});
      }
      // Honour the saved sidebar setting on startup rather than always
      // beginning closed.
      this.applySidebarMode();
      this.reveal();
      this.push();
    });

    this.layout();
  }

  /**
   * Put the window on screen once its chrome has drawn. One restored behind
   * the window in use comes up without the focus, and hands the front back:
   * each window of a session shows as its chrome loads, and the last to load
   * would otherwise end up in front, whichever was in front when it was saved.
   */
  reveal() {
    if (this.closed || !this.window || this.window.isDestroyed()) return;
    if (!this.behind) { this.window.show(); return; }
    this.window.showInactive();
    const front = this.browser.front;
    if (front && front !== this && !front.closed) front.focus();
  }

  /** A tab came on screen (clicked, chosen by a key, or its pane clicked in split view). */
  #selected(id) {
    // The tab coming on screen has its picture taken once it settles, for
    // its hover card later. (Not the one being left: it is taken off screen
    // in the same moment, and a capture started then waits for it to come
    // back - see settleSnapshot.)
    this.hidePreview();
    this.settleSnapshot();
    const chosen = this.tabs?.tabs.get(id);
    if (chosen && !chosen.state.internalUrl) this.lastWebTabId = id;
    if (this.findBar && this.findTabId && this.findTabId !== id) this.closeFind();
    if (this.htmlFullscreen && this.htmlFullscreen !== id) this.leaveHtmlFullscreen();
    return this.browser.productivity?.organizer.wake(id).catch(() => this.notify('This tab could not wake. Try reloading it.'));
  }

  /* ---- which views are this window's -------------------------------------- */

  /** Which of this window's own views `contents` belongs to (a key of PANEL_PAGES), or null. */
  viewKind(contents) {
    if (!contents) return null;
    for (const kind of Object.keys(PANEL_PAGES)) {
      if (this[kind] && this[kind].webContents === contents) return kind;
    }
    return null;
  }

  /** The tab in this window showing `contents`, if any. */
  tabOf(contents) {
    if (!contents || !this.tabs) return null;
    for (const tab of this.tabs.tabs.values()) {
      if (tab.view.webContents === contents) return tab;
    }
    return null;
  }

  /** Whether `contents` is anything in this window: one of its views or one of its tabs. */
  owns(contents) {
    return !!(this.viewKind(contents) || this.tabOf(contents));
  }

  /** What this window is called in a list of windows: the tab on show, as its title bar says. */
  title() {
    const tab = this.tabs?.active;
    return tab?.state.title || tab?.state.displayUrl || 'New tab';
  }

  /** Bring this window to the front, restored if it was minimised. */
  focus() {
    if (this.closed || !this.window || this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  /**
   * The window has closed: everything in it goes. A BaseWindow does not
   * destroy its views' pages when it closes, so each is closed here - a tab
   * left running would go on playing sound in a window no one can see.
   */
  dispose() {
    this.closed = true;
    clearInterval(this.sidebarAnim);
    clearTimeout(this.thumbTimer);
    this.tabs?.dispose();
    for (const kind of Object.keys(PANEL_PAGES)) {
      const view = this[kind];
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  /* ---- state ---------------------------------------------------------------- */

  /** Push state to this window's chrome, overlay, panels and open internal pages. */
  push(payload) {
    // Nothing to push before the services exist, or after the window closed.
    if (this.closed || !this.browser.settings) return;
    const state = payload || this.browser.state(this);
    // The system's name for the window follows its page, as our own title bar
    // does: with several open, Alt+Tab, the taskbar and the Mac's Window menu
    // are how one is told from another.
    const name = this.tabs?.active?.state.title ? this.tabs.active.state.title + ' — static' : 'static';
    if (name !== this.systemTitle && this.window && !this.window.isDestroyed()) {
      this.systemTitle = name;
      this.window.setTitle(name);
    }
    // The overlay needs state too: it renders menus whose contents (checkmarks,
    // shortcut labels) depend on settings. The sidebar follows the active
    // page - its permission line has to change the moment you navigate.
    for (const view of [this.chrome, this.overlay, this.sidebar, this.vtabs]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.send('app:state', state);
    }
    for (const tab of this.tabs?.tabs.values() || []) {
      const wc = tab.view.webContents;
      if (!wc.isDestroyed() && tab.state.internalUrl) wc.send('app:state', state);
    }
  }

  /** A short message along the bottom of this window's chrome. */
  notify(message) {
    this.notice = { message, at: Date.now() };
    this.push();
    setTimeout(() => {
      if (this.notice && Date.now() - this.notice.at >= 5000) { this.notice = null; this.push(); }
    }, 5200);
  }

  /* ---- find in page --------------------------------------------------------- */

  /** Open find-in-page over the active tab, or refocus it if open. */
  openFind(text) {
    const tab = this.tabs?.active;
    if (!tab || !this.window) return;
    this.findTabId = tab.id;
    if (this.findBar && !this.findBar.webContents.isDestroyed()) {
      this.findBar.webContents.focus();
      this.findBar.webContents.send('find:focus', { text });
      return;
    }
    this.findBar = new WebContentsView({
      webPreferences: {
        preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    this.findBar.setBackgroundColor('#00000000');
    this.browser.attachShortcuts(this.findBar.webContents);
    this.findBar.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'find.html'));
    this.findBar.webContents.once('did-finish-load', () => {
      if (!this.findBar || this.findBar.webContents.isDestroyed()) return;
      this.findBar.webContents.focus();
      if (text) this.findBar.webContents.send('find:focus', { text });
    });
    this.layout();
  }

  closeFind() {
    const wc = this.tabs?.tabs.get(this.findTabId)?.view.webContents;
    if (wc && !wc.isDestroyed()) wc.stopFindInPage('keepSelection');
    if (this.findBar) {
      try { this.window.contentView.removeChildView(this.findBar); } catch { /* already gone */ }
      if (!this.findBar.webContents.isDestroyed()) this.findBar.webContents.close();
      this.findBar = null;
    }
    this.findTabId = null;
    if (wc && !wc.isDestroyed()) wc.focus();
  }

  /* ---- full screen and zoom ------------------------------------------------- */

  enterHtmlFullscreen(contents) {
    const tab = this.tabOf(contents);
    if (!tab || !this.window) return;
    this.htmlFullscreen = tab.id;
    this.wasFullscreen = this.window.isFullScreen();
    if (!this.wasFullscreen) this.setWindowFullScreen(true);
    this.layout();
  }

  leaveHtmlFullscreen() {
    if (!this.htmlFullscreen) return;
    const tab = this.tabs?.tabs.get(this.htmlFullscreen);
    this.htmlFullscreen = null;
    const wc = tab?.view.webContents;
    // Leaving because the user switched tabs: the page still thinks it is
    // fullscreen, so tell it.
    if (wc && !wc.isDestroyed()) {
      wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    }
    if (!this.wasFullscreen && !this.windowFullscreen && this.window && !this.window.isDestroyed()) {
      this.setWindowFullScreen(false);
    }
    this.layout();
  }

  /** OS fullscreen, except in test runs, where it would take over the screen. */
  setWindowFullScreen(on) {
    if (process.env.STATIC_OFFSCREEN === '1' || !this.window || this.window.isDestroyed()) return;
    this.window.setFullScreen(on);
  }

  /** F11: the whole browser fullscreen, toolbar hidden, like every browser. */
  toggleWindowFullscreen() {
    if (!this.window) return;
    if (this.htmlFullscreen) { this.leaveHtmlFullscreen(); return; }
    this.windowFullscreen = !this.windowFullscreen;
    this.setWindowFullScreen(this.windowFullscreen);
    this.layout();
    if (this.windowFullscreen) {
      this.notify(process.platform === 'darwin' ? 'Press Ctrl+Cmd+F to exit full screen' : 'Press F11 to exit full screen');
    }
  }

  /** Zoom the active page in the steps browsers share: 25% to 500%. */
  zoom(direction) {
    const wc = this.tabs?.active?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const now = wc.getZoomFactor();
    let next = 1;
    if (direction > 0) next = STEPS.find((step) => step > now + 0.001) || 5;
    else if (direction < 0) next = [...STEPS].reverse().find((step) => step < now - 0.001) || 0.25;
    wc.setZoomFactor(next);
    this.push();
    this.notify(next === 1 ? 'Zoom reset to 100%' : 'Zoom ' + Math.round(next * 100) + '%');
  }

  /* ---- menus ---------------------------------------------------------------- */

  /** Draw the right-click menu for a page, at the pointer, in the overlay. */
  openPageMenu(contents, params) {
    const tab = this.tabOf(contents);
    if (!tab || !this.overlay || this.overlay.webContents.isDestroyed()) return;
    const browser = this.browser;
    const extensionItems = browser.extensions?.contextMenuItems(contents, params) || [];
    this.contextTarget = { tabId: tab.id, contents, params, extensionItems, win: this };
    const items = pageMenu.buildItems(params, {
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      pageUrl: contents.getURL(),
      // What the address bar shows: reading view is our page, but its QR
      // code is of the article.
      shownUrl: tab.state.displayUrl,
      extensionItems,
      has: {
        window: typeof browser.openWindow === 'function',
        incognito: typeof browser.openIncognito === 'function',
        split: typeof this.openSplit === 'function',
        blockElement: typeof browser.startElementPicker === 'function',
        pageTools: !!browser.pageTools,
        reader: !!browser.pageTools?.readerState(tab).available,
      },
    });
    // params are in the page's own coordinates; the overlay spans the window.
    const bounds = tab.view.getBounds();
    const x = bounds.x + params.x;
    const y = bounds.y + params.y;
    this.pendingMenu = { items, anchor: { left: x, right: x, top: y, bottom: y, width: 0, height: 0 }, align: 'left' };
    // The overlay takes pendingMenu as soon as it polls; this copy stays.
    this.lastPageMenu = this.pendingMenu;
    this.overlay.webContents.send('ui:render-menu', this.pendingMenu);
  }

  /** Draw a menu in the overlay. A passive one leaves the keyboard with the page. */
  showMenu(items, anchor, align = 'left', { passive = false } = {}) {
    if (!this.overlay || this.overlay.webContents.isDestroyed()) return;
    this.pendingMenu = this.lastMenu = { items: items.filter(Boolean), anchor, align, passive };
    this.overlay.webContents.send('ui:render-menu', this.pendingMenu);
  }

  /** Close whatever menu is open. The overlay picks this up like any menu. */
  closeMenu() {
    if (!this.overlay || this.overlay.webContents.isDestroyed()) return;
    this.pendingMenu = { items: [] };
    this.overlay.webContents.send('ui:render-menu', this.pendingMenu);
  }

  /**
   * A menu anchor sent by a view, in window coordinates: the overlay spans
   * the window, and the vertical tab list (or the chrome) sits somewhere in it.
   * Anything that is not a set of numbers gives way to the usual place.
   */
  windowAnchor(sender, anchor) {
    const keys = ['left', 'right', 'top', 'bottom'];
    if (!anchor || !keys.every((k) => Number.isFinite(Number(anchor[k])))) return this.promptAnchor();
    const view = sender === this.vtabs?.webContents ? this.vtabs : sender === this.chrome?.webContents ? this.chrome : null;
    const at = view ? view.getBounds() : { x: 0, y: 0 };
    return {
      left: Number(anchor.left) + at.x, right: Number(anchor.right) + at.x,
      top: Number(anchor.top) + at.y, bottom: Number(anchor.bottom) + at.y,
      width: Number(anchor.width) || 0, height: Number(anchor.height) || 0,
    };
  }

  /** The ids in a request that are open tabs in this window, at most 500. */
  tabIds(value) {
    return Array.isArray(value) ? [...new Set(value.slice(0, 500).map(String))].filter((id) => this.tabs.tabs.has(id)) : [];
  }

  /** Where a question about the page goes: under the toolbar, at the right. */
  promptAnchor() {
    const top = chromeHeight(this.browser.settings.value);
    const width = this.window.getContentBounds().width;
    return { left: width - 16, right: width - 16, top: top - 6, bottom: top - 6, width: 0, height: 0 };
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
  setOverlayInteractive(interactive, { passive = false } = {}) {
    if (!this.overlay || !this.window || this.window.isDestroyed()) return;
    const wasInteractive = this.overlayInteractive;
    const wasPassive = this.overlayPassive;
    this.overlayInteractive = interactive;
    this.overlayPassive = interactive && passive;
    const { width, height } = this.window.getContentBounds();
    // Full-window while a menu is open; a 1x1 corner otherwise, so clicks pass
    // straight through to the chrome and the page. The view stays attached
    // either way - see the note above this method.
    if (interactive) {
      // A menu takes the overlay from a hover card; the card just goes.
      if (this.preview) {
        this.preview = null;
        this.overlay.webContents.send('ui:tab-preview', null);
      }
      // RE-ADD before resizing, not just resize. addChildView moves an
      // existing child to the END of the child list, which is what puts it on
      // top. Without this the menu opened BEHIND the page: selecting or
      // creating a tab appends that tab above the overlay, and resizing alone
      // does not change the order. On a blank tab nothing was behind it so the
      // bug stayed hidden; on a real site the page covered the menu entirely.
      this.window.contentView.addChildView(this.overlay);
      this.overlay.setBounds({ x: 0, y: 0, width, height });
      // A passive menu (autofill suggestions) leaves the keyboard where it is.
      if (!passive) this.overlay.webContents.focus();
    } else {
      // A 1x1 corner when idle, so clicks pass straight through to the chrome
      // and the page below. The view stays attached either way. (A hover
      // card on show keeps its lane: this may be a menu that never opened.)
      this.overlay.setBounds(this.preview ? this.preview.lane : { x: 0, y: 0, width: 1, height: 1 });
      this.browser.promptClosed(this);
      // A menu can open from F10 while a web tab owns focus, so chrome never
      // gets a blur event. Explicitly reset its trigger on every dismissal.
      this.chrome.webContents.send('ui:menu-closed');
      // After a passive menu the keyboard never left the page; do not take it.
      if (wasInteractive && !wasPassive) this.chrome.webContents.focus();
    }
  }

  /** Hand the queued menu request to the overlay, clearing it. */
  takePendingMenu() {
    const payload = this.pendingMenu;
    this.pendingMenu = null;
    return payload || null;
  }

  /* ---- the sidebar, the edge strip and the vertical tab list ---------------- */

  /**
   * Create the sidebar view on first use.
   *
   * Lazy because most sessions never open it, and an idle WebContentsView is
   * a renderer process doing nothing.
   */
  ensureSidebar() {
    if (this.sidebar && !this.sidebar.webContents.isDestroyed()) return this.sidebar;
    this.sidebar = new WebContentsView({
      webPreferences: {
        preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.sidebar.setBackgroundColor('#00000000');
    this.sidebar.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'pages', 'sidebar.html'));
    this.browser.attachShortcuts(this.sidebar.webContents);
    this.window.contentView.addChildView(this.sidebar);
    return this.sidebar;
  }

  /**
   * Apply the sidebarMode setting.
   *
   * This setting existed in three places in the UI - the menu, Settings and
   * the store - and was read by NOTHING, which is why switching it to "On"
   * appeared to do nothing at all. The sidebar only ever followed its own
   * toggle.
   *
   *   on       the sidebar is open and stays open
   *   autohide it is hidden, and slides back when the pointer reaches the
   *            right edge of the window
   *   off      it is closed and the toggle will not open it
   */
  applySidebarMode() {
    const mode = this.browser.settings?.value?.sidebarMode || 'on';
    if (mode === 'on') {
      if (!this.sidebarOpen) this.toggleSidebar(true);
    } else if (this.sidebarOpen && mode !== 'autohide') {
      this.toggleSidebar(false);
    } else if (mode === 'autohide' && this.sidebarOpen && !this.sidebarPeeking) {
      // Entering autohide from "on" hides it; it comes back on the edge.
      this.toggleSidebar(false);
    }
    this.applyEdgeReveal();
    return mode;
  }

  /**
   * The hot zone that brings an autohidden sidebar back.
   *
   * "Autohide" used to be a comment and nothing else: it behaved exactly like
   * "off", so the setting appeared to do nothing. A hidden sidebar needs a way
   * back that does not require remembering a shortcut, so a narrow strip at
   * the right edge of the window reveals it on hover, the way a dock does.
   *
   * The strip is a real WebContentsView because Electron gives no window-level
   * pointer events; it is transparent, ignores clicks, and only reports that
   * the pointer arrived.
   */
  applyEdgeReveal() {
    const wanted = this.browser.settings?.value?.sidebarMode === 'autohide';
    if (!wanted) {
      if (this.edgeStrip) {
        try { this.window.contentView.removeChildView(this.edgeStrip); } catch { /* already gone */ }
        try { this.edgeStrip.webContents.close(); } catch { /* already gone */ }
        this.edgeStrip = null;
      }
      return;
    }
    if (this.edgeStrip && !this.edgeStrip.webContents.isDestroyed()) return;

    this.edgeStrip = new WebContentsView({
      webPreferences: {
        preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    this.edgeStrip.setBackgroundColor('#00000000');
    this.edgeStrip.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'pages', 'edge.html'));
    this.window.contentView.addChildView(this.edgeStrip);
    this.layout();
  }

  /** A small trusted view of one of our own pages, for panels and handles. */
  panelView(page) {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    view.setBackgroundColor('#00000000');
    this.browser.attachShortcuts(view.webContents);
    view.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'pages', page));
    return view;
  }

  /** Open `url` beside a tab, in split view. */
  openSplit(url, fromTabId = this.tabs?.activeId) {
    if (!this.tabs?.tabs.has(fromTabId)) return null;
    const index = this.tabs.order.indexOf(fromTabId) + 1;
    const id = this.tabs.create({ url, background: true, index });
    this.tabs.split(fromTabId, id);
    this.tabs.select(fromTabId);
    this.layout();
    return id;
  }

  /**
   * Show or hide the drop zones while a tab is dragged - any tab, the one
   * you are on included (it then shares the page with the last one used).
   *
   * The drag ends in two places at once: the tab list says "dragend" and the
   * zones say "drop", from different processes, in no fixed order. When the
   * end arrives first the tab is remembered for a moment, so the drop still
   * knows what was dragged (see splitDropTab).
   */
  showSplitDrop(id) {
    clearTimeout(this.splitDropTimer);
    const valid = !!id && !!this.tabs?.tabs.has(id);
    if (this.splitDragId && !valid) this.splitDragEnded = { id: this.splitDragId, at: Date.now() };
    this.splitDragId = valid ? id : null;
    if (!valid) {
      if (this.splitDrop && !this.splitDrop.webContents.isDestroyed()) this.splitDrop.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    if (!this.splitDrop || this.splitDrop.webContents.isDestroyed()) this.splitDrop = this.panelView('splitdrop.html');
    this.window.contentView.addChildView(this.splitDrop);
    this.splitDrop.setBounds(this.tabs.bounds);
    // Never left covering the page: a drag that ends somewhere nothing
    // reports it (another app, the desktop) still takes the zones away.
    this.splitDropTimer = setTimeout(() => this.showSplitDrop(null), 30000);
  }

  /** The tab being dragged onto the zones, or the one whose drag just ended. */
  splitDropTab() {
    const recent = this.splitDragEnded && Date.now() - this.splitDragEnded.at < 2000 ? this.splitDragEnded.id : null;
    const id = this.splitDragId || recent;
    this.splitDragEnded = null;
    return id && this.tabs?.tabs.has(id) ? id : null;
  }

  /**
   * The tab to share the page with `id`: the one used most recently before
   * it, in the same workspace. A new tab when there is no other.
   */
  splitPartner(id) {
    const tab = this.tabs?.tabs.get(id);
    if (!tab) return null;
    const other = this.tabs.list()
      .filter((t) => t.id !== id && t.workspaceId === tab.workspaceId)
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0];
    if (other) return other.id;
    const index = this.tabs.order.indexOf(id) + 1;
    return this.tabs.create({ background: true, index });
  }

  /** Create or remove the vertical tab list to match the setting. */
  applyTabLayout() {
    if (!this.window || this.window.isDestroyed()) return;
    const settings = this.browser.settings.value;
    const want = settings.tabLayout === 'vertical';
    if (!want) {
      if (this.vtabs) {
        try { this.window.contentView.removeChildView(this.vtabs); } catch { /* already gone */ }
        if (!this.vtabs.webContents.isDestroyed()) this.vtabs.webContents.close();
        this.vtabs = null;
      }
      this.layout();
      return;
    }
    if (this.vtabs && !this.vtabs.webContents.isDestroyed()) { this.layout(); return; }
    this.vtabs = new WebContentsView({
      webPreferences: {
        preload: path.join(app.getAppPath(), 'build', 'tab.preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    this.vtabs.setBackgroundColor(THEMES[settings.theme]?.tokens.bg || '#161718');
    this.browser.attachShortcuts(this.vtabs.webContents);
    this.vtabs.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'vtabs.html'));
    this.layout();
  }

  /** Reveal or re-hide an autohidden sidebar. */
  peekSidebar(show) {
    if (this.browser.settings?.value?.sidebarMode !== 'autohide') return false;
    const next = !!show;
    if (next === this.sidebarOpen) return next;
    this.sidebarPeeking = next;
    if (next) this.ensureSidebar();
    this.sidebarOpen = next;
    this.animateSidebar(next);
    this.push();
    return next;
  }

  /**
   * Slide the sidebar open or closed.
   *
   * A WebContentsView's bounds change instantly - there is no CSS transition
   * to lean on - so the width is stepped over a few frames and the layout is
   * recomputed each time. Without this the sidebar appears and disappears with
   * a jump, and the page under it jumps with it.
   *
   * Eased rather than linear, and short: the point is that the eye can follow
   * where the space came from, not that there is an animation to admire.
   */
  animateSidebar(toOpen) {
    clearInterval(this.sidebarAnim);
    const target = toOpen ? 1 : 0;
    // Animations off, in Static or in the system: the panel is simply there,
    // or simply gone, like everything else.
    if (!this.browser.motionOn()) {
      this.sidebarAnim = null;
      this.sidebarProgress = target;
      this.layout();
      return;
    }
    const start = this.sidebarProgress ?? (toOpen ? 0 : 1);
    const began = Date.now();
    const DURATION = 190;

    this.sidebarAnim = setInterval(() => {
      const t = Math.min(1, (Date.now() - began) / DURATION);
      // ease-out cubic: fast at first, settling at the end.
      const eased = 1 - Math.pow(1 - t, 3);
      this.sidebarProgress = start + (target - start) * eased;
      this.layout();
      if (t >= 1) {
        clearInterval(this.sidebarAnim);
        this.sidebarAnim = null;
        this.sidebarProgress = target;
        this.layout();
      }
    }, 16);
  }

  /** Open, close or toggle the sidebar. */
  toggleSidebar(open) {
    // "Off" means off: a toggle must not be able to reopen it, or the setting
    // is a suggestion rather than a setting.
    if (this.browser.settings?.value?.sidebarMode === 'off') {
      if (this.sidebarOpen) { this.sidebarOpen = false; this.layout(); this.push(); }
      return false;
    }
    const next = typeof open === 'boolean' ? open : !this.sidebarOpen;
    if (next) this.ensureSidebar();
    this.sidebarOpen = next;
    this.animateSidebar(next);
    this.push();
    if (next && this.sidebar && !this.sidebar.webContents.isDestroyed()) {
      this.sidebar.webContents.focus();
    }
    return this.sidebarOpen;
  }

  /* ---- layout --------------------------------------------------------------- */

  /** Position the chrome across the top and give tabs the remaining area. */
  layout() {
    if (this.closed || !this.window || this.window.isDestroyed()) return;
    const settings = this.browser.settings.value;
    const { width, height } = this.window.getContentBounds();
    // Fullscreen (a page's own, or F11) gives the page every pixel.
    const immersive = !!(this.htmlFullscreen || this.windowFullscreen);
    if (this.tabs) this.tabs.solo = !!this.htmlFullscreen;
    const top = immersive ? 0 : chromeHeight(settings);
    // The omnibox dropdown is drawn INSIDE the chrome view, so the view has to
    // be tall enough to show it. At the resting chrome height the list was
    // clipped to a few pixels and looked like it was not appearing at all.
    // While it is open the view grows and the tab is pushed down behind it;
    // the extra strip is mouse-transparent everywhere except the list itself.
    const chromeH = this.suggestionsOpen && !immersive
      ? Math.min(height, top + SUGGESTIONS_HEIGHT)
      : top;
    this.chrome.setBounds(immersive ? { x: 0, y: 0, width: 0, height: 0 } : { x: 0, y: 0, width, height: chromeH });
    // Re-added so it stays above the tab view while it is expanded.
    if (this.suggestionsOpen) this.window.contentView.addChildView(this.chrome);

    // The sidebar takes a strip on the right and the tab gets what is left,
    // so the page is never covered - the point of a sidebar rather than an
    // overlay is that you can still see and use what you are reading.
    // Clamped so a narrow window cannot leave the page with no room.
    // Scaled by the slide progress, so the page and the sidebar move together.
    const full = Math.min(this.sidebarWidth, Math.max(0, Math.floor(width * 0.5)));
    const progress = this.sidebarProgress ?? (this.sidebarOpen ? 1 : 0);
    const side = immersive ? 0 : Math.round(full * progress);
    const vertical = !immersive && settings.tabLayout === 'vertical' && this.vtabs;
    const left = vertical
      ? Math.min(settings.verticalTabsCollapsed ? VERTICAL_TABS_FOLDED : VERTICAL_TABS_WIDTH, Math.floor(width * 0.4))
      : 0;
    if (this.vtabs && !this.vtabs.webContents.isDestroyed()) {
      this.window.contentView.addChildView(this.vtabs);
      this.vtabs.setBounds(vertical ? { x: 0, y: top, width: left, height: Math.max(0, height - top) } : { x: 0, y: 0, width: 0, height: 0 });
    }

    this.tabs?.setBounds({
      x: left,
      y: top,
      width: Math.max(0, width - side - left),
      height: Math.max(0, height - top),
    });

    // The handle between split panes, when the active tab has a partner.
    const divider = immersive ? null : this.tabs?.dividerBounds();
    if (divider) {
      if (!this.splitDivider || this.splitDivider.webContents.isDestroyed()) this.splitDivider = this.panelView('split.html');
      this.window.contentView.addChildView(this.splitDivider);
      this.splitDivider.setBounds(divider);
    } else if (this.splitDivider) {
      this.splitDivider.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    // Mid-drag, a page brought on screen would land above the drop zones.
    if (this.splitDragId && this.splitDrop && !this.splitDrop.webContents.isDestroyed()) {
      this.window.contentView.addChildView(this.splitDrop);
      this.splitDrop.setBounds(this.tabs.bounds);
    }

    // The autohide strip hugs the right edge, under the chrome. It sits above
    // the tab so it can see the pointer, and is narrow enough not to steal
    // real estate from the page.
    if (this.edgeStrip && !this.edgeStrip.webContents.isDestroyed()) {
      const STRIP = immersive ? 0 : 8;
      this.window.contentView.addChildView(this.edgeStrip);
      this.edgeStrip.setBounds({
        x: Math.max(0, width - STRIP - side),
        y: top,
        width: STRIP,
        height: Math.max(0, height - top),
      });
    }

    if (this.sidebar) {
      if (side > 0) {
        // Re-added so it stays above the tab view: adding a tab appends it
        // above earlier children, the same ordering trap the menu overlay hit.
        this.window.contentView.addChildView(this.sidebar);
        this.sidebar.setBounds({ x: width - side, y: top, width: side, height: Math.max(0, height - top) });
      } else {
        this.sidebar.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    }

    if (this.findBar && !this.findBar.webContents.isDestroyed()) {
      const FIND_W = Math.min(400, Math.max(0, width - side - 24));
      this.window.contentView.addChildView(this.findBar);
      this.findBar.setBounds({ x: Math.max(0, width - side - FIND_W - 14), y: top + 6, width: FIND_W, height: 54 });
    }

    // Re-add the overlay so it stays the topmost child: adding a tab view
    // appends it above earlier children. Its size depends on whether a menu is
    // currently open (see setOverlayInteractive). A hover card was placed for
    // the old layout, so it goes; the pointer brings it back.
    if (this.overlay) {
      this.hidePreview();
      this.window.contentView.addChildView(this.overlay);
      this.overlay.setBounds(this.overlayInteractive
        ? { x: 0, y: 0, width, height }
        : { x: 0, y: 0, width: 1, height: 1 });
    }
  }

  /* ---- tab search ---------------------------------------------------------
   * Every open tab in one list, drawn in the overlay like any menu: a box to
   * type in, and the tabs that match. The list is sent whole and filtered in
   * the overlay as each letter is typed (shared/tabsearch.js), so typing
   * never waits on a round trip. Choosing a row sends the same tabs:select
   * any tab click sends; its close button closes the tab and the list
   * carries on with what is left. This window's tabs come first; the other
   * windows' follow, marked with the window they are in, and choosing one
   * brings that window forward.
   */

  /** Open the list under the button that asked, or under its button when a key did. Pressed again, it closes. */
  openTabSearch(sender = null, anchor = null) {
    if (!this.overlay || this.overlay.webContents.isDestroyed() || !this.tabs) return false;
    if (this.overlayInteractive && this.lastMenu?.items?.some((item) => item?.tabsearch)) {
      this.closeMenu();
      return false;
    }
    const where = anchor
      ? { anchor: this.windowAnchor(sender, anchor), align: sender === this.vtabs?.webContents ? 'left' : 'right' }
      : this.tabSearchAnchor();
    this.hidePreview();
    const others = this.browser.windows.filter((w) => w !== this && !w.closed).length;
    this.showMenu([{
      tabsearch: {
        tabs: this.tabSearchEntries(),
        placeholder: others ? 'Search tabs in every window' : 'Search your tabs',
        shortcut: ACCEL.get('tab:search')?.display || '',
      },
    }], where.anchor, where.align);
    return true;
  }

  /**
   * Where the list opens from the keyboard: under the search button at the
   * right-hand end of the strip, or at the top of the tab list down the side.
   * Both sit at fixed places, so there is nothing to measure.
   */
  tabSearchAnchor() {
    const { width } = this.window.getContentBounds();
    const immersive = !!(this.htmlFullscreen || this.windowFullscreen);
    const at = (x, y) => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 });
    if (immersive) return { anchor: at(width - 12, 8), align: 'right' };
    if (this.browser.settings.value.tabLayout === 'vertical' && this.vtabs && !this.vtabs.webContents.isDestroyed()) {
      const side = this.vtabs.getBounds();
      return { anchor: at(side.x + 8, side.y + 46), align: 'left' };
    }
    return { anchor: at(width - 8, TITLEBAR_HEIGHT + TABSTRIP_HEIGHT - 2), align: 'right' };
  }

  /**
   * The rows of the tab search list: this window's tabs, most recently used
   * first with the tab you are on at the top, as Chrome orders them; then
   * every other window's, each tagged with the window it is in. Data only -
   * it crosses IPC - and every action names a channel main checks again when
   * it arrives.
   */
  tabSearchEntries() {
    const organizer = this.browser.productivity?.organizer;
    const workspaces = organizer?.store.data.workspaces || [];
    const sleeping = organizer?.sleeping || new Set();
    const others = this.browser.windows.filter((w) => w !== this && !w.closed && w.tabs);
    const rows = (w, elsewhere) => w.tabs.list()
      .map((tab) => ({ tab, record: w.tabs.tabs.get(tab.id) }))
      .sort((a, b) => Number(b.tab.active) - Number(a.tab.active) || (b.record.lastActiveAt || 0) - (a.record.lastActiveAt || 0))
      .map(({ tab }) => {
        const group = tab.groupId ? organizer?.groups.find((g) => g.id === tab.groupId) : null;
        const url = tab.url || '';
        return {
          id: tab.id,
          title: String(tab.title || (url ? url : 'New tab')).slice(0, 300),
          url: url.slice(0, 2048),
          site: siteOf(url),
          favicon: safeFavicon(tab.favicon),
          // "Current" is the tab on show in THIS window; another window's
          // front tab is only that window's.
          active: !elsewhere && !!tab.active, pinned: !!tab.pinned,
          audible: !!tab.audible, muted: !!tab.muted,
          sleeping: sleeping.has(tab.id),
          // Only worth saying once there is more than one workspace to be in.
          workspace: workspaces.length > 1 ? workspaces.find((w) => w.id === tab.workspaceId)?.name || '' : '',
          group: group ? { name: group.name, color: group.color } : null,
          elsewhere: elsewhere || null,
          select: { channel: 'tabs:select', payload: { id: tab.id } },
          close: { channel: 'tabs:search-close', payload: { id: tab.id } },
        };
      });
    return [
      ...rows(this, null),
      ...others.flatMap((w) => rows(w, { window: w.id, name: 'Window ' + (this.browser.windows.indexOf(w) + 1) })),
    ];
  }

  /* ---- tab hover previews -------------------------------------------------
   * Rest the pointer on a tab and a card comes up under it (beside it, down
   * the side): the title, the site, and a picture of the page.
   *
   * The card is drawn by the overlay, but NOT as a menu: a menu makes the
   * overlay cover the whole window, which would put it under the pointer,
   * take the tab's hover away and close the card again - a flicker loop. The
   * overlay is instead sized to a "lane" beside the tab list that the card
   * slides along, and it never takes the keyboard. Moving into the lane means
   * leaving the tabs, so the card goes; a click there is passed through.
   */
  tabPreview(sender, payload) {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const tab = id ? this.tabs?.tabs.get(id) : null;
    if (!tab || this.browser.settings.value.tabPreviews === false || !this.overlay || this.overlay.webContents.isDestroyed()) {
      this.hidePreview();
      return false;
    }
    // A menu owns the overlay while it is open; a card never covers one.
    if (this.overlayInteractive) return false;
    const anchor = this.windowAnchor(sender, payload?.anchor);
    const side = sender === this.vtabs?.webContents;
    const { width, height } = this.window.getContentBounds();
    const card = PREVIEW_CARD;
    const clamp = (value, low, high) => Math.round(Math.max(low, Math.min(value, high)));
    let lane;
    let x;
    let y;
    if (side) {
      const list = this.vtabs.getBounds();
      lane = { x: list.x + list.width, y: list.y, width: Math.min(card.width + 32, Math.max(0, width - list.x - list.width)), height: list.height };
      x = 10;
      y = clamp(anchor.top - lane.y - 6, 8, lane.height - card.height - 8);
    } else {
      const top = Math.round(anchor.bottom);
      lane = { x: 0, y: top, width, height: Math.min(card.height + 32, Math.max(0, height - top)) };
      x = clamp(anchor.left, 8, width - card.width - 8);
      y = 6;
    }
    if (lane.width < card.width || lane.height < 60) return false;
    this.preview = { id, lane };
    // Re-added so it is above the page, sized to the lane, and NOT focused.
    this.window.contentView.addChildView(this.overlay);
    this.overlay.setBounds(lane);
    const data = this.previewCard(tab);
    this.overlay.webContents.send('ui:tab-preview', { ...data, x, y, side: side ? 'right' : 'below', lane: { x: lane.x, y: lane.y } });
    // The picture follows as soon as it is taken; the card waits with a
    // shimmer meanwhile rather than holding the whole card back.
    if (data.pending) {
      this.snapshot(tab).catch(() => null).then((thumb) => {
        if (this.preview?.id !== id || this.overlay.webContents.isDestroyed()) return;
        this.overlay.webContents.send('ui:tab-preview', { id, update: true, thumb: thumb || null, pending: false });
      });
    }
    return true;
  }

  /** What a hover card says about a tab, and the picture already to hand. */
  previewCard(tab) {
    const organizer = this.browser.productivity?.organizer;
    const sleeping = !!organizer?.sleeping.has(tab.id);
    const url = tab.state.displayUrl || '';
    const kept = this.browser.thumbs.get(tab.id);
    const usable = kept && kept.url === url ? kept : null;
    // Only a tab on screen can be photographed now; any other shows the
    // picture taken when it was last on screen, if its page has not changed.
    const live = !sleeping && this.window.contentView.children.includes(tab.view) && !tab.view.webContents.isDestroyed();
    const fresh = usable && Date.now() - usable.at < PREVIEW_FRESH_MS;
    const group = tab.groupId ? organizer?.groups.find((g) => g.id === tab.groupId) : null;
    return {
      id: tab.id,
      title: String(tab.state.title || url || 'New tab').slice(0, 300),
      site: siteOf(url) || 'New tab',
      favicon: safeFavicon(tab.state.favicon),
      audible: !!tab.state.audible, muted: !!tab.state.muted,
      loading: !!tab.state.loading, sleeping,
      group: group ? { name: group.name, color: group.color } : null,
      thumb: sleeping ? null : usable?.data || null,
      pending: live && !fresh,
    };
  }

  /**
   * Photograph a tab that is on screen, for its hover card: the top of the
   * page at the card's shape, shrunk and kept as a small JPEG. Anything off
   * screen answers with the last picture of the same page, if there is one.
   */
  async snapshot(tab) {
    const browser = this.browser;
    if (!tab || browser.settings?.value.tabPreviews === false) return null;
    const thumbs = browser.thumbs;
    const wc = tab.view.webContents;
    const url = tab.state.displayUrl || '';
    const kept = thumbs.get(tab.id);
    const fallback = kept && kept.url === url ? kept.data : null;
    if (wc.isDestroyed() || wc.isCrashed() || !this.window?.contentView.children.includes(tab.view)) return fallback;
    if (kept && kept.url === url && Date.now() - kept.at < PREVIEW_FRESH_MS) return kept.data;
    const bounds = tab.view.getBounds();
    if (bounds.width < 40 || bounds.height < 40) return fallback;
    const rect = { x: 0, y: 0, width: bounds.width, height: Math.min(bounds.height, Math.round(bounds.width * 9 / 16)) };
    // A tab taken off screen while its picture is being taken leaves the
    // capture waiting until it is next shown - possibly much later, on a
    // different page, or after previews were switched off. So it gets a
    // moment, and whatever it brings back is checked again before it is kept.
    let timer = 0;
    const image = await Promise.race([
      wc.capturePage(rect).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), PREVIEW_CAPTURE_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!image || image.isEmpty() || !browser.findTab(tab.id)) return fallback;
    if (browser.settings.value.tabPreviews === false || (tab.state.displayUrl || '') !== url) return null;
    const small = image.getSize().width > PREVIEW_SHOT_WIDTH ? image.resize({ width: PREVIEW_SHOT_WIDTH, quality: 'good' }) : image;
    const data = 'data:image/jpeg;base64,' + small.toJPEG(82).toString('base64');
    // Newest last, so the oldest is the first to go; closed tabs go first of all.
    // One store for every window: a tab keeps its picture when it moves.
    thumbs.delete(tab.id);
    thumbs.set(tab.id, { data, url, at: Date.now() });
    for (const id of thumbs.keys()) if (!browser.findTab(id)) thumbs.delete(id);
    while (thumbs.size > PREVIEW_KEEP) thumbs.delete(thumbs.keys().next().value);
    return data;
  }

  /**
   * Take the picture of the tab on screen once it has settled: loaded, and
   * looked at for a moment. Only a tab on screen can be photographed, and the
   * moment it is left is already too late, so this is what gives a tab in the
   * background a picture on its card. One timer for the window: only the tab
   * on show ever needs it, and switching again starts it over.
   */
  settleSnapshot() {
    clearTimeout(this.thumbTimer);
    if (this.closed || this.browser.settings?.value.tabPreviews === false) return;
    this.thumbTimer = setTimeout(() => {
      const tab = this.tabs?.active;
      const win = this.window;
      if (!tab || !win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      // Still loading: the end of the load starts this again.
      if (tab.state.loading || this.browser.productivity?.organizer.sleeping.has(tab.id)) return;
      this.snapshot(tab).catch(() => {});
    }, PREVIEW_SETTLE_MS);
  }

  /** Put the hover card away and give the overlay back its idle corner. */
  hidePreview() {
    if (!this.preview) return;
    this.preview = null;
    if (!this.overlay || this.overlay.webContents.isDestroyed()) return;
    if (!this.overlayInteractive) this.overlay.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    this.overlay.webContents.send('ui:tab-preview', null);
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
}

module.exports = {
  AppWindow, chromeHeight, safeFavicon, PANEL_PAGES,
  TITLEBAR_HEIGHT, TABSTRIP_HEIGHT, TOOLBAR_HEIGHT, BOOKMARKS_BAR_HEIGHT,
};
