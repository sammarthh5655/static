'use strict';
(function () {
/**
 * First launch.
 *
 * One question per screen, every optional step skippable, and the whole flow
 * dismissible. The renderer makes no decisions: the step list, which step is
 * current, what each card says and whether the assistant can be offered all
 * come from the main process.
 */

const { invoke, $, element } = window.page;

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

function show(message) {
  const existing = $('#body').querySelector('.welcome-error');
  if (existing) existing.textContent = message;
  else $('#body').append(element('p', { class: 'welcome-error', text: message }));
}

/** A choice card. The whole card is the button. */
function choice(item, chosen, onPick) {
  return element('button', {
    class: 'welcome-choice' + (chosen ? ' is-chosen' : ''),
    onclick: () => onPick(item.id),
  }, [
    element('div', { class: 'welcome-choice-head' }, [
      element('span', { class: 'welcome-choice-name', text: item.name }),
      // Stated in words as well as colour, so the selection is readable
      // without relying on the accent being visible.
      chosen ? element('span', { class: 'welcome-choice-mark', text: 'Chosen' }) : null,
    ]),
    element('div', { class: 'welcome-choice-summary', text: item.summary }),
  ]);
}

function pick(channel, id) {
  return async () => {
    try {
      state = await invoke(channel, { id });
      render();
    } catch (error) {
      show(error.message);
    }
  };
}

/** Pick, then move on - choosing is the answer, so it should not need two clicks. */
async function pickAndAdvance(channel, id) {
  try {
    state = await invoke(channel, { id });
    state = await invoke('onboarding:next');
    render();
  } catch (error) {
    show(error.message);
  }
}

function body() {
  const box = element('div');

  if (state.stepId === 'welcome') {
    box.append(element('ul', { class: 'welcome-list' }, [
      element('li', {}, [element('strong', { text: 'Ads and trackers blocked' }),
        element('span', { text: ' — including on YouTube, using filter lists updated on this device.' })]),
      element('li', {}, [element('strong', { text: 'Nothing leaves your machine' }),
        element('span', { text: ' — history, notes and passwords are stored locally and encrypted by your system.' })]),
      element('li', {}, [element('strong', { text: 'Tools that stay out of the way' }),
        element('span', { text: ' — focus sessions, tab groups and an assistant you have to ask.' })]),
    ]));
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
      ? summary.map(([label, value]) => element('li', {}, [
        element('strong', { text: label + ': ' }), element('span', { text: value }),
      ]))
      : [element('li', { text: 'Nothing was changed. Static is running on its defaults.' })]));

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
  $('#body').replaceChildren(body());

  const back = $('#back');
  back.disabled = state.step === 0;

  const skip = $('#skip');
  skip.hidden = !state.canSkip;

  const next = $('#next');
  next.textContent = state.isLast ? 'Start browsing' : 'Continue';
  // The profile step is the one real question, so Continue waits for it.
  next.disabled = state.stepId === 'profile' && !state.chosen.profile;
}

async function step(channel) {
  try {
    state = await invoke(channel);
    render();
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

step('onboarding:state');

})();
