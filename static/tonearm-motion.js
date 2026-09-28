/** One state-driven pivot sweep for assisted cueing, return, and record handling. */
export class TonearmMotion {
  constructor(deck, geometry) {
    this.deck = deck;
    this.geometry = geometry;
    this.generation = 0;
    this.frame = null;
    this.resolve = null;
  }
  cancel() {
    ++this.generation;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.deck.state.tonearmMotion = null;
    this.resolve?.(false);
    this.resolve = null;
  }
  moveTo(targetAngle, { kind = 'cueing', duration = 620, liftDelay = 150, settleDelay = 0 } = {}) {
    this.cancel();
    const d = this.deck, s = d.state;
    d.syncPosition();
    const startAngle = s.tonearmAngle;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clearance = !s.stylusRaised && !reduced ? liftDelay : 0;
    const travel = Math.abs(targetAngle - startAngle) < .000001 ? 0 : reduced ? 1 : duration;
    const settle = reduced ? 0 : settleDelay;
    const generation = this.generation;
    const began = performance.now();
    const motion = { kind, phase: clearance ? 'lifting' : 'moving', startAngle, targetAngle, progress: 0 };
    s.tonearmMotion = { ...motion };
    // The existing contact edge owns release sound and silence. Lift before any sweep.
    d.change(s => { s.stylusRaised = true; });
    return new Promise(resolve => {
      this.resolve = resolve;
      const tick = now => {
        if (generation !== this.generation) return;
        const elapsed = now - began;
        if (elapsed >= clearance) {
          const progress = travel ? Math.min(1, (elapsed - clearance) / travel) : 1;
          const eased = progress * progress * (3 - 2 * progress);
          motion.phase = progress < 1 ? 'moving' : 'settling';
          motion.progress = progress;
          d.change(s => {
            s.tonearmMotion = { ...motion };
            const angle = startAngle + (targetAngle - startAngle) * eased;
            d.setGroovePosition(this.geometry.progressAtAngle(angle), angle);
          }, true);
        }
        if (elapsed >= clearance + travel + settle) {
          this.frame = null;
          this.resolve = null;
          // Set the exact endpoint before releasing ownership to ordinary playback.
          d.change(s => {
            d.setGroovePosition(this.geometry.progressAtAngle(targetAngle), targetAngle);
            s.tonearmMotion = null;
          }, true);
          resolve(true);
          return;
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    });
  }
}
