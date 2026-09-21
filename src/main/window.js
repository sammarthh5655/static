'use strict';

const path = require('node:path');
const { BrowserWindow, WebContentsView } = require('electron');
const ipc = require('./ipc');
const { TabManager } = require('../features/tabs');
const { buildTabStripMenu } = require('./context-menu');
const { showAppMenu } = require('./app-menu');

/**
 * One browser window = one BrowserWindow whose own webContents renders the
 * browser chrome (tab strip + toolbar, `src/renderer/index.html`), plus a
 * stack of WebContentsViews layered on top of it:
 *
 *   ┌──────────────────────────────────────┐
 *   │ UI chrome (win.webContents)          │  <- y: 0 .. chromeHeight
 *   ├──────────────────────────────────────┤
 *   │ active tab WebContentsView           │  <- y: chromeHeight .. bottom
 *   │   ┌──────────────┐                   │
 *   │   │ dropdown     │ (omnibox overlay, │
 *   │   │ WebContentsView│ shown on demand) │
 *   │   └──────────────┘                   │
 *   └──────────────────────────────────────┘
 *
 * Views are rectangles, so anything the chrome wants to draw *over* the page
 * (the omnibox suggestion list) has to be its own view — hence `dropdown`.
 * The renderer reports its height through `ui:layout` whenever the bookmarks
 * bar toggles, and `layout()` re-fits the tab view.
 */

const UI_PRELOAD = path.join(__dirname, '..', '..', 'dist', 'ui-preload.js');
const UI_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const DROPDOWN_HTML = path.join(__dirname, '..', 'renderer', 'dropdown', 'dropdown.html');

const DEFAULT_CHROME_HEIGHT = 78;
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

class BrowserWindowController {
  /**
   * @param {object} ctx  shared app context (see main.js)
   * @param {{url?: string, bounds?: Electron.Rectangle}} opts
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.chromeHeight = DEFAULT_CHROME_HEIGHT;
    this.contentFullscreen = false;
    this.dropdown = null;
    this.dropdownVisible = false;

    this.win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 500,
      minHeight: 300,
      ...(opts.bounds || {}),
      show: false,
      backgroundColor: '#dee1e6',
      // Chrome-style: tabs live in the title bar. Windows/macOS draw native
      // window controls over our UI (titleBarOverlay); Linux keeps a frame.
      titleBarStyle: isLinux ? 'default' : 'hidden',
      titleBarOverlay: isLinux ? undefined : { color: '#dee1e6', symbolColor: '#3c4043', height: 36 },
      trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: UI_PRELOAD,
        // UI chrome uses the default session; extensions + tabs use their own.
      },
    });

    ipc.registerUIContents(this.win.webContents);
    this.tabs = new TabManager(this);

    this._wire();
    this.win.loadFile(UI_HTML);

    this.win.once('ready-to-show', () => {
      this.win.show();
      this.tabs.create({ url: opts.url || this.ctx.settings.newTabUrl() });
    });
  }

  _wire() {
    const { win } = this;

    win.on('resize', () => this.layout());
    win.on('maximize', () => this.layout());
    win.on('unmaximize', () => this.layout());
    win.on('enter-full-screen', () => this.layout());
    win.on('leave-full-screen', () => this.layout());

    win.webContents.on('before-input-event', (event, input) => {
      if (this.ctx.shortcuts.handle(this, input, 'ui')) event.preventDefault();
    });

    // Any keypress that would open a new window from the UI is denied.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.on('focus', () => this.tabs.active && this.ctx.extensions?.selectTab(this.tabs.active.wc));

    win.on('closed', () => {
      this.tabs.destroyAll();
      if (this.dropdown) {
        this.dropdown.webContents.close();
        this.dropdown = null;
      }
      this.ctx.windows.remove(this);
    });
  }

  // ---- layout -------------------------------------------------------------

  /** Content area rectangle for the active tab. */
  tabBounds() {
    const { width, height } = this.win.getContentBounds();
    const top = this.contentFullscreen ? 0 : this.chromeHeight;
    return { x: 0, y: top, width, height: Math.max(0, height - top) };
  }

  layout() {
    const active = this.tabs.active;
    if (active) active.view.setBounds(this.tabBounds());
    if (this.dropdownVisible) this.hideDropdown();
  }

  attachTabView(view) {
    view.setBounds(this.tabBounds());
    this.win.contentView.addChildView(view);
    // Keep the dropdown above the freshly attached tab view.
    if (this.dropdownVisible && this.dropdown) this.win.contentView.addChildView(this.dropdown);
  }

  detachTabView(view) {
    try {
      this.win.contentView.removeChildView(view);
    } catch {
      // Already detached.
    }
  }

  /** Called by the renderer via `ui:layout` when its height changes. */
  setChromeHeight(height) {
    const h = Math.max(40, Math.min(200, Math.round(height)));
    if (h === this.chromeHeight) return;
    this.chromeHeight = h;
    this.layout();
  }

  /** HTML5 fullscreen: page takes the entire window, chrome hidden. */
  setContentFullscreen(on) {
    this.contentFullscreen = on;
    if (on && !this.win.isFullScreen()) this.win.setFullScreen(true);
    if (!on && this.win.isFullScreen()) this.win.setFullScreen(false);
    ipc.send(this.win.webContents, 'ui:fullscreen', on);
    this.layout();
  }

  // ---- omnibox dropdown overlay ------------------------------------------

  _ensureDropdown() {
    if (this.dropdown) return this.dropdown;
    this.dropdown = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: UI_PRELOAD,
        transparent: true,
      },
    });
    this.dropdown.setBackgroundColor('#00000000');
    ipc.registerUIContents(this.dropdown.webContents);
    this.dropdown.webContents.loadFile(DROPDOWN_HTML);
    this.dropdown.webContents.on('before-input-event', (event, input) => {
      if (this.ctx.shortcuts.handle(this, input, 'ui')) event.preventDefault();
    });
    return this.dropdown;
  }

  /**
   * @param {{items: object[], selected: number, anchor: {x:number,y:number,width:number,height:number}}} payload
   */
  showDropdown(payload) {
    const view = this._ensureDropdown();
    const { anchor, items } = payload;
    const rowHeight = 36;
    const height = Math.min(items.length * rowHeight + 12, 420);
    const { width: winWidth } = this.win.getContentBounds();
    const x = Math.max(0, Math.round(anchor.x));
    const width = Math.min(Math.round(anchor.width), winWidth - x);
    view.setBounds({ x, y: Math.round(anchor.y + anchor.height + 4), width, height });
    if (!this.dropdownVisible) {
      this.win.contentView.addChildView(view);
      this.dropdownVisible = true;
    }
    ipc.send(view.webContents, 'omnibox:dropdown-render', { items, selected: payload.selected });
  }

  hideDropdown() {
    if (!this.dropdownVisible || !this.dropdown) return;
    this.win.contentView.removeChildView(this.dropdown);
    this.dropdownVisible = false;
    ipc.send(this.dropdown.webContents, 'omnibox:dropdown-render', { items: [], selected: -1 });
  }

  // ---- actions used by shortcuts / menus ---------------------------------

  focusOmnibox() {
    this.win.webContents.focus();
    ipc.send(this.win.webContents, 'omnibox:focus');
  }

  focusActiveTab() {
    this.tabs.active?.wc.focus();
  }

  toggleBookmarkActive() {
    const tab = this.tabs.active;
    if (!tab || !tab.url) return;
    this.ctx.bookmarks.toggle(tab.url, tab.title, tab.favicon);
  }

  showTabStripMenu(tabId) {
    buildTabStripMenu(this, tabId).popup({ window: this.win });
  }

  showAppMenu(x, y) {
    showAppMenu(this, x, y);
  }
}

module.exports = { BrowserWindowController, DEFAULT_CHROME_HEIGHT };
