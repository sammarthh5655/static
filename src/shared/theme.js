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

/**
 * Themes, as planets.
 *
 * Each planet is a complete palette taken from what the body actually looks
 * like - Mars is iron oxide, Neptune is methane blue, Saturn is pale ammonia
 * gold. They are deliberately LOW SATURATION: a planet photographed from space
 * is muted, and muted is what reads as elegant rather than as a neon developer
 * theme.
 *
 * Every planet must define the same token set. `cssVariables` reads these
 * directly, so a missing key would render as an invalid CSS value rather than
 * falling back - the shape is the contract, and a test holds it.
 *
 * `luminous: true` marks a light theme, so anything drawn on top (glass,
 * shadows, the starfield) can pick sensible contrast.
 */
const THEMES = {
  mercury: {
    id: 'mercury', name: 'Mercury', order: 1,
    blurb: 'Bare rock and iron. Quiet greys, close to the metal.',
    tokens: {
      'bg': '#131313',
      'bg-raised': '#1a1a1b',
      'bg-strip': '#0d0d0e',
      'surface': '#1f2021',
      'surface-hover': '#292a2c',
      'surface-active': '#333436',
      'text': '#eceded',
      'text-dim': '#9b9d9f',
      'text-faint': '#6d6f72',
      'border': '#2e2f31',
      'border-soft': '#242526',
      'accent': '#b9a78c',
      'accent-dim': '#4a4237',
      'accent-alt': '#8f8d84',
      'danger': '#e3707f',
      'success': '#8ec99b',
      'warn': '#d9b271',
      'menu-bg': 'rgba(26, 26, 27, 0.84)',
      'menu-bg-solid': '#1a1a1b',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.55)',
      'tab-active': '#1f2021',
      'field': '#1b1b1c',
    },
  },

  venus: {
    id: 'venus', name: 'Venus', order: 2, luminous: true,
    blurb: 'Sulphur cloud and haze. Warm gold over cream.',
    tokens: {
      'bg': '#f6f1e7',
      'bg-raised': '#fbf7f0',
      'bg-strip': '#ece5d7',
      'surface': '#ffffff',
      'surface-hover': '#f3ece0',
      'surface-active': '#e9dfcd',
      'text': '#2b2620',
      'text-dim': '#6d6355',
      'text-faint': '#948977',
      'border': '#ded3c0',
      'border-soft': '#ebe3d5',
      'accent': '#b8863b',
      'accent-dim': '#e6d3b0',
      'accent-alt': '#8a6b2f',
      'danger': '#c2453f',
      'success': '#4c7a4a',
      'warn': '#b07d15',
      'menu-bg': 'rgba(251, 247, 240, 0.9)',
      'menu-bg-solid': '#fbf7f0',
      'shadow': '0 10px 30px rgba(90, 74, 48, 0.16)',
      'tab-active': '#ffffff',
      'field': '#ffffff',
    },
  },

  earth: {
    id: 'earth', name: 'Earth', order: 3,
    blurb: 'Ocean and forest from orbit. Deep green over slate.',
    tokens: {
      'bg': '#0c1412',
      'bg-raised': '#111b18',
      'bg-strip': '#080f0d',
      'surface': '#16221e',
      'surface-hover': '#1d2e28',
      'surface-active': '#264038',
      'text': '#e8f0ec',
      'text-dim': '#94aba2',
      'text-faint': '#6a8077',
      'border': '#26362f',
      'border-soft': '#1a2823',
      'accent': '#4fc08a',
      'accent-dim': '#1b4433',
      'accent-alt': '#3fa7d6',
      'danger': '#ef7285',
      'success': '#68d79b',
      'warn': '#e0b465',
      'menu-bg': 'rgba(17, 27, 24, 0.84)',
      'menu-bg-solid': '#111b18',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.55)',
      'tab-active': '#16221e',
      'field': '#121d19',
    },
  },

  mars: {
    id: 'mars', name: 'Mars', order: 4,
    blurb: 'Iron oxide and dust. Warm rust on a dark plain.',
    tokens: {
      'bg': '#150f0d',
      'bg-raised': '#1d1512',
      'bg-strip': '#0f0a09',
      'surface': '#241a16',
      'surface-hover': '#31231d',
      'surface-active': '#412d24',
      'text': '#f2e8e3',
      'text-dim': '#b09a90',
      'text-faint': '#816d65',
      'border': '#3a2a23',
      'border-soft': '#2a1e19',
      'accent': '#e07a52',
      'accent-dim': '#5a2e1e',
      'accent-alt': '#c6553f',
      'danger': '#f06d72',
      'success': '#93c47d',
      'warn': '#e2a95c',
      'menu-bg': 'rgba(29, 21, 18, 0.85)',
      'menu-bg-solid': '#1d1512',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#241a16',
      'field': '#1f1714',
    },
  },

  jupiter: {
    id: 'jupiter', name: 'Jupiter', order: 5,
    blurb: 'Banded cloud and the great storm. Amber and cream.',
    tokens: {
      'bg': '#16120e',
      'bg-raised': '#1f1913',
      'bg-strip': '#100d0a',
      'surface': '#271f18',
      'surface-hover': '#342a20',
      'surface-active': '#44372a',
      'text': '#f5ede2',
      'text-dim': '#b6a48d',
      'text-faint': '#867763',
      'border': '#3b3025',
      'border-soft': '#2a221a',
      'accent': '#e3a857',
      'accent-dim': '#5c4426',
      'accent-alt': '#c9705a',
      'danger': '#ec6f78',
      'success': '#9cc47a',
      'warn': '#edbb62',
      'menu-bg': 'rgba(31, 25, 19, 0.85)',
      'menu-bg-solid': '#1f1913',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#271f18',
      'field': '#211a14',
    },
  },

  saturn: {
    id: 'saturn', name: 'Saturn', order: 6,
    blurb: 'Pale ammonia gold and the shadow of the rings.',
    tokens: {
      'bg': '#14120c',
      'bg-raised': '#1c1a12',
      'bg-strip': '#0e0d08',
      'surface': '#242117',
      'surface-hover': '#302c1f',
      'surface-active': '#3f3929',
      'text': '#f4efdf',
      'text-dim': '#b3aa8d',
      'text-faint': '#847c63',
      'border': '#383322',
      'border-soft': '#282518',
      'accent': '#d8c27a',
      'accent-dim': '#564d2c',
      'accent-alt': '#b09a58',
      'danger': '#e87484',
      'success': '#a3c583',
      'warn': '#e0be68',
      'menu-bg': 'rgba(28, 26, 18, 0.85)',
      'menu-bg-solid': '#1c1a12',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.58)',
      'tab-active': '#242117',
      'field': '#1e1c14',
    },
  },

  uranus: {
    id: 'uranus', name: 'Uranus', order: 7,
    blurb: 'Methane ice. Pale cyan, cold and even.',
    tokens: {
      'bg': '#0b1416',
      'bg-raised': '#101c1f',
      'bg-strip': '#070f11',
      'surface': '#152327',
      'surface-hover': '#1c3035',
      'surface-active': '#254147',
      'text': '#e6f2f3',
      'text-dim': '#92adb1',
      'text-faint': '#688186',
      'border': '#233639',
      'border-soft': '#18282b',
      'accent': '#71d3d8',
      'accent-dim': '#1f4a4d',
      'accent-alt': '#5aa9d6',
      'danger': '#ee7585',
      'success': '#6fd3a8',
      'warn': '#ddb771',
      'menu-bg': 'rgba(16, 28, 31, 0.84)',
      'menu-bg-solid': '#101c1f',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.55)',
      'tab-active': '#152327',
      'field': '#111e21',
    },
  },

  neptune: {
    id: 'neptune', name: 'Neptune', order: 8,
    blurb: 'Deep methane blue. The default, and the calmest.',
    tokens: {
      'bg': '#0a1018',
      'bg-raised': '#0f1722',
      'bg-strip': '#070b12',
      'surface': '#131e2c',
      'surface-hover': '#1a2a3d',
      'surface-active': '#233852',
      'text': '#e7eef7',
      'text-dim': '#93a6bd',
      'text-faint': '#697c94',
      'border': '#223047',
      'border-soft': '#182334',
      'accent': '#5aa7f0',
      'accent-dim': '#1c3c5f',
      'accent-alt': '#7d8ef2',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(15, 23, 34, 0.85)',
      'menu-bg-solid': '#0f1722',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#131e2c',
      'field': '#101a26',
    },
  },

  pluto: {
    id: 'pluto', name: 'Pluto', order: 9,
    blurb: 'Nitrogen ice at the edge. Dim violet and distant light.',
    tokens: {
      'bg': '#111016',
      'bg-raised': '#18161f',
      'bg-strip': '#0b0a0f',
      'surface': '#1f1c28',
      'surface-hover': '#292434',
      'surface-active': '#372f47',
      'text': '#ece9f2',
      'text-dim': '#a099b4',
      'text-faint': '#746d86',
      'border': '#2f2a3b',
      'border-soft': '#221e2c',
      'accent': '#a48ce0',
      'accent-dim': '#3f3459',
      'accent-alt': '#c08fc8',
      'danger': '#ee7490',
      'success': '#7fd0a6',
      'warn': '#deb46e',
      'menu-bg': 'rgba(24, 22, 31, 0.85)',
      'menu-bg-solid': '#18161f',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#1f1c28',
      'field': '#1a1822',
    },
  },

  sun: {
    id: 'sun', name: 'Sun', order: 10, luminous: true,
    blurb: 'Full daylight. The bright one.',
    tokens: {
      'bg': '#f7f8fa',
      'bg-raised': '#ffffff',
      'bg-strip': '#eceef2',
      'surface': '#ffffff',
      'surface-hover': '#f0f2f6',
      'surface-active': '#e3e7ee',
      'text': '#1b1f26',
      'text-dim': '#5d6572',
      'text-faint': '#8a93a1',
      'border': '#d8dde5',
      'border-soft': '#e7eaf0',
      'accent': '#c98a1e',
      'accent-dim': '#f2e0bd',
      'accent-alt': '#d9622f',
      'danger': '#c43d3d',
      'success': '#2f7d4f',
      'warn': '#b07d15',
      'menu-bg': 'rgba(255, 255, 255, 0.92)',
      'menu-bg-solid': '#ffffff',
      'shadow': '0 10px 30px rgba(27, 31, 38, 0.13)',
      'tab-active': '#ffffff',
      'field': '#ffffff',
    },
  },

  moon: {
    id: 'moon', name: 'Moon', order: 11,
    blurb: 'Regolith and shadow. Monochrome, no colour at all.',
    tokens: {
      'bg': '#0e0e0f',
      'bg-raised': '#151516',
      'bg-strip': '#090909',
      'surface': '#1b1b1d',
      'surface-hover': '#242426',
      'surface-active': '#2f2f32',
      'text': '#ededee',
      'text-dim': '#9a9a9d',
      'text-faint': '#6e6e72',
      'border': '#2a2a2d',
      'border-soft': '#1f1f21',
      'accent': '#c8c8cc',
      'accent-dim': '#45454a',
      'accent-alt': '#9a9aa0',
      'danger': '#d98a93',
      'success': '#a6bfa9',
      'warn': '#cbb48a',
      'menu-bg': 'rgba(21, 21, 22, 0.86)',
      'menu-bg-solid': '#151516',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#1b1b1d',
      'field': '#171718',
    },
  },
};

/** The planet a fresh profile starts on. */
const DEFAULT_THEME = 'neptune';

/**
 * Build a custom planet from one colour.
 *
 * The user picks an accent and a base darkness; every other token is derived
 * so a custom planet is as complete and as consistent as a built-in one. It is
 * NOT stored as a partial override - it is expanded into the full token set,
 * so nothing downstream has to know it was custom.
 */
function customPlanet(accentHex, { name = 'Custom', light = false } = {}) {
  const accent = normalizeHex(accentHex) || THEMES[DEFAULT_THEME].tokens.accent;
  // Mix toward black (or white) to build a family from the one colour, so the
  // surfaces carry a hint of the accent rather than being neutral grey.
  const base = light ? '#ffffff' : '#000000';
  const ink = light ? '#12141a' : '#ffffff';
  const mix = (amount) => mixHex(accent, base, amount);

  return {
    id: 'custom', name, order: 99, luminous: !!light, custom: true,
    blurb: 'Your own world.',
    tokens: {
      'bg': mix(light ? 0.05 : 0.94),
      'bg-raised': mix(light ? 0.02 : 0.9),
      'bg-strip': mix(light ? 0.09 : 0.96),
      'surface': mix(light ? 0.0 : 0.86),
      'surface-hover': mix(light ? 0.08 : 0.8),
      'surface-active': mix(light ? 0.14 : 0.72),
      'text': light ? ink : mixHex(ink, accent, 0.08),
      'text-dim': mixHex(ink, base, light ? 0.45 : 0.42),
      'text-faint': mixHex(ink, base, light ? 0.62 : 0.58),
      'border': mix(light ? 0.18 : 0.74),
      'border-soft': mix(light ? 0.1 : 0.82),
      'accent': accent,
      'accent-dim': mix(light ? 0.72 : 0.62),
      'accent-alt': mixHex(accent, light ? '#000000' : '#ffffff', 0.22),
      'danger': light ? '#c43d3d' : '#ef7285',
      'success': light ? '#2f7d4f' : '#68d79b',
      'warn': light ? '#b07d15' : '#e0b465',
      'menu-bg': mix(light ? 0.02 : 0.9),
      'menu-bg-solid': mix(light ? 0.02 : 0.9),
      'shadow': light ? '0 10px 30px rgba(20, 24, 32, 0.14)' : '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': mix(light ? 0.0 : 0.86),
      'field': mix(light ? 0.02 : 0.88),
    },
  };
}

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
  palette: { outline: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4C21 6 17 3 12 3ZM7 10h.01M10 6.5h.01M15 7h.01M18 10.5h.01', fill: null },
  content: { outline: 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5', fill: null },
  shield: { outline: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5', fill: null },
  sidebar: { outline: 'M3 4h18v16H3zM8 4v16', fill: null },
  code: { outline: 'M7 6l-5 6 5 6M17 6l5 6-5 6M14 3l-4 18', fill: null },
  help: { outline: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2M12 17h.01', fill: null },
  info: { outline: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7h.01', fill: null },
  key: { outline: 'M14 4a6 6 0 1 1-4 10l-7 7v-4l2-2v-3h3a6 6 0 0 1 6-8ZM16 8h.01', fill: null },
  accessibility: { outline: 'M12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4 9l8 2 8-2M12 11v5M8 22l4-6 4 6M8 10v6M16 10v6', fill: null },
  reset: { outline: 'M4 4v6h6M4 10a8 8 0 1 1 0 5', fill: null },
};

/**
 * Font choices. Only families that ship with the OS, so nothing is fetched at
 * runtime and there is no flash of unstyled text.
 */
const FONTS = {
  system: {
    id: 'system', name: 'System',
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  inter: {
    id: 'inter', name: 'Inter / Helvetica',
    stack: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  grotesk: {
    id: 'grotesk', name: 'Grotesk',
    stack: '"Segoe UI Variable Display", "Segoe UI", Verdana, sans-serif',
  },
  serif: {
    id: 'serif', name: 'Serif',
    stack: 'Georgia, "Times New Roman", "Noto Serif", serif',
  },
  rounded: {
    id: 'rounded', name: 'Rounded',
    stack: '"SF Pro Rounded", "Segoe UI", "Nunito", system-ui, sans-serif',
  },
  mono: {
    id: 'mono', name: 'Monospace',
    stack: '"Cascadia Code", "JetBrains Mono", Consolas, "SF Mono", monospace',
  },
};

/**
 * Accent presets. The accent drives focus rings, selected states and the AI
 * badge, so it is the one colour a user is most likely to want to change.
 * `custom` reads a hex value from settings instead of this table.
 */
const ACCENTS = {
  default: { id: 'default', name: 'Theme default', value: null },
  blue: { id: 'blue', name: 'Blue', value: '#5b8def' },
  violet: { id: 'violet', name: 'Violet', value: '#8c7cf0' },
  emerald: { id: 'emerald', name: 'Emerald', value: '#3fb984' },
  amber: { id: 'amber', name: 'Amber', value: '#e0a248' },
  rose: { id: 'rose', name: 'Rose', value: '#e56b8a' },
  cyan: { id: 'cyan', name: 'Cyan', value: '#38b2c4' },
  custom: { id: 'custom', name: 'Custom\u2026', value: null, custom: true },
};

/** UI density: scales font size and spacing together. */
const DENSITY = {
  compact: { id: 'compact', name: 'Compact', scale: 0.92 },
  comfortable: { id: 'comfortable', name: 'Comfortable', scale: 1 },
  spacious: { id: 'spacious', name: 'Spacious', scale: 1.1 },
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
  // A custom planet arrives as a full token map rather than an id, because it
  // does not live in THEMES. Anything unrecognised falls back to the default
  // planet: an undefined theme here would produce 'undefined' in real CSS.
  const theme = (appearance.customTheme && appearance.customTheme.tokens)
    ? appearance.customTheme
    : (THEMES[appearance.theme] || THEMES[DEFAULT_THEME]);
  const radius = RADIUS[appearance.radius] || RADIUS.rounded;
  const motionOn = appearance.animations !== false;

  const vars = {};
  for (const [key, value] of Object.entries(theme.tokens)) vars['--' + key] = value;

  // Shadows on a light planet must be softer and warmer than on a dark one;
  // a hardcoded rgba(0,0,0,.4) reads as dirt on a cream background. Pages use
  // --shadow-colour rather than picking their own black.
  vars['--shadow-colour'] = theme.luminous
    ? 'rgba(40, 34, 24, 0.14)'
    : 'rgba(0, 0, 0, 0.34)';
  vars['--shadow-colour-strong'] = theme.luminous
    ? 'rgba(40, 34, 24, 0.22)'
    : 'rgba(0, 0, 0, 0.5)';
  // Whether this planet is a light one, for anything that must branch in CSS.
  vars['--luminous'] = theme.luminous ? '1' : '0';

  vars['--radius'] = radius.value + 'px';
  vars['--radius-sm'] = Math.max(2, Math.round(radius.value * 0.6)) + 'px';
  vars['--radius-lg'] = Math.round(radius.value * 1.6) + 'px';

  // Typography and density. One scale drives both the base font size and the
  // spacing unit, so "compact" tightens the whole UI coherently.
  const font = FONTS[appearance.font] || FONTS.system;
  const density = DENSITY[appearance.density] || DENSITY.comfortable;
  const baseSize = Number(appearance.fontSize) || 13;
  vars['--font'] = font.stack;
  vars['--font-mono'] = FONTS.mono.stack;
  vars['--font-size'] = (baseSize * density.scale).toFixed(2) + 'px';
  vars['--density'] = String(density.scale);
  vars['--space'] = (4 * density.scale).toFixed(2) + 'px';

  // Accent override. `custom` takes a hex from settings; anything invalid
  // falls through to the theme's own accent rather than producing broken CSS.
  const accentChoice = ACCENTS[appearance.accent] ? appearance.accent : 'default';
  let accent = ACCENTS[accentChoice].value;
  if (accentChoice === 'custom') accent = normalizeHex(appearance.accentCustom);
  if (accent) {
    vars['--accent'] = accent;
    vars['--accent-dim'] = mixHex(accent, theme.tokens.bg, 0.62);
  }

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

/** #rgb or #rrggbb -> #rrggbb, or null when it is not a usable colour. */
function normalizeHex(value) {
  const text = String(value || '').trim();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return '#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3];
  const full = /^#?([0-9a-f]{6})$/i.exec(text);
  return full ? '#' + full[1].toLowerCase() : null;
}

/** Blend `hex` toward `toward` by `amount` (0 = hex, 1 = toward). */
function mixHex(hex, toward, amount) {
  const a = normalizeHex(hex);
  const b = normalizeHex(toward);
  if (!a || !b) return a || b || '#888888';
  const channel = (start, end) => {
    const value = Math.round(parseInt(start, 16) * (1 - amount) + parseInt(end, 16) * amount);
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
  };
  return '#' +
    channel(a.slice(1, 3), b.slice(1, 3)) +
    channel(a.slice(3, 5), b.slice(3, 5)) +
    channel(a.slice(5, 7), b.slice(5, 7));
}

/**
 * Per-widget appearance overrides.
 *
 * Every widget on the new tab page can override colour, font, size, alignment
 * and how many grid columns it spans. Anything the user has not set falls
 * through to the global theme, so an untouched widget always tracks the theme.
 *
 * Returned as CSS custom properties scoped to one widget element rather than
 * :root, which is what lets two widgets look different at the same time.
 *
 * @param {object} config one entry from settings.newTab.widgetStyles
 */
function widgetVariables(config = {}) {
  const vars = {};
  const background = normalizeHex(config.background);
  const text = normalizeHex(config.text);
  const accent = normalizeHex(config.accent);
  const border = normalizeHex(config.border);

  if (background) vars['--surface'] = background;
  if (text) vars['--text'] = text;
  if (accent) vars['--accent'] = accent;
  if (border) vars['--border-soft'] = border;

  if (FONTS[config.font]) vars['--font'] = FONTS[config.font].stack;
  if (config.fontSize) vars['--font-size'] = Number(config.fontSize).toFixed(2) + 'px';
  if (RADIUS[config.radius]) vars['--radius-lg'] = RADIUS[config.radius].value * 1.6 + 'px';
  if (config.opacity !== undefined && config.opacity !== null) {
    vars['--widget-opacity'] = String(Math.max(0.2, Math.min(1, Number(config.opacity) || 1)));
  }
  return vars;
}

/** Text alignment options for a widget. */
const ALIGNMENTS = {
  left: { id: 'left', name: 'Left' },
  center: { id: 'center', name: 'Centre' },
  right: { id: 'right', name: 'Right' },
};

/** How many columns of the new tab grid a widget occupies. */
const WIDGET_SPANS = {
  half: { id: 'half', name: 'Half width', columns: 1 },
  full: { id: 'full', name: 'Full width', columns: 2 },
};

/** Serialise `cssVariables` into a `:root { ... }` rule. */
function cssText(appearance) {
  const vars = cssVariables(appearance);
  const body = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return ':root {\n' + body + '\n}';
}

const shared = {
  THEMES, DEFAULT_THEME, customPlanet,
  SURFACE_STYLES, RADIUS, FONTS, ACCENTS, DENSITY, ALIGNMENTS, WIDGET_SPANS,
  ICONS, MOTION, cssVariables, cssText, widgetVariables, normalizeHex, mixHex,
};

// Usable from both `require` (main) and a plain <script> tag (renderers).
if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.theme = shared;

})();
