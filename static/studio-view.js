import { StudioRenderer } from './studio-renderer.js';
import { PLATE, placePlate } from './studio-plate.js';

const $ = id => document.getElementById(id);
const mix = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Hide and Show slide the panel at this one speed both ways (ms for the full slide).
const SLIDE = 450;

/** Camera navigation and the canonical control surface, with no playback state. */
export class StudioView {
  constructor({ beforeMove = () => {}, onTarget = () => {} } = {}) {
    this.stage = $('studio'); this.world = $('studio-world'); this.viewport = $('studio-camera');
    this.deck = $('drop-zone'); this.beforeMove = beforeMove; this.onTarget = onTarget;
    this.target = 'studio'; this.view = 'studio'; this.inspection = 0; this.motion = null; this.frame = null;
    // The panel's slide (0 shown, 1 away) and the close-up frame's share of it.
    this.away = 0; this.share = 0; this.glide = null; this.glideFrame = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    try {
      this.graphics = new StudioRenderer(this.stage, { onFailure: error => this.useFallback(error) }); this.stage.dataset.renderer = 'webgl';
    } catch (error) {
      this.useFallback(error);
    }
    this.measure(); this.paint(); this.settle(); this.stage.dataset.ready = 'true'; this.onTarget(this.target);
    $('studio-enter').addEventListener('click', () => this.goTo('turntable'));
    // Close-up opens with the listening panel cleared away; one pill on its top edge shows
    // and hides it again. The studio always shows it.
    this.controlsHidden = false;
    $('hud-toggle').addEventListener('click', () => { if (this.target === 'turntable') this.setControlsHidden(!this.controlsHidden); });
    // One header toggle replaces the former Studio/Turntable pair.
    $('studio-focus').addEventListener('click', () => this.goTo(this.target === 'turntable' ? 'studio' : 'turntable'));
    $('studio-quality').addEventListener('change', event => this.graphics?.guard(() => this.graphics.setQuality(event.target.value)));
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || document.querySelector('dialog[open]')) return;
      if ($('preset-toggle').getAttribute('aria-expanded') === 'true') return;
      if (this.skylineTarget) { event.preventDefault(); this.setSkyline(false); return; }
      if (this.target !== 'studio' && this.graphics) { event.preventDefault(); this.goTo('studio'); }
    });
    // Skyline: the UI fades and the view tilts up to the city; music keeps playing.
    this.sky = 0; this.skylineTarget = false;
    $('skyline-toggle').addEventListener('click', () => this.setSkyline(!this.skylineTarget));
    document.addEventListener('click', event => {
      if (this.skylineTarget && !event.target.closest('.masthead')) this.setSkyline(false);
    });
    // The panel and hero bound the open scene area, so their sizes also reframe the camera.
    this.resizeObserver = new ResizeObserver(() => { this.graphics?.guard(() => this.graphics.resize()); this.measure(); this.paint(); this.graphics?.guard(() => this.graphics.redraw()); });
    for (const node of [this.viewport, $('scene-frame'), $('listening-hud'), document.querySelector('.masthead')]) this.resizeObserver.observe(node);
    this.reduced.addEventListener('change', () => { if (this.reduced.matches) { if (this.motion) this.finish(); if (this.skyMotion) this.setSkyline(this.skylineTarget); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { if (this.motion) this.finish(false); if (this.skyMotion) this.setSkyline(this.skylineTarget, true); } });
    document.addEventListener('focusin', () => this.updateFocus());
    document.addEventListener('focusout', () => requestAnimationFrame(() => this.updateFocus()));
    const diagnostics = new URLSearchParams(location.search).has('studioDiagnostics') ? { capturePass: modes => this.graphics?.capturePass(modes) } : {};
    window.studioView = Object.freeze({
      ...diagnostics,
      snapshot: options => this.graphics?.snapshot(options) ?? { renderer: 'SVG fallback', ready: true },
      projectPoint: (name, local) => this.graphics?.projectPoint(name, local) ?? null,
    });
  }

  goTo(target) {
    if (!this.graphics || !['studio', 'turntable'].includes(target) || this.target === target) return;
    if (this.skylineTarget) this.setSkyline(false, true);
    this.beforeMove(); const previous = this.target; this.target = target; this.onTarget(target);
    // Every trip into the close-up clears the controls away from the click for a full view
    // of the deck; Show controls brings them back. The studio view always shows them.
    if (target === 'turntable') { this.controlsHidden = true; this.syncControls(); }
    cancelAnimationFrame(this.frame);
    const active = document.activeElement, moveFocus = this.deck.contains(active) || active === $('studio-enter');
    this.deck.inert = true; $('studio-enter').disabled = true;
    this.stage.dataset.moving = 'true'; this.stage.dataset.target = target; this.stage.setAttribute('aria-busy', 'true');
    this.label();
    if (moveFocus) $('studio-focus').focus({ preventScroll: true });
    this.motion = { from: this.inspection, to: target === 'turntable' ? 1 : 0, start: performance.now(), duration: previous === this.view ? 1650 : 950 };
    if (this.reduced.matches) { this.finish(); return; }
    const tick = now => {
      if (!this.motion) return;
      const { from, to, start, duration } = this.motion, progress = Math.min(1, Math.max(0, (now - start) / duration));
      this.inspection = mix(from, to, ease(progress)); this.paint(); this.present();
      if (progress === 1) this.finish(); else this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Open scene areas in stage pixels, measured as laid out at the top of the page
   * so scrolling a long phone layout never moves the composition. */
  measure() {
    const stage = this.stage.getBoundingClientRect(), width = stage.width, height = stage.height;
    const offset = getComputedStyle(this.stage).position === 'fixed' ? scrollY : 0;
    const y = node => { const r = node.getBoundingClientRect(); return { top: r.top + offset - stage.top, bottom: r.bottom + offset - stage.top }; };
    // Layout positions, not transformed ones: the panel slides away with a transform.
    const room = document.querySelector('.room'), hud = $('listening-hud'), roomTop = y(room).top;
    // The Hide/Show pill rests just above the bottom of the screen while the panel is away.
    room.style.setProperty('--hud-floor', `${height - roomTop}px`);
    // Docking depends on width only, never on the view, so the panel keeps its size during travel.
    const hudTop = roomTop + hud.offsetTop;
    room.style.setProperty('--hud-offset', `${hud.offsetTop}px`);
    const gutter = Math.min(24, width * .04), panel = Math.min(hudTop, height) - 12;

    const scene = y($('scene-frame')), header = y(document.querySelector('.masthead'));
    const rect = (top, bottom, side = gutter) => ({ x: side, y: top, width: Math.max(1, width - side * 2), height: Math.max(1, bottom - top) });
    // Phones inspect the deck nearly edge to edge so its controls stay finger-sized.
    const wide = rect(scene.top, Math.max(scene.top + 1, panel));
    // The photographic plate and the plate camera share this one placement.
    const plate = placePlate(width, height, wide);
    // Let the browser pick the derivative for the plate's real rendered width.
    $('studio-plate').sizes = `${Math.ceil(plate.width)}px`;
    // Close-up frames with the panel shown and hidden; the slide moves between them. The close-up
    // header keeps only its links (centred in the row, the Back pill up to 42 px tall), so the deck
    // starts just below them (the SVG fallback keeps the whole header); hidden, it ends just above
    // the resting Show controls pill. Narrower
    // close-ups keep status messages in a row above a shown panel, not over the deck.
    const closeTop = this.graphics ? (header.top + header.bottom) / 2 + 31 : header.bottom + 14, noticeRow = width < 1180 && width >= 600 ? 44 : 0;
    const close = bottom => rect(closeTop, Math.max(closeTop + 1, bottom), width < 600 ? 2 : gutter);
    this.closeFrames = [close(Math.min(hudTop, height) - 12 - noticeRow), close(height - 60)];
    this.framing = { width, height, wide, plate, settledPlate: plate, close: this.closeFrame() };
    this.placeShot();
  }

  /** Skyline view tilts the camera straight up to the city: the plate slides down to
   * top-aligned at the same scale (a pure vertical pan, no zoom or sideways drift). The
   * plate camera maps through the same rectangle, so the deck sinks exactly with the photo. */
  placeShot() {
    const settled = this.framing.settledPlate, t = ease(this.sky ?? 0);
    const plate = t === 0 ? settled : { ...settled, y: mix(settled.y, 0, t) };
    this.framing.plate = plate;
    Object.assign($('studio-plate').style, { left: `${plate.x}px`, top: `${plate.y}px`, width: `${plate.width}px`, height: `${plate.height}px` });
    this.graphics?.guard(() => this.graphics.setFraming(this.framing));
  }

  /** Reversible, retargetable 1.4-second tilt; immediate under reduced motion or `now`. */
  setSkyline(on, now = false) {
    if (on && (!this.graphics || this.target !== 'studio')) return;
    const room = document.querySelector('.room'), hud = $('listening-hud'), toggle = $('skyline-toggle');
    this.skylineTarget = on; cancelAnimationFrame(this.skyMotion); this.skyMotion = null;
    if (on) { this.beforeMove(); if (hud.contains(document.activeElement)) toggle.focus({ preventScroll: true }); }
    room.toggleAttribute('data-skyline', on); hud.inert = on || (this.hidesControls() && this.target === 'turntable');
    $('studio-enter').disabled = on || this.view !== 'studio';
    toggle.innerHTML = on ? '<span aria-hidden="true">←</span> Back to studio <kbd aria-hidden="true">Esc</kbd>' : 'Skyline';
    toggle.setAttribute('aria-label', on ? 'Return to the studio view' : 'Fade the controls and look out at the skyline');
    const from = this.sky, to = on ? 1 : 0, started = performance.now(), duration = 1400 * Math.abs(to - from);
    const step = time => {
      const progress = now || this.reduced.matches || !duration ? 1 : Math.min(1, (time - started) / duration);
      this.sky = mix(from, to, progress); this.placeShot(); this.paint(); this.present();
      this.skyMotion = progress < 1 ? requestAnimationFrame(step) : null;
    };
    step(started);
  }

  paint() {
    // The plate is a photograph from the wide camera: as the camera leaves it, the plate
    // pushes in around the table spot and falls out of focus behind the close-up.
    this.slide();
    const t = this.inspection, plateStyle = $('studio-plate').style, { plate } = this.framing;
    // Hero copy follows the camera, not the target: it leaves early on the way in and
    // returns only as the studio view settles.
    const room = document.querySelector('.room').style;
    // Skyline view fades the hero and panel as the view tilts up.
    const sky = this.sky ?? 0;
    room.setProperty('--intro-away', Math.max(smooth(0, .3, t), smooth(0, .5, sky)).toFixed(3));
    room.setProperty('--hud-away', this.away.toFixed(3));
    // The pill reads Show controls from the moment the camera heads in, then follows the slide.
    room.setProperty('--hud-label', (this.target === 'turntable' && this.view === 'studio' ? 1 : this.away).toFixed(3));
    // Skyline only fades the panel in place; it never slides.
    room.setProperty('--hud-fade', smooth(0, .6, sky).toFixed(3));
    plateStyle.transformOrigin = `${PLATE.anchor[0] * plate.width}px ${PLATE.anchor[1] * plate.height}px`;
    plateStyle.transform = t ? `scale(${mix(1, 1.45, ease(Math.min(1, t * 1.15)))})` : '';
    plateStyle.filter = t ? `blur(${(18 * Math.min(1, t / .45)).toFixed(2)}px) brightness(${mix(1, .62, t).toFixed(3)}) saturate(${mix(1, .8, t).toFixed(3)})` : '';
    if (!this.graphics) {
      // Fit the visible SVG into the area the panel leaves open.
      const { width, height, close } = this.framing, scale = Math.min(close.width * .94 / 1024, close.height * .96 / 828);
      const dx = close.x + close.width / 2 - width / 2, dy = close.y + close.height / 2 - height / 2;
      this.world.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`; this.updateFocus(); return;
    }
    this.graphics.guard(() => this.graphics.updateCamera(this.inspection));
    if (!this.graphics) return;
    // Project the original, transparent SVG control plane through the same
    // camera as the visible meshes. At the overhead endpoint this is affine.
    const camera = this.graphics.camera;
    const matrix = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).elements;
    const width = this.graphics.width / 2, height = -this.graphics.height / 2;
    const x = i => matrix[i] * width, y = i => matrix[i] * height;
    const transform = [x(0) / 1000, y(1) / 1000, 0, matrix[3] / 1000,
      x(8) / 1000, y(9) / 1000, 0, matrix[11] / 1000, 0, 0, 1, 0,
      x(4) * .075 + x(12), y(5) * .075 + y(13), 0, matrix[7] * .075 + matrix[15]];
    this.world.style.transform = `matrix3d(${transform.join(',')})`;
    this.updateFocus();
  }

  finish(focus = true) {
    cancelAnimationFrame(this.frame); this.frame = null; this.motion = null;
    this.inspection = this.target === 'turntable' ? 1 : 0; this.paint(); this.view = this.target; this.settle();
    const active = document.activeElement;
    if (focus && (active === document.body || active === $('studio-enter') || active === $('studio-focus'))) {
      (this.view === 'studio' ? $('studio-enter') : $('studio-focus')).focus({ preventScroll: true });
    }
  }

  settle() {
    const close = this.view === 'turntable';
    this.stage.dataset.view = this.view; this.stage.dataset.target = this.view; this.stage.dataset.moving = 'false';
    this.stage.setAttribute('aria-busy', 'false'); this.deck.inert = !close;
    $('studio-enter').disabled = close; $('studio-enter').hidden = close; this.label();
    $('studio-description').textContent = !this.graphics
      ? 'Graphics unavailable. The turntable and audio controls are ready to use.'
      : close ? 'Turntable view. Use the physical controls, or return to the studio.' : 'Studio view. Select the turntable to move closer. Playback controls are below.';
    this.updateFocus();
  }

  setControlsHidden(hidden) {
    const hud = $('listening-hud'), hadFocus = hud.contains(document.activeElement);
    if (hidden) this.beforeMove();
    this.controlsHidden = hidden; this.syncControls();
    if (hidden && hadFocus) $('hud-toggle').focus({ preventScroll: true });
  }

  hidesControls() { return this.controlsHidden && !!this.graphics; }

  syncControls() {
    const hidden = this.hidesControls() && this.target === 'turntable', hud = $('listening-hud'), toggle = $('hud-toggle');
    document.querySelector('.room').dataset.controls = hidden ? 'hidden' : 'shown';
    toggle.inert = !this.graphics || this.target !== 'turntable';
    toggle.setAttribute('aria-expanded', String(!hidden)); toggle.setAttribute('aria-label', hidden ? 'Show controls' : 'Hide controls');
    if (hidden && hud.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    hud.inert = hidden;
    this.slideControls();
  }

  /** The panel slides away (entering the close-up, Hide) or back (Show, Back to studio) from
   * the click over one smooth glide, the same speed both ways, and in the close-up the frame
   * grows into the space it frees in step. Heading back to the studio the frame keeps its
   * size, so returning never resizes it mid-travel. */
  slideControls() {
    if (!this.framing) return;
    this.slide();
    const close = this.target === 'turntable', hidden = this.hidesControls() ? 1 : 0;
    const from = [this.away, this.share], to = close ? [hidden, hidden] : [0, this.share];
    if (this.glide && to.every((value, i) => value === this.glide.to[i])) return;
    const span = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
    this.glide = span && !this.reduced.matches ? { from, to, start: performance.now(), duration: SLIDE * span } : null;
    if (!span) return;
    if (!this.glide) { [this.away, this.share] = to; this.paint(); this.present(); return; }
    // Camera travel paints every frame itself; otherwise the glide drives its own frames.
    const step = () => {
      this.glideFrame = null;
      if (!this.motion) { this.paint(); this.present(); }
      if (this.glide) this.glideFrame = requestAnimationFrame(step);
    };
    if (!this.glideFrame) this.glideFrame = requestAnimationFrame(step);
  }

  /** Advance the glide to now and frame the close-up to match. */
  slide() {
    const glide = this.glide;
    if (glide) {
      const progress = this.reduced.matches ? 1 : Math.min(1, (performance.now() - glide.start) / glide.duration), x = smooth(0, 1, progress);
      [this.away, this.share] = progress === 1 ? glide.to : glide.from.map((from, i) => mix(from, glide.to[i], x));
      if (progress === 1) this.glide = null;
    }
    if (!this.graphics) this.away = this.share = 0;
    const close = this.closeFrame(), current = this.framing.close;
    if (['x', 'y', 'width', 'height'].some(key => close[key] !== current[key])) {
      this.framing.close = close; this.graphics?.guard(() => this.graphics.setFraming(this.framing));
    }
  }

  closeFrame() {
    const [shown, hidden] = this.closeFrames, t = this.share;
    return t <= 0 ? shown : t >= 1 ? hidden : { x: mix(shown.x, hidden.x, t), y: mix(shown.y, hidden.y, t), width: mix(shown.width, hidden.width, t), height: mix(shown.height, hidden.height, t) };
  }

  label() {
    this.syncControls();
    // The toggle names its destination; the name updates immediately on retarget.
    // In close-up the same header toggle becomes a prominent "Back to studio" pill.
    const toggle = $('studio-focus'), close = this.target === 'turntable';
    toggle.innerHTML = close ? '<span aria-hidden="true">←</span> Back to studio <kbd aria-hidden="true">Esc</kbd>' : 'Close-up';
    toggle.setAttribute('aria-label', close ? 'Return to the studio view' : 'Move closer to the turntable');
  }

  updateFocus() {
    const ring = $('studio-control-focus'), active = document.activeElement;
    const show = this.deck.contains(active) && active?.matches(':focus-visible') && this.view === 'turntable' && !this.motion;
    ring.hidden = !show;
    if (!show) return;
    const rect = active.getBoundingClientRect(), stage = this.stage.getBoundingClientRect();
    Object.assign(ring.style, { left: `${rect.left - stage.left - 3}px`, top: `${rect.top - stage.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  }

  useFallback(error) {
    console.warn('Studio graphics unavailable; using the original turntable controls.', error);
    this.beforeMove(); cancelAnimationFrame(this.frame); this.frame = null; this.motion = null;
    if (this.skylineTarget) this.setSkyline(false, true);
    this.graphics?.dispose(); this.graphics = null;
    this.stage.dataset.renderer = 'fallback'; delete this.stage.dataset.graphics;
    this.view = this.target = 'turntable'; this.inspection = 1; this.onTarget(this.target);
    $('studio-focus').hidden = $('skyline-toggle').hidden = true; $('studio-quality').closest('.quality-setting').hidden = true;
    this.measure(); this.paint(); this.settle();
  }

  /** Draw now, in the same frame as the DOM plate update. The app's frame loop runs before
   * these motion callbacks, so waiting for it would show the deck one frame behind the
   * photograph and make it jiggle against the table while the view moves. */
  present() { this.graphics?.guard(() => this.graphics.redraw()); }

  renderFrame(state, now, audible) {
    this.graphics?.guard(() => this.graphics.update(state, now, audible));
  }
}
