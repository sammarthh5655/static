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
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(80% 60% at 18% -6%, rgba(201,185,160,0.16), transparent 70%), linear-gradient(160deg, rgba(255,255,255,0.035), transparent 38%, rgba(0,0,0,0.28))',
    palette: { primary: '#c9b9a0', secondary: '#8a7f73', deep: '#3d3832' },
    tokens: {
      'bg': '#121110',
      'bg-raised': '#1a1917',
      'bg-strip': '#0c0b0a',
      'surface': '#201e1c',
      'surface-hover': '#2b2825',
      'surface-active': '#38342f',
      'text': '#efece7',
      'text-dim': '#a39c92',
      'text-faint': '#746d65',
      'border': '#332f2b',
      'border-soft': '#262320',
      'accent': '#c9b9a0',
      'accent-dim': '#4a4239',
      'accent-alt': '#9e8f7c',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(26, 25, 23, 0.86)',
      'menu-bg-solid': '#1a1917',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#201e1c',
      'field': '#1b1a18',
    },
  },

  venus: {
    id: 'venus', name: 'Venus', order: 2, luminous: true,
    blurb: 'Sulphur cloud and haze. Warm gold over cream.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(90% 70% at 72% -12%, rgba(217,154,63,0.26), transparent 70%), radial-gradient(70% 60% at 0% 105%, rgba(201,104,90,0.14), transparent 70%)',
    palette: { primary: '#d99a3f', secondary: '#c9685a', deep: '#8a5a22' },
    tokens: {
      'bg': '#faf4e8',
      'bg-raised': '#fffaf1',
      'bg-strip': '#f0e7d6',
      'surface': '#ffffff',
      'surface-hover': '#f6ecda',
      'surface-active': '#ecdcc2',
      'text': '#2e2519',
      'text-dim': '#6f6250',
      'text-faint': '#998b76',
      'border': '#e0d2ba',
      'border-soft': '#eee4d2',
      'accent': '#b5762a',
      'accent-dim': '#f0dcb8',
      'accent-alt': '#c2604f',
      'danger': '#c43d3d',
      'success': '#2f7d4f',
      'warn': '#b07d15',
      'menu-bg': 'rgba(255, 255, 255, 0.92)',
      'menu-bg-solid': '#fffaf1',
      'shadow': '0 10px 30px rgba(40, 34, 24, 0.14)',
      'tab-active': '#ffffff',
      'field': '#ffffff',
    },
  },

  earth: {
    id: 'earth', name: 'Earth', order: 3,
    blurb: 'Ocean and forest from orbit. Deep green over slate.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(70% 55% at 50% -8%, rgba(63,169,224,0.20), transparent 70%), radial-gradient(55% 42% at 88% 92%, rgba(79,192,138,0.16), transparent 72%), radial-gradient(40% 30% at 8% 70%, rgba(63,169,224,0.08), transparent 70%)',
    palette: { primary: '#3fa9e0', secondary: '#4fc08a', deep: '#0f3a4a' },
    tokens: {
      'bg': '#081318',
      'bg-raised': '#0d1d23',
      'bg-strip': '#050e12',
      'surface': '#11252d',
      'surface-hover': '#17323c',
      'surface-active': '#1f4652',
      'text': '#e6f2f5',
      'text-dim': '#8fb0ba',
      'text-faint': '#66838d',
      'border': '#1d3a44',
      'border-soft': '#142932',
      'accent': '#3fa9e0',
      'accent-dim': '#12415a',
      'accent-alt': '#4fc08a',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(13, 29, 35, 0.86)',
      'menu-bg-solid': '#0d1d23',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#11252d',
      'field': '#0e2028',
    },
  },

  mars: {
    id: 'mars', name: 'Mars', order: 4,
    blurb: 'Iron oxide and dust. Warm rust on a dark plain.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(95% 60% at 50% 112%, rgba(232,113,63,0.26), transparent 70%), radial-gradient(60% 40% at 8% -4%, rgba(212,86,107,0.12), transparent 70%)',
    palette: { primary: '#e8713f', secondary: '#d4566b', deep: '#5c2317' },
    tokens: {
      'bg': '#170e0b',
      'bg-raised': '#20140f',
      'bg-strip': '#100907',
      'surface': '#281812',
      'surface-hover': '#37221a',
      'surface-active': '#4a2d22',
      'text': '#f6e9e3',
      'text-dim': '#bb9a8d',
      'text-faint': '#8a6f64',
      'border': '#402720',
      'border-soft': '#2e1c16',
      'accent': '#e8713f',
      'accent-dim': '#5c2a1c',
      'accent-alt': '#d4566b',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(32, 20, 15, 0.86)',
      'menu-bg-solid': '#20140f',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#281812',
      'field': '#221510',
    },
  },

  jupiter: {
    id: 'jupiter', name: 'Jupiter', order: 5,
    blurb: 'Banded cloud and the great storm. Amber and cream.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(34% 26% at 72% 64%, rgba(200,95,74,0.20), transparent 70%), repeating-linear-gradient(174deg, rgba(232,180,92,0.055) 0 44px, rgba(200,95,74,0.045) 44px 78px, transparent 78px 132px)',
    palette: { primary: '#e8b45c', secondary: '#c85f4a', deep: '#5a3a1e' },
    tokens: {
      'bg': '#16110b',
      'bg-raised': '#1f1810',
      'bg-strip': '#100c07',
      'surface': '#281f14',
      'surface-hover': '#36291a',
      'surface-active': '#483724',
      'text': '#f8efe0',
      'text-dim': '#bda88a',
      'text-faint': '#8b7b61',
      'border': '#3e3122',
      'border-soft': '#2c2217',
      'accent': '#e8b45c',
      'accent-dim': '#5e4527',
      'accent-alt': '#c85f4a',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(31, 24, 16, 0.86)',
      'menu-bg-solid': '#1f1810',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#281f14',
      'field': '#221a11',
    },
  },

  saturn: {
    id: 'saturn', name: 'Saturn', order: 6,
    blurb: 'Pale ammonia gold and the shadow of the rings.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(ellipse 130% 34% at 50% 46%, transparent 56%, rgba(230,207,143,0.12) 58.5%, transparent 61.5%, rgba(159,184,196,0.09) 64.5%, transparent 68%), radial-gradient(60% 50% at 50% -6%, rgba(230,207,143,0.13), transparent 70%)',
    palette: { primary: '#e6cf8f', secondary: '#9fb8c4', deep: '#544620' },
    tokens: {
      'bg': '#141209',
      'bg-raised': '#1c190e',
      'bg-strip': '#0e0c06',
      'surface': '#242013',
      'surface-hover': '#312c1b',
      'surface-active': '#413a25',
      'text': '#f7f1de',
      'text-dim': '#bbb08d',
      'text-faint': '#8a8164',
      'border': '#3a3320',
      'border-soft': '#282316',
      'accent': '#e6cf8f',
      'accent-dim': '#544a28',
      'accent-alt': '#9fb8c4',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(28, 25, 14, 0.86)',
      'menu-bg-solid': '#1c190e',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#242013',
      'field': '#1e1b10',
    },
  },

  uranus: {
    id: 'uranus', name: 'Uranus', order: 7, luminous: true,
    blurb: 'An ice giant rolled on its side. Pale mint, frost and still air.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(80% 60% at 28% -12%, rgba(169,220,214,0.75), transparent 70%), radial-gradient(60% 50% at 104% 104%, rgba(111,159,180,0.22), transparent 70%)',
    palette: { primary: '#a9dcd6', secondary: '#6f9fb4', deep: '#2f5a61' },
    tokens: {
      'bg': '#e8f1ef',
      'bg-raised': '#f3f8f7',
      'bg-strip': '#dae8e5',
      'surface': '#fbfdfd',
      'surface-hover': '#e1ecea',
      'surface-active': '#d1e2df',
      'text': '#12292b',
      'text-dim': '#4f6b6d',
      'text-faint': '#7f9597',
      'border': '#c3d6d3',
      'border-soft': '#d6e5e2',
      'accent': '#227f7c',
      'accent-dim': '#c2e0dc',
      'accent-alt': '#4f7fa3',
      'danger': '#c2413f',
      'success': '#2d7d57',
      'warn': '#a26c0e',
      'menu-bg': 'rgba(243, 248, 247, 0.88)',
      'menu-bg-solid': '#f3f8f7',
      'shadow': '0 10px 30px rgba(18, 41, 43, 0.14)',
      'tab-active': '#fbfdfd',
      'field': '#fbfdfd',
    },
  },

  neptune: {
    id: 'neptune', name: 'Neptune', order: 8,
    blurb: 'Deep methane blue. The default, and the calmest.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(70% 55% at 50% -8%, rgba(77,144,240,0.18), transparent 70%), radial-gradient(28% 22% at 28% 62%, rgba(18,34,74,0.55), transparent 70%), radial-gradient(40% 30% at 92% 20%, rgba(139,124,240,0.10), transparent 70%)',
    palette: { primary: '#4d90f0', secondary: '#8b7cf0', deep: '#12224a' },
    tokens: {
      'bg': '#080d1a',
      'bg-raised': '#0d1426',
      'bg-strip': '#050813',
      'surface': '#111a31',
      'surface-hover': '#182443',
      'surface-active': '#21325c',
      'text': '#e6ecf9',
      'text-dim': '#8fa0c4',
      'text-faint': '#67779a',
      'border': '#1e2b4d',
      'border-soft': '#151f39',
      'accent': '#4d90f0',
      'accent-dim': '#1a3466',
      'accent-alt': '#8b7cf0',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(13, 20, 38, 0.86)',
      'menu-bg-solid': '#0d1426',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#111a31',
      'field': '#0e1628',
    },
  },

  pluto: {
    id: 'pluto', name: 'Pluto', order: 9,
    blurb: 'Nitrogen ice at the edge. Dim violet and distant light.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(34% 30% at 64% 60%, rgba(220,147,181,0.18), transparent 70%), radial-gradient(70% 55% at 26% -4%, rgba(180,140,232,0.14), transparent 70%)',
    palette: { primary: '#b48ce8', secondary: '#dc93b5', deep: '#3a2b52' },
    tokens: {
      'bg': '#100e16',
      'bg-raised': '#171420',
      'bg-strip': '#0a080e',
      'surface': '#1e1a2a',
      'surface-hover': '#292338',
      'surface-active': '#372e4c',
      'text': '#eee9f6',
      'text-dim': '#a79bbd',
      'text-faint': '#7a6f8f',
      'border': '#2e2740',
      'border-soft': '#221d30',
      'accent': '#b48ce8',
      'accent-dim': '#3f3160',
      'accent-alt': '#dc93b5',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(23, 20, 32, 0.86)',
      'menu-bg-solid': '#171420',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#1e1a2a',
      'field': '#1a1725',
    },
  },

  sun: {
    id: 'sun', name: 'Sun', order: 10, luminous: true,
    blurb: 'Full daylight. The bright one.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(60% 50% at 50% -16%, rgba(232,160,32,0.40), transparent 70%), radial-gradient(90% 60% at 50% 122%, rgba(226,98,44,0.14), transparent 70%)',
    palette: { primary: '#e8a020', secondary: '#e2622c', deep: '#9a5a08' },
    tokens: {
      'bg': '#fbfaf7',
      'bg-raised': '#ffffff',
      'bg-strip': '#f1efe9',
      'surface': '#ffffff',
      'surface-hover': '#f5f2ea',
      'surface-active': '#e9e4d8',
      'text': '#1f1c16',
      'text-dim': '#5f594c',
      'text-faint': '#8d8578',
      'border': '#e0dace',
      'border-soft': '#ede9df',
      'accent': '#c07c12',
      'accent-dim': '#f6e2b8',
      'accent-alt': '#d4582a',
      'danger': '#c43d3d',
      'success': '#2f7d4f',
      'warn': '#b07d15',
      'menu-bg': 'rgba(255, 255, 255, 0.92)',
      'menu-bg-solid': '#ffffff',
      'shadow': '0 10px 30px rgba(40, 34, 24, 0.14)',
      'tab-active': '#ffffff',
      'field': '#ffffff',
    },
  },

  moon: {
    id: 'moon', name: 'Moon', order: 11,
    blurb: 'Regolith and shadow. Monochrome, no colour at all.',
    // The page's backdrop: what makes this world recognisable at a glance.
    ambient: 'radial-gradient(7% 7% at 20% 30%, rgba(255,255,255,0.06), transparent 70%), radial-gradient(11% 11% at 78% 70%, rgba(255,255,255,0.045), transparent 70%), radial-gradient(5% 5% at 60% 18%, rgba(255,255,255,0.06), transparent 70%), radial-gradient(9% 9% at 36% 82%, rgba(0,0,0,0.25), transparent 70%), radial-gradient(70% 55% at 50% -8%, rgba(210,212,217,0.12), transparent 70%)',
    palette: { primary: '#d2d4d9', secondary: '#9aa0ab', deep: '#3a3d44' },
    tokens: {
      'bg': '#0d0e10',
      'bg-raised': '#141517',
      'bg-strip': '#08090a',
      'surface': '#1a1c1f',
      'surface-hover': '#242629',
      'surface-active': '#303338',
      'text': '#eeeff1',
      'text-dim': '#9ba0a8',
      'text-faint': '#6f747c',
      'border': '#292c30',
      'border-soft': '#1e2023',
      'accent': '#d2d4d9',
      'accent-dim': '#43464d',
      'accent-alt': '#9aa0ab',
      'danger': '#f0738b',
      'success': '#63d2a4',
      'warn': '#e4b968',
      'menu-bg': 'rgba(20, 21, 23, 0.86)',
      'menu-bg-solid': '#141517',
      'shadow': '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': '#1a1c1f',
      'field': '#161719',
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
      // `mix(n)` is n-of-the-way from the accent TOWARD the base. A light
      // world therefore needs HIGH amounts (almost all the way to white) and a
      // dark one equally high amounts toward black. They were inverted for
      // light, which made the background come out as the accent itself.
      'bg': mix(light ? 0.95 : 0.94),
      'bg-raised': mix(light ? 0.985 : 0.9),
      'bg-strip': mix(light ? 0.91 : 0.96),
      'surface': mix(light ? 1.0 : 0.86),
      'surface-hover': mix(light ? 0.92 : 0.8),
      'surface-active': mix(light ? 0.86 : 0.72),
      'text': light ? ink : mixHex(ink, accent, 0.08),
      'text-dim': mixHex(ink, base, light ? 0.45 : 0.42),
      'text-faint': mixHex(ink, base, light ? 0.62 : 0.58),
      'border': mix(light ? 0.82 : 0.74),
      'border-soft': mix(light ? 0.9 : 0.82),
      'accent': light ? mixHex(accent, '#000000', 0.28) : accent,
      // On a light world the accent must be darkened to stay readable on
      // near-white; on a dark one it is used as picked.
      'accent-dim': light ? mix(0.72) : mix(0.62),
      'accent-alt': mixHex(accent, light ? '#000000' : '#ffffff', 0.22),
      'danger': light ? '#c43d3d' : '#ef7285',
      'success': light ? '#2f7d4f' : '#68d79b',
      'warn': light ? '#b07d15' : '#e0b465',
      'menu-bg': mix(light ? 0.985 : 0.9),
      'menu-bg-solid': mix(light ? 0.985 : 0.9),
      'shadow': light ? '0 10px 30px rgba(20, 24, 32, 0.14)' : '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': mix(light ? 1.0 : 0.86),
      'field': mix(light ? 1.0 : 0.88),
    },
  };
}

/**
 * A planet the user made: a name, three colours for the body, an accent, how
 * much it glows, how see-through its surfaces are, and light or dark.
 *
 * The body colours are not decoration only: the deep colour tints every
 * surface of the browser, the secondary is the second accent, and the
 * backdrop is painted from all three - so two planets forged from different
 * colours are two different places, not one layout with a new highlight.
 */
function forgePlanet(def = {}) {
  const primary = normalizeHex(def.primary) || THEMES[DEFAULT_THEME].palette.primary;
  const secondary = normalizeHex(def.secondary) || mixHex(primary, '#ffffff', 0.25);
  const deep = normalizeHex(def.deep) || mixHex(primary, '#000000', 0.7);
  const accent = normalizeHex(def.accent) || primary;
  const light = !!def.light;
  const glow = Math.min(1, Math.max(0, Number(def.glow ?? 0.5)));
  const glass = Math.min(1, Math.max(0, Number(def.glass ?? 0.3)));
  const base = light ? '#ffffff' : '#000000';
  const ink = light ? '#12141a' : '#ffffff';
  // Surfaces come from the DEEP colour, pushed nearly to black or white.
  const tint = (amount) => mixHex(light ? primary : deep, base, amount);
  const rgba = (hex, alpha) => {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + alpha.toFixed(2) + ')';
  };
  const raised = tint(light ? 0.95 : 0.72);
  const readableAccent = light ? mixHex(accent, '#000000', 0.3) : accent;
  return {
    id: String(def.id || 'planet-custom'),
    name: String(def.name || 'Your planet'),
    order: 50,
    luminous: light,
    custom: true,
    blurb: 'Made by you.',
    palette: { primary, secondary, deep },
    glow,
    glass,
    ambient: 'radial-gradient(75% 58% at 50% -10%, ' + rgba(primary, (light ? 0.35 : 0.2) * (0.5 + glow)) + ', transparent 70%), ' +
      'radial-gradient(55% 45% at 90% 100%, ' + rgba(secondary, (light ? 0.2 : 0.13) * (0.5 + glow)) + ', transparent 72%), ' +
      'radial-gradient(45% 35% at 6% 80%, ' + rgba(deep, light ? 0.12 : 0.35) + ', transparent 70%)',
    tokens: {
      'bg': tint(light ? 0.93 : 0.86),
      'bg-raised': raised,
      'bg-strip': tint(light ? 0.88 : 0.9),
      'surface': tint(light ? 0.985 : 0.66),
      'surface-hover': tint(light ? 0.9 : 0.58),
      'surface-active': tint(light ? 0.84 : 0.5),
      'text': light ? ink : mixHex(ink, primary, 0.06),
      'text-dim': mixHex(ink, base, light ? 0.45 : 0.4),
      'text-faint': mixHex(ink, base, light ? 0.62 : 0.58),
      'border': tint(light ? 0.8 : 0.52),
      'border-soft': tint(light ? 0.88 : 0.62),
      'accent': readableAccent,
      'accent-dim': mixHex(readableAccent, light ? '#ffffff' : '#000000', 0.62),
      'accent-alt': light ? mixHex(secondary, '#000000', 0.25) : secondary,
      'danger': light ? '#c43d3d' : '#ef7285',
      'success': light ? '#2f7d4f' : '#68d79b',
      'warn': light ? '#b07d15' : '#e0b465',
      // Glass: how much of what is behind a menu shows through it.
      'menu-bg': rgba(raised, 1 - glass * 0.55),
      'menu-bg-solid': raised,
      'shadow': light ? '0 10px 30px rgba(20, 24, 32, 0.14)' : '0 10px 34px rgba(0, 0, 0, 0.6)',
      'tab-active': tint(light ? 0.985 : 0.66),
      'field': tint(light ? 0.985 : 0.76),
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
  user: { outline: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0', fill: null },
  tabs: { outline: 'M3 8h18v12H3ZM3 8l2-4h6l2 4', fill: null },
  split: { outline: 'M3 4h18v16H3ZM12 4v16', fill: null },
  import: { outline: 'M12 3v12M7 10l5 5 5-5M4 21h16', fill: null },
  doc: { outline: 'M6 3h9l4 4v14H6ZM14 3v5h5M9 13h7M9 17h7', fill: null },
  chat: { outline: 'M4 5h16v11H9l-5 4Z', fill: null },
  image: { outline: 'M3 5h18v14H3ZM3 16l5-5 4 4 3-3 6 6M15 9h.01', fill: null },
  heart: { outline: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z', fill: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z' },
  shuffle: { outline: 'M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3', fill: null },
  // Profile avatars (features/profiles AVATARS). Every id there must exist here.
  planet: { outline: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM6.5 14.5C3 16.5 2 18 3.5 18.5c2 .6 7.5-1.3 12-4.3S21.8 7.6 20.5 7c-.8-.4-2.3 0-4 .8', fill: null },
  moon: { outline: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z', fill: null },
  comet: { outline: 'M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM13.5 10.5 4 20M11 8l-6 6M16 13l-6 6', fill: null },
  orbit: { outline: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM3 12a9 4 0 1 0 18 0 9 4 0 1 0-18 0', fill: null },
  rocket: { outline: 'M12 2c3 2 5 6 5 10l-2 4H9l-2-4c0-4 2-8 5-10ZM12 9h.01M9 16l-3 3M15 16l3 3M10 20h4', fill: null },
  leaf: { outline: 'M5 19C5 10 10 5 20 4c0 10-5 15-14 15ZM5 19l8-8', fill: null },
  flame: { outline: 'M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8a7 7 0 0 0 7 7Z', fill: null },
  wave: { outline: 'M2 10c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-3 5-2M2 16c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-3 5-2', fill: null },
  peak: { outline: 'M3 20l6-10 4 6 3-4 5 8Z', fill: null },
  incognito: { outline: 'M3 11h18M6 11l2-6h8l2 6M7 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10 17h4', fill: null },
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
  // A forged world is stored as the colour the user picked, not as expanded
  // tokens, so it is rebuilt here every time - which means a later improvement
  // to how worlds are built reaches worlds that already exist.
  const made = typeof appearance.theme === 'string' && appearance.theme.startsWith('planet-') &&
    Array.isArray(appearance.customPlanets)
    ? appearance.customPlanets.find((planet) => planet && planet.id === appearance.theme)
    : null;
  const forged = made
    ? forgePlanet(made)
    : appearance.theme === 'custom' && appearance.customColour
      ? customPlanet(appearance.customColour, { light: !!appearance.customLight })
      : null;

  const theme = forged
    || (appearance.customTheme && appearance.customTheme.tokens ? appearance.customTheme : null)
    || THEMES[appearance.theme]
    || THEMES[DEFAULT_THEME];
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
  // The planet's own backdrop, and how strongly its surfaces glow and let the
  // page show through. Built-in planets glow a little and are fairly solid.
  vars['--ambient'] = theme.ambient ||
    'radial-gradient(70% 55% at 50% -8%, color-mix(in srgb, ' + theme.tokens.accent + ' 13%, transparent), transparent 70%)';
  const glow = typeof theme.glow === 'number' ? theme.glow : 0.35;
  const glass = typeof theme.glass === 'number' ? theme.glass : 0.25;
  vars['--planet-glow'] = glow > 0.05
    ? '0 0 ' + Math.round(8 + glow * 28) + 'px color-mix(in srgb, ' + theme.tokens.accent + ' ' + Math.round(glow * 45) + '%, transparent)'
    : 'none';
  vars['--glass-pct'] = Math.round(92 - glass * 55) + '%';

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
  THEMES, DEFAULT_THEME, customPlanet, forgePlanet,
  SURFACE_STYLES, RADIUS, FONTS, ACCENTS, DENSITY, ALIGNMENTS, WIDGET_SPANS,
  ICONS, MOTION, cssVariables, cssText, widgetVariables, normalizeHex, mixHex,
};

// Usable from both `require` (main) and a plain <script> tag (renderers).
if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.theme = shared;

})();
