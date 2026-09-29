const fs = require('node:fs');
const path = require('node:path');

/**
 * Brave's scriptlet library, used under MPL-2.0.
 *
 * WHAT THIS IS
 * `resources.json` is taken from brave/adblock-rust (data/brave/
 * brave-resources.json), reduced to the JavaScript scriptlets and the `empty`
 * stub. These are the same scriptlets uBlock Origin and Brave inject to
 * neutralise ads in the page, and they are the half of Brave's blocker that
 * Electron can actually run.
 *
 * WHY NOT THE ENGINE ITSELF
 * adblock-rust is a Rust crate compiled to a native Node addon. It makes rule
 * MATCHING faster; it does not block anything the current matcher cannot. The
 * ads that survive on YouTube are not a matching problem - they arrive inside
 * a player response that the network layer cannot rewrite (see
 * docs/adblock-architecture.md). The scriptlets below are what deals with
 * those, so they are what was worth taking.
 *
 * HOW A RULE REACHES A PAGE
 * A cosmetic rule of the form
 *
 *     example.com##+js(json-prune, adPlacements adSlots)
 *
 * names a scriptlet and its arguments. `scriptFor` looks the scriptlet up,
 * appends a call with those arguments, and the result is injected into the
 * page's main world at document-start.
 *
 * SAFETY
 * Arguments come from filter list text, which is data we download. They are
 * serialised with JSON.stringify rather than interpolated, so a malformed or
 * hostile rule cannot break out of the argument list and run its own code.
 */

/** Scriptlets every injection needs, because the others call into them. */
const PRELUDE = ['safe-self.fn'];

let cache = null;

/** Load and index the library. Read once, then kept in memory. */
function library() {
  if (cache) return cache;
  const byName = new Map();
  try {
    const file = path.join(__dirname, 'resources.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Brave's own additions (brave-fix.js, brave-yt-sabr-fix.js ...), which
    // Brave's list rules inject by name. Made by scripts/make-redirects.cjs.
    try { list.push(...JSON.parse(fs.readFileSync(path.join(__dirname, 'brave-extra.json'), 'utf8'))); } catch { /* optional */ }
    for (const entry of list) {
      if (!entry || !entry.name || !entry.body) continue;
      const source = Buffer.from(entry.body, 'base64').toString('utf8');
      const record = { name: entry.name, source };
      byName.set(entry.name, record);
      // uBlock rules name scriptlets with and without the .js, and by alias.
      byName.set(entry.name.replace(/\.js$/, ''), record);
      for (const alias of entry.aliases || []) {
        byName.set(alias, record);
        byName.set(String(alias).replace(/\.js$/, ''), record);
      }
    }
  } catch (error) {
    // A missing or corrupt library must not stop the browser blocking
    // anything else.
    console.error('shields: could not load Brave resources:', error.message);
  }
  cache = byName;
  return cache;
}

/** Is this scriptlet available? */
function has(name) { return library().has(String(name || '').trim()); }

/** How many scriptlets are loaded. Reported in Settings. */
function count() {
  // The map holds aliases too, so count distinct sources.
  return new Set([...library().values()].map((entry) => entry.name)).size;
}

/**
 * Split a `+js(...)` argument string into its arguments.
 *
 * uBlock's own rules contain commas inside quoted strings and regular
 * expressions, so a plain split on ',' corrupts them.
 */
function splitArgs(raw) {
  const args = [];
  let current = '';
  let quote = null;
  let inRegex = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { current += char; escaped = true; continue; }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (inRegex) {
      current += char;
      if (char === '/') inRegex = false;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    // A '/' only opens a regex at the start of an argument.
    if (char === '/' && current.trim() === '') { inRegex = true; current += char; continue; }
    if (char === ',') { args.push(current.trim()); current = ''; continue; }
    current += char;
  }
  args.push(current.trim());
  return args.filter((arg, index) => arg !== '' || index === 0);
}

/** Strip the quotes uBlock arguments are sometimes written with. */
function unquote(value) {
  const text = String(value);
  if (text.length > 1 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Build the injectable source for one `+js(name, args...)` rule.
 *
 * @returns {string} JavaScript, or '' when the scriptlet is not in the library
 */
function scriptFor(spec) {
  const text = String(spec || '').trim();
  if (!text) return '';

  const args = splitArgs(text);
  const name = unquote(args.shift() || '').trim();
  const entry = library().get(name);
  if (!entry) return '';

  // Arguments are DATA. Serialising them means a filter rule cannot close the
  // call and append statements of its own.
  const callArgs = args.map((arg) => JSON.stringify(unquote(arg))).join(', ');

  // The function is declared by the scriptlet body; the call is appended. Each
  // scriptlet runs in its own scope so two of them cannot collide on a name.
  const fn = entry.source.match(/^\s*function\s+([A-Za-z0-9_$]+)/);
  if (!fn) {
    // The older template form Brave's own resources use: a plain script with
    // {{1}}, {{2}} placeholders inside string literals. Arguments are
    // escaped for a JavaScript string, so one cannot end the string early.
    const values = args.map((arg) => JSON.stringify(unquote(arg)).slice(1, -1));
    const filled = entry.source.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? '');
    return '(function(){\ntry{\n' + filled + '\n}catch(e){}\n})();';
  }

  // Helpers are placed INSIDE the wrapper with the scriptlet that needs them.
  // Hoisting them to the top of the bundle would leave them out of scope,
  // and the resulting ReferenceError is swallowed by the scriptlet's own
  // try/catch - the page looks fine and nothing is blocked.
  const helpers = resolveDependencies([entry.source]);
  // uBlock's injector defines `scriptletGlobals` around every scriptlet, and
  // safeSelf() - which nearly all of them call first - reads it. Without it
  // each scriptlet threw a ReferenceError on its first line, which its own
  // try/catch swallowed: every Brave scriptlet, YouTube's included, silently
  // did nothing.
  return '(function(){\nconst scriptletGlobals = {};\n' + helpers.join('\n') + '\n' + entry.source +
    '\ntry{ ' + fn[1] + '(' + callArgs + '); }catch(e){}\n})();';
}

/**
 * Dependency resolution.
 *
 * uBlock's scriptlets are split into a scriptlet plus a set of `.fn` helper
 * modules - json-prune alone calls safeSelf, objectPruneFn, proxyApplyFn and
 * several more. Injecting the scriptlet on its own throws a ReferenceError at
 * the first call, which its own try/catch swallows: the page looks perfectly
 * normal and nothing is blocked. So helpers are resolved and shipped with it.
 */

/** Names that are the language or the DOM rather than another module. */
const BUILT_IN = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'JSON', 'Object', 'Array', 'String', 'Number', 'Math', 'RegExp', 'Error',
  'Boolean', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect',
  'Symbol', 'Date', 'console', 'window', 'document', 'location', 'navigator',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURIComponent',
  'encodeURIComponent', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'requestAnimationFrame', 'fetch',
  'XMLHttpRequest', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
  'TextDecoder', 'TextEncoder', 'Element', 'Node', 'MutationObserver',
]);

/** Index of function name -> the module that defines it. */
let definitions = null;

function definitionIndex() {
  if (definitions) return definitions;
  definitions = new Map();
  for (const entry of new Set(library().values())) {
    for (const match of entry.source.matchAll(/(?:^|\n)\s*function\s+([A-Za-z0-9_$]+)/g)) {
      if (!definitions.has(match[1])) definitions.set(match[1], entry);
    }
  }
  return definitions;
}

/** Every identifier a source calls that it does not itself define. */
function externalCalls(source) {
  const defined = new Set(
    [...source.matchAll(/function\s+([A-Za-z0-9_$]+)/g)].map((match) => match[1]));
  const called = new Set(
    [...source.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((match) => match[1]));
  return [...called].filter((name) => !defined.has(name) && !BUILT_IN.has(name));
}

/**
 * Collect the helpers a set of sources needs, following the chain.
 *
 * Bounded, because two helpers that call each other would otherwise never
 * terminate.
 */
function resolveDependencies(sources) {
  const index = definitionIndex();
  const included = new Set();
  const out = [];
  let frontier = sources;

  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const next = [];
    for (const source of frontier) {
      for (const name of externalCalls(source)) {
        const entry = index.get(name);
        if (!entry || included.has(entry.name)) continue;
        included.add(entry.name);
        out.push(entry.source);
        next.push(entry.source);
      }
    }
    frontier = next;
  }
  // Deepest helpers first, so every call resolves by the time it runs.
  return out.reverse();
}

/**
 * Build one script from several `+js(...)` specs.
 *
 * Returns '' when none of them resolved, so the caller can skip injection
 * entirely rather than running an empty script on every page.
 */
function bundle(specs) {
  const parts = [];
  for (const spec of specs || []) {
    const source = scriptFor(spec);
    if (source) parts.push(source);
  }
  if (!parts.length) return '';
  // Each scriptlet already carries its own helpers, so they are simply
  // concatenated. A helper appearing twice is harmless: each lives inside its
  // own wrapper and cannot collide with the other.
  return parts.join('\n');
}

/**
 * Brave's own YouTube rules, as a single injectable script.
 *
 * Taken from data/brave/brave-main-list.txt, reduced to the rules aimed only
 * at YouTube whose scriptlets this browser can actually run. Rules that need
 * network-level response rewriting (trusted-replace-fetch-response and the
 * rest) are deliberately absent: Electron cannot rewrite a response body, so
 * including them would inject code that silently does nothing.
 *
 * Built once and cached - it is the same script on every YouTube page.
 */
let youtubeScript = null;

function youtubeRules() {
  try {
    const file = path.join(__dirname, 'youtube-rules.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return []; }
}

function youtubeBundle() {
  if (youtubeScript !== null) return youtubeScript;
  const rules = youtubeRules().map((rule) => rule.spec);
  youtubeScript = bundle(rules);
  return youtubeScript;
}

/** How many of Brave's YouTube rules are actually runnable here. */
function youtubeRuleCount() { return youtubeRules().length; }

/**
 * Brave's YouTube cosmetic rules, as one CSS rule.
 *
 * These hide the ad SLOTS - the sidebar ad, the merch shelf, the masthead
 * banner, the promoted rows in search. The scriptlets deal with the video ad;
 * these deal with everything else on the page, which is most of what a person
 * actually sees.
 *
 * Procedural selectors (:has-text and friends) are excluded at import time,
 * because insertCSS only takes real CSS and one invalid selector invalidates
 * the entire rule - which would silently disable every other selector too.
 */
let youtubeCss = null;

function youtubeCosmetic() {
  if (youtubeCss !== null) return youtubeCss;
  try {
    const file = path.join(__dirname, 'youtube-cosmetic.json');
    const selectors = JSON.parse(fs.readFileSync(file, 'utf8'));
    youtubeCss = selectors.length
      ? selectors.join(', ') + ' { display: none !important; }'
      : '';
  } catch { youtubeCss = ''; }
  return youtubeCss;
}

function youtubeCosmeticCount() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'youtube-cosmetic.json'), 'utf8')).length;
  } catch { return 0; }
}

/**
 * A redirect resource as a data: URL, by name or alias ("noop.js",
 * "1x1-transparent.gif", "noopmp3-0.1s"), or '' when there is none.
 * Made by scripts/make-redirects.cjs from uBlock Origin's resources.
 */
let redirects = null;
function redirectData(name) {
  if (!redirects) {
    redirects = new Map();
    try {
      const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'redirects.json'), 'utf8'));
      for (const [key, entry] of Object.entries(all)) {
        const url = 'data:' + entry.mime + ';base64,' + entry.data;
        for (const alias of [key, ...(entry.aliases || [])]) redirects.set(alias, url);
      }
    } catch { /* none available: redirect rules fall back to blocking */ }
  }
  return redirects.get(String(name || '')) || '';
}

/** Where a redirect resource is served from: the static-stub scheme. */
function redirectUrl(name) {
  return redirectData(name) ? 'static-stub://r/' + encodeURIComponent(String(name)) : '';
}

/** The bytes and type of a redirect resource, for the scheme handler. */
function redirectBody(name) {
  const data = redirectData(name);
  const m = data.match(/^data:([^;]+);base64,(.*)$/);
  return m ? { mime: m[1], bytes: Buffer.from(m[2], 'base64') } : null;
}

module.exports = {
  redirectData,
  redirectUrl,
  redirectBody,
  youtubeCosmetic, youtubeCosmeticCount,
  library, has, count, scriptFor, bundle, splitArgs, unquote,
  youtubeBundle, youtubeRuleCount, youtubeRules,
};
