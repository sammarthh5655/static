/**
 * Run the off-screen probes (tests/<name>.cjs), a few at a time, and report.
 *
 *   node scripts/probes.cjs                 every probe
 *   node scripts/probes.cjs smoke menu      just these
 *   node scripts/probes.cjs -j2             two at a time (default 3)
 *   node scripts/probes.cjs --failed        only those that failed last time
 *
 * Each probe runs from this checkout (wherever this script lives), with its
 * own throwaway profile, off-screen and silent, exactly as
 * `node scripts/start.cjs --<name>` runs it. Logs go to tmp/probe-logs/,
 * and a summary to tmp/probe-logs/summary.json.
 *
 * A file is a probe when it exports run(). Some need more than one run or an
 * extra flag: those are listed below rather than guessed.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'probe-logs');
fs.mkdirSync(OUT, { recursive: true });

// Never run here: it shows the window on screen.
const SKIP = new Set(['screenshot']);
// Probes that are run with extra flags, or several times in a row (the
// second run checks what the first left behind, such as restored windows).
const RUNS = {
  privatewin: [['--incognito']],
  windowsedge: [[], []],
  splitdrag: [[], ['--incognito']],
  siteinfo: [[], ['--incognito']],
  netprivacy: [[], ['--incognito']],
  extlocal: [[], []],
};

const args = process.argv.slice(2);
const jArg = args.find((a) => /^-j\d+$/.test(a));
const J = jArg ? Number(jArg.slice(2)) : 3;
const onlyFailed = args.includes('--failed');
let names = args.filter((a) => !a.startsWith('-'));
if (!names.length) {
  names = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs') && !f.startsWith('diag-'))
    .map((f) => f.slice(0, -4))
    .filter((n) => !SKIP.has(n))
    .filter((n) => /module\.exports\s*=\s*\{[^}]*\brun\b|exports\.run\s*=/.test(fs.readFileSync(path.join(ROOT, 'tests', n + '.cjs'), 'utf8')));
}
if (onlyFailed) {
  try {
    const last = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
    const failed = new Set(last.filter((r) => r.code !== 0 || r.fails > 0).map((r) => r.name));
    names = names.filter((n) => failed.has(n));
  } catch { /* no earlier run: run them all */ }
}

const TIMEOUT = 10 * 60 * 1000;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function once(name, extra, n) {
  return new Promise((resolve) => {
    const start = Date.now();
    const file = path.join(OUT, name + (n ? '.' + (n + 1) : '') + '.log');
    const log = fs.createWriteStream(file);
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.cjs'), '--' + name, ...extra], { cwd: ROOT, env });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => child.kill(), TIMEOUT);
    child.on('exit', (code) => {
      clearTimeout(timer);
      setTimeout(() => {
        log.end(() => {
          const text = fs.readFileSync(file, 'utf8');
          const fails = (text.match(/^\s*FAIL\b/gm) || []).length;
          resolve({ code: code ?? -1, fails, secs: Math.round((Date.now() - start) / 1000), log: path.relative(ROOT, file) });
        });
      }, 200);
    });
  });
}

async function probe(name) {
  const runs = RUNS[name] || [[]];
  const results = [];
  for (let i = 0; i < runs.length; i++) results.push(await once(name, runs[i], runs.length > 1 ? i : 0));
  const worst = results.find((r) => r.code !== 0 || r.fails > 0) || results[results.length - 1];
  const result = { name, code: worst.code, fails: results.reduce((s, r) => s + r.fails, 0), secs: results.reduce((s, r) => s + r.secs, 0), log: worst.log };
  console.log((result.code === 0 && !result.fails ? 'pass  ' : 'FAIL  ') + name.padEnd(22) + String(result.secs).padStart(4) + 's' +
    (result.fails ? '  ' + result.fails + ' failed check(s), see ' + result.log : result.code !== 0 ? '  exit ' + result.code + ', see ' + result.log : ''));
  return result;
}

(async () => {
  const queue = [...names];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(J, queue.length) }, async () => {
    while (queue.length) results.push(await probe(queue.shift()));
  }));
  results.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 1));
  const bad = results.filter((r) => r.code !== 0 || r.fails > 0);
  console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' probes passed' + (bad.length ? '; failed: ' + bad.map((r) => r.name).join(', ') : ''));
  process.exit(bad.length ? 1 : 0);
})();
