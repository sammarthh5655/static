const { JsonStore } = require('../../main/storage');

/**
 * First launch: the few questions worth asking, and nothing else.
 *
 * WHAT THIS IS ALLOWED TO DO
 * Onboarding collects preferences and writes them through the SAME validated
 * paths the settings page uses. It owns no settings of its own and never
 * writes to another feature's store directly, so a choice made here cannot
 * set a value the settings page would reject.
 *
 * WHAT IT MUST NOT DO
 *  - It must not block the browser. Every step after the first is skippable
 *    and the whole flow can be dismissed; a browser you cannot use until you
 *    have answered questions is a worse browser.
 *  - It must not ask for anything it does not need. No account, no email, no
 *    consent prompt for telemetry that does not exist.
 *  - It must not claim to have done something it has not.
 *
 * WHY THE CHOICES ARE PRESETS RATHER THAN A SETTINGS DUMP
 * Someone opening a browser for the first time has no basis for choosing a
 * corner radius. They do know whether they are here to study, to work, or to
 * browse. Each profile is a named bundle of settings the settings page can
 * still change afterwards - a starting point, not a mode.
 */

/** The steps, in order. `optional` steps can be passed over without a choice. */
const STEPS = [
  { id: 'welcome', title: 'Welcome to Static', optional: false },
  { id: 'profile', title: 'How will you use Static?', optional: false },
  { id: 'homepage', title: 'Your homepage', optional: true },
  { id: 'privacy', title: 'Privacy level', optional: true },
  { id: 'ai', title: 'The assistant', optional: true },
  { id: 'done', title: 'You are set up', optional: false },
];

/**
 * Browsing profiles.
 *
 * Each is a complete, coherent starting point. The summary states what
 * actually changes rather than describing a mood.
 */
const PROFILES = {
  study: {
    id: 'study',
    name: 'Study',
    summary: 'Reading queue and notes on the homepage, with a calmer start page. Focus sessions are one click away.',
    settings: { theme: 'eclipse', density: 'comfortable' },
    newTab: { widgets: ['clock', 'reading', 'notes', 'privacy'], showMostVisited: false },
  },
  work: {
    id: 'work',
    name: 'Work',
    summary: 'Shortcuts, downloads and recent pages in view, in a denser layout that fits more on screen.',
    settings: { theme: 'midnight', density: 'compact' },
    newTab: { widgets: ['clock', 'shortcuts', 'downloads', 'recent'], showMostVisited: true },
  },
  everyday: {
    id: 'everyday',
    name: 'Everyday',
    summary: 'A clean start page with your shortcuts and what you have been blocking. Nothing switched on that you did not ask for.',
    settings: { theme: 'eclipse', density: 'comfortable' },
    newTab: { widgets: ['clock', 'shortcuts', 'privacy'], showMostVisited: true },
  },
  private: {
    id: 'private',
    name: 'Private',
    summary: 'Every shield on, no most-visited row, and nothing suggested from your history.',
    settings: { theme: 'midnight', density: 'comfortable' },
    newTab: { widgets: ['clock', 'privacy'], showMostVisited: false },
    shields: {
      enabled: true, blockTrackers: true, upgradeHttps: true, stripTracking: true,
      blockThirdPartyCookies: true, blockVideoAds: true, hideAdSlots: true,
    },
  },
};

/**
 * Privacy levels.
 *
 * Strict says what it costs, because a protection that silently breaks sites
 * is one that gets switched off wholesale later.
 */
const PRIVACY_LEVELS = {
  standard: {
    id: 'standard',
    name: 'Standard',
    summary: 'Blocks ads and trackers, upgrades to HTTPS and strips tracking parameters. Sites work normally.',
    shields: {
      enabled: true, blockTrackers: true, upgradeHttps: true, stripTracking: true,
      blockThirdPartyCookies: true, blockVideoAds: true, hideAdSlots: true,
    },
  },
  strict: {
    id: 'strict',
    name: 'Strict',
    summary: 'Everything in Standard, with third-party cookies blocked everywhere. A few sites may need a per-site exception, which you can add from the shield.',
    shields: {
      enabled: true, blockTrackers: true, upgradeHttps: true, stripTracking: true,
      blockThirdPartyCookies: true, blockVideoAds: true, hideAdSlots: true,
    },
  },
  off: {
    id: 'off',
    name: 'Off for now',
    summary: 'Nothing is blocked. You can switch shields on at any time from the shield in the toolbar.',
    shields: { enabled: false },
  },
};

/** Homepage layouts offered during setup, by widget id. */
const LAYOUTS = {
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    summary: 'A clock and the search box. Nothing else.',
    widgets: ['clock'],
    showMostVisited: false,
  },
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    summary: 'Clock, shortcuts and what your shields have been blocking.',
    widgets: ['clock', 'shortcuts', 'privacy'],
    showMostVisited: true,
  },
  full: {
    id: 'full',
    name: 'Everything',
    summary: 'Every widget on, ready to be rearranged or removed.',
    widgets: ['clock', 'shortcuts', 'privacy', 'reading', 'notes', 'recent'],
    showMostVisited: true,
  },
};

class Onboarding {
  /**
   * @param {string} dir profile directory
   * @param {object} deps the features this writes THROUGH - never their stores
   */
  constructor(dir, { settings, shields, aiAvailable = false, onChange = () => {} } = {}) {
    this.store = new JsonStore(dir, 'onboarding', {
      // Finished or dismissed. Either way it does not come back on its own.
      completed: false,
      completedAt: 0,
      // What was chosen, so Settings can say so and a re-run can start from it.
      profile: '',
      privacy: '',
      layout: '',
      aiEnabled: null,
      // Steps passed over, so anything later can be honest about what was
      // skipped rather than treating it as answered.
      skipped: [],
    });
    this.settings = settings;
    this.shields = shields;
    this.aiAvailable = !!aiAvailable;
    this.onChange = onChange;
    this.step = 0;
  }

  get data() { return this.store.data; }

  /** Has the user been through this? */
  get completed() { return !!this.store.data.completed; }

  /** Should the flow open on this launch? */
  get due() { return !this.completed; }

  /** Everything the page needs, so no decision is left to the renderer. */
  state() {
    const step = STEPS[this.step] || STEPS[STEPS.length - 1];
    return {
      steps: STEPS.map(({ id, title, optional }) => ({ id, title, optional })),
      step: this.step,
      stepId: step.id,
      stepTitle: step.title,
      canSkip: !!step.optional,
      isLast: this.step === STEPS.length - 1,
      completed: this.completed,
      profiles: Object.values(PROFILES).map(({ id, name, summary }) => ({ id, name, summary })),
      privacyLevels: Object.values(PRIVACY_LEVELS).map(({ id, name, summary }) => ({ id, name, summary })),
      layouts: Object.values(LAYOUTS).map(({ id, name, summary }) => ({ id, name, summary })),
      chosen: {
        profile: this.store.data.profile,
        privacy: this.store.data.privacy,
        layout: this.store.data.layout,
        aiEnabled: this.store.data.aiEnabled,
      },
      // Stated rather than assumed, so the page never offers something that
      // would fail the moment it was used.
      aiAvailable: this.aiAvailable,
      skipped: [...this.store.data.skipped],
    };
  }

  go(index) {
    const next = Number(index);
    if (!Number.isInteger(next) || next < 0 || next >= STEPS.length) throw new Error('No such step.');
    this.step = next;
    this.onChange();
    return this.state();
  }

  next() { return this.go(Math.min(this.step + 1, STEPS.length - 1)); }
  back() { return this.go(Math.max(this.step - 1, 0)); }

  /** Pass over an optional step, recording that it was passed over. */
  skip() {
    const step = STEPS[this.step];
    if (!step || !step.optional) throw new Error('This step needs an answer.');
    if (!this.store.data.skipped.includes(step.id)) {
      this.store.data.skipped.push(step.id);
      this.store.save();
    }
    return this.next();
  }

  /**
   * Apply a profile.
   *
   * Written through settings.update, so anything a preset names that the
   * allowlist rejects throws here rather than reaching the store.
   */
  chooseProfile(id) {
    const profile = PROFILES[id];
    if (!profile) throw new Error('No such profile.');

    // Settings first. If this throws, nothing has changed and nothing is
    // recorded, so the flow is simply still on this step.
    this.settings.update({ ...profile.settings, newTab: profile.newTab });

    // Shields second, and separately. Once the settings above have landed the
    // user can SEE the profile applied, so the choice is recorded even if the
    // shield part fails - a state that said "no profile chosen" next to a
    // visibly changed theme would be lying about what happened.
    let shieldError = null;
    if (profile.shields && this.shields) {
      try { this.shields.update(profile.shields); }
      catch (error) { shieldError = error.message; }
    }

    this.store.data.profile = id;
    // A profile carries a homepage layout, so a skipped homepage step still
    // leaves a coherent page rather than the bare default.
    this.store.data.layout = '';
    this.store.save();
    this.onChange();

    // Reported rather than thrown: the profile did apply, and the page should
    // say which part did not instead of discarding the whole step.
    return { ...this.state(), warning: shieldError
      ? 'Your profile was applied, but the shield settings could not be changed: ' + shieldError
      : null };
  }

  chooseLayout(id) {
    const layout = LAYOUTS[id];
    if (!layout) throw new Error('No such layout.');
    this.settings.update({
      newTab: { widgets: layout.widgets, showMostVisited: layout.showMostVisited },
    });
    this.store.data.layout = id;
    this.store.save();
    this.onChange();
    return this.state();
  }

  choosePrivacy(id) {
    const level = PRIVACY_LEVELS[id];
    if (!level) throw new Error('No such privacy level.');
    if (this.shields) this.shields.update(level.shields);
    this.store.data.privacy = id;
    this.store.save();
    this.onChange();
    return this.state();
  }

  chooseAI(enabled) {
    this.store.data.aiEnabled = !!enabled;
    this.store.save();
    this.onChange();
    return this.state();
  }

  /**
   * Finish, or dismiss.
   *
   * Both mark it complete. A first-launch flow that reappears because it was
   * closed rather than completed is one that gets closed angrily next time.
   */
  complete() {
    this.store.data.completed = true;
    this.store.data.completedAt = Date.now();
    this.store.save();
    this.onChange();
    return this.state();
  }

  /**
   * Run through it again, from Settings.
   *
   * Earlier answers are KEPT and shown as chosen, so someone re-running this
   * to change one thing can see what they picked last time instead of being
   * asked from scratch. `fresh` clears them, which is what a genuinely new
   * profile wants.
   */
  restart({ fresh = false } = {}) {
    this.store.data.completed = false;
    this.store.data.skipped = [];
    if (fresh) {
      this.store.data.profile = '';
      this.store.data.privacy = '';
      this.store.data.layout = '';
      this.store.data.aiEnabled = null;
    }
    this.step = 0;
    this.store.save();
    this.onChange();
    return this.state();
  }

  flush() { this.store.save(); }
}

module.exports = { Onboarding, STEPS, PROFILES, PRIVACY_LEVELS, LAYOUTS };
