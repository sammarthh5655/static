'use strict';
(function () {
/**
 * browser://licences - what Static is built on, and under what terms.
 *
 * This is an obligation rather than a courtesy: the extension bridge is
 * GPL-3.0 and Brave's scriptlets are MPL-2.0, and both require attribution and
 * a pointer to the source. Writing it as data means a dependency cannot be
 * added without appearing here.
 */

const { $, element } = window.page;

/**
 * Everything Static ships that someone else wrote.
 *
 * `obligation` states plainly what the licence requires OF US, because a
 * licence name alone tells a reader nothing about whether we are complying.
 */
const CREDITS = [
  {
    name: 'Electron',
    licence: 'MIT',
    what: 'The application framework: Chromium for rendering pages, Node for everything else.',
    url: 'https://github.com/electron/electron',
    obligation: 'Keep the copyright notice. No restriction on use.',
  },
  {
    name: 'Chromium',
    licence: 'BSD-3-Clause',
    what: 'The browser engine inside Electron. Every page you view is rendered by it.',
    url: 'https://www.chromium.org/',
    obligation: 'Keep the copyright notice and licence text.',
  },
  {
    name: 'electron-chrome-extensions',
    licence: 'GPL-3.0',
    what: 'The bridge that lets Chrome extensions run in Static.',
    url: 'https://github.com/samuelmaddock/electron-chrome-extensions',
    obligation:
      'GPL-3.0 is a copyleft licence. Static is distributed under compatible terms and its ' +
      'source is available. A commercial licence exists for projects that cannot do that.',
  },
  {
    name: 'electron-chrome-web-store',
    licence: 'MIT',
    what: 'Installing extensions from the Chrome Web Store.',
    url: 'https://github.com/samuelmaddock/electron-browser-shell',
    obligation: 'Keep the copyright notice.',
  },
  {
    name: 'Brave adblock resources',
    licence: 'MPL-2.0',
    what:
      'The scriptlet library Static injects to neutralise ads in the page, and the ' +
      'YouTube rules that go with it. Taken from brave/adblock-rust.',
    url: 'https://github.com/brave/adblock-rust',
    obligation:
      'MPL-2.0 is file-level copyleft. The files are used unmodified and are named here; ' +
      'changes to them would have to be published under the same licence.',
  },
  {
    name: 'uBlock Origin filter lists',
    licence: 'GPL-3.0',
    what:
      'The filter rules themselves — filters.txt, the per-year files, badware, ' +
      'unbreak and quick-fixes. These are what actually block ads.',
    url: 'https://github.com/uBlockOrigin/uAssets',
    obligation: 'Used as data, unmodified, and downloaded from the original source.',
  },
  {
    name: 'EasyList and EasyPrivacy',
    licence: 'GPL-3.0 / CC BY-SA 3.0',
    what: 'Long-standing ad and tracker lists, maintained independently.',
    url: 'https://easylist.to/',
    obligation: 'Used as data, unmodified, and downloaded from the original source.',
  },
  {
    name: 'Google Gemini',
    licence: 'Commercial API',
    what: 'The assistant. Used only when you ask it something.',
    url: 'https://ai.google.dev/',
    obligation:
      'A service rather than bundled code. Nothing is sent to it unless you ask, and ' +
      'page content is only read for a request you made.',
  },
];

/** What leaves this machine, and what does not. */
const PRIVACY = [
  ['Stays on this device',
    'History, bookmarks, notes, saved passwords, open tabs, settings and every counter ' +
    'on the privacy card. None of it is uploaded anywhere.'],
  ['Leaves only when you ask',
    'A question to the assistant, and the page text it needs to answer it. Nothing is ' +
    'sent in the background, and a sensitive page asks first every time.'],
  ['Downloaded regularly',
    'Filter lists, from EasyList and the uBlock and Brave repositories. These are ' +
    'downloads, not uploads: nothing about you goes with the request.'],
  ['Never collected',
    'There is no telemetry, no analytics, no crash reporting and no account.'],
];

function card(credit) {
  return element('div', { class: 'credit' }, [
    element('div', { class: 'credit-head' }, [
      element('strong', { text: credit.name }),
      element('span', { class: 'credit-licence', text: credit.licence }),
    ]),
    element('p', { class: 'credit-what', text: credit.what }),
    element('p', { class: 'credit-obligation', text: credit.obligation }),
    element('button', {
      class: 'credit-link',
      text: credit.url,
      onclick: () => window.page.openUrl(credit.url),
    }),
  ]);
}

$('#list').replaceChildren(
  element('h2', { text: 'Built on' }),
  element('div', { class: 'credits' }, CREDITS.map(card)),
);

$('#privacy').replaceChildren(...PRIVACY.map(([title, body]) =>
  element('div', { class: 'field' }, [
    element('div', {}, [
      element('label', { text: title }),
      element('div', { class: 'hint', text: body }),
    ]),
  ])));

})();
