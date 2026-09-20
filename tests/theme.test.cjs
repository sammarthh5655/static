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
