'use strict';
(function () {
/**
 * browser://help - help, feedback, legal and about, in one place.
 *
 * Sections are addressed by hash (#feedback, #about, #legal/privacy) so every
 * menu item and link can land exactly where it means to.
 */
const { $, element, invoke, onState, icon } = window.page;
const legal = window.legal;

const SECTIONS = [
  ['start', 'Getting started', 'home'],
  ['new', "What's new", 'sparkle'],
  ['shortcuts', 'Keyboard shortcuts', 'key'],
  ['feedback', 'Send feedback', 'chat'],
  ['legal', 'Privacy & legal', 'doc'],
  ['diagnostics', 'Diagnostics', 'code'],
  ['about', 'About Static', 'info'],
];

const GUIDE = [
  ['Search or go anywhere', 'Type in the address bar and press Enter to search, or type an address to go there. Ctrl+L, Ctrl+K or Alt+D puts the cursor there.'],
  ['Right-click everything', 'Pages, links, images, text and tabs all have their own menu: open links beside the page in split view, copy, save, translate, inspect.'],
  ['Split view', 'Right-click a link and choose "Open link in split view", or drag a tab onto the left or right edge of the page. Drag the handle between them to resize.'],
  ['Vertical tabs', 'Right-click the tab strip and choose "Show tabs vertically" to see whole titles down the side.'],
  ['Incognito', 'Ctrl+Shift+N opens a window that forgets everything - history, cookies, site data - when you close it.'],
  ['Make it yours', 'Pick a planet in Settings → Appearance, or forge your own. On a new tab, Customise changes the wallpaper and lets you drag widgets anywhere.'],
  ['Shields', 'Ads and trackers are blocked before they load. If a site breaks, turn Shields off for that site from the shield icon.'],
  ['Profiles', 'Separate spaces with their own history, logins and look. Make one from the profile picker or Settings → Profiles.'],
];

const NEW = [
  ['Split view', 'Two pages side by side in one tab, with a handle to resize.'],
  ['Vertical tabs', 'Tabs down the side, from the tab strip\'s right-click menu.'],
  ['Right-click menus', 'For pages, links, images, video, text fields and selections.'],
  ['Incognito windows', 'A separate, forgetful window with its own process.'],
  ['Find, zoom and full screen', 'Ctrl+F, Ctrl +/-/0 and F11, and videos that really fill the screen.'],
  ['48 built-in wallpapers', 'One, a new one every tab, or every launch. With favourites.'],
  ['Widgets anywhere', 'Drag any widget to any spot on the new tab page.'],
  ['Forge a planet', 'Your own theme, named by you, orbiting with the others. The Sun is at the centre now.'],
  ['Profiles', 'Create one in four steps from the picker; manage them in Settings.'],
  ['Help and feedback', 'This page, and a feedback form that shows exactly what it would send.'],
];

let system = null;
let current = 'start';

function fill(text) {
  const values = legal.ENTITY;
  return String(text)
    .replace(/\{(\w+)\}/g, (_, key) => values[key] || '[' + ({
      company: 'company name', address: 'postal address', jurisdiction: 'governing law', privacyEmail: 'privacy email',
      securityEmail: 'security email', supportEmail: 'support email', liabilityCap: 'liability amount', minimumAge: 'minimum age',
    }[key] || key) + ' - to be added]');
}

function nav() {
  $('#help-nav').replaceChildren(...SECTIONS.map(([id, name, glyph]) => element('a', {
    href: '#' + id, class: 'help-link' + (current === id ? ' active' : ''),
  }, [icon(glyph, { size: 17 }), element('span', { text: name })])));
}

function header(title, lede) {
  return [element('h1', { text: title }), lede ? element('p', { class: 'lede', text: lede }) : null].filter(Boolean);
}

function cards(list) {
  return element('div', { class: 'help-cards' }, list.map(([title, body]) =>
    element('div', { class: 'help-card' }, [element('strong', { text: title }), element('p', { text: body })])));
}

/* ---- sections ------------------------------------------------------------ */

function start() {
  return [...header('Getting started', 'A few things worth knowing on your first day.'), cards(GUIDE)];
}

function whatsNew() {
  return [...header("What's new", 'In this version of Static.'), cards(NEW)];
}

async function shortcuts() {
  const list = await invoke('ui:shortcuts').catch(() => []);
  const byId = new Map();
  for (const item of list) {
    const row = byId.get(item.id) || { label: item.label, keys: [] };
    if (!row.keys.includes(item.display)) row.keys.push(item.display);
    byId.set(item.id, row);
  }
  return [...header('Keyboard shortcuts', 'Every shortcut Static understands. They work even when the page has focus.'),
    element('div', { class: 'help-shortcuts' }, [...byId.values()].map((row) => element('div', { class: 'help-shortcut' }, [
      element('span', { text: row.label }),
      element('span', { class: 'keys' }, row.keys.map((k) => element('kbd', { text: k }))),
    ])))];
}

async function feedbackSection(preset) {
  const categories = await invoke('feedback:categories');
  const available = await invoke('feedback:available');
  const LABELS = {
    version: 'Browser version', os: 'Operating system', hardware: 'CPU, GPU and memory', screen: 'Screen resolution',
    extensions: 'Installed extensions', settings: 'Browser settings', profile: 'Profile name', openTabs: 'Addresses of open tabs',
    console: 'Recent page errors (console)', diagnostics: 'Browser diagnostics',
  };
  // Harmless technical details start ticked; anything that could identify you starts unticked.
  const DEFAULT_ON = new Set(['version', 'os', 'hardware', 'screen', 'diagnostics']);
  const include = {};
  for (const key of Object.keys(available)) include[key] = DEFAULT_ON.has(key);

  const category = element('select', { id: 'fb-category' }, categories.map((c) =>
    element('option', { value: c.id, text: c.name })));
  if (preset && categories.some((c) => c.id === preset)) category.value = preset;
  const description = element('textarea', { id: 'fb-text', rows: '6', placeholder: 'What happened, or what would you like? Steps to reproduce help a lot.' });
  const contact = element('input', { id: 'fb-contact', placeholder: 'Email, if you would like a reply (optional)' });
  const media = element('div', { class: 'fb-media' });
  const status = element('p', { class: 'fb-status', role: 'status' });
  const preview = element('pre', { class: 'fb-preview', hidden: '' });

  const paintMedia = ({ shots, files }) => {
    media.replaceChildren(
      ...shots.map((src, index) => element('figure', { class: 'fb-shot' }, [
        element('img', { src, alt: 'Screenshot ' + (index + 1) }),
        element('button', { type: 'button', text: 'Remove', onclick: async () => paintMedia(await invoke('feedback:remove', { kind: 'shot', index })) }),
      ])),
      ...files.map((file, index) => element('div', { class: 'fb-file' }, [
        icon('doc', { size: 15 }), element('span', { text: file.name + ' · ' + Math.max(1, Math.round(file.size / 1024)) + ' KB' }),
        element('button', { type: 'button', text: 'Remove', onclick: async () => paintMedia(await invoke('feedback:remove', { kind: 'file', index })) }),
      ])));
  };
  invoke('feedback:shots').then(paintMedia);

  const toggles = element('div', { class: 'fb-toggles' }, Object.keys(available).map((key) => {
    const box = element('button', { type: 'button', role: 'switch', class: 'fb-toggle', 'aria-checked': String(include[key]) }, [
      element('span', { class: 'fb-switch' }), element('span', { text: LABELS[key] || key }),
    ]);
    box.addEventListener('click', () => {
      include[key] = !include[key];
      box.setAttribute('aria-checked', String(include[key]));
      if (!preview.hidden) showPreview();
    });
    return box;
  }));

  const input = () => ({ category: category.value, description: description.value, contact: contact.value, include });
  async function showPreview() {
    try {
      const report = await invoke('feedback:preview', input());
      preview.textContent = JSON.stringify(report, null, 2);
      preview.hidden = false;
      status.textContent = 'This is everything the report contains. Nothing has been saved or sent.';
    } catch (error) { status.textContent = error.message; }
  }

  const send = element('button', { type: 'button', class: 'primary', text: 'Save report' });
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      const result = await invoke('feedback:submit', input());
      status.replaceChildren(
        element('span', { text: 'Saved. Static has no feedback server yet, so your report is a folder on this device - attach it to an email to ' +
          (legal.ENTITY.supportEmail || 'the developer') + ', or delete it. ' }),
        element('button', { type: 'button', class: 'link', text: 'Open the folder', onclick: () => invoke('feedback:reveal') }));
      description.value = '';
      preview.hidden = true;
      paintMedia({ shots: [], files: [] });
    } catch (error) {
      status.textContent = error.message;
    }
    send.disabled = false;
  });

  return [
    ...header('Send feedback', 'Bugs, ideas, crashes, broken sites, anything. Only the description is required; everything else is your choice, and you see it all before it goes anywhere.'),
    element('div', { class: 'card fb-form' }, [
      element('label', { class: 'fb-field' }, [element('span', { text: 'What is it about?' }), category]),
      element('label', { class: 'fb-field' }, [element('span', { text: 'Description' }), description]),
      element('div', { class: 'fb-field' }, [
        element('span', { text: 'Screenshots and files' }),
        element('div', { class: 'fb-actions' }, [
          element('button', { type: 'button', text: 'Capture the page I was on', onclick: async () => {
            try { paintMedia({ shots: await invoke('feedback:screenshot'), files: (await invoke('feedback:shots')).files }); } catch (error) { status.textContent = error.message; }
          } }),
          element('button', { type: 'button', text: 'Attach files…', onclick: async () => {
            const files = await invoke('feedback:attach');
            paintMedia({ shots: (await invoke('feedback:shots')).shots, files });
          } }),
        ]),
        media,
      ]),
      element('div', { class: 'fb-field' }, [element('span', { text: 'Include, if you want to' }), toggles]),
      element('label', { class: 'fb-field' }, [element('span', { text: 'Reply to' }), contact]),
      element('div', { class: 'fb-actions end' }, [
        element('button', { type: 'button', text: 'Preview exactly what is included', onclick: showPreview }),
        send,
      ]),
      status,
      preview,
    ]),
    element('p', { class: 'settings-note', text: 'Found a security problem? Choose "Security issue", or see the Security Policy under Privacy & legal.' }),
  ];
}

function legalSection(docId) {
  const blanks = legal.missing().filter((key) => key !== 'minimumAge');
  const doc = legal.DOCS.find((d) => d.id === docId);
  const notice = blanks.length ? element('div', { class: 'help-notice' }, [
    element('strong', { text: 'These documents are not finished.' }),
    element('span', { text: ' The publisher\'s details (' + blanks.length + ' items, shown as "to be added") must be filled in, and the documents reviewed by a lawyer, before Static is distributed commercially.' }),
  ]) : null;
  if (doc) {
    return [
      element('a', { href: '#legal', class: 'help-back', text: '← All policies' }),
      ...header(doc.title, 'Last updated ' + doc.updated + '. ' + doc.summary),
      notice,
      ...doc.sections.flatMap(([title, paragraphs]) => [
        element('h2', { text: title }),
        ...paragraphs.flatMap((p) => p === '{flows}'
          ? [element('div', { class: 'help-flows' }, legal.DATA_FLOWS.map(([who, what]) =>
            element('div', {}, [element('strong', { text: who }), element('p', { text: what })])))]
          : [element('p', { class: p.startsWith('•') ? 'bullet' : '', text: fill(p) })]),
      ]),
    ].filter(Boolean);
  }
  const groups = [...new Set(legal.DOCS.map((d) => d.group))];
  return [
    ...header('Privacy & legal', 'Static keeps your data on your device. These documents say exactly what that means.'),
    notice,
    ...groups.flatMap((group) => [
      element('h2', { text: group }),
      element('div', { class: 'help-docs' }, legal.DOCS.filter((d) => d.group === group).map((d) =>
        element('a', { href: '#legal/' + d.id, class: 'help-doc' }, [element('strong', { text: d.title }), element('span', { text: d.summary })]))),
    ]),
    element('h2', { text: 'Open source' }),
    element('div', { class: 'help-docs' }, [element('a', { href: '#', class: 'help-doc', onclick: (e) => { e.preventDefault(); invoke('tabs:navigate', { input: 'browser://licences' }); } }, [
      element('strong', { text: 'Open-source licences and credits' }),
      element('span', { text: 'Every project, list and photograph Static is built on, and the terms each comes under.' }),
    ])]),
  ].filter(Boolean);
}

function table(rows) {
  return element('dl', { class: 'help-table' }, rows.flatMap(([k, v]) => [element('dt', { text: k }), element('dd', { text: String(v ?? '-') })]));
}

async function diagnostics() {
  system = await invoke('help:system');
  const text = JSON.stringify(system, null, 2);
  return [
    ...header('Diagnostics', 'What Static knows about this device and this build. Nothing here is sent anywhere.'),
    table([
      ['Version', system.version], ['Build', system.build], ['Channel', system.channel], ['Rendering engine', system.engine],
      ['Chromium', system.chromium], ['Electron', system.electron], ['Node.js', system.node], ['V8', system.v8],
      ['Operating system', system.os], ['Architecture', system.arch], ['CPU', system.cpu], ['GPU', system.gpu],
      ['Memory', system.memory], ['Screen', system.screen], ['Locale', system.locale],
      ['Network', system.online ? 'Online' : 'Offline'], ['Pages sandboxed', system.sandboxed ? 'Yes' : 'No'],
      ['Profile', system.profile + (system.incognito ? ' (incognito)' : '')],
      ['Shields', system.features.shields ? 'On' : 'Off'], ['Tab layout', system.features.tabLayout],
      ['Theme', system.features.theme], ['Assistant', system.features.assistant ? 'Available' : 'No key in this build'],
      ['Extensions', system.extensions.length ? system.extensions.join(', ') : 'None'],
      ['Experiments', 'None enabled'], ['Updates', system.updates],
    ]),
    element('div', { class: 'fb-actions' }, [element('button', { type: 'button', text: 'Copy as text', onclick: async (e) => {
      await navigator.clipboard.writeText(text).catch(() => {});
      e.currentTarget.textContent = 'Copied';
    } })]),
  ];
}

async function about() {
  system = await invoke('help:system');
  return [
    element('div', { class: 'help-about' }, [
      element('img', { src: '../assets/static-logo.png', alt: '' }),
      element('h1', { text: 'Static' }),
      element('p', { class: 'lede', text: 'Version ' + system.version + ' · ' + system.channel + ' · build ' + system.build }),
      element('p', { class: 'help-update', text: system.updates }),
    ]),
    table([
      ['Chromium', system.chromium], ['Electron', system.electron], ['Operating system', system.os + ' (' + system.arch + ')'],
      ['Installed in', system.installPath], ['Your data', system.dataPath],
    ]),
    element('div', { class: 'fb-actions' }, [
      element('button', { type: 'button', text: 'Show install folder', onclick: () => invoke('help:reveal', { which: 'install' }) }),
      element('button', { type: 'button', text: 'Show data folder', onclick: () => invoke('help:reveal', { which: 'data' }) }),
      element('a', { href: '#new', class: 'button-link', text: 'Release notes' }),
      element('a', { href: '#legal', class: 'button-link', text: 'Privacy & legal' }),
      element('button', { type: 'button', text: 'Open-source licences', onclick: () => invoke('tabs:navigate', { input: 'browser://licences' }) }),
    ]),
    element('p', { class: 'settings-note', text: fill('Copyright © 2026 {company}. Static is built on Chromium and other open-source software.') }),
  ];
}

/* ---- routing and search ---------------------------------------------------- */

async function render() {
  const [id, sub] = (location.hash.slice(1) || 'start').split('/');
  current = SECTIONS.some(([s]) => s === id) ? id : 'start';
  nav();
  const main = $('#help-main');
  let nodes;
  try {
    if (current === 'new') nodes = whatsNew();
    else if (current === 'shortcuts') nodes = await shortcuts();
    else if (current === 'feedback') nodes = await feedbackSection(sub);
    else if (current === 'legal') nodes = legalSection(sub);
    else if (current === 'diagnostics') nodes = await diagnostics();
    else if (current === 'about') nodes = await about();
    else nodes = start();
  } catch (error) {
    nodes = [element('p', { class: 'fb-status', text: 'This section could not load: ' + error.message })];
  }
  main.replaceChildren(...nodes);
  main.scrollTop = 0;
}

$('#help-search').addEventListener('input', (event) => {
  const q = event.target.value.trim().toLowerCase();
  if (!q) { render(); return; }
  const hits = [];
  for (const [title, body] of [...GUIDE, ...NEW]) {
    if ((title + ' ' + body).toLowerCase().includes(q)) hits.push({ title, body, href: '#start' });
  }
  for (const doc of legal.DOCS) {
    const text = doc.sections.map(([t, ps]) => t + ' ' + ps.join(' ')).join(' ');
    if ((doc.title + ' ' + doc.summary + ' ' + text).toLowerCase().includes(q)) hits.push({ title: doc.title, body: doc.summary, href: '#legal/' + doc.id });
  }
  for (const [id, name] of SECTIONS) if (name.toLowerCase().includes(q)) hits.push({ title: name, body: 'Section', href: '#' + id });
  $('#help-main').replaceChildren(...header('Results for “' + event.target.value.trim() + '”'),
    hits.length
      ? element('div', { class: 'help-docs' }, hits.map((h) => element('a', { href: h.href, class: 'help-doc' }, [element('strong', { text: h.title }), element('span', { text: h.body })])))
      : element('p', { class: 'lede', text: 'Nothing found. Try "privacy", "split" or "shortcut".' }));
});

addEventListener('hashchange', () => { $('#help-search').value = ''; render(); });
onState(() => {});
render();
})();
