const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { decode, sample } = require('./qr.decoder.cjs');

/**
 * Page tools, used the way a person uses them, off-screen:
 *
 * - Reading view: the book appears on an article and not on a home page; one
 *   click opens a clean, sanitised article (nothing from the page's scripts,
 *   handlers or javascript: links survives; pictures load with no referrer);
 *   size, width and colours change and are remembered; one click goes back.
 * - Screenshots: from the page's right-click menu and the main menu - the
 *   visible area, the full page and a dragged area - each to a card whose
 *   Copy and Save really copy and save (to a stand-in Pictures folder).
 * - QR code: from the address bar and the right-click menu; the code on the
 *   card, the copied picture and the saved file are each DECODED here and
 *   must give back the page's address exactly.
 *
 * Pictures land in shots/pagetools-*.png.
 */

const PARA = [
  'The overnight sleeper pulled out of the station just after nine, its windows glowing amber against a sky that had not quite decided to be dark, and for the forty or so passengers on board, the journey had already begun to feel like a small act of rebellion against the tyranny of the departure lounge.',
  'Rail operators across the continent, long convinced that night trains were a relic, have spent the last five years quietly reversing course, buying new carriages, reopening routes that closed in the nineties, and discovering, somewhat to their surprise, that people will happily pay for the privilege of waking up somewhere else.',
  'Part of the appeal is practical: a sleeper that leaves the city centre in the evening and arrives in another city centre the next morning saves a night in a hotel, two trips to an airport, and the particular weariness of security queues, shoe removal and the ritual unpacking of liquids into small plastic bags.',
  'But talk to the people who ride them, and the practical case quickly gives way to something harder to measure, a sense that the journey itself, with its rocking compartments, its corridor conversations and its strange, suspended hours, is a thing worth having rather than a gap to be endured.',
];

function articlePage(base) {
  const paras = (n, offset = 0) => Array.from({ length: n }, (_, i) => `<p>${PARA[(i + offset) % PARA.length]}</p>`).join('\n');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<title>The quiet return of the night train | The Example Times</title>
<meta property="og:site_name" content="The Example Times">
<meta property="og:title" content="The quiet return of the night train">
<meta name="author" content="Ada Lovelace">
<meta property="article:published_time" content="2025-06-14T08:00:00Z">
<style>
  body { margin: 0; font: 17px/1.6 Georgia, serif; background: #fff; color: #222; }
  .site-header { background: #b3122e; color: #fff; padding: 14px 24px; font: 700 22px sans-serif; }
  .site-header nav a { color: #fff; margin-right: 14px; font-size: 14px; }
  .layout { display: flex; gap: 32px; max-width: 1100px; margin: 0 auto; padding: 24px; }
  main { flex: 1; } aside { width: 260px; font: 14px sans-serif; }
  .share-bar a { margin-right: 8px; } .ad-slot { background: #fde68a; padding: 40px; text-align: center; }
  h1 { font-size: 36px; line-height: 1.15; } figure { margin: 24px 0; } img { max-width: 100%; }
</style></head><body>
<header class="site-header">The Example Times <nav><a href="/">Home</a><a href="/world">World</a><a href="/travel">Travel</a><a href="/opinion">Opinion</a></nav></header>
<div class="layout"><main><article class="post-content">
<h1>The quiet return of the night train</h1>
<div class="share-bar"><a href="#share">Share</a><a href="#tweet">Tweet</a><a href="#mail">Email</a></div>
${paras(3)}
<figure><img src="/photo.png" width="640" height="320" alt="A sleeper train at dusk"><figcaption>A sleeper leaves the city at dusk.</figcaption></figure>
<p>Operators such as <a href="https://rail.example/sleepers">the new sleeper companies</a> say demand has outstripped every forecast they made.</p>
<blockquote><p>We thought we were selling transport. It turns out we were selling time.</p></blockquote>
<h2>Why now</h2>
<ul><li>Cheaper, longer-lasting carriages.</li><li>Airports that have become an ordeal.</li><li>A generation that counts its carbon.</li></ul>
<p>Some of the page is hostile: <img src="/nothing" onerror="window.__pwned = 'img'"> an image with a handler, and <a href="javascript:window.__pwned='link'">a link that runs script</a>, sit in the middle of this paragraph, which is otherwise just more words about trains and the people who love them.</p>
<p><img data-src="/lazy.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="600" height="300" alt="A lazy picture"></p>
<div class="ad-slot">Advertisement</div>
<script>window.pageScriptRan = true;</script>
${paras(8, 1)}
</article></main>
<aside class="sidebar"><h3>Most read</h3><ul>
<li><a href="${base}/a">Ten things about trains</a></li><li><a href="${base}/b">The best seat on the bus</a></li>
<li><a href="${base}/c">Why ferries are back</a></li><li><a href="${base}/d">Bicycles, again</a></li></ul></aside></div>
<section class="comments"><h3>Comments</h3><p>First!</p><p>Great article, would ride again.</p></section>
<footer>© The Example Times</footer></body></html>`;
}

const HOME = `<!doctype html><html><head><title>Example home</title></head><body>
<nav><a href="/a">News</a> <a href="/b">Sport</a> <a href="/c">Weather</a></nav>
<h1>Welcome</h1><p>Short and sweet.</p><ul><li><a href="/x">One</a></li><li><a href="/y">Two</a></li></ul></body></html>`;

async function run(browser) {
  const { app, clipboard, nativeImage } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 260) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 50, ms = 120) => {
    for (let i = 0; i < tries; i++) {
      const v = await Promise.resolve().then(fn).catch(() => null);
      if (v) return v;
      await wait(ms);
    }
    return null;
  };

  // Saves go to stand-in folders, never the real Pictures and Downloads.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'static-pagetools-'));
  app.setPath('pictures', path.join(scratch, 'Pictures'));
  app.setPath('downloads', path.join(scratch, 'Downloads'));
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });

  // Pictures for the article, made here: a photo-like gradient.
  const photo = (() => {
    const w = 640; const h = 320; const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = 120 + (x * 100) / w; buf[i + 1] = 60 + (y * 80) / h; buf[i + 2] = 40 + (x * 40) / w; buf[i + 3] = 255;
    }
    return nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
  })();
  const imageRequests = [];
  const server = http.createServer((req, res) => {
    if (/^\/(photo|lazy)\.png/.test(req.url)) {
      imageRequests.push({ url: req.url, referer: req.headers.referer || '' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(photo);
      return;
    }
    res.writeHead(req.url === '/nothing' ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.url.startsWith('/article') ? articlePage(base) : HOME);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const articleUrl = base + '/article?id=42&utm=probe';

  const overlay = () => browser.overlay.webContents;
  const chrome = () => browser.chrome.webContents;
  const rectOf = (wc, selector, text) => wc.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const n = ${text ? `nodes.find((x) => x.textContent.includes(${JSON.stringify(text)}))` : 'nodes[0]'};
    if (!n) return null;
    const b = n.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), left: b.left, top: b.top, width: b.width, height: b.height };
  })()`);
  /** A real click, through the input pipeline. */
  const click = async (wc, at, button = 'left') => {
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await wait(50);
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button, clickCount: 1 });
  };
  const clickOn = async (wc, selector, text) => {
    const at = await until(() => rectOf(wc, selector, text));
    if (!at) return false;
    await click(wc, at);
    return true;
  };
  const key = (wc, keyCode) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const closeMenu = async () => {
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`));
    await wait(200);
  };
  /** The picture on the clipboard, if there is one (Electron's clipboard is asynchronous now). */
  const clipImage = async () => {
    try {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'));
      if (!item) return null;
      const image = nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer()));
      return image.isEmpty() ? null : image;
    } catch { return null; }
  };
  /** Until the overlay's entrances have played (the halo turns for ever, so it does not count). */
  const settledOverlay = () => until(() => overlay().executeJavaScript(
    `document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length === 0`), 60);
  const loaded = (wc, prefix) => until(() => !wc.isLoading() && wc.getURL().startsWith(prefix), 80);

  /** The whole window as a person would see it: every view, in order, the overlay on top. */
  const windowShot = async (name) => {
    const views = browser.window.contentView.children.filter((v) => v.webContents && !v.webContents.isDestroyed() && v.getBounds().width > 2 && v.getVisible?.() !== false);
    const parts = [];
    for (const view of views) {
      const image = await view.webContents.capturePage().catch(() => null);
      if (image && !image.isEmpty()) parts.push({ b: view.getBounds(), image });
    }
    if (!parts.length) return;
    const content = browser.window.getContentBounds();
    const scale = parts[0].image.getSize().width / parts[0].b.width;
    const W = Math.round(content.width * scale); const H = Math.round(content.height * scale);
    const out = Buffer.alloc(W * H * 4, 0);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    for (const { b, image } of parts) {
      const size = image.getSize(); const bmp = image.toBitmap();
      const ox = Math.round(b.x * scale); const oy = Math.round(b.y * scale);
      for (let y = 0; y < size.height; y++) {
        const ty = oy + y; if (ty < 0 || ty >= H) continue;
        for (let x = 0; x < size.width; x++) {
          const tx = ox + x; if (tx < 0 || tx >= W) continue;
          const s = (y * size.width + x) * 4; const d = (ty * W + tx) * 4; const a = bmp[s + 3] / 255;
          if (a <= 0) continue;
          for (let c = 0; c < 3; c++) out[d + c] = Math.min(255, Math.round(bmp[s + c] + out[d + c] * (1 - a)));
        }
      }
    }
    fs.writeFileSync(path.join(shots, 'pagetools-' + name + '.png'), nativeImage.createFromBitmap(out, { width: W, height: H }).toPNG());
  };

  try {
    await wait(1500);
    browser.settings.update({ tabLayout: 'horizontal', sidebarMode: 'off', reader: { size: 20, width: 'medium', font: 'serif', theme: '' } });
    browser.applyTabLayout?.();
    browser.applySidebarMode?.();
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const tab = browser.tabs.active;
    const page = tab.view.webContents;

    /* ---- reading view ---------------------------------------------------- */

    browser.tabs.navigate(tab.id, base + '/home');
    await loaded(page, base + '/home');
    await wait(900);
    check('a home page is not offered reading view',
      browser.state().reader && !browser.state().reader.available && await chrome().executeJavaScript(`document.getElementById('reader').hidden`),
      JSON.stringify(browser.state().reader));

    browser.tabs.navigate(tab.id, articleUrl);
    await loaded(page, articleUrl);
    const offered = await until(() => browser.state().reader?.available, 40);
    check('an article is offered reading view', !!offered, JSON.stringify(browser.state().reader));
    const bookShown = await until(() => chrome().executeJavaScript(`!document.getElementById('reader').hidden`));
    check('the book appears in the address bar', !!bookShown);
    await windowShot('article');

    imageRequests.length = 0;
    await clickOn(chrome(), '#reader');
    const opened = await until(() => tab.state.internalUrl?.startsWith('browser://reader') && !page.isLoading(), 60);
    check('one click opens reading view', !!opened, tab.state.internalUrl);
    check('the address bar keeps the article address', browser.tabs.activeState().url === articleUrl,
      browser.tabs.activeState().url);
    check('the book is lit while reading', await until(() => chrome().executeJavaScript(`document.getElementById('reader').classList.contains('on')`)));

    const view = await until(() => page.executeJavaScript(`(() => {
      const body = document.querySelector('.rd-body');
      if (!body) return null;
      const all = [...document.querySelectorAll('*')];
      return {
        title: document.querySelector('.rd-title')?.textContent,
        kicker: document.querySelector('.rd-kicker')?.textContent,
        meta: document.querySelector('.rd-meta')?.textContent,
        paragraphs: body.querySelectorAll('p').length,
        figure: !!body.querySelector('figure img[src$="/photo.png"]'),
        caption: body.querySelector('figcaption')?.textContent,
        lazy: !!body.querySelector('img[src$="/lazy.png"]'),
        quote: !!body.querySelector('blockquote'), list: body.querySelectorAll('li').length, heading: body.querySelector('h2')?.textContent,
        link: body.querySelector('a[href="https://rail.example/sleepers"]')?.textContent,
        handlers: all.filter((n) => [...n.attributes].some((a) => /^on/i.test(a.name))).length,
        scripts: [...document.scripts].filter((s) => !s.src).length,
        badLinks: [...document.querySelectorAll('a')].filter((a) => !/^https?:/.test(a.href)).map((a) => a.href),
        styles: body.querySelectorAll('[style]').length,
        classes: [...body.querySelectorAll('[class]')].map((n) => n.className).filter((c) => !/^(rd-|is-)/.test(c)),
        furniture: /Advertisement|Most read|First!|Share|Tweet|Example home/.test(body.textContent),
        noReferrer: [...body.querySelectorAll('img')].every((i) => i.referrerPolicy === 'no-referrer'),
        pwned: window.__pwned || null, pageScript: !!window.pageScriptRan,
        theme: document.body.dataset.theme,
        docTitle: document.title,
      };
    })()`));
    check('the article: headline, site and byline', view && view.title === 'The quiet return of the night train' &&
      view.kicker === 'The Example Times' && /Ada Lovelace/.test(view.meta) && /min read/.test(view.meta), JSON.stringify(view));
    check('the article: its paragraphs, figure, caption, quote, list and heading',
      view && view.paragraphs >= 12 && view.figure && view.caption === 'A sleeper leaves the city at dusk.' && view.quote &&
      view.list === 3 && view.heading === 'Why now' && view.link === 'the new sleeper companies', JSON.stringify(view));
    check('a lazily loaded picture is shown by its real address', view?.lazy, JSON.stringify(view));
    check('none of the page around it: no navigation, sidebar, comments, share bar or advert', view && !view.furniture);
    check('nothing executable survives: no handlers, no inline scripts, no javascript: links, no styles',
      view && view.handlers === 0 && view.scripts === 0 && view.badLinks.length === 0 && view.styles === 0 && view.classes.length === 0 && !view.pwned && !view.pageScript,
      JSON.stringify({ handlers: view?.handlers, scripts: view?.scripts, badLinks: view?.badLinks, classes: view?.classes, pwned: view?.pwned }));
    check('the tab is named after the article', view?.docTitle === 'The quiet return of the night train', view?.docTitle);
    await until(() => imageRequests.length >= 1, 30);
    check('pictures are fetched with no referrer', imageRequests.length >= 1 && imageRequests.every((r) => !r.referer),
      JSON.stringify(imageRequests));
    check('every picture is asked for with no referrer', !!view?.noReferrer);

    await wait(900);
    await windowShot('reader-' + view?.theme);

    // Size, width, colours: real clicks on the reader's own controls.
    const fontBefore = await page.executeJavaScript(`parseFloat(getComputedStyle(document.querySelector('.rd-body p')).fontSize)`);
    await clickOn(page, '#bigger');
    await clickOn(page, '#bigger');
    await clickOn(page, '[data-pref="theme:sepia"]');
    await clickOn(page, '[data-pref="width:wide"]');
    await clickOn(page, '[data-pref="font:sans"]');
    await wait(500);
    const after = await page.executeJavaScript(`({
      size: parseFloat(getComputedStyle(document.querySelector('.rd-body p')).fontSize),
      theme: document.body.dataset.theme, bg: getComputedStyle(document.body).backgroundColor,
      width: document.querySelector('.rd-article').getBoundingClientRect().width,
      font: getComputedStyle(document.querySelector('.rd-body p')).fontFamily,
      pressed: [...document.querySelectorAll('[aria-pressed=true]')].map((b) => b.dataset.pref),
    })`);
    check('larger text, twice', after.size > fontBefore + 3, fontBefore + ' -> ' + after.size);
    check('sepia colours', after.theme === 'sepia' && after.bg === 'rgb(244, 236, 216)', after.theme + ' ' + after.bg);
    check('the controls show what is chosen', ['theme:sepia', 'width:wide', 'font:sans'].every((p) => after.pressed.includes(p)), after.pressed.join(','));
    check('and it is remembered for the next article',
      browser.settings.value.reader.theme === 'sepia' && browser.settings.value.reader.width === 'wide' &&
      browser.settings.value.reader.font === 'sans' && browser.settings.value.reader.size === after.size,
      JSON.stringify(browser.settings.value.reader));
    await page.executeJavaScript('scrollTo(0, 900)');
    await wait(700);
    await windowShot('reader-sepia-scrolled');
    const progress = await page.executeJavaScript(`parseFloat(document.getElementById('progress').style.getPropertyValue('--done'))`);
    check('the reading line along the top moves as you read', progress > 0.1, String(progress));
    await page.executeJavaScript('scrollTo(0, document.documentElement.scrollHeight)');
    await until(() => imageRequests.some((r) => r.url === '/lazy.png'), 30);
    check('a picture further down loads as it comes into view, with no referrer either',
      imageRequests.some((r) => r.url === '/lazy.png') && imageRequests.every((r) => !r.referer), JSON.stringify(imageRequests));
    await clickOn(page, '[data-pref="theme:light"]');
    await clickOn(page, '[data-pref="font:serif"]');
    await clickOn(page, '[data-pref="width:medium"]');
    await page.executeJavaScript('scrollTo(0, 0)');
    await wait(600);
    await windowShot('reader-light');
    await clickOn(page, '[data-pref="theme:dark"]');
    await wait(300);

    // One click back to the page.
    await page.executeJavaScript('scrollTo(0, 0)');
    await wait(300);
    await clickOn(page, '#back');
    const back = await until(() => !tab.state.internalUrl && page.getURL() === articleUrl && !page.isLoading(), 60);
    check('one click returns to the page', !!back, page.getURL());
    check('and the book is no longer lit', await until(() => chrome().executeJavaScript(`!document.getElementById('reader').classList.contains('on')`)));

    // F9 opens it too, and the lit book (or Escape) leaves.
    await until(() => browser.state().reader?.available, 40);
    key(page, 'F9');
    check('F9 opens reading view', !!await until(() => tab.state.internalUrl?.startsWith('browser://reader') && !page.isLoading(), 60));
    await until(() => page.executeJavaScript(`!!document.querySelector('.rd-body')`));
    await clickOn(chrome(), '#reader');
    check('the lit book in the address bar leaves it', !!await until(() => !tab.state.internalUrl && page.getURL() === articleUrl, 60));

    /* ---- QR code from the address bar ----------------------------------- */

    await loaded(page, articleUrl);
    // The book comes back once the page is judged an article again; the bar
    // settles before the pointer goes to it.
    await until(() => browser.state().reader?.available, 40);
    await until(() => chrome().executeJavaScript(`!document.getElementById('reader').hidden`));
    await wait(600);
    const omni = await rectOf(chrome(), '#omnibox');
    chrome().sendInputEvent({ type: 'mouseMove', x: omni.x, y: omni.y });
    await wait(250);
    check('the QR button shows while the pointer is on the address bar', !!await until(() => rectOf(chrome(), '#qr')));
    await clickOn(chrome(), '#qr');
    const qrCard = await until(() => overlay().executeJavaScript(`(() => {
      const svg = document.querySelector('.menu-qr .qr-svg');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, n: svg.viewBox.baseVal.width - 8,
        url: document.querySelector('.qr-url')?.textContent, host: document.querySelector('.menu-qr .pt-sub')?.textContent };
    })()`));
    check('the QR card opens under the button', !!qrCard && qrCard.url === articleUrl, JSON.stringify(qrCard));
    const qrSettled = await settledOverlay();
    check('the QR card has finished arriving', !!qrSettled);
    await wait(200);
    const qrNow = await overlay().executeJavaScript(`(() => { const r = document.querySelector('.menu-qr .qr-svg').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    Object.assign(qrCard || {}, qrNow);
    if (qrCard) {
      const x0 = Math.floor(qrCard.left); const y0 = Math.floor(qrCard.top);
      const shot = await overlay().capturePage({ x: x0, y: y0, width: Math.ceil(qrCard.left + qrCard.width) - x0, height: Math.ceil(qrCard.top + qrCard.height) - y0 });
      const size = shot.getSize();
      const s = size.width / (Math.ceil(qrCard.left + qrCard.width) - x0);
      const moduleSide = (qrCard.width * s) / (qrCard.n + 8);
      const offset = { x: (qrCard.left - x0) * s, y: (qrCard.top - y0) * s };
      let text = '';
      try {
        text = decode(sample(shot.toBitmap(), size.width, { left: offset.x + 4 * moduleSide, top: offset.y + 4 * moduleSide, side: qrCard.n * moduleSide, count: qrCard.n })).text;
      } catch (error) { text = 'decode failed: ' + error.message; }
      check('the QR code on screen decodes to the page address', text === articleUrl, text);
      const menuBox = await rectOf(overlay(), '.menu-qr');
      const card = await overlay().capturePage({ x: Math.max(0, Math.floor(menuBox.left) - 24), y: Math.max(0, Math.floor(menuBox.top) - 16), width: Math.ceil(menuBox.width) + 48, height: Math.ceil(menuBox.height) + 40 });
      fs.writeFileSync(path.join(shots, 'pagetools-qr-card.png'), card.toPNG());
    }
    await windowShot('qr');
    clipboard.clear();
    await clickOn(overlay(), '.menu-qr .pt-btn', 'Copy image');
    const copied = await until(clipImage);
    const readPicture = (img) => {
      const { width } = img.getSize();
      const n = (width / 12) - 8;
      return decode(sample(img.toBitmap(), width, { left: 48, top: 48, side: n * 12, count: n })).text;
    };
    let copiedText = '';
    try { copiedText = copied ? readPicture(copied) : 'nothing copied'; } catch (error) { copiedText = error.message; }
    check('Copy image puts a QR code of the address on the clipboard', copiedText === articleUrl, copiedText);
    await clickOn(overlay(), '.menu-qr .pt-btn', 'Save');
    const saidSaved = await until(() => overlay().executeJavaScript(`document.querySelector('.menu-qr .pt-status')?.textContent || ''`).then((t) => (/Saved to Downloads/.test(t) ? t : null)));
    const savedQr = fs.existsSync(path.join(scratch, 'Downloads')) ? fs.readdirSync(path.join(scratch, 'Downloads')).filter((f) => f.endsWith('.png')) : [];
    let savedText = '';
    try { savedText = savedQr.length ? readPicture(nativeImage.createFromPath(path.join(scratch, 'Downloads', savedQr[0]))) : 'no file'; } catch (error) { savedText = error.message; }
    check('Save writes it to Downloads, and says so', !!saidSaved && savedQr.length === 1 && /^QR code /.test(savedQr[0]), (saidSaved || '') + ' ' + savedQr.join(','));
    check('the saved QR code decodes to the address too', savedText === articleUrl, savedText);
    await wait(400);
    const qrStatus = await rectOf(overlay(), '.menu-qr');
    if (qrStatus) {
      const card = await overlay().capturePage({ x: Math.max(0, Math.floor(qrStatus.left) - 24), y: Math.max(0, Math.floor(qrStatus.top) - 16), width: Math.ceil(qrStatus.width) + 48, height: Math.ceil(qrStatus.height) + 40 });
      fs.writeFileSync(path.join(shots, 'pagetools-qr-saved.png'), card.toPNG());
    }
    key(overlay(), 'Escape');
    check('Escape puts the card away', !!await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`)));
    await wait(300);

    /* ---- the page's right-click menu --------------------------------------- */

    for (let i = 0; i < 3; i++) { page.sendInputEvent({ type: 'mouseMove', x: 1000 + i * 5, y: 600 }); await wait(100); }
    const bounds = tab.view.getBounds();
    const rightClickPage = async () => {
      browser.lastPageMenu = null;
      for (let i = 0; i < 6 && !browser.lastPageMenu; i++) {
        await click(page, { x: bounds.width - 40, y: Math.min(bounds.height - 40, 420) }, 'right');
        await until(() => browser.lastPageMenu, 12);
      }
      return (browser.lastPageMenu?.items || []).filter((i) => i.label).map((i) => i.label);
    };
    let labels = await rightClickPage();
    check('the page menu offers Screenshot, a QR code and reading view',
      ['Screenshot', 'QR code for this page', 'Open in reading view'].every((l) => labels.includes(l)), labels.join(' | '));
    await until(() => rectOf(overlay(), '.menu .menu-item', 'QR code for this page'));
    await clickOn(overlay(), '.menu .menu-item', 'QR code for this page');
    check('QR code for this page opens the card from the right-click menu',
      !!await until(() => overlay().executeJavaScript(`document.querySelector('.menu-qr .qr-url')?.textContent === ${JSON.stringify(articleUrl)}`)));
    await closeMenu();

    // Screenshot -> Visible area.
    labels = await rightClickPage();
    await until(() => rectOf(overlay(), '.menu .menu-item', 'Screenshot'));
    await clickOn(overlay(), '.menu .menu-item', 'Screenshot');
    const kinds = await until(() => overlay().executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('.menu .menu-item .menu-label')].map((n) => n.firstChild?.textContent || n.textContent);
      return items.includes('Visible area') ? items : null;
    })()`));
    check('Screenshot opens its three kinds in place', kinds && ['Visible area', 'Full page', 'Select an area'].every((k) => kinds.includes(k)), JSON.stringify(kinds));
    await wait(450);
    const kindsMenu = await rectOf(overlay(), '.menu');
    if (kindsMenu) fs.writeFileSync(path.join(shots, 'pagetools-screenshot-menu.png'), (await overlay().capturePage({ x: Math.max(0, Math.floor(kindsMenu.left) - 16), y: Math.max(0, Math.floor(kindsMenu.top) - 12), width: Math.ceil(kindsMenu.width) + 32, height: Math.ceil(kindsMenu.height) + 28 })).toPNG());
    const truth = await page.capturePage();
    await clickOn(overlay(), '.menu .menu-item', 'Visible area');
    const visibleCard = await until(() => overlay().executeJavaScript(`(() => {
      const c = document.querySelector('.menu-shot');
      return c && document.querySelector('.menu-shot .shot-img')?.complete ? { title: c.querySelector('.pt-title').textContent, sub: c.querySelector('.pt-sub').textContent } : null;
    })()`));
    const truthSize = truth.getSize();
    check('Visible area: a card with the picture and its size', visibleCard?.title === 'Visible area' &&
      visibleCard.sub.startsWith(truthSize.width + ' × ' + truthSize.height), JSON.stringify(visibleCard) + ' vs ' + JSON.stringify(truthSize));
    await wait(120);
    await windowShot('visible-arriving');
    await wait(900);
    await windowShot('visible-card');
    clipboard.clear();
    await clickOn(overlay(), '.menu-shot .pt-btn', 'Copy');
    const shotCopy = await until(clipImage);
    check('Copy puts the screenshot on the clipboard', !!shotCopy && shotCopy.getSize().width === truthSize.width && shotCopy.getSize().height === truthSize.height,
      JSON.stringify(shotCopy?.getSize()));
    check('and says so', !!await until(() => overlay().executeJavaScript(`/Copied/.test(document.querySelector('.menu-shot .pt-status')?.textContent || '')`)));
    await clickOn(overlay(), '.menu-shot .pt-close');
    check('the close button puts it away', !!await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`)));
    await wait(300);

    // The main menu -> Screenshot -> Full page, then Save.
    await clickOn(chrome(), '#app-menu');
    await until(() => rectOf(overlay(), '.menu .menu-item', 'Screenshot'));
    await clickOn(overlay(), '.menu .menu-item', 'Screenshot');
    await until(() => rectOf(overlay(), '.menu .menu-item', 'Full page'));
    await clickOn(overlay(), '.menu .menu-item', 'Full page');
    const fullCard = await until(() => overlay().executeJavaScript(`(() => {
      const c = document.querySelector('.menu-shot');
      return c ? { title: c.querySelector('.pt-title').textContent, sub: c.querySelector('.pt-sub').textContent, tall: !!c.querySelector('.shot-frame.is-tall') } : null;
    })()`), 80);
    const fullHeight = Number((fullCard?.sub || '').split('×')[1]?.trim().split(' ')[0]);
    const pageHeight = await page.executeJavaScript('document.documentElement.scrollHeight');
    check('Full page from the main menu: the whole page, top to bottom', fullCard?.title === 'Full page' && fullHeight > truthSize.height * 1.5,
      JSON.stringify(fullCard) + ' page ' + pageHeight + 'px');
    await wait(1000);
    await windowShot('fullpage-card');
    await clickOn(overlay(), '.menu-shot .pt-btn', 'Save');
    const saveSaid = await until(() => overlay().executeJavaScript(`(() => { const s = document.querySelector('.menu-shot .pt-status'); return s ? s.textContent + ' [' + s.title + ']' : ''; })()`).then((t) => (/Saved to/.test(t) ? t : null)));
    const folder = path.join(scratch, 'Pictures', 'Static Screenshots');
    const savedShots = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    const savedImage = savedShots[0] ? nativeImage.createFromPath(path.join(folder, savedShots[0])) : null;
    check('Save puts it in Pictures › Static Screenshots, named for when and what',
      !!saveSaid && /Saved to Static Screenshots/.test(saveSaid) && saveSaid.includes('[Pictures › Static Screenshots › ' + savedShots[0] + ']') && savedShots.length === 1 &&
      /^Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d - The quiet return of the night train/.test(savedShots[0]), (saveSaid || '') + ' :: ' + savedShots.join(','));
    check('the saved file is the full page', savedImage && savedImage.getSize().height === fullHeight, JSON.stringify(savedImage?.getSize()));
    check('Show in folder is offered', !!await rectOf(overlay(), '.menu-shot .pt-link', 'Show in folder'));
    await wait(300);
    const fullBox = await rectOf(overlay(), '.menu-shot');
    if (fullBox) fs.writeFileSync(path.join(shots, 'pagetools-fullpage-saved.png'), (await overlay().capturePage({ x: Math.max(0, Math.floor(fullBox.left) - 24), y: Math.max(0, Math.floor(fullBox.top) - 16), width: Math.ceil(fullBox.width) + 48, height: Math.ceil(fullBox.height) + 40 })).toPNG());
    await closeMenu();

    // Select an area: drag across part of the page, adjust nothing, Enter.
    await page.executeJavaScript('scrollTo(0, 260)');
    await wait(400);
    labels = await rightClickPage();
    await until(() => rectOf(overlay(), '.menu .menu-item', 'Screenshot'));
    await clickOn(overlay(), '.menu .menu-item', 'Screenshot');
    await until(() => rectOf(overlay(), '.menu .menu-item', 'Select an area'));
    const still = await page.capturePage();
    await clickOn(overlay(), '.menu .menu-item', 'Select an area');
    const picker = await until(() => overlay().executeJavaScript(`(() => {
      const s = document.querySelector('.menu-region .rg-stage');
      const shot = document.querySelector('.menu-region .rg-shot');
      if (!s || !shot?.complete) return null;
      const r = s.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, hint: document.querySelector('.rg-hint')?.textContent };
    })()`), 60);
    check('Select an area covers the page with a picker', !!picker && Math.abs(picker.left - bounds.x) < 1 && Math.abs(picker.top - bounds.y) < 1 &&
      /Drag across/.test(picker.hint), JSON.stringify(picker) + ' tab ' + JSON.stringify(bounds));
    await wait(400);
    // A pointer move first shows the crosshair.
    overlay().sendInputEvent({ type: 'mouseMove', x: bounds.x + 300, y: bounds.y + 200 });
    await wait(200);
    await windowShot('region-crosshair');
    const from = { x: bounds.x + 120, y: bounds.y + 90 };
    const to = { x: bounds.x + 560, y: bounds.y + 370 };
    overlay().sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    overlay().sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      overlay().sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / 12), y: Math.round(from.y + (to.y - from.y) * i / 12), button: 'left', modifiers: ['leftButtonDown'] });
      await wait(25);
    }
    overlay().sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    const chosen = await until(() => overlay().executeJavaScript(`(() => {
      const s = document.querySelector('.rg-sel');
      const bar = document.querySelector('.rg-bar');
      if (!s || s.hidden || !bar || bar.hidden) return null;
      return { width: s.offsetWidth, height: s.offsetHeight, size: document.querySelector('.rg-size').textContent };
    })()`));
    const ratio = still.getSize().width / bounds.width;
    check('dragging draws the selection, with its size in real pixels and a Capture button',
      !!chosen && Math.abs(chosen.width - 440) <= 2 && Math.abs(chosen.height - 280) <= 2 &&
      chosen.size === Math.round(440 * ratio) + ' × ' + Math.round(280 * ratio), JSON.stringify(chosen));
    await wait(450);
    await windowShot('region-selected');
    key(overlay(), 'Return');
    const regionCard = await until(() => overlay().executeJavaScript(`(() => {
      const c = document.querySelector('.menu-shot');
      return c ? { title: c.querySelector('.pt-title').textContent, sub: c.querySelector('.pt-sub').textContent } : null;
    })()`), 60);
    check('Enter captures it, to a card', regionCard?.title === 'Selected area' &&
      regionCard.sub === Math.round(440 * ratio) + ' × ' + Math.round(280 * ratio), JSON.stringify(regionCard));
    clipboard.clear();
    await clickOn(overlay(), '.menu-shot .pt-btn', 'Copy');
    const regionImage = await until(clipImage);
    // The cut-out is exactly that part of the page: compare pixels.
    let same = 0; let tried = 0;
    if (regionImage) {
      const a = regionImage.toBitmap(); const aw = regionImage.getSize().width;
      const b = still.toBitmap(); const bw = still.getSize().width;
      for (const [px, py] of [[5, 5], [60, 40], [200, 120], [400, 250], [430, 270]]) {
        const ax = Math.round(px * ratio); const ay = Math.round(py * ratio);
        const bx = Math.round((120 + px) * ratio); const by = Math.round((90 + py) * ratio);
        const ia = (ay * aw + ax) * 4; const ib = (by * bw + bx) * 4;
        tried++;
        if (Math.abs(a[ia] - b[ib]) + Math.abs(a[ia + 1] - b[ib + 1]) + Math.abs(a[ia + 2] - b[ib + 2]) <= 12) same++;
      }
    }
    check('the picture is exactly the part selected', tried > 0 && same === tried, same + '/' + tried);
    await wait(900);
    await windowShot('region-card');
    await closeMenu();

    // Escape leaves the picker without taking anything.
    labels = await rightClickPage();
    await until(() => rectOf(overlay(), '.menu .menu-item', 'Screenshot'));
    await clickOn(overlay(), '.menu .menu-item', 'Screenshot');
    await until(() => rectOf(overlay(), '.menu .menu-item', 'Select an area'));
    await clickOn(overlay(), '.menu .menu-item', 'Select an area');
    await until(() => overlay().executeJavaScript(`!!document.querySelector('.menu-region')`), 60);
    key(overlay(), 'Escape');
    check('Escape leaves the picker', !!await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`)));
    check('and the overlay gives the window back', !!await until(() => browser.overlay.getBounds().width <= 1 || !browser.overlayInteractive));

    // On a light planet, reading view starts light, and the cards wear it.
    const theme = browser.settings.value.theme;
    browser.settings.update({ theme: 'venus', reader: { theme: '' } });
    browser.push();
    await page.executeJavaScript('scrollTo(0, 0)');
    await until(() => browser.state().reader?.available, 40);
    await browser.pageTools.toggleReader(tab.id);
    const lightTheme = await until(() => page.executeJavaScript(`document.querySelector('.rd-body') ? document.body.dataset.theme : null`), 60);
    check('on a light planet, reading view starts in light colours', lightTheme === 'light', lightTheme);
    await wait(1200);
    await windowShot('reader-venus');
    browser.pageTools.leaveReader(tab.id);
    await loaded(page, articleUrl);
    await wait(400);
    browser.pageTools.showQr(tab.id, null, 'right');
    await until(() => overlay().executeJavaScript(`!!document.querySelector('.menu-qr')`));
    await settledOverlay();
    await windowShot('qr-venus');
    await closeMenu();
    browser.settings.update({ theme });
    browser.push();

    check('no QR or screenshot reached the real Pictures or Downloads', app.getPath('pictures').startsWith(scratch));
  } catch (error) {
    check('probe completed', false, error.stack);
  }
  server.close();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall page tools checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run, articlePage };
