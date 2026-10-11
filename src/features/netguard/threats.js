'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Safe Browsing's threat lists: real, published lists of dangerous sites,
 * downloaded and matched on this computer.
 *
 * NOTHING ABOUT BROWSING LEAVES THE COMPUTER. Google Safe Browsing and its
 * like work by asking a server about (a hash of) the address being opened;
 * these lists are fetched whole, like the Shields filter lists, and every
 * check is a lookup in memory. The only network traffic is the download of
 * the lists themselves, which says nothing about where anyone goes.
 *
 * The lists, verified live:
 *
 *   URLhaus (abuse.ch), via the malware-filter project: sites and addresses
 *   currently serving malware. The "online" edition, which is the one uBlock
 *   Origin ships - addresses already taken down are left out, so a domain
 *   cleaned up and reused does not stay flagged.
 *
 *   Phishing URL Blocklist (malware-filter): OpenPhish, PhishTank and IPThreat
 *   combined - pages built to steal sign-ins and payment details.
 *
 *   uBlock Origin's Badware risks: sites documented to push adware, fake
 *   downloads, tech-support scams and the like. Only its rules that name a
 *   whole page ($doc / $all, or a plain address) are used here; the rest of
 *   it (hiding rules, script rules) is already part of Shields.
 *
 * Both malware-filter lists are written as bare hostnames, one per line, plus
 * `||host/path^$all` for single addresses on shared hosts (one bad Google
 * Form, not all of docs.google.com). That is all this parser needs to read.
 */
const MF = ['https://malware-filter.gitlab.io/malware-filter/', 'https://curbengh.github.io/malware-filter/', 'https://malware-filter.pages.dev/'];

const LISTS = [
  {
    id: 'urlhaus', kind: 'malware', name: 'URLhaus malicious URLs',
    source: 'URLhaus by abuse.ch, via the malware-filter project',
    urls: MF.map((base) => base + 'urlhaus-filter-online.txt'),
  },
  {
    id: 'phishing', kind: 'phishing', name: 'Phishing URL Blocklist',
    source: 'OpenPhish, PhishTank and IPThreat, via the malware-filter project',
    urls: MF.map((base) => base + 'phishing-filter.txt'),
  },
  {
    id: 'badware', kind: 'badware', name: 'Badware risks',
    source: 'uBlock Origin\'s Badware risks list',
    urls: ['https://ublockorigin.github.io/uAssets/filters/badware.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt'],
  },
];

/** What each kind of threat is, in words a person can act on. */
const KINDS = {
  malware: { label: 'Malware', title: 'This site spreads harmful software' },
  phishing: { label: 'Phishing', title: 'This site is built to steal your details' },
  badware: { label: 'Unwanted software or scam', title: 'This site is known for scams and unwanted software' },
};

/** Malware lists are updated twice a day; anything older is fetched again. */
const MAX_AGE = 12 * 60 * 60 * 1000;

/** Options a whole-page rule may carry. Anything else scopes it to something narrower. */
const PAGE_OPTIONS = new Set(['all', 'doc', 'document', 'important', '1p', 'first-party']);

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

class ThreatLists {
  /**
   * @param dir    the profile directory; lists are cached under threat-lists/
   * @param store  a JsonStore-like object whose data.threatsFetched is used
   * @param fetcher (url) => Promise<string>, so probes can stand in for the network
   */
  constructor(dir, { store, fetcher }) {
    this.cacheDir = path.join(dir, 'threat-lists');
    this.store = store;
    this.fetcher = fetcher;
    this.hosts = new Map();      // host -> list id
    this.paths = new Map();      // host -> [{ rest, sep, list }]
    this.allowed = new Set();    // @@ exceptions from the lists themselves
    this.counts = {};            // list id -> entries read
    this.injected = [];          // test entries, kept across reloads
    this.refreshing = null;
    this.load();
  }

  /** Read every cached list into memory. A missing cache is simply empty. */
  load() {
    this.hosts = new Map();
    this.paths = new Map();
    this.allowed = new Set();
    this.counts = {};
    for (const list of LISTS) {
      let text = '';
      try { text = fs.readFileSync(path.join(this.cacheDir, list.id + '.txt'), 'utf8'); } catch { /* not downloaded yet */ }
      this.counts[list.id] = text ? this.#parse(text, list.id) : 0;
    }
    for (const { list, text } of this.injected) this.#parse(text, list);
    return this.total();
  }

  /** How many entries are loaded, across every list. */
  total() {
    return Object.values(this.counts).reduce((sum, n) => sum + n, 0);
  }

  /**
   * Add entries for a probe (a local test host), in memory only. They are
   * re-applied after every reload, and never written to the cache.
   */
  inject(list, text) {
    if (!LISTS.some((entry) => entry.id === list)) throw new Error('Unknown threat list: ' + list);
    this.injected.push({ list, text: String(text) });
    this.#parse(String(text), list);
  }

  #parse(text, list) {
    let added = 0;
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) continue;
      // Hiding rules (host##selector and friends) are Shields' business.
      if (/#[@?$%]?#/.test(line)) continue;
      const exception = line.startsWith('@@');
      if (exception) line = line.slice(2);

      let options = '';
      const dollar = line.lastIndexOf('$');
      if (dollar > 0) { options = line.slice(dollar + 1); line = line.slice(0, dollar); }
      if (options && !options.split(',').every((option) => PAGE_OPTIONS.has(option.trim()))) continue;

      let pattern = line.replace(/&amp;/g, '&').toLowerCase();
      if (pattern.startsWith('||')) pattern = pattern.slice(2);
      else if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/.test(pattern)) continue; // regexes, |anchors, wildcards
      if (pattern.startsWith('*') || pattern.includes('*')) continue;

      const cut = pattern.search(/[/^?:]/);
      const host = (cut === -1 ? pattern : pattern.slice(0, cut)).replace(/\.$/, '');
      if (!host || !host.includes('.') && !host.includes(':')) continue;
      let rest = cut === -1 ? '' : pattern.slice(cut);
      const sep = rest.endsWith('^');
      if (sep) rest = rest.slice(0, -1);
      if (rest === '^') rest = '';

      if (exception) { if (!rest) this.allowed.add(host); continue; }
      if (!rest) {
        if (!this.hosts.has(host)) this.hosts.set(host, list);
      } else {
        if (!this.paths.has(host)) this.paths.set(host, []);
        this.paths.get(host).push({ rest, sep, list });
      }
      added++;
    }
    return added;
  }

  /**
   * Is this address on a list? Returns { list, kind, name, source, matched }
   * or null. `matched` is the entry that matched - a host, or host and path.
   */
  match(url) {
    if (!this.hosts.size && !this.paths.size) return null;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    const rest = (parsed.pathname + parsed.search).toLowerCase();
    const withPort = parsed.port ? ':' + parsed.port + rest : '';

    // The host and every parent: a listed domain covers its subdomains, as
    // `||example.com^` does in every blocker. An IP is only ever itself.
    const candidates = [host];
    if (!isIp(host)) for (let at = host.indexOf('.'); at !== -1 && host.indexOf('.', at + 1) !== -1; at = host.indexOf('.', at + 1)) candidates.push(host.slice(at + 1));

    for (const candidate of candidates) {
      if (this.allowed.has(candidate)) return null;
      const list = this.hosts.get(candidate);
      if (list) return this.#hit(list, candidate);
      const rules = this.paths.get(candidate);
      if (!rules) continue;
      for (const rule of rules) {
        for (const target of withPort ? [rest, withPort] : [rest]) {
          if (target.startsWith(rule.rest) && (!rule.sep || boundary(target, rule.rest.length))) {
            return this.#hit(rule.list, candidate + rule.rest);
          }
        }
      }
    }
    return null;
  }

  #hit(listId, matched) {
    const list = LISTS.find((entry) => entry.id === listId);
    return { list: listId, kind: list.kind, name: list.name, source: list.source, matched };
  }

  /** Are the cached lists older than they should be? */
  stale() {
    const fetched = this.store.data.threatsFetched || 0;
    return Date.now() - fetched > MAX_AGE || LISTS.some((list) => !this.counts[list.id]);
  }

  /**
   * Download the lists, trying each list's mirrors in turn. One list failing
   * never stops the others, and a response that does not look like a list
   * never replaces a good cache: a truncated download would otherwise switch
   * protection off without anyone noticing.
   */
  refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    if (!force && !this.stale()) return Promise.resolve({ ok: true, skipped: true, entries: this.total() });
    this.refreshing = (async () => {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const results = await Promise.all(LISTS.map(async (list) => {
        for (const url of list.urls) {
          try {
            const text = await this.fetcher(url);
            const lines = text.split('\n').length;
            if (text.length < 2000 || lines < 50 || !/(^|\n)(\|\||[a-z0-9-]+\.[a-z])/.test(text)) throw new Error('response did not look like a list');
            fs.writeFileSync(path.join(this.cacheDir, list.id + '.txt'), text);
            return true;
          } catch (error) {
            console.error('safe browsing: could not fetch ' + list.id + ' from ' + new URL(url).host + ':', error.message);
          }
        }
        return false;
      }));
      const fetched = results.filter(Boolean).length;
      if (fetched) {
        this.store.data.threatsFetched = Date.now();
        this.store.save();
        this.load();
      }
      return { ok: fetched === LISTS.length, fetched, total: LISTS.length, entries: this.total() };
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** For Settings and the Health Center: what is loaded, and from when. */
  state() {
    return {
      lists: LISTS.map((list) => ({ id: list.id, name: list.name, kind: list.kind, source: list.source, entries: this.counts[list.id] || 0 })),
      entries: this.total(),
      fetchedAt: this.store.data.threatsFetched || 0,
    };
  }
}

/** `^` in a filter: the end of the address, or any character that is not part of a name. */
function boundary(text, at) {
  if (at >= text.length) return true;
  return !/[a-z0-9_.%-]/.test(text[at]);
}

module.exports = { ThreatLists, LISTS, KINDS };
