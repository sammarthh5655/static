'use strict';
(function () {
/**
 * First launch.
 *
 * One question per screen, every optional step skippable, and the whole flow
 * dismissible. The renderer makes no decisions: the step list, which step is
 * current, what each card says and whether the assistant can be offered all
 * come from the main process.
 *
 * The motion here is deliberate. This is the first thing anyone sees, so it
 * has to feel like the product rather than a form: a drifting starfield that
 * leans away from the pointer, a panel that tilts toward it, cards that light
 * up under the cursor and ripple where they are clicked, and a staged rise as
 * each step arrives. All of it is CSS and one canvas - no library, nothing the
 * strict CSP has to accommodate, and everything switched off for anyone who
 * has asked for reduced motion.
 */

const { invoke, $, element } = window.page;

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = null;

/** What each step says above its choices. */
const LEDE = {
  welcome: 'A browser that blocks what you did not ask for, and keeps what you are doing to yourself. Setting up takes about a minute, and you can change any of it later.',
  profile: 'This sets your homepage and theme to something sensible. Everything stays editable in Settings.',
  homepage: 'What you see when you open a new tab. Widgets can be added, removed and rearranged later.',
  privacy: 'How much Static blocks by default. You can change this per site from the shield in the toolbar.',
  ai: 'The assistant can summarise a page you are reading and answer questions about it.',
  done: '',
};

/* ---- starfield ----------------------------------------------------------- */

/**
 * A slow drift of particles that leans away from the pointer.
 *
 * Canvas rather than DOM nodes: a few hundred elements each with their own
 * animation is a layout cost on every frame, and this has to stay free.
 */
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
    const value = getComputedStyle(document.body).getPropertyValue('--accent').trim();
    return value || '#47baff';
  };
  let colour = accent();

  let frame = 0;
  const draw = () => {
    frame++;
    ctx.clearRect(0, 0, width, height);
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
  // The theme can change under us (a profile choice does exactly that).
  const observer = new MutationObserver(() => { colour = accent(); });
  observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

  resize();
  requestAnimationFrame(draw);
}

/* ---- panel tilt ---------------------------------------------------------- */

/** The panel leans a degree or two toward the pointer. Subtle on purpose. */
function startTilt() {
  if (reduced) return;
  const panel = $('#panel');
  addEventListener('pointermove', (event) => {
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

/** A choice card. The whole card is the button. */
function choice(item, chosen, onPick) {
  const card = element('button', {
    class: 'welcome-choice' + (chosen ? ' is-chosen' : ''),
    onclick: (event) => {
      if (!reduced) {
        // A ripple from the exact point that was clicked.
        const box = card.getBoundingClientRect();
        const size = Math.max(box.width, box.height) * 2;
        const ripple = element('span', { class: 'ripple' });
        ripple.style.setProperty('width', size + 'px');
        ripple.style.setProperty('height', size + 'px');
        ripple.style.setProperty('left', (event.clientX - box.left) + 'px');
        ripple.style.setProperty('top', (event.clientY - box.top) + 'px');
        card.append(ripple);
        setTimeout(() => ripple.remove(), 640);
      }
      onPick(item.id);
    },
  }, [
    element('div', { class: 'welcome-choice-head' }, [
      element('span', { class: 'welcome-choice-name', text: item.name }),
      // Stated in words as well as colour, so the selection is readable
      // without relying on the accent being visible.
      chosen ? element('span', { class: 'welcome-choice-mark', text: 'Chosen' }) : null,
    ]),
    element('div', { class: 'welcome-choice-summary', text: item.summary }),
  ]);

  if (!reduced) {
    card.addEventListener('pointermove', (event) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty('--mx', (event.clientX - box.left) + 'px');
      card.style.setProperty('--my', (event.clientY - box.top) + 'px');
    });
  }
  return card;
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

/** Pick, then move on - choosing is the answer, so it should not need two clicks. */
async function pickAndAdvance(channel, id) {
  try {
    const chosen = await invoke(channel, { id });
    // Advancing returns a fresh state, which would drop any warning the choice
    // came back with. Carry it over so a partly-applied choice still says so.
    const next = { ...(await invoke('onboarding:next')), warning: chosen.warning || null };
    await transition(next);
    if (next.warning) show(next.warning);
  } catch (error) {
    show(error.message);
  }
}

/* ---- step bodies --------------------------------------------------------- */

function body() {
  const box = element('div');

  if (state.stepId === 'welcome') {
    const list = element('ul', { class: 'welcome-list' }, [
      feature(0, 'Ads and trackers blocked',
        'including on YouTube, using filter lists updated on this device.'),
      feature(1, 'Nothing leaves your machine',
        'history, notes and passwords are stored locally and encrypted by your system.'),
      feature(2, 'Tools that stay out of the way',
        'focus sessions, tab groups and an assistant you have to ask.'),
    ]);
    box.append(list);
    return box;
  }

  if (state.stepId === 'profile') {
    box.append(element('div', { class: 'welcome-choices' },
      state.profiles.map((profile) => choice(
        profile, state.chosen.profile === profile.id,
        (id) => pickAndAdvance('onboarding:profile', id)))));
    return box;
  }

  if (state.stepId === 'homepage') {
    box.append(element('div', { class: 'welcome-choices' },
      state.layouts.map((layout) => choice(
        layout, state.chosen.layout === layout.id,
        (id) => pickAndAdvance('onboarding:layout', id)))));
    return box;
  }

  if (state.stepId === 'privacy') {
    box.append(element('div', { class: 'welcome-choices' },
      state.privacyLevels.map((level) => choice(
        level, state.chosen.privacy === level.id,
        (id) => pickAndAdvance('onboarding:privacy', id)))));
    return box;
  }

  if (state.stepId === 'ai') {
    if (!state.aiAvailable) {
      // Say so rather than offering something that would fail on first use.
      box.append(element('p', { class: 'welcome-note',
        text: 'The assistant is not available in this build, so there is nothing to decide here.' }));
      return box;
    }
    box.append(element('div', { class: 'welcome-choices' }, [
      choice({ id: 'on', name: 'Ask before reading a page',
        summary: 'The assistant can read the page you are on, but only when you ask it to, and it tells you each time.' },
      state.chosen.aiEnabled === true, () => pickAndAdvance('onboarding:ai', 'on')),
      choice({ id: 'off', name: 'Keep it switched off',
        summary: 'No page content is ever read. You can switch this on later in Settings.' },
      state.chosen.aiEnabled === false, () => pickAndAdvance('onboarding:ai', 'off')),
    ]));
    box.append(element('p', { class: 'welcome-note',
      text: 'Either way, pages on banking and health sites are never read without a separate confirmation.' }));
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
  if (state.chosen.profile) {
    const profile = state.profiles.find((item) => item.id === state.chosen.profile);
    if (profile) summary.push(['Profile', profile.name]);
  }
  if (state.chosen.layout) {
    const layout = state.layouts.find((item) => item.id === state.chosen.layout);
    if (layout) summary.push(['Homepage', layout.name]);
  }
  if (state.chosen.privacy) {
    const level = state.privacyLevels.find((item) => item.id === state.chosen.privacy);
    if (level) summary.push(['Privacy', level.name]);
  }
  if (state.chosen.aiEnabled !== null) {
    summary.push(['Assistant', state.chosen.aiEnabled ? 'On, and it asks first' : 'Off']);
  }

  box.append(element('ul', { class: 'welcome-list' },
    summary.length
      ? summary.map(([label, value], index) => feature(index, label + ':', value))
      : [feature(0, 'Nothing was changed', 'Static is running on its defaults.')]));

  // Honest about what was passed over, rather than implying it was answered.
  if (state.skipped.length) {
    box.append(element('p', { class: 'welcome-note',
      text: 'You skipped ' + state.skipped.length
        + (state.skipped.length === 1 ? ' step' : ' steps')
        + '. Those settings are on their defaults and are in Settings whenever you want them.' }));
  }
  box.append(element('p', { class: 'welcome-note',
    text: 'All of this is in Settings, and you can run this setup again from there.' }));
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
  $('#lede').textContent = LEDE[state.stepId] || '';

  const next = body();
  $('#body').replaceChildren(next);
  // Stagger the step's own content, and the choices within it, so the screen
  // assembles rather than appearing.
  stagger(next);
  const choices = next.querySelector('.welcome-choices');
  if (choices) stagger(choices);

  const back = $('#back');
  back.disabled = state.step === 0;

  const skip = $('#skip');
  skip.hidden = !state.canSkip;

  const button = $('#next');
  button.textContent = state.isLast ? 'Start browsing' : 'Continue';
  // The profile step is the one real question, so Continue waits for it.
  button.disabled = state.stepId === 'profile' && !state.chosen.profile;
}

/**
 * Move to a new state with the outgoing step dropping away first.
 *
 * Without this the content swaps instantly under a panel that is still, which
 * is what made the original version feel like a form.
 */
async function transition(nextState) {
  const panel = $('#panel');
  if (reduced) { state = nextState; render(); return; }
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
$('#skip').addEventListener('click', () => step('onboarding:skip'));
$('#next').addEventListener('click', async () => {
  if (state && state.isLast) {
    try { await invoke('onboarding:complete'); } catch (error) { show(error.message); }
    return;
  }
  step('onboarding:next');
});

startStars();
startTilt();
step('onboarding:state');

})();
