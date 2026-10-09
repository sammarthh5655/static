'use strict';

/**
 * Page tools: reading view, screenshots and a QR code for the page.
 *
 * All three act on a tab and show their results in the overlay as cards
 * (renderer/pagetools-panel.js), so they share one place in main: which tab a
 * request is about, the pictures waiting to be copied or saved, and the IPC
 * that the cards and the reading view page send back.
 *
 * Nothing a card sends can name a file, a tab or an address. A card holds a
 * random token for the picture main is keeping; the tab is the one the menu
 * was opened on, remembered here; the address is read from the tab itself.
 */

const { app, clipboard, ClipboardItem, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const qr = require('./qr');
const reader = require('./reader');
const capture = require('./capture');
const { readerSource } = require('../../shared/urls');

/**
 * The isolated world our page scripts run in. Its own JavaScript globals,
 * the page's DOM: the page cannot see these scripts, change what they call,
 * or read what they return.
 */
const WORLD = 4207;
/**
 * Pictures kept for the cards, newest last. Few, because a full page can be
 * tens of megabytes as a bitmap; only the cards still likely to be open need one.
 */
const KEEP = 4;
/** Articles kept for reading view, across all tabs. */
const ARTICLES = 12;

const isWeb = (url) => /^https?:\/\//i.test(url || '');

class PageTools {
  /**
   * @param {object} browser the BrowserApplication
   * @param {object} hooks   { showMenu(items, anchor, align), anchor(), tabOf(contents) }
   */
  constructor(browser, { showMenu, anchor, tabOf }) {
    this.browser = browser;
    this.showMenu = showMenu;
    this.anchor = anchor;
    this.tabOf = tabOf;
    /** token -> { kind, image, title, file?, tabId?, bounds? } */
    this.kept = new Map();
    /**
     * "tab id + address" -> article, newest last: the articles each tab has
     * opened in reading view, so Back through two of them finds each again.
     */
    this.articles = new Map();
    /** The tab a screenshot menu was opened for. */
    this.shotTabId = null;
  }

  get tabs() { return this.browser.tabs; }

  #notify(message) { this.browser.notify(message); }

  #keep(entry) {
    const token = randomUUID();
    this.kept.set(token, entry);
    while (this.kept.size > KEEP) this.kept.delete(this.kept.keys().next().value);
    return token;
  }

  #run(contents, source) {
    return contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: source }]);
  }

  /* ---- reading view ------------------------------------------------------ */

  /**
   * Ask each page, once it settles, whether it reads like an article, so the
   * address bar can offer reading view only where it will work. A page that
   * changes without loading (most news sites now) is asked again.
   */
  watch(contents) {
    let timer = 0;
    const later = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => this.check(contents), ms);
    };
    contents.on('did-start-navigation', (details) => {
      if (!details?.isMainFrame || details.isSameDocument) return;
      const tab = this.tabOf(contents);
      if (tab?.readable) { tab.readable = null; if (tab === this.tabs?.active) this.browser.push(); }
    });
    contents.on('did-stop-loading', () => later(350));
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) later(1200); });
    contents.once('destroyed', () => clearTimeout(timer));
  }

  async check(contents) {
    if (!contents || contents.isDestroyed()) return;
    const tab = this.tabOf(contents);
    if (!tab) return;
    const url = contents.getURL();
    let ok = false;
    if (!tab.state.internalUrl && isWeb(url)) {
      // The cheap question first; only a page that passes it is measured.
      try {
        ok = !!(await this.#run(contents, reader.PROBE_SOURCE))?.readable &&
          reader.looksLikeArticle(await this.#run(contents, reader.MEASURE_SOURCE));
      } catch { ok = false; }
    }
    if (contents.isDestroyed()) return;
    const before = tab.readable?.ok === ok && tab.readable?.url === url;
    tab.readable = { url, ok };
    if (!before && tab === this.tabs?.active) this.browser.push();
  }

  /** What the address bar shows for a tab: offer reading view, or show it is on. */
  readerState(tab) {
    if (!tab) return { available: false, active: false };
    const active = !!readerSource(tab.state.internalUrl || '');
    const available = !active && !tab.state.internalUrl && !!tab.readable?.ok && tab.readable.url === tab.state.url;
    return { available, active };
  }

  /** Open the reading view in place of the page, or leave it if it is open. */
  async toggleReader(tabId) {
    const tab = this.tabs?.tabs.get(tabId);
    if (!tab) return false;
    if (readerSource(tab.state.internalUrl || '')) return this.leaveReader(tabId);
    const contents = tab.view.webContents;
    const url = contents.getURL();
    if (!isWeb(url) || tab.state.internalUrl) {
      this.#notify('Reading view works on articles on the web.');
      return false;
    }
    let raw = null;
    try { raw = await this.#run(contents, reader.EXTRACT_SOURCE); } catch { raw = null; }
    const article = reader.clean(raw, url);
    if (!article) {
      this.#notify('Static could not find an article on this page to show in reading view.');
      return false;
    }
    // Kept while their tab is open, and only the last few: an article can
    // be the better part of a megabyte.
    const key = tabId + '\n' + url;
    this.articles.delete(key);
    this.articles.set(key, { tabId, article });
    for (const [k, entry] of this.articles) if (!this.tabs.tabs.has(entry.tabId)) this.articles.delete(k);
    while (this.articles.size > ARTICLES) this.articles.delete(this.articles.keys().next().value);
    this.tabs.navigate(tabId, 'browser://reader?url=' + encodeURIComponent(url));
    return true;
  }

  /**
   * Back to the page. When the page is the entry just behind this one - the
   * usual case - that is Back, which Chromium can restore exactly as it was,
   * scroll position and all. Otherwise it is loaded again.
   */
  leaveReader(tabId) {
    const tab = this.tabs?.tabs.get(tabId);
    const source = readerSource(tab?.state.internalUrl || '');
    if (!source) return false;
    const history = tab.view.webContents.navigationHistory;
    const index = history.getActiveIndex();
    const previous = index > 0 ? history.getEntryAtIndex(index - 1) : null;
    if (previous?.url === source) history.goBack();
    else this.tabs.navigate(tabId, source);
    return true;
  }

  /** The article for the reading view page in `sender`'s own tab. */
  articleFor(sender) {
    const tab = this.tabOf(sender);
    const source = readerSource(tab?.state.internalUrl || '');
    if (!source) return null;
    const entry = this.articles.get(tab.id + '\n' + source);
    if (entry) return { ...entry.article, source };
    // Restored from an earlier run, or the article was let go: say so, and
    // offer the page itself.
    return { missing: true, source, site: new URL(source).hostname.replace(/^www\./, '') };
  }

  /* ---- screenshots -------------------------------------------------------- */

  /** The three kinds of screenshot, as a menu where the last one was. */
  screenshotMenu(tabId, anchor, align = 'left') {
    if (!this.tabs?.tabs.has(tabId)) return false;
    this.shotTabId = tabId;
    const take = (mode) => ({ channel: 'shot:take', payload: { mode } });
    this.showMenu([
      { heading: 'Screenshot' },
      { label: 'Visible area', icon: 'shot_visible', hint: 'Just what is on screen now', action: take('visible') },
      { label: 'Full page', icon: 'shot_full', hint: 'The whole page, top to bottom', action: take('full') },
      { label: 'Select an area', icon: 'crop', hint: 'Drag across the part you want', action: take('region') },
    ], anchor || this.anchor(), align);
    return true;
  }

  async take(mode) {
    const tab = this.tabs?.tabs.get(this.shotTabId) || this.tabs?.active;
    const contents = tab?.view.webContents;
    if (!contents || contents.isDestroyed()) return false;
    // Taken from the tab on screen: a tab in the background has no picture.
    if (tab !== this.tabs.active && this.tabs.active?.splitWith !== tab.id) this.tabs.select(tab.id);
    const bounds = tab.view.getBounds();
    const title = tab.state.title || '';
    if (mode === 'region') {
      const image = await capture.visible(contents);
      if (!image) { this.#notify('This page could not be captured. Try again once it has loaded.'); return false; }
      const token = this.#keep({ kind: 'region', image, title, bounds });
      this.showMenu([{
        region: { token, image: 'data:image/jpeg;base64,' + image.toJPEG(92).toString('base64'), bounds },
      }], { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }, 'left');
      return true;
    }
    const result = mode === 'full'
      ? await capture.fullPage(contents)
      : { image: await capture.visible(contents) };
    if (!result?.image) { this.#notify('This page could not be captured. Try again once it has loaded.'); return false; }
    this.#preview(result.image, {
      title, mode: result.fallback ? 'visible' : mode, trimmed: !!(result.trimmed && !result.fallback),
      from: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    });
    if (result.fallback) this.#notify('The whole page could not be captured, so this is the part on screen.');
    return true;
  }

  /** The part of a picture someone selected, in the page's own pixels. */
  region(token, rect) {
    const entry = this.kept.get(token);
    if (!entry || entry.kind !== 'region') return false;
    this.kept.delete(token);
    const { bounds } = entry;
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
    let x = n(rect?.x); let y = n(rect?.y); let width = n(rect?.width); let height = n(rect?.height);
    if ([x, y, width, height].some(Number.isNaN)) return false;
    x = Math.max(0, Math.min(bounds.width - 1, x));
    y = Math.max(0, Math.min(bounds.height - 1, y));
    width = Math.max(1, Math.min(bounds.width - x, width));
    height = Math.max(1, Math.min(bounds.height - y, height));
    const image = capture.crop(entry.image, { x, y, width, height }, bounds.width);
    this.#preview(image, { title: entry.title, mode: 'region', from: { x: bounds.x + x, y: bounds.y + y, width, height } });
    return true;
  }

  #preview(image, { title, mode, trimmed = false, from }) {
    const token = this.#keep({ kind: 'shot', image, title });
    const { width, height } = image.getSize();
    this.showMenu([{
      shot: { token, image: capture.thumbnail(image), width, height, mode, trimmed, from },
    }], this.anchor(), 'right');
  }

  /* ---- QR code ------------------------------------------------------------ */

  /** A card with a QR code of the tab's address, drawn here and nowhere else. */
  showQr(tabId, anchor, align = 'right') {
    const tab = this.tabs?.tabs.get(tabId);
    const url = tab?.state.displayUrl || '';
    if (!isWeb(url)) { this.#notify('QR codes are for web pages.'); return false; }
    let symbol;
    try { symbol = qr.encode(url); } catch (error) { this.#notify(error.message); return false; }
    const picture = qr.bitmap(symbol, { scale: 12, border: 4 });
    const image = nativeImage.createFromBitmap(picture.buffer, { width: picture.width, height: picture.height });
    const host = new URL(url).hostname.replace(/^www\./, '');
    const token = this.#keep({ kind: 'qr', image, title: host });
    this.showMenu([{
      qr: { token, rows: qr.rows(symbol), url, host, title: tab.state.title || host },
    }], anchor || this.anchor(), align);
    return true;
  }

  /* ---- what the cards send back ------------------------------------------ */

  async copy(token) {
    const entry = this.kept.get(token);
    if (!entry || entry.kind === 'region') return { ok: false, error: 'This picture has gone. Take it again.' };
    try {
      const png = new Blob([entry.image.toPNG()], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': png })]);
    } catch (error) {
      return { ok: false, error: 'It could not be copied: ' + error.message };
    }
    return { ok: true };
  }

  save(token) {
    const entry = this.kept.get(token);
    if (!entry || entry.kind === 'region') return { ok: false, error: 'This picture has gone. Take it again.' };
    const qrCode = entry.kind === 'qr';
    // A short name for the card's status line, and the whole way there for its tooltip.
    const where = qrCode ? 'Downloads' : 'Static Screenshots';
    const folder = qrCode ? 'Downloads' : 'Pictures › Static Screenshots';
    // Saved once already: the same file, unless it has since been deleted
    // or moved, when Save means save it again.
    if (!entry.file || !fs.existsSync(entry.file)) {
      try {
        entry.file = capture.savePng(entry.image, qrCode
          ? { dir: app.getPath('downloads'), prefix: 'QR code', title: entry.title }
          : { title: entry.title });
      } catch (error) {
        return { ok: false, error: 'It could not be saved: ' + error.message };
      }
    }
    return { ok: true, name: path.basename(entry.file), where, folder };
  }

  reveal(token) {
    const entry = this.kept.get(token);
    if (!entry?.file) return false;
    shell.showItemInFolder(entry.file);
    return true;
  }

  /** IPC for the cards, the address bar and the reading view page. */
  handlers() {
    const browser = this.browser;
    const token = (payload) => String(payload?.token || '');
    return {
      // From the main menu: the kinds open where the main menu was.
      'shot:menu': () => {
        const from = browser.lastMenu || {};
        return this.screenshotMenu(this.tabs?.activeId, from.anchor, from.align || 'left');
      },
      'shot:take': (_sender, payload) => this.take(['visible', 'full', 'region'].includes(payload?.mode) ? payload.mode : 'visible'),
      'shot:region': (_sender, payload) => this.region(token(payload), payload?.rect),
      'shot:copy': (_sender, payload) => this.copy(token(payload)),
      'shot:save': (_sender, payload) => this.save(token(payload)),
      'shot:reveal': (_sender, payload) => this.reveal(token(payload)),
      // The QR button in the address bar, in the chrome's own coordinates.
      'qr:show': (sender, payload) => {
        let anchor = null;
        const a = payload?.anchor;
        const keys = ['left', 'right', 'top', 'bottom'];
        if (a && sender === browser.chrome?.webContents && keys.every((k) => Number.isFinite(Number(a[k])))) {
          const b = browser.chrome.getBounds();
          anchor = { left: Number(a.left) + b.x, right: Number(a.right) + b.x, top: Number(a.top) + b.y, bottom: Number(a.bottom) + b.y, width: 0, height: 0 };
        }
        return this.showQr(this.tabs?.activeId, anchor, 'right');
      },
      // The book in the address bar (or F9), and the reading view page itself.
      'reader:toggle': (sender) => this.toggleReader(this.tabOf(sender)?.id || this.tabs?.activeId),
      'reader:article': (sender) => this.articleFor(sender),
      'reader:leave': (sender) => this.leaveReader(this.tabOf(sender)?.id || this.tabs?.activeId),
    };
  }
}

module.exports = { PageTools };
