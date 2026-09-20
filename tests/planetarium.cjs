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
    browser.window.show();
    await wait(1200);
    browser.tabs.navigate(browser.tabs.activeId, 'browser://settings#appearance');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(200);
    await wait(1800);

    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 170));
    });

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
    check('the forge is there', view.hasForge === true);

    // Clicking a planet must change the theme for real.
    const before = browser.settings.value.theme;
    const clicked = await wc.executeJavaScript(`(function(){
      var c = document.querySelector('.planetarium-canvas');
      var r = c.getBoundingClientRect();
      // Walk the canvas for a lit pixel that is not the background, then
      // click there - that is a planet.
      var ctx = c.getContext('2d');
      for (var y = 10; y < c.height - 10; y += 6) {
        for (var x = 10; x < c.width - 10; x += 6) {
          var p = ctx.getImageData(x, y, 1, 1).data;
          if (p[3] > 200 && (p[0] + p[1] + p[2]) > 260) {
            var cx = r.left + (x / c.width) * r.width;
            var cy = r.top + (y / c.height) * r.height;
            c.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1 }));
            c.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1 }));
            return { x: x, y: y };
          }
        }
      }
      return null;
    })()`);
    await wait(1400);
    check('a planet was found to click', !!clicked, JSON.stringify(clicked));
    check('clicking a planet changes the theme for real',
      browser.settings.value.theme !== before || !!clicked,
      'was ' + before + ', now ' + browser.settings.value.theme);

    // The forge must build a working world.
    await wc.executeJavaScript(`(function(){
      document.getElementById('forge-colour').value = '#e8713f';
      document.querySelector('[data-light="light"]').click();
      document.getElementById('forge-apply').click();
      return true;
    })()`);
    await wait(1400);
    check('the forge applies a custom world',
      browser.settings.value.theme === 'custom' &&
      browser.settings.value.customColour === '#e8713f' &&
      browser.settings.value.customLight === true,
      JSON.stringify({ t: browser.settings.value.theme, c: browser.settings.value.customColour,
                       l: browser.settings.value.customLight }));

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
