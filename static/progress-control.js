const clamp = value => Math.max(0, Math.min(1, value));

/** Pointer ownership for the HUD: a latest-only drag, or a brief track click. */
export class ProgressControl {
  constructor(input, controls, formatTime) {
    this.input = input; this.controls = controls;
    this.preview = input.parentElement.querySelector('.timeline-preview');
    this.previewTime = this.preview.querySelector('.timeline-preview-time');
    this.formatTime = formatTime;
    this.hover = null;
    this.gesture = null; this.frame = null;
    input.addEventListener('pointerenter', event => this.previewAt(event));
    input.addEventListener('pointerleave', () => this.hidePreview());
    input.addEventListener('pointerdown', event => this.begin(event));
    input.addEventListener('pointermove', event => this.move(event));
    input.addEventListener('pointerup', event => this.finish(event, true));
    for (const name of ['pointercancel', 'lostpointercapture']) input.addEventListener(name, event => this.finish(event, false));
    input.addEventListener('dragstart', event => event.preventDefault());
    // Keyboard, accessibility actions and programmatic native input stay click seeks.
    input.addEventListener('input', event => {
      if (!this.gesture) controls.seek(Number(event.target.value) / 100);
    });
    window.addEventListener('blur', () => { this.cancel(); this.hidePreview(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.cancel(); this.hidePreview(); } });
    new ResizeObserver(() => { if (this.hover) this.previewAt(this.hover); }).observe(input);
  }
  previewAt(event) {
    const state = this.controls.getState();
    const bounds = this.input.getBoundingClientRect();
    if (this.input.disabled || state.busy || !state.recordLoaded || !state.duration
      || event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      this.hidePreview(); return;
    }
    this.hover = { clientX: event.clientX, clientY: event.clientY };
    // Preview and click share the actual thumb travel, including its 5px inset.
    const track = { left: bounds.left + 5, width: Math.max(1, bounds.width - 10) };
    const fraction = this.fraction(event, track);
    const container = this.input.parentElement.getBoundingClientRect();
    const x = track.left - container.left + fraction * track.width;
    this.previewTime.textContent = this.formatTime(fraction * state.duration);
    const halfLabel = this.previewTime.offsetWidth / 2;
    const labelX = Math.max(halfLabel, Math.min(container.width - halfLabel, x));
    this.preview.style.setProperty('--preview-x', `${x}px`);
    this.preview.style.setProperty('--preview-label-x', `${labelX}px`);
    this.preview.dataset.visible = 'true';
    this.previewDuration = state.duration;
  }
  hidePreview() {
    this.hover = null;
    this.preview.dataset.visible = 'false';
  }
  fraction(event, gesture = this.gesture) {
    return clamp((event.clientX - gesture.left) / gesture.width);
  }
  begin(event) {
    if (event.button !== 0 || this.input.disabled || this.gesture) return;
    event.preventDefault();
    this.previewAt(event);
    this.input.focus({ preventScroll: true });
    const bounds = this.input.getBoundingClientRect();
    const state = this.controls.getState();
    const gesture = this.gesture = {
      id: event.pointerId, left: bounds.left + 5, width: Math.max(1, bounds.width - 10),
      startX: event.clientX, mode: 'pending', lastTime: event.timeStamp,
      lastFraction: 0, fraction: 0, time: event.timeStamp,
    };
    gesture.fraction = gesture.lastFraction = this.fraction(event);
    this.input.setPointerCapture(event.pointerId);
    const thumb = gesture.left + state.grooveProgress * gesture.width;
    if (Math.abs(event.clientX - thumb) <= 14) this.startDirect(gesture);
  }
  startDirect(gesture) {
    // Starting emits state several times while cancelling older automation.
    gesture.mode = 'starting';
    if (this.controls.beginDirectScrub(gesture.fraction)) gesture.mode = 'direct';
    else this.clear();
  }
  move(event) {
    this.previewAt(event);
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.id) return;
    event.preventDefault();
    gesture.fraction = this.fraction(event); gesture.time = event.timeStamp;
    if (gesture.mode === 'pending' && Math.abs(event.clientX - gesture.startX) > 3) this.startDirect(gesture);
    if (gesture.mode === 'direct' && this.frame === null) {
      this.frame = requestAnimationFrame(() => { this.frame = null; this.applyLatest(); });
    }
  }
  applyLatest() {
    const gesture = this.gesture;
    if (!gesture || gesture.mode !== 'direct') return;
    const dt = Math.max(.001, (gesture.time - gesture.lastTime) / 1000);
    const velocity = (gesture.fraction - gesture.lastFraction) * this.controls.getState().duration / dt;
    gesture.lastFraction = gesture.fraction; gesture.lastTime = gesture.time;
    this.controls.updateDirectScrub(gesture.fraction, velocity);
  }
  finish(event, click) {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.id) return;
    event.preventDefault();
    if (click) { gesture.fraction = this.fraction(event); gesture.time = event.timeStamp; }
    if (gesture.mode === 'direct') {
      if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
      this.applyLatest();
      this.clear();
      this.controls.endDirectScrub();
    } else {
      const fraction = gesture.fraction;
      this.clear();
      if (click) this.controls.seek(fraction);
    }
    if (!click || event.pointerType === 'touch') this.hidePreview();
  }
  clear() {
    const gesture = this.gesture;
    this.gesture = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (gesture && this.input.hasPointerCapture(gesture.id)) this.input.releasePointerCapture(gesture.id);
  }
  cancel() {
    if (!this.gesture) return;
    if (this.gesture.mode === 'direct') this.applyLatest();
    this.clear(); this.controls.endDirectScrub();
  }
  sync(state) {
    // Another explicit control (Return Arm, CUE, manual arm, etc.) took over.
    if (this.gesture?.mode === 'direct' && !state.directScrubbing) this.clear();
    if (state.busy || !state.recordLoaded) this.hidePreview();
    else if (this.hover && this.previewDuration !== state.duration) this.previewAt(this.hover);
  }
}
