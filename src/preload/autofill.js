/**
 * Autofill, the page half. Runs in the preload's isolated world on web pages,
 * top frame only; the page's own scripts cannot see or call any of this.
 *
 * It does four small things: say which kind of field has focus and where it
 * is (main decides what, if anything, to suggest), fill the fields main hands
 * back after the user picks a suggestion, report what was typed into a form
 * when it is submitted (main decides whether to offer to save it), and say
 * when a sign-in form appears (main decides whether to sign in on its own).
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

/** A field's own words - label, name, id, placeholder - for custom fields. */
function describe(el) {
  return [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), labelText(el)]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 300);
}

/** A plain text box no built-in kind claimed: custom fields may fit it. */
function customCandidate(el) {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
  return ['text', 'email', 'tel', 'number', 'url', ''].includes(el.type);
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
  let type = typeOf(el);
  if (type === 'cc-csc' || (!type && !customCandidate(el))) { focused = null; return; }
  // One-time codes are never filled from anything saved.
  if (!type && /\b(otp|one[\s_-]?time|verification[\s_-]?code|2fa|mfa|captcha)\b/i.test(describe(el))) { focused = null; return; }
  if (!type) type = 'custom';
  focused = el;
  const box = el.getBoundingClientRect();
  const scope = scopeOf(el).map((f) => f.type);
  ipcRenderer.send('autofill:focus', {
    type, kind: type === 'custom' ? 'custom' : kindOf(type),
    rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
    scope: [...new Set(scope)].slice(0, 40),
    empty: !el.value,
    text: describe(el),
    // autocomplete="username webauthn": the site offers passkeys in this box.
    webauthn: /\bwebauthn\b/i.test(el.getAttribute('autocomplete') || ''),
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

/** Press the form's sign-in button, the way a person would. */
function submit(anchor) {
  const form = anchor.form || anchor.closest('form');
  const root = form || document;
  const buttons = [...root.querySelectorAll('button, input[type=submit], [role=button]')].filter((b) => visible(b) && !b.disabled);
  const button = buttons.find((b) => b.type === 'submit' && (b.form === form || !form)) ||
    buttons.find((b) => /log ?in|sign ?in|continue|next|submit/i.test(b.textContent || b.value || ''));
  if (button) { button.click(); return true; }
  if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
  return false;
}

ipcRenderer.on('autofill:apply', (_event, payload) => {
  const values = payload && typeof payload.values === 'object' ? payload.values : {};
  // An automatic sign-in fills the sign-in form, not whatever has focus.
  const anchor = payload?.target === 'login' && loginField && document.contains(loginField) ? loginField
    : focused && document.contains(focused) ? focused : document.activeElement;
  if (!anchor) return;
  // A custom field goes into the one box it was chosen for, nowhere else.
  if (payload?.only === 'focused') {
    const value = values.custom ?? Object.values(values)[0];
    if (value !== undefined && setValue(anchor, value)) ipcRenderer.send('autofill:filled', { count: 1 });
    return;
  }
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
  if (payload?.submit && filled) {
    // A beat for the page's own scripts to see the input events first.
    setTimeout(() => { if (document.contains(anchor)) submit(anchor); }, 350);
  }
});

/**
 * Sign-in forms, for signing in automatically.
 *
 * A form counts when it has exactly one visible password box that is empty
 * and not for a new password. Found on load and again as the page changes,
 * because most sign-in pages are drawn by script after the document loads.
 * Main decides whether to act; this only says the form is there.
 */
let loginField = null;
let loginReported = null;
let scans = 0;

function scanForLogin() {
  if (++scans > 40) { observer?.disconnect(); return; }
  const boxes = [...document.querySelectorAll('input[type=password]')].filter((el) => visible(el) && !el.disabled && !el.readOnly);
  if (boxes.length !== 1) return;
  const box = boxes[0];
  if (box.value || box === loginReported || typeOf(box) !== 'password') return;
  const scope = scopeOf(box).map((f) => f.type);
  if (scope.includes('new-password')) return;
  loginField = box;
  loginReported = box;
  ipcRenderer.send('autofill:login-form', { hasUser: scope.some((t) => t === 'username' || t === 'email') });
}

let pending = null;
const later = () => { clearTimeout(pending); pending = setTimeout(scanForLogin, 300); };
let observer = null;
function watch() {
  later();
  try {
    observer = new MutationObserver(later);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer?.disconnect(), 20_000);
  } catch { /* no observer: the load-time scan still ran */ }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
else watch();

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
