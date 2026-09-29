/**
 * Turn the supplied logo into the two images Static uses.
 *
 *   npx electron scripts/make-logo.cjs "<logo.png>"
 *
 * - src/renderer/assets/static-logo.png: 512px rounded tile for the interface.
 * - build/icon.png: the same tile at 1024px, from which electron-builder
 *   makes the Windows .ico and macOS .icns.
 */
const { app, nativeImage, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = process.argv.find((a, i) => i > 1 && /\.(png|jpe?g)$/i.test(a) && fs.existsSync(a));
const MARK = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'static-logo.png');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (!SOURCE) { console.error('usage: electron scripts/make-logo.cjs <logo.png>'); app.exit(1); return; }
  const image = nativeImage.createFromPath(SOURCE);
  const { width, height } = image.getSize();
  const px = image.toBitmap(); // BGRA
  const at = (x, y) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const bg = [2, 1, 0].map((c) => Math.round(corners.reduce((sum, i) => sum + px[i + c], 0) / 4));
  const hex = '#' + bg.map((v) => v.toString(16).padStart(2, '0')).join('');

  // The logo's background is a gradient, not a flat colour, so it cannot be
  // keyed out cleanly. Instead the artwork keeps its own navy and sits on a
  // rounded tile of that colour, its edges faded into the tile so no
  // rectangle shows. The same tile is the app icon and the in-app mark.
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, webPreferences: { offscreen: true } });
  const render = async (size) => {
    win.setContentSize(size, size);
    const html = `<!doctype html><style>
      html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
      .plate{width:100%;height:100%;display:grid;place-items:center;overflow:hidden;
        border-radius:${Math.round(size * 0.22)}px;
        background:radial-gradient(90% 90% at 50% 45%, ${hex}, color-mix(in srgb, ${hex} 70%, #000) 100%)}
      img{width:118%;height:auto;image-rendering:auto;
        -webkit-mask-image:radial-gradient(closest-side, #000 72%, transparent 100%);
        mask-image:radial-gradient(closest-side, #000 72%, transparent 100%)}
    </style><div class="plate"><img src="${image.toDataURL()}"></div>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((resolve) => setTimeout(resolve, 500));
    return win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  };
  fs.mkdirSync(path.dirname(MARK), { recursive: true });
  fs.writeFileSync(MARK, (await render(512)).toPNG());
  fs.mkdirSync(path.dirname(ICON), { recursive: true });
  const big = await render(1024);
  fs.writeFileSync(ICON, big.toPNG());

  // A Windows .ico for shortcuts, holding PNG images at the sizes Windows asks
  // for (PNG-in-ICO works on every Windows Static supports).
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => big.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  fs.writeFileSync(path.join(path.dirname(ICON), 'icon.ico'), Buffer.concat([header, ...images]));
  console.log('source ' + width + 'x' + height + ', background ' + hex);
  console.log('wrote ' + path.relative(process.cwd(), MARK) + ' and ' + path.relative(process.cwd(), ICON));
  app.exit(0);
});
