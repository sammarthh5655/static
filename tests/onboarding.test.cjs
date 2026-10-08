const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Onboarding, STEPS } = require('../src/features/onboarding');
const { Settings } = require('../src/features/settings');

/**
 * Onboarding owns no settings of its own: every choice is written through the
 * same validated path the settings page uses. These tests hold it to that, to
 * asking only what needs asking, and to not blocking the browser.
 */

function fixture(t, { canImport = () => false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-onboarding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const settings = new Settings(dir);
  const onboarding = new Onboarding(dir, { settings, canImport });
  return { onboarding, settings, dir };
}

const ids = (onboarding) => onboarding.state().steps.map((step) => step.id);
const indexOf = (onboarding, id) => ids(onboarding).indexOf(id);

test('setup asks only for a world, and nothing else, when there is nothing to import', (t) => {
  const { onboarding } = fixture(t);
  assert.deepEqual(ids(onboarding), ['welcome', 'theme', 'done']);
  assert.equal(onboarding.state().canImport, false);
});

test('"Bring your stuff" appears only when another browser has something to bring', (t) => {
  const { onboarding } = fixture(t, { canImport: () => true });
  assert.deepEqual(ids(onboarding), ['welcome', 'theme', 'import', 'done']);
  assert.equal(onboarding.state().canImport, true);
});

test('the questions that have sensible defaults are no longer asked', () => {
  const asked = STEPS.map((step) => step.id);
  for (const gone of ['profile', 'homepage', 'privacy', 'ai']) {
    assert.ok(!asked.includes(gone), gone + ' is left to its default and to Settings');
  }
});

test('a detection failure means no import step, not a broken setup', (t) => {
  const { onboarding } = fixture(t, { canImport: () => { throw new Error('EPERM'); } });
  assert.deepEqual(ids(onboarding), ['welcome', 'theme', 'done']);
});

test('detection is asked once per run, so the steps cannot shift mid-flow', (t) => {
  let calls = 0;
  let found = true;
  const { onboarding } = fixture(t, { canImport: () => { calls++; return found; } });
  onboarding.next();
  found = false;
  onboarding.next();
  assert.equal(onboarding.state().stepId, 'import', 'still the step this run started with');
  assert.equal(calls, 1);

  // A re-run looks again, because a browser may have been installed since.
  onboarding.restart();
  assert.deepEqual(ids(onboarding), ['welcome', 'theme', 'done']);
  assert.equal(calls, 2);
});

test('a planet is written through the real settings allowlist', (t) => {
  const { onboarding, settings } = fixture(t);
  onboarding.chooseTheme('mars');
  assert.equal(settings.value.theme, 'mars');
  assert.equal(onboarding.state().chosen.theme, 'mars');
});

test('a planet Settings would reject is refused and nothing is recorded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-onboarding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const onboarding = new Onboarding(dir, {
    settings: { update() { throw new Error('settings rejected this'); } },
  });

  assert.throws(() => onboarding.chooseTheme('nope'), /settings rejected this/);
  assert.equal(onboarding.state().chosen.theme, '', 'nothing was recorded');
});

test('unknown steps are refused rather than silently ignored', (t) => {
  const { onboarding } = fixture(t);
  assert.throws(() => onboarding.go(99), /No such step/);
  assert.throws(() => onboarding.go(-1), /No such step/);
  // The import step's slot does not exist when there is nothing to import.
  assert.throws(() => onboarding.go(3), /No such step/);
});

test('optional steps can be skipped and the skip is recorded', (t) => {
  const { onboarding } = fixture(t, { canImport: () => true });
  onboarding.go(indexOf(onboarding, 'theme'));
  onboarding.skip();
  assert.ok(onboarding.state().skipped.includes('theme'));
  assert.equal(onboarding.state().stepId, 'import');
  onboarding.skip();
  assert.ok(onboarding.state().skipped.includes('import'));
  assert.equal(onboarding.state().stepId, 'done');
});

test('choosing a planet after skipping the step un-skips it', (t) => {
  const { onboarding } = fixture(t);
  onboarding.go(indexOf(onboarding, 'theme'));
  onboarding.skip();
  onboarding.back();
  onboarding.chooseTheme('earth');
  assert.ok(!onboarding.state().skipped.includes('theme'), 'it was answered after all');
});

test('the welcome and finishing steps cannot be skipped', (t) => {
  const { onboarding } = fixture(t);
  assert.throws(() => onboarding.skip(), /needs an answer/);
  onboarding.go(indexOf(onboarding, 'done'));
  assert.throws(() => onboarding.skip(), /needs an answer/);
});

test('navigation is clamped at both ends rather than throwing', (t) => {
  const { onboarding } = fixture(t, { canImport: () => true });
  onboarding.back();
  assert.equal(onboarding.state().step, 0, 'back from the first step stays put');
  for (let i = 0; i < STEPS.length + 3; i++) onboarding.next();
  assert.equal(onboarding.state().stepId, 'done', 'next past the end stays put');
  assert.equal(onboarding.state().isLast, true);
});

test('completing is remembered across a restart, and does not reappear', (t) => {
  const { onboarding, settings, dir } = fixture(t);
  assert.equal(onboarding.due, true, 'a fresh profile is due for setup');
  onboarding.chooseTheme('saturn');
  onboarding.complete();
  assert.equal(onboarding.due, false);
  onboarding.flush();

  const reopened = new Onboarding(dir, { settings });
  assert.equal(reopened.due, false, 'it stays completed after a restart');
  assert.equal(reopened.state().chosen.theme, 'saturn', 'the choice is remembered');
});

test('a profile that finished the longer, older setup is not asked again', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-onboarding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // What the eight-step version saved.
  fs.writeFileSync(path.join(dir, 'onboarding.json'), JSON.stringify({
    completed: true, completedAt: 1, profile: 'study', privacy: 'strict',
    layout: 'full', theme: 'pluto', aiEnabled: true, skipped: ['homepage'],
  }));
  const onboarding = new Onboarding(dir, { settings: new Settings(dir) });
  assert.equal(onboarding.due, false);
  assert.equal(onboarding.data.profile, 'study', 'its old answers are still readable');
});

test('dismissing without answering still counts as done', (t) => {
  const { onboarding, dir, settings } = fixture(t);
  onboarding.complete();
  onboarding.flush();
  const reopened = new Onboarding(dir, { settings });
  assert.equal(reopened.due, false, 'a dismissed flow does not come back on its own');
  assert.equal(reopened.state().chosen.theme, '', 'and nothing was chosen for the user');
});

test('restarting from settings makes it due again and clears skips', (t) => {
  const { onboarding } = fixture(t);
  onboarding.go(indexOf(onboarding, 'theme'));
  onboarding.skip();
  onboarding.complete();

  onboarding.restart();
  assert.equal(onboarding.due, true);
  assert.equal(onboarding.state().step, 0);
  assert.deepEqual(onboarding.state().skipped, [], 'earlier skips are cleared');
});

test('a re-run keeps the earlier planet; a fresh one clears it', (t) => {
  const { onboarding } = fixture(t);
  onboarding.chooseTheme('venus');
  onboarding.complete();

  onboarding.restart();
  assert.equal(onboarding.state().chosen.theme, 'venus', 'the earlier planet is still shown as chosen');

  onboarding.restart({ fresh: true });
  assert.equal(onboarding.state().chosen.theme, '');
  assert.equal(onboarding.due, true);
});

test('state carries everything the page needs to render a step', (t) => {
  const { onboarding } = fixture(t);
  const state = onboarding.state();
  assert.equal(state.stepId, 'welcome');
  assert.ok(state.stepTitle, 'the step has a title');
  assert.equal(state.canSkip, false);
  assert.equal(state.isLast, false);
  assert.ok(state.steps.every((step) => step.title), 'every step is named in the progress list');
});
