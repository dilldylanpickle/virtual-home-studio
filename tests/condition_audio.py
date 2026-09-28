"""Capture actual browser output: six conditions, live A/B, wear and peak safety.

Run against the local server with `uv run --group dev python tests/condition_audio.py`.
The generated musical passage is original synthesis; no personal audio is needed.
The test-only recorder taps the same master node connected to the destination.
"""
import base64
import json
import math
import random
import struct
import tempfile
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
CONDITIONS = ['Mint', 'Near Mint', 'Very Good+', 'Very Good', 'Fair', 'Poor']
checks = []


def check(ok, message, **details):
    assert ok, f'{message}: {details}'
    checks.append({'check': message, **details})
    print(f'PASS {message}', flush=True)


def make_source(path):
    """64 seconds:32 original music,16 silence,8 calibrated probes,8 peak stress."""
    rate = 48000
    rng = random.Random(120)
    pattern = bytearray()
    progression = [(130.8128, 155.5635, 195.9977), (103.8262, 130.8128, 155.5635),
                   (116.5409, 146.8324, 174.6141), (97.9989, 123.4708, 146.8324)]
    melody = [391.9954, 466.1638, 523.2511, 391.9954, 311.1270, 391.9954, 466.1638, 523.2511,
              349.2282, 466.1638, 587.3295, 523.2511, 391.9954, 493.8833, 587.3295, 391.9954]
    for i in range(rate * 8):
        t = i / rate
        chord = progression[int(t // 2)]
        local = t % 2
        chord_envelope = min(1, local / .03) * (.6 + .4 * math.exp(-local / 1.4))
        pad = sum(math.sin(2 * math.pi * hz * t) + .2 * math.sin(2 * math.pi * hz * 2 * t)
                  for hz in chord) * .044 * chord_envelope
        beat = t % .5
        bass = .16 * math.sin(2 * math.pi * chord[0] / 2 * t) * math.exp(-beat / .30)
        note = melody[int(t / .5)]
        lead = sum(math.sin(2 * math.pi * note * harmonic * t) / harmonic
                   for harmonic in (1, 2, 3, 5, 7, 11)) * .047 * math.exp(-beat / .22)
        kick_age = t % 1
        kick = .13 * math.sin(2 * math.pi * (48 * kick_age + 3 * (1 - math.exp(-kick_age / .018)))) * math.exp(-kick_age / .075)
        hat_age = t % .25
        noise = rng.uniform(-1, 1)
        hat = noise * .033 * math.exp(-hat_age / .018)
        snare_age = (t - .5) % 1
        snare = noise * .075 * math.exp(-snare_age / .045)
        side = .035 * math.sin(2 * math.pi * chord[2] * t) * chord_envelope
        left = pad + bass + lead + kick + hat + snare + side
        right = pad + bass + .78 * lead + kick - .65 * hat + snare - side
        pattern.extend(struct.pack('<hh', round(left * 32767), round(right * 32767)))
    probe = bytearray()
    stress = bytearray()
    for i in range(rate):
        t = i / rate
        mid = .16 * math.sin(2 * math.pi * 220 * t) + .045 * math.sin(2 * math.pi * 3600 * t) + .045 * math.sin(2 * math.pi * 9600 * t)
        side = .08 * math.sin(2 * math.pi * 5400 * t)
        probe.extend(struct.pack('<hh', round((mid + side) * 32767), round((mid - side) * 32767)))
        # Full-scale plateaus maximize opportunities for a defect to exceed source headroom.
        value = .999 * math.tanh(9 * math.sin(2 * math.pi * 110 * t))
        stress.extend(struct.pack('<hh', round(value * 32767), round(value * 32767)))
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((2, 2, rate, 0, 'NONE', 'not compressed'))
        for _ in range(4):
            wav.writeframesraw(pattern)
        wav.writeframesraw(bytes(rate * 16 * 4))
        for _ in range(8):
            wav.writeframesraw(probe)
        for _ in range(8):
            wav.writeframesraw(stress)


PROBE = r'''(() => {
  const nativeConnect = AudioNode.prototype.connect;
  const NativeWorklet = AudioWorkletNode;
  const nodes = [], ids = new WeakMap();
  const probe = window.__conditionProbe = {edges: [], engineCount: 0, commands: {}, master: null};
  const id = node => {
    if (!ids.has(node)) { ids.set(node, nodes.length); nodes.push(node); }
    return ids.get(node);
  };
  AudioNode.prototype.connect = function(destination, ...args) {
    const result = nativeConnect.call(this, destination, ...args);
    probe.edges.push({source: id(this), destination: id(destination)});
    if (destination instanceof AudioDestinationNode && !probe.master) {
      probe.master = this; probe.context = this.context;
    }
    return result;
  };
  window.AudioWorkletNode = class extends NativeWorklet {
    constructor(...args) {
      super(...args);
      if (args[1] === 'vinyl-processor') {
        probe.engineCount++;
        const post = this.port.postMessage.bind(this.port);
        this.port.postMessage = (message, ...rest) => {
          probe.commands[message.type] = (probe.commands[message.type] ?? 0) + 1;
          return post(message, ...rest);
        };
      }
    }
  };
  probe.graph = () => ({
    edges: probe.edges,
    nodes: nodes.map((node, id) => ({id, type: node instanceof NativeWorklet ? 'AudioWorkletNode' : node.constructor.name, filter: node.type,
      gain: node.gain?.value, frequency: node.frequency?.value, oversample: node.oversample})),
  });
  const stats = (channels, rate, start=0, end=channels[0].length, frequencies=[]) => {
    let sum=0, peak=0, delta=0, mid=0, side=0, nonfinite=0, fullscale=0;
    const n=end-start;
    for(let i=start;i<end;i++) {
      const l=channels[0][i], r=channels[1]?.[i]??l;
      if(!Number.isFinite(l)||!Number.isFinite(r)) nonfinite++;
      sum+=(l*l+r*r)/2; peak=Math.max(peak,Math.abs(l),Math.abs(r));
      fullscale+=Number(Math.abs(l)>=1)+Number(Math.abs(r)>=1);
      mid+=((l+r)/2)**2; side+=((l-r)/2)**2;
      if(i>start) delta+=((l-channels[0][i-1])**2+(r-(channels[1]?.[i-1]??channels[0][i-1]))**2)/2;
    }
    const amplitudes={};
    for(const f of frequencies) {
      let real=0, imaginary=0;
      for(let i=start;i<end;i++) {
        const value=(channels[0][i]+(channels[1]?.[i]??channels[0][i]))/2;
        real+=value*Math.cos(2*Math.PI*f*i/rate);imaginary+=value*Math.sin(2*Math.PI*f*i/rate);
      }
      amplitudes[f]=2*Math.hypot(real,imaginary)/n;
    }
    const rms=Math.sqrt(sum/n);
    return {rms,rmsDbFS:rms?20*Math.log10(rms):-999,peak,nonfinite,fullscale,
      differenceRms:Math.sqrt(delta/Math.max(1,n-1)),sideToMid:Math.sqrt(side/Math.max(1e-30,mid)),amplitudes};
  };
  probe.capture = async ({seconds, changes=[], frequencies=[], wav=false, timeline=false}) => {
    if (!probe.recorder) {
      const code = `class ConditionRecorder extends AudioWorkletProcessor {
        constructor(){super();this.buffer=null;this.port.onmessage=({data})=>{
          this.buffer=[new Float32Array(data.frames),new Float32Array(data.frames)];this.index=0;this.marks=data.marks;
        };}
        process(inputs){
          if(this.buffer&&inputs[0]?.[0]){
            const length=Math.min(inputs[0][0].length,this.buffer[0].length-this.index);
            for(let c=0;c<2;c++)this.buffer[c].set((inputs[0][c]??inputs[0][0]).subarray(0,length),this.index);
            this.index+=length;
            while(this.marks.length&&this.index>=this.marks[0].frame)this.port.postMessage({mark:this.marks.shift(),time:currentTime});
            if(this.index===this.buffer[0].length){this.port.postMessage({channels:this.buffer},this.buffer.map(c=>c.buffer));this.buffer=null;}
          }
          return true;
        }
      }registerProcessor('condition-output-recorder',ConditionRecorder);`;
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
      await probe.context.audioWorklet.addModule(url);URL.revokeObjectURL(url);
      probe.recorder=new NativeWorklet(probe.context,'condition-output-recorder');
      const mute=probe.context.createGain();mute.gain.value=0;
      nativeConnect.call(probe.master,probe.recorder);nativeConnect.call(probe.recorder,mute);
      nativeConnect.call(mute,probe.context.destination);
    }
    const rate=probe.context.sampleRate, switches=[], states=[];
    const snap=()=>{
      const s=turntable.state;
      return {time:probe.context.currentTime,position:s.position,tonearmAngle:s.tonearmAngle,
        motorRate:s.motorActualRate,condition:s.condition,stylusRaised:s.stylusRaised,
        power:s.power,platterRunning:s.platterRunning,rpm:s.rpm,assistPhase:s.assistPhase};
    };
    const interval=timeline?setInterval(()=>states.push(snap()),30):null;
    const before={state:turntable.state,diagnostics:turntable.audioDiagnostics,
      metrics:turntable.metrics,commands:{...probe.commands},engineCount:probe.engineCount};
    return new Promise(resolve=>{
      probe.recorder.port.onmessage=({data})=>{
        if(data.mark){
          const before=snap();
          const radio=[...document.querySelectorAll('[name="record-condition"]')].find(el=>el.value===data.mark.condition);
          radio.click();
          switches.push({requestedFrame:data.mark.frame,recorderTime:data.time,before,after:snap()});
          return;
        }
        clearInterval(interval);
        const channels=data.channels;
        const result={sampleRate:rate,frames:channels[0].length,before,
          after:{state:turntable.state,diagnostics:turntable.audioDiagnostics,metrics:turntable.metrics,
            commands:{...probe.commands},engineCount:probe.engineCount},
          switches,states,stats:stats(channels,rate,0,channels[0].length,frequencies)};
        const boundaries=[0,...changes.map(x=>Math.round(x.at*rate)),channels[0].length];
        result.segments=boundaries.slice(0,-1).map((start,i)=>stats(channels,rate,start+Math.round(.12*rate),boundaries[i+1],frequencies));
        if(wav){
          const pcm=new Int16Array(channels[0].length*2);
          for(let i=0;i<channels[0].length;i++)for(let c=0;c<2;c++)pcm[i*2+c]=Math.round(Math.max(-1,Math.min(1,channels[c][i]))*32767);
          const bytes=new Uint8Array(pcm.buffer);let binary='';
          for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
          result.pcm=btoa(binary);
        }
        resolve(result);
      };
      probe.recorder.port.postMessage({frames:Math.round(seconds*rate),
        marks:changes.map(x=>({frame:Math.round(x.at*rate),condition:x.condition}))});
    });
  };
})();'''


def db_ratio(a, b):
    return 20 * math.log10(a / b)


def run():
    ARTIFACTS.mkdir(exist_ok=True)
    report = {'fixture': 'Original synthesized stereo chords, bass, melody and percussion; no third-party recording.',
              'method': 'A test-only recorder taps the application master node already connected to AudioContext.destination. Metrics use Float32 samples before WAV quantization.',
              'listening': 'Automated measurements only; condition-ab.wav is supplied for human listening.',
              'abSegments': [{'startSeconds': 0, 'condition': 'Mint'}, {'startSeconds': 8, 'condition': 'Poor'}, {'startSeconds': 16, 'condition': 'Mint'}]}
    with tempfile.TemporaryDirectory(prefix='vinyl-condition-') as tmp, sync_playwright() as playwright:
        source = Path(tmp) / 'original-condition-demo.wav'
        make_source(source)
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1150})
        page.set_default_timeout(90000)
        page.add_init_script(PROBE)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        state = lambda: page.evaluate('turntable.state')
        defaults = state()
        check(all(defaults[key] for key in ['surface', 'contacts', 'cartridge']), 'Surface, stylus contacts and cartridge warmth default on')
        check(defaults['condition'] == 'Very Good+' and defaults['vinylColor'] == 'Black' and defaults['labelColor'] == 'Blue', 'Very Good+ is the fresh default with black vinyl and a blue label')
        report['profiles'] = page.evaluate("async()=> (await import('/static/condition-profiles.js')).CONDITIONS")
        check(list(report['profiles']) == CONDITIONS, 'One shared profile table exposes exactly the six full condition names')
        page.locator('#file-input').set_input_files(source)
        page.wait_for_function('turntable.state.recordLoaded')
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.position>.05")
        page.locator('#customize-open').click()
        check(page.get_by_role('radio').count() == 6, 'Six conditions are directly selectable without a dropdown')
        page.get_by_role('radio', name='Mint', exact=True).check()
        page.evaluate('turntable.controls.seek(.02)')
        page.wait_for_function('!turntable.state.seeking')
        page.wait_for_timeout(180)
        report['graph'] = page.evaluate('__conditionProbe.graph()')
        ab = page.evaluate('options=>__conditionProbe.capture(options)', {
            'seconds': 24, 'changes': [{'at': 8, 'condition': 'Poor'}, {'at': 16, 'condition': 'Mint'}],
            'wav': True, 'timeline': True,
        })
        pcm = base64.b64decode(ab.pop('pcm'))
        with wave.open(str(ARTIFACTS / 'condition-ab.wav'), 'wb') as wav:
            wav.setparams((2, 2, ab['sampleRate'], 0, 'NONE', 'not compressed'))
            wav.writeframes(pcm)
        report['liveAB'] = ab
        check(len(ab['switches']) == 2 and [s['after']['condition'] for s in ab['switches']] == ['Poor', 'Mint'], 'Live radio clicks produce Mint → Poor → Mint during the musical passage')
        check(ab['before']['commands'].get('load') == ab['after']['commands'].get('load') == 1 and ab['before']['engineCount'] == ab['after']['engineCount'] == 1, 'Condition A/B keeps one processor and never reloads the PCM')
        check(all(s['after']['position'] >= s['before']['position'] and s['after']['position'] - s['before']['position'] < .1 for s in ab['switches']), 'Live changes preserve the current groove without a seek or reset')
        check(all(abs(s['after']['tonearmAngle'] - s['before']['tonearmAngle']) < .1 for s in ab['switches']), 'Condition changes do not jump the tonearm')
        check(all(abs(s['motorRate'] - 1) < .0001 and not s['stylusRaised'] and s['power'] and s['platterRunning'] and s['assistPhase'] == 'idle' for s in ab['states']), 'Platter, cue, power and assisted-play state remain unchanged throughout A/B')
        check(all(b['position'] >= a['position'] for a, b in zip(ab['states'], ab['states'][1:])), 'The playback cursor advances continuously through both condition changes')
        check(ab['stats']['peak'] < 1 and ab['stats']['fullscale'] == 0 and ab['stats']['nonfinite'] == 0, 'Ordinary musical A/B output stays finite and below full scale', peak=ab['stats']['peak'])
        check(abs(db_ratio(ab['segments'][2]['rms'], ab['segments'][0]['rms'])) < .15, 'Returning to Mint restores musical level without permanent degradation')

        report['silence'] = {}
        for condition in CONDITIONS:
            page.get_by_role('radio', name=condition, exact=True).check()
            page.evaluate('turntable.controls.seek(34/64)')
            page.wait_for_function('!turntable.state.seeking')
            page.wait_for_timeout(180)
            captured = page.evaluate('options=>__conditionProbe.capture(options)', {'seconds': 2})
            report['silence'][condition] = captured
            check(captured['before']['state']['condition'] == condition and captured['stats']['rms'] > 0 and captured['stats']['peak'] < 1, f'{condition} visibly selects and produces its surface signal at the real master')
        noise = [report['silence'][name]['stats']['rms'] for name in CONDITIONS]
        check(all(b > a for a, b in zip(noise, noise[1:])), 'Measured surface degradation increases across all six conditions', rms=noise)
        check(db_ratio(noise[-1], noise[0]) > 25 and noise[-1] > .003, 'Poor surface texture is clearly separated from Mint at an audible output level', differenceDb=db_ratio(noise[-1], noise[0]), poorRms=noise[-1])

        report['frequencyProbe'] = {}
        for name in ['Mint', 'Poor', 'Mint restored']:
            page.get_by_role('radio', name='Mint' if name == 'Mint restored' else name, exact=True).check()
            page.evaluate('turntable.controls.seek(49/64)')
            page.wait_for_function('!turntable.state.seeking')
            page.wait_for_timeout(180)
            report['frequencyProbe'][name] = page.evaluate('options=>__conditionProbe.capture(options)', {'seconds': 1, 'frequencies': [220, 3600, 9600]})
        mint = report['frequencyProbe']['Mint']['stats']
        poor = report['frequencyProbe']['Poor']['stats']
        restored = report['frequencyProbe']['Mint restored']['stats']
        high_loss = db_ratio(poor['amplitudes']['9600'], mint['amplitudes']['9600'])
        low_loss = db_ratio(poor['amplitudes']['220'], mint['amplitudes']['220'])
        report['wearDifferenceDb'] = {'220Hz': low_loss, '9600Hz': high_loss, 'relativeHighFrequencyLoss': high_loss - low_loss}
        check(high_loss - low_loss < -3, 'Poor substantially changes the music itself, beyond added noise', **report['wearDifferenceDb'])
        check(abs(db_ratio(restored['amplitudes']['9600'], mint['amplitudes']['9600'])) < .12, 'Returning to Mint restores high-frequency response')
        check(poor['sideToMid'] < mint['sideToMid'] * .98, 'Worn grooves subtly reduce stereo clarity', mint=mint['sideToMid'], poor=poor['sideToMid'])

        page.get_by_role('radio', name='Poor', exact=True).check()
        page.evaluate('()=>{turntable.controls.setVolume(1);turntable.controls.seek(57/64)}')
        page.wait_for_function('!turntable.state.seeking')
        page.wait_for_timeout(180)
        stress = page.evaluate('options=>__conditionProbe.capture(options)', {'seconds': 5})
        report['peakStress'] = stress
        check(stress['before']['state']['volume'] == 1 and stress['stats']['peak'] < 1 and stress['stats']['fullscale'] == 0 and stress['stats']['nonfinite'] == 0, 'Full-scale input plus Poor defects remains below clipping at maximum volume', peak=stress['stats']['peak'])
        check(stress['after']['diagnostics']['popCount'] > stress['before']['diagnostics']['popCount'], 'Peak-safety measurement includes actual randomized defect events')
        check(stress['after']['engineCount'] == 1 and stress['after']['commands'].get('load') == 1, 'Repeated condition changes retain one engine and one PCM upload')
        check(not errors, 'No browser or audio-worklet errors', errors=errors)
        report['checks'] = checks
        (ARTIFACTS / 'condition-audio.json').write_text(json.dumps(report, indent=2) + '\n')
        browser.close()
        print(f'PASS {len(checks)} condition-audio checks; A/B WAV and measured output report saved in artifacts/', flush=True)


if __name__ == '__main__':
    run()
