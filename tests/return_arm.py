"""Mechanical Return Arm shares auto-cue geometry and yields to newer intent."""
import json
import math
from playwright.sync_api import sync_playwright
from acceptance import ROOT, PROBE, arm_point, groove_angle, select_speed
from audio_fixtures import generated_long_record
from audio_assertions import wait_for_silence

checks = []
def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)

TRACE = '''async () => {
  const start = turntable.state, contactBefore = turntable.audioDiagnostics.contactCount;
  const began = performance.now(), frames = [];
  const returning = turntable.controls.returnArm();
  const immediate = turntable.state;
  await new Promise(resolve => {
    const tick = () => {
      const s = turntable.state, a = __probe.analyser, pcm = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(pcm);
      frames.push({elapsed:performance.now()-began, angle:s.tonearmAngle, position:s.position,
        raised:s.stylusRaised, contact:s.stylusContact, motion:s.tonearmMotion,
        paused:s.transportPaused, motor:s.motorActualRate, running:s.platterRunning,
        rendered:document.querySelector('#tonearm').getAttribute('transform'),
        rms:Math.sqrt(pcm.reduce((sum,v)=>sum+v*v,0)/pcm.length)});
      if(s.tonearmMotion) requestAnimationFrame(tick); else resolve();
    };requestAnimationFrame(tick);
  });
  await returning;
  return {start, immediate, frames, end:turntable.state,
    contactDelta:turntable.audioDiagnostics.contactCount-contactBefore};
}'''


def run():
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    with generated_long_record() as fixture, sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1440,'height':1500})
        page.add_init_script(PROBE)
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('http://127.0.0.1:42069');page.wait_for_function('window.turntable')
        page.locator('#file-input').set_input_files(fixture)
        page.wait_for_function("turntable.state.recordPhase==='ready'")
        state=lambda:page.evaluate('turntable.state')
        click=lambda name:page.locator('#'+name).click()
        g=page.evaluate('turntable.geometry')
        def position(fraction, play=True, raised=False):
            page.evaluate('fraction=>turntable.controls.seek(fraction)',fraction)
            page.wait_for_function('!turntable.state.seeking')
            if play:
                page.evaluate('turntable.controls.play()')
                page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.stylusContact && turntable.state.motorActualRate>.9")
            else:
                page.evaluate('turntable.controls.pause()')
                page.wait_for_function("turntable.state.transportState==='paused'")
            if state()['stylusRaised'] != raised: click('cue')
            page.wait_for_timeout(80)
        traces={}
        preserved=['power','speed33Pressed','speed45Pressed','pitch','pitchRange','quartzLock','volume',
            'condition','vinylColor','labelColor','wow','centering','cartridge']
        page.evaluate('turntable.controls.customize("condition","Poor");turntable.controls.setVolume(.69)')
        for fraction in [.002,.25,.5,.75,.9999]:
            position(fraction)
            trace=page.evaluate(TRACE);traces[str(fraction)]=trace
            frames=trace['frames'];start=trace['start'];end=trace['end'];now=trace['immediate']
            label=f'{fraction*100:g}% return'
            check(now['stylusRaised'] and not now['stylusContact'] and now['tonearmMotion']['phase']=='lifting',label+': stylus lifts before horizontal travel')
            check(abs(now['tonearmAngle']-start['tonearmAngle'])<.02 and frames[0]['angle']>g['rest'],label+': starts at the actual groove without teleporting')
            check(all(abs(f['angle']-start['tonearmAngle'])<.02 for f in frames if f['elapsed']<140),label+': clearance precedes the outward sweep')
            moving=[f for f in frames if f['motion'] and f['motion']['phase']=='moving']
            check(len(moving)>10 and all(b['angle']<=a['angle']+1e-6 for a,b in zip(moving,moving[1:])),label+': multiple monotonic intermediate pivot angles')
            check(all(abs(float(f['rendered'].split('rotate(')[1][:-1])-f['angle'])<.00001 for f in moving),label+': complete rendered arm follows authoritative state')
            check(all(abs(f['angle']-groove_angle(g,f['position']/start['duration']))<.00002 for f in moving if f['angle']>=g['outerAngle']),label+': stylus progress follows physical pivot geometry')
            check(all(f['raised'] and not f['contact'] for f in frames) and all(f['rms']<1e-6 for f in frames if f['elapsed']>400),label+': suspended arm has no music or condition audio')
            check(trace['contactDelta']==1,label+': uses exactly one existing stylus-release sound')
            check(500<=frames[-1]['elapsed']<=950,label+': complete mechanical action takes 500–900 ms plus a frame')
            check(end['tonearmMotion'] is None and end['tonearmAngle']==g['rest'] and end['position']==0 and end['stylusRaised'],label+': exact raised rest geometry and empty groove position')
            check(all(f['running'] and abs(f['motor']-start['motorActualRate'])<.002 for f in frames),label+': independently spinning motor keeps its RPM')
            check(all(end[key]==start[key] for key in preserved),label+': unrelated hardware and customization settings remain intact')
        check(traces['0.9999']['frames'][-1]['elapsed']>traces['0.002']['frames'][-1]['elapsed']+80,'Longer inward distances take a naturally longer return')
        position(.5,play=False)
        trace=page.evaluate(TRACE);traces['paused']=trace
        check(all(f['paused'] and abs(f['motor'])<.00001 for f in trace['frames']) and trace['end']['transportPaused'],'Paused return never resumes or starts the platter')
        position(.5,raised=True)
        trace=page.evaluate(TRACE);traces['raised']=trace
        check(trace['immediate']['tonearmMotion']['phase']=='moving' and trace['frames'][1]['angle']<trace['start']['tonearmAngle'],'An already raised arm skips unnecessary lift clearance')
        check(trace['contactDelta']==0,'An already raised arm does not manufacture a release sound')
        # Run-out remains physical until return lifts the stylus.
        position(.9999)
        page.wait_for_function("turntable.state.grooveRegion==='run-out'")
        trace=page.evaluate(TRACE);traces['runout']=trace
        check(trace['start']['grooveRegion']=='run-out' and not trace['end']['stylusContact'] and trace['end']['position']==0,'Run-out returns naturally and clears physical groove contact')
        wait_for_silence(page,1e-7)
        # Return takes ownership of a traversal at its current interpolated point.
        position(.2)
        page.evaluate('turntable.controls.seek(.9)');page.wait_for_timeout(25)
        trace=page.evaluate(TRACE);traces['seek-interrupted']=trace
        check(trace['start']['seeking'] and not trace['immediate']['seeking'] and abs(trace['immediate']['tonearmAngle']-trace['start']['tonearmAngle'])<.15,'Return cancels an active click traversal at its current arm angle')
        page.wait_for_timeout(200)
        check(state()['tonearmAngle']==g['rest'] and state()['stylusRaised'],'Cancelled traversal cannot later move the parked arm')
        # Auto-cue and Return use one shared motion object and cancellation generation.
        page.evaluate('void turntable.controls.play()')
        page.wait_for_function("turntable.state.tonearmMotion?.kind==='cueing'")
        page.wait_for_timeout(180)
        trace=page.evaluate(TRACE);traces['cue-interrupted']=trace
        check(trace['start']['tonearmMotion']['kind']=='cueing' and trace['immediate']['tonearmMotion']['kind']=='returning','Return supersedes assisted Play in the shared motion primitive')
        page.wait_for_timeout(1100)
        check(state()['assistPhase']=='idle' and state()['stylusRaised'] and state()['tonearmAngle']==g['rest'],'Cancelled auto-cue never lowers or moves the returned arm later')
        # A new Play intentionally supersedes return, with no stale park completion.
        position(.75)
        page.evaluate('void turntable.controls.returnArm()');page.wait_for_timeout(240)
        angle=state()['tonearmAngle'];page.evaluate('void turntable.controls.play()')
        page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.stylusContact")
        page.wait_for_timeout(750)
        check(state()['tonearmMotion'] is None and state()['tonearmAngle']>=angle and state()['stylusContact'],'Play during return takes ownership without a delayed stale park')
        # A real manual pointer grab cancels the automatic RAF writer.
        position(.75)
        page.evaluate('void turntable.controls.returnArm()')
        page.wait_for_function("turntable.state.tonearmMotion?.phase==='moving'")
        page.locator('#deck').scroll_into_view_if_needed()
        xy=arm_point(page,g,state()['tonearmAngle']);page.mouse.move(*xy);page.mouse.down()
        check(state()['dragging'] and state()['tonearmMotion'] is None,'Grabbing the returning headshell cancels mechanical ownership immediately')
        page.mouse.move(*arm_point(page,g,groove_angle(g,.45)),steps=4)
        page.mouse.up();held=state()['tonearmAngle'];page.wait_for_timeout(950)
        check(abs(state()['tonearmAngle']-held)<1e-7 and abs(state()['position']/state()['duration']-.45)<.00001,'Manual arm position persists after the cancelled return deadline')
        # Explicit click-seek and Pause also win over an in-flight return.
        position(.75)
        page.evaluate('void turntable.controls.returnArm()');page.wait_for_timeout(230)
        page.evaluate('turntable.controls.seek(.3)');page.wait_for_function('!turntable.state.seeking');page.wait_for_timeout(900)
        check(state()['tonearmMotion'] is None and abs(state()['position']/state()['duration']-.3)<.00001,'Click-seek cancels returning motion and keeps the newer target')
        position(.75)
        page.evaluate('void turntable.controls.returnArm()');page.wait_for_timeout(230)
        page.evaluate('turntable.controls.pause()');held=state()['tonearmAngle'];page.wait_for_timeout(900)
        check(state()['tonearmMotion'] is None and state()['transportPaused'] and abs(state()['tonearmAngle']-held)<1e-7,'Pause cancels a return without a stale automatic completion')
        # Deliberate hardware values survive, including both 78 latches and unlocked pitch.
        select_speed(page,78);click('quartz');click('pitch-range');page.locator('#pitch').fill('5')
        for key,value in [('vinylColor','Red'),('labelColor','Cream'),('wow',.2),('centering',.3)]:
            page.evaluate('([key,value])=>turntable.controls.customize(key,value)',[key,value])
        position(.5);trace=page.evaluate(TRACE)
        check(all(trace['end'][key]==trace['start'][key] for key in preserved) and trace['end']['rpm']==78 and trace['end']['pitch']==5,'Return retains 78 RPM, unlocked ±16 pitch, colors, volume, condition and mechanics')
        # Lifecycle owns its own motor stop but uses the same state-driven pivot sweep.
        position(.6)
        page.evaluate('void turntable.controls.returnArm()');page.wait_for_timeout(220)
        click('eject');page.wait_for_function("turntable.state.tonearmMotion?.kind==='parking'")
        page.locator('#power').focus();page.keyboard.press('Home')
        page.wait_for_function("turntable.state.recordPhase==='empty'");page.wait_for_timeout(950)
        check(state()['tonearmAngle']==g['rest'] and state()['tonearmMotion'] is None and not state()['recordPresent'],'Eject supersedes return and completes shared mechanical parking safely')
        check(not state()['power'] and state()['tonearmAngle']==g['rest'],'Power-off during mandatory lifecycle parking preserves its safe arm sweep')
        check(page.evaluate('__probe.worklets===1 && __probe.starts===0'),'All returns and interruptions retain one audio engine with no source restart')
        check(not errors,'No browser errors during mechanical return or cancellation')
        browser.close()
    (ROOT/'artifacts/return-arm.json').write_text(json.dumps({'total':len(checks),'checks':checks,'traces':traces},indent=2)+'\n')
    print(f'PASS {len(checks)} mechanical return checks',flush=True)

if __name__=='__main__':run()
