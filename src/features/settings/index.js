const { JsonStore } = require('../../main/storage');
const { resolveInput } = require('../../shared/urls');
const { THEMES, SURFACE_STYLES, RADIUS, FONTS, ACCENTS, DENSITY,
        ALIGNMENTS, WIDGET_SPANS, normalizeHex } = require('../../shared/theme');
const { WIDGETS, BACKGROUNDS, DEFAULT_LAYOUT } = require('../../shared/widgets');

const DEFAULTS = {
  searchEngine: 'google',
  bookmarksBar: true,
  sidebarMode: 'on',
  homepage: 'browser://newtab',
  newTabBehavior: 'newtab',

  // Appearance. Every one of these feeds shared/theme.js#cssVariables, which
  // is the only place that turns them into actual CSS.
  theme: 'eclipse',
  surfaceStyle: 'frosted',
  radius: 'rounded',
  animations: true,
  font: 'system',
  fontSize: 13,
  density: 'comfortable',
  accent: 'default',
  accentCustom: '',

  // New tab page. `widgets` is an ordered list of widget ids - order here is
  // render order, so rearranging is just a reorder of this array.
  newTab: {
    widgets: [...DEFAULT_LAYOUT],
    showMostVisited: true,
    background: 'plain',
    backgroundValue: '',
    // Per-widget appearance overrides, keyed by widget id. Anything absent
    // falls through to the global theme - see theme.js#widgetVariables.
    widgetStyles: {},
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
    if (!FONTS[next.font]) next.font = DEFAULTS.font;
    if (!DENSITY[next.density]) next.density = DEFAULTS.density;
    if (!['on', 'autohide', 'off'].includes(next.sidebarMode)) next.sidebarMode = DEFAULTS.sidebarMode;
    if (!ACCENTS[next.accent]) next.accent = DEFAULTS.accent;
    next.fontSize = clampSize(next.fontSize, DEFAULTS.fontSize);
    next.accentCustom = normalizeHex(next.accentCustom) || '';
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
      widgetStyles: normaliseWidgetStyles(source.widgetStyles),
    };
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
    const next = { ...this.value };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'searchEngine' && ['google', 'brave'].includes(value)) next[key] = value;
      else if (key === 'bookmarksBar' && typeof value === 'boolean') next[key] = value;
      else if (key === 'sidebarMode' && ['on', 'autohide', 'off'].includes(value)) next[key] = value;
      else if (key === 'newTabBehavior' && ['newtab', 'homepage'].includes(value)) next[key] = value;
      else if (key === 'homepage' && typeof value === 'string' && value.length <= 16384) next[key] = resolveInput(value, next.searchEngine);
      else if (key === 'theme' && THEMES[value]) next[key] = value;
      else if (key === 'surfaceStyle' && SURFACE_STYLES[value]) next[key] = value;
      else if (key === 'radius' && RADIUS[value]) next[key] = value;
      else if (key === 'animations' && typeof value === 'boolean') next[key] = value;
      else if (key === 'font' && FONTS[value]) next[key] = value;
      else if (key === 'density' && DENSITY[value]) next[key] = value;
      else if (key === 'accent' && ACCENTS[value]) next[key] = value;
      else if (key === 'accentCustom') next[key] = normalizeHex(value) || '';
      else if (key === 'fontSize') next[key] = clampSize(value, DEFAULTS.fontSize);
      else if (key === 'newTab') next[key] = this.#normaliseNewTab({ ...next.newTab, ...value });
      else throw new Error('Invalid setting: ' + key);
    }
    this.store.save(next);
    this.value = next;
    return next;
  }

  reset(scope) {
    if (!['appearance', 'all'].includes(scope)) throw new Error('Invalid reset scope.');
    const defaults = structuredClone(DEFAULTS);
    if (scope === 'appearance') {
      return this.update(Object.fromEntries([
        'theme', 'surfaceStyle', 'radius', 'animations', 'font', 'fontSize',
        'density', 'accent', 'accentCustom', 'sidebarMode',
      ].map(key => [key, defaults[key]])));
    }
    // Reset only this preference store; other feature stores and the profile
    // (bookmarks, notes, history, passwords, extensions) remain untouched.
    this.value = this.#normalise(defaults);
    this.store.save(this.value);
    return this.value;
  }
}

/** Font sizes outside this range make the UI unusable. */
function clampSize(value, fallback) {
  const size = Number(value);
  if (!Number.isFinite(size)) return fallback;
  return Math.max(10, Math.min(22, Math.round(size * 2) / 2));
}

/**
 * Validate per-widget style overrides.
 *
 * These come from an internal page, which is still web content, so every
 * colour is parsed rather than trusted: an unparseable value is dropped, not
 * written through to CSS.
 */
function normaliseWidgetStyles(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, style] of Object.entries(raw)) {
    if (!WIDGETS[id] || !style || typeof style !== 'object') continue;
    const clean = {};
    for (const key of ['background', 'text', 'accent', 'border']) {
      const hex = normalizeHex(style[key]);
      if (hex) clean[key] = hex;
    }
    if (FONTS[style.font]) clean.font = style.font;
    if (RADIUS[style.radius]) clean.radius = style.radius;
    if (ALIGNMENTS[style.align]) clean.align = style.align;
    if (WIDGET_SPANS[style.span]) clean.span = style.span;
    if (style.fontSize !== undefined) {
      const size = Number(style.fontSize);
      if (Number.isFinite(size)) clean.fontSize = Math.max(10, Math.min(48, size));
    }
    if (style.opacity !== undefined) {
      const opacity = Number(style.opacity);
      if (Number.isFinite(opacity)) clean.opacity = Math.max(0.2, Math.min(1, opacity));
    }
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

module.exports = { Settings, DEFAULTS };
