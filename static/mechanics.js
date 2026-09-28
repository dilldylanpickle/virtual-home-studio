/** Direct-drive velocity model. Called only on the audio rendering clock. */
export class PlatterMotor {
  constructor() { this.rate = 0; this.target = 0; this.start = 0; this.elapsed = 0; this.duration = 0; }
  setTarget(target, immediate = false, duration = null) {
    if (target === this.target && !immediate) return;
    this.start = this.rate;
    this.target = Math.max(0, target);
    this.elapsed = 0;
    this.duration = immediate ? 0 : duration ?? (target === 0 ? .36 : this.rate === 0 ? .28 : .45);
    if (!this.duration) this.rate = this.target;
  }
  step(dt) {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const t = this.duration ? this.elapsed / this.duration : 1;
    const eased = t * t * (3 - 2 * t);
    this.rate = this.start + (this.target - this.start) * eased;
    return this.rate;
  }
  get ramping() { return this.elapsed < this.duration; }
}
