'use strict';

/**
 * A tab's hover card, drawn in the overlay: the title, the site, and a
 * picture of the page (main/application.js#tabPreview decides when, where
 * and what; this only draws it).
 *
 * While a card is up the overlay is sized to a "lane" beside the tab list,
 * not the whole window, so the pointer stays on the tab underneath. The card
 * is placed inside that lane at (x, y). Moving from tab to tab slides the
 * same card along rather than drawing a new one, so nothing flickers.
 *
 * Every word on the card comes from a web page, so it is set as text, never
 * parsed as markup; the picture is one main took itself.
 */
(function () {

const invoke = (channel, payload) => window.browser.invoke(channel, payload).catch(() => null);

/** The card on show: { id, side, lane, outer, card, ... } or null. */
let current = null;

function hide() {
  if (!current) return;
  current.outer.remove();
  current = null;
}

/**
 * The site's icon: the favicon, or the site's first letter - also when the
 * favicon turns out not to be a picture at all. Small on the site line,
 * `big` on the placeholder.
 */
function siteIcon(data, { big = false } = {}) {
  const letter = () => {
    const mark = document.createElement('span');
    mark.className = 'tc-letter' + (big ? ' is-big' : '');
    mark.textContent = (data.site || data.title || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '·';
    return mark;
  };
  if (!data.favicon) return letter();
  const img = document.createElement('img');
  img.className = 'tc-favicon' + (big ? ' is-big' : '');
  img.alt = '';
  img.width = 14; img.height = 14;
  img.src = data.favicon;
  img.onerror = () => img.replaceWith(letter());
  return img;
}

/** Sound: one short word with its own little picture. (Asleep says so in the picture's place.) */
function stateTag(data) {
  const tag = document.createElement('span');
  tag.className = 'tc-tag';
  if (data.muted) {
    tag.classList.add('is-muted');
    tag.append(window.ui.icon('muted', { size: 12 }), document.createTextNode('Muted'));
  } else if (data.audible) {
    tag.classList.add('is-playing');
    const bars = document.createElement('span');
    bars.className = 'tc-bars';
    bars.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    tag.append(bars, document.createTextNode('Playing'));
  } else return null;
  return tag;
}

/**
 * The picture, or what stands in for it: a shimmer while it is being taken,
 * and for a tab with no picture (asleep, never opened) the site's icon on a
 * soft field in the planet's colours.
 */
function fillShot(shot, data) {
  shot.classList.toggle('is-pending', !!data.pending && !data.thumb);
  shot.classList.toggle('is-empty', !data.thumb && !data.pending);
  const had = shot.querySelector('.tc-img:last-of-type');
  if (data.thumb) {
    if (had && had.dataset.src === data.thumb.slice(-64)) return;
    // The new picture fades in over whatever was there - the last tab's
    // picture, sliding along with the card - which goes once it is covered.
    const img = document.createElement('img');
    img.className = 'tc-img';
    img.alt = '';
    img.dataset.src = data.thumb.slice(-64);
    img.onload = () => {
      // Overtaken by a newer picture while it was still decoding: leave it be.
      if (shot.querySelector('.tc-img:last-of-type') !== img) return;
      img.classList.add('is-in');
      setTimeout(() => {
        for (const node of shot.querySelectorAll('.tc-img, .tc-rest')) if (node !== img && img.isConnected) node.remove();
      }, 260);
    };
    img.src = data.thumb;
    shot.append(img);
    return;
  }
  // No picture for this tab: nothing of the last one may stay behind.
  shot.querySelectorAll('.tc-img, .tc-rest').forEach((n) => n.remove());
  if (data.pending) return;
  const rest = document.createElement('div');
  rest.className = 'tc-rest';
  const plate = document.createElement('span');
  plate.className = 'tc-plate';
  plate.append(siteIcon(data, { big: true }));
  const words = document.createElement('span');
  words.className = 'tc-rest-words';
  if (data.sleeping) words.append(window.ui.icon('moon', { size: 12 }), document.createTextNode('Asleep · wakes when you open it'));
  else if (data.loading) words.textContent = 'Loading…';
  else words.textContent = 'No picture yet';
  rest.append(plate, words);
  shot.append(rest);
}

/** Write a tab's details into the card, new or already on show. */
function fill(data) {
  const { card } = current;
  card.classList.toggle('is-grouped', !!data.group);
  if (data.group?.color) card.style.setProperty('--swatch', data.group.color);
  card.querySelector('.tc-title').textContent = data.title || 'New tab';
  const site = card.querySelector('.tc-site');
  const name = document.createElement('span');
  name.className = 'tc-site-name';
  name.textContent = data.site || '';
  site.replaceChildren(siteIcon(data), name);
  if (data.group) {
    const chip = document.createElement('span');
    chip.className = 'tc-group';
    chip.textContent = data.group.name;
    site.append(chip);
  }
  const tag = stateTag(data);
  if (tag) site.append(tag);
  fillShot(card.querySelector('.tc-shot'), data);
  fillMemory(card.querySelector('.tc-foot'), data);
}

/** "Memory usage: 184 MB", or what a sleeping tab uses: nothing. */
function fillMemory(foot, data) {
  const parts = [];
  if (data.sleeping) parts.push(document.createTextNode('Memory usage: freed while asleep'));
  else if (data.memory?.mb) {
    const amount = document.createElement('b');
    amount.textContent = data.memory.mb >= 1024 ? (data.memory.mb / 1024).toFixed(1) + ' GB' : data.memory.mb + ' MB';
    parts.push(document.createTextNode('Memory usage: '), amount);
    if (data.memory.shared) {
      // Same-site tabs share one process; the figure is all of theirs.
      const shared = document.createElement('span');
      shared.className = 'tc-shared';
      shared.textContent = 'shared with ' + data.memory.shared + (data.memory.shared === 1 ? ' tab' : ' tabs');
      parts.push(shared);
    }
  } else parts.push(document.createTextNode('Memory usage: not known yet'));
  foot.replaceChildren(...parts);
}

function show(data) {
  if (!data) { hide(); return; }
  // A late picture for a card that is no longer up, or a different one.
  if (data.update) {
    if (!current || current.id !== data.id) return;
    current.thumb = data.thumb || current.thumb;
    fillShot(current.card.querySelector('.tc-shot'), { ...current, ...data, thumb: data.thumb || current.thumb, pending: false });
    return;
  }
  if (window.ui.menuIsOpen()) return;

  // A card already up on the same side slides to the new tab; otherwise a
  // new one comes in.
  if (!current || current.side !== data.side) {
    hide();
    const outer = document.createElement('div');
    outer.className = 'tab-card-pos side-' + (data.side === 'right' ? 'right' : 'below');
    const card = document.createElement('div');
    card.className = 'tab-card';
    card.setAttribute('role', 'tooltip');
    const text = document.createElement('div');
    text.className = 'tc-text';
    const title = document.createElement('div');
    title.className = 'tc-title';
    const site = document.createElement('div');
    site.className = 'tc-site';
    text.append(title, site);
    const shot = document.createElement('div');
    shot.className = 'tc-shot';
    const foot = document.createElement('div');
    foot.className = 'tc-foot';
    card.append(text, shot, foot);
    outer.append(card);
    document.body.append(outer);
    current = { outer, card };
  } else if (current.id !== data.id) {
    // A different tab: its words slip in, and its picture fades in over the
    // last one (see fillShot) rather than the card blinking empty between.
    current.card.classList.remove('is-switch');
    void current.card.offsetWidth;
    current.card.classList.add('is-switch');
  }
  Object.assign(current, data);
  current.outer.style.transform = `translate(${Math.round(Number(data.x) || 0)}px, ${Math.round(Number(data.y) || 0)}px)`;
  fill(data);
}

window.browser.on('ui:tab-preview', show);

/**
 * The pointer in the lane has left the tabs: the card goes, at once. A
 * press there was meant for the toolbar or page under the lane, so it is
 * passed on to them, the way a passive menu passes a click on.
 */
for (const type of ['pointermove', 'pointerdown', 'wheel']) {
  document.addEventListener(type, (event) => {
    if (!current || window.ui.menuIsOpen()) return;
    const lane = current.lane || { x: 0, y: 0 };
    hide();
    invoke('tabs:preview', { id: null });
    if (type === 'pointerdown') {
      invoke('menu:passthrough', { x: event.clientX + lane.x, y: event.clientY + lane.y, button: event.button === 2 ? 'right' : 'left' });
    }
  }, { capture: true, passive: true });
}

window.tabPreview = { hide };

})();
