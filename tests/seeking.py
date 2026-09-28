"""Real-browser audio-clock HUD traversal, geometry, transport and interruption checks."""
import json
import math
import struct
import tempfile
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright
from acceptance import ROOT, PROBE, groove_angle
from audio_assertions import wait_for_silence

checks = []
def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)

TRACE = '''async target => {
  const start=turntable.state;
  turntable.controls.seek(target);
  const frames=[];
  await new Promise(resolve=>{
    const began=performance.now();
    const tick=()=>{
      const s=turntable.state,a=__probe.analyser,d=new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(d);
      frames.push({elapsed:performance.now()-began,position:s.position,angle:s.tonearmAngle,
        seeking:s.seeking,paused:s.transportPaused,raised:s.stylusRaised,motor:s.motorActualRate,
        rotation:s.recordRotation,rate:s.actualRate,hud:Number(document.querySelector('#groove-progress').value),
        rendered:document.querySelector('#tonearm').getAttribute('transform'),
        rms:Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length)});
      if(!s.seeking || performance.now()-began>1600)resolve();else requestAnimationFrame(tick);
    };requestAnimationFrame(tick);
  });
  return {start,frames,end:turntable.state};
}'''

def run():
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temp, sync_playwright() as p:
        path=Path(temp)/'traversal-tone.wav'
        with wave.open(str(path),'wb') as wav:
            wav.setparams((1,2,24000,0,'NONE','not compressed'))
            one=b''.join(struct.pack('<h',int(6500*math.sin(2*math.pi*173*i/24000)+3000*math.sin(2*math.pi*311*i/24000))) for i in range(24000))
            wav.writeframes(one*60)
        browser=p.chromium.launch(); page=browser.new_page(viewport={'width':1440,'height':1500})
        page.add_init_script(PROBE); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:42069');page.wait_for_function('window.turntable')
        state=lambda:page.evaluate('turntable.state')
        click=lambda id:page.locator('#'+id).click()
        page.locator('#file-input').set_input_files(path);page.wait_for_function("turntable.state.recordPhase==='ready'")
        g=page.evaluate('turntable.geometry');duration=state()['duration']
        page.evaluate('turntable.controls.customize("surface",false);turntable.controls.customize("contacts",false)')
        # Starting from the parked arm follows the same arc without lowering the cue.
        trace=page.evaluate(TRACE,.2)
        check(len(trace['frames'])>10 and not trace['end']['seeking'],'Parked arm enters the grooves through a finite traversal')
        angles=[f['angle'] for f in trace['frames']]
        check(g['rest']<=angles[0]<g['outerAngle'] and all(b>=a-1e-7 for a,b in zip(angles,angles[1:])), 'Parked seek starts at the actual rest and rotates continuously around the pivot')
        check(all(f['raised'] and f['rms']<1e-7 for f in trace['frames']), 'Raised CUE stays raised and silent throughout HUD seeking')
        click('transport');page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.stylusContact && turntable.state.motorActualRate>.99")
        traces={}
        for name,target in [('short forward',.24),('long forward',.85),('short backward',.81),('long backward',.1)]:
            trace=page.evaluate(TRACE,target);traces[name]=trace
            frames=trace['frames'];start=trace['start'];end=trace['end'];direction=1 if target*duration>start['position'] else -1
            middle=[f for f in frames if f['seeking'] and f['elapsed']>40]
            check(len(middle)>=5 and all(direction*(b['position']-a['position'])>=-1e-7 for a,b in zip(middle,middle[1:])),f'{name}: several monotonic intermediate grooves, no teleport')
            check(all(abs(f['angle']-groove_angle(g,f['position']/duration))<.00002 for f in middle),f'{name}: tonearm angle matches the true pivot geometry at every sampled groove')
            check(all(abs(f['hud']-f['position']/duration*100)<3 for f in middle),f'{name}: HUD thumb follows traversal')
            check(any(direction*f['rate']>.9 and f['rms']>.005 for f in middle) and all(abs(f['rate'])<=2.5 for f in middle),f'{name}: actual master contains bounded forward/reverse scrub audio')
            check(all(abs(f['motor']-1)<.001 for f in middle) and abs((middle[-1]['rotation']-middle[0]['rotation'])/200-(middle[-1]['elapsed']-middle[0]['elapsed'])/1000)<.055,f'{name}: physical record and platter keep their selected RPM')
            check(not end['seeking'] and not end['transportPaused'] and abs(end['position']-target*duration)<.15,f'{name}: playing transport resumes from target')
        page.evaluate('turntable.controls.pause()');page.wait_for_function("turntable.state.transportState==='paused'")
        wait_for_silence(page,1e-7)
        trace=page.evaluate(TRACE,.6)
        check(all(f['paused'] for f in trace['frames']) and abs(trace['end']['position']-.6*duration)<1e-8,'Paused seeking retains the pause and exact target groove')
        check(any(f['rms']>.005 for f in trace['frames']) and all(abs(f['motor'])<1e-8 for f in trace['frames']),'Paused scrubbing is audible while the motor stays stopped')
        wait_for_silence(page,1e-7);anchor=state()['position'];page.wait_for_timeout(150)
        check(state()['position']==anchor,'Paused seeking becomes stationary after release')
        # Exercise the actual native HUD input as well as its presentation API.
        page.locator('#groove-progress').fill('70');immediate=state()
        check(immediate['seeking'] and immediate['position']<.7*duration,'HUD input requests traversal instead of committing an immediate currentTime')
        page.wait_for_function('!turntable.state.seeking');check(abs(state()['position']-.7*duration)<1e-8,'Native HUD input reaches its requested groove')
        page.evaluate('turntable.controls.seek(.05)');page.wait_for_timeout(90)
        retarget=page.evaluate('()=>{const before=turntable.state;turntable.controls.seek(.9);return {before,after:turntable.state}}')
        check(abs(retarget['after']['position']-retarget['before']['position'])<.001,'Interrupted seeking retargets from its current groove without a synchronous jump')
        page.wait_for_function('!turntable.state.seeking');page.wait_for_timeout(180)
        check(abs(state()['position']-.9*duration)<1e-8,'The latest interrupted seek wins without stale completion')
        page.evaluate('turntable.controls.seek(.1)');page.wait_for_timeout(120)
        page.locator('#tonearm').focus();page.keyboard.press('ArrowRight');anchor=state()['position'];page.wait_for_timeout(1100)
        check(not state()['seeking'] and abs(state()['position']-anchor)<1e-8,'Manual tonearm input cancels HUD traversal permanently')
        page.evaluate('turntable.controls.seek(.1)');page.wait_for_timeout(120)
        page.locator('#vinyl-hit-area').focus();page.keyboard.down('ArrowLeft');page.wait_for_timeout(100);page.keyboard.up('ArrowLeft');page.wait_for_timeout(160)
        check(not state()['seeking'] and state()['transportPaused'],'Manual vinyl scratching takes over without resuming the motor')
        page.evaluate('turntable.controls.seek(.8)');page.wait_for_timeout(100);click('cue')
        page.wait_for_function('!turntable.state.seeking && turntable.state.actualRate===0')
        anchor=state()['position'];page.wait_for_timeout(1100)
        check(not state()['seeking'] and state()['stylusRaised'] and abs(state()['position']-anchor)<1e-8,'CUE interruption cancels traversal and preserves the raised state')
        check(abs(state()['tonearmAngle']-groove_angle(g,state()['position']/duration))<.00002,'Interrupted raised-cue sweep leaves the arm at the actual final groove')
        trace=page.evaluate(TRACE,.3);wait_for_silence(page,1e-7)
        check(all(f['raised'] and f['rms']<1e-7 for f in trace['frames']) and abs(state()['position']-.3*duration)<1e-8,'A later raised-cue seek traverses silently without lowering the needle')
        page.evaluate('turntable.controls.seek(.9)');page.wait_for_timeout(90);page.evaluate('turntable.controls.returnArm()');page.wait_for_timeout(1000)
        check(not state()['seeking'] and state()['tonearmAngle']==g['rest'],'Return Arm takes priority over pending HUD traversal')
        page.evaluate('turntable.controls.seek(.8)');page.wait_for_timeout(120);click('eject');page.wait_for_function("turntable.state.recordPhase==='empty'")
        page.wait_for_timeout(1100)
        check(not state()['seeking'] and state()['position']==0 and state()['tonearmAngle']==g['rest'],'Ejection cancels traversal and cannot receive stale seek callbacks')
        check(page.evaluate('__probe.worklets===1 && __probe.starts===0'),'All seeks share one persistent PCM reader')
        check(not errors,'No browser/worklet errors during seeking')
        browser.close()
        (ROOT/'artifacts/seeking.json').write_text(json.dumps({'result':'passed','total':len(checks),'checks':checks,'traces':traces},indent=2)+'\n')
        print(f'PASS {len(checks)} physical seeking browser checks',flush=True)

if __name__=='__main__':run()
