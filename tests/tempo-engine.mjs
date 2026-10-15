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
vm.runInNewContext(['condition-profiles.js', 'mechanics.js', 'vinyl-effects.js', 'trance-gate.js', 'vinyl-processor.js']
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
