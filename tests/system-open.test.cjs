const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { target, targets } = require('../src/main/system-open');

test('web links from another app open as they are', () => {
  assert.deepEqual(target('https://example.com/a?b=1#c'), { kind: 'web', url: 'https://example.com/a?b=1#c' });
  assert.deepEqual(target('http://localhost:3000/'), { kind: 'web', url: 'http://localhost:3000/' });
  assert.deepEqual(target('  HTTPS://Example.COM  '), { kind: 'web', url: 'https://example.com/' });
});

test('nothing but http(s) and real files is ever opened', () => {
  for (const bad of [
    'javascript:alert(1)', 'data:text/html,<script>x</script>', 'browser://settings', 'chrome://settings',
    'file:///', 'mailto:a@b.c', 'vbscript:x', 'ms-settings:defaultapps', 'about:blank', 'static-file://x/y',
    '', '   ', null, undefined, 42, 'x'.repeat(40000),
  ]) assert.equal(target(bad), null, String(bad).slice(0, 40));
});

test('Chromium switches and the program\'s own path are not targets', () => {
  const exe = process.execPath; // a file that exists, but not a page
  assert.equal(target('--allow-file-access-from-files'), null);
  assert.equal(target('--original-process-start-time=1'), null);
  assert.equal(target('-psn_0_12345'), null);
  assert.equal(target(exe), null);
  assert.equal(target('.'), null);
});

test('local pages open, by path, by file:// address, or relative to where static was started', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-open-'));
  try {
    const page = path.join(dir, 'Page One.html');
    fs.writeFileSync(page, '<p>hi</p>');
    assert.deepEqual(target(page), { kind: 'file', path: page });
    assert.deepEqual(target(pathToFileURL(page).href), { kind: 'file', path: page });
    assert.deepEqual(target('Page One.html', dir), { kind: 'file', path: page });
    // Only kinds a browser shows.
    const script = path.join(dir, 'run.bat');
    fs.writeFileSync(script, 'echo');
    assert.equal(target(script), null);
    // Missing files and folders are not opened.
    assert.equal(target(path.join(dir, 'missing.html')), null);
    fs.mkdirSync(path.join(dir, 'folder.html'));
    assert.equal(target(path.join(dir, 'folder.html')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Drive paths only exist on Windows; elsewhere "C:\x" is just a file name.
test('a Windows drive path is a path, not a scheme', { skip: process.platform !== 'win32' }, () => {
  const yes = () => true;
  assert.deepEqual(target('C:\\Users\\me\\page.html', 'C:\\', yes), { kind: 'file', path: path.normalize('C:\\Users\\me\\page.html') });
  assert.deepEqual(target('d:/docs/report.pdf', 'C:\\', yes), { kind: 'file', path: path.normalize('d:/docs/report.pdf') });
});

test('every kind of file static accepts from the system is one a tab can show', () => {
  // Otherwise "Open with static" downloads the file instead of showing it,
  // which is what .xhtml and .shtml did.
  const { FILE_TYPES } = require('../src/main/system-open');
  const { mimeOf } = require('../src/features/tabs/local-files');
  const unshowable = [...FILE_TYPES].filter((ext) => mimeOf('file' + ext) === 'application/octet-stream');
  assert.deepEqual(unshowable, []);
});

test('an argument list yields each target once, in order, at most twenty', () => {
  const argv = ['static.exe', '--flag', 'https://a.example/', 'javascript:x', 'https://b.example/', 'https://a.example/'];
  assert.deepEqual(targets(argv).map((t) => t.url), ['https://a.example/', 'https://b.example/']);
  const many = Array.from({ length: 50 }, (_, i) => 'https://e.example/' + i);
  assert.equal(targets(many).length, 20);
  assert.deepEqual(targets(null), []);
});
