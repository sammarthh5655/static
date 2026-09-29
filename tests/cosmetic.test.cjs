const test = require('node:test');
const assert = require('node:assert/strict');
const { CosmeticIndex, parseLine, hostKeys } = require('../src/features/shields/cosmetic');

test('each kind of cosmetic line is recognised for what it is', () => {
  assert.equal(parseLine('##.ad').kind, 'css');
  assert.equal(parseLine('example.com##.box:has-text(Sponsored)').kind, 'procedural');
  assert.equal(parseLine('example.com#?#.box:-abp-has(.ad)').kind, 'procedural');
  assert.equal(parseLine('example.com##+js(set-constant, ads, false)').kind, 'scriptlet');
  assert.equal(parseLine('example.com##+js(set-constant, ads, false)').body, 'set-constant, ads, false');
  assert.equal(parseLine('example.com#@#.ad').exception, true);
  assert.equal(parseLine('example.com#$#.ad { visibility: hidden !important; }').body, '.ad:style(visibility: hidden !important;)');
  assert.equal(parseLine('##.x { color: red }'), null, 'no rule-set punctuation in plain CSS');
  assert.deepEqual(parseLine('a.com,~b.a.com##.ad').exclude, ['b.a.com']);
});

test('a site gets its own and generic rules, minus exclusions and exceptions', () => {
  const index = new CosmeticIndex();
  for (const line of ['##.ad', '##.banner', 'news.example##.promo', 'example##.cookie',
    '~quiet.example##.loud', 'news.example#@#.banner', 'news.example##.card:has-text(Ad)',
    'news.example##+js(set-constant, adsOn, false)', 'google.*##.sponsored']) index.add(line);
  const news = index.forHost('www.news.example');
  assert.equal(news.selectorCount, 4, '.ad, .promo, .cookie (parent domain), .loud; .banner is excepted');
  assert.ok(!news.css.includes('.banner'));
  assert.deepEqual(news.procedural, ['.card:has-text(Ad)']);
  assert.deepEqual(news.scriptlets, ['set-constant, adsOn, false']);
  assert.ok(!index.forHost('quiet.example').css.includes('.loud'));
  assert.ok(index.forHost('www.google.co.uk').css.includes('.sponsored'), 'entity rules match any TLD');
  assert.ok(!index.forHost('news.example', { generic: false }).css.includes('.ad'), '$generichide drops generic rules');
});

test('one selector a browser rejects cannot switch off every other', () => {
  const index = new CosmeticIndex();
  for (let i = 0; i < 200; i++) index.add('##.ad-' + i);
  const css = index.forHost('x.example').css;
  assert.ok(css.split('{ display: none !important; }').length - 1 >= 3, 'split into several rules');
});

test('trusted scriptlets only from trusted lists; #@#+js() switches a site off', () => {
  const index = new CosmeticIndex();
  index.add('a.example##+js(trusted-set-constant, x, 1)');
  index.add('a.example##+js(trusted-set-constant, y, 1)', { trusted: true });
  assert.deepEqual(index.forHost('a.example').scriptlets, ['trusted-set-constant, y, 1']);
  index.add('b.example##+js(set-constant, z, 0)');
  index.add('b.example#@#+js()');
  assert.deepEqual(index.forHost('b.example').scriptlets, []);
});

test('host keys cover parents and name.* forms', () => {
  assert.deepEqual(hostKeys('a.b.example.com'), ['a.b.example.com', 'a.*', 'b.example.com', 'b.*', 'example.com', 'example.*', 'com']);
});
