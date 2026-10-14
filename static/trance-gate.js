/** Trance Gate: a 16-step rhythmic gain envelope clocked by the beat grid at the record's
 * read position (song seconds), never by wall time. Seeking, pausing, scratching and
 * speed/pitch changes therefore stay on the beat with no resynchronization. It gates the
 * music only; surface noise and contact sounds pass untouched. */
export class TranceGate {
  constructor(sampleRate) {
    this.sampleRate = sampleRate; this.beats = new Float64Array(0); this.downbeat = 0; this.cursor = 0; this.gain = 1; this.interval = .5;
    // Crossover state: the gate ducks the low end fully and the highs only partly (`highs`).
    this.low = [0, 0]; this.lowCoefficient = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate);
    this.makeupGain = 1; this.makeupCoefficient = 1 - Math.exp(-1 / (sampleRate * .05));
    this.configure({});
  }
  configure({ enabled = false, depth = .85, stepsPerBeat = 4, length = .55, steps = Array(16).fill(true), shape = 'chop', cycle = 16, attackMs = 1.5, releaseMs = 9, punchMs = 0, highs = 1, makeup = 1 } = {}) {
    this.enabled = enabled; this.shape = shape === 'pump' ? 'pump' : 'chop'; this.depth = Math.max(0, Math.min(1, depth)); this.stepsPerBeat = stepsPerBeat;
    this.length = Math.max(0, Math.min(1, length)); this.steps = steps.length ? steps.map(Boolean) : [true];
    // Steps per pattern cycle: 16, or 12 (one bar) for triplets so they stay bar-aligned.
    this.cycle = Math.max(1, Math.min(this.steps.length, cycle));
    // Musical, not muffled: let the kick's attack through before a pump ducks (punchMs),
    // spare part of the highs (vocals, hats, air), and restore a little lost loudness.
    this.punch = Math.max(0, punchMs) / 1000; this.highs = Math.max(0, Math.min(1, highs)); this.makeup = Math.max(1, Math.min(1.19, makeup));
    // Click-free edges: a short attack opens, a slightly longer release closes.
    this.attack = 1 - Math.exp(-1 / (this.sampleRate * attackMs / 1000));
    this.release = 1 - Math.exp(-1 / (this.sampleRate * releaseMs / 1000));
  }
  setGrid(beats, downbeat = 0) { this.beats = beats instanceof Float64Array ? beats : Float64Array.from(beats ?? []); this.downbeat = downbeat; this.cursor = 0; }
  /** Fractional beat index at song time `t`, extrapolating before the first and after the
   * last beat with the nearest interval. The cursor makes sequential reads O(1). */
  beatAt(t) {
    const beats = this.beats, n = beats.length;
    if (n < 2) return null;
    if (t <= beats[0]) { this.interval = beats[1] - beats[0]; return (t - beats[0]) / this.interval; }
    if (t >= beats[n - 1]) { this.interval = beats[n - 1] - beats[n - 2]; return n - 1 + (t - beats[n - 1]) / this.interval; }
    let i = Math.min(this.cursor, n - 2);
    while (i < n - 2 && beats[i + 1] <= t) i++;
    while (i > 0 && beats[i] > t) i--;
    this.cursor = i; this.interval = beats[i + 1] - beats[i];
    return i + (t - beats[i]) / this.interval;
  }
  /** Target gain (before smoothing) at song time `t`. */
  target(t, beat = this.beatAt(t)) {
    if (!this.enabled || beat === null) return 1;
    const position = (beat - this.downbeat) * this.stepsPerBeat, step = Math.floor(position);
    const index = ((step % this.cycle) + this.cycle) % this.cycle;
    if (!this.steps[index]) return 1 - this.depth;
    const within = position - step;
    // Chop: hard on/off within each step. Pump: drop at the step start, stay low, then swell
    // back (ease-in, accelerating) to full level by `length` of the step: the sidechain "woah".
    if (this.shape === 'pump') {
      const punch = Math.min(.3, this.punch * this.stepsPerBeat / Math.max(1e-3, this.interval));
      if (within < punch || within >= this.length) return 1;
      return 1 - this.depth * (1 - ((within - punch) / Math.max(1e-3, this.length - punch)) ** 2);
    }
    return within < this.length ? 1 : 1 - this.depth;
  }
  /** Smoothed gain for one sample. */
  step(t) {
    // The beat position is kept for other beat-synced effects (hardstyle kicks) too.
    this.beat = this.beatAt(t);
    const target = this.target(t, this.beat);
    this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
    this.makeupGain += ((this.enabled ? this.makeup : 1) - this.makeupGain) * this.makeupCoefficient;
    return this.gain;
  }
  /** Apply the current gain to one music sample on `channel`: full duck below ~180 Hz,
   * `highs` of it above. With the gate off (gain 1, makeup 1) the sample is unchanged. */
  apply(value, channel, gain = this.gain) {
    const low = this.low[channel] = (this.low[channel] ?? 0) + (value - (this.low[channel] ?? 0)) * this.lowCoefficient;
    return (low * gain + (value - low) * (1 - (1 - gain) * this.highs)) * this.makeupGain;
  }
}
