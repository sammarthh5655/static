const { WebContentsView } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { resolveInput, securityState, internalPage } = require('../../shared/urls');

const NEW_TAB = 'browser://newtab';

/**
 * Owns every web tab and the single active-view slot inside the window.
 *
 * Design notes (read before modifying):
 * - Each tab is an Electron `WebContentsView`. Only ONE is attached to the
 *   window contentView at a time; switching tabs detaches the previous view
 *   rather than hiding it, so background tabs cannot paint over the chrome.
 * - Tab order lives in `this.order` (array of ids), NOT in a Map insertion
 *   order, because drag-to-reorder has to rewrite it independently of creation.
 * - Every webContents is created sandboxed with no node integration. The
 *   `webPreferences` below are the security boundary for ALL untrusted content.
 */
class Tabs {
  constructor({ window, session, preload, onChange, onNavigate, onTabCreated, onSelected, extensions, getEngine }) {
    this.window = window;
    this.session = session;
    this.preload = preload;
    this.onChange = onChange;       // re-render the chrome
    this.onNavigate = onNavigate;   // record history
    this.onTabCreated = onTabCreated; // attach keyboard shortcut interception
    this.onSelected = onSelected;
    this.extensions = extensions;   // electron-chrome-extensions instance
    this.getEngine = getEngine;     // () => 'google' | 'brave'
    this.tabs = new Map();          // id -> tab record
    this.order = [];                // tab ids, in strip order
    this.activeId = null;
    this.activeWorkspace = 'main';
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
  }

  get active() { return this.tabs.get(this.activeId) || null; }

  list() {
    return this.order.map((id) => {
      const tab = this.tabs.get(id);
      return {
        id,
        active: id === this.activeId,
        title: tab.state.title,
        url: tab.state.displayUrl,
        favicon: tab.state.favicon,
        loading: tab.state.loading,
        pinned: tab.pinned, groupId: tab.groupId, workspaceId: tab.workspaceId,
        createdAt: tab.createdAt, lastActiveAt: tab.lastActiveAt,
      };
    });
  }

  /** State the omnibox and nav buttons render from (active tab only). */
  activeState() {
    const tab = this.active;
    if (!tab) return { url: '', security: 'internal', canGoBack: false, canGoForward: false, loading: false };
    return {
      url: tab.state.displayUrl,
      security: tab.state.security,
      canGoBack: tab.state.canGoBack,
      canGoForward: tab.state.canGoForward,
      loading: tab.state.loading,
      title: tab.state.title,
    };
  }

  create({ url, background = false, index, workspaceId = this.activeWorkspace } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        // Security defaults for untrusted web content. Do not relax these.
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        safeDialogs: true,
        // electron-chrome-extensions prepends its own preload on top of this
        // one; ours only exposes the internal-page bridge.
        preload: this.preload,
        session: this.session,
      },
    });

    const id = randomUUID();
    const tab = {
      id,
      view,
      historyId: null, // current history entry, so late title updates can patch it
      createdAt: Date.now(), lastActiveAt: Date.now(),
      pinned: false, groupId: null, workspaceId,
      state: {
        title: 'New tab',
        url: '',
        displayUrl: '',
        internalUrl: null,
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        security: 'internal',
        loadError: null,
      },
    };
    this.tabs.set(id, tab);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, this.order.length)) : this.order.length;
    this.order.splice(at, 0, id);

    this.#wire(tab);
    this.onTabCreated?.(view.webContents);

    // Register with the extension system so chrome.tabs.* sees this tab and
    // browser action popups resolve against the right webContents.
    try {
      this.extensions?.addTab(view.webContents, this.window);
    } catch (error) {
      console.error('Extension tab registration failed:', error.message);
    }

    if (!background || !this.activeId) this.select(id);
    this.navigate(id, url || NEW_TAB);
    this.onChange();
    return id;
  }

  /** Mirror Chromium navigation state into `tab.state` and notify the chrome. */
  #wire(tab) {
    const wc = tab.view.webContents;

    const sync = () => {
      if (wc.isDestroyed()) return;
      tab.state.url = wc.getURL();
      // Internal pages keep showing their browser:// URL, never the file path.
      tab.state.displayUrl = tab.state.internalUrl || tab.state.url;
      tab.state.canGoBack = wc.navigationHistory.canGoBack();
      tab.state.canGoForward = wc.navigationHistory.canGoForward();
      tab.state.security = securityState(tab.state.displayUrl, tab.state.loadError);
      this.onChange();
    };

    wc.on('page-title-updated', (_event, title) => {
      tab.state.title = title;
      // Titles often arrive after the visit was recorded; patch that row.
      if (tab.historyId) this.onNavigate?.({ type: 'title', id: tab.historyId, title });
      this.onChange();
    });

    wc.on('page-favicon-updated', (_event, icons) => {
      tab.state.favicon = Array.isArray(icons) ? icons[0] || null : null;
      this.onChange();
    });

    wc.on('did-start-loading', () => {
      tab.state.loading = true;
      tab.state.loadError = null;
      this.onChange();
    });
    wc.on('did-stop-loading', () => {
      tab.state.loading = false;
      sync();
    });
    wc.on('did-navigate', sync);
    wc.on('did-navigate-in-page', sync);

    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED, which fires for ordinary user-cancelled loads.
      if (isMainFrame && code !== -3) {
        tab.state.loadError = description;
        sync();
      }
    });

    // Record the visit once the main frame has actually committed.
    wc.on('did-finish-load', () => {
      if (wc.isDestroyed()) return;
      const url = tab.state.internalUrl || wc.getURL();
      tab.historyId = this.onNavigate?.({ type: 'visit', url, title: wc.getTitle() }) || null;
      sync();
    });

    // Popups and target=_blank become real tabs instead of extra windows.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      this.create({ url, background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
  }

  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const target = resolveInput(input, this.getEngine?.() || 'google');
    const page = internalPage(target);
    if (page) {
      // Internal pages load from disk but keep their browser:// identity in the
      // omnibox, so users never see a file:// path for a built-in screen.
      tab.state.internalUrl = target;
      // Preserve section links such as browser://settings#appearance while
      // keeping the on-disk file chosen only from the internal-page allowlist.
      tab.view.webContents.loadFile(path.join(__dirname, '..', '..', 'renderer', 'pages', `${page}.html`), {
        hash: new URL(target).hash,
        query: Object.fromEntries(new URL(target).searchParams),
      });
    } else {
      tab.state.internalUrl = null;
      tab.view.webContents.loadURL(target);
    }
  }

  select(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.lastActiveAt = Date.now();
    this.activeWorkspace = tab.workspaceId;
    this.onSelected?.(id);
    if (id !== this.activeId) {
      const previous = this.active;
      if (previous && this.window.contentView.children.includes(previous.view)) {
        this.window.contentView.removeChildView(previous.view);
      }
      this.activeId = id;
    }
    this.#attach(tab);
    try {
      // Keeps chrome.tabs.query({active:true}) and popups pointed at this tab.
      this.extensions?.selectTab(tab.view.webContents);
    } catch (error) {
      console.error('Extension tab selection failed:', error.message);
    }
    this.onChange();
  }

  #attach(tab) {
    if (!this.window.contentView.children.includes(tab.view)) {
      this.window.contentView.addChildView(tab.view);
    }
    tab.view.setBounds(this.bounds);
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const position = this.order.indexOf(id);
    if (position >= 0) this.order.splice(position, 1);
    this.tabs.delete(id);

    if (this.window.contentView.children.includes(tab.view)) {
      this.window.contentView.removeChildView(tab.view);
    }
    try {
      this.extensions?.removeTab(tab.view.webContents);
    } catch { /* extension host may already be gone */ }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    if (this.activeId === id) {
      this.activeId = null;
      // Chrome selects the tab to the right, falling back to the left.
      const next = this.order.slice(position).find(id => this.tabs.get(id).workspaceId === this.activeWorkspace) ||
        this.order.slice(0, position).reverse().find(id => this.tabs.get(id).workspaceId === this.activeWorkspace);
      if (next) this.select(next);
      else this.create({}); // never leave the window with zero tabs
    }
    this.onChange();
  }

  /** Drag-to-reorder: move `id` to absolute position `to` in the strip. */
  reorder(id, to) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    const target = Math.max(0, Math.min(Number(to) || 0, this.order.length));
    this.order.splice(target, 0, id);
    this.onChange();
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab. */
  cycle(step = 1) {
    const visible = this.order.filter(id => this.tabs.get(id).workspaceId === this.activeWorkspace);
    if (visible.length < 2) return;
    const index = visible.indexOf(this.activeId);
    const next = (index + step + visible.length) % visible.length;
    this.select(visible[next]);
  }

  /** Called by the layout manager whenever the chrome height changes. */
  setBounds(bounds) {
    this.bounds = bounds;
    if (this.active) this.active.view.setBounds(bounds);
  }

  navigateActive(action) {
    const wc = this.active?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const nav = wc.navigationHistory;
    if (action === 'back' && nav.canGoBack()) nav.goBack();
    else if (action === 'forward' && nav.canGoForward()) nav.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
  }

  closeAll() {
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
  }
}

module.exports = { Tabs, NEW_TAB };
