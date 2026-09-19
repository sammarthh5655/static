const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { JsonStore } = require('../../main/storage');

/**
 * Auto Notes.
 *
 * Captures selected text, links, screenshots and AI summaries from any page
 * into a searchable store organised by workspace.
 *
 * Screenshots are written as files under `userData/note-images/` rather than
 * base64 inside the JSON: a handful of PNGs inlined would bloat the store to
 * megabytes and make every read and write slow.
 */

const MAX_NOTES = 5000;
const IMAGE_DIR = 'note-images';

class Notes {
  constructor(dir, { onChange } = {}) {
    this.dir = dir;
    this.store = new JsonStore(dir, 'notes-store', {
      notes: [],
      workspaces: [{ id: 'default', name: 'General', createdAt: 0 }],
      activeWorkspace: 'default',
    });
    this.imageDir = path.join(dir, IMAGE_DIR);
    this.onChange = onChange || (() => {});
    this.#repair();
  }

  #repair() {
    const data = this.store.data;
    if (!Array.isArray(data.notes)) data.notes = [];
    if (!Array.isArray(data.workspaces) || !data.workspaces.length) {
      data.workspaces = [{ id: 'default', name: 'General', createdAt: Date.now() }];
    }
    if (!data.workspaces.some((w) => w.id === data.activeWorkspace)) {
      data.activeWorkspace = data.workspaces[0].id;
    }
  }

  /**
   * Add a note.
   *
   * @param {object} input
   * @param {string} input.kind  'text' | 'link' | 'screenshot' | 'summary'
   */
  add(input = {}) {
    const now = Date.now();
    const note = {
      id: randomUUID(),
      kind: ['text', 'link', 'screenshot', 'summary'].includes(input.kind) ? input.kind : 'text',
      title: String(input.title || '').slice(0, 300),
      body: String(input.body || '').slice(0, 100000),
      url: String(input.url || '').slice(0, 2048),
      favicon: String(input.favicon || '').slice(0, 2048),
      image: input.image || null,
      tags: normaliseTags(input.tags),
      comment: String(input.comment || '').slice(0, 5000),
      workspace: this.#workspaceId(input.workspace),
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    if (!note.title) note.title = deriveTitle(note);

    this.store.data.notes.unshift(note);
    if (this.store.data.notes.length > MAX_NOTES) {
      // Never drop a pinned note when trimming.
      const pinned = this.store.data.notes.filter((n) => n.pinned);
      const rest = this.store.data.notes.filter((n) => !n.pinned);
      this.store.data.notes = [...pinned, ...rest].slice(0, MAX_NOTES);
    }
    this.store.save();
    this.onChange();
    return note;
  }

  /** Save a PNG buffer (from capturePage) and return its stored filename. */
  saveImage(buffer) {
    try {
      fs.mkdirSync(this.imageDir, { recursive: true });
      const name = randomUUID() + '.png';
      fs.writeFileSync(path.join(this.imageDir, name), buffer);
      return name;
    } catch (error) {
      console.error('notes: could not save screenshot', error.message);
      return null;
    }
  }

  /** Absolute path for a stored image, or null if it is missing. */
  imagePath(name) {
    if (!name || !/^[0-9a-f-]+\.png$/i.test(name)) return null;
    const full = path.join(this.imageDir, name);
    return fs.existsSync(full) ? full : null;
  }

  update(id, patch = {}) {
    const note = this.store.data.notes.find((n) => n.id === id);
    if (!note) return null;
    if (typeof patch.title === 'string') note.title = patch.title.slice(0, 300);
    if (typeof patch.body === 'string') note.body = patch.body.slice(0, 100000);
    if (typeof patch.comment === 'string') note.comment = patch.comment.slice(0, 5000);
    if (patch.tags !== undefined) note.tags = normaliseTags(patch.tags);
    if (typeof patch.pinned === 'boolean') note.pinned = patch.pinned;
    if (patch.workspace) note.workspace = this.#workspaceId(patch.workspace);
    note.updatedAt = Date.now();
    this.store.save();
    this.onChange();
    return note;
  }

  remove(id) {
    const note = this.store.data.notes.find((n) => n.id === id);
    // Delete the screenshot too, or the images directory grows forever.
    if (note?.image) {
      const full = this.imagePath(note.image);
      if (full) { try { fs.unlinkSync(full); } catch { /* already gone */ } }
    }
    const before = this.store.data.notes.length;
    this.store.data.notes = this.store.data.notes.filter((n) => n.id !== id);
    if (this.store.data.notes.length !== before) {
      this.store.save();
      this.onChange();
    }
    return { ok: true };
  }

  /**
   * Search across title, body, url, tags and comment.
   * Pinned notes always sort first.
   */
  list({ query = '', workspace = null, tag = null, kind = null, limit = 500 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    let notes = this.store.data.notes;
    if (workspace) notes = notes.filter((n) => n.workspace === workspace);
    if (tag) notes = notes.filter((n) => n.tags.includes(tag));
    if (kind) notes = notes.filter((n) => n.kind === kind);
    if (q) {
      notes = notes.filter((n) =>
        (n.title + ' ' + n.body + ' ' + n.url + ' ' + n.comment + ' ' + n.tags.join(' '))
          .toLowerCase().includes(q));
    }
    return [...notes]
      .sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, limit);
  }

  get(id) { return this.store.data.notes.find((n) => n.id === id) || null; }

  /** Every tag in use, with counts, for the filter row. */
  tags() {
    const counts = new Map();
    for (const note of this.store.data.notes) {
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  addWorkspace(name) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) return null;
    const workspace = { id: randomUUID(), name: clean, createdAt: Date.now() };
    this.store.data.workspaces.push(workspace);
    this.store.save();
    this.onChange();
    return workspace;
  }

  removeWorkspace(id) {
    if (id === 'default') return { ok: false, error: 'The default workspace cannot be removed.' };
    this.store.data.workspaces = this.store.data.workspaces.filter((w) => w.id !== id);
    // Move its notes rather than deleting them - silently losing notes would
    // be far worse than leaving them somewhere findable.
    for (const note of this.store.data.notes) {
      if (note.workspace === id) note.workspace = 'default';
    }
    this.#repair();
    this.store.save();
    this.onChange();
    return { ok: true };
  }

  setActiveWorkspace(id) {
    if (this.store.data.workspaces.some((w) => w.id === id)) {
      this.store.data.activeWorkspace = id;
      this.store.save();
      this.onChange();
    }
    return this.store.data.activeWorkspace;
  }

  /** Export as markdown or JSON. */
  export(format = 'markdown', workspace = null) {
    const notes = this.list({ workspace, limit: MAX_NOTES });
    if (format === 'json') return JSON.stringify(notes, null, 2);

    const lines = ['# Notes', ''];
    for (const note of notes) {
      lines.push(`## ${note.title}`);
      lines.push('');
      if (note.url) lines.push(`Source: ${note.url}`);
      if (note.tags.length) lines.push(`Tags: ${note.tags.join(', ')}`);
      lines.push(`Saved: ${new Date(note.createdAt).toLocaleString()}`);
      lines.push('');
      if (note.body) { lines.push(note.body); lines.push(''); }
      if (note.comment) { lines.push(`> ${note.comment}`); lines.push(''); }
      if (note.image) { lines.push(`(screenshot: ${note.image})`); lines.push(''); }
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  }

  #workspaceId(id) {
    if (id && this.store.data.workspaces.some((w) => w.id === id)) return id;
    return this.store.data.activeWorkspace || 'default';
  }

  state() {
    return {
      workspaces: this.store.data.workspaces,
      activeWorkspace: this.store.data.activeWorkspace,
      tags: this.tags(),
      count: this.store.data.notes.length,
    };
  }

  flush() { this.store.save(); }
}

function normaliseTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const seen = new Set();
  for (const raw of list) {
    const tag = String(raw || '').trim().toLowerCase().replace(/^#/, '').slice(0, 40);
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, 20);
}

/** A note with no title gets one from its content, so lists stay readable. */
function deriveTitle(note) {
  if (note.kind === 'screenshot') {
    try { return 'Screenshot of ' + new URL(note.url).hostname; } catch { return 'Screenshot'; }
  }
  if (note.kind === 'link') {
    try { return new URL(note.url).hostname.replace(/^www\./, ''); } catch { return note.url || 'Link'; }
  }
  const text = note.body.replace(/\s+/g, ' ').trim();
  if (!text) return 'Note';
  return text.length > 70 ? text.slice(0, 67).trimEnd() + '…' : text;
}

module.exports = { Notes };
