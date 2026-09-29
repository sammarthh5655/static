/**
 * Build the redirect resources and Brave's extra scriptlets.
 *
 *   node scripts/make-redirects.cjs "<brave research and repos folder>"
 *
 * - src/features/shields/brave/redirects.json: uBlock Origin's redirect
 *   resources (noop.js, 1x1.gif, googletagmanager_gtm.js ...), with their
 *   aliases, as data. A `$redirect=` rule answers a matching request with one
 *   of these instead of blocking it, which keeps pages that expect the
 *   script to exist from breaking. Taken from adblock-rust's copy of them
 *   (data/test/fake-uBO-files). GPL-3.0, like uBlock's lists; credited on the
 *   licences page.
 * - src/features/shields/brave/brave-extra.json: the 17 resources Brave adds
 *   in adblock-resources (brave-fix.js, brave-yt-sabr-fix.js ...), which
 *   Brave's own list rules inject by name. MPL-2.0.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root || !fs.existsSync(root)) { console.error('usage: node scripts/make-redirects.cjs <brave research folder>'); process.exit(1); }
const find = (...parts) => {
  for (const top of fs.readdirSync(root)) {
    const candidate = path.join(root, top, top, ...parts);
    if (fs.existsSync(candidate)) return candidate;
    const flat = path.join(root, top, ...parts);
    if (fs.existsSync(flat)) return flat;
  }
  return null;
};

const MIME = { js: 'application/javascript', gif: 'image/gif', png: 'image/png', css: 'text/css', html: 'text/html',
  txt: 'text/plain', mp3: 'audio/mpeg', mp4: 'video/mp4', xml: 'text/xml' };

const map = find('data', 'test', 'fake-uBO-files', 'redirect-resources.js');
const dir = find('data', 'test', 'fake-uBO-files', 'web_accessible_resources');
if (!map || !dir) { console.error('adblock-rust test resources not found'); process.exit(1); }
const source = fs.readFileSync(map, 'utf8');
const out = {};
for (const match of source.matchAll(/\[\s*'([^']+)',\s*\{([^}]*)\}\s*\]/g)) {
  const [, name, body] = match;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) continue;
  const aliases = [];
  const alias = body.match(/alias:\s*(\[[^\]]*\]|'[^']*')/);
  if (alias) for (const a of alias[1].matchAll(/'([^']+)'/g)) aliases.push(a[1]);
  const ext = path.extname(name).slice(1);
  out[name] = { mime: MIME[ext] || 'text/plain', data: fs.readFileSync(file).toString('base64'), aliases };
}
// 'empty' has no extension and no entry of its own in some versions.
if (!out.empty && fs.existsSync(path.join(dir, 'empty'))) out.empty = { mime: 'text/plain', data: '', aliases: [] };
const target = path.join(__dirname, '..', 'src', 'features', 'shields', 'brave');
fs.writeFileSync(path.join(target, 'redirects.json'), JSON.stringify(out) + '\n');

const brave = find('dist', 'resources.json');
let extra = [];
if (brave) {
  extra = JSON.parse(fs.readFileSync(brave, 'utf8'))
    .filter((r) => r.kind && r.kind.mime === 'application/javascript')
    .map((r) => ({ name: r.name, aliases: r.aliases || [], body: r.content }));
  fs.writeFileSync(path.join(target, 'brave-extra.json'), JSON.stringify(extra) + '\n');
}
console.log(Object.keys(out).length + ' redirect resources, ' + extra.length + ' Brave extras');
