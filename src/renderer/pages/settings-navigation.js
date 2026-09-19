'use strict';
(function () {
const { $, element, icon, invoke, onState, platform } = window.page;
const categories = [
  ['start', 'Get started', 'home', 'Everything you need to feel at home.'],
  ['appearance', 'Appearance', 'palette', 'Make every detail feel like yours.'],
  ['content', 'Content', 'content', 'Set the stage for your next idea.'],
  ['privacy', 'Privacy & Security', 'shield', 'Choose how Static protects your browsing.'],
  ['ai', 'AI', 'sparkle', 'A little help for the things you do every day.'],
  ['search', 'Search', 'search', 'Find your way around the web.'],
  ['workspaces', 'Workspaces', 'grid', 'A place for every kind of work.'],
  ['extensions', 'Extensions', 'puzzle', 'Add the tools that work for you.'],
  ['passwords', 'Passwords', 'key', 'Manage your saved credentials.'],
  ['downloads', 'Downloads', 'download', 'Keep your files within reach.'],
  ['accessibility', 'Accessibility', 'accessibility', 'Make browsing more comfortable.'],
  ['system', 'System', 'gear', 'Keep an eye on performance.'],
  ['reset', 'Reset settings', 'reset', 'A fresh start for your preferences.'],
  ['about', 'About Static', 'info', 'A more intelligent web.'],
];
const sections = [...document.querySelectorAll('[data-section]')];
let current = categories.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : 'start';
for (const node of document.querySelectorAll('[data-icon]')) node.append(icon(node.dataset.icon, { size: 22 }));
for (const node of document.querySelectorAll('.search-key')) node.textContent = platform === 'darwin' ? 'Cmd+K' : 'Ctrl+K';

for (const [id, name, glyph] of categories) {
  const button = element('button', {
    type: 'button', class: 'settings-nav-item', 'data-category': id,
    onclick: () => select(id),
  }, [icon(glyph, { size: 21 }), element('span', { text: name })]);
  if (['passwords', 'reset', 'about'].includes(id)) button.classList.add('starts-group');
  $('#settings-nav').append(button);
}

function select(id, updateURL = true) {
  const category = categories.find(item => item[0] === id);
  if (!category) return;
  current = id;
  if (updateURL) history.replaceState(null, '', '#' + id);
  $('#settings-search').value = '';
  $('#settings-title').textContent = category[1];
  $('#settings-description').textContent = category[3];
  $('#settings-no-results').hidden = true;
  document.body.classList.remove('is-searching');
  for (const section of sections) {
    section.hidden = section.dataset.section !== id;
    for (const child of section.querySelectorAll('[hidden]')) child.hidden = false;
  }
  for (const button of document.querySelectorAll('[data-category]')) {
    const active = button.dataset.category === id;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('.settings-main').scrollTop = 0;
}

// Search the rendered controls rather than maintaining a second description
// list that can drift from the real settings. Nodes are filtered, not rebuilt,
// so a live app-state update cannot discard an in-progress edit.
$('#settings-search').addEventListener('input', () => {
  const words = $('#settings-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) { select(current); return; }
  const matches = text => words.every(word => text.toLowerCase().includes(word));
  document.body.classList.add('is-searching');
  $('#settings-title').textContent = 'Search settings';
  $('#settings-description').textContent = 'Matching controls from across your browser.';
  let count = 0;
  for (const section of sections) {
    const wholeSection = matches(section.getAttribute('aria-label'));
    let found = false;
    for (const child of section.children) {
      const fields = [...child.querySelectorAll('.field')];
      for (const field of fields) field.hidden = !wholeSection && !matches(field.textContent);
      const visible = wholeSection || (fields.length ? fields.some(field => !field.hidden) : matches(child.textContent));
      child.hidden = !visible;
      if (visible && child.tagName !== 'H2') found = true;
    }
    for (const title of section.querySelectorAll(':scope > h2')) title.hidden = title.nextElementSibling?.hidden !== false;
    section.hidden = !found;
    if (found) count++;
  }
  $('#settings-no-results').hidden = count > 0;
  for (const button of document.querySelectorAll('[data-category]')) {
    button.classList.remove('active');
    button.removeAttribute('aria-current');
  }
});

document.addEventListener('click', event => {
  const target = event.target.closest('[data-section-target], [data-open-page]');
  if (!target) return;
  if (target.dataset.sectionTarget) select(target.dataset.sectionTarget);
  else invoke('tabs:navigate', { input: target.dataset.openPage }).catch(showError);
});

document.addEventListener('keydown', event => {
  if ($('#reset-dialog').open) return;
  const mod = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault(); $('#settings-search').focus(); $('#settings-search').select();
  } else if (event.key === 'Escape' && $('#settings-search').value) {
    event.preventDefault(); select(current); $('#settings-search').focus();
  }
});
window.addEventListener('hashchange', () => select(location.hash.slice(1), false));

function showError(error) { $('#settings-status').textContent = error.message || String(error); }
let resetScope = null;
for (const button of document.querySelectorAll('[data-reset]')) button.addEventListener('click', () => {
  resetScope = button.dataset.reset;
  $('#reset-title').textContent = resetScope === 'all' ? 'Reset browser preferences?' : 'Reset appearance?';
  $('#reset-description').textContent = resetScope === 'all'
    ? 'Your theme, homepage, search engine, sidebar and new-tab layout will return to their defaults.'
    : 'Your theme, colors, typeface, spacing and sidebar will return to their defaults.';
  $('#reset-dialog').returnValue = 'cancel';
  $('#reset-dialog').showModal();
});
$('#reset-dialog').addEventListener('close', async () => {
  if ($('#reset-dialog').returnValue !== 'reset' || !resetScope) return;
  try {
    await invoke('settings:reset', { scope: resetScope });
    $('#settings-status').textContent = 'Preferences reset. Your browsing data has been kept.';
  } catch (error) { showError(error); }
  resetScope = null;
});
onState(state => {
  $('#ai-connection').textContent = state.ai?.available ? 'API key available' : 'API key not configured';
  $('#ai-connection').classList.toggle('on', !!state.ai?.available);
  $('#app-version').textContent = 'Version ' + (state.appInfo?.version || 'development');
  $('#chromium-version').textContent = state.appInfo?.chromium || '-';
  $('#electron-version').textContent = state.appInfo?.electron || '-';
});
select(current, false);
})();
