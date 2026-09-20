const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * browser://welcome checks. Run with `npm run test:welcome`.
 *
 * Drives the real page in a real window, because the failures worth catching
 * here are the ones a unit test cannot see: a step that renders nothing, a
 * choice that does not stick, a Continue button that stays disabled, or a
 * flow that cannot be left.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 140) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1200);

    // Start from a profile that has not been set up, whatever this machine's
    // real profile says, so the flow under test is the first-launch one.
    browser.onboarding.restart({ fresh: true });

    browser.tabs.navigate(browser.tabs.activeId, 'browser://welcome');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(200);
    await wait(700);

    const errors = [];
    wc.on('console-message', (event) => {
      if (event?.level === 'error' || event?.level === 3) errors.push(String(event.message).slice(0, 160));
    });

    const read = () => wc.executeJavaScript(`({
      title: document.getElementById('title').textContent,
      lede: document.getElementById('lede').textContent,
      steps: document.querySelectorAll('.welcome-step').length,
      current: document.querySelector('.welcome-step.is-current')?.textContent || '',
      choices: [...document.querySelectorAll('.welcome-choice')].map(node => ({
        name: node.querySelector('.welcome-choice-name')?.textContent || '',
        summary: node.querySelector('.welcome-choice-summary')?.textContent || '',
        chosen: node.classList.contains('is-chosen'),
      })),
      nextText: document.getElementById('next').textContent,
      nextDisabled: document.getElementById('next').disabled,
      backDisabled: document.getElementById('back').disabled,
      skipHidden: document.getElementById('skip').hidden,
      listItems: document.querySelectorAll('.welcome-list li').length,
      error: document.querySelector('.welcome-error')?.textContent || '',
    })`);

    const click = (selector) => wc.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).click(), true`);

    /** Click the nth choice card (1-based), by position in the card list. */
    const clickChoice = (n) => wc.executeJavaScript(
      `document.querySelectorAll('.welcome-choice')[${n - 1}].click(), true`);

    /**
     * Wait until the panel title matches, rather than sleeping a guessed
     * interval. The flow does two IPC round-trips plus a transition per step,
     * so a fixed wait either flakes or slows every run.
     */
    const until = async (pattern, label) => {
      for (let i = 0; i < 50; i++) {
        const title = await wc.executeJavaScript(`document.getElementById('title').textContent`);
        if (pattern.test(title)) return title;
        await wait(100);
      }
      return await wc.executeJavaScript(`document.getElementById('title').textContent`);
    };

    // The first paint needs an IPC round-trip for the state, so wait for the
    // page to actually have content before reading it.
    await until(/./, 'first render');

    // ---- welcome step -----------------------------------------------------
    let view = await read();
    check('welcome step renders with a title and the step list',
      !!view.title && view.steps >= 5, JSON.stringify({ title: view.title, steps: view.steps }));
    check('welcome step says what the browser does', view.listItems >= 3, 'items=' + view.listItems);
    check('back is disabled on the first step', view.backDisabled === true);
    check('the first step is not skippable', view.skipHidden === true);

    await click('#next');
    await wait(600);

    // ---- profile step -----------------------------------------------------
    view = await read();
    check('profile step offers every profile as a card',
      view.choices.length === 4, 'choices=' + view.choices.length);
    check('every profile card explains what it changes',
      view.choices.every((choice) => choice.name && choice.summary.length > 20),
      JSON.stringify(view.choices.map((choice) => choice.name)));
    check('continue waits for the one required answer', view.nextDisabled === true);
    check('the required profile step cannot be skipped', view.skipHidden === true);

    // Choosing advances, because choosing IS the answer.
    await clickChoice(2);
    await until(/world/i, 'theme');
    view = await read();
    check('choosing a profile advances to the theme step',
      /world/i.test(view.title), view.title);

    // The theme step is the planetarium, not a list of cards.
    const planets = await wc.executeJavaScript(`(function(){
      var c = document.querySelector('.planetarium-canvas');
      if (!c) return { canvas: false };
      var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      var lit = 0;
      for (var i = 3; i < d.length; i += 400) if (d[i] > 12) lit++;
      return { canvas: true, painted: lit, name: (document.querySelector('.planetarium-name')||{}).textContent || '' };
    })()`);
    check('the theme step shows the planetarium', planets.canvas === true);
    check('planets are drawn there too', planets.painted > 30, planets.painted + ' lit samples');
    check('and one is named', planets.name.length > 0, planets.name);

    // It is optional, so it can be passed over.
    await click('#skip');
    await until(/homepage/i, 'homepage');
    view = await read();
    check('the theme step can be skipped', /homepage/i.test(view.title), view.title);
    check('the chosen profile really reached settings',
      browser.settings.value.density === 'compact' || browser.settings.value.theme === 'pluto',
      JSON.stringify({ theme: browser.settings.value.theme, density: browser.settings.value.density }));

    // ---- homepage step ----------------------------------------------------
    check('optional steps show the skip control', view.skipHidden === false);
    check('homepage step offers layouts', view.choices.length >= 3, 'choices=' + view.choices.length);

    await clickChoice(1);
    await until(/privacy/i, 'privacy');
    const widgets = browser.settings.value.newTab.widgets;
    check('the chosen layout really reached settings',
      Array.isArray(widgets) && widgets.length >= 1, JSON.stringify(widgets));

    // ---- privacy step -----------------------------------------------------
    view = await read();
    check('privacy step follows the homepage step', /privacy/i.test(view.title), view.title);
    check('privacy levels state their trade-off',
      view.choices.every((choice) => choice.summary.length > 20));

    // Skip it, to prove skipping works and is recorded.
    await click('#skip');
    await until(/assistant/i, 'assistant');
    view = await read();
    check('skipping a step moves on', !/privacy/i.test(view.title), view.title);
    check('the skipped step is marked in the step list',
      await wc.executeJavaScript(`document.querySelectorAll('.welcome-step.is-skipped').length >= 1`));

    // ---- assistant step ---------------------------------------------------
    check('assistant step is reached', /assistant/i.test(view.title), view.title);

    await click('#next');
    await until(/set up|done/i, 'done');

    // ---- done step --------------------------------------------------------
    view = await read();
    check('the last step summarises what was chosen', view.listItems >= 1, 'items=' + view.listItems);
    check('the last step offers to start browsing',
      /start browsing/i.test(view.nextText), view.nextText);
    check('the summary is honest about the skipped step',
      await wc.executeJavaScript(
        `[...document.querySelectorAll('.welcome-note')].some(n => /skipped/i.test(n.textContent))`));

    // ---- leaving ----------------------------------------------------------
    await click('#next');
    await wait(900);

    check('finishing marks the profile as set up', browser.onboarding.completed === true);
    check('finishing leaves the welcome page',
      !/welcome/.test(browser.tabs.active?.state?.displayUrl || ''),
      browser.tabs.active?.state?.displayUrl);
    check('a set-up profile no longer starts on welcome',
      browser.onboarding.due === false);

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall welcome checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
