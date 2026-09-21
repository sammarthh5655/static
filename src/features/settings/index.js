'use strict';

const { JsonStore } = require('../../main/lib/json-store');
const ipc = require('../../main/ipc');
const { SEARCH_ENGINES, DEFAULT_ENGINE } = require('../../main/lib/search-engines');
const { NEW_TAB_URL } = require('../../main/lib/url');

/**
 * Settings feature — persisted in `userData/settings.json`.
 *
 * Every other feature reads its configuration from here rather than keeping
 * its own copy, so a `settings:changed` broadcast is all it takes for the UI
 * and the internal pages to re-render with new values.
 *
 * `newTabBehavior`: what Ctrl+T opens
 *   'newtab'   -> the built-in static://newtab page
 *   'homepage' -> the homepage URL
 *   'blank'    -> about:blank
 */
const DEFAULTS = {
  searchEngine: DEFAULT_ENGINE,
  homepage: NEW_TAB_URL,
  newTabBehavior: 'newtab',
  showBookmarksBar: false,
  askWhereToSave: false,
};

/** Validators per key: reject garbage coming from the settings page. */
const VALIDATORS = {
  searchEngine: (v) => typeof v === 'string' && Object.hasOwn(SEARCH_ENGINES, v),
  homepage: (v) => typeof v === 'string' && v.length < 2048,
  newTabBehavior: (v) => ['newtab', 'homepage', 'blank'].includes(v),
  showBookmarksBar: (v) => typeof v === 'boolean',
  askWhereToSave: (v) => typeof v === 'boolean',
};

class Settings {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new JsonStore('settings', DEFAULTS);
    // Repair values that no longer exist (e.g. an engine we dropped).
    if (!SEARCH_ENGINES[this.store.data.searchEngine]) {
      this.store.data.searchEngine = DEFAULT_ENGINE;
    }
  }

  get(key) {
    return key ? this.store.data[key] : { ...this.store.data };
  }

  /** Merge a partial object; invalid keys/values are ignored. */
  set(patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch || {})) {
      if (!VALIDATORS[key] || !VALIDATORS[key](value)) continue;
      if (this.store.data[key] === value) continue;
      this.store.data[key] = value;
      changed = true;
    }
    if (changed) {
      this.store.save();
      ipc.broadcast('settings:changed', this.get());
    }
    return this.get();
  }

  /** URL a brand-new tab should open, per `newTabBehavior`. */
  newTabUrl() {
    const { newTabBehavior, homepage } = this.store.data;
    if (newTabBehavior === 'homepage') return homepage || NEW_TAB_URL;
    if (newTabBehavior === 'blank') return 'about:blank';
    // An enabled extension may override the new tab page (chrome_url_overrides).
    return this.ctx.extensionsFeature?.newTabOverride() || NEW_TAB_URL;
  }

  homepageUrl() {
    return this.store.data.homepage || NEW_TAB_URL;
  }

  registerIpc() {
    ipc.handle('settings:get', () => this.get());
    ipc.handle('settings:set', (_e, patch) => this.set(patch));
    ipc.handle('settings:search-engines', () => Object.values(SEARCH_ENGINES));
    ipc.handle('settings:clear-browsing-data', (_e, opts) => this.clearBrowsingData(opts));
  }

  /**
   * "Clear browsing data", split into independent switches so the settings
   * page can offer history-only / cookies+cache-only / everything.
   *
   * @param {{history?: boolean, cookiesAndCache?: boolean, downloads?: boolean}} opts
   */
  async clearBrowsingData(opts = {}) {
    const { history, cookiesAndCache, downloads } = opts;
    const cleared = [];
    if (history) {
      this.ctx.history.clear();
      cleared.push('history');
    }
    if (downloads) {
      this.ctx.downloads.clearList();
      cleared.push('downloads');
    }
    if (cookiesAndCache) {
      const s = this.ctx.tabSession;
      await s.clearCache();
      await s.clearAuthCache();
      await s.clearHostResolverCache();
      await s.clearCodeCaches({});
      // Wipes web storage for every origin, but NOT chrome.storage used by
      // extensions (that lives in Electron's own extension settings store).
      await s.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'shadercache', 'filesystem'],
      });
      cleared.push('cookiesAndCache');
    }
    return { ok: true, cleared };
  }
}

module.exports = { Settings };
