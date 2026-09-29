'use strict';
(function () {
/**
 * "Bring your stuff": import bookmarks, history and homepage from another
 * browser on this computer. Shared by the first-run flow and Settings.
 */

function build({ element, invoke, onDone }) {
  const box = element('div', { class: 'import-panel' });
  const choice = { browser: null, profile: null, bookmarks: true, history: true, homepage: false };

  const toggle = (key, label, hint) => {
    const b = element('button', { type: 'button', role: 'switch', class: 'import-switch', 'aria-checked': String(choice[key]) }, [
      element('span', { class: 'import-knob', 'aria-hidden': 'true' }),
      element('span', {}, [element('strong', { text: label }), element('small', { text: hint })]),
    ]);
    b.addEventListener('click', () => { choice[key] = !choice[key]; b.setAttribute('aria-checked', String(choice[key])); });
    return b;
  };

  const status = element('p', { class: 'import-status', role: 'status' });
  const go = element('button', { type: 'button', class: 'import-go', text: 'Import', disabled: '' });

  invoke('import:detect').then((browsers) => {
    if (!browsers.length) {
      box.replaceChildren(element('p', { class: 'import-empty', text: 'No other browsers were found on this computer. You can always import later from Settings.' }));
      return;
    }
    const profileSelect = element('select', { class: 'import-profile', 'aria-label': 'Profile' });
    const pickBrowser = (browser, tile) => {
      choice.browser = browser.id;
      for (const t of tiles.children) t.setAttribute('aria-checked', String(t === tile));
      profileSelect.replaceChildren(...browser.profiles.map((p) => element('option', { value: p.id, text: p.name })));
      choice.profile = browser.profiles[0].id;
      profileSelect.hidden = browser.profiles.length < 2;
      go.disabled = false;
      go.textContent = 'Import from ' + browser.name;
    };
    const tiles = element('div', { class: 'import-browsers', role: 'radiogroup' }, browsers.map((browser) => {
      const tile = element('button', { type: 'button', role: 'radio', class: 'import-browser', 'data-id': browser.id, 'aria-checked': 'false' }, [
        element('span', { class: 'import-badge ' + browser.id, text: browser.name.split(' ').pop()[0] }),
        element('span', { text: browser.name }),
      ]);
      tile.addEventListener('click', () => pickBrowser(browser, tile));
      return tile;
    }));
    profileSelect.addEventListener('change', () => { choice.profile = profileSelect.value; });
    profileSelect.hidden = true;
    box.replaceChildren(
      tiles, profileSelect,
      element('div', { class: 'import-options' }, [
        toggle('bookmarks', 'Bookmarks', 'With their folders'),
        toggle('history', 'History', 'The last 5,000 pages you visited'),
        toggle('homepage', 'Homepage', 'If you set one there'),
      ]),
      element('p', { class: 'import-note', text: 'Passwords are locked to the browser that saved them. To bring them too, export them to a file from that browser, then use Passwords → Import.' }),
      element('div', { class: 'import-actions' }, [go]),
      status,
    );
    if (browsers.length === 1) pickBrowser(browsers[0], tiles.firstChild);
  }).catch((error) => { box.replaceChildren(element('p', { class: 'import-empty', text: error.message })); });

  go.addEventListener('click', async () => {
    go.disabled = true;
    status.textContent = 'Importing…';
    try {
      const result = await invoke('import:run', choice);
      const parts = [];
      if (choice.bookmarks) parts.push(result.bookmarks + ' bookmarks');
      if (choice.history) parts.push(result.history + ' history entries');
      if (result.homepage) parts.push('your homepage');
      status.textContent = 'Imported ' + (parts.join(', ') || 'nothing new') + '.';
      onDone?.(result);
    } catch (error) {
      status.textContent = String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') +
        ' If that browser is open, close it and try again.';
    }
    go.disabled = false;
  });
  return box;
}

window.importPanel = { build };
})();
