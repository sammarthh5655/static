const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThreatLists } = require('../src/features/netguard/threats');
const { Bounce, destination } = require('../src/features/netguard/bounce');
const { normaliseTemplate, resolverConfig } = require('../src/features/netguard/dns');
const { LEVELS, levelOf } = require('../src/features/netguard/presets');
const { siteOf, sameSite, isLocalHost, isIpAddress } = require('../src/features/netguard/site');
const { signalsScript, cappedReferrer } = require('../src/features/netguard/page-signals');
const { Settings } = require('../src/features/settings');

const lists = () => new ThreatLists(fs.mkdtempSync(path.join(os.tmpdir(), 'static-threats-')), { store: { data: {}, save() {} }, fetcher: async () => '' });

test('threat lists read hostnames, ||host^ rules and single addresses on shared hosts', () => {
  const t = lists();
  t.inject('urlhaus', 'evil.example\n||1.2.3.4/bins/x.sh^$all\n! comment\nexample.org##.ad\n');
  t.inject('phishing', '||docs.google.com/forms/d/e/abc^$all\n||phish.example^\n');
  t.inject('badware', '||scam.example^$doc\n||cosmetic.example^$script\n');
  assert.equal(t.match('https://evil.example/').kind, 'malware');
  assert.equal(t.match('https://cdn.evil.example/a.js').matched, 'evil.example', 'a listed domain covers its subdomains');
  assert.equal(t.match('http://1.2.3.4/bins/x.sh').list, 'urlhaus', 'malware served from a bare IP is matched');
  assert.equal(t.match('https://docs.google.com/forms/d/e/abc/viewform').kind, 'phishing');
  assert.equal(t.match('https://docs.google.com/forms/d/e/other'), null, 'one bad form does not list all of Google Docs');
  assert.equal(t.match('https://scam.example/').kind, 'badware');
  assert.equal(t.match('https://cosmetic.example/'), null, 'rules scoped to scripts are not whole-page rules');
  assert.equal(t.match('https://example.org/'), null, 'hiding rules are ignored');
  assert.equal(t.match('https://notevil.example/'), null);
});

test('bounce hops are skipped only to a real address on another site', () => {
  const b = new Bounce();
  assert.deepEqual(b.unwrap('https://www.google.com/url?q=https%3A%2F%2Fnews.example%2Fstory&sa=D'), { url: 'https://news.example/story', kind: 'bounce' });
  assert.equal(b.unwrap('https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F&h=AT0').url, 'https://shop.example/');
  assert.equal(b.unwrap('https://out.reddit.com/t3_abc?url=https%3A%2F%2Fblog.example%2Fp&token=x').url, 'https://blog.example/p');
  assert.equal(b.unwrap('https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com%2F&v=1').url, 'https://example.com/');
  assert.equal(b.unwrap('https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F').url, 'https://example.com/');
  assert.equal(b.unwrap('https://www.google.com/url?q=javascript%3Aalert(1)'), null, 'never a script address');
  assert.equal(b.unwrap('https://www.google.com/url?q=https%3A%2F%2Fwww.google.com%2Fmaps'), null, 'a hop within one site is left alone');
  assert.equal(b.unwrap('https://click.mail.example.com/track?url=https%3A%2F%2Fother.example%2F').url, 'https://other.example/');
  assert.equal(b.unwrap('https://link.bank.example/login?url=https%3A%2F%2Fother.example%2F'), null, 'never a sign-in path');
  assert.equal(b.unwrap('https://accounts.example.com/signin?continue=https%3A%2F%2Fother.example%2F'), null, 'sign-in redirects are never read');
  assert.equal(b.unwrap('https://go.dev/?url=https%3A%2F%2Fother.example%2F'), null, 'a site called go is not a hop');
  assert.equal(destination('https://user:pw@x.example/'), '');
});

test('AMP viewer and cache addresses go to the publisher’s page', () => {
  const b = new Bounce();
  assert.deepEqual(b.unwrap('https://www.google.com/amp/s/www.news.example/2026/story.amp'), { url: 'https://www.news.example/2026/story.amp', kind: 'amp' });
  assert.equal(b.unwrap('https://www-news-example.cdn.ampproject.org/c/s/www.news.example/story').url, 'https://www.news.example/story');
  assert.equal(b.unwrap('https://www.google.com/amp/s/www.news.example/x', { amp: false }), null);
});

test('Brave debounce rules: redirect, base64 and regex-path', () => {
  const b = new Bounce();
  const n = b.loadDebounce([
    { include: ['*://*.track.example/*'], exclude: [], action: 'redirect', param: 'dest' },
    { include: ['*://b64.example/*'], exclude: [], action: 'base64,redirect', param: 'r' },
    { include: ['*://path.example/out/*'], exclude: [], action: 'regex-path', param: '^/out/(.*)$', prepend_scheme: 'https' },
    { include: ['*://odd.example/*'], action: 'something-new', param: 'x' },
  ]);
  assert.equal(n, 3, 'an unknown action is skipped, not guessed at');
  assert.equal(b.unwrap('https://a.track.example/c?dest=https%3A%2F%2Fend.example%2F').url, 'https://end.example/');
  assert.equal(b.unwrap('https://b64.example/x?r=' + Buffer.from('https://end.example/b').toString('base64')).url, 'https://end.example/b');
  assert.equal(b.unwrap('https://path.example/out/end.example%2Fc').url, 'https://end.example/c');
});

test('secure DNS: only real https templates, and Secure without one falls back to Automatic', () => {
  assert.equal(normaliseTemplate('https://dns.example.com/dns-query{?dns}'), 'https://dns.example.com/dns-query{?dns}');
  assert.equal(normaliseTemplate('http://dns.example.com/dns-query'), '');
  assert.equal(normaliseTemplate('https://user:pw@dns.example.com/q'), '');
  assert.equal(normaliseTemplate('https://dns.example.com/{name}'), '');
  assert.equal(normaliseTemplate('https://localhost/q'), '');
  assert.deepEqual(resolverConfig({ secureDns: 'secure', secureDnsProvider: 'quad9' }), { secureDnsMode: 'secure', secureDnsServers: ['https://dns.quad9.net/dns-query'] });
  assert.deepEqual(resolverConfig({ secureDns: 'secure', secureDnsProvider: 'custom', secureDnsCustom: '' }), { secureDnsMode: 'automatic', secureDnsServers: [] });
  assert.deepEqual(resolverConfig({ secureDns: 'off' }), { secureDnsMode: 'off', secureDnsServers: [] });
});

test('tracking protection levels are read from the switches; any change by hand is Custom', () => {
  const shields = { blockTrackers: true, blockThirdPartyCookies: true, stripTracking: true };
  assert.equal(levelOf(shields, { ...LEVELS.standard.settings }), 'standard');
  assert.equal(levelOf(shields, { ...LEVELS.strict.settings }), 'strict');
  assert.equal(levelOf(shields, { ...LEVELS.standard.settings, doNotTrack: true }), 'custom');
  assert.equal(levelOf({ ...shields, stripTracking: false }, { ...LEVELS.standard.settings }), 'custom');
  assert.equal(levelOf(shields, { ...LEVELS.standard.settings, fingerprinting: undefined }), 'standard', 'a key not set yet reads as Standard');
});

test('sites, local hosts and IPs', () => {
  assert.equal(siteOf('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('mail.google.com'), 'google.com');
  assert.ok(sameSite('https://a.example.com/x', 'https://b.example.com/'));
  assert.ok(!sameSite('https://a.example.com/', 'https://example.org/'));
  for (const host of ['localhost', '127.0.0.1', '192.168.1.1', '10.0.0.2', 'printer.local', 'router', '[::1]']) assert.ok(isLocalHost(host), host);
  for (const host of ['8.8.8.8', 'example.com', 'evil.probe.test']) assert.ok(!isLocalHost(host), host);
  assert.ok(isIpAddress('8.8.8.8') && !isIpAddress('example.com'));
});

test('page signals: GPC and DNT getters, and a referrer capped to its origin across sites', () => {
  assert.equal(signalsScript({}), '');
  const script = signalsScript({ gpc: true, dnt: true, referrer: 'https://from.example/' });
  const nav = {}; const doc = {};
  new Function('Navigator', 'Document', script)({ prototype: nav }, { prototype: doc });
  assert.equal(nav.globalPrivacyControl, true);
  assert.equal(nav.doNotTrack, '1');
  assert.equal(doc.referrer, 'https://from.example/');
  assert.equal(cappedReferrer('https://from.example/secret/page?q=1', 'https://to.example/', siteOf), 'https://from.example/');
  assert.equal(cappedReferrer('https://www.to.example/page', 'https://to.example/', siteOf), null, 'within a site, as normal');
});

test('settings: network keys are validated, and a custom DNS address must be https', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-netsettings-'));
  const settings = new Settings(dir);
  assert.equal(settings.value.safeBrowsing, 'standard');
  assert.equal(settings.value.gpc, true);
  assert.equal(settings.value.doNotTrack, false);
  assert.equal(settings.value.webrtcPolicy, 'standard');
  settings.update({ safeBrowsing: 'enhanced', httpsOnly: true, webrtcPolicy: 'strict' });
  assert.equal(settings.value.safeBrowsing, 'enhanced');
  assert.throws(() => settings.update({ safeBrowsing: 'maximum' }));
  assert.throws(() => settings.update({ secureDnsCustom: 'http://dns.example/q' }), /https/);
  settings.update({ secureDnsCustom: 'https://dns.example.com/dns-query' });
  assert.equal(settings.value.secureDnsCustom, 'https://dns.example.com/dns-query');
});

test('the fake-site check Safe Browsing stops pages with leaves real sign-ins alone and still catches fakes', () => {
  const { Safety, isLookalike } = require('../src/features/safety');
  const safety = new Safety(fs.mkdtempSync(path.join(os.tmpdir(), 'static-safety-')), {});
  // What netguard stops in Enhanced, the stricter level: an imitation scoring 45 or more.
  const stopped = (url) => { const a = safety.assess(url); return !!a.imitates && a.score >= 45; };
  for (const real of [
    'https://www.amazon.co.uk/ap/signin', 'https://login.microsoftonline.com/common/oauth2/authorize',
    'https://outlook.office365.com/mail/', 'https://www.microsoft365.com/', 'https://steamcommunity.com/login',
    'https://apple.stackexchange.com/users/login', 'https://purchase.ticketmaster.com/account',
    'https://www.pineapple.com/', 'https://finance.co/', 'https://stream.me/login', 'https://email.com/',
    'https://xn--mnchen-3ya.de/', 'https://my-company-assets-bucket.s3.us-east-1.amazonaws.com/index.html',
    'https://www.google.co.uk/', 'https://discord.js.org/', 'https://paypal-community.com/t5/',
  ]) assert.equal(stopped(real), false, real);
  for (const fake of [
    'https://paypal-login.com/', 'https://paypa1.com/signin', 'https://arnazon.co.uk/', 'https://gooogle.com/',
    'https://facebok.com/login', 'https://applesupport-id.com/', 'https://xn--pple-43d.com/',
    'https://chase.com.verify-acct.ru/', 'https://paypal.weird.xyz/login',
  ]) assert.equal(stopped(fake), true, fake);
  // Standard (60) stops the plain imitations too.
  assert.ok(safety.assess('https://paypal-login.com/').score >= 60);
  // Real words one letter from a brand are not near-misses; slips are.
  for (const [word, brand] of [['finance', 'binance'], ['stream', 'steam'], ['email', 'gmail'], ['cloud', 'icloud']]) assert.equal(isLookalike(word, brand), false, word);
  for (const [word, brand] of [['paypai', 'paypal'], ['gogole', 'google'], ['amazzon', 'amazon'], ['micr0soft', 'microsoft']]) assert.equal(isLookalike(word, brand), true, word);
});

test('bounce hops are only skipped for links, and HTTPS-only asks about a site that quietly fell back', () => {
  const { NetGuard } = require('../src/features/netguard');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-guard-'));
  const recorded = [];
  const settings = { value: { safeBrowsing: 'off', httpsOnly: false, bounceTracking: true, ampSkip: true } };
  const browser = { dir, settings, shields: { stats: { record: (k) => recorded.push(k) } }, safety: null };
  const guard = new NetGuard(browser);
  const hop = 'https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fpage';
  assert.equal(guard.inspect({ url: hop, resourceType: 'mainFrame', method: 'GET', webContentsId: 1 }, null)?.redirect, 'https://example.org/page');
  assert.equal(guard.inspect({ url: hop, resourceType: 'mainFrame', method: 'POST', webContentsId: 1 }, null), null);
  guard.httpThisSession.add('plain.example');
  assert.deepEqual(guard.inspect({ url: 'http://plain.example/', resourceType: 'mainFrame', method: 'GET', webContentsId: 1 }, null), { skipUpgrade: true, allowSite: undefined });
  settings.value.httpsOnly = true;
  assert.equal(guard.inspect({ url: 'http://plain.example/', resourceType: 'mainFrame', method: 'GET', webContentsId: 1 }, null)?.redirect, 'https://plain.example/');
});
