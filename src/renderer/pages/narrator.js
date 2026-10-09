'use strict';

/**
 * Read aloud, for mode pages: window.narrator.
 *
 * Built on the system's own voices (speechSynthesis), so nothing leaves the
 * computer and it works offline. One narrator per page, with one player docked
 * at the foot of the page while it talks.
 *
 * Text is spoken a sentence or two at a time rather than as one long
 * utterance. Chromium stops some voices dead about fifteen seconds into a long
 * utterance, and short pieces also give the player real progress, let a
 * change of voice or speed take effect straight away, and let the block being
 * read light up on the page.
 *
 * Pause is "stop, and remember where": pause() and resume() behave differently
 * on every platform's speech engine (and not at all on some), whereas starting
 * the current sentence again works everywhere and is what a listener expects.
 */
(function () {

const { element } = window.page;

const synth = window.speechSynthesis || null;
const VOICE_KEY = 'static.narrator.voice';
const RATE_KEY = 'static.narrator.rate';
const RATES = [0.8, 1, 1.2, 1.5, 1.8];
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---- remembered choices ----------------------------------------------------- */

// Per-person conveniences only. Storage can be unavailable (or throw), and the
// narrator must work the same without it.
function remembered(key) {
  try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
}
function remember(key, value) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* not kept */ }
}

/* ---- voices ----------------------------------------------------------------- */

let voices = [];

function loadVoices() {
  if (!synth) return;
  const listed = synth.getVoices() || [];
  // The person's own language first, then the rest of English, then the rest -
  // a long list of voices for languages they do not read helps nobody choose.
  const own = (navigator.language || 'en-GB').toLowerCase();
  const rank = (voice) => {
    const lang = String(voice.lang || '').toLowerCase().replace('_', '-');
    if (lang === own) return 0;
    if (lang === 'en-gb') return 1;
    if (lang.startsWith(own.slice(0, 2))) return 2;
    if (lang.startsWith('en')) return 3;
    return 4;
  };
  voices = listed.slice().sort((a, b) => rank(a) - rank(b)
    || Number(b.localService) - Number(a.localService)
    || a.name.localeCompare(b.name));
  paintVoices();
  emit();
}

function currentVoice() {
  const chosen = remembered(VOICE_KEY);
  return voices.find((voice) => voice.voiceURI === chosen) || voices[0] || null;
}

/** Strip the engine's boilerplate so the menu reads "Hazel · English (UK)". */
function voiceLabel(voice) {
  const name = voice.name.replace(/^(Microsoft|Google|Apple)\s+/i, '').replace(/\s+(Online\s*)?\(Natural\)/i, ' (natural)')
    .replace(/\s+-\s+.*$/, '');
  let language = voice.lang;
  try { language = new Intl.DisplayNames([navigator.language || 'en-GB'], { type: 'language' }).of(voice.lang) || voice.lang; }
  catch { /* the raw code will do */ }
  return name + ' · ' + language;
}

/* ---- splitting text into speakable pieces ---------------------------------- */

/** Sentences, packed into pieces of a few hundred characters at most. */
function pieces(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // A sentence ends at punctuation FOLLOWED BY A SPACE, so "4.4 out of 5",
  // "Bluetooth 5.3" and "₹7,999.00" are read as numbers, not cut in two.
  const sentences = clean.split(/(?<=[.!?;:]["')\]]*)\s+/).map((sentence) => sentence + ' ');
  const out = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current + sentence).length > 260) { out.push(current.trim()); current = ''; }
    // A single run-on "sentence" (a long list, a table row) is cut at a comma
    // or a space, never mid-word.
    let rest = sentence;
    while (rest.length > 300) {
      const cut = Math.max(rest.lastIndexOf(', ', 260), rest.lastIndexOf(' ', 260));
      out.push(rest.slice(0, cut > 80 ? cut + 1 : 260).trim());
      rest = rest.slice(cut > 80 ? cut + 1 : 260);
    }
    current += rest;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/**
 * Split a long text into paragraph-sized segments for reading a whole page:
 * blank lines are paragraph breaks, and short neighbouring lines (a list, a
 * table's cells) are gathered up so the progress counter means something.
 */
function paragraphs(text) {
  const out = [];
  let current = '';
  for (const line of String(text || '').split(/\n+/)) {
    const part = line.trim();
    if (!part) continue;
    current = current ? current + (/[.!?:;]$/.test(current) ? ' ' : '. ') + part : part;
    if (current.length > 320) { out.push(current); current = ''; }
  }
  if (current) out.push(current);
  return out.map((piece) => ({ text: piece }));
}

/* ---- playback ---------------------------------------------------------------- */

let segments = [];   // [{ text, el? }]
let queue = [];      // [{ text, segment }] - every piece, in order
let position = 0;    // index into queue of the piece being (or next to be) spoken
let title = '';
let playing = false;
let paused = false;
let generation = 0;  // bumps on every (re)start, so a cancelled piece's late "end" is ignored
let totalChars = 1;
let doneChars = 0;
let errorText = '';
let rate = Number(remembered(RATE_KEY)) || 1;
if (!RATES.includes(rate)) rate = 1;

const listeners = new Set();
function emit() {
  for (const listener of listeners) {
    try { listener(api.state()); } catch (error) { console.error('narrator listener', error); }
  }
  paintDock();
}

function motionOff() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim() === '0ms';
}

function highlight(segment) {
  for (const node of document.querySelectorAll('.is-speaking')) node.classList.remove('is-speaking');
  const el = segment?.el;
  if (!el || !el.isConnected) return;
  el.classList.add('is-speaking');
  el.scrollIntoView({ block: 'nearest', behavior: motionOff() ? 'auto' : 'smooth' });
}

function speakNext() {
  const token = generation;
  if (position >= queue.length) { finish(); return; }
  const piece = queue[position];
  highlight(piece.segment);

  const utterance = new SpeechSynthesisUtterance(piece.text);
  const voice = currentVoice();
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
  utterance.rate = rate;
  utterance.volume = api.volume;
  utterance.onend = () => {
    if (token !== generation) return;
    doneChars += piece.text.length;
    position += 1;
    emit();
    speakNext();
  };
  utterance.onerror = (event) => {
    if (token !== generation) return;
    // "interrupted"/"canceled" are our own stop and pause; anything else is
    // the engine giving up, which should not leave a player stuck on "playing".
    if (event.error === 'interrupted' || event.error === 'canceled') return;
    // Held as paused, so the player stays up saying why and play tries again.
    paused = true;
    errorText = 'The voice stopped. Press play to try again, or pick another voice.';
    emit();
  };
  synth.speak(utterance);
}

function finish() {
  generation += 1;
  playing = false;
  paused = false;
  position = 0;
  doneChars = 0;
  highlight(null);
  emit();
}

function restartPiece() {
  generation += 1;
  synth.cancel();
  if (playing && !paused) speakNext();
}

/* ---- the docked player ------------------------------------------------------- */

function glyph(kind) {
  // Play, pause and stop are not in the shared icon set; they are drawn here
  // as plain paths rather than markup, as everywhere else on these pages.
  const shapes = {
    play: 'M8 5.5v13l10.5-6.5z',
    pause: 'M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z',
    stop: 'M7 7h10v10H7z',
  };
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', shapes[kind]);
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

const dockTitle = element('div', { class: 'narrator-title' });
const dockDetail = element('div', { class: 'narrator-detail' });
const dockBar = element('div', { class: 'narrator-progress' });
const playButton = element('button', {
  class: 'narrator-button narrator-main', 'aria-label': 'Pause', title: 'Pause',
  onclick: () => api.toggle(),
});
const stopButton = element('button', {
  class: 'narrator-button', 'aria-label': 'Stop reading', title: 'Stop',
  onclick: () => api.stop(),
}, [glyph('stop')]);
const voiceSelect = element('select', { class: 'narrator-select narrator-voice', 'aria-label': 'Voice', title: 'Voice' });
voiceSelect.addEventListener('change', () => {
  remember(VOICE_KEY, voiceSelect.value);
  restartPiece();
});
const rateSelect = element('select', { class: 'narrator-select narrator-rate', 'aria-label': 'Speed', title: 'Speed' },
  RATES.map((value) => element('option', { value: String(value), text: value + '×' })));
rateSelect.value = String(rate);
rateSelect.addEventListener('change', () => {
  rate = Number(rateSelect.value) || 1;
  remember(RATE_KEY, rate);
  restartPiece();
});

const dock = element('div', { class: 'narrator-dock', role: 'region', 'aria-label': 'Read aloud' }, [
  element('div', { class: 'narrator-wave', 'aria-hidden': 'true' },
    [0, 1, 2, 3, 4].map(() => element('span'))),
  element('div', { class: 'narrator-text' }, [dockTitle, dockDetail]),
  element('div', { class: 'narrator-controls' }, [playButton, stopButton]),
  voiceSelect,
  rateSelect,
  dockBar,
]);
dock.hidden = true;

function paintVoices() {
  const chosen = currentVoice();
  voiceSelect.replaceChildren(...voices.map((voice) => element('option', {
    value: voice.voiceURI, text: voiceLabel(voice),
  })));
  if (chosen) voiceSelect.value = chosen.voiceURI;
  voiceSelect.disabled = !voices.length;
}

function paintDock() {
  const active = playing || paused;
  if (active && dock.hidden) {
    // Unhide first and open a frame later, so it slides in rather than appears.
    dock.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (playing || paused) dock.classList.add('is-open');
    }));
  } else {
    dock.classList.toggle('is-open', active);
  }
  dock.classList.toggle('is-paused', paused);
  dockTitle.textContent = title || 'Reading aloud';
  const total = queue.length;
  const segmentAt = queue[position]?.segment;
  const segmentIndex = segmentAt ? segments.indexOf(segmentAt) : -1;
  dockDetail.textContent = errorText
    || (paused ? 'Paused' : 'Reading aloud')
      + (segments.length > 1 && segmentIndex >= 0 ? ' · part ' + (segmentIndex + 1) + ' of ' + segments.length : '')
      + (total && rate !== 1 ? ' · ' + rate + '×' : '');
  dockBar.style.setProperty('--done', Math.min(100, Math.round((doneChars / totalChars) * 100)) + '%');
  playButton.replaceChildren(glyph(paused ? 'play' : 'pause'));
  playButton.title = paused ? 'Carry on reading' : 'Pause';
  playButton.setAttribute('aria-label', playButton.title);
  // Slide away once stopped, then leave the layout entirely.
  if (!active && !dock.hidden) {
    setTimeout(() => { if (!playing && !paused) dock.hidden = true; }, motionOff() ? 0 : 260);
  }
}

/* ---- public api -------------------------------------------------------------- */

const api = {
  dock,
  /** Speech volume. Probes turn it to 0 so a test run never talks to the room. */
  volume: 1,

  available: () => !!synth && typeof window.SpeechSynthesisUtterance === 'function',
  hasVoices: () => voices.length > 0,

  /**
   * Start reading. `items` are { text, el? }: el, when given, is lit up and
   * scrolled into view while its text is read. `key` names what is being read,
   * so a button can tell whether the narrator is reading ITS text.
   */
  play({ title: heading = '', items = [], key = '' } = {}) {
    if (!api.available()) return false;
    const list = items.filter((item) => item && String(item.text || '').trim());
    if (!list.length) return false;
    generation += 1;
    synth.cancel();
    segments = list;
    queue = list.flatMap((segment) => pieces(segment.text).map((text) => ({ text, segment })));
    totalChars = Math.max(1, queue.reduce((sum, piece) => sum + piece.text.length, 0));
    doneChars = 0;
    position = 0;
    title = heading;
    api.key = key;
    errorText = '';
    playing = true;
    paused = false;
    emit();
    speakNext();
    return true;
  },

  pause() {
    if (!playing || paused) return;
    paused = true;
    generation += 1;
    synth.cancel();
    emit();
  },

  resume() {
    if (!paused) return;
    paused = false;
    errorText = '';
    emit();
    speakNext();
  },

  toggle() { if (paused) api.resume(); else api.pause(); },

  stop() {
    if (!playing && !paused) return;
    synth.cancel();
    finish();
  },

  key: '',

  /** { playing, paused, key, position, total } */
  state: () => ({ playing: playing && !paused, paused, key: api.key, position, total: queue.length }),

  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

  paragraphs,
  pieces,
};

if (synth) {
  loadVoices();
  // Voices arrive asynchronously in Chromium: the first getVoices() is often
  // empty, and the list fills in a moment later.
  synth.addEventListener?.('voiceschanged', loadVoices);
  // Leaving the page must not leave its voice talking over the next one.
  window.addEventListener('pagehide', () => synth.cancel());
}

window.narrator = api;

})();
