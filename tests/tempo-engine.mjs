// Tempo analysis, beat-grid corrections and the Trance Gate in the production worklet.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { analyzeTempo } from '../static/tempo-analysis.js';
import { effectiveGrid, tapBpm, patternSteps, patternName } from '../static/tempo-grid.js';

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} versus ${expected}`);
let seed = 11; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// --- Synthetic music with known beats --------------------------------------------------
function groove({ bpm, seconds, rate = 44100, offset = .1, ramp = 0, offbeatBass = false }) {
  const out = new Float32Array(Math.round(rate * seconds)), truth = [];
  let t = offset, beat = 0;
  while (t < seconds) {
    truth.push(t);
    const start = Math.round(t * rate), period = 60 / (bpm + ramp * t / seconds);
    for (let i = 0; i < rate * .22 && start + i < out.length; i++) {
      const x = i / rate; out[start + i] += .75 * Math.sin(2 * Math.PI * (48 + 85 * Math.exp(-x * 32)) * x) * Math.exp(-x * 9) * (beat % 4 ? .75 : 1);
    }
    for (let q = 1; q < 4; q++) {
      const hat = Math.round((t + q * period / 4) * rate);
      for (let i = 0; i < rate * .03 && hat + i < out.length; i++) out[hat + i] += (q === 2 ? .2 : .08) * (random() * 2 - 1) * Math.exp(-i / rate * 140);
    }
    if (offbeatBass) {
      const bass = Math.round((t + period / 2) * rate);
      for (let i = 0; i < rate * period * .45 && bass + i < out.length; i++) out[bass + i] += .25 * Math.sin(2 * Math.PI * 55 * i / rate) * Math.exp(-i / rate * 4) * Math.min(1, (rate * period * .45 - i) / (rate * .015));
    }
    t += period; beat++;
  }
  for (let i = 0; i < out.length; i++) out[i] += .04 * (Math.sin(2 * Math.PI * 261.6 * i / rate) + Math.sin(2 * Math.PI * 392 * i / rate));
  return { pcm: out, truth, rate };
}
const beatError = (beats, truth) => Math.max(...beats.map(b => Math.min(...truth.map(t => Math.abs(t - b)))));

// --- Analysis -----------------------------------------------------------------------------
for (const spec of [{ bpm: 128, seconds: 30 }, { bpm: 174, seconds: 30 }, { bpm: 90, seconds: 30 }, { bpm: 140, seconds: 25, offset: .37, offbeatBass: true }, { bpm: 124, seconds: 30, rate: 48000 }]) {
  const { pcm, truth, rate } = groove(spec), result = analyzeTempo(pcm, rate);
  near(result.bpm, spec.bpm, .05, `${spec.bpm} BPM tempo`);
  assert.ok(beatError(result.beats, truth) < .004, `${spec.bpm} BPM: every beat within 4 ms (got ${(beatError(result.beats, truth) * 1000).toFixed(2)} ms)`);
  assert.ok(result.confidence > .7 && !result.varies, `${spec.bpm} BPM: steady, high-confidence grid (${result.confidence.toFixed(2)})`);
}
console.log('PASS analysis: 90–174 BPM, 44.1/48 kHz, offbeat hats and offbeat bass land on the kick within 4 ms');

{
  const { pcm, truth, rate } = groove({ bpm: 120, seconds: 60, ramp: 16 }), result = analyzeTempo(pcm, rate);
  assert.ok(result.varies, 'a 120→136 BPM ramp is reported as a changing tempo');
  const errors = result.beats.map(b => Math.min(...truth.map(t => Math.abs(t - b)))).sort((a, b) => a - b);
  assert.ok(errors[Math.floor(errors.length * .9)] < .01, `changing tempo: 90% of tracked beats within 10 ms (${(errors[Math.floor(errors.length * .9)] * 1000).toFixed(1)} ms)`);
}
console.log('PASS changing tempo: beats follow a ramp instead of assuming a constant BPM');

{
  const n = 44100 * 25, noise = Float32Array.from({ length: n }, () => .3 * (random() * 2 - 1)), irregular = new Float32Array(n);
  for (let t = .2; t < 25; t += .15 + random() * .9) { const s = Math.round(t * 44100); for (let i = 0; i < 2000 && s + i < n; i++) irregular[s + i] += .6 * (random() * 2 - 1) * Math.exp(-i / 300); }
  const steady = analyzeTempo(groove({ bpm: 128, seconds: 25 }).pcm, 44100).confidence;
  for (const [label, signal] of [['noise', noise], ['irregular hits', irregular]]) {
    const confidence = analyzeTempo(signal, 44100).confidence;
    assert.ok(confidence < .2 && confidence < steady - .5, `${label} reports low confidence (${confidence.toFixed(2)})`);
  }
}
console.log('PASS confidence: steady grooves high, noise and irregular hits low');

// --- Grid corrections and tap tempo ---------------------------------------------------------
{
  const analysis = { bpm: 128, beats: Array.from({ length: 64 }, (_, i) => .1 + i * 60 / 128), downbeat: 1 };
  const base = effectiveGrid(analysis, {}, 30);
  assert.equal(base.beats.length, 64); assert.equal(base.downbeat, 1); near(base.bpm, 128, 1e-9, 'auto BPM');
  const double = effectiveGrid(analysis, { multiplier: 2 }, 30);
  near(double.bpm, 256, 1e-9, 'double time'); near(double.beats[1] - double.beats[0], 60 / 256, 1e-9, 'double-time midpoints'); assert.equal(double.downbeat, 2);
  const half = effectiveGrid(analysis, { multiplier: .5 }, 30);
  near(half.bpm, 64, 1e-9, 'half time'); near(half.beats[0], analysis.beats[1], 1e-9, 'half time keeps the downbeat parity');
  const manual = effectiveGrid(analysis, { source: 'manual', manualBpm: 100, anchor: 2 }, 30);
  near(manual.beats[1] - manual.beats[0], .6, 1e-9, 'manual BPM spacing'); assert.ok(manual.beats.some(b => Math.abs(b - 2) < 1e-9), 'manual grid passes through its anchor');
  const shifted = effectiveGrid(analysis, { offsetMs: 25, barShift: 1 }, 30);
  near(shifted.beats[0] - analysis.beats[0], .025, 1e-9, 'grid offset'); assert.equal(shifted.downbeat, 2);
  near(tapBpm([0, .5, 1, 1.5]), 120, 1e-9, 'tap tempo'); assert.equal(tapBpm([0, .5]), null, 'two taps are not enough');
  assert.equal(tapBpm([0, .47, .94, 1.41, 2.4]), 128, 'tap tempo ignores an outlier gap and rounds to whole BPM');
  const fallback = effectiveGrid({ bpm: 117.6, confidence: 0, beats: analysis.beats, downbeat: 2 }, {}, 10);
  assert.ok(fallback.fallback && fallback.bpm === 120 && fallback.beats[0] === 0 && Math.abs(fallback.beats[1] - .5) < 1e-9, 'no usable beat: the gate runs on a steady 120 BPM grid');
  assert.equal(patternName(patternSteps('Offbeat')), 'Offbeat'); assert.equal(patternName(Array(16).fill(false)), 'Custom');
}
console.log('PASS grid corrections: half/double time, manual and tap BPM with anchor, offset and bar shift');

// --- Trance Gate inside the production worklet ----------------------------------------------
let Processor; const scope = {
  sampleRate: 48000, currentTime: 0,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage: () => {} }; } },
  registerProcessor: (_name, implementation) => { Processor = implementation; },
};
vm.runInNewContext(['condition-profiles.js', 'mechanics.js', 'vinyl-effects.js', 'trance-gate.js', 'hardstyle.js', 'chiptune.js', 'vinyl-processor.js']
  .map(file => fs.readFileSync(new URL('../static/' + file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '')).join('\n'), scope);
const engine = new Processor(), rate = 48000;
engine.command({ type: 'settings', settings: { surface: false, contacts: false } });
engine.command({ type: 'load', channels: [new Float32Array(rate * 20).fill(.5)], sampleRate: rate });
let revision = 0, controls = { enabled: true, motorRate: 1, holding: false, immediate: true };
const control = patch => { controls = { ...controls, ...patch }; engine.command({ ...controls, type: 'control', revision: ++revision }); delete controls.position; };
const render = seconds => { const out = []; for (let left = Math.round(seconds * rate); left > 0; left -= 128) { const n = Math.min(128, left), o = [new Float32Array(n), new Float32Array(n)]; engine.process([], [o]); out.push(...o[0]); } return out; };
const period = 60 / 120, beats = Float64Array.from({ length: 40 }, (_, i) => .2 + i * period);
engine.command({ type: 'beats', beats, downbeat: 0 });
engine.command({ type: 'gate', settings: { enabled: true, depth: 1, stepsPerBeat: 4, length: .5, steps: Array(16).fill(true) } });
control({ position: 4 / 20 }); render(.05);
// Song time of each output sample is the engine's own read position; compare the level
// in the open and closed halves of each 16th step.
function gateAlignment(seconds) {
  let open = 0, closed = 0, openN = 0, closedN = 0;
  for (let i = 0; i < seconds * rate; i += 128) {
    const block = render(128 / rate), t = engine.position / rate;
    const phase = (((t - .2) / (period / 4)) % 1 + 1) % 1, level = Math.abs(block[block.length - 1]);
    if (phase > .15 && phase < .4) { open += level; openN++; } else if (phase > .65 && phase < .9) { closed += level; closedN++; }
  }
  return { open: open / openN, closed: closed / closedN };
}
let level = gateAlignment(2);
assert.ok(level.open > .45 && level.closed < level.open * .1, `gate opens on the grid's 16ths and closes between them (${JSON.stringify(level)})`);
control({ position: 11.3 / 20 }); render(.03);
level = gateAlignment(1.5);
assert.ok(level.open > .45 && level.closed < level.open * .1, `gate stays on the beat after a seek (${JSON.stringify(level)})`);
control({ pause: true, pausePosition: engine.position / rate }); render(.8); control({ pause: false }); render(.05);
level = gateAlignment(1.5);
assert.ok(level.open > .45 && level.closed < level.open * .1, `gate stays on the beat after pause and resume (${JSON.stringify(level)})`);
control({ motorRate: 1.35, rpm: 45 }); render(.6);
level = gateAlignment(1.5);
assert.ok(level.open > .45 && level.closed < level.open * .1, `at 45 RPM the gate follows song time, not wall time (${JSON.stringify(level)})`);
engine.command({ type: 'gate', settings: { enabled: false } }); render(.05);
level = gateAlignment(1);
assert.ok(level.open > .45 && level.closed > .45, `disabling the gate restores the dry signal (${JSON.stringify(level)})`);
console.log('PASS Trance Gate: 16ths locked to the grid through seek, pause/resume and 45 RPM; off restores the signal');

// Pump: on each quarter note the music ducks at the beat and swells back (sidechain push).
{
  engine.command({ type: 'gate', settings: { enabled: true, depth: 1, stepsPerBeat: 1, length: .8, shape: 'pump', steps: Array(16).fill(true) } });
  control({ motorRate: 1, rpm: 100 / 3, position: 6 / 20 }); render(.05);
  const phases = [[], [], [], []];
  for (let i = 0; i < rate * 2; i += 128) {
    const block = render(128 / rate), t = engine.position / rate, phase = (((t - .2) / period) % 1 + 1) % 1;
    phases[Math.min(3, Math.floor(phase * 4))].push(Math.abs(block[block.length - 1]));
  }
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length, levels = phases.map(mean);
  assert.ok(levels[0] < levels[1] && levels[1] < levels[2] && levels[3] > .45 && levels[0] < .2, `pump ducks on the beat and swells back (${levels.map(v => v.toFixed(3))})`);
}
console.log('PASS Trance Gate pump: ducks on each beat and swells back to full level');

// The gate shapes music only: surface noise continues through closed steps.
{
  const noisy = new Processor();
  noisy.command({ type: 'settings', settings: { surface: true, contacts: false, condition: 'Poor' } });
  noisy.command({ type: 'load', channels: [new Float32Array(rate * 6)], sampleRate: rate });
  noisy.command({ type: 'beats', beats, downbeat: 0 });
  noisy.command({ type: 'gate', settings: { enabled: true, depth: 1, stepsPerBeat: 4, length: .1, steps: Array(16).fill(false) } });
  noisy.command({ type: 'control', revision: 1, enabled: true, contact: true, motorRate: 1, holding: false, immediate: true, position: .2 });
  let energy = 0; for (let b = 0; b < 400; b++) { const o = [new Float32Array(128), new Float32Array(128)]; noisy.process([], [o]); for (const v of o[0]) energy += v * v; }
  assert.ok(energy > 1e-6, 'closed gate steps leave the vinyl surface noise audible');
}
console.log('PASS Trance Gate gates music only; vinyl surface noise passes through');

// Not muffled: lows take the full duck, highs only `highs` of it; a pump lets the kick's
// attack (first 25 ms after the beat) through; make-up gain is bounded.
{
  const { TranceGate } = await import('../static/trance-gate.js');
  const level = (frequency, highs) => {
    const gate = new TranceGate(rate); gate.setGrid(beats, 0);
    gate.configure({ enabled: true, depth: 1, stepsPerBeat: 4, length: .5, shape: 'chop', steps: Array(16).fill(true), highs, makeup: 1 });
    let open = 0, closed = 0;
    for (let i = 0; i < rate * 2; i++) {
      const t = 1 + i / rate, g = gate.step(t), y = Math.abs(gate.apply(Math.sin(2 * Math.PI * frequency * i / rate), 0, g));
      const phase = (((t - .2) / (period / 4)) % 1 + 1) % 1;
      if (phase > .2 && phase < .4) open = Math.max(open, y); else if (phase > .7 && phase < .9) closed = Math.max(closed, y);
    }
    return closed / open;
  };
  assert.ok(level(60, .5) < .2, `bass is ducked fully (${level(60, .5).toFixed(2)})`);
  near(level(4000, .5), .5, .12, 'highs take half of the duck with highs .5');
  const gate = new TranceGate(rate); gate.setGrid(beats, 0);
  gate.configure({ enabled: true, depth: .8, stepsPerBeat: 1, length: .6, shape: 'pump', steps: Array(16).fill(true), punchMs: 25 });
  const beat = beats[10];
  near(gate.target(beat + .01), 1, 1e-9, 'pump leaves the kick attack open'); assert.ok(gate.target(beat + .04) < .3, 'pump ducks right after the attack');
  const { gateMakeup, styleSettings } = await import('../static/tempo-grid.js');
  for (const name of ['Push', 'Pulse', 'Bounce', 'Breathe', 'Trance', 'Gallop']) { const m = gateMakeup(styleSettings(name)); assert.ok(m >= 1 && m <= 1.19, `${name} make-up gain within +1.5 dB`); }
}
console.log('PASS Trance Gate stays bright: full duck for lows, partial for highs, kick attack kept, bounded make-up gain');

// --- Key detection and hardstyle mode ---------------------------------------------------------
{
  const { analyzeKey } = await import('../static/tempo-analysis.js');
  const midi = n => 440 * 2 ** ((n - 69) / 12), sr = 44100;
  const progression = chords => { const out = new Float32Array(sr * 24);
    for (let i = 0; i < out.length; i++) { const c = chords[Math.floor(i / (sr * 2)) % chords.length], t = i / sr; let v = 0;
      c.forEach((n, j) => { v += (j ? .15 : .25) * Math.sin(2 * Math.PI * midi(j ? n : n - 12) * t) + .05 * Math.sin(4 * Math.PI * midi(n) * t); }); out[i] = v; }
    return out; };
  for (const [tonic, mode, chords] of [[0, 'major', [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]]], [9, 'minor', [[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]]],
    [4, 'minor', [[64, 67, 71], [60, 64, 67], [62, 66, 69], [59, 63, 66], [64, 67, 71]]], [6, 'major', [[66, 70, 73], [71, 75, 78], [73, 77, 80], [66, 70, 73]]]]) {
    const key = analyzeKey(progression(chords), sr);
    assert.ok(key.tonic === tonic && key.mode === mode, `key detection: expected ${tonic} ${mode}, got ${key.tonic} ${key.mode}`);
  }
  console.log('PASS key detection: C major, A minor, E minor and F♯ major progressions');
  // Chords along the beat grid: C–F–G–Am, two seconds each, on a 120 BPM grid.
  const { analyzeChords } = await import('../static/tempo-analysis.js');
  const chordPcm = progression([[60, 64, 67], [65, 69, 72], [67, 71, 74], [57, 60, 64]]), chordGrid = Array.from({ length: 48 }, (_, i) => i * .5);
  const changes = analyzeChords(chordPcm, sr, chordGrid, analyzeKey(chordPcm, sr)), truth = [[0, 0], [5, 0], [7, 0], [9, 1]];
  const chordAt = time => changes.reduce((found, change) => change[0] <= time + 1e-9 ? change : found, changes[0]);
  const right = chordGrid.filter(time => { const [, root, minor] = chordAt(time + .25), [r, m] = truth[Math.floor(time / 2) % 4]; return root === r && minor === m; }).length;
  assert.ok(right / chordGrid.length >= .9 && changes.length <= 14, `chords follow C–F–G–Am (${right}/${chordGrid.length} beats, ${changes.length} changes)`);
  console.log('PASS chord analysis: C–F–G–Am on the beat grid, without flicker');

  // Hardstyle: a kick on each beat while playing forward, tuned to the root, song ducked.
  const { kickTune, kitLanes: lanesOf } = await import('../static/tempo-grid.js');
  const kickSteps = name => lanesOf(name).steps, floor = kickSteps('Classic');
  const kickEngine = (motorRate, settings, music = 0, seconds = 12) => {
    const e = new Processor();
    e.command({ type: 'settings', settings: { surface: false, contacts: false } });
    e.command({ type: 'load', channels: [new Float32Array(rate * seconds).fill(music)], sampleRate: rate });
    e.command({ type: 'beats', beats: Float64Array.from({ length: Math.ceil(seconds * 2) + 2 }, (_, i) => .2 + i * period), downbeat: 0 });
    if (settings) e.command({ type: 'kick', settings });
    e.command({ type: 'control', revision: 1, enabled: true, contact: true, motorRate, holding: false, immediate: true, position: 1 / seconds });
    return e;
  };
  const capture = (e, seconds) => { const out = [], times = []; for (let left = Math.round(seconds * rate); left > 0; left -= 128) { const o = [new Float32Array(128), new Float32Array(128)]; e.process([], [o]); for (const v of o[0]) out.push(v); times.push(e.position / rate); } return { out, times }; };
  const tune = kickTune('auto', { tonic: 9 });
  const kicking = kickEngine(1, { enabled: true, volume: .7, drive: .6, tail: .5, tune, steps: floor, duck: .6 });
  capture(kicking, .05); const before = kicking.kick.fired ?? 0;
  const { out } = capture(kicking, 3);
  const fired = (kicking.kick.fired ?? 0) - before;
  assert.ok(fired === 6, `one kick per beat while playing (${fired} in 3 s at 120 BPM)`);
  // Tail pitch: zero crossings 150–400 ms after a kick.
  // Window 120–320 ms after the kick: past the click, before the next kick even at 45 RPM.
  const start = Math.round(rate * .12), span = Math.round(rate * .2); let crossings = 0;
  const kickStart = out.findIndex(v => Math.abs(v) > .2);
  for (let i = kickStart + start; i < kickStart + start + span; i++) if (out[i - 1] <= 0 && out[i] > 0) crossings++;
  near(crossings / (span / rate), tune, tune * .08, 'kick tail sits on the tuned root (A ≈ 55 Hz)');
  const fast = kickEngine(1.35, { enabled: true, volume: .7, drive: .6, tail: .5, tune, steps: floor, duck: .6 });
  capture(fast, .05); const fastOut = capture(fast, 1.5).out, fastStart = fastOut.findIndex(v => Math.abs(v) > .2); let fastCrossings = 0;
  for (let i = fastStart + start; i < fastStart + start + span; i++) if (fastOut[i - 1] <= 0 && fastOut[i] > 0) fastCrossings++;
  near(fastCrossings / (span / rate), tune * 1.35, tune * .12, 'at 45 RPM the kick retunes with the record');
  const half = kickEngine(1, { enabled: true, volume: .7, drive: .6, tail: .5, tune, steps: kickSteps('Half time'), duck: .6 });
  capture(half, 3.05); assert.equal(half.kick.fired, 3, 'half time fires every other beat');
  // Build ("do do do do do do do dodo do"): 8ths with a double at the bar's end = 9 per bar.
  const build = kickEngine(1, { enabled: true, volume: .7, drive: .6, tail: .5, tune, steps: kickSteps('Build'), duck: .6 });
  capture(build, .17); const buildBefore = build.kick.fired ?? 0; capture(build, 2);
  assert.equal((build.kick.fired ?? 0) - buildBefore, 9, 'the Build kick bar fires 9 kicks per bar');
  const stopped = kickEngine(0, { enabled: true, volume: .7, tune, steps: floor }); capture(stopped, 2); assert.ok(!stopped.kick.fired, 'no kicks while the record is stopped');
  const seeking = kickEngine(1, { enabled: true, volume: .7, tune, steps: floor });
  seeking.command({ type: 'control', revision: 2, enabled: true, contact: true, motorRate: 1, holding: false, immediate: true, seekTarget: .9, seekDuration: 1.2 });
  capture(seeking, 1); assert.ok(!seeking.kick.fired, 'seeking across beats fires no kicks');
  const ducked = kickEngine(1, { enabled: true, volume: .7, tune, steps: floor, duck: .6 }, .5); capture(ducked, .25); // 50 ms after the 1.2 s kick
  assert.ok(ducked.kick.duck > .1, `the song ducks under each kick (${ducked.kick.duck.toFixed(2)})`);
  console.log('PASS hardstyle kick bar: four on the floor, half time and Build fire on their 16ths; tuned to the root, retunes at 45 RPM, none when stopped or seeking, song ducks');
  const off = kickEngine(1, { enabled: false, volume: .7, tune }, .3), plain = kickEngine(1, null, .3);
  const a = capture(off, 1).out, b = capture(plain, 1).out;
  assert.equal(Math.max(...a.map((v, i) => Math.abs(v - b[i]))), 0, 'with hardstyle off the output is unchanged');
  console.log('PASS hardstyle off: output identical');

  // Kit: claps on 2 and 4, open hats on the offbeats, crashes every 8 bars; drops build, pause, land.
  const kitLanes = lanesOf;
  const kitSettings = (extra = {}) => ({ enabled: true, volume: .7, drive: .6, tail: .5, tune, ...kitLanes('Classic'), crashEvery: 8, duck: .6, ...extra });
  const kit = kickEngine(1, kitSettings());
  capture(kit, .17); const at = { ...kit.kick }; capture(kit, 2);   // one bar at 120 BPM
  assert.ok(kit.kick.claps - at.claps === 2 && kit.kick.hats - at.hats === 4 && kit.kick.fired - at.fired === 4, `Classic bar: 4 kicks, 2 claps, 4 hats (${kit.kick.fired - at.fired}/${kit.kick.claps - at.claps}/${kit.kick.hats - at.hats})`);
  const long = kickEngine(1, kitSettings(), 0); capture(long, 9.5);
  assert.ok(long.kick.crashes >= 1 && long.kick.crashes <= 2, `crash on bar 1 of every 8 (${long.kick.crashes} in ~5 bars)`);
  console.log('PASS hardstyle kit: kick, clap and hat lanes, crash every 8 bars');
  const dropping = kickEngine(1, kitSettings({ horn: true }), .5); capture(dropping, .1);
  dropping.command({ type: 'drop' });
  const startBar = Math.floor((dropping.gate.beat - dropping.gate.downbeat) / 4);
  let pauseGain = 1, built = { kicks: 0 }, landed = null;
  const before2 = { ...dropping.kick };
  for (let block = 0; block < Math.round(rate * 5 / 128); block++) {
    const o = [new Float32Array(128), new Float32Array(128)]; dropping.process([], [o]);
    const bar = Math.floor((dropping.gate.beat - dropping.gate.downbeat) / 4), inBar = ((dropping.gate.beat - dropping.gate.downbeat) / 4) % 1;
    if (bar === startBar + 1 && inBar > .8) pauseGain = Math.min(pauseGain, dropping.kick.musicGain);
    if (bar === startBar + 1 && inBar < .74) built.kicks = dropping.kick.fired - before2.fired;
    if (bar === startBar + 2 && inBar > .05 && !landed) landed = { crashes: dropping.kick.crashes - before2.crashes, horns: dropping.kick.horns - before2.horns };
  }
  assert.ok(dropping.kick.drops === 1 && built.kicks >= 11, `drop build rolls the kick in sixteenths (${built.kicks})`);
  assert.ok(pauseGain < .3, `the beat before the drop pauses the music (${pauseGain.toFixed(2)})`);
  assert.ok(landed && landed.crashes >= 1 && landed.horns === 1, `the drop lands with a crash and the air horn (${JSON.stringify(landed)})`);
  const random = kickEngine(1, kitSettings({ drops: true, seed: 3 }), 0, 80); capture(random, 70);
  const calm = kickEngine(1, kitSettings({ drops: false }), 0, 80); capture(calm, 70);
  assert.ok(random.kick.drops >= 1 && !calm.kick.drops, `random drops happen at phrase ends only when switched on (${random.kick.drops})`);
  console.log('PASS hardstyle drops: build, one-beat pause, crash + air horn landing; random drops on phrase ends');

  // Kick sounds: each renders clean and bounded; Techno drive rumbles between kicks; Rawstyle screeches.
  const sound = name => { const e = kickEngine(1, { enabled: true, volume: 1, drive: .6, tail: .5, tune, steps: floor, sound: name, duck: .6 }); capture(e, .16); return capture(e, 2).out; };
  const between = out => { const k = out.findIndex(v => Math.abs(v) > .2); let sum = 0; for (let i = k + Math.round(rate * .33); i < k + Math.round(rate * .45); i++) sum += out[i] * out[i]; return sum; };
  const rendered = Object.fromEntries(['euphoric', 'raw', 'techno', 'gabber'].map(name => [name, sound(name)]));
  for (const [name, out] of Object.entries(rendered)) assert.ok(out.every(Number.isFinite) && Math.max(...out.map(Math.abs)) < 1.17, `${name} kick renders clean and bounded by the kit bus clipper`);
  assert.ok(between(rendered.techno) > between(rendered.gabber) * 10, 'Techno drive rumbles between kicks');
  const power = (x, f) => { const w = 2 * Math.PI * f / rate, c = 2 * Math.cos(w); let a = 0, b = 0; for (const v of x) { const y = v + c * a - b; b = a; a = y; } return a * a + b * b - c * a * b; };
  const band900 = out => power(out.slice(0, Math.round(rate * .4)), 900);
  assert.ok(band900(rendered.raw) > band900(rendered.euphoric) * 1.5, 'Rawstyle adds its nasal ~900 Hz screech');
  console.log('PASS kick sounds: Euphoric, Rawstyle (screech), Techno drive (rumble) and Gabber render clean and distinct');

  // 8-bar phrases: presets carry fills in bars 4 and 8, and the engine plays the whole phrase.
  const { KIT_STEPS, catLanes } = await import('../static/tempo-grid.js');
  const classic = kitLanes('Classic');
  assert.ok(['steps', 'clap', 'hat'].every(key => classic[key].length === KIT_STEPS), 'kit presets are 8-bar phrases');
  const phrase = kickEngine(1, kitSettings({ crashEvery: 0 }), 0, 24); capture(phrase, 17);
  // The read head starts at 1 s and enters sixteenths 7…142 (grid from 0.2 s, 8 per second).
  let expected = 0, oneBar = 0; for (let s = 7; s <= 142; s++) { expected += classic.steps[s % KIT_STEPS]; oneBar += classic.steps[s % 16]; }
  assert.ok(Math.abs(phrase.kick.fired - expected) <= 1 && expected - oneBar >= 4, `the kick plays the 8-bar phrase with its fills (${phrase.kick.fired} kicks, phrase ${expected}, one bar ${oneBar})`);
  console.log('PASS hardstyle phrases: 8-bar presets with fills in bars 4 and 8 play through the engine');

  // 8-bit mode: a chip band on the sixteenths in the song's key and chords, over the crunched record.
  const { CHIP_SOUND_NAMES, chipLanes } = await import('../static/tempo-grid.js');
  const chipEngine = (motorRate, settings, chords, music = .3, seconds = 12) => {
    const e = new Processor();
    e.command({ type: 'settings', settings: { surface: false, contacts: false } });
    e.command({ type: 'load', channels: [Float32Array.from({ length: rate * seconds }, (_, i) => music * Math.sin(2 * Math.PI * 220 * i / rate))], sampleRate: rate });
    e.command({ type: 'beats', beats: Float64Array.from({ length: Math.ceil(seconds * 2) + 2 }, (_, i) => .2 + i * period), downbeat: 0 });
    if (chords) e.command({ type: 'chords', ...chords });
    if (settings) e.command({ type: 'chip', settings });
    e.command({ type: 'control', revision: 1, enabled: true, contact: true, motorRate, holding: false, immediate: true, position: 1 / seconds });
    return e;
  };
  const chipSettings = (extra = {}) => ({ enabled: true, volume: .6, crunch: .5, sound: 'console', chords: true, drumsOn: true, ...chipLanes('Sparkle'), tonic: 0, minor: false, ...extra });
  const pitchClass = frequency => ((Math.round(12 * Math.log2(frequency / 440)) + 9) % 12 + 12) % 12;
  // C major until 3 s, then A minor (song seconds; the read head starts at 1 s).
  const band = chipEngine(1, chipSettings(), { times: [0, 3], roots: [0, 9], minors: [0, 1] }), events = [];
  const onStep = band.chip.onStep.bind(band.chip);
  band.chip.onStep = (step, t) => {
    const before = { notes: band.chip.notes, stabs: band.chip.stabs }; onStep(step, t);
    events.push({ step, t, lead: band.chip.lead.frequency, fresh: band.chip.notes > before.notes, bass: band.chip.bass.frequency, stab: [...band.chip.stab.notes], stabbed: band.chip.stabs > before.stabs });
  };
  let peak = 0;
  for (let block = 0; block < Math.round(rate * 3.5 / 128); block++) {
    const o = [new Float32Array(128), new Float32Array(128)]; band.process([], [o]);
    for (const v of o[0]) peak = Math.max(peak, Math.abs(v));
  }
  const notes = events.filter(event => event.fresh), inC = notes.filter(event => event.t > 1.05 && event.t < 2.95), inAm = notes.filter(event => event.t > 3.05);
  assert.ok(inC.every(event => [0, 2, 4, 7, 9].includes(pitchClass(event.lead))), 'the melody stays in the key (C major pentatonic)');
  const onBeat = list => list.filter(event => ((event.step % 4) + 4) % 4 === 0).map(event => pitchClass(event.lead));
  assert.ok(onBeat(inC).length >= 3 && onBeat(inC).every(pc => [0, 4, 7].includes(pc)), `notes on the beat land on the C chord (${onBeat(inC)})`);
  assert.ok(onBeat(inAm).length >= 1 && onBeat(inAm).every(pc => [9, 0, 4].includes(pc)), `after the change they land on A minor (${onBeat(inAm)})`);
  assert.deepEqual([...new Set(events.filter(event => event.t > 1.05 && event.t < 2.95 && event.step % 2 === 0).map(event => pitchClass(event.bass)))], [0], 'the bass bounces on the root');
  const stabs = events.filter(event => event.stabbed);
  assert.ok(stabs.length >= 5 && stabs.every(event => ((event.step % 4) + 4) % 4 === 2), 'chip chords stab on the offbeat eighths');
  assert.deepEqual(stabs.filter(event => event.t > 3.05).at(-1).stab.map(pitchClass), [9, 0, 4], 'chip chords arpeggiate the current chord (A minor)');
  assert.ok(band.chip.notes >= 20 && band.chip.bassNotes >= 12 && band.chip.hits >= 10, `Sparkle plays sixteenths with bass and drums (${band.chip.notes} notes, ${band.chip.hits} drum hits in 3.5 s at 120 BPM)`);
  assert.ok(peak < 1.2, `the band stays bounded (${peak.toFixed(2)})`);
  const bare = chipEngine(1, chipSettings({ chords: false, drumsOn: false })); capture(bare, 2);
  assert.ok(bare.chip.stabs === 0 && bare.chip.hits === 0 && bare.chip.notes > 8, 'chip chords and drums switch off');
  // Each sound chip renders clean and bounded, and they sound different.
  const sounds = Object.fromEntries(Object.keys(CHIP_SOUND_NAMES).map(name => { const e = chipEngine(1, chipSettings({ sound: name }), null, 0); return [name, capture(e, 2).out]; }));
  for (const [name, out] of Object.entries(sounds)) assert.ok(out.every(Number.isFinite) && Math.max(...out.map(Math.abs)) < 1.2 && Math.max(...out.map(Math.abs)) > .05, `the ${name} chip renders clean and bounded`);
  const difference = (a, b) => a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0) / a.reduce((sum, v) => sum + v * v, 0);
  assert.ok(difference(sounds.console, sounds.pocket) > .05 && difference(sounds.console, sounds.computer) > .05, 'Console, Pocket and Computer chips sound different');
  // Power up: the jingle starts on the next beat and rises.
  const powered = chipEngine(1, chipSettings({ drumsOn: false, chords: false }), null, 0); capture(powered, .3);
  powered.command({ type: 'powerup' }); capture(powered, .6);
  assert.ok(powered.chip.powerUps === 1 && powered.chip.jingle.notes.every((f, i, all) => !i || f > all[i - 1]), 'Power up plays one rising jingle on the next beat');
  const stoppedChip = chipEngine(0, chipSettings()); capture(stoppedChip, 2); assert.equal(stoppedChip.chip.notes, 0, 'no notes while the record is stopped');
  const seekingChip = chipEngine(1, chipSettings());
  seekingChip.command({ type: 'control', revision: 2, enabled: true, contact: true, motorRate: 1, holding: false, immediate: true, seekTarget: .9, seekDuration: 1.2 });
  capture(seekingChip, 1); assert.equal(seekingChip.chip.notes, 0, 'seeking plays no notes');
  // Without chords the band plays in the key: the bass sits on its root (G).
  const keyed = chipEngine(1, chipSettings({ tonic: 7, minor: false })); capture(keyed, .6);
  assert.equal(pitchClass(keyed.chip.bass.frequency), 7, 'without detected chords the band plays the key (G)');
  // Crunch alone (band silent): 4-bit/4 kHz audibly changes the record; 0 leaves it untouched.
  const plainChip = chipEngine(1, null), clean = chipEngine(1, chipSettings({ volume: 0, crunch: 0 })), crushed = chipEngine(1, chipSettings({ volume: 0, crunch: 1 }));
  const reference = capture(plainChip, 1).out, cleanOut = capture(clean, 1).out, crushedOut = capture(crushed, 1).out;
  assert.equal(Math.max(...cleanOut.map((v, i) => Math.abs(v - reference[i]))), 0, 'crunch 0 with the band silent leaves the record unchanged');
  const error = difference(crushedOut, reference) * reference.reduce((sum, v) => sum + v * v, 0) / crushedOut.reduce((sum, v) => sum + v * v, 0);
  assert.ok(error > .003 && error < .5, `full crunch degrades the record audibly but keeps it (${(10 * Math.log10(error)).toFixed(1)} dB error)`);
  const offChip = chipEngine(1, { ...chipSettings(), enabled: false }), offOut = capture(offChip, 1).out, plainOut = capture(chipEngine(1, null), 1).out;
  assert.equal(Math.max(...offOut.map((v, i) => Math.abs(v - plainOut[i]))), 0, 'with 8-bit mode off the output is unchanged');
  console.log('PASS 8-bit mode: pulse lead in the key and on the chord, octave bass, offbeat chip chords, drums, three sound chips, power-up, crunch; silent when stopped, seeking or off');
}
