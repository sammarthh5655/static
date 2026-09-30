'use strict';
(function () {
/**
 * The rest of Passwords & autofill: password health and leak check, import
 * and export, and everything autofill keeps - addresses, cards, UPI IDs and
 * documents - with the switches that govern it.
 *
 * Drawn into one persistent host that passwords.js places at the end of its
 * page, so saving a form here never loses what is open elsewhere.
 */
const { invoke, element, icon, onState } = window.page;

const host = element('div', { class: 'pw-extras', id: 'autofill' });

const FORMS = {
  address: {
    title: 'Addresses and contact details', noun: 'address', glyph: 'user',
    fields: [
      ['label', 'Label', 'Home, Work…'], ['purpose', 'Use for', 'select:both=Shipping and billing,shipping=Shipping,billing=Billing'],
      ['name', 'Full name'], ['email', 'Email', '', 'email'], ['tel', 'Phone', '', 'tel'], ['organization', 'Company'],
      ['gstin', 'GSTIN'], ['address-line1', 'Address'], ['address-line2', 'Landmark / area'],
      ['address-level2', 'City'], ['address-level1', 'State'], ['postal-code', 'PIN / ZIP code'], ['country', 'Country'],
    ],
  },
  card: {
    title: 'Payment cards', noun: 'card', glyph: 'key',
    note: 'Card numbers are encrypted by your operating system. The security code (CVV) is never stored; you type it each time.',
    fields: [
      ['label', 'Label', 'Personal, Work…'], ['cardKind', 'Type', 'select:credit=Credit card,debit=Debit card'],
      ['cc-name', 'Name on card'], ['cc-number', 'Card number', '', 'text', 'cc-number'],
      ['cc-exp-month', 'Expiry month', 'MM'], ['cc-exp-year', 'Expiry year', 'YYYY'],
    ],
  },
  upi: {
    title: 'UPI IDs', noun: 'UPI ID', glyph: 'key',
    fields: [['label', 'Label', 'Main, Savings…'], ['upi', 'UPI ID', 'name@bank']],
  },
  document: {
    title: 'IDs and documents', noun: 'document', glyph: 'doc',
    note: 'Filled into forms that ask for them, such as a vehicle number on an insurance site.',
    fields: [
      ['docType', 'Kind', 'select:passport=Passport,driving-licence=Driving licence,vehicle-registration=Vehicle registration (number plate),national-id=National ID (PAN, Aadhaar…),other=Other'],
      ['label', 'Label'], ['number', 'Number'], ['holder', 'Name on it'], ['expires', 'Expires', 'MM/YYYY'],
    ],
  },
  custom: {
    title: 'Custom fields', noun: 'custom field', glyph: 'doc',
    note: 'Anything else a form asks for - an employee ID, a library card, a frequent-flyer number. Static offers it in any box whose label or name matches.',
    fields: [
      ['label', 'Name', 'Employee ID, Library card…'], ['value', 'Value'],
      ['match', 'Also fill fields named', 'staff no, badge number (optional, comma-separated)'],
    ],
  },
};

let state = { prefs: {}, never: [], counts: {}, available: true };
let lists = {};
let health = null;
let leaks = null;
let tab = 'address';
let editing = null;
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
  });
  return card('Import and export', 'import', [
    element('p', { class: 'muted', text: 'Bring passwords from Chrome, Edge, Brave, Opera, Vivaldi or Firefox: in that browser, export your passwords to a CSV file, then import it here. Delete the file afterwards.' }),
    element('div', { class: 'pw-row' }, [importButton, exportButton]),
    message ? element('p', { class: 'pw-ok', text: message }) : null,
  ].filter(Boolean));
}

/* ---- autofill ------------------------------------------------------------- */

function formFor(kind, values = {}) {
  const spec = FORMS[kind];
  const inputs = {};
  const grid = element('div', { class: 'pw-form' }, spec.fields.map(([key, label, hint = '', type = 'text', autocomplete]) => {
    let control;
    if (hint.startsWith('select:')) {
      control = element('select', {}, hint.slice(7).split(',').map((pair) => {
        const [value, text] = pair.split('=');
        return element('option', { value, text });
      }));
      if (values[key]) control.value = values[key];
    } else {
      control = element('input', { type, placeholder: hint, autocomplete: autocomplete || 'off', value: values[key] || '' });
    }
    inputs[key] = control;
    return element('label', { class: 'pw-field' }, [element('span', { text: label }), control]);
  }));
  const error = element('p', { class: 'pw-error' });
  const save = element('button', { type: 'button', class: 'pill selected', text: editing?.id ? 'Save changes' : 'Save ' + spec.noun });
  save.addEventListener('click', async () => {
    const fields = Object.fromEntries(Object.entries(inputs).map(([key, el]) => [key, el.value]));
    try {
      await invoke('autofill:put', { kind, fields, id: editing?.id });
      editing = null;
      await load();
    } catch (e) { error.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  });
  const cancel = element('button', { type: 'button', class: 'pill', text: 'Cancel', onclick: () => { editing = null; draw(); } });
  return element('div', { class: 'pw-editor' }, [grid, error, element('div', { class: 'pw-row' }, [save, cancel])]);
}

function autofillCard() {
  const spec = FORMS[tab];
  const tabs = element('div', { class: 'pw-tabs', role: 'tablist' }, Object.entries(FORMS).map(([kind, f]) => {
    const b = element('button', { type: 'button', role: 'tab', class: 'pw-tab', 'aria-selected': String(kind === tab) }, [
      element('span', { text: f.title }), element('em', { text: String(state.counts?.[kind] || 0) }),
    ]);
    b.addEventListener('click', () => { tab = kind; editing = null; draw(); });
    return b;
  }));
  const rows = (lists[tab] || []).map((item) => element('div', { class: 'pw-item' }, [
    element('div', {}, [element('strong', { text: item.label || item.summary }), element('span', { text: item.label ? item.summary : (item.docType || '') })]),
    element('button', { type: 'button', class: 'pill', text: 'Edit', onclick: async () => {
      const full = await invoke('autofill:values', { id: item.id });
      editing = { id: item.id, values: full?.fields || {} };
      draw();
    } }),
    element('button', { type: 'button', class: 'pill danger', text: 'Delete', onclick: async () => { await invoke('autofill:remove', { id: item.id }); await load(); } }),
  ]));
  return card('Autofill', 'user', [
    element('div', { class: 'pw-toggles' }, [
      toggle('Offer to save passwords', 'After you sign in somewhere new', 'offerPasswords'),
      toggle('Sign in automatically', 'When a site has one saved login, Static fills it and signs in - at most once in 10 minutes per site', 'autoSignIn'),
      toggle('Save and use passkeys', 'Sites that offer passkeys keep them in Static, unlocked with your face, fingerprint or PIN', 'passkeys'),
      toggle('Fill addresses, UPI, IDs and custom fields', 'Suggested under the field; nothing is filled until you pick', 'fillAddresses'),
      toggle('Fill payment cards', 'Never the security code', 'fillCards'),
    ]),
    tabs,
    spec.note ? element('p', { class: 'muted', text: spec.note }) : null,
    ...(rows.length ? rows : [element('p', { class: 'muted', text: 'Nothing saved yet. Static offers to save these when you fill in a form, or add one here.' })]),
    editing
      ? formFor(tab, editing.values)
      : element('button', { type: 'button', class: 'pw-add', text: '+ Add ' + spec.noun, onclick: () => { editing = { values: {} }; draw(); } }),
  ].filter(Boolean));
}

function neverCard() {
  if (!state.never?.length) return null;
  return card('Never save passwords for', 'close', state.never.map((origin) => element('div', { class: 'pw-item' }, [
    element('div', {}, [element('strong', { text: origin.replace(/^https?:\/\//, '') })]),
    element('button', { type: 'button', class: 'pill', text: 'Remove', onclick: async () => { await invoke('autofill:never-remove', { origin }); await load(); } }),
  ])));
}

function noAutoCard() {
  if (!state.noAuto?.length) return null;
  return card('Never sign in automatically on', 'close', state.noAuto.map((origin) => element('div', { class: 'pw-item' }, [
    element('div', {}, [element('strong', { text: origin.replace(/^https?:\/\//, '') })]),
    element('button', { type: 'button', class: 'pill', text: 'Remove', onclick: async () => { await invoke('autofill:no-auto-remove', { origin }); await load(); } }),
  ])));
}

function draw() {
  if (!state.available) {
    host.replaceChildren(card('Autofill', 'user', [element('p', { class: 'pw-error', text: 'Your system has no secure storage, so Static will not store addresses or cards here.' })]));
    return;
  }
  host.replaceChildren(...[health?.locked ? null : healthCard(), transferCard(), autofillCard(), neverCard(), noAutoCard()].filter(Boolean));
}

async function load() {
  try {
    const [s, h, ...all] = await Promise.all([
      invoke('autofill:state'), invoke('passwords:health'),
      ...Object.keys(FORMS).map((kind) => invoke('autofill:list', { kind })),
    ]);
    state = s;
    health = h;
    Object.keys(FORMS).forEach((kind, i) => { lists[kind] = all[i]; });
  } catch (error) { message = error.message; }
  draw();
  if (location.hash === '#autofill') host.scrollIntoView({ block: 'start' });
}

window.passwordExtras = { host, reload: load };
onState(() => {});
load();
})();
