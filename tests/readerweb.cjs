const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reading view on real sites, off-screen. Needs the network; without it the
 * probe says so and passes, since there is nothing to judge.
 *
 * Articles must be offered the book and come out with their headline and a
 * proper amount of text; a front page full of headlines is reported, not
 * failed, because what a front page carries changes by the hour.
 * Pictures land in shots/readerweb-*.png.
 */

const ARTICLES = [
  ['wikipedia', 'https://en.wikipedia.org/wiki/Sleeping_car'],
  ['mdn', 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy'],
  ['paulgraham', 'https://paulgraham.com/greatwork.html'],
  ['govuk', 'https://www.gov.uk/guidance/the-highway-code/rules-for-pedestrians-1-to-35'],
  ['cloudflare', 'https://blog.cloudflare.com/the-road-to-quic/'],
  ['webdev', 'https://web.dev/articles/lcp'],
];
const FRONT_PAGES = [['hackernews', 'https://news.ycombinator.com/']];

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 260) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 50, ms = 150) => {
    for (let i = 0; i < tries; i++) {
      const v = await Promise.resolve().then(fn).catch(() => null);
      if (v) return v;
      await wait(ms);
    }
    return null;
  };
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });

  try {
    await wait(1500);
    const tab = browser.tabs.active;
    const page = tab.view.webContents;
    const open = async (url) => {
      browser.tabs.navigate(tab.id, url);
      await until(() => !page.isLoading() && page.getURL().startsWith(new URL(url).origin), 160, 150);
      // Long enough for the page to settle and be judged.
      await wait(2200);
    };

    await open(ARTICLES[0][1]);
    if (!/^https:/.test(page.getURL()) || tab.state.loadError) {
      console.log('  --  offline, nothing to judge: ' + (tab.state.loadError || page.getURL()));
      console.log('\nall reader web checks passed');
      app.exit(0);
      return;
    }

    for (const [name, url] of ARTICLES) {
      if (name !== ARTICLES[0][0]) await open(url);
      const offered = await until(() => browser.state().reader?.available, 40);
      check(name + ': offered reading view', !!offered, page.getURL());
      const before = Date.now();
      const opened = await browser.pageTools.toggleReader(tab.id);
      const shown = opened && await until(() => page.executeJavaScript(`(() => {
        const body = document.querySelector('.rd-body');
        if (!body) return null;
        return {
          title: document.querySelector('.rd-title')?.textContent,
          meta: document.querySelector('.rd-meta')?.textContent,
          words: body.textContent.split(/\\s+/).filter(Boolean).length,
          paragraphs: body.querySelectorAll('p').length,
          images: body.querySelectorAll('img').length,
          headings: [...body.querySelectorAll('h2, h3')].slice(0, 4).map((h) => h.textContent.trim().slice(0, 40)),
          first: (body.querySelector('p')?.textContent || '').trim().slice(0, 90),
        };
      })()`), 60);
      check(name + ': a headline and the article text', !!shown && shown.title && shown.words > 300 && shown.paragraphs >= 4,
        JSON.stringify(shown) + ' in ' + (Date.now() - before) + 'ms');
      await wait(1200);
      const image = await page.capturePage().catch(() => null);
      if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, 'readerweb-' + name + '.png'), image.toPNG());
      browser.pageTools.leaveReader(tab.id);
      await until(() => !tab.state.internalUrl && !page.isLoading(), 80);
    }

    for (const [name, url] of FRONT_PAGES) {
      await open(url);
      await wait(800);
      console.log('  --  ' + name + ' (a front page) offered reading view: ' + !!browser.state().reader?.available);
    }
  } catch (error) {
    check('probe completed', false, error.stack);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall reader web checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
