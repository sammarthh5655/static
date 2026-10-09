const test = require('node:test');
const assert = require('node:assert/strict');
const { clean } = require('../src/features/pagetools/reader');
const { readerSource, internalPage, allowedURL } = require('../src/shared/urls');

/**
 * Reading view's sanitiser. What the page hands back is the page's to
 * decide, so it is treated as hostile: only allow-listed tags survive, only a
 * few attributes, and only http(s) addresses.
 */

const words = (n) => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');
const article = (content, extra = {}) => ({ url: 'https://news.example/story', title: 'A story', site: 'News', content, ...extra });

/** Every tag and attribute anywhere in a cleaned tree. */
function inventory(tree) {
  const tags = new Set();
  const attrs = new Set();
  const values = [];
  const walk = (node) => {
    if (typeof node === 'string') return;
    tags.add(node[0]);
    for (const [k, v] of Object.entries(node[1] || {})) { attrs.add(node[0] + '.' + k); values.push(String(v)); }
    node.slice(2).forEach(walk);
  };
  tree.forEach(walk);
  return { tags, attrs, values };
}

test('an ordinary article comes through with its structure', () => {
  const out = clean(article([
    ['p', null, words(30), ['a', { href: 'https://other.example/x' }, 'a link'], '.'],
    ['h2', null, 'A heading'],
    ['p', null, words(30), ['strong', null, 'bold'], ['em', null, 'italic']],
    ['figure', null, ['img', { src: 'https://cdn.example/p.jpg', alt: 'A photo', width: 800, height: 600 }], ['figcaption', null, 'Caption']],
    ['ul', null, ['li', null, 'one'], ['li', null, 'two']],
  ]));
  assert.ok(out);
  assert.equal(out.title, 'A story');
  assert.equal(out.minutes, 1);
  const { tags } = inventory(out.content);
  for (const tag of ['p', 'a', 'h2', 'strong', 'em', 'figure', 'img', 'figcaption', 'ul', 'li']) assert.ok(tags.has(tag), tag);
});

test('scripts, styles, frames and event handlers do not survive', () => {
  const out = clean(article([
    ['p', { onclick: 'alert(1)', style: 'color:red', class: 'x', id: 'y' }, words(50)],
    ['script', null, 'alert(1)'],
    ['style', null, 'body{display:none}'],
    ['iframe', { src: 'https://evil.example' }, 'frame text'],
    ['section', { class: 'wrapper' }, 'wrapped text'],
    ['img', { src: 'https://cdn.example/a.png', onerror: 'alert(1)', srcset: 'javascript:alert(1)' }],
    ['svg', null, ['script', null, 'alert(2)']],
    ['object', { data: 'x' }, ''],
  ]));
  const { tags, attrs, values } = inventory(out.content);
  for (const bad of ['script', 'style', 'iframe', 'svg', 'object']) assert.ok(!tags.has(bad), bad);
  assert.deepEqual([...attrs].filter((a) => !['img.src', 'img.alt'].includes(a)), []);
  assert.ok(!values.some((v) => /alert|javascript/i.test(v)), values.join(' '));
  // An unknown wrapper is unwrapped to its text, never kept; a frame or a
  // script goes with everything in it.
  assert.ok(JSON.stringify(out.content).includes('wrapped text'));
  assert.ok(!JSON.stringify(out.content).includes('frame text'));
  assert.ok(!tags.has('section'));
});

test('only http and https addresses, with no passwords in them', () => {
  const out = clean(article([
    ['p', null, words(50),
      ['a', { href: 'javascript:alert(1)' }, 'js'],
      ['a', { href: 'data:text/html,<script>alert(1)</script>' }, 'data'],
      ['a', { href: 'file:///C:/secret' }, 'file'],
      ['a', { href: 'https://user:pass@site.example/' }, 'creds'],
      ['a', { href: '  JaVaScRiPt:alert(1)' }, 'spaced']],
    ['img', { src: 'javascript:alert(1)' }],
    ['img', { src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }],
    ['img', { src: 'data:image/png;base64,iVBORw0KGgo=' }],
  ]));
  const { values } = inventory(out.content);
  assert.ok(values.every((v) => /^(https:\/\/|data:image\/png)/.test(v) || !/[:/]/.test(v)), values.join(' | '));
  assert.ok(values.includes('https://site.example/'), 'credentials are stripped from links');
  // The text of a refused link stays; the link does not.
  assert.ok(JSON.stringify(out.content).includes('"js"'));
});

test('loose text and inline pieces between blocks become paragraphs', () => {
  const out = clean(article([words(30), ['em', null, 'emphasis'], ['h2', null, 'Next'], words(30)]));
  assert.deepEqual(out.content.map((n) => n[0]), ['p', 'h2', 'p']);
});

test('a blank line made of two <br>s is a paragraph break', () => {
  // How hand-made essays (and many old blogs) space their paragraphs.
  const out = clean(article([words(30), ['br'], ' ', ['br'], words(30), ['br'], ['br'], ['br'], words(10), ['br'], 'same paragraph',
    ['p', null, words(20), ['br'], ['br'], words(20)]]));
  assert.deepEqual(out.content.map((n) => n[0]), ['p', 'p', 'p', 'p', 'p']);
  // A single <br> is a line break inside the paragraph, and stays.
  assert.ok(out.content[2].some((n) => Array.isArray(n) && n[0] === 'br'));
  assert.ok(!out.content.some((p) => Array.isArray(p[2]) && p[2][0] === 'br'), 'no paragraph starts with a break');
});

test('nothing worth reading is no article', () => {
  assert.equal(clean(article([['p', null, 'Too short.']])), null);
  assert.equal(clean(null), null);
  assert.equal(clean({ content: 'not a list' }), null);
  assert.equal(clean(article([['script', null, words(200)]])), null);
});

test('limits hold against a page that tries to exhaust them', () => {
  let deep = words(60);
  for (let i = 0; i < 500; i++) deep = ['em', null, deep];
  const out = clean(article([['p', null, words(60)], ['p', null, deep]]));
  assert.ok(out);
  const many = Array.from({ length: 50000 }, () => ['p', null, 'x y z']);
  const big = clean(article(many));
  assert.ok(big.content.length < 25000, String(big.content.length));
});

test('metadata is plain text, trimmed and bounded', () => {
  const out = clean(article([['p', null, words(60)]], {
    title: '  <b>Title</b>\n\twith   space ' + 'x'.repeat(1000), byline: 'By <script>Someone</script>',
    published: '2024-03-05T10:00:00Z', lang: 'en-GB"><script>', dir: 'sideways', url: 'javascript:alert(1)',
  }), 'https://news.example/real');
  assert.ok(out.title.startsWith('<b>Title</b> with space'), out.title);
  assert.ok(out.title.length <= 300);
  assert.equal(out.lang, '');
  assert.equal(out.dir, 'ltr');
  assert.equal(out.url, 'https://news.example/real');
  assert.equal(out.published, '2024-03-05T10:00:00.000Z');
});

test('browser://reader names the article it shows, and only a web one', () => {
  assert.equal(internalPage('browser://reader?url=' + encodeURIComponent('https://a.example/x')), 'reader');
  assert.ok(allowedURL('browser://reader?url=' + encodeURIComponent('https://a.example/x')));
  assert.equal(readerSource('browser://reader?url=' + encodeURIComponent('https://a.example/x?y=1#z')), 'https://a.example/x?y=1#z');
  assert.equal(readerSource('browser://reader?url=' + encodeURIComponent('javascript:alert(1)')), '');
  assert.equal(readerSource('browser://reader?url=' + encodeURIComponent('file:///etc/passwd')), '');
  assert.equal(readerSource('browser://settings?url=https%3A%2F%2Fa.example'), '');
  assert.equal(readerSource('https://a.example/'), '');
});
