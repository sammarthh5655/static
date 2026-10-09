'use strict';

/**
 * Reading view: deciding that a page is an article, lifting the article out
 * of it, and making what was lifted safe to show.
 *
 * Two halves, kept apart on purpose:
 *
 * - `probablyReadable` and `extract` run IN THE PAGE, in an isolated world
 *   (main/application.js runs them with executeJavaScriptInIsolatedWorld), so
 *   they see the page's live DOM - what is visible, where lazy images really
 *   point - without the page's own scripts being able to reach or redefine
 *   anything they use. They are written as ordinary functions and sent as
 *   source, so they must not use anything from this module's scope.
 *
 * - `clean` runs in main on what came back. The page owns its DOM, so the
 *   result is untrusted however careful the extractor was. It is not HTML at
 *   all but a small tree of [tag, attributes, ...children] and strings, and
 *   `clean` rebuilds it from an allow-list: known tags only, a handful of
 *   attributes, http(s) links and images only. The reader page then builds
 *   its DOM from that tree with createElement and textContent - no markup is
 *   ever parsed - so there is nowhere for a script, an event handler or a
 *   javascript: URL to survive.
 *
 * The heuristics are the ones Mozilla's Readability made standard (score
 * paragraphs, credit their containers, punish link-heavy blocks), written
 * afresh and smaller.
 */

/**
 * Is this page worth offering the reading view for? Cheap enough to run on
 * every page load: a page needs several visible blocks of real prose.
 * Readability's isProbablyReaderable, in essence.
 */
function probablyReadable() {
  const UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
  const MAYBE = /and|article|body|column|content|main|shadow/i;
  if (!document.body) return { readable: false, score: 0 };
  const nodes = new Set(document.body.querySelectorAll('p, pre, article'));
  // Prose spaced with <br><br> rather than paragraphs, as older sites and
  // hand-made essays are: in a div, or loose in a table cell or a <font>.
  for (const br of document.body.querySelectorAll('div > br, td > br, font > br')) nodes.add(br.parentNode);
  let score = 0;
  for (const node of nodes) {
    const name = (typeof node.className === 'string' ? node.className : '') + ' ' + node.id;
    if (UNLIKELY.test(name) && !MAYBE.test(name)) continue;
    if (node.closest('li') && node.tagName === 'P') continue;
    if (node.checkVisibility ? !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : !node.offsetParent) continue;
    const length = node.textContent.trim().length;
    if (length < 140) continue;
    score += Math.sqrt(length - 140);
    if (score > 20) return { readable: true, score: Math.round(score) };
  }
  return { readable: false, score: Math.round(score) };
}

/**
 * Lift the article out of the page. Reads the live DOM and changes nothing.
 * Returns metadata and `content`: a tree of strings and [tag, attrs, ...kids].
 *
 * With `measure`, stops once it has found the article and says only how much
 * prose it holds and how much of that is links - enough to tell a story from
 * a front page full of headlines, without building anything.
 */
function extract(measure = false) {
  const MAX_NODES = 15000;
  const MAX_TEXT = 400000;
  const UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|newsletter|subscribe|promo|share|cookie|consent|signup|paywall|recirc|trending|outbrain|taboola|hatnote|ambox|navbox|mw-editsection|noprint|catlinks/i;
  const MAYBE = /and|article|body|column|content|main|shadow|story|post|entry|prose/i;
  const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story|prose/i;
  const NEGATIVE = /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget|newsletter|subscribe|taboola/i;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'NAV', 'ASIDE', 'FOOTER', 'HEADER', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'MAP', 'DIALOG', 'MENU',
    'LINK', 'META', 'HEAD', 'LABEL', 'FIELDSET', 'OUTPUT', 'PROGRESS', 'METER']);
  const SKIP_ROLES = /^(navigation|complementary|banner|contentinfo|menu|menubar|dialog|alertdialog|search|toolbar|tablist|form)$/;
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  // Class names that are never the article, whatever else they say:
  // encyclopaedia notices, edit links, screen-reader-only labels.
  // Prefixed forms count too (govuk-visually-hidden), and so do the Show and
  // Hide toggles an accordion puts in its headings.
  const FURNITURE = /(?:^|\s)(?:hatnote|ambox|navbox|vertical-navbox|mw-editsection|noprint|catlinks|metadata|skip-link|(?:[\w-]*[-_])?(?:sr-only|visually-hidden|screen-reader-text|toggle))(?:\s|$)/i;
  const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '') + ' ' + el.id;

  /* ---- what the page says about itself ---- */
  const meta = (...names) => {
    for (const name of names) {
      const node = document.querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`);
      const value = squash(node?.getAttribute('content'));
      if (value) return value;
    }
    return '';
  };
  let ld = {};
  const ARTICLE_TYPES = /Article|BlogPosting|Report|NewsArticle|TechArticle|ScholarlyArticle|WebPage|Posting/;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      const all = [].concat(data).flatMap((d) => (d && d['@graph'] ? [].concat(d['@graph']) : [d]));
      const found = all.find((d) => d && ARTICLE_TYPES.test([].concat(d['@type'] || '').join(' ')) && (d.headline || d.author));
      if (found) { ld = found; break; }
    } catch { /* a page's broken JSON-LD is not our problem */ }
  }
  const ldName = (value) => [].concat(value || []).map((v) => (typeof v === 'string' ? v : v?.name)).filter(Boolean).map(squash).join(', ');

  // Folded away but there to be read: an accordion's hidden="until-found"
  // section (GOV.UK's guidance, for one). Find in page opens them, so they
  // are part of the article; reading view unfolds them. A closed <details>
  // stays closed: it is usually an aside ("what does this badge mean?").
  const FOLDED = '[hidden="until-found"]';
  const visible = (el) => {
    if (el.hidden && el.getAttribute('hidden') !== 'until-found') return false;
    // aria-hidden hides furniture; but a page with a cookie dialog open
    // hides EVERYTHING behind it that way, article included.
    if (el.getAttribute('aria-hidden') === 'true' && (el.textContent || '').length < 2000) return false;
    if (!el.checkVisibility) return !!el.getClientRects().length;
    if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    const style = getComputedStyle(el);
    // display: contents has no box of its own, so it "is not visible" - but
    // its children are, and many sites wrap the whole page in one.
    if (style.display === 'contents') return true;
    const fold = el.closest(FOLDED);
    if (!fold || style.display === 'none' || style.visibility === 'hidden') return false;
    // Unfolded, it would show if what holds the fold shows.
    const holder = fold.parentElement;
    return !holder || holder === document.body || visible(holder);
  };

  // The headline: the page's own h1 when the other sources agree with it,
  // otherwise the declared title without the " | Site name" on the end.
  const h1 = [...document.querySelectorAll('h1')].find((h) => visible(h) && squash(h.textContent).length > 3);
  const h1Text = squash(h1?.textContent);
  const declared = squash(ld.headline) || meta('og:title', 'twitter:title');
  let title = declared;
  const docTitle = squash(document.title);
  if (h1Text && (docTitle.includes(h1Text) || declared.includes(h1Text) || !declared)) title = h1Text;
  if (!title) {
    const parts = docTitle.split(/\s+[|\-–—:·»]\s+/);
    title = parts.length > 1 ? parts.reduce((a, b) => (b.length > a.length ? b : a)) : docTitle;
  }

  let byline = ldName(ld.author) || meta('author', 'article:author', 'parsely-author', 'sailthru.author', 'byl');
  if (!byline || /^https?:/.test(byline)) {
    const node = document.querySelector('[rel="author"], [itemprop="author"] [itemprop="name"], [itemprop="author"], .byline, .author-name, .post-author, .article-author');
    const text = squash(node?.textContent);
    if (text && text.length < 100) byline = text;
  }
  byline = byline.replace(/^by\s+/i, '').slice(0, 160);

  const host = location.hostname.replace(/^www\./, '');
  // The site's own name, or its address: a publisher's company name ("Vox
  // Media, LLC") is not what anyone calls the site they are reading.
  const site = meta('og:site_name', 'application-name') || host;
  const published = squash(ld.datePublished) || meta('article:published_time', 'datePublished', 'pubdate', 'date') ||
    document.querySelector('article time[datetime], time[datetime]')?.getAttribute('datetime') || '';
  const excerpt = meta('og:description', 'description', 'twitter:description');

  /* ---- where the article is ---- */
  const unlikelyCache = new Map();
  // An element we never read from: hidden, furniture (nav, footer, a share
  // bar), or inside one. Cached, so each ancestor is judged once.
  const excluded = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (unlikelyCache.has(el)) return unlikelyCache.get(el);
    let out = el.namespaceURI !== HTML_NS || SKIP.has(el.tagName) || SKIP_ROLES.test(el.getAttribute('role') || '') || el.getAttribute('aria-modal') === 'true';
    if (!out) {
      const name = nameOf(el);
      out = UNLIKELY.test(name) && !MAYBE.test(name) && el.tagName !== 'BODY' && el.tagName !== 'ARTICLE' && el.tagName !== 'MAIN';
    }
    if (!out) out = excluded(el.parentElement);
    if (!out && !visible(el)) out = true;
    unlikelyCache.set(el, out);
    return out;
  };

  const textLength = (el) => squash(el.textContent).length;
  const linkDensity = (el) => {
    const total = textLength(el);
    if (!total) return 0;
    let links = 0;
    for (const a of el.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      links += squash(a.textContent).length * (/^#/.test(href) ? 0.3 : 1);
    }
    return Math.min(1, links / total);
  };
  const classWeight = (el) => {
    const name = nameOf(el);
    return (NEGATIVE.test(name) ? -25 : 0) + (POSITIVE.test(name) ? 25 : 0);
  };
  const scores = new Map();
  const initial = (el) => {
    const base = { DIV: 5, ARTICLE: 10, MAIN: 8, SECTION: 3, PRE: 3, TD: 3, BLOCKQUOTE: 3,
      ADDRESS: -3, OL: -3, UL: -3, DL: -3, DD: -3, DT: -3, LI: -3, FORM: -3,
      H1: -5, H2: -5, H3: -5, H4: -5, H5: -5, H6: -5, TH: -5 }[el.tagName] || 0;
    return base + classWeight(el);
  };

  const paragraphs = document.body.querySelectorAll(
    'p, pre, blockquote, td, div:not(:has(p, div, section, article, ul, ol, table, pre, blockquote, h1, h2, h3, h4, h5, h6, figure))');
  let seen = 0;
  for (const p of paragraphs) {
    if (++seen > 6000) break;
    if (excluded(p)) continue;
    const text = squash(p.textContent);
    if (text.length < 25) continue;
    const points = 1 + text.split(/[,，、]/).length - 1 + Math.min(Math.floor(text.length / 100), 3);
    let ancestor = p.parentElement;
    for (let level = 0; ancestor && ancestor !== document.documentElement && level < 5; level++, ancestor = ancestor.parentElement) {
      if (!scores.has(ancestor)) scores.set(ancestor, initial(ancestor));
      const share = level === 0 ? 1 : level === 1 ? 2 : level * 3;
      scores.set(ancestor, scores.get(ancestor) + points / share);
    }
  }
  const ranked = [...scores].map(([el, score]) => [el, score * (1 - linkDensity(el))]).sort((a, b) => b[1] - a[1]);
  let top = ranked[0]?.[0] || document.querySelector('article, main, [role="main"]') || document.body;
  const topScore = ranked[0]?.[1] || 0;
  // When several of the best candidates sit inside one container that also
  // scores well, the article is that container (a story split into sections).
  const best = ranked.slice(0, 5).map(([el]) => el);
  for (let parent = top.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const holds = best.filter((el) => el !== top && parent.contains(el)).length;
    if (holds >= 2 && (scores.get(parent) || 0) * (1 - linkDensity(parent)) >= topScore * 0.75) { top = parent; break; }
  }
  // Or when two other parts score nearly as well as the best (an article in
  // sections, each scored on its own), the article is what holds all three.
  const near = ranked.slice(1, 8).filter(([el, score]) => score >= topScore * 0.75 && !el.contains(top) && !top.contains(el)).map(([el]) => el);
  // A section and its own wrapper are one rival, not two.
  const rivals = near.filter((el) => !near.some((other) => other !== el && other.contains(el)));
  if (rivals.length >= 2) {
    for (let parent = top.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (rivals.filter((el) => parent.contains(el)).length >= 2) { top = parent; break; }
    }
  }
  // Or when the best is one of a set - the same element, with the same
  // classes, repeated close by and holding real prose too - it is one
  // section of an article split up (an accordion's panels, a guide's
  // chapters), and the article is what holds the set.
  const kind = (el) => el.tagName + '.' + (typeof el.className === 'string' ? el.className.trim() : '');
  if (typeof top.className === 'string' && top.className.trim()) {
    const twins = ranked
      .filter(([el, score]) => el !== top && score >= topScore * 0.3 && kind(el) === kind(top) && !el.contains(top) && !top.contains(el))
      .map(([el]) => el);
    let parent = top.parentElement;
    for (let level = 1; twins.length && parent && parent !== document.body && level <= 3; level++, parent = parent.parentElement) {
      if (twins.some((el) => parent.contains(el))) { top = parent; break; }
    }
  }
  // An only child says nothing about its siblings; its parent does.
  while (top.parentElement && top.parentElement !== document.body && top.parentElement.children.length === 1) top = top.parentElement;

  // The best container, plus siblings that read like more of the same.
  const parts = [top];
  if (top.parentElement && top !== document.body) {
    const threshold = Math.max(10, topScore * 0.2);
    for (const sibling of top.parentElement.children) {
      if (sibling === top || excluded(sibling)) continue;
      const score = (scores.get(sibling) || 0) * (1 - linkDensity(sibling));
      let take = score >= threshold;
      if (!take && sibling.tagName === 'P') {
        const length = textLength(sibling);
        const density = linkDensity(sibling);
        take = (length > 80 && density < 0.25) || (length > 0 && length <= 80 && density === 0 && /\.( |$)/.test(sibling.textContent));
      }
      if (take) parts.push(sibling);
    }
    parts.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  if (measure) {
    const length = parts.reduce((total, part) => total + textLength(part), 0);
    const links = parts.reduce((total, part) => total + textLength(part) * linkDensity(part), 0);
    return { length, linkDensity: length ? links / length : 1, scored: ranked.length };
  }

  /* ---- the article, as a tree ---- */
  let budget = MAX_NODES;
  let textBudget = MAX_TEXT;
  let words = 0;
  const titleKey = title.toLowerCase().replace(/\W+/g, '');
  const RENAME = { H1: 'h2', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4', B: 'strong', I: 'em', STRIKE: 's', TT: 'code' };
  const KEEP = new Set(['P', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD',
    'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'HR', 'BR', 'EM', 'STRONG', 'SUP', 'SUB', 'SMALL', 'MARK', 'S', 'DEL', 'INS',
    'Q', 'CITE', 'ABBR', 'TIME', 'CODE', 'KBD', 'VAR', 'SAMP', 'U']);
  const BLOCKS = new Set(['p', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'ul', 'ol', 'dl', 'figure', 'table', 'hr']);

  // The picture a lazy-loading page really means, not its placeholder.
  const imageSource = (img) => {
    const fromSet = (set) => {
      let pick = '';
      let widest = 0;
      for (const part of String(set || '').split(/,\s+/)) {
        const [url, size] = part.trim().split(/\s+/);
        const width = parseFloat(size) || 1;
        if (url && width >= widest) { widest = width; pick = url; }
      }
      return pick;
    };
    const candidates = [
      img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), img.getAttribute('data-original'),
      img.getAttribute('data-url'), fromSet(img.getAttribute('data-srcset')),
      img.currentSrc, img.getAttribute('src'), fromSet(img.getAttribute('srcset')),
    ];
    for (const value of candidates) {
      if (!value || /^data:image\/(gif|svg)/i.test(value) || (/^data:/i.test(value) && value.length < 200)) continue;
      try { return new URL(value, location.href).href; } catch { /* next */ }
    }
    return '';
  };

  // Open shadow roots are where many sites now keep parts of an article
  // (MDN's code samples, for one), and slots are where a component shows
  // what it was given: what the person sees is the flattened tree, so that
  // is what is read.
  const childrenOf = (el) => {
    if (el.tagName === 'SLOT') {
      const assigned = el.assignedNodes({ flatten: true });
      return assigned.length ? assigned : [...el.childNodes];
    }
    return [...(el.shadowRoot || el).childNodes];
  };

  // A table used to lay a page out (an essay in a cell, a menu in the next
  // one) is not a table of anything: its cells are unwrapped and read as
  // the page. Mozilla's test, near enough: declared, captioned or headed
  // tables are data; nested, tiny or prose-filled ones are layout.
  const layoutCache = new Map();
  const isLayoutTable = (table) => {
    if (!table) return false;
    if (layoutCache.has(table)) return layoutCache.get(table);
    let layout;
    const role = table.getAttribute('role');
    if (role === 'presentation' || role === 'none' || table.getAttribute('datatable') === '0') layout = true;
    else if (table.getAttribute('summary') || table.caption || table.querySelector('col, colgroup, thead, tfoot, th')) layout = false;
    else if (table.querySelector('table')) layout = true;
    else {
      const rows = table.rows.length;
      let columns = 0;
      for (const row of [...table.rows].slice(0, 30)) columns = Math.max(columns, row.cells.length);
      const prose = [...table.querySelectorAll('td')].some((cell) => textLength(cell) > 600);
      layout = prose || !(rows >= 10 || columns > 4 || rows * columns > 10);
    }
    layoutCache.set(table, layout);
    return layout;
  };
  const TABLE_PARTS = /^(TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|CAPTION)$/;
  const here = location.href.split('#')[0];

  const walk = (node, inPre) => {
    if (budget-- <= 0 || textBudget <= 0) return [];
    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.nodeValue || '';
      if (!inPre) text = text.replace(/\s+/g, ' ');
      if (!text) return [];
      textBudget -= text.length;
      words += (text.match(/[\p{L}\p{N}]+/gu) || []).length;
      return [text];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const el = node;
    // SVG and MathML are drawings and formulae, not prose - and their
    // <script>, <style> and <a> have lower-case names that would slip past
    // every list here, their code read out as the article's words.
    if (el.namespaceURI !== HTML_NS) return [];
    const tag = el.tagName;
    // An accordion's heading is a button: its words are the heading's.
    const headingButton = tag === 'BUTTON' && !!el.parentElement?.closest('h2, h3, h4, h5, h6');
    if ((SKIP.has(tag) && !headingButton) || SKIP_ROLES.test(el.getAttribute('role') || '') || !visible(el)) return [];
    const kids = () => childrenOf(el).flatMap((child) => walk(child, inPre || tag === 'PRE'));

    // Furniture inside the article (share bars, "related" lists, sign-up
    // boxes) goes; a long passage that merely has an unlucky class stays.
    // Never inside code, where a highlighter's "token comment" and "token
    // header" are the code itself.
    // A heading's id is usually its own words made into an address
    // ("situations-needing-extra-care"), so only its classes are judged.
    const name = /^H[1-6]$/.test(tag) ? (typeof el.className === 'string' ? el.className : '') : nameOf(el);
    if (!inPre && FURNITURE.test(name)) return [];
    if (!inPre && tag !== 'IMG' && tag !== 'PICTURE' && (UNLIKELY.test(name) || NEGATIVE.test(name)) && !MAYBE.test(name)) {
      // Except a section's "header" that is nothing but its heading.
      const heading = el.querySelector('h2, h3, h4, h5, h6');
      const justHeading = !!heading && textLength(heading) >= textLength(el) * 0.8;
      if (!justHeading && (linkDensity(el) > 0.4 || textLength(el) < 200)) return [];
    }
    if (!inPre && /^(UL|OL|TABLE|DIV|SECTION)$/.test(tag)) {
      const length = textLength(el);
      if (length > 0 && linkDensity(el) > 0.5 && length < 2000) return [];
      // (A shadow host's own text is empty: what it shows is in its shadow root.)
      if (!length && !el.shadowRoot && !el.querySelector('img, picture')) return [];
    }

    if (tag === 'IMG') {
      const src = imageSource(el);
      const width = Number(el.getAttribute('width')) || el.naturalWidth || 0;
      const height = Number(el.getAttribute('height')) || el.naturalHeight || 0;
      if (!src || (width && width < 48) || (height && height < 48)) return [];
      // An image map is a menu drawn as a picture; a thin strip is a rule or
      // a spacer. Neither is a picture in the story.
      if (el.hasAttribute('usemap') || el.hasAttribute('ismap')) return [];
      if (width && height && (height > width * 4 || width > height * 8)) return [];
      const attrs = { src, alt: squash(el.getAttribute('alt')).slice(0, 300) };
      if (width && height) { attrs.width = width; attrs.height = height; }
      return [['img', attrs]];
    }
    if (tag === 'PICTURE') {
      const img = el.querySelector('img');
      return img ? walk(img, inPre) : [];
    }
    if (tag === 'A') {
      const children = kids();
      if (!children.length) return [];
      let href = '';
      try { href = new URL(el.getAttribute('href') || '', location.href).href; } catch { /* plain text then */ }
      // A link to elsewhere on this page (a heading's own anchor, a footnote
      // marker) would leave reading view for the page: it stays as text.
      if (href.split('#')[0] === here) return children;
      return /^https?:/i.test(href) ? [['a', { href }, ...children]] : children;
    }
    if (/^H[1-6]$/.test(tag)) {
      const text = squash(el.textContent);
      if (!text || text.toLowerCase().replace(/\W+/g, '') === titleKey) return [];
      return [[RENAME[tag], null, ...kids()]];
    }
    // A layout table's parts fall through to the wrappers below.
    const grid = TABLE_PARTS.test(tag) && isLayoutTable(tag === 'TABLE' ? el : el.closest('table'));
    if (grid) {
      const children = kids();
      // A cell is a column of the page: whatever loose text it has is a
      // passage of its own, not a run-on of the cell beside it.
      return tag === 'TD' || tag === 'TH' ? [...children, ['br'], ['br']] : children;
    }
    if (tag === 'TD' || tag === 'TH') {
      const attrs = {};
      for (const key of ['colspan', 'rowspan']) if (Number(el.getAttribute(key)) > 1) attrs[key] = Number(el.getAttribute(key));
      return [[tag.toLowerCase(), Object.keys(attrs).length ? attrs : null, ...kids()]];
    }
    if (tag === 'OL') {
      const start = Number(el.getAttribute('start'));
      return [['ol', start > 1 ? { start } : null, ...kids()]];
    }
    if (RENAME[tag]) return [[RENAME[tag], null, ...kids()]];
    if (KEEP.has(tag)) return [[tag.toLowerCase(), null, ...kids()]];
    // Anything else (div, section, span, font, article...) is a wrapper: its
    // contents carry on without it. A div of loose text was a paragraph -
    // except in code, where a highlighter's div is a line.
    const children = kids();
    if (inPre) {
      const block = /^(DIV|P|LI)$/.test(tag) && !/\n$/.test(el.textContent || '');
      return block ? [...children, '\n'] : children;
    }
    if (/^(DIV|SECTION|ARTICLE|MAIN)$/.test(tag) && children.length &&
        children.every((c) => typeof c === 'string' || !BLOCKS.has(c[0])) &&
        children.some((c) => (typeof c === 'string' ? c.trim() : true))) {
      return [['p', null, ...children]];
    }
    return children;
  };

  const content = parts.flatMap((part) => walk(part, false));
  const lead = meta('og:image', 'twitter:image');
  let leadImage = '';
  try { if (lead) leadImage = new URL(lead, location.href).href; } catch { /* none */ }

  return {
    url: location.href, title, byline, site, published, excerpt, words,
    lang: document.documentElement.lang || '', dir: getComputedStyle(document.body).direction === 'rtl' ? 'rtl' : 'ltr',
    leadImage, content,
  };
}

/* ---- main's half: make it safe -------------------------------------------- */

const BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure',
  'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'hr']);
const INLINE_TAGS = new Set(['a', 'em', 'strong', 'sup', 'sub', 'small', 'mark', 's', 'del', 'ins', 'q', 'cite', 'abbr',
  'time', 'code', 'kbd', 'var', 'samp', 'u', 'br', 'img']);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
/** Gone with everything inside them: their text is code or controls, never the article. */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed', 'svg', 'math',
  'canvas', 'video', 'audio', 'form', 'input', 'button', 'select', 'textarea', 'head', 'title', 'meta', 'link', 'base']);
/** Containers whose loose text and inline pieces are gathered into paragraphs. */
const FLOWS = new Set(['root', 'blockquote', 'figure', 'li', 'dd']);
const LIMITS = { nodes: 20000, text: 500000, depth: 40, url: 4096 };

/** An http(s) address, without any user:password@, or ''. */
function webUrl(value) {
  if (typeof value !== 'string' || value.length > LIMITS.url) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    return url.href;
  } catch { return ''; }
}

/** An image address: http(s), or a small inline raster picture. */
function imageUrl(value) {
  if (typeof value === 'string' && /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value)) {
    return value.length <= 200000 ? value.replace(/\s+/g, '') : '';
  }
  return webUrl(value);
}

/**
 * Inline content cut into passages where two or more <br>s (with only space
 * between them) make a blank line: how a page without paragraphs has them.
 */
function splitAtBreaks(list) {
  const isBreak = (node) => Array.isArray(node) && node[0] === 'br';
  const isSpace = (node) => typeof node === 'string' && !node.trim();
  const runs = [[]];
  for (let i = 0; i < list.length; i++) {
    if (isBreak(list[i])) {
      let j = i + 1;
      while (isSpace(list[j])) j++;
      if (isBreak(list[j])) {
        while (j < list.length && (isBreak(list[j]) || isSpace(list[j]))) j++;
        runs.push([]);
        i = j - 1;
        continue;
      }
    }
    runs[runs.length - 1].push(list[i]);
  }
  return runs;
}

const plain = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const count = (value, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/**
 * Rebuild an extracted article from the allow-list. Anything not on it is
 * dropped (a tag) or unwrapped to its text (an unknown wrapper). Returns null
 * when nothing worth reading is left.
 */
function clean(raw, pageUrl = '') {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.content)) return null;
  let nodes = 0;
  let text = 0;
  let words = 0;

  const attrsFor = (tag, attrs) => {
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) attrs = {};
    if (tag === 'a') {
      const href = webUrl(attrs.href);
      return href ? { href } : null;
    }
    if (tag === 'img') {
      const src = imageUrl(attrs.src);
      if (!src) return null;
      const out = { src, alt: plain(attrs.alt, 300) };
      const width = count(attrs.width, 1, 20000);
      const height = count(attrs.height, 1, 20000);
      if (width && height) { out.width = width; out.height = height; }
      return out;
    }
    if (tag === 'td' || tag === 'th') {
      const out = {};
      for (const key of ['colspan', 'rowspan']) { const n = count(attrs[key], 2, 50); if (n) out[key] = n; }
      return out;
    }
    if (tag === 'ol') {
      const start = count(attrs.start, 2, 100000);
      return start ? { start } : {};
    }
    return {};
  };

  const visit = (node, depth, inPre) => {
    if (nodes++ > LIMITS.nodes || text > LIMITS.text) return [];
    if (typeof node === 'string') {
      const value = node.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      const kept = inPre ? value : value.replace(/\s+/g, ' ');
      text += kept.length;
      words += (kept.match(/[\p{L}\p{N}]+/gu) || []).length;
      return kept ? [kept] : [];
    }
    if (!Array.isArray(node) || typeof node[0] !== 'string') return [];
    const tag = node[0].toLowerCase();
    if (DROP_TAGS.has(tag)) return [];
    const children = depth >= LIMITS.depth ? [] : node.slice(2).flatMap((child) => visit(child, depth + 1, inPre || tag === 'pre'));
    if (!BLOCK_TAGS.has(tag) && !INLINE_TAGS.has(tag)) return children;
    const attrs = attrsFor(tag, node[1]);
    if (attrs === null) return tag === 'a' ? children : [];
    if (VOID_TAGS.has(tag)) return [[tag, attrs]];
    if (!children.length) return [];
    if (tag === 'p') {
      const runs = splitAtBreaks(children).filter((run) => run.some(hasWords));
      if (runs.length > 1) return runs.map((run) => ['p', attrs, ...trimRun(run)]);
    }
    return [[tag, attrs, ...children]];
  };

  const isBlock = (node) => Array.isArray(node) && BLOCK_TAGS.has(node[0]) && node[0] !== 'li';
  const hasWords = (node) => (typeof node === 'string' ? node.trim().length > 0 : node[0] === 'img' || node.slice(2).some(hasWords));

  // Loose text and inline pieces between blocks become paragraphs, so the
  // page never has to guess what a bare string at the top level means.
  const flow = (list, container) => {
    const out = [];
    let run = [];
    const flush = () => {
      for (const part of splitAtBreaks(run)) {
        if (!part.some(hasWords)) continue;
        const words = part.filter(hasWords);
        const lonelyImage = words.length === 1 && Array.isArray(words[0]) && words[0][0] === 'img';
        out.push(lonelyImage ? ['figure', {}, words[0]] : ['p', {}, ...trimRun(part)]);
      }
      run = [];
    };
    for (const node of list) {
      if (isBlock(node)) { flush(); out.push(tidy(node)); } else run.push(node);
    }
    flush();
    return container === 'root' ? out.filter((node) => node[0] === 'hr' || node[0] === 'img' || hasWords(node)) : out;
  };
  const trimRun = (run) => {
    const copy = [...run];
    const blank = (node) => (typeof node === 'string' ? !node.trim() : Array.isArray(node) && node[0] === 'br');
    while (copy.length && blank(copy[0])) copy.shift();
    while (copy.length && blank(copy.at(-1))) copy.pop();
    if (typeof copy[0] === 'string') copy[0] = copy[0].replace(/^\s+/, '');
    if (typeof copy.at(-1) === 'string') copy[copy.length - 1] = copy.at(-1).replace(/\s+$/, '');
    return copy;
  };
  const tidy = (node) => {
    if (!Array.isArray(node) || VOID_TAGS.has(node[0])) return node;
    const [tag, attrs, ...kids] = node;
    const inner = kids.map(tidy);
    return [tag, attrs, ...(FLOWS.has(tag) && inner.some(isBlock) ? flow(inner, tag) : inner)];
  };

  const content = flow(raw.content.flatMap((node) => visit(node, 0, false)), 'root');
  if (!content.length || words < 40) return null;

  const url = webUrl(raw.url) || webUrl(pageUrl);
  let site = plain(raw.site, 80);
  if (!site && url) site = new URL(url).hostname.replace(/^www\./, '');
  const published = plain(raw.published, 40);
  const date = published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : '';
  return {
    url,
    title: plain(raw.title, 300) || site,
    byline: plain(raw.byline, 160),
    site,
    published: date,
    excerpt: plain(raw.excerpt, 400),
    lang: /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(raw.lang || '') ? raw.lang : '',
    dir: raw.dir === 'rtl' ? 'rtl' : 'ltr',
    words,
    minutes: Math.max(1, Math.round(words / 230)),
    content,
  };
}

/** The page-side functions, as source to run in an isolated world. */
const PROBE_SOURCE = '(' + probablyReadable.toString() + ')()';
const EXTRACT_SOURCE = '(' + extract.toString() + ')(false)';
const MEASURE_SOURCE = '(' + extract.toString() + ')(true)';

/**
 * Whether a page measured by MEASURE_SOURCE holds an article: a good deal of
 * prose, mostly not links. A front page of headlines passes the cheap check
 * above (lots of text) and fails this one (it is nearly all links).
 */
function looksLikeArticle(measured) {
  return !!measured && measured.length >= 900 && measured.linkDensity < 0.45;
}

module.exports = { clean, probablyReadable, extract, looksLikeArticle, PROBE_SOURCE, EXTRACT_SOURCE, MEASURE_SOURCE };
