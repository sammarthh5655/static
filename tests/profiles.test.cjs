const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Profiles, TEMPLATES, AVATARS } = require('../src/features/profiles');

/**
 * Profiles are user-created identities, and they must be genuinely separate.
 * These tests hold the separation, the safety of the PIN, and the rule that a
 * browser always has somewhere to be.
 */

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-profiles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { profiles: new Profiles(dir), dir };
}

test('a fresh install has exactly one profile to be in', (t) => {
  const { profiles } = fixture(t);
  assert.equal(profiles.list.length, 1);
  assert.ok(profiles.active, 'and it is active');
  assert.equal(profiles.state().defaultId, profiles.list[0].id, 'and it is the default');
});

test('any name the user wants is accepted, not a fixed category', (t) => {
  const { profiles } = fixture(t);
  for (const name of ['Sam', 'Advaya', 'Client 1', 'Office', 'zzz', '日本語']) {
    const profile = profiles.create({ name });
    assert.equal(profile.name, name, name + ' was kept verbatim');
  }
});

test('names are cleaned but never rejected outright', (t) => {
  const { profiles } = fixture(t);
  assert.equal(profiles.create({ name: '  Spaced  ' }).name, 'Spaced');
  assert.equal(profiles.create({ name: '' }).name, 'Me', 'an empty name falls back');
  assert.equal(profiles.create({ name: null }).name, 'Me');
  assert.equal(profiles.create({ name: 'a'.repeat(200) }).name.length, 40, 'a long name is capped');
  assert.ok(!profiles.create({ name: 'Bad\u0000Name' }).name.includes('\u0000'),
    'control characters are stripped');
});

test('every profile gets its own directory and its own session partition', (t) => {
  const { profiles } = fixture(t);
  const a = profiles.create({ name: 'A' });
  const b = profiles.create({ name: 'B' });

  assert.notEqual(profiles.directory(a.id), profiles.directory(b.id));
  assert.notEqual(profiles.partition(a.id), profiles.partition(b.id));
  assert.ok(fs.existsSync(profiles.directory(a.id)), 'the directory really exists');
  // Separation is enforced by Chromium, not by our own bookkeeping.
  assert.match(profiles.partition(a.id), /^persist:/, 'a normal profile persists cookies');
});

test('a guest profile does not persist its cookies', (t) => {
  const { profiles } = fixture(t);
  const guest = profiles.create({ name: 'Guest', guest: true });
  assert.ok(!profiles.partition(guest.id).startsWith('persist:'),
    'a guest partition is deliberately not persistent');
});

test('a guest is never remembered as the last profile used', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam' });
  const guest = profiles.create({ name: 'Guest', guest: true });

  profiles.setActive(sam.id);
  profiles.setActive(guest.id);
  profiles.setStartup('last');

  // Resuming into a guest session would defeat the point of it.
  assert.equal(profiles.startup().id, sam.id, 'startup returns to the real profile');
});

test('the last profile cannot be deleted', (t) => {
  const { profiles } = fixture(t);
  assert.throws(() => profiles.remove(profiles.list[0].id), /at least one profile/);
});

test('deleting a profile removes its data from disk', (t) => {
  const { profiles } = fixture(t);
  const gone = profiles.create({ name: 'Temporary' });
  const dir = profiles.directory(gone.id);
  fs.writeFileSync(path.join(dir, 'history.json'), '[]');

  profiles.remove(gone.id);
  assert.equal(fs.existsSync(dir), false, 'the directory is gone');
  assert.equal(profiles.find(gone.id), null, 'and so is the entry');
});

test('deleting the active or default profile never leaves a dangling pointer', (t) => {
  const { profiles } = fixture(t);
  const other = profiles.create({ name: 'Other' });
  profiles.setDefault(other.id);
  profiles.setActive(other.id);

  profiles.remove(other.id);
  const state = profiles.state();
  assert.ok(profiles.find(state.activeId), 'active points at a real profile');
  assert.ok(profiles.find(state.defaultId), 'default points at a real profile');
});

test('clearing data empties the directory but keeps the profile', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam' });
  fs.writeFileSync(path.join(profiles.directory(sam.id), 'history.json'), '[1,2,3]');

  profiles.clearData(sam.id);
  assert.ok(profiles.find(sam.id), 'the profile survives');
  assert.deepEqual(fs.readdirSync(profiles.directory(sam.id)), [], 'its data does not');
});

test('duplicating copies settings but never browsing data', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam', accent: '#ff5533' });
  const dir = profiles.directory(sam.id);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme":"mars"}');
  fs.writeFileSync(path.join(dir, 'history.json'), '[{"url":"https://private.example"}]');
  fs.writeFileSync(path.join(dir, 'passwords.json'), '[{"host":"bank.example"}]');

  const copy = profiles.duplicate(sam.id, 'Sam copy');
  const copyDir = profiles.directory(copy.id);

  assert.ok(fs.existsSync(path.join(copyDir, 'settings.json')), 'settings came across');
  assert.equal(fs.existsSync(path.join(copyDir, 'history.json')), false,
    'history did NOT - duplicating must not duplicate a browsing record');
  assert.equal(fs.existsSync(path.join(copyDir, 'passwords.json')), false,
    'and neither did saved passwords');
  assert.equal(copy.accent, '#ff5533', 'appearance is carried over');
});

test('a PIN is stored only as a salted hash, and never leaves in a card', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam' });
  profiles.setPin(sam.id, '4821');

  const stored = profiles.find(sam.id).pin;
  assert.ok(stored.salt && stored.hash, 'a salt and a hash are stored');
  assert.ok(!JSON.stringify(stored).includes('4821'), 'the PIN itself is not stored');

  const card = profiles.card(profiles.find(sam.id));
  assert.ok(!('pin' in card), 'the card carries no hash at all');
  assert.equal(card.locked, true, 'only that it is locked');
});

test('PIN checking accepts the right one and rejects everything else', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam' });
  profiles.setPin(sam.id, '4821');

  assert.equal(profiles.checkPin(sam.id, '4821'), true);
  for (const wrong of ['0000', '482', '48211', '', null, undefined, 4821]) {
    if (String(wrong) === '4821') continue;
    assert.equal(profiles.checkPin(sam.id, wrong), false, JSON.stringify(wrong) + ' is rejected');
  }
});

test('an unlocked profile always passes the PIN check', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam' });
  assert.equal(profiles.checkPin(sam.id, ''), true, 'no PIN means no barrier');
});

test('a PIN must be digits and a sensible length', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam' });
  for (const bad of ['abc', '12', '1'.repeat(20), 'pin!']) {
    assert.throws(() => profiles.setPin(sam.id, bad), /4 to 12 digits/, bad + ' is refused');
  }
  profiles.setPin(sam.id, '4821');
  profiles.setPin(sam.id, null);
  assert.equal(profiles.find(sam.id).pin, null, 'a PIN can be removed');
});

test('startup honours what the user chose', (t) => {
  const { profiles } = fixture(t);
  const sam = profiles.create({ name: 'Sam' });

  profiles.setStartup('always');
  assert.equal(profiles.startup().show, true);

  profiles.setStartup('default');
  assert.equal(profiles.startup().show, false);
  assert.equal(profiles.startup().id, profiles.state().defaultId);

  profiles.setStartup('last');
  profiles.setActive(sam.id);
  assert.equal(profiles.startup().id, sam.id, 'it resumes the last one used');
});

test('"only when there are several" means exactly that', (t) => {
  const { profiles } = fixture(t);
  profiles.setStartup('multiple');
  assert.equal(profiles.startup().show, false, 'one profile: no picker');
  profiles.create({ name: 'Second' });
  assert.equal(profiles.startup().show, true, 'two profiles: picker');
});

test('a guest does not count toward "more than one profile"', (t) => {
  const { profiles } = fixture(t);
  profiles.setStartup('multiple');
  profiles.create({ name: 'Guest', guest: true });
  assert.equal(profiles.startup().show, false,
    'a guest alongside one real profile is still one real profile');
});

test('unknown ids and settings are refused rather than half-applied', (t) => {
  const { profiles } = fixture(t);
  assert.throws(() => profiles.update('nope', { name: 'x' }), /no longer exists/);
  assert.throws(() => profiles.remove('nope'), /no longer exists/);
  assert.throws(() => profiles.setDefault('nope'), /no longer exists/);
  assert.throws(() => profiles.setPin('nope', '1234'), /no longer exists/);
  assert.throws(() => profiles.clearData('nope'), /no longer exists/);
  assert.throws(() => profiles.setStartup('whenever'), /No such startup/);
});

test('everything survives a restart', (t) => {
  const { profiles, dir } = fixture(t);
  const sam = profiles.create({ name: 'Sam', accent: '#ff5533', label: 'personal' });
  profiles.setPin(sam.id, '4821');
  profiles.setDefault(sam.id);
  profiles.setStartup('always');
  profiles.flush();

  const reopened = new Profiles(dir);
  const found = reopened.find(sam.id);
  assert.ok(found, 'the profile is still there');
  assert.equal(found.name, 'Sam');
  assert.equal(found.accent, '#ff5533');
  assert.equal(found.label, 'personal');
  assert.equal(reopened.checkPin(sam.id, '4821'), true, 'and still unlocks');
  assert.equal(reopened.state().startup, 'always');
  assert.equal(reopened.state().defaultId, sam.id);
});

test('templates are offered as starting points, not as categories', (t) => {
  const { profiles } = fixture(t);
  const state = profiles.state();
  assert.ok(state.templates.length >= 4, 'several are offered');
  assert.ok(state.templates.every((template) => template.name && template.summary));

  // A profile made from a template is an ordinary profile afterwards.
  const made = profiles.create({ name: 'Whatever I Like', template: 'privacy' });
  assert.equal(made.name, 'Whatever I Like', 'the template does not name it');
  assert.ok(TEMPLATES.privacy, 'the template exists as a starting point only');
});

test('the avatar list is offered and honoured', (t) => {
  const { profiles } = fixture(t);
  assert.ok(profiles.state().avatars.length > 4);
  const made = profiles.create({ name: 'Sam', avatar: AVATARS[2] });
  assert.equal(made.avatar, AVATARS[2]);
  const junk = profiles.create({ name: 'Other', avatar: 'not-an-avatar' });
  assert.ok(AVATARS.includes(junk.avatar), 'an unknown avatar falls back to a real one');
});

test('there is a ceiling on how many profiles can exist', (t) => {
  const { profiles } = fixture(t);
  for (let i = profiles.list.length; i < 30; i++) profiles.create({ name: 'P' + i });
  assert.throws(() => profiles.create({ name: 'One too many' }), /up to 30/);
});

test('a new profile starts with the planet and template it was made with, once', (t) => {
  const { profiles } = fixture(t);
  const made = profiles.create({ name: 'Study', theme: 'mars', template: 'privacy' });
  const seed = profiles.takeSeed(made.id);
  assert.equal(seed.settings.theme, 'mars');
  assert.deepEqual(seed.shields, TEMPLATES.privacy.shields);
  assert.equal(profiles.takeSeed(made.id), null, 'and never again, so later changes stick');
});

test('profiles made before seeding existed are left alone', (t) => {
  const { profiles } = fixture(t);
  const old = profiles.create({ name: 'Old', theme: 'mars' });
  delete profiles.find(old.id).seeded;
  assert.equal(profiles.takeSeed(old.id), null);
});

test('every avatar a profile can pick has an icon drawn for it', () => {
  const { ICONS } = require('../src/shared/theme.js');
  assert.deepEqual(AVATARS.filter((id) => !ICONS[id]), []);
});
