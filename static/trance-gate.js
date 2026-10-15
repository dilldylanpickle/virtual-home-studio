/** Trance Gate: a step-sequenced ADSR gate, the classic way. Each step that starts a note
 * fires an attack–decay–sustain envelope, tied steps hold that note, and the release runs
 * into the steps that are off; Mix blends the dry record back in.
 * The clock is the beat grid at the record's read position (song seconds), never wall time,
 * and the envelope is a pure function of that position: seeking, pausing, scratching,
 * reversing and speed/pitch changes stay on the beat with no resynchronization or stale
 * triggers. It gates the music only; surface noise and contact sounds pass untouched. */
const OFF = 0, ON = 1, TIE = 2;

export class TranceGate {
  constructor(sampleRate) {
    this.sampleRate = sampleRate; this.beats = new Float64Array(0); this.downbeat = 0; this.cursor = 0; this.timeCursor = 0;
    this.gain = 1; this.interval = .5; this.beat = null;
    // A 0.8 ms follower keeps retriggers and hard stops click-free without softening them.
    this.follow = 1 - Math.exp(-1 / (sampleRate * .0008));
    this.configure({});
  }
  configure({ enabled = false, stepsPerBeat = 4, steps = Array(16).fill(ON), cycle = 16, attackMs = 1, decayMs = 80, sustain = .4, releaseMs = 30, mix = 1 } = {}) {
    this.enabled = enabled; this.stepsPerBeat = stepsPerBeat > 0 ? stepsPerBeat : 4;
    // Steps cycle every 16, or every bar (12) for triplets so they stay bar-aligned.
    const states = (steps.length ? steps : [ON]).map(step => step === true ? ON : step === TIE ? TIE : step ? ON : OFF);
    this.cycle = Math.max(1, Math.min(states.length, cycle)); this.steps = normalize(states, this.cycle);
    this.attack = Math.max(.0005, attackMs / 1000); this.decay = Math.max(.001, decayMs / 1000); this.release = Math.max(.001, releaseMs / 1000);
    this.sustain = Math.max(0, Math.min(1, sustain)); this.mix = Math.max(0, Math.min(1, mix));
    this.note = null;
  }
  setGrid(beats, downbeat = 0) {
    this.beats = beats instanceof Float64Array ? beats : Float64Array.from(beats ?? []);
    this.downbeat = downbeat; this.cursor = this.timeCursor = 0; this.note = null;
  }
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
  /** Song time of a fractional beat index (the inverse of beatAt). */
  timeAt(beat) {
    const beats = this.beats, n = beats.length;
    if (beat <= 0) return beats[0] + beat * (beats[1] - beats[0]);
    if (beat >= n - 1) return beats[n - 1] + (beat - n + 1) * (beats[n - 1] - beats[n - 2]);
    const i = Math.floor(beat);
    return beats[i] + (beat - i) * (beats[i + 1] - beats[i]);
  }
  state(step) { return this.steps[((step % this.cycle) + this.cycle) % this.cycle]; }
  /** The note around absolute step `step`: when it starts and ends (song seconds), or, for an
   * off step, the last note before it (whose release may still be sounding). Cached per step. */
  noteAt(step) {
    if (this.note?.step === step) return this.note;
    const time = k => this.timeAt(this.downbeat + k / this.stepsPerBeat);
    let last = step;
    while (this.state(last) === OFF && step - last < this.cycle) last--;
    if (this.state(last) === OFF) return (this.note = { step, silent: true });
    let start = last, end = last + 1;
    while (this.state(start) === TIE && last - start < this.cycle) start--;
    while (this.state(end) === TIE && end - last < this.cycle) end++;
    return (this.note = { step, start: time(start), end: time(end) });
  }
  // Attack rises linearly; decay and release fall on a convex curve, so hits read as plucks.
  held(age) {
    if (age < this.attack) return Math.max(0, age / this.attack);
    const x = Math.min(1, (age - this.attack) / this.decay);
    return this.sustain + (1 - this.sustain) * (1 - x) ** 2;
  }
  /** Envelope (0–1) at song time `t`; 1 without a grid. */
  envelope(t, beat = this.beatAt(t)) {
    if (beat === null) return 1;
    const step = Math.floor((beat - this.downbeat) * this.stepsPerBeat), note = this.noteAt(step);
    if (note.silent) return 0;
    if (t < note.end) return this.held(t - note.start);
    const x = Math.min(1, (t - note.end) / this.release);
    return this.held(note.end - note.start) * (1 - x) ** 2;
  }
  /** Gain target at song time `t`: the envelope, with Mix of the dry record kept. */
  target(t, beat = this.beatAt(t)) {
    if (!this.enabled) return 1;
    return 1 - this.mix + this.mix * this.envelope(t, beat);
  }
  /** Smoothed gain for one sample. The beat position is kept for the UI and other effects. */
  step(t) {
    this.beat = this.beatAt(t);
    this.gain += (this.target(t, this.beat) - this.gain) * this.follow;
    return this.gain;
  }
  /** Apply the current gain to one music sample. With the gate off it is unchanged. */
  apply(value, _channel, gain = this.gain) { return value * gain; }
}

/** A tie must follow a note (within the cycle): a tie after an off step starts a note, and a
 * cycle of only ties starts on its first step. */
function normalize(steps, cycle) {
  const out = [...steps], used = out.slice(0, cycle);
  if (!used.includes(ON) && used.includes(TIE)) out[used.indexOf(TIE)] = ON;
  for (let i = 0; i < cycle; i++) if (out[i] === TIE && out[(i - 1 + cycle) % cycle] === OFF) out[i] = ON;
  return out;
}
