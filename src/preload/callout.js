/**
 * The sign-in callout: "Saved login for github.com - sam@example.com [Fill]",
 * shown under a site's sign-in box when Static has a login for it.
 *
 * Drawn by the preload (an isolated world) inside a CLOSED shadow root, so
 * the site's scripts cannot read the usernames in it or reach its buttons,
 * and the site's CSS cannot restyle it. It carries no password: a click
 * sends only an opaque token to main, which checks the tab and the site
 * before filling, exactly as for the suggestion menu. Synthetic clicks from
 * the page are ignored - only a real one fills.
 */

const WIDTH = 320;

const CSS = `
:host { all: initial; }
.card {
  box-sizing: border-box;
  width: ${WIDTH}px;
  max-width: calc(100vw - 16px);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  background:
    radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 60%),
    color-mix(in srgb, var(--surface) 94%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 14px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, .38), 0 0 0 1px rgba(255, 255, 255, .03) inset;
  backdrop-filter: blur(16px) saturate(1.5);
  padding: 10px;
  animation: in 220ms cubic-bezier(.22, .61, .36, 1) both;
  position: relative;
}
.card.above { animation-name: in-above; }
@keyframes in { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes in-above { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
.card.out { animation: out 160ms ease forwards; }
@keyframes out { to { opacity: 0; transform: translateY(-4px) scale(.98); } }
.nub {
  position: absolute; top: -6px; left: 22px; width: 10px; height: 10px; transform: rotate(45deg);
  background: color-mix(in srgb, var(--surface) 94%, var(--accent));
  border-left: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-top: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
}
.card.above .nub { top: auto; bottom: -6px; transform: rotate(225deg); }
.head { display: flex; align-items: center; gap: 9px; padding: 2px 2px 8px; }
.glyph {
  width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 8px;
  color: var(--bg); background: linear-gradient(135deg, var(--accent), var(--accent-alt));
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 40%, transparent);
}
.title { flex: 1; min-width: 0; }
.title strong { display: block; font-weight: 600; font-size: 12.5px; }
.title span { display: block; font-size: 11.5px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.close {
  width: 24px; height: 24px; flex: none; display: grid; place-items: center; border: 0; border-radius: 7px;
  background: transparent; color: var(--dim); cursor: pointer; font: inherit;
}
.close:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.list { display: grid; gap: 4px; }
.row {
  display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 8px; border-radius: 10px;
  background: color-mix(in srgb, var(--bg) 45%, transparent); border: 1px solid transparent;
}
.row:hover { border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.avatar {
  width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 50%;
  font-size: 12px; font-weight: 700; color: var(--bg);
  background: linear-gradient(135deg, var(--accent-alt), var(--accent));
}
.who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.fill {
  flex: none; padding: 6px 14px; border: 0; border-radius: 8px; cursor: pointer;
  font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--bg); background: linear-gradient(120deg, var(--accent), var(--accent-alt));
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 35%, transparent);
  transition: transform 120ms ease, filter 120ms ease;
}
.fill:hover { filter: brightness(1.08); transform: translateY(-1px); }
.fill:disabled { opacity: .6; cursor: default; transform: none; }
.fill:focus-visible, .close:focus-visible, .more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.foot { display: flex; align-items: center; gap: 8px; padding: 8px 2px 0; font-size: 11px; color: var(--dim); }
.foot .brand { margin-left: auto; letter-spacing: .6px; text-transform: lowercase; opacity: .8; }
.more { border: 0; padding: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .card, .card.out { animation: none; } }
`;

const KEY = 'M15.5 7.5a3.5 3.5 0 1 1-4.9 3.2L4 17.3V20h2.7l.8-.8v-1.7h1.7l.9-.9v-1.7h1.7l1.5-1.5a3.5 3.5 0 0 1 2.2-5.8Z';

let current = null;

function svgIcon(d, size) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.9');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Show the callout under `anchor`.
 * @param {object} data { site, accounts: [{ token, username }], more, locked, theme }
 * @param {{ anchor: HTMLElement, onFill: (token: string) => void, onMore: () => void }} hooks
 */
function show(data, { anchor, onFill, onMore }) {
  hide(true);
  const theme = data.theme || {};
  const host = document.createElement('div');
  host.style.setProperty('all', 'initial');
  host.style.setProperty('position', 'fixed');
  host.style.setProperty('z-index', '2147483647');
  host.style.setProperty('top', '0');
  host.style.setProperty('left', '0');
  const shadow = host.attachShadow({ mode: data.inspectable ? 'open' : 'closed' });
  const vars = { '--accent': theme.accent || '#5aa7f0', '--accent-alt': theme.accentAlt || '#7d8ef2', '--surface': theme.surface || '#131e2c',
    '--text': theme.text || '#e7eef7', '--dim': theme.dim || '#93a6bd', '--border': theme.border || '#223047', '--bg': theme.bg || '#0a1018' };
  try {
    // A constructed sheet is not blocked by a page's style-src policy the way
    // a <style> element would be.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
  }

  const card = el('div', 'card');
  for (const [name, value] of Object.entries(vars)) card.style.setProperty(name, value);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Saved login for ' + data.site);

  const glyph = el('div', 'glyph');
  glyph.append(svgIcon(KEY, 15));
  const title = el('div', 'title');
  title.append(el('strong', '', (data.accounts.length > 1 || data.more) ? 'Saved logins for ' + data.site : 'Saved login for ' + data.site),
    el('span', '', data.locked ? 'Locked - Fill asks for your master password' : 'One click to fill'));
  const close = el('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  const head = el('div', 'head');
  head.append(glyph, title, close);

  const list = el('div', 'list');
  for (const account of data.accounts.slice(0, 4)) {
    const row = el('div', 'row');
    const name = account.username || '(no username)';
    const avatar = el('div', 'avatar', (name.replace(/[^a-z0-9]/gi, '').charAt(0) || '?').toUpperCase());
    const who = el('div', 'who', name);
    who.title = name;
    const fill = el('button', 'fill', 'Fill');
    fill.type = 'button';
    fill.setAttribute('aria-label', 'Fill ' + name);
    fill.addEventListener('click', (event) => {
      // Only a real click: a page cannot script its way into a fill.
      if (!event.isTrusted) return;
      fill.disabled = true;
      fill.textContent = data.locked ? 'Unlock…' : 'Filling…';
      onFill(account.token);
    });
    row.append(avatar, who, fill);
    list.append(row);
  }

  card.append(el('div', 'nub'), head, list);
  const foot = el('div', 'foot');
  if (data.more) {
    const more = el('button', 'more', '+' + data.more + ' more');
    more.type = 'button';
    more.addEventListener('click', (event) => { if (event.isTrusted) { hide(); onMore(); } });
    foot.append(more);
  }
  foot.append(el('span', 'brand', 'static passwords'));
  card.append(foot);
  shadow.append(card);

  close.addEventListener('click', (event) => { if (event.isTrusted) hide(); });
  card.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });

  (document.body || document.documentElement).append(host);
  current = { host, card, anchor, timer: 0 };
  place();
  const onMove = () => place();
  window.addEventListener('scroll', onMove, { capture: true, passive: true });
  window.addEventListener('resize', onMove, { passive: true });
  current.cleanup = () => {
    window.removeEventListener('scroll', onMove, { capture: true });
    window.removeEventListener('resize', onMove);
  };
  // Pages move their forms about as they finish drawing.
  current.timer = setInterval(place, 400);
}

/** Keep the card under its field; go away with the field. */
function place() {
  if (!current) return;
  const { anchor, host, card } = current;
  if (!anchor.isConnected) { hide(true); return; }
  const box = anchor.getBoundingClientRect();
  if (!box.width || !box.height || getComputedStyle(anchor).visibility === 'hidden') { host.style.setProperty('display', 'none'); return; }
  host.style.setProperty('display', 'block');
  const height = card.offsetHeight || 150;
  const width = Math.min(WIDTH, window.innerWidth - 16);
  const below = box.bottom + 10 + height <= window.innerHeight || box.top < height + 10;
  card.classList.toggle('above', !below);
  const top = below ? box.bottom + 10 : box.top - 10 - height;
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  host.style.setProperty('transform', 'translate(' + Math.round(left) + 'px, ' + Math.round(top) + 'px)');
}

function hide(now = false) {
  if (!current) return;
  const { host, card, timer, cleanup } = current;
  current = null;
  clearInterval(timer);
  cleanup?.();
  if (now) { host.remove(); return; }
  card.classList.add('out');
  setTimeout(() => host.remove(), 170);
}

const showing = () => !!current;

module.exports = { show, hide, showing };
