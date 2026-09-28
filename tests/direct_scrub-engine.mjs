// Exercise the production worklet: the pointer anchor and short audible grain are
// independent, with no queued seek, frozen transport, or recreated PCM reader.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let Processor;
const reports = [];
const rate = 48000, duration = 60;
const scope = {sampleRate:rate, currentTime:0,
  AudioWorkletProcessor:class {constructor(){this.port={postMessage:m=>reports.push(m)}}},
  registerProcessor:(_,type)=>{Processor=type},
};
vm.runInNewContext(['condition-profiles.js','mechanics.js','vinyl-effects.js','vinyl-processor.js']
  .map(file=>fs.readFileSync(new URL('../static/'+file,import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,''))
  .join('\n'),scope);
const pcm=Float32Array.from({length:rate*duration},(_,i)=>.1+.6*i/(rate*duration));
const d=new Processor();
d.command({type:'load',channels:[pcm],sampleRate:rate});
d.command({type:'settings',settings:{surface:false,contacts:false}});
let state={enabled:true,contact:true,powered:true,holding:false,pause:false,motorRate:1,rpm:100/3,immediate:true};
let revision=0;
function command(patch={}) {
  d.command({...state,...patch,type:'control',revision:++revision});
  for(const key of Object.keys(state))if(key in patch)state[key]=patch[key];
}
function render(seconds,blockSize=128,processor=d) {
  const samples=[];
  for(let left=Math.round(seconds*rate);left>0;) {
    const n=Math.min(blockSize,left),out=[new Float32Array(n),new Float32Array(n)];
    processor.process([],[out]);samples.push(...out[0]);scope.currentTime+=n/rate;left-=n;
    if(!processor.effects.settings.surface) assert.deepEqual(out[0],out[1],'dry mono source reaches both channels');
  }
  assert.ok(samples.every(Number.isFinite),'scrub samples stay finite');
  return samples;
}
const near=(a,b,t,label)=>assert.ok(Math.abs(a-b)<=t,`${label}: ${a} vs ${b}`);
const rms=a=>Math.sqrt(a.reduce((sum,x)=>sum+x*x,0)/a.length);
command({position:5});render(.1);
const pcmIdentity=d.channels[0], motorIdentity=d.motor, effectsIdentity=d.effects;

// A pointer packet takes ownership immediately, before another render quantum.
command({seekTarget:50,seekDuration:.4});render(.08);
const travel=d.travel,motorTravel=d.motorTravel;
command({directScrub:true,scrubPosition:15,scrubVelocity:2});
near(d.position/rate,15,0,'pointer immediately owns the exact groove');
assert.equal(d.seek,null,'direct manipulation cancels click traversal');
let samples=render(.012);
near(d.position/rate,15,0,'audible grain never moves the logical pointer anchor');
near(d.travel-travel,.012,1e-9,'record keeps motor rotation during scrub');
near(d.motorTravel-motorTravel,.012,1e-9,'motor is independent from audio velocity');
near(samples[400],.9*(.1+.01*15),.00015,'actual attenuated PCM stays in the live pointer neighborhood');

// Measure local read speed from real PCM output. Large timeline distances must
// select different fragments without turning the whole record into ultrasonic audio.
const measuredRates=[];
for(const velocity of [.25,2,16,-.5,-8,-64,512,-800]) {
  command({directScrub:true,scrubPosition:30,scrubVelocity:velocity});
  samples=render(.012,73);
  const measured=(samples[550]-samples[250])/(300/rate)/(.01*.9);
  measuredRates.push({velocity,measured});
  assert.ok(Math.abs(measured)>=.999 && Math.abs(measured)<=1.252,`recognizable local PCM speed for ${velocity}: ${measured}`);
  near(measured,d.rate,.003,`reported velocity matches actual PCM at ${velocity}`);
  near(d.position/rate,30,0,`exact anchor at velocity ${velocity}`);
  assert.equal(Math.sign(measured),Math.sign(velocity),'actual PCM reverses in the next audio quantum');
}
assert.ok(measuredRates[2].measured>measuredRates[0].measured+.05,'faster input audibly changes fragment pitch within its musical range');
assert.ok(Math.abs(measuredRates.at(-1).measured)<=1.252,'an extreme reverse jump stays bounded');
console.log('PASS direct scrub PCM: immediate anchors, bounded measured forward/reverse rates, modest velocity sensitivity, independent motor and variable render blocks.');

// Equivalent physical headshell and timeline movement share the same low-level
// output, not merely similarly named state fields or independent gain controls.
const physical=new Processor(),hud=new Processor();
const pairControl={type:'control',revision:1,enabled:true,contact:true,powered:true,holding:false,pause:false,motorRate:1,rpm:100/3,immediate:true};
for(const processor of [physical,hud]) {
  processor.command({type:'load',channels:[pcm],sampleRate:rate});
  processor.command({type:'settings',settings:{surface:false,contacts:false}});
  processor.command({...pairControl,position:5});
  render(.1,128,processor);
}
for(const condition of [null,'Mint','Very Good+','Poor']) {
  if(condition) for(const processor of [physical,hud]) processor.command({type:'settings',settings:{surface:true,condition}});
  for(const [position,velocity] of [[10,1],[15,20],[30,500],[22,-50],[12,-2],[25,8]]) {
    physical.command({...pairControl,position,grooveScrub:true,scrubVelocity:velocity});
    hud.command({...pairControl,directScrub:true,scrubPosition:position,scrubVelocity:velocity});
    const manualSamples=render(.012,97,physical),hudSamples=render(.012,97,hud);
    assert.deepEqual(manualSamples,hudSamples,`manual/HUD actual PCM matches with ${condition??'dry'} at ${position}s, velocity ${velocity}`);
    near(hud.position/rate,position,0,'unified audio preserves HUD pointer ownership');
  }
}
console.log('PASS shared scrub PCM: physical headshell and HUD fragments match sample-for-sample for slow/fast forward and reverse motion, dry and with Mint/VG+/Poor condition processing.');

// A lost/stationary pointer cannot keep scanning or continue an old destination.
command({directScrub:true,scrubPosition:22,scrubVelocity:-32});
render(.018);
command({directScrub:true}); // A Quartz/pitch/control update is not fresh pointer motion.
render(.013);
near(d.position/rate,22,0,'watchdog holds the anchor exactly');
near(d.rate,0,0,'stale velocity expires');
near(rms(render(.05)),0,0,'stationary scrub is fully silent within 31 ms');
near(d.position/rate,22,0,'waiting does not catch up toward any destination');
command({directScrub:true,scrubPosition:24,scrubVelocity:8});render(.01);
command({directScrub:true,scrubPosition:24,scrubVelocity:0});render(.007);
near(rms(render(.01)),0,0,'explicit stationary packet fades within 7 ms');
for(let i=0;i<120;i++) {
  const position=15+(i%2)*25, velocity=i%2 ? 800 : -800;
  command({directScrub:true,scrubPosition:position,scrubVelocity:velocity});
  near(d.position/rate,position,0,'rapid pointer event always supersedes its predecessor');
  render(.001);
  assert.equal(Math.sign(d.rate),Math.sign(velocity),'rapid reversal is immediate');
}
command({directScrub:true,scrubPosition:36,scrubVelocity:0});render(.04);
near(d.position/rate,36,0,'rapid back-and-forth leaves only the last anchor');
assert.equal(d.channels[0],pcmIdentity,'all packets reuse decoded PCM');
assert.equal(d.motor,motorIdentity,'all packets reuse motor');
assert.equal(d.effects,effectsIdentity,'all packets reuse audio effects');
assert.equal(d.seek,null,'no seek destination remains after rapid input');
console.log('PASS direct scrub latency: fixed anchor, <31 ms stale-motion silence, <7 ms explicit stop, 120 immediate reversals, no cursor backlog or PCM/effect recreation.');

// Release restores transport at the exact anchor and preserves selected speed.
for(const [rpm,motorRate] of [[100/3,1],[45,1.35],[78,2.34]]) {
  command({rpm,motorRate,pause:false,directScrub:true,scrubPosition:30,scrubVelocity:4});
  render(.01);
  command({directScrub:false,scrubPosition:35});
  near(d.position/rate,35,0,'release lands at exact final pointer');
  render(.02);
  near(d.position/rate,35+.02*motorRate,1e-8,`playing release resumes at ${rpm} RPM`);
  assert.equal(d.rpm,rpm,'release preserves RPM');
}
command({pause:true,motorRate:0,immediate:false,directScrub:true,scrubPosition:20,scrubVelocity:3});
assert.ok(rms(render(.012))>.1,'paused transport still emits live scrub PCM');
command({directScrub:false,scrubPosition:42});render(.01);
near(d.position/rate,42,0,'paused release lands exactly');
near(rms(render(.04)),0,0,'paused release silences even during unfinished motor coast');
render(.2);near(d.position/rate,42,0,'paused release never advances its anchor');
command({pause:false,motorRate:1,immediate:true});render(.02);
near(d.position/rate,42.02,1e-8,'Play resumes the exact paused-scrub groove');
assert.ok(rms(render(.01))>.1,'Play re-enables music after paused scrub release');
// A previous paused scrub must not latch a mute over a later physical action.
command({pause:true,motorRate:0,directScrub:true,scrubPosition:30,scrubVelocity:2});render(.01);
command({directScrub:false,scrubPosition:30});render(.01);
command({seekTarget:40,seekDuration:.1});
assert.ok(rms(render(.04))>.1,'paused click seek remains audible after direct release');
render(.07);near(d.position/rate,40,1e-8,'paused click seek lands exactly after direct release');
command({directScrub:true,scrubPosition:30,scrubVelocity:2});render(.01);
command({directScrub:false,scrubPosition:30});
command({holding:true});d.command({type:'scratch',delta:-.1});
assert.ok(rms(render(.02))>.1,'physical scratching overrides the previous paused-release gate');
command({holding:false,position:12});render(.02);
near(d.position/rate,12,1e-8,'ordinary needle placement retains the correct paused anchor');
command({pause:false,motorRate:1});
console.log('PASS direct scrub release: playing resume at 33/45/78, paused audible preview, exact paused anchor, no coast leakage, Play/click/manual/scratch takeover clears the release gate.');

// Physical contact and power retain control of audio, never pointer position.
for(const gate of [{enabled:false,contact:false,powered:true},{enabled:true,contact:true,powered:false}]) {
  command({...gate,directScrub:true,scrubPosition:10,scrubVelocity:4});render(.01);
  near(rms(render(.01)),0,0,'raised cue or power off suppresses scrub music');
  near(d.position/rate,10,0,'muted scrub still owns exact groove');
}
command({enabled:true,contact:true,powered:true,directScrub:true,scrubPosition:0,scrubVelocity:-20});render(.04);
near(d.position,0,0,'beginning boundary does not wrap');near(d.scrubReadPosition,0,0,'reverse grain clamps at beginning');
command({directScrub:true,scrubPosition:duration,scrubVelocity:20});render(.04);
near(d.position/rate,duration,0,'end boundary does not wrap');near(d.scrubReadPosition,d.length,0,'forward grain clamps at end');
command({directScrub:false,scrubPosition:duration});render(.01);
assert.equal(d.region,'run-out','end release enters the existing run-out region');

// Competing physical intent and media lifecycle erase old direct control.
command({directScrub:true,scrubPosition:20,scrubVelocity:4});render(.01);
command({seekTarget:10,seekDuration:.1});assert.equal(d.directScrub,false,'new click traversal cancels scrub');render(.11);
assert.ok(d.position/rate<11,'old pointer destination does not return');
command({directScrub:true,scrubPosition:20,scrubVelocity:4});
command({holding:true});assert.equal(d.directScrub,false,'physical record scratching wins');
d.command({type:'scratch',delta:-.1});render(.1);assert.ok(d.position/rate<20,'physical scratch still reads backward');
command({holding:false,directScrub:true,scrubPosition:20,scrubVelocity:4});
command({position:8});assert.equal(d.directScrub,false,'manual needle placement cancels scrub');render(.02);assert.ok(d.position/rate<9);
command({directScrub:true,scrubPosition:20,scrubVelocity:4});
d.command({type:'clear'});render(.05);assert.equal(d.directScrub,false,'eject cancels scrub');near(d.position,0,0,'eject clears anchor');
near(rms(render(.05)),0,0,'ejected record stays silent');
d.command({type:'load',channels:[pcm],sampleRate:rate});
command({directScrub:true,scrubPosition:30,scrubVelocity:-4});
d.command({type:'load',channels:[pcm],sampleRate:rate});assert.equal(d.directScrub,false,'replacement cancels scrub');near(d.position,0,0,'replacement starts with its own groove');
assert.ok(reports.some(r=>r.directScrub)&&reports.some(r=>!r.directScrub),'clock reports expose direct-scrub lifecycle');
console.log('PASS direct scrub safety: cue and power gating, beginning/end/run-out, click/manual/scratch takeover, ejection/replacement reset and lifecycle reports.');
