/**
 * Generate the app icon from the wordmark SVG.
 *
 * electron-builder needs a 512x512 (or larger) PNG at build/icon.png, from
 * which it produces the .icns macOS needs and the .ico Windows needs. Without
 * one, the packaged app wears Electron's default icon.
 *
 * Rendered through Electron rather than an image library, because Electron is
 * already a dependency and it renders the SVG with the same engine the browser
 * itself uses - so the icon looks exactly like the mark in the UI.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'assets', 'static-mark.svg'), 'utf8');

  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false,
    webPreferences: { offscreen: true },
  });

  // A rounded dark plate behind the mark: a bare glyph on transparency reads
  // as a broken icon in the dock and the taskbar.
  const html = `<!doctype html><meta charset="utf-8">
    <style>
      html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent}
      .plate{
        width:100%;height:100%;box-sizing:border-box;
        display:flex;align-items:center;justify-content:center;
        background:radial-gradient(120% 120% at 30% 20%,#12263d,#080d18 70%);
        border-radius:${Math.round(SIZE * 0.22)}px;
      }
      svg{width:62%;height:62%;filter:drop-shadow(0 ${Math.round(SIZE*0.02)}px ${Math.round(SIZE*0.05)}px rgba(0,0,0,.45))}
    </style>
    <div class="plate">${svg}</div>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((resolve) => setTimeout(resolve, 600));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  console.log('wrote build/icon.png (' + SIZE + 'x' + SIZE + ')');
  app.exit(0);
});
