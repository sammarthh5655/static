const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');
const lock = require('./lock');

/**
 * Password vault.
 *
 * Credentials are encrypted with Electron's `safeStorage`, which delegates to
 * the operating system: DPAPI on Windows, Keychain on macOS, libsecret or
 * kwallet on Linux. The encryption key is held by the OS and tied to the user
 * account, so the vault file is useless if copied to another machine.
 *
 * WHAT THIS PROTECTS AGAINST, and what it does not:
 *   - Protects: the file being read directly, copied off the disk, or picked
 *     up in a backup. Without the OS key it is ciphertext.
 *   - Does NOT protect: malware already running as you. It can ask the same OS
 *     to decrypt, exactly as this browser does. No local password manager can
 *     defend against that, including Chrome's and Brave's.
 *
 * On Linux with no keyring, safeStorage silently falls back to `basic_text`,
 * which is NOT encryption. That case is detected and reported rather than
 * quietly storing passwords in plaintext.
 *
 * Each entry is encrypted individually rather than the file as a whole, so a
 * single corrupt record loses one login instead of the entire vault.
 *
 * A MASTER PASSWORD (optional) adds a second layer inside the OS one - see
 * lock.js. With it set, secrets are sealed to the vault's public key and can
 * only be opened between an unlock and the next lock, and the vault locks
 * itself after a quiet spell, when the computer sleeps or locks, and when
 * Static closes. Passkeys are kept here too, their private keys sealed exactly
 * like passwords.
 */

const FILE = 'vault.json';
const MAX_ENTRIES = 2000;
const MAX_PASSKEYS = 1000;
/** What a sealed secret decrypts to while the vault is locked. */
const LOCKED = Symbol('locked');
/** Auto-lock choices, in minutes. 0 = only when Static closes. */
const LOCK_AFTER = [1, 5, 15, 60, 240, 0];

class Passwords {
  constructor(dir, { onChange } = {}) {
    this.file = path.join(dir, FILE);
    this.onChange = onChange || (() => {});
    this.data = { version: 1, entries: [], passkeys: [], lock: null };
    /** The vault's private key while unlocked. Memory only. */
    this.key = null;
    this.lastUse = 0;
    this.failures = 0;
    this.waitUntil = 0;
    this.load();
    this.timer = setInterval(() => this.#autoLock(), 20_000);
    this.timer.unref?.();
  }

  /**
   * Is real encryption available?
   *
   * `basic_text` on Linux means safeStorage will happily "encrypt" with no
   * key at all. Storing passwords under that is worse than refusing, because
   * the user would believe they were protected.
   */
  encryptionStatus() {
    let available = false;
    try { available = safeStorage.isEncryptionAvailable(); } catch { available = false; }

    let backend = 'unknown';
    if (process.platform === 'linux') {
      try { backend = safeStorage.getSelectedStorageBackend(); } catch { backend = 'unknown'; }
    } else {
      backend = process.platform === 'win32' ? 'dpapi' : 'keychain';
    }

    const plaintextBackend = backend === 'basic_text';
    return {
      available: available && !plaintextBackend,
      backend,
      reason: !available
        ? 'The operating system did not offer an encryption key.'
        : plaintextBackend
          ? 'No system keyring is available, so passwords could only be stored unencrypted.'
          : null,
    };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.entries)) this.data = parsed;
    } catch {
      // Missing or unreadable file is the normal first-run case.
      this.data = { version: 1, entries: [] };
    }
    if (!Array.isArray(this.data.passkeys)) this.data.passkeys = [];
    if (this.data.lock && !this.data.lock.publicKey) this.data.lock = null;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      // 0600: the ciphertext still should not be world-readable.
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('passwords: could not write the vault', error.message);
    }
  }

  /**
   * Encrypt a secret: sealed to the vault key first when there is a master
   * password (which needs no unlock - only the public half), then the OS.
   */
  #encrypt(plain) {
    const inner = this.data.lock ? lock.seal(this.data.lock.publicKey, plain) : String(plain);
    return safeStorage.encryptString(inner).toString('base64');
  }

  /** The OS layer only: the stored string, or null if unreadable here. */
  #outer(encoded) {
    try {
      return safeStorage.decryptString(Buffer.from(String(encoded), 'base64'));
    } catch {
      // A record encrypted under a different OS user or machine cannot be
      // read. Report it rather than throwing away the row.
      return null;
    }
  }

  /** The plaintext, LOCKED while the vault is locked, or null if unreadable. */
  #decrypt(encoded) {
    const outer = this.#outer(encoded);
    if (outer === null || !lock.isSealed(outer)) return outer;
    if (!this.key || !this.data.lock) return LOCKED;
    try { return lock.open(this.key, this.data.lock.publicKey, outer); } catch { return null; }
  }

  /* ---- master password --------------------------------------------------- */

  get hasMaster() { return !!this.data.lock; }
  get locked() { return !!this.data.lock && !this.key; }

  /** Something used the vault: the auto-lock clock starts again. */
  touch() { this.lastUse = Date.now(); }

  lockAfter() {
    const minutes = this.data.lock?.lockAfter;
    return LOCK_AFTER.includes(minutes) ? minutes : 15;
  }

  #autoLock() {
    if (!this.key) return;
    const minutes = this.lockAfter();
    if (minutes && Date.now() - this.lastUse > minutes * 60_000) this.lock();
  }

  lock() {
    if (!this.key) return;
    this.key = null;
    this.onChange();
  }

  /** Wrong guesses make the next attempt wait. */
  #waiting() {
    const left = this.waitUntil - Date.now();
    return left > 0 ? { ok: false, wait: left, error: 'Too many wrong tries. Wait ' + Math.ceil(left / 1000) + ' s.' } : null;
  }

  async #check(password) {
    const blocked = this.#waiting();
    if (blocked) return { blocked };
    const key = await lock.unlockLock(this.data.lock, String(password || ''));
    if (!key) {
      this.failures++;
      this.waitUntil = Date.now() + lock.penaltyMs(this.failures);
      return { blocked: { ok: false, error: 'That is not your master password.' } };
    }
    this.failures = 0;
    this.waitUntil = 0;
    return { key };
  }

  /** Open the vault with the master password. */
  async unlock(password) {
    if (!this.data.lock) return { ok: true };
    const { key, blocked } = await this.#check(password);
    if (blocked) return blocked;
    this.key = key;
    this.touch();
    this.onChange();
    return { ok: true };
  }

  /** Is this the master password? For re-checking before something sensitive. */
  async verify(password) {
    if (!this.data.lock) return { ok: false, error: 'There is no master password.' };
    const { blocked } = await this.#check(password);
    return blocked || { ok: true };
  }

  get deviceUnlock() { return !!this.data.lock?.device; }

  /** Open the vault with the device copy, AFTER the OS has verified the person. */
  unlockWithDevice() {
    const device = this.data.lock?.device;
    if (!device) return { ok: false, error: 'Device unlock is not set up.' };
    try {
      const pkcs8 = Buffer.from(safeStorage.decryptString(Buffer.from(device, 'base64')), 'base64');
      this.key = lock.importPrivate(pkcs8);
    } catch {
      return { ok: false, error: 'The device key could not be read. Unlock with your master password.' };
    }
    this.failures = 0;
    this.touch();
    this.onChange();
    return { ok: true };
  }

  /** Keep a copy of the vault key under the OS, released by Windows Hello or Touch ID. */
  setDeviceUnlock(enabled) {
    if (!this.data.lock) return { ok: false, error: 'Set a master password first.' };
    if (enabled) {
      if (!this.key) return { ok: false, error: 'Unlock first.' };
      this.data.lock.device = safeStorage.encryptString(lock.exportPrivate(this.key).toString('base64')).toString('base64');
    } else {
      delete this.data.lock.device;
    }
    this.save();
    this.onChange();
    return { ok: true };
  }

  setLockAfter(minutes) {
    if (!this.data.lock || !LOCK_AFTER.includes(Number(minutes))) return { ok: false };
    this.data.lock.lockAfter = Number(minutes);
    this.save();
    this.onChange();
    return { ok: true };
  }

  /** Re-encrypt every stored secret. Throws, changing nothing, if any is locked. */
  #rewriteAll(read, write) {
    const rows = [
      ...this.data.entries.map((e) => [e, 'password']),
      ...this.data.entries.filter((e) => e.note).map((e) => [e, 'note']),
      ...this.data.passkeys.map((k) => [k, 'privateKey']),
    ];
    const plain = rows.map(([row, field]) => {
      const value = read(row[field]);
      if (value === LOCKED) throw new Error('Unlock first.');
      return value;
    });
    rows.forEach(([row, field], index) => {
      // A row this machine cannot read stays as it is: it is lost either way,
      // and it must not stop a master password being set.
      if (typeof plain[index] === 'string') row[field] = write(plain[index]);
    });
  }

  /** Turn on a master password. */
  async setMaster(password) {
    if (this.data.lock) return { ok: false, error: 'A master password is already set.' };
    const text = String(password || '');
    if (text.length < 8) return { ok: false, error: 'Use at least 8 characters.' };
    if (!this.encryptionStatus().available) return { ok: false, error: 'Encryption is unavailable on this system.' };
    const { record, privateKey } = await lock.createLock(text);
    this.#rewriteAll((value) => this.#outer(value),
      (plain) => safeStorage.encryptString(lock.seal(record.publicKey, plain)).toString('base64'));
    this.data.lock = { ...record, lockAfter: 15 };
    this.key = privateKey;
    this.touch();
    this.save();
    this.onChange();
    return { ok: true };
  }

  async changeMaster(current, next) {
    if (!this.data.lock) return { ok: false, error: 'There is no master password.' };
    if (String(next || '').length < 8) return { ok: false, error: 'Use at least 8 characters.' };
    const { key, blocked } = await this.#check(current);
    if (blocked) return blocked;
    this.data.lock = await lock.rewrapLock(this.data.lock, key, String(next));
    this.key = key;
    this.touch();
    this.save();
    this.onChange();
    return { ok: true };
  }

  /** Turn the master password off: the OS layer alone protects the vault again. */
  async removeMaster(current) {
    if (!this.data.lock) return { ok: true };
    const { key, blocked } = await this.#check(current);
    if (blocked) return blocked;
    this.key = key;
    this.#rewriteAll((value) => this.#decrypt(value), (plain) => safeStorage.encryptString(plain).toString('base64'));
    this.data.lock = null;
    this.key = null;
    this.save();
    this.onChange();
    return { ok: true };
  }

  lockState() {
    return {
      hasMaster: this.hasMaster,
      locked: this.locked,
      deviceUnlock: this.deviceUnlock,
      lockAfter: this.hasMaster ? this.lockAfter() : null,
      lockAfterChoices: LOCK_AFTER,
      waitMs: Math.max(0, this.waitUntil - Date.now()),
    };
  }

  /* ---- passkeys ----------------------------------------------------------- */

  /**
   * Store a new passkey. A second one for the same account on the same site
   * replaces the first, as the spec asks: the site has just forgotten it.
   */
  addPasskey(stored) {
    const status = this.encryptionStatus();
    if (!status.available) return { ok: false, error: status.reason || 'Encryption is unavailable.' };
    this.data.passkeys = this.data.passkeys.filter((k) => !(k.rpId === stored.rpId && k.userId === stored.userId));
    const now = Date.now();
    const entry = {
      id: crypto.randomUUID(),
      credentialId: stored.credentialId,
      rpId: stored.rpId,
      rpName: stored.rpName,
      userId: stored.userId,
      userName: stored.userName,
      displayName: stored.displayName,
      publicKey: stored.publicKey,
      privateKey: this.#encrypt(stored.privatePkcs8),
      createdAt: now,
      lastUsed: 0,
    };
    this.data.passkeys.unshift(entry);
    if (this.data.passkeys.length > MAX_PASSKEYS) this.data.passkeys.length = MAX_PASSKEYS;
    this.save();
    this.onChange();
    return { ok: true, id: entry.id };
  }

  #publicPasskey(k) {
    return { id: k.id, credentialId: k.credentialId, rpId: k.rpId, rpName: k.rpName, userId: k.userId,
      userName: k.userName, displayName: k.displayName, createdAt: k.createdAt, lastUsed: k.lastUsed };
  }

  /** Passkeys a site may use, optionally only those it named. No private keys. */
  passkeysFor(rpId, allow = []) {
    const wanted = new Set(allow || []);
    return this.data.passkeys
      .filter((k) => k.rpId === rpId && (!wanted.size || wanted.has(k.credentialId)))
      .map((k) => this.#publicPasskey(k));
  }

  hasCredential(rpId, credentialIds) {
    const ids = new Set(credentialIds || []);
    return this.data.passkeys.some((k) => k.rpId === rpId && ids.has(k.credentialId));
  }

  /** The private key for signing: a string, LOCKED, or null. */
  passkeyPrivate(id) {
    const entry = this.data.passkeys.find((k) => k.id === id);
    if (!entry) return null;
    const value = this.#decrypt(entry.privateKey);
    if (typeof value === 'string') {
      entry.lastUsed = Date.now();
      this.touch();
      this.save();
    }
    return value;
  }

  listPasskeys(query = '') {
    const q = String(query || '').trim().toLowerCase();
    return this.data.passkeys
      .filter((k) => !q || (k.rpId + ' ' + k.userName + ' ' + k.displayName + ' ' + k.rpName).toLowerCase().includes(q))
      .map((k) => ({ ...this.#publicPasskey(k), readable: this.#outer(k.privateKey) !== null }))
      .sort((a, b) => a.rpId.localeCompare(b.rpId) || String(a.userName).localeCompare(String(b.userName)));
  }

  removePasskey(id) {
    const before = this.data.passkeys.length;
    this.data.passkeys = this.data.passkeys.filter((k) => k.id !== id);
    if (this.data.passkeys.length !== before) { this.save(); this.onChange(); }
    return { ok: true };
  }

  /**
   * Save or update a credential.
   *
   * Matching is by origin plus username, so several accounts on one site are
   * separate entries rather than overwriting each other.
   */
  save_credential({ url, username, password, title, note }) {
    const status = this.encryptionStatus();
    if (!status.available) {
      return { ok: false, error: status.reason || 'Encryption is unavailable.' };
    }
    const origin = originOf(url);
    if (!origin) return { ok: false, error: 'That page has no usable address.' };
    if (!password) return { ok: false, error: 'There is no password to save.' };

    const now = Date.now();
    const existing = this.data.entries.find(
      (entry) => entry.origin === origin && entry.username === String(username || ''));

    if (existing) {
      existing.password = this.#encrypt(password);
      existing.updatedAt = now;
      if (title) existing.title = String(title).slice(0, 200);
      if (note !== undefined) this.#setNote(existing, note);
    } else {
      const entry = {
        id: crypto.randomUUID(),
        origin,
        username: String(username || ''),
        password: this.#encrypt(password),
        title: String(title || origin).slice(0, 200),
        createdAt: now,
        updatedAt: now,
        lastUsed: 0,
      };
      if (note) this.#setNote(entry, note);
      this.data.entries.unshift(entry);
      if (this.data.entries.length > MAX_ENTRIES) this.data.entries.length = MAX_ENTRIES;
    }

    this.save();
    this.onChange();
    return { ok: true, origin, id: (existing || this.data.entries[0]).id };
  }

  /** A note is a secret like the password: sealed and encrypted the same way. */
  #setNote(entry, note) {
    const text = String(note || '').replace(/\r\n/g, '\n').slice(0, 4000);
    if (text.trim()) entry.note = this.#encrypt(text);
    else delete entry.note;
  }

  /**
   * Add a login by hand, from the manager. Unlike saving after a sign-in, an
   * existing login for the same site and username is not silently replaced.
   */
  add({ url, username, password, note }) {
    const origin = originOf(withScheme(url));
    if (!origin) return { ok: false, error: 'Enter the website, like github.com or https://mail.example.com.' };
    if (!String(password || '')) return { ok: false, error: 'Enter the password.' };
    const name = String(username || '').trim().slice(0, 300);
    if (this.data.entries.some((entry) => entry.origin === origin && entry.username === name)) {
      return { ok: false, error: 'You already have a login for ' + origin.replace(/^https?:\/\//, '') + (name ? ' as ' + name : '') + '. Edit that one instead.' };
    }
    return this.save_credential({ url: origin, username: name, password: String(password), note, title: origin });
  }

  /**
   * Change a saved login. Only what is given changes: leave `password` empty
   * to keep the current one.
   */
  update(id, { url, username, password, note } = {}) {
    const entry = this.data.entries.find((candidate) => candidate.id === id);
    if (!entry) return { ok: false, error: 'That login no longer exists.' };
    const status = this.encryptionStatus();
    if (!status.available) return { ok: false, error: status.reason || 'Encryption is unavailable.' };
    const origin = url === undefined ? entry.origin : originOf(withScheme(url));
    if (!origin) return { ok: false, error: 'Enter the website, like github.com or https://mail.example.com.' };
    const name = username === undefined ? entry.username : String(username || '').trim().slice(0, 300);
    if (this.data.entries.some((other) => other !== entry && other.origin === origin && other.username === name)) {
      return { ok: false, error: 'Another saved login already uses that website and username.' };
    }
    if (origin !== entry.origin && entry.title === entry.origin) entry.title = origin;
    entry.origin = origin;
    entry.username = name;
    if (password) entry.password = this.#encrypt(String(password));
    if (note !== undefined) this.#setNote(entry, note);
    entry.updatedAt = Date.now();
    this.touch();
    this.save();
    this.onChange();
    return { ok: true, id: entry.id };
  }

  /** How much is saved for a page, for the key in the address bar. Nothing secret. */
  savedFor(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return { logins: 0, passkeys: 0 }; }
    return {
      logins: this.forUrl(url).length,
      passkeys: this.data.passkeys.filter((k) => host === k.rpId || host.endsWith('.' + k.rpId)).length,
    };
  }

  /** Credentials for a page. Passwords are NOT included - see `reveal`. */
  forUrl(url) {
    const origin = originOf(url);
    if (!origin) return [];
    return this.data.entries
      .filter((entry) => entry.origin === origin)
      .map((entry) => ({
        id: entry.id,
        username: entry.username,
        title: entry.title,
        lastUsed: entry.lastUsed,
      }));
  }

  /**
   * The decrypted password for one entry.
   *
   * Deliberately separate from listing: a renderer that only needs to show
   * "you have 3 logins" never receives a password, so the plaintext crosses
   * the IPC boundary only when something explicitly asks for that one entry.
   */
  reveal(id) {
    const entry = this.data.entries.find((candidate) => candidate.id === id);
    if (!entry) return { ok: false, error: 'That login no longer exists.' };
    const password = this.#decrypt(entry.password);
    if (password === LOCKED) return { ok: false, locked: true, error: 'Your passwords are locked.' };
    if (password === null) {
      return {
        ok: false,
        error: 'This entry cannot be decrypted. It was probably saved by a different '
          + 'user account or on another machine.',
      };
    }
    entry.lastUsed = Date.now();
    this.touch();
    this.save();
    return { ok: true, username: entry.username, password };
  }

  /** Everything about one login, for the edit form: password and note included. */
  details(id) {
    const entry = this.data.entries.find((candidate) => candidate.id === id);
    if (!entry) return { ok: false, error: 'That login no longer exists.' };
    const password = this.#decrypt(entry.password);
    if (password === LOCKED) return { ok: false, locked: true, error: 'Your passwords are locked.' };
    if (password === null) return { ok: false, error: 'This entry cannot be decrypted on this machine.' };
    const note = entry.note ? this.#decrypt(entry.note) : '';
    this.touch();
    return { ok: true, id: entry.id, url: entry.origin, username: entry.username, password, note: typeof note === 'string' ? note : '' };
  }

  /** Vault listing. Never includes passwords. */
  list(query = '') {
    const q = String(query || '').trim().toLowerCase();
    return this.data.entries
      .filter((entry) => !q ||
        (entry.origin + ' ' + entry.username + ' ' + entry.title).toLowerCase().includes(q))
      .map((entry) => ({
        id: entry.id,
        origin: entry.origin,
        username: entry.username,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastUsed: entry.lastUsed,
        hasNote: !!entry.note,
        readable: this.#outer(entry.password) !== null,
      }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }

  remove(id) {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((entry) => entry.id !== id);
    if (this.data.entries.length !== before) {
      this.save();
      this.onChange();
    }
    return { ok: true };
  }

  clear() {
    this.data.entries = [];
    this.data.passkeys = [];
    this.save();
    this.onChange();
    return { ok: true };
  }

  /** Every login with its password, for export and health checks only. */
  #all() {
    if (this.locked) throw new Error('Your passwords are locked. Unlock them first.');
    this.touch();
    return this.data.entries.map((entry) => ({ entry, password: this.#decrypt(entry.password) }))
      .filter((item) => typeof item.password === 'string');
  }

  /**
   * Weak and reused passwords. Worked out here and returned as counts and
   * ids; no password leaves main.
   */
  health() {
    if (this.locked) return { total: 0, weak: [], reused: [], strong: 0, locked: true };
    const all = this.#all();
    const byPassword = new Map();
    for (const { entry, password } of all) byPassword.set(password, [...(byPassword.get(password) || []), entry.id]);
    const weak = all.filter(({ password }) => isWeak(password)).map(({ entry }) => entry.id);
    const reused = [...byPassword.values()].filter((ids) => ids.length > 1).flat();
    return { total: all.length, weak, reused, strong: all.length - new Set([...weak, ...reused]).size };
  }

  /**
   * Have any of these passwords appeared in a known data breach?
   *
   * Uses Have I Been Pwned's range API (k-anonymity): only the first five
   * characters of each password's SHA-1 hash are sent, the service returns
   * every hash starting with them, and the match is made here. The password,
   * and even its full hash, never leave this device. Runs only when asked.
   */
  async breachCheck(fetcher) {
    const results = [];
    const cache = new Map();
    for (const { entry, password } of this.#all()) {
      const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
      const prefix = hash.slice(0, 5);
      if (!cache.has(prefix)) {
        const response = await fetcher('https://api.pwnedpasswords.com/range/' + prefix, { headers: { 'Add-Padding': 'true' } });
        if (!response.ok) throw new Error('The breach service did not answer (' + response.status + ').');
        cache.set(prefix, await response.text());
      }
      const line = cache.get(prefix).split('\n').find((row) => row.startsWith(hash.slice(5)));
      const count = line ? Number(line.split(':')[1]) || 0 : 0;
      if (count > 0) results.push({ id: entry.id, origin: entry.origin, username: entry.username, count });
    }
    return { checked: this.#all().length, breached: results };
  }

  /** CSV in the format Chrome, Edge and Brave use: name,url,username,password,note. */
  exportCsv() {
    const quote = (value) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    const noteOf = (entry) => {
      const note = entry.note ? this.#decrypt(entry.note) : '';
      return typeof note === 'string' ? note : '';
    };
    return ['name,url,username,password,note', ...this.#all().map(({ entry, password }) =>
      [entry.title, entry.origin, entry.username, password, noteOf(entry)].map(quote).join(','))].join('\r\n') + '\r\n';
  }

  /**
   * Import a password CSV exported by Chrome, Edge, Brave, Opera, Vivaldi or
   * Firefox. Columns are found by their header names, so the order does not
   * matter.
   */
  importCsv(text) {
    const rows = parseCsv(String(text || ''));
    if (rows.length < 2) return { ok: false, error: 'That file has no passwords in it.' };
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => header.findIndex((h) => names.includes(h));
    const url = col('url', 'origin', 'login_uri', 'website', 'hostname');
    const user = col('username', 'login_username', 'login', 'email');
    const pass = col('password', 'login_password');
    const name = col('name', 'title');
    const notes = col('note', 'notes', 'extra', 'comments');
    if (url < 0 || pass < 0) return { ok: false, error: 'This does not look like a password export (no url and password columns).' };
    let added = 0;
    let skipped = 0;
    for (const row of rows.slice(1)) {
      const result = row[pass] ? this.save_credential({ url: row[url], username: user >= 0 ? row[user] : '', password: row[pass],
        title: name >= 0 ? row[name] : '', note: notes >= 0 && row[notes] ? row[notes] : undefined }) : { ok: false };
      if (result.ok) added++; else skipped++;
    }
    return { ok: true, added, skipped };
  }

  state() {
    const status = this.encryptionStatus();
    return {
      count: this.data.entries.length,
      passkeys: this.data.passkeys.length,
      encryption: status,
      // Flagged so the UI can explain rather than showing a silent failure.
      unreadable: this.data.entries.filter((entry) =>
        this.#outer(entry.password) === null).length,
      ...this.lockState(),
    };
  }

  flush() { this.save(); }

  dispose() { clearInterval(this.timer); this.key = null; }
}

/**
 * Credentials are scoped to scheme + host, not the full URL.
 *
 * The port is deliberately dropped: a site moving between :443 and a proxy
 * should not orphan a saved login. The scheme is kept, so an http:// login is
 * never offered on https:// or vice versa.
 */
function originOf(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    // Scheme, host AND port, as every browser matches logins: a server on
    // another port is a different site.
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
}

/** "github.com" -> "https://github.com": people type sites without a scheme. */
function withScheme(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text;
}

/**
 * Generate a password.
 *
 * Uses crypto.randomInt rather than Math.random - a predictable generator
 * would undermine the whole point - and rejection sampling to avoid the modulo
 * bias that makes early characters in the alphabet more likely.
 */
function generatePassword({ length = 20, symbols = true } = {}) {
  const lower = 'abcdefghijkmnopqrstuvwxyz';      // no l
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';       // no I, O
  const digits = '23456789';                       // no 0, 1
  const punctuation = '!@#$%^&*-_=+?';
  const alphabet = lower + upper + digits + (symbols ? punctuation : '');

  const size = Math.max(8, Math.min(128, Number(length) || 20));
  const out = [];
  for (let i = 0; i < size; i++) {
    out.push(alphabet[crypto.randomInt(alphabet.length)]);
  }

  // Guarantee one of each class, so a generated password always satisfies the
  // "must contain a number" rules sites impose.
  const required = [lower, upper, digits, ...(symbols ? [punctuation] : [])];
  required.forEach((set, index) => {
    out[index] = set[crypto.randomInt(set.length)];
  });

  // Shuffle so the guaranteed characters are not always at the front.
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

const COMMON = new Set(['password', '123456', '12345678', '123456789', 'qwerty', 'abc123', 'password1', '111111', 'iloveyou', 'admin', 'welcome', 'letmein', 'monkey', 'dragon', '1234567890', 'qwerty123', '000000']);

function isWeak(password) {
  const p = String(password || '');
  if (p.length < 8 || COMMON.has(p.toLowerCase())) return true;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((r) => r.test(p)).length;
  return p.length < 12 && classes < 3;
}

/** RFC 4180 CSV, including quoted fields with commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

module.exports = { Passwords, generatePassword, originOf, isWeak, parseCsv, LOCKED, LOCK_AFTER };
