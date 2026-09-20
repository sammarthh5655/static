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

    // Start from a known list: the probe profile persists between runs, so
    // without this each run stacks another set of cards on the last.
    for (const extra of browser.profiles.list.slice(1)) {
      try { browser.profiles.remove(extra.id); } catch { /* the last one stays */ }
    }

    // Real profiles with distinct looks.
    browser.profiles.update(browser.profiles.list[0].id, { name: 'Sam', accent: '#e07a52', label: 'personal' });
    const work = browser.profiles.create({ name: 'Work', avatar: 'shield', accent: '#5aa7f0' });
    browser.profiles.create({ name: 'Guest', guest: true });
    const locked = browser.profiles.create({ name: 'Private', accent: '#a48ce0' });
    browser.profiles.setPin(locked.id, '4821');
    browser.profiles.setActive(work.id);

    browser.tabs.navigate(browser.tabs.activeId, 'browser://profiles');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 60 && wc.isLoading(); i++) await wait(200);
    await wait(1600);

    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });

    const view = await wc.executeJavaScript(`({
      title: document.getElementById('title').textContent,
      cards: [...document.querySelectorAll('.picker-card:not(.is-add)')].map(c => ({
        name: c.querySelector('.picker-name').textContent,
        label: c.querySelector('.picker-label').textContent,
        meta: [...c.querySelectorAll('.picker-meta span')].map(s => s.textContent),
        badges: [...c.querySelectorAll('.picker-badge')].map(b => b.textContent),
        tone: c.style.getPropertyValue('--tone'),
        enter: c.querySelector('.picker-enter').textContent,
      })),
      hasAddCard: !!document.querySelector('.picker-card.is-add'),
      stars: !!document.getElementById('stars'),
    })`);

    // The heading is a gradient clipped to the text. If the gradient ever
    // fails to resolve, -webkit-text-fill-color: transparent paints nothing
    // and the title silently disappears - which is exactly what a missing
    // --accent-alt did. Assert the gradient is really there.
    const title = await wc.executeJavaScript(`(() => {
      const h = document.getElementById('title');
      const cs = getComputedStyle(h);
      return { text: h.textContent, bgImage: cs.backgroundImage,
               accentAlt: getComputedStyle(document.documentElement).getPropertyValue('--accent-alt') };
    })()`);
    check('the heading is visible, not a transparent fill over nothing',
      title.bgImage.startsWith('linear-gradient'), title.bgImage.slice(0, 50));
    check('every theme variable a rule depends on is defined',
      !!title.accentAlt.trim(), 'accent-alt = ' + JSON.stringify(title.accentAlt));

    check('the picker renders every profile', view.cards.length === 4, view.cards.length + ' cards');
    check('the tagline is there', /choose your space/i.test(view.title), view.title);
    check('names are the ones the user chose',
      view.cards.map(c => c.name).join(',') === 'Sam,Work,Guest,Private',
      view.cards.map(c => c.name).join(','));
    check('each card carries its own accent',
      view.cards[0].tone === '#e07a52' && view.cards[1].tone === '#5aa7f0',
      JSON.stringify(view.cards.map(c => c.tone)));
    check('a guest is marked as one',
      view.cards.find(c => c.name === 'Guest').badges.includes('Guest'));
    check('a locked profile is marked and says Unlock',
      view.cards.find(c => c.name === 'Private').badges.includes('Locked') &&
      view.cards.find(c => c.name === 'Private').enter === 'Unlock');
    check('last-used and tab counts are shown',
      view.cards[0].meta.length === 2 && /used|tab/i.test(view.cards[0].meta.join(' ')),
      JSON.stringify(view.cards[0].meta));
    check('the user label is shown', view.cards[0].label === 'personal', view.cards[0].label);
    check('there is a way to add a profile', view.hasAddCard === true);

    // A locked profile must ask rather than enter.
    await wc.executeJavaScript(
      `[...document.querySelectorAll('.picker-card')].find(c => /Private/.test(c.textContent)).click(), true`);
    await wait(700);
    const pin = await wc.executeJavaScript(`({
      asks: !!document.querySelector('.picker-pin input'),
      stillHere: location.href.includes('profiles'),
    })`);
    check('a locked profile asks for a PIN instead of entering', pin.asks === true);
    check('and does not navigate away', pin.stillHere === true);

    // A wrong PIN is refused, in place.
    await wc.executeJavaScript(`(() => {
      const i = document.querySelector('.picker-pin input');
      i.value = '0000';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await wait(900);
    const wrong = await wc.executeJavaScript(`({
      error: document.getElementById('error').textContent,
      stillHere: location.href.includes('profiles'),
    })`);
    check('a wrong PIN says so and keeps you on the picker',
      /not right/i.test(wrong.error) && wrong.stillHere, JSON.stringify(wrong));

    check('no page errors', errors.length === 0, errors.join(' | '));

    const dir = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(dir, { recursive: true });
    await wait(600);
    let img = null;
    for (let i = 0; i < 4 && !img; i++) { img = await wc.capturePage().catch(() => null); if (!img) await wait(700); }
    if (img) { fs.writeFileSync(path.join(dir, 'profile-picker.png'), img.toPNG()); console.log('shot written'); }
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall picker checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
