'use strict';
(function () {
/**
 * First launch.
 *
 * One question per screen, and only the questions that need the person: which
 * world to wear, and - when there is another browser on this computer - what
 * to bring from it. Every optional step is skippable and the whole flow
 * dismissible. The renderer makes no decisions: the step list, which step is
 * current, and whether there is anything to import all come from main.
 * Finishing opens browser://guide, which shows what setup no longer asks.
 *
 * The motion here is deliberate. This is the first thing anyone sees, so it
 * has to feel like the product rather than a form: a drifting starfield that
 * leans away from the pointer, a panel that tilts toward it, and a staged rise
 * as each step arrives. All of it is CSS and one canvas - no library, nothing the
 * strict CSP has to accommodate, and everything switched off for anyone who
 * has asked for reduced motion or turned Static's animations off.
 */

const { invoke, $, element } = window.page;

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Motion is off when the system asks for less, or Static's own animations
 * switch is off - setup can be run again from Settings by someone who turned
 * it off long ago.
 */
let animationsOff = false;
const still = () => reducedQuery.matches || animationsOff;

let state = null;

/** What each step says above its choices. */
const LEDE = {
  welcome: 'A browser that blocks what you did not ask for, and keeps what you are doing to yourself.',
  theme: 'Every planet is a full colour scheme. Hover to see one named, click to wear it - the browser changes straight away, and you can change it again whenever you like.',
  import: 'Bring your bookmarks and history from the browser you used before. Nothing is changed there, and you can do this later from Settings instead.',
  done: '',
};

/** What this run brought over from another browser, for the last screen. */
let imported = null;

/** Set by the starfield once it runs; a planet choice calls it. */
let recolourStars = () => {};
/** Set by the starfield; starts it again when motion is switched back on. */
let wakeStars = () => {};

/* ---- starfield ----------------------------------------------------------- */

/**
 * A slow drift of particles that leans away from the pointer.
 *
 * Canvas rather than DOM nodes: a few hundred elements each with their own
 * animation is a layout cost on every frame, and this has to stay free.
 */
function startStars() {
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
    // Density scales with area so a large window is not sparse and a small one
    // is not a swarm.
    const count = Math.min(190, Math.round((innerWidth * innerHeight) / 11000));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: (Math.random() * 1.5 + 0.35) * ratio,
      vx: (Math.random() - 0.5) * 0.16 * ratio,
      vy: (Math.random() - 0.5) * 0.16 * ratio,
      a: Math.random() * 0.45 + 0.12,
      phase: Math.random() * Math.PI * 2,
    }));
  };

  // The accent, read from the theme rather than hard-coded, so the field
  // matches whatever the user has chosen.
  const accent = () => {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return value || '#47baff';
  };
  let colour = accent();
  recolourStars = () => { colour = accent(); };

  let frame = 0;
  let running = false;
  const draw = () => {
    ctx.clearRect(0, 0, width, height);
    // Stopped rather than paused: a still page costs nothing per frame.
    if (still()) { running = false; return; }
    frame++;
    // Pointer position in canvas space, for the lean.
    const px = pointer.x * width;
    const py = pointer.y * height;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;

      // Gentle repulsion, so moving the mouse parts the field.
      const dx = p.x - px;
      const dy = p.y - py;
      const distance = Math.hypot(dx, dy);
      const reach = 170 * (window.devicePixelRatio || 1);
      if (distance < reach && distance > 0.1) {
        const push = (1 - distance / reach) * 0.55;
        p.x += (dx / distance) * push;
        p.y += (dy / distance) * push;
      }

      // Wrap rather than bounce: a bounce reads as a wall.
      if (p.x < 0) p.x = width; else if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height; else if (p.y > height) p.y = 0;

      const twinkle = 0.65 + Math.sin(frame * 0.02 + p.phase) * 0.35;
      ctx.globalAlpha = p.a * twinkle;
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
  resize();
  wakeStars = () => {
    if (running || still()) return;
    running = true;
    requestAnimationFrame(draw);
  };
  wakeStars();
}

/* ---- panel tilt ---------------------------------------------------------- */

/** The panel leans a degree or two toward the pointer. Subtle on purpose. */
function startTilt() {
  const panel = $('#panel');
  addEventListener('pointermove', (event) => {
    if (still()) return;
    const x = event.clientX / innerWidth - 0.5;
    const y = event.clientY / innerHeight - 0.5;
    panel.style.setProperty('--tilt-y', (x * 3).toFixed(2));
    panel.style.setProperty('--tilt-x', (-y * 2).toFixed(2));
  });
  addEventListener('pointerleave', () => {
    panel.style.setProperty('--tilt-x', '0');
    panel.style.setProperty('--tilt-y', '0');
  });
}

/* ---- helpers ------------------------------------------------------------- */

function show(message) {
  const existing = $('#body').querySelector('.welcome-error');
  if (existing) existing.textContent = message;
  else $('#body').append(element('p', { class: 'welcome-error', text: message }));
}

/** Give every child of a container its stagger index. */
function stagger(container) {
  let index = 0;
  for (const node of container.children) {
    node.classList.add('rise');
    node.style.setProperty('--i', index++);
  }
}

/** A feature line with its own pulsing dot. */
function feature(index, title, rest) {
  const dot = element('span', { class: 'welcome-dot' });
  dot.style.setProperty('--i', index);
  return element('li', {}, [
    dot,
    element('span', {}, [
      element('strong', { text: title }),
      element('span', { text: ' — ' + rest }),
    ]),
  ]);
}

/* ---- step bodies --------------------------------------------------------- */

/** How long setup is, said plainly, so the first screen sets expectations. */
function lengthNote() {
  const questions = state.steps.filter((step) => step.optional).length;
  const words = ['', 'one quick choice', 'two quick choices', 'three quick choices'];
  return 'Setting up is ' + (words[questions] || questions + ' quick choices')
    + ', then a short look around. You can change any of it later.';
}

/** The planet's name as the planetarium knows it, built-in or forged. */
function planetName(id) {
  const planet = (state.planets || []).find((item) => item.id === id);
  return planet ? planet.name : '';
}

function body() {
  const box = element('div');

  if (state.stepId === 'welcome') {
    const list = element('ul', { class: 'welcome-list' }, [
      feature(0, 'Ads and trackers blocked',
        'including on YouTube, using filter lists updated on this device.'),
      feature(1, 'Nothing leaves your machine',
        'history, notes and passwords are stored locally and encrypted by your system.'),
      feature(2, 'Yours to shape',
        'planets, wallpapers, tab groups, split view, and an assistant you have to ask.'),
    ]);
    box.append(list);
    box.append(element('p', { class: 'welcome-note', text: lengthNote() }));
    return box;
  }

  if (state.stepId === 'import') {
    if (window.importPanel) {
      box.append(window.importPanel.build({ element, invoke, onDone: (result) => { imported = result; } }));
    }
    return box;
  }

  if (state.stepId === 'theme') {
    // The same planetarium as Settings, so choosing a theme is the same
    // gesture wherever it is done.
    const host = element('div', { class: 'welcome-planets' });
    box.append(host);
    if (window.planetarium && state.planets && state.planets.length) {
      const view = window.planetarium.build({ element, icon: window.page.icon }, {
        planets: state.planets,
        current: state.chosen.theme || state.currentTheme,
        onPick: (id) => {
          // Kept in step with main without re-rendering, so the planetarium
          // is not rebuilt under the pointer that just chose.
          invoke('onboarding:theme', { id })
            .then((next) => { state = next; })
            .catch((e) => show(e.message));
        },
      });
      host.append(view.node);
    } else {
      host.append(element('p', { class: 'welcome-note',
        text: 'Themes are not available in this build.' }));
    }
    return box;
  }

  // done
  box.append(element('div', { class: 'welcome-seal' }, [(() => {
    // A tick that draws itself in.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 12.5 L9.5 18 L20 6.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  })()]));

  const summary = [];
  const world = planetName(state.chosen.theme || state.currentTheme);
  if (world) {
    // A skipped world is still a world - whichever the browser is already
    // wearing - so it is named, and said to be left alone rather than chosen.
    // Not "the default": someone re-running setup may be wearing another.
    const passed = !state.chosen.theme && state.skipped.includes('theme');
    summary.push(['Your world', passed ? world + ', left as it was' : world]);
  }
  if (imported) {
    const parts = [];
    if (imported.bookmarks) parts.push(imported.bookmarks + (imported.bookmarks === 1 ? ' bookmark' : ' bookmarks'));
    if (imported.history) parts.push(imported.history + (imported.history === 1 ? ' page' : ' pages') + ' of history');
    if (imported.homepage) parts.push('your homepage');
    summary.push(['Brought over', (parts.join(', ') || 'nothing new') + (imported.from ? ' from ' + imported.from : '')]);
  }
  box.append(element('ul', { class: 'welcome-list' },
    summary.map(([label, value], index) => feature(index, label, value))));

  // The one line that stands in for every question this no longer asks.
  box.append(element('p', { class: 'welcome-defaults' }, [
    element('span', { text: 'Everything else starts on sensible defaults - your homepage, standard shields and the assistant - and all of it is in ' }),
    element('strong', { text: 'Settings' }),
    element('span', { text: '.' }),
  ]));
  return box;
}

/* ---- render -------------------------------------------------------------- */

function render() {
  if (!state) return;

  $('#steps').replaceChildren(...state.steps.map((step, index) => element('span', {
    class: 'welcome-step'
      + (index === state.step ? ' is-current' : '')
      + (index < state.step ? ' is-done' : '')
      + (state.skipped.includes(step.id) ? ' is-skipped' : ''),
    text: step.title,
  })));

  $('#title').textContent = state.stepTitle;
  // The last screen is a moment rather than a form, and is laid out as one.
  $('#panel').classList.toggle('is-finale', state.stepId === 'done');
  $('#lede').textContent = LEDE[state.stepId] || '';

  const next = body();
  $('#body').replaceChildren(next);
  // Stagger the step's own content, so the screen assembles rather than
  // appearing.
  stagger(next);

  const back = $('#back');
  back.disabled = state.step === 0;

  // On the last step the quiet button is the way past the tour, so finishing
  // never forces a guide on anyone who would rather just browse.
  const skip = $('#skip');
  skip.hidden = !state.canSkip && !state.isLast;
  skip.textContent = state.isLast ? 'Skip the tour' : 'Skip this';

  const button = $('#next');
  button.textContent = state.isLast ? 'Show me around' : 'Continue';
}

/**
 * Move to a new state with the outgoing step dropping away first.
 *
 * Without this the content swaps instantly under a panel that is still, which
 * is what made the original version feel like a form.
 */
async function transition(nextState) {
  const panel = $('#panel');
  if (still()) { state = nextState; render(); return; }
  panel.classList.add('is-leaving');
  // Short enough that the flow never feels gated on an animation - the whole
  // out-and-in reads as one motion rather than a wait.
  await new Promise((resolve) => setTimeout(resolve, 120));
  panel.classList.remove('is-leaving');
  state = nextState;
  render();
}

async function step(channel) {
  try {
    await transition(await invoke(channel));
  } catch (error) {
    show(error.message);
  }
}

$('#back').addEventListener('click', () => step('onboarding:back'));
/** Finish setup: into the guide, unless the tour was skipped. */
async function finish(tour) {
  try { await invoke('onboarding:complete', { tour }); } catch (error) { show(error.message); }
}

$('#skip').addEventListener('click', () => {
  if (state && state.isLast) return finish(false);
  return step('onboarding:skip');
});
$('#next').addEventListener('click', () => {
  if (state && state.isLast) return finish(true);
  return step('onboarding:next');
});

// Follow the theme, so choosing a planet recolours this page as well as the
// browser around it: the choice is seen where it was made.
window.page.onState((app) => {
  recolourStars();
  animationsOff = app?.settings?.animations === false;
  applyMotion();
});

/** The page's CSS stands still under one class, whichever switch asked. */
function applyMotion() {
  document.body.classList.toggle('is-still', still());
  if (still()) {
    $('#panel').style.setProperty('--tilt-x', '0');
    $('#panel').style.setProperty('--tilt-y', '0');
  }
  wakeStars();
}
reducedQuery.addEventListener('change', applyMotion);

startStars();
startTilt();
applyMotion();
step('onboarding:state');

})();
