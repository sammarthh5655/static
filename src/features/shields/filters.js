/**
 * Filter-rule matching for the content blocker.
 *
 * Parses a useful subset of Adblock Plus syntax - the part that covers network
 * blocking - and matches requests against it. Deliberately NOT a full engine:
 *
 *   Supported: ||domain^ anchors, plain substrings, |prefix and suffix|
 *              anchors, * wildcards, $third-party, $script/$image/$xhr and the
 *              other common type options, $domain=a.com|~b.com, and @@
 *              exception rules.
 *   Also supported: cosmetic filters (##selector and domain##selector), which
 *              hide the element an ad would have occupied.
 *   Not supported: scriptlet injection, $redirect, $csp, regex rules, and the
 *              procedural cosmetic syntax (#?# :has(), :matches-css()).
 *
 * Cosmetic filtering matters as much as network blocking for what a person
 * actually sees. Blocking the request stops the ad loading, but without
 * hiding the container the page is left with an empty reserved box, often
 * still labelled "Advertisement". Discarding these rules was why ads still
 * looked present on ordinary sites even with blocking on.
 *
 * Performance matters because this runs on every request. Rules are bucketed
 * by a token drawn from the pattern, so a request only tests the handful of
 * rules sharing a token with its URL rather than all 50,000.
 */

/** Request types we recognise, mapped from Electron's resourceType. */
const TYPE_MAP = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

/**
 * Options that scope a rule to behaviour this engine does not implement.
 * A rule carrying one of these is marked inert rather than applied, because
 * applying it as a plain network rule would be wrong in both directions.
 */
const COSMETIC_ONLY_OPTIONS = new Set([
  'content', 'inline-script', 'inline-font',
]);

/**
 * Exception options that say what to switch OFF on a page rather than which
 * request to allow: `@@||site^$generichide` keeps site-specific hiding but
 * drops generic hiding there; `$elemhide` drops all hiding; `$document`
 * switches blocking off for the page entirely.
 */
const PAGE_FLAGS = {
  generichide: 'generichide', ghide: 'generichide',
  elemhide: 'elemhide', ehide: 'elemhide',
  specifichide: 'specifichide', shide: 'specifichide',
  document: 'document', doc: 'document',
  genericblock: 'genericblock',
};

/**
 * Options this engine does not implement, which make a rule UNSAFE to apply.
 *
 * These are not merely unsupported - ignoring them inverts what the rule
 * means. uBlock's list contains, for example:
 *
 *   *$xhr,redirect-rule=noop.txt,to=~pagead2.googlesyndication.com,from=tunein.com
 *
 * which redirects one site's requests to a stub. Dropping `from=`, `to=` and
 * `redirect-rule` leaves the bare pattern `*` with type xhr - "block every
 * XHR on the entire web". That one rule made the browser return
 * ERR_BLOCKED_BY_CLIENT for ordinary pages.
 *
 * A rule carrying any of these is marked inert, so it neither blocks nor
 * unblocks anything.
 */
const UNSUPPORTED_SCOPE_OPTIONS = new Set([
  // Rewriting a response body or a URL path: Electron's request hooks cannot.
  'rewrite', 'replace', 'uritransform', 'urlskip',
  // Scoping by things a request hook is not told.
  'ipaddress', 'header', 'permissions', 'cname', 'strict1p', 'strict3p',
  // Behavioural, not network.
  'popup', 'popunder', 'webrtc', 'badfilter', 'match-case',
]);

/** uBlock's shorthands for common redirects. */
const REDIRECT_SHORTHAND = { empty: 'empty', mp4: 'noopmp4-1s' };

const TYPE_OPTIONS = new Set([
  'document', 'subdocument', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
]);

class Rule {
  constructor({ pattern, isException, options, raw }) {
    this.raw = raw;
    this.isException = isException;
    this.domainAnchor = false;
    this.startAnchor = false;
    this.endAnchor = false;
    this.thirdParty = null;      // true = only third-party, false = only first
    this.types = null;           // Set of allowed types, or null for any
    this.excludedTypes = null;
    this.domains = null;         // Set of domains the rule applies on
    this.excludedDomains = null;
    // Set when the rule only governs behaviour this engine does not implement.
    this.inert = false;
    // For @@ rules that switch features off on a page (see PAGE_FLAGS).
    this.pageFlags = null;
    this.list = '';
    // Request-domain scoping: `to=` (and its opposite, `denyallow=`).
    this.requestDomains = null;
    this.excludedRequestDomains = null;
    this.methods = null;
    // What the rule does besides block or allow.
    this.redirect = '';        // $redirect=name: block, and serve this instead
    this.redirectRule = '';    // $redirect-rule=name: serve this IF blocked
    this.removeparam = null;   // $removeparam: '' for all, or a name or /regex/
    this.csp = null;           // $csp=directives
    this.important = false;
    this.regex = null;

    this.#applyOptions(options);
    this.pattern = this.#normalise(pattern);
    this.token = this.regex ? regexToken(pattern.slice(1, -1))
      : tokenOf(this.pattern, { startBounded: this.domainAnchor || this.startAnchor, endBounded: this.endAnchor });
  }

  #applyOptions(options) {
    if (!options) return;
    for (const option of options.split(',')) {
      const negated = option.startsWith('~');
      const body = negated ? option.slice(1) : option;
      const [name, value] = body.split('=');

      if (name === 'third-party') { this.thirdParty = !negated; continue; }
      if (name === 'first-party') { this.thirdParty = negated; continue; }
      if (name === 'important') { this.important = true; continue; }
      if (name === 'all') continue;
      if (name === 'redirect' || name === 'redirect-rule') {
        // With no value (only meaningful in an exception) it means "any".
        const resource = value === undefined ? '*' : value.split(':')[0];
        if (name === 'redirect') this.redirect = resource; else this.redirectRule = resource;
        continue;
      }
      if (REDIRECT_SHORTHAND[name]) { this.redirect = REDIRECT_SHORTHAND[name]; continue; }
      if (name === 'removeparam' || name === 'queryprune') { this.removeparam = body.slice(name.length + 1); continue; }
      if (name === 'csp') { this.csp = body.slice(4); continue; }
      if (name === 'method' && value) { this.methods = new Set(value.toLowerCase().split('|').filter((m) => !m.startsWith('~'))); continue; }
      if ((name === 'to' || name === 'denyallow') && value) {
        for (const entry of value.split('|')) {
          const exclude = name === 'denyallow' || entry.startsWith('~');
          const domain = entry.replace(/^~/, '').toLowerCase();
          if (!domain) continue;
          if (exclude) (this.excludedRequestDomains ||= new Set()).add(domain);
          else (this.requestDomains ||= new Set()).add(domain);
        }
        continue;
      }
      if ((name === 'domain' || name === 'from') && value) {
        for (const entry of value.split('|')) {
          const exclude = entry.startsWith('~');
          const domain = (exclude ? entry.slice(1) : entry).toLowerCase();
          if (!domain) continue;
          if (exclude) (this.excludedDomains ||= new Set()).add(domain);
          else (this.domains ||= new Set()).add(domain);
        }
        continue;
      }
      if (TYPE_OPTIONS.has(name)) {
        if (negated) (this.excludedTypes ||= new Set()).add(name);
        else (this.types ||= new Set()).add(name);
        continue;
      }

      // Options that scope a rule to something this engine does not implement.
      // These MUST disable the rule rather than being ignored: `$generichide`
      // and friends only lift COSMETIC hiding, so treating
      // `@@||facebook.com^$generichide` as a plain network exception silently
      // unblocks the Facebook pixel everywhere - which is exactly what it did
      // before this check existed.
      if (PAGE_FLAGS[name]) {
        if (this.isException) (this.pageFlags ||= new Set()).add(PAGE_FLAGS[name]);
        else this.inert = true;
        continue;
      }
      if (COSMETIC_ONLY_OPTIONS.has(name)) { this.inert = true; continue; }

      // Options that change WHAT a rule means, not just what it matches.
      // Dropping them turns a narrowly scoped rule into a broad one - see the
      // note on UNSUPPORTED_SCOPE_OPTIONS.
      if (UNSUPPORTED_SCOPE_OPTIONS.has(name)) { this.inert = true; continue; }
    }
  }

  #normalise(pattern) {
    let text = pattern;
    // /regex/ rules. Case-insensitive, as uBlock treats them.
    if (text.length > 2 && text.startsWith('/') && text.endsWith('/')) {
      try { this.regex = new RegExp(text.slice(1, -1), 'i'); } catch { this.inert = true; }
      return '';
    }
    if (text.startsWith('||')) { this.domainAnchor = true; text = text.slice(2); }
    else if (text.startsWith('|')) { this.startAnchor = true; text = text.slice(1); }
    if (text.endsWith('|')) { this.endAnchor = true; text = text.slice(0, -1); }

    // A trailing `?` marks where the query string begins - it is a separator,
    // not a literal question mark. Treated literally, `||google.*/pagead/lvz?`
    // demanded a `?` actually be present and so never matched the real request
    // to /pagead/lvz. `^` already means "separator or end of URL", so reusing
    // it gets the right behaviour for free.
    if (text.endsWith('?')) text = text.slice(0, -1) + '^';

    return text.toLowerCase();
  }

  /**
   * Does this rule apply to the request?
   *
   * @param {string} url        lowercased request URL
   * @param {string} host       request hostname
   * @param {string} docHost    hostname of the page making the request
   * @param {string} type       normalised resource type
   * @param {boolean} isThird   third-party request
   */
  matches(url, host, docHost, type, isThird, method) {
    // Scoped to something this engine does not implement - see `inert` above.
    if (this.inert) return false;
    if (this.methods && method && !this.methods.has(method)) return false;
    if (this.excludedRequestDomains && onDomain(host, this.excludedRequestDomains)) return false;
    if (this.requestDomains && !onDomain(host, this.requestDomains)) return false;
    if (this.thirdParty !== null && this.thirdParty !== isThird) return false;
    if (this.types && !this.types.has(type)) return false;
    if (this.excludedTypes && this.excludedTypes.has(type)) return false;

    if (this.excludedDomains && onDomain(docHost, this.excludedDomains)) return false;
    if (this.domains && !onDomain(docHost, this.domains)) return false;

    return this.#patternMatches(url, host);
  }

  #patternMatches(url, host) {
    if (this.regex) return this.regex.test(url);
    const pattern = this.pattern;
    if (!pattern) return true;

    if (this.domainAnchor) {
      // ||example.com^ matches example.com and any subdomain, but NOT
      // notexample.com - which is why this compares labels rather than
      // doing a plain substring test.
      const separator = pattern.search(/[/^*?]/);
      const domainPart = separator === -1 ? pattern : pattern.slice(0, separator);

      // A `*` inside the domain itself, as in ||google.*/pagead/lvz - the
      // multi-TLD form EasyList uses heavily (google.*, amazon.*, ebay.*).
      // Splitting on the `*` leaves domainPart as "google", which no host ends
      // with, so every one of these rules silently failed to match. Verified
      // against a live YouTube page: /pagead/lvz and /pagead/1p-user-list
      // requests were allowed through despite EasyList carrying rules for both.
      if (pattern[separator] === '*') {
        const prefix = domainPart;                  // "google."
        // The host must start the prefix at a label boundary, so
        // notgoogle.com does not match ||google.*.
        const startsAtBoundary = host === prefix || host.startsWith(prefix) ||
          host.includes('.' + prefix);
        if (!startsAtBoundary) return false;
        return wildcardIndex(url, pattern) !== -1;
      }

      if (!(host === domainPart || host.endsWith('.' + domainPart))) return false;
      if (separator === -1) return true;
      return wildcardIndex(url, pattern) !== -1;
    }

    if (this.startAnchor) return startsWithPattern(url, pattern);
    if (this.endAnchor && !pattern.includes('*')) return url.endsWith(pattern);
    return wildcardIndex(url, pattern) !== -1;
  }
}

/**
 * Is `host` one of `set`, or under one? Walks the host's own labels and asks
 * the set, rather than testing every entry in it - some rules list hundreds
 * of domains. Also matches `name.*` entries (any TLD).
 */
function onDomain(host, set) {
  let at = 0;
  while (at !== -1) {
    const suffix = host.slice(at);
    if (set.has(suffix)) return true;
    const dot = suffix.indexOf('.');
    if (dot > 0 && set.has(suffix.slice(0, dot) + '.*')) return true;
    at = host.indexOf('.', at);
    if (at !== -1) at += 1;
  }
  return false;
}

/**
 * Substring search honouring `*` wildcards and `^` separators.
 * Written by hand rather than compiled to RegExp: building 50,000 regexes is
 * slow to construct and slower to run than this for the common case.
 */
function wildcardIndex(haystack, pattern) {
  if (!pattern.includes('*') && !pattern.includes('^')) {
    return haystack.indexOf(pattern);
  }
  const segments = pattern.split('*');
  let position = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const found = indexOfWithSeparator(haystack, segment, position);
    if (found === -1) return -1;
    position = found + segment.length;
    if (i === 0 && pattern.startsWith('*')) continue;
  }
  return position;
}

/** `^` in ABP means "any separator character or end of URL". */
function indexOfWithSeparator(haystack, needle, from) {
  if (!needle.includes('^')) return haystack.indexOf(needle, from);
  const pieces = needle.split('^');
  let position = from;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece) {
      const found = haystack.indexOf(piece, position);
      if (found === -1) return -1;
      position = found + piece.length;
    }
    if (i < pieces.length - 1) {
      const next = haystack[position];
      // End of string counts as a separator.
      if (next !== undefined && !/[/:?=&^]/.test(next)) return -1;
      if (next !== undefined) position += 1;
    }
  }
  return position - needle.replace(/\^/g, '').length;
}

function startsWithPattern(url, pattern) {
  if (!pattern.includes('*')) return url.startsWith(pattern);
  return wildcardIndex(url, pattern) === 0;
}

/**
 * Pick a stable token from a pattern for bucketing.
 *
 * Any request whose URL does not contain the token cannot match the rule, so
 * bucketing by it turns a 50,000-rule scan into a few dozen comparisons.
 */
function tokenOf(pattern, { startBounded = false, endBounded = false } = {}) {
  // Three characters, not four. At four, ~1500 rules failed to produce a
  // token and fell into the generic bucket, which is scanned on EVERY request
  // - that alone was most of the matching cost.
  //
  // A request is only tested against a rule when the rule's token is one of
  // the request URL's own tokens - WHOLE runs of letters and digits. So a
  // candidate must be bounded on both sides: "banner" taken from a pattern
  // ending "/banner" would miss ".../banner42.gif", whose token is
  // "banner42". Candidates touching a `*`, or the open end of an unanchored
  // pattern, are therefore not used.
  let best = '';
  const re = /[a-z0-9%]{3,}/g;
  let m;
  while ((m = re.exec(pattern))) {
    const at = m.index;
    const end = at + m[0].length;
    const leftOk = at === 0 ? startBounded : pattern[at - 1] !== '*';
    const rightOk = end === pattern.length ? endBounded : pattern[end] !== '*';
    if (leftOk && rightOk && m[0].length > best.length) best = m[0];
  }
  // The longest bounded token is the most selective.
  return best;
}

/**
 * A token every URL matching this regex must contain, or '' when none can be
 * proved. Only literal runs outside groups, classes and alternations count,
 * and a character made optional by ?, * or {0 is dropped - a token that is
 * not truly required would make the rule miss requests.
 */
function regexToken(source) {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    else if (source[i] === '|' && depth === 0) return '';
  }
  // Walk the pattern as a sequence of pieces. A run of literal letters and
  // digits is usable only when a literal non-alphanumeric character (or an
  // anchor) sits on BOTH sides of it, for the same reason as in tokenOf.
  const runs = [];
  let run = '';
  let leftBounded = true;          // the start of the URL, if ^-anchored
  if (source[0] !== '^') leftBounded = false;
  const flush = (rightBounded) => {
    if (run.length >= 3 && leftBounded && rightBounded) runs.push(run);
    run = '';
  };
  for (let i = source[0] === '^' ? 1 : 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '\\') {
      const escaped = source[i + 1] || '';
      i++;
      // \. \/ \- are literal punctuation: a boundary. \d \w \s are classes.
      const literal = !/[a-z0-9]/i.test(escaped);
      flush(literal);
      leftBounded = literal;
      continue;
    }
    if (/[a-z0-9%]/i.test(c)) {
      if (next === '?' || next === '*' || (next === '{' && source[i + 2] === '0')) { flush(false); leftBounded = false; i++; continue; }
      run += c.toLowerCase();
      continue;
    }
    if (c === '$') { flush(true); leftBounded = false; continue; }
    if (c === '[' || c === '(' || c === '.' || c === '+' || c === '*' || c === '?' || c === '{' || c === '^') {
      flush(false);
      leftBounded = false;
      if (c === '[') { while (i < source.length && source[i] !== ']') { if (source[i] === '\\') i++; i++; } }
      else if (c === '(') {
        let d = 1;
        i++;
        while (i < source.length && d > 0) { if (source[i] === '\\') i++; else if (source[i] === '(') d++; else if (source[i] === ')') d--; i++; }
        i--;
      } else if (c === '{') { while (i < source.length && source[i] !== '}') i++; }
      continue;
    }
    // Any other literal character (/ - _ = & , :) is a boundary.
    flush(true);
    leftBounded = true;
  }
  flush(false);
  const useful = runs.filter((r) => !['http', 'https', 'www'].includes(r));
  return useful.reduce((best, r) => (r.length > best.length ? r : best), '');
}

/** Parse one filter-list line. Returns null for comments and cosmetic rules. */
function parseRule(line) {
  const text = line.trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return null;
  // Cosmetic filters are out of scope - see the note at the top of this file.
  // Cosmetic rules are handled separately by parseCosmetic, not here.
  if (text.includes('##') || text.includes('#@#') || text.includes('#?#')) return null;

  let body = text;
  const isException = body.startsWith('@@');
  if (isException) body = body.slice(2);

  let options = '';
  // Options follow the LAST `$` that is not inside a regex's own slashes.
  const regexEnd = body.startsWith('/') ? body.lastIndexOf('/') : -1;
  const dollar = body.lastIndexOf('$');
  if (dollar >= 0 && dollar > regexEnd) {
    const maybe = body.slice(dollar + 1);
    // Only treat it as options if it looks like them, not a URL fragment.
    // removeparam and csp values may carry more (regex, spaces, quotes).
    if (/^[a-z~][a-z0-9~,=|._:-]*$/i.test(maybe) || /(^|,)(removeparam|queryprune|csp)(=|,|$)/.test(maybe)) {
      options = maybe;
      body = body.slice(0, dollar);
    }
  }
  // A plain path filter like /ads/banner.js starts with a slash but is not a
  // regex; only /pattern/ (slashes at BOTH ends) is.
  if (!body) body = '*';

  const rule = new Rule({ pattern: body === '*' ? '' : body, isException, options, raw: text });
  // A rule with no pattern matches every URL. That is only meaningful when
  // something else narrows it (a site, a request domain) or when it modifies
  // rather than blocks; a bare one would block the whole web.
  if (!rule.pattern && !rule.regex && !rule.domains && !rule.requestDomains && !rule.pageFlags &&
      rule.removeparam === null && rule.csp === null && !rule.redirectRule) return null;
  return rule;
}

/**
 * A compiled list of rules, bucketed by token.
 */
/**
 * Parse a cosmetic rule.
 *
 * Handles the two plain forms:
 *   ##.ad-banner            generic - applies everywhere
 *   example.com##.sponsor   domain-scoped, comma-separated domain list
 *
 * Returns null for anything else, which deliberately includes:
 *   #@#  exception rules (unhiding), which need the generic set resolved first
 *   #?#  and #$# procedural/style rules, whose syntax is not plain CSS and
 *        would throw if handed to insertCSS
 *
 * A selector is rejected unless it looks like plain CSS. Anything from a
 * downloaded list ends up inside a stylesheet this app injects, so a
 * malformed or hostile selector must not be able to break out of it - hence
 * no braces, no at-rules, no comment sequences.
 */
function parseCosmetic(line) {
  const text = String(line).trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return null;
  if (text.includes('#@#') || text.includes('#?#') || text.includes('#$#')) return null;

  const at = text.indexOf('##');
  if (at === -1) return null;

  const selector = text.slice(at + 2).trim();
  if (!selector || selector.length > 400) return null;
  // Must be plain CSS: no rule-set punctuation, no at-rules, no comments.
  if (/[{}]/.test(selector)) return null;
  if (selector.includes('/*') || selector.includes('@') || selector.includes('\\')) return null;

  const scope = text.slice(0, at).trim();
  if (!scope) return { selector, domains: null };

  // A domain list may contain exclusions (~a.com). Those only make sense
  // alongside an included domain, and treating one as an inclusion would hide
  // the element on exactly the site the list meant to spare - so skip them.
  const domains = scope.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length || domains.some((d) => d.startsWith('~'))) return null;
  if (domains.some((d) => !/^[a-z0-9.*-]+$/.test(d))) return null;

  return { selector, domains };
}

const { CosmeticIndex } = require('./cosmetic');

/**
 * A set of network rules, indexed three ways so a request tests only rules
 * that could possibly match it:
 *   - by a token its URL must contain (most rules);
 *   - by the site it is limited to (`*$script,3p,domain=a.com` has no URL
 *     token, but only ever applies on a.com);
 *   - the small remainder, tested on every request.
 */
class RuleSet {
  constructor() {
    this.buckets = new Map();
    this.byDomain = new Map();
    this.generic = [];
    this.size = 0;
  }

  add(rule) {
    this.size++;
    if (rule.token) {
      if (!this.buckets.has(rule.token)) this.buckets.set(rule.token, []);
      this.buckets.get(rule.token).push(rule);
    } else if (rule.domains && rule.domains.size) {
      for (const domain of rule.domains) {
        if (!this.byDomain.has(domain)) this.byDomain.set(domain, []);
        this.byDomain.get(domain).push(rule);
      }
    } else {
      this.generic.push(rule);
    }
  }

  find(tokens, pageKeys, url, host, page, type, isThird, method) {
    for (const token of tokens) {
      const bucket = this.buckets.get(token);
      if (!bucket) continue;
      for (const rule of bucket) if (rule.matches(url, host, page, type, isThird, method)) return rule;
    }
    for (const key of pageKeys) {
      const list = this.byDomain.get(key);
      if (!list) continue;
      for (const rule of list) if (rule.matches(url, host, page, type, isThird, method)) return rule;
    }
    for (const rule of this.generic) if (rule.matches(url, host, page, type, isThird, method)) return rule;
    return null;
  }
}

/** The keys a page's host is listed under: itself, parents, and name.* forms. */
function domainKeys(host) {
  const keys = [];
  let at = 0;
  while (at !== -1 && host) {
    const suffix = host.slice(at);
    keys.push(suffix);
    const dot = suffix.indexOf('.');
    if (dot > 0) keys.push(suffix.slice(0, dot) + '.*');
    at = host.indexOf('.', at);
    if (at !== -1) at += 1;
  }
  return keys;
}

class FilterEngine {
  constructor() {
    this.block = new RuleSet();
    this.allow = new RuleSet();
    this.count = 0;
    /** CSS, procedural rules, scriptlets and their exceptions. */
    this.cosmetic = new CosmeticIndex();
    this.cosmeticCount = 0;
    /** @@ rules that switch features off on matching pages. */
    this.pageExceptions = [];
    // $important rules, kept apart so the ordinary search can stop at its
    // first match and only this small set is searched to the end.
    this.importantBlock = new RuleSet();
    this.importantAllow = new RuleSet();
    // Rules that modify rather than block, and their exceptions.
    this.redirectRules = [];
    /** Named $removeparam rules by parameter; the rest are scanned. */
    this.removeParamByName = new Map();
    this.removeParamRules = [];
    this.cspRules = [];
    this.modifierExceptions = [];
  }

  /**
   * @param {string} text
   * @param {{ id?: string, trusted?: boolean }} source - where the list came
   *   from, recorded on each rule for the logger, and whether it may use
   *   privileged (`trusted-*`) scriptlets.
   */
  addList(text, source = {}) {
    for (const line of String(text).split('\n')) {
      // Cosmetic rules outnumber network rules several times over in these
      // lists, so test for them first and skip the network parse entirely.
      if (line.includes('#@#') || line.includes('##') || line.includes('#?#') || line.includes('#$#')) {
        if (this.cosmetic.add(line, source)) this.cosmeticCount++;
        continue;
      }
      const rule = parseRule(line);
      if (!rule) continue;
      rule.list = source.id || '';
      if (rule.pageFlags) { this.pageExceptions.push(rule); continue; }
      if (rule.inert) continue;
      // Exceptions to a modifier (@@...$redirect, $removeparam, $csp) cancel
      // only that modifier. Filing them with the ordinary exceptions would
      // turn them into a full unblock.
      if (rule.isException && (rule.redirect || rule.redirectRule || rule.removeparam !== null || rule.csp !== null)) {
        this.modifierExceptions.push(rule); continue;
      }
      if (rule.redirectRule) { this.redirectRules.push(rule); continue; }
      if (rule.removeparam !== null) {
        const simple = /^[\w.-]+$/.test(rule.removeparam) ? rule.removeparam : '';
        if (simple) {
          if (!this.removeParamByName.has(simple)) this.removeParamByName.set(simple, []);
          this.removeParamByName.get(simple).push(rule);
        } else this.removeParamRules.push(rule);
        continue;
      }
      if (rule.csp !== null) { this.cspRules.push(rule); continue; }
      if (rule.important) (rule.isException ? this.importantAllow : this.importantBlock).add(rule);
      else (rule.isException ? this.allow : this.block).add(rule);
      this.count++;
    }
    return this.count;
  }

  /**
   * Test the rules that could possibly match, without building an
   * intermediate array. Spreading every bucket into a new array allocated on
   * every single request, which is the kind of cost that only shows up once a
   * page makes four hundred of them.
   *
   * @returns {object|null} the matching rule, or null
   */
  /** Is there an exception cancelling this modifier here? */
  #modifierExcepted(kind, value, url, host, page, type, isThird) {
    return this.modifierExceptions.some((rule) => {
      const has = kind === 'redirect' ? (rule.redirect || rule.redirectRule) : kind === 'removeparam' ? rule.removeparam !== null : rule.csp !== null;
      if (!has) return false;
      const ruleValue = kind === 'redirect' ? (rule.redirect || rule.redirectRule) : kind === 'removeparam' ? rule.removeparam : rule.csp;
      if (ruleValue && ruleValue !== '*' && value && ruleValue !== value) return false;
      return rule.matches(url, host, page, type, isThird);
    });
  }

  /**
   * @returns {{blocked: boolean, rule: string|null}}
   */
  match({ url, docHost, resourceType, method }) {
    const lower = String(url).toLowerCase();
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return { blocked: false, rule: null }; }

    const type = TYPE_MAP[resourceType] || 'other';
    const page = String(docHost || '').toLowerCase();
    const isThird = !!page && host !== page && !host.endsWith('.' + page) && !page.endsWith('.' + host);
    const verb = method ? String(method).toLowerCase() : '';

    // Tokenise once and reuse for every pass.
    const tokens = lower.match(/[a-z0-9%]{3,}/g) || [];

    const keys = domainKeys(page);
    const importantBlock = this.importantBlock.find(tokens, keys, lower, host, page, type, isThird, verb);
    const importantAllow = importantBlock && this.importantAllow.find(tokens, keys, lower, host, page, type, isThird, verb);
    // $important beats an ordinary exception; only an important exception
    // beats it back.
    let block = importantAllow ? null : importantBlock;
    let allow = importantAllow || null;
    if (!block && !allow) {
      // Most requests match nothing, so exceptions are only looked for once
      // a blocking rule has matched.
      block = this.block.find(tokens, keys, lower, host, page, type, isThird, verb);
      if (block) {
        allow = this.allow.find(tokens, keys, lower, host, page, type, isThird, verb);
        if (allow) block = null;
      }
    }
    if (!block) {
      const cleaned = this.#removeParams(url, lower, host, page, type, isThird, tokens);
      return { blocked: false, rule: allow ? allow.raw : null, list: allow?.list, allowed: !!allow, removeparam: cleaned };
    }
    let redirect = block.redirect;
    if (!redirect) {
      const directive = this.redirectRules.find((rule) => rule.matches(lower, host, page, type, isThird, verb));
      redirect = directive ? directive.redirectRule : '';
    }
    if (redirect && this.#modifierExcepted('redirect', redirect, lower, host, page, type, isThird)) redirect = '';
    return { blocked: true, rule: block.raw, list: block.list, redirect };
  }

  /** The URL with tracking parameters removed, when a $removeparam rule applies. */
  #removeParams(url, lower, host, page, type, isThird) {
    if (!lower.includes('?')) return '';
    let parsed;
    try { parsed = new URL(url); } catch { return ''; }
    let changed = false;
    const candidates = [...this.removeParamRules];
    for (const key of parsed.searchParams.keys()) {
      const named = this.removeParamByName.get(key);
      if (named) candidates.push(...named);
    }
    for (const rule of candidates) {
      if (!rule.matches(lower, host, page, type, isThird)) continue;
      if (this.#modifierExcepted('removeparam', rule.removeparam, lower, host, page, type, isThird)) continue;
      const spec = rule.removeparam;
      const negate = spec.startsWith('~');
      const body = negate ? spec.slice(1) : spec;
      const re = body.startsWith('/') && body.lastIndexOf('/') > 0 ? (() => { try { return new RegExp(body.slice(1, body.lastIndexOf('/')), body.slice(body.lastIndexOf('/') + 1).replace('g', '')); } catch { return null; } })() : null;
      for (const [key, value] of [...parsed.searchParams]) {
        const hit = !body ? true : re ? re.test(key + '=' + value) : key === body;
        if (hit !== negate) { parsed.searchParams.delete(key); changed = true; }
      }
    }
    return changed ? parsed.toString() : '';
  }

  /** CSP directives the lists add to this document. */
  cspFor(url, docHost, resourceType) {
    const type = TYPE_MAP[resourceType] || 'other';
    if (type !== 'document' && type !== 'subdocument') return [];
    const lower = String(url).toLowerCase();
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return []; }
    const page = String(docHost || host).toLowerCase();
    if (this.pageFlagsFor(url).has('document')) return [];
    return [...new Set(this.cspRules
      .filter((rule) => rule.csp && rule.matches(lower, host, page, type, false))
      .filter((rule) => !this.#modifierExcepted('csp', rule.csp, lower, host, page, type, false))
      .map((rule) => rule.csp))];
  }

  /**
   * CSS hiding every ad container known for this host.
   *
   * Generic rules plus those scoped to the host or any parent domain, so a
   * rule written for `example.com` also applies on `news.example.com`.
   *
   * The result is cached per host: the generic set alone runs to tens of
   * thousands of selectors, and rebuilding that string on every navigation
   * would be pure waste.
   */
  cosmeticFor(host, url) {
    const flags = url ? this.pageFlagsFor(url) : new Set();
    if (flags.has('elemhide') || flags.has('document')) return '';
    return this.cosmetic.forHost(String(host || ''), { generic: !flags.has('generichide') }).css;
  }

  /** Everything a page needs beyond network blocking. */
  pageRules(host, url) {
    const flags = this.pageFlagsFor(url || ('https://' + host + '/'));
    if (flags.has('document')) return { css: '', procedural: [], scriptlets: [], flags: [...flags] };
    const all = this.cosmetic.forHost(String(host || ''), { generic: !flags.has('generichide') });
    const hide = !flags.has('elemhide');
    return {
      css: hide ? all.css : '',
      procedural: hide ? all.procedural : [],
      scriptlets: all.scriptlets,
      flags: [...flags],
    };
  }

  /** Which page-level switches the lists turn off for this page. */
  pageFlagsFor(url) {
    const flags = new Set();
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return flags; }
    const lower = String(url).toLowerCase();
    for (const rule of this.pageExceptions) {
      if (rule.matches(lower, host, host, 'document', false)) for (const f of rule.pageFlags) flags.add(f);
    }
    return flags;
  }
}

module.exports = { FilterEngine, parseRule, parseCosmetic, Rule, tokenOf, regexToken, TYPE_MAP };
