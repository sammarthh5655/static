'use strict';

/**
 * Autofill data: addresses (with the name, email, phone and company that go
 * with them), payment cards, UPI IDs and documents such as a passport or a
 * vehicle registration.
 *
 * Every entry is encrypted with the operating system (safeStorage), like the
 * password vault, and a card's security code is never stored at all. Lists
 * handed to pages show masked summaries; full values leave main only to fill
 * a field the user chose to fill.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');
const { KINDS, cardNetwork, luhn } = require('../../shared/autofill-fields');

const FILE = 'autofill.json';
const MAX = 500;

/** The fields each kind of entry may hold, and nothing else. */
const SHAPES = {
  address: ['label', 'purpose', ...KINDS.address],
  card: ['label', 'cardKind', 'cc-name', 'cc-number', 'cc-exp-month', 'cc-exp-year'],
  upi: ['label', 'upi'],
  document: ['label', 'docType', 'number', 'holder', 'expires'],
  // Anything else a form asks for: an employee ID, a library card, a
  // frequent-flyer number. `match` lists other names the field goes by.
  custom: ['label', 'value', 'match'],
};
const DOC_TYPES = ['passport', 'driving-licence', 'vehicle-registration', 'national-id', 'other'];

function clean(kind, input) {
  const out = {};
  for (const key of SHAPES[kind]) {
    const value = input?.[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, key === 'value' ? 2000 : 200);
  }
  if (kind === 'custom' && out.value && !out.label) throw new Error('Give it a name, so Static knows which fields it belongs in.');
  if (kind === 'card') {
    if (out['cc-number']) out['cc-number'] = out['cc-number'].replace(/\D/g, '');
    if (out['cc-number'] && !luhn(out['cc-number'])) throw new Error('That card number does not look right.');
    out.cardKind = out.cardKind === 'debit' ? 'debit' : 'credit';
  }
  if (kind === 'upi' && out.upi && !/^[\w.-]{2,}@[a-z][\w]{1,}$/i.test(out.upi)) throw new Error('A UPI ID looks like name@bank.');
  if (kind === 'document') out.docType = DOC_TYPES.includes(out.docType) ? out.docType : 'other';
  if (kind === 'address') out.purpose = ['shipping', 'billing', 'both'].includes(out.purpose) ? out.purpose : 'both';
  return out;
}

function mask(kind, fields) {
  if (kind === 'card') {
    const n = fields['cc-number'] || '';
    return cardNetwork(n) + ' •••• ' + n.slice(-4) + (fields['cc-exp-month'] ? ' · ' + fields['cc-exp-month'].padStart(2, '0') + '/' + String(fields['cc-exp-year'] || '').slice(-2) : '');
  }
  if (kind === 'document') {
    const n = fields.number || '';
    return n.length > 4 ? '•••• ' + n.slice(-4) : n;
  }
  if (kind === 'address') {
    return [fields.name || [fields['given-name'], fields['family-name']].filter(Boolean).join(' '),
      fields['address-line1'], fields['address-level2'], fields['postal-code']].filter(Boolean).join(', ');
  }
  if (kind === 'upi') return fields.upi || '';
  if (kind === 'custom') return fields.value ? (fields.value.length > 40 ? fields.value.slice(0, 39) + '…' : fields.value) : '';
  return fields.value ? fields.value.slice(0, 40) : '';
}

class Autofill {
  constructor(dir, { onChange } = {}) {
    this.file = path.join(dir, FILE);
    this.onChange = onChange || (() => {});
    this.data = { version: 1, entries: [], never: [], noAuto: [], prefs: { offerPasswords: true, fillAddresses: true, fillCards: true, autoSignIn: true, passkeys: true } };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw.entries)) this.data.entries = raw.entries;
      if (Array.isArray(raw.never)) this.data.never = raw.never;
      if (Array.isArray(raw.noAuto)) this.data.noAuto = raw.noAuto;
      if (raw.prefs) this.data.prefs = { ...this.data.prefs, ...raw.prefs };
    } catch { /* first run */ }
  }

  available() {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  }

  #save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    this.onChange();
  }

  #open(entry) {
    try { return JSON.parse(safeStorage.decryptString(Buffer.from(entry.box, 'base64'))); }
    catch { return null; }
  }

  /** Add or replace an entry. */
  put(kind, fields, id) {
    if (!SHAPES[kind]) throw new Error('Unknown kind of entry.');
    if (!this.available()) throw new Error('Your system has no secure storage, so autofill data cannot be saved safely.');
    const values = clean(kind, fields);
    if (Object.keys(values).filter((k) => !['label', 'purpose', 'cardKind', 'docType', 'match'].includes(k)).length === 0) {
      throw new Error('There is nothing to save.');
    }
    const box = safeStorage.encryptString(JSON.stringify(values)).toString('base64');
    const now = Date.now();
    const existing = id && this.data.entries.find((e) => e.id === id);
    if (existing) Object.assign(existing, { kind, box, updatedAt: now });
    else {
      this.data.entries.unshift({ id: crypto.randomUUID(), kind, box, createdAt: now, updatedAt: now, used: 0 });
      this.data.entries.length = Math.min(this.data.entries.length, MAX);
    }
    this.#save();
    return (existing || this.data.entries[0]).id;
  }

  remove(id) {
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    this.#save();
  }

  /** Summaries only: safe to show in a list. */
  list(kind) {
    return this.data.entries.filter((e) => !kind || e.kind === kind).map((entry) => {
      const fields = this.#open(entry) || {};
      return { id: entry.id, kind: entry.kind, label: fields.label || '', summary: mask(entry.kind, fields),
        docType: fields.docType, cardKind: fields.cardKind, purpose: fields.purpose, updatedAt: entry.updatedAt };
    });
  }

  /** The full values, for filling a form or for the edit dialog. */
  values(id) {
    const entry = this.data.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.used = Date.now();
    return { kind: entry.kind, fields: this.#open(entry) || {} };
  }

  /** Entries that have a value for this field type. */
  suggestionsFor(fieldType) {
    const out = [];
    for (const entry of this.data.entries) {
      const fields = this.#open(entry);
      if (!fields) continue;
      const value = fillValues(entry.kind, fields)[fieldType];
      if (value) out.push({ id: entry.id, kind: entry.kind, value: entry.kind === 'card' ? mask('card', fields) : value, label: fields.label || '', summary: mask(entry.kind, fields) });
    }
    return out;
  }

  /**
   * Custom fields that belong in a field described by `text` (its label, name,
   * id and placeholder). A custom field matches when every word of its name,
   * or of one of its other names, appears in the description.
   */
  customFor(text) {
    const words = normalise(text);
    if (!words) return [];
    const out = [];
    for (const entry of this.data.entries) {
      if (entry.kind !== 'custom') continue;
      const fields = this.#open(entry);
      if (!fields?.value) continue;
      const names = [fields.label, ...String(fields.match || '').split(/[,;\n]/)].map(normalise).filter(Boolean);
      if (names.some((name) => name.split(' ').every((word) => (' ' + words + ' ').includes(' ' + word + ' ')))) {
        out.push({ id: entry.id, kind: 'custom', label: fields.label, value: fields.value, summary: mask('custom', fields) });
      }
    }
    return out;
  }

  /** Sites where Static must not sign in on its own. */
  noAuto(origin) { return this.data.noAuto.includes(origin); }
  addNoAuto(origin) { if (!this.noAuto(origin)) { this.data.noAuto.push(origin); this.#save(); } }
  removeNoAuto(origin) { this.data.noAuto = this.data.noAuto.filter((o) => o !== origin); this.#save(); }

  /** Is there already an entry that matches what was typed? */
  has(kind, fields) {
    const probe = clean(kind, fields);
    const keyOf = (f) => kind === 'card' ? f['cc-number'] : kind === 'upi' ? f.upi
      : kind === 'address' ? [f['address-line1'], f['postal-code']].join('|').toLowerCase() : JSON.stringify(f);
    const key = keyOf(probe);
    return this.data.entries.some((e) => e.kind === kind && keyOf(this.#open(e) || {}) === key);
  }

  never(origin) { return this.data.never.includes(origin); }
  addNever(origin) { if (!this.never(origin)) { this.data.never.push(origin); this.#save(); } }
  removeNever(origin) { this.data.never = this.data.never.filter((o) => o !== origin); this.#save(); }
  prefs() { return { ...this.data.prefs }; }
  setPrefs(patch) {
    for (const key of Object.keys(this.data.prefs)) if (typeof patch?.[key] === 'boolean') this.data.prefs[key] = patch[key];
    this.#save();
    return this.prefs();
  }

  state() {
    return { available: this.available(), prefs: this.prefs(), never: [...this.data.never], noAuto: [...this.data.noAuto],
      counts: Object.fromEntries(Object.keys(SHAPES).map((k) => [k, this.data.entries.filter((e) => e.kind === k).length])) };
  }
}

/** What an entry puts into each field type. */
function fillValues(kind, f) {
  if (kind === 'address') {
    const out = { ...f };
    if (!out.name && (f['given-name'] || f['family-name'])) out.name = [f['given-name'], f['family-name']].filter(Boolean).join(' ');
    if (out.name && !out['given-name']) {
      const parts = out.name.split(/\s+/);
      out['given-name'] = parts[0];
      out['family-name'] = parts.slice(1).join(' ');
    }
    delete out.label; delete out.purpose;
    return out;
  }
  if (kind === 'card') {
    const month = String(f['cc-exp-month'] || '').padStart(2, '0');
    const year = String(f['cc-exp-year'] || '');
    return {
      'cc-name': f['cc-name'], 'cc-number': f['cc-number'],
      'cc-exp-month': f['cc-exp-month'] ? month : undefined, 'cc-exp-year': year || undefined,
      'cc-exp': f['cc-exp-month'] && year ? month + '/' + year.slice(-2) : undefined,
    };
  }
  if (kind === 'upi') return { upi: f.upi };
  if (kind === 'document') return { [f.docType]: f.number };
  if (kind === 'custom') return { custom: f.value };
  return {};
}

/** "Employee_ID no." -> "employee id no" */
function normalise(text) {
  return String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ').trim();
}

module.exports = { Autofill, SHAPES, DOC_TYPES, fillValues, mask };
