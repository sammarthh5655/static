/**
 * Draw the macOS installer window's background: build/background.png
 * (540x380) and build/background@2x.png (1080x760) for Retina screens.
 * electron-builder's DMG step combines the two into one image on a Mac.
 *
 * The layout matches `dmg.contents` in electron-builder.config.cjs: the app
 * icon is centred at (140, 190) and the Applications folder at (400, 190),
 * so the arrow runs between them, just above where Finder writes the names.
 *
 * Light on purpose: Finder labels the two icons in dark text, which a dark
 * background would swallow.
 *
 *   npm run dmg-background      (rendered by Electron, window never shown)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BUILD = path.join(__dirname, '..', 'build');
const W = 540;
const H = 380;
const mark = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'static-mark.svg'), 'utf8');

const page = (scale) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${W * scale}px; height: ${H * scale}px; overflow: hidden; }
  body {
    font-family: -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    background:
      radial-gradient(ellipse at 50% -10%, rgba(0, 186, 255, 0.16), transparent 60%),
      radial-gradient(ellipse at 100% 110%, rgba(23, 100, 239, 0.10), transparent 55%),
      linear-gradient(180deg, #fbfdff 0%, #eef5fc 100%);
    position: relative;
  }
  .s { position: absolute; transform-origin: 0 0; transform: scale(${scale}); width: ${W}px; height: ${H}px; }
  .brand { position: absolute; top: 34px; left: 0; right: 0; display: flex; align-items: center; justify-content: center; gap: 10px; }
  .brand svg { width: 26px; height: 26px; }
  .brand b { font-size: 21px; font-weight: 650; letter-spacing: -0.02em; color: #0d1b2e; }
  .hint { position: absolute; top: 72px; left: 0; right: 0; text-align: center; font-size: 12.5px; color: #4b5d73; letter-spacing: 0.005em; }
  .slot { position: absolute; top: 132px; width: 116px; height: 116px; margin-left: -58px; border-radius: 26px;
          background: rgba(255,255,255,0.55); box-shadow: 0 1px 0 rgba(255,255,255,0.9) inset, 0 6px 22px rgba(19, 60, 120, 0.08); }
  .arrow { position: absolute; left: 0; top: 0; }
  .foot { position: absolute; bottom: 20px; left: 0; right: 0; text-align: center; font-size: 11px; color: #7b8ba0; }
</style></head><body><div class="s">
  <div class="brand">${mark}<b>static</b></div>
  <div class="hint">Drag static into your Applications folder to install it.</div>
  <div class="slot" style="left:140px"></div>
  <div class="slot" style="left:400px"></div>
  <svg class="arrow" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#50d6ff"/><stop offset="1" stop-color="#1764ef"/></linearGradient></defs>
    <path d="M214 182 C 250 160, 290 160, 322 178" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-dasharray="1 11"/>
    <path d="M314 168 L 328 181 L 310 187" fill="none" stroke="#1764ef" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <div class="foot">Then open static from Applications or Launchpad.</div>
</div></body></html>`;

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function render(scale, file) {
  const win = new BrowserWindow({ width: W * scale, height: H * scale, show: false, useContentSize: true, frame: false,
    webPreferences: { offscreen: false, sandbox: true, contextIsolation: true, zoomFactor: 1 } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(scale)));
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: W * scale, height: H * scale });
  // capturePage returns device pixels; make the file exactly the size asked for.
  const sized = image.getSize().width === W * scale ? image : image.resize({ width: W * scale, height: H * scale, quality: 'best' });
  fs.writeFileSync(path.join(BUILD, file), sized.toPNG());
  win.destroy();
  console.log('wrote build/' + file, sized.getSize());
}

app.whenReady().then(async () => {
  try {
    await render(1, 'background.png');
    await render(2, 'background@2x.png');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  app.quit();
});
