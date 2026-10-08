'use strict';
(function () {
/**
 * browser://guide - a short tour of what Static can do.
 *
 * It opens once setup is finished, because setup no longer asks about most of
 * this: rather than eight screens of questions, a person gets a few cards
 * that show each thing and take them straight to it. It is also reachable at
 * any time from Help and from the main menu.
 *
 * THE VISUALS ARE THE REAL UI, IN MINIATURE
 * Each card's picture is drawn from the same pieces the browser is: the real
 * icon set, the real planets' palettes, the built-in wallpapers, the mode
 * registry's names and taglines, all coloured by the theme variables. So the
 * guide wears whatever planet was just chosen, and a planet tapped here
 * recolours the guide as it recolours everything else.
 *
 * WHAT IT MUST NOT DO
 *  - Trap anyone. Skip is always in the same corner, and every card can be
 *    passed by swipe, scroll, arrow keys or the dots.
 *  - Move for anyone who has asked it not to: reduced motion and the app's
 *    own animations switch both stop every loop and show the finished frame.
 *  - Lose its place. A button opens its destination in a new tab, so the
 *    tour is still where it was when they come back.
 */

const { invoke, element, icon, $ } = window.page;

const fromSetup = new URLSearchParams(location.search).get('from') === 'setup';
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Motion is off when the system asks for less, or Static's own switch is off. */
let animationsOff = false;
const still = () => prefersReduced.matches || animationsOff;

/** What the app state last said, for the parts of a card drawn from it. */
let app = null;

/** Open a place in a new tab, so the tour stays where it was. */
const openPage = (url) => invoke('tabs:new', { url });

/* ---- small builders ------------------------------------------------------ */

/** A div with classes, the commonest node in the miniatures. */
const div = (cls, children = []) => element('div', { class: cls }, children);

/** Skeleton text: a bar of a given width, standing in for words. */
const bar = (width, cls = '') => {
  const node = div('mini-bar ' + cls);
  node.style.setProperty('--w', width + '%');
  return node;
};

/** A planet drawn the way the planetarium lights it: lit from the top left. */
function planetBall(planet, size) {
  const ball = element('span', { class: 'planet-ball' + (planet.luminous ? ' is-luminous' : '') });
  const { primary, secondary, deep } = planet.palette || {};
  ball.style.setProperty('--p1', primary || '#5aa7f0');
  ball.style.setProperty('--p2', secondary || '#7d8ef2');
  ball.style.setProperty('--p3', deep || '#12224a');
  ball.style.setProperty('--size', size + 'px');
  return ball;
}

/** Built-in planets, from the same table the theme engine uses. */
function planets() {
  const fromApp = app?.catalog?.planets;
  if (Array.isArray(fromApp) && fromApp.length) return fromApp;
  return Object.values(window.theme?.THEMES || {})
    .map(({ id, name, order, palette, luminous }) => ({ id, name, order, palette, luminous }))
    .sort((a, b) => a.order - b.order);
}

/* ---- the stages ---------------------------------------------------------- */

/** The opening picture: Static's mark with each card's icon in orbit. */
function stageIntro() {
  const orbit = div('intro-orbit');
  CARDS.filter((card) => card.icon).forEach((card, index, all) => {
    const arm = div('intro-arm');
    arm.style.setProperty('--start', (index / all.length) * 360 + 'deg');
    const bead = element('button', {
      type: 'button', class: 'intro-bead', title: card.eyebrow, 'aria-label': card.eyebrow,
      onclick: () => goTo(CARDS.indexOf(card)),
    }, [icon(card.icon, { size: 18 })]);
    arm.append(bead);
    orbit.append(arm);
  });
  return div('stage stage-intro', [
    div('intro-ring one'), div('intro-ring two'),
    orbit,
    div('intro-core', [element('img', { src: '../assets/static-mark.svg', alt: '' })]),
  ]);
}

/**
 * Make it yours: a working orrery of the real planets, a wallpaper and the
 * forge. Tapping a planet wears it, through the same validated settings path
 * the Appearance page uses.
 */
function stageYours() {
  const all = planets();
  const sun = all.find((planet) => planet.id === 'sun');
  const rest = all.filter((planet) => planet !== sun);
  const orrery = div('orrery');
  // Radii in the stage's own units, so the system fits whatever room it has.
  const rings = [21, 30, 39].map((size) => size + 'cqmin');
  rings.forEach((radius, index) => {
    const ring = div('orrery-ring');
    ring.style.setProperty('--r', radius);
    ring.style.setProperty('--i', index);
    orrery.append(ring);
  });

  rest.forEach((planet, index) => {
    const ringIndex = index < 4 ? 0 : index < 7 ? 1 : 2;
    const onRing = rest.filter((_, i) => (i < 4 ? 0 : i < 7 ? 1 : 2) === ringIndex);
    const slot = onRing.indexOf(planet);
    const arm = div('orrery-arm');
    arm.style.setProperty('--r', rings[ringIndex]);
    arm.style.setProperty('--start', (slot / onRing.length) * 360 + ringIndex * 40 + 'deg');
    arm.style.setProperty('--dur', 46 + ringIndex * 22 + 's');
    const button = element('button', {
      type: 'button', class: 'orrery-planet', 'data-planet': planet.id,
      title: 'Wear ' + planet.name, 'aria-label': 'Wear ' + planet.name,
      onclick: () => wear(planet.id),
    }, [planetBall(planet, ringIndex === 1 ? 26 : 20)]);
    arm.append(button);
    orrery.append(arm);
  });

  if (sun) {
    orrery.append(element('button', {
      type: 'button', class: 'orrery-sun', 'data-planet': sun.id,
      title: 'Wear the Sun', 'aria-label': 'Wear the Sun', onclick: () => wear(sun.id),
    }, [planetBall(sun, 54)]));
  }

  // A new tab, in miniature: a real built-in wallpaper behind the clock.
  const wall = div('yours-newtab', [
    div('yours-wall'),
    div('yours-clock', [element('span', { text: '09:41' }), element('small', { text: 'Thursday' })]),
    div('yours-search', [icon('search', { size: 11 }), bar(60)]),
  ]);
  invoke('wallpapers:catalog').then((data) => {
    // Only pictures that ship with Static: this page's policy allows no
    // other images, and a broken frame is worse than the gradient behind it.
    const local = (data?.wallpapers || []).filter((item) => item.thumb && !/^https?:/i.test(item.thumb));
    const pick = local.find((item) => item.category === 'space') || local[0];
    if (pick) {
      wall.querySelector('.yours-wall').style.setProperty('background-image',
        'url("../assets/' + String(pick.thumb).replace(/["'()\\]/g, '') + '")');
    }
  }).catch(() => {});

  // The forge: three swatches becoming a planet of your own.
  const forge = div('yours-forge', [
    div('forge-swatches', ['#ff8a5c', '#c86bff', '#2b1d4a'].map((colour) => {
      const swatch = element('span', { class: 'forge-swatch' });
      swatch.style.setProperty('--c', colour);
      return swatch;
    })),
    icon('chevron_right', { size: 12 }),
    planetBall({ palette: { primary: '#ff8a5c', secondary: '#c86bff', deep: '#2b1d4a' } }, 22),
    element('span', { text: 'Forge your own' }),
  ]);

  return div('stage stage-yours', [
    orrery,
    wall,
    forge,
    element('p', { class: 'stage-caption', text: 'Tap a planet to try it on' }),
  ]);
}

/** Shields: a page whose ad slots fold away while the count climbs. */
function stageShields() {
  const page = div('mini-page', [
    bar(46, 'is-title'), bar(92), bar(84), bar(88),
    div('mini-ad one', [element('span', { text: 'Ad' }), element('em', { text: 'Blocked' })]),
    bar(90), bar(72),
    div('mini-ad two', [element('span', { text: 'Ad' }), element('em', { text: 'Blocked' })]),
    bar(80),
  ]);

  const counter = (label, target, cls) => div('shield-stat ' + cls, [
    element('strong', { class: 'count', 'data-target': String(target), text: String(target) }),
    element('span', { text: label }),
  ]);

  const blocked = ['ads.doubleclick.net', 'pagead2.googlesyndication.com', 'tracker.adnxs.com', 'connect.facebook.net']
    .map((host, index) => {
      const row = div('shield-host', [icon('shield', { size: 11 }), element('span', { text: host })]);
      row.style.setProperty('--i', index);
      return row;
    });

  const popover = div('shield-pop', [
    div('shield-pop-head', [
      div('shield-badge', [icon('shield', { filled: true, size: 16 })]),
      element('div', {}, [element('strong', { text: 'Shields are up' }), element('small', { text: 'news.example' })]),
      element('span', { class: 'mini-switch is-on' }),
    ]),
    div('shield-stats', [counter('Ads', 24, 'ads'), counter('Trackers', 11, 'trackers')]),
    div('shield-hosts', blocked),
  ]);

  return div('stage stage-shields', [
    miniWindow('news.example', page, { shield: true }),
    popover,
  ]);
}

/** Passwords and passkeys: a sign-in filled from the vault, and a passkey. */
function stagePasswords() {
  const form = div('pw-form', [
    div('pw-site', [element('span', { class: 'mini-favicon', text: 'S' }), element('strong', { text: 'Sign in to studio.example' })]),
    div('pw-field', [element('small', { text: 'Email' }), element('span', { class: 'pw-typed email', text: 'alex@example.com' })]),
    div('pw-field', [element('small', { text: 'Password' }), element('span', { class: 'pw-typed dots', text: '••••••••••••' })]),
    div('pw-submit', [element('span', { text: 'Sign in' })]),
  ]);

  const suggest = div('pw-suggest', [
    div('pw-suggest-row is-picked', [
      div('pw-key', [icon('key', { size: 13 })]),
      element('div', {}, [element('strong', { text: 'alex@example.com' }), element('small', { text: 'Saved on this device' })]),
    ]),
    div('pw-suggest-row passkey', [
      div('pw-key', [icon('lock', { size: 13 })]),
      element('div', {}, [element('strong', { text: 'Use a passkey' }), element('small', { text: 'No password to type or leak' })]),
    ]),
  ]);

  const vault = div('pw-vault', [
    ['G', 'mail.example', 'Strong'], ['B', 'bank.example', 'Strong'], ['N', 'news.example', 'Reused'],
  ].map(([letter, site, health], index) => {
    const row = div('pw-vault-row', [
      element('span', { class: 'mini-favicon', text: letter }),
      element('span', { class: 'pw-site-name', text: site }),
      element('span', { class: 'pw-health ' + (health === 'Strong' ? 'is-good' : 'is-warn'), text: health }),
    ]);
    row.style.setProperty('--i', index);
    return row;
  }));

  return div('stage stage-passwords', [form, suggest, vault]);
}

/** The assistant: a page, the sidebar sliding in, and an answer arriving. */
function stageAssistant() {
  const page = div('mini-page', [
    bar(58, 'is-title'), bar(94), bar(88), bar(91), bar(70), div('mini-figure'), bar(86), bar(78),
  ]);
  const side = div('ai-side', [
    div('ai-head', [icon('sparkle', { size: 13 }), element('strong', { text: 'Assistant' })]),
    div('ai-bubble is-you', [element('span', { text: 'Summarise this page' })]),
    div('ai-bubble is-ai', [
      div('ai-typing', [element('i'), element('i'), element('i')]),
      div('ai-answer', [bar(92), bar(80), bar(86), bar(54)]),
    ]),
    div('ai-input', [element('span', { text: 'Ask about this page…' }), icon('chevron_right', { size: 12 })]),
  ]);
  return div('stage stage-assistant', [miniWindow('article.example', div('ai-split', [page, side]))]);
}

/** Tabs: pinned, grouped, split, down the side, and in workspaces. */
function stageTabs() {
  const tab = (label, cls = '') => div('mini-tab ' + cls, [element('span', { class: 'mini-favicon' }), element('span', { text: label })]);
  const strip = div('tabs-strip', [
    div('mini-tab is-pinned', [icon('pin', { size: 11 })]),
    div('mini-tab is-pinned', [icon('star', { size: 11 })]),
    div('tabs-group', [element('span', { class: 'tabs-group-chip', text: 'Research' }), tab('Sources', 'is-active'), tab('Notes')]),
    tab('Inbox'),
  ]);
  const split = div('tabs-split', [
    div('tabs-pane one', [bar(60, 'is-title'), bar(90), bar(80), bar(86)]),
    div('tabs-handle'),
    div('tabs-pane two', [bar(50, 'is-title'), bar(84), bar(92), bar(70)]),
  ]);
  const vertical = div('tabs-vertical', ['Sources', 'Notes', 'Inbox', 'Calendar'].map((name, index) => {
    const row = div('tabs-vrow' + (index === 0 ? ' is-active' : ''), [element('span', { class: 'mini-favicon' }), element('span', { text: name })]);
    row.style.setProperty('--i', index);
    return row;
  }));
  const spaces = div('tabs-spaces', ['Main', 'Uni', 'Work'].map((name, index) =>
    element('span', { class: 'tabs-space' + (index === 1 ? ' is-on' : ''), text: name })));

  return div('stage stage-tabs', [
    div('mini-window', [strip, split]),
    vertical,
    spaces,
  ]);
}

/**
 * Where the registry gives two modes the same glyph (Student and Legal are
 * both a bookmark), the guide tells them apart: side by side on one card,
 * twin icons read as a mistake.
 */
const MODE_GLYPHS = { legal: 'doc' };

/** Modes: the real mode registry, each tile a way in. */
function stageModes() {
  const registry = window.modes?.MODES || {};
  const tiles = ['student', 'legal', 'shopping', 'focus'].map((id, index) => {
    const mode = registry[id];
    if (!mode) return null;
    const tile = element('button', {
      type: 'button', class: 'mode-tile', 'data-mode': id,
      onclick: () => openPage(mode.page),
    }, [
      div('mode-glyph', [icon(MODE_GLYPHS[id] || mode.icon, { size: 18 })]),
      element('strong', { text: mode.name }),
      element('span', { text: mode.tagline }),
      div('mode-go', [icon('chevron_right', { size: 13 })]),
    ]);
    tile.style.setProperty('--i', index);
    return tile;
  });
  return div('stage stage-modes', tiles);
}

/** The last card: the mark, settled. */
function stageEnd() {
  return div('stage stage-end', [
    div('end-halo'),
    div('end-mark', [element('img', { src: '../assets/static-mark.svg', alt: '' })]),
  ]);
}

/** A browser window in miniature, with its address and optional shield. */
function miniWindow(address, content, { shield = false } = {}) {
  return div('mini-window', [
    div('mini-toolbar', [
      div('mini-lights', [element('i'), element('i'), element('i')]),
      div('mini-address', [icon('lock', { size: 10 }), element('span', { text: address })]),
      shield ? div('mini-shield', [icon('shield', { filled: true, size: 13 }), element('b', { class: 'count', 'data-target': '35', text: '35' })]) : null,
    ]),
    content,
  ]);
}

/* ---- the cards ----------------------------------------------------------- */

/**
 * One line of what each thing does, and a button that goes there. The
 * destinations are addresses main already allows; nothing here can open
 * anything a person could not type into the address bar themselves.
 */
const CARDS = [
  {
    id: 'start', eyebrow: 'Welcome', title: ['Static, in ', 'a minute.'],
    line: 'Six things worth knowing on your first day. Swipe, scroll or use the arrow keys.',
    stage: stageIntro,
    actions: [{ label: 'Start the tour', primary: true, run: () => goTo(1) }],
    index: true,
  },
  {
    id: 'yours', icon: 'palette', eyebrow: 'Make it yours', title: ['A browser that looks like ', 'you.'],
    line: 'Wear a planet, pick a wallpaper or forge a world of your own, and the whole browser follows.',
    chips: ['Planets', 'Wallpapers', 'Forge a planet', 'Fonts and spacing'],
    stage: stageYours,
    actions: [{ label: 'Open Appearance', primary: true, url: 'browser://settings#appearance' }],
  },
  {
    id: 'shields', icon: 'shield', eyebrow: 'Shields', title: ['Ads gone ', 'before they load.'],
    line: 'Ads and trackers are stopped before they reach the page, YouTube included, and you decide site by site.',
    chips: ['Ad blocking', 'Tracker blocking', 'HTTPS upgrades', 'Per-site control'],
    stage: stageShields,
    actions: [{ label: 'Open Shields', primary: true, url: 'browser://shields' }],
  },
  {
    id: 'passwords', icon: 'key', eyebrow: 'Passwords and passkeys', title: ['Sign in ', 'without remembering.'],
    line: 'Logins and passkeys are kept on this device, encrypted by your system, and filled in with one click.',
    chips: ['Saved passwords', 'Passkeys', 'Password health', 'Autofill'],
    stage: stagePasswords,
    actions: [{ label: 'Open Passwords', primary: true, url: 'browser://passwords' }],
  },
  {
    id: 'assistant', icon: 'sparkle', eyebrow: 'The assistant', title: ['Ask about ', 'the page you are on.'],
    line: 'Summaries and answers from a sidebar that only reads a page when you ask it to.',
    chips: ['Summarise', 'Explain a selection', 'Saved chats', 'Notes'],
    stage: stageAssistant,
    actions: [
      { label: 'Ask the assistant', primary: true, url: 'browser://ai' },
      // With the sidebar switched off in Settings it will not open, so the
      // button goes to that switch instead of doing nothing.
      { label: 'Open the sidebar', run: () => invoke('sidebar:toggle', { open: true })
        .then((open) => { if (!open) openPage('browser://settings#workspaces'); }) },
    ],
  },
  {
    id: 'tabs', icon: 'tabs', eyebrow: 'Tabs', title: ['Tabs that ', 'keep up with you.'],
    line: 'Group them, pin them, put two side by side, run them down the side, or give each project a workspace.',
    chips: ['Tab groups', 'Pinned tabs', 'Split view', 'Vertical tabs', 'Workspaces'],
    stage: stageTabs,
    actions: [
      { label: 'Organise tabs', primary: true, url: 'browser://organizer' },
      { label: 'Workspaces', url: 'browser://dashboard' },
    ],
  },
  {
    id: 'modes', icon: 'grid', eyebrow: 'Modes', title: ['A different browser ', 'for each job.'],
    line: 'Revise as a student, research the law, compare prices, or shut out everything but the work.',
    chips: ['Student', 'Legal', 'Shopping', 'Focus'],
    stage: stageModes,
    actions: [{ label: 'See every mode', primary: true, url: 'browser://dashboard' }],
  },
  {
    id: 'end', eyebrow: 'That is the tour', title: ['Over ', 'to you.'],
    line: 'This guide is in Help and on the main menu whenever you want it again.',
    stage: stageEnd,
    actions: [
      { label: 'Start browsing', primary: true, run: () => leave() },
      { label: 'Open Help', url: 'browser://help' },
    ],
  },
];

/* ---- building ------------------------------------------------------------ */

function actionButton(action) {
  const button = element('button', {
    type: 'button',
    class: 'guide-action' + (action.primary ? ' is-primary' : ''),
    'data-url': action.url || null,
    onclick: () => (action.url ? openPage(action.url) : action.run()),
  }, [element('span', { text: action.label }), action.primary ? icon('chevron_right', { size: 14 }) : null]);
  return button;
}

function card(def, index) {
  const copy = div('guide-copy', [
    element('span', { class: 'guide-eyebrow' }, [
      def.icon ? icon(def.icon, { size: 13 }) : null,
      element('span', { text: def.eyebrow }),
    ]),
    // The second half of each title carries the accent: the words that say
    // what is in it for the reader, not wherever a gradient happens to land.
    element('h2', {}, [element('span', { text: def.title[0] }), element('em', { text: def.title[1] })]),
    element('p', { class: 'guide-line', text: def.line }),
    def.chips ? element('ul', { class: 'guide-chips' }, def.chips.map((chip) => element('li', { text: chip }))) : null,
    // The opening card is also a contents page.
    def.index ? element('ol', { class: 'guide-index' }, CARDS.filter((item) => item.icon).map((item) =>
      element('li', {}, [element('button', {
        type: 'button', onclick: () => goTo(CARDS.indexOf(item)),
      }, [icon(item.icon, { size: 14 }), element('span', { text: item.eyebrow })])]))) : null,
    div('guide-actions', def.actions.map(actionButton)),
  ]);

  return element('section', {
    class: 'guide-card card-' + def.id,
    id: 'card-' + def.id,
    'data-card': def.id,
    'aria-roledescription': 'card',
    'aria-label': (index + 1) + ' of ' + CARDS.length + ': ' + def.eyebrow,
  }, [copy, div('guide-stage-wrap', [def.stage()])]);
}

/* ---- moving between cards ------------------------------------------------ */

let active = -1;

/**
 * The card a button, dot or key is taking the track to, until it arrives.
 *
 * While a smooth scroll passes the cards in between, the one nearest the
 * centre is briefly each of them; without this, a resize mid-scroll (the
 * sidebar opening, the window changing) would re-centre on whichever card
 * happened to be passing and strand the tour there.
 */
let heading = null;

function cards() { return [...document.querySelectorAll('.guide-card')]; }

/** Scroll a card to the centre. `instant` skips the glide, as after a resize. */
function goTo(index, { instant = false } = {}) {
  const list = cards();
  const target = list[Math.max(0, Math.min(list.length - 1, index))];
  if (!target) return;
  const track = $('#track');
  const left = target.offsetLeft - (track.clientWidth - target.clientWidth) / 2;
  const smooth = !instant && !still() && Math.abs(track.scrollLeft - left) > 1;
  heading = smooth ? list.indexOf(target) : null;
  track.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  // A scroll that does not move (already there) fires no event, so settle
  // now rather than waiting for one.
  setActive(list.indexOf(target));
  if (!smooth) measure();
}

/**
 * Which card is centred, and how far each one is from the centre.
 *
 * The distance drives the depth: cards either side sit back and dim, so the
 * one being read is the one in focus without a modal frame around it.
 */
function measure() {
  const track = $('#track');
  const centre = track.scrollLeft + track.clientWidth / 2;
  let best = 0;
  let bestDistance = Infinity;
  cards().forEach((node, index) => {
    const middle = node.offsetLeft + node.clientWidth / 2;
    const distance = (middle - centre) / node.clientWidth;
    node.style.setProperty('--ad', Math.min(1.5, Math.abs(distance)).toFixed(3));
    if (Math.abs(distance) < bestDistance) { bestDistance = Math.abs(distance); best = index; }
  });
  if (heading === null) setActive(best);
}

function setActive(index) {
  if (index === active) return;
  active = index;
  cards().forEach((node, i) => {
    node.classList.toggle('is-active', i === index);
    node.setAttribute('aria-hidden', String(i !== index));
    // Only the centred card's buttons are reachable by Tab, so the keyboard
    // never lands on something half off-screen.
    for (const control of node.querySelectorAll('button')) control.tabIndex = i === index ? 0 : -1;
  });
  for (const [i, dot] of [...document.querySelectorAll('.guide-dot')].entries()) {
    dot.classList.toggle('is-on', i === index);
    dot.setAttribute('aria-selected', String(i === index));
  }
  $('#prev').disabled = index === 0;
  $('#next').disabled = index === CARDS.length - 1;
  $('#count').textContent = (index + 1) + ' / ' + CARDS.length;
  const id = CARDS[index]?.id;
  // The place is kept in the address, so Back from a page this opened (or a
  // link to browser://guide#tabs) lands on the right card.
  if (id) history.replaceState(null, '', '#' + id);
  countUp(cards()[index]);
}

/** Numbers that climb when their card arrives, rather than sitting there. */
function countUp(node) {
  if (!node) return;
  for (const count of node.querySelectorAll('.count')) {
    const target = Number(count.dataset.target) || 0;
    if (still()) { count.textContent = target.toLocaleString(); continue; }
    const started = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - started) / 1500);
      const eased = 1 - Math.pow(1 - t, 3);
      count.textContent = Math.round(target * eased).toLocaleString();
      if (t < 1 && node.classList.contains('is-active')) requestAnimationFrame(tick);
      else count.textContent = target.toLocaleString();
    };
    requestAnimationFrame(tick);
  }
}

/** Wear a planet, from the orrery. */
function wear(id) {
  invoke('settings:update', { theme: id }).catch(() => {});
  for (const node of document.querySelectorAll('[data-planet]')) {
    node.classList.toggle('is-worn', node.dataset.planet === id);
  }
}

/** Leave the tour: to a new tab after setup, or back where they came from. */
function leave() {
  if (!fromSetup && history.length > 1) { history.back(); return; }
  invoke('tabs:navigate', { input: 'browser://newtab' });
}

/* ---- start --------------------------------------------------------------- */

function build() {
  const track = $('#track');
  track.replaceChildren(...CARDS.map(card));

  $('#dots').replaceChildren(...CARDS.map((def, index) => element('button', {
    type: 'button', class: 'guide-dot', role: 'tab', 'aria-label': def.eyebrow, title: def.eyebrow,
    onclick: () => goTo(index),
  }, [element('span', { text: def.eyebrow })])));

  $('#prev').append(icon('back', { size: 16 }));
  $('#next').append(icon('forward', { size: 16 }));
  $('#prev').addEventListener('click', () => goTo(active - 1));
  $('#next').addEventListener('click', () => goTo(active + 1));

  const skip = $('#skip');
  skip.textContent = fromSetup ? 'Skip the tour' : 'Close the guide';
  skip.addEventListener('click', leave);

  // Measured on the next frame rather than on every scroll event, so a fast
  // swipe costs one layout read per frame.
  let queued = false;
  track.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; measure(); });
  }, { passive: true });
  // Arrived: from here a swipe decides which card is centred again.
  track.addEventListener('scrollend', () => { heading = null; measure(); });
  // A person's own swipe or drag takes over from any glide in progress.
  for (const type of ['pointerdown', 'touchstart']) {
    track.addEventListener(type, () => { heading = null; }, { passive: true });
  }
  addEventListener('resize', () => goTo(heading ?? active, { instant: true }));

  // A mouse wheel scrolls up and down, which a sideways track ignores. One
  // notch moves one card; a trackpad's own sideways swipe is left alone.
  let wheelLock = 0;
  track.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const now = Date.now();
    if (now < wheelLock || Math.abs(event.deltaY) < 4) return;
    wheelLock = now + 420;
    goTo(active + (event.deltaY > 0 ? 1 : -1));
  }, { passive: false });

  addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); goTo(active + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); goTo(active - 1); }
    else if (event.key === 'Home') { event.preventDefault(); goTo(0); }
    else if (event.key === 'End') { event.preventDefault(); goTo(CARDS.length - 1); }
    else if (event.key === 'Escape') { event.preventDefault(); leave(); }
  });

  const start = Math.max(0, CARDS.findIndex((def) => '#' + def.id === location.hash));
  // Laid out first, then placed without animation: arriving on a card should
  // not look like the tour scrolling past the others.
  requestAnimationFrame(() => {
    track.scrollLeft = cards()[start].offsetLeft - (track.clientWidth - cards()[start].clientWidth) / 2;
    measure();
    document.body.classList.add('is-ready');
  });
}

function applyMotion() {
  document.body.classList.toggle('is-still', still());
}

prefersReduced.addEventListener('change', applyMotion);

window.page.onState((state) => {
  app = state;
  const before = animationsOff;
  animationsOff = state?.settings?.animations === false;
  if (before !== animationsOff || !document.body.classList.contains('is-ready')) applyMotion();
  const theme = state?.settings?.theme;
  for (const node of document.querySelectorAll('[data-planet]')) {
    node.classList.toggle('is-worn', node.dataset.planet === theme);
  }
});

build();
applyMotion();

// Exposed for the probe, which drives the tour the way a person would but
// needs to know which card is centred.
window.guide = { goTo, get active() { return active; }, cards: CARDS.map((def) => def.id) };
})();
