/**
 * Autofill, the page half. Runs in the preload's isolated world on web pages,
 * top frame only; the page's own scripts cannot see or call any of this.
 *
 * It does three small things: say which kind of field has focus and where it
 * is (main decides what, if anything, to suggest), fill the fields main hands
 * back after the user picks a suggestion, and report what was typed into a
 * form when it is submitted (main decides whether to offer to save it).
 * Nothing is stored here and nothing is read that is not a form field.
 */
const { ipcRenderer } = require('electron');
const { classify, kindOf } = require('../shared/autofill-fields');

const FIELD = 'input, select, textarea';
let focused = null;
let lastReport = '';

function labelText(el) {
  const parts = [];
  if (el.id) {
    try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(l.textContent); } catch { /* bad id */ }
  }
  const wrap = el.closest('label');
  if (wrap) parts.push(wrap.textContent);
  const by = el.getAttribute('aria-labelledby');
  if (by) for (const id of by.split(/\s+/)) parts.push(document.getElementById(id)?.textContent || '');
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function typeOf(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return null;
  if (el.disabled || el.readOnly) return null;
  return classify({
    type: el instanceof HTMLSelectElement ? 'select' : el instanceof HTMLTextAreaElement ? 'text' : el.type,
    name: el.name, id: el.id, autocomplete: el.getAttribute('autocomplete'),
    placeholder: el.getAttribute('placeholder'), label: labelText(el), ariaLabel: el.getAttribute('aria-label'),
  });
}

function visible(el) {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** The fields that belong together: the form, or the whole page without one. */
function scopeOf(el) {
  return [...(el.form || document).querySelectorAll(FIELD)]
    .map((node) => ({ node, type: typeOf(node) }))
    .filter((f) => f.type && visible(f.node));
}

document.addEventListener('focusin', (event) => {
  const el = event.target;
  const type = typeOf(el);
  if (!type || type === 'cc-csc') { focused = null; return; }
  focused = el;
  const box = el.getBoundingClientRect();
  const scope = scopeOf(el).map((f) => f.type);
  ipcRenderer.send('autofill:focus', {
    type, kind: kindOf(type),
    rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
    scope: [...new Set(scope)].slice(0, 40),
    empty: !el.value,
  });
}, true);

// Typing into the field closes the suggestions, as in every browser.
document.addEventListener('input', (event) => {
  if (event.isTrusted && event.target === focused) ipcRenderer.send('autofill:typing');
}, true);

/** Set a value the way a person typing would, so frameworks notice. */
function setValue(el, value) {
  if (el instanceof HTMLSelectElement) {
    const want = String(value).toLowerCase();
    const option = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) ||
      [...el.options].find((o) => o.text.trim().toLowerCase().startsWith(want) || (want.length > 2 && o.value.toLowerCase().startsWith(want)));
    if (!option) return false;
    el.value = option.value;
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    let text = String(value);
    if (el.maxLength > 0 && el.maxLength < text.length) {
      // A two-digit year box wants "28", not "2028".
      text = /^\d{4}$/.test(text) && el.maxLength === 2 ? text.slice(-2) : text.slice(0, el.maxLength);
    }
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.classList.add('static-autofilled');
  return true;
}

ipcRenderer.on('autofill:apply', (_event, payload) => {
  const values = payload && typeof payload.values === 'object' ? payload.values : {};
  const anchor = focused && document.contains(focused) ? focused : document.activeElement;
  if (!anchor) return;
  let filled = 0;
  for (const { node, type } of scopeOf(anchor)) {
    if (type === 'cc-csc') continue;
    const value = values[type];
    if (value === undefined || value === null || value === '') continue;
    // Never overwrite what the person already typed, except the field they chose from.
    if (node !== anchor && node.value && !(node instanceof HTMLSelectElement)) continue;
    if (setValue(node, value)) filled++;
  }
  ipcRenderer.send('autofill:filled', { count: filled });
});

/** What was typed into this form, by field type. Security codes are left out. */
function snapshot(root) {
  const out = {};
  for (const { node, type } of scopeOf(root)) {
    if (type === 'cc-csc' || !node.value) continue;
    if (node instanceof HTMLSelectElement) out[type] = node.options[node.selectedIndex]?.text?.trim() || node.value;
    else out[type] = String(node.value).slice(0, 300);
  }
  return out;
}

function report(root) {
  const fields = snapshot(root);
  if (!Object.keys(fields).length) return;
  const key = JSON.stringify(fields);
  if (key === lastReport) return;
  lastReport = key;
  ipcRenderer.send('autofill:submitted', { fields });
}

document.addEventListener('submit', (event) => report(event.target), true);
// Many sign-in pages never submit a form: they post from a button or on Enter.
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('button, input[type=submit], [role=button]');
  if (!button) return;
  const text = (button.textContent || button.value || '').toLowerCase();
  const inForm = button.form || button.closest('form');
  if (button.type === 'submit' || /log ?in|sign ?in|sign ?up|register|continue|next|submit|save|pay|place order|checkout/.test(text)) {
    report(inForm || focused || document.body);
  }
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && focused && event.target === focused) report(focused);
}, true);
