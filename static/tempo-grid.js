/** Beat-grid corrections and Trance Gate patterns, styles and envelope ranges. Pure functions shared by the model,
 * the UI and Node tests; the analysis itself lives in tempo-analysis.js. Grid times are
 * song (record) seconds, so playback speed and pitch never change beat positions. */

// Steps per beat. 1/8T is eighth-note triplets (three per beat); triplet patterns repeat
// every bar (12 steps) so they stay bar-aligned.
export const GATE_RATES = Object.freeze({ '1/2': .5, '1/4': 1, '1/8': 2, '1/8T': 3, '1/16': 4, '1/32': 8 });
export const GATE_STEPS = 16;
/** Step states: off, on (starts a note) and tie (holds the note before it). Patterns are
 * written 'x' on, '-' tie, '.' off. */
export const STEP_OFF = 0, STEP_ON = 1, STEP_TIE = 2;
export const GATE_PATTERNS = Object.freeze({
  Straight: 'xxxxxxxxxxxxxxxx',
  Alternate: 'x.x.x.x.x.x.x.x.',
  Trance: 'xx.xx.x.xx.xx.x.',
  Offbeat: '..x...x...x...x.',
});
/** Envelope ranges (ms) for the Attack, Decay and Release sliders, which move on a log scale. */
export const GATE_ENVELOPE = Object.freeze({ attack: [.5, 400], decay: [1, 1000], release: [1, 1000] });
export const envelopeMs = (key, x) => { const [low, high] = GATE_ENVELOPE[key]; return Math.round(low * (high / low) ** Math.max(0, Math.min(1, x)) * 10) / 10; };
export const envelopeSlider = (key, ms) => { const [low, high] = GATE_ENVELOPE[key]; return Math.log(Math.max(low, Math.min(high, ms)) / low) / Math.log(high / low); };
/** Gate styles: complete settings (rate, pattern, ADSR envelope, mix), the way a trance gate
 * plugin's presets work. Mix below 100% keeps some of the dry record under the gate. Any
 * later change makes the gate "Custom". */
export const GATE_STYLES = Object.freeze({
  Trance: { rate: '1/16', pattern: 'xx.xx.x.xx.xx.x.', attack: 1, decay: 70, sustain: .3, release: 25, mix: .9 },    // the classic 3-3-2 sixteenth chop
  Pluck: { rate: '1/8', pattern: 'xxxxxxxxxxxxxxxx', attack: 1, decay: 140, sustain: .1, release: 40, mix: .9 },    // every eighth plucked short
  Stutter: { rate: '1/32', pattern: 'xxxxxxxxxxxxxxxx', attack: .5, decay: 22, sustain: 0, release: 6, mix: .85 },  // machine-gun thirty-seconds
  Bounce: { rate: '1/16', pattern: 'x-.x-.x-x-.x-.x.', attack: 2, decay: 90, sustain: .6, release: 40, mix: 1 },    // tied steps: long-short bounce
  Gallop: { rate: '1/8T', pattern: 'xx.xx.xx.xx.xxxx', attack: 2, decay: 60, sustain: .5, release: 30, mix: .9 },   // triplet gallop
  Push: { rate: '1/4', pattern: 'xxxxxxxxxxxxxxxx', attack: 180, decay: 1, sustain: 1, release: 1, mix: .55 },      // sidechain swell on every beat
  Breathe: { rate: '1/2', pattern: 'xxxxxxxxxxxxxxxx', attack: 320, decay: 250, sustain: .6, release: 200, mix: .65 }, // slow half-note swell
});
export const parseSteps = text => [...text].map(step => step === 'x' ? STEP_ON : step === '-' ? STEP_TIE : STEP_OFF);
export const stepsText = steps => steps.map(step => step === STEP_TIE ? '-' : step ? 'x' : '.').join('');
/** A tie must follow a note: a tie after an off step (within the cycle) starts a note. */
export function normalizeSteps(steps, cycle = steps.length) {
  const out = steps.map(step => step === true ? STEP_ON : step === STEP_TIE ? STEP_TIE : step ? STEP_ON : STEP_OFF), used = out.slice(0, cycle);
  if (!used.includes(STEP_ON) && used.includes(STEP_TIE)) out[used.indexOf(STEP_TIE)] = STEP_ON;
  for (let i = 0; i < cycle; i++) if (out[i] === STEP_TIE && out[(i - 1 + cycle) % cycle] === STEP_OFF) out[i] = STEP_ON;
  return out;
}
export function styleSettings(name) {
  const style = GATE_STYLES[name]; if (!style) return null;
  return { rate: style.rate, steps: normalizeSteps(parseSteps(style.pattern), gateCycle(style.rate)), attack: style.attack, decay: style.decay, sustain: style.sustain, release: style.release, mix: style.mix };
}
export function styleName(gate) {
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  return Object.keys(GATE_STYLES).find(name => {
    const style = styleSettings(name);
    return style.rate === gate.rate && ['attack', 'decay', 'sustain', 'release', 'mix'].every(key => close(style[key], gate[key])) && stepsText(style.steps) === stepsText(gate.steps);
  }) ?? 'Custom';
}
/** Steps in one pattern cycle: 16, or one bar (12) for triplets. */
export const gateCycle = rate => GATE_RATES[rate] === 3 ? 12 : GATE_STEPS;
export const DEFAULT_GATE = Object.freeze({ enabled: false, ...styleSettings('Trance') });

export const DEFAULT_TEMPO = Object.freeze({ source: 'auto', manualBpm: null, anchor: null, multiplier: 1, offsetMs: 0, barShift: 0 });
export const BPM_RANGE = Object.freeze([40, 250]);
// Without a usable detected beat (a sustained tone, ambient audio) the gate still needs a
// steady clock: a straight grid from the start of the song until the user taps or types one.
export const FALLBACK_BPM = 120, MIN_CONFIDENCE = .15;

export function patternSteps(name) { return parseSteps(GATE_PATTERNS[name] ?? GATE_PATTERNS.Straight); }
export function patternName(steps) { return Object.keys(GATE_PATTERNS).find(name => GATE_PATTERNS[name] === stepsText(steps)) ?? 'Custom'; }

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
