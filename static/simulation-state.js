/** Pure selectors: physical inputs are stored; effective speeds are always derived. */
export const NOMINAL_RPM = 100 / 3;
export function deriveSpeed(s) {
  const nominalRPM = s.speed33Pressed ? (s.speed45Pressed ? 78 : NOMINAL_RPM) : s.speed45Pressed ? 45 : null;
  const effectivePitch = s.quartzLock ? 0 : s.pitch;
  const targetRPM = nominalRPM === null ? 0 : nominalRPM * (1 + effectivePitch / 100);
  const effectiveRate = targetRPM / NOMINAL_RPM;
  const motorTargetRPM = s.power && s.platterRunning && !s.transportPaused ? targetRPM : 0;
  return { rpm: nominalRPM, nominalRPM, effectivePitch, targetRPM, effectiveRate, motorTargetRPM };
}
export function derivePhysical(s, overGroove) {
  const speed = deriveSpeed(s);
  const actualRPM = s.motorActualRate * NOMINAL_RPM;
  const contact = s.recordPresent && s.recordPhase === 'ready' && !s.stylusRaised && overGroove;
  const motorState = s.motorRamping ? speed.motorTargetRPM > actualRPM ? 'accelerating' : 'decelerating' : actualRPM > .003 ? 'steady' : 'stopped';
  const transportState = s.directScrubbing ? 'directScrub' : s.transportPaused ? (actualRPM > .003 && !s.scratching ? 'pausing' : 'paused')
    : s.scratching ? 'scratching' : s.motorRamping && !s.platterRunning ? 'coasting'
    : s.platterRunning && contact && s.power ? (s.motorRamping ? 'starting' : 'playing') : 'idle';
  return { ...speed, actualRPM, motorState, transportState, stylusContact: contact,
    grooveProgress: s.duration ? Math.max(0, Math.min(1, s.position / s.duration)) : 0,
    busy: !['empty', 'ready'].includes(s.recordPhase) };
}

export function playbackEnded(s) {
  return s.recordLoaded && s.duration > 0 && s.position >= s.duration - .02;
}
