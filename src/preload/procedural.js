/**
 * Procedural cosmetic filtering, in the page.
 *
 * Filter lists hide some ads with rules no stylesheet can express: "the card
 * whose text says Sponsored", "the third ancestor of this link", "the box
 * whose computed position is fixed". This runs those rules in the preload's
 * isolated world, where the page cannot see or tamper with it, and keeps
 * running them as the page changes, because most such ads arrive late.
 *
 * Supported (uBlock Origin and AdGuard/ABP names):
 *   :has-text() :contains() :-abp-contains()   text, or /regex/flags
 *   :-abp-has() :if() :if-not()                 contains / lacks a match
 *   :upward(n|selector) :nth-ancestor(n)        climb to an ancestor
 *   :matches-css() -before -after               computed style test
 *   :matches-attr() :matches-path()             attribute / URL tests
 *   :min-text-length()  :xpath()  :watch-attr() (treated as a no-op filter)
 * Actions: hide (default), :remove(), :style(), :remove-attr(), :remove-class()
 */

const OPS = ['has-text', 'contains', '-abp-contains', '-abp-has', 'if-not', 'if', 'upward', 'nth-ancestor',
  'matches-css-before', 'matches-css-after', 'matches-css', 'matches-attr', 'matches-path', 'matches-media',
  'min-text-length', 'xpath', 'watch-attr', 'others', 'remove-attr', 'remove-class', 'remove', 'style'];
const ACTIONS = new Set(['remove', 'style', 'remove-attr', 'remove-class']);

/** A string or /regex/flags as a test function. */
function matcher(arg) {
  const text = String(arg || '').trim().replace(/^(['"])(.*)\1$/, '$2');
  const re = text.match(/^\/(.+)\/([gimsuy]*)$/);
  if (re) {
    try { const r = new RegExp(re[1], re[2].replace('g', '')); return (value) => r.test(value); } catch { return () => false; }
  }
  return (value) => value.includes(text);
}

/** Split `div.x:has-text(Ad):upward(2)` into a CSS start and a list of steps. */
function parse(selector) {
  const steps = [];
  let css = '';
  let i = 0;
  let depth = 0;
  let bracket = 0;
  let start = 0;
  const text = String(selector);
  while (i < text.length) {
    const c = text[i];
    if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ':' && depth === 0 && bracket === 0) {
      const name = OPS.find((op) => text.startsWith(op + '(', i + 1));
      if (name) {
        const before = text.slice(start, i);
        if (!steps.length) css += before;
        else if (before.trim()) steps.push({ op: 'css', arg: before });
        let j = i + name.length + 2;
        let d = 1;
        while (j < text.length && d > 0) { if (text[j] === '(') d++; else if (text[j] === ')') d--; j++; }
        steps.push({ op: name, arg: text.slice(i + name.length + 2, j - 1) });
        i = j;
        start = j;
        continue;
      }
    }
    i++;
  }
  const rest = text.slice(start);
  if (!steps.length) css += rest; else if (rest.trim()) steps.push({ op: 'css', arg: rest });
  return { css: css.trim() || '*', steps };
}

function styleMatches(el, arg, pseudo) {
  const [prop, ...value] = String(arg).split(':');
  const test = matcher(value.join(':').trim());
  try { return test(getComputedStyle(el, pseudo).getPropertyValue(prop.trim())); } catch { return false; }
}

/** Apply one filtering or navigating step to a set of elements. */
function step(elements, { op, arg }) {
  const out = new Set();
  switch (op) {
    case 'has-text': case 'contains': case '-abp-contains': {
      const test = matcher(arg);
      for (const el of elements) if (test(el.textContent || '')) out.add(el);
      break;
    }
    case '-abp-has': case 'if': {
      for (const el of elements) if (run(el, arg).length) out.add(el);
      break;
    }
    case 'if-not': {
      for (const el of elements) if (!run(el, arg).length) out.add(el);
      break;
    }
    case 'upward': case 'nth-ancestor': {
      const n = Number(arg);
      for (const el of elements) {
        let target = el;
        if (Number.isInteger(n) && n > 0) { for (let k = 0; k < n && target; k++) target = target.parentElement; }
        else target = el.parentElement?.closest(arg);
        if (target && target !== document.documentElement && target !== document.body) out.add(target);
      }
      break;
    }
    case 'matches-css': for (const el of elements) if (styleMatches(el, arg)) out.add(el); break;
    case 'matches-css-before': for (const el of elements) if (styleMatches(el, arg, '::before')) out.add(el); break;
    case 'matches-css-after': for (const el of elements) if (styleMatches(el, arg, '::after')) out.add(el); break;
    case 'matches-attr': {
      const [rawName, ...rest] = String(arg).split('=');
      const nameTest = matcher(rawName.replace(/^["']|["']$/g, ''));
      const valueTest = rest.length ? matcher(rest.join('=').replace(/^["']|["']$/g, '')) : () => true;
      for (const el of elements) if ([...el.attributes].some((a) => nameTest(a.name) && valueTest(a.value))) out.add(el);
      break;
    }
    case 'matches-path': if (matcher(arg)(location.pathname + location.search)) for (const el of elements) out.add(el); break;
    case 'matches-media': try { if (matchMedia(arg).matches) for (const el of elements) out.add(el); } catch { /* bad query */ } break;
    case 'min-text-length': for (const el of elements) if ((el.textContent || '').length >= Number(arg)) out.add(el); break;
    case 'xpath': {
      for (const el of elements) {
        try {
          const result = document.evaluate(arg, el, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let k = 0; k < result.snapshotLength; k++) if (result.snapshotItem(k).nodeType === 1) out.add(result.snapshotItem(k));
        } catch { /* bad expression */ }
      }
      break;
    }
    case 'css': {
      const rel = String(arg).trim();
      for (const el of elements) {
        try { for (const found of el.querySelectorAll(':scope ' + rel)) out.add(found); } catch { /* bad selector */ }
      }
      break;
    }
    case 'watch-attr': case 'others': for (const el of elements) out.add(el); break;
    default: break;
  }
  return [...out];
}

/** Every element a procedural selector points at, from a root. */
function run(root, selector) {
  const { css, steps } = parse(selector);
  let elements;
  try { elements = [...root.querySelectorAll(css)]; } catch { return []; }
  for (const s of steps) {
    if (ACTIONS.has(s.op)) break;
    elements = step(elements, s);
    if (!elements.length) break;
  }
  return elements;
}

function act(element, action) {
  if (!action) {
    element.style.setProperty('display', 'none', 'important');
    return;
  }
  if (action.op === 'remove') { element.remove(); return; }
  if (action.op === 'remove-attr') { for (const name of String(action.arg).split('|')) element.removeAttribute(name.trim().replace(/^["']|["']$/g, '')); return; }
  if (action.op === 'remove-class') { for (const name of String(action.arg).split('|')) element.classList.remove(name.trim().replace(/^["']|["']$/g, '')); return; }
  if (action.op === 'style') {
    for (const declaration of String(action.arg).split(';')) {
      const [prop, ...value] = declaration.split(':');
      if (!prop || !value.length) continue;
      const clean = value.join(':').replace(/!important/i, '').trim();
      // Refuse anything that can fetch or run: url(), expression(), javascript.
      if (/url\(|expression|javascript|@import/i.test(clean)) continue;
      element.style.setProperty(prop.trim(), clean, 'important');
    }
  }
}

function start(selectors) {
  const rules = selectors.map((selector) => {
    const parsed = parse(selector);
    return { selector, action: parsed.steps.find((s) => ACTIONS.has(s.op)) || null };
  }).filter((rule) => rule.selector);
  if (!rules.length) return;
  let hidden = 0;
  const apply = () => {
    const began = performance.now();
    for (const rule of rules) {
      for (const el of run(document, rule.selector)) {
        if (el.__staticDone && !rule.action) continue;
        act(el, rule.action);
        el.__staticDone = true;
        hidden++;
      }
      // Never hold the page up: stop for this frame after 8ms.
      if (performance.now() - began > 8) break;
    }
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; apply(); }, 120);
  };
  const begin = () => {
    apply();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'style'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
  return { count: () => hidden };
}

module.exports = { start, parse, run };
