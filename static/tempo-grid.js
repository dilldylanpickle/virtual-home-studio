/** Beat-grid corrections and Trance Gate patterns. Pure functions shared by the model,
 * the UI and Node tests; the analysis itself lives in tempo-analysis.js. Grid times are
 * song (record) seconds, so playback speed and pitch never change beat positions. */

// Steps per beat. 1/8T is eighth-note triplets (three per beat); triplet patterns repeat
// every bar (12 steps) so they stay bar-aligned.
export const GATE_RATES = Object.freeze({ '1/2': .5, '1/4': 1, '1/8': 2, '1/8T': 3, '1/16': 4, '1/32': 8 });
export const GATE_SHAPES = Object.freeze(['chop', 'pump']);
export const GATE_STEPS = 16;
export const GATE_PATTERNS = Object.freeze({
  Straight: 'xxxxxxxxxxxxxxxx',
  Trance: 'x.xxx.xxx.xxx.xx',
  Offbeat: '..x...x...x...x.',
  Stutter: 'xx.xxx.xxx.x.xx.',
});
// Full depth by default: a classic trance gate chops to silence, which reads clearly on dense mixes.
/** Gate styles: complete settings voiced for full songs, the way a producer would use a
 * gate on a whole mix. Less is more: no total drop-outs, softened edges (`soft`, 0–1),
 * pumps that let the kick's attack through, and `highs` (0–1) = how much of the duck the
 * highs take, so vocals and air stay present while the low end pumps. Any later change
 * makes the gate "Custom". */
const ALL = 'xxxxxxxxxxxxxxxx';
export const GATE_STYLES = Object.freeze({
  Push: { shape: 'pump', rate: '1/4', depth: .5, length: .65, soft: .3, highs: .55, pattern: ALL },      // sidechain "woah" on every beat
  Pulse: { shape: 'chop', rate: '1/4', depth: .5, length: .65, soft: .45, highs: .55, pattern: ALL },    // Push's settings, chopped: a steady on-off throb
  Bounce: { shape: 'pump', rate: '1/8', depth: .4, length: .6, soft: .3, highs: .5, pattern: ALL },       // lighter double-time pump
  Breathe: { shape: 'pump', rate: '1/2', depth: .55, length: .9, soft: .5, highs: .6, pattern: ALL },     // slow half-note swell
  Trance: { shape: 'chop', rate: '1/16', depth: .6, length: .7, soft: .6, highs: .8, pattern: 'xxxxx.xxxxx.xx.x' }, // 16th shimmer
  Gallop: { shape: 'chop', rate: '1/8T', depth: .5, length: .65, soft: .7, highs: .8, pattern: 'xx.xx.xx.xx.xxxx' }, // gentle triplet lilt
});
export function styleSettings(name) {
  const style = GATE_STYLES[name]; if (!style) return null;
  return { shape: style.shape, rate: style.rate, depth: style.depth, length: style.length, soft: style.soft, highs: style.highs, steps: [...style.pattern].map(step => step === 'x') };
}
export function styleName(gate) {
  return Object.keys(GATE_STYLES).find(name => {
    const style = styleSettings(name);
    return style.shape === gate.shape && style.rate === gate.rate && Math.abs(style.depth - gate.depth) < 1e-6 && Math.abs(style.soft - (gate.soft ?? 0)) < 1e-6 && Math.abs(style.highs - (gate.highs ?? 1)) < 1e-6
      && Math.abs(style.length - gate.length) < 1e-6 && style.steps.every((on, i) => on === gate.steps[i]);
  }) ?? 'Custom';
}
/** Steps in one pattern cycle: 16, or one bar (12) for triplets. */
export const gateCycle = rate => GATE_RATES[rate] === 3 ? 12 : GATE_STEPS;
export const DEFAULT_GATE = Object.freeze({ enabled: false, ...styleSettings('Push') });

/** Small make-up gain (≤ +1.5 dB) for the loudness a gate removes, from its average gain;
 * lows count fully, highs by their share of the duck. */
export function gateMakeup(gate) {
  const cycle = gateCycle(gate.rate), on = gate.steps.slice(0, cycle).filter(Boolean).length / cycle, d = gate.depth, l = gate.length;
  const onMean = gate.shape === 'pump' ? l * (1 - d * 2 / 3) + (1 - l) : l + (1 - l) * (1 - d);
  const mean = on * onMean + (1 - on) * (1 - d), effective = 1 - (1 - mean) * (.4 + .6 * (gate.highs ?? 1));
  return Math.max(1, Math.min(1.19, 1 / Math.max(.1, effective)));
}
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

/** Hardstyle mode: a synthesized kick on the beat grid tuned to the song's root note. */
/** Hardstyle kit presets: 8-bar phrases of 16ths per lane (kick, clap on 2 and 4, open hats
 * on the offbeats), like a long pattern in a DAW: the main bar repeats, bar 4 adds a small
 * fill and bar 8 a bigger one into the next phrase, so the loop never feels like one bar on
 * repeat. "Build" is the do-do-do… do-do do hardstyle build; "Anthem" drops the kick out
 * before each phrase. */
export const KIT_BARS = 8, KIT_STEPS = KIT_BARS * 16;
const BACKBEAT = '....x.......x...', OFFBEATS = '..x...x...x...x.', EMPTY = '................';
// One lane: the main bar, with replacements for some bars (1-based).
const phrase = (main, fills = {}) => Array.from({ length: KIT_BARS }, (_, bar) => fills[bar + 1] ?? main).join('');
export const KIT_PATTERNS = Object.freeze({
  Classic: { kick: phrase('x...x...x...x...', { 4: 'x...x...x...x.x.', 8: 'x...x...x.x.xxxx' }), clap: phrase(BACKBEAT, { 8: '....x.......x.xx' }), hat: phrase(OFFBEATS, { 8: '..x...x...x.....' }) },
  Anthem: { kick: phrase('x...x...x...x...', { 4: 'x...x...x.......', 8: 'x...x...........' }), clap: phrase(BACKBEAT, { 8: '....x...x.x.xxxx' }), hat: phrase(OFFBEATS, { 4: '..x...x...x.....', 8: '..x...x.........' }) },
  Build: { kick: phrase('x.x.x.x.x.x.x.xx', { 8: 'x.x.x.x.xxxxxxxx' }), clap: phrase(BACKBEAT), hat: phrase(OFFBEATS) },
  Gallop: { kick: phrase('x..x..x.x..x..x.', { 4: 'x..x..x.x..x.xx.', 8: 'x..x..x.x.x.xxxx' }), clap: phrase(BACKBEAT), hat: phrase(OFFBEATS) },
  Roll: { kick: phrase('xxxxxxxxxxxxxxxx', { 8: 'xxxxxxxxxxxx....' }), clap: phrase(EMPTY), hat: phrase(EMPTY) },
  'Half time': { kick: phrase('x.......x.......', { 4: 'x.......x.....x.', 8: 'x.......x...x.x.' }), clap: phrase('........x.......', { 8: '........x.....x.' }), hat: phrase(OFFBEATS) },
});
export const KIT_LANES = Object.freeze(['kick', 'clap', 'hat']);
const toSteps = text => [...text].map(step => step === 'x');
export const kitLanes = name => { const kit = KIT_PATTERNS[name] ?? KIT_PATTERNS.Classic; return { steps: toSteps(kit.kick), clap: toSteps(kit.clap), hat: toSteps(kit.hat) }; };
export const kitName = kick => Object.keys(KIT_PATTERNS).find(name => {
  const kit = kitLanes(name); return ['steps', 'clap', 'hat'].every(lane => kit[lane].every((on, i) => on === Boolean(kick[lane]?.[i])));
}) ?? 'Custom';
/** Kick sounds by hard dance school; the synthesis lives in hardstyle.js (KICK_SOUNDS). */
export const KIT_SOUNDS = Object.freeze({ euphoric: 'Euphoric', raw: 'Rawstyle', techno: 'Techno drive', gabber: 'Gabber' });
export const DEFAULT_KICK = Object.freeze({ enabled: false, ...kitLanes('Classic'), sound: 'raw', crashEvery: 8, drops: true, horn: true, volume: .7, drive: .6, tail: .5, tune: 'auto' });
/** 8-bit mode melodies (original): two bars of sixteenths. Lead digits are pentatonic degrees
 * of the song's key (0 tonic, 1, 2, 3, 4, 5 octave…; notes on the beat snap to the chord),
 * bass digits 0 root, 1 octave, 2 fifth of the chord, '-' holds and '.' rests; drums are one
 * bar of 'k' kick, 's' snare, 'h' hat. */
export const CHIP_PATTERNS = Object.freeze({
  Overworld: { lead: '3432123210123-3-4345432343212---', bass: '0.1.0.1.0.1.0.1.', drums: 'k.h.s.h.k.h.s.h.' },
  Sparkle: { lead: '0235323575323.2.1346434676434...', bass: '0.1.0.1.0.1.0.1.', drums: 'k.h.s.h.k.h.s.hh' },
  'Boss fight': { lead: '05050505272716160505050538384.3.', bass: '0.0.0.0.2.2.1.1.', drums: 'k.hhs.hhk.hhs.hk' },
  Chill: { lead: '3.3.4.3.2.1.2.3.5-4-3.2.3---....', bass: '0---1---0---2---', drums: 'k...s...k.k.s...' },
});
const toNotes = text => [...text].map(step => step === '-' ? null : step === '.' ? -1 : Number(step));
export const chipLanes = name => { const pattern = CHIP_PATTERNS[name] ?? CHIP_PATTERNS.Overworld; return { lead: toNotes(pattern.lead), bass: toNotes(pattern.bass), drums: [...pattern.drums] }; };
/** Sound chips; the synthesis lives in chiptune.js (CHIP_SOUNDS). */
export const CHIP_SOUND_NAMES = Object.freeze({ console: 'Console', pocket: 'Pocket', computer: 'Computer' });
export const DEFAULT_CHIP = Object.freeze({ enabled: false, sound: 'console', pattern: 'Overworld', chords: true, drums: true, pixels: true, volume: .6, crunch: .5 });
export const KEY_NAMES = Object.freeze(['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']);
export const keyLabel = key => key ? `${KEY_NAMES[key.tonic]} ${key.mode}` : '';
/** Kick tail frequency (Hz): the chosen or detected root, in the 41–78 Hz hardstyle range
 * (E1–E♭2). 'auto' uses the detected key; '0'…'11' pick a root (0 = C). */
export function kickTune(choice, detected) {
  const tonic = /^(?:[0-9]|1[01])$/.test(String(choice)) ? Number(choice) : detected?.tonic ?? 9;
  const midi = 28 + ((tonic - 4) % 12 + 12) % 12;
  return 440 * 2 ** ((midi - 69) / 12);
}
