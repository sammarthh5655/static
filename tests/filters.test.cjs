const test = require('node:test');
const assert = require('node:assert/strict');
const { FilterEngine } = require('../src/features/shields/filters');

/**
 * The filter parser.
 *
 * The rule that matters most here is the one about UNSUPPORTED options: a
 * rule whose meaning depends on an option this engine cannot implement must
 * be dropped, never applied with the option ignored. Ignoring one turned a
 * narrowly scoped uBlock rule into "block every XHR on the web", and the
 * browser returned ERR_BLOCKED_BY_CLIENT for ordinary pages.
 */

function engine(...rules) {
  const e = new FilterEngine();
  e.addList(rules.join('\n'));
  return e;
}

const page = (url, type = 'mainFrame') =>
  ({ url, docHost: new URL(url).hostname, resourceType: type });

test('a scoped redirect rule never becomes a global block', () => {
  // Verbatim from uBlock's filters-2024.txt.
  const e = engine('*$xhr,redirect-rule=noop.txt,to=~pagead2.googlesyndication.com,from=tunein.com');
  for (const url of ['https://www.speedtest.net/', 'https://example.com/',
                     'https://www.google.com/', 'https://en.wikipedia.org/']) {
    assert.equal(e.match(page(url)).blocked, false, url + ' must load');
    assert.equal(e.match(page(url, 'xmlhttprequest')).blocked, false,
      url + ' XHR must not be blocked either');
  }
});

test('every option that changes a rule\'s meaning makes it inert', () => {
  // Each of these would be wrong if the option were simply ignored.
  const dangerous = [
    '*$xhr,from=example.com',
    '*$script,to=ads.example',
    '||example.com^$redirect=noop.js',
    '*$xhr,redirect-rule=noop.txt',
    '||example.com^$removeparam=utm_source',
    '||example.com^$csp=script-src none',
    '||example.com^$replace=/a/b/',
    '*$denyallow=example.com',
    '||example.com^$header=x-frame-options',
    '*$method=post',
  ];
  for (const rule of dangerous) {
    const e = engine(rule);
    assert.equal(e.match(page('https://unrelated.example/')).blocked, false,
      rule + ' must not block an unrelated page');
    assert.equal(e.match(page('https://unrelated.example/x.js', 'script')).blocked, false,
      rule + ' must not block an unrelated script');
  }
});

test('ordinary rules still block what they should', () => {
  const e = engine(
    '||pagead2.googlesyndication.com^',
    '||doubleclick.net^',
    '||google-analytics.com/analytics.js',
  );
  assert.equal(e.match(page('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script')).blocked, true);
  assert.equal(e.match(page('https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script')).blocked, true);
  assert.equal(e.match(page('https://www.google-analytics.com/analytics.js', 'script')).blocked, true);
  assert.equal(e.match(page('https://example.com/app.js', 'script')).blocked, false,
    'and leave everything else alone');
});

test('exceptions still win over blocks', () => {
  const e = engine('||ads.example^', '@@||ads.example/allowed.js');
  assert.equal(e.match(page('https://ads.example/track.js', 'script')).blocked, true);
  assert.equal(e.match(page('https://ads.example/allowed.js', 'script')).blocked, false);
});

test('cosmetic-only options do not become network rules', () => {
  // $generichide only lifts COSMETIC hiding. Treated as a network exception it
  // would unblock that domain's trackers everywhere.
  const e = engine('||tracker.example^', '@@||facebook.com^$generichide');
  assert.equal(e.match(page('https://tracker.example/pixel.gif', 'image')).blocked, true,
    'the block still applies');
});

test('no rule in the shipped lists blocks a plain web page', () => {
  // A regression guard over the REAL lists, if they have been fetched.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '.test-profile');
  let dir = null;
  const find = (at, depth) => {
    if (dir || depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (dir) return;
      if (entry.isDirectory()) {
        if (entry.name === 'filter-lists') {
          const full = path.join(at, entry.name);
          if (fs.existsSync(path.join(full, 'ubo-filters.txt'))) { dir = full; return; }
        }
        find(path.join(at, entry.name), depth + 1);
      }
    }
  };
  find(root, 0);
  if (!dir) return;   // lists not fetched in this checkout; nothing to guard

  const e = new FilterEngine();
  for (const file of fs.readdirSync(dir)) {
    e.addList(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  for (const url of ['https://www.speedtest.net/', 'https://www.indiatimes.com/',
                     'https://timesofindia.indiatimes.com/', 'https://example.com/',
                     'https://www.google.com/', 'https://www.youtube.com/',
                     'https://github.com/', 'https://en.wikipedia.org/wiki/Advertising']) {
    const verdict = e.match(page(url));
    assert.equal(verdict.blocked, false,
      url + ' is blocked by: ' + JSON.stringify(verdict.rule));
  }
});
