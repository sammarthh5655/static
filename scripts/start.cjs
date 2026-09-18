const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
// Some editors inherit this variable; Electron must start as a desktop app.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.resolve(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
