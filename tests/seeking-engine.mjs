// Actual worklet traversal: sample order, audio/physical clocks, retarget and cancellation.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let Processor;
const reports = [];
const scope = { sampleRate: 48000, currentTime: 0,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => reports.push(m) }; } },
  registerProcessor: (_, type) => { Processor = type; },
};
vm.runInNewContext(['condition-profiles.js', 'mechanics.js', 'vinyl-effects.js', 'vinyl-processor.js']
  .map(file => fs.readFileSync(new URL('../static/' + file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '')).join('\n'), scope);
const d = new Processor();
const rate = 48000, duration = 60;
const pcm = Float32Array.from({length: rate * duration}, (_, i) => .1 + .6 * i / (rate * duration));
d.command({type:'load', channels:[pcm], sampleRate:rate});
d.command({type:'settings',settings:{surface:false,contacts:false}});
let control = {type:'control',revision:0,enabled:true,contact:true,powered:true,motorRate:1,rpm:100/3,pause:false,holding:false,immediate:true};
function command(patch) { const next={...control,...patch,revision:++control.revision}; d.command(next); for(const key of ['enabled','contact','powered','motorRate','rpm','pause','holding','immediate']) if(key in patch)control[key]=patch[key]; }
function render(seconds) {
  const samples=[];
  for(let remaining=Math.round(seconds*rate);remaining>0;) {
    const n=Math.min(128,remaining), block=[new Float32Array(n),new Float32Array(n)];
    d.process([], [block]);samples.push(...block[0]);scope.currentTime+=n/rate;remaining-=n;
  }
  assert.ok(samples.every(Number.isFinite),'finite seek audio');
  return samples;
}
const near=(a,b,t,label)=>assert.ok(Math.abs(a-b)<=t,`${label}: ${a} vs ${b}`);
command({position:10});render(.03);
for(const [name,target,span] of [['short forward',12,.35],['long forward',52,.9],['short backward',50,.35],['long backward',8,.9]]) {
  const start=d.position/rate,travel=d.travel,motor=d.motorTravel;
  command({seekTarget:target,seekDuration:span});
  near(d.position/rate,start,1e-9,name+' begins at actual cursor');
  const samples=render(span/2),mid=d.position/rate;
  near(mid,(start+target)/2,.001,name+' traverses midpoint continuously');
  assert.ok((samples.at(-1)-samples[500])*(target-start)>0,name+' PCM reads in traversal direction');
  assert.equal(Math.sign(d.rate),Math.sign(target-start),name+' audio rate direction');
  assert.ok(Math.abs(d.rate)<=2.5,name+' audio speed stays bounded independently of logical traversal distance');
  const localRates=samples.slice(448).map((sample,i)=>(sample-samples[i+384])*rate/(64*.01*.9));
  const readable=localRates.filter(value=>Math.sign(value)===Math.sign(target-start) && Math.abs(value)>.98 && Math.abs(value)<1.27).length;
  assert.ok(readable/localRates.length>.6,`${name} keeps most PCM within recognizable local fragments: ${readable/localRates.length}`);
  near(d.travel-travel,span/2,.00001,name+' physical record maintains motor speed');
  near(d.motorTravel-motor,span/2,.00001,name+' motor remains independent');
  render(span/2+.02);assert.equal(d.seek,null,name+' completes');
  near(d.position/rate,target+.02,.0001,name+' resumes music from target');
}
command({pause:true,motorRate:0});render(.02);
const stationaryTravel=d.travel;
command({seekTarget:40,seekDuration:.8});
const pauseAudio=render(.4);
assert.ok(pauseAudio.some(x=>x>.2),'paused seek produces actual scrub audio');
assert.equal(d.paused,true,'paused seek retains pause');
near(d.travel,stationaryTravel,1e-9,'paused seek does not rotate vinyl');
render(.42);near(d.position/rate,40,1e-8,'paused target exact');
assert.ok(render(.1).every(x=>x===0),'paused seek finishes silent');
command({seekTarget:5,seekDuration:.8});render(.25);
const retargetFrom=d.position;
command({seekTarget:55,seekDuration:.7});near(d.position,retargetFrom,1e-8,'retarget never jumps to previous destination');
render(.2);assert.ok(d.position>retargetFrom,'retarget reverses traversal');
command({cancelSeek:true});const canceled=d.position;render(1);near(d.position,canceled,1e-8,'cancel removes stale destination');
command({enabled:false,contact:false,seekTarget:15,seekDuration:.5});
assert.ok(render(.5).every(x=>x===0),'raised cue keeps the entire traversal silent');
near(d.position/rate,15,1e-8,'raised cue still follows target');
command({enabled:true,contact:true,seekTarget:45,seekDuration:.7});render(.12);
command({holding:true});const scratchStart=d.position;
d.command({type:'scratch',delta:-.2});render(.2);assert.ok(d.position<scratchStart,'manual scratching cancels traversal and owns cursor');
command({holding:false,seekTarget:55,seekDuration:.8});render(.1);
command({position:5});render(.9);near(d.position/rate,5,1e-8,'manual needle seek cancels stale HUD traversal');
command({seekTarget:55,seekDuration:.8});render(.1);d.command({type:'clear'});render(1);
assert.equal(d.seek,null,'ejection clears traversal');assert.equal(d.length,0,'ejection clears audio');
assert.ok(reports.some(r=>r.seeking)&&reports.some(r=>!r.seeking),'audio clock reports traversal lifecycle');
console.log('PASS physical seek DSP: four directions/distances, bounded audible fragments with continuous logical traversal, independent physical motor, exact paused anchor, silent raised cue, seamless retarget, manual takeover and eject.');
