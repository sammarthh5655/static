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

/** Milliseconds of page time saved per blocked request. Also an estimate. */
const MS_PER_BLOCK = 35;

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
    if (!this.store.data.days || typeof this.store.data.days !== 'object') {
      this.store.data.days = {};
    }
    // Dirty-count so a burst of blocks does not write the file per request.
    this.dirty = 0;
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

    this.dirty += count;
    if (this.dirty >= 25) this.flush();
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
    if (keys.length <= RETENTION_DAYS) return;
    for (const key of keys.sort().slice(0, keys.length - RETENTION_DAYS)) {
      delete this.days[key];
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
      series: this.series(7),
      isEmpty: this.isEmpty,
      // So the UI never has to hardcode the disclaimer text.
      estimateNote: 'Bandwidth and time saved are estimates.',
    };
  }
}

module.exports = { Stats, CATEGORIES, dayKey, BYTES_PER_BLOCK, MS_PER_BLOCK };
