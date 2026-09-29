import { deriveSpeed, NOMINAL_RPM } from './simulation-state.js';

/** Presets describe physical controls; selection is derived, never stored. */
export const PLAYBACK_PRESETS = Object.freeze([
  { id: 'original', name: 'Original', rpm: NOMINAL_RPM, pitch: 0 },
  { id: 'slowed', name: 'Slowed + Pitched Down', rpm: NOMINAL_RPM, pitch: -16 },
  { id: 'slightly-sped-up', name: 'Slightly Sped Up + Pitched Up', rpm: NOMINAL_RPM, pitch: 16 },
  { id: 'sped-up', name: 'Sped Up', rpm: 45, pitch: -8 },
  { id: 'sped-up-pitched-up', name: 'Sped Up + Pitched Up', rpm: 45, pitch: 0 },
  { id: 'nightcore', name: 'Nightcore', rpm: 45, pitch: 16 },
  { id: 'hyperpop', name: 'Hyperpop', rpm: 78, pitch: -16 },
  { id: 'chipmunk', name: 'Chipmunk', rpm: 78, pitch: 0 },
].map(preset => Object.freeze({ ...preset, range: Math.abs(preset.pitch) > 8 ? 16 : 8 })));

export function selectedPreset(state) {
  const { rpm } = deriveSpeed(state);
  return PLAYBACK_PRESETS.find(preset => preset.rpm === rpm
    && Math.abs(preset.pitch - state.pitch) < .00001
    && preset.range === state.pitchRange && state.quartzLock === (preset.pitch === 0));
}

/** Cancellable movement of the existing physical pitch controls. */
export class PresetMotion {
  constructor(deck) { this.deck = deck; this.frame = null; this.generation = 0; }
  cancel() {
    ++this.generation;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.deck.state.presetMotion) {
      this.deck.state.presetMotion = null;
      this.deck.emit();
    }
  }
  apply(preset) {
    this.cancel();
    const d = this.deck, s = d.state, generation = this.generation;
    // A range-button press preserves physical fader travel, just like manual
    // toggleRange(). Only the remaining distance to the preset is animated.
    const fraction = s.pitch / s.pitchRange;
    const start = fraction * preset.range;
    const target = preset.pitch;
    d.change(s => {
      s.presetMotion = { id: preset.id, name: preset.name };
      s.speed33Pressed = preset.rpm !== 45;
      s.speed45Pressed = preset.rpm !== NOMINAL_RPM;
      s.pitchRange = preset.range;
      s.pitch = start;
      if (target !== 0) s.quartzLock = false;
    });
    const finish = () => {
      if (generation !== this.generation) return;
      this.frame = null;
      d.change(s => { s.pitch = target; s.quartzLock = target === 0; s.presetMotion = null; });
    };
    if (generation !== this.generation) return;
    if (Math.abs(target - start) < .00001) { finish(); return; }
    const duration = 260 + 520 * Math.abs(target - start) / (2 * preset.range);
    const began = performance.now();
    const tick = now => {
      if (generation !== this.generation) return;
      const progress = Math.min(1, (now - began) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      d.change(s => { s.pitch = start + (target - start) * eased; });
      if (generation !== this.generation) return;
      if (progress < 1) this.frame = requestAnimationFrame(tick);
      else finish();
    };
    this.frame = requestAnimationFrame(tick);
  }
}
