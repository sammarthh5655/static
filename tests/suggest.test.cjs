const test = require('node:test');
const assert = require('node:assert');
const { remoteAllowed, looksLikeAddress, parseRemote, mergeSuggestions, stillMatching, highlightParts } = require('../src/shared/suggest');
const { SearchSuggestions } = require('../src/features/suggest');

// Plain Node, no Electron: the fetcher is a stub that answers like an engine.

test('ordinary searches may be sent for suggestions', () => {
  for (const q of ['how tall is everest', 'git', 'covid-19 symptoms', 'mp3 to wav', "o'reilly books"]) {
    assert.strictEqual(remoteAllowed(q), true, q);
  }
});

test('addresses, internal pages and schemes never leave the computer', () => {
  for (const q of ['example.com', 'www.bbc', 'https://example.com/a', 'browser://settings', 'about:blank',
    'javascript:alert(1)', 'file:///etc/passwd', 'localhost:3000', '192.168.0.1', '/home/me', 'node.js']) {
    assert.strictEqual(remoteAllowed(q), false, q);
  }
});

test('emails, passwords, keys and long numbers are kept private', () => {
  for (const q of ['me@example.com', 'mail jo@work.co.uk about it', 'Hunter2!', 'P@ssw0rd', 'aB3dE5fGh',
    'sk_live_abcdefghijklmnop1234', '4111 1111 1111 1111', '07700900123', 'call 0770-090-0123 now']) {
    assert.strictEqual(remoteAllowed(q), false, q);
  }
  assert.strictEqual(remoteAllowed(''), false);
  assert.strictEqual(remoteAllowed('x'.repeat(121)), false);
});

test('what navigates is labelled as going there', () => {
  assert.strictEqual(looksLikeAddress('github.com'), true);
  assert.strictEqual(looksLikeAddress('browser://history'), true);
  assert.strictEqual(looksLikeAddress('github'), false);
  assert.strictEqual(mergeSuggestions('github.com', {})[0].kind, 'go');
  assert.strictEqual(mergeSuggestions('github', {})[0].kind, 'search');
});

test('engine answers are read defensively', () => {
  assert.deepStrictEqual(parseRemote('["ga",["gal","gadot","Gal","https://ga.com"],[],[],{"google:suggesttype":["QUERY","QUERY","QUERY","NAVIGATION"]}]', 'ga'), ['gal', 'gadot']);
  assert.deepStrictEqual(parseRemote('["ga",["ga","gap\\u0007 year"]]', 'ga'), ['gap year']);
  assert.deepStrictEqual(parseRemote('not json', 'x'), []);
  assert.deepStrictEqual(parseRemote('{"a":1}', 'x'), []);
  assert.deepStrictEqual(parseRemote('["x",[1,null,{"a":"b"},"ok"]]', 'x'), ['ok']);
  assert.strictEqual(parseRemote(JSON.stringify(['x', ['y'.repeat(500)]]), 'x')[0].length, 160);
});

test('one list: typed search first, then a matching site, then searches, then pages', () => {
  const rows = mergeSuggestions('git', {
    searches: ['github', 'git commands', 'GIT'],
    pages: [
      { url: 'https://example.com/git', title: 'Git notes', source: 'history' },
      { url: 'https://github.com/explore', title: 'Explore GitHub', source: 'bookmark' },
      { url: 'https://www.google.com/search?q=git+rebase', title: 'git rebase - Google Search', source: 'history' },
    ],
  });
  assert.deepStrictEqual(rows.map((r) => r.kind + ':' + (r.query || r.url)), [
    'search:git',
    'page:https://github.com/explore',
    'search:github',
    'search:git commands',
    'search:git rebase',
    'page:https://example.com/git',
  ]);
  assert.strictEqual(rows[1].source, 'bookmark');
  assert.strictEqual(rows[4].past, true);
  assert.ok(mergeSuggestions('a', { searches: Array.from({ length: 20 }, (_, i) => 'a' + i) }).length <= 8);
});

test('the last answer narrows while the next is on its way', () => {
  assert.deepStrictEqual(stillMatching(['galaxy', 'gal gadot', 'garden'], 'gal'), ['galaxy', 'gal gadot']);
  assert.deepStrictEqual(highlightParts('Explore GitHub', 'git'), ['Explore ', 'Git', 'Hub']);
  assert.deepStrictEqual(highlightParts('abc', 'zz'), ['abc', '', '']);
});

function stubEngine(answers, log, delay = 0) {
  return async (url, options) => {
    log.push({ url, options });
    const q = decodeURIComponent(url.split('q=')[1]);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
    });
    return { ok: true, text: async () => JSON.stringify([q, answers[q] || []]) };
  };
}

test('the service asks the chosen engine, without cookies, and caches', async () => {
  const log = [];
  let engine = 'google';
  const service = new SearchSuggestions({ fetcher: stubEngine({ cat: ['cats', 'cat food'] }, log), engine: () => engine });
  const first = await service.lookup('cat', 1);
  assert.deepStrictEqual(first.searches, ['cats', 'cat food']);
  assert.match(log[0].url, /^https:\/\/suggestqueries\.google\.com\/complete\/search\?client=chrome&q=cat$/);
  assert.strictEqual(log[0].options.credentials, 'omit');
  await service.lookup('CAT', 1);
  assert.strictEqual(log.length, 1, 'answered from the cache');
  engine = 'brave';
  await service.lookup('cat', 1);
  assert.match(log[1].url, /^https:\/\/search\.brave\.com\/api\/suggest\?q=cat$/);
});

test('the service refuses in incognito, when switched off, and for private text', async () => {
  const log = [];
  const fetcher = stubEngine({}, log);
  let on = true;
  const normal = new SearchSuggestions({ fetcher, enabled: () => on });
  assert.strictEqual((await normal.lookup('me@example.com', 1)).remote, false);
  assert.strictEqual((await normal.lookup('browser://settings', 1)).remote, false);
  on = false;
  assert.strictEqual((await normal.lookup('weather', 1)).remote, false);
  const incognito = new SearchSuggestions({ fetcher, incognito: true });
  assert.strictEqual((await incognito.lookup('weather', 1)).remote, false);
  assert.strictEqual(log.length, 0, 'nothing was sent');
});

test('a newer keystroke cancels the older request', async () => {
  const log = [];
  const service = new SearchSuggestions({ fetcher: stubEngine({ ga: ['gap'], gal: ['galaxy'] }, log, 40) });
  const older = service.lookup('ga', 7);
  const newer = service.lookup('gal', 7);
  const [a, b] = await Promise.all([older, newer]);
  assert.strictEqual(a.stale, true);
  assert.deepStrictEqual(a.searches, []);
  assert.deepStrictEqual(b.searches, ['galaxy']);
  // A different asker is not affected by this one.
  const other = service.lookup('gap', 8);
  service.cancel(7);
  assert.strictEqual((await other).stale, undefined);
});

test('the start of an email address is private too, a bare handle is not', () => {
  for (const q of ['jo@', 'jo@gmail', 'write to jo@exa']) assert.strictEqual(remoteAllowed(q), false, q);
  assert.strictEqual(remoteAllowed('@nasa'), true);
});

test('an engine suggesting an address is offered as going there', () => {
  const rows = mergeSuggestions('youtube', { searches: ['youtube music', 'youtube.com'] });
  assert.deepStrictEqual(rows.map((r) => r.kind + ':' + (r.query || r.url)),
    ['search:youtube', 'search:youtube music', 'go:youtube.com']);
});

test('answers are decoded in the charset the engine names', async () => {
  const { readBody } = require('../src/features/suggest');
  const latin1 = Uint8Array.from([0x5b, 0x22, 0x63, 0x61, 0x66, 0xe9, 0x22, 0x5d]); // ["café"] in ISO-8859-1
  const answer = (bytes, type) => ({ arrayBuffer: async () => bytes.buffer, headers: { get: () => type } });
  assert.strictEqual(await readBody(answer(latin1, 'text/javascript; charset=ISO-8859-1')), '["café"]');
  const utf8 = new TextEncoder().encode('["café"]');
  assert.strictEqual(await readBody(answer(utf8, 'application/json')), '["café"]');
  assert.strictEqual(await readBody(answer(utf8, 'text/plain; charset=nonsense')), '["café"]');
});
