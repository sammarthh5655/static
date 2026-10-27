'use strict';

/**
 * What the assistant knows about static itself.
 *
 * Gemini knows nothing about this browser, so "how do I import from Brave?"
 * used to get a guess about some other browser's menus. This is a guide to
 * static, written from the code, that joins the system instruction whenever
 * a question is about the browser (isAboutStatic). Ordinary questions, and
 * questions about the page, do not carry it.
 *
 * Kept accurate in two ways: the parts that change most (keyboard shortcuts,
 * built-in pages, the version) are generated from the live code on every
 * call, and the hand-written steps name only labels that exist - checked by
 * tests/knowledge.test.cjs against the source. When a feature's menu,
 * button or page changes, update its line here.
 */

const { ACCELERATORS, ACCEL } = require('../../main/shortcuts');
const { INTERNAL_PAGES } = require('../../shared/urls');

const mac = process.platform === 'darwin';

/** The key for an action, as this computer's menus show it. */
const key = (id) => ACCEL.get(id)?.display || '';

// Pages that only open themselves (a warning, the reader's own view).
const UNLISTED = new Set(['reader', 'warning', 'edge']);

/** Step-by-step answers, by topic. Every label here is one the app shows. */
const TOPICS = [
  ['Finding things', [
    'The main menu is the button at the far left of the title bar (or press F10). It has New tab, Incognito, History, Downloads, Bookmarks, AI chat, Workspaces, Settings, zoom, Full screen, New window, Split view, Find in page, Print, Screenshot, Organise tabs, Extensions and Sidebar, and at the bottom Help, Guide, Send feedback, About Static and Exit.',
    'Settings: main menu > Settings. Its sections are Get started, Profiles, Appearance, Content, Privacy & Security, AI, Search, Workspaces, Extensions, Passwords, Downloads, Accessibility, System, Reset settings and About Static. The search box at the top of Settings (' + (mac ? 'Cmd+K' : 'Ctrl+K') + ') finds any setting by name.',
    'The icon at the left of the address bar opens the site card: whether the connection is secure, Shields on or off for that site, Clear cookies and site data, and Site settings.',
  ]],
  ['Importing from another browser (Brave, Chrome, Edge, Firefox, Opera, Vivaldi, Safari)', [
    'Open main menu > Settings. The import is on the first page, Get started, under "Import from another browser" (or type "import" in the Settings search box).',
    'Click the browser to import from, for example Brave. If it has several profiles, pick one from the list that appears.',
    'Choose what to bring: Bookmarks (with their folders), History (the last 5,000 pages) and Homepage. Then click "Import from Brave" (the button names the browser picked).',
    'The other browser can stay open; if the import fails, close that browser and try again.',
    'Passwords cannot be read from other browsers directly, because each browser locks them. To bring them: in Brave (or Chrome, Edge), open brave://password-manager/settings (chrome://password-manager/settings, edge://settings/passwords), choose Export passwords and save the CSV file. Then in static open browser://passwords, find "Import and export" and click "Import from a file...". Delete the CSV file afterwards: it is not encrypted.',
    'Safari on a Mac: macOS keeps Safari\'s data private, so first turn on static in System Settings > Privacy & Security > Full Disk Access, then quit and reopen static. The Safari tile has a button that opens that page.',
    'From a file, on any computer: in Safari use File > Export Browsing Data to File and choose that zip under "Or import from a file" (it brings bookmarks, history and passwords). A bookmarks .html file exported from any browser also works there.',
    'First-time setup offers the same import when static is opened for the first time.',
  ]],
  ['Bookmarks, history, downloads', [
    'Bookmark a page with the star in the address bar. All bookmarks: main menu > Bookmarks (browser://bookmarks). Show or hide the bookmarks bar: Settings > Appearance > Show bookmarks bar (or ' + key('open:bookmarks') + ').',
    'History: main menu > History (browser://history), searchable. Downloads: main menu > Downloads (browser://downloads).',
    'Clear browsing data: Settings > Privacy & Security, choose history, cookies and site data, or cached files, then clear.',
  ]],
  ['Tabs and windows', [
    'Drag tabs to reorder them. Right-click a tab for its menu: Pin, Mute, Duplicate, Add tab to new group, Move tab to new window, Close other tabs, Close tabs to the right, Reopen closed tab.',
    'Vertical tabs: main menu > Tabs > Side, or right-click the tab strip and choose "Show tabs vertically". Tabs > Top puts them back.',
    'Split view: right-click a link and choose "Open link in split view", drag a tab onto the left or right edge of the page, right-click a tab and choose "Split view with...", or main menu > Split view. Drag the handle between the pages to resize.',
    'Incognito: main menu > Incognito (' + key('window:incognito') + '). It forgets history, cookies and site data when it is closed.',
    'Tab Organizer: main menu > Organise tabs (browser://organizer) sorts open tabs into groups, with Gemini if you like. Memory, CPU, sleeping tabs and Game Mode: browser://resources, or Settings > System.',
  ]],
  ['Extensions', [
    'Install from the Chrome Web Store: main menu > Extensions > Open Chrome Web Store, open an extension and click the store\'s "Add to Chrome" button: it installs into static.',
    'Manage them at browser://extensions (main menu > Extensions): turn each on or off, open its options, or remove it.',
    'Developers can use "Load unpacked" for a folder or "Install .crx file" for a package file on the same page.',
    'Extension buttons appear at the right of the address bar.',
  ]],
  ['Privacy: Shields', [
    'Shields block ads and trackers and upgrade connections to HTTPS, on every site by default.',
    'If a site breaks, open the site card (the icon at the left of the address bar) and set Shields to Off for that site.',
    'Shields statistics: browser://shields. All Shields options: Settings > Privacy & Security.',
  ]],
  ['Passwords and autofill', [
    'static offers to save a password when you sign in, and fills it in next time. Passwords and passkeys are kept in an encrypted vault: browser://passwords.',
    'Addresses and payment cards: browser://autofill.',
    'Import or export passwords: browser://passwords > "Import and export".',
  ]],
  ['Looks and new tab', [
    'Themes are planets: Settings > Appearance, click a planet to wear it, or forge your own.',
    'On a new tab, Customise changes the wallpaper (This wallpaper, A different one on every new tab, or A new one each time Static starts) and lets you drag widgets anywhere.',
    'Homepage and what a new tab shows: Settings > Get started. Search engine (Google or Brave Search): Settings > Search.',
  ]],
  ['AI assistant', [
    'The sidebar assistant answers questions about the page you are on: press ' + key('sidebar:toggle') + ', or main menu > Sidebar. Full conversations: main menu > AI chat (browser://ai).',
    'On a new tab, press Tab in the search box to ask Gemini instead of searching.',
  ]],
  ['Profiles', [
    'Profiles are separate spaces with their own history, passwords and look. Create or switch one from the profile picker (browser://profiles) or Settings > Profiles.',
  ]],
  ['Reading, screenshots, QR codes, notes', [
    'Reading view: on an article, click the book in the address bar or press ' + key('page:reader') + '. It offers light, sepia or dark and a text size.',
    'Screenshots: right-click a page or main menu > Screenshot, then Visible area, Full page or Select an area. Copy it, or save it to Pictures > Static Screenshots.',
    'QR code for the page: rest the pointer on the address bar and press the QR button.',
    'Notes: save text, links and screenshots to browser://notes.',
  ]],
  ['Focus and Screen Time', [
    'Focus (browser://focus, ' + key('open:focus') + '): Start a session to block distracting sites until it ends. Screen Time (browser://screentime, ' + key('open:screentime') + ') shows time spent per site and sets daily limits and schedules.',
  ]],
  ['Default browser, updates, help', [
    mac
      ? 'Make static the default browser: System Settings > Desktop & Dock > Default web browser > static.'
      : 'Make static the default browser: Windows Settings > Apps > Default apps > static > Set default.',
    'Updates: main menu > About Static shows the version and update status, with Check for updates. Installed copies on Windows update themselves; download new versions from github.com/sammarthh5655/static/releases.',
    'Help and the tour: main menu > Help (browser://help) and Guide (browser://guide). Send feedback from the main menu.',
    mac
      ? 'Uninstall: drag static from Applications to the Trash. Bookmarks and passwords are kept.'
      : 'Uninstall: Windows Settings > Apps > Installed apps > ... next to static > Uninstall. Bookmarks and passwords are kept.',
  ]],
];

/**
 * The shortcuts worth putting in front of the model, as "New tab: Ctrl+T".
 *
 * Not all of them: the system instruction has a hard size limit (gemini.js
 * trims it), and the whole table costs more of that budget than it is worth -
 * a browser question is rarely about Ctrl+6. These are the ones people ask
 * about; anything else is on browser://help.
 */
const KEY_SHORTCUTS = [
  'tab:new', 'tab:close', 'tab:reopen', 'tab:search', 'window:new', 'window:incognito',
  'address:focus', 'page:find', 'page:reload', 'page:reader', 'page:print',
  'open:settings', 'open:history', 'open:downloads', 'open:bookmarks', 'bookmarks:toggle',
  'open:extensions', 'sidebar:toggle', 'data:clear', 'menu:main',
];

function shortcutLines() {
  const lines = [];
  for (const id of KEY_SHORTCUTS) {
    const a = ACCEL.get(id);
    if (a) lines.push(`${a.label}: ${a.display}`);
  }
  return lines;
}

/** This copy's version; blank outside Electron (the unit tests). */
function appVersion() {
  try { return require('electron').app.getVersion(); } catch { return ''; }
}

/** The guide, as text for the system instruction. */
function browserGuide(version = appVersion()) {
  const parts = [
    `You are the assistant built into static, a desktop web browser (${version ? 'version ' + version + ', ' : ''}on ${mac ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'}). static is built on Chromium; it is not Chrome, Brave or Edge, and its menus are its own.`,
    'When the user asks how to do something in this browser, answer from the guide below with exact, numbered steps that name the real buttons and menus. Never describe Chrome\'s or another browser\'s menus as if they were static\'s, except where the steps happen in that other browser (such as exporting passwords from Brave). If the guide does not cover something, say you are not sure rather than inventing a menu.',
    '',
    'STATIC GUIDE',
  ];
  for (const [title, lines] of TOPICS) {
    parts.push('', title + ':', ...lines.map((line) => '- ' + line));
  }
  parts.push('', 'Keyboard shortcuts:', ...shortcutLines().map((line) => '- ' + line));
  parts.push('', 'Built-in pages (type in the address bar): ' + [...INTERNAL_PAGES].filter((p) => !UNLISTED.has(p)).map((p) => 'browser://' + p).join(', ') + '.');
  return parts.join('\n');
}

// Things a browser has. "history" and "notes" alone are too common, so only
// their browser senses count.
const FEATURE = /\b(import(ing)?|export|migrate|switch(ing)? from|brave|chrome|edge|firefox|safari|opera|vivaldi|bookmarks?|(my|browsing|search) history|history page|downloads?|extensions?|add-?ons?|web store|shields?|ad ?block(er|ing)?|trackers?|incognito|private (window|mode|browsing)|profiles?|tabs?|split view|sidebar|settings?|preferences|shortcuts?|hotkeys?|keyboard|themes?|planets?|wallpapers?|widgets?|new tab|home ?page|search engine|default browser|passwords?|passkeys?|autofill|reading view|reader mode|screenshots?|qr code|focus mode|screen time|workspaces?|organi[sz]e|sleeping tabs|game mode|uninstall|install|update|cookies|cache|browsing data|zoom|full ?screen|find in page)\b/i;
// Asking how, where or whether - not "what is", which is how questions about
// the world begin ("what is the history of Rome?").
const HOW = /\b(how|where|can i|can you|could i|is there|do i|does it|why (does|is|can't|cannot|won't)|steps?|set ?up|turn (on|off)|enable|disable|change|find|get|make|use|add|remove|delete|move|bring|transfer|keep|save|stop|block|show|hide)\b/i;

/**
 * Whether a question is about using static. Mentioning static or this
 * browser is enough; otherwise it must name a browser feature AND ask how,
 * where or whether. A wrong yes costs only a longer instruction (the guide
 * tells Gemini to use it for questions about the browser); a wrong no is the
 * guess this module exists to prevent, so it leans towards yes.
 */
function isAboutStatic(question) {
  const q = String(question || '');
  if (/\b(static|this browser|my browser|the browser)\b/i.test(q)) return true;
  return FEATURE.test(q) && HOW.test(q);
}

/**
 * `system` with the guide in front of it when the question - or, for a
 * follow-up such as "and my passwords?", the one before it - is about static.
 */
function withGuide(system, question, history) {
  const previous = Array.isArray(history) ? history.filter((t) => t?.role === 'user').slice(-1)[0]?.text : '';
  if (!isAboutStatic(question) && !isAboutStatic(previous)) return system;
  // The caller's own instruction goes FIRST. A system instruction has a size
  // limit (gemini.js trims the end), and the caller's rules - "answer in
  // plain text", how long to be - must survive that; losing the tail of the
  // guide only costs a detail the model can say it is unsure of.
  return (system ? system + '\n\n' : '')
    + browserGuide()
    + '\n\nQuestions about static itself are answered from the guide, even when a page is provided as context.';
}

module.exports = { browserGuide, isAboutStatic, withGuide, TOPICS };
