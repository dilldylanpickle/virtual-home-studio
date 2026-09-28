// Sample-level mechanics and vinyl realism checks, independent of browser timing.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let Processor;
const scope = { sampleRate: 48000, currentTime: 0,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
  registerProcessor: (_, implementation) => { Processor = implementation; },
};
const source = ['condition-profiles.js', 'mechanics.js', 'vinyl-effects.js', 'vinyl-processor.js'].map(file => fs.readFileSync(new URL('../static/' + file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '')).join('\n');
vm.runInNewContext(source, scope);
function fixture(settings = {}, silence = false) {
  const e = new Processor();
  e.command({type:'settings', settings});
  e.command({type:'load', channels:[Float32Array.from({length:48000*5}, (_,i)=>silence ? 0 : .2*Math.sin(i*2*Math.PI*440/48000))], sampleRate:48000});
  return e;
}
function render(e, seconds) {
  const samples=[];
  for(let n=Math.round(seconds*48000);n>0;) {
    const count=Math.min(128,n), output=[new Float32Array(count),new Float32Array(count)];
    e.process([], [output]); samples.push(...output[0]); n-=count; scope.currentTime+=count/48000;
  }
  assert.ok(samples.every(Number.isFinite));
  return samples;
}
const rms = a => Math.sqrt(a.reduce((sum,x)=>sum+x*x,0)/a.length);
const near = (a,b,t=1e-5)=>assert.ok(Math.abs(a-b)<t,`${a} vs ${b}`);
const clean={surface:false,contacts:false};
const e=fixture(clean);
let c={type:'control',revision:1,enabled:true,contact:true,powered:true,holding:false,motorRate:1,rpm:100/3};
const control=patch=>{c={...c,...patch,revision:c.revision+1}; e.command(c); delete c.position;delete c.runIn;};
control({position:1});render(e,.07);
assert.ok(e.rate>0&&e.rate<.3);near(e.position/48000-1,e.motorTravel,1e-9);
render(e,.21);near(e.rate,1);near(e.motorTravel,.14,.00002);
const before=e.motorTravel;control({motorRate:0});render(e,.18);near(e.rate,.5);
render(e,.18);near(e.rate,0);near(e.motorTravel-before,.18,.00002);
const stopped=e.position;render(e,.1);near(e.position,stopped);
console.log('PASS mechanics: smooth 280 ms startup, 360 ms coast, exact integrated audio/platter travel.');
control({motorRate:1,position:0,runIn:true});
assert.equal(e.region,'run-in');assert.ok(e.position<0);
assert.ok(rms(render(e,1))<1e-9);near(e.position/48000,-.54,.00005);
render(e,.6);assert.equal(e.region,'music');assert.ok(rms(render(e,.1))>.1);
control({position:4.9});render(e,.2);assert.equal(e.region,'run-out');near(e.position/48000,5);
const travel=e.travel;assert.ok(rms(render(e,.15))<1e-9);assert.ok(e.travel>travel);
console.log('PASS virtual grooves: silent clean run-in delays source only, music begins naturally, run-out keeps rotating.');
const n=fixture({surface:true,contacts:false,condition:'Very Good'},true);
const nc={...c,enabled:true,contact:true,motorRate:1,immediate:true,position:5};n.command(nc);
assert.ok(rms(render(n,2))>0);assert.equal(n.region,'run-out');
n.command({...nc,enabled:false,contact:false});render(n,.05);assert.equal(rms(render(n,.2)),0);
n.command({...nc,holding:true});render(n,.1);assert.equal(rms(render(n,.2)),0);
n.command({...nc,contact:true,powered:false,enabled:false,motorRate:0});render(n,.05);assert.equal(rms(render(n,.2)),0);
console.log('PASS surface gating: run-out has noise; raised stylus, held vinyl and power-off are silent.');
const levels=[];
for(const condition of ['Mint','Near Mint','Very Good+','Very Good','Fair','Poor']) {
 const worn=fixture({surface:true,contacts:false,condition},true);
 worn.command({...nc,position:0});levels.push(rms(render(worn,12)));
}
assert.ok(levels.every((x,i)=>!i||x>levels[i-1]));assert.ok(levels.at(-1)<.03);
const worn=fixture({surface:true,contacts:false,condition:'Poor'},true);worn.command({...nc,position:0});
const first=render(worn,2),second=render(worn,2);assert.notDeepEqual(first,second);assert.ok(worn.effects.pops>0);
console.log('PASS record condition: ascending noise/wear, restrained levels, non-looping procedural crackle and dust.');
const contact=fixture({surface:false,contacts:true},true);
contact.command({...nc,position:1,motorRate:0});let sound=render(contact,.06);
assert.ok(rms(sound)>0&&Math.max(...sound)<.04);assert.equal(contact.effects.contacts,1);
contact.command({...nc,position:1,motorRate:0});render(contact,.06);assert.equal(contact.effects.contacts,1);
contact.command({...nc,contact:false,enabled:false,motorRate:0});sound=render(contact,.06);
assert.ok(rms(sound)>0);assert.equal(contact.effects.contacts,2);assert.equal(rms(render(contact,.1)),0);
contact.command({type:'clear'});contact.command({...nc});assert.equal(contact.effects.contacts,2);
console.log('PASS contact: one quiet drop/lift per actual contact edge, no cue-click retrigger, no contact on an empty platter.');
const w=fixture({...clean,wow:1,centering:1});w.command({...nc,position:1});
const rates=[];for(let i=0;i<100;i++){render(w,.01);rates.push(w.motorActualRate);}
assert.ok(Math.max(...rates)-Math.min(...rates)>.0005);assert.ok(rates.every(x=>Math.abs(x-1)<.0011));
assert.ok(Math.abs(w.position/48000-2)<.003);
w.command({type:'settings',settings:{wow:0,centering:0}});render(w,.02);near(w.motorActualRate,1);
console.log('PASS pressing imperfections: bounded wow/flutter and eccentricity; disabling restores exact nominal velocity.');
