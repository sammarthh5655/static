'use strict';
(function () {
/** Drag the handle to resize the panes; main turns the pointer into a ratio. */
const { invoke, onState } = window.page;

let dragging = false;
let pending = null;

document.body.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  document.body.classList.add('dragging');
  document.body.setPointerCapture(event.pointerId);
});
document.body.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const first = pending === null;
  pending = event.screenX;
  if (first) {
    requestAnimationFrame(() => {
      invoke('split:resize', { screenX: pending }).catch(() => {});
      pending = null;
    });
  }
});
const stop = (event) => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  try { document.body.releasePointerCapture(event.pointerId); } catch { /* already released */ }
};
document.body.addEventListener('pointerup', stop);
document.body.addEventListener('pointercancel', stop);
document.body.addEventListener('dblclick', () => invoke('split:reset'));
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  invoke('split:menu', { x: event.clientX, y: event.clientY });
});

onState(() => {});
})();
