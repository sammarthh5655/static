// Wrapped in an IIFE: widget files load as plain <script> tags and classic
// scripts share one global scope.
(function () {
/**
 * Customise mode for the homepage.
 *
 * Turns the widget grid into something the user arranges: drag to reorder,
 * toggle widgets on and off, apply a preset layout, or reset.
 *
 * WHY DRAG AND NOT RESIZE
 * The grid is `auto-fit` with a minimum column width, so widgets already size
 * themselves to the window and stay legible at any width. Free resizing would
 * mean storing pixel geometry per widget, which breaks the moment the window
 * changes size or the page is opened on another display - the layout would
 * need repairing rather than just rendering. Order and visibility are what
 * actually change how the page reads, so those are what this edits.
 *
 * Everything writes through settings:update, which validates and drops unknown
 * ids, so a layout saved by a later version cannot render this page unusable.
 */

const RENDERERS = window.widgetRenderers || (window.widgetRenderers = {});

/**
 * Preset layouts.
 *
 * Each names widgets that exist in the registry; settings drops anything it
 * does not recognise, so a preset can safely mention a widget added later.
 */
const PRESETS = {
  minimal: { name: 'Minimal', widgets: ['clock'] },
  privacy: { name: 'Privacy', widgets: ['clock', 'privacy'] },
  productivity: { name: 'Productivity', widgets: ['clock', 'notes', 'reading', 'shortcuts'] },
  student: { name: 'Student', widgets: ['clock', 'notes', 'reading', 'privacy'] },
  everything: { name: 'Everything', widgets: ['clock', 'privacy', 'notes', 'reading', 'shortcuts', 'recent', 'downloads'] },
};

/**
 * Build the customise bar.
 *
 * Returned as a node the page mounts above the grid; it is not a widget and
 * never appears in the layout itself.
 */
function build(ctx, { getLayout, setLayout, onExit }) {
  const registry = (window.widgets && window.widgets.WIDGETS) || {};

  const bar = ctx.element('div', { class: 'customise' });
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Customise homepage');

  const head = ctx.element('div', { class: 'customise-head' }, [
    ctx.element('span', { class: 'customise-title', text: 'Customise' }),
  ]);

  const done = ctx.element('button', { class: 'customise-done', text: 'Done' });
  done.addEventListener('click', onExit);
  head.appendChild(done);

  /** Toggle chips: one per registered widget, on when it is in the layout. */
  const chips = ctx.element('div', { class: 'customise-chips' });
  const paintChips = () => {
    const layout = getLayout();
    const nodes = Object.values(registry).map((widget) => {
      const on = layout.includes(widget.id);
      const chip = ctx.element('button', {
        class: 'customise-chip' + (on ? ' is-on' : ''),
        text: widget.name,
      });
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.title = widget.description || '';
      chip.addEventListener('click', () => {
        const next = getLayout();
        setLayout(on ? next.filter((id) => id !== widget.id) : [...next, widget.id]);
      });
      return chip;
    });
    chips.replaceChildren(...nodes);
  };

  /** Preset row. */
  const presets = ctx.element('div', { class: 'customise-presets' });
  presets.appendChild(ctx.element('span', { class: 'customise-label', text: 'Layouts' }));
  for (const [id, preset] of Object.entries(PRESETS)) {
    const button = ctx.element('button', { class: 'customise-preset', text: preset.name });
    button.dataset.preset = id;
    button.addEventListener('click', () => setLayout([...preset.widgets]));
    presets.appendChild(button);
  }

  const reset = ctx.element('button', { class: 'customise-preset is-reset', text: 'Reset' });
  reset.addEventListener('click', () => {
    const fallback = (window.widgets && window.widgets.DEFAULT_LAYOUT) || ['clock'];
    setLayout([...fallback]);
  });
  presets.appendChild(reset);

  const hint = ctx.element('p', {
    class: 'customise-hint',
    text: 'Drag a card to reorder. Click a name to show or hide it.',
  });

  bar.append(head, chips, presets, hint);
  bar.refresh = paintChips;
  paintChips();
  return bar;
}

/**
 * Make the rendered grid draggable.
 *
 * Uses the HTML drag-and-drop API rather than pointer maths: it gives keyboard
 * and accessibility behaviour for free from the platform, and the drop target
 * is unambiguous. Reordering commits on drop, so an abandoned drag changes
 * nothing.
 */
function makeDraggable(host, { getLayout, setLayout }) {
  const cards = [...host.children];
  let dragging = null;

  cards.forEach((card, index) => {
    card.setAttribute('draggable', 'true');
    card.classList.add('is-draggable');
    card.dataset.index = String(index);

    card.addEventListener('dragstart', (event) => {
      dragging = index;
      card.classList.add('is-dragging');
      // Firefox requires data to be set for a drag to start at all.
      try { event.dataTransfer.setData('text/plain', String(index)); } catch { /* not fatal */ }
      event.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      dragging = null;
      card.classList.remove('is-dragging');
      for (const other of cards) other.classList.remove('is-over');
    });

    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dragging !== null && dragging !== index) card.classList.add('is-over');
    });

    card.addEventListener('dragleave', () => card.classList.remove('is-over'));

    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('is-over');
      const from = dragging !== null ? dragging : Number(event.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(from) || from === index) return;
      const layout = getLayout();
      const next = [...layout];
      const [moved] = next.splice(from, 1);
      next.splice(index, 0, moved);
      setLayout(next);
    });
  });
}

RENDERERS.__customise = { build, makeDraggable, PRESETS };

})();
