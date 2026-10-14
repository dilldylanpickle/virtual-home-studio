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
vm.runInNewContext(['condition-profiles.js', 'mechanics.js', 'vinyl-effects.js', 'trance-gate.js', 'hardstyle.js', 'vinyl-processor.js']
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
}
