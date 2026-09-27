'use strict';
(function () {
/** Drop zones for opening a dragged tab beside the current one. */
const { invoke, onState } = window.page;

for (const zone of document.querySelectorAll('.zone')) {
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('over');
    invoke('split:drop', { side: zone.dataset.side });
  });
}
// Dropping in the middle, or anywhere else, does nothing but must not
// navigate this view to the dragged data.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => { event.preventDefault(); invoke('split:drag', { id: null }); });

onState(() => {});
})();
