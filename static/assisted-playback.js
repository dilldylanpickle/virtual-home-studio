import { playbackEnded } from './simulation-state.js';

// Play is brisk but continuous: the arm sweeps while the platter spins up, hovers briefly
// over the lead-in, then takes a quicker damped descent than the manual cue lever. The
// descent outlasts the motor's longest start ramp (450 ms), so touchdown meets full speed.
const SWEEP_MS = 420, SWEEP_SPAN_MS = 700, HOVER_MS = 120, DESCENT_MS = 650;

/** Cancellable physical setup. No audio source, cursor, or motor lives here. */
export class AssistedPlayback {
  constructor(deck, geometry) {
    this.deck = deck;
    this.geometry = geometry;
    this.generation = 0;
    this.frame = null;
  }
  cancel() {
    ++this.generation;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.deck.state.tonearmMotion?.kind !== 'parking') this.deck.armMotion.cancel();
    this.deck.state.assistPhase = 'idle';
    this.deck.emit();
  }
  async play() {
    const d = this.deck, s = d.state;
    if (d.lifecycle.busy || !s.recordLoaded || s.assistPhase !== 'idle') return;
    d.armMotion.cancel();
    d.syncPosition();
    const restart = playbackEnded(s) || !this.geometry.inGroove(s.tonearmAngle);
    // A normal resume uses the existing soft motor ramp and exact groove anchor.
    if (!restart && !s.stylusRaised && s.power && s.rpm !== null) {
      void d.unlockAudio();
      d.change(s => { s.transportPaused = false; s.platterRunning = true; });
      return;
    }
    const generation = ++this.generation;
    d.cancelPowerAnimation();
    s.assistPhase = 'preparing';
    d.emit();
    await d.unlockAudio();
    if (generation !== this.generation) return;
    if (d.context?.state !== 'running' || !d.engine) { this.cancel(); return; }
    const fromPower = s.powerAngle;
    if (restart) { d.cancelCueDescent(); d.change(s => { s.stylusRaised = true; }); }
    let began = performance.now();
    const enter = (phase, now) => { s.assistPhase = phase; began = now; d.emit(); };
    enter('powering', began);
    const tick = now => {
      if (generation !== this.generation) return;
      const elapsed = now - began;
      switch (s.assistPhase) {
        case 'powering': {
          const progress = Math.min(1, elapsed / 180);
          d.setPowerAngle(fromPower + (0 - fromPower) * (progress * progress * (3 - 2 * progress)));
          if (progress < 1 && fromPower !== 0) break;
          d.change(s => {
            if (s.rpm === null) s.speed33Pressed = true;
            s.transportPaused = false;
            s.platterRunning = true;
          });
          enter(restart ? 'cueing' : 'lowering', now);
          break;
        }
        case 'cueing': {
          this.frame = null;
          const { outerAngle, rest, innerAngle } = this.geometry;
          const distance = Math.min(1, Math.abs(outerAngle - s.tonearmAngle) / (innerAngle - rest));
          void d.armMotion.moveTo(outerAngle, { kind: 'cueing', duration: SWEEP_MS + SWEEP_SPAN_MS * distance, liftDelay: 0 })
            .then(completed => {
              if (!completed || generation !== this.generation) return;
              d.change(s => { s.position = 0; }, true);
              enter('lowering', performance.now());
              this.frame = requestAnimationFrame(tick);
            });
          return;
        }
        case 'lowering':
          // A short pause over the lead-in, then the damped cue lowers; contact starts at touchdown.
          if (elapsed >= HOVER_MS) {
            this.frame = null;
            void d.lowerStylus({ seek: restart, duration: DESCENT_MS }).then(landed => {
              if (generation !== this.generation) return;
              enter('idle', performance.now());
            });
            return;
          }
          break;
        default: return;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
}
