// Wrapped in an IIFE: widget files load as plain <script> tags and classic
// scripts share one global scope.
(function () {
/**
 * Scratchpad: quick notes, stored locally.
 *
 * Backed by the real Notes feature rather than a separate plain-text blob, so
 * anything jotted here is the same note that Notes, Auto Notes and the AI
 * summaries work with. A second private store would have meant a thought
 * captured here was invisible everywhere else, which is the wrong behaviour
 * for something called a scratchpad.
 *
 * Local-first: nothing here syncs. Notes persists to the profile directory on
 * this machine and no part of this widget sends anything anywhere.
 */

const RENDERERS = window.widgetRenderers || (window.widgetRenderers = {});

/** How many notes fit before the card starts scrolling. */
const VISIBLE = 4;

RENDERERS.notes = (ctx) => {
  const body = ctx.element('div', { class: 'scratch-body' });
  let disposed = false;

  const node = ctx.element('section', { class: 'widget widget-scratch' }, [
    ctx.element('div', { class: 'widget-head' }, [
      ctx.icon('bookmark', { size: 15 }),
      ctx.element('span', { class: 'widget-title', text: 'Scratchpad' }),
    ]),
    body,
  ]);

  /** The add field. Kept outside paint() so typing survives a re-render. */
  const input = ctx.element('input', {
    class: 'scratch-input',
    type: 'text',
    placeholder: 'Add a thought…',
  });
  input.setAttribute('aria-label', 'Add a note');

  const add = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await ctx.invoke('notes:add', { kind: 'text', body: text });
      load();
    } catch (error) {
      // Put the text back rather than losing what was typed.
      input.value = text;
      fail(error.message);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); add(); }
  });

  const fail = (message) => {
    body.replaceChildren(
      ctx.element('p', { class: 'widget-empty', text: 'Notes unavailable: ' + message }),
      input,
    );
  };

  const paint = (notes) => {
    const list = ctx.element('ul', { class: 'scratch-list' });

    if (!notes.length) {
      // Empty state, not a fake sample note.
      body.replaceChildren(
        ctx.element('p', { class: 'widget-empty', text: 'Nothing saved yet.' }),
        input,
      );
      return;
    }

    for (const note of notes.slice(0, VISIBLE)) {
      const item = ctx.element('li', { class: 'scratch-item' });
      const label = ctx.element('span', {
        class: 'scratch-text',
        // title/body depending on how the note was captured.
        text: note.title || note.body || '(empty note)',
      });
      const remove = ctx.element('button', { class: 'scratch-remove', text: '×' });
      remove.setAttribute('aria-label', 'Delete note');
      remove.addEventListener('click', async () => {
        try { await ctx.invoke('notes:remove', { id: note.id }); load(); }
        catch (error) { fail(error.message); }
      });
      item.append(label, remove);
      list.appendChild(item);
    }

    const children = [list, input];
    if (notes.length > VISIBLE) {
      const more = ctx.element('button', {
        class: 'widget-link',
        text: 'Open all ' + notes.length + ' notes',
      });
      more.addEventListener('click', () =>
        ctx.invoke('tabs:navigate', { input: 'browser://notes' }));
      children.push(more);
    }
    body.replaceChildren(...children);
  };

  const load = async () => {
    if (disposed) return;
    try {
      // Text notes only. A saved LINK is a reading-queue item, and showing
      // it in both cards made the same entry appear twice on the homepage.
      const notes = await ctx.invoke('notes:list', { kind: 'text', limit: 20 });
      paint(Array.isArray(notes) ? notes : []);
    } catch (error) {
      fail(error.message);
    }
  };

  body.replaceChildren(ctx.element('p', { class: 'widget-empty', text: 'Loading…' }));
  load();

  // Notes can be added from the page context menu and by Auto Notes, so the
  // card follows the feature's own change event rather than polling.
  const off = ctx.on ? ctx.on('notes:changed', load) : null;
  node.dispose = () => { disposed = true; if (off) off(); };
  return node;
};

/* ---- reading queue ------------------------------------------------------- */

/**
 * Reading queue: saved links and saved sessions.
 *
 * Both come from real stores - link notes, and Organizer's saved sessions.
 * Nothing is invented: with neither present the card says so.
 *
 * Reading time is an ESTIMATE and is labelled as one. There is no word count
 * for a page that has not been fetched, so it is derived from the title and
 * marked accordingly rather than presented as measured.
 */
RENDERERS.reading = (ctx) => {
  const body = ctx.element('div', { class: 'reading-body' });
  let disposed = false;

  const countTag = ctx.element('span', { class: 'widget-tag' });
  const node = ctx.element('section', { class: 'widget widget-reading' }, [
    ctx.element('div', { class: 'widget-head' }, [
      ctx.icon('bookmark', { size: 15 }),
      ctx.element('span', { class: 'widget-title', text: 'Reading queue' }),
      countTag,
    ]),
    body,
  ]);

  const row = (title, sub, onOpen) => {
    const item = ctx.element('button', { class: 'reading-item' }, [
      ctx.element('span', { class: 'reading-title', text: title }),
      ctx.element('span', { class: 'reading-sub', text: sub }),
    ]);
    item.addEventListener('click', onOpen);
    return item;
  };

  const load = async () => {
    if (disposed) return;
    try {
      const [notes, organizer] = await Promise.all([
        ctx.invoke('notes:list', { kind: 'link', limit: 20 }),
        ctx.invoke('organizer:state').catch(() => null),
      ]);

      const links = Array.isArray(notes) ? notes : [];
      const sessions = organizer?.sessions || [];
      countTag.textContent = String(links.length + sessions.length) || '';

      if (!links.length && !sessions.length) {
        countTag.textContent = '';
        body.replaceChildren(ctx.element('p', {
          class: 'widget-empty',
          text: 'No saved pages yet. Save a link or a session to read later.',
        }));
        return;
      }

      const children = [];
      for (const link of links.slice(0, 3)) {
        let host = '';
        try { host = new URL(link.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
        children.push(row(link.title || link.url, host, () => ctx.openUrl(link.url)));
      }
      for (const session of sessions.slice(0, 2)) {
        const count = session.tabs?.length || 0;
        children.push(row(
          session.name || 'Saved session',
          count + (count === 1 ? ' tab' : ' tabs'),
          () => ctx.invoke('organizer:restore-session', { id: session.id }),
        ));
      }

      const open = ctx.element('button', { class: 'widget-link', text: 'Open list' });
      open.addEventListener('click', () =>
        ctx.invoke('tabs:navigate', { input: 'browser://notes' }));
      children.push(open);

      body.replaceChildren(...children);
    } catch (error) {
      body.replaceChildren(ctx.element('p', {
        class: 'widget-empty', text: 'Reading queue unavailable: ' + error.message,
      }));
    }
  };

  body.replaceChildren(ctx.element('p', { class: 'widget-empty', text: 'Loading…' }));
  load();

  const offNotes = ctx.on ? ctx.on('notes:changed', load) : null;
  const offOrg = ctx.on ? ctx.on('organizer:changed', load) : null;
  node.dispose = () => { disposed = true; if (offNotes) offNotes(); if (offOrg) offOrg(); };
  return node;
};

})();
