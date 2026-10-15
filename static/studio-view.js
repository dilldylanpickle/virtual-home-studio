import { PIXEL_LEVELS, StudioRenderer } from './studio-renderer.js';
import { PLATE, placePlate } from './studio-plate.js';

const $ = id => document.getElementById(id);
const mix = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// 4×4 ordered-dither thresholds (0–15), matching the renderer's pixel-view palette.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Camera navigation and the canonical control surface, with no playback state. */
export class StudioView {
  constructor({ beforeMove = () => {}, onTarget = () => {} } = {}) {
    this.stage = $('studio'); this.world = $('studio-world'); this.viewport = $('studio-camera');
    this.deck = $('drop-zone'); this.beforeMove = beforeMove; this.onTarget = onTarget;
    this.target = 'studio'; this.view = 'studio'; this.inspection = 0; this.motion = null; this.frame = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    try {
      this.graphics = new StudioRenderer(this.stage, { onFailure: error => this.useFallback(error) }); this.stage.dataset.renderer = 'webgl';
    } catch (error) {
      this.useFallback(error);
    }
    this.measure(); this.paint(); this.settle(); this.stage.dataset.ready = 'true'; this.onTarget(this.target);
    $('studio-enter').addEventListener('click', () => this.goTo('turntable'));
    // Close-up docks the listening panel into a slim row; Hide/Show controls trades it for a
    // full view of the deck, persists for later close-ups this session, and the studio always shows it.
    this.controlsHidden = false;
    $('hud-hide').addEventListener('click', () => this.setControlsHidden(true));
    $('hud-show').addEventListener('click', () => this.setControlsHidden(false));
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
    // Docking depends on width only, never on the view, so the panel keeps its size during travel.
    const hudTop = roomTop + hud.offsetTop;
    room.style.setProperty('--hud-offset', `${hud.offsetTop}px`);
    const gutter = Math.min(24, width * .04), panel = Math.min(hudTop, height) - 12;
    // The close-up frame follows the preference, not the target, so returning never resizes it mid-travel.
    const hidden = this.hidesControls();
    const closeBottom = hidden ? height - 76 : Math.min(hudTop, height) - 12;

    const scene = y($('scene-frame')), header = y(document.querySelector('.masthead'));
    const rect = (top, bottom, side = gutter) => ({ x: side, y: top, width: Math.max(1, width - side * 2), height: Math.max(1, bottom - top) });
    // Phones inspect the deck nearly edge to edge so its controls stay finger-sized.
    const wide = rect(scene.top, Math.max(scene.top + 1, panel));
    // The photographic plate and the plate camera share this one placement.
    const plate = placePlate(width, height, wide);
    // Let the browser pick the derivative for the plate's real rendered width.
    $('studio-plate').sizes = `${Math.ceil(plate.width)}px`;
    // Pixel view redraws the pixelated plate when its displayed size changes.
    if (this.pixelView && Math.abs(plate.width - (this.pixelWidth ?? 0)) > 1) queueMicrotask(() => this.pixelView && this.pixelPlate(Math.max(2, Math.min(6, Math.round(innerWidth / 300)))));
    // Narrower close-ups keep status messages in a row above the panel, not over the deck.
    const closeTop = header.bottom + 14, noticeRow = this.target === 'turntable' && !hidden && width < 1180 && width >= 600 ? 44 : 0;
    this.framing = { width, height, wide, plate, settledPlate: plate, close: rect(closeTop, Math.max(closeTop + 1, closeBottom - noticeRow), width < 600 ? 2 : gutter) };
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
    const t = this.inspection, plateStyle = $('studio-plate').style, { plate } = this.framing;
    // Hero copy and a hidden panel follow the camera, not the target: they leave early on
    // the way in and return only as the studio view settles.
    const room = document.querySelector('.room').style;
    // Skyline view fades the hero and panel as the view tilts up.
    const sky = this.sky ?? 0;
    room.setProperty('--intro-away', Math.max(smooth(0, .3, t), smooth(0, .5, sky)).toFixed(3));
    room.setProperty('--hud-away', (this.hidesControls() ? smooth(.1, .55, t) : 0).toFixed(3));
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
    if (hidden && hadFocus) $('hud-show').focus({ preventScroll: true });
    if (!hidden && (document.activeElement === document.body || document.activeElement === $('hud-show'))) $('hud-hide').focus({ preventScroll: true });
  }

  hidesControls() { return this.controlsHidden && !!this.graphics; }

  syncControls() {
    const hidden = this.hidesControls() && this.target === 'turntable', hud = $('listening-hud');
    document.querySelector('.room').dataset.controls = hidden ? 'hidden' : 'shown';
    if (hidden && hud.contains(document.activeElement)) $('hud-show').focus({ preventScroll: true });
    hud.inert = hidden; $('hud-show').hidden = !hidden;
    // A hidden panel frees the bottom of the close-up; reframe whenever that changes.
    if (this.framing && this.appliedHidden !== this.hidesControls()) { this.appliedHidden = this.hidesControls(); this.measure(); this.paint(); }
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
    const pixels = Boolean(state.chip?.enabled && state.chip?.pixels);
    if (pixels !== Boolean(this.pixelView)) this.setPixelView(pixels);
    this.graphics?.guard(() => this.graphics.update(state, now, audible));
  }

  /** Pixel view (8-bit mode): the native deck renders as pixel art and the plate is swapped
   * for a downscaled copy at the same pixel size with the same dithered palette. Presentation
   * only; turning it off restores the plate's responsive sources. */
  setPixelView(on) {
    this.pixelView = on; this.stage.toggleAttribute('data-pixels', on);
    const plate = $('studio-plate'), size = Math.max(2, Math.min(6, Math.round(innerWidth / 300)));
    this.stage.style.setProperty('--pixel', `${size}px`);
    if (on) { this.plateSource ??= { src: plate.getAttribute('src'), srcset: plate.getAttribute('srcset'), current: plate.currentSrc || plate.src }; this.pixelPlate(size); }
    else if (this.plateSource) {
      plate.setAttribute('srcset', this.plateSource.srcset); plate.setAttribute('src', this.plateSource.src);
      plate.style.imageRendering = ''; this.plateSource = null; this.pixelWidth = 0;
    }
    this.graphics?.guard(() => this.graphics.setPixelArt(on ? size : 0));
  }
  pixelPlate(size) {
    const { plate } = this.framing ?? {}, source = this.plateSource; if (!plate || !source) return;
    const width = Math.max(1, Math.round(plate.width / size)), height = Math.max(1, Math.round(plate.height / size)), token = this.pixelToken = {};
    const image = new Image();
    image.onload = () => {
      if (this.pixelToken !== token || !this.pixelView) return;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); context.imageSmoothingQuality = 'high'; context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height), data = pixels.data, levels = PIXEL_LEVELS;
      // The renderer's palette and its gentle 4×4 ordered dither.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const threshold = .25 + .5 * BAYER[(y & 3) * 4 + (x & 3)] / 16, i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) data[i + c] = Math.min(levels, Math.floor(data[i + c] / 255 * levels + threshold)) / levels * 255;
      }
      context.putImageData(pixels, 0, 0);
      const element = $('studio-plate'); element.removeAttribute('srcset'); element.src = canvas.toDataURL('image/png');
      element.style.imageRendering = 'pixelated'; this.pixelWidth = plate.width;
    };
    image.src = source.current;
  }
}
