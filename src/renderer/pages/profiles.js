'use strict';
(function () {
/**
 * Profile picker.
 *
 * Shows the profiles the user has made and enters the one they choose. Every
 * decision - which profiles exist, which is default, whether one is locked -
 * comes from the main process; this file draws and reports clicks.
 *
 * The motion is the point of the screen, so it is handled carefully: cards
 * rise in staggered, answer the pointer in their own colour, and the chosen
 * one expands while the rest fall back, so entering reads as going somewhere
 * rather than as a page swap. All of it switches off under reduced motion.
 */

const { invoke, $, element, icon } = window.page;

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = null;
let entering = false;

/* ---- background ---------------------------------------------------------- */

function startStars() {
  if (reduced) return;
  const canvas = $('#stars');
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let particles = [];
  const pointer = { x: 0.5, y: 0.5 };

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.width = Math.floor(innerWidth * ratio);
    height = canvas.height = Math.floor(innerHeight * ratio);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    const count = Math.min(200, Math.round((innerWidth * innerHeight) / 10000));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: (Math.random() * 1.5 + 0.3) * ratio,
      vx: (Math.random() - 0.5) * 0.14 * ratio,
      vy: (Math.random() - 0.5) * 0.14 * ratio,
      a: Math.random() * 0.4 + 0.1,
      phase: Math.random() * Math.PI * 2,
    }));
  };

  const accent = () => getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#5aa7f0';
  let colour = accent();
  let frame = 0;

  const draw = () => {
    frame++;
    ctx.clearRect(0, 0, width, height);
    const px = pointer.x * width;
    const py = pointer.y * height;
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      const dx = p.x - px;
      const dy = p.y - py;
      const distance = Math.hypot(dx, dy);
      const reach = 180 * (window.devicePixelRatio || 1);
      if (distance < reach && distance > 0.1) {
        const push = (1 - distance / reach) * 0.5;
        p.x += (dx / distance) * push;
        p.y += (dy / distance) * push;
      }
      if (p.x < 0) p.x = width; else if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height; else if (p.y > height) p.y = 0;
      ctx.globalAlpha = p.a * (0.65 + Math.sin(frame * 0.02 + p.phase) * 0.35);
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  };

  addEventListener('resize', resize);
  addEventListener('pointermove', (event) => {
    pointer.x = event.clientX / innerWidth;
    pointer.y = event.clientY / innerHeight;
  });
  new MutationObserver(() => { colour = accent(); })
    .observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

  resize();
  requestAnimationFrame(draw);
}

/* ---- helpers ------------------------------------------------------------- */

function fail(message) { $('#error').textContent = message || ''; }

/** "2 hours ago" for the last-used line. */
function ago(timestamp) {
  if (!timestamp) return 'Not used yet';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 90) return 'Used just now';
  if (seconds < 3600) return 'Used ' + Math.round(seconds / 60) + ' minutes ago';
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600);
    return 'Used ' + hours + (hours === 1 ? ' hour ago' : ' hours ago');
  }
  const days = Math.round(seconds / 86400);
  if (days === 1) return 'Used yesterday';
  if (days < 30) return 'Used ' + days + ' days ago';
  return 'Used ' + new Date(timestamp).toLocaleDateString();
}

/** An avatar glyph. Falls back to the profile's initial. */
function avatarFor(profile) {
  if (profile.emoji) return element('span', { class: 'picker-emoji', text: profile.emoji });
  try {
    const glyph = icon(profile.avatar === 'planet' ? 'grid' : profile.avatar, { size: 30 });
    if (glyph) return glyph;
  } catch { /* not a known glyph; fall through to the initial */ }
  return element('span', { class: 'picker-emoji', text: (profile.name[0] || '?').toUpperCase() });
}

/* ---- entering ------------------------------------------------------------ */

/** Ask for a PIN in place on the card, rather than in a dialog. */
function askPin(card, profile) {
  const input = element('input', {
    type: 'password', inputmode: 'numeric', maxlength: 12,
    'aria-label': 'PIN for ' + profile.name, autofocus: '',
  });
  const box = element('div', { class: 'picker-pin' }, [input]);

  const submit = async () => {
    try {
      const result = await invoke('profiles:enter', { id: profile.id, pin: input.value });
      if (result && result.locked) {
        box.classList.add('is-wrong');
        input.value = '';
        setTimeout(() => box.classList.remove('is-wrong'), 450);
        fail('That PIN is not right.');
        return;
      }
      finish(card);
    } catch (error) { fail(error.message); }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
    if (event.key === 'Escape') { box.remove(); render(); }
  });
  card.querySelector('.picker-enter').replaceWith(box);
  input.focus();
}

/** The chosen card expands, the rest fall back, then main takes over. */
function finish(card) {
  const grid = $('#grid');
  card.classList.add('is-chosen');
  grid.classList.add('is-entering');
}

async function enter(card, profile) {
  if (entering) return;
  fail('');

  if (profile.locked) { askPin(card, profile); return; }

  entering = true;
  finish(card);
  // Let the expansion play before main swaps the view out. Skipped entirely
  // when reduced motion is on, so nothing is waiting on an animation.
  if (!reduced) await new Promise((resolve) => setTimeout(resolve, 260));
  try {
    await invoke('profiles:enter', { id: profile.id });
  } catch (error) {
    entering = false;
    $('#grid').classList.remove('is-entering');
    card.classList.remove('is-chosen');
    fail(error.message);
  }
}

/* ---- cards --------------------------------------------------------------- */

function profileCard(profile, index) {
  const card = element('button', {
    class: 'picker-card',
    'data-id': profile.id,
    'aria-label': 'Enter ' + profile.name,
  }, [
    element('div', { class: 'picker-avatar' }, [avatarFor(profile)]),
    element('div', { class: 'picker-name', text: profile.name, title: profile.name }),
    element('div', { class: 'picker-label', text: profile.label || '' }),
    element('div', { class: 'picker-meta' }, [
      element('span', { text: ago(profile.lastUsedAt) }),
      element('span', { text: profile.tabs
        ? profile.tabs + (profile.tabs === 1 ? ' tab open' : ' tabs open')
        : 'No tabs open' }),
    ]),
    element('div', { class: 'picker-badges' }, [
      profile.guest ? element('span', { class: 'picker-badge is-guest', text: 'Guest' }) : null,
      profile.locked ? element('span', { class: 'picker-badge is-locked', text: 'Locked' }) : null,
      profile.isDefault ? element('span', { class: 'picker-badge', text: 'Default' }) : null,
    ]),
    element('div', { class: 'picker-enter', text: profile.locked ? 'Unlock' : 'Enter' }),
  ]);

  card.style.setProperty('--i', index);
  if (profile.accent) card.style.setProperty('--tone', profile.accent);

  card.addEventListener('click', () => enter(card, profile));
  if (!reduced) {
    card.addEventListener('pointermove', (event) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty('--mx', (event.clientX - box.left) + 'px');
      card.style.setProperty('--my', (event.clientY - box.top) + 'px');
    });
  }
  return card;
}

function addCard(index) {
  const card = element('button', {
    class: 'picker-card is-add',
    'aria-label': 'Create a new profile',
  }, [
    element('div', { class: 'picker-avatar' }, [icon('plus', { size: 30 })]),
    element('div', { class: 'picker-name', text: 'New profile' }),
    element('div', { class: 'picker-label', text: 'A separate space of your own' }),
    element('div', { class: 'picker-meta' }, [
      element('span', { text: 'Its own history, tabs and look' }),
    ]),
    element('div', { class: 'picker-enter', text: 'Create' }),
  ]);
  card.style.setProperty('--i', index);
  card.addEventListener('click', () => invoke('profiles:manage').catch((e) => fail(e.message)));
  return card;
}

function render() {
  if (!state) return;
  const grid = $('#grid');
  grid.classList.remove('is-entering');
  const cards = state.profiles.map((profile, index) => profileCard(profile, index));
  cards.push(addCard(cards.length));
  grid.replaceChildren(...cards);

  // Keyboard: arrows move between cards, Enter opens the focused one.
  grid.addEventListener('keydown', (event) => {
    const all = [...grid.querySelectorAll('.picker-card')];
    const at = all.indexOf(document.activeElement);
    if (at < 0) return;
    let next = at;
    if (event.key === 'ArrowRight') next = Math.min(all.length - 1, at + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, at - 1);
    else return;
    event.preventDefault();
    all[next].focus();
  }, { once: true });
}

/* ---- boot ---------------------------------------------------------------- */

$('#create').addEventListener('click', () =>
  invoke('profiles:manage').catch((error) => fail(error.message)));
$('#manage').addEventListener('click', () =>
  invoke('profiles:manage').catch((error) => fail(error.message)));

async function load() {
  try {
    state = await invoke('profiles:state');
    render();
    // Focus the default profile so the keyboard works from the first press.
    const first = $('#grid').querySelector('.picker-card');
    if (first) first.focus({ preventScroll: true });
  } catch (error) {
    fail('Could not read your profiles: ' + error.message);
  }
}

startStars();
load();

})();
