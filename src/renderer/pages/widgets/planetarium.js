'use strict';
(function () {
/**
 * The theme picker: a planetarium.
 *
 * Choosing how the browser looks should be done by LOOKING, not by reading
 * names in a dropdown. So the planets are drawn as actual bodies, orbiting,
 * each rendered from its own three-colour identity: a lit limb in the primary
 * colour, a secondary band, and a shadow side in the deep colour.
 *
 * Interaction, in order of how people reach for it:
 *   - hover a planet   -> it swells, names itself, and the ring lights up
 *   - click a planet   -> the whole browser changes to it, immediately
 *   - drag the system  -> the orbits rotate under the pointer
 *   - the Forge        -> build your own world from a colour and a light/dark
 *
 * Applying on click rather than behind a Save button is deliberate: the only
 * way to judge a theme is to see the browser wearing it, and every choice here
 * is one click to undo.
 *
 * Drawn on a canvas rather than as DOM nodes. Eleven animated bodies with
 * gradients and shadows are eleven composited layers recalculating on every
 * frame; a canvas is one.
 */

function build(ctx, options) {
  const settings = options || {};
  const planets = (settings.planets || []).slice().sort((a, b) => a.order - b.order);
  const onPick = settings.onPick || (() => {});
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const wrap = ctx.element('div', { class: 'planetarium' });
  const canvas = ctx.element('canvas', { class: 'planetarium-canvas' });
  const caption = ctx.element('div', { class: 'planetarium-caption' }, [
    ctx.element('span', { class: 'planetarium-name' }),
    ctx.element('span', { class: 'planetarium-blurb' }),
  ]);
  wrap.append(canvas, caption);

  const context = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let ratio = 1;

  // Where each planet currently is, recomputed every frame and used for both
  // drawing and hit-testing, so what is clicked is exactly what is drawn.
  let bodies = [];
  let hovered = -1;
  let current = settings.current || '';
  let spin = 0;          // the whole system's rotation
  let dragging = false;
  let dragFrom = 0;
  let spinFrom = 0;
  let pressed = -1;      // the planet under the pointer when it went down
  let pointer = null;    // the pointer's last position over the canvas
  let time = 0;          // orbital clock, in "orbit units", advanced by real time
  let clock = 0;         // wall time, for the Sun's pulse
  let last = 0;          // the previous frame's timestamp
  let pace = 1;          // 1 = orbiting, 0 = held still while someone chooses
  const grow = [];       // each body's eased hover size
  let stars = null;      // the sky, drawn once per size and theme
  let disposed = false;

  // The system is a tilted disc: every orbit has the same tilt, so it reads
  // as one solar system seen from slightly above rather than a set of ellipses
  // stretched to whatever shape the card happens to be.
  const TILT = 0.42;
  // Orbital speed per millisecond. Driven by the clock, not the frame count:
  // counting frames made the planets race four times faster on a 240 Hz
  // screen than on a 60 Hz one, too fast to click.
  const SPEED = 0.00011;

  /**
   * Size the drawing buffer to the canvas as it is actually shown.
   *
   * Returns false while the canvas is not laid out (its section is hidden).
   * It used to fall back to a guessed 640px there, and because nothing
   * measured again until the WINDOW resized, Settings - which opens on another
   * section and builds this hidden - kept that guess: the 640px picture was
   * stretched across the whole card (everything looked widened), and clicks,
   * hit-tested in the unstretched coordinates, landed where no planet was.
   */
  const resize = () => {
    const shown = canvas.clientWidth;
    if (!shown) { width = 0; height = 0; return false; }
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    // CSS decides the width (100% of the card); only the drawing buffer is
    // sized here. Setting an inline pixel width made the card grow to fit the
    // canvas instead of the canvas fitting the card.
    const w = Math.max(260, shown);
    // A composed scene rather than a band as tall as it is wide: tall enough
    // for the orbits to breathe, never so tall it pushes the page away.
    const h = Math.round(Math.max(250, Math.min(340, w * 0.44)));
    if (w === width && h === height && canvas.width === Math.floor(w * ratio)) return true;
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(h * ratio);
    canvas.style.height = h + 'px';
    width = w;
    height = h;
    stars = null;
    return true;
  };

  /** A still field of faint stars in the page's own text colour. */
  const paintStars = () => {
    const sky = document.createElement('canvas');
    sky.width = canvas.width;
    sky.height = canvas.height;
    const paint = sky.getContext('2d');
    paint.fillStyle = getComputedStyle(canvas).color || '#ffffff';
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed % 10000) / 10000; };
    const count = Math.round(width * height / 2600);
    for (let i = 0; i < count; i++) {
      const x = next() * sky.width;
      const y = next() * sky.height;
      const bright = next();
      paint.globalAlpha = 0.06 + bright * bright * 0.34;
      paint.beginPath();
      paint.arc(x, y, (0.35 + bright * 0.75) * ratio, 0, Math.PI * 2);
      paint.fill();
    }
    stars = sky;
  };

  /** Draw one planet as a lit sphere from its own three colours. */
  const drawPlanet = (planet, x, y, r, lit) => {
    const palette = planet.palette || {};
    const primary = palette.primary || '#888888';
    const secondary = palette.secondary || primary;
    const deep = palette.deep || '#222222';

    context.save();
    context.translate(x * ratio, y * ratio);
    const radius = r * ratio;

    // Glow, stronger for the hovered and the current planet.
    if (lit > 0) {
      const glow = context.createRadialGradient(0, 0, radius * 0.7, 0, 0, radius * 2.6);
      glow.addColorStop(0, primary + Math.round(lit * 90).toString(16).padStart(2, '0'));
      glow.addColorStop(1, primary + '00');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(0, 0, radius * 2.6, 0, Math.PI * 2);
      context.fill();
    }

    // The body: lit limb in primary, terminator into deep.
    const face = context.createLinearGradient(-radius, -radius, radius, radius);
    face.addColorStop(0, primary);
    face.addColorStop(0.5, secondary);
    face.addColorStop(1, deep);
    context.fillStyle = face;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();

    // A band across the middle, so a planet reads as a body rather than a dot.
    context.save();
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.clip();
    context.globalAlpha = 0.34;
    context.fillStyle = secondary;
    context.beginPath();
    context.ellipse(0, radius * 0.12, radius * 1.2, radius * 0.22, 0, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 0.2;
    context.beginPath();
    context.ellipse(0, -radius * 0.34, radius * 1.2, radius * 0.14, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();

    // Surface detail: a few soft mottles in the planet's own colours, placed
    // from the planet's NAME so they are stable rather than jittering every
    // frame. Without these a planet is a smooth gradient ball, which is what
    // made them read as generated rather than observed.
    context.save();
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.clip();
    const seedText = String(planet.id || planet.name || 'x');
    let hash = 0;
    for (let i = 0; i < seedText.length; i++) hash = (hash * 31 + seedText.charCodeAt(i)) >>> 0;
    for (let i = 0; i < 5; i++) {
      hash = (hash * 1103515245 + 12345) >>> 0;
      const ax = ((hash % 200) / 100 - 1) * radius * 0.6;
      hash = (hash * 1103515245 + 12345) >>> 0;
      const ay = ((hash % 200) / 100 - 1) * radius * 0.6;
      hash = (hash * 1103515245 + 12345) >>> 0;
      const ar = radius * (0.14 + (hash % 100) / 100 * 0.24);
      context.globalAlpha = 0.16;
      context.fillStyle = i % 2 ? deep : secondary;
      context.beginPath();
      context.ellipse(ax, ay, ar, ar * 0.72, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();

    // A specular highlight, so the body reads as lit from one side rather
    // than evenly coloured.
    const spec = context.createRadialGradient(
      -radius * 0.35, -radius * 0.38, 0, -radius * 0.35, -radius * 0.38, radius * 0.9);
    spec.addColorStop(0, 'rgba(255,255,255,0.28)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = spec;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();

    // Shadow side, so the light has a direction.
    const shade = context.createLinearGradient(-radius * 0.2, -radius, radius, radius);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.55)');
    context.fillStyle = shade;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();

    // Saturn gets its rings, because a gold circle is not Saturn.
    if (planet.id === 'saturn') {
      context.save();
      context.rotate(-0.42);
      context.strokeStyle = secondary;
      context.globalAlpha = 0.85;
      context.lineWidth = Math.max(1, radius * 0.1);
      context.beginPath();
      context.ellipse(0, 0, radius * 1.75, radius * 0.42, 0, 0, Math.PI * 2);
      context.stroke();
      context.globalAlpha = 0.45;
      context.lineWidth = Math.max(1, radius * 0.06);
      context.beginPath();
      context.ellipse(0, 0, radius * 2.1, radius * 0.5, 0, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }

    // The current planet wears a ring, so the chosen one is obvious at rest.
    if (planet.id === current) {
      context.strokeStyle = primary;
      context.globalAlpha = 0.9;
      context.lineWidth = 1.6 * ratio;
      context.beginPath();
      context.arc(0, 0, radius * 1.45, 0, Math.PI * 2);
      context.stroke();
      context.globalAlpha = 1;
    }
    context.restore();
  };

  /** The Sun: not a planet on an orbit but the light at the middle of them. */
  const drawSun = (planet, x, y, r, lit) => {
    const palette = planet.palette || {};
    const pulse = reduced ? 0 : Math.sin(clock * 0.0053) * 0.06;
    context.save();
    context.translate(x * ratio, y * ratio);
    const radius = r * ratio;
    const corona = context.createRadialGradient(0, 0, radius * 0.6, 0, 0, radius * (3.4 + pulse * 4));
    corona.addColorStop(0, (palette.primary || '#e8a020') + 'aa');
    corona.addColorStop(0.35, (palette.secondary || '#e2622c') + '44');
    corona.addColorStop(1, (palette.secondary || '#e2622c') + '00');
    context.fillStyle = corona;
    context.beginPath();
    context.arc(0, 0, radius * 3.6, 0, Math.PI * 2);
    context.fill();
    const body = context.createRadialGradient(-radius * 0.25, -radius * 0.25, radius * 0.1, 0, 0, radius);
    body.addColorStop(0, '#fffbe8');
    body.addColorStop(0.45, palette.primary || '#e8a020');
    body.addColorStop(1, palette.secondary || '#e2622c');
    context.fillStyle = body;
    context.beginPath();
    context.arc(0, 0, radius * (1 + pulse * 0.3), 0, Math.PI * 2);
    context.fill();
    if (planet.id === current || lit >= 1) {
      context.strokeStyle = palette.primary || '#e8a020';
      context.globalAlpha = 0.9;
      context.lineWidth = 1.6 * ratio;
      context.beginPath();
      context.arc(0, 0, radius * 1.35, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  };

  const frame = (now) => {
    // Keep waiting rather than giving up. The loop is started before the node
    // is appended, so isConnected is false on the first frame - returning
    // there killed the loop permanently and the canvas stayed blank, which is
    // why the planetarium failed to draw about one launch in three.
    if (disposed) return;
    const stamp = typeof now === 'number' ? now : performance.now();
    // Real elapsed time, capped so a hidden tab coming back does not jump
    // the planets half an orbit.
    const elapsed = last ? Math.min(64, Math.max(0, stamp - last)) : 16;
    last = stamp;
    // The canvas has no size until it is in the document and its section is
    // shown, so measure then, rather than guess at construction.
    if (!wrap.isConnected || ((!width || !height) && !resize())) { requestAnimationFrame(frame); return; }

    // While the pointer is over the system the orbits ease to a stop, so the
    // planet someone is reading about is still there when they click it.
    const holding = pointer && !dragging;
    pace += ((holding ? 0 : 1) - pace) * Math.min(1, elapsed / 180);
    clock += elapsed;
    if (!reduced) time += elapsed * SPEED * pace;

    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!stars) paintStars();
    context.drawImage(stars, 0, 0);

    const cx = width / 2;
    const cy = height / 2;
    // Planet size follows the room the system has, not the card's width.
    const room = Math.min(width / 2, (height / 2) / TILT);
    const base = Math.max(8, Math.min(14, room / 24));
    // Keep the outermost planet, its glow and Saturn's rings inside the sky.
    const margin = base * 2.4 + 10;
    const maxA = Math.min(width / 2 - margin, (height / 2 - margin) / TILT);
    const maxB = maxA * TILT;

    bodies = [];
    const sizeFor = (index, planet, scale = 1) => {
      const target = hovered === index ? 1.4 : planet.id === current ? 1.16 : 1;
      grow[index] = grow[index] == null ? target : grow[index] + (target - grow[index]) * Math.min(1, elapsed / 90);
      return base * scale * grow[index];
    };

    // The Sun sits at the centre, the Moon goes round the Earth, and every
    // other body - including the ones the user made - has an orbit of its own.
    const sunIndex = planets.findIndex((planet) => planet.id === 'sun');
    const moonIndex = planets.findIndex((planet) => planet.id === 'moon');
    const orbiters = planets.map((planet, index) => index).filter((index) => index !== sunIndex && index !== moonIndex);
    if (sunIndex >= 0) {
      bodies.push({ planet: planets[sunIndex], x: cx, y: cy, r: sizeFor(sunIndex, planets[sunIndex], 1.7), index: sunIndex, sun: true });
    }
    let earth = null;
    orbiters.forEach((index, slot) => {
      const planet = planets[index];
      const step = (slot + 1) / orbiters.length;
      const a = maxA * (0.32 + step * 0.68);
      const b = maxB * (0.32 + step * 0.68);
      // Outer planets move more slowly, which is both true and easier to read.
      // Golden-angle spacing spreads them round the system instead of in a line.
      const angle = spin + time * (1.6 / (slot + 2)) + slot * 2.399963;
      const x = cx + Math.cos(angle) * a;
      const y = cy + Math.sin(angle) * b;
      // Nearer the viewer (the lower half of the disc) is a little larger.
      const depth = 1 + Math.sin(angle) * 0.1;

      context.save();
      context.strokeStyle = (planet.palette && planet.palette.primary) || '#ffffff';
      context.globalAlpha = hovered === index ? 0.5 : planet.id === current ? 0.26 : planet.custom ? 0.22 : 0.09;
      context.lineWidth = 1 * ratio;
      if (planet.custom) context.setLineDash([4 * ratio, 5 * ratio]);
      context.beginPath();
      context.ellipse(cx * ratio, cy * ratio, a * ratio, b * ratio, 0, 0, Math.PI * 2);
      context.stroke();
      context.restore();

      const body = { planet, x, y, r: sizeFor(index, planet, depth), index };
      bodies.push(body);
      if (planet.id === 'earth') earth = body;
    });
    if (moonIndex >= 0) {
      const moon = planets[moonIndex];
      const around = earth || { x: cx, y: cy, r: base };
      // The Moon laps the Earth quickly, but not so quickly it cannot be caught.
      const angle = time * 5 + spin;
      const distance = around.r * 1.9 + 7;
      bodies.push({ planet: moon, index: moonIndex, r: sizeFor(moonIndex, moon, 0.58),
        x: around.x + Math.cos(angle) * distance, y: around.y + Math.sin(angle) * distance * 0.7 });
    }

    // Draw far-to-near so nearer planets overlap correctly.
    bodies.slice().sort((one, two) => one.y - two.y).forEach((body) => {
      const lit = hovered === body.index ? 1 : body.planet.id === current ? 0.55 : 0.18;
      if (body.sun) drawSun(body.planet, body.x, body.y, body.r, lit);
      else drawPlanet(body.planet, body.x, body.y, body.r, lit);
    });

    // The pointer can rest while the system still drifts: keep what is named
    // below the system true to what is actually under it.
    if (pointer && !dragging) hover(hitAt(pointer.x, pointer.y));

    requestAnimationFrame(frame);
  };

  /** Pointer position in the canvas's drawing coordinates. */
  const toCanvas = (event) => {
    const box = canvas.getBoundingClientRect();
    // Scale by what is actually shown, so a hit is where the planet is drawn
    // even if the buffer and the box ever disagree.
    const sx = box.width && width ? width / box.width : 1;
    const sy = box.height && height ? height / box.height : 1;
    return { x: (event.clientX - box.left) * sx, y: (event.clientY - box.top) * sy };
  };

  /** Which planet is at this point, if any. */
  const hitAt = (px, py) => {
    let best = -1;
    let bestDistance = Infinity;
    for (const body of bodies) {
      const distance = Math.hypot(px - body.x, py - body.y);
      // A generous radius: these are small targets and a near miss should
      // still select rather than silently do nothing. Ranked by distance from
      // each body's EDGE, so the large Sun does not steal a click meant for a
      // small planet beside it.
      if (distance < body.r + 10 && distance - body.r < bestDistance) {
        bestDistance = distance - body.r;
        best = body.index;
      }
    }
    return best;
  };
  const hitTest = (event) => { const at = toCanvas(event); return hitAt(at.x, at.y); };

  const showCaption = (index) => {
    const planet = index >= 0 ? planets[index] : planets.find((item) => item.id === current);
    caption.querySelector('.planetarium-name').textContent = planet ? planet.name : '';
    caption.querySelector('.planetarium-blurb').textContent = planet ? (planet.blurb || '') : '';
    if (planet && planet.palette) {
      caption.style.setProperty('--caption-tone', planet.palette.primary);
    }
  };

  const hover = (at) => {
    if (at === hovered) return;
    hovered = at;
    canvas.style.cursor = at >= 0 ? 'pointer' : 'grab';
    showCaption(at);
  };

  const choose = (index) => {
    if (index < 0 || !planets[index]) return;
    current = planets[index].id;
    showCaption(index);
    onPick(current);
  };

  canvas.addEventListener('pointermove', (event) => {
    pointer = toCanvas(event);
    if (dragging) {
      // Only a real drag turns the system; a hand that wobbles while
      // clicking must not.
      if (Math.abs(event.clientX - dragFrom) > 4) spin = spinFrom + (event.clientX - dragFrom) * 0.006;
      return;
    }
    hover(hitAt(pointer.x, pointer.y));
  });

  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    if (dragging) return;          // captured: the drag carries on outside
    hover(-1);
    showCaption(-1);
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    dragFrom = event.clientX;
    spinFrom = spin;
    // What was pressed is what is chosen, even if it drifts before release.
    pressed = hitTest(event);
    try { canvas.setPointerCapture(event.pointerId); } catch { /* not a live pointer */ }
  });

  const release = (event) => {
    if (!dragging) return;
    const moved = Math.abs(event.clientX - dragFrom) > 4;
    dragging = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    const target = pressed;
    pressed = -1;
    if (event.type !== 'pointerup' || moved) return;   // a drag is not a choice
    choose(target >= 0 ? target : hitTest(event));
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // Keyboard: the planetarium is one control that steps through the planets.
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'listbox');
  canvas.setAttribute('aria-label', 'Theme, as a planet');
  canvas.addEventListener('keydown', (event) => {
    const at = planets.findIndex((planet) => planet.id === current);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(planets.length - 1, at + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(hovered >= 0 ? hovered : at);
      return;
    } else return;
    event.preventDefault();
    hovered = next;
    choose(next);
  });

  // Re-measure whenever the canvas's own box changes - the section being
  // shown, the card or sidebar resizing - not only when the window does.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (observer) observer.observe(canvas);
  addEventListener('resize', resize);
  resize();
  showCaption(-1);
  requestAnimationFrame(frame);

  // Where every body is right now, in drawing coordinates (CSS pixels of the
  // canvas as sized). For tests: they click a planet where it is actually
  // drawn, as a person would.
  wrap.planetariumBodies = () => bodies.map((body) =>
    ({ id: body.planet.id, x: body.x, y: body.y, r: body.r }));

  return {
    node: wrap,
    setCurrent(id) {
      current = id;
      stars = null;                  // the sky takes the new theme's colour
      if (hovered < 0) showCaption(-1);
    },
    dispose() {
      disposed = true;
      if (observer) observer.disconnect();
      removeEventListener('resize', resize);
    },
  };
}

window.planetarium = { build };

})();
