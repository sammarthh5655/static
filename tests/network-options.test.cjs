const test = require('node:test');
const assert = require('node:assert/strict');
const { FilterEngine, regexToken } = require('../src/features/shields/filters');

const engine = (lines) => { const e = new FilterEngine(); e.addList(lines.join('\n'), { id: 't' }); return e; };
const req = (url, docHost = 'site.example', resourceType = 'script', method = 'GET') => ({ url, docHost, resourceType, method });

test('$redirect blocks and names a stand-in; $redirect-rule only when otherwise blocked', () => {
  const e = engine(['||ads.example/gpt.js$script,redirect=googletagservices_gpt.js',
    '||cdn.example/lib.js$script,redirect-rule=noop.js', '||cdn.example/lib.js$script,domain=blocky.example']);
  assert.deepEqual([e.match(req('https://ads.example/gpt.js')).blocked, e.match(req('https://ads.example/gpt.js')).redirect], [true, 'googletagservices_gpt.js']);
  assert.equal(e.match(req('https://cdn.example/lib.js')).blocked, false, 'a redirect-rule alone does not block');
  const blocked = e.match(req('https://cdn.example/lib.js', 'blocky.example'));
  assert.deepEqual([blocked.blocked, blocked.redirect], [true, 'noop.js']);
});

test('an exception for a redirect cancels the redirect, never the block', () => {
  const e = engine(['||ads.example^$script,redirect=noop.js', '@@||ads.example^$redirect']);
  const r = e.match(req('https://ads.example/x.js'));
  assert.deepEqual([r.blocked, r.redirect], [true, '']);
});

test('$important beats an ordinary exception but not an important one', () => {
  const e = engine(['||t.example^$important', '@@||t.example^']);
  assert.equal(e.match(req('https://t.example/p')).blocked, true);
  const f = engine(['||t.example^$important', '@@||t.example^$important']);
  assert.equal(f.match(req('https://t.example/p')).blocked, false);
});

test('from=, to= and denyallow= scope rules the way uBlock means them', () => {
  const e = engine(['*$script,3p,from=news.example,denyallow=cdn.example|static.example']);
  assert.equal(e.match(req('https://evil.example/a.js', 'news.example')).blocked, true);
  assert.equal(e.match(req('https://cdn.example/a.js', 'news.example')).blocked, false);
  assert.equal(e.match(req('https://evil.example/a.js', 'other.example')).blocked, false);
  const t = engine(['*$xhr,to=tracker.example']);
  assert.equal(t.match(req('https://tracker.example/x', 'a.example', 'xhr')).blocked, true);
  assert.equal(t.match(req('https://fine.example/x', 'a.example', 'xhr')).blocked, false);
});

test('$method narrows a rule', () => {
  const e = engine(['||api.example/log$method=post']);
  assert.equal(e.match(req('https://api.example/log', 's.example', 'xhr', 'POST')).blocked, true);
  assert.equal(e.match(req('https://api.example/log', 's.example', 'xhr', 'GET')).blocked, false);
});

test('regex rules match, with a real token when one can be proved', () => {
  const e = engine(['/banner[0-9]+\.gif/$image']);
  assert.equal(e.match(req('https://x.example/banner42.gif', 'a.example', 'image')).blocked, true);
  assert.equal(e.match(req('https://x.example/banner.gif', 'a.example', 'image')).blocked, false);
  // "track" could continue ("tracking"), so the bounded "example" is used.
  assert.equal(regexToken(String.raw`^https?:\/\/ads\.example\/track`), 'example');
  assert.equal(regexToken('foo|bar'), '', 'alternation proves nothing');
  assert.equal(regexToken('adverts?x'), '', 'a run ending in an optional character is not bounded');
  assert.equal(regexToken(String.raw`banner[0-9]+\.gif`), '', 'banner continues into digits');
});

test('$removeparam strips named, regex and all parameters, and honours exceptions', () => {
  const e = engine(['$removeparam=utm_source', '$removeparam=/^fbclid=/', '||clean.example^$removeparam', '@@||keep.example^$removeparam']);
  assert.equal(e.match(req('https://a.example/p?utm_source=x&q=1', 'a.example', 'mainFrame')).removeparam, 'https://a.example/p?q=1');
  assert.equal(e.match(req('https://a.example/p?fbclid=abc', 'a.example', 'mainFrame')).removeparam, 'https://a.example/p');
  assert.equal(e.match(req('https://clean.example/p?a=1&b=2', 'a.example', 'xhr')).removeparam, 'https://clean.example/p');
  assert.equal(e.match(req('https://keep.example/p?utm_source=x', 'a.example', 'mainFrame')).removeparam, '');
});

test('$csp adds directives to documents only', () => {
  const e = engine(['||news.example^$csp=script-src \'self\'']);
  assert.deepEqual(e.cspFor('https://news.example/a', 'news.example', 'mainFrame'), ["script-src 'self'"]);
  assert.deepEqual(e.cspFor('https://news.example/a.js', 'news.example', 'script'), []);
});

test('a rule with no pattern and nothing narrowing it is refused', () => {
  const e = engine(['$third-party', '$script,domain=only.example']);
  assert.equal(e.match(req('https://x.example/a.js', 'y.example')).blocked, false);
  assert.equal(e.match(req('https://x.example/a.js', 'only.example')).blocked, true);
});
