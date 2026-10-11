const { WebContentsView } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { resolveInput, securityState, internalPage, readerSource, warningSource } = require('../../shared/urls');
const { pathToFileURL } = require('node:url');
const { tidyOrder } = require('./order');

/** Where Static's own pages load from; a file:// navigation outside it is a dropped file. */
const RENDERER_ROOT = pathToFileURL(path.join(__dirname, '..', '..', 'renderer')).href;

const NEW_TAB = 'browser://newtab';

/**
 * The browser:// address of one of our own pages, from the file it loaded
 * from - or null for anything else, including a file of ours that is not an
 * allowlisted page.
 */
function pageFromFile(url) {
  const pages = RENDERER_ROOT + '/pages/';
  if (!url || !url.startsWith(pages)) return null;
  const match = /^([a-z]+)\.html(?:[?#]|$)/.exec(url.slice(pages.length));
  if (!match || !internalPage('browser://' + match[1])) return null;
  const file = new URL(url);
  return { page: match[1], url: 'browser://' + match[1] + file.search + file.hash };
}

/**
 * Owns every web tab and the single active-view slot inside the window.
 *
 * Design notes (read before modifying):
 * - Each tab is an Electron `WebContentsView`. Only the active tab is
 *   attached to the window - or the active PAIR, in split view, where two
 *   tabs share the page area. Switching detaches rather than hides, so
 *   background tabs cannot paint over the chrome.
 * - Tab order lives in `this.order` (array of ids), NOT in a Map insertion
 *   order, because drag-to-reorder has to rewrite it independently of creation.
 * - Every webContents is created sandboxed with no node integration. The
 *   `webPreferences` below are the security boundary for ALL untrusted content.
 * - There is one of these per window. A tab can move to another window
 *   (release here, adopt there), so everything wired to a tab's page answers
 *   to `tab.manager` - whichever window holds it now - never to the one it
 *   was born in.
 */
class Tabs {
  constructor({ window, session, preload, onChange, onNavigate, onTabCreated, onSelected, extensions, getEngine, securityOf }) {
    // (url) => 'insecure' for an https page whose certificate you chose to
    // go past (features/netguard): it must not wear the padlock.
    this.securityOf = securityOf;
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
    // Recently closed tabs, newest last, for Ctrl+Shift+T.
    this.closed = [];
  }

  /** Gap between split panes; the divider handle sits in it. */
  static get DIVIDER() { return 8; }

  /** The two tabs sharing the page with `id`, left first, or null. */
  pairOf(id) {
    const tab = this.tabs.get(id);
    if (!tab?.splitWith || !this.tabs.has(tab.splitWith)) return null;
    return tab.splitSide === 'left' ? { left: id, right: tab.splitWith } : { left: tab.splitWith, right: id };
  }

  /** Put two tabs side by side. The pair keeps its ratio until it is undone. */
  split(leftId, rightId) {
    if (leftId === rightId || !this.tabs.has(leftId) || !this.tabs.has(rightId)) return false;
    this.unsplit(leftId);
    this.unsplit(rightId);
    const left = this.tabs.get(leftId);
    const right = this.tabs.get(rightId);
    Object.assign(left, { splitWith: rightId, splitSide: 'left', splitRatio: 0.5 });
    Object.assign(right, { splitWith: leftId, splitSide: 'right', splitRatio: 0.5 });
    // Neighbours in the strip, so the pair reads as one unit.
    this.order.splice(this.order.indexOf(rightId), 1);
    this.order.splice(this.order.indexOf(leftId) + 1, 0, rightId);
    right.workspaceId = left.workspaceId;
    right.groupId = left.groupId;
    if (this.activeId === leftId || this.activeId === rightId) this.select(this.activeId);
    this.onChange();
    return true;
  }

  /** Separate a pair; both tabs stay open. */
  unsplit(id) {
    const pair = this.pairOf(id);
    if (!pair) return false;
    for (const key of [pair.left, pair.right]) {
      const tab = this.tabs.get(key);
      tab.splitWith = null; tab.splitSide = null;
      if (key !== this.activeId && this.window.contentView.children.includes(tab.view)) {
        this.window.contentView.removeChildView(tab.view);
      }
    }
    this.#place();
    this.onChange();
    return true;
  }

  swapSplit(id) {
    const pair = this.pairOf(id);
    if (!pair) return false;
    const left = this.tabs.get(pair.left);
    const right = this.tabs.get(pair.right);
    left.splitSide = 'right'; right.splitSide = 'left';
    const ratio = 1 - (left.splitRatio || 0.5);
    left.splitRatio = ratio; right.splitRatio = ratio;
    this.order.splice(this.order.indexOf(pair.left), 1);
    this.order.splice(this.order.indexOf(pair.right) + 1, 0, pair.left);
    this.#place();
    this.onChange();
    return true;
  }

  /** Share of the width the LEFT pane gets, 0.2 to 0.8. */
  setSplitRatio(id, ratio) {
    const pair = this.pairOf(id);
    if (!pair) return false;
    const value = Math.min(0.8, Math.max(0.2, Number(ratio) || 0.5));
    this.tabs.get(pair.left).splitRatio = value;
    this.tabs.get(pair.right).splitRatio = value;
    this.#place();
    return true;
  }

  /** Where the divider goes, in window coordinates, or null without a split. */
  dividerBounds() {
    const pair = this.solo ? null : this.pairOf(this.activeId);
    if (!pair) return null;
    const { x, y, width, height } = this.bounds;
    const leftWidth = Math.round((width - Tabs.DIVIDER) * (this.tabs.get(pair.left).splitRatio || 0.5));
    return { x: x + leftWidth, y, width: Tabs.DIVIDER, height };
  }

  /** Size and attach whatever is on screen: one tab, or a pair. */
  #place() {
    const active = this.active;
    if (!active) return;
    // `solo`: a pane in fullscreen takes the whole area; its partner steps aside.
    const pair = this.solo ? null : this.pairOf(active.id);
    if (!pair) {
      const partner = this.tabs.get(active.splitWith)?.view;
      if (this.solo && partner && this.window.contentView.children.includes(partner)) {
        this.window.contentView.removeChildView(partner);
      }
      active.view.setBounds(this.bounds);
      return;
    }
    const divider = this.dividerBounds();
    const { x, y, width, height } = this.bounds;
    const left = this.tabs.get(pair.left);
    const right = this.tabs.get(pair.right);
    for (const tab of [left, right]) {
      if (!this.window.contentView.children.includes(tab.view)) this.window.contentView.addChildView(tab.view);
    }
    left.view.setBounds({ x, y, width: divider.x - x, height });
    right.view.setBounds({ x: divider.x + divider.width, y, width: Math.max(0, x + width - divider.x - divider.width), height });
  }

  /**
   * Ctrl+Shift+T: bring back the most recently closed tab - pinned if it was
   * pinned, and back in its group if that group is still about. `groupOf(id)`
   * answers that (groups belong to the organiser, not to this class).
   */
  reopenClosed(groupOf = () => null) {
    const last = this.closed.pop();
    if (!last) return null;
    const group = last.groupId ? groupOf(last.groupId) : null;
    return this.create({
      url: last.url, index: Math.min(last.index, this.order.length), pinned: !!last.pinned,
      ...(group ? { groupId: group.id, workspaceId: group.workspaceId } : {}),
    });
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
        audible: tab.state.audible, muted: tab.state.muted,
        pinned: tab.pinned, groupId: tab.groupId, workspaceId: tab.workspaceId,
        splitWith: tab.splitWith || null, splitSide: tab.splitSide || null,
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
      zoom: tab.view.webContents.isDestroyed() ? 1 : tab.view.webContents.getZoomFactor(),
      // In reading view, whose address bar shows the article's own address.
      reader: !!readerSource(tab.state.internalUrl || ''),
    };
  }

  /** Pinned tabs first, groups together (see order.js). */
  tidy() {
    this.order = tidyOrder(this.order, (id) => this.tabs.get(id));
  }

  /**
   * `groupId` and `pinned` are for a tab that belongs somewhere from the
   * start - "New tab in group", or a restored session - so it is born in its
   * place rather than created at the end and moved.
   */
  create({ url, background = false, index, workspaceId = this.activeWorkspace, groupId = null, pinned = false } = {}) {
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
        // The preload runs in every frame, not just the top one, so privacy
        // signals (Global Privacy Control, Do Not Track) reach iframes too.
        // Despite the name this gives frames no Node: with the sandbox on and
        // nodeIntegration off, all it does is run the sandboxed preload there.
        // Everything else in the preload checks process.isMainFrame.
        nodeIntegrationInSubFrames: true,
        session: this.session,
        // Test runs are off-screen; a page going fullscreen must not drag the
        // window onto the user's monitor. Layout still reacts to the request.
        disableHtmlFullscreenWindowResize: process.env.STATIC_OFFSCREEN === '1',
      },
    });

    const id = randomUUID();
    const tab = {
      id,
      view,
      // The window's tabs that hold this one now (see adopt).
      manager: this,
      historyId: null, // current history entry, so late title updates can patch it
      createdAt: Date.now(), lastActiveAt: Date.now(),
      pinned: !!pinned, groupId: pinned ? null : groupId || null, workspaceId,
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
        // Sound: playing right now, and silenced by the person.
        audible: false,
        muted: false,
      },
    };
    this.tabs.set(id, tab);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, this.order.length)) : this.order.length;
    this.order.splice(at, 0, id);
    this.tidy();

    this.#wire(tab);
    this.onTabCreated?.(view.webContents);

    // Register with the extension system so chrome.tabs.* sees this tab and
    // browser action popups resolve against the right webContents.
    const previousActiveId = this.activeId;
    try {
      this.extensions?.addTab(view.webContents, this.window);
    } catch (error) {
      console.error('Extension tab registration failed:', error.message);
    }

    // The extension bridge emits activation while registering every new tab.
    // Restore the previous selection for background creates so bulk session
    // restoration and extension-created background tabs cannot steal focus.
    if (background && previousActiveId && this.tabs.has(previousActiveId)) this.select(previousActiveId);
    else this.select(id);
    this.navigate(id, url || NEW_TAB);
    this.onChange();
    return id;
  }

  /**
   * Mirror Chromium navigation state into `tab.state` and notify the chrome.
   * `owner()` rather than `this` throughout: the tab may have been moved to
   * another window since, and that window is the one to tell.
   */
  #wire(tab) {
    const wc = tab.view.webContents;
    const owner = () => tab.manager;

    const sync = () => {
      if (wc.isDestroyed()) return;
      tab.state.url = wc.getURL();
      // Back and Forward load a page without going through navigate(), so the
      // browser:// name a tab was given can belong to the page it has just
      // left. From Help to the guide and back, it is read again from the file
      // (only one of our own pages, by the same allowlist navigate() uses).
      // From one of our pages back to a website it is dropped altogether, or
      // the website would sit under an internal address and padlock.
      const loaded = pageFromFile(tab.state.url);
      if (loaded) {
        if (internalPage(tab.state.internalUrl || '') !== loaded.page) tab.state.internalUrl = loaded.url;
      } else if (tab.state.internalUrl && tab.state.url && tab.state.url !== 'about:blank') {
        tab.state.internalUrl = null;
      }
      // Internal pages keep showing their browser:// URL, never the file path;
      // reading view shows the article's own address (see readerSource).
      // A Safe Browsing warning shows the address it is about, marked
      // dangerous - never as the padlocked page it stopped.
      const warned = warningSource(tab.state.internalUrl);
      tab.state.displayUrl = readerSource(tab.state.internalUrl) || warned || tab.state.internalUrl || tab.state.url;
      tab.state.canGoBack = wc.navigationHistory.canGoBack();
      tab.state.canGoForward = wc.navigationHistory.canGoForward();
      tab.state.security = securityState(warned ? tab.state.internalUrl : tab.state.displayUrl, tab.state.loadError);
      if (tab.state.security === 'secure' && owner().securityOf?.(tab.state.url) === 'insecure') tab.state.security = 'insecure';
      owner().onChange();
    };

    // In split view, clicking into a pane makes it the active tab, so the
    // address bar and every command follow what you are working in.
    wc.on('focus', () => {
      if (owner().activeId === tab.id) return;
      const pair = owner().pairOf(owner().activeId);
      if (!pair || (pair.left !== tab.id && pair.right !== tab.id)) return;
      owner().activeId = tab.id;
      tab.lastActiveAt = Date.now();
      owner().onSelected?.(tab.id);
      owner().onChange();
    });

    wc.on('page-title-updated', (_event, title) => {
      tab.state.title = title;
      // Titles often arrive after the visit was recorded; patch that row.
      if (tab.historyId) owner().onNavigate?.({ type: 'title', id: tab.historyId, title });
      owner().onChange();
    });

    wc.on('page-favicon-updated', (_event, icons) => {
      tab.state.favicon = Array.isArray(icons) ? icons[0] || null : null;
      owner().onChange();
    });

    // Chromium says when a page starts and stops making sound (it holds
    // "playing" a couple of seconds past the last sound, so a pause between
    // tracks does not make the speaker blink). Read back from the contents
    // rather than trusting the event alone: older builds sent no flag.
    wc.on('audio-state-changed', (event) => {
      if (wc.isDestroyed()) return;
      const audible = typeof event?.audible === 'boolean' ? event.audible : wc.isCurrentlyAudible();
      if (audible === tab.state.audible) return;
      tab.state.audible = audible;
      owner().onChange();
    });

    wc.on('did-start-loading', () => {
      tab.state.loading = true;
      tab.state.loadError = null;
      owner().onChange();
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
      tab.historyId = owner().onNavigate?.({ type: 'visit', url, title: wc.getTitle() }) || null;
      sync();
    });

    // A file dropped onto a page. Chromium would open it as file://, which
    // tabs may never load; main opens it the safe way instead. Our own pages
    // are file:// too, so anything under the app's renderer folder is left alone.
    wc.on('will-navigate', (event, legacyUrl) => {
      const url = typeof legacyUrl === 'string' ? legacyUrl : event?.url || '';
      if (!/^file:/i.test(url) || url.startsWith(RENDERER_ROOT)) return;
      event.preventDefault();
      owner().onFileDropped?.(tab, url);
    });

    // Popups and target=_blank become real tabs instead of extra windows.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      owner().create({ url, background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
  }

  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const target = resolveInput(input, this.getEngine?.() || 'google');
    tab.state.displayUrl = readerSource(target) || warningSource(target) || target;
    tab.state.security = securityState(target);
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
      if (previous) previous.lastActiveAt = Date.now();
      // Detach what was on screen, except what stays on screen: selecting the
      // other half of a pair keeps both panes.
      const keep = new Set([id, this.tabs.get(id)?.splitWith].filter(Boolean));
      const shown = previous ? [previous.id, previous.splitWith].filter(Boolean) : [];
      for (const shownId of shown) {
        const view = this.tabs.get(shownId)?.view;
        if (view && !keep.has(shownId) && this.window.contentView.children.includes(view)) {
          this.window.contentView.removeChildView(view);
        }
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
    this.#place();
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // Closing one half of a pair leaves the other as an ordinary tab, and
    // selected if the closed one was.
    const partner = tab.splitWith && this.tabs.has(tab.splitWith) ? tab.splitWith : null;
    if (partner) this.unsplit(id);
    const url = tab.state.displayUrl;
    if (url && !/^browser:\/\/(newtab|welcome|profiles)/.test(url)) {
      // `at`: so a window closed since can be reopened first (see tab:reopen).
      this.closed.push({ url, index: this.order.indexOf(id), pinned: !!tab.pinned, groupId: tab.groupId || null, at: Date.now() });
      if (this.closed.length > 25) this.closed.shift();
    }
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
      if (partner) { this.select(partner); this.onChange(); return; }
      // Chrome selects the tab to the right, falling back to the left.
      const next = this.order.slice(position).find(id => this.tabs.get(id).workspaceId === this.activeWorkspace) ||
        this.order.slice(0, position).reverse().find(id => this.tabs.get(id).workspaceId === this.activeWorkspace);
      if (next) this.select(next);
      // The window's last tab: with other windows open, the window closes
      // with it, as in Chrome (`onEmpty` says whether it did). Otherwise the
      // window is never left with zero tabs.
      else if (this.order.length || !this.onEmpty?.()) this.create({});
    }
    this.onChange();
  }

  /**
   * Let a tab go to another window: out of this strip and off this window,
   * but alive - its page, its history and its scroll position go with it.
   * The next tab along takes its place, as when one is closed. A window left
   * with nothing at all is the caller's to close. Returns the tab record, for
   * the other window's adopt().
   */
  release(id) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    if (tab.splitWith && this.tabs.has(tab.splitWith)) this.unsplit(id);
    const position = this.order.indexOf(id);
    if (position >= 0) this.order.splice(position, 1);
    this.tabs.delete(id);
    if (this.window.contentView.children.includes(tab.view)) this.window.contentView.removeChildView(tab.view);
    try {
      this.extensions?.removeTab(tab.view.webContents);
    } catch { /* extension host may already be gone */ }
    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order.slice(Math.max(0, position)).find((other) => this.tabs.get(other).workspaceId === this.activeWorkspace) ||
        this.order.slice(0, Math.max(0, position)).reverse().find((other) => this.tabs.get(other).workspaceId === this.activeWorkspace);
      if (next) this.select(next);
      else if (this.order.length) this.create({});
    }
    this.onChange();
    return tab;
  }

  /**
   * Take in a tab another window let go of. It lands in the workspace on
   * show here, out of any split and any group (those belong to the window it
   * left), and keeps its pin. `background` leaves the current tab in front.
   */
  adopt(tab, { index, background = false } = {}) {
    if (!tab || this.tabs.has(tab.id) || tab.view.webContents.isDestroyed()) return false;
    tab.manager = this;
    Object.assign(tab, { workspaceId: this.activeWorkspace, groupId: null, splitWith: null, splitSide: null });
    this.tabs.set(tab.id, tab);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, this.order.length)) : this.order.length;
    this.order.splice(at, 0, tab.id);
    this.tidy();
    const previousActiveId = this.activeId;
    try {
      this.extensions?.addTab(tab.view.webContents, this.window);
    } catch (error) {
      console.error('Extension tab registration failed:', error.message);
    }
    // As in create(): registering can claim the selection, so it is put back.
    if (background && previousActiveId && this.tabs.has(previousActiveId)) this.select(previousActiveId);
    else this.select(tab.id);
    this.onChange();
    return true;
  }

  /**
   * The window is closing: every page in it goes too. A window's views are
   * not destroyed with it (unlike a BrowserWindow's), so a closed window
   * would otherwise leave its tabs running - and playing - unseen.
   */
  dispose() {
    for (const tab of this.tabs.values()) {
      try { this.extensions?.removeTab(tab.view.webContents); } catch { /* host already gone */ }
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
  }

  /**
   * Silence a tab, or let it be heard again. The page keeps playing either
   * way - only what reaches the speakers changes - so unmuting picks up
   * wherever the video or call has got to.
   */
  setMuted(id, muted) {
    const tab = this.tabs.get(id);
    const wc = tab?.view.webContents;
    if (!wc || wc.isDestroyed()) return false;
    wc.setAudioMuted(!!muted);
    tab.state.muted = wc.isAudioMuted();
    this.onChange();
    return true;
  }

  /** Drag-to-reorder: move `id` to absolute position `to` in the strip. */
  reorder(id, to) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    const target = Math.max(0, Math.min(Number(to) || 0, this.order.length));
    this.order.splice(target, 0, id);
    this.tidy();
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
    this.#place();
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

}

module.exports = { Tabs, NEW_TAB };
