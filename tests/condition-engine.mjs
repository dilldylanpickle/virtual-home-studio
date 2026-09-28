// Quantitative condition model checks independent of UI timing and the output device.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const rate = 48000;
let Processor;
const scope = { sampleRate: rate, currentTime: 0,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
  registerProcessor: (_, value) => { Processor = value; },
};
const source = ['condition-profiles.js','mechanics.js','vinyl-effects.js','vinyl-processor.js']
  .map(name => fs.readFileSync(new URL('../static/'+name,import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,'')).join('\n');
vm.runInNewContext(source+'\nglobalThis.Effects=VinylImperfections;globalThis.profiles=CONDITIONS;globalThis.defaultCondition=DEFAULT_CONDITION;',scope);
const fresh = new Processor().effects;
assert.equal(scope.defaultCondition, 'Very Good+');
assert.equal(fresh.settings.condition, scope.defaultCondition);
assert.equal(fresh.settings.surface, true);
assert.equal(fresh.settings.contacts, true);
for (const [key, value] of Object.entries(scope.profiles[scope.defaultCondition])) {
  if (key !== 'visualWear') assert.equal(fresh.profile[key], value, `default audio parameter ${key}`);
}
assert.equal(fresh.highGain, Math.pow(10, -scope.profiles[scope.defaultCondition].highFrequencyLoss / 20));
console.log('PASS Very Good+ default: settings, every audio coefficient and treble gain agree before the first sample.');
const names = Object.keys(scope.profiles);
assert.deepEqual(names,['Mint','Near Mint','Very Good+','Very Good','Fair','Poor']);
for (const key of ['surfaceNoise','crackleDensity','crackleGain','popRate','popGain','wearAmount','highFrequencyLoss','saturation','stereoNarrowing','visualWear']) {
  const values=names.map(name=>scope.profiles[name][key]);
  assert.ok(values.every((n,i)=>!i||n>values[i-1]),key);
}
const rms = values => Math.sqrt(values.reduce((sum,n)=>sum+n*n,0)/values.length);
const db = n => 20*Math.log10(Math.max(n,1e-15));
function effect(condition) {
  const e=new scope.Effects(rate);e.configure({condition,contacts:false});
  for(let i=0;i<rate*.08;i++) e.sample(false,false,true,'music',1);
  return e;
}
function colorResponse(condition,frequency,amplitude=.4) {
  const e=effect(condition), samples=[];
  for(let i=0;i<rate*.35;i++) {
    const out=e.color(amplitude*Math.sin(2*Math.PI*frequency*i/rate),0);
    if(i>=rate*.1)samples.push(out);
  }
  return samples;
}
const noise=[];
for(const condition of names) {
  const e=effect(condition), first=[],second=[];
  for(let i=0;i<rate*8;i++) {
    const value=e.sample(true,true,true,'music',1);
    assert.ok(Number.isFinite(value));
    (i<rate*4?first:second).push(value);
  }
  noise.push({condition,rms:rms(first.concat(second)),crackles:e.crackles,pops:e.pops});
  assert.notDeepEqual(first,second);
  if(condition==='Poor') { assert.ok(e.crackles>150&&e.pops>10);assert.ok(e.crackles>e.pops*4); }
}
assert.ok(noise.every((n,i)=>!i||n.rms>noise[i-1].rms));
assert.ok(noise.at(-1).rms>.006&&noise.at(-1).rms<.025);
assert.ok(noise[0].rms<.00008);
const treble=names.map(name=>rms(colorResponse(name,11000)));
assert.ok(treble.every((n,i)=>!i||n<treble[i-1]));
assert.ok(db(treble.at(-1)/treble[0]) < -6);
const bass=names.map(name=>rms(colorResponse(name,110,.2)));
assert.ok(db(bass.at(-1)/bass[0])>-1);
// Tone coloration must introduce restrained harmonics only in worn profiles.
function harmonic(samples,hz) {
  let a=0,b=0;
  samples.forEach((x,i)=>{a+=x*Math.cos(i*2*Math.PI*hz/rate);b+=x*Math.sin(i*2*Math.PI*hz/rate);});
  return 2*Math.hypot(a,b)/samples.length;
}
const cleanTone=colorResponse('Mint',1000,.7),wornTone=colorResponse('Poor',1000,.7);
const distortion=harmonic(wornTone,3000)/harmonic(wornTone,1000);
assert.ok(harmonic(cleanTone,3000)<1e-8);
assert.ok(distortion>.005&&distortion<.05,distortion);
// Rapid live changes ramp from current coefficients and end exactly at Mint.
const e=effect('Mint');
e.configure({condition:'Poor'});e.sample(false,false,true,'music',1);
assert.ok(e.profile.wearAmount>0&&e.profile.wearAmount<.001);
for(let j=0;j<80;j++) {
  e.configure({condition:names[j%names.length]});
  for(let i=0;i<rate*.005;i++) {
    const s=e.sample(true,true,true,'music',1);
    assert.ok(Number.isFinite(s+e.color(.3,0)));
  }
}
e.configure({condition:'Mint'});
for(let i=0;i<rate*.07;i++)e.sample(false,false,true,'music',1);
assert.equal(e.profile.wearAmount,0);assert.equal(e.highGain,1);
assert.equal(e.profile.saturation,0);assert.equal(e.profile.stereoNarrowing,0);
assert.equal(e.crackleVoices.length,8);assert.equal(e.popVoices.length,4);
// Independent stereo PCM is narrowed by Poor, without changing the shared read clock.
function stereo(condition) {
  const p=new Processor();p.command({type:'settings',settings:{condition,contacts:false}});
  const channels=[0,1].map(c=>Float32Array.from({length:rate*2},(_,i)=>.3*Math.sin(2*Math.PI*440*i/rate)*(c?-1:1)));
  p.command({type:'load',channels,sampleRate:rate});
  p.command({type:'control',revision:1,enabled:true,contact:true,powered:true,motorRate:1,rpm:100/3,immediate:true,position:.2});
  const side=[];
  for(let n=0;n<rate*.4;n+=128){const out=[new Float32Array(128),new Float32Array(128)];p.process([],[out]);if(n>rate*.1)for(let i=0;i<128;i++)side.push((out[0][i]-out[1][i])*.5);}
  return {rms:rms(side),position:p.position,travel:p.travel};
}
const mint=stereo('Mint'),poor=stereo('Poor');
assert.ok(poor.rms<mint.rms*.85&&poor.rms>mint.rms*.6);
assert.equal(poor.position,mint.position);assert.equal(poor.travel,mint.travel);
console.log('PASS six-condition profiles: ordered surface, event density/intensity, wear, HF loss, saturation, stereo degradation and visual wear.');
console.log('PASS signal measurements: '+JSON.stringify({noise:noise.map(x=>({...x,db:db(x.rms)})),poorTrebleDb:db(treble.at(-1)/treble[0]),poorBassDb:db(bass.at(-1)/bass[0]),thirdHarmonicRatio:distortion}));
console.log('PASS independent nonperiodic crackles/pops, 60ms live ramps, exact Mint restoration, bounded voice pools, stereo/clock continuity.');
