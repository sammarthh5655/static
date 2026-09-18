// Wrapped in an IIFE: these files are also loaded as plain <script> tags, and
// classic scripts share one global scope - two files with a top-level `const
// shared` would collide on any page that loads both.
(function () {
// Single source of truth for the visual language: colours, radius, blur,
// motion and the icon set. Both the chrome renderer and every browser:// page
// build their CSS variables from this, so a change here lands everywhere.
//
// This file is required by main (to validate settings) and loaded as a plain
// script by renderers, so it must stay free of Electron and Node imports.

const THEMES = {
  dark: {
    id: 'dark', name: 'Dark',
    tokens: {
      'bg': '#161718',
      'bg-raised': '#1e1f21',
      'bg-strip': '#101112',
      'surface': '#242628',
      'surface-hover': '#2e3033',
      'surface-active': '#383a3e',
      'text': '#e9eaec',
      'text-dim': '#9498a0',
      'text-faint': '#6b6f77',
      'border': '#303236',
      'border-soft': '#26282b',
      'accent': '#7aa2f7',
      'accent-dim': '#3d5a94',
      'danger': '#f7768e',
      'success': '#9ece6a',
      'warn': '#e0af68',
      'menu-bg': 'rgba(30, 31, 33, 0.82)',
      'menu-bg-solid': '#1e1f21',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.5)',
      'tab-active': '#242628',
      'field': '#202123',
    },
  },
  light: {
    id: 'light', name: 'Light',
    tokens: {
      'bg': '#f2f3f5',
      'bg-raised': '#ffffff',
      'bg-strip': '#e6e8ea',
      'surface': '#ffffff',
      'surface-hover': '#eceef1',
      'surface-active': '#e0e3e7',
      'text': '#1b1d21',
      'text-dim': '#5f636b',
      'text-faint': '#8b9098',
      'border': '#d6d9dd',
      'border-soft': '#e4e6e9',
      'accent': '#3b6fd4',
      'accent-dim': '#a8c0ec',
      'danger': '#d1435b',
      'success': '#3f8f3f',
      'warn': '#b4761c',
      'menu-bg': 'rgba(255, 255, 255, 0.78)',
      'menu-bg-solid': '#ffffff',
      'shadow': '0 10px 34px rgba(20, 22, 28, 0.18)',
      'tab-active': '#ffffff',
      'field': '#ffffff',
    },
  },
  midnight: {
    id: 'midnight', name: 'Midnight',
    tokens: {
      'bg': '#0f1117',
      'bg-raised': '#161923',
      'bg-strip': '#0a0c11',
      'surface': '#1b1f2b',
      'surface-hover': '#232838',
      'surface-active': '#2c3244',
      'text': '#e4e7f0',
      'text-dim': '#8d93a8',
      'text-faint': '#5f6478',
      'border': '#262b3a',
      'border-soft': '#1d2130',
      'accent': '#8c7cf0',
      'accent-dim': '#413a75',
      'danger': '#f2657a',
      'success': '#7fd88f',
      'warn': '#e2b164',
      'menu-bg': 'rgba(22, 25, 35, 0.8)',
      'menu-bg-solid': '#161923',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#1b1f2b',
      'field': '#161923',
    },
  },
};

/** Menu/dropdown background treatments, selectable in Settings. */
const SURFACE_STYLES = {
  frosted: { id: 'frosted', name: 'Frosted glass' },
  solid: { id: 'solid', name: 'Flat solid' },
  shadow: { id: 'shadow', name: 'Soft shadow' },
};

/** Corner radius presets. One variable drives every rounded element. */
const RADIUS = {
  sharp: { id: 'sharp', name: 'Sharp', value: 2 },
  subtle: { id: 'subtle', name: 'Subtle', value: 6 },
  rounded: { id: 'rounded', name: 'Rounded', value: 10 },
  pill: { id: 'pill', name: 'Soft', value: 14 },
};

/**
 * Icon set. Outline by default, filled on hover/active - both variants share
 * a 24x24 viewBox so they can be swapped without any layout shift.
 *
 * Stored as raw path data rather than markup so callers can build either an
 * <svg> element (chrome) or an inline string (pages) from the same source.
 */
const ICONS = {
  back: { outline: 'M15 18l-6-6 6-6', fill: null },
  forward: { outline: 'M9 18l6-6-6-6', fill: null },
  reload: { outline: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6', fill: null },
  close: { outline: 'M18 6L6 18M6 6l12 12', fill: null },
  home: {
    outline: 'M3 10.5L12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
    fill: 'M3 10.5L12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  },
  star: {
    outline: 'M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9z',
    fill: 'M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9z',
  },
  menu: { outline: 'M4 7h16M4 12h16M4 17h16', fill: null },
  plus: { outline: 'M12 5v14M5 12h14', fill: null },
  lock: {
    outline: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
    fill: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
  },
  warn: { outline: 'M12 3l9.5 17h-19zM12 9v5M12 17.5v.5', fill: null },
  gear: {
    outline: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.6 1.6 0 0 0 15 19.4a1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
    fill: null,
  },
  puzzle: {
    outline: 'M10 3h4v2.5a1.5 1.5 0 0 0 3 0V3h4v4h-2.5a1.5 1.5 0 0 0 0 3H21v4h-2.5a1.5 1.5 0 0 0 0 3H21v4h-4v-2.5a1.5 1.5 0 0 0-3 0V21h-4v-4H6.5a1.5 1.5 0 0 0 0-3H4v-4h2.5a1.5 1.5 0 0 0 0-3H4V3z',
    fill: null,
  },
  clock: { outline: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2', fill: null },
  download: { outline: 'M12 3v12M7 11l5 5 5-5M4 20h16', fill: null },
  bookmark: {
    outline: 'M6 3h12v18l-6-4.5L6 21z',
    fill: 'M6 3h12v18l-6-4.5L6 21z',
  },
  search: { outline: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', fill: null },
  window_minimize: { outline: 'M5 12h14', fill: null },
  window_maximize: { outline: 'M5 5h14v14H5z', fill: null },
  window_restore: { outline: 'M8 8V5h11v11h-3M5 8h11v11H5z', fill: null },
  window_close: { outline: 'M6 6l12 12M18 6L6 18', fill: null },
  grid: { outline: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', fill: null },
  sparkle: {
    outline: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z',
    fill: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z',
  },
  trash: { outline: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14', fill: null },
  check: { outline: 'M5 13l4 4L19 7', fill: null },
  chevron_right: { outline: 'M9 6l6 6-6 6', fill: null },
};

/** Motion timings. `enabled: false` in settings collapses these to zero. */
const MOTION = {
  fast: 120,
  base: 170,   // menu open/close - inside the 150-200ms brief
  slow: 240,
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

/**
 * Build the CSS custom properties for a given appearance configuration.
 * Returned as a plain object so callers can serialise it into a <style> block
 * or apply it directly to an element.
 */
function cssVariables(appearance = {}) {
  const theme = THEMES[appearance.theme] || THEMES.dark;
  const radius = RADIUS[appearance.radius] || RADIUS.rounded;
  const motionOn = appearance.animations !== false;

  const vars = {};
  for (const [key, value] of Object.entries(theme.tokens)) vars['--' + key] = value;

  vars['--radius'] = radius.value + 'px';
  vars['--radius-sm'] = Math.max(2, Math.round(radius.value * 0.6)) + 'px';
  vars['--radius-lg'] = Math.round(radius.value * 1.6) + 'px';

  vars['--motion-fast'] = (motionOn ? MOTION.fast : 0) + 'ms';
  vars['--motion-base'] = (motionOn ? MOTION.base : 0) + 'ms';
  vars['--motion-slow'] = (motionOn ? MOTION.slow : 0) + 'ms';
  vars['--ease'] = MOTION.ease;

  // Menu surface treatment. Frosted needs a translucent base plus backdrop
  // blur; the other two are opaque and differ only in elevation.
  const style = SURFACE_STYLES[appearance.surfaceStyle] ? appearance.surfaceStyle : 'frosted';
  if (style === 'frosted') {
    vars['--menu-surface'] = theme.tokens['menu-bg'];
    vars['--menu-blur'] = 'blur(18px) saturate(1.6)';
    vars['--menu-shadow'] = theme.tokens['shadow'];
  } else if (style === 'solid') {
    vars['--menu-surface'] = theme.tokens['menu-bg-solid'];
    vars['--menu-blur'] = 'none';
    vars['--menu-shadow'] = 'none';
  } else {
    vars['--menu-surface'] = theme.tokens['menu-bg-solid'];
    vars['--menu-blur'] = 'none';
    vars['--menu-shadow'] = theme.tokens['shadow'];
  }

  return vars;
}

/** Serialise `cssVariables` into a `:root { ... }` rule. */
function cssText(appearance) {
  const vars = cssVariables(appearance);
  const body = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return ':root {\n' + body + '\n}';
}

const shared = { THEMES, SURFACE_STYLES, RADIUS, ICONS, MOTION, cssVariables, cssText };

// Usable from both `require` (main) and a plain <script> tag (renderers).
if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.theme = shared;

})();
