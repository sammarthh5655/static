const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

/**
 * Create a desktop shortcut that launches the dev build without a terminal.
 *
 * This points at the project folder rather than an installed copy, so the
 * folder must stay put. For a movable/installable build, use electron-builder
 * (`npm run dist:win` and friends).
 */
const root = path.resolve(__dirname, '..');
const desktop = path.join(os.homedir(), 'Desktop');

if (!fs.existsSync(desktop)) {
  console.error('No Desktop folder found at ' + desktop);
  process.exit(1);
}

if (process.platform === 'win32') {
  // Built through WScript.Shell because .lnk is a binary format; writing one
  // by hand is not practical.
  const lnk = path.join(desktop, 'static.lnk');
  const icon = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const ps = `
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(lnk)})
    $s.TargetPath = 'wscript.exe'
    $s.Arguments = '"${path.join(root, 'scripts', 'launch.vbs')}"'
    $s.WorkingDirectory = ${quote(root)}
    $s.IconLocation = ${quote(icon + ',0')}
    $s.Description = 'static - desktop web browser'
    $s.Save()
  `;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || 'Failed to create shortcut');
    process.exit(1);
  }
  console.log('Created ' + lnk);
} else if (process.platform === 'linux') {
  const file = path.join(desktop, 'static.desktop');
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=static',
    'Comment=static - desktop web browser',
    `Exec=${path.join(root, 'node_modules', '.bin', 'electron')} ${root}`,
    `Path=${root}`,
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  console.log('Created ' + file);
} else if (process.platform === 'darwin') {
  // A .command file is the closest thing to a double-clickable launcher that
  // does not require building an .app bundle.
  const file = path.join(desktop, 'static.command');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `cd "${root}" || exit 1`,
    'node scripts/build.cjs',
    'unset ELECTRON_RUN_AS_NODE',
    'exec "$(node -p "require(\'electron\')")" "${PWD}"',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  console.log('Created ' + file);
  console.log('For a real .app bundle, run: npm run dist:mac');
} else {
  console.error('Unsupported platform: ' + process.platform);
  process.exit(1);
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
