import { CONDITIONS, DEFAULT_CONDITION } from './condition-profiles.js';

const PROFILE_KEYS = Object.keys(CONDITIONS.Mint).filter(key => key !== 'visualWear');
const TAU = 2 * Math.PI;
/** Procedural groove/contact signal and condition wear, on the shared audio clock. */
export class VinylImperfections {
  constructor(rate) {
    this.sampleRate = rate; this.seed = 0x72656364;
    this.settings = { surface: true, contacts: true, condition: DEFAULT_CONDITION, wow: 0, centering: 0 };
    this.profile = {}; this.targetProfile = {};
    for (const key of PROFILE_KEYS) this.profile[key] = this.targetProfile[key] = CONDITIONS[DEFAULT_CONDITION][key];
    this.profileRamp = 0;
    this.highGain = this.targetHighGain = Math.pow(10, -this.profile.highFrequencyLoss / 20);
    this.wearFilter = [0, 0]; this.toneFilter = [0, 0];
    this.wearCoefficient = 1 - Math.exp(-TAU * 6500 / rate);
    this.toneCoefficient = 1 - Math.exp(-TAU * 1800 / rate);
    this.noiseLow = 0; this.noiseMid = 0; this.noiseFast = 0;
    this.noiseCoefficients = [35, 350, 7000].map(hz => 1 - Math.exp(-TAU * hz / rate));
    this.contactAge = 1; this.contactLevel = 0; this.contactFrequency = 80;
    this.motionGain = 0; this.sideNoise = 0;
    // Independent, bounded pools: a pop never cuts off a fine crackle burst.
    this.crackleVoices = Array.from({ length: 8 }, () => this.voice());
    this.popVoices = Array.from({ length: 4 }, () => this.voice());
    this.crackleIndex = 0; this.popIndex = 0;
    this.contacts = 0; this.pops = 0; this.crackles = 0;
  }
  voice() { return { remaining: 0, amplitude: 0, decay: 0, phase: 0, step: 0, texture: 0, pan: 0 }; }
  random() {
    let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0; return this.seed / 4294967296;
  }
  configure(settings = {}) {
    const s = this.settings, previous = `${s.condition}:${s.surface}`;
    for (const key of ['surface', 'contacts']) if (typeof settings[key] === 'boolean') s[key] = settings[key];
    if (Object.hasOwn(CONDITIONS, settings.condition)) s.condition = settings.condition;
    for (const key of ['wow', 'centering']) if (Number.isFinite(settings[key])) s[key] = Math.max(0, Math.min(1, settings[key]));
    if (`${s.condition}:${s.surface}` !== previous) {
      const selected = CONDITIONS[s.condition];
      for (const key of PROFILE_KEYS) this.targetProfile[key] = s.surface ? selected[key] : 0;
      this.targetHighGain = Math.pow(10, -this.targetProfile.highFrequencyLoss / 20);
      this.profileRamp = Math.round(this.sampleRate * .06);
    }
  }
  contact(down) {
    if (!this.settings.contacts) return;
    this.contactAge = 0; this.contactLevel = down ? .021 : .010; this.contactFrequency = down ? 78 : 125;
    this.contacts++;
  }
  clear() {
    this.contactLevel = 0; this.motionGain = 0; this.sideNoise = 0;
    this.wearFilter.fill(0); this.toneFilter.fill(0);
    for (const voice of this.crackleVoices) voice.remaining = 0;
    for (const voice of this.popVoices) voice.remaining = 0;
  }
  wow(time) { return this.settings.wow * (.0009 * Math.sin(time * TAU * .61) + .00015 * Math.sin(time * TAU * 8.3)); }
  eccentricity(travel) { return this.settings.centering * .002 * Math.sin(travel * 200 * Math.PI / 180); }
  color(value, channel) {
    const p = this.profile;
    this.wearFilter[channel] += this.wearCoefficient * (value - this.wearFilter[channel]);
    const softened = value + p.wearAmount * (this.wearFilter[channel] - value);
    this.toneFilter[channel] += this.toneCoefficient * (softened - this.toneFilter[channel]);
    const tone = this.toneFilter[channel] + (softened - this.toneFilter[channel]) * this.highGain;
    // Parallel soft saturation mostly affects loud grooves, with no loudness boost.
    return tone + p.saturation * (Math.tanh(tone * 2.4) / 2.4 - tone);
  }
  trigger(pop) {
    const p = this.profile;
    const voices = pop ? this.popVoices : this.crackleVoices;
    const index = pop ? this.popIndex++ : this.crackleIndex++;
    const v = voices[index % voices.length];
    const variation = p.transientVariation;
    const duration = pop ? .0012 + this.random() * .0048 : .0003 + this.random() ** 2 * .0015;
    let amplitude = (pop ? p.popGain : p.crackleGain) * (.25 + .75 * this.random() ** (1 + variation));
    if (pop && this.random() < .1 * variation) amplitude *= 1.6;
    v.amplitude = amplitude * (this.random() < .5 ? -1 : 1);
    v.remaining = Math.ceil(duration * this.sampleRate);
    v.decay = Math.exp(-1 / (this.sampleRate * duration * .24));
    v.phase = 0; v.step = TAU * (pop ? 150 + this.random() * 1800 : 1800 + this.random() * 6200) / this.sampleRate;
    v.texture = .12 + this.random() * .55; v.pan = (this.random() * 2 - 1) * .4;
    if (pop) this.pops++; else this.crackles++;
  }
  defects(voices, white) {
    let value = 0;
    for (const v of voices) {
      if (!v.remaining) continue;
      const sample = v.amplitude * ((1 - v.texture) * Math.cos(v.phase) + v.texture * white);
      value += sample; this.sideNoise += sample * v.pan;
      v.phase += v.step; v.amplitude *= v.decay; v.remaining--;
    }
    return value;
  }
  sample(contact, moving, powered, region, speed) {
    if (this.profileRamp > 0) {
      for (const key of PROFILE_KEYS) this.profile[key] += (this.targetProfile[key] - this.profile[key]) / this.profileRamp;
      this.highGain += (this.targetHighGain - this.highGain) / this.profileRamp;
      this.profileRamp--;
    }
    const dt = 1 / this.sampleRate, p = this.profile;
    const white = this.random() * 2 - 1;
    this.noiseLow += this.noiseCoefficients[0] * (white - this.noiseLow);
    this.noiseMid += this.noiseCoefficients[1] * (white - this.noiseMid);
    this.noiseFast += this.noiseCoefficients[2] * (white - this.noiseFast);
    const movingContact = contact && moving && powered && this.settings.surface;
    const target = movingContact ? Math.min(1, Math.abs(speed) / .1) : 0;
    this.motionGain += Math.max(-dt / .006, Math.min(dt / .006, target - this.motionGain));
    if (movingContact && this.random() < p.crackleDensity * dt) this.trigger(false);
    if (movingContact && this.random() < p.popRate * dt) this.trigger(true);
    const texture = .7 * (this.noiseFast - this.noiseLow) + p.noiseColor * (2 * this.noiseMid + 3 * this.noiseLow);
    this.sideNoise = (this.random() * 2 - 1) * p.surfaceNoise * .045;
    const fine = this.defects(this.crackleVoices, white), pops = this.defects(this.popVoices, white);
    const groove = region === 'music' ? 1 : 1.25;
    let value = (texture * p.surfaceNoise * groove + fine + pops) * this.motionGain;
    this.sideNoise *= this.motionGain;
    if (this.settings.contacts && this.contactAge < .045 && powered) {
      const t = this.contactAge;
      value += this.contactLevel * Math.exp(-t / .007) * (Math.sin(t * TAU * this.contactFrequency) + .22 * white);
    }
    this.contactAge += dt;
    return value;
  }
}
