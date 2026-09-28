// Compare production scrub modes on the same original PCM and pointer schedule.
// No browser, personal media, or external DSP library is needed. Measurements are
// taken before cartridge coloration/master volume; the review WAV uses 69% gain.
// Optional baseline: --baseline /tmp/saved-worklet.js
// Save baseline metrics only: add --capture-baseline before changing production.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.join(root, 'artifacts');
fs.mkdirSync(artifact, { recursive: true });
const rate = 48000, fileRate = 48000, duration = 64;
const baselinePath = process.argv[process.argv.indexOf('--baseline') + 1];
const baselineOnly = process.argv.includes('--capture-baseline');
const hasBaseline = process.argv.includes('--baseline') && fs.existsSync(baselinePath);
assert.ok(!baselineOnly || hasBaseline, '--capture-baseline requires an existing --baseline worklet');

function processor(file) {
  const seen = new Set();
  function source(filename) {
    if (seen.has(filename)) return '';
    seen.add(filename);
    const text = fs.readFileSync(filename, 'utf8');
    const imports = [...text.matchAll(/^import .*?from ['"](.+)['"];?$/gm)];
    const dependencies = imports.map(match => source(path.resolve(path.join(root, 'static'), match[1]))).join('\n');
    return dependencies + '\n' + text.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  }
  let Processor;
  const scope = { sampleRate: rate, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (_, type) => { Processor = type; },
  };
  vm.runInNewContext(source(file), scope);
  return { Processor, scope };
}

// An original eight-second musical phrase, repeated to a realistic song length.
// It has bass, changing triads, melody, kick, snare and hats, not just a DC ramp.
function music() {
  const frames = 8 * fileRate, phrase = [new Float32Array(frames), new Float32Array(frames)];
  const progression = [[130.8128,155.5635,195.9977],[103.8262,130.8128,155.5635],
    [116.5409,146.8324,174.6141],[97.9989,123.4708,146.8324]];
  const melody = [391.9954,466.1638,523.2511,391.9954,311.127,391.9954,466.1638,523.2511,
    349.2282,466.1638,587.3295,523.2511,391.9954,493.8833,587.3295,391.9954];
  let seed = 120;
  for (let i = 0; i < frames; i++) {
    const t = i / fileRate, chord = progression[Math.floor(t / 2)], local = t % 2, beat = t % .5;
    const envelope = Math.min(1, local / .03) * (.6 + .4 * Math.exp(-local / 1.4));
    const pad = chord.reduce((sum, hz) => sum + Math.sin(2*Math.PI*hz*t) + .2*Math.sin(4*Math.PI*hz*t), 0) * .044 * envelope;
    const bass = .16 * Math.sin(2*Math.PI*chord[0]/2*t) * Math.exp(-beat/.3);
    const lead = [1,2,3,5,7,11].reduce((sum, h) => sum + Math.sin(2*Math.PI*melody[Math.floor(t/.5)]*h*t)/h, 0) * .047 * Math.exp(-beat/.22);
    const age = t % 1, kick = .13*Math.sin(2*Math.PI*(48*age+3*(1-Math.exp(-age/.018))))*Math.exp(-age/.075);
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const noise = (seed >>> 0) / 4294967296 * 2 - 1;
    const hat = noise * .033 * Math.exp(-(t%.25)/.018), snare = noise * .075 * Math.exp(-((t+.5)%1)/.045);
    const side = .035 * Math.sin(2*Math.PI*chord[2]*t)*envelope;
    phrase[0][i] = pad+bass+lead+kick+hat+snare+side;
    phrase[1][i] = pad+bass+.78*lead+kick-.65*hat+snare-side;
  }
  return phrase.map(channel => {
    const pcm = new Float32Array(duration * fileRate);
    for (let i=0; i<8; i++) pcm.set(channel, i*frames);
    return pcm;
  });
}
const channels = music();
const schedules = {
  slow: { fractions: [.20,.24,.22,.26,.23], leg: 1 },
  fast: { fractions: [.20,.70,.30,.80,.40], leg: 1 },
  reversal: { fractions: [.20,.70,.30,.80,.40], leg: .15 },
};

function render(implementation, mode, schedule, condition='Very Good+', seconds=4) {
  const {Processor,scope} = implementation, p = new Processor();
  p.command({type:'load', channels, sampleRate:fileRate});
  p.command({type:'settings',settings:{condition,surface:true,contacts:false,wow:0,centering:0}});
  let revision=0;
  const command=patch=>p.command({type:'control',revision:++revision,enabled:true,contact:true,powered:true,
    holding:false,pause:false,motorRate:1,rpm:100/3,immediate:true,...patch});
  command({position:duration*.2});
  const identity = {pcm:p.channels[0],effects:p.effects,motor:p.motor};
  const left=[],right=[],rates=[];
  const block=n=>{
    const output=[new Float32Array(n),new Float32Array(n)];
    p.process([],[output]);scope.currentTime+=n/rate;
    left.push(...output[0]);right.push(...output[1]);rates.push(p.rate);
  };
  // Settle condition coefficients and motor before measuring each identical run.
  for(let i=0;i<40;i++)block(128);
  left.length=0;right.length=0;rates.length=0;
  command({position:duration*.2});
  const frames=Math.round(seconds*rate), eventFrames=rate/60;
  let lastPosition=duration*schedule.fractions[0];
  for(let frame=0;frame<frames;) {
    const elapsed=frame/rate;
    if(frame%eventFrames===0) {
      const leg=Math.min(schedule.fractions.length-2,Math.floor(elapsed/schedule.leg));
      const u=Math.min(1,elapsed/schedule.leg-leg);
      const position=duration*(schedule.fractions[leg]+(schedule.fractions[leg+1]-schedule.fractions[leg])*u);
      const velocity=frame ? (position-lastPosition)*60 : 0;
      if(mode==='manual') command({position,grooveScrub:true,scrubVelocity:velocity});
      else if(mode==='manual-reference') command({position});
      else if(mode==='hud') command({directScrub:true,scrubPosition:position,scrubVelocity:velocity});
      else if(mode==='click'&&frame%(rate/2)===0) {
        const destinations=[.7,.3,.8,.4,.6,.2,.8,.4];
        command({seekTarget:duration*destinations[Math.floor(elapsed*2)],seekDuration:.4});
      }
      lastPosition=position;
    }
    const n=Math.min(128,eventFrames-frame%eventFrames,frames-frame);
    block(n);frame+=n;
  }
  assert.equal(p.channels[0],identity.pcm,'scrubbing reuses decoded PCM');
  assert.equal(p.effects,identity.effects,'scrubbing reuses one effects instance');
  assert.equal(p.motor,identity.motor,'scrubbing reuses the existing motor');
  assert.ok(left.every(Number.isFinite)&&right.every(Number.isFinite),'output stays finite');
  return {channels:[Float32Array.from(left),Float32Array.from(right)],rates};
}

function fftPower(input,start,size=2048) {
  const re=new Float64Array(size),im=new Float64Array(size);
  for(let i=0;i<size;i++)re[i]=input[start+i]*(.5-.5*Math.cos(2*Math.PI*i/(size-1)));
  for(let i=1,j=0;i<size;i++) {
    let bit=size>>1;
    for(;j&bit;bit>>=1)j^=bit;
    j^=bit;
    if(i<j)[re[i],re[j]]=[re[j],re[i]];
  }
  for(let width=2;width<=size;width*=2) {
    const angle=-2*Math.PI/width;
    for(let offset=0;offset<size;offset+=width) {
      for(let k=0;k<width/2;k++) {
        const a=offset+k,b=a+width/2,cos=Math.cos(angle*k),sin=Math.sin(angle*k);
        const tr=re[b]*cos-im[b]*sin,ti=re[b]*sin+im[b]*cos;
        re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
      }
    }
  }
  return re.slice(0,size/2).map((x,i)=>x*x+im[i]*im[i]);
}
function stats(result) {
  const channels=result.channels,n=channels[0].length,count=channels.length;
  let energy=0,peak=0,jump=0,deltaEnergy=0,clipped=0;
  const windowRms=[];
  for(const pcm of channels)for(let i=0;i<n;i++) {
    const x=pcm[i];energy+=x*x;peak=Math.max(peak,Math.abs(x));clipped+=Number(Math.abs(x)>=1);
    if(i){const delta=x-pcm[i-1];jump=Math.max(jump,Math.abs(delta));deltaEnergy+=delta*delta;}
  }
  for(let i=0;i+480<=n;i+=480) {
    let sum=0;
    for(const pcm of channels)for(let j=0;j<480;j++)sum+=pcm[i+j]*pcm[i+j];
    windowRms.push(Math.sqrt(sum/(480*count)));
  }
  windowRms.sort((a,b)=>a-b);
  let spectralEnergy=0,high6k=0,high10k=0,weighted=0;
  for(const pcm of channels)for(let start=0;start+2048<=n;start+=1024) {
    const power=fftPower(pcm,start);
    for(let bin=1;bin<power.length;bin++) {
      const hz=bin*rate/2048,e=power[bin];spectralEnergy+=e;weighted+=e*hz;
      if(hz>=6000)high6k+=e;if(hz>=10000)high10k+=e;
    }
  }
  return {rms:Math.sqrt(energy/(n*count)),peak,maxSampleStep:jump,differenceRms:Math.sqrt(deltaEnergy/((n-1)*count)),
    p95TenMsRms:windowRms[Math.floor(windowRms.length*.95)],fullScaleSamples:clipped,
    energyAbove6kFraction:high6k/spectralEnergy,energyAbove10kFraction:high10k/spectralEnergy,
    spectralCentroidHz:weighted/spectralEnergy,
    readRateMin:Math.min(...result.rates),readRateMax:Math.max(...result.rates)};
}
function difference(a,b) {
  let sum=0,max=0;
  for(let c=0;c<a.channels.length;c++)for(let i=0;i<a.channels[c].length;i++) {
    const d=a.channels[c][i]-b.channels[c][i];sum+=d*d;max=Math.max(max,Math.abs(d));
  }
  return {rms:Math.sqrt(sum/(a.channels.length*a.channels[0].length)),peak:max};
}
// Measure the actual interpolated PCM slope, not merely the reported rate. A
// fraction/second motion should not become harsher on a longer or 44.1 kHz file.
function durationInvariance(implementation) {
  const measurements=[];
  for(const seconds of [8,690])for(const sourceRate of [48000,44100]) {
    const pcm=new Float32Array(seconds*sourceRate);
    for(let i=0;i<pcm.length;i++)pcm[i]=.1+.2*(i%sourceRate)/sourceRate;
    const p=new implementation.Processor();
    p.command({type:'load',channels:[pcm],sampleRate:sourceRate});
    p.command({type:'settings',settings:{surface:false,contacts:false,wow:0,centering:0}});
    let revision=0;
    const command=patch=>p.command({type:'control',revision:++revision,enabled:true,contact:true,powered:true,
      holding:false,pause:false,motorRate:1,rpm:100/3,immediate:true,...patch});
    const anchor=Math.floor(seconds*.4)+.25;
    command({position:anchor});
    const renderFrames=frames=>{
      const samples=[];
      for(let left=frames;left>0;) {
        const n=Math.min(73,left),out=[new Float32Array(n),new Float32Array(n)];
        p.process([],[out]);samples.push(...out[0]);left-=n;
      }
      return samples;
    };
    renderFrames(4096);
    for(const normalizedVelocity of [.05,-.05,.5,-.5,2,-2]) {
      command({directScrub:true,scrubPosition:anchor,scrubVelocity:normalizedVelocity*seconds});
      const samples=renderFrames(576);
      const measured=(samples[500]-samples[300])/((200/rate)*.2*p.gain);
      measurements.push({duration:seconds,sourceRate,normalizedVelocity,measuredRate:measured});
      assert.ok(Math.abs(measured-p.rate)<.0015,'actual interpolated PCM matches bounded local read rate');
      assert.equal(Math.sign(measured),Math.sign(normalizedVelocity),'PCM direction follows current motion');
      assert.ok(Math.abs(measured)<2.5,'long and 44.1 kHz sources retain safe local fragment rates');
      const reference=measurements.find(m=>m.normalizedVelocity===normalizedVelocity);
      assert.ok(Math.abs(measured-reference.measuredRate)<.0015,'the same normalized gesture sounds alike across duration/sample rate');
    }
  }
  return measurements;
}

function writeWav(filename,sections) {
  const silence=Math.round(rate*.35);
  const frames=sections.reduce((n,section)=>n+section.channels[0].length+silence,0);
  const wav=Buffer.alloc(44+frames*4);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(rate,24);
  wav.writeUInt32LE(rate*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(frames*4,40);
  let frame=0;
  for(const section of sections) {
    for(let i=0;i<section.channels[0].length;i++,frame++)for(let c=0;c<2;c++)
      wav.writeInt16LE(Math.round(Math.max(-1,Math.min(1,section.channels[c][i]*.69))*32767),44+frame*4+c*2);
    frame+=silence;
  }
  fs.writeFileSync(filename,wav);
}

const baseline=hasBaseline?processor(baselinePath):null;
const current=baselineOnly?null:processor(path.join(root,'static/vinyl-processor.js'));
const report={source:'Original 8-second stereo musical phrase repeated to 64 seconds; no sampled/personal media.',
  measurement:'48 kHz production worklet output, before cartridge/master. Review WAV scales by the 69% default volume; no headphone audition claimed.',
  baseline:{},current:{},differences:{},review:[]};
const recordings={};
for(const [name,schedule] of Object.entries(schedules)) {
  const seconds=name==='reversal'?.6:4;
  if(baseline) {
    const manual=render(baseline,'manual-reference',schedule,'Very Good+',seconds);
    const hud=render(baseline,'hud',schedule,'Very Good+',seconds);
    report.baseline[name]={manual:stats(manual),hud:stats(hud)};
    if(name==='fast')recordings.baselineManual=manual;
  }
  if(current) {
    const manual=render(current,'manual',schedule,'Very Good+',seconds);
    const hud=render(current,'hud',schedule,'Very Good+',seconds);
    report.current[name]={manual:stats(manual),hud:stats(hud)};
    report.differences[name]=difference(manual,hud);
    if(name==='fast'){recordings.manual=manual;recordings.hud=hud;}
  }
}
if(baseline) {
  report.baseline.click=stats(render(baseline,'click',schedules.fast));
  recordings.baselineNormal=render(baseline,'normal',schedules.fast);
  report.baseline.normal=stats(recordings.baselineNormal);
}
if(current) {
  report.durationInvariance=durationInvariance(current);
  recordings.normal=render(current,'normal',schedules.fast);
  recordings.click=render(current,'click',schedules.fast);
  report.current.normal=stats(recordings.normal);report.current.click=stats(recordings.click);
  if(recordings.baselineNormal)report.differences.normalPlayback=difference(recordings.baselineNormal,recordings.normal);
  for(const condition of ['Mint','Very Good+','Poor']) {
    const manual=render(current,'manual',schedules.fast,condition);
    const hud=render(current,'hud',schedules.fast,condition);
    report.current[condition]={manual:stats(manual),hud:stats(hud)};
    report.differences[condition]=difference(manual,hud);
  }
  const sections=[['Normal playback',recordings.normal],
    ...(recordings.baselineManual?[['Previous manual tonearm reference',recordings.baselineManual]]:[]),
    ['Current manual tonearm',recordings.manual],['Current HUD drag',recordings.hud],['Current click traversal',recordings.click]];
  let start=0;
  for(const [label,section]of sections){const length=section.channels[0].length/rate;report.review.push({label,start,end:start+length});start+=length+.35;}
  writeWav(path.join(artifact,'scrub-audio-ab.wav'),sections.map(([,recording])=>recording));
}
const filename=baselineOnly?'scrub-audio-baseline.json':'scrub-audio-comparison.json';
fs.writeFileSync(path.join(artifact,filename),JSON.stringify(report,null,2)+'\n');
console.log(`Audio metrics saved to artifacts/${filename}`);
for(const [name,entry]of Object.entries(report.current)) {
  const value=entry.hud??entry;
  console.log(`${name}: peak ${value.peak.toFixed(4)}, RMS ${value.rms.toFixed(4)}, >6kHz ${(value.energyAbove6kFraction*100).toFixed(3)}%, local rate ${value.readRateMin.toFixed(3)}…${value.readRateMax.toFixed(3)}×`);
}
if(!baselineOnly) {
  for(const mode of ['slow','fast','reversal']) {
    const {manual,hud}=report.current[mode];
    assert.ok(report.differences[mode].peak<1e-7,'equivalent manual/HUD anchor schedules produce the same PCM');
    assert.ok(Math.max(Math.abs(hud.readRateMin),Math.abs(hud.readRateMax))<=2.5,'HUD local fragments never inherit whole-song scan velocity');
    assert.equal(hud.fullScaleSamples,0,'no scrub clipping');
    assert.ok(hud.peak<.7,'scrub transient headroom remains bounded');
    assert.ok(hud.energyAbove6kFraction<.025,'music scrub does not create excessive high-frequency energy');
    assert.ok(hud.rms<=manual.rms*1.08,'HUD scrub is not louder than equivalent manual scrub');
  }
  assert.ok(report.current.click.readRateMax<=2.5&&report.current.click.readRateMin>=-2.5,'click traversal uses bounded fragment playback');
  assert.ok(report.current.click.energyAbove6kFraction<.025,'click traversal avoids high-frequency scanning noise');
  for(const condition of ['Mint','Very Good+','Poor'])assert.ok(report.differences[condition].peak<1e-7,`${condition} shares equivalent audio once per path`);
  if(report.differences.normalPlayback)assert.equal(report.differences.normalPlayback.peak,0,'ordinary playback stays sample-identical to baseline');
  for(const mode of ['slow','fast','reversal']) {
    assert.ok(report.current[mode].hud.rms<=report.current.normal.rms*1.05,'scrub stays below ordinary musical playback level');
    assert.ok(report.current[mode].hud.peak<=report.current.normal.peak*1.05,'scrub does not introduce peaks beyond ordinary playback');
  }
  console.log('PASS scrub audio comparison: slow/fast/reversal schedules, shared manual/HUD PCM, bounded fragment rates, click traversal, condition profiles, headroom, high-frequency energy, 8/690-second duration and 44.1/48 kHz source invariance.');
}
