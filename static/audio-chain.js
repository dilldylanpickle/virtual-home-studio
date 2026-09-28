/** The worklet supplies source + mechanics + imperfections; coloration stays separate. */
export class CartridgeOutput {
  constructor(context, volume) {
    this.context = context;
    this.input = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.subsonic = context.createBiquadFilter();
    this.subsonic.type = 'highpass'; this.subsonic.frequency.value = 18; this.subsonic.Q.value = .5;
    this.topEnd = context.createBiquadFilter();
    this.topEnd.type = 'highshelf'; this.topEnd.frequency.value = 8500; this.topEnd.gain.value = -1.2;
    // Rare near-full-scale music + defect peaks get a smooth knee, after all coloration.
    // Normal program levels stay linear. This bound also covers filter overshoot.
    this.safety = context.createWaveShaper();
    const curve = new Float32Array(65537);
    for (let i = 0; i < curve.length; i++) {
      const x = i * 2 / (curve.length - 1) - 1, a = Math.abs(x);
      curve[i] = a <= .9 ? x : Math.sign(x) * (.9 + .08 * (1 - Math.exp(-(a - .9) / .08)));
    }
    this.safety.curve = curve;
    this.output = context.createGain(); this.output.gain.value = volume;
    this.input.connect(this.dry).connect(this.safety);
    this.input.connect(this.subsonic).connect(this.topEnd).connect(this.wet).connect(this.safety);
    this.safety.connect(this.output);
    this.wet.gain.value = 0;
    this.output.connect(context.destination);
  }
  color(enabled) {
    const now = this.context.currentTime;
    this.dry.gain.setTargetAtTime(enabled ? 0 : 1, now, .02);
    this.wet.gain.setTargetAtTime(enabled ? 1 : 0, now, .02);
  }
}
