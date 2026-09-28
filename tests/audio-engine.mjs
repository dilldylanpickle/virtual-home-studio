// Exercise the production sample reader without a browser or audio device.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let Processor;
const messages = [];
const scope = {
  sampleRate: 48000, currentTime: 0,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => messages.push(m) }; } },
  registerProcessor: (_name, implementation) => { Processor = implementation; },
};
const source = ['condition-profiles.js', 'mechanics.js', 'vinyl-effects.js', 'vinyl-processor.js'].map(file => fs.readFileSync(new URL('../static/' + file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '')).join('\n');
vm.runInNewContext(source, scope);
const engine = new Processor();
engine.command({type:'settings', settings:{surface:false, contacts:false}});
const pcm = Float32Array.from({ length: 48000 * 4 }, (_, i) => .1 + .8 * i / (48000 * 4));
engine.command({ type: 'load', channels: [pcm], sampleRate: 48000 });
let revision = 0;
let controls = { enabled: true, motorRate: 1, holding: false, immediate:true };
function control(patch) {
  controls = { ...controls, ...patch };
  engine.command({ ...controls, type: 'control', revision: ++revision });
  delete controls.position;
}
function render(seconds, blockSize = 128) {
  const samples = [];
  for (let remaining = Math.round(seconds * 48000); remaining > 0;) {
    const count = Math.min(blockSize, remaining);
    const output = [new Float32Array(count), new Float32Array(count)];
    assert.equal(engine.process([], [output]), true);
    assert.ok(output[0].every(Number.isFinite), 'all audio samples are finite');
    assert.deepEqual(output[0], output[1], 'mono input reaches both output channels');
    samples.push(...output[0]);
    scope.currentTime += count / 48000;
    remaining -= count;
  }
  return samples;
}
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} versus ${expected}`);
control({ position: 1 });
let samples = render(.1);
near(engine.position / 48000, 1.1, 1e-6, 'forward playback cursor');
assert.ok(samples.at(-1) > samples[500], 'forward output reads the ramp in ascending order');
const beforeSeek = samples.at(-1);
control({ position: 3 });
samples = render(.01);
near(samples[0], beforeSeek, 1e-6, 'needle seek starts at the previous output value');
assert.ok(samples.every((v, i) => i === 0 || Math.abs(v - samples[i - 1]) < .01), 'seek crossfade avoids a discontinuous waveform step');
control({ position: 1.1 });
render(.01);
control({ holding: true });
render(.02);
const held = engine.position;
samples = render(.1, 256);
near(engine.position, held, 1e-6, 'holding does not advance audio');
assert.ok(samples.every((v) => v === 0), 'stationary vinyl outputs actual silence, not a constant sample');
engine.command({ type: 'scratch', delta: -.3 });
samples = render(.015);
assert.ok(samples.at(-1) < samples[300], 'reverse scratching reads PCM in descending order');
assert.ok(engine.rate < 0, 'reverse produces a negative sample rate');
render(.2);
near(engine.position / 48000, .81, 2e-6, 'reverse movement covers the commanded distance');
engine.command({ type: 'scratch', delta: .2 });
samples = render(.015);
assert.ok(samples.at(-1) > samples[300], 'forward scratching reads PCM in ascending order');
render(.2);
near(engine.position / 48000, 1.01, 2e-6, 'forward movement covers the commanded distance');
control({ holding: false, motorRate: 1.35 });
render(.06);
assert.ok(engine.rate > .6 && engine.rate < .8, 'motor catches up gradually after release');
render(.06);
near(engine.rate, 1.35, 1e-8, 'release finishes at selected speed');
control({ motorRate: 0, holding: true });
engine.command({ type: 'scratch', delta: -.1 });
render(.1);
assert.ok(engine.position / 48000 < 1.02, 'hand rotation works with motor stopped');
control({ holding: false });
const stopped = engine.position;
render(.1);
near(engine.position, stopped, 1e-6, 'release with stopped motor stays stopped');
control({ enabled: false, holding: true });
engine.command({ type: 'scratch', delta: .4 });
samples = render(.2);
near(engine.position, stopped, 1e-6, 'raised stylus does not follow scratch travel');
assert.ok(samples.slice(500).every((v) => v === 0), 'raised stylus stays silent');
control({ enabled: true, holding: false, motorRate: 1, position: 3.99 });
render(.2);
near(engine.position / 48000, 4, 1e-9, 'end boundary clamps correctly');
control({ holding: true });
engine.command({ type: 'scratch', delta: -.2 });
render(.2);
near(engine.position / 48000, 3.8, 2e-6, 'backward scratching recovers from end-of-side');
control({ position: .01 });
engine.command({ type: 'scratch', delta: -.5 });
render(.2);
near(engine.position, 0, 1e-9, 'beginning clamps without wrapping');
engine.command({ type: 'scratch', delta: .2 });
render(.2);
near(engine.position / 48000, .2, 2e-6, 'forward scratching recovers from beginning');
engine.command({ type: 'clear' });
samples = render(.1);
assert.ok(samples.slice(500).every((v) => v === 0), 'eject clears audio');
assert.equal(engine.channels.length, 0, 'eject releases PCM');
assert.ok(messages.length > 0 && messages.at(-1).revision === revision, 'clock reports identify their control revision');
console.log('PASS DSP: forward/reverse PCM order, stationary silence, exact scratch distance, release ramp, manual rotation, cue gating, boundaries, eject, variable block size.');

// RPM changes integrate the same motor curve into both the PCM cursor and platter.
const motor = new Processor();
motor.command({type:'settings', settings:{surface:false, contacts:false}});
motor.command({ type: 'load', channels: [pcm], sampleRate: 48000 });
let motorControl = { type: 'control', revision: 1, enabled: true, holding: false, motorRate: 1, rpm: 100 / 3 };
const setMotor = (patch) => {
  motorControl = { ...motorControl, ...patch, revision: motorControl.revision + 1 };
  motor.command(motorControl);
};
const runMotor = (seconds) => {
  for (let remaining = Math.round(seconds * 48000); remaining > 0;) {
    const count = Math.min(128, remaining);
    motor.process([], [[new Float32Array(count), new Float32Array(count)]]);
    scope.currentTime += count / 48000;
    remaining -= count;
  }
};
setMotor({});
runMotor(.28);
setMotor({ motorRate: 2.34, rpm: 78 });
near(motor.rate, 1, 1e-9, 'RPM change has no instantaneous rate jump');
const startPosition = motor.position / 48000;
const startTravel = motor.motorTravel;
runMotor(.225);
near(motor.rate, 1.67, 1e-8, 'acceleration reaches halfway speed at half transition');
near(motor.position / 48000 - startPosition, .225 + 1.34 * .45 * .09375, .00002, 'audio integrates the changing rate');
near(motor.position / 48000 - startPosition, motor.motorTravel - startTravel, 1e-8, 'platter and audio use identical motor travel');
setMotor({ motorRate: 1, rpm: 100 / 3 });
near(motor.rate, 1.67, 1e-8, 'rapid retarget preserves instantaneous speed');
runMotor(.225);
near(motor.rate, 1.335, 1e-8, 'deceleration passes through intermediate speeds');
setMotor({ enabled: false });
runMotor(.225);
near(motor.rate, 1, 1e-8, 'cue control does not restart the ramp');
setMotor({ holding: true, motorRate: 2.34, rpm: 78 });
runMotor(.225);
near(motor.rate, 0, 1e-8, 'held vinyl stays still during RPM change');
near(motor.motorActualRate, 1.67, 1e-8, 'motor accelerates under held vinyl');
runMotor(.225);
setMotor({ holding: false });
runMotor(.12);
near(motor.rate, 2.34, 1e-8, 'scratch release catches the transitioned motor');
setMotor({ motorRate: 1, rpm: 100 / 3 });
runMotor(.05);
setMotor({ motorRate: 0 });
assert.ok(motor.motor.rate > 0, 'STOP begins a coast instead of freezing');
runMotor(.36);
near(motor.rate, 0, 1e-8, 'STOP cancels a pending speed glide');
near(motor.motorActualRate, 0, 1e-8, 'STOP also stops platter motion');
console.log('PASS RPM DSP: continuous acceleration/deceleration, integrated audio/platter synchronization, rapid retarget, independent cue, held vinyl, release, stop.');
