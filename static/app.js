import { CONDITIONS, DEFAULT_CONDITION } from './condition-profiles.js';
import { AssistedPlayback } from './assisted-playback.js';
import { TonearmMotion } from './tonearm-motion.js';
import { NOMINAL_RPM, deriveSpeed, derivePhysical } from './simulation-state.js';
import { ListeningHUD } from './listening-hud.js';
import { CartridgeOutput } from './audio-chain.js';
import { RecordLifecycle } from './record-lifecycle.js';
import { setupCustomization, renderMaterial, VINYL, LABELS } from './record-customization.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const POWER_KNOB = Object.freeze({ cx: 149, cy: 837, minAngle: -90, maxAngle: 0, offThreshold: -48, onThreshold: -42 });
// Established hardware geometry in deck-local coordinates.
// The parked needle contact is (856,926); the swing axis is (951,415).
const geometry = Object.freeze({ cx: 498, cy: 598, px: 951, py: 415,
  length: Math.hypot(95, 511), outer: 327, inner: 140,
  rest: Math.atan2(95, 511) * 180 / Math.PI });
const radians = (angle) => angle * Math.PI / 180;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function stylusAt(angle) {
  return { x: geometry.px - geometry.length * Math.sin(radians(angle)), y: geometry.py + geometry.length * Math.cos(radians(angle)) };
}
function radiusAt(angle) {
  const p = stylusAt(angle);
  return Math.hypot(p.x - geometry.cx, p.y - geometry.cy);
}
function angleAtRadius(radius) {
  let low = geometry.rest, high = Math.atan2(geometry.px - geometry.cx, geometry.cy - geometry.py) * 180 / Math.PI;
  for (let i = 0; i < 35; i++) {
    const middle = (low + high) / 2;
    if (radiusAt(middle) > radius) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
const OUTER_ANGLE = angleAtRadius(geometry.outer);
const INNER_ANGLE = angleAtRadius(geometry.inner);
const angleAtProgress = (fraction) => angleAtRadius(geometry.outer - clamp(fraction, 0, 1) * (geometry.outer - geometry.inner));
const progressAtAngle = (angle) => clamp((geometry.outer - radiusAt(angle)) / (geometry.outer - geometry.inner), 0, 1);
const inGroove = (angle) => angle >= OUTER_ANGLE - 0.00001 && angle <= INNER_ANGLE + 0.00001;
function timeLabel(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = String(Math.floor(whole / 60) % 60).padStart(2, '0');
  const secs = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${secs}` : `${minutes}:${secs}`;
}

/** One processor owns the playback cursor, including reverse and stationary vinyl. */
class Turntable extends EventTarget {
  constructor() {
    super();
    this.state = {
      power: true, powerAngle: 0, powerDragging: false, powerSettling: false,
      platterRunning: false, speed33Pressed: false, speed45Pressed: false, transportPaused: false, assistPhase: 'idle',
      pitchRange: 8, pitch: 0, quartzLock: true,
      recordLoaded: false, recordPresent: false, recordPhase: 'empty', grooveRegion: 'music', runInRemaining: 0, filename: '', pendingFilename: '', duration: 0, position: 0,
      tonearmAngle: geometry.rest, stylusRaised: true, tonearmMotion: null,
      actualRate: 0, motorActualRate: 0, motorRamping: false, rotation: 0, recordRotation: 0,
      targetLight: false, coverClosed: false,
      vinylColor: 'Black', labelColor: 'Blue', condition: DEFAULT_CONDITION, surface: true, contacts: true, wow: 0, centering: 0, cartridge: true,
      volume: 0.69, loading: false, dragging: false, scratching: false, seeking: false, seekTarget: null,
      directScrubbing: false, scrubVelocity: 0, preScrubTransportState: null,
    };
    // Compatibility names remain read-only selectors, never cached speed state.
    for (const key of ['rpm', 'effectiveRate', 'effectivePitch', 'targetRPM', 'motorTargetRPM']) {
      Object.defineProperty(this.state, key, { enumerable: true, get: () => deriveSpeed(this.state)[key] });
    }
    this.context = null;
    this.engine = null;
    this.enginePromise = null;
    this.report = null;
    this.revision = 0;
    this.armScrubSample = null;
    this.lifecycle = new RecordLifecycle(this, { park: () => this.parkForRecord(), motion: animateRecord, grooves: drawGrooves, notice: showNotice, rest: geometry.rest });
    this.powerAnimation = null;
    this.armMotion = new TonearmMotion(this, { progressAtAngle });
    this.assist = new AssistedPlayback(this, { inGroove, progressAtAngle, outerAngle: OUTER_ANGLE });
    this.metrics = { sourcesCreated: 0, activeSources: 0, maxActiveSources: 0 };
  }
  audioContext() {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.chain = new CartridgeOutput(this.context, this.state.volume);
      this.chain.color(this.state.cartridge);
      this.output = this.chain.output;
      this.context.addEventListener('statechange', () => this.emit());
    }
    return this.context;
  }
  async initializeEngine() {
    if (this.engine) return;
    if (this.enginePromise) return this.enginePromise;
    const ctx = this.audioContext();
    this.enginePromise = (async () => {
      await ctx.audioWorklet.addModule('/static/vinyl-processor.js');
      this.engine = new AudioWorkletNode(ctx, 'vinyl-processor', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      this.engine.connect(this.chain.input);
      this.sendSettings();
      this.metrics.sourcesCreated++;
      this.engine.port.onmessage = ({ data }) => {
        if (data.revision !== this.revision) return;
        this.report = data;
        this.syncPosition();
        this.metrics.activeSources = this.audible ? 1 : 0;
        this.metrics.maxActiveSources = Math.max(this.metrics.maxActiveSources, this.metrics.activeSources);
      };
      this.engine.onprocessorerror = () => showNotice('The audio processor stopped. Reload the page to restart it.', true);
      this.sendControl({ travel: this.state.recordRotation / 200, motorTravel: this.state.rotation / 200 });
    })();
    try { await this.enginePromise; }
    catch (error) { this.enginePromise = null; throw error; }
  }
  async unlockAudio() {
    try {
      const ctx = this.audioContext();
      // Resume directly in the gesture, before awaiting module loading.
      const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
      await Promise.all([resumed, this.initializeEngine()]);
      this.emit();
    } catch (error) { showNotice(`Could not start audio: ${error.message}`, true); }
  }
  get derived() { return derivePhysical(this.state, inGroove(this.state.tonearmAngle)); }
  get snapshot() { this.syncPosition(); return { ...this.state, ...this.derived }; }
  get needleOnRecord() {
    const s = this.state;
    return s.power && this.stylusContact;
  }
  get stylusContact() {
    return this.derived.stylusContact;
  }
  get audible() {
    const s = this.state;
    return this.needleOnRecord && this.context?.state === 'running'
      && (s.directScrubbing || s.seeking || s.scratching || s.motorActualRate > .0001) && Math.abs(s.actualRate) > .0001
      && (s.actualRate > 0 ? s.position < s.duration : s.position > 0);
  }
  syncPosition() {
    const r = this.report, s = this.state;
    if (!r || r.revision !== this.revision) return;
    const elapsed = Math.max(0, this.context.currentTime - r.time);
    const manual = s.directScrubbing || !!s.tonearmMotion;
    const predict = !manual && !s.seeking && !r.seeking && !s.transportPaused && !s.scratching && !r.ramping && !s.wow && !s.centering ? elapsed * (r.manualScrub ? r.motorActualRate : r.rate) : 0;
    const wasSeeking = s.seeking, wasContact = this.stylusContact, previousPosition = s.position;
    if (!manual) {
      s.seeking = r.seeking;
      if (!s.seeking) s.seekTarget = null;
      s.position = clamp(r.position + (this.needleOnRecord ? predict : 0), 0, s.duration);
      s.grooveRegion = r.grooveRegion; s.runInRemaining = r.runInRemaining;
    }
    s.actualRate = r.rate;
    s.motorActualRate = r.motorActualRate;
    s.motorRamping = r.motorRamping;
    const motorPredict = r.motorRamping ? 0 : elapsed * r.motorActualRate;
    s.rotation = ((r.motorTravel + motorPredict) * 200) % 360;
    if (!s.scratching) s.recordRotation = (r.travel + (s.directScrubbing || s.seeking ? motorPredict : predict)) * 200;
    if (!manual && !s.dragging && s.duration) {
      if (s.seeking || wasSeeking) s.tonearmAngle = angleAtRadius(geometry.outer - r.position / s.duration * (geometry.outer - geometry.inner));
      else if (((!s.transportPaused || s.scratching) && this.needleOnRecord)
        || (s.position !== previousPosition && inGroove(s.tonearmAngle))) {
        s.tonearmAngle = angleAtProgress(s.position / s.duration);
      }
    }
    if (!manual && (s.seeking || wasSeeking) && wasContact !== this.stylusContact) this.sendControl();
  }
  sendControl(extra = {}) {
    if (!this.engine) return;
    const s = this.state;
    this.engine.port.postMessage({
      type: 'control', revision: ++this.revision,
      enabled: this.needleOnRecord, contact: this.stylusContact, powered: s.power, immediate: !s.power || s.rpm === null,
      motorRate: this.derived.motorTargetRPM / NOMINAL_RPM, pause: s.transportPaused,
      holding: s.scratching, directScrub: s.directScrubbing, rpm: s.rpm, ...extra,
    });
  }
  change(update, seek = false, extra = {}) {
    this.syncPosition();
    update(this.state);
    const s = this.state;
    if (s.rpm === null || !s.power) { s.platterRunning = false; s.transportPaused = false; }
    this.sendControl({ ...(seek ? { position: s.position, runIn: s.position === 0 && inGroove(s.tonearmAngle) } : {}), ...extra });
    this.emit();
  }
  emit() { this.dispatchEvent(new Event('change')); }
  setPowerAngle(angle) {
    angle = clamp(angle, POWER_KNOB.minAngle, POWER_KNOB.maxAngle);
    const power = this.state.power ? angle > POWER_KNOB.offThreshold : angle >= POWER_KNOB.onThreshold;
    if (power !== this.state.power) {
      if (this.state.tonearmMotion?.kind !== 'parking') this.armMotion.cancel();
      this.endDirectScrub();
      this.cancelSeek();
      this.change((s) => { s.powerAngle = angle; s.power = power; if (!power) s.platterRunning = false; });
    } else { this.state.powerAngle = angle; this.emit(); }
  }
  cancelPowerAnimation() {
    if (this.powerAnimation !== null) cancelAnimationFrame(this.powerAnimation);
    this.powerAnimation = null;
    this.state.powerSettling = false;
  }
  turnPowerTo(angle, animate = true) {
    this.cancelPowerAnimation();
    angle = clamp(angle, POWER_KNOB.minAngle, POWER_KNOB.maxAngle);
    const start = this.state.powerAngle;
    if (!animate || Math.abs(start - angle) < .01) { this.setPowerAngle(angle); return; }
    const began = performance.now();
    this.state.powerSettling = true;
    const settle = (now) => {
      const progress = Math.min(1, (now - began) / 140);
      this.setPowerAngle(start + (angle - start) * (1 - (1 - progress) ** 3));
      if (progress < 1) this.powerAnimation = requestAnimationFrame(settle);
      else { this.powerAnimation = null; this.state.powerSettling = false; this.emit(); }
    };
    this.powerAnimation = requestAnimationFrame(settle);
  }
  togglePlatter() {
    this.endDirectScrub();
    this.assist.cancel();
    this.cancelSeek();
    if (this.lifecycle.busy) return;
    if (!this.state.power) { showNotice('Turn the POWER knob on first.'); return; }
    if (this.state.rpm === null) { showNotice('Select a speed: latch 33 or 45, or both for 78 RPM, then press START.'); return; }
    void this.unlockAudio();
    this.change((s) => { s.transportPaused = false; s.platterRunning = !s.platterRunning; });
  }
  pause() {
    this.endDirectScrub();
    this.assist.cancel();
    this.cancelSeek();
    if (this.lifecycle.busy || !this.state.recordLoaded || this.state.transportPaused) return;
    cancelGestures();
    this.syncPosition();
    this.state.transportPaused = true;
    // Commit the currently displayed logical groove, while the processor renders a tail.
    const position = this.state.grooveRegion === 'run-in' ? -this.state.runInRemaining : this.state.position;
    this.sendControl({ pausePosition: position });
    this.emit();
  }
  play() { this.endDirectScrub(); this.cancelSeek(); showNotice(''); return this.assist.play(); }
  seekProgress(fraction) {
    this.endDirectScrub();
    if (!Number.isFinite(fraction) || !this.state.recordLoaded || this.lifecycle.busy) return;
    const retargeting = this.state.seeking;
    this.assist.cancel();
    this.cancelSeek();
    cancelGestures();
    this.syncPosition();
    const s = this.state;
    const target = clamp(fraction, 0, 1) * s.duration;
    const from = inGroove(s.tonearmAngle) ? s.position
      : s.duration * (geometry.outer - radiusAt(s.tonearmAngle)) / (geometry.outer - geometry.inner);
    if (Math.abs(target - from) < .00001) return;
    void this.unlockAudio();
    s.seeking = true; s.seekTarget = target;
    this.sendControl({ seekTarget: target, ...(!retargeting && !inGroove(s.tonearmAngle) ? { seekFrom: from } : {}),
      seekDuration: .12 + .33 * Math.sqrt(Math.min(1, Math.abs(target - from) / s.duration)) });
    this.emit();
  }
  cancelSeek() {
    if (!this.state.seeking) return;
    this.syncPosition();
    this.state.seeking = false; this.state.seekTarget = null;
    this.sendControl({ cancelSeek: true });
    this.emit();
  }
  setGroovePosition(fraction, angle = angleAtProgress(fraction)) {
    const s = this.state;
    s.position = clamp(fraction, 0, 1) * s.duration;
    s.tonearmAngle = angle;
    s.grooveRegion = fraction >= 1 ? 'run-out' : 'music'; s.runInRemaining = 0;
  }
  beginDirectScrub(fraction) {
    if (!Number.isFinite(fraction) || !this.state.recordLoaded || this.lifecycle.busy) return false;
    this.assist.cancel(); this.armMotion.cancel(); this.cancelSeek(); cancelGestures();
    this.syncPosition();
    void this.unlockAudio();
    const s = this.state;
    s.preScrubTransportState = this.derived.transportState;
    s.directScrubbing = true; s.scrubVelocity = 0;
    this.setGroovePosition(clamp(fraction, 0, 1));
    this.sendControl({ directScrub: true, scrubPosition: s.position, scrubVelocity: 0 });
    this.emit();
    return true;
  }
  updateDirectScrub(fraction, velocity = 0) {
    if (!this.state.directScrubbing || !Number.isFinite(fraction)) return;
    const s = this.state;
    this.setGroovePosition(clamp(fraction, 0, 1));
    // This is pointer travel in source seconds, not an audible playback rate.
    // The worklet owns the shared perceptual mapping for every scrub input.
    s.scrubVelocity = Number.isFinite(velocity) ? velocity : 0;
    this.sendControl({ directScrub: true, scrubPosition: s.position, scrubVelocity: s.scrubVelocity });
    this.emit();
  }
  endDirectScrub() {
    const s = this.state;
    if (!s.directScrubbing) return;
    s.directScrubbing = false; s.scrubVelocity = 0; s.preScrubTransportState = null;
    // No transport flags changed on entry: playing resumes and pause stays held.
    this.sendControl({ directScrub: false, scrubPosition: s.position });
    this.emit();
  }
  toggleSpeed(button) {
    this.assist.cancel();
    const key = button === 33 ? 'speed33Pressed' : 'speed45Pressed';
    this.change((s) => { s[key] = !s[key]; });
    const s = this.state;
    if (s.rpm === null) showNotice('No speed selected. The motor is stopped; select a speed and press START.');
    else showNotice(`${s.rpm === NOMINAL_RPM ? '33⅓' : s.rpm} RPM selected.${s.power && !s.platterRunning ? ' Press START to turn the platter.' : ''}`);
  }
  setPitch(pitch) { this.change((s) => { s.pitch = clamp(pitch, -s.pitchRange, s.pitchRange); }); }
  toggleRange() { this.change((s) => { const fraction = s.pitch / s.pitchRange; s.pitchRange = s.pitchRange === 8 ? 16 : 8; s.pitch = fraction * s.pitchRange; }); }
  toggleQuartz() { this.change((s) => { s.quartzLock = !s.quartzLock; }); }
  toggleCue() {
    this.endDirectScrub();
    this.assist.cancel();
    this.cancelSeek();
    if (this.lifecycle.busy) return;
    void this.unlockAudio();
    this.change((s) => { s.stylusRaised = !s.stylusRaised; });
    const s = this.state;
    if (s.stylusRaised) showNotice('Stylus raised. Position the arm silently; lower CUE when you’re ready.');
    else if (!inGroove(s.tonearmAngle)) showNotice('The stylus is outside the grooves. Move the headshell inward to reach the record.');
    else if (!s.recordLoaded) showNotice('The platter is empty. Choose a record to begin.');
    else if (!s.power || !s.platterRunning) showNotice('Stylus set. Press START to listen, or turn the vinyl by hand with power on.');
    else showNotice('Stylus down. Grab the vinyl and move it back and forth to scratch.');
  }
  moveArm(angle) {
    this.endDirectScrub();
    this.assist.cancel();
    this.cancelSeek();
    if (this.lifecycle.busy) return;
    this.syncPosition();
    const s = this.state, now = performance.now();
    const previous = s.dragging && this.armScrubSample
      ? this.armScrubSample : { position: s.position, time: now - 1000 / 60 };
    // Cue belongs to the user: pointer and keyboard seeks preserve its setting.
    s.tonearmAngle = clamp(angle, geometry.rest, INNER_ANGLE);
    const progress = progressAtAngle(s.tonearmAngle);
    this.setGroovePosition(progress < .005 ? 0 : progress, s.tonearmAngle);
    const velocity = (s.position - previous.position) / Math.max(.001, (now - previous.time) / 1000);
    this.armScrubSample = { position: s.position, time: now };
    this.sendControl({ position: s.position, runIn: s.position === 0 && inGroove(s.tonearmAngle),
      grooveScrub: inGroove(s.tonearmAngle), scrubVelocity: velocity });
    this.emit();
  }
  beginScratch() {
    this.endDirectScrub();
    this.assist.cancel();
    this.cancelSeek();
    if (!this.state.recordLoaded || this.state.dragging || this.lifecycle.busy) return;
    void this.unlockAudio();
    this.change((s) => { s.scratching = true; s.actualRate = 0; });
    showNotice('Record held. Turn clockwise or counterclockwise to scratch; release to let the motor take over.');
  }
  scratchBy(degrees) {
    if (!this.state.scratching || !Number.isFinite(degrees)) return;
    this.state.recordRotation += degrees;
    this.engine?.port.postMessage({ type: 'scratch', delta: degrees / 200 });
  }
  endScratch() {
    if (!this.state.scratching) return;
    this.change((s) => { s.scratching = false; });
    showNotice(this.state.platterRunning ? 'Vinyl released. Returning to the selected speed.' : 'Vinyl released. The motor is stopped.');
  }
  async returnArm() {
    if (this.lifecycle.busy) return;
    this.assist.cancel();
    this.endDirectScrub();
    this.cancelSeek();
    cancelGestures();
    this.syncPosition();
    const distance = Math.abs(this.state.tonearmAngle - geometry.rest) / (INNER_ANGLE - geometry.rest);
    showNotice('Lifting the stylus and returning the arm…');
    const completed = await this.armMotion.moveTo(geometry.rest, {
      kind: 'returning', duration: 400 + 250 * Math.min(1, distance), settleDelay: 50,
    });
    if (completed) showNotice('Arm returned to its rest. The platter is controlled independently.');
  }
  async parkForRecord() {
    this.assist.cancel();
    this.endDirectScrub();
    this.cancelSeek();
    if (this.parking) return this.parking;
    this.parking = this.parkMechanism();
    try { await this.parking; } finally { this.parking = null; }
  }
  async parkMechanism() {
    releasePointers();
    this.change(s => { s.scratching = false; s.dragging = false; s.platterRunning = false; s.transportPaused = false; });
    await this.armMotion.moveTo(geometry.rest, { kind: 'parking', duration: 180 });
    // A suspended audio clock cannot coast; settle before allowing a record to lift.
    if (this.context?.state !== 'running') {
      this.sendControl({ immediate: true });
      this.state.motorActualRate = 0; this.state.actualRate = 0;
    } else await new Promise(resolve => {
      const check = () => {
        if (this.context.state !== 'running') {
          this.sendControl({ immediate: true });
          this.state.motorActualRate = 0; this.state.actualRate = 0;
          resolve(); return;
        }
        this.syncPosition();
        if (this.state.motorActualRate < .0001) resolve(); else requestAnimationFrame(check);
      };
      check();
    });
  }
  eject() { this.endDirectScrub(); this.assist.cancel(); this.cancelSeek(); return this.lifecycle.eject(); }
  load(file) { if (!file) return; this.endDirectScrub(); this.assist.cancel(); return this.lifecycle.load(file); }
  sendSettings() {
    const { surface, contacts, condition, wow, centering } = this.state;
    this.engine?.port.postMessage({ type: 'settings', settings: { surface, contacts, condition, wow, centering } });
  }
  customize(key, value) {
    if (key === 'vinylColor') { if (!Object.hasOwn(VINYL, value)) return; }
    else if (key === 'labelColor') { if (!Object.hasOwn(LABELS, value)) return; }
    else if (key === 'condition') { if (!Object.hasOwn(CONDITIONS, value)) return; }
    else if (['surface', 'contacts', 'cartridge'].includes(key)) { if (typeof value !== 'boolean') return; }
    else if (['wow', 'centering'].includes(key)) { if (!Number.isFinite(value)) return; value = clamp(value, 0, 1); }
    else return;
    this.state[key] = value;
    this.sendSettings();
    if (key === 'cartridge') this.chain?.color(value);
    this.emit();
  }
  setVolume(value) {
    if (!Number.isFinite(value)) return;
    value = clamp(value, 0, 1);
    this.state.volume = value;
    if (this.output) this.output.gain.setTargetAtTime(value, this.context.currentTime, 0.015);
    this.emit();
  }
}

const turntable = new Turntable();
const controls = Object.freeze({
  getState: () => turntable.snapshot,
  subscribe: listener => {
    const changed = () => listener(turntable.snapshot);
    turntable.addEventListener('change', changed);
    changed();
    return () => turntable.removeEventListener('change', changed);
  },
  getVolume: () => turntable.state.volume,
  setVolume: value => turntable.setVolume(value),
  play: () => turntable.play(), pause: () => turntable.pause(),
  seek: fraction => turntable.seekProgress(fraction),
  beginDirectScrub: fraction => turntable.beginDirectScrub(fraction),
  updateDirectScrub: (fraction, velocity) => turntable.updateDirectScrub(fraction, velocity),
  endDirectScrub: () => turntable.endDirectScrub(),
  customize: (key, value) => turntable.customize(key, value),
  returnArm: () => turntable.returnArm(),
  eject: () => turntable.eject(), load: file => turntable.load(file),
});
const hud = new ListeningHUD(controls, timeLabel);
// A small read-only inspection surface for acceptance tests and browser debugging.
window.turntable = Object.freeze({
  get state() { return turntable.snapshot; },
  controls,
  get metrics() { return { ...turntable.metrics, activeSources: turntable.audible ? 1 : 0 }; },
  get audioState() { return turntable.context?.state ?? 'uninitialized'; },
  get outputLevel() {
    return turntable.output?.gain.value ?? 0;
  },
  get audioDiagnostics() { return { contactCount: turntable.report?.contactCount ?? 0, popCount: turntable.report?.popCount ?? 0, crackleCount: turntable.report?.crackleCount ?? 0 }; },
  powerKnob: POWER_KNOB,
  geometry: Object.freeze({ ...geometry, outerAngle: OUTER_ANGLE, innerAngle: INNER_ANGLE }),
});

function circle(attrs) {
  const node = document.createElementNS(SVG_NS, 'circle');
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function drawDetails() {
  const dots = document.createDocumentFragment();
  [369, 361, 353, 345].forEach((radius, row) => {
    const count = [228, 220, 212, 204][row];
    for (let i = 0; i < count; i++) {
      const angle = (i + row * .31) / count * Math.PI * 2;
      dots.append(circle({ cx: geometry.cx + Math.cos(angle) * radius,
        cy: geometry.cy + Math.sin(angle) * radius,
        r: [1.7, 2.5, 1.7, 2.45][row], fill: row % 2 ? '#e8eae6' : '#cbd0ce' }));
    }
  });
  $('strobe-dots').append(dots);
  for (let i = 0; i <= 22; i++) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M${i % 2 === 0 ? 981 : 987} ${700 + i * (224 / 22)}H995`);
    $('pitch-ticks').append(path);
  }
  $('arm-reference').setAttribute('transform', `rotate(${-geometry.rest}) translate(${-geometry.px} ${-geometry.py})`);
}

function drawGrooves(buffer) {
  const fragment = document.createDocumentFragment();
  const data = buffer.getChannelData(0);
  for (let i = 0; i < 190; i++) {
    let energy = 0;
    const index = Math.floor(i / 190 * data.length);
    for (let j = 0; j < 32; j++) energy += Math.abs(data[Math.min(index + j * 13, data.length - 1)]);
    fragment.append(circle({ cx: geometry.cx, cy: geometry.cy, r: geometry.inner + (190 - i) / 190 * (geometry.outer - geometry.inner), 'stroke-width': 0.5 + energy / 32 * 0.4, opacity: 0.2 + energy / 32 * 0.24 }));
  }
  fragment.append(circle({ cx: geometry.cx, cy: geometry.cy, r: 127, stroke: '#69716c', 'stroke-width': .6, opacity: .24 }));
  $('grooves').replaceChildren(fragment);
}
function showNotice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function attr(node, name, value) { if (node.getAttribute(name) !== String(value)) node.setAttribute(name, value); }

function render() {
  const s = turntable.state;
  const audible = turntable.audible;
  $('deck').classList.toggle('power-off', !s.power);
  $('power').classList.toggle('dragging', s.powerDragging);
  attr($('power-rotor'), 'transform', `rotate(${s.powerAngle.toFixed(3)} ${POWER_KNOB.cx} ${POWER_KNOB.cy})`);
  attr($('power'), 'aria-valuenow', (s.powerAngle - POWER_KNOB.minAngle).toFixed(1));
  attr($('power'), 'aria-valuetext', `${s.power ? 'ON' : 'OFF'}, ${Math.round(s.powerAngle - POWER_KNOB.minAngle)} degrees of 90`);
  $('deck').classList.toggle('stylus-down', !s.stylusRaised);
  $('record').classList.toggle('is-hidden', !s.recordPresent);
  attr($('deck'), 'data-record-phase', s.recordPhase);
  renderMaterial(s);
  for (const id of ['tonearm', 'cue', 'start-stop', 'vinyl-hit-area']) attr($(id), 'aria-disabled', turntable.lifecycle.busy);
  $('mini-record').classList.toggle('loaded', s.recordLoaded);
  $('light-beam').classList.toggle('lit', s.targetLight && s.power);
  $('dust-cover').classList.toggle('is-hidden', !s.coverClosed);
  $('tonearm').classList.toggle('dragging', s.dragging);
  $('record').classList.toggle('scratching', s.scratching);
  $('vinyl-hit-area').classList.toggle('is-hidden', !s.recordLoaded || turntable.lifecycle.busy);
  $('vinyl-hit-area').classList.toggle('scratching', s.scratching);
  attr($('vinyl-hit-area'), 'aria-valuenow', Math.round(s.position));
  attr($('vinyl-hit-area'), 'aria-valuemax', Math.max(1, Math.ceil(s.duration)));
  attr($('vinyl-hit-area'), 'aria-valuetext', `${timeLabel(s.position)} · ${s.scratching ? 'record held' : 'drag to scratch'}`);
  attr($('tonearm'), 'transform', `translate(${geometry.px} ${geometry.py}) rotate(${s.tonearmAngle.toFixed(5)})`);
  attr($('tonearm'), 'aria-valuenow', Math.round(progressAtAngle(s.tonearmAngle) * 100));
  attr($('tonearm'), 'aria-valuetext', s.tonearmAngle === geometry.rest ? 'On arm rest' : `${Math.round(progressAtAngle(s.tonearmAngle) * 100)} percent, ${timeLabel(s.position)}, stylus ${s.stylusRaised ? 'raised' : 'lowered'}`);
  for (const [id, pressed] of [['start-stop', s.platterRunning], ['quartz', s.quartzLock], ['cue', !s.stylusRaised], ['pitch-range', s.pitchRange === 16], ['target-light', s.targetLight], ['cover-toggle', s.coverClosed], ['rpm-33', s.speed33Pressed], ['rpm-45', s.speed45Pressed]]) attr($(id), 'aria-pressed', pressed);
  attr($('start-stop'), 'aria-label', s.platterRunning ? 'Stop platter' : 'Start platter');
  attr($('cue'), 'aria-label', s.stylusRaised ? 'Lower cue lever' : 'Raise cue lever');
  attr($('pitch-range'), 'aria-label', `Pitch range plus or minus ${s.pitchRange} percent`);
  attr($('pitch'), 'min', -s.pitchRange); attr($('pitch'), 'max', s.pitchRange);
  if (Number($('pitch').value) !== s.pitch) $('pitch').value = s.pitch;
  attr($('pitch'), 'aria-valuetext', `${s.pitch.toFixed(1)} percent${s.quartzLock ? ', quartz locked' : ''}`);
  text('range-label', `Pitch range ±${s.pitchRange}%`);
  attr($('range-8-led'), 'fill', s.power && s.pitchRange === 8 ? '#f44c60' : '#747c77');
  attr($('range-16-led'), 'fill', s.power && s.pitchRange === 16 ? '#f44c60' : '#747c77');
  attr($('pitch-zero'), 'fill', s.power && (s.quartzLock || s.pitch === 0) ? '#f55364' : '#8b928c');
  text('cover-toggle', `Cover ${s.coverClosed ? 'closed' : 'open'}`);
  text('record-caption', s.recordPhase === 'inserting' ? 'SEATING YOUR RECORD' : s.recordPhase === 'ejecting' ? 'LIFTING YOUR RECORD' : s.loading ? 'CUTTING YOUR RECORD' : '');
  text('track-name', s.filename ? s.filename.replace(/\.(mp3|wav)$/i, '').replace(/_/g, ' ') : s.pendingFilename ? 'Seating your record' : 'Choose a record');
  $('track-name').title = s.filename;
  text('track-meta', s.filename ? `${s.filename.split('.').pop().toUpperCase()} · ${timeLabel(s.duration)}` : 'MP3 or WAV');
  const label = (s.pendingFilename || s.filename).replace(/\.(mp3|wav)$/i, '').replace(/_/g, ' ');
  text('label-title', label.length > 20 ? `${label.slice(0, 19)}…` : label);
  text('elapsed', timeLabel(s.position)); text('duration', timeLabel(s.duration));
  const targetRPM = s.quartzLock || s.pitch === 0 ? (s.rpm === NOMINAL_RPM ? '33⅓' : s.rpm) : (NOMINAL_RPM * s.effectiveRate).toFixed(2);
  text('speed-readout', s.rpm === null ? 'NO SPEED SELECTED' : s.motorRamping ? `${(s.motorActualRate * NOMINAL_RPM).toFixed(1)} → ${s.platterRunning && !s.transportPaused ? targetRPM : 0} RPM` : `${targetRPM} RPM`);
  text('pitch-readout', `${s.quartzLock ? 'QUARTZ LOCKED' : 'QUARTZ OFF'} · ${s.effectivePitch >= 0 ? '+' : ''}${s.effectivePitch.toFixed(1)}% · ${s.effectiveRate.toFixed(3)}×`);
  let status = s.recordPhase === 'ejecting' ? 'Lifting record…' : s.recordPhase === 'inserting' ? 'Seating record…' : !s.power ? 'Power off' : s.loading ? 'Decoding record…' : !s.recordLoaded ? (s.rpm === null ? 'No speed selected' : s.platterRunning ? 'Platter spinning · no record' : 'Ready when you are') : s.scratching ? (s.stylusRaised ? 'Record held · stylus raised' : Math.abs(s.actualRate) < .01 ? 'Record held · silent' : s.actualRate < 0 ? 'Scratching · reverse' : 'Scratching · forward') : s.directScrubbing ? '' : s.seeking ? 'Traversing grooves' : s.transportPaused ? (s.motorRamping ? 'Soft pause…' : 'Paused · groove held') : s.rpm === null ? 'No speed selected' : !s.platterRunning && s.motorRamping ? 'Platter coasting…' : !s.platterRunning ? 'Platter stopped' : s.dragging ? 'Positioning tonearm' : s.stylusRaised ? 'Stylus raised' : !inGroove(s.tonearmAngle) ? 'Arm outside grooves' : s.grooveRegion === 'run-in' ? 'Run-in groove' : s.position >= s.duration ? 'Run-out groove' : audible ? 'Playing · side A' : 'Audio suspended · press C';
  text('status', status);
  $('status-dot').classList.toggle('playing', audible);
  $('eject').disabled = s.recordPhase === 'ejecting' || (!s.recordPresent && !s.loading);
  $('load').disabled = ['inserting', 'ejecting'].includes(s.recordPhase);
  $('load').querySelector('span').textContent = s.loading ? 'Choose another file' : s.recordLoaded ? 'Replace' : 'Choose record';
  attr($('load'), 'aria-label', s.recordPresent ? 'Replace record' : 'Choose a record');
}

function bindButton(id, handler) {
  const node = $(id);
  node.addEventListener('click', handler);
  if (node instanceof SVGElement) node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); handler(); }
  });
}
bindButton('start-stop', () => turntable.togglePlatter());
// A speed key toggles its own latch; RPM is derived centrally from both latches.
function bindSpeedKey(id, speed) {
  const node = $(id);
  let pointer = null;
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer !== null) return;
    pointer = event.pointerId;
    node.focus({ preventScroll: true });
    node.setPointerCapture(pointer);
    event.preventDefault();
  });
  node.addEventListener('pointerup', (event) => {
    if (event.pointerId !== pointer) return;
    const rect = node.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    pointer = null;
    if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    if (inside) turntable.toggleSpeed(speed);
    event.preventDefault();
  });
  for (const name of ['pointercancel', 'lostpointercapture']) node.addEventListener(name, (event) => { if (event.pointerId === pointer) pointer = null; });
  // Pointer release already handled the latch; synthesized clicks must not toggle twice.
  node.addEventListener('click', (event) => { if (event.detail === 0) turntable.toggleSpeed(speed); });
  node.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) turntable.toggleSpeed(speed);
  });
  window.addEventListener('blur', () => { if (pointer !== null && node.hasPointerCapture(pointer)) node.releasePointerCapture(pointer); pointer = null; });
}
bindSpeedKey('rpm-33', 33);
bindSpeedKey('rpm-45', 45);

let powerPointer = null;
let previousPowerPoint = null;
let radialPowerDrag = true;
function powerPoint(event) {
  return new DOMPoint(event.clientX, event.clientY).matrixTransform($('deck').getScreenCTM().inverse());
}
$('power').addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || powerPointer !== null) return;
  event.preventDefault();
  turntable.assist.cancel();
  turntable.cancelPowerAnimation();
  powerPointer = event.pointerId;
  previousPowerPoint = powerPoint(event);
  radialPowerDrag = Math.hypot(previousPowerPoint.x - POWER_KNOB.cx, previousPowerPoint.y - POWER_KNOB.cy) >= 8;
  turntable.state.powerDragging = true;
  $('power').focus({ preventScroll: true });
  $('power').setPointerCapture(powerPointer);
  turntable.emit();
});
$('power').addEventListener('pointermove', (event) => {
  if (event.pointerId !== powerPointer) return;
  const point = powerPoint(event);
  let delta;
  if (radialPowerDrag) {
    if (Math.hypot(point.x - POWER_KNOB.cx, point.y - POWER_KNOB.cy) < 8) { previousPowerPoint = null; return; }
    if (!previousPowerPoint) { previousPowerPoint = point; return; }
    const angle = Math.atan2(point.y - POWER_KNOB.cy, point.x - POWER_KNOB.cx);
    const previous = Math.atan2(previousPowerPoint.y - POWER_KNOB.cy, previousPowerPoint.x - POWER_KNOB.cx);
    delta = ((angle - previous) * 180 / Math.PI + 540) % 360 - 180;
  } else delta = (point.x - previousPowerPoint.x - point.y + previousPowerPoint.y) * .8;
  previousPowerPoint = point;
  turntable.setPowerAngle(turntable.state.powerAngle + delta);
});
function finishPowerDrag(event, animate = true) {
  if (powerPointer === null || (event && event.pointerId !== powerPointer)) return;
  const pointer = powerPointer;
  powerPointer = null;
  previousPowerPoint = null;
  turntable.state.powerDragging = false;
  if ($('power').hasPointerCapture(pointer)) $('power').releasePointerCapture(pointer);
  turntable.turnPowerTo(turntable.state.power ? POWER_KNOB.maxAngle : POWER_KNOB.minAngle, animate);
}
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('power').addEventListener(name, finishPowerDrag);
$('power').addEventListener('keydown', (event) => {
  const steps = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 };
  if (!(event.key in steps) && !['Home', 'End', 'Enter', ' '].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (powerPointer !== null || (event.repeat && ['Enter', ' '].includes(event.key))) return;
  turntable.assist.cancel();
  let angle = turntable.state.powerAngle + (steps[event.key] ?? 0);
  if (event.key === 'Home') angle = POWER_KNOB.minAngle;
  if (event.key === 'End') angle = POWER_KNOB.maxAngle;
  if (['Enter', ' '].includes(event.key)) angle = turntable.state.power ? POWER_KNOB.minAngle : POWER_KNOB.maxAngle;
  turntable.turnPowerTo(angle, !(event.key in steps));
});
window.addEventListener('blur', () => finishPowerDrag(null, false));
document.addEventListener('visibilitychange', () => { if (document.hidden) finishPowerDrag(null, false); });
bindButton('cue', () => turntable.toggleCue());
bindButton('quartz', () => turntable.toggleQuartz());
bindButton('pitch-range', () => turntable.toggleRange());
bindButton('target-light', () => { turntable.state.targetLight = !turntable.state.targetLight; turntable.emit(); });
bindButton('cover-toggle', () => { turntable.state.coverClosed = !turntable.state.coverClosed; turntable.emit(); });
bindButton('arm-rest', () => turntable.returnArm());
bindButton('eject', () => turntable.eject());
$('pitch').addEventListener('input', (e) => turntable.setPitch(Number(e.target.value)));
$('pitch').addEventListener('dblclick', () => turntable.setPitch(0));

// Open synchronously in the gesture. Only an actual file selection starts replacement.
$('load').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { void turntable.load(e.target.files[0]); e.target.value = ''; });
$('help-open').addEventListener('click', () => $('help').showModal());
$('help-close').addEventListener('click', () => $('help').close());
$('help').addEventListener('click', (event) => { if (event.target === $('help') && (event.offsetX < 0 || event.offsetX > $('help').clientWidth || event.offsetY < 0 || event.offsetY > $('help').clientHeight)) $('help').close(); });

// SVG focus-visible can persist after a pointer click following keyboard input.
// Track modality for the contextual arm hint without changing hardware appearance.
document.addEventListener('pointerdown', () => $('deck').classList.remove('keyboard-navigation'), true);
document.addEventListener('keydown', event => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) $('deck').classList.add('keyboard-navigation');
}, true);

let activePointer = null;
function movePointer(event) {
  const matrix = $('deck').getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const angle = Math.atan2(geometry.px - point.x, point.y - geometry.py) * 180 / Math.PI;
  turntable.moveArm(clamp(angle, geometry.rest, INNER_ANGLE));
}
$('tonearm').addEventListener('pointerdown', (event) => {
  if (turntable.lifecycle.busy || event.button !== 0 || activePointer !== null || turntable.state.scratching) return;
  event.preventDefault();
  $('tonearm').focus({ preventScroll: true });
  turntable.assist.cancel();
  turntable.cancelSeek();
  turntable.endDirectScrub();
  activePointer = event.pointerId;
  $('tonearm').setPointerCapture(event.pointerId);
  turntable.change((s) => { s.dragging = true; });
  turntable.armScrubSample = { position: turntable.state.position, time: performance.now() };
});
$('tonearm').addEventListener('pointermove', (event) => { if (event.pointerId === activePointer) movePointer(event); });
function endDrag(event) {
  if (event.pointerId !== activePointer) return;
  activePointer = null;
  turntable.armScrubSample = null;
  turntable.change((s) => { s.dragging = false; }, false, { grooveScrub: false });
  showNotice(inGroove(turntable.state.tonearmAngle) ? `Groove selected · ${timeLabel(turntable.state.position)}. ${turntable.state.stylusRaised ? 'Lower CUE to listen.' : 'Cue remains down.'}` : 'Move the headshell farther inward to reach the record grooves.');
}
$('tonearm').addEventListener('pointerup', endDrag);
$('tonearm').addEventListener('pointercancel', endDrag);
$('tonearm').addEventListener('lostpointercapture', endDrag);
$('tonearm').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const increment = (event.shiftKey ? .1 : .01) * (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1);
  const fraction = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : clamp(progressAtAngle(turntable.state.tonearmAngle) + increment, 0, 1);
  turntable.moveArm(angleAtProgress(fraction));
});
document.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || $('help').open || $('customize').open || /INPUT|BUTTON|TEXTAREA|SELECT|A/.test(event.target.tagName)) return;
  if (event.key === ' ') { event.preventDefault(); turntable.togglePlatter(); }
  else if (event.key.toLowerCase() === 'c') { event.preventDefault(); turntable.toggleCue(); }
  else if (event.key.toLowerCase() === 'r') { event.preventDefault(); turntable.returnArm(); }
});

let recordPointer = null;
let recordPointerAngle = 0;
function vinylAngle(event) {
  const matrix = $('deck').getScreenCTM();
  if (!matrix) return null;
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  if (Math.hypot(p.x - geometry.cx, p.y - geometry.cy) < 30) return null;
  return Math.atan2(p.y - geometry.cy, p.x - geometry.cx) * 180 / Math.PI;
}
$('vinyl-hit-area').addEventListener('pointerdown', (event) => {
  if (turntable.lifecycle.busy || event.button !== 0 || recordPointer !== null || activePointer !== null || !turntable.state.recordLoaded) return;
  const angle = vinylAngle(event);
  if (angle === null) return;
  event.preventDefault();
  recordPointer = event.pointerId;
  recordPointerAngle = angle;
  $('vinyl-hit-area').focus({ preventScroll: true });
  $('vinyl-hit-area').setPointerCapture(event.pointerId);
  turntable.beginScratch();
});
$('vinyl-hit-area').addEventListener('pointermove', (event) => {
  if (event.pointerId !== recordPointer) return;
  const angle = vinylAngle(event);
  if (angle === null) { recordPointerAngle = null; return; }
  if (recordPointerAngle !== null) {
    const delta = ((angle - recordPointerAngle + 540) % 360) - 180;
    turntable.scratchBy(delta);
  }
  recordPointerAngle = angle;
});
function endRecordDrag(event) {
  if (event.pointerId !== recordPointer) return;
  recordPointer = null;
  turntable.endScratch();
}
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('vinyl-hit-area').addEventListener(name, endRecordDrag);
function releasePointers() {
  for (const [id, pointer] of [['tonearm', activePointer], ['vinyl-hit-area', recordPointer]]) {
    if (pointer !== null && $(id).hasPointerCapture(pointer)) $(id).releasePointerCapture(pointer);
  }
  activePointer = null;
  recordPointer = null;
}
function cancelGestures() {
  turntable.endDirectScrub();
  releasePointers();
  turntable.armScrubSample = null;
  if (turntable.state.dragging) turntable.change((s) => { s.dragging = false; }, false, { grooveScrub: false });
  turntable.endScratch();
}
// A keyboard alternative: hold an arrow to turn, release it to let go.
$('vinyl-hit-area').addEventListener('keydown', (event) => {
  if (turntable.lifecycle.busy || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (!turntable.state.scratching) turntable.beginScratch();
  turntable.scratchBy(event.key === 'ArrowLeft' ? -18 : 18);
});
$('vinyl-hit-area').addEventListener('keyup', (event) => {
  if (['ArrowLeft', 'ArrowRight'].includes(event.key) && recordPointer === null) turntable.endScratch();
});
$('vinyl-hit-area').addEventListener('blur', () => { if (recordPointer === null) turntable.endScratch(); });
window.addEventListener('blur', cancelGestures);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGestures(); });

// File drags are tracked across the page; the visual target stays on the platter.
let dragDepth = 0;
const audioTypes = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);
function fileDrag(data) { return data && Array.from(data.types).includes('Files'); }
function acceptsDrag(data) {
  const files = Array.from(data.items ?? []).filter(item => item.kind === 'file');
  // Some OS/browser drags conceal MIME until drop. Validate the filename on load.
  return !files.length || files.some(item => !item.type || audioTypes.has(item.type));
}
function clearDrop() { dragDepth = 0; $('drop-zone').classList.remove('drag-over'); }
document.addEventListener('dragenter', event => {
  if (!fileDrag(event.dataTransfer)) return;
  dragDepth++;
  $('drop-zone').classList.toggle('drag-over', acceptsDrag(event.dataTransfer));
});
document.addEventListener('dragover', event => {
  if (!fileDrag(event.dataTransfer)) return;
  event.preventDefault();
  const valid = acceptsDrag(event.dataTransfer);
  event.dataTransfer.dropEffect = valid ? 'copy' : 'none';
  $('drop-zone').classList.toggle('drag-over', valid);
});
document.addEventListener('dragleave', event => {
  if (fileDrag(event.dataTransfer) && --dragDepth <= 0) clearDrop();
});
document.addEventListener('drop', event => {
  clearDrop();
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer.files);
  void turntable.load(files.find(file => /\.(mp3|wav)$/i.test(file.name)) ?? files[0]);
});
document.addEventListener('dragend', clearDrop);
window.addEventListener('blur', clearDrop);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearDrop(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') clearDrop(); });

drawDetails();
setupCustomization((key, value) => turntable.customize(key, value));
turntable.addEventListener('change', render);
render();
let previousRender = 0, wasSeeking = false;
function frame(now) {
  const s = turntable.state;
  turntable.syncPosition();
  $('platter-rotation').setAttribute('transform', `rotate(${s.rotation.toFixed(4)} ${geometry.cx} ${geometry.cy})`);
  $('record').setAttribute('transform', `rotate(${s.recordRotation % 360} ${geometry.cx} ${geometry.cy})`);
  hud.rotate(s.recordRotation);
  if (s.seeking || wasSeeking) hud.render({ ...s, ...turntable.derived });
  if (turntable.audible || s.seeking || wasSeeking) attr($('tonearm'), 'transform', `translate(${geometry.px} ${geometry.py}) rotate(${s.tonearmAngle.toFixed(5)})`);
  wasSeeking = s.seeking;
  if (now - previousRender > 100) { turntable.emit(); previousRender = now; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function reducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
async function animateRecord(direction) {
  const insert = direction === 'insert';
  // Fade only while well above the spindle. Near the platter, solid media and
  // its moving center hole determine occlusion; permanent hardware never fades.
  const frames = insert ? [
    { transform: 'translate(-8px, -160px) scale(1.07)', opacity: 0, filter: 'brightness(1.06)', offset: 0 },
    { transform: 'translate(-4px, -128px) scale(1.055)', opacity: 1, filter: 'brightness(1.04)', offset: .22 },
    { transform: 'translate(0px, -30px) scale(1.025)', opacity: 1, filter: 'brightness(1.015)', offset: .62 },
    { transform: 'translate(0px, 1px) scale(.999)', opacity: 1, filter: 'brightness(1)', offset: .9 },
    { transform: 'translate(0px, 0px) scale(1)', opacity: 1, filter: 'brightness(1)' },
  ] : [
    { transform: 'translate(0px, 0px) scale(1)', opacity: 1, filter: 'brightness(1)', offset: 0 },
    { transform: 'translate(0px, -30px) scale(1.025)', opacity: 1, filter: 'brightness(1.015)', offset: .35 },
    { transform: 'translate(-4px, -128px) scale(1.055)', opacity: 1, filter: 'brightness(1.04)', offset: .78 },
    { transform: 'translate(-8px, -160px) scale(1.07)', opacity: 0, filter: 'brightness(1.06)' },
  ];
  const options = { duration: reducedMotion() ? 1 : insert ? 780 : 620, easing: 'cubic-bezier(.3,0,.25,1)', fill: 'forwards' };
  const lift = $('record-lift').animate(frames, options);
  const shadow = $('record-shadow').animate(insert ? [
    { opacity: .32, filter: 'blur(12px)', transform: 'translate(6px, 14px) scale(1.02)' },
    { opacity: 0, filter: 'blur(1px)', transform: 'translate(0px, 1px) scale(1)' },
  ] : [
    { opacity: 0, filter: 'blur(1px)' },
    { opacity: .3, filter: 'blur(12px)', offset: .6 },
    { opacity: 0, filter: 'blur(16px)' },
  ], options);
  await lift.finished;
  if (!insert) $('record').classList.add('is-hidden');
  lift.cancel(); shadow.cancel();
}
