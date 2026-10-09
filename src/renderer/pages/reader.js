'use strict';
(function () {
/**
 * browser://reader - an article on its own.
 *
 * Main lifted the article out of the page and cleaned it to an allow-listed
 * tree (features/pagetools/reader.js); this page asks for it and builds it
 * with createElement and textContent. It checks the tree against the same
 * short list again as it builds - main is the line that matters, this is the
 * second one - so a tag, an attribute or an address that is not expected is
 * simply not made. Pictures load with no referrer.
 *
 * The reader's own colours (light, sepia, dark) are its own, because reading
 * comfort is not the same thing as a theme; the planet still lends its
 * accent to links, the progress line and the controls. Size, width, typeface
 * and colours are remembered in settings (`reader`), for every article.
 */

const { $, invoke, icon } = window.page;

const SIZES = [14, 16, 18, 20, 22, 24, 27, 30, 32];
const WIDTHS = [['narrow', 'Narrow column'], ['medium', 'Medium column'], ['wide', 'Wide column']];
const THEMES = [['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']];

let prefs = { size: 20, width: 'medium', font: 'serif', theme: '' };
let planetIsLight = false;
let article = null;

/* ---- the article, from main's tree ---------------------------------------- */

const TAGS = new Set(['p', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure',
  'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'hr', 'a', 'em', 'strong', 'sup',
  'sub', 'small', 'mark', 's', 'del', 'ins', 'q', 'cite', 'abbr', 'time', 'code', 'kbd', 'var', 'samp', 'u', 'br', 'img']);

function webUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}
function imageUrl(value) {
  const text = String(value || '');
  return /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(text) ? text : webUrl(text);
}
const whole = (value, max) => (Number.isInteger(value) && value > 0 && value <= max ? value : 0);

function build(node) {
  if (typeof node === 'string') return document.createTextNode(node);
  if (!Array.isArray(node) || !TAGS.has(node[0])) return null;
  const [tag, rawAttrs, ...kids] = node;
  const attrs = rawAttrs && typeof rawAttrs === 'object' ? rawAttrs : {};
  const el = document.createElement(tag);
  if (tag === 'a') {
    const href = webUrl(attrs.href);
    if (href) { el.href = href; el.rel = 'noopener noreferrer'; el.referrerPolicy = 'no-referrer'; el.title = href; }
  } else if (tag === 'img') {
    const src = imageUrl(attrs.src);
    if (!src) return null;
    el.alt = String(attrs.alt || '');
    el.referrerPolicy = 'no-referrer';
    el.loading = 'lazy';
    el.decoding = 'async';
    // Its real proportions up front, so text does not jump as it arrives.
    if (whole(attrs.width, 20000) && whole(attrs.height, 20000)) {
      el.width = attrs.width;
      el.height = attrs.height;
      if (attrs.width < 260) el.classList.add('is-small');
    }
    el.addEventListener('load', () => el.classList.add('is-loaded'));
    el.addEventListener('error', () => { const figure = el.closest('figure'); (figure && !figure.textContent.trim() ? figure : el).remove(); });
    el.src = src;
    return el;
  } else if (tag === 'td' || tag === 'th') {
    if (whole(attrs.colspan, 50)) el.colSpan = attrs.colspan;
    if (whole(attrs.rowspan, 50)) el.rowSpan = attrs.rowspan;
  } else if (tag === 'ol' && whole(attrs.start, 100000)) {
    el.start = attrs.start;
  }
  for (const kid of kids) {
    const child = build(kid);
    if (child) el.append(child);
  }
  // A wide table scrolls on its own rather than pushing the page sideways.
  if (tag === 'table') {
    const wrap = document.createElement('div');
    wrap.className = 'rd-table';
    wrap.append(el);
    return wrap;
  }
  return el;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function render(data) {
  const root = $('#article');
  root.removeAttribute('aria-busy');
  if (!data || data.missing) { renderMissing(data); return; }
  article = data;
  document.title = data.title || data.site || 'Reading view';
  if (data.lang) root.lang = data.lang;
  root.dir = data.dir === 'rtl' ? 'rtl' : 'ltr';

  const head = el('header', 'rd-head');
  head.append(el('p', 'rd-kicker', data.site || ''));
  head.append(el('h1', 'rd-title', data.title || ''));
  const meta = el('p', 'rd-meta');
  const bits = [data.byline, formatDate(data.published)].filter(Boolean);
  bits.forEach((bit, i) => {
    if (i) meta.append(el('span', 'rd-dot', '·'));
    meta.append(el('span', i === 0 && data.byline ? 'rd-byline' : '', bit));
  });
  const time = el('span', 'rd-time');
  time.append(icon('clock', { size: 14 }), document.createTextNode(data.minutes + ' min read'));
  meta.append(time);
  head.append(meta);

  const body = el('div', 'rd-body');
  for (const node of data.content || []) {
    const child = build(node);
    if (child) body.append(child);
  }
  // A long opening paragraph gets a drop capital, as a magazine would.
  const first = body.firstElementChild;
  if (first && first.tagName === 'P' && first.textContent.trim().length > 160 && /^\p{L}/u.test(first.textContent.trim())) {
    first.classList.add('rd-lede');
  }

  const end = el('footer', 'rd-end');
  const mark = el('div', 'rd-end-mark');
  mark.append(el('i'), el('i'), el('i'));
  const from = el('p', 'rd-end-from');
  from.append(document.createTextNode('From ' + (data.site || 'the web') + '. '));
  const original = el('a', 'rd-end-link', 'Read it on the original page');
  original.href = data.source;
  original.rel = 'noopener noreferrer';
  from.append(original);
  const back = el('button', 'rd-end-back');
  back.type = 'button';
  back.append(icon('back', { size: 15 }), document.createTextNode('Back to the page'));
  back.addEventListener('click', leave);
  end.append(mark, from, back);

  root.replaceChildren(head, el('div', 'rd-rule'), body, end);
  $('#where').replaceChildren(siteChip(data), el('span', 'rd-where-title', data.title || ''));
  progress();
}

/** The site, with its initial on a small tile (no favicon service is asked: nobody need know what is being read). */
function siteChip(data) {
  const chip = el('span', 'rd-where-site');
  const letter = el('span', 'rd-letter', (data.site || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '·');
  chip.append(letter, el('span', '', data.site || ''));
  return chip;
}

function renderMissing(data) {
  const root = $('#article');
  document.title = 'Reading view';
  const card = el('div', 'rd-missing');
  const plate = el('div', 'rd-missing-plate');
  plate.append(icon('reader', { size: 30 }));
  card.append(plate,
    el('h1', '', 'This article is no longer open'),
    el('p', '', 'Reading view keeps an article only while Static is running. Open the page to read it again.'));
  if (data?.source) {
    const open = el('button', 'rd-primary');
    open.type = 'button';
    open.append(document.createTextNode('Open ' + (data.site || 'the page')));
    open.addEventListener('click', leave);
    card.append(open);
  }
  root.replaceChildren(card);
}

function leave() {
  invoke('reader:leave').catch(() => {});
}

/* ---- how it looks ----------------------------------------------------------- */

function applyPrefs() {
  const body = document.body;
  const theme = prefs.theme || (planetIsLight ? 'light' : 'dark');
  body.dataset.theme = theme;
  body.dataset.font = prefs.font;
  body.dataset.width = prefs.width;
  body.style.setProperty('--rd-size', prefs.size + 'px');
  for (const button of document.querySelectorAll('[data-pref]')) {
    const [key, value] = button.dataset.pref.split(':');
    const on = (key === 'theme' ? theme : prefs[key]) === value;
    button.setAttribute('aria-pressed', String(on));
  }
  $('#smaller').disabled = prefs.size <= SIZES[0];
  $('#bigger').disabled = prefs.size >= SIZES[SIZES.length - 1];
  $('#size-now').textContent = String(prefs.size);
  progress();
}

function choose(patch) {
  prefs = { ...prefs, ...patch };
  applyPrefs();
  invoke('settings:update', { reader: patch }).catch(() => {});
}

function stepSize(direction) {
  const next = direction > 0
    ? SIZES.find((size) => size > prefs.size) || SIZES[SIZES.length - 1]
    : [...SIZES].reverse().find((size) => size < prefs.size) || SIZES[0];
  choose({ size: next });
}

/** A small picture of a column at each width, drawn rather than worded. */
function widthGlyph(width) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const half = { narrow: 3.5, medium: 6, wide: 8.5 }[width];
  for (const y of [7, 10.5, 14, 17.5]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', `M${12 - half} ${y}H${12 + half - (y === 17.5 ? half * 0.8 : 0)}`);
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.8');
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
  }
  return svg;
}

function buildTools() {
  const group = (label, ...children) => {
    const g = el('div', 'rd-group');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    g.append(...children);
    return g;
  };
  const tool = (props, ...children) => {
    const b = el('button', 'rd-tool' + (props.className ? ' ' + props.className : ''));
    b.type = 'button';
    if (props.id) b.id = props.id;
    if (props.title) { b.title = props.title; b.setAttribute('aria-label', props.title); }
    if (props.pref) b.dataset.pref = props.pref;
    b.append(...children);
    b.addEventListener('click', props.onClick);
    return b;
  };

  const smaller = tool({ id: 'smaller', title: 'Smaller text', className: 'rd-a is-small', onClick: () => stepSize(-1) }, 'A');
  const now = el('span', 'rd-size-now');
  now.id = 'size-now';
  now.setAttribute('aria-live', 'polite');
  const bigger = tool({ id: 'bigger', title: 'Larger text', className: 'rd-a is-big', onClick: () => stepSize(1) }, 'A');

  const fonts = [['serif', 'Serif'], ['sans', 'Sans serif']].map(([value, title]) =>
    tool({ title, pref: 'font:' + value, className: 'rd-font is-' + value, onClick: () => choose({ font: value }) }, 'Aa'));
  const widths = WIDTHS.map(([value, title]) =>
    tool({ title, pref: 'width:' + value, onClick: () => choose({ width: value }) }, widthGlyph(value)));
  const themes = THEMES.map(([value, title]) => {
    const dot = el('span', 'rd-swatch is-' + value);
    dot.append(icon('check', { size: 11 }));
    return tool({ title: title + ' colours', pref: 'theme:' + value, className: 'rd-theme', onClick: () => choose({ theme: value }) }, dot);
  });

  $('#tools').replaceChildren(
    group('Text size', smaller, now, bigger),
    group('Typeface', ...fonts),
    group('Column width', ...widths),
    group('Colours', ...themes),
  );

  const back = $('#back');
  back.append(icon('back', { size: 16 }), el('span', '', 'Back to page'));
  back.addEventListener('click', leave);
}

/* ---- reading ------------------------------------------------------------------ */

let lastY = 0;
let ticking = false;

/** The line along the top fills as you read; the bar steps aside going down. */
function progress() {
  const max = document.documentElement.scrollHeight - innerHeight;
  const done = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
  $('#progress').style.setProperty('--done', String(done));
  const bar = $('#bar');
  const titleGone = scrollY > ($('.rd-title')?.offsetTop || 120) + 40;
  bar.classList.toggle('show-title', titleGone && !!article);
  if (scrollY > lastY + 6 && scrollY > 140 && !bar.matches(':hover, :focus-within')) bar.classList.add('is-tucked');
  else if (scrollY < lastY - 6 || scrollY < 140) bar.classList.remove('is-tucked');
  bar.classList.toggle('is-scrolled', scrollY > 8);
  lastY = scrollY;
}

addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; progress(); });
}, { passive: true });
addEventListener('resize', progress, { passive: true });
// The bar comes back when the pointer goes looking for it.
addEventListener('mousemove', (event) => { if (event.clientY < 64) $('#bar').classList.remove('is-tucked'); }, { passive: true });

// Links in the article: here, or in a new tab with Ctrl/Cmd or the middle button.
document.addEventListener('click', (event) => {
  const link = event.target.closest?.('.rd-article a[href]');
  if (!link) return;
  event.preventDefault();
  if (link.classList.contains('rd-end-link')) { leave(); return; }
  window.page.openUrl(link.href, event);
});
document.addEventListener('auxclick', (event) => {
  const link = event.target.closest?.('.rd-article a[href]');
  if (!link || event.button !== 1) return;
  event.preventDefault();
  window.page.openUrl(link.href, event);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); leave(); }
});

buildTools();

window.page.onState((state) => {
  const settings = state?.settings || {};
  planetIsLight = window.theme.cssVariables(settings)['--luminous'] === '1';
  if (settings.reader) prefs = { ...prefs, ...settings.reader };
  applyPrefs();
});

invoke('reader:article').then(render).catch(() => render(null));

})();
