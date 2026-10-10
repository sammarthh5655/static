'use strict';
(function () {
/** Drop zones: let a dragged tab go on a half of the page to split with it. */
const { invoke, onState } = window.page;

const zones = [...document.querySelectorAll('.zone')];
const light = (zone) => zones.forEach((z) => z.classList.toggle('over', z === zone));

for (const zone of zones) {
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    light(zone);
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    light(null);
    invoke('split:drop', { side: zone.dataset.side });
  });
}
// Back over the tab strip: nothing is lit. Leaving one half for the other
// is handled by the dragover above, so only a leave out of the page counts.
document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) light(null); });
// Anything else let go here must not navigate this view to the dragged data.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

onState(() => {});
})();
