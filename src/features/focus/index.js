const { JsonStore } = require('../../main/storage');

/**
 * Focus mode: site blocking with a timer.
 *
 * Blocking happens in `session.webRequest.onBeforeRequest`, which is the only
 * mechanism that stops a request before it leaves. Only top-level document
 * loads are blocked - blocking subresources would break embeds on pages the
 * user is legitimately allowed to see.
 *
 * YouTube is allowed by default and deliberately so: it is where people watch
 * lectures, tutorials and background music, and a blocker that also kills
 * those gets switched off entirely.
 */

/** Sites offered in the UI. `blockedByDefault: false` still appears, unticked. */
const CATALOG = [
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'], blockedByDefault: true },
  { id: 'facebook', name: 'Facebook', domains: ['facebook.com', 'fb.com', 'messenger.com'], blockedByDefault: true },
  { id: 'x', name: 'X / Twitter', domains: ['x.com', 'twitter.com', 't.co'], blockedByDefault: true },
  { id: 'snapchat', name: 'Snapchat', domains: ['snapchat.com'], blockedByDefault: true },
  { id: 'reddit', name: 'Reddit', domains: ['reddit.com', 'redd.it'], blockedByDefault: true },
  { id: 'tiktok', name: 'TikTok', domains: ['tiktok.com'], blockedByDefault: true },
  { id: 'threads', name: 'Threads', domains: ['threads.net', 'threads.com'], blockedByDefault: true },
  { id: 'pinterest', name: 'Pinterest', domains: ['pinterest.com'], blockedByDefault: true },
  { id: 'tumblr', name: 'Tumblr', domains: ['tumblr.com'], blockedByDefault: true },
  { id: 'linkedin', name: 'LinkedIn', domains: ['linkedin.com'], blockedByDefault: false },
  { id: 'discord', name: 'Discord', domains: ['discord.com', 'discord.gg'], blockedByDefault: false },
  { id: 'twitch', name: 'Twitch', domains: ['twitch.tv'], blockedByDefault: false },
  {
    id: 'youtube',
    name: 'YouTube',
    domains: ['youtube.com', 'youtu.be'],
    blockedByDefault: false,
    note: 'Allowed by default - lectures, tutorials and music.',
  },
];

/** Presets. `sites` lists catalog ids to block. */
const PRESETS = {
  study: {
    id: 'study', name: 'Study', minutes: 50,
    sites: ['instagram', 'facebook', 'x', 'snapchat', 'reddit', 'tiktok', 'threads', 'pinterest', 'tumblr'],
  },
  work: {
    id: 'work', name: 'Work', minutes: 90,
    sites: ['instagram', 'facebook', 'x', 'snapchat', 'reddit', 'tiktok', 'threads', 'pinterest', 'tumblr', 'twitch'],
  },
  legal: {
    id: 'legal', name: 'Legal research', minutes: 120,
    sites: ['instagram', 'facebook', 'x', 'snapchat', 'reddit', 'tiktok', 'threads', 'pinterest', 'tumblr', 'twitch', 'discord'],
  },
  gaming: {
    id: 'gaming', name: 'Gaming', minutes: 60,
    sites: ['instagram', 'facebook', 'x', 'linkedin', 'pinterest', 'tumblr'],
  },
  custom: { id: 'custom', name: 'Custom', minutes: 45, sites: [] },
};

/** Emergency unlock friction: the user must wait this long before it applies. */
const UNLOCK_DELAY_MS = 60 * 1000;

class Focus {
  /**
   * @param {string}   dir
   * @param {object}   deps
   * @param {Function} deps.onChange
   */
  constructor(dir, { onChange } = {}) {
    const defaultSites = CATALOG.filter((site) => site.blockedByDefault).map((site) => site.id);
    this.store = new JsonStore(dir, 'focus', {
      preset: 'study',
      blocked: defaultSites,
      customDomains: [],
      allowlist: [],
      // Session history, for the productivity stats.
      sessions: [],
      totalFocusMs: 0,
      blockedHits: 0,
    });
    this.onChange = onChange || (() => {});

    /** Active session, or null. */
    this.session = null;
    this.timer = null;
    this.unlockRequestedAt = null;
    /** Rebuilt whenever the blocklist changes, so the hot path is a Set. */
    this.blockedDomains = new Set();
    this.rebuild();
  }

  get config() { return this.store.data; }

  /** Flatten the selected catalog entries plus custom domains into one Set. */
  rebuild() {
    const domains = new Set();
    for (const id of this.config.blocked || []) {
      const entry = CATALOG.find((site) => site.id === id);
      if (entry) for (const domain of entry.domains) domains.add(domain);
    }
    for (const domain of this.config.customDomains || []) {
      const clean = normaliseDomain(domain);
      if (clean) domains.add(clean);
    }
    // The allowlist always wins over the blocklist.
    for (const domain of this.config.allowlist || []) {
      domains.delete(normaliseDomain(domain));
    }
    this.blockedDomains = domains;
  }

  get active() {
    return !!this.session && Date.now() < this.session.endsAt;
  }

  /** Remaining milliseconds, or 0 when no session is running. */
  get remainingMs() {
    return this.active ? Math.max(0, this.session.endsAt - Date.now()) : 0;
  }

  /**
   * Should this navigation be blocked?
   *
   * Matches the host and any parent domain, so `www.instagram.com` and
   * `m.instagram.com` are both caught by the single entry `instagram.com`.
   */
  shouldBlock(url) {
    if (!this.active) return false;
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch { return false; }

    for (const allowed of this.config.allowlist || []) {
      const clean = normaliseDomain(allowed);
      if (clean && (host === clean || host.endsWith('.' + clean))) return false;
    }
    for (const domain of this.blockedDomains) {
      if (host === domain || host.endsWith('.' + domain)) return true;
    }
    return false;
  }

  /** Called by the request filter when a load is actually blocked. */
  recordHit() {
    this.store.data.blockedHits = (this.store.data.blockedHits || 0) + 1;
    if (this.session) this.session.blocked = (this.session.blocked || 0) + 1;
    this.store.save();
  }

  start({ preset = this.config.preset, minutes } = {}) {
    const chosen = PRESETS[preset] || PRESETS.study;
    const duration = Math.max(1, Math.min(480, Number(minutes) || chosen.minutes));

    // A preset swaps the blocklist; "custom" keeps whatever the user set.
    if (chosen.id !== 'custom') {
      this.store.data.blocked = [...chosen.sites];
    }
    this.store.data.preset = chosen.id;
    this.rebuild();

    const now = Date.now();
    this.session = {
      preset: chosen.id,
      startedAt: now,
      endsAt: now + duration * 60000,
      minutes: duration,
      blocked: 0,
    };
    this.unlockRequestedAt = null;
    this.store.save();

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish('completed'), duration * 60000);
    this.onChange();
    return this.state();
  }

  /** End a session, recording it for the stats. */
  finish(reason = 'stopped') {
    if (!this.session) return this.state();
    const elapsed = Math.max(0, Date.now() - this.session.startedAt);
    this.store.data.sessions = [
      {
        preset: this.session.preset,
        startedAt: this.session.startedAt,
        endedAt: Date.now(),
        minutes: Math.round(elapsed / 60000),
        blocked: this.session.blocked || 0,
        reason,
      },
      ...(this.store.data.sessions || []),
    ].slice(0, 200);
    this.store.data.totalFocusMs = (this.store.data.totalFocusMs || 0) + elapsed;

    this.session = null;
    this.unlockRequestedAt = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.store.save();
    this.onChange();
    return this.state();
  }

  /**
   * Emergency unlock, with deliberate friction.
   *
   * The first call starts a one-minute wait; only a second call after that
   * wait actually ends the session. Instant unlock would make the whole
   * feature pointless, and no unlock at all would make it hostile.
   */
  requestUnlock() {
    if (!this.active) return { ok: true, unlocked: true };
    const now = Date.now();
    if (!this.unlockRequestedAt) {
      this.unlockRequestedAt = now;
      this.onChange();
      return { ok: true, unlocked: false, waitMs: UNLOCK_DELAY_MS };
    }
    const waited = now - this.unlockRequestedAt;
    if (waited < UNLOCK_DELAY_MS) {
      return { ok: true, unlocked: false, waitMs: UNLOCK_DELAY_MS - waited };
    }
    this.finish('unlocked');
    return { ok: true, unlocked: true };
  }

  update(patch) {
    const data = this.store.data;
    if (Array.isArray(patch?.blocked)) {
      data.blocked = patch.blocked.filter((id) => CATALOG.some((site) => site.id === id));
    }
    if (Array.isArray(patch?.customDomains)) {
      data.customDomains = patch.customDomains
        .map(normaliseDomain).filter(Boolean).slice(0, 200);
    }
    if (Array.isArray(patch?.allowlist)) {
      data.allowlist = patch.allowlist.map(normaliseDomain).filter(Boolean).slice(0, 200);
    }
    if (PRESETS[patch?.preset]) data.preset = patch.preset;
    this.store.save();
    this.rebuild();
    this.onChange();
    return this.state();
  }

  /** Aggregate stats for the UI. */
  stats() {
    const sessions = this.config.sessions || [];
    const dayAgo = Date.now() - 86400000;
    const weekAgo = Date.now() - 7 * 86400000;
    return {
      totalMinutes: Math.round((this.config.totalFocusMs || 0) / 60000),
      todayMinutes: sessions.filter((s) => s.endedAt > dayAgo)
        .reduce((sum, s) => sum + s.minutes, 0),
      weekMinutes: sessions.filter((s) => s.endedAt > weekAgo)
        .reduce((sum, s) => sum + s.minutes, 0),
      sessionCount: sessions.length,
      blockedHits: this.config.blockedHits || 0,
      recent: sessions.slice(0, 10),
    };
  }

  state() {
    return {
      active: this.active,
      remainingMs: this.remainingMs,
      session: this.session,
      config: this.config,
      catalog: CATALOG,
      presets: Object.values(PRESETS),
      stats: this.stats(),
      unlockRequestedAt: this.unlockRequestedAt,
      unlockDelayMs: UNLOCK_DELAY_MS,
    };
  }

  flush() { clearTimeout(this.timer); this.store.save(); }
}

/** "https://www.Example.com/path" -> "example.com" */
function normaliseDomain(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  try {
    if (/^[a-z]+:\/\//.test(text)) return new URL(text).hostname.replace(/^www\./, '');
  } catch { /* fall through to the plain form */ }
  return text.replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/[^a-z0-9.-]/g, '');
}

module.exports = { Focus, CATALOG, PRESETS, normaliseDomain };
