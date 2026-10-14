/** Trance Gate: a 16-step rhythmic gain envelope clocked by the beat grid at the record's
 * read position (song seconds), never by wall time. Seeking, pausing, scratching and
 * speed/pitch changes therefore stay on the beat with no resynchronization. It gates the
 * music only; surface noise and contact sounds pass untouched. */
export class TranceGate {
  constructor(sampleRate) {
    this.sampleRate = sampleRate; this.beats = new Float64Array(0); this.downbeat = 0; this.cursor = 0; this.gain = 1;
    this.configure({});
  }
  configure({ enabled = false, depth = .85, stepsPerBeat = 4, length = .55, steps = Array(16).fill(true), shape = 'chop', attackMs = 1.5, releaseMs = 9 } = {}) {
    this.enabled = enabled; this.shape = shape === 'pump' ? 'pump' : 'chop'; this.depth = Math.max(0, Math.min(1, depth)); this.stepsPerBeat = stepsPerBeat;
    this.length = Math.max(.05, Math.min(1, length)); this.steps = steps.length ? steps.map(Boolean) : [true];
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
    if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
    if (t >= beats[n - 1]) return n - 1 + (t - beats[n - 1]) / (beats[n - 1] - beats[n - 2]);
    let i = Math.min(this.cursor, n - 2);
    while (i < n - 2 && beats[i + 1] <= t) i++;
    while (i > 0 && beats[i] > t) i--;
    this.cursor = i;
    return i + (t - beats[i]) / (beats[i + 1] - beats[i]);
  }
  /** Target gain (before smoothing) at song time `t`. */
  target(t) {
    if (!this.enabled) return 1;
    const beat = this.beatAt(t);
    if (beat === null) return 1;
    const position = (beat - this.downbeat) * this.stepsPerBeat, step = Math.floor(position);
    const index = ((step % this.steps.length) + this.steps.length) % this.steps.length;
    if (!this.steps[index]) return 1 - this.depth;
    const within = position - step;
    // Chop: hard on/off within each step. Pump: drop at the step start, stay low, then swell
    // back (ease-in, accelerating) to full level by `length` of the step: the sidechain "woah".
    if (this.shape === 'pump') return within >= this.length ? 1 : 1 - this.depth * (1 - (within / this.length) ** 2);
    return within < this.length ? 1 : 1 - this.depth;
  }
  /** Smoothed gain for one sample. */
  step(t) {
    const target = this.target(t);
    this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
    return this.gain;
  }
}
