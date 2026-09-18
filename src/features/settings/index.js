const { JsonStore } = require('../../main/storage');
const { resolveInput } = require('../../shared/urls');
const { THEMES, SURFACE_STYLES, RADIUS } = require('../../shared/theme');
const { WIDGETS, BACKGROUNDS, DEFAULT_LAYOUT } = require('../../shared/widgets');

const DEFAULTS = {
  searchEngine: 'google',
  bookmarksBar: true,
  homepage: 'browser://newtab',
  newTabBehavior: 'newtab',

  // Appearance. Every one of these feeds shared/theme.js#cssVariables, which
  // is the only place that turns them into actual CSS.
  theme: 'dark',
  surfaceStyle: 'frosted',
  radius: 'rounded',
  animations: true,

  // New tab page. `widgets` is an ordered list of widget ids - order here is
  // render order, so rearranging is just a reorder of this array.
  newTab: {
    widgets: [...DEFAULT_LAYOUT],
    showMostVisited: true,
    background: 'plain',
    backgroundValue: '',
  },
};

/**
 * Validated preferences.
 *
 * Every key is checked against an explicit allowlist: an internal page is
 * still web content, so `settings:update` must never be able to write an
 * arbitrary key or an out-of-range value into the store.
 */
class Settings {
  constructor(dir) {
    this.store = new JsonStore(dir, 'settings', DEFAULTS);
    this.value = this.#normalise({ ...DEFAULTS, ...this.store.data });
  }

  /** Repair anything stale or malformed loaded from disk. */
  #normalise(value) {
    const next = { ...DEFAULTS, ...value };
    if (!THEMES[next.theme]) next.theme = DEFAULTS.theme;
    if (!SURFACE_STYLES[next.surfaceStyle]) next.surfaceStyle = DEFAULTS.surfaceStyle;
    if (!RADIUS[next.radius]) next.radius = DEFAULTS.radius;
    if (typeof next.animations !== 'boolean') next.animations = DEFAULTS.animations;
    next.newTab = this.#normaliseNewTab(next.newTab);
    return next;
  }

  #normaliseNewTab(config) {
    const source = config && typeof config === 'object' ? config : {};
    // Drop unknown widget ids (e.g. a widget removed in a later version) and
    // de-duplicate, so a corrupt file cannot render the page unusable.
    const seen = new Set();
    const widgets = (Array.isArray(source.widgets) ? source.widgets : DEFAULT_LAYOUT)
      .filter(id => WIDGETS[id] && !seen.has(id) && seen.add(id));
    return {
      widgets,
      showMostVisited: typeof source.showMostVisited === 'boolean'
        ? source.showMostVisited : DEFAULTS.newTab.showMostVisited,
      background: BACKGROUNDS[source.background] ? source.background : DEFAULTS.newTab.background,
      backgroundValue: typeof source.backgroundValue === 'string'
        ? source.backgroundValue.slice(0, 2048) : '',
    };
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
    const next = { ...this.value };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'searchEngine' && ['google', 'brave'].includes(value)) next[key] = value;
      else if (key === 'bookmarksBar' && typeof value === 'boolean') next[key] = value;
      else if (key === 'newTabBehavior' && ['newtab', 'homepage'].includes(value)) next[key] = value;
      else if (key === 'homepage' && typeof value === 'string' && value.length <= 16384) next[key] = resolveInput(value, next.searchEngine);
      else if (key === 'theme' && THEMES[value]) next[key] = value;
      else if (key === 'surfaceStyle' && SURFACE_STYLES[value]) next[key] = value;
      else if (key === 'radius' && RADIUS[value]) next[key] = value;
      else if (key === 'animations' && typeof value === 'boolean') next[key] = value;
      else if (key === 'newTab') next[key] = this.#normaliseNewTab({ ...next.newTab, ...value });
      else throw new Error('Invalid setting: ' + key);
    }
    this.store.save(next);
    this.value = next;
    return next;
  }
}

module.exports = { Settings, DEFAULTS };
