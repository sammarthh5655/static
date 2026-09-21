const fs = require('node:fs');
const path = require('node:path');
const { net } = require('electron');
const { JsonStore } = require('../../main/storage');
const { FilterEngine } = require('./filters');
const { Stats } = require('./stats');

/**
 * Shields: content blocking, HTTPS upgrades and URL cleaning.
 *
 * WHAT THIS IS AND IS NOT - read before comparing it to Brave or uBlock:
 *
 * This blocks NETWORK requests using EasyList/EasyPrivacy rules, and pairs
 * that with scriptlet injection (see scriptlets.js) for the ads that cannot be
 * blocked by address - YouTube serves video ads from the same endpoint as the
 * video itself.
 *
 * It does NOT randomise fingerprints, which needs Chromium patches Electron
 * does not expose.
 *
 * What it does do is real: the ad and tracker networks never get the request,
 * so they never see the visit and the bytes are never downloaded.
 *
 * Lists are cached on disk and refreshed weekly. A first run with no cache
 * falls back to a small built-in list so the feature is never silently inert.
 */

/** Refreshed weekly; these lists change slowly. */
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The filter lists, taken from Brave's own catalogue.
 *
 * This used to be EasyList and EasyPrivacy alone, which is why ads kept
 * getting through: Brave's DEFAULT set is uBlock Origin's filter corpus, and
 * EasyList is only one entry in it. uBlock's per-year files carry the rules
 * for everything added since 2020, `unbreak` and `quick-fixes` are what keep
 * sites working, and Brave's own lists cover what the shared lists miss.
 *
 * Source: brave/adblock-resources, filter_lists/list_catalog.json, the two
 * entries marked default_enabled.
 *
 * `essential` lists are fetched before the browser reports itself ready;
 * everything else streams in behind them, so a first run is protected quickly
 * rather than waiting on two dozen downloads.
 */
const UBO = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/';
const BRAVE = 'https://raw.githubusercontent.com/brave/adblock-lists/master/';

const LISTS = [
  // --- the core corpus, in Brave's own order --------------------------------
  { id: 'ubo-filters', name: 'uBlock filters', url: UBO + 'filters.txt', essential: true },
  { id: 'easylist', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt', essential: true },
  { id: 'easyprivacy', name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt', essential: true },
  { id: 'ubo-privacy', name: 'uBlock privacy', url: UBO + 'privacy.txt', essential: true },

  // Per-year files. uBlock splits its corpus by the year a rule was added, so
  // omitting these omits most of the modern web's ad rules.
  { id: 'ubo-2020', name: 'uBlock 2020', url: UBO + 'filters-2020.txt' },
  { id: 'ubo-2021', name: 'uBlock 2021', url: UBO + 'filters-2021.txt' },
  { id: 'ubo-2022', name: 'uBlock 2022', url: UBO + 'filters-2022.txt' },
  { id: 'ubo-2023', name: 'uBlock 2023', url: UBO + 'filters-2023.txt' },
  { id: 'ubo-2024', name: 'uBlock 2024', url: UBO + 'filters-2024.txt' },
  { id: 'ubo-2025', name: 'uBlock 2025', url: UBO + 'filters-2025.txt' },
  { id: 'ubo-2026', name: 'uBlock 2026', url: UBO + 'filters-2026.txt' },
  { id: 'ubo-general', name: 'uBlock general', url: UBO + 'filters-general.txt' },

  // Safety and site-health.
  { id: 'ubo-badware', name: 'Badware risks', url: UBO + 'badware.txt' },
  { id: 'ubo-abuse', name: 'Resource abuse', url: UBO + 'resource-abuse.txt' },
  // Unbreak and quick-fixes carry EXCEPTIONS. Without them the rules above
  // break real sites, which is how an ad blocker ends up switched off.
  { id: 'ubo-unbreak', name: 'uBlock unbreak', url: UBO + 'unbreak.txt', essential: true },
  { id: 'ubo-quick', name: 'Quick fixes', url: UBO + 'quick-fixes.txt', essential: true },

  // Brave's own lists.
  { id: 'brave-specific', name: 'Brave specific', url: BRAVE + 'brave-lists/brave-specific.txt' },
  { id: 'brave-social', name: 'Brave social', url: BRAVE + 'brave-lists/brave-social.txt' },
  { id: 'brave-firstparty', name: 'Brave first party', url: BRAVE + 'brave-lists/brave-firstparty.txt' },
  { id: 'brave-unbreak', name: 'Brave unbreak', url: BRAVE + 'brave-unbreak.txt', essential: true },
];

/**
 * Minimal built-in list, used when nothing has been downloaded yet.
 * Covers the largest ad and tracking networks so a fresh profile is not
 * completely unprotected on its first run.
 */
const BUILTIN = `
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||google-analytics.com^
||googletagmanager.com^
||googletagservices.com^
||adservice.google.com^
||analytics.google.com^
||facebook.com/tr^$third-party
||connect.facebook.net^$third-party
||scorecardresearch.com^
||quantserve.com^
||adnxs.com^
||rubiconproject.com^
||pubmatic.com^
||criteo.com^
||criteo.net^
||taboola.com^
||outbrain.com^
||amazon-adsystem.com^
||adsrvr.org^
||casalemedia.com^
||openx.net^
||33across.com^
||sharethrough.com^
||hotjar.com^
||mixpanel.com^
||segment.io^
||branch.io^
||amplitude.com^
||fullstory.com^
||mouseflow.com^
||crazyegg.com^
||clarity.ms^
||yandex.ru/metrika^
||matomo.cloud^
||chartbeat.com^
||newrelic.com/browser^
||bugsnag.com^
||sentry.io/api^$third-party
`;

/**
 * Tracking parameters stripped from URLs.
 *
 * Only ones that are unambiguously analytics: removing something a site uses
 * for routing would break it, which is a far worse outcome than leaving a
 * tracker in place.
 */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_cid', 'utm_reader', 'utm_pubreferrer',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'wbraid', 'gbraid',
  'msclkid', 'twclid', 'igshid', 'ttclid', 'yclid', 'rb_clickid',
  'mc_eid', 'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'vero_id',
  '_openstat', 'icid', 'ncid', 'ref_src', 'ref_url',
];

/**
 * Is a matched rule an ad rule or a tracking rule?
 *
 * The lists do not label rules, so this reads the rule text - the same signal
 * a person would use. It is a presentation split only: both are blocked
 * identically, and a rule that reads as neither is counted as a tracker, since
 * EasyPrivacy is the larger source of unlabelled rules.
 */
function classify(rule, url) {
  const text = String(rule || '') + ' ' + String(url || '');
  if (/(ads?|adserver|adservice|advert|doubleclick|adsystem|pagead|popads|banner|sponsor)/i.test(text)) {
    return 'ads';
  }
  return 'trackers';
}

class Shields {
  constructor(dir, { onChange } = {}) {
    this.dir = dir;
    this.cacheDir = path.join(dir, 'filter-lists');
    this.store = new JsonStore(dir, 'shields', {
      enabled: true,
      blockTrackers: true,
      upgradeHttps: true,
      stripTracking: true,
      blockThirdPartyCookies: true,
      // Scriptlet-based video ad blocking and cosmetic hiding.
      blockVideoAds: true,
      hideAdSlots: true,
      // Sites the user has switched shields off for.
      disabledSites: [],
      totalBlocked: 0,
      lastFetch: 0,
    });
    this.onChange = onChange || (() => {});

    // Per-day, per-category counters for the privacy widget and the Health
    // Center. Shares the store so it persists and prunes with everything else.
    this.stats = new Stats(this.store, () => this.onChange());

    this.engine = new FilterEngine();
    this.ready = false;
    /** tabId -> { host, blocked: Map<host, count> } for the per-site counter. */
    this.perTab = new Map();
    this.loadLists();
  }

  get config() { return this.store.data; }

  /** How many lists this build ships. */
  listCount() { return LISTS.length; }

  /** How many of the configured lists are actually cached on disk. */
  cachedListCount() {
    let found = 0;
    for (const list of LISTS) {
      try {
        if (fs.existsSync(path.join(this.cacheDir, list.id + '.txt'))) found++;
      } catch { /* unreadable cache counts as missing */ }
    }
    return found;
  }

  /** Load cached lists if present, otherwise the built-in fallback. */
  loadLists() {
    this.engine = new FilterEngine();
    let loadedFromCache = false;

    for (const list of LISTS) {
      const file = path.join(this.cacheDir, list.id + '.txt');
      try {
        if (fs.existsSync(file)) {
          this.engine.addList(fs.readFileSync(file, 'utf8'));
          loadedFromCache = true;
        }
      } catch (error) {
        console.error('shields: could not read ' + list.id, error.message);
      }
    }

    // Always include the built-in list: it is small, and it guarantees the
    // biggest trackers are covered even if a downloaded list is truncated.
    this.engine.addList(BUILTIN);
    this.ready = true;
    this.usingCache = loadedFromCache;
    return this.engine.count;
  }

  /** Download the filter lists. Safe to call on a schedule. */
  async refresh({ force = false } = {}) {
    const age = Date.now() - (this.config.lastFetch || 0);

    // A cache that is missing lists is stale no matter how recently it was
    // written. Without this, a profile created when the browser shipped two
    // lists kept exactly those two for a week after twenty were added - the
    // timestamp said "fresh", so nothing refetched, and the browser blocked
    // far less than it reported.
    const complete = this.cachedListCount() >= LISTS.length;
    if (!force && age < REFRESH_MS && this.usingCache && complete) {
      return { ok: true, skipped: true };
    }

    fs.mkdirSync(this.cacheDir, { recursive: true });

    /**
     * Fetch one list and cache it.
     *
     * A truncated or error response would silently disable blocking, so the
     * body has to look like a filter list before it overwrites the cache.
     * The test is deliberately loose: `quick-fixes` and the unbreak lists are
     * small and carry mostly EXCEPTIONS (@@) and cosmetic rules (##), so
     * demanding a network rule would reject exactly the lists that keep sites
     * working.
     */
    const fetchOne = async (list) => {
      try {
        const text = await download(list.url);
        const looksRight = text.length > 200 &&
          (text.includes('||') || text.includes('##') || text.includes('@@'));
        if (!looksRight) throw new Error('response did not look like a filter list');
        fs.writeFileSync(path.join(this.cacheDir, list.id + '.txt'), text);
        return true;
      } catch (error) {
        // One list failing must never stop the others: a network hiccup on a
        // minor list should not leave the browser unprotected.
        console.error('shields: could not fetch ' + list.id + ':', error.message);
        return false;
      }
    };

    // Essentials first and in parallel, so a fresh profile is protected in
    // seconds rather than after two dozen sequential downloads.
    const essential = LISTS.filter((list) => list.essential);
    const rest = LISTS.filter((list) => !list.essential);

    const first = await Promise.all(essential.map(fetchOne));
    let fetched = first.filter(Boolean).length;
    if (fetched) this.loadLists();     // block with what we have, now

    // Downloaded a few at a time: twenty parallel requests to two hosts is
    // rude and gets rate-limited.
    for (let at = 0; at < rest.length; at += 4) {
      const batch = await Promise.all(rest.slice(at, at + 4).map(fetchOne));
      fetched += batch.filter(Boolean).length;
    }

    if (fetched) {
      this.store.data.lastFetch = Date.now();
      this.store.save();
      this.loadLists();
    }
    this.onChange();
    return { ok: fetched > 0, fetched, total: LISTS.length, rules: this.engine.count };
  }

  /** Is the shield on for this page? */
  activeFor(host) {
    if (!this.config.enabled) return false;
    const clean = normaliseHost(host);
    return !(this.config.disabledSites || []).includes(clean);
  }

  /**
   * Decide what to do with a request.
   *
   * @returns {{block?: boolean, redirect?: string}|null} null means allow
   */
  inspect({ url, docHost, resourceType, tabId }) {
    if (!this.ready) return null;

    // Never interfere with our own pages or extension resources.
    if (!/^https?:/i.test(url)) return null;
    if (!this.activeFor(docHost)) return null;

    if (this.config.blockTrackers) {
      const verdict = this.engine.match({ url, docHost, resourceType });
      if (verdict.blocked) {
        this.#count(tabId, docHost, url);
        this.stats.record(classify(verdict.rule, url));
        return { block: true };
      }
    }

    // Upgrades and cleaning only make sense on a top-level navigation; doing
    // them to subresources risks breaking signed URLs and CORS.
    if (resourceType === 'mainFrame') {
      const rewritten = this.rewrite(url);
      if (rewritten && rewritten !== url) {
        // Record what actually changed rather than one generic event: an
        // https upgrade and a stripped parameter are different protections and
        // the dashboard reports them separately.
        if (/^http:/i.test(url) && /^https:/i.test(rewritten)) this.stats.record('https');
        if (new URL(url).search !== new URL(rewritten).search) this.stats.record('params');
        return { redirect: rewritten };
      }
    }
    return null;
  }

  /**
   * HTTPS upgrade and tracking-parameter removal for a top-level URL.
   * Returns the new URL, or the original when nothing changed.
   */
  rewrite(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return url; }
    let changed = false;

    if (this.config.stripTracking && parsed.search) {
      for (const param of TRACKING_PARAMS) {
        if (parsed.searchParams.has(param)) {
          parsed.searchParams.delete(param);
          changed = true;
        }
      }
    }

    if (this.config.upgradeHttps && parsed.protocol === 'http:') {
      // Localhost and raw IPs are left alone: they frequently have no TLS at
      // all, and upgrading them just breaks local development.
      const host = parsed.hostname;
      const isLocal = host === 'localhost' || host.endsWith('.localhost') ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.endsWith('.local');
      if (!isLocal) { parsed.protocol = 'https:'; changed = true; }
    }

    return changed ? parsed.toString() : url;
  }

  #count(tabId, docHost, url) {
    this.store.data.totalBlocked = (this.config.totalBlocked || 0) + 1;

    if (tabId === undefined || tabId === null) return;
    if (!this.perTab.has(tabId)) this.perTab.set(tabId, { host: docHost, blocked: new Map() });
    const entry = this.perTab.get(tabId);
    if (entry.host !== docHost) { entry.host = docHost; entry.blocked = new Map(); }
    let blockedHost = url;
    try { blockedHost = new URL(url).hostname; } catch { /* keep the raw url */ }
    entry.blocked.set(blockedHost, (entry.blocked.get(blockedHost) || 0) + 1);

    // The counter changes on nearly every request, so the store is saved
    // lazily rather than on each one.
    if (this.config.totalBlocked % 25 === 0) this.store.save();
  }

  /** Reset the per-tab counter when a tab navigates somewhere new. */
  resetTab(tabId, host) {
    this.perTab.set(tabId, { host: normaliseHost(host), blocked: new Map() });
  }

  forgetTab(tabId) { this.perTab.delete(tabId); }

  /** What was blocked on one tab, for the shield popup. */
  tabReport(tabId) {
    const entry = this.perTab.get(tabId);
    if (!entry) return { host: '', count: 0, sources: [] };
    const sources = [...entry.blocked.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    return {
      host: entry.host,
      count: sources.reduce((sum, source) => sum + source.count, 0),
      sources,
      active: this.activeFor(entry.host),
    };
  }

  setSiteEnabled(host, enabled) {
    const clean = normaliseHost(host);
    if (!clean) return { ok: false };
    const disabled = new Set(this.config.disabledSites || []);
    if (enabled) disabled.delete(clean);
    else disabled.add(clean);
    this.store.data.disabledSites = [...disabled].slice(-500);
    this.store.save();
    this.onChange();
    return { ok: true };
  }

  update(patch) {
    for (const key of ['enabled', 'blockTrackers', 'upgradeHttps', 'stripTracking',
                       'blockThirdPartyCookies', 'blockVideoAds', 'hideAdSlots']) {
      if (typeof patch?.[key] === 'boolean') this.store.data[key] = patch[key];
    }
    this.store.save();
    this.onChange();
    return this.state();
  }

  state() {
    return {
      config: this.config,
      rules: this.engine.count,
      usingCache: !!this.usingCache,
      lastFetch: this.config.lastFetch || 0,
      // Derived from the per-day stats, NOT from a separate counter. Two
      // counters is what made four surfaces disagree.
      totalBlocked: this.stats.lifetime().blocked,
      lifetime: this.stats.lifetime(),
      lists: LISTS.map((list) => ({ id: list.id, name: list.name })),
    };
  }

  flush() { this.store.save(); }
}

function normaliseHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

/** Download a filter list through Chromium's network stack. */
function download(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url });
    const chunks = [];
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error('HTTP ' + response.statusCode));
      }
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', reject);
    request.end();
  });
}

module.exports = { Shields, TRACKING_PARAMS, BUILTIN };
