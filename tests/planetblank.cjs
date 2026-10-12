/**
 * The planetarium when Settings does NOT open on Appearance.
 *
 * tests/planetarium.cjs navigates straight to `browser://settings#appearance`,
 * so the canvas is laid out from its first frame. The reported blank - about
 * one open in four - is on the ordinary path: Settings opens on `start`, the
 * planetarium is built inside a `hidden` section (no box, so no size), and it
 * only has to draw once someone picks Appearance.
 *
 * This probe reproduces that path and gives the canvas a SHORT budget to
 * paint, so "it eventually painted after seconds of retrying" is a failure
 * here rather than a pass.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lit sample count for the planetarium canvas, or a reason it has none. */
const LIT = `(function(){
  var c = document.querySelector('.planetarium-canvas');
  if (!c) return { state: 'no-canvas' };
  if (!c.width || !c.height) return { state: 'no-buffer', w: c.width, h: c.height };
  var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  var lit = 0;
  for (var i = 3; i < d.length; i += 400) if (d[i] > 12) lit++;
  return { state: 'measured', lit: lit, w: c.width, h: c.height, shown: c.clientWidth };
})()`;

async function run(browser) {
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 150) : ''));
    if (!ok) fails++;
  };

  // How many opens to try. The bug is intermittent, so one clean open proves
  // nothing; this is what turns "about one in four" into a signal.
  const ROUNDS = Number(process.env.PLANETBLANK_ROUNDS || 6);
  const blanks = [];

  try {
    await wait(1200);
    browser.settings.update({ customPlanets: [], theme: 'neptune' });
    browser.push();

    const wc = browser.tabs.active.view.webContents;

    for (let round = 1; round <= ROUNDS; round++) {
      // A fresh load each round: the race is on the first paint after mount,
      // so the page has to be built again, not just re-shown.
      browser.tabs.navigate(browser.tabs.activeId, 'browser://newtab');
      for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(100);
      // No #appearance: Settings opens on `start` and builds the planetarium
      // inside a hidden section, exactly as it does for a person.
      browser.tabs.navigate(browser.tabs.activeId, 'browser://settings');
      for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(100);
      await wait(900); // let the state push land and mount the widget

      const hiddenState = await wc.executeJavaScript(`(function(){
        var s = document.querySelector('[data-section="appearance"]');
        var c = document.querySelector('.planetarium-canvas');
        return { sectionHidden: !!(s && s.hidden), mounted: !!c };
      })()`);
      if (round === 1) {
        check('Settings opens with Appearance hidden', hiddenState.sectionHidden, JSON.stringify(hiddenState));
        check('the planetarium is mounted while hidden', hiddenState.mounted, JSON.stringify(hiddenState));
      }

      // Pick Appearance the way a person does, by clicking its nav button.
      await wc.executeJavaScript(`(function(){
        var b = document.querySelector('[data-section-target="appearance"]')
             || [...document.querySelectorAll('button,a')].find(function(n){
                  return /appearance/i.test(n.textContent || '');
                });
        if (b) b.click();
        return !!b;
      })()`);

      // A person waits a moment, not several seconds. Poll briefly.
      let seen = null;
      for (let i = 0; i < 12; i++) {       // ~1.2s budget
        seen = await wc.executeJavaScript(LIT);
        if (seen.state === 'measured' && seen.lit > 20) break;
        await wait(100);
      }
      const painted = seen && seen.state === 'measured' && seen.lit > 20;
      console.log(`      round ${round}: ${painted ? 'painted' : 'BLANK'} :: ${JSON.stringify(seen)}`);
      if (!painted) blanks.push({ round, seen });
    }

    check(
      `the planetarium paints on every open (${ROUNDS} opens)`,
      blanks.length === 0,
      blanks.length ? `${blanks.length}/${ROUNDS} blank: ${JSON.stringify(blanks[0].seen)}` : 'all painted',
    );

    /* A frame that throws must cost one frame, not the planetarium ----------
       The loop used to re-arm itself as the last statement of its drawing
       code, so a single throw mid-frame stopped it for good and the canvas
       stayed blank until Settings was reopened. The re-arm now sits in a
       `finally`. This proves it with a real fault rather than by reading the
       code: break one frame, then check the planets are still moving. */
    const moved = await wc.executeJavaScript(`(async function(){
      var wrap = document.querySelector('.planetarium');
      if (!wrap || !wrap.planetariumBodies) return { ok: false, why: 'no planetarium' };
      var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

      // arc() is called for every planet drawn, so this throws inside a frame.
      var proto = CanvasRenderingContext2D.prototype;
      var original = proto.arc;
      var thrown = 0;
      proto.arc = function(){
        if (thrown < 1) { thrown++; throw new Error('injected frame fault'); }
        return original.apply(this, arguments);
      };
      await sleep(250);
      proto.arc = original;           // only the one frame is broken
      await sleep(350);

      // Still animating? Sample one body twice; an orbiting system drifts.
      var first = wrap.planetariumBodies();
      await sleep(320);
      var second = wrap.planetariumBodies();
      if (!first.length || !second.length) return { ok: false, why: 'no bodies after fault', thrown: thrown };
      var drift = Math.max.apply(null, first.map(function(body, i){
        var other = second[i] || body;
        return Math.abs(body.x - other.x) + Math.abs(body.y - other.y);
      }));
      return { ok: thrown === 1 && drift > 0.05, thrown: thrown, drift: Number(drift.toFixed(3)), bodies: second.length };
    })()`);
    check('a frame that throws costs one frame, not the planetarium', moved.ok, JSON.stringify(moved));

    const afterFault = await wc.executeJavaScript(LIT);
    check(
      'the canvas is still painted after a broken frame',
      afterFault.state === 'measured' && afterFault.lit > 20,
      JSON.stringify(afterFault),
    );
  } catch (error) {
    check('probe ran', false, error && error.stack ? error.stack : error);
  }

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  require('electron').app.exit(fails ? 1 : 0);
}

module.exports = { run };
