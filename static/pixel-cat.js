/** Pixel Cat mode: an 8-bit remix of any record. The record is crunched (sample-rate and
 * bit-depth reduction) under a small chiptune band on the beat grid, playing the song's
 * chords: a 25% pulse lead (two-bar melody patterns built from chord tones, with a
 * dotted-eighth echo), a 4-bit triangle bass bouncing octaves, and optional "nya" vocals
 * (the lead through a formant glide from a nasal "n" into "ya").
 * Chords come from offline analysis in song seconds, so seeking, pausing and speed changes
 * stay in sync; notes start only while the record plays forward and retune with its rate. */
const PHRASE = 32; // two bars of sixteenths

export class PixelCat {
  constructor(sampleRate) {
    this.sampleRate = sampleRate; this.lastBeat = null; this.speed = 1;
    this.times = new Float64Array(0); this.roots = new Int8Array(0); this.minors = new Uint8Array(0);
    this.lead = { on: false, frequency: 0, time: 0, phase: 0, amp: 0, f1: [0, 0], f2: [0, 0], vowel: 0 };
    this.bass = { on: false, frequency: 0, time: 0, phase: 0, amp: 0 };
    this.echo = new Float32Array(Math.ceil(sampleRate * 2)); this.echoWrite = 0; this.echoDelay = sampleRate * .375;
    this.held = [0, 0]; this.holdPhase = [0, 0];
    this.notes = 0; this.bassNotes = 0; this.meows = 0; this.sample = 0; this.idle = Infinity;
    this.configure({});
  }
  configure({ enabled = false, volume = .6, crunch = .5, lead = [], bass = [], meow = false, tonic = 0, minor = false } = {}) {
    this.enabled = enabled; this.volume = Math.max(0, Math.min(1, volume)); this.meow = Boolean(meow);
    this.crunch = Math.max(0, Math.min(1, crunch)); this.tonic = ((tonic % 12) + 12) % 12; this.minor = Boolean(minor);
    // Crunch: 0 leaves the record clean; 50% is 8-bit at 8 kHz; 100% is 4-bit at 4 kHz.
    this.bits = Math.round(12 - 8 * this.crunch); this.holdStep = this.sampleRate / (16000 * .25 ** this.crunch);
    // Patterns: lead notes are chord-tone ladder steps (0 root, 1 third, 2 fifth, 3 octave…),
    // bass notes 0 root, 1 octave, 2 fifth; -1 rests and null holds the previous note.
    this.leadSteps = lead; this.bassSteps = bass;
    if (!enabled) { this.lead.on = false; this.bass.on = false; } else this.idle = 0;
  }
  /** Chord changes in song seconds: roots are pitch classes (0 = C), minors 1 for minor. */
  setChords(times = [], roots = [], minors = []) {
    this.times = Float64Array.from(times); this.roots = Int8Array.from(roots); this.minors = Uint8Array.from(minors);
  }
  chordAt(t) {
    const times = this.times, n = times.length;
    if (!n) return { root: this.tonic, minor: this.minor };
    let low = 0, high = n - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (times[middle] <= t) low = middle; else high = middle - 1; }
    return { root: this.roots[low], minor: Boolean(this.minors[low]) };
  }

  /** Called on each sixteenth the read head enters while playing forward. */
  onStep(step, t) {
    const i = ((step % PHRASE) + PHRASE) % PHRASE, chord = this.chordAt(t + .03);
    const third = chord.minor ? 3 : 4, ladder = [0, third, 7];
    const lead = this.leadSteps.length ? this.leadSteps[i % this.leadSteps.length] : -1;
    if (lead === -1) this.lead.on = false;
    else if (Number.isInteger(lead)) {
      // Lead: A3–G♯4 root, so most of the melody sits in the bright 440–880 Hz range.
      const midi = 57 + ((chord.root - 9 + 12) % 12) + ladder[lead % 3] + 12 * Math.floor(lead / 3);
      Object.assign(this.lead, { on: true, frequency: 440 * 2 ** ((midi - 69) / 12), time: 0 }); this.notes++;
      if (this.meow) this.meows++;
    }
    const bass = this.bassSteps.length ? this.bassSteps[i % this.bassSteps.length] : -1;
    if (bass === -1) this.bass.on = false;
    else if (Number.isInteger(bass)) {
      const midi = 36 + chord.root + [0, 12, 7][bass];  // C2–B2 root
      Object.assign(this.bass, { on: true, frequency: 440 * 2 ** ((midi - 69) / 12), time: 0 }); this.bassNotes++;
    }
  }

  /** Advance one sample. `t` is the read head in song seconds, `beat` the fractional beat
   * (null without a grid), `rate` the signed playback rate (0 while scrubbing or seeking)
   * and `interval` the current beat length in song seconds. */
  step(t, beat, downbeat, rate, interval = .5) {
    // Off, and the release and echo tails have died away (2 s): nothing to do.
    if (!this.enabled && this.idle > 2 * this.sampleRate) { this.sample = 0; this.lastBeat = beat; return; }
    if (!this.enabled) this.idle++;
    this.speed = Math.max(.25, Math.min(4, Math.abs(rate) || 1));
    const forward = this.enabled && rate > .3;
    if (forward && beat !== null && this.lastBeat !== null) {
      const now = Math.floor((beat - downbeat) * 4), before = Math.floor((this.lastBeat - downbeat) * 4);
      if (now > before && beat - this.lastBeat < .125) this.onStep(now, t);
    }
    if (!forward) { this.lead.on = false; this.bass.on = false; }
    this.lastBeat = beat;
    const sr = this.sampleRate, dt = 1 / sr;
    let lead = 0, bass = 0;
    // Lead: 25% pulse (band-limited edges), quick decay to a sustain, late vibrato.
    const L = this.lead;
    if (L.on || L.amp > 1e-4) {
      // A 1 ms attack from the current level (no click on retrigger), 15 ms release.
      const time = L.time, envelope = L.on ? .72 + .28 * Math.exp(-time / .08) : 0;
      L.amp += (envelope - L.amp) * (1 - Math.exp(-dt / (L.on ? .001 : .015)));
      const vibrato = time > .18 ? 1 + .005 * Math.sin(2 * Math.PI * 5.5 * (time - .18)) * Math.min(1, (time - .18) / .12) : 1;
      // Nya: the voice scoops up a semitone into the note, like a sung syllable.
      const scoop = this.meow ? 2 ** (-Math.exp(-time / .03) / 12) : 1;
      const frequency = L.frequency * this.speed * vibrato * scoop, increment = frequency / sr;
      L.phase += increment; if (L.phase >= 1) L.phase -= 1;
      let pulse = (L.phase < .25 ? 1 : -1) + blep(L.phase, increment) - blep((L.phase + .75) % 1, increment) + .5;
      if (this.meow) {
        // "n" (nasal murmur, low formants) → "y" glide → "a" (open vowel), within 75 ms.
        const glide = time < .025 ? 0 : time < .075 ? smooth((time - .025) / .05) : 1;
        const f1 = 280 + 570 * glide, f2 = 2300 - 800 * glide, nasal = 1 - glide;
        pulse = (this.formant(L.f1, pulse, f1, 4) + .7 * this.formant(L.f2, pulse, f2, 7) + .08 * pulse) * (1 - .55 * nasal);
      }
      lead = pulse * L.amp; L.time += dt;
    }
    // Dotted-eighth echo, the classic chiptune trick for a fuller lead.
    const target = Math.max(.05 * sr, Math.min(1.9 * sr, .75 * interval / this.speed * sr));
    this.echoDelay += (target - this.echoDelay) * .0005;
    const size = this.echo.length, read = (this.echoWrite - this.echoDelay + size) % size, index = Math.floor(read), fraction = read - index;
    const echoed = this.echo[index] * (1 - fraction) + this.echo[(index + 1) % size] * fraction;
    this.echo[this.echoWrite] = lead + echoed * .35; this.echoWrite = (this.echoWrite + 1) % size;
    // Bass: a 4-bit stepped triangle (the NES bass voice), short attack and release.
    const B = this.bass;
    if (B.on || B.amp > 1e-4) {
      B.amp += ((B.on ? 1 : 0) - B.amp) * (1 - Math.exp(-dt / (B.on ? .001 : .008)));
      B.phase = (B.phase + B.frequency * this.speed / sr) % 1;
      bass = (Math.round(2 * Math.abs(B.phase - .5) * 15) / 15 * 2 - 1) * B.amp; B.time += dt;
    }
    const band = lead * .16 + echoed * .056 + bass * .3;
    this.sample = Math.tanh(1.2 * band) / Math.tanh(1.2) * this.volume;
  }
  // Resonant band-pass (TPT state-variable filter), unity gain at the centre.
  formant(state, x, cutoff, q) {
    const g = Math.tan(Math.PI * Math.min(cutoff, this.sampleRate * .45) / this.sampleRate), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - state[1], v1 = a1 * state[0] + a2 * v3, v2 = state[1] + a2 * state[0] + a3 * v3;
    state[0] = 2 * v1 - state[0]; state[1] = 2 * v2 - state[1];
    return v1 * k;
  }
  /** The crunched record under the band, plus the band. */
  apply(value, channel = 0) {
    if (!this.enabled) return value + this.sample;
    let music = value;
    if (this.crunch > .01) {
      // Sample-and-hold at the crunch rate, then quantize to the crunch bit depth.
      const c = channel & 1;
      if ((this.holdPhase[c] += 1) >= this.holdStep) {
        this.holdPhase[c] -= this.holdStep;
        const levels = 2 ** (this.bits - 1); this.held[c] = Math.round(value * levels) / levels;
      }
      music = this.held[c];
    }
    return music * (1 - .25 * this.volume) + this.sample;
  }
}
const smooth = x => x * x * (3 - 2 * x);
// PolyBLEP correction for a band-limited step at phase 0.
function blep(phase, increment) {
  if (phase < increment) { const x = phase / increment; return x + x - x * x - 1; }
  if (phase > 1 - increment) { const x = (phase - 1) / increment; return x * x + x + x + 1; }
  return 0;
}
