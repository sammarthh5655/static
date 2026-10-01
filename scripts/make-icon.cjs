/**
 * Generate the app icons from the Static mark (src/renderer/assets/static-mark.svg).
 *
 *   build/icon.png      Windows and Linux (1024x1024), and the source of
 *   build/icon.ico      the .ico for shortcuts and the installer
 *   build/icon-mac.png  macOS, drawn on Apple's icon grid
 *
 * Why two: macOS expects an icon's plate to sit inside the canvas with a
 * transparent margin (an 824px rounded square in a 1024px canvas) and draws
 * every Dock icon at that size. A plate that fills the whole canvas - what
 * Static had - looks oversized and square-cornered next to every other app.
 * Windows and Linux show icons with almost no margin, so their plate fills
 * nearly all of it.
 *
 * The mark is centred by its real outline, measured in the renderer, not by
 * its viewBox: the S does not sit in the middle of its own 64x64 box, which
 * is why it looked small and off-centre on the plate.
 *
 * Rendered through Electron rather than an image library: it is already a
 * dependency, and it draws the SVG with the engine the browser itself uses.
 * The window is never shown.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const BUILD = path.join(__dirname, '..', 'build');

/** Each icon: where the plate sits, its corner radius, and how big the mark is on it. */
const LAYOUTS = {
  windows: { file: 'icon.png', inset: 24, radius: 0.23, mark: 0.66, shadow: false },
  // Apple's grid: an 824px plate centred in 1024, continuous corners, and the
  // soft shadow every macOS app icon carries.
  mac: { file: 'icon-mac.png', inset: 100, radius: 0.225, mark: 0.64, shadow: true },
};

app.disableHardwareAcceleration();
// Each icon renders in its own hidden window; closing one must not quit.
app.on('window-all-closed', () => {});

function page(svg, layout) {
  const plate = SIZE - layout.inset * 2;
  return `<!doctype html><meta charset="utf-8">
  <style>
    html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
    .plate{
      position:absolute;left:${layout.inset}px;top:${layout.inset}px;width:${plate}px;height:${plate}px;
      box-sizing:border-box;display:flex;align-items:center;justify-content:center;
      border-radius:${Math.round(plate * layout.radius)}px;
      background:
        radial-gradient(90% 70% at 28% 18%, rgba(80,239,255,.16), transparent 60%),
        radial-gradient(120% 120% at 30% 20%, #142a44, #080d18 70%);
      box-shadow:
        inset 0 ${Math.round(plate * 0.004)}px 0 rgba(255,255,255,.10),
        inset 0 0 0 ${Math.max(1, Math.round(plate * 0.002))}px rgba(255,255,255,.05)
        ${layout.shadow ? `, 0 ${Math.round(plate * 0.028)}px ${Math.round(plate * 0.05)}px rgba(0,0,0,.35)` : ''};
    }
    svg{width:${Math.round(plate * layout.mark)}px;height:${Math.round(plate * layout.mark)}px;overflow:visible;
      filter:drop-shadow(0 ${Math.round(plate * 0.018)}px ${Math.round(plate * 0.04)}px rgba(0,0,0,.45))}
  </style>
  <div class="plate">${svg}</div>
  <script>
    // Fit the viewBox to the mark's real outline, so it is centred and sized
    // by what is drawn rather than by the empty space around it.
    const mark = document.querySelector('svg');
    const box = mark.getBBox();
    const side = Math.max(box.width, box.height);
    mark.setAttribute('viewBox', [box.x + box.width / 2 - side / 2, box.y + box.height / 2 - side / 2, side, side].join(' '));
    document.title = 'ready';
  </script>`;
}

async function render(svg, layout) {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(svg, layout)));
  for (let i = 0; i < 40 && win.webContents.getTitle() !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage();
  win.destroy();
  return image;
}

/** A Windows .ico holding PNG images at the sizes Windows asks for. */
function writeIco(image, file) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
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
  fs.writeFileSync(file, Buffer.concat([header, ...images]));
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'static-mark.svg'), 'utf8');
  fs.mkdirSync(BUILD, { recursive: true });
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    const image = await render(svg, layout);
    fs.writeFileSync(path.join(BUILD, layout.file), image.toPNG());
    console.log('wrote build/' + layout.file + ' (' + name + ', ' + SIZE + 'x' + SIZE + ')');
    if (name === 'windows') {
      writeIco(image, path.join(BUILD, 'icon.ico'));
      console.log('wrote build/icon.ico');
    }
  }
  app.exit(0);
});
