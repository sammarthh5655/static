const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/** Forge a planet in Settings and check it joins the solar system. Off-screen. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const until = async (fn, tries = 50) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(150); } return null; };

  try {
    browser.window.show();
    await wait(900);
    browser.settings.update({ customPlanets: [], theme: 'neptune' });
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const loaded = new Promise((resolve) => { wc.once('did-finish-load', resolve); setTimeout(resolve, 8000); });
    browser.tabs.navigate(tab.id, 'browser://settings#appearance');
    await loaded;
    await until(() => wc.executeJavaScript(`!!document.querySelector('.planetarium-canvas')`));
    await wait(1200);

    // The Sun: the brightest thing at the centre of the canvas.
    const centre = await wc.executeJavaScript(`(() => {
      const c = document.querySelector('.planetarium-canvas');
      const x = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return [x[0], x[1], x[2], x[3]];
    })()`);
    check('the Sun is drawn at the centre of the solar system', centre[3] > 200 && centre[0] > 200 && centre[1] > 120, JSON.stringify(centre));
    const shot0 = await wc.capturePage().catch(() => null);
    if (shot0) fs.writeFileSync(path.join(shots, 'planetarium.png'), shot0.toPNG());

    // Forge one through the page.
    await wc.executeJavaScript(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('forge-name', 'Aurelia');
      set('forge-primary', '#d4a24a');
      set('forge-secondary', '#c0567a');
      set('forge-deep', '#2a1a08');
      set('forge-accent', '#e8b85a');
      set('forge-glow', '80');
      set('forge-glass', '45');
    })()`);
    await wait(300);
    const preview = await wc.executeJavaScript(`({
      title: document.getElementById('forge-title').textContent,
      bg: document.getElementById('forge-preview').style.getPropertyValue('--f-bg'),
      orb: document.getElementById('forge-orb').style.background.slice(0, 40),
    })`);
    check('the preview is painted from the real theme builder as you type', preview.title === 'Aurelia' && /^#/.test(preview.bg) && /gradient/.test(preview.orb), JSON.stringify(preview));
    await wc.executeJavaScript(`document.getElementById('forge-preview').scrollIntoView({ block: 'center' })`);
    await wait(300);
    const shot1 = await wc.capturePage().catch(() => null);
    if (shot1) fs.writeFileSync(path.join(shots, 'forge.png'), shot1.toPNG());

    await wc.executeJavaScript(`document.getElementById('forge-apply').click()`);
    const made = await until(() => browser.settings.value.customPlanets.find((p) => p.name === 'Aurelia'));
    check('"Add to the solar system" saves a named planet', made?.id === 'planet-aurelia', JSON.stringify(made));
    await until(() => browser.settings.value.theme === 'planet-aurelia');
    await wait(400);
    check('and the browser wears it at once', browser.settings.value.theme === 'planet-aurelia', browser.settings.value.theme);
    const inSystem = browser.state().catalog.planets.find((p) => p.id === 'planet-aurelia');
    check('it is in the solar system the planetarium draws', !!inSystem && inSystem.custom === true, JSON.stringify(inSystem));
    const chrome = await browser.chrome.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
    check('the toolbar is wearing its accent', chrome === '#e8b85a', chrome);
    const listed = await until(() => wc.executeJavaScript(`[...document.querySelectorAll('.forge-made-item strong')].map(n => n.textContent).join(',')`));
    check('it is listed under Your planets', /Aurelia/.test(listed || ''), listed);
    await wait(900);
    const shot2 = await wc.capturePage().catch(() => null);
    if (shot2) fs.writeFileSync(path.join(shots, 'forge-worn.png'), shot2.toPNG());

    // A duplicate name is refused, politely.
    await wc.executeJavaScript(`(() => { const n = document.getElementById('forge-name'); n.value = 'aurelia'; n.dispatchEvent(new Event('input')); document.getElementById('forge-apply').click(); })()`);
    const status = await until(() => wc.executeJavaScript(`document.getElementById('forge-status').textContent`));
    check('a second planet with the same name is refused, with a reason', /already have a planet called/.test(status || ''), status);

    browser.settings.update({ customPlanets: [], theme: 'neptune' });
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall forge checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
