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
  let time = 0;
  let disposed = false;

  const resize = () => {
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    // CSS decides the width (100% of the card); only the drawing buffer is
    // sized here. Setting an inline pixel width made the card grow to fit the
    // canvas instead of the canvas fitting the card.
    const w = Math.max(280, canvas.clientWidth || wrap.clientWidth || 640);
    // The system is wider than it is tall, and must not push the page down.
    // Taller than it was: the inner orbits were bunched near the centre and
    // the planets overlapped each other.
    const h = Math.max(300, Math.min(440, w * 0.58));
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(h * ratio);
    canvas.style.height = h + 'px';
    width = w;
    height = h;
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
    const pulse = reduced ? 0 : Math.sin(time * 40) * 0.06;
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

  const frame = () => {
    // Keep waiting rather than giving up. The loop is started before the node
    // is appended, so isConnected is false on the first frame - returning
    // there killed the loop permanently and the canvas stayed blank, which is
    // why the planetarium failed to draw about one launch in three.
    if (disposed) return;
    if (!wrap.isConnected) { requestAnimationFrame(frame); return; }
    // The canvas has no size until it is in the document, so measure once it
    // is rather than at construction.
    if (!width || !height) resize();
    if (!reduced) time += 0.0022;

    context.clearRect(0, 0, canvas.width, canvas.height);

    const cx = width / 2;
    const cy = height / 2;
    // Orbits are ellipses so the system reads as tilted rather than flat.
    // Leave room for a planet's own radius plus its glow at the outermost
    // orbit, or the outer planets are drawn half outside the canvas.
    const margin = Math.max(26, Math.min(40, width / 24));
    const maxA = (width / 2) - margin;
    const maxB = (height / 2) - margin;

    bodies = [];
    const base = Math.max(10, Math.min(17, width / 52));
    const sizeFor = (index, planet, scale = 1) =>
      base * scale * (hovered === index ? 1.45 : planet.id === current ? 1.18 : 1);

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
      const a = maxA * (0.3 + step * 0.7);
      const b = maxB * (0.3 + step * 0.7);
      // Outer planets move more slowly, which is both true and easier to read.
      // Golden-angle spacing spreads them round the system instead of in a line.
      const angle = spin + time * (1.6 / (slot + 2)) + slot * 2.399963;
      const x = cx + Math.cos(angle) * a;
      const y = cy + Math.sin(angle) * b;

      context.save();
      context.strokeStyle = (planet.palette && planet.palette.primary) || '#ffffff';
      context.globalAlpha = hovered === index ? 0.45 : planet.custom ? 0.22 : 0.08;
      context.lineWidth = 1 * ratio;
      if (planet.custom) context.setLineDash([4 * ratio, 5 * ratio]);
      context.beginPath();
      context.ellipse(cx * ratio, cy * ratio, a * ratio, b * ratio, 0, 0, Math.PI * 2);
      context.stroke();
      context.restore();

      const body = { planet, x, y, r: sizeFor(index, planet), index };
      bodies.push(body);
      if (planet.id === 'earth') earth = body;
    });
    if (moonIndex >= 0) {
      const moon = planets[moonIndex];
      const around = earth || { x: cx, y: cy, r: base };
      const angle = time * 9 + spin;
      const distance = around.r * 2.1 + 6;
      bodies.push({ planet: moon, index: moonIndex, r: sizeFor(moonIndex, moon, 0.55),
        x: around.x + Math.cos(angle) * distance, y: around.y + Math.sin(angle) * distance * 0.7 });
    }

    // Draw far-to-near so nearer planets overlap correctly.
    bodies.slice().sort((one, two) => one.y - two.y).forEach((body) => {
      const lit = hovered === body.index ? 1 : body.planet.id === current ? 0.55 : 0.18;
      if (body.sun) drawSun(body.planet, body.x, body.y, body.r, lit);
      else drawPlanet(body.planet, body.x, body.y, body.r, lit);
    });

    requestAnimationFrame(frame);
  };

  /** Which planet is under this pointer position, if any. */
  const hitTest = (event) => {
    const box = canvas.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    let best = -1;
    let bestDistance = Infinity;
    for (const body of bodies) {
      const distance = Math.hypot(px - body.x, py - body.y);
      // A generous radius: these are small targets and a near miss should
      // still select rather than silently do nothing.
      if (distance < body.r + 12 && distance < bestDistance) {
        bestDistance = distance;
        best = body.index;
      }
    }
    return best;
  };

  const showCaption = (index) => {
    const planet = index >= 0 ? planets[index] : planets.find((item) => item.id === current);
    caption.querySelector('.planetarium-name').textContent = planet ? planet.name : '';
    caption.querySelector('.planetarium-blurb').textContent = planet ? (planet.blurb || '') : '';
    if (planet && planet.palette) {
      caption.style.setProperty('--caption-tone', planet.palette.primary);
    }
  };

  canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
      spin = spinFrom + (event.clientX - dragFrom) * 0.006;
      return;
    }
    const at = hitTest(event);
    if (at !== hovered) {
      hovered = at;
      canvas.style.cursor = at >= 0 ? 'pointer' : 'grab';
      showCaption(at);
    }
  });

  canvas.addEventListener('pointerleave', () => {
    hovered = -1;
    dragging = false;
    showCaption(-1);
  });

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    dragFrom = event.clientX;
    spinFrom = spin;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointerup', (event) => {
    const moved = Math.abs(event.clientX - dragFrom) > 4;
    dragging = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    if (moved) return;                       // a drag is not a choice
    const at = hitTest(event);
    if (at < 0) return;
    current = planets[at].id;
    showCaption(at);
    onPick(planets[at].id);
  });

  // Keyboard: the planetarium is one control that steps through the planets.
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'listbox');
  canvas.setAttribute('aria-label', 'Theme, as a planet');
  canvas.addEventListener('keydown', (event) => {
    const at = planets.findIndex((planet) => planet.id === current);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      hovered = Math.min(planets.length - 1, at + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      hovered = Math.max(0, at - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (hovered >= 0) { current = planets[hovered].id; onPick(current); }
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    current = planets[hovered].id;
    showCaption(hovered);
    onPick(current);
  });

  addEventListener('resize', resize);
  resize();
  showCaption(-1);
  requestAnimationFrame(frame);

  return {
    node: wrap,
    setCurrent(id) { current = id; showCaption(-1); },
    dispose() { disposed = true; removeEventListener('resize', resize); },
  };
}

window.planetarium = { build };

})();
