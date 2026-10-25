'use strict';

/**
 * The downloads bubble, drawn inside a menu in the overlay (see ui.js#menu)
 * under the toolbar's downloads button, as in Chrome: the last few
 * downloads, each with its progress, speed and time left while it runs, and
 * Open, Show in folder or Cancel.
 *
 * The list is the browser state's `downloads` (features/downloads), redrawn
 * whenever that state changes (overlay.js calls downloadsPanel.refresh).
 * Opened by a download starting (`auto`), it closes itself after a few
 * seconds unless the pointer is on it.
 *
 * File names come from web pages, so they are set as text, never markup.
 */
(function () {

const RECENT_MS = 24 * 60 * 60 * 1000;
const SHOWN = 6;
const AUTO_CLOSE_MS = 5000;

/** The panel on show: { list, item, close } or null. */
let open = null;
/** id -> { received, at, speed } for working out speed between updates. */
const rates = new Map();

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function bytes(n) {
  if (!(n > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return (value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i];
}

function timeLeft(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return Math.ceil(seconds) + ' s left';
  if (seconds < 3600) return Math.ceil(seconds / 60) + ' min left';
  return Math.floor(seconds / 3600) + ' h ' + Math.ceil((seconds % 3600) / 60) + ' min left';
}

/** Bytes a second, smoothed so the figure does not jump with every update. */
function speedOf(d) {
  const now = Date.now();
  const last = rates.get(d.id);
  if (!last) { rates.set(d.id, { received: d.received, at: now, speed: 0 }); return 0; }
  const dt = (now - last.at) / 1000;
  if (dt >= 0.4) {
    const instant = Math.max(0, d.received - last.received) / dt;
    last.speed = last.speed ? last.speed * 0.6 + instant * 0.4 : instant;
    last.received = d.received;
    last.at = now;
  }
  return last.speed;
}

function status(d) {
  if (d.state === 'progressing') {
    const speed = speedOf(d);
    const parts = [d.total > 0 ? bytes(d.received) + ' of ' + bytes(d.total) : bytes(d.received)];
    if (speed > 0) parts.push(bytes(speed) + '/s');
    if (speed > 0 && d.total > 0) parts.push(timeLeft((d.total - d.received) / speed));
    return parts.filter(Boolean).join(' · ');
  }
  rates.delete(d.id);
  if (d.state === 'completed') return 'Done · ' + bytes(d.total || d.received);
  if (d.state === 'cancelled') return 'Cancelled';
  return 'Failed · try downloading it again';
}

/** A tile with the file's type, like "PDF", where Chrome shows the file's icon. */
function fileTile(d) {
  const ext = (String(d.name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toUpperCase();
  const tile = node('span', 'dl-file' + (d.state === 'completed' ? ' is-done' : ''));
  if (ext) tile.append(node('span', 'dl-ext', ext));
  else tile.append(window.ui.icon('download', { size: 16 }));
  return tile;
}

function iconButton(name, title, onClick) {
  const b = node('button', 'dl-act');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(window.ui.icon(name, { size: 15 }));
  b.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
  return b;
}

function row(d) {
  const { item } = open;
  const done = d.state === 'completed';
  const going = d.state === 'progressing';
  const r = node(done ? 'button' : 'div', 'dl-row is-' + d.state);
  if (done) {
    r.type = 'button';
    r.title = 'Open ' + d.name;
    r.addEventListener('click', async () => {
      const result = await item.run('downloads:open', { id: d.id });
      if (result?.ok) open?.close();
      else if (result?.error) words.lastChild.textContent = result.error;
    });
  }
  const words = node('span', 'dl-words');
  words.append(node('span', 'dl-name', d.name || 'Download'), node('span', 'dl-status', status(d)));
  if (going) {
    const bar = node('span', 'dl-bar' + (d.total > 0 ? '' : ' is-unknown'));
    const fill = node('span', 'dl-fill');
    if (d.total > 0) fill.style.width = Math.min(100, (d.received / d.total) * 100).toFixed(1) + '%';
    bar.append(fill);
    words.append(bar);
  }
  const actions = node('span', 'dl-actions');
  if (going) actions.append(iconButton('close', 'Cancel', () => item.run('downloads:cancel', { id: d.id })));
  else if (d.path && d.state !== 'cancelled') actions.append(iconButton('folder', 'Show in folder', () => item.run('downloads:reveal', { id: d.id })));
  r.append(fileTile(d), words, actions);
  return r;
}

function draw() {
  if (!open) return;
  if (!open.list.isConnected) { open = null; return; }
  const all = Array.isArray(open.item.state?.()?.downloads) ? open.item.state().downloads : [];
  const now = Date.now();
  const recent = all.filter((d) => d.state === 'progressing' || now - (d.startedAt || 0) < RECENT_MS).slice(0, SHOWN);
  if (!recent.length) {
    open.list.replaceChildren(node('p', 'dl-empty', 'Nothing downloaded in the last day.'));
    return;
  }
  open.list.replaceChildren(...recent.map(row));
}

function downloadsPanel(item, { close }) {
  const spec = item.downloads || {};
  const card = node('div', 'dl-card');
  const head = node('div', 'dl-head');
  head.append(node('span', 'dl-title', 'Downloads'));
  const all = node('button', 'dl-all', 'Show all');
  all.type = 'button';
  all.addEventListener('click', () => { close(); item.run('ui:action', { action: 'open:downloads' }); });
  head.append(all);
  const list = node('div', 'dl-list');
  card.append(head, list);
  open = { list, item, close };
  draw();

  // Opened by a download starting: it steps aside after a moment, unless
  // someone is reading it.
  if (spec.auto) {
    let timer = setTimeout(close, AUTO_CLOSE_MS);
    card.addEventListener('pointerenter', () => clearTimeout(timer));
    card.addEventListener('pointerleave', () => { clearTimeout(timer); timer = setTimeout(close, 2000); });
  }
  return card;
}

downloadsPanel.refresh = draw;
window.downloadsPanel = downloadsPanel;

})();
