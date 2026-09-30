'use strict';
(function () {
/**
 * browser://autofill - what Static fills into forms that are not sign-ins:
 * addresses and contact details, payment cards, UPI IDs, IDs and documents,
 * and custom fields.
 *
 * Everything is encrypted by the operating system in main. This page gets
 * masked summaries for its lists (a card is only ever its last four digits
 * here) and the full values of one entry only when it is opened for editing.
 * A card's security code is never stored at all.
 */
const { invoke, onState, element, icon } = window.page;

const FORMS = {
  address: {
    title: 'Addresses', noun: 'address', glyph: 'home',
    note: 'Your name, phone, email and address, filled into delivery and billing forms together.',
    fields: [
      ['label', 'Label', 'Home, Work…'], ['purpose', 'Use for', 'select:both=Shipping and billing,shipping=Shipping,billing=Billing'],
      ['name', 'Full name'], ['email', 'Email', '', 'email'], ['tel', 'Phone', '', 'tel'], ['organization', 'Company'],
      ['gstin', 'GSTIN'], ['address-line1', 'Address'], ['address-line2', 'Landmark / area'],
      ['address-level2', 'City'], ['address-level1', 'State'], ['postal-code', 'PIN / ZIP code'], ['country', 'Country'],
    ],
  },
  card: {
    title: 'Payment cards', noun: 'card', glyph: 'key',
    note: 'Card numbers are encrypted by your operating system. The security code (CVV) is never stored - you type it each time.',
    fields: [
      ['label', 'Label', 'Personal, Work…'], ['cardKind', 'Type', 'select:credit=Credit card,debit=Debit card'],
      ['cc-name', 'Name on card'], ['cc-number', 'Card number', '', 'text', 'cc-number'],
      ['cc-exp-month', 'Expiry month', 'MM'], ['cc-exp-year', 'Expiry year', 'YYYY'],
    ],
  },
  upi: {
    title: 'UPI IDs', noun: 'UPI ID', glyph: 'import',
    note: 'Filled into the UPI box at checkout.',
    fields: [['label', 'Label', 'Main, Savings…'], ['upi', 'UPI ID', 'name@bank']],
  },
  document: {
    title: 'IDs & documents', noun: 'document', glyph: 'doc',
    note: 'Filled into forms that ask for them, such as a vehicle number on an insurance site.',
    fields: [
      ['docType', 'Kind', 'select:passport=Passport,driving-licence=Driving licence,vehicle-registration=Vehicle registration (number plate),national-id=National ID (PAN, Aadhaar…),other=Other'],
      ['label', 'Label'], ['number', 'Number'], ['holder', 'Name on it'], ['expires', 'Expires', 'MM/YYYY'],
    ],
  },
  custom: {
    title: 'Custom fields', noun: 'custom field', glyph: 'sparkle',
    note: 'Anything else a form asks for - an employee ID, a library card, a frequent-flyer number. Static offers it in any box whose label or name matches.',
    fields: [
      ['label', 'Name', 'Employee ID, Library card…'], ['value', 'Value'],
      ['match', 'Also fill fields named', 'staff no, badge number (optional, comma-separated)'],
    ],
  },
};

const DOC_NAMES = { passport: 'Passport', 'driving-licence': 'Driving licence', 'vehicle-registration': 'Vehicle registration', 'national-id': 'National ID', other: 'Document' };
const NETWORK_TONE = { Visa: 'visa', Mastercard: 'mastercard', 'American Express': 'amex', RuPay: 'rupay', Discover: 'discover', JCB: 'jcb' };

let state = { prefs: {}, counts: {}, available: true };
let lists = {};
let kind = 'address';
let editing = null;     // { id?, values }
let armed = null;       // id waiting for the second click to delete
let shellApi = null;

const content = element('div', { class: 'af' });
const errorText = (error) => String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/* ---- categories ---------------------------------------------------------------- */

function categories() {
  return element('div', { class: 'af-cats', role: 'tablist', 'aria-label': 'What autofill keeps' }, Object.entries(FORMS).map(([id, spec], index) => {
    const count = state.counts?.[id] || 0;
    const button = element('button', {
      type: 'button', role: 'tab', class: 'af-cat' + (id === kind ? ' is-active' : ''), 'aria-selected': String(id === kind),
      style: '--i:' + index,
    }, [
      element('span', { class: 'af-cat-plate' }, [icon(spec.glyph, { size: 18 })]),
      element('span', { class: 'af-cat-count', text: String(count) }),
      element('span', { class: 'af-cat-name', text: spec.title }),
    ]);
    button.addEventListener('click', () => { kind = id; editing = null; armed = null; draw(); });
    return button;
  }));
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

/* ---- entries --------------------------------------------------------------------- */

function actions(item) {
  const confirming = armed === item.id;
  const edit = element('button', { type: 'button', class: 'af-act', text: 'Edit' });
  edit.addEventListener('click', async () => {
    const full = await invoke('autofill:values', { id: item.id }).catch(() => null);
    editing = { id: item.id, values: full?.fields || {} };
    armed = null;
    draw();
  });
  const remove = element('button', { type: 'button', class: 'af-act danger' + (confirming ? ' armed' : ''), text: confirming ? 'Delete for good' : 'Delete' });
  remove.addEventListener('click', async () => {
    if (!confirming) {
      armed = item.id;
      draw();
      setTimeout(() => { if (armed === item.id) { armed = null; draw(); } }, 3500);
      return;
    }
    armed = null;
    await invoke('autofill:remove', { id: item.id });
    await load();
  });
  return element('div', { class: 'af-actions' }, [edit, remove]);
}

function cardTile(item) {
  const v = item.view || {};
  const tone = NETWORK_TONE[v.network] || 'other';
  return element('div', { class: 'af-item af-card-item' }, [
    element('div', { class: 'af-cc tone-' + tone }, [
      element('div', { class: 'af-cc-top' }, [
        element('span', { class: 'af-cc-label', text: [item.label, item.cardKind === 'debit' ? 'Debit' : 'Credit'].filter(Boolean).join(' · ') }),
        element('span', { class: 'af-cc-network', text: v.network || 'Card' }),
      ]),
      element('div', { class: 'af-cc-chip', 'aria-hidden': 'true' }),
      element('div', { class: 'af-cc-number', text: '••••  ••••  ••••  ' + (v.last4 || '····') }),
      element('div', { class: 'af-cc-bottom' }, [
        element('span', { class: 'af-cc-holder', text: v.holder || 'Name on card' }),
        element('span', { class: 'af-cc-exp' }, [element('small', { text: 'VALID THRU' }), v.expires || '--/--']),
      ]),
    ]),
    actions(item),
  ]);
}

function addressTile(item) {
  const v = item.view || {};
  const purpose = { shipping: 'Shipping', billing: 'Billing' }[item.purpose] || 'Shipping and billing';
  return element('div', { class: 'af-item af-tile' }, [
    element('div', { class: 'af-tile-head' }, [
      element('span', { class: 'af-tile-glyph' }, [icon('home', { size: 15 })]),
      element('strong', { text: item.label || v.name || 'Address' }),
      element('span', { class: 'af-chip', text: purpose }),
    ]),
    item.label && v.name ? element('div', { class: 'af-tile-name', text: v.name }) : null,
    ...(v.lines || []).map((line) => element('div', { class: 'af-tile-line', text: line })),
    v.contact ? element('div', { class: 'af-tile-dim', text: v.contact }) : null,
    actions(item),
  ].filter(Boolean));
}

function simpleTile(item) {
  const glyph = FORMS[item.kind].glyph;
  const title = item.kind === 'document' ? (item.label || DOC_NAMES[item.docType] || 'Document')
    : item.kind === 'custom' ? item.label : (item.label || 'UPI');
  const sub = item.kind === 'document' && item.label ? DOC_NAMES[item.docType] || '' : item.kind === 'upi' ? 'UPI ID' : item.kind === 'custom' ? 'Custom field' : '';
  return element('div', { class: 'af-item af-tile' }, [
    element('div', { class: 'af-tile-head' }, [
      element('span', { class: 'af-tile-glyph' }, [icon(glyph, { size: 15 })]),
      element('strong', { text: title }),
      sub ? element('span', { class: 'af-chip', text: sub }) : null,
    ].filter(Boolean)),
    element('div', { class: 'af-tile-value', text: item.summary || '' }),
    actions(item),
  ]);
}

function tileFor(item) {
  if (editing?.id === item.id) return null;
  if (item.kind === 'card') return cardTile(item);
  if (item.kind === 'address') return addressTile(item);
  return simpleTile(item);
}

/* ---- the form -------------------------------------------------------------------- */

function editor() {
  const spec = FORMS[kind];
  const values = editing.values || {};
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
  const error = element('p', { class: 'pw-error', role: 'alert' });
  const save = element('button', { type: 'submit', class: 'pill selected', text: editing.id ? 'Save changes' : 'Save ' + spec.noun });
  const form = element('form', { class: 'af-editor' }, [
    element('div', { class: 'af-editor-head' }, [
      element('span', { class: 'af-tile-glyph' }, [icon(spec.glyph, { size: 15 })]),
      element('strong', { text: (editing.id ? 'Edit ' : 'Add ') + spec.noun }),
    ]),
    grid,
    error,
    element('div', { class: 'pw-row' }, [save, element('button', { type: 'button', class: 'pill', text: 'Cancel', onclick: () => { editing = null; draw(); } })]),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(Object.entries(inputs).map(([key, el]) => [key, el.value]));
    save.disabled = true;
    try {
      await invoke('autofill:put', { kind, fields, id: editing.id });
      editing = null;
      await load();
    } catch (e) {
      error.textContent = errorText(e);
      save.disabled = false;
    }
  });
  setTimeout(() => form.querySelector('input')?.focus(), 30);
  return form;
}

/* ---- page ------------------------------------------------------------------------- */

let editorNode = null;

function panel() {
  const spec = FORMS[kind];
  const items = lists[kind] || [];
  if (editing && !editorNode) editorNode = editor();
  if (!editing) editorNode = null;
  const tiles = items.map(tileFor).filter(Boolean);
  const add = element('button', { type: 'button', class: 'af-add' }, [
    element('span', { class: 'af-add-plus', text: '+' }),
    element('span', { text: 'Add ' + spec.noun }),
  ]);
  add.addEventListener('click', () => { editing = { values: {} }; editorNode = null; draw(); });
  return element('section', { class: 'af-panel' }, [
    element('div', { class: 'af-panel-head' }, [
      element('h2', { text: spec.title }),
      element('p', { class: 'muted', text: spec.note }),
    ]),
    editing && !editing.id ? editorNode : null,
    element('div', { class: 'af-grid' + (kind === 'card' ? ' cards' : '') }, [
      ...items.map((item) => (editing?.id === item.id ? editorNode : null) || tileFor(item)).filter(Boolean),
      editing ? null : add,
    ].filter(Boolean)),
    !tiles.length && !editing ? element('p', { class: 'af-empty', text: 'Nothing saved yet. Static offers to save these when you fill in a form - or add one here.' }) : null,
  ].filter(Boolean));
}

function draw() {
  if (!state.available) {
    content.replaceChildren(element('div', { class: 'panel-card' }, [
      element('p', { class: 'pw-error', text: 'Your system has no secure storage, so Static will not store addresses or cards here.' }),
    ]));
    return;
  }
  const active = content.contains(document.activeElement) ? document.activeElement : null;
  content.replaceChildren(
    categories(),
    element('div', { class: 'af-switches' }, [
      toggle('Fill addresses, UPI, IDs and custom fields', 'Suggested under the field when you click it; nothing is filled until you pick', 'fillAddresses'),
      toggle('Fill payment cards', 'Never the security code. With a master password, cards wait for the vault to be unlocked', 'fillCards'),
    ]),
    panel(),
    element('p', { class: 'af-foot muted' }, [
      'Saved logins and passkeys are in ',
      element('a', { href: '#', text: 'Passwords', onclick: (event) => { event.preventDefault(); invoke('tabs:navigate', { input: 'browser://passwords' }); } }),
      '. Everything here is encrypted by your operating system and stays on this device.',
    ]),
  );
  if (active && active.isConnected) active.focus({ preventScroll: true });
}

async function load() {
  try {
    const [s, ...all] = await Promise.all([
      invoke('autofill:state'),
      ...Object.keys(FORMS).map((id) => invoke('autofill:list', { kind: id })),
    ]);
    state = s;
    Object.keys(FORMS).forEach((id, i) => { lists[id] = all[i]; });
  } catch (error) { state.error = error.message; }
  draw();
}

shellApi = window.shell.mount({
  mode: 'autofill',
  title: 'Autofill',
  subtitle: 'Addresses, cards, IDs and more - filled with one click',
  content,
});
onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });

// browser://autofill#card opens straight onto payment cards, and so on.
const wanted = location.hash.replace('#', '');
if (FORMS[wanted]) kind = wanted;
load();
})();
