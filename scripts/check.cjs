const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|cjs|mjs)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
      count++;
    }
  }
}
['src', 'scripts', 'tests'].forEach(walk);
console.log('Syntax checked ' + count + ' JavaScript files.');
