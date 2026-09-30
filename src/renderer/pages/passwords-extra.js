'use strict';
(function () {
/**
 * The rest of Passwords: password health and leak check, import and export,
 * how Static signs you in, and the sites where it has been told not to.
 *
 * Addresses, cards, UPI IDs, documents and custom fields have their own page,
 * browser://autofill.
 *
 * Drawn into one persistent host that passwords.js places at the end of its
 * page, so saving a form here never loses what is open elsewhere.
 */
const { invoke, element, icon, onState } = window.page;

const host = element('div', { class: 'pw-extras' });

let state = { prefs: {}, never: [], noAuto: [], available: true };
let health = null;
let leaks = null;
let message = '';

function card(title, glyph, body) {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [icon(glyph, { size: 15 }), element('span', { class: 'panel-card-title', text: title })]),
    ...body,
  ]);
}

function toggle(label, hint, key) {
  const on = !!state.prefs[key];
  const button = element('button', { type: 'button', role: 'switch', class: 'pw-toggle', 'aria-checked': String(on) }, [
    element('span', { class: 'pw-toggle-text' }, [element('strong', { text: label }), element('span', { text: hint })]),
    element('span', { class: 'pw-switch', 'aria-hidden': 'true' }),
  ]);
  button.addEventListener('click', async () => {
    state.prefs = await invoke('autofill:prefs', { [key]: !on });
    draw();
  });
  return button;
}

/* ---- health and leaks ------------------------------------------------------ */

function healthCard() {
  const h = health || { total: 0, weak: [], reused: [], strong: 0 };
  const stat = (value, label, tone) => element('div', { class: 'pw-stat ' + tone }, [element('strong', { text: String(value) }), element('span', { text: label })]);
  const check = element('button', { type: 'button', class: 'pill selected', text: leaks ? 'Check again' : 'Check for leaks' });
  check.addEventListener('click', async () => {
    check.disabled = true;
    check.textContent = 'Checking…';
    try { leaks = await invoke('passwords:breach-check'); } catch (error) { leaks = { error: error.message }; }
    draw();
  });
  return card('Password health', 'lock', [
    element('div', { class: 'pw-stats' }, [
      stat(h.strong, 'strong', 'good'), stat(new Set(h.weak).size, 'weak', h.weak.length ? 'warn' : 'good'),
      stat(new Set(h.reused).size, 'reused', h.reused.length ? 'warn' : 'good'),
      stat(leaks?.breached ? leaks.breached.length : '–', 'found in leaks', leaks?.breached?.length ? 'bad' : 'good'),
    ]),
    element('p', { class: 'muted', text: 'Weak means short or common; reused means the same password on more than one site. Change those first.' }),
    element('div', { class: 'pw-row' }, [check,
      element('span', { class: 'muted', text: 'Checks Have I Been Pwned. Only the first 5 characters of a scrambled hash of each password are sent - never the password, and not enough to work it out.' })]),
    leaks?.error ? element('p', { class: 'pw-error', text: leaks.error }) : null,
    ...(leaks?.breached || []).map((b) => element('div', { class: 'pw-leak' }, [
      element('strong', { text: b.origin.replace(/^https?:\/\//, '') }),
      element('span', { text: (b.username || 'no username') + ' · seen in ' + b.count.toLocaleString() + ' breaches. Change this password.' }),
    ])),
    leaks && !leaks.error && !leaks.breached.length ? element('p', { class: 'pw-ok', text: 'None of your ' + leaks.checked + ' passwords appear in known breaches.' }) : null,
  ].filter(Boolean));
}

function transferCard() {
  let armed = null;
  const exportButton = element('button', { type: 'button', class: 'pill', text: 'Export…' });
  exportButton.addEventListener('click', async () => {
    if (!armed) {
      exportButton.textContent = 'The file will not be encrypted - click again';
      armed = setTimeout(() => { armed = null; exportButton.textContent = 'Export…'; }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    const result = await invoke('passwords:export');
    message = result?.saved ? 'Exported to ' + result.saved + '. Delete it once you have used it.' : '';
    draw();
  });
  const importButton = element('button', { type: 'button', class: 'pill selected', text: 'Import from a file…' });
  importButton.addEventListener('click', async () => {
    const result = await invoke('passwords:import');
    if (result?.canceled) return;
    message = result?.ok ? 'Imported ' + result.added + ' passwords' + (result.skipped ? ', skipped ' + result.skipped : '') + '.' : (result?.error || 'Import failed.');
    await load();
    window.passwordPage?.refresh();
  });
  return card('Import and export', 'import', [
    element('p', { class: 'muted', text: 'Bring passwords from Chrome, Edge, Brave, Opera, Vivaldi or Firefox: in that browser, export your passwords to a CSV file, then import it here. Delete the file afterwards.' }),
    element('div', { class: 'pw-row' }, [importButton, exportButton]),
    message ? element('p', { class: 'pw-ok', text: message }) : null,
  ].filter(Boolean));
}

/* ---- signing in ------------------------------------------------------------- */

function signInCard() {
  return card('Signing in', 'key', [
    element('div', { class: 'pw-toggles' }, [
      toggle('Offer to save passwords', 'After you sign in somewhere new', 'offerPasswords'),
      toggle('Show saved logins on sign-in pages', 'A card under the sign-in box: your saved account, one click to fill', 'loginHints'),
      toggle('Sign in automatically', 'When a site has one saved login, Static fills it and signs in - at most once in 10 minutes per site', 'autoSignIn'),
      toggle('Save and use passkeys', 'Sites that offer passkeys keep them in Static, unlocked with your face, fingerprint or PIN', 'passkeys'),
    ]),
    element('p', { class: 'muted' }, [
      'Addresses, cards, UPI IDs, documents and custom fields are in ',
      element('a', { href: '#', text: 'Autofill', onclick: (event) => { event.preventDefault(); invoke('tabs:navigate', { input: 'browser://autofill' }); } }),
      '.',
    ]),
  ]);
}

function siteList(title, origins, channel) {
  if (!origins?.length) return null;
  return card(title, 'close', origins.map((origin) => element('div', { class: 'pw-item' }, [
    element('div', {}, [element('strong', { text: origin.replace(/^https?:\/\//, '') })]),
    element('button', { type: 'button', class: 'pill', text: 'Remove', onclick: async () => { await invoke(channel, { origin }); await load(); } }),
  ])));
}

function draw() {
  host.replaceChildren(...[
    health?.locked ? null : healthCard(),
    signInCard(),
    transferCard(),
    siteList('Never save passwords for', state.never, 'autofill:never-remove'),
    siteList('Never sign in automatically on', state.noAuto, 'autofill:no-auto-remove'),
  ].filter(Boolean));
}

async function load() {
  try {
    const [s, h] = await Promise.all([invoke('autofill:state'), invoke('passwords:health')]);
    state = s;
    health = h;
  } catch (error) { message = error.message; }
  draw();
}

window.passwordExtras = { host, reload: load };
onState(() => {});
load();
})();
