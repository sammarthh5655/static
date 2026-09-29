const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/** browser://help: about, diagnostics, legal, and feedback end to end. Off-screen. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 240) : ''));
    if (!ok) fails++;
  };
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const until = async (fn, tries = 50) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Broken site</title><body style="background:#c33;color:#fff;font:40px sans-serif">This page is broken<script>console.error("boom from the page")</script>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  try {
    browser.window.show();
    await wait(900);
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const go = async (url) => {
      browser.tabs.navigate(tab.id, url);
      for (let i = 0; i < 60 && (wc.isLoading() || !(tab.state.displayUrl || '').startsWith(url.split('#')[0])); i++) await wait(120);
      await wait(700);
    };

    // A web page first, so there is something to report.
    await go(base);
    await wait(1000); // someone reporting a page has been looking at it
    browser.dispatch('feedback:open');
    await until(() => (browser.tabs.active?.state.displayUrl || '').startsWith('browser://help'));
    const helpTab = browser.tabs.active;
    const hw = helpTab.view.webContents;
    await until(() => hw.executeJavaScript(`!!document.getElementById('fb-text')`).catch(() => false));
    await wait(800);
    const pre = await hw.executeJavaScript(`document.querySelectorAll('.fb-shot img').length`);
    check('"Send feedback" from the menu brings a screenshot of the page you were on', pre === 1, pre);

    await hw.executeJavaScript(`(() => {
      const t = document.getElementById('fb-text'); t.value = 'The page is red and says it is broken.';
      document.getElementById('fb-category').value = 'compatibility';
    })()`);
    await hw.executeJavaScript(`[...document.querySelectorAll('.fb-actions button')].find(b => b.textContent.startsWith('Preview')).click()`);
    const previewText = await until(() => hw.executeJavaScript(`(() => { const p = document.querySelector('.fb-preview'); return p && !p.hidden ? p.textContent : ''; })()`));
    const preview = JSON.parse(previewText || '{}');
    check('the preview shows the exact report', preview.description === 'The page is red and says it is broken.' && preview.category === 'compatibility', previewText?.slice(0, 120));
    check('identifying details are OFF until you turn them on', !('openTabs' in (preview.included || {})) && !('profile' in (preview.included || {})) && 'version' in (preview.included || {}), JSON.stringify(Object.keys(preview.included || {})));
    await hw.executeJavaScript(`[...document.querySelectorAll('.fb-toggle')].find(b => /console/.test(b.textContent)).click()`);
    await wait(500);
    const withConsole = JSON.parse(await hw.executeJavaScript(`document.querySelector('.fb-preview').textContent`));
    check('switching one on adds exactly that, and the preview updates', (withConsole.included.console || []).some((c) => /boom from the page/.test(c.message)), JSON.stringify(withConsole.included.console || []).slice(0, 140));

    await hw.executeJavaScript(`[...document.querySelectorAll('.fb-actions button')].find(b => b.textContent === 'Save report').click()`);
    await until(() => browser.lastFeedbackFolder);
    const folder = browser.lastFeedbackFolder;
    const saved = folder && JSON.parse(fs.readFileSync(path.join(folder, 'report.json'), 'utf8'));
    check('saving writes the report and the screenshot to a folder on this device',
      !!saved && saved.description === preview.description && fs.existsSync(path.join(folder, 'screenshot-1.png')), folder);
    const said = await hw.executeJavaScript(`document.querySelector('.fb-status').textContent`);
    check('and says plainly there is no feedback server yet', /no feedback server yet/.test(said), said);
    await hw.executeJavaScript(`document.getElementById('fb-text').value = 'x'; [...document.querySelectorAll('.fb-actions button')].find(b => b.textContent === 'Save report').click()`);
    await wait(500);
    check('a report with no real description is refused', /describe/i.test(await hw.executeJavaScript(`document.querySelector('.fb-status').textContent`)));
    if (folder) fs.rmSync(folder, { recursive: true, force: true });

    // About.
    await hw.executeJavaScript(`location.hash = '#about'`);
    const aboutText = await until(() => hw.executeJavaScript(`(document.querySelector('.help-about')?.textContent || '')`));
    check('About shows name, version, channel and build', /Static/.test(aboutText) && /Version \d+\.\d+\.\d+/.test(aboutText) && /build/.test(aboutText), aboutText);
    const aboutTable = await hw.executeJavaScript(`document.querySelector('.help-table').textContent`);
    check('with Chromium, Electron, OS and both folders', /Chromium/.test(aboutTable) && /Electron/.test(aboutTable) && /Installed in/.test(aboutTable) && /Your data/.test(aboutTable));
    await wait(500);
    const a = await hw.capturePage().catch(() => null);
    if (a) fs.writeFileSync(path.join(shots, 'help-about.png'), a.toPNG());

    // Diagnostics.
    await hw.executeJavaScript(`location.hash = '#diagnostics'`);
    const diag = await until(() => hw.executeJavaScript(`(document.querySelector('.help-table')?.textContent || '').includes('GPU') ? document.querySelector('.help-table').textContent : ''`));
    check('Diagnostics lists CPU, GPU, memory, screen, network and extensions', ['CPU', 'GPU', 'Memory', 'Screen', 'Network', 'Extensions'].every((k) => diag.includes(k)), diag.slice(0, 160));

    // Legal.
    await hw.executeJavaScript(`location.hash = '#legal'`);
    const docs = await until(() => hw.executeJavaScript(`document.querySelectorAll('.help-doc').length`));
    check('Privacy & legal lists every document', docs >= 16, docs);
    await hw.executeJavaScript(`location.hash = '#legal/privacy'`);
    const policy = await until(() => hw.executeJavaScript(`document.querySelector('.help-flows') ? document.getElementById('help-main').textContent : ''`));
    check('the Privacy Policy lists every outside service and when it is contacted', /favicon/i.test(policy) && /Gemini/.test(policy) && /GitHub/.test(policy), policy.length);
    check('and says there is no telemetry', /no telemetry/i.test(policy));
    check('unfilled publisher details show as blanks, not invented', /to be added/.test(policy) && /not finished/.test(policy));
    await wait(400);
    const l = await hw.capturePage().catch(() => null);
    if (l) fs.writeFileSync(path.join(shots, 'help-privacy.png'), l.toPNG());

    // Search.
    await hw.executeJavaScript(`(() => { const s = document.getElementById('help-search'); s.value = 'cookies'; s.dispatchEvent(new Event('input')); })()`);
    const found = await hw.executeJavaScript(`[...document.querySelectorAll('.help-doc strong')].map(n => n.textContent)`);
    check('help search finds policies by what they say', found.includes('Cookie Policy'), found.join(', '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall help centre checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
