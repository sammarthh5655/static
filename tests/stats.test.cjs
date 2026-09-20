const test = require('node:test');
const assert = require('node:assert');
const { Stats, dayKey } = require('../src/features/shields/stats');

const makeStore = () => ({ data: {}, saved: 0, save() { this.saved++; } });

test('starts empty so the widget can show an empty state', () => {
  const stats = new Stats(makeStore());
  assert.strictEqual(stats.isEmpty, true);
  assert.strictEqual(stats.totals(1).total, 0);
});

test('records only known categories', () => {
  const stats = new Stats(makeStore());
  stats.record('ads', 3);
  stats.record('not-a-category', 99);
  assert.strictEqual(stats.totals(1).ads, 3);
  assert.strictEqual(stats.totals(1).total, 3);
});

test('ignores non-positive counts', () => {
  const stats = new Stats(makeStore());
  stats.record('ads', 0);
  stats.record('ads', -5);
  assert.strictEqual(stats.isEmpty, true);
});

test('bandwidth counts only network blocks', () => {
  const stats = new Stats(makeStore());
  // Hiding an element or stripping a parameter downloads nothing less, so
  // neither may inflate the saved-bandwidth figure.
  stats.record('cosmetic', 10);
  stats.record('params', 10);
  assert.strictEqual(stats.totals(1).bytesSaved, 0);
  stats.record('ads', 1);
  assert.ok(stats.totals(1).bytesSaved > 0);
});

test('derived figures are flagged as estimates', () => {
  const stats = new Stats(makeStore());
  stats.record('ads', 1);
  assert.strictEqual(stats.totals(1).estimated, true);
  assert.match(stats.summary().estimateNote, /estimate/i);
});

test('series covers every day in the window, including quiet ones', () => {
  const stats = new Stats(makeStore());
  stats.record('ads', 2);
  const series = stats.series(7);
  assert.strictEqual(series.length, 7);
  assert.strictEqual(series[6].day, dayKey());
  assert.strictEqual(series[6].total, 2);
  assert.strictEqual(series[0].total, 0);
});

test('older days are kept out of the today window', () => {
  const store = makeStore();
  const stats = new Stats(store);
  const old = new Date();
  old.setDate(old.getDate() - 3);
  store.data.days[dayKey(old)] = { ads: 50, trackers: 0, cosmetic: 0, https: 0,
    params: 0, cookies: 0, phishing: 0, videoAds: 0 };
  stats.record('ads', 2);
  assert.strictEqual(stats.totals(1).ads, 2, 'today must exclude older days');
  assert.strictEqual(stats.totals(7).ads, 52, 'the week must include them');
  assert.strictEqual(stats.totals(0).ads, 52, 'all time must include them');
});

test('persists through the store', () => {
  const store = makeStore();
  const stats = new Stats(store);
  stats.record('ads', 1);
  stats.flush();
  assert.ok(store.saved > 0);
  // A fresh Stats over the same data sees the same totals.
  assert.strictEqual(new Stats(store).totals(1).ads, 1);
});
