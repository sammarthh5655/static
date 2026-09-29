const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');

/**
 * List rules beyond network blocking, in a real page, off-screen: plain CSS
 * hiding, procedural hiding (including content that arrives late), exceptions,
 * and a scriptlet that must run before the page's own first script.
 */
const PAGE = `<!doctype html><title>t</title><body>
<div class="plain-ad" id="plain">plain ad</div>
<div class="spared" id="spared">excepted</div>
<div class="card" id="c1">Sponsored post</div>
<div class="card" id="c2">A normal post</div>
<div class="wrap"><div class="inner"><a class="lnk" id="deep">Promoted</a></div></div>
<script>
  document.title = 'ads:' + String(window.adsEnabled);
  setTimeout(() => { const d = document.createElement('div'); d.className = 'card'; d.id = 'late'; d.textContent = 'Sponsored, late'; document.body.append(d); }, 400);
</script></body>`;

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  try {
    await wait(800);
    browser.shields.engine.addList([
      '127.0.0.1##.plain-ad',
      '127.0.0.1##.spared',
      '127.0.0.1#@#.spared',
      '127.0.0.1##.card:has-text(Sponsored)',
      '127.0.0.1##.lnk:has-text(Promoted):upward(2)',
      '127.0.0.1##+js(set-constant, adsEnabled, false)',
    ].join('\n'), { id: 'probe' });
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    browser.tabs.navigate(tab.id, base);
    for (let i = 0; i < 60 && (wc.isLoading() || !wc.getURL().startsWith(base)); i++) await wait(120);
    await wait(1200);
    const state = await wc.executeJavaScript(`(() => {
      const shown = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
      return { title: document.title, plain: shown('plain'), spared: shown('spared'), c1: shown('c1'), c2: shown('c2'),
        late: shown('late'), wrap: getComputedStyle(document.querySelector('.wrap')).display !== 'none', lateExists: !!document.getElementById('late') };
    })()`);
    check('a scriptlet runs before the page\'s own first script', state.title === 'ads:false', state.title);
    check('plain CSS hiding works', state.plain === false);
    check('a #@# exception keeps an element the lists would hide', state.spared === true);
    check('procedural :has-text hides the sponsored card only', state.c1 === false && state.c2 === true);
    check('procedural :upward hides the right ancestor', state.wrap === false);
    check('content that arrives later is caught too', state.lateExists && state.late === false, JSON.stringify(state));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall page rule checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
