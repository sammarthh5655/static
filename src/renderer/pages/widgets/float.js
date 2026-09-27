// Wrapped in an IIFE: widget files load as plain <script> tags.
(function () {
/**
 * Widgets that go anywhere.
 *
 * Each widget can be dragged to any spot on the page - top, bottom, either
 * side, the middle. Where it lands is stored as a FRACTION of the free space
 * across and down (0 = left/top edge, 1 = right/bottom edge), not in pixels,
 * so a layout made on a laptop still makes sense on a wide monitor and a
 * resize never pushes a widget off screen.
 *
 * Widgets nobody has moved stack down the sides, with the clock top right,
 * so the middle stays clear for the search box until the user decides.
 */

const MARGIN = 20;
const TOP = 18;
const BOTTOM = 52; // clear of the status strip
const GAP = 14;
const SNAP = 14;

function freeSpace(card) {
  return {
    width: Math.max(1, innerWidth - card.offsetWidth - MARGIN * 2),
    height: Math.max(1, innerHeight - card.offsetHeight - TOP - BOTTOM),
  };
}

function toPixels(card, at) {
  const free = freeSpace(card);
  return { left: MARGIN + at.x * free.width, top: TOP + at.y * free.height };
}

function toFraction(card, left, top) {
  const free = freeSpace(card);
  return {
    x: Math.min(1, Math.max(0, (left - MARGIN) / free.width)),
    y: Math.min(1, Math.max(0, (top - TOP) / free.height)),
  };
}

/** Put every card where it belongs: its saved spot, or down a side. */
function place(host, positions = {}) {
  const cards = [...host.querySelectorAll(':scope > [data-widget]')];
  const stacks = { left: TOP + 70, right: TOP };
  let side = 'right';
  for (const card of cards) {
    const saved = positions[card.dataset.widget];
    if (saved) {
      const at = toPixels(card, saved);
      card.style.left = at.left + 'px';
      card.style.top = at.top + 'px';
      card.classList.remove('is-default');
      continue;
    }
    // The clock goes top right; the rest alternate down the two sides.
    const column = card.dataset.widget === 'clock' ? 'right' : side;
    if (card.dataset.widget !== 'clock') side = side === 'right' ? 'left' : 'right';
    const left = column === 'left' ? MARGIN : innerWidth - card.offsetWidth - MARGIN;
    card.style.left = Math.max(MARGIN, left) + 'px';
    card.style.top = stacks[column] + 'px';
    card.classList.add('is-default');
    stacks[column] += card.offsetHeight + GAP;
  }
}

/**
 * Drag to move. While customising, the whole card is a handle; otherwise
 * only its grip is, so typing in the scratchpad never moves it.
 *
 * @param {HTMLElement} host
 * @param {{ customising: () => boolean, positions: () => object, save: (next: object) => void }} options
 */
function enableDrag(host, { customising, positions, save }) {
  if (host.dataset.floatReady) return;
  host.dataset.floatReady = '1';
  const guide = document.createElement('div');
  guide.className = 'float-guide';
  document.body.append(guide);

  host.addEventListener('pointerdown', (event) => {
    const card = event.target.closest('[data-widget]');
    if (!card || event.button !== 0) return;
    const grip = event.target.closest('.widget-grip');
    if (!grip && !customising()) return;
    if (!grip && event.target.closest('input, textarea, select, a, button, [contenteditable="true"]')) return;
    event.preventDefault();
    // Capture keeps the drag alive when the pointer outruns the card; without
    // it the move still works while the pointer stays over the card.
    try { card.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    const start = { x: event.clientX, y: event.clientY, left: card.offsetLeft, top: card.offsetTop };
    card.classList.add('is-moving');
    document.body.classList.add('moving-widget');

    const move = (ev) => {
      let left = start.left + ev.clientX - start.x;
      let top = start.top + ev.clientY - start.y;
      left = Math.min(innerWidth - card.offsetWidth - MARGIN, Math.max(MARGIN, left));
      top = Math.min(innerHeight - card.offsetHeight - BOTTOM, Math.max(TOP, top));
      // Snap to the centre line and to the edges, and show where.
      const centre = innerWidth / 2 - card.offsetWidth / 2;
      let snapped = false;
      if (Math.abs(left - centre) < SNAP) { left = centre; snapped = true; }
      guide.classList.toggle('on', snapped);
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    };
    const up = () => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
      card.classList.remove('is-moving');
      document.body.classList.remove('moving-widget');
      guide.classList.remove('on');
      const moved = Math.abs(card.offsetLeft - start.left) + Math.abs(card.offsetTop - start.top) > 2;
      if (moved) save({ ...positions(), [card.dataset.widget]: toFraction(card, card.offsetLeft, card.offsetTop) });
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  });

  // Arrow keys move a focused card while customising: 1% a press, 5% with Shift.
  host.addEventListener('keydown', (event) => {
    if (!customising()) return;
    const card = event.target.closest?.('[data-widget]');
    if (!card || event.target !== card) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const now = toFraction(card, card.offsetLeft, card.offsetTop);
    const next = { x: Math.min(1, Math.max(0, now.x + delta[0])), y: Math.min(1, Math.max(0, now.y + delta[1])) };
    const at = toPixels(card, next);
    card.style.left = at.left + 'px';
    card.style.top = at.top + 'px';
    clearTimeout(card.saveTimer);
    card.saveTimer = setTimeout(() => save({ ...positions(), [card.dataset.widget]: next }), 400);
  });
}

(window.widgetRenderers || (window.widgetRenderers = {})).__float = { place, enableDrag, toFraction, toPixels };
})();
