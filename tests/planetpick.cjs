const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Settings -> Appearance -> Theme, used the way a person uses it.
 *
 * Settings is opened on its first section and Appearance chosen from the side
 * list (the picker is built while hidden - that is what once stretched it and
 * broke clicking). Then, on arrival and at three window sizes, every planet is
 * clicked where it is actually drawn (a real mouse press and release sent to
 * the page), and the check is that the browser really changes: the stored
 * theme, and the CSS variables the page paints from. Finally a person on a
 * 240 Hz screen hovers, reads the name, and clicks. Screenshots go to shots/.
 *
 * Run: node scripts/start.cjs --planetpick   (the window stays off-screen)
 */
async function run(browser) {
  const { app } = require('electron');
  const { cssVariables } = require('../src/shared/theme');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 200) : ''));
    if (!ok) fails++;
  };
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });

  try {
    await wait(1200);
    // A lived-in profile rather than the defaults: these are the settings the
    // bug was reported with.
    browser.settings.update({ theme: 'mercury', sidebarMode: 'autohide', surfaceStyle: 'shadow',
      radius: 'sharp', density: 'compact' });
    browser.applySidebarMode?.();
    browser.layout?.();
    browser.push();
    // Arrive the way a person does: Settings opens on Get started, then
    // Appearance is chosen from the side list.
    browser.tabs.navigate(browser.tabs.activeId, 'browser://settings');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(200);
    const errors = [];
    wc.on('console-message', (event) => {
      const level = event?.level;
      if (level === 'error' || level === 3 || level === 'warning' || level === 2) {
        errors.push(String(event.message).slice(0, 220));
      }
    });
    await wait(1500);

    const js = (code) => wc.executeJavaScript(code);
    const nav = await js(`(function(){ var r = document.querySelector('[data-category=appearance]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseDown', x: nav.x, y: nav.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: nav.x, y: nav.y, button: 'left', clickCount: 1 });
    await wait(900);
    check('Appearance opened from the side list', (await js('location.hash')) === '#appearance', await js('location.hash'));
    const layout = () => js(`(function(){
      var wrap = document.querySelector('.planetarium');
      var c = document.querySelector('.planetarium-canvas');
      if (!wrap || !c || !wrap.planetariumBodies) return null;
      var r = c.getBoundingClientRect();
      // Bodies are reported in drawing coordinates; place them where they
      // actually appear on screen, which differs if the drawing is stretched.
      var ratio = Math.min(devicePixelRatio || 1, 2);
      var sx = r.width / (c.width / ratio), sy = r.height / (c.height / ratio);
      var bodies = wrap.planetariumBodies().map(function (b) {
        return { id: b.id, x: b.x * sx, y: b.y * sy, r: b.r * Math.min(sx, sy) };
      });
      return { left: r.left, top: r.top, width: r.width, height: r.height,
               vw: innerWidth, vh: innerHeight, bodies: bodies };
    })()`);

    // The picture must be drawn at the size it is shown. A drawing buffer
    // measured while the section was hidden was stretched to fit the card:
    // everything looked widened, and clicks landed where planets were not.
    const measure = () => js(`(function(){ var c = document.querySelector('.planetarium-canvas'); var ratio = Math.min(devicePixelRatio || 1, 2); return { w: Math.round(c.width / ratio), h: Math.round(c.height / ratio), cw: c.clientWidth, ch: c.clientHeight }; })()`);
    const unstretched = (b) => Math.abs(b.w - b.cw) <= 2 && Math.abs(b.h - b.ch) <= 2;
    await wait(400);
    const arrived = await measure();
    check('on arrival: drawn at the size it is shown (not stretched)', unstretched(arrived), JSON.stringify(arrived));

    /** Click every planet where it is drawn: a real press and release. */
    const clickEvery = async (label) => {
      // In an order that always changes the theme (the one worn goes last).
      const ids = (await layout()).bodies.map((b) => b.id);
      const worn = browser.settings.value.theme;
      const order = ids.filter((id) => id !== worn).concat(ids.includes(worn) ? [worn] : []);
      const failed = [];
      for (const id of order) {
        const now = await layout();
        const body = now.bodies.find((b) => b.id === id);
        if (!body) { failed.push(id + ':missing'); continue; }
        const x = Math.round(now.left + body.x);
        const y = Math.round(now.top + body.y);
        if (y < 0 || y > now.vh || x < 0 || x > now.vw) { failed.push(id + ':offscreen'); continue; }
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        await wait(40);
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await wait(60);
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await wait(450);
        const stored = browser.settings.value.theme;
        const expected = cssVariables({ ...browser.settings.value, theme: id })['--bg'];
        const painted = (await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`));
        const caption = await js(`document.querySelector('.planetarium-name').textContent`);
        if (stored !== id || painted !== expected) {
          failed.push(id + ' (stored ' + stored + ', --bg ' + painted + ' want ' + expected + ', caption ' + caption + ')');
        }
      }
      check(label, failed.length === 0, failed.join(' | '));
    };

    await js(`document.querySelector('.planetarium-canvas').scrollIntoView({ block: 'center' })`);
    await wait(500);
    await clickEvery('on arrival: every planet can be chosen by a real click');
    const first = await wc.capturePage().catch(() => null);
    if (first) fs.writeFileSync(path.join(shots, 'planetpick-arrival.png'), first.toPNG());

    const sizes = [[1231, 640], [1440, 900], [900, 700]];
    for (const [width, height] of sizes) {
      const bounds = browser.window.getBounds();
      browser.window.setBounds({ x: bounds.x, y: bounds.y, width, height });
      await wait(900);
      await js(`document.querySelector('.planetarium-canvas').scrollIntoView({ block: 'center' })`);
      await wait(700);
      let view = null;
      for (let i = 0; i < 30; i++) {
        view = await layout().catch(() => null);
        if (view && view.bodies.length) break;
        await wait(200);
      }
      check(width + 'x' + height + ': the planetarium is laid out', view && view.bodies.length >= 11,
        view && JSON.stringify({ w: view.width, h: view.height, vw: view.vw, vh: view.vh, n: view.bodies.length }));
      if (!view) continue;

      const buffer = await measure();
      check(width + ': drawn at the size it is shown (not stretched)', unstretched(buffer), JSON.stringify(buffer));

      // Proportion: a composed scene that never pushes the page away, with
      // every planet clear of the edges of its sky.
      check(width + ': the scene is a sensible height', view.height >= 240 && view.height <= 360,
        Math.round(view.width) + 'x' + Math.round(view.height));
      const tight = view.bodies.filter((b) => b.x - b.r < 8 || b.y - b.r < 8 ||
        b.x + b.r > view.width - 8 || b.y + b.r > view.height - 8);
      check(width + ': no planet crowds the edge', tight.length === 0, tight.map((b) => b.id).join(','));

      const shot = await wc.capturePage().catch(() => null);
      if (shot) fs.writeFileSync(path.join(shots, 'planetpick-' + width + '-before.png'), shot.toPNG());

      await clickEvery(width + ': every planet can be chosen by a real click');

      // The element's own handler, as a screen reader or keyboard user reaches it.
      await js(`document.querySelector('.planetarium-canvas').focus()`);
      const beforeKey = browser.settings.value.theme;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      await wait(450);
      check(width + ': the arrow keys step through the planets', browser.settings.value.theme !== beforeKey,
        beforeKey + ' -> ' + browser.settings.value.theme);

      // Leave a recognisable planet worn for the screenshot.
      const mars = (await layout()).bodies.find((b) => b.id === 'mars');
      if (mars) {
        const now = await layout();
        const x = Math.round(now.left + mars.x); const y = Math.round(now.top + mars.y);
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await wait(1200);
      }
      const after = await wc.capturePage().catch(() => null);
      if (after) fs.writeFileSync(path.join(shots, 'planetpick-' + width + '-after.png'), after.toPNG());
    }

    // A person, on a 240 Hz display (the machine this was reported on): the
    // pointer comes to rest on a planet, they read its name, then click. The
    // display is emulated by running animation frames at 240 a second.
    await js(`(function(){
      window.requestAnimationFrame = function (cb) { return setTimeout(function(){ cb(performance.now()); }, 1000 / 240); };
      return true;
    })()`);
    await wait(600);
    const human = [];
    const ids = (await layout()).bodies.map((b) => b.id);
    const start = browser.settings.value.theme;
    for (const id of ids.filter((x) => x !== start).concat([start])) {
      const now = await layout();
      const body = now.bodies.find((b) => b.id === id);
      const x = Math.round(now.left + body.x);
      const y = Math.round(now.top + body.y);
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      await wait(250);
      const named = await js(`document.querySelector('.planetarium-name').textContent`);
      await wait(550);                       // reading the name, deciding
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await wait(110);
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await wait(450);
      const stored = browser.settings.value.theme;
      if (stored !== id) human.push(id + ' (named ' + named + ', got ' + stored + ')');
    }
    check('240 Hz, hover then click: the planet that was named is the one worn', human.length === 0, human.join(' | '));

    // A light planet too, so the sky is judged in both kinds of theme.
    browser.settings.update({ theme: 'sun' });
    browser.push();
    await wait(1200);
    const light = await wc.capturePage().catch(() => null);
    if (light) fs.writeFileSync(path.join(shots, 'planetpick-light.png'), light.toPNG());

    check('no page errors or warnings', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall planet-pick checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
