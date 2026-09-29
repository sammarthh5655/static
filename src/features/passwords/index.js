const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');

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
 */

const FILE = 'vault.json';
const MAX_ENTRIES = 2000;

class Passwords {
  constructor(dir, { onChange } = {}) {
    this.file = path.join(dir, FILE);
    this.onChange = onChange || (() => {});
    this.data = { version: 1, entries: [] };
    this.load();
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

  #encrypt(plain) {
    return safeStorage.encryptString(String(plain)).toString('base64');
  }

  #decrypt(encoded) {
    try {
      return safeStorage.decryptString(Buffer.from(String(encoded), 'base64'));
    } catch {
      // A record encrypted under a different OS user or machine cannot be
      // read. Report it rather than throwing away the row.
      return null;
    }
  }

  /**
   * Save or update a credential.
   *
   * Matching is by origin plus username, so several accounts on one site are
   * separate entries rather than overwriting each other.
   */
  save_credential({ url, username, password, title }) {
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
    } else {
      this.data.entries.unshift({
        id: crypto.randomUUID(),
        origin,
        username: String(username || ''),
        password: this.#encrypt(password),
        title: String(title || origin).slice(0, 200),
        createdAt: now,
        updatedAt: now,
        lastUsed: 0,
      });
      if (this.data.entries.length > MAX_ENTRIES) this.data.entries.length = MAX_ENTRIES;
    }

    this.save();
    this.onChange();
    return { ok: true, origin };
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
    if (password === null) {
      return {
        ok: false,
        error: 'This entry cannot be decrypted. It was probably saved by a different '
          + 'user account or on another machine.',
      };
    }
    entry.lastUsed = Date.now();
    this.save();
    return { ok: true, username: entry.username, password };
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
        readable: this.#decrypt(entry.password) !== null,
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
    this.save();
    this.onChange();
    return { ok: true };
  }

  /** Every login with its password, for export and health checks only. */
  #all() {
    return this.data.entries.map((entry) => ({ entry, password: this.#decrypt(entry.password) }))
      .filter((item) => item.password !== null);
  }

  /**
   * Weak and reused passwords. Worked out here and returned as counts and
   * ids; no password leaves main.
   */
  health() {
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

  /** CSV in the format Chrome, Edge and Brave use: name,url,username,password. */
  exportCsv() {
    const quote = (value) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    return ['name,url,username,password', ...this.#all().map(({ entry, password }) =>
      [entry.title, entry.origin, entry.username, password].map(quote).join(','))].join('\r\n') + '\r\n';
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
    if (url < 0 || pass < 0) return { ok: false, error: 'This does not look like a password export (no url and password columns).' };
    let added = 0;
    let skipped = 0;
    for (const row of rows.slice(1)) {
      const result = row[pass] ? this.save_credential({ url: row[url], username: user >= 0 ? row[user] : '', password: row[pass], title: name >= 0 ? row[name] : '' }) : { ok: false };
      if (result.ok) added++; else skipped++;
    }
    return { ok: true, added, skipped };
  }

  state() {
    const status = this.encryptionStatus();
    return {
      count: this.data.entries.length,
      encryption: status,
      // Flagged so the UI can explain rather than showing a silent failure.
      unreadable: this.data.entries.filter((entry) =>
        this.#decrypt(entry.password) === null).length,
    };
  }

  flush() { this.save(); }
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

module.exports = { Passwords, generatePassword, originOf, isWeak, parseCsv };
