const { JsonStore } = require('../../main/storage');

/**
 * Static Sense: notice what the user is doing and offer the right next step.
 *
 * THE RULES THIS FOLLOWS
 *
 *  1. Detection is LOCAL. It reads tab titles and URLs already in memory.
 *     Nothing is sent anywhere, no page content is read, and the AI is not
 *     involved in deciding that a suggestion applies.
 *
 *  2. Suggestions are offers, never actions. Nothing is organised, opened,
 *     closed or summarised until the user says so.
 *
 *  3. Dismissal is permanent by kind. "Do not suggest this again" means this
 *     suggestion never appears again, not that it returns next week.
 *
 *  4. Silence is the default. A suggestion must clear a real threshold, and
 *     at most one is offered at a time. A browser that constantly suggests
 *     things is a browser people learn to ignore.
 *
 * WHY THIS IS PATTERN-BASED RATHER THAN A MODEL
 * Sending a list of open tabs to an API to ask "what is this person doing"
 * would leak a browsing session to a third party on a timer, to answer a
 * question that hostname counting answers well enough.
 */

/** How long a suggestion stays dismissed when snoozed rather than silenced. */
const SNOOZE_MS = 6 * 60 * 60 * 1000;

/** Minimum tabs before "you have a lot of tabs" is worth saying. */
const MANY_TABS = 12;

/** Minimum same-category tabs before a grouping suggestion applies. */
const CLUSTER_SIZE = 3;

/**
 * Host fragments by category.
 *
 * Deliberately small and obvious. A wrong guess here produces a suggestion
 * that makes no sense, which costs more trust than a missed one.
 */
const CATEGORIES = {
  shopping: ['amazon.', 'flipkart.', 'ebay.', 'etsy.', 'myntra.', 'ajio.',
    'bestbuy.', 'walmart.', 'target.com', 'aliexpress.', 'shopify.'],
  legal: ['indiankanoon', 'scconline', 'manupatra', 'barandbench', 'livelaw',
    'courtlistener', 'justia.', 'casetext.', 'supremecourt', 'judiciary.'],
  study: ['wikipedia.org', 'scholar.google', 'jstor.', 'arxiv.', 'coursera.',
    'khanacademy.', 'brilliant.org', 'researchgate.', 'sciencedirect.'],
  dev: ['github.com', 'gitlab.com', 'stackoverflow.com', 'developer.mozilla',
    'npmjs.com', 'pypi.org', 'docs.rs'],
  video: ['youtube.com', 'netflix.com', 'primevideo.', 'hotstar.', 'twitch.tv'],
};

/** Normalise a URL to a comparable hostname. */
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

/** Which category a host belongs to, or null. */
function categoryOf(host) {
  for (const [name, fragments] of Object.entries(CATEGORIES)) {
    if (fragments.some((fragment) => host.includes(fragment))) return name;
  }
  return null;
}

class Sense {
  constructor(dir, { onChange } = {}) {
    this.store = new JsonStore(dir, 'sense', {
      // Suggestion ids the user never wants to see again.
      silenced: [],
      // id -> timestamp until which it is snoozed.
      snoozed: {},
      // Whether Sense runs at all.
      enabled: true,
      // Counters, so the UI can say how useful it has actually been.
      accepted: 0,
      dismissed: 0,
    });
    this.onChange = onChange || (() => {});
  }

  get config() { return this.store.data; }

  setEnabled(on) {
    this.store.data.enabled = !!on;
    this.store.save();
    this.onChange();
    return this.store.data.enabled;
  }

  /** Permanently stop offering one suggestion. */
  silence(id) {
    if (!id) return;
    if (!this.store.data.silenced.includes(id)) this.store.data.silenced.push(id);
    this.store.data.dismissed++;
    this.store.save();
    this.onChange();
  }

  /** Dismiss for now. It may come back later. */
  snooze(id, now = Date.now()) {
    if (!id) return;
    this.store.data.snoozed[id] = now + SNOOZE_MS;
    this.store.data.dismissed++;
    this.store.save();
    this.onChange();
  }

  /** Record that a suggestion was taken up. */
  accept(id) {
    this.store.data.accepted++;
    // Taking an action does not silence it - the same situation later is
    // still worth offering.
    delete this.store.data.snoozed[id];
    this.store.save();
    this.onChange();
  }

  /** Is this suggestion currently allowed to appear? */
  allowed(id, now = Date.now()) {
    if (this.store.data.silenced.includes(id)) return false;
    const until = this.store.data.snoozed[id];
    return !(until && until > now);
  }

  /**
   * Look at the current tabs and produce at most one suggestion.
   *
   * @param {Array<{id: any, url: string, title: string, active?: boolean}>} tabs
   * @param {object} [context]
   * @param {boolean} [context.focusActive] a Focus session is running
   * @returns {object|null}
   */
  suggest(tabs = [], context = {}, now = Date.now()) {
    if (!this.config.enabled) return null;

    // Tabs arrive from live browser state, which can contain a half-closed or
    // not-yet-populated entry. A suggestion engine must never be the thing
    // that throws during a tab close race, so the input is filtered rather
    // than trusted.
    if (!Array.isArray(tabs)) return null;
    const real = tabs.filter((tab) =>
      tab && typeof tab.url === 'string' && /^https?:/i.test(tab.url));
    if (!real.length) return null;

    const candidates = [];

    // Duplicates: the same page open more than once.
    const byUrl = new Map();
    for (const tab of real) {
      const key = String(tab.url).split('#')[0];
      byUrl.set(key, (byUrl.get(key) || 0) + 1);
    }
    const duplicates = [...byUrl.values()].filter((count) => count > 1)
      .reduce((total, count) => total + (count - 1), 0);
    if (duplicates >= 2) {
      candidates.push({
        id: 'duplicates',
        title: duplicates + ' duplicate tabs are open',
        detail: 'Close the copies and keep one of each?',
        action: 'organizer:close-duplicates',
        actionLabel: 'Close duplicates',
        weight: 3,
      });
    }

    // Category clusters.
    const clusters = new Map();
    for (const tab of real) {
      const category = categoryOf(hostOf(tab.url));
      if (!category) continue;
      clusters.set(category, (clusters.get(category) || 0) + 1);
    }

    const shopping = clusters.get('shopping') || 0;
    if (shopping >= CLUSTER_SIZE) {
      candidates.push({
        id: 'shopping',
        title: 'Looks like you are comparing products',
        detail: shopping + ' shopping tabs are open. Compare them side by side?',
        action: 'open:browser://shopping',
        actionLabel: 'Open Shopping',
        weight: 4,
      });
    }

    const legal = clusters.get('legal') || 0;
    if (legal >= 2) {
      candidates.push({
        id: 'legal',
        title: 'Looks like legal research',
        detail: legal + ' legal sources are open. Start a case brief?',
        action: 'open:browser://legal',
        actionLabel: 'Open Legal',
        weight: 4,
      });
    }

    const study = clusters.get('study') || 0;
    if (study >= CLUSTER_SIZE) {
      candidates.push({
        id: 'study',
        title: 'Looks like study or research',
        detail: study + ' reference pages are open. Turn them into notes?',
        action: 'open:browser://student',
        actionLabel: 'Open Student',
        weight: 3,
      });
    }

    // Too many tabs at once.
    if (real.length >= MANY_TABS) {
      candidates.push({
        id: 'many-tabs',
        title: real.length + ' tabs are open',
        detail: 'Group them by what they are for?',
        action: 'open:browser://organizer',
        actionLabel: 'Organise tabs',
        weight: 2,
      });
    }

    // A Focus session with entertainment open is worth naming, because the
    // user asked to be protected from exactly this.
    if (context.focusActive && (clusters.get('video') || 0) >= 1) {
      candidates.push({
        id: 'focus-drift',
        title: 'Focus is running',
        detail: 'A video tab is open. End the session, or keep going?',
        action: 'open:browser://focus',
        actionLabel: 'Open Focus',
        weight: 5,
      });
    }

    // Only ever one, and only if it is allowed to appear.
    const allowed = candidates
      .filter((candidate) => this.allowed(candidate.id, now))
      .sort((a, b) => b.weight - a.weight);

    return allowed[0] || null;
  }

  state() {
    return {
      enabled: this.config.enabled,
      silenced: [...this.config.silenced],
      accepted: this.config.accepted,
      dismissed: this.config.dismissed,
    };
  }

  flush() { this.store.save(); }
}

module.exports = { Sense, CATEGORIES, categoryOf, hostOf, MANY_TABS, CLUSTER_SIZE, SNOOZE_MS };
