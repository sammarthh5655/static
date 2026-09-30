const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 130) : ''));
    if (!ok) fails++;
  };

  try {
    // Off-screen: probes never show the window (see main.js).
    await wait(1200);
    // A clean solar system: a planet forged by an earlier run would make the
    // forge (rightly) refuse a second one with the same name.
    browser.settings.update({ customPlanets: [], theme: 'neptune' });
    browser.push();
    browser.tabs.navigate(browser.tabs.activeId, 'browser://settings#appearance');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(200);
    await wait(1800);

    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 170));
    });

    // The planetarium draws on requestAnimationFrame, so a fixed sleep races
    // the first paint - this failed about one run in three. Wait for actual
    // pixels instead.
    for (let i = 0; i < 40; i++) {
      const painted = await wc.executeJavaScript(`(function(){
        var c = document.querySelector('.planetarium-canvas');
        if (!c || !c.width) return 0;
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        var lit = 0;
        for (var i = 3; i < d.length; i += 400) if (d[i] > 12) lit++;
        return lit;
      })()`).catch(() => 0);
      if (painted > 40) break;
      await wait(250);
    }
    const why = await wc.executeJavaScript(`(function(){
      var c = document.querySelector('.planetarium-canvas');
      if (!c) return { canvas: false };
      return {
        canvas: true, w: c.width, h: c.height,
        cssW: c.getBoundingClientRect().width,
        connected: c.isConnected,
        hostChildren: (document.getElementById('planetarium-host')||{children:[]}).children.length,
        sectionHidden: (c.closest('[data-section]')||{}).hidden,
        display: getComputedStyle(c).display,
      };
    })()`).catch((e) => ({ err: e.message }));
    console.log('  [diag]', JSON.stringify(why));

    const view = await wc.executeJavaScript(`({
      hasCanvas: !!document.querySelector('.planetarium-canvas'),
      noDropdown: !document.getElementById('theme'),
      canvasW: (document.querySelector('.planetarium-canvas')||{}).width || 0,
      canvasH: (document.querySelector('.planetarium-canvas')||{}).height || 0,
      hasForge: !!document.getElementById('forge-apply'),
      caption: (document.querySelector('.planetarium-name')||{}).textContent || '',
      painted: (function(){
        var c = document.querySelector('.planetarium-canvas');
        if (!c) return 0;
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        var lit = 0;
        for (var i = 3; i < d.length; i += 400) if (d[i] > 12) lit++;
        return lit;
      })(),
    })`);

    check('the theme dropdown is gone', view.noDropdown === true);
    check('the planetarium is mounted', view.hasCanvas === true);
    check('it has real size', view.canvasW > 200 && view.canvasH > 100,
      view.canvasW + 'x' + view.canvasH);
    check('planets are actually drawn', view.painted > 40, view.painted + ' lit samples');
    check('the current planet is named', view.caption.length > 0, view.caption);

    // Every planet must be fully inside the canvas - the outer orbits used to
    // run off the right edge and two planets were drawn half cut off.
    const inside = await wc.executeJavaScript(`(function(){
      var c = document.querySelector('.planetarium-canvas');
      var ctx = c.getContext('2d');
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      // Sample the outermost columns and rows: a planet touching the edge
      // means it is clipped.
      function litAt(x, y) {
        var i = (y * c.width + x) * 4;
        return d[i + 3] > 200 && (d[i] + d[i+1] + d[i+2]) > 300;
      }
      var edge = 0;
      for (var y = 0; y < c.height; y += 2) {
        if (litAt(0, y) || litAt(c.width - 1, y)) edge++;
      }
      for (var x = 0; x < c.width; x += 2) {
        if (litAt(x, 0) || litAt(x, c.height - 1)) edge++;
      }
      return edge;
    })()`);
    check('no planet is clipped by the canvas edge', inside === 0,
      inside + ' lit pixels on the border');
    check('the forge is there', view.hasForge === true);

    // Clicking a planet must change the theme for real: a real mouse press
    // and release where the planet is drawn, and the stored theme follows.
    const before = browser.settings.value.theme;
    const target = await wc.executeJavaScript(`(function(){
      var wrap = document.querySelector('.planetarium');
      var c = wrap.querySelector('.planetarium-canvas');
      var r = c.getBoundingClientRect();
      var pick = wrap.planetariumBodies().filter(function (b) { return b.id !== ${JSON.stringify(before)}; })[0];
      return pick ? { id: pick.id, x: Math.round(r.left + pick.x), y: Math.round(r.top + pick.y) } : null;
    })()`);
    check('a planet was found to click', !!target, JSON.stringify(target));
    if (target) {
      wc.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
      wc.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
      await wait(900);
    }
    check('clicking a planet changes the theme for real',
      !!target && browser.settings.value.theme === target.id,
      'was ' + before + ', clicked ' + (target && target.id) + ', now ' + browser.settings.value.theme);

    // The forge must build a working world, and it joins the solar system.
    await wc.executeJavaScript(`(function(){
      document.getElementById('forge-name').value = 'Ember';
      document.getElementById('forge-primary').value = '#e8713f';
      document.querySelector('[data-light="light"]').click();
      document.getElementById('forge-apply').click();
      return true;
    })()`);
    await wait(1600);
    const made = (browser.settings.value.customPlanets || []).find((planet) => planet.name === 'Ember');
    check('the forge applies a world of your own',
      !!made && browser.settings.value.theme === made.id && made.primary === '#e8713f' && made.light === true,
      JSON.stringify({ theme: browser.settings.value.theme, made }));
    const joined = await wc.executeJavaScript(`(function(){
      var wrap = document.querySelector('.planetarium');
      return wrap && wrap.planetariumBodies ? wrap.planetariumBodies().map(function (b) { return b.id; }) : [];
    })()`);
    check('it joins the solar system', !!made && joined.includes(made.id), joined.join(','));

    check('no page errors', errors.length === 0, errors.join(' | '));

    const dir = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(dir, { recursive: true });
    browser.settings.update({ theme: 'neptune' });
    browser.push();
    await wait(1600);
    let img = null;
    for (let i = 0; i < 4 && !img; i++) { img = await wc.capturePage().catch(() => null); if (!img) await wait(800); }
    if (img) { fs.writeFileSync(path.join(dir, 'planetarium.png'), img.toPNG()); console.log('shot written'); }
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall planetarium checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
