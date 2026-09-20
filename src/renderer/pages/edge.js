'use strict';
(function () {
/**
 * The autohide reveal strip.
 *
 * Reports that the pointer reached the right edge of the window, so main can
 * slide the sidebar back. It does nothing else: no clicks, no state, no
 * opinion about whether the sidebar should actually open - that is main's
 * decision, because only main knows the current mode.
 */

const { invoke } = window.page;

let inside = false;

document.addEventListener('pointerenter', () => {
  if (inside) return;
  inside = true;
  invoke('sidebar:peek', { show: true }).catch(() => {
    // Main may have changed mode underneath us; it is the authority.
  });
});

// Leaving the strip does NOT hide the sidebar: the pointer has to cross this
// strip to reach the sidebar itself, so hiding on leave would make it
// impossible to use. The sidebar hides itself when the pointer leaves IT.
document.addEventListener('pointerleave', () => { inside = false; });

})();
