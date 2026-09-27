'use strict';
(function () {
const { $, element, icon, invoke, onState, platform } = window.page;
const categories = [
  ['start', 'Get started', 'home', 'Everything you need to feel at home.'],
  ['profiles', 'Profiles', 'user', 'Separate spaces for separate lives.'],
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
  $('#settings-jump').hidden = true;
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

/**
 * The words people actually type, mapped to where the answer lives.
 *
 * Controls are still found by their own visible text (and `data-keywords`);
 * this adds the vocabulary that never appears on a label - nobody's control
 * says "user selection" or "dark mode", but that is what gets typed.
 */
const TOPICS = [
  { terms: ['profile', 'user', 'user selection', 'account', 'person', 'people', 'switch user', 'picker', 'guest', 'pin', 'lock'], sections: ['profiles'] },
  { terms: ['theme', 'planet', 'dark', 'dark mode', 'light', 'light mode', 'colour', 'color', 'look', 'style', 'appearance', 'font', 'typeface', 'text size', 'zoom', 'density', 'accent', 'wallpaper', 'background'], sections: ['appearance'] },
  { terms: ['new tab', 'homepage', 'home page', 'widget', 'widgets', 'clock', 'shortcuts row', 'most visited', 'wallpaper', 'status strip'], sections: ['content', 'start'] },
  { terms: ['startup', 'start up', 'launch', 'on startup', 'restore', 'session', 'reopen', 'continue where'], sections: ['start', 'profiles'] },
  { terms: ['privacy', 'security', 'tracking', 'tracker', 'trackers', 'cookie', 'cookies', 'fingerprint', 'https', 'shield', 'shields', 'ad', 'ads', 'adblock', 'ad blocker', 'block', 'safe browsing', 'safety', 'malware', 'phishing', 'clear', 'clear data', 'cache', 'history', 'permissions'], sections: ['privacy'] },
  { terms: ['password', 'passwords', 'login', 'logins', 'credential', 'autofill', 'auto fill', 'fill', 'address', 'card', 'credit card', 'payment', 'upi', 'passkey'], sections: ['passwords'] },
  { terms: ['download', 'downloads', 'file', 'files', 'save location', 'folder'], sections: ['downloads'] },
  { terms: ['search', 'search engine', 'engine', 'google', 'brave search', 'bing', 'duckduckgo', 'suggestion', 'suggestions', 'address bar', 'omnibox'], sections: ['search'] },
  { terms: ['ai', 'gemini', 'assistant', 'chat', 'ask', 'summarise', 'summarize'], sections: ['ai'] },
  { terms: ['performance', 'memory', 'ram', 'cpu', 'speed', 'fast', 'slow', 'sleep', 'sleeping tabs', 'resources', 'battery', 'gpu', 'game mode', 'system', 'usage'], sections: ['system'] },
  { terms: ['tab', 'tabs', 'tab bar', 'vertical tabs', 'horizontal tabs', 'sidebar', 'workspace', 'workspaces', 'focus', 'split'], sections: ['workspaces'] },
  { terms: ['keyboard', 'shortcut', 'shortcuts', 'hotkey', 'hotkeys', 'keys', 'accessibility', 'motion', 'animation', 'reduce motion'], sections: ['accessibility'] },
  { terms: ['extension', 'extensions', 'add-on', 'addon', 'plugin', 'plugins', 'web store', 'chrome web store'], sections: ['extensions'] },
  { terms: ['reset', 'defaults', 'restore defaults', 'factory'], sections: ['reset'] },
  { terms: ['about', 'version', 'update', 'updates', 'licence', 'license', 'licences', 'credits', 'chromium', 'electron', 'legal', 'privacy policy', 'terms'], sections: ['about'] },
];

/** Places outside this page that a search should still reach. */
const DESTINATIONS = [
  { title: 'Password manager', hint: 'See, edit and delete saved logins', page: 'browser://passwords', terms: ['password', 'login', 'credential', 'autofill', 'vault'] },
  { title: 'Shields dashboard', hint: 'Ads and trackers blocked, per site', page: 'browser://shields', terms: ['shield', 'ad', 'ads', 'adblock', 'blocked', 'tracker', 'statistics', 'stats'] },
  { title: 'History', hint: 'Every page you have visited', page: 'browser://history', terms: ['history', 'visited', 'recent'] },
  { title: 'Downloads', hint: 'Files you have downloaded', page: 'browser://downloads', terms: ['download', 'file'] },
  { title: 'Bookmarks', hint: 'Pages you have saved', page: 'browser://bookmarks', terms: ['bookmark', 'favourite', 'favorite', 'saved pages'] },
  { title: 'Extensions', hint: 'Installed extensions and the Chrome Web Store', page: 'browser://extensions', terms: ['extension', 'addon', 'add-on', 'plugin'] },
  { title: 'Profile picker', hint: 'Choose, create or lock a profile', page: 'browser://profiles', terms: ['profile', 'user', 'switch', 'picker', 'account'] },
  { title: 'New tab page', hint: 'Widgets, wallpaper and layout', page: 'browser://newtab', terms: ['widget', 'wallpaper', 'new tab', 'homepage', 'clock'] },
  { title: 'AI chat', hint: 'Your conversations with the assistant', page: 'browser://ai', terms: ['ai', 'gemini', 'chat', 'assistant'] },
  { title: 'Resources and Game Mode', hint: 'Memory, CPU and sleeping tabs', page: 'browser://resources', terms: ['performance', 'memory', 'ram', 'cpu', 'game', 'resources'] },
  { title: 'Licences and credits', hint: 'Open-source software Static is built on', page: 'browser://licences', terms: ['licence', 'license', 'credits', 'open source', 'legal'] },
];

function topicSections(query, words) {
  const hits = new Set();
  for (const topic of TOPICS) {
    const hit = topic.terms.some(term =>
      term === query || (query.length >= 3 && term.startsWith(query)) ||
      words.some(word => word.length >= 2 && (term === word || (word.length >= 3 && term.startsWith(word)))));
    if (hit) topic.sections.forEach(id => hits.add(id));
  }
  return hits;
}

function renderDestinations(query, words) {
  const host = $('#settings-jump');
  const found = DESTINATIONS.filter(item =>
    words.every(word => item.title.toLowerCase().includes(word) ||
      item.terms.some(term => term.startsWith(word) || word.startsWith(term))));
  host.hidden = !found.length;
  host.replaceChildren(...found.length ? [
    element('h2', { text: 'Jump to' }),
    element('div', { class: 'card' }, found.map(item => element('div', { class: 'field' }, [
      element('div', {}, [element('label', { text: item.title }), element('div', { class: 'hint', text: item.hint })]),
      element('div', { class: 'control right' }, [element('button', { type: 'button', 'data-open-page': item.page, text: 'Open' })]),
    ]))),
  ] : []);
  return found.length;
}

// Search the rendered controls rather than maintaining a second description
// list that can drift from the real settings. Nodes are filtered, not rebuilt,
// so a live app-state update cannot discard an in-progress edit.
$('#settings-search').addEventListener('input', () => {
  const query = $('#settings-search').value.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  if (!words.length) { $('#settings-jump').hidden = true; select(current); return; }
  const matches = text => words.every(word => text.toLowerCase().includes(word));
  const topical = topicSections(query, words);
  document.body.classList.add('is-searching');
  $('#settings-title').textContent = 'Search settings';
  $('#settings-description').textContent = 'Matching controls from across your browser.';
  let count = 0;
  for (const section of sections) {
    const label = section.getAttribute('aria-label') + ' ' + (section.dataset.keywords || '');
    const wholeSection = matches(label) || topical.has(section.dataset.section);
    let found = false;
    for (const child of section.children) {
      const fields = [...child.querySelectorAll('.field')];
      for (const field of fields) {
        field.hidden = !wholeSection && !matches(field.textContent + ' ' + (field.dataset.keywords || ''));
      }
      const visible = wholeSection || (fields.length ? fields.some(field => !field.hidden) : matches(child.textContent));
      child.hidden = !visible;
      if (visible && child.tagName !== 'H2') found = true;
    }
    for (const title of section.querySelectorAll(':scope > h2')) title.hidden = title.nextElementSibling?.hidden !== false;
    section.hidden = !found;
    if (found) count++;
  }
  count += renderDestinations(query, words);
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
