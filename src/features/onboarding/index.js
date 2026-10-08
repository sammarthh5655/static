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
 * WHY SO FEW STEPS
 * It used to ask eight screens of questions: a usage profile, a homepage
 * layout, a privacy level, the assistant. Someone opening a browser for the
 * first time has no basis for most of those, and every one already had a
 * sensible default - the everyday homepage, standard shields, the assistant
 * when it is available. So the flow now asks only what genuinely needs the
 * person: how it should look, and whether to bring their things from the
 * browser they used before - and that second question is only asked when
 * there IS such a browser on this computer. Everything else stays where it
 * always was, in Settings, and the last screen says so.
 */

/**
 * The steps, in order. `optional` steps can be passed over without a choice.
 * `when` names a condition the step needs; a step whose condition does not
 * hold is left out of the flow entirely rather than shown empty.
 */
const STEPS = [
  { id: 'welcome', title: 'Welcome to Static', optional: false },
  { id: 'theme', title: 'Choose a world', optional: true },
  { id: 'import', title: 'Bring your stuff', optional: true, when: 'canImport' },
  { id: 'done', title: 'You are set up', optional: false },
];

class Onboarding {
  /**
   * @param {string} dir profile directory
   * @param {object} deps the features this writes THROUGH - never their stores.
   *   `canImport` answers whether another browser with data is on this
   *   computer; it is a function because finding out reads the disk.
   */
  constructor(dir, { settings, canImport = () => false, onChange = () => {} } = {}) {
    this.store = new JsonStore(dir, 'onboarding', {
      // Finished or dismissed. Either way it does not come back on its own.
      completed: false,
      completedAt: 0,
      // What was chosen, so Settings can say so and a re-run can start from it.
      theme: '',
      // Steps passed over, so anything later can be honest about what was
      // skipped rather than treating it as answered.
      skipped: [],
    });
    this.settings = settings;
    this.canImport = canImport;
    this.onChange = onChange;
    this.step = 0;
    // Whether the import step is in this run of the flow. Decided once per
    // run, so the step list cannot shift under someone half-way through it.
    this.importable = null;
  }

  get data() { return this.store.data; }

  /** Has the user been through this? */
  get completed() { return !!this.store.data.completed; }

  /** Should the flow open on this launch? */
  get due() { return !this.completed; }

  /** The steps this run actually has. */
  steps() {
    if (this.importable === null) {
      // A detection failure (an unreadable folder, a permissions error) means
      // there is nothing we can import, not that setup cannot start.
      try { this.importable = !!this.canImport(); } catch { this.importable = false; }
    }
    return STEPS.filter((step) => step.when !== 'canImport' || this.importable);
  }

  /** Everything the page needs, so no decision is left to the renderer. */
  state() {
    const steps = this.steps();
    const step = steps[this.step] || steps[steps.length - 1];
    return {
      steps: steps.map(({ id, title, optional }) => ({ id, title, optional })),
      step: this.step,
      stepId: step.id,
      stepTitle: step.title,
      canSkip: !!step.optional,
      isLast: this.step === steps.length - 1,
      completed: this.completed,
      canImport: this.importable,
      chosen: { theme: this.store.data.theme },
      skipped: [...this.store.data.skipped],
    };
  }

  go(index) {
    const next = Number(index);
    if (!Number.isInteger(next) || next < 0 || next >= this.steps().length) throw new Error('No such step.');
    this.step = next;
    this.onChange();
    return this.state();
  }

  next() { return this.go(Math.min(this.step + 1, this.steps().length - 1)); }
  back() { return this.go(Math.max(this.step - 1, 0)); }

  /** Pass over an optional step, recording that it was passed over. */
  skip() {
    const step = this.steps()[this.step];
    if (!step || !step.optional) throw new Error('This step needs an answer.');
    if (!this.store.data.skipped.includes(step.id)) {
      this.store.data.skipped.push(step.id);
      this.store.save();
    }
    return this.next();
  }

  /**
   * Pick a planet.
   *
   * Written through settings.update like everything else, so a theme id the
   * settings allowlist rejects throws here rather than reaching the store.
   */
  chooseTheme(id) {
    this.settings.update({ theme: String(id || '') });
    this.store.data.theme = String(id || '');
    // Choosing answers the step, so an earlier skip of it no longer stands.
    this.store.data.skipped = this.store.data.skipped.filter((step) => step !== 'theme');
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
   * profile wants. Whether there is anything to import is asked again, since
   * a browser may have been installed since.
   */
  restart({ fresh = false } = {}) {
    this.store.data.completed = false;
    this.store.data.skipped = [];
    if (fresh) this.store.data.theme = '';
    this.step = 0;
    this.importable = null;
    this.store.save();
    this.onChange();
    return this.state();
  }

  flush() { this.store.save(); }
}

module.exports = { Onboarding, STEPS };
