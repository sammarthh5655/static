const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ScreenTime, domain, hostOf, scheduled, dayKey } = require('../src/features/screen-time');
const { analyze, aiMetadata, parseGroups } = require('../src/features/organizer/classify');
function fixture(t, now = new Date(2026, 8, 21, 12).getTime()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-productivity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = now; const time = new ScreenTime(dir, { now: () => clock });
  return { time, dir, advance: ms => clock += ms, now: () => clock };
}
function rule(time, domain, dailyMinutes, schedules = []) { return time.saveRule({ domain, dailyMinutes, schedules }); }
test('screen time counts foreground consecutive samples only and ignores suspension gaps', t => {
  const f = fixture(t), context = { id: 'a', url: 'http://localhost:8080/one', eligible: true };
  f.time.observe(context); f.advance(1000); f.time.observe(context);
  assert.equal(f.time.used('localhost'), 1000);
  f.advance(1000); f.time.observe({ ...context, eligible: false });
  f.advance(3600000); f.time.observe(context); f.advance(1000); f.time.observe({ ...context, id: 'b' });
  assert.equal(f.time.used('localhost'), 1000);
  f.advance(1000); f.time.observe({ ...context, id: 'b' });
  assert.equal(f.time.used('localhost'), 2000);
  f.time.update({ enabled: false }); f.advance(1000); f.time.observe(context);
  assert.equal(f.time.used('localhost'), 2000);
});
test('time splits at local midnight and weekly reports survive restart', t => {
  const f = fixture(t, new Date(2026, 8, 21, 23, 59, 59).getTime());
  const start = f.now(); f.time.record('example.com', start, start + 2000); f.advance(2000);
  assert.equal(f.time.used('example.com', dayKey(start)), 1000);
  assert.equal(f.time.used('example.com'), 1000); f.time.flush();
  const restored = new ScreenTime(f.dir, { now: f.now });
  assert.equal(restored.state().weekMs, 2000); assert.equal(restored.state().weekly.length, 7);
});
test('overnight pauses use the day they started; equal times cover a whole selected day', () => {
  const schedule = { days: [1], start: '22:00', end: '06:00' };
  assert.equal(scheduled(schedule, new Date(2026, 8, 21, 23).getTime()), true);
  assert.equal(scheduled(schedule, new Date(2026, 8, 22, 5).getTime()), true);
  assert.equal(scheduled(schedule, new Date(2026, 8, 22, 6).getTime()), false);
  assert.equal(scheduled(schedule, new Date(2026, 8, 21, 5).getTime()), false);
  assert.equal(scheduled({ ...schedule, start: '00:00', end: '00:00' }, new Date(2026, 8, 21, 12).getTime()), true);
});
test('limits cover subdomains, warn once, expire unlocks and honour allowlists', t => {
  const f = fixture(t); rule(f.time, 'reddit.com', 5);
  f.time.record('old.reddit.com', f.now() - 4.5 * 60000, f.now());
  assert.equal(f.time.warning('https://reddit.com').seconds, 30);
  assert.equal(f.time.warning('https://reddit.com'), null);
  assert.equal(f.time.verdict('https://reddit.com'), null);
  f.time.record('reddit.com', f.now() - 30000, f.now());
  assert.equal(f.time.verdict('https://old.reddit.com').reason, 'limit');
  assert.equal(f.time.verdict('https://reddit.com.evil.test'), null);
  f.time.unlock('https://reddit.com'); assert.equal(f.time.verdict('https://reddit.com'), null);
  f.advance(300001); assert.equal(f.time.verdict('https://reddit.com').reason, 'limit');
  f.time.update({ allowlist: ['reddit.com'] }); assert.equal(f.time.verdict('https://old.reddit.com'), null);
});
test('presets leave YouTube allowed, preserve custom shopping rules, and optional YouTube limits work', t => {
  const { time } = fixture(t); rule(time, 'amazon.in', 12);
  for (const preset of ['study', 'work', 'gaming', 'legal', 'custom']) {
    time.preset(preset);
    assert.equal(time.verdict('https://youtube.com/watch?v=lecture'), null);
    assert.equal(time.config.rules.find(r => r.domain === 'amazon.in').dailyMinutes, 12);
  }
  rule(time, 'youtube.com', 0);
  assert.equal(time.verdict('https://youtu.be/lecture').reason, 'limit');
  rule(time, 'twitter.com', 0);
  assert.equal(time.verdict('https://x.com/home').reason, 'limit');
  assert.throws(() => rule(time, 'javascript:alert(1)', 5));
  assert.throws(() => rule(time, 'news.test', -1));
  assert.throws(() => rule(time, 'news.test', null));
  assert.throws(() => rule(time, 'news.test', null, [{ start: '25:00', end: '06:00', days: [1] }]));
  assert.equal(domain('https://user:pass@example.com'), '');
  assert.equal(hostOf('http://127.0.0.1:8134/path'), '127.0.0.1');
  assert.equal(hostOf('browser://newtab'), '');
});
test('organizer classifies topics and never merges distinct queries or document fragments', () => {
  const tabs = [
    { id: 'a', title: 'Python reference', url: 'https://docs.python.org/3/?q=a', lastActiveAt: 0, memoryMb: 400 },
    { id: 'b', title: 'Python reference', url: 'https://docs.python.org/3/?q=a', active: true, lastActiveAt: 500 },
    { id: 'c', title: 'Python search', url: 'https://docs.python.org/3/?q=b', lastActiveAt: 500 },
    { id: 'd', title: 'Judgment', url: 'https://indiankanoon.org/doc/123', lastActiveAt: 500 },
    { id: 'e', title: 'Course', url: 'https://wikipedia.org/wiki/Physics#one', lastActiveAt: 500 },
    { id: 'f', title: 'Course', url: 'https://wikipedia.org/wiki/Physics#two', lastActiveAt: 500 },
  ];
  const plan = analyze(tabs, 3600000);
  assert.equal(plan.duplicates.length, 1); assert.equal(plan.duplicates[0].keep, 'b');
  assert.deepEqual(plan.heavy, ['a']); assert.ok(plan.groups.some(g => g.category === 'Legal'));
  assert.ok(plan.groups.some(g => g.category === 'Study')); assert.equal(plan.sameDomain.length, 2);
  const metadata = aiMetadata(tabs);
  assert.equal(JSON.stringify(metadata).includes('?q='), false); assert.equal(JSON.stringify(metadata).includes('/doc/123'), false);
  const parsed = parseGroups(JSON.stringify({ groups: [{ name: 'Code', category: 'Coding', ids: ['a', 'a', 'made-up'] }] }), tabs, plan.groups);
  assert.equal(parsed.flatMap(g => g.ids).length, 6);
  assert.equal(new Set(parsed.flatMap(g => g.ids)).size, 6);
});
