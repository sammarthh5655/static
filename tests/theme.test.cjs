const test = require('node:test');
const assert = require('node:assert/strict');
const { THEMES, DEFAULT_THEME, customPlanet, cssVariables, normalizeHex } = require('../src/shared/theme');

/**
 * Themes are planets. Every one must be COMPLETE: cssVariables reads the token
 * map directly, so a planet missing a key renders an invalid CSS value rather
 * than falling back to anything. The shape is the contract.
 */

const EXPECTED = Object.keys(THEMES[DEFAULT_THEME].tokens).sort();

test('the default planet exists', () => {
  assert.ok(THEMES[DEFAULT_THEME], DEFAULT_THEME + ' is a real planet');
});

test('every planet defines exactly the same tokens', () => {
  for (const [id, planet] of Object.entries(THEMES)) {
    assert.deepEqual(Object.keys(planet.tokens).sort(), EXPECTED,
      id + ' has the full token set and nothing extra');
  }
});

test('every planet has a name and says what it looks like', () => {
  for (const [id, planet] of Object.entries(THEMES)) {
    assert.equal(planet.id, id, id + ' id matches its key');
    assert.ok(planet.name, id + ' has a name');
    assert.ok(planet.blurb && planet.blurb.length > 15, id + ' describes itself');
    assert.equal(typeof planet.order, 'number', id + ' has a sort order');
  }
});

test('planets are ordered outward from the sun, with no duplicate positions', () => {
  const orders = Object.values(THEMES).map((planet) => planet.order);
  assert.equal(new Set(orders).size, orders.length, 'no two planets share an order');
});

test('every colour token is a real colour', () => {
  // shadow and the two menu backgrounds are deliberately not plain hex.
  const notHex = new Set(['shadow', 'menu-bg']);
  for (const [id, planet] of Object.entries(THEMES)) {
    for (const [key, value] of Object.entries(planet.tokens)) {
      if (notHex.has(key)) {
        assert.match(value, /^(rgba?\(|0 )/, id + '.' + key + ' is a colour or shadow');
        continue;
      }
      assert.ok(normalizeHex(value), id + '.' + key + ' = ' + value + ' is a valid hex colour');
    }
  }
});

test('every planet declares a three-colour identity', () => {
  // The picker renders these rather than a name in a dropdown, so a planet
  // without them would be a blank card.
  for (const [id, planet] of Object.entries(THEMES)) {
    assert.ok(planet.palette, id + ' has a palette');
    for (const key of ['primary', 'secondary', 'deep']) {
      assert.ok(normalizeHex(planet.palette[key]),
        id + '.' + key + ' = ' + planet.palette[key] + ' is a real colour');
    }
  }
});

test('no two planets look the same', () => {
  // Two planets that read identically make the picker pointless.
  const seen = new Map();
  for (const [id, planet] of Object.entries(THEMES)) {
    const key = planet.palette.primary.toLowerCase();
    assert.ok(!seen.has(key), id + ' and ' + seen.get(key) + ' share a primary colour');
    seen.set(key, id);
  }
});

test('a planet primary is distinct enough from every other', () => {
  const rgb = (hex) => {
    const n = parseInt(normalizeHex(hex).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const entries = Object.entries(THEMES);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      const one = rgb(a.palette.primary);
      const two = rgb(b.palette.primary);
      const distance = Math.hypot(one[0] - two[0], one[1] - two[1], one[2] - two[2]);
      assert.ok(distance > 28,
        idA + ' and ' + idB + ' are too close to tell apart (' + Math.round(distance) + ')');
    }
  }
});

test('the three colours of a planet differ from each other', () => {
  for (const [id, planet] of Object.entries(THEMES)) {
    const { primary, secondary, deep } = planet.palette;
    assert.notEqual(primary.toLowerCase(), secondary.toLowerCase(), id + ' primary vs secondary');
    assert.notEqual(secondary.toLowerCase(), deep.toLowerCase(), id + ' secondary vs deep');
    assert.notEqual(primary.toLowerCase(), deep.toLowerCase(), id + ' primary vs deep');
  }
});

test('light planets are marked, dark ones are not', () => {
  // Someone drawing glass or a shadow on top needs to know which way to go.
  assert.equal(THEMES.sun.luminous, true, 'the Sun is a light theme');
  assert.equal(THEMES.venus.luminous, true, 'Venus is a light theme');
  assert.ok(!THEMES.neptune.luminous, 'Neptune is dark');
  assert.ok(!THEMES.moon.luminous, 'the Moon is dark');
});

test('a dark planet is actually dark and a light one actually light', () => {
  const luminance = (hex) => {
    const n = parseInt(normalizeHex(hex).slice(1), 16);
    // Rough perceptual weighting; exact values do not matter, the side does.
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  for (const [id, planet] of Object.entries(THEMES)) {
    const bg = luminance(planet.tokens.bg);
    const text = luminance(planet.tokens.text);
    if (planet.luminous) {
      assert.ok(bg > 0.7, id + ' light background is light (' + bg.toFixed(2) + ')');
      assert.ok(text < 0.4, id + ' light theme has dark text');
    } else {
      assert.ok(bg < 0.25, id + ' dark background is dark (' + bg.toFixed(2) + ')');
      assert.ok(text > 0.6, id + ' dark theme has light text');
    }
    // Whatever the direction, text and background must not converge.
    assert.ok(Math.abs(text - bg) > 0.45, id + ' has real contrast between text and background');
  }
});

test('a custom planet is expanded to a complete palette, not a partial override', () => {
  const planet = customPlanet('#ff5533');
  assert.deepEqual(Object.keys(planet.tokens).sort(), EXPECTED,
    'a custom planet is as complete as a built-in one');
  assert.equal(planet.tokens.accent, '#ff5533', 'it keeps the colour it was given');
  assert.equal(planet.custom, true);
});

test('a custom planet can be light or dark', () => {
  const dark = customPlanet('#5aa7f0');
  const light = customPlanet('#5aa7f0', { light: true });
  assert.ok(!dark.luminous);
  assert.equal(light.luminous, true);
  assert.notEqual(dark.tokens.bg, light.tokens.bg, 'the two differ');
});

test('a forged world is actually light when light is asked for', () => {
  // The mix amounts were inverted for light worlds, which produced a
  // background that WAS the accent - unreadable, and it looked like the
  // toggle did nothing.
  const luminance = (hex) => {
    const n = parseInt(normalizeHex(hex).slice(1), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  for (const colour of ['#e8713f', '#4d90f0', '#63d2a4', '#b48ce8']) {
    const light = customPlanet(colour, { light: true });
    const dark = customPlanet(colour);

    assert.ok(luminance(light.tokens.bg) > 0.85,
      colour + ' light background is light (' + luminance(light.tokens.bg).toFixed(2) + ')');
    assert.ok(luminance(light.tokens.text) < 0.3, colour + ' light text is dark');
    assert.ok(luminance(dark.tokens.bg) < 0.2,
      colour + ' dark background is dark (' + luminance(dark.tokens.bg).toFixed(2) + ')');
    assert.ok(luminance(dark.tokens.text) > 0.7, colour + ' dark text is light');

    // Whatever the direction, it has to be readable.
    assert.ok(Math.abs(luminance(light.tokens.text) - luminance(light.tokens.bg)) > 0.5,
      colour + ' light world has real contrast');
    assert.ok(Math.abs(luminance(dark.tokens.text) - luminance(dark.tokens.bg)) > 0.5,
      colour + ' dark world has real contrast');
  }
});

test('a forged world keeps its accent readable against its own background', () => {
  const luminance = (hex) => {
    const n = parseInt(normalizeHex(hex).slice(1), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  // A bright accent on near-white is unreadable, so a light world darkens it.
  const light = customPlanet('#ffe14d', { light: true });
  assert.ok(luminance(light.tokens.accent) < luminance(light.tokens.bg) - 0.2,
    'the accent is darker than the background it sits on');
});

test('a forged world is rebuilt from its colour, not stored expanded', () => {
  // Storing the input rather than the tokens means a later improvement to how
  // worlds are built reaches worlds that already exist.
  const one = cssVariables({ theme: 'custom', customColour: '#4d90f0' });
  const two = cssVariables({ theme: 'custom', customColour: '#4d90f0' });
  assert.deepEqual(one, two, 'the same input always builds the same world');
  const other = cssVariables({ theme: 'custom', customColour: '#e8713f' });
  assert.notEqual(one['--bg'], other['--bg'], 'a different colour builds a different world');
});

test('custom with no colour falls back rather than producing nothing', () => {
  const vars = cssVariables({ theme: 'custom' });
  assert.ok(normalizeHex(vars['--bg']), 'still a real background');
  assert.equal(vars['--bg'], cssVariables({ theme: DEFAULT_THEME })['--bg'],
    'it falls back to the default planet');
});

test('a custom planet built from junk still produces a usable palette', () => {
  // The colour comes from a picker in a renderer, which is web content.
  for (const input of ['', null, undefined, 'not a colour', '#xyz', '#12', {}, []]) {
    const planet = customPlanet(input);
    assert.deepEqual(Object.keys(planet.tokens).sort(), EXPECTED,
      'complete even for input ' + JSON.stringify(input));
    assert.ok(normalizeHex(planet.tokens.accent), 'falls back to a real accent');
  }
});

test('cssVariables builds a full variable set for every planet', () => {
  for (const id of Object.keys(THEMES)) {
    const vars = cssVariables({ theme: id });
    assert.ok(vars['--bg'], id + ' produced a background');
    assert.ok(vars['--text'], id + ' produced a text colour');
    assert.ok(vars['--accent'], id + ' produced an accent');
    for (const [key, value] of Object.entries(vars)) {
      assert.ok(value !== undefined && value !== 'undefined' && value !== '',
        id + ' ' + key + ' is not empty or undefined');
    }
  }
});

test('an unknown theme id falls back rather than producing broken CSS', () => {
  const vars = cssVariables({ theme: 'not-a-planet' });
  assert.ok(normalizeHex(vars['--bg']), 'still a real background');
  assert.ok(normalizeHex(vars['--text']), 'still a real text colour');
});
