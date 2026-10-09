const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/**
 * Page tools at their edges, off-screen. Where pagetools.cjs walks the happy
 * path, this one leans on the corners:
 *
 * - a hostile article: a page that tries every way it can think of to get
 *   markup, script or a strange address into reading view, and that rewrites
 *   the DOM's own methods in its world to throw the extractor off;
 * - a large page, measured for how long the "is it an article?" question
 *   holds up the page's main thread;
 * - full page screenshots of a scrolled page (it starts at the top, and the
 *   page is left where it was), of a zoomed page, and of a page taller than
 *   one picture can be;
 * - screenshots of Static's own pages, where QR codes are not offered;
 * - two articles read one after the other in one tab, then Back to the first;
 * - the area picker adjusted by its handles and moved, with real drags;
 * - links in reading view, and Escape.
 *
 * Pictures land in shots/pagetoolsedge-*.png.
 */

const PARA = 'The harbour wall was built in the eighteenth century to keep the winter storms out of the town, and for most of its life it did exactly that, quietly, without anyone thinking much about it, until the storms began to change and the people who lived behind it began to wonder how long a wall of stone and lime could hold back a sea that seemed to grow a little stronger every year.';

function hostilePage() {
  const p = (n) => Array.from({ length: n }, () => `<p>${PARA}</p>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>The harbour wall | Hostile Herald</title>
<meta property="og:site_name" content="Hostile Herald &lt;script&gt;">
<meta name="author" content="&lt;img src=x onerror=alert(1)&gt; Mallory">
<script>
  // The page's own world, rewritten: none of this may reach the extractor.
  Object.defineProperty(Node.prototype, 'textContent', { get() { return 'pwned'; } });
  Element.prototype.getAttribute = function () { return 'javascript:alert(1)'; };
  Array.prototype.flatMap = function () { return [['script', null, 'alert(1)']]; };
  JSON.parse = function () { return { '@type': 'Article', headline: 'Hijacked headline' }; };
  window.getComputedStyle = function () { return { display: 'none' }; };
</script>
</head><body>
<article class="story">
<h1>The harbour wall</h1>
${p(3)}
<p>Links: <a href="javascript:window.__pwned='js'">js</a>, <a href=" JaVaScRiPt:window.__pwned='js2'">spaced</a>,
<a href="data:text/html,<script>parent.__pwned='data'</script>">data</a>, <a href="vbscript:msgbox">vb</a>,
<a href="file:///C:/Windows/win.ini">file</a>, <a href="browser://settings">settings</a>,
<a href="https://user:secret@example.org/path">with a password</a> and <a href="https://example.org/fine" onclick="window.__pwned='click'" style="color:red" id="back" class="rd-end-link" target="_top">a fine one</a>.</p>
<p><img src="javascript:alert(1)" width="300" height="200" alt="js image"><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" width="300" height="200" alt="svg data"><img src="data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=" width="300" height="200" alt="html data"><img srcset="javascript:alert(2) 2x" width="300" height="200" alt="srcset"></p>
<svg width="400" height="200"><a href="javascript:alert(3)"><text y="20">svg link text that should not appear anywhere</text></a><script>window.__svgScript = "svg script text that should not appear"</script></svg>
<math><mtext>math text that should not appear</mtext></math>
<iframe srcdoc="<script>parent.__pwned='iframe'</script>"></iframe>
<form action="/evil/steal"><input name="password" value="hunter2"><button>Send</button></form>
<template><p>template text that should not appear</p></template>
<p style="background:url(/evil/track.png)" onmouseover="window.__pwned='hover'">A paragraph with a style and a handler, which should keep only its words: ${PARA}</p>
<p>Markup as text: &lt;script&gt;window.__pwned='text'&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; and the article carries on as normal.</p>
<custom-element><p>Inside a custom element, still the article: ${PARA}</p></custom-element>
<div id="shadow-host"></div>
<object data="/evil/x.swf"></object><embed src="/evil/x.swf">
<link rel="stylesheet" href="/evil/x.css">
<style>p { color: red }</style>
<noscript><p>noscript text that should not appear</p></noscript>
${p(4)}
</article>
<script>
  const host = document.getElementById('shadow-host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<p>From a shadow root, read as the article: ' + ${JSON.stringify(PARA)} + '</p><script>window.__pwned = "shadow"<\\/script><img src="javascript:alert(5)" width="200" height="200">';
</script>
</body></html>`;
}

function articlePage(title, n = 8) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>
<header style="background:#c0392b;color:#fff;height:120px;margin:0">Masthead</header>
<article><h1>${title}</h1>${Array.from({ length: n }, (_, i) => `<p>${PARA} (${i})</p>`).join('\n')}
<p>Read <a href="/second">the second story</a> next.</p></article></body></html>`;
}

/** A big front page: thousands of paragraphs and links in nested boxes. */
function bigPage() {
  const blocks = [];
  for (let i = 0; i < 600; i++) {
    blocks.push(`<div class="card"><div class="inner"><h3><a href="/s${i}">Story number ${i}</a></h3>` +
      `<p>${PARA.slice(0, 160)} <a href="/t${i}">more</a></p><ul><li><a href="/u${i}">One</a></li><li><a href="/v${i}">Two</a></li></ul></div></div>`);
  }
  return `<!doctype html><html><head><title>Big</title></head><body><main>${blocks.join('\n')}</main></body></html>`;
}

function tallPage(height) {
  return `<!doctype html><html><head><title>Tall</title><style>body{margin:0}
.top{height:200px;background:#c0392b}.mid{height:${height - 400}px;background:linear-gradient(#27ae60,#2980b9)}.end{height:200px;background:#f1c40f}</style></head>
<body><div class="top"></div><div class="mid"></div><div class="end"></div></body></html>`;
}

async function run(browser) {
  const { app, nativeImage } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d !== undefined && d !== '' ? ' :: ' + String(d).slice(0, 300) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 50, ms = 120) => {
    for (let i = 0; i < tries; i++) {
      // A page torn down mid-question never answers: give up on that try.
      const v = await Promise.race([Promise.resolve().then(fn).catch(() => null), wait(3000).then(() => null)]);
      if (v) return v;
      await wait(ms);
    }
    return null;
  };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'static-pagetoolsedge-'));
  app.setPath('pictures', path.join(scratch, 'Pictures'));
  app.setPath('downloads', path.join(scratch, 'Downloads'));
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });

  const evilRequests = [];
  const server = http.createServer((req, res) => {
    const send = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
    if (req.url.startsWith('/hostile')) return send(hostilePage());
    if (req.url.startsWith('/first')) return send(articlePage('The first story'));
    if (req.url.startsWith('/second')) return send(articlePage('The second story'));
    if (req.url.startsWith('/big')) return send(bigPage());
    if (req.url.startsWith('/tall')) return send(tallPage(Number(req.url.split('=')[1]) || 5000));
    if (req.url !== '/favicon.ico') evilRequests.push(req.url);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

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
  const click = async (wc, at, { button = 'left', modifiers = [] } = {}) => {
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await wait(50);
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button, clickCount: 1, modifiers });
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button, clickCount: 1, modifiers });
  };
  const clickOn = async (wc, selector, text, options) => {
    const at = await until(() => rectOf(wc, selector, text));
    if (!at) return false;
    await click(wc, at, options);
    return true;
  };
  const drag = async (wc, from, to, steps = 10) => {
    wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps), button: 'left', modifiers: ['leftButtonDown'] });
      await wait(20);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await wait(120);
  };
  const key = (wc, keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const closeMenu = async () => {
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`));
    await wait(200);
  };
  const loaded = (wc, prefix) => until(() => !wc.isLoading() && wc.getURL().startsWith(prefix), 80);
  const shotCard = () => until(() => overlay().executeJavaScript(`(() => {
    const c = document.querySelector('.menu-shot');
    return c ? { title: c.querySelector('.pt-title').textContent, sub: c.querySelector('.pt-sub').textContent } : null;
  })()`), 80);
  /** The newest picture main is keeping for a card. */
  const lastKept = () => [...browser.pageTools.kept.values()].at(-1);
  const pixel = (image, x, y) => {
    const { width } = image.getSize();
    const b = image.toBitmap();
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    return [b[i + 2], b[i + 1], b[i]];
  };
  const near = (a, b, tolerance = 40) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tolerance;
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
    fs.writeFileSync(path.join(shots, 'pagetoolsedge-' + name + '.png'), nativeImage.createFromBitmap(out, { width: W, height: H }).toPNG());
  };

  try {
    await wait(1500);
    browser.settings.update({ tabLayout: 'horizontal', sidebarMode: 'off', reader: { size: 20, width: 'medium', font: 'serif', theme: 'dark' } });
    browser.applyTabLayout?.();
    browser.applySidebarMode?.();
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const tab = browser.tabs.active;
    const page = tab.view.webContents;

    /* ---- a hostile article ---------------------------------------------- */

    browser.tabs.navigate(tab.id, base + '/hostile');
    await loaded(page, base + '/hostile');
    const offered = await until(() => browser.state().reader?.available, 40);
    check('a page that rewrites the DOM in its own world is still judged an article', !!offered, JSON.stringify(browser.state().reader));
    // From here on, only what reading view itself asks for.
    evilRequests.length = 0;
    await browser.pageTools.toggleReader(tab.id);
    await until(() => tab.state.internalUrl?.startsWith('browser://reader') && !page.isLoading(), 60);
    const view = await until(() => page.executeJavaScript(`(() => {
      const body = document.querySelector('.rd-body');
      if (!body) return null;
      const allowed = new Set(['P','H2','H3','H4','BLOCKQUOTE','PRE','UL','OL','LI','DL','DT','DD','FIGURE','FIGCAPTION','DIV','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','CAPTION','HR','A','EM','STRONG','SUP','SUB','SMALL','MARK','S','DEL','INS','Q','CITE','ABBR','TIME','CODE','KBD','VAR','SAMP','U','BR','IMG']);
      const all = [...body.querySelectorAll('*')];
      return {
        title: document.querySelector('.rd-title')?.textContent,
        kicker: document.querySelector('.rd-kicker')?.textContent,
        meta: document.querySelector('.rd-meta')?.textContent,
        metaElements: document.querySelectorAll('.rd-head img, .rd-head script, #where img').length,
        tags: [...new Set(all.map((n) => n.tagName))].filter((t) => !allowed.has(t)),
        attrs: [...new Set(all.flatMap((n) => [...n.attributes].map((a) => n.tagName + '.' + a.name)))]
          .filter((a) => !/^(A\\.(href|rel|referrerpolicy|title)|IMG\\.(src|alt|referrerpolicy|loading|decoding|width|height|class)|DIV\\.class|P\\.class|T[DH]\\.(colspan|rowspan)|OL\\.start)$/.test(a)),
        hrefs: [...body.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        srcs: [...body.querySelectorAll('img')].map((i) => i.getAttribute('src').slice(0, 40)),
        text: body.textContent,
        pwned: window.__pwned || null,
      };
    })()`), 40);
    check('the hostile article opens in reading view', !!view, tab.state.internalUrl);
    if (view) {
      check('its real headline, not the one its scripts tried to plant', view.title === 'The harbour wall', view.title);
      check('markup in its metadata is shown as words, never made', /Mallory/.test(view.meta) && view.metaElements === 0, view.meta + ' | ' + view.kicker);
      check('only allow-listed tags are made', view.tags.length === 0, view.tags.join(','));
      check('only allow-listed attributes are made', view.attrs.length === 0, view.attrs.join(','));
      check('every link is plain http(s), without a password in it',
        view.hrefs.length > 0 && view.hrefs.every((h) => /^https?:\/\//.test(h) && !/secret/.test(h)), JSON.stringify(view.hrefs));
      check('only real pictures: no script, SVG or HTML images', view.srcs.every((s) => /^https?:|^data:image\/(png|jpe?g|gif|webp|avif)/.test(s)), JSON.stringify(view.srcs));
      check('no SVG, MathML, template, form, noscript or frame text survives',
        !/should not appear|hunter2|Send/.test(view.text), view.text.match(/.{30}(should not appear|hunter2).{10}/)?.[0]);
      check('the shadow root and the custom element are read as the article',
        /From a shadow root/.test(view.text) && /Inside a custom element/.test(view.text), view.text.slice(-900));
      check('markup written as text stays text', /<script>window.__pwned='text'<\/script>/.test(view.text));
      check('nothing ran in reading view', !view.pwned, view.pwned);
    }
    await windowShot('hostile-reader');
    check('reading view fetched nothing the page pointed at', evilRequests.length === 0, evilRequests.join(','));
    browser.pageTools.leaveReader(tab.id);
    await loaded(page, base + '/hostile');
    check('reading view leaves back to the hostile page', page.getURL() === base + '/hostile', page.getURL());

    /* ---- two articles in one tab, then Back --------------------------------- */

    browser.tabs.navigate(tab.id, base + '/first');
    await loaded(page, base + '/first');
    await until(() => browser.state().reader?.available, 40);
    await browser.pageTools.toggleReader(tab.id);
    await until(() => page.executeJavaScript(`document.querySelector('.rd-title')?.textContent`).then((t) => t === 'The first story'), 60);
    // Follow the article's own link, as a reader would, with a real click.
    const link = await until(() => page.executeJavaScript(`(() => { const a = [...document.querySelectorAll('.rd-body a')].find((x) => x.textContent === 'the second story'); if (!a) return null; a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`));
    await wait(200);
    const linkNow = await page.executeJavaScript(`(() => { const a = [...document.querySelectorAll('.rd-body a')].find((x) => x.textContent === 'the second story'); const r = a.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (link) await click(page, linkNow);
    check('a link in reading view opens in the same tab', !!await loaded(page, base + '/second'), page.getURL());
    await until(() => browser.state().reader?.available, 40);
    await browser.pageTools.toggleReader(tab.id);
    await until(() => page.executeJavaScript(`document.querySelector('.rd-title')?.textContent`).then((t) => t === 'The second story'), 60);
    // Back, Back: the first article in reading view again.
    page.navigationHistory.goBack();
    await wait(600);
    page.navigationHistory.goBack();
    const firstAgain = await until(() => page.executeJavaScript(`document.querySelector('.rd-title')?.textContent || (document.querySelector('.rd-missing') ? 'missing' : null)`), 60);
    check('Back to an earlier article in reading view shows it again (Static is still running)', firstAgain === 'The first story', firstAgain);
    await windowShot('back-to-first');
    // Escape leaves reading view.
    await page.executeJavaScript('document.activeElement?.blur(), true').catch(() => {});
    key(page, 'Escape');
    check('Escape leaves reading view', !!await until(() => !tab.state.internalUrl && page.getURL().startsWith(base + '/first'), 60), page.getURL());

    // An address typed by hand: an article that was never opened.
    browser.tabs.navigate(tab.id, 'browser://reader?url=' + encodeURIComponent('https://example.org/never'));
    const missing = await until(() => page.executeJavaScript(`document.querySelector('.rd-missing')?.textContent || null`), 60);
    check('reading view of an article never opened says so, kindly', /no longer open/.test(missing || ''), missing);
    await wait(500);
    await windowShot('missing');
    browser.tabs.navigate(tab.id, 'browser://reader?url=' + encodeURIComponent('javascript:alert(1)'));
    const bad = await until(() => page.executeJavaScript(`document.querySelector('.rd-missing') ? { button: !!document.querySelector('.rd-primary') } : null`), 60);
    check('a reading view address that is not a web page offers nothing to open', bad && !bad.button, JSON.stringify(bad));

    /* ---- the cost of asking "is this an article?" ---------------------------- */

    browser.tabs.navigate(tab.id, base + '/big');
    await loaded(page, base + '/big');
    await wait(600);
    const reader = require('../src/features/pagetools/reader');
    let t0 = Date.now();
    await page.executeJavaScriptInIsolatedWorld(4207, [{ code: reader.PROBE_SOURCE }]);
    const probeMs = Date.now() - t0;
    t0 = Date.now();
    const measured = await page.executeJavaScriptInIsolatedWorld(4207, [{ code: reader.MEASURE_SOURCE }]);
    const measureMs = Date.now() - t0;
    check('the quick question on a big page is quick', probeMs < 150, probeMs + 'ms');
    check('measuring a big page (600 cards, 3000 links) stays under half a second', measureMs < 500, measureMs + 'ms ' + JSON.stringify(measured));

    /* ---- full page screenshots ------------------------------------------------ */

    browser.tabs.navigate(tab.id, base + '/tall?h=5000');
    await loaded(page, base + '/tall');
    await wait(500);
    await page.executeJavaScript('scrollTo(0, 2400)');
    await wait(300);
    await browser.pageTools.take('full');
    const scrolledCard = await shotCard();
    const scrolledShot = lastKept()?.image;
    const scrollAfter = await page.executeJavaScript('scrollY');
    check('Full page of a scrolled page: the whole page', scrolledCard?.title === 'Full page' && /× 5000/.test(scrolledCard.sub), JSON.stringify(scrolledCard));
    if (scrolledShot) {
      const size = scrolledShot.getSize();
      check('it starts at the top of the page, not where it was scrolled to', near(pixel(scrolledShot, 20, 20), [192, 57, 43]), JSON.stringify(pixel(scrolledShot, 20, 20)));
      check('and ends at the bottom', near(pixel(scrolledShot, 20, size.height - 20), [241, 196, 15]), JSON.stringify(pixel(scrolledShot, 20, size.height - 20)));
    }
    check('the page is left where it was scrolled to', Math.abs(scrollAfter - 2400) < 2, scrollAfter);
    await closeMenu();

    browser.tabs.navigate(tab.id, base + '/tall?h=40000');
    await loaded(page, base + '/tall');
    await wait(500);
    await browser.pageTools.take('full');
    const tallCard = await shotCard();
    check('a page taller than one picture is cut, and the card says so', /as far as fits/.test(tallCard?.sub || ''), JSON.stringify(tallCard));
    await wait(900);
    await windowShot('tall-card');
    await closeMenu();

    browser.tabs.navigate(tab.id, base + '/tall?h=3000');
    await loaded(page, base + '/tall');
    await wait(400);
    const visibleWidth = (await page.capturePage()).getSize().width;
    page.setZoomFactor(1.5);
    await wait(600);
    await browser.pageTools.take('full');
    const zoomCard = await shotCard();
    const zoomShot = lastKept()?.image;
    const zw = zoomShot?.getSize();
    check('Full page of a zoomed page is the page as seen, all of it',
      !!zw && Math.abs(zw.width - visibleWidth) < 40 && zw.height >= 3000 * 1.5 - 4, JSON.stringify(zw) + ' visible ' + visibleWidth + ' ' + JSON.stringify(zoomCard));
    if (zoomShot) check('and it ends at the bottom', near(pixel(zoomShot, 20, zw.height - 20), [241, 196, 15]), JSON.stringify(pixel(zoomShot, 20, zw.height - 20)));
    page.setZoomFactor(1);
    await closeMenu();

    /* ---- the area picker, adjusted ---------------------------------------- */

    browser.tabs.navigate(tab.id, base + '/first');
    await loaded(page, base + '/first');
    await wait(500);
    const bounds = tab.view.getBounds();
    await browser.pageTools.take('region');
    await until(() => overlay().executeJavaScript(`!!document.querySelector('.menu-region .rg-shot')?.complete`), 60);
    await wait(300);
    // Enter with nothing chosen does nothing.
    key(overlay(), 'Return');
    await wait(300);
    check('Enter with nothing selected does nothing', await overlay().executeJavaScript(`!!document.querySelector('.menu-region') && !document.querySelector('.menu-shot')`));
    const at = (x, y) => ({ x: bounds.x + x, y: bounds.y + y });
    await drag(overlay(), at(100, 100), at(300, 250));
    let sel = await overlay().executeJavaScript(`(() => { const s = document.querySelector('.rg-sel'); return { x: s.offsetLeft, y: s.offsetTop, w: s.offsetWidth, h: s.offsetHeight }; })()`);
    check('a drag draws a selection', sel.w === 200 && sel.h === 150, JSON.stringify(sel));
    // The bottom-right handle, dragged out.
    await drag(overlay(), at(300, 250), at(400, 330));
    sel = await overlay().executeJavaScript(`(() => { const s = document.querySelector('.rg-sel'); return { x: s.offsetLeft, y: s.offsetTop, w: s.offsetWidth, h: s.offsetHeight }; })()`);
    check('its corner handle resizes it', sel.x === 100 && sel.y === 100 && sel.w === 300 && sel.h === 230, JSON.stringify(sel));
    // The left edge's handle, dragged in.
    await drag(overlay(), at(100, 215), at(150, 215));
    sel = await overlay().executeJavaScript(`(() => { const s = document.querySelector('.rg-sel'); return { x: s.offsetLeft, y: s.offsetTop, w: s.offsetWidth, h: s.offsetHeight }; })()`);
    check('its edge handle moves just that edge', sel.x === 150 && sel.w === 250 && sel.h === 230, JSON.stringify(sel));
    // Dragged from the middle, it moves; past the edge, it stops at the edge.
    await drag(overlay(), at(250, 200), at(-200, 150));
    sel = await overlay().executeJavaScript(`(() => { const s = document.querySelector('.rg-sel'); return { x: s.offsetLeft, y: s.offsetTop, w: s.offsetWidth, h: s.offsetHeight }; })()`);
    check('dragged from inside, it moves, and stops at the page edge', sel.x === 0 && sel.y === 50 && sel.w === 250 && sel.h === 230, JSON.stringify(sel));
    await wait(400);
    await windowShot('region-moved');
    const still = await page.capturePage();
    await clickOn(overlay(), '.rg-bar .pt-btn', 'Capture');
    const regionCard = await shotCard();
    const ratio = still.getSize().width / bounds.width;
    check('Capture takes exactly that area', regionCard?.title === 'Selected area' && regionCard.sub === Math.round(250 * ratio) + ' × ' + Math.round(230 * ratio), JSON.stringify(regionCard));
    await wait(900);
    await windowShot('region-card');
    await closeMenu();

    /* ---- Static's own pages ---------------------------------------------------- */

    browser.tabs.navigate(tab.id, 'browser://settings');
    await until(() => tab.state.internalUrl === 'browser://settings' && !page.isLoading(), 60);
    await wait(800);
    check('no QR button on Static\'s own pages', await chrome().executeJavaScript(`document.getElementById('qr').hidden`));
    check('nor reading view', await chrome().executeJavaScript(`document.getElementById('reader').hidden`));
    const qrShown = browser.pageTools.showQr(tab.id, null, 'right');
    check('asking for a QR code there explains instead', qrShown === false);
    await browser.pageTools.take('visible');
    const own = await shotCard();
    check('a screenshot of Static\'s own page works', own?.title === 'Visible area', JSON.stringify(own));
    await closeMenu();
    await browser.pageTools.take('full');
    const ownFull = await shotCard();
    check('and a full page one', ownFull?.title === 'Full page' || ownFull?.title === 'Visible area', JSON.stringify(ownFull));
    await closeMenu();

    // Save twice: the second does not make a second file; a deleted file is saved again.
    await browser.pageTools.take('visible');
    await shotCard();
    const token = [...browser.pageTools.kept.entries()].filter(([, e]) => e.kind === 'shot').at(-1)[0];
    const first = browser.pageTools.save(token);
    const second = browser.pageTools.save(token);
    const folder = path.join(scratch, 'Pictures', 'Static Screenshots');
    check('Save twice keeps one file', first.ok && second.ok && first.name === second.name && fs.readdirSync(folder).length === 1, fs.readdirSync(folder).join(','));
    fs.rmSync(path.join(folder, first.name));
    const third = browser.pageTools.save(token);
    check('a saved file that was deleted is saved again', third.ok && fs.existsSync(path.join(folder, third.name)), JSON.stringify(third));
    await closeMenu();
    check('nothing went to the real Pictures folder', app.getPath('pictures').startsWith(scratch));
  } catch (error) {
    check('probe completed', false, error.stack);
  }
  server.close();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall page tools edge checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run, hostilePage };
