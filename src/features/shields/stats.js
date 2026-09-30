/**
 * Privacy statistics: what was actually blocked, by day and by category.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * Shields kept a single lifetime `totalBlocked` integer. That is enough for a
 * badge and nothing else - it cannot answer "today", "this week", "how much of
 * that was trackers rather than ads", or draw a chart. Anything built on it
 * would have had to invent the rest, and invented numbers in a privacy UI are
 * worse than no numbers: they teach people to distrust the one screen that
 * exists to be trusted.
 *
 * DESIGN
 * Days are stored as plain YYYY-MM-DD keys in local time, because that is the
 * day boundary a person means when they say "today". Each day holds one small
 * object of counters. Old days are pruned so the file cannot grow without
 * bound.
 *
 * Counters are only ever incremented from the real pipeline - the request
 * filter, the URL rewriter, the cosmetic injector. Nothing here estimates
 * anything except bandwidth and time, and both are labelled as estimates
 * wherever they surface.
 */

/** Categories tracked per day. Adding one is safe: missing keys read as 0. */
const CATEGORIES = [
  'ads',            // network requests matched by an ad rule
  'trackers',       // network requests matched by a privacy/tracking rule
  'cosmetic',       // elements hidden by cosmetic rules
  'https',          // http -> https upgrades
  'params',         // tracking parameters stripped
  'cookies',        // third-party cookies blocked
  'phishing',       // phishing/unsafe navigations blocked
  'videoAds',       // video ad payloads stripped (YouTube)
  'scriptlet',      // pages where filter-list scriptlets were injected
  'redirect',       // requests answered with a harmless stand-in resource
];

/** How many days of history to keep. */
const RETENTION_DAYS = 400;

/**
 * Average transfer size avoided per blocked request, in bytes.
 *
 * A real measurement is not available: the request is cancelled before any
 * body arrives, so its size is never known. 55KB is a conservative figure for
 * a typical ad or tracker payload. Everything derived from it is labelled an
 * estimate in the UI, and it is deliberately on the low side - overstating
 * what a blocker saved is the kind of number that makes people stop believing
 * the rest of the screen.
 */
const BYTES_PER_BLOCK = 55 * 1024;

/**
 * Milliseconds of page time saved per blocked request. Also an estimate, and
 * the same one Brave uses (MILLISECONDS_PER_ITEM = 50 in brave-core's
 * brave_new_tab_ui/containers/newTab/stats.tsx), so the two are comparable.
 */
const MS_PER_BLOCK = 50;

/** Blocked domains and sites kept for the "most blocked" lists. */
const MAX_HOSTS = 300;
/** Hourly buckets kept, for the last-24-hours chart. */
const HOURS_KEPT = 48;
/** Recent blocks kept in memory for the live feed. Never written to disk. */
const FEED_SIZE = 150;

/**
 * Second-level suffixes under which a name is still a public suffix, so
 * `ads.example.co.uk` groups as `example.co.uk` rather than `co.uk`. Not the
 * full public suffix list: enough for the domains ad networks actually use.
 */
const TWO_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in',
  'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.mx',
  'com.tr', 'com.sg', 'com.hk', 'co.kr', 'co.nz', 'co.za', 'com.ar', 'com.tw', 'co.id', 'com.my', 'com.ph']);

/** The registrable part of a host: ads.g.doubleclick.net -> doubleclick.net. */
function baseDomain(host) {
  const clean = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!clean || /^[\d.]+$/.test(clean) || clean.includes(':')) return clean;
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  const lastTwo = parts.slice(-2).join('.');
  return parts.slice(TWO_LEVEL.has(lastTwo) ? -3 : -2).join('.');
}

/** Local-time YYYY-MM-DDTHH for a timestamp. */
function hourKey(at) {
  const date = at instanceof Date ? at : new Date(at ?? Date.now());
  return dayKey(date) + 'T' + String(date.getHours()).padStart(2, '0');
}

/** Local-time YYYY-MM-DD for a timestamp. */
function dayKey(at) {
  const date = at instanceof Date ? at : new Date(at ?? Date.now());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** An empty day. */
function emptyDay() {
  const day = {};
  for (const category of CATEGORIES) day[category] = 0;
  return day;
}

class Stats {
  /**
   * @param {object} store a JsonStore-like object with a `.data` object
   * @param {() => void} [onChange] called when a day rolls over or totals move
   */
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange || (() => {});
    for (const key of ['days', 'hours', 'hosts', 'sites']) {
      const value = this.store.data[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) this.store.data[key] = {};
    }
    /** The newest blocks first, for the live feed. Memory only. */
    this.feed = [];
    // Dirty-count so a burst of blocks does not write the file per request.
    this.dirty = 0;
    // Since Static started, in memory only.
    this.session = emptyDay();
  }

  get days() { return this.store.data.days; }

  /**
   * Record `count` events of `category`.
   *
   * Called from the blocking pipeline, so it must stay cheap: no allocation
   * beyond the day object itself, and no disk write on most calls.
   */
  record(category, count = 1) {
    if (!CATEGORIES.includes(category) || !(count > 0)) return;
    const key = dayKey();
    const day = (this.days[key] ||= emptyDay());
    day[category] = (day[category] || 0) + count;
    this.session[category] = (this.session[category] || 0) + count;

    const hour = (this.store.data.hours[hourKey()] ||= { ads: 0, trackers: 0, other: 0 });
    const lane = category === 'ads' || category === 'trackers' ? category : 'other';
    hour[lane] = (hour[lane] || 0) + count;

    this.dirty += count;
    if (this.dirty >= 25) this.flush();
  }

  /**
   * Who was blocked, and where. Called alongside `record` for network blocks.
   *
   * Blocked domains are what a person asks about ("who was tracking me?"), and
   * the sites are where it happened. The live feed holds the latest few in
   * memory only: a list of addresses you visited is browsing history, and it
   * does not belong in a statistics file.
   */
  note({ url, host, site, category, type, list, action } = {}) {
    const requestHost = host || hostOf(url);
    const blocked = baseDomain(requestHost);
    const where = baseDomain(site);
    const now = Date.now();
    if (blocked) {
      const entry = (this.store.data.hosts[blocked] ||= { count: 0, ads: 0, trackers: 0, last: 0 });
      entry.count++;
      if (category === 'ads' || category === 'trackers') entry[category]++;
      entry.last = now;
    }
    if (where) {
      const entry = (this.store.data.sites[where] ||= { count: 0, last: 0 });
      entry.count++;
      entry.last = now;
    }
    this.feed.unshift({
      at: now,
      url: String(url || '').slice(0, 300),
      host: requestHost,
      domain: blocked,
      site: where,
      category: category || 'trackers',
      type: type || 'other',
      list: list || '',
      action: action || 'blocked',
    });
    if (this.feed.length > FEED_SIZE) this.feed.length = FEED_SIZE;
  }

  /** The latest blocks, newest first. */
  recent(limit = 50) {
    return this.feed.slice(0, Math.max(0, Math.min(FEED_SIZE, Number(limit) || 0)));
  }

  /** The most-blocked domains, or the sites where most was blocked. */
  top(which = 'hosts', limit = 10) {
    const table = this.store.data[which === 'sites' ? 'sites' : 'hosts'] || {};
    return Object.entries(table)
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => b.count - a.count || b.last - a.last)
      .slice(0, limit);
  }

  /** One entry per hour for the last `hours` hours, oldest first. */
  hourly(hours = 24) {
    const out = [];
    const now = Date.now();
    for (let back = hours - 1; back >= 0; back--) {
      const at = new Date(now - back * 3600 * 1000);
      const bucket = this.store.data.hours[hourKey(at)] || {};
      out.push({ hour: hourKey(at), at: at.getHours(), ads: bucket.ads || 0, trackers: bucket.trackers || 0, other: bucket.other || 0 });
    }
    return out;
  }

  /** The first day anything was recorded, for "since ...". */
  get firstDay() {
    return Object.keys(this.days)
      .filter((key) => CATEGORIES.some((category) => this.days[key][category]))
      .sort()[0] || null;
  }

  /** Forget where blocking happened, which reads like history. Totals stay. */
  forgetSites() {
    this.store.data.sites = {};
    this.feed = [];
    this.flush();
  }

  /** Start the statistics again from nothing. */
  reset() {
    this.store.data.days = {};
    this.store.data.hours = {};
    this.store.data.hosts = {};
    this.store.data.sites = {};
    this.store.data.totalBlocked = 0;
    this.session = emptyDay();
    this.feed = [];
    this.flush();
    this.onChange();
  }

  /** Persist and prune. Safe to call at any time. */
  flush() {
    this.dirty = 0;
    this.#prune();
    this.store.save();
  }

  /** Drop days beyond the retention window. */
  #prune() {
    const keys = Object.keys(this.days);
    if (keys.length > RETENTION_DAYS) {
      for (const key of keys.sort().slice(0, keys.length - RETENTION_DAYS)) delete this.days[key];
    }
    const hours = Object.keys(this.store.data.hours);
    if (hours.length > HOURS_KEPT) {
      for (const key of hours.sort().slice(0, hours.length - HOURS_KEPT)) delete this.store.data.hours[key];
    }
    // The long tail of domains blocked once is dropped first.
    for (const which of ['hosts', 'sites']) {
      const table = this.store.data[which];
      const names = Object.keys(table);
      if (names.length <= MAX_HOSTS) continue;
      const keep = new Set(this.top(which, MAX_HOSTS).map((entry) => entry.name));
      for (const name of names) if (!keep.has(name)) delete table[name];
    }
  }

  /**
   * Totals over the last `days` days, inclusive of today.
   * `days = 0` means all recorded history.
   */
  totals(days = 1) {
    const wanted = this.#keysFor(days);
    const sum = emptyDay();
    for (const key of wanted) {
      const day = this.days[key];
      if (!day) continue;
      for (const category of CATEGORIES) sum[category] += day[category] || 0;
    }
    sum.total = CATEGORIES.reduce((n, category) => n + sum[category], 0);
    // Only NETWORK blocks avoid a download. Hiding an element or stripping a
    // parameter saves nothing on the wire, so counting them here would inflate
    // the figure for no reason.
    const networkBlocks = sum.ads + sum.trackers;
    sum.bytesSaved = networkBlocks * BYTES_PER_BLOCK;
    sum.msSaved = networkBlocks * MS_PER_BLOCK;
    sum.estimated = true;   // the UI must label bytesSaved/msSaved as estimates
    return sum;
  }

  /** Totals plus the derived estimates, for a counter object. */
  #decorate(sum) {
    sum.total = CATEGORIES.reduce((n, category) => n + (sum[category] || 0), 0);
    const networkBlocks = (sum.ads || 0) + (sum.trackers || 0);
    sum.bytesSaved = networkBlocks * BYTES_PER_BLOCK;
    sum.msSaved = networkBlocks * MS_PER_BLOCK;
    sum.estimated = true;
    return sum;
  }

  /** Day keys for a window, oldest first. */
  #keysFor(days) {
    if (!days || days <= 0) return Object.keys(this.days).sort();
    const keys = [];
    const now = new Date();
    for (let back = days - 1; back >= 0; back--) {
      const date = new Date(now);
      date.setDate(date.getDate() - back);
      keys.push(dayKey(date));
    }
    return keys;
  }

  /**
   * A series for the sparkline: one entry per day, oldest first, including
   * days with no activity so the chart keeps an even time axis.
   */
  series(days = 7) {
    return this.#keysFor(days).map((key) => {
      const day = this.days[key] || emptyDay();
      return {
        day: key,
        total: CATEGORIES.reduce((n, category) => n + (day[category] || 0), 0),
      };
    });
  }

  /** Ads, trackers and everything else for one day. */
  #split(key) {
    const day = this.days[key] || {};
    const ads = day.ads || 0;
    const trackers = day.trackers || 0;
    const all = CATEGORIES.reduce((n, category) => n + (day[category] || 0), 0);
    return { ads, trackers, other: all - ads - trackers };
  }

  /** True when nothing has ever been recorded - the UI shows an empty state. */
  get isEmpty() {
    for (const key of Object.keys(this.days)) {
      const day = this.days[key];
      for (const category of CATEGORIES) if (day[category]) return false;
    }
    return true;
  }

  /**
   * The one number every surface shows.
   *
   * There used to be two counters: a lifetime `totalBlocked` integer bumped on
   * each block, and this per-day map. They counted different events and drifted
   * apart, so the homepage, the shield card and the dashboard each showed a
   * DIFFERENT figure at the same moment - 142, 736, 746 and 747 all on screen
   * at once. Anything that wants a headline count now derives it from here.
   */
  lifetime() {
    const all = this.totals(0);
    return {
      // Ads and trackers are what "blocked" means to a person: requests that
      // were stopped. Cosmetic hiding and parameter stripping are real, but
      // counting them in the same number is what made it unexplainable.
      ads: all.ads,
      trackers: all.trackers,
      blocked: all.ads + all.trackers,
      cosmetic: all.cosmetic,
      videoAds: all.videoAds,
      // Everything, for anywhere that genuinely wants the grand total.
      total: all.total,
    };
  }

  /** Everything the privacy widget needs, in one call. */
  summary() {
    return {
      lifetime: this.lifetime(),
      today: this.totals(1),
      week: this.totals(7),
      month: this.totals(30),
      allTime: this.totals(0),
      session: this.#decorate({ ...this.session }),
      series: this.series(7),
      series30: this.series(30).map((point) => ({ ...point, ...this.#split(point.day) })),
      hourly: this.hourly(24),
      topHosts: this.top('hosts', 12),
      topSites: this.top('sites', 12),
      firstDay: this.firstDay,
      isEmpty: this.isEmpty,
      // So the UI never has to hardcode the disclaimer text.
      estimateNote: 'Bandwidth and time saved are estimates.',
    };
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

module.exports = { Stats, CATEGORIES, dayKey, hourKey, baseDomain, BYTES_PER_BLOCK, MS_PER_BLOCK };
