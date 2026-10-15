/** 8-bit mode: turns any record into a chiptune remix. The record is crunched (sample-rate
 * and bit-depth reduction) under a chip band on the beat grid, in the song's key and chords:
 * - lead: a pulse-wave melody (two-bar original patterns in pentatonic degrees of the key;
 *   notes on the beat snap to the chord), vibrato on long notes and a dotted-eighth echo;
 * - chip chords: offbeat stabs that arpeggiate the current chord at frame rate, the
 *   classic way sound chips fake chords with one voice;
 * - bass: octaves bouncing on the chord root;
 * - drums: a pitch-dropping kick and noise snare/hats from a linear-feedback shift register;
 * - power-up: a rising jingle in key on the next beat.
 * The sound chip sets the voices: Console (25% pulse lead, stepped 4-bit triangle bass, long
 * noise), Pocket (hollow square lead, 4-bit wavetable bass, short metallic noise) or Computer
 * (pulse-width sweep through a resonant low-pass, filtered saw bass).
 * Chords come from offline analysis in song seconds, so seeking, pausing and speed changes
 * stay in sync; notes start only while the record plays forward and retune with its rate. */
const PHRASE = 32; // two bars of sixteenths
// Pentatonic: bouncy, and safe when the key is a near miss (it skips the notes that tell a
// key from its neighbours).
const SCALES = { major: [0, 2, 4, 7, 9], minor: [0, 3, 5, 7, 10] };
const hz = midi => 440 * 2 ** ((midi - 69) / 12);

/** Sound chips. duty/pwm: lead pulse width and its sweep; bass: voice; noise: shift-register
 * length (15 hiss, 7 metallic); arp: chord-arpeggio frame rate (Hz); filter: resonant
 * low-pass sweep on the lead; stab: chord-stab pulse width. */
export const CHIP_SOUNDS = Object.freeze({
  console: { duty: .25, pwm: 0, bass: 'triangle', noise: 15, arp: 60, filter: false, stab: .125 },
  pocket: { duty: .5, pwm: 0, bass: 'wave', noise: 7, arp: 64, filter: false, stab: .25 },
  computer: { duty: .3, pwm: .18, bass: 'saw', noise: 15, arp: 50, filter: true, stab: .125 },
});
// Pocket bass wavetable: 32 4-bit steps, a rounded saw.
const WAVE = Float32Array.from({ length: 32 }, (_, i) => Math.round(7.5 + 7.5 * Math.sin(Math.PI * i / 16 - Math.PI / 2) * .6 + 7.5 * (i / 31 - .5) * .8) / 7.5 - 1);

export class Chiptune {
  constructor(sampleRate) {
    this.sampleRate = sampleRate; this.lastBeat = null; this.speed = 1; this.stepLength = .125; this.clock = 0;
    this.times = new Float64Array(0); this.roots = new Int8Array(0); this.minors = new Uint8Array(0);
    this.lead = { on: false, frequency: 0, time: 0, until: 0, phase: 0, amp: 0, filter: [0, 0] };
    this.stab = { on: false, notes: [0, 0, 0], time: 0, until: 0, phase: 0, amp: 0 };
    this.bass = { on: false, frequency: 0, time: 0, until: 0, phase: 0, amp: 0, tone: 0 };
    this.jingle = { time: Infinity, notes: [], phase: 0, pending: false };
    this.kick = { time: Infinity, phase: 0 }; this.snare = { time: Infinity }; this.hat = { time: Infinity };
    this.lfsr = { register: 1, count: 0, value: 1, seed: 22222 };
    this.echo = new Float32Array(Math.ceil(sampleRate * 2)); this.echoWrite = 0; this.echoDelay = sampleRate * .375;
    this.held = [0, 0]; this.holdPhase = [0, 0];
    this.notes = 0; this.bassNotes = 0; this.stabs = 0; this.hits = 0; this.powerUps = 0; this.sample = 0; this.idle = Infinity;
    this.configure({});
  }
  configure({ enabled = false, volume = .6, crunch = .5, sound = 'console', lead = [], bass = [], drums = [], chords = true, drumsOn = true, tonic = 0, minor = false } = {}) {
    this.enabled = enabled; this.volume = Math.max(0, Math.min(1, volume)); this.sound = CHIP_SOUNDS[sound] ?? CHIP_SOUNDS.console;
    this.crunch = Math.max(0, Math.min(1, crunch)); this.tonic = ((tonic % 12) + 12) % 12; this.minor = Boolean(minor);
    // Crunch: 0 leaves the record clean; 50% is 8-bit at 8 kHz; 100% is 4-bit at 4 kHz.
    this.bits = Math.round(12 - 8 * this.crunch); this.holdStep = this.sampleRate / (16000 * .25 ** this.crunch);
    // Patterns: lead digits are pentatonic degrees of the song's key (0 tonic … 5 octave);
    // bass digits 0 root, 1 octave, 2 fifth of the chord; -1 rests, null holds; drums are
    // 'k' kick, 's' snare, 'h' hat per sixteenth.
    this.leadSteps = lead; this.bassSteps = bass; this.drumSteps = drums; this.useChords = Boolean(chords); this.useDrums = Boolean(drumsOn);
    if (!enabled) { this.lead.on = this.stab.on = this.bass.on = false; this.jingle.pending = false; } else this.idle = 0;
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
  /** Power up: the jingle starts on the next beat. */
  powerUp() { if (this.enabled) this.jingle.pending = true; }
  // Steps a note lasts: itself plus the holds after it.
  span(steps, i) { let n = 1; while (n < steps.length && steps[(i + n) % steps.length] === null) n++; return n; }

  /** Called on each sixteenth the read head enters while playing forward. */
  onStep(step, t) {
    const i = ((step % PHRASE) + PHRASE) % PHRASE, inBar = i % 16, chord = this.chordAt(t + .03), sixteenth = this.stepLength / this.speed;
    const third = chord.minor ? 3 : 4, tones = [0, third, 7].map(p => (chord.root + p) % 12);
    const lead = this.leadSteps.length ? this.leadSteps[i % this.leadSteps.length] : -1;
    if (lead === -1) this.lead.on = false;
    else if (Number.isInteger(lead)) {
      // Tonic between G4 and F♯5, so the melody sings around 500–1200 Hz.
      const scale = SCALES[this.minor ? 'minor' : 'major'];
      let midi = 67 + ((this.tonic - 7 + 12) % 12) + scale[lead % 5] + 12 * Math.floor(lead / 5);
      // On the beat, land on the chord: move to the nearest chord tone (within a tone).
      if (i % 4 === 0 && !tones.includes(midi % 12)) for (const shift of [-1, 1, -2, 2]) if (tones.includes((midi + shift + 12) % 12)) { midi += shift; break; }
      const length = this.span(this.leadSteps, i % this.leadSteps.length) * sixteenth;
      Object.assign(this.lead, { on: true, frequency: hz(midi), time: 0, until: length * .8 }); this.notes++;
    }
    const bass = this.bassSteps.length ? this.bassSteps[i % this.bassSteps.length] : -1;
    if (bass === -1) this.bass.on = false;
    else if (Number.isInteger(bass)) {
      const midi = 40 + ((chord.root - 4 + 12) % 12) + [0, 12, 7][bass];  // E2–E♭3 root
      const length = this.span(this.bassSteps, i % this.bassSteps.length) * sixteenth;
      Object.assign(this.bass, { on: true, frequency: hz(midi), time: 0, until: length * .8 }); this.bassNotes++;
    }
    // Chip chords: an offbeat-eighth stab arpeggiating the chord (root, third, fifth) between C4 and B4.
    if (this.useChords && inBar % 4 === 2) {
      const root = 60 + chord.root;
      Object.assign(this.stab, { on: true, notes: [root, root + third, root + 7].map(hz), time: 0, until: sixteenth * 1.6 }); this.stabs++;
    }
    if (this.useDrums && this.drumSteps.length) {
      const hit = this.drumSteps[inBar % this.drumSteps.length];
      if (hit === 'k') { this.kick.time = 0; this.kick.phase = 0; this.hits++; }
      if (hit === 's') { this.snare.time = 0; this.hits++; }
      if (hit === 'h') { this.hat.time = 0; this.hits++; }
    }
    // Power-up jingle on the beat: two octaves of the key chord rising in 32nd-ish steps.
    if (this.jingle.pending && i % 4 === 0) {
      const base = 67 + ((this.tonic - 7 + 12) % 12), triad = [0, this.minor ? 3 : 4, 7];
      this.jingle = { time: 0, phase: 0, pending: false, notes: Array.from({ length: 9 }, (_, n) => hz(base - 12 + triad[n % 3] + 12 * Math.floor(n / 3))) };
      this.powerUps++;
    }
  }

  /** Advance one sample. `t` is the read head in song seconds, `beat` the fractional beat
   * (null without a grid), `rate` the signed playback rate (0 while scrubbing or seeking)
   * and `interval` the current beat length in song seconds. */
  step(t, beat, downbeat, rate, interval = .5) {
    // Off, and the release and echo tails have died away (2 s): nothing to do.
    if (!this.enabled && this.idle > 2 * this.sampleRate) { this.sample = 0; this.lastBeat = beat; return; }
    if (!this.enabled) this.idle++;
    this.speed = Math.max(.25, Math.min(4, Math.abs(rate) || 1)); this.stepLength = interval / 4;
    const forward = this.enabled && rate > .3;
    if (forward && beat !== null && this.lastBeat !== null) {
      const now = Math.floor((beat - downbeat) * 4), before = Math.floor((this.lastBeat - downbeat) * 4);
      if (now > before && beat - this.lastBeat < .125) this.onStep(now, t);
    }
    if (!forward) { this.lead.on = this.stab.on = this.bass.on = false; }
    this.lastBeat = beat;
    const sr = this.sampleRate, dt = 1 / sr, speed = this.speed, chip = this.sound;
    this.clock += dt;
    // Lead: pulse (band-limited edges), quick decay to a sustain, late vibrato; Computer
    // sweeps the pulse width and runs it through a resonant low-pass that closes per note.
    const L = this.lead; let lead = 0;
    if (L.on && L.time >= L.until) L.on = false;
    if (L.on || L.amp > 1e-4) {
      L.amp += ((L.on ? .75 + .25 * Math.exp(-L.time / .06) : 0) - L.amp) * (1 - Math.exp(-dt / (L.on ? .001 : .008)));
      const vibrato = L.time > .15 ? 1 + .007 * Math.sin(2 * Math.PI * 6 * L.time) * Math.min(1, (L.time - .15) / .1) : 1;
      const increment = L.frequency * speed * vibrato / sr; L.phase += increment; if (L.phase >= 1) L.phase -= 1;
      const duty = chip.duty + chip.pwm * Math.sin(2 * Math.PI * 1.2 * this.clock);
      let pulse = pulseWave(L.phase, increment, duty);
      if (chip.filter) pulse = this.lowpass(L.filter, pulse, 900 + 3600 * Math.exp(-L.time / .12), 2.2);
      lead = pulse * L.amp; L.time += dt;
    }
    // Dotted-eighth echo on the lead, the classic trick for a fuller chip melody.
    const target = Math.max(.05 * sr, Math.min(1.9 * sr, .75 * interval / speed * sr));
    this.echoDelay += (target - this.echoDelay) * .0005;
    const size = this.echo.length, read = (this.echoWrite - this.echoDelay + size) % size, index = Math.floor(read), fraction = read - index;
    const echoed = this.echo[index] * (1 - fraction) + this.echo[(index + 1) % size] * fraction;
    this.echo[this.echoWrite] = lead + echoed * .3; this.echoWrite = (this.echoWrite + 1) % size;
    // Chip chords: one voice cycling root → third → fifth at the chip's frame rate.
    const C = this.stab; let stab = 0;
    if (C.on && C.time >= C.until) C.on = false;
    if (C.on || C.amp > 1e-4) {
      C.amp += ((C.on ? Math.exp(-C.time / .12) : 0) - C.amp) * (1 - Math.exp(-dt / (C.on ? .001 : .006)));
      const frequency = C.notes[Math.floor(C.time * chip.arp) % 3] * speed, increment = frequency / sr;
      C.phase += increment; if (C.phase >= 1) C.phase -= 1;
      stab = pulseWave(C.phase, increment, chip.stab) * C.amp; C.time += dt;
    }
    // Bass: stepped 4-bit triangle, 4-bit wavetable or filtered saw, by chip.
    const B = this.bass; let bass = 0;
    if (B.on && B.time >= B.until) B.on = false;
    if (B.on || B.amp > 1e-4) {
      B.amp += ((B.on ? 1 : 0) - B.amp) * (1 - Math.exp(-dt / (B.on ? .001 : .008)));
      const increment = B.frequency * speed / sr; B.phase += increment; if (B.phase >= 1) B.phase -= 1;
      let raw;
      if (chip.bass === 'triangle') raw = Math.round(2 * Math.abs(B.phase - .5) * 15) / 15 * 2 - 1;
      else if (chip.bass === 'wave') raw = WAVE[Math.floor(B.phase * 32)];
      else { raw = 2 * B.phase - 1 - blep(B.phase, increment); B.tone += (raw - B.tone) * (1 - Math.exp(-2 * Math.PI * 900 / sr)); raw = B.tone * 1.4; }
      bass = raw * B.amp; B.time += dt;
    }
    // Drums: a triangle kick dropping 180→50 Hz; snare and hats from the shift register
    // (clocked ~11 kHz for the snare, ~24 kHz for hats), short and dry like a sound chip.
    let drums = 0;
    if (this.kick.time < .12) { const k = this.kick, f = (50 + 130 * Math.exp(-k.time / .018)) * speed; k.phase = (k.phase + f / sr) % 1; drums += (1 - 4 * Math.abs(k.phase - .5)) * Math.exp(-k.time / .04) * .6; k.time += dt; }
    if (this.snare.time < .2) { const s = this.snare.time; drums += this.noise(11025) * Math.exp(-s / .045) * .45 + Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s / .025) * .3; this.snare.time += dt; }
    if (this.hat.time < .06) { const h = this.hat.time; drums += this.noise(24000) * Math.exp(-h / .015) * .2; this.hat.time += dt; }
    // Power-up jingle: rising 45 ms square notes with a final pitch lift, plus a noise sweep.
    let jingle = 0;
    if (this.jingle.time < .55) {
      const J = this.jingle, n = Math.min(J.notes.length - 1, Math.floor(J.time / .045)), lift = J.time > .4 ? 2 ** ((J.time - .4) * 2) : 1;
      const increment = J.notes[n] * speed * lift / sr; J.phase += increment; if (J.phase >= 1) J.phase -= 1;
      jingle = pulseWave(J.phase, increment, .5) * Math.min(1, J.time / .002) * (J.time < .45 ? 1 : 1 - (J.time - .45) / .1) * .9;
      J.time += dt;
    }
    const band = lead * .13 + echoed * .045 + stab * .07 + bass * .28 + drums * .3 + jingle * .14;
    this.sample = Math.tanh(1.2 * band) / Math.tanh(1.2) * this.volume;
  }
  // Shift-register noise held at `clock` Hz: 15-bit (hiss) or 7-bit (metallic) by chip.
  noise(clock) {
    const n = this.lfsr;
    if ((n.count -= clock / this.sampleRate) <= 0) {
      n.count += 1;
      const feedback = (n.register ^ (n.register >> 1)) & 1;
      n.register = (n.register >> 1) | (feedback << 14);
      if (this.sound.noise === 7) n.register = (n.register & ~(1 << 6)) | (feedback << 6);
      n.value = n.register & 1 ? -1 : 1;
    }
    return n.value;
  }
  // Resonant low-pass (TPT state-variable filter).
  lowpass(state, x, cutoff, q) {
    const g = Math.tan(Math.PI * Math.min(cutoff, this.sampleRate * .45) / this.sampleRate), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - state[1], v1 = a1 * state[0] + a2 * v3, v2 = state[1] + a2 * state[0] + a3 * v3;
    state[0] = 2 * v1 - state[0]; state[1] = 2 * v2 - state[1];
    return v2;
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
    return music * (1 - .3 * this.volume) + this.sample;
  }
}
// Band-limited pulse of the given duty, centred on zero.
function pulseWave(phase, increment, duty) {
  return (phase < duty ? 1 : -1) + blep(phase, increment) - blep((phase + 1 - duty) % 1, increment) + (1 - 2 * duty);
}
// PolyBLEP correction for a band-limited step at phase 0.
function blep(phase, increment) {
  if (phase < increment) { const x = phase / increment; return x + x - x * x - 1; }
  if (phase > 1 - increment) { const x = (phase - 1) / increment; return x * x + x + x + 1; }
  return 0;
}
