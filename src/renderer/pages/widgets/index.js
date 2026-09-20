'use strict';

/**
 * New tab widget implementations.
 *
 * Each entry is `id -> render(context) => HTMLElement`. The id must match a
 * declaration in src/shared/widgets.js; the registry there is what the
 * customiser lists, and this map is what actually draws.
 *
 * To add a widget: declare it in shared/widgets.js, add a render function
 * here. Nothing else needs to change - the page picks it up automatically.
 *
 * `context` gives each widget:
 *   state   - the current app state snapshot
 *   invoke  - IPC call
 *   element - DOM helper
 *   icon    - icon builder
 *   openUrl - navigate helper
 */
(function () {

const RENDERERS = {};

/** Card shell shared by every widget, so spacing and radius stay consistent. */
function card(title, iconName, body, ctx, actions = []) {
  const head = ctx.element('div', { class: 'widget-head' }, [
    ctx.icon(iconName, { size: 15 }),
    ctx.element('span', { class: 'widget-title', text: title }),
    ...actions,
  ]);
  return ctx.element('section', { class: 'widget' }, [head, body]);
}

/* ---- clock --------------------------------------------------------------- */

RENDERERS.clock = (ctx) => {
  const time = ctx.element('div', { class: 'clock-time' });
  const date = ctx.element('div', { class: 'clock-date' });

  const tick = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  };
  tick();
  // Cleared by the page when the widget is removed, so a hidden widget does
  // not keep a timer alive.
  const timer = setInterval(tick, 1000);

  const node = ctx.element('div', { class: 'widget widget-clock' }, [time, date]);
  node.dispose = () => clearInterval(timer);
  return node;
};

/* ---- quick links --------------------------------------------------------- */

RENDERERS.shortcuts = (ctx) => {
  const items = (ctx.state.bookmarks || []).slice(0, 8);
  const body = items.length
    ? ctx.element('div', { class: 'quick-grid' }, items.map((item) =>
        ctx.element('button', {
          class: 'quick-link',
          title: item.url,
          onclick: (event) => ctx.openUrl(item.url, event),
        }, [
          ctx.favicon(item.url),
          ctx.element('span', { class: 'quick-name', text: item.title || item.url }),
        ])))
    : ctx.element('div', { class: 'widget-empty', text: 'Bookmark a page to see it here.' });
  return card('Quick links', 'bookmark', body, ctx);
};

/* ---- recently visited ---------------------------------------------------- */

RENDERERS.recent = (ctx) => {
  const seen = new Set();
  const items = [];
  for (const entry of ctx.state.history || []) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    items.push(entry);
    if (items.length >= 5) break;
  }
  const body = items.length
    ? ctx.element('div', { class: 'widget-list' }, items.map((entry) =>
        ctx.element('button', {
          class: 'widget-row',
          title: entry.url,
          onclick: (event) => ctx.openUrl(entry.url, event),
        }, [
          ctx.favicon(entry.url),
          ctx.element('span', { class: 'widget-row-label', text: entry.title || entry.url }),
        ])))
    : ctx.element('div', { class: 'widget-empty', text: 'Pages you visit will show up here.' });
  return card('Recently visited', 'clock', body, ctx);
};

/* ---- downloads ----------------------------------------------------------- */

RENDERERS.downloads = (ctx) => {
  const items = (ctx.state.downloads || []).slice(0, 5);
  const body = items.length
    ? ctx.element('div', { class: 'widget-list' }, items.map((item) =>
        ctx.element('button', {
          class: 'widget-row',
          title: item.path || item.url,
          onclick: () => ctx.invoke('downloads:reveal', { id: item.id }),
        }, [
          ctx.icon('download', { size: 14 }),
          ctx.element('span', { class: 'widget-row-label', text: item.name }),
        ])))
    : ctx.element('div', { class: 'widget-empty', text: 'No downloads yet.' });
  return card('Downloads', 'download', body, ctx);
};

/* ---- scratchpad ---------------------------------------------------------- */

/* ---- scratchpad ----------------------------------------------------------
 * Implemented in widgets/scratchpad.js, backed by the real Notes feature.
 *
 * The version that lived here was a plain textarea over a separate
 * `newtab:notes` blob. That meant a thought captured on the homepage was
 * invisible to Notes, Auto Notes and the AI summaries - the wrong behaviour
 * for a scratchpad, so it was replaced rather than kept alongside.
 */

/* ---- AI assistant (extension point) --------------------------------------
 * Deliberately inert: there is no provider wired up and no key configured.
 * The widget renders its setup state so the extension point is visible, and
 * `submit` below is the single function a future integration replaces.
 */

RENDERERS.assistant = (ctx) => {
  // AI is available when the build ships a key; the key itself is never in
  // renderer context, so this only reports availability.
  const configured = !!ctx.credential();

  if (!configured) {
    const body = ctx.element('p', {
      class: 'widget-empty',
      text: 'AI is unavailable in this build.',
    });
    return card('AI assistant', 'sparkle', body, ctx, [
      ctx.element('span', { class: 'widget-tag', text: 'Unavailable' }),
    ]);
  }

  // Configured path. Kept as a single seam so wiring a provider later touches
  // only `ctx.ask`, not this layout.
  const input = ctx.element('input', {
    class: 'assistant-input', type: 'text', placeholder: 'Ask anything…',
  });
  const output = ctx.element('div', { class: 'assistant-output' });

  const submit = async () => {
    const question = input.value.trim();
    if (!question) return;
    output.textContent = 'Thinking…';
    try {
      output.textContent = await ctx.ask(question);
    } catch (error) {
      output.textContent = 'Could not reach the assistant: ' + error.message;
    }
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });

  return card('AI assistant', 'sparkle', ctx.element('div', {}, [input, output]), ctx);
};

window.widgetRenderers = RENDERERS;

})();
