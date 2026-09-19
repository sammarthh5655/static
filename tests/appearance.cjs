const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Appearance and window-chrome checks. Run with `npm run test:appearance`.
 *
 * These assert that a setting actually REPAINTS the UI, not merely that it was
 * stored - the failure mode worth catching is a theme value that persists but
 * never reaches the CSS variables the chrome renders from.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + detail : ''));
    if (!ok) fails++;
  };
  browser.window.show();
  await wait(1500);

  const read = (v) => browser.chrome.webContents.executeJavaScript(
    `getComputedStyle(document.documentElement).getPropertyValue('${v}').trim()`);

  // Theme switching must repaint the chrome, not just store a value.
  const darkBg = await read('--bg');
  browser.settings.update({ theme: 'light' }); browser.push();
  await wait(400);
  const lightBg = await read('--bg');
  check('theme switch repaints chrome', darkBg !== lightBg, darkBg + ' -> ' + lightBg);

  browser.settings.update({ theme: 'midnight' }); browser.push();
  await wait(400);
  check('third theme applies', (await read('--bg')) === '#0f1117', await read('--bg'));

  // Radius is one variable driving everything.
  browser.settings.update({ radius: 'sharp' }); browser.push();
  await wait(400);
  check('radius setting applies', (await read('--radius')) === '2px', await read('--radius'));

  // Animations off must collapse durations to zero.
  browser.settings.update({ animations: false }); browser.push();
  await wait(400);
  check('animations off zeroes motion', (await read('--motion-base')) === '0ms', await read('--motion-base'));

  // Surface style changes the menu treatment.
  browser.settings.update({ animations: true, surfaceStyle: 'solid' }); browser.push();
  await wait(400);
  check('solid surface removes blur', (await read('--menu-blur')) === 'none', await read('--menu-blur'));
  browser.settings.update({ surfaceStyle: 'frosted' }); browser.push();
  await wait(300);
  check('frosted surface restores blur', (await read('--menu-blur')).includes('blur'), await read('--menu-blur'));

  // Window controls must actually drive the window.
  browser.windowControl('maximize');
  await wait(600);
  check('maximize works', browser.window.isMaximized());
  browser.windowControl('maximize');
  await wait(600);
  check('restore works', !browser.window.isMaximized());

  // The shortcut table the menus render from must be populated.
  const { ACCELERATORS } = require('../src/main/shortcuts');
  check('shortcut table populated', ACCELERATORS.length > 10, ACCELERATORS.length + ' bindings');
  check('shortcuts have display strings', ACCELERATORS.every(a => a.display), '');

  // No native menu anywhere.
  const { Menu } = require('electron');
  check('no native application menu', Menu.getApplicationMenu() === null);

  // Shortcuts must work while a WEB PAGE has focus, which is the whole reason
  // they are intercepted in main rather than bound in the chrome renderer.
  const page = browser.tabs.create({ url: 'https://example.com' });
  for (let i = 0; i < 40 && browser.tabs.tabs.get(page).view.webContents.isLoading(); i++) {
    await wait(200);
  }
  browser.tabs.select(page);
  const before = browser.tabs.order.length;
  const key = (input) => browser.tabs.tabs.get(page).view.webContents
    .sendInputEvent({ type: 'keyDown', keyCode: input.key, modifiers: input.modifiers });

  key({ key: 't', modifiers: ['control'] });
  await wait(500);
  check('Ctrl+T works with a web page focused', browser.tabs.order.length === before + 1,
    before + ' -> ' + browser.tabs.order.length);

  const afterNew = browser.tabs.order.length;
  key({ key: 'w', modifiers: ['control'] });
  await wait(500);
  check('Ctrl+W works with a web page focused', browser.tabs.order.length === afterNew - 1,
    afterNew + ' -> ' + browser.tabs.order.length);

  browser.settings.update({ theme: 'dark', radius: 'rounded' });
  await require('./settings-design.cjs').run(browser);
  console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll appearance checks passed.\n');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
