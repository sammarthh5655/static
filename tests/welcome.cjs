const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * browser://welcome checks. Run with `npm run test:welcome`. Off-screen.
 *
 * Drives the real page the way a person does - real clicks on real buttons -
 * because the failures worth catching here are the ones a unit test cannot
 * see: a step that renders nothing, a choice that does not stick, a flow that
 * cannot be left, or a guide that never opens.
 *
 * Setup is walked twice: once on a computer with no other browser (welcome,
 * a world, done) and once with a synthetic Chrome profile to bring things
 * from (welcome, a world, bring your stuff, done). Never the user's own
 * browsers: every importer root points at a stand-in.
 *
 * Run it twice on the same profile to check the other half of the promise:
 * the first launch of a fresh profile opens setup, and a launch after it was
 * finished does not. A marker file in the test profile says which this is.
 */

/** A synthetic Chrome profile with two bookmarks and three visits. */
function chromeFixture() {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-welcome-'));
  const chrome = path.join(root, 'chrome');
  fs.mkdirSync(path.join(chrome, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' } } } }));
  fs.writeFileSync(path.join(chrome, 'Default', 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: [
    { type: 'url', name: 'Welcome A', url: 'https://welcome-a.example/' }, { type: 'url', name: 'Welcome B', url: 'https://welcome-b.example/' }] } } }));
  const db = new DatabaseSync(path.join(chrome, 'Default', 'History'));
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER)');
  const insert = db.prepare('INSERT INTO urls (url, title, last_visit_time, hidden) VALUES (?, ?, ?, 0)');
  for (let i = 0; i < 3; i++) insert.run('https://welcome-visit' + i + '.example/', 'Visit ' + i, BigInt(Date.UTC(2026, 0, 1 + i) + 11644473600000) * 1000n);
  db.close();
  return { root, chrome };
}

const NOWHERE = { chrome: '/none', edge: '/none', brave: '/none', opera: '/none', vivaldi: '/none', firefox: '/none' };

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 160) : ''));
    if (!ok) fails++;
  };

  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const marker = path.join(browser.dir, 'welcome-probe-ran');
  const fixture = chromeFixture();

  try {
    await wait(1200);

    // ---- first launch, or a later one ------------------------------------
    const firstUrl = browser.tabs.active?.state?.displayUrl || '';
    if (fs.existsSync(marker)) {
      check('a finished profile is not set up again on its next launch',
        browser.onboarding.due === false && !/^browser:\/\/welcome/.test(firstUrl), firstUrl);
    } else {
      check('a fresh profile opens setup on its first launch',
        browser.onboarding.due === true && /^browser:\/\/welcome/.test(firstUrl), firstUrl);
    }

    const wc = () => browser.tabs.active.view.webContents;
    const js = (code) => wc().executeJavaScript(code);
    const errors = [];
    const watch = () => wc().on('console-message', (event) => {
      if (event?.level === 'error' || event?.level === 3) errors.push(String(event.message).slice(0, 160));
    });

    const read = () => js(`({
      title: document.getElementById('title').textContent,
      lede: document.getElementById('lede').textContent,
      steps: [...document.querySelectorAll('.welcome-step')].map(n => n.textContent),
      current: document.querySelector('.welcome-step.is-current')?.textContent || '',
      nextText: document.getElementById('next').textContent,
      backDisabled: document.getElementById('back').disabled,
      skipHidden: document.getElementById('skip').hidden,
      skipText: document.getElementById('skip').textContent,
      list: [...document.querySelectorAll('.welcome-list li')].map(n => n.textContent),
      notes: [...document.querySelectorAll('.welcome-note, .welcome-defaults')].map(n => n.textContent),
      error: document.querySelector('.welcome-error')?.textContent || '',
    })`);

    /** A real click: the pointer moves to the element and presses. */
    const click = async (selector) => {
      const at = await js(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      })()`);
      if (!at) throw new Error('nothing to click at ' + selector);
      wc().sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      await wait(30);
      wc().sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await wait(40);
      wc().sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    };

    /** Wait for the panel title to match, rather than sleeping a guess. */
    const until = async (pattern) => {
      for (let i = 0; i < 60; i++) {
        const title = await js(`document.getElementById('title').textContent`).catch(() => '');
        if (pattern.test(title)) return title;
        await wait(100);
      }
      return js(`document.getElementById('title').textContent`).catch(() => '');
    };

    const shot = async (name) => {
      await wait(900);
      const image = await wc().capturePage().catch(() => null);
      if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG());
    };

    /** Start setup over from nothing, as a fresh profile would see it. */
    const begin = async (roots) => {
      browser.importRoots = roots;
      browser.onboarding.restart({ fresh: true });
      const loaded = new Promise((resolve) => { wc().once('did-finish-load', resolve); setTimeout(resolve, 8000); });
      browser.tabs.navigate(browser.tabs.activeId, 'browser://welcome');
      await loaded;
      watch();
      await until(/welcome/i);
    };

    // ======================================================================
    // Without another browser on this computer
    // ======================================================================
    await begin(NOWHERE);
    let view = await read();
    check('[no import] setup is three screens: welcome, a world, done',
      JSON.stringify(view.steps) === JSON.stringify(['Welcome to Static', 'Choose a world', 'You are set up']), JSON.stringify(view.steps));
    check('[no import] the welcome screen says what the browser does', view.list.length >= 3, view.list.length);
    check('[no import] and how short setup is', view.notes.some((note) => /one quick choice/.test(note)), view.notes.join(' | '));
    check('[no import] back is disabled on the first step', view.backDisabled === true);
    check('[no import] the first step is not skippable', view.skipHidden === true);
    await shot('welcome-1-welcome');

    await click('#next');
    await until(/world/i);
    view = await read();
    check('[no import] the second screen is the world', /choose a world/i.test(view.title), view.title);
    check('[no import] and it can be skipped', view.skipHidden === false && /skip this/i.test(view.skipText), view.skipText);

    // The theme step is the planetarium; pick Mars where it is drawn.
    await wait(600);
    const layout = () => js(`(function(){
      var wrap = document.querySelector('.planetarium');
      var c = document.querySelector('.planetarium-canvas');
      if (!wrap || !c || !wrap.planetariumBodies) return null;
      var r = c.getBoundingClientRect();
      var ratio = Math.min(devicePixelRatio || 1, 2);
      var sx = r.width / (c.width / ratio), sy = r.height / (c.height / ratio);
      return { left: r.left, top: r.top, bodies: wrap.planetariumBodies().map(function (b) {
        return { id: b.id, x: b.x * sx, y: b.y * sy };
      }) };
    })()`);
    const planets = await layout();
    check('[no import] the planetarium draws every planet', planets && planets.bodies.length >= 11, planets && planets.bodies.length);
    const mars = planets?.bodies.find((body) => body.id === 'mars');
    if (mars) {
      const x = Math.round(planets.left + mars.x);
      const y = Math.round(planets.top + mars.y);
      wc().sendInputEvent({ type: 'mouseMove', x, y });
      await wait(40);
      wc().sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await wait(60);
      wc().sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await wait(900);
    }
    check('[no import] a clicked planet is worn by the browser', browser.settings.value.theme === 'mars', browser.settings.value.theme);
    check('[no import] and by the welcome page itself',
      (await js(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`))
        === require('../src/shared/theme').cssVariables({ ...browser.settings.value, theme: 'mars' })['--bg']);
    await shot('welcome-2-world');

    await click('#next');
    await until(/set up/i);
    view = await read();
    check('[no import] a world leads straight to the end: nothing else is asked', /you are set up/i.test(view.title), view.title);
    check('[no import] the end names the world chosen', view.list.some((line) => /Your world/.test(line) && /Mars/.test(line)), view.list.join(' | '));
    check('[no import] and says, in one line, that everything else is on defaults in Settings',
      view.notes.some((note) => /sensible defaults/.test(note) && /Settings/.test(note)), view.notes.join(' | '));
    check('[no import] the way on is the guide', /show me around/i.test(view.nextText), view.nextText);
    check('[no import] with a way past it', view.skipHidden === false && /skip the tour/i.test(view.skipText), view.skipText);
    await shot('welcome-3-done');

    await click('#next');
    let landed = '';
    for (let i = 0; i < 40 && !/guide/.test(landed); i++) { await wait(150); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('[no import] finishing marks the profile as set up', browser.onboarding.completed === true);
    check('[no import] finishing opens the guide', /^browser:\/\/guide/.test(landed), landed);
    await wait(900);
    check('[no import] the guide arrives knowing it follows setup',
      await js(`document.getElementById('skip').textContent`) === 'Skip the tour');
    await shot('welcome-4-guide');

    // ======================================================================
    // With another browser to bring things from
    // ======================================================================
    // What an earlier run brought over is taken away again, so the import
    // below has something new to bring.
    const tidy = () => {
      for (const b of browser.bookmarks.list()) if (/welcome-[ab]\.example/.test(b.url)) browser.bookmarks.remove(b.id);
      for (const h of browser.history.search('welcome-visit')) browser.history.remove(h.id);
    };
    tidy();
    await begin({ ...NOWHERE, chrome: fixture.chrome });
    view = await read();
    check('[import] setup is four screens when there is something to bring',
      JSON.stringify(view.steps) === JSON.stringify(['Welcome to Static', 'Choose a world', 'Bring your stuff', 'You are set up']), JSON.stringify(view.steps));
    check('[import] and the welcome screen says two choices', view.notes.some((note) => /two quick choices/.test(note)), view.notes.join(' | '));

    // Static's own animations switch stills the page, not only the system's.
    const animations = browser.settings.value.animations;
    browser.settings.update({ animations: false });
    browser.push();
    await wait(500);
    const still = await js(`({ still: document.body.classList.contains('is-still'),
      running: document.getAnimations().filter(a => a.playState === 'running').length })`);
    check('[import] with animations off, setup stands still', still.still && still.running === 0, JSON.stringify(still));
    browser.settings.update({ animations });
    browser.push();
    await wait(300);

    await click('#next');
    await until(/world/i);
    await click('#skip');
    await until(/bring your stuff/i);
    check('[import] skipping the world moves on to bringing your stuff', true);
    // The browsers found are listed once detection has answered.
    let tiles = [];
    for (let i = 0; i < 30 && !tiles.length; i++) {
      tiles = await js(`[...document.querySelectorAll('.import-browser span:last-child')].map(s => s.textContent)`);
      if (!tiles.length) await wait(100);
    }
    check('[import] the stand-in Chrome is offered, and nothing from this computer', JSON.stringify(tiles) === '["Google Chrome"]', JSON.stringify(tiles));
    await shot('welcome-5-import');

    await click('.import-go');
    let status = '';
    for (let i = 0; i < 40 && !/^Imported/.test(status); i++) {
      await wait(150);
      status = await js(`document.querySelector('.import-status')?.textContent || ''`);
    }
    check('[import] importing really brings the bookmarks and history', /2 bookmarks, 3 history/.test(status), status);
    check('[import] they are in the browser', browser.bookmarks.list().filter((b) => b.source === 'Google Chrome' && /welcome-[ab]/.test(b.url)).length === 2);

    await click('#next');
    await until(/set up/i);
    view = await read();
    check('[import] the end says what was brought over, and from where',
      view.list.some((line) => /Brought over/.test(line) && /2 bookmarks/.test(line) && /Google Chrome/.test(line)), view.list.join(' | '));
    check('[import] the skipped world is said to be left as it was',
      view.list.some((line) => /Your world/.test(line) && /left as it was/.test(line)), view.list.join(' | '));
    check('[import] the step list marks the skipped step',
      await js(`document.querySelectorAll('.welcome-step.is-skipped').length === 1`));
    await shot('welcome-6-done-import');

    // Skipping the tour goes straight to browsing.
    await click('#skip');
    landed = '';
    for (let i = 0; i < 40 && !/newtab/.test(landed); i++) { await wait(150); landed = browser.tabs.active?.state?.displayUrl || ''; }
    check('[import] "Skip the tour" finishes setup without the guide', /^browser:\/\/newtab/.test(landed), landed);
    check('[import] and still marks the profile as set up', browser.onboarding.completed === true && browser.onboarding.due === false);

    // A set-up profile reopened from disk stays set up.
    browser.onboarding.flush();
    const { Onboarding } = require('../src/features/onboarding');
    const reopened = new Onboarding(browser.dir, { settings: browser.settings });
    check('a finished profile, read back from disk, is not due for setup', reopened.due === false);

    check('no page errors', errors.length === 0, errors.join(' | '));
    fs.writeFileSync(marker, String(Date.now()));
    tidy();
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    browser.importRoots = null;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall welcome checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
