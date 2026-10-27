const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browserGuide, isAboutStatic, withGuide, TOPICS } = require('../src/features/ai/knowledge');
const { ACCEL } = require('../src/main/shortcuts');

const root = path.join(__dirname, '..');

/** Every .js and .html file the app ships, except the guide itself. */
function sources(dir = path.join(root, 'src'), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(js|html)$/.test(entry.name) && !full.endsWith(path.join('ai', 'knowledge.js'))) out.push(fs.readFileSync(full, 'utf8'));
  }
  return out;
}

test('questions about the browser get the guide; questions about the world do not', () => {
  for (const q of [
    'from where do i import all the stuff in static from brave',
    'how do I turn off shields for a site',
    'where are my downloads',
    'how do i add an extension',
    'how do I get my passwords from chrome',
    'how do i clear my history',
    'can i use vertical tabs',
    'what can this browser do?',
  ]) assert.equal(isAboutStatic(q), true, q);
  for (const q of [
    'what is the history of Rome?',
    'summarise this page',
    'write me a poem about the sea',
    'explain photosynthesis',
    'how do I make a pizza',
    '',
  ]) assert.equal(isAboutStatic(q), false, q);
});

test('a follow-up to a question about static keeps the guide', () => {
  const history = [{ role: 'user', text: 'how do i import from brave' }, { role: 'model', text: 'Open Settings...' }];
  assert.notEqual(withGuide('S', 'and passwords?', history), 'S');
  assert.equal(withGuide('S', 'and passwords?', []), 'S');
  assert.equal(withGuide(undefined, 'explain photosynthesis'), undefined);
  // The caller's own instruction is kept, and comes first so that the cap in
  // gemini.js (which trims the end) can never drop it.
  assert.match(withGuide('Be brief.', 'how do I import bookmarks?'), /^Be brief\.[\s\S]*STATIC GUIDE/);
});

test('the guide gives the exact Brave import steps, passwords included', () => {
  const guide = browserGuide('9.9.9');
  assert.match(guide, /version 9\.9\.9/);
  assert.match(guide, /main menu > Settings/);
  assert.match(guide, /Get started, under "Import from another browser"/);
  assert.match(guide, /brave:\/\/password-manager\/settings/);
  assert.match(guide, /browser:\/\/passwords/);
});

test('every label the guide quotes is one the app shows', () => {
  const all = sources().join('\n').replace(/…/g, '...');
  // Text other programs show, or that the app builds at run time.
  const elsewhere = new Set(['import', 'Import from Brave', 'Add to Chrome']);
  const quoted = TOPICS.flatMap(([, lines]) => lines)
    .flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
    .filter((label) => !elsewhere.has(label));
  assert.ok(quoted.length > 8);
  for (const label of quoted) assert.ok(all.includes(label), 'not in the app: ' + label);
});

test('the guide and the caller\'s rules both survive the system-instruction cap', () => {
  // gemini.js trims the system instruction from the end. The caller's own
  // rules therefore have to come first, and the whole thing has to fit, or
  // "write plain text" is silently dropped on every browser question.
  const source = fs.readFileSync(path.join(root, 'src', 'features', 'ai', 'gemini.js'), 'utf8');
  const cap = Number(/clean\(system,\s*(\d+)\)/.exec(source)?.[1]);
  assert.ok(Number.isFinite(cap), 'found the system-instruction cap in gemini.js');

  const callerRules = 'You are a browser sidebar assistant. Answer briefly and concretely. Write plain text: no markdown, no asterisks, no headings.';
  const combined = withGuide(callerRules, 'how do i import everything from brave');
  assert.ok(combined.startsWith(callerRules), 'the caller\'s rules come first');
  assert.ok(combined.length <= cap, `guide + rules is ${combined.length}, over the ${cap} cap`);
  // The parts an answer actually needs must be inside the cap.
  const kept = combined.slice(0, cap);
  assert.match(kept, /Import from another browser/);
  assert.match(kept, /browser:\/\/passwords/);
});

test('keyboard shortcuts in the guide are the ones the menus show', () => {
  const guide = browserGuide();
  for (const id of ['tab:new', 'open:settings', 'open:history', 'open:downloads', 'window:incognito', 'page:reader']) {
    const a = ACCEL.get(id);
    assert.ok(a, id);
    assert.ok(guide.includes(`${a.label}: ${a.display}`), id);
  }
  assert.doesNotMatch(guide, /undefined|\(\)|press \./);
});
