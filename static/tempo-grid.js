/** Beat-grid corrections and Trance Gate patterns. Pure functions shared by the model,
 * the UI and Node tests; the analysis itself lives in tempo-analysis.js. Grid times are
 * song (record) seconds, so playback speed and pitch never change beat positions. */

export const GATE_RATES = Object.freeze({ '1/4': 1, '1/8': 2, '1/16': 4, '1/32': 8 });
export const GATE_SHAPES = Object.freeze(['chop', 'pump']);
export const GATE_STEPS = 16;
export const GATE_PATTERNS = Object.freeze({
  Straight: 'xxxxxxxxxxxxxxxx',
  Trance: 'x.xxx.xxx.xxx.xx',
  Offbeat: '..x...x...x...x.',
  Stutter: 'xx.xxx.xxx.x.xx.',
});
// Full depth by default: a classic trance gate chops to silence, which reads clearly on dense mixes.
export const DEFAULT_GATE = Object.freeze({ enabled: false, rate: '1/16', depth: 1, length: .55, shape: 'chop', steps: patternSteps('Trance') });
export const DEFAULT_TEMPO = Object.freeze({ source: 'auto', manualBpm: null, anchor: null, multiplier: 1, offsetMs: 0, barShift: 0 });
export const BPM_RANGE = Object.freeze([40, 250]);
// Without a usable detected beat (a sustained tone, ambient audio) the gate still needs a
// steady clock: a straight grid from the start of the song until the user taps or types one.
export const FALLBACK_BPM = 120, MIN_CONFIDENCE = .15;

export function patternSteps(name) { return [...(GATE_PATTERNS[name] ?? GATE_PATTERNS.Straight)].map(step => step === 'x'); }
export function patternName(steps) {
  const text = steps.map(on => on ? 'x' : '.').join('');
  return Object.keys(GATE_PATTERNS).find(name => GATE_PATTERNS[name] === text) ?? 'Custom';
}

/** The beat grid the gate follows: detected beats (optionally halved or doubled) or a
 * constant manual/tap grid anchored on a beat, then shifted by the user's offset. */
export function effectiveGrid(analysis, tempo, duration) {
  const settings = { ...DEFAULT_TEMPO, ...tempo };
  const detected = analysis?.beats ?? [];
  let beats = [], downbeat = analysis?.downbeat ?? 0, bpm = 0;
  if (settings.source !== 'auto' && settings.manualBpm > 0) {
    const period = 60 / settings.manualBpm;
    const anchor = Number.isFinite(settings.anchor) ? settings.anchor : detected[downbeat] ?? detected[0] ?? 0;
    const first = anchor - Math.floor(anchor / period) * period;
    for (let time = first; time <= duration + period; time += period) beats.push(time);
    downbeat = Math.round((anchor - first) / period) % 4;
    bpm = settings.manualBpm;
  } else if (detected.length < 2 || (analysis.confidence ?? 1) < MIN_CONFIDENCE) {
    const period = 60 / FALLBACK_BPM;
    for (let time = 0; time <= duration + period; time += period) beats.push(time);
    downbeat = 0; bpm = FALLBACK_BPM;
    return { beats: Float64Array.from(beats, time => time + (settings.offsetMs || 0) / 1000), downbeat: ((settings.barShift % 4) + 4) % 4, bpm, fallback: true };
  } else if (detected.length > 1) {
    beats = [...detected];
    if (settings.multiplier === 2) {
      const doubled = [];
      for (let i = 0; i < beats.length; i++) {
        doubled.push(beats[i]);
        const next = beats[i + 1] ?? beats[i] + (beats[i] - beats[i - 1]);
        doubled.push((beats[i] + next) / 2);
      }
      beats = doubled; downbeat *= 2;
    } else if (settings.multiplier === .5) {
      // Keep the beats in the downbeat's parity, so bars still start on a kept beat.
      beats = beats.filter((_, i) => i % 2 === downbeat % 2); downbeat = Math.floor(downbeat / 2);
    }
    bpm = (analysis.bpm || 0) * settings.multiplier;
  }
  const shift = (settings.offsetMs || 0) / 1000;
  return { beats: Float64Array.from(beats, time => time + shift), downbeat: ((downbeat + settings.barShift) % 4 + 4) % 4, bpm };
}

/** Tap tempo from tap times in song seconds (wall seconds when the record is not moving).
 * Uses the most recent consistent taps; needs at least three. */
export function tapBpm(times) {
  if (times.length < 3) return null;
  const intervals = times.slice(1).map((time, i) => time - times[i]).filter(value => value > .2 && value < 1.6);
  if (intervals.length < 2) return null;
  const sorted = [...intervals].sort((a, b) => a - b), middle = sorted[sorted.length >> 1];
  const bpm = 60 / middle;
  return Math.round(Math.min(BPM_RANGE[1], Math.max(BPM_RANGE[0], bpm)));
}

/** Confidence (0–1) as a short label for the player. */
export function confidenceLabel(confidence) {
  return confidence >= .7 ? 'High' : confidence >= .4 ? 'Medium' : 'Low';
}
