const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Sense, CLUSTER_SIZE } = require('../src/features/sense');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-sense-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Sense(dir);
}

const shopping = (count) => Array.from({ length: count }, (_, i) => ({
  id: 'tab' + i, url: 'https://amazon.in/dp/' + i, title: 'Item ' + i,
}));

test('malformed tab entries never throw', (t) => {
  const sense = fixture(t);
  // These arrive from live browser state during a tab close race.
  assert.equal(sense.suggest([null, undefined, {}, { url: null }]), null);
  assert.equal(sense.suggest([{ url: 'not a url' }, { title: 'no url at all' }]), null);
  assert.equal(sense.suggest('not an array'), null);
  assert.equal(sense.suggest(null), null);
  assert.equal(sense.suggest(), null);
});

test('junk mixed into real tabs does not stop detection', (t) => {
  const sense = fixture(t);
  const suggestion = sense.suggest([...shopping(CLUSTER_SIZE), null, { url: null }]);
  assert.ok(suggestion, 'a suggestion was still produced');
  assert.equal(suggestion.id, 'shopping');
});

test('non-web schemes are never counted', (t) => {
  const sense = fixture(t);
  const internal = Array.from({ length: 6 }, (_, i) => ({
    id: 'x' + i, url: 'browser://newtab', title: 'New tab',
  }));
  assert.equal(sense.suggest(internal), null);
});

test('silence is the default: below the threshold nothing is offered', (t) => {
  const sense = fixture(t);
  assert.equal(sense.suggest(shopping(CLUSTER_SIZE - 1)), null);
  assert.ok(sense.suggest(shopping(CLUSTER_SIZE)), 'at the threshold it speaks');
});

test('at most one suggestion is ever returned', (t) => {
  const sense = fixture(t);
  // Enough tabs to trigger several rules at once.
  const many = [
    ...shopping(4),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 'g' + i, url: 'https://github.com/r' + i, title: 'Repo ' + i,
    })),
  ];
  const result = sense.suggest(many);
  assert.ok(result && !Array.isArray(result), 'exactly one suggestion, not a list');
});

test('"never again" is permanent, and survives a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-sense-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sense = new Sense(dir);
  assert.ok(sense.suggest(shopping(CLUSTER_SIZE)));
  sense.silence('shopping');
  assert.equal(sense.suggest(shopping(CLUSTER_SIZE)), null, 'silenced immediately');
  sense.flush();

  const reopened = new Sense(dir);
  assert.equal(reopened.suggest(shopping(CLUSTER_SIZE)), null, 'still silenced after a restart');
});

test('snoozing hides it for now and it returns later', (t) => {
  const sense = fixture(t);
  const now = Date.now();
  sense.snooze('shopping', now);
  assert.equal(sense.suggest(shopping(CLUSTER_SIZE), {}, now + 1000), null);
  // Past the snooze window it is offered again.
  const later = now + 7 * 60 * 60 * 1000;
  assert.ok(sense.suggest(shopping(CLUSTER_SIZE), {}, later));
});

test('switching Sense off silences everything', (t) => {
  const sense = fixture(t);
  sense.setEnabled(false);
  assert.equal(sense.suggest(shopping(10)), null);
  sense.setEnabled(true);
  assert.ok(sense.suggest(shopping(10)));
});
