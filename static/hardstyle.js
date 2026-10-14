/** Hardstyle mode: a small synthesized hardstyle kit on 16-step lanes (kick, clap, hat),
 * crashes and drops, clocked by the beat grid at the read head's song time and tuned to the
 * song's key. Built the way producers build it: a kick with a click and a fast pitch drop into
 * a saturated, pitched tail; a layered noise clap; an open hat; a long crash. A drop is a
 * one-bar build (rising kick roll, clap roll, riser, music filtered thinner), a one-beat
 * pause, then crash + kick (+ an optional air horn) on the next downbeat.
 * Hits fire only while the record plays forward (never stopped, scrubbing or seeking) and
 * retune with the playback rate, so they stay in key at 45/78 RPM and with pitch moves. */
const BAR = 16; // sixteenths per bar

/** Kick sounds (hard dance schools). click/body: pitch-drop components (Hz, decay s);
 * bend: semitones the tail glides down from; drive/decay scale the sliders; formant adds a
 * nasal ~900 Hz screech; octave lifts the tail; rumble adds a techno rumble between kicks. */
export const KICK_SOUNDS = Object.freeze({
  euphoric: { click: 1800, clickTau: .004, body: 220, bodyTau: .04, bend: 0, drive: 1, hold: .045, decay: 1, formant: 0, octave: 0, rumble: 0 },
  raw: { click: 2400, clickTau: .003, body: 420, bodyTau: .07, bend: 4, drive: 1.6, hold: .05, decay: 1.15, formant: .55, octave: 0, rumble: 0 },
  techno: { click: 1100, clickTau: .003, body: 160, bodyTau: .035, bend: 0, drive: .45, hold: .03, decay: .4, formant: 0, octave: 0, rumble: 1 },
  gabber: { click: 3000, clickTau: .003, body: 320, bodyTau: .03, bend: 0, drive: 2.4, hold: .02, decay: .35, formant: .3, octave: 1, rumble: 0 },
});

class Rng {
  constructor(seed) { this.state = Math.max(1, Math.floor(seed) % 2147483647); }
  next() { this.state = (this.state * 16807) % 2147483647; return this.state / 2147483647; }
}

export class HardstyleKick {
  constructor(sampleRate) {
    this.sampleRate = sampleRate; this.lastBeat = null; this.noise = new Rng(22222); this.speed = 1;
    this.voice = { time: Infinity, phase: 0, speed: 1, rise: 0, tone: 0, formant: [0, 0, 0] };
    this.rumble = { phase: 0, low: 0, out: 0, noise: 0, since: Infinity }; this.bus = { high: [] };
    this.clap = { time: Infinity, band: [0, 0, 0] }; this.hat = { time: Infinity, high: [] }; this.crash = { time: Infinity, high: [] };
    this.horn = { time: Infinity, phases: [0, 0, 0], low: 0 }; this.riser = { high: [] };
    this.fired = 0; this.claps = 0; this.hats = 0; this.crashes = 0; this.drops = 0; this.horns = 0;
    this.sample = 0; this.duck = 0; this.musicGain = 1; this.musicHigh = []; this.highCut = 0;
    this.drop = null; this.pendingDrop = false;
    this.smooth = 1 - Math.exp(-2 * Math.PI * 9000 / sampleRate);  // tame kick fizz above ~9 kHz
    this.configure({});
  }
  configure({ enabled = false, volume = .7, drive = .6, tail = .5, tune = 55, steps = [true, false, false, false], clap = [], hat = [],
    crashEvery = 0, drops = false, horn = false, seed = 1, duck = .6, sound = 'euphoric' } = {}) {
    this.enabled = enabled; this.volume = Math.max(0, Math.min(1, volume)); this.sound = KICK_SOUNDS[sound] ?? KICK_SOUNDS.euphoric;
    this.drive = (2 + Math.max(0, Math.min(1, drive)) * 18) * this.sound.drive;
    this.decay = (.08 + Math.max(0, Math.min(1, tail)) * .4) * this.sound.decay; this.tune = tune; this.duckAmount = Math.max(0, Math.min(.9, duck));
    // Lanes: one bar of sixteenths each; a hit fires when the read head enters a filled step.
    this.steps = steps.map(Boolean); this.clapSteps = clap.map(Boolean); this.hatSteps = hat.map(Boolean);
    this.crashEvery = Math.max(0, crashEvery); this.autoDrops = Boolean(drops); this.useHorn = Boolean(horn);
    if (this.seed !== seed) { this.seed = seed; this.rng = new Rng(seed * 7919 + 1); }
    if (!enabled) { this.drop = null; this.pendingDrop = false; }
  }
  /** Ask for a drop: the build starts at the next bar line. */
  requestDrop() { if (this.enabled) this.pendingDrop = true; }
  white() { return this.noise.next() * 2 - 1; }
  lane(steps, inBar) { return steps.length ? steps[inBar % steps.length] : false; }

  /** Called on each sixteenth the read head enters while playing forward. */
  onStep(step) {
    const inBar = ((step % BAR) + BAR) % BAR, bar = Math.floor(step / BAR);
    if (inBar === 0) {
      if (this.drop && bar > this.drop.bar) this.drop = null;
      // Drops start on bar lines: a manual request, or a random one ending an 8-bar phrase.
      if (!this.drop && (this.pendingDrop || (this.autoDrops && bar % 8 === 7 && this.rng.next() < .45))) {
        this.drop = { build: bar, bar: bar + 1 }; this.pendingDrop = false; this.drops++;
      }
    }
    const building = this.drop && bar === this.drop.build, landing = this.drop && bar === this.drop.bar && inBar === 0;
    if (building && inBar >= 12) return; // the one-beat pause right before the drop
    if (building || this.lane(this.steps, inBar)) this.trigger('kick', building ? inBar / 12 : 0);
    if (building ? inBar >= 8 && inBar % 2 === 0 : this.lane(this.clapSteps, inBar)) this.trigger('clap');
    if (!building && this.lane(this.hatSteps, inBar)) this.trigger('hat');
    if (landing || (!building && inBar === 0 && this.crashEvery && bar % this.crashEvery === 0)) this.trigger('crash');
    if (landing && this.useHorn) this.trigger('horn');
  }
  trigger(name, rise = 0) {
    if (name === 'kick') { Object.assign(this.voice, { time: 0, phase: 0, rise, speed: this.speed }); this.rumble.since = 0; this.fired++; }
    if (name === 'clap') { this.clap.time = 0; this.claps++; }
    if (name === 'hat') { this.hat.time = 0; this.hats++; }
    if (name === 'crash') { this.crash.time = 0; this.crashes++; }
    if (name === 'horn') { this.horn.time = 0; this.horn.phases = [0, 0, 0]; this.horns++; }
  }

  /** Advance one sample. `beat` is the fractional beat index (null without a grid), `rate`
   * the signed playback rate (0 while scrubbing or seeking). */
  step(beat, downbeat, rate) {
    this.speed = Math.max(.25, Math.min(4, Math.abs(rate) || 1));
    if (beat !== null && this.lastBeat !== null && this.enabled && rate > .3) {
      const now = Math.floor((beat - downbeat) * 4), before = Math.floor((this.lastBeat - downbeat) * 4);
      if (now > before && beat - this.lastBeat < .125) this.onStep(now);
    }
    this.lastBeat = beat;
    const sr = this.sampleRate, dt = 1 / sr;
    let out = 0;
    // Kick: click + pitch drop ("tok") into the tuned, saturated tail, shaped by the sound;
    // build rolls rise an octave. Rawstyle bends into the note and adds a nasal formant.
    const k = this.voice, sound = this.sound;
    if (k.time < this.decay * 6 + .1) {
      const t = k.time, note = this.tune * 2 ** (k.rise + sound.octave + sound.bend * Math.exp(-t / .08) / 12);
      const frequency = (note + sound.click * Math.exp(-t / sound.clickTau) + sound.body * Math.exp(-t / sound.bodyTau)) * k.speed;
      k.phase += 2 * Math.PI * frequency / sr;
      const amplitude = Math.min(1, t / .0015) * (t < sound.hold ? 1 : Math.exp(-(t - sound.hold) / this.decay));
      let driven = Math.tanh(this.drive * (Math.sin(k.phase) * amplitude + this.white() * Math.exp(-t / .0012) * .6)) / Math.tanh(this.drive);
      if (sound.formant) driven += sound.formant * this.band(k.formant, driven, 900);
      k.tone += (driven - k.tone) * this.smooth;
      out += k.tone * .85 * Math.min(1, amplitude * 4);
      this.duck = this.duckAmount * Math.exp(-t / .14) * Math.min(1, t / .003);
      k.time += dt;
    } else this.duck = 0;
    // Clap: three quick noise bursts and a short tail, band-passed around 1.3 kHz.
    if (this.clap.time < .4) {
      const t = this.clap.time, bursts = (t >= 0 ? Math.exp(-t / .006) : 0) + (t >= .011 ? Math.exp(-(t - .011) / .006) : 0) + (t >= .022 ? Math.exp(-(t - .022) / .006) : 0) + .5 * Math.exp(-t / .12);
      out += this.band(this.clap.band, this.white() * bursts, 1300) * .55; this.clap.time += dt;
    }
    // Open hat: high-passed noise, ~90 ms.
    if (this.hat.time < .35) { const t = this.hat.time; out += this.high(this.hat.high, this.white(), 7000, 2) * Math.exp(-t / .09) * .28; this.hat.time += dt; }
    // Crash: long, bright, shimmering noise.
    if (this.crash.time < 3) { const t = this.crash.time; out += this.high(this.crash.high, this.white(), 3500, 1) * Math.min(1, t / .004) * Math.exp(-t / 1.4) * .32; this.crash.time += dt; }
    // Air horn: three detuned saws, "BWAAA bwa bwa", two octaves above the kick's root.
    if (this.horn.time < 1.1) {
      const t = this.horn.time, f = this.tune * 4 * this.speed, gate = (t < .55) || (t > .64 && t < .78) || (t > .86 && t < 1.04) ? 1 : 0;
      const vibrato = 1 + .006 * Math.sin(2 * Math.PI * 6 * t); let saw = 0;
      for (let i = 0; i < 3; i++) { this.horn.phases[i] = (this.horn.phases[i] + f * [1, 1.006, .994][i] * vibrato / sr) % 1; saw += 2 * this.horn.phases[i] - 1; }
      this.horn.low += (saw / 3 * gate - this.horn.low) * (1 - Math.exp(-2 * Math.PI * 2800 / sr));
      out += this.horn.low * .42; this.horn.time += dt;
    }
    // Techno drive: a distorted, low-passed sub rumble on the root that swells between kicks
    // (ducked at each kick, blooming mid-beat), the hard-techno "brrrm".
    if (sound.rumble && this.rumble.since < 2) {
      const r = this.rumble, t = r.since, swell = (1 - Math.exp(-t / .07)) * Math.exp(-t / .55);
      r.phase += 2 * Math.PI * this.tune * this.speed / sr;
      r.noise += (this.white() - r.noise) * (1 - Math.exp(-2 * Math.PI * 140 / sr));
      const grit = Math.tanh(3.2 * (Math.sin(r.phase) * .7 + r.noise * 2.2));
      r.low += (grit - r.low) * (1 - Math.exp(-2 * Math.PI * 240 / sr));
      out += r.low * swell * .75 * sound.rumble; r.since += dt;
    }
    // Drop build: a riser and the music filtered thinner, then the one-beat pause dips the music.
    let musicGain = 1, highCut = 0;
    if (this.drop && beat !== null) {
      const barPosition = (beat - downbeat) / 4 - this.drop.build;
      if (barPosition >= 0 && barPosition < 1) {
        highCut = barPosition < .75 ? 30 * (1400 / 30) ** (barPosition / .75) : 1400;
        musicGain = barPosition >= .75 ? .12 : 1;
        if (barPosition < .75) out += this.high(this.riser.high, this.white(), 2000 + 6000 * barPosition, 1) * .18 * (barPosition / .75) ** 2;
      }
    }
    this.highCut += (highCut - this.highCut) * .002;
    this.musicGain += (musicGain - this.musicGain) * .004;
    // Kit bus: clean up sub-25 Hz and glue the drums with a gentle soft clip (master clipper).
    this.sample = Math.tanh(1.3 * this.high(this.bus.high, out, 25, 1)) / Math.tanh(1.3) * this.volume;
  }
  // One-pole high-pass stages with per-voice state (cheap and stable at any sample rate).
  high(state, x, cutoff, stages) {
    const a = Math.exp(-2 * Math.PI * cutoff / this.sampleRate); let y = x;
    for (let i = 0; i < stages; i++) { const input = y; y = a * ((state[i * 2 + 1] ?? 0) + input - (state[i * 2] ?? 0)); state[i * 2] = input; state[i * 2 + 1] = y; }
    return y;
  }
  // Rough band-pass: one-pole low-pass then one-pole high-pass around `center`.
  band(state, x, center) {
    state[0] += (x - state[0]) * (1 - Math.exp(-2 * Math.PI * center * 1.6 / this.sampleRate));
    const a = Math.exp(-2 * Math.PI * center / 1.6 / this.sampleRate), y = a * (state[1] + state[0] - state[2]);
    state[2] = state[0]; state[1] = y; return y * 2.5;
  }
  /** The music under the kit (kick sidechain duck, drop high-pass and pause), plus the kit. */
  apply(value, channel = 0) {
    let music = value;
    if (this.highCut > 31) {
      const a = Math.exp(-2 * Math.PI * this.highCut / this.sampleRate), s = this.musicHigh, y = a * ((s[channel * 2 + 1] ?? 0) + music - (s[channel * 2] ?? 0));
      s[channel * 2] = music; s[channel * 2 + 1] = y; music = y;
    }
    return music * this.musicGain * (1 - this.duck * this.volume) + this.sample;
  }
}
