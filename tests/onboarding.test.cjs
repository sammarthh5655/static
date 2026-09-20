const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Onboarding, STEPS, PROFILES, PRIVACY_LEVELS, LAYOUTS } = require('../src/features/onboarding');
const { Settings } = require('../src/features/settings');

/**
 * Onboarding owns no settings of its own: every choice is written through the
 * same validated path the settings page uses. These tests hold it to that, and
 * to not blocking the browser.
 */

function fixture(t, { aiAvailable = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-onboarding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const settings = new Settings(dir);
  // A stand-in for shields that records what it was asked to change.
  const applied = [];
  const shields = { update(patch) { applied.push(patch); return patch; } };

  const onboarding = new Onboarding(dir, { settings, shields, aiAvailable });
  return { onboarding, settings, applied, dir };
}

test('every profile preset is accepted by the real settings allowlist', (t) => {
  for (const id of Object.keys(PROFILES)) {
    const { onboarding, settings } = fixture(t);
    // Throws if a preset names a key or value Settings rejects, which is the
    // whole point of routing through update() rather than the store.
    onboarding.chooseProfile(id);
    assert.equal(onboarding.state().chosen.profile, id);
    assert.ok(settings.value.newTab.widgets.length, id + ' produced a homepage');
  }
});

test('a profile actually changes the settings it names', (t) => {
  const { onboarding, settings } = fixture(t);
  onboarding.chooseProfile('work');
  assert.equal(settings.value.density, 'compact');
  assert.equal(settings.value.theme, 'pluto');
  assert.deepEqual(settings.value.newTab.widgets, PROFILES.work.newTab.widgets);
  assert.equal(settings.value.newTab.showMostVisited, true);
});

test('the private profile switches every shield on', (t) => {
  const { onboarding, applied } = fixture(t);
  onboarding.chooseProfile('private');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].enabled, true);
  assert.equal(applied[0].blockThirdPartyCookies, true);
});

test('profiles that name no shield changes leave shields alone', (t) => {
  const { onboarding, applied } = fixture(t);
  onboarding.chooseProfile('everyday');
  assert.equal(applied.length, 0, 'shields were not touched');
});

test('every homepage layout survives the settings allowlist', (t) => {
  for (const id of Object.keys(LAYOUTS)) {
    const { onboarding, settings } = fixture(t);
    onboarding.chooseLayout(id);
    assert.deepEqual(settings.value.newTab.widgets, LAYOUTS[id].widgets, id + ' widgets stuck');
    assert.equal(settings.value.newTab.showMostVisited, LAYOUTS[id].showMostVisited);
  }
});

test('every privacy level is a real shields patch', (t) => {
  for (const id of Object.keys(PRIVACY_LEVELS)) {
    const { onboarding, applied } = fixture(t);
    onboarding.choosePrivacy(id);
    assert.equal(applied.length, 1, id + ' applied exactly one patch');
    assert.equal(typeof applied[0].enabled, 'boolean');
  }
  const { onboarding, applied } = fixture(t);
  onboarding.choosePrivacy('off');
  assert.equal(applied[0].enabled, false, 'off really switches shields off');
});

test('a profile whose shield part fails is still recorded, and says so', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-onboarding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new Settings(dir);
  const onboarding = new Onboarding(dir, {
    settings,
    shields: { update() { throw new Error('vault busy'); } },
  });

  const result = onboarding.chooseProfile('private');
  // The settings part landed and is visible, so the choice must not read as
  // unmade - that would be the state lying about what the user can see.
  assert.equal(result.chosen.profile, 'private');
  assert.equal(settings.value.theme, 'pluto', 'the settings part did apply');
  assert.match(result.warning, /shield settings could not be changed/);
  assert.match(result.warning, /vault busy/, 'the real reason is passed through');
});

test('a profile that applies cleanly carries no warning', (t) => {
  const { onboarding } = fixture(t);
  assert.equal(onboarding.chooseProfile('private').warning, null);
  assert.equal(onboarding.chooseProfile('everyday').warning, null);
});

test('a failed settings write records nothing at all', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-onboarding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const onboarding = new Onboarding(dir, {
    settings: { update() { throw new Error('settings rejected this'); } },
    shields: { update() {} },
  });

  assert.throws(() => onboarding.chooseProfile('work'), /settings rejected this/);
  assert.equal(onboarding.state().chosen.profile, '', 'nothing was recorded');
});

test('unknown choices are refused rather than silently ignored', (t) => {
  const { onboarding } = fixture(t);
  assert.throws(() => onboarding.chooseProfile('nope'), /No such profile/);
  assert.throws(() => onboarding.chooseLayout('nope'), /No such layout/);
  assert.throws(() => onboarding.choosePrivacy('nope'), /No such privacy level/);
  assert.throws(() => onboarding.go(99), /No such step/);
  assert.throws(() => onboarding.go(-1), /No such step/);
});

test('optional steps can be skipped and the skip is recorded', (t) => {
  const { onboarding } = fixture(t);
  onboarding.go(STEPS.findIndex((step) => step.id === 'homepage'));
  onboarding.skip();
  assert.ok(onboarding.state().skipped.includes('homepage'));
  assert.equal(onboarding.state().stepId, 'privacy');
});

test('a required step cannot be skipped', (t) => {
  const { onboarding } = fixture(t);
  onboarding.go(STEPS.findIndex((step) => step.id === 'profile'));
  assert.throws(() => onboarding.skip(), /needs an answer/);
});

test('navigation is clamped at both ends rather than throwing', (t) => {
  const { onboarding } = fixture(t);
  onboarding.back();
  assert.equal(onboarding.state().step, 0, 'back from the first step stays put');
  for (let i = 0; i < STEPS.length + 3; i++) onboarding.next();
  assert.equal(onboarding.state().step, STEPS.length - 1, 'next past the end stays put');
  assert.equal(onboarding.state().isLast, true);
});

test('completing is remembered across a restart, and does not reappear', (t) => {
  const { onboarding, settings, dir } = fixture(t);
  assert.equal(onboarding.due, true, 'a fresh profile is due for setup');
  onboarding.chooseProfile('study');
  onboarding.complete();
  assert.equal(onboarding.due, false);
  onboarding.flush();

  const reopened = new Onboarding(dir, { settings, shields: { update() {} } });
  assert.equal(reopened.due, false, 'it stays completed after a restart');
  assert.equal(reopened.state().chosen.profile, 'study', 'the choice is remembered');
});

test('dismissing without answering still counts as done', (t) => {
  const { onboarding, dir, settings } = fixture(t);
  onboarding.complete();
  onboarding.flush();
  const reopened = new Onboarding(dir, { settings, shields: { update() {} } });
  assert.equal(reopened.due, false, 'a dismissed flow does not come back on its own');
  assert.equal(reopened.state().chosen.profile, '', 'and nothing was chosen for the user');
});

test('restarting from settings makes it due again and clears skips', (t) => {
  const { onboarding } = fixture(t);
  onboarding.go(STEPS.findIndex((step) => step.id === 'privacy'));
  onboarding.skip();
  onboarding.complete();

  onboarding.restart();
  assert.equal(onboarding.due, true);
  assert.equal(onboarding.state().step, 0);
  assert.deepEqual(onboarding.state().skipped, [], 'earlier skips are cleared');
});

test('a re-run keeps earlier answers so one thing can be changed', (t) => {
  const { onboarding } = fixture(t);
  onboarding.chooseProfile('study');
  onboarding.choosePrivacy('strict');
  onboarding.complete();

  onboarding.restart();
  const chosen = onboarding.state().chosen;
  assert.equal(chosen.profile, 'study', 'the earlier profile is still shown as chosen');
  assert.equal(chosen.privacy, 'strict');
});

test('a fresh restart clears earlier answers', (t) => {
  const { onboarding } = fixture(t);
  onboarding.chooseProfile('study');
  onboarding.choosePrivacy('strict');
  onboarding.chooseAI(true);
  onboarding.complete();

  onboarding.restart({ fresh: true });
  const chosen = onboarding.state().chosen;
  assert.equal(chosen.profile, '');
  assert.equal(chosen.privacy, '');
  assert.equal(chosen.layout, '');
  assert.equal(chosen.aiEnabled, null);
  assert.equal(onboarding.due, true);
});

test('the assistant step reports availability rather than assuming it', (t) => {
  const off = fixture(t, { aiAvailable: false });
  assert.equal(off.onboarding.state().aiAvailable, false);
  const on = fixture(t, { aiAvailable: true });
  assert.equal(on.onboarding.state().aiAvailable, true);

  on.onboarding.chooseAI(true);
  assert.equal(on.onboarding.state().chosen.aiEnabled, true);
  on.onboarding.chooseAI(false);
  assert.equal(on.onboarding.state().chosen.aiEnabled, false);
});

test('state carries everything the page needs to render a step', (t) => {
  const { onboarding } = fixture(t);
  const state = onboarding.state();
  assert.equal(state.stepId, 'welcome');
  assert.ok(state.stepTitle, 'the step has a title');
  assert.equal(state.profiles.length, Object.keys(PROFILES).length);
  assert.ok(state.profiles.every((profile) => profile.name && profile.summary),
    'every profile card has something to say');
  assert.ok(state.privacyLevels.every((level) => level.summary));
  assert.ok(state.layouts.every((layout) => layout.summary));
});
