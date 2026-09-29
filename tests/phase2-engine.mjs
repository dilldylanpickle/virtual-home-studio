import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let Processor;
const scope = {sampleRate:48000,currentTime:0, AudioWorkletProcessor:class{constructor(){this.port={postMessage(){}}}}, registerProcessor:(_,p)=>{Processor=p}};
const source=['condition-profiles.js','simulation-state.js','mechanics.js','vinyl-effects.js','vinyl-processor.js'].map(file=>fs.readFileSync(new URL('../static/'+file,import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/^export /gm,'')).join('\n');
vm.runInNewContext(source+'\nglobalThis.selectSpeed=deriveSpeed;',scope);
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} vs ${b}`);
function render(e,seconds){const samples=[];for(let n=Math.round(seconds*48000);n>0;){const k=Math.min(128,n);const out=[new Float32Array(k),new Float32Array(k)];e.process([],[out]);samples.push(...out[0]);scope.currentTime+=k/48000;n-=k;}assert.ok(samples.every(Number.isFinite));return samples;}
const rms=a=>Math.sqrt(a.reduce((n,x)=>n+x*x,0)/a.length);
function engine(hz=440){const e=new Processor();e.command({type:'settings',settings:{surface:false,contacts:false}});e.command({type:'load',channels:[Float32Array.from({length:48000*12},(_,i)=>.2*Math.sin(i*2*Math.PI*hz/48000))],sampleRate:48000});return e;}
for(const rpm of [100/3,45,78])for(const pitch of [-16,-8,0,8,16])for(const running of [true,false]){
 const s={power:true,platterRunning:running,speed33Pressed:rpm!==45,speed45Pressed:rpm!==100/3,pitch,quartzLock:false,transportPaused:false};
 let d=scope.selectSpeed(s);near(d.effectiveRate,(rpm/(100/3))*(1+pitch/100));
 s.quartzLock=true;d=scope.selectSpeed(s);near(d.effectivePitch,0);near(d.effectiveRate,rpm/(100/3));near(s.pitch,pitch);
 s.quartzLock=false;near(scope.selectSpeed(s).effectivePitch,pitch);
}
console.log('PASS state selectors: Quartz on/off derives every RPM and signed pitch immediately, independent of motor state.');
const e=engine();let c={type:'control',revision:0,enabled:true,contact:true,powered:true,holding:false,pause:false,motorRate:1,rpm:100/3};
const control=patch=>{c={...c,...patch,revision:c.revision+1};e.command(c);delete c.position;delete c.pausePosition;};
control({position:1});render(e,.4);
control({motorRate:1.08});render(e,.035);near(e.motorActualRate,1.08);
control({motorRate:1});render(e,.035);near(e.motorActualRate,1);
control({motorRate:2.34,rpm:78});render(e,.1);assert.ok(e.motorActualRate>1&&e.motorActualRate<2.34);render(e,.35);near(e.motorActualRate,2.34);
console.log('PASS motor corrections: pitch/Quartz settle in 35 ms; deliberate RPM transitions retain their full glide.');
const sourcePosition=e.position;
const index=Math.floor(sourcePosition), fraction=sourcePosition-index;
const nextSample=e.channels[0][index]+(e.channels[0][index+1]-e.channels[0][index])*fraction;
const anchor=e.position-100, angle=e.travel; // A UI snapshot can lag the rendering thread.
control({pause:true,motorRate:0,pausePosition:anchor/48000});let tail=render(e,.08);
near(tail[0],nextSample,1e-7); // Pause starts with the very next PCM sample, not a seek discontinuity.
near(e.position,anchor);assert.ok(e.rate>0&&e.rate<2.34);assert.ok(rms(tail)>.01);assert.ok(e.travel>angle);
render(e,.30);near(e.position,anchor);near(e.rate,0);assert.equal(rms(render(e,.1)),0);
control({pause:false,motorRate:2.34});render(e,.28);near(e.rate,2.34);near(e.position/48000-anchor/48000,.14*2.34,.00005);
console.log('PASS soft pause: audible slowdown, frozen logical groove, stationary silence, exact-groove ramped resume.');
control({pause:true,motorRate:0});render(e,.4);control({position:3});render(e,.05);near(e.position,3*48000);
control({holding:true});e.command({type:'scratch',delta:-.1});render(e,.16);near(e.position/48000,2.9,.00001);
control({holding:false});render(e,.1);near(e.position/48000,2.9,.00001);near(e.rate,0);
control({pause:false,motorRate:1});render(e,.28);near(e.position/48000,3.04,.00005);
control({pause:true,motorRate:0});render(e,.03);control({pause:false,motorRate:1});render(e,.03);control({pause:true,motorRate:0});const interrupted=e.position;render(e,.4);near(e.position,interrupted);near(e.rate,0);
console.log('PASS paused controls: seek/scratch share the logical groove; interrupted pause/resume settles without stale playback.');
// Compare the real readers: the HUD stop must sound exactly like physical STOP,
// while preserving its logical anchor. Resume must follow the same motor curve.
for (const target of [1, 1.35, 2.34]) {
 const physical=engine(), hud=engine();
 const base={type:'control',revision:1,enabled:true,contact:true,powered:true,holding:false,rpm:target*100/3};
 for (const reader of [physical,hud]) { reader.command({...base,motorRate:target,immediate:true,position:1});render(reader,.1); }
 const held=hud.position;
 physical.command({...base,revision:2,motorRate:0,pause:false});
 hud.command({...base,revision:2,motorRate:0,pause:true});
 const stop=render(physical,.4), pause=render(hud,.4);
 assert.deepEqual(pause,stop);near(hud.position,held);near(hud.rate,0);
 assert.ok(rms(pause.slice(9600,12000))>.01,'HUD stop remains audible after the old 160 ms cutoff');
 for (const reader of [physical,hud]) reader.command({...base,revision:3,motorRate:target,pause:false});
 for (let step=0;step<7;step++) {render(physical,.04);render(hud,.04);near(hud.rate,physical.rate);}
 near(hud.rate,target);
}
console.log('PASS HUD/physical parity: identical audible stop at 33/45/78 RPM and matching full startup curves.');
const wear=engine(12000);wear.command({...c,enabled:true,holding:false,pause:false,motorRate:1,rpm:100/3,immediate:true,position:1});render(wear,.1);
const clean=rms(render(wear,.1));const start=wear.position;
wear.command({type:'settings',settings:{surface:true,condition:'Poor'}});near(wear.effects.profile.wearAmount,0);
render(wear,.02);assert.ok(wear.effects.profile.wearAmount>0&&wear.effects.profile.wearAmount<.34);
render(wear,.05);const worn=rms(render(wear,.1));assert.ok(worn<clean*.6&&worn>clean*.2);assert.ok(wear.position>start);
wear.command({type:'settings',settings:{surface:false}});render(wear,.06);near(wear.effects.profile.wearAmount,0);near(rms(render(wear,.1)),clean,.00001);
assert.ok(Object.values(wear.effects.profile).every(x=>x===0));
console.log('PASS wear: live smoothed multi-parameter changes reduce high-frequency energy subtly; master bypass restores clean source without seeking.');
