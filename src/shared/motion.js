'use strict';

/**
 * Motion for lists that change while someone is looking at them: the tab
 * strip along the top and the tab list down the side.
 *
 * The lists are kept, not redrawn: each tab keeps one node for as long as it
 * is open, so a change only inserts, moves or removes what it touched. That
 * is what lets things move at all - a node that is thrown away and rebuilt on
 * every state push can only vanish and pop in. The moves themselves are FLIP
 * (First, Last, Invert, Play): note where everything is drawn, change the
 * DOM, note where it all landed, then play each node from where it was to
 * where it is with a transform. One layout read before the change and one
 * after, however many tabs there are, and nothing but transforms and opacity
 * on the frames in between - so fifty tabs glide as cheaply as five.
 *
 * Timings come from the theme (--motion-base, --ease). Static's animations
 * setting writes 0ms there, and a system that asks for reduced motion is
 * honoured here too: either way nothing moves, and anything already moving
 * jumps straight to its end.
 *
 * A plain script for renderers (window.motion). No Electron, no Node.
 */
(function () {
if (typeof window === 'undefined') return;

const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
// Every animation started here carries one of these ids, so settle() and
// halt() never touch anyone else's (a spinner, the sound waves, a menu).
const GLIDE = 'motion-glide';
const ENTER = 'motion-enter';
const LEAVE = 'motion-leave';
const OURS = new Set([GLIDE, ENTER, LEAVE]);

/** How long a move takes now, in ms: 0 when motion is off for any reason. */
function duration() {
  if (reduced?.matches) return 0;
  const ms = parseFloat(document.documentElement.style.getPropertyValue('--motion-base'));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function ease() {
  return document.documentElement.style.getPropertyValue('--ease').trim() || 'cubic-bezier(0.22, 0.61, 0.36, 1)';
}

/** Finish everything in flight at once: motion was just turned off. */
function settle() {
  for (const animation of document.getAnimations()) {
    if (OURS.has(animation.id)) animation.finish();
  }
}
reduced?.addEventListener?.('change', () => { if (reduced.matches) settle(); });

/** Where each node is drawn right now, moves in flight included. One read pass. */
function measure(nodes) {
  const boxes = new Map();
  for (const node of nodes) if (node?.isConnected) boxes.set(node, node.getBoundingClientRect());
  return boxes;
}

/**
 * Stop the glides in progress, so the layout underneath can be read. Each
 * node's next glide starts from where it was DRAWN (measured before this),
 * so a change arriving mid-move carries on smoothly rather than jumping.
 */
function halt(nodes) {
  for (const node of nodes) {
    for (const animation of node.getAnimations({ subtree: true })) {
      if (animation.id === GLIDE) animation.cancel();
    }
  }
}

/**
 * The longest run of positions already in the right order (a longest
 * increasing subsequence of their current indices; -1 is a new node). Those
 * stay where they are and only the rest are moved, because moving a node
 * restarts its CSS animations - a loading spinner, a pop - for no reason.
 */
function steady(indices) {
  const tails = [];
  const before = new Array(indices.length).fill(-1);
  for (let i = 0; i < indices.length; i++) {
    const value = indices[i];
    if (value < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (indices[tails[mid]] < value) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) before[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = before[i]) keep.add(i);
  return keep;
}

/**
 * Make `parent`'s children exactly `wanted`, in order, touching as few as
 * possible. Nodes on their way out (.leaving) are left alone.
 */
function arrange(parent, wanted) {
  const want = new Set(wanted);
  for (const child of [...parent.children]) {
    if (!want.has(child) && !child.classList.contains('leaving')) child.remove();
  }
  const index = new Map();
  let i = 0;
  for (const child of parent.children) if (!child.classList.contains('leaving')) index.set(child, i++);
  const keep = steady(wanted.map((node) => (index.has(node) ? index.get(node) : -1)));
  let after = null;
  for (let at = wanted.length - 1; at >= 0; at--) {
    const node = wanted[at];
    if (!keep.has(at)) parent.insertBefore(node, after);
    after = node;
  }
}

/**
 * Play every node from where it was (`first`) to where it is (`last`).
 * `parentOf` names a node's moving container, whose own move its children
 * then subtract; `stretch` lets a node's change of width play too, as a
 * short horizontal scale - kept within bounds, because a big stretch would
 * visibly squash its text.
 */
function glide(first, last, { parentOf, stretch } = {}) {
  const ms = duration();
  const moves = new Map();
  if (!ms) return moves;
  for (const [node, was] of first) {
    const now = last.get(node);
    if (!now) continue;
    let sx = 1;
    if (stretch?.(node) && now.width > 0 && Math.abs(was.width - now.width) > 1) {
      const ratio = was.width / now.width;
      if (ratio > 0.6 && ratio < 1.6) sx = ratio;
    }
    moves.set(node, { dx: was.left - now.left, dy: was.top - now.top, sx });
  }
  const easing = ease();
  for (const [node, move] of moves) {
    const outer = parentOf ? moves.get(parentOf(node)) : null;
    const dx = move.dx - (outer ? outer.dx : 0);
    const dy = move.dy - (outer ? outer.dy : 0);
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && move.sx === 1) continue;
    const from = 'translate(' + dx + 'px, ' + dy + 'px)' + (move.sx !== 1 ? ' scaleX(' + move.sx + ')' : '');
    node.animate([
      { transform: from, transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' },
    ], { duration: ms, easing, id: GLIDE });
  }
  return moves;
}

/**
 * A node arriving. No fill mode: the resting state is the element's own,
 * so a view that stops ticking animations still shows it, just without the
 * entrance. `moving` marks a move rather than an arrival (it is stopped and
 * replayed like a glide when the next change lands).
 */
function enter(node, keyframes, { delay = 0, scale = 1, pseudoElement, moving = false } = {}) {
  const ms = duration();
  if (!ms) return null;
  const options = { duration: ms * scale, delay, easing: ease(), id: moving ? GLIDE : ENTER };
  if (pseudoElement) options.pseudoElement = pseudoElement;
  return node.animate(keyframes, options);
}

/**
 * A node on its way out. It is lifted out of the flow into `host` exactly
 * where it was drawn (`box`, from before the change), so the nodes around it
 * can slide into its space while it goes. From that moment it is only a
 * picture: no id, no pointer, no focus, hidden from assistive technology -
 * it cannot be clicked, hovered for a card, or found by anything looking for
 * the real thing. `paint` carries colours it would lose by leaving its
 * container (a group's tint).
 */
function lift(node, host, box, hostBox, paint = {}) {
  node.removeAttribute('data-id');
  node.removeAttribute('data-group-id');
  node.removeAttribute('data-group');
  node.removeAttribute('role');
  node.setAttribute('aria-hidden', 'true');
  node.inert = true;
  node.draggable = false;
  node.classList.add('leaving');
  for (const animation of node.getAnimations()) if (OURS.has(animation.id)) animation.cancel();
  const style = node.style;
  // The box measured is the border box; a row whose padding is not counted
  // in its width (the side list's) would otherwise jump wider as it lifts.
  style.boxSizing = 'border-box';
  style.position = 'absolute';
  style.left = (box.left - hostBox.left + host.scrollLeft) + 'px';
  style.top = (box.top - hostBox.top + host.scrollTop) + 'px';
  style.width = box.width + 'px';
  style.height = box.height + 'px';
  style.margin = '0';
  style.minWidth = '0';
  style.maxWidth = 'none';
  style.minHeight = '0';
  style.flex = 'none';
  style.pointerEvents = 'none';
  style.zIndex = '0';
  if (paint.background) style.background = paint.background;
  if (paint.color) style.color = paint.color;
  host.append(node);
  return node;
}

/**
 * Play a lifted node out, then remove it. Removed on a timer as well: a view
 * that is not being composited may never finish an animation, and a ghost
 * left behind would sit on the strip for good.
 */
function leave(node, keyframes) {
  const ms = duration();
  let gone = false;
  const done = () => { if (!gone) { gone = true; node.remove(); } };
  if (!ms) { done(); return; }
  const animation = node.animate(keyframes, { duration: ms, easing: ease(), fill: 'forwards', id: LEAVE });
  animation.finished.then(done, done);
  setTimeout(done, ms + 160);
}

/**
 * Resolves once `node` (and the group it sits in) has stopped gliding. A
 * hover card is pinned to where a tab is drawn; asked for while the tab is
 * still sliding into the space a closed one left, it would be pinned to a
 * place the tab is about to leave.
 */
function settled(node) {
  const moving = [node, node?.parentElement].filter(Boolean)
    .flatMap((n) => n.getAnimations().filter((a) => a.id === GLIDE && a.playState === 'running'));
  if (!moving.length) return Promise.resolve();
  // Capped as well, like leave(): a view that is not being composited may
  // never finish a move, and the card must still come.
  return Promise.race([
    Promise.all(moving.map((a) => a.finished.catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, duration() + 60)),
  ]).then(() => {});
}

window.motion = { duration, ease, settle, measure, halt, arrange, glide, enter, lift, leave, steady, settled };
})();
