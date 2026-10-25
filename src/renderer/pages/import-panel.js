'use strict';
(function () {
/**
 * "Bring your stuff": import from another browser. Shared by the first-run
 * flow and Settings.
 *
 * Two ways in:
 *   - A browser on this computer (Chrome, Edge, Brave, Opera, Vivaldi,
 *     Firefox, and Safari on a Mac): bookmarks, history and homepage.
 *   - A file a browser exported: Safari's export zip (bookmarks, history and
 *     passwords), or any browser's bookmarks .html. Works on any computer and
 *     needs no permissions - the way to bring Safari data to a PC.
 *
 * Safari on a Mac is readable only once macOS gives static Full Disk Access.
 * Until then its tile says so and offers the settings page, and the file
 * route is right there as the alternative.
 */

// How to export passwords from each browser, and the page that does it.
// Opening that page in static lands the person one click from Export.
const PASSWORD_EXPORTS = {
  chrome: { page: 'https://passwords.google.com/options', steps: 'In Chrome, open Settings > Autofill and passwords > Google Password Manager > Settings > Export passwords, and save the CSV file.' },
  edge: { page: null, steps: 'In Edge, open Settings > Profiles > Passwords > the “…” menu > Export passwords, and save the CSV file.' },
  brave: { page: null, steps: 'In Brave, open brave://password-manager/settings, choose Export passwords, and save the CSV file.' },
  opera: { page: null, steps: 'In Opera, open Settings > Advanced > Privacy & security > Passwords, use the “…” menu > Export passwords, and save the CSV file.' },
  vivaldi: { page: null, steps: 'In Vivaldi, open Settings > Passwords, use Export, and save the CSV file.' },
  firefox: { page: null, steps: 'In Firefox, open about:logins, use the “…” menu > Export Logins, and save the CSV file.' },
};

function build({ element, invoke, onDone }) {
  const box = element('div', { class: 'import-panel' });
  const choice = { browser: null, profile: null, bookmarks: true, history: true, homepage: false };
  const fileChoice = { bookmarks: true, history: true, passwords: true };
  // The chosen browser's name, kept apart from `choice` because that is
  // exactly what is sent to main.
  let pickedName = '';

  const toggle = (state, key, label, hint) => {
    const b = element('button', { type: 'button', role: 'switch', class: 'import-switch', 'aria-checked': String(state[key]) }, [
      element('span', { class: 'import-knob', 'aria-hidden': 'true' }),
      element('span', {}, [element('strong', { text: label }), element('small', { text: hint })]),
    ]);
    b.addEventListener('click', () => { state[key] = !state[key]; b.setAttribute('aria-checked', String(state[key])); });
    return b;
  };
  const clean = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

  const status = element('p', { class: 'import-status', role: 'status' });
  const go = element('button', { type: 'button', class: 'import-go', text: 'Import', disabled: '' });
  // Shown only while a browser that macOS has not let static read is picked.
  const access = element('div', { class: 'import-access', hidden: '' }, [
    element('p', { class: 'import-note', text: 'macOS keeps Safari’s data private. To read it, turn on static in System Settings > Privacy & Security > Full Disk Access, then quit and reopen static. Or export from Safari instead (File > Export Browsing Data to File) and choose that file below.' }),
    element('div', { class: 'import-actions' }, [
      element('button', { type: 'button', class: 'import-secondary', text: 'Open Full Disk Access settings', onclick: () => invoke('import:privacy-settings') }),
    ]),
  ]);

  /* ---- from a file ---- */
  const fileStatus = element('p', { class: 'import-status', role: 'status' });
  const fileGo = element('button', { type: 'button', class: 'import-secondary', text: 'Choose a file…' });
  const fromFile = element('section', { class: 'import-file' }, [
    element('div', {}, [
      element('strong', { text: 'Or import from a file' }),
      element('small', { text: 'Safari’s export (.zip) brings bookmarks, history and passwords. A bookmarks file (.html) from Chrome, Edge, Brave, Firefox or Safari brings bookmarks.' }),
    ]),
    element('div', { class: 'import-options' }, [
      toggle(fileChoice, 'bookmarks', 'Bookmarks', 'With their folders'),
      toggle(fileChoice, 'history', 'History', 'From a Safari export'),
      toggle(fileChoice, 'passwords', 'Passwords', 'From a Safari export, into your password vault'),
    ]),
    element('div', { class: 'import-actions' }, [fileGo]),
    fileStatus,
  ]);
  fileGo.addEventListener('click', async () => {
    fileGo.disabled = true;
    fileStatus.textContent = 'Choose the file in the window that opens…';
    try {
      const result = await invoke('import:file', fileChoice);
      if (result?.canceled) { fileStatus.textContent = ''; return; }
      const parts = [];
      if (fileChoice.bookmarks) parts.push(result.bookmarks + ' bookmarks');
      if (fileChoice.history && result.history) parts.push(result.history + ' history entries');
      if (fileChoice.passwords && result.passwords) parts.push(result.passwords + ' passwords');
      fileStatus.textContent = 'Imported ' + (parts.join(', ') || 'nothing new') + ' from ' + result.from + '.' +
        (result.passwordsError ? ' Passwords: ' + result.passwordsError : '');
      onDone?.({ ...result, from: result.from });
    } catch (error) {
      fileStatus.textContent = clean(error);
    } finally {
      fileGo.disabled = false;
    }
  });

  invoke('import:detect').then((browsers) => {
    if (!browsers.length) {
      box.replaceChildren(
        element('p', { class: 'import-empty', text: 'No other browsers were found on this computer.' }),
        fromFile,
      );
      return;
    }
    const profileSelect = element('select', { class: 'import-profile', 'aria-label': 'Profile' });
    const homepageSwitch = toggle(choice, 'homepage', 'Homepage', 'If you set one there');

    /* ---- passwords: a guided, two-click export-then-import ---- */
    const pwSteps = element('small', { class: 'import-pw-steps' });
    const pwStatus = element('p', { class: 'import-status', role: 'status' });
    const pwOpen = element('button', { type: 'button', class: 'import-secondary', text: 'Open the export page' });
    const pwImport = element('button', { type: 'button', class: 'import-secondary', text: 'Import the CSV file…' });
    pwOpen.addEventListener('click', () => {
      const info = PASSWORD_EXPORTS[choice.browser];
      if (info?.page) invoke('tabs:new', { url: info.page });
    });
    pwImport.addEventListener('click', async () => {
      pwImport.disabled = true;
      pwStatus.textContent = 'Choose the CSV file you exported…';
      try {
        const result = await invoke('passwords:import');
        if (result?.canceled) { pwStatus.textContent = ''; return; }
        pwStatus.textContent = result?.ok
          ? 'Imported ' + result.added + ' password' + (result.added === 1 ? '' : 's') + (result.skipped ? ', skipped ' + result.skipped : '') + '. Delete the CSV file now - it is not encrypted.'
          : (clean(result?.error) || 'That file could not be imported.');
      } catch (error) { pwStatus.textContent = clean(error); }
      finally { pwImport.disabled = false; }
    });
    const passwordsStep = element('details', { class: 'import-passwords' }, [
      element('summary', {}, [element('strong', { text: 'Also bring your passwords' }), element('span', { class: 'import-pw-caret', 'aria-hidden': 'true' })]),
      element('p', { class: 'import-note', text: 'Passwords are locked to the browser that saved them, so static cannot read them directly. Export them once, then import that file - it takes two clicks:' }),
      pwSteps,
      element('div', { class: 'import-actions' }, [pwOpen, pwImport]),
      pwStatus,
    ]);

    const pickBrowser = (browser, tile) => {
      choice.browser = browser.id;
      pickedName = browser.name;
      for (const t of tiles.children) t.setAttribute('aria-checked', String(t === tile));
      profileSelect.replaceChildren(...browser.profiles.map((p) => element('option', { value: p.id, text: p.name })));
      choice.profile = browser.profiles[0].id;
      profileSelect.hidden = browser.profiles.length < 2;
      // Safari keeps no homepage where static can read it.
      homepageSwitch.hidden = browser.kind === 'safari';
      access.hidden = !browser.needsAccess;
      go.disabled = !!browser.needsAccess;
      go.textContent = 'Import from ' + browser.name;
      status.textContent = '';
      // Safari's passwords come in its export zip (the file route), so the
      // step is for the Chromium browsers and Firefox only.
      const info = PASSWORD_EXPORTS[browser.id];
      passwordsStep.hidden = !info;
      if (info) {
        pwSteps.textContent = info.steps;
        pwOpen.hidden = !info.page;
        pwStatus.textContent = '';
        passwordsStep.open = false;
      }
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
      tiles, profileSelect, access,
      element('div', { class: 'import-options' }, [
        toggle(choice, 'bookmarks', 'Bookmarks', 'With their folders'),
        toggle(choice, 'history', 'History', 'The last 5,000 pages you visited'),
        homepageSwitch,
      ]),
      passwordsStep,
      element('div', { class: 'import-actions' }, [go]),
      status,
      fromFile,
    );
    if (browsers.length === 1) pickBrowser(browsers[0], tiles.firstChild);
  }).catch((error) => { box.replaceChildren(element('p', { class: 'import-empty', text: clean(error) }), fromFile); });

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
      onDone?.({ ...result, from: pickedName });
    } catch (error) {
      const message = clean(error);
      // Safari's permission message already says what to do; for the others
      // a locked database usually means the browser is still open.
      status.textContent = /Full Disk Access/.test(message) ? message : message + ' If that browser is open, close it and try again.';
    }
    go.disabled = false;
  });
  return box;
}

window.importPanel = { build };
})();
