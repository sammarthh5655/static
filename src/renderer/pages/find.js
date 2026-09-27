'use strict';
(function () {
/**
 * Find in page. Main runs the search on the active tab and reports the
 * result count back; this page only collects the text.
 */
const { invoke, $, onState } = window.page;

const input = $('#query');
const count = $('#count');
// Electron's `findNext: true` STARTS a new search and `false` continues the
// current one (the reverse of what the name suggests), so new text sends
// true and Next/Previous send false.
function search() {
  const text = input.value;
  if (!text) { count.textContent = ''; count.classList.remove('none'); }
  invoke('find:query', { text, forward: true, findNext: true }).catch(() => {});
}
function step(forward) {
  if (!input.value) return;
  invoke('find:query', { text: input.value, forward, findNext: false }).catch(() => {});
}

input.addEventListener('input', search);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); step(!event.shiftKey); }
  if (event.key === 'Escape') { event.preventDefault(); invoke('find:close'); }
});
$('#next').addEventListener('click', () => step(true));
$('#previous').addEventListener('click', () => step(false));
$('#close').addEventListener('click', () => invoke('find:close'));
$('#form').addEventListener('submit', (event) => event.preventDefault());

window.browser.on('find:result', (result) => {
  if (!input.value) { count.textContent = ''; return; }
  const matches = result?.matches || 0;
  count.textContent = matches ? (result.active || 1) + ' of ' + matches : 'No results';
  count.classList.toggle('none', !matches);
});

// Main asks for focus when Ctrl+F is pressed again while the bar is open.
window.browser.on('find:focus', (payload) => {
  if (typeof payload?.text === 'string' && payload.text && payload.text !== input.value) {
    input.value = payload.text;
    search();
  }
  input.focus();
  input.select();
});

onState(() => {});
input.focus();
})();
