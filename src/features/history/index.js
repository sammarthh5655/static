'use strict';

const { JsonStore } = require('../../main/lib/json-store');
const ipc = require('../../main/ipc');
const { isInternalUrl, hostOf } = require('../../main/lib/url');

/**
 * History feature — every top-level navigation is appended to
 * `userData/history.json` as a visit `{ id, url, title, time }`.
 *
 * We store raw visits (newest first) and aggregate on read; that keeps the
 * write path trivial. The list is capped so the file stays small.
 */
const MAX_VISITS = 10000;

class History {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new JsonStore('history', { visits: [] });
    this._nextId = this.store.data.visits.reduce((m, v) => Math.max(m, v.id || 0), 0) + 1;
  }

  get visits() {
    return this.store.data.visits;
  }

  /** Should this URL be recorded at all? */
  static isRecordable(url) {
    if (!url || url === 'about:blank') return false;
    if (isInternalUrl(url)) return false;
    return /^(https?|file|chrome-extension):/.test(url);
  }

  add(url, title) {
    if (!History.isRecordable(url)) return;
    const last = this.visits[0];
    // Collapse immediate duplicates (reload, in-page nav bouncing).
    if (last && last.url === url && Date.now() - last.time < 5000) {
      if (title) last.title = title;
      this.store.save();
      return;
    }
    this.visits.unshift({ id: this._nextId++, url, title: title || url, time: Date.now() });
    if (this.visits.length > MAX_VISITS) this.visits.length = MAX_VISITS;
    this.store.save();
    ipc.broadcast('history:changed');
  }

  /** Titles usually arrive after the navigation; patch the newest visit. */
  updateTitle(url, title) {
    if (!title) return;
    const visit = this.visits.find((v) => v.url === url);
    if (visit && visit.title !== title) {
      visit.title = title;
      this.store.save();
    }
  }

  list({ limit = 200, offset = 0 } = {}) {
    return this.visits.slice(offset, offset + limit);
  }

  search(query, { limit = 200 } = {}) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return this.list({ limit });
    const terms = q.split(/\s+/);
    const out = [];
    for (const v of this.visits) {
      const hay = `${v.title} ${v.url}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) {
        out.push(v);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  remove(ids) {
    const set = new Set(ids);
    this.store.data.visits = this.visits.filter((v) => !set.has(v.id));
    this.store.save();
    ipc.broadcast('history:changed');
  }

  clear() {
    this.store.data.visits = [];
    this.store.save();
    ipc.broadcast('history:changed');
  }

  /**
   * Aggregate visits per URL with a score that favours frequency + recency.
   * Used by omnibox suggestions and the new-tab "top sites".
   */
  aggregate() {
    const now = Date.now();
    const byUrl = new Map();
    for (const v of this.visits) {
      let agg = byUrl.get(v.url);
      if (!agg) {
        agg = { url: v.url, title: v.title, count: 0, lastVisit: v.time, score: 0 };
        byUrl.set(v.url, agg);
      }
      agg.count += 1;
      // Recency decay: a visit today counts ~1, a week ago ~0.5, a month ~0.2.
      const ageDays = (now - v.time) / 86400000;
      agg.score += 1 / (1 + ageDays / 7);
    }
    return byUrl;
  }

  topSites(n = 8) {
    const perHost = new Map();
    for (const agg of this.aggregate().values()) {
      if (!/^https?:/.test(agg.url)) continue;
      const host = hostOf(agg.url);
      const cur = perHost.get(host);
      if (!cur) perHost.set(host, { ...agg });
      else {
        cur.score += agg.score;
        if (agg.lastVisit > cur.lastVisit) Object.assign(cur, { url: agg.url, title: agg.title, lastVisit: agg.lastVisit });
      }
    }
    return [...perHost.values()].sort((a, b) => b.score - a.score).slice(0, n)
      .map((a) => ({ url: a.url, title: a.title, host: hostOf(a.url) }));
  }

  /** Omnibox suggestions from history for a typed prefix/substring. */
  suggest(query, limit = 5) {
    const q = query.toLowerCase();
    const results = [];
    for (const agg of this.aggregate().values()) {
      const url = agg.url.toLowerCase();
      const title = (agg.title || '').toLowerCase();
      const stripped = url.replace(/^https?:\/\/(www\.)?/, '');
      let bonus = 0;
      if (stripped.startsWith(q)) bonus = 3;
      else if (url.includes(q)) bonus = 1;
      else if (title.includes(q)) bonus = 1;
      else continue;
      results.push({ url: agg.url, title: agg.title, score: agg.score + bonus });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  registerIpc() {
    ipc.handle('history:list', (_e, opts) => this.list(opts));
    ipc.handle('history:search', (_e, query, opts) => this.search(query, opts));
    ipc.handle('history:remove', (_e, ids) => this.remove(Array.isArray(ids) ? ids : [ids]));
    ipc.handle('history:clear', () => this.clear());
    ipc.handle('history:top-sites', (_e, n) => this.topSites(n));
  }
}

module.exports = { History };
