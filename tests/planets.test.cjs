const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { THEMES, forgePlanet, cssVariables } = require('../src/shared/theme');
const { Settings } = require('../src/features/settings');

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('every planet has a backdrop of its own', () => {
  const seen = new Set();
  for (const planet of Object.values(THEMES)) {
    assert.ok(planet.ambient, planet.id + ' has a backdrop');
    assert.ok(!seen.has(planet.ambient), planet.id + ' backdrop is not shared');
    seen.add(planet.ambient);
  }
});

test('Uranus is an icy light world now, not cyan on dark teal', () => {
  assert.equal(THEMES.uranus.luminous, true);
  assert.ok(luminance(THEMES.uranus.tokens.bg) > 0.8);
});

test('text is readable on every planet', () => {
  for (const planet of Object.values(THEMES)) {
    assert.ok(contrast(planet.tokens.text, planet.tokens.bg) >= 7, planet.id + ' body text');
    assert.ok(contrast(planet.tokens.accent, planet.tokens.bg) >= 3, planet.id + ' accent');
  }
});

test('a forged planet is a whole world, readable, dark or light', () => {
  for (const light of [false, true]) {
    const planet = forgePlanet({ id: 'planet-test', name: 'Test', primary: '#e05a8a', secondary: '#5ad8c0', deep: '#1a2a44', light, glow: 0.8, glass: 0.6 });
    assert.equal(planet.luminous, light);
    assert.deepEqual(Object.keys(planet.tokens).sort(), Object.keys(THEMES.neptune.tokens).sort());
    assert.ok(contrast(planet.tokens.text, planet.tokens.bg) >= 7, 'text, light=' + light);
    assert.ok(contrast(planet.tokens.accent, planet.tokens.bg) >= 2.5, 'accent, light=' + light);
    assert.match(planet.tokens['menu-bg'], /^rgba\(/, 'glass makes menus see-through');
  }
});

test('two forged planets from different colours are different places', () => {
  const a = forgePlanet({ primary: '#e05a3a', deep: '#3a1208' });
  const b = forgePlanet({ primary: '#3a8ae0', deep: '#081a3a' });
  assert.notEqual(a.tokens.bg, b.tokens.bg);
  assert.notEqual(a.tokens.surface, b.tokens.surface);
  assert.notEqual(a.ambient, b.ambient);
});

test('the browser wears a planet the user made, by id', () => {
  const vars = cssVariables({ theme: 'planet-aurelia', customPlanets: [{ id: 'planet-aurelia', name: 'Aurelia', primary: '#d4a24a', deep: '#2a1a08' }] });
  assert.equal(vars['--accent'], '#d4a24a');
  assert.notEqual(vars['--bg'], THEMES.neptune.tokens.bg);
});

test('settings name, clean and cap user planets, and fall back when one is deleted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-planets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new Settings(dir);
  const next = settings.update({ customPlanets: [
    { name: 'Aurelia', primary: '#d4a24a', glow: 9, glass: -1, wallpaper: 'nope' },
    { name: 'Aurelia', primary: '#123456' },
    { name: '', primary: '#123456' },
    { name: 'No colour' },
  ] });
  assert.deepEqual(next.customPlanets.map((p) => p.id), ['planet-aurelia', 'planet-aurelia-2']);
  assert.equal(next.customPlanets[0].glow, 1);
  assert.equal(next.customPlanets[0].glass, 0);
  assert.equal(next.customPlanets[0].wallpaper, '');
  settings.update({ theme: 'planet-aurelia' });
  assert.equal(settings.value.theme, 'planet-aurelia');
  settings.update({ customPlanets: [] });
  assert.equal(settings.value.theme, 'neptune', 'deleting the worn planet falls back');
  assert.deepEqual(settings.update({ customPlanets: 'x' }).customPlanets, [], 'anything but a list is no planets');
});
