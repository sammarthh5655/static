'use strict';

/**
 * The page tools' cards, drawn inside a menu in the overlay (see ui.js#menu):
 *
 * - `qr`: a QR code of the page's address, with Copy image and Save;
 * - `shot`: a screenshot just taken, with Copy and Save;
 * - `region`: the area picker - a still of the page under a veil, to drag a
 *   rectangle across, adjust, and capture.
 *
 * Main sends each as data (features/pagetools): the QR code as rows of
 * modules it encoded itself, pictures as data: URLs it made from the page.
 * Every button sends a token back on the item's own channel; main holds the
 * actual picture, so nothing here can point a save at a different file.
 * `item.run` (attached by overlay.js) sends a request and resolves with
 * main's answer; `item.settle` gives the overlay back if nothing follows.
 */
(function () {

const SVG_NS = 'http://www.w3.org/2000/svg';

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** No movement: the system asks for less, or Static's animations are off. */
function still() {
  const ms = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--motion-base'), 10) || 0;
  return ms === 0 || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function button(label, iconName, { primary = false, onClick } = {}) {
  const b = node('button', 'pt-btn' + (primary ? ' is-primary' : ''));
  b.type = 'button';
  b.append(window.ui.icon(iconName, { size: 15 }), node('span', 'pt-btn-label', label));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** The top of a card: a glowing plate with the tool's icon, what it is, and a close button. */
function header(iconName, title, sub, close) {
  const top = node('div', 'pt-head');
  const plate = node('span', 'pt-plate');
  plate.append(window.ui.icon(iconName, { size: 17 }));
  const words = node('div', 'pt-words');
  words.append(node('strong', 'pt-title', title), node('span', 'pt-sub', sub));
  const x = window.ui.iconButton('close', { title: 'Close', onClick: () => close(), size: 15, className: 'pt-close' });
  top.append(plate, words, x);
  return top;
}

/**
 * The line under the buttons. A result arrives with a small tick (or a
 * warning glyph) and, after a save, a way to see the file.
 */
function statusLine() {
  const line = node('div', 'pt-status');
  line.setAttribute('role', 'status');
  const say = (text, { ok = true, link = null, title = '' } = {}) => {
    line.replaceChildren();
    line.title = title;
    line.classList.remove('is-in', 'is-error');
    void line.offsetWidth;
    line.classList.add('is-in');
    line.classList.toggle('is-error', !ok);
    const glyph = node('span', 'pt-status-glyph');
    glyph.append(window.ui.icon(ok ? 'check' : 'warn', { size: 13 }));
    line.append(glyph, node('span', 'pt-status-text', text));
    if (link) {
      const go = node('button', 'pt-link', link.label);
      go.type = 'button';
      go.addEventListener('click', link.onClick);
      line.append(go);
    }
  };
  return { line, say };
}

/**
 * Copy and Save, wired to main. The busy button pulses while main works;
 * the answer lands in the status line.
 */
function actions(item, token, { copyLabel, savedLabel }) {
  const row = node('div', 'pt-actions');
  const { line, say } = statusLine();
  const act = async (b, channel, done) => {
    if (b.disabled) return;
    b.disabled = true;
    b.classList.add('is-busy');
    try {
      const answer = await item.run(channel, { token });
      if (answer && answer.ok === false) say(answer.error || 'That did not work.', { ok: false });
      else done(answer);
      b.classList.remove('is-busy');
      b.classList.add('is-done');
      setTimeout(() => b.classList.remove('is-done'), 1400);
    } catch (error) {
      say(String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), { ok: false });
      b.classList.remove('is-busy');
    } finally {
      b.disabled = false;
    }
  };
  const copy = button(copyLabel, 'copy', { onClick: () => act(copy, 'shot:copy', () => say('Copied. Paste it anywhere.')) });
  const save = button('Save', 'download', {
    primary: true,
    onClick: () => act(save, 'shot:save', (answer) => say(savedLabel(answer), {
      title: answer?.folder && answer?.name ? answer.folder + ' › ' + answer.name : '',
      link: { label: 'Show in folder', onClick: () => item.run('shot:reveal', { token }) },
    })),
  });
  copy.dataset.autofocus = '';
  row.append(copy, save);
  return { row, line };
}

/* ---- the QR code ----------------------------------------------------------- */

/**
 * The code itself, as SVG: the three finder squares drawn whole, with soft
 * corners, and every data module its own square, so they can ripple out
 * from the centre when the card opens. A quiet zone of four modules all the
 * way round, as scanners need, is the white plate it sits on.
 */
function qrSymbol(rows) {
  const n = rows.length;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `-4 -4 ${n + 8} ${n + 8}`);
  svg.setAttribute('class', 'qr-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const shape = (tag, attrs, cls) => {
    const s = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    if (cls) s.setAttribute('class', cls);
    return s;
  };
  const finder = (x, y) => {
    const g = shape('g', {}, 'qr-finder');
    // A ring (7x7 less its 5x5 middle) and a 3x3 centre.
    g.append(
      shape('path', { d: `M${x + 1.4} ${y}h4.2a1.4 1.4 0 0 1 1.4 1.4v4.2a1.4 1.4 0 0 1-1.4 1.4h-4.2a1.4 1.4 0 0 1-1.4-1.4v-4.2a1.4 1.4 0 0 1 1.4-1.4Z` +
        `M${x + 1.8} ${y + 1}h3.4a.8.8 0 0 1 .8.8v3.4a.8.8 0 0 1-.8.8h-3.4a.8.8 0 0 1-.8-.8v-3.4a.8.8 0 0 1 .8-.8Z`, 'fill-rule': 'evenodd', 'shape-rendering': 'geometricPrecision' }),
      shape('rect', { x: x + 2, y: y + 2, width: 3, height: 3, rx: 0.7, 'shape-rendering': 'geometricPrecision' }),
    );
    return g;
  };
  const inFinder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  const modules = shape('g', {}, 'qr-modules');
  const centre = (n - 1) / 2;
  const reach = Math.hypot(centre, centre) || 1;
  const fragment = document.createDocumentFragment();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '1' || inFinder(x, y)) continue;
      const cell = shape('rect', { x, y, width: 1, height: 1 });
      cell.style.setProperty('--d', Math.round((Math.hypot(x - centre, y - centre) / reach) * 460) + 'ms');
      fragment.append(cell);
    }
  });
  modules.append(fragment);
  svg.append(modules, finder(0, 0), finder(n - 7, 0), finder(0, n - 7));
  return svg;
}

function qrPanel(item, { close }) {
  const spec = item.qr || {};
  const rows = Array.isArray(spec.rows) ? spec.rows.map(String) : [];
  const card = node('div', 'pt-card qr-card');
  card.append(header('qr', 'Scan to open on your phone', spec.host || '', close));

  const stage = node('div', 'qr-stage');
  const halo = node('div', 'qr-halo');
  const plate = node('div', 'qr-plate' + (still() ? '' : ' is-arriving'));
  const symbol = qrSymbol(rows);
  symbol.setAttribute('aria-label', 'QR code for ' + (spec.url || 'this page'));
  plate.append(symbol);
  stage.append(halo, plate);
  card.append(stage);

  const where = node('div', 'qr-where');
  where.append(node('div', 'qr-page', spec.title || spec.host || ''), node('div', 'qr-url', spec.url || ''));
  where.title = spec.url || '';
  card.append(where);

  const { row, line } = actions(item, spec.token, {
    copyLabel: 'Copy image',
    savedLabel: (answer) => 'Saved to ' + (answer?.where || 'Downloads'),
  });
  card.append(row, line);
  return card;
}

/* ---- a screenshot ---------------------------------------------------------- */

const SHOT_NAMES = { visible: 'Visible area', full: 'Full page', region: 'Selected area' };

function shotPanel(item, { close }) {
  const spec = item.shot || {};
  const card = node('div', 'pt-card shot-card');
  const size = (spec.width || 0) + ' × ' + (spec.height || 0) + (spec.trimmed ? ' · as far as fits in one picture' : '');
  card.append(header('camera', SHOT_NAMES[spec.mode] || 'Screenshot', size, close));

  const tall = spec.height > spec.width * 1.25;
  const frame = node('div', 'shot-frame' + (tall ? ' is-tall' : ''));
  const img = node('img', 'shot-img');
  img.alt = 'The screenshot';
  img.draggable = false;
  img.src = spec.image || '';
  frame.append(img);
  card.append(frame);

  const { row, line } = actions(item, spec.token, {
    copyLabel: 'Copy',
    savedLabel: (answer) => 'Saved to ' + (answer?.where || 'Pictures'),
  });
  card.append(row, line);

  // The picture flies from where it was taken into the card, after a flash
  // over that spot: a camera's click, seen rather than heard.
  if (spec.from && !still()) {
    frame.classList.add('is-arriving');
    requestAnimationFrame(() => requestAnimationFrame(() => flyIn(frame, img, spec.from)));
  }
  return card;
}

function flyIn(frame, img, from) {
  const to = frame.getBoundingClientRect();
  const finish = () => { frame.classList.remove('is-arriving'); ghost.remove(); flash.remove(); };
  const flash = node('div', 'shot-flash');
  const ghost = node('img', 'shot-ghost');
  for (const n of [flash, ghost]) {
    n.style.left = to.left + 'px';
    n.style.top = to.top + 'px';
    n.style.width = to.width + 'px';
    n.style.height = to.height + 'px';
  }
  flash.style.left = from.x + 'px';
  flash.style.top = from.y + 'px';
  flash.style.width = from.width + 'px';
  flash.style.height = from.height + 'px';
  ghost.src = img.src;
  ghost.alt = '';
  if (frame.classList.contains('is-tall')) ghost.classList.add('is-tall');
  document.body.append(flash, ghost);
  const start = `translate(${from.x - to.left}px, ${from.y - to.top}px) scale(${from.width / Math.max(1, to.width)}, ${from.height / Math.max(1, to.height)})`;
  const ms = Math.max(200, (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--motion-base'), 10) || 170) * 3.4);
  flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: ms * 0.6, easing: 'ease-out', fill: 'forwards' });
  const flight = ghost.animate([
    { transform: start, borderRadius: '2px', boxShadow: '0 0 0 rgba(0,0,0,0)' },
    { transform: 'none', borderRadius: '10px', boxShadow: '0 18px 50px rgba(0,0,0,.45)' },
  ], { duration: ms, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards' });
  flight.finished.then(finish, finish);
  // A view that is not being composited does not finish animations: never
  // leave the card without its picture because of that.
  setTimeout(finish, ms + 400);
}

/* ---- choosing an area ------------------------------------------------------ */

const EDGES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN = 8;

function regionPanel(item, { close, root }) {
  const spec = item.region || {};
  const bounds = spec.bounds || { x: 0, y: 0, width: innerWidth, height: innerHeight };
  const W = bounds.width;
  const H = bounds.height;

  const stage = node('div', 'rg-stage');
  for (const key of ['left', 'top', 'width', 'height']) {
    stage.style[key] = (key === 'left' ? bounds.x : key === 'top' ? bounds.y : bounds[key]) + 'px';
  }
  const shot = node('img', 'rg-shot');
  shot.src = spec.image || '';
  shot.alt = '';
  shot.draggable = false;
  const shade = node('div', 'rg-shade');
  const guideX = node('div', 'rg-guide is-x');
  const guideY = node('div', 'rg-guide is-y');
  const sel = node('div', 'rg-sel');
  sel.hidden = true;
  for (const edge of EDGES) {
    const handle = node('span', 'rg-handle is-' + edge);
    handle.dataset.edge = edge;
    sel.append(handle);
  }
  const size = node('div', 'rg-size');
  sel.append(size);

  const hint = node('div', 'rg-hint');
  const kbd = (text) => node('kbd', '', text);
  hint.append(window.ui.icon('crop', { size: 15 }), node('span', '', 'Drag across the part you want'),
    node('span', 'rg-hint-keys'));
  hint.lastChild.append(kbd('Esc'), document.createTextNode(' to cancel'));

  const bar = node('div', 'rg-bar');
  bar.hidden = true;
  const cancel = button('Cancel', 'close', { onClick: () => close() });
  const take = button('Capture', 'camera', { primary: true, onClick: () => confirm() });
  take.title = 'Capture (Enter)';
  bar.append(cancel, take);

  stage.append(shot, shade, guideX, guideY, sel, hint, bar);

  let rect = null;
  let drag = null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const point = (event) => {
    const box = stage.getBoundingClientRect();
    return { x: clamp(event.clientX - box.left, 0, W), y: clamp(event.clientY - box.top, 0, H) };
  };
  const inside = (p, r) => r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
  // How many of the picture's own pixels one of ours is: the size label
  // says what the screenshot will be, not how big the box looks.
  const scale = () => (shot.naturalWidth ? shot.naturalWidth / W : (window.devicePixelRatio || 1));

  function render() {
    root.classList.toggle('has-selection', !!rect);
    sel.hidden = !rect;
    shade.hidden = !!rect;
    if (!rect) { bar.hidden = true; return; }
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.width + 'px';
    sel.style.height = rect.height + 'px';
    size.textContent = Math.round(rect.width * scale()) + ' × ' + Math.round(rect.height * scale());
    size.classList.toggle('is-inside', rect.y < 30);
    bar.hidden = !!drag || rect.width < MIN || rect.height < MIN;
    if (!bar.hidden) {
      // Under the selection's right-hand corner; above it, or tucked inside,
      // when there is no room below.
      const bw = bar.offsetWidth || 190;
      const bh = bar.offsetHeight || 40;
      let top = rect.y + rect.height + 10;
      if (top + bh > H - 8) top = rect.y - bh - 10;
      if (top < 8) top = rect.y + rect.height - bh - 10;
      bar.style.left = clamp(rect.x + rect.width - bw, 8, W - bw - 8) + 'px';
      bar.style.top = clamp(top, 8, H - bh - 8) + 'px';
    }
  }

  function guides(p) {
    const show = !!p && !rect && !drag;
    guideX.hidden = !show;
    guideY.hidden = !show;
    if (show) {
      guideX.style.transform = `translateY(${p.y}px)`;
      guideY.style.transform = `translateX(${p.x}px)`;
    }
  }
  guides(null);

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || bar.contains(event.target)) return;
    event.preventDefault();
    const p = point(event);
    const edge = event.target.dataset?.edge;
    if (rect && edge) drag = { mode: 'resize', edge, start: p, from: { ...rect } };
    else if (rect && inside(p, rect)) drag = { mode: 'move', start: p, from: { ...rect } };
    else { drag = { mode: 'new', start: p }; rect = { x: p.x, y: p.y, width: 0, height: 0 }; }
    stage.setPointerCapture(event.pointerId);
    root.classList.add('is-dragging');
    hint.classList.add('is-gone');
    guides(null);
    render();
  });

  stage.addEventListener('pointermove', (event) => {
    const p = point(event);
    if (!drag) {
      guides(p);
      stage.dataset.over = rect && inside(p, rect) ? 'move' : '';
      return;
    }
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (drag.mode === 'new') {
      rect = { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), width: Math.abs(dx), height: Math.abs(dy) };
    } else if (drag.mode === 'move') {
      rect = { ...drag.from, x: clamp(drag.from.x + dx, 0, W - drag.from.width), y: clamp(drag.from.y + dy, 0, H - drag.from.height) };
    } else {
      let { x, y, width, height } = drag.from;
      let right = x + width;
      let bottom = y + height;
      if (drag.edge.includes('w')) x = clamp(x + dx, 0, right - MIN);
      if (drag.edge.includes('e')) right = clamp(right + dx, x + MIN, W);
      if (drag.edge.includes('n')) y = clamp(y + dy, 0, bottom - MIN);
      if (drag.edge.includes('s')) bottom = clamp(bottom + dy, y + MIN, H);
      rect = { x, y, width: right - x, height: bottom - y };
    }
    render();
  });

  const end = () => {
    if (!drag) return;
    const wasNew = drag.mode === 'new';
    drag = null;
    root.classList.remove('is-dragging');
    // A click rather than a drag: nothing chosen yet, so carry on choosing.
    if (wasNew && rect && (rect.width < MIN || rect.height < MIN)) {
      rect = null;
      hint.classList.remove('is-gone');
    }
    render();
    if (rect) take.focus({ preventScroll: true });
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('pointerleave', () => { if (!drag) guides(null); });
  sel.addEventListener('dblclick', () => confirm());

  function confirm() {
    if (!rect || rect.width < MIN || rect.height < MIN) return;
    const chosen = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    // The card that follows takes over the overlay; if none does, give it back.
    close({ handoff: true });
    Promise.resolve(item.run('shot:region', { token: spec.token, rect: chosen }))
      .then((shown) => { if (!shown) item.settle(); }, () => item.settle());
  }

  // Enter captures; the listener goes with the picker.
  const onKey = (event) => {
    if (!root.classList.contains('menu')) { window.removeEventListener('keydown', onKey, true); return; }
    if (event.key === 'Enter' && rect && !event.target.closest?.('.rg-bar .pt-btn:not(.is-primary)')) {
      event.preventDefault();
      confirm();
    }
  };
  window.addEventListener('keydown', onKey, true);

  // Pressing outside the page (on the toolbar's part of the window) leaves.
  root.addEventListener('pointerdown', (event) => { if (event.target === root) close(); });

  return stage;
}

window.pageToolPanels = { qr: qrPanel, shot: shotPanel, region: regionPanel };

})();
