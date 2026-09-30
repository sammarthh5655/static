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

const { baseDomain } = require('../src/features/shields/stats');

test('blocked hosts group by the domain a person would name', () => {
  assert.strictEqual(baseDomain('securepubads.g.doubleclick.net'), 'doubleclick.net');
  assert.strictEqual(baseDomain('www.example.co.uk'), 'example.co.uk');
  assert.strictEqual(baseDomain('ads.news.co.in'), 'news.co.in');
  assert.strictEqual(baseDomain('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(baseDomain('localhost'), 'localhost');
});

test('most blocked and where, ranked by count', () => {
  const stats = new Stats(makeStore());
  stats.note({ url: 'https://ad.doubleclick.net/a.gif', site: 'news.com', category: 'ads' });
  stats.note({ url: 'https://securepubads.g.doubleclick.net/gpt.js', site: 'www.news.com', category: 'ads' });
  stats.note({ url: 'https://www.google-analytics.com/a.js', site: 'blog.org', category: 'trackers' });
  const hosts = stats.top('hosts');
  assert.strictEqual(hosts[0].name, 'doubleclick.net');
  assert.strictEqual(hosts[0].count, 2);
  assert.strictEqual(hosts[0].ads, 2);
  assert.strictEqual(stats.top('sites')[0].name, 'news.com');
});

test('the live feed is newest first, bounded, and never saved', () => {
  const store = makeStore();
  const stats = new Stats(store);
  for (let i = 0; i < 400; i++) stats.note({ url: 'https://t.example/' + i, site: 'a.com' });
  assert.strictEqual(stats.recent(1000).length, 150);
  assert.ok(stats.recent(1)[0].url.endsWith('/399'));
  assert.strictEqual(JSON.stringify(store.data).includes('t.example/'), false);
});

test('hourly buckets split ads, trackers and the rest', () => {
  const stats = new Stats(makeStore());
  stats.record('ads', 2);
  stats.record('trackers', 3);
  stats.record('cookies', 4);
  const now = stats.hourly(24);
  assert.strictEqual(now.length, 24);
  assert.deepStrictEqual([now[23].ads, now[23].trackers, now[23].other], [2, 3, 4]);
});

test('forgetting sites keeps the totals; reset clears everything', () => {
  const stats = new Stats(makeStore());
  stats.record('ads', 5);
  stats.note({ url: 'https://ads.x.com/a', site: 'visited.com', category: 'ads' });
  stats.forgetSites();
  assert.strictEqual(stats.top('sites').length, 0);
  assert.strictEqual(stats.totals(1).ads, 5);
  stats.reset();
  assert.strictEqual(stats.isEmpty, true);
  assert.strictEqual(stats.top('hosts').length, 0);
  assert.strictEqual(stats.firstDay, null);
});

test('the long tail of domains is pruned first', () => {
  const stats = new Stats(makeStore());
  for (let i = 0; i < 5; i++) stats.note({ url: 'https://big.example/x' });
  for (let i = 0; i < 400; i++) stats.note({ url: 'https://small' + i + '.example/x' });
  stats.flush();
  assert.strictEqual(stats.top('hosts', 1000).length, 300);
  assert.strictEqual(stats.top('hosts', 1)[0].name, 'big.example');
});
