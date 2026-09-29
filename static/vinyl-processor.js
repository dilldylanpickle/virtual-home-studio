import { PlatterMotor } from './mechanics.js';
import { VinylImperfections } from './vinyl-effects.js';

/** One PCM reader and one audio clock own motor, scratching and virtual grooves. */
class VinylProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = []; this.length = 0; this.fileRate = sampleRate;
    this.position = 0; this.runIn = 1.4; this.paused = false; this.tailPosition = 0;
    this.seek = null;
    // Pointer anchors are exact. Only this short-lived audible readhead extrapolates
    // between packets, so stationary input never leaves a destination to catch up to.
    this.directScrub = false; this.manualScrub = false; this.scrubReadPosition = 0; this.scrubVelocity = 0;
    this.scrubAge = Infinity; this.scrubWindow = .024; this.scrubGain = .9; this.pausedScrubRelease = false;
    this.travel = 0; this.targetTravel = 0; this.rate = 0;
    this.motor = new PlatterMotor(); this.effects = new VinylImperfections(sampleRate);
    this.motorRate = 0; this.motorActualRate = 0; this.motorTravel = 0;
    this.rpm = null; this.enabled = false; this.contact = false; this.powered = true;
    this.holding = false; this.revision = 0; this.rampRemaining = 0;
    this.gain = 0; this.colored = [0, 0]; this.last = [0, 0]; this.blendFrom = [0, 0]; this.blendRemaining = 0;
    this.reportFrames = 0; this.clock = 0; this.playbackEnds = 0;
    this.fadeFrames = Math.max(1, Math.round(sampleRate * .004));
    this.follow = 1 - Math.exp(-1 / (sampleRate * .006));
    this.port.onmessage = ({ data }) => this.command(data);
  }
  get region() { return this.position < 0 ? 'run-in' : this.position >= this.length ? 'run-out' : 'music'; }
  command(data) {
    if (data.type === 'settings') this.effects.configure(data.settings);
    if (data.type === 'load') {
      this.channels = data.channels; this.length = this.channels[0]?.length ?? 0;
      this.fileRate = data.sampleRate; this.position = 0; this.seek = null;
      this.clearScrub();
      this.gain = 0; this.last.fill(0); this.blendRemaining = 0; this.effects.clear();
    }
    if (data.type === 'clear') {
      this.channels = []; this.length = 0; this.position = 0; this.seek = null;
      this.clearScrub();
      this.enabled = false; this.contact = false; this.paused = false; this.effects.clear();
    }
    if (data.type === 'control') {
      this.revision = data.revision;
      const contact = data.contact ?? data.enabled;
      this.powered = data.powered ?? true;
      if (contact !== this.contact && this.length && this.powered) this.effects.contact(contact);
      this.contact = contact; this.enabled = data.enabled;
      const wasPaused = this.paused;
      this.paused = data.pause === true;
      const pauseChanged = wasPaused !== this.paused;
      const rpmChanged = data.rpm !== this.rpm;
      const correction = !rpmChanged && this.motorRate > 0 && data.motorRate > 0;
      if (pauseChanged && this.paused) {
        // Continue the audible readhead without a seek; only the logical anchor freezes.
        this.tailPosition = this.position;
        if (Number.isFinite(data.pausePosition)) this.position = Math.max(-this.runIn * this.fileRate, Math.min(this.length, data.pausePosition * this.fileRate));
      }
      if (pauseChanged && !this.paused) {
        this.pausedScrubRelease = false;
        this.blendFrom = [...this.last]; this.blendRemaining = this.fadeFrames;
      }
      this.motorRate = data.motorRate; this.rpm = data.rpm;
      // HUD transport and physical START/STOP share the same motor inertia.
      this.motor.setTarget(this.motorRate, data.immediate === true, correction ? .035 : null);
      if (data.cancelSeek || data.holding || data.position !== undefined) {
        this.seek = null; this.tailPosition = this.position;
      }
      if (data.position !== undefined) {
        this.clearScrub();
        this.position = data.runIn && data.position === 0 ? -this.runIn * this.fileRate : Math.max(0, Math.min(this.length, data.position * this.fileRate));
        this.blendFrom = [...this.last]; this.blendRemaining = this.fadeFrames;
        this.tailPosition = this.position;
        if (data.grooveScrub === true) {
          this.manualScrub = true;
          this.anchorScrub(this.position, data.scrubVelocity);
        }
      }
      if (data.grooveScrub === false && this.manualScrub) {
        this.manualScrub = false;
        this.blendFrom = [...this.last]; this.blendRemaining = this.fadeFrames;
      }
      if (Number.isFinite(data.seekTarget) && this.length) {
        this.clearScrub();
        // The logical cursor traverses continuously; audio samples short fragments
        // through the same reader used by either way of dragging the tonearm.
        // A parked arm starts outside the recorded radius and enters silently.
        this.seek = {
          from: Number.isFinite(data.seekFrom) ? data.seekFrom * this.fileRate : this.position,
          to: Math.max(0, Math.min(this.length, data.seekTarget * this.fileRate)),
          elapsed: 0, grainElapsed: 1 / 60, duration: Math.max(.08, Math.min(1.2, data.seekDuration || .6)),
        };
        this.position = this.seek.from;
        this.blendFrom = [...this.last]; this.blendRemaining = this.fadeFrames;
      }
      if (data.travel !== undefined) this.travel = data.travel;
      if (data.motorTravel !== undefined) this.motorTravel = data.motorTravel;
      if (data.holding) this.clearScrub();
      if (data.directScrub === true && this.length && !data.holding) {
        this.seek = null; this.rampRemaining = 0; this.pausedScrubRelease = false;
        this.directScrub = true; this.manualScrub = false;
        if (Number.isFinite(data.scrubPosition)) {
          this.position = Math.max(0, Math.min(this.length, data.scrubPosition * this.fileRate));
          this.tailPosition = this.position;
        }
        if (Number.isFinite(data.scrubPosition) || Number.isFinite(data.scrubVelocity)) {
          this.anchorScrub(this.position, data.scrubVelocity);
        }
      } else if (data.directScrub === false && this.directScrub) {
        this.clearScrub(); this.seek = null; this.rampRemaining = 0;
        if (Number.isFinite(data.scrubPosition)) this.position = Math.max(0, Math.min(this.length, data.scrubPosition * this.fileRate));
        this.tailPosition = this.position;
        this.pausedScrubRelease = this.paused;
        for (let c = 0; c < this.last.length; c++) this.blendFrom[c] = this.last[c];
        this.blendRemaining = this.fadeFrames;
      }
      if (data.holding && !this.holding) { this.targetTravel = this.travel; this.rate = 0; this.rampRemaining = 0; }
      else if (!data.holding && this.holding) this.rampRemaining = this.motor.rate > 0 ? Math.round(sampleRate * .12) : 0;
      this.holding = data.holding;
      if (data.immediate && !this.motorRate) this.rampRemaining = 0;
    }
    if (data.type === 'scratch' && this.holding) this.targetTravel += data.delta;
  }
  // Radial needle travel selects fragments; it must not become hundreds of
  // revolutions per second. All three inputs share this exact PCM/rate/gain path.
  // The normalized speed only adds a little pitch movement to the manual arm's
  // near-normal-speed reference. Direction takes effect at the newest anchor.
  anchorScrub(position, velocity = 0) {
    const motion = Number.isFinite(velocity) ? velocity : 0;
    const speed = Math.abs(motion) / Math.max(.001, this.length / this.fileRate);
    const base = Math.abs(this.motorActualRate) > .001 ? Math.max(.5, Math.abs(this.motorActualRate)) : 1;
    this.scrubReadPosition = position;
    this.scrubVelocity = Math.sign(motion) * Math.min(2.5, base * (1 + .25 * Math.tanh(4 * speed)));
    this.scrubAge = 0;
    // Convex four-millisecond blend: no summed/queued grains or extra sources.
    for (let c = 0; c < this.last.length; c++) this.blendFrom[c] = this.last[c];
    this.blendRemaining = this.fadeFrames;
  }
  clearScrub() {
    this.directScrub = false; this.manualScrub = false; this.scrubVelocity = 0; this.scrubAge = Infinity;
    this.scrubReadPosition = this.position; this.pausedScrubRelease = false;
  }
  process(inputs, outputs) {
    const output = outputs[0], frames = output[0]?.length ?? 0, dt = 1 / sampleRate;
    let active = false;
    for (let i = 0; i < frames; i++) {
      this.clock += dt;
      this.motorActualRate = this.motor.step(dt) * (1 + this.effects.wow(this.clock));
      this.motorTravel += this.motorActualRate * dt;
      const seeking = this.seek;
      if (seeking) {
        seeking.elapsed = Math.min(seeking.duration, seeking.elapsed + dt);
        const progress = seeking.elapsed / seeking.duration;
        const next = seeking.from + (seeking.to - seeking.from) * progress * progress * (3 - 2 * progress);
        const velocity = (next - this.position) / this.fileRate / dt;
        this.position = next;
        seeking.grainElapsed += dt;
        if (seeking.grainElapsed >= 1 / 60) {
          this.anchorScrub(this.position, velocity);
          seeking.grainElapsed = 0;
        }
      }
      if (this.manualScrub && this.scrubAge >= this.scrubWindow) {
        this.manualScrub = false;
        this.blendFrom = [...this.last]; this.blendRemaining = this.fadeFrames;
      }
      const scrubbing = this.directScrub || this.manualScrub || !!seeking;
      if (scrubbing) {
        this.scrubAge += dt;
        this.rate = this.scrubAge < this.scrubWindow ? this.scrubVelocity : 0;
      } else if (this.holding) {
        const remaining = this.targetTravel - this.travel;
        this.rate = Math.abs(remaining) < 1e-8 ? 0 : Math.max(-8, Math.min(8, remaining * this.follow * sampleRate));
      } else if (this.rampRemaining > 0) this.rate += (this.motorActualRate - this.rate) / this.rampRemaining--;
      else this.rate = this.motorActualRate;
      const step = this.rate * dt;
      // Moving a needle across grooves does not accelerate the physical vinyl.
      this.travel += scrubbing ? this.motorActualRate * dt : step;
      const readPosition = scrubbing ? this.scrubReadPosition : this.paused && !this.holding && !seeking ? this.tailPosition : this.position;
      const canRead = this.enabled && this.length > 0 && Math.abs(this.rate) > .0001
        && (!this.directScrub || (this.powered && this.contact)) && !this.pausedScrubRelease
        && readPosition >= 0 && (this.rate > 0 ? readPosition < this.length : readPosition > 0);
      active = canRead;
      const desiredGain = canRead ? Math.min(1, Math.abs(this.rate) / .03) * (scrubbing ? this.scrubGain : 1) : 0;
      this.gain += Math.max(-1 / this.fadeFrames, Math.min(1 / this.fadeFrames, desiredGain - this.gain));
      const index = Math.max(0, Math.min(this.length - 1, Math.floor(readPosition)));
      const fraction = readPosition - Math.floor(readPosition);
      const noise = this.effects.sample(this.contact && this.length > 0, Math.abs(this.rate) > .0001 && !this.pausedScrubRelease, this.powered, this.region, this.rate);
      for (let c = 0; c < output.length; c++) {
        const pcm = this.channels[Math.min(c, this.channels.length - 1)];
        let value = pcm && this.gain > 0 ? (pcm[index] + ((pcm[index + 1] ?? pcm[index]) - pcm[index]) * fraction) * this.gain : 0;
        if (this.blendRemaining > 0) {
          const mix = 1 - this.blendRemaining / this.fadeFrames;
          value = (this.blendFrom[c] ?? 0) * (1 - mix) + value * mix;
        }
        this.last[c] = value;
        this.colored[c] = this.effects.color(value, c);
      }
      const middle = output.length > 1 ? (this.colored[0] + this.colored[1]) * .5 : this.colored[0];
      const width = 1 - this.effects.profile.stereoNarrowing;
      for (let c = 0; c < output.length; c++) {
        output[c][i] = middle + (this.colored[c] - middle) * width + noise + (c ? -1 : 1) * this.effects.sideNoise;
      }
      if (this.blendRemaining > 0) this.blendRemaining--;
      if (scrubbing) {
        const minimum = Math.min(0, this.position); // preserve silent approach outside the lead-in
        this.scrubReadPosition = Math.max(minimum, Math.min(this.length, this.scrubReadPosition + step * this.fileRate));
      }
      if (!this.directScrub && this.enabled && !seeking) {
        // Eccentric groove pitch varies once per revolution without wobbling the motor.
        const eccentricity = this.holding ? 0 : this.effects.eccentricity(this.travel);
        const minimum = this.position < 0 ? -this.runIn * this.fileRate : 0;
        const advance = (this.manualScrub ? this.motorActualRate * dt : step) * (1 + eccentricity) * this.fileRate;
        if (this.paused && !this.holding) this.tailPosition = Math.max(minimum, Math.min(this.length, this.tailPosition + advance));
        else {
          const previous = this.position;
          this.position = Math.max(minimum, Math.min(this.length, this.position + advance));
          this.tailPosition = this.position;
          // A monotonic event serial survives intervening control revisions. Direct
          // manipulation and commanded seeks never count as finishing a song.
          if (!scrubbing && !this.holding && !this.paused && previous < this.length
            && this.position >= this.length && this.length > 0 && advance > 0) this.playbackEnds++;
        }
      }
      if (seeking) {
        this.tailPosition = this.position;
        if (seeking.elapsed >= seeking.duration) {
          this.position = seeking.to; this.tailPosition = this.position; this.seek = null;
          this.blendFrom = [...this.last]; this.blendRemaining = this.fadeFrames;
        }
      }
    }
    this.reportFrames += frames;
    if (this.reportFrames >= sampleRate / 60) {
      this.reportFrames = 0;
      this.port.postMessage({
        playbackEnds: this.playbackEnds, revision: this.revision, position: this.position / this.fileRate, seeking: this.seek !== null, directScrub: this.directScrub, manualScrub: this.manualScrub,
        travel: this.travel, rate: this.rate, active,
        time: currentTime + frames / sampleRate, ramping: this.rampRemaining > 0 || this.motor.ramping,
        motorTravel: this.motorTravel, motorActualRate: this.motorActualRate, motorRamping: this.motor.ramping,
        grooveRegion: this.region, runInRemaining: Math.max(0, -this.position / this.fileRate),
        contactCount: this.effects.contacts, popCount: this.effects.pops, crackleCount: this.effects.crackles,
      });
    }
    return true;
  }
}
registerProcessor('vinyl-processor', VinylProcessor);
