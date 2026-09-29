'use strict';

/**
 * Cosmetic filtering: everything after `##` in a filter list.
 *
 * A list line after the domain part is one of four quite different things,
 * and they must never be mixed:
 *
 *   ##.ad-box                  plain CSS: hidden with a stylesheet
 *   ##.box:has-text(Sponsored) procedural: not CSS at all, run in the page
 *   ##+js(set-constant, x, 0)  a scriptlet: JavaScript, run at document start
 *   #@#.ad-box                 an exception: do NOT hide this here
 *
 * Mixing them is what silently disabled hiding on most of the web: all of a
 * site's selectors were joined into one CSS rule, and CSS drops the WHOLE
 * rule when any one selector is invalid. 25,389 of 32,717 sites with rules -
 * YouTube, Reddit, Facebook, X among them - had a `+js(...)` or `:has-text`
 * line in theirs, so the stylesheet for those sites hid nothing at all.
 */

/** uBlock and AdGuard/ABP extended pseudo-classes: never plain CSS. */
const PROCEDURAL = /:(?:has-text|contains|-abp-contains|-abp-has|upward|nth-ancestor|remove|remove-attr|remove-class|style|matches-css(?:-before|-after)?|matches-attr|matches-media|matches-path|matches-prop|min-text-length|others|watch-attr|xpath|if|if-not)\(/;

const SEPARATORS = ['#@?#', '#@$#', '#@#', '#?#', '#$#', '##'];

/** Split a domain list into included and excluded names. */
function parseDomains(text) {
  const include = [];
  const exclude = [];
  for (const raw of String(text || '').split(',')) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (!/^~?[a-z0-9.*-]+$/.test(d)) return null;
    if (d.startsWith('~')) exclude.push(d.slice(1)); else include.push(d);
  }
  return { include, exclude };
}

/**
 * Classify one line.
 * @returns {null | {kind: 'css'|'procedural'|'scriptlet', exception: boolean, body: string, include: string[], exclude: string[]}}
 */
function parseLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return null;
  let at = -1;
  let separator = '';
  for (const s of SEPARATORS) {
    const i = text.indexOf(s);
    if (i !== -1 && (at === -1 || i < at || (i === at && s.length > separator.length))) { at = i; separator = s; }
  }
  if (at === -1) return null;
  const domains = parseDomains(text.slice(0, at));
  if (!domains) return null;
  const body = text.slice(at + separator.length).trim();
  if (!body || body.length > 2000) return null;
  const exception = separator.includes('@');

  if (body.startsWith('+js(') && body.endsWith(')')) {
    return { kind: 'scriptlet', exception, body: body.slice(4, -1).trim(), ...domains };
  }
  // AdGuard/ABP snippets (#$#abort-on-property-read ...) are a different
  // language from uBlock scriptlets; only #$# CSS-with-style is understood.
  if (separator.includes('$')) {
    const style = body.match(/^(.+?)\s*\{\s*([^{}]+)\s*\}$/);
    if (!style) return null;
    return { kind: 'procedural', exception, body: style[1].trim() + ':style(' + style[2].trim() + ')', ...domains };
  }
  if (separator.includes('?') || PROCEDURAL.test(body)) {
    return { kind: 'procedural', exception, body, ...domains };
  }
  // Plain CSS must be exactly that: no rule-set punctuation, no at-rules, no
  // comments, because it ends up inside a stylesheet this browser injects.
  if (/[{}]/.test(body) || body.includes('/*') || /(^|[^\\])@/.test(body)) return null;
  return { kind: 'css', exception, body, ...domains };
}

/** Every key a host is known by: itself, its parents, and `name.*` forms. */
function hostKeys(host) {
  const clean = String(host || '').toLowerCase().replace(/^www\./, '');
  const parts = clean.split('.');
  const keys = [];
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join('.');
    keys.push(suffix);
    if (i < parts.length - 1) keys.push(parts[i] + '.*');
  }
  return keys;
}

function onAny(keys, domains) {
  return domains.some((d) => keys.includes(d));
}

class CosmeticIndex {
  constructor() {
    this.byKind = { css: new Map(), procedural: new Map(), scriptlet: new Map() };
    this.generic = { css: [], procedural: [], scriptlet: [] };
    this.exceptions = { css: new Map(), procedural: new Map(), scriptlet: new Map() };
    this.genericExceptions = { css: new Set(), procedural: new Set(), scriptlet: new Set() };
    this.counts = { css: 0, procedural: 0, scriptlet: 0, exception: 0 };
    this.cache = new Map();
  }

  /**
   * @param {string} line
   * @param {{ trusted?: boolean }} source - only trusted lists may use the
   *   `trusted-*` scriptlets, which can rewrite responses and set any value.
   */
  add(line, source = {}) {
    const rule = parseLine(line);
    if (!rule) return false;
    if (rule.kind === 'scriptlet' && /^['"]?trusted-/.test(rule.body) && !source.trusted) return false;
    const record = { body: rule.body, exclude: rule.exclude };
    if (rule.exception) {
      this.counts.exception++;
      if (!rule.include.length) { this.genericExceptions[rule.kind].add(rule.body); return true; }
      for (const d of rule.include) {
        if (!this.exceptions[rule.kind].has(d)) this.exceptions[rule.kind].set(d, new Set());
        this.exceptions[rule.kind].get(d).add(rule.body);
      }
      return true;
    }
    this.counts[rule.kind]++;
    if (!rule.include.length) { this.generic[rule.kind].push(record); return true; }
    for (const d of rule.include) {
      if (!this.byKind[rule.kind].has(d)) this.byKind[rule.kind].set(d, []);
      this.byKind[rule.kind].get(d).push(record);
    }
    return true;
  }

  /** The rules of one kind that apply on a host, after exclusions and exceptions. */
  #collect(kind, keys, { generic = true } = {}) {
    const out = new Set();
    const consider = (record) => { if (!record.exclude.length || !onAny(keys, record.exclude)) out.add(record.body); };
    if (generic) for (const record of this.generic[kind]) consider(record);
    for (const key of keys) for (const record of this.byKind[kind].get(key) || []) consider(record);
    for (const body of this.genericExceptions[kind]) out.delete(body);
    for (const key of keys) for (const body of this.exceptions[kind].get(key) || []) out.delete(body);
    return out;
  }

  /**
   * Everything cosmetic for one host.
   * @param {{ generic?: boolean }} options  false when the page is excepted
   *   from generic hiding ($generichide)
   */
  forHost(host, { generic = true } = {}) {
    const cacheKey = host + '|' + generic;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const keys = hostKeys(host);
    const css = [...this.#collect('css', keys, { generic })];
    // An empty `#@#+js()` on a site switches off every scriptlet there.
    const allScriptletsOff = keys.some((k) => this.exceptions.scriptlet.get(k)?.has('')) || this.genericExceptions.scriptlet.has('');
    const result = {
      css: chunkCss(css),
      selectorCount: css.length,
      procedural: [...this.#collect('procedural', keys, { generic })],
      scriptlets: allScriptletsOff ? [] : [...this.#collect('scriptlet', keys)],
    };
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(cacheKey, result);
    return result;
  }
}

/**
 * Selectors as CSS, in small rules so that one selector a browser rejects
 * costs its own chunk, not the whole page's hiding.
 */
function chunkCss(selectors, size = 60) {
  const rules = [];
  for (let i = 0; i < selectors.length; i += size) {
    rules.push(selectors.slice(i, i + size).join(',\n') + ' { display: none !important; }');
  }
  return rules.join('\n');
}

module.exports = { CosmeticIndex, parseLine, hostKeys, chunkCss, PROCEDURAL };
