"""Real pointer, single-frame HUD/tonearm and live audio scrubbing regression checks."""
import json
import re
from playwright.sync_api import sync_playwright
from acceptance import ROOT, PROBE, arm_point, groove_angle, select_speed
from audio_fixtures import generated_long_record
from audio_assertions import wait_for_silence

checks = []


def check(ok, message, **details):
    assert ok, f'{message}: {details}'
    checks.append({'check': message, **details})
    print('PASS ' + message, flush=True)


PERFORMANCE_PROBE = """(() => {
  window.__scrubPerf = {nodes: 0, decodes: 0};
  for (const name of ['createGain','createBiquadFilter','createWaveShaper','createBufferSource','createAnalyser']) {
    const original = BaseAudioContext.prototype[name];
    BaseAudioContext.prototype[name] = function(...args) { __scrubPerf.nodes++; return original.apply(this,args); };
  }
  const original = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function(...args) { __scrubPerf.decodes++; return original.apply(this,args); };
})();"""

# Installed after application listeners: each actual pointer event is sampled at its
# next rendered frame, after the application's latest-only RAF has had one chance.
FRAME_PROBE = """() => {
  window.__pointerFrames = [];
  const el=document.querySelector('#groove-progress');
  el.addEventListener('pointermove', event => {
    if (!event.buttons && event.pointerType==='mouse') return;
    const r=el.getBoundingClientRect(), inset=5;
    const requested=Math.max(0,Math.min(1,(event.clientX-r.left-inset)/(r.width-2*inset)));
    const began=performance.now();
    requestAnimationFrame(() => {
      const s=turntable.state;
      if (!s.directScrubbing) return;
      __pointerFrames.push({requested,position:s.position,fraction:s.grooveProgress,
        elapsed:document.querySelector('#elapsed').textContent,
        angle:s.tonearmAngle,rendered:document.querySelector('#tonearm').getAttribute('transform'),
        hud:Number(el.value)/100,direct:s.directScrubbing,seeking:s.seeking,
        delay:performance.now()-began,rate:s.actualRate,velocity:s.scrubVelocity});
    });
  });
}"""


def run():
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    with generated_long_record() as record, sync_playwright() as p:
        browser=p.chromium.launch()
        context=browser.new_context(viewport={'width':1440,'height':1500},has_touch=True)
        page=context.new_page();page.add_init_script(PROBE);page.add_init_script(PERFORMANCE_PROBE)
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:42069');page.wait_for_function('window.turntable')
        state=lambda:page.evaluate('turntable.state')
        page.locator('#file-input').set_input_files(record)
        page.wait_for_function("turntable.state.recordPhase==='ready'",timeout=90000)
        page.evaluate(FRAME_PROBE)
        page.evaluate('''()=>{window.__audioFrames=[];window.__audioPhase='';const tick=()=>{
          const s=turntable.state,a=__probe.analyser;
          if(__audioPhase && a){const d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);
          __audioFrames.push({phase:__audioPhase,rate:s.actualRate,velocity:s.scrubVelocity,rms:Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length)});}
          requestAnimationFrame(tick)};requestAnimationFrame(tick)}''')
        g=page.evaluate('turntable.geometry');duration=state()['duration']
        progress=page.locator('#groove-progress')
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.stylusContact && turntable.state.motorActualRate>.99")
        initial_graph=page.evaluate('({...__scrubPerf,worklets:__probe.worklets,starts:__probe.starts})')

        def point(fraction,offset_y=0):
            r=progress.bounding_box()
            return (r['x']+5+fraction*(r['width']-10), r['y']+r['height']/2+offset_y)

        def seek(fraction):
            page.evaluate('f=>turntable.controls.seek(f)',fraction)
            page.wait_for_function('!turntable.state.seeking')

        def grab(offset_y=0):
            progress.scroll_into_view_if_needed()
            page.mouse.move(*point(state()['grooveProgress'],offset_y))
            page.mouse.down()
            page.wait_for_function('turntable.state.directScrubbing',timeout=1000)

        def move(fraction,wait=35,offset_y=0):
            page.mouse.move(*point(fraction,offset_y))
            if wait:page.wait_for_timeout(wait)
            return state()

        def signal():
            return page.evaluate("""()=>{const a=__probe.analyser,d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);
              return {rms:Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length),peak:Math.max(...d.map(Math.abs)),finite:d.every(Number.isFinite)};}""")

        def release():
            page.mouse.up();page.wait_for_function('!turntable.state.directScrubbing')

        # The user's exact long-record acceptance path, driven by a real pointer.
        seek(.25);grab()
        check(state()['directScrubbing'] and not state()['seeking'],'Thumb press immediately enters direct manipulation without a destination sweep')
        check(page.locator('#transport-hint').inner_text()=='','Active pointer manipulation has no persistent status hint')
        forward=[];page.evaluate("__audioPhase='forward'")
        for f in [.28,.32,.37,.42,.46,.50]:
            s=move(f,55);forward.append({'fraction':s['grooveProgress'],'angle':s['tonearmAngle'],'rate':s['actualRate'],'signal':signal()})
        check(all(b['angle']>a['angle'] for a,b in zip(forward,forward[1:])),'Slow forward pointer motion moves the true tonearm arc inward continuously')
        check(page.evaluate("__audioFrames.some(f=>f.phase==='forward' && f.rate>0 && f.rms>.003)"),'Forward direct scrub produces uploaded audio at the actual master output',samples=forward)
        reverse=[];page.evaluate("__audioPhase='reverse'")
        for f in [.48,.44,.39,.34]:
            s=move(f,55);reverse.append({'fraction':s['grooveProgress'],'angle':s['tonearmAngle'],'rate':s['actualRate'],'signal':signal()})
        check(all(b['angle']<a['angle'] for a,b in zip(reverse,reverse[1:])),'Reversing the same pointer gesture immediately moves the arm outward')
        check(page.evaluate("__audioFrames.some(f=>f.phase==='reverse' && f.rate<0 && f.rms>.003)"),'Reverse direct scrub sends backward uploaded audio through the master',samples=reverse)
        page.evaluate("__audioPhase=''")
        for f in [.82,.15,.76,.22,.91,.09,.6]:move(f,18)
        anchor=state();page.wait_for_timeout(400);held=state()
        check(abs(held['grooveProgress']-.6)<.001 and abs(held['position']-anchor['position'])<1e-7,'Rapid reversals have no backlog or visual catch-up after the pointer stops',anchor=anchor['grooveProgress'],held=held['grooveProgress'])
        check(not held['seeking'] and held['directScrubbing'],'Holding the pointer never starts a delayed click traversal')
        wait_for_silence(page,1e-5)
        check(signal()['rms']<1e-5,'Stationary direct manipulation settles to silence without replaying old audio')
        release();released=state()
        check(not released['transportPaused'] and not released['seeking'] and abs(released['grooveProgress']-.6)<.001,'Playing release resumes immediately from the selected groove without a second traversal')
        page.wait_for_timeout(220)
        check(state()['position']>released['position']+.08,'Normal playback advances immediately after releasing direct scrub')

        frames=page.evaluate('__pointerFrames')
        check(len(frames)>=15 and max(abs(f['fraction']-f['requested']) for f in frames)<.001,'Latest pointer position reaches the shared groove state within one rendered frame',frames=len(frames),maxFractionError=max(abs(f['fraction']-f['requested']) for f in frames))
        check(max(abs(f['hud']-f['requested']) for f in frames)<.001,'Visible progress thumb follows the same-frame pointer position')
        check(all(abs(f['angle']-groove_angle(g,f['requested']))<.03 for f in frames),'Direct HUD arm angle follows physical pivot geometry with no independent easing')
        check(all(abs(float(re.search(r'rotate\(([-\d.]+)',f['rendered']).group(1))-f['angle'])<.001 for f in frames),'Rendered SVG arm transform has no stale target behind the state')
        check(all(f['elapsed']==f'{int(f["position"])//60:02d}:{int(f["position"])%60:02d}' for f in frames),'Elapsed timestamps update live from the pointer groove on every sampled frame')
        check(all(not f['seeking'] for f in frames),'Direct pointer frames never enter Traversing grooves')
        check(all(abs(f['rate'])<=2.5 for f in page.evaluate('__audioFrames')),'Actual audible scrub rate remains bounded despite large timeline jumps')

        # Paused feedback is audible, but neither release nor a later stale event plays.
        page.evaluate('turntable.controls.pause()');page.wait_for_function("turntable.state.transportState==='paused'")
        seek(.2);grab();move(.4);s=move(.7,45);paused_signal=signal();release()
        anchor=state();page.wait_for_timeout(250)
        check(s['transportPaused'] and paused_signal['rms']>.003,'Paused direct manipulation still provides live uploaded-audio feedback')
        check(state()['transportPaused'] and abs(state()['grooveProgress']-.7)<.001 and abs(state()['position']-anchor['position'])<1e-7,'Paused release holds exactly the chosen groove and preserves pause intent')
        page.locator('#transport').click();page.wait_for_function("turntable.state.assistPhase==='idle' && !turntable.state.transportPaused")
        check(.699<state()['grooveProgress']<.702,'Play after a paused scrub begins at the chosen seventy-percent groove')

        # Small and faster movements retain perceptible feedback without whole-song speedup.
        seek(.4);grab();page.evaluate("__audioPhase='slow'")
        for n in range(1,9):
            move(.4+n*.00015,75)
        page.evaluate("__audioPhase='fast'")
        for n in range(1,9):
            move(.4012+n*.002,25)
        page.evaluate("__audioPhase=''")
        slow_rates=page.evaluate("__audioFrames.filter(f=>f.phase==='slow').map(f=>Math.abs(f.rate))")
        fast_rates=page.evaluate("__audioFrames.filter(f=>f.phase==='fast').map(f=>Math.abs(f.rate))")
        check(max(fast_rates)>max(slow_rates)+.005 and max(slow_rates)>.9 and max(fast_rates)<=2.5,'Faster pointer motion modestly changes audible pitch while keeping recognizable playback rates',slow=slow_rates,fast=fast_rates)
        release()

        # Click gestures retain a short physical sweep; pointer down can interrupt it.
        seek(.2)
        page.evaluate("""()=>{window.__clickFrames=[];window.__captureClicks=true;
          const tick=()=>{if(!__captureClicks)return;const s=turntable.state;__clickFrames.push({at:performance.now(),seeking:s.seeking,p:s.grooveProgress});requestAnimationFrame(tick)};requestAnimationFrame(tick)}""")
        page.mouse.click(*point(.8));page.wait_for_function('!turntable.state.seeking');page.wait_for_timeout(35)
        click_frames=page.evaluate('__captureClicks=false;__clickFrames')
        sweep=[f for f in click_frames if f['seeking']]
        check(len(sweep)>=3 and all(b['p']>=a['p'] for a,b in zip(sweep,sweep[1:])),'A track-only click traverses several intermediate grooves instead of teleporting')
        check(sweep[-1]['at']-sweep[0]['at']<=470 and abs(state()['grooveProgress']-.8)<.002,'Large click traversal completes within approximately 450 ms',observedMs=sweep[-1]['at']-sweep[0]['at'])
        page.evaluate('turntable.controls.seek(.1)');page.wait_for_timeout(65);grab();move(.65,40);release();page.wait_for_timeout(550)
        check(not state()['seeking'] and .649<state()['grooveProgress']<.653,'Direct dragging interrupts a click sweep immediately and its old destination never returns')

        # Manual headshell is the latency reference, not a separate seek cursor.
        page.evaluate('turntable.controls.pause()');page.wait_for_function("turntable.state.transportState==='paused'")
        s=state();page.mouse.move(*arm_point(page,g,s['tonearmAngle']));page.mouse.down();page.mouse.move(*arm_point(page,g,groove_angle(g,.35)))
        manual=state();page.mouse.up();grab();move(.55,0)
        page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(resolve))');remote=state();release()
        check(abs(manual['grooveProgress']-.35)<.001 and abs(remote['grooveProgress']-.55)<.001,'HUD direct manipulation matches the immediate physical headshell response',manualError=abs(manual['grooveProgress']-.35),hudError=abs(remote['grooveProgress']-.55))

        # Captured pointer may leave both horizontal and vertical visible bounds.
        check(progress.bounding_box()['height']>=24,'The thin visible progress track has a forgiving invisible vertical hit area')
        grab(offset_y=9);move(-.3,40,offset_y=-70)
        check(state()['directScrubbing'] and state()['grooveProgress']==0 and abs(state()['tonearmAngle']-g['outerAngle'])<.001,'Pointer capture reaches outer lead-in without parking the arm, even outside the control')
        move(1.3,40,offset_y=70)
        check(state()['grooveProgress']==1 and abs(state()['tonearmAngle']-g['innerAngle'])<.001,'Captured pointer clamps at inner run-out without impossible arm geometry')
        release();check(state()['transportPaused'],'Extreme-end release preserves paused intent')
        check(page.evaluate('getSelection().toString()===""'),'Progress dragging never selects labels or surrounding text')

        # These controls must remain independent of cursor movement.
        page.evaluate('turntable.controls.customize("condition","Poor");turntable.controls.customize("wow",.4);turntable.controls.customize("centering",.3);turntable.controls.setVolume(.69)')
        for rpm in [100/3,45,78]:
            select_speed(page,rpm)
            if state()['quartzLock']:page.locator('#quartz').click()
            page.locator('#pitch').evaluate("e=>{e.value=4;e.dispatchEvent(new Event('input',{bubbles:true}))}")
            before=state();seek(.3);grab();move(.65);release();after=state()
            keys=['rpm','speed33Pressed','speed45Pressed','pitch','pitchRange','quartzLock','volume','condition','wow','centering','cartridge','surface','contacts']
            check(all(before[k]==after[k] for k in keys),f'{rpm:g} RPM direct scrub preserves speed, pitch, volume, condition and mechanical settings')
            page.locator('#quartz').click();grab();move(.35);release()
            check(state()['quartzLock'] and state()['effectivePitch']==0 and state()['rpm']==rpm,f'{rpm:g} RPM Quartz stays immediately locked during and after direct scrub')

        for event in ['pointercancel','lostpointercapture','blur']:
            grab();move(.47)
            if event=='blur':page.evaluate("window.dispatchEvent(new Event('blur'))")
            elif event=='lostpointercapture':progress.evaluate('el=>el.releasePointerCapture(1)')
            else:progress.dispatch_event(event,{'pointerId':1})
            page.wait_for_function('!turntable.state.directScrubbing')
            page.mouse.up();check(state()['transportPaused'] and not state()['seeking'],f'{event} cleanly ends direct manipulation and preserves pause')

        # CUE still belongs to the user during virtual headshell movement.
        page.locator('#cue').click();page.wait_for_timeout(120);wait_for_silence(page,1e-5);grab();move(.61,25)
        check(state()['stylusRaised'] and signal()['rms']<1e-5,'Raised CUE stays raised and silent while direct scrubbing moves the arm',raised=state()['stylusRaised'],audio=signal())
        release();check(state()['stylusRaised'] and state()['transportPaused'],'Direct release preserves both raised CUE and pause')
        page.locator('#cue').click()

        # Genuine Chromium touch-to-pointer input and pointer capture.
        session=context.new_cdp_session(page);x,y=point(state()['grooveProgress'])
        session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
        page.wait_for_function('turntable.state.directScrubbing')
        x,y=point(.72,-55);session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y}]});page.wait_for_timeout(45)
        check(abs(state()['grooveProgress']-.72)<.001,'Captured touch directly controls the groove outside the visible timeline')
        session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});page.wait_for_function('!turntable.state.directScrubbing')
        check(state()['transportPaused'] and not state()['seeking'],'Touch release completes without a stuck gesture or delayed traversal')

        x,y=point(state()['grooveProgress'])
        session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
        page.wait_for_function('turntable.state.directScrubbing')
        session.send('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]})
        page.wait_for_function('!turntable.state.directScrubbing')
        check(state()['transportPaused'] and not state()['seeking'],'Native touch cancellation releases the captured gesture without resuming playback')

        # Return/reset and auto-cue automation cannot overrule intentional later motion.
        grab();move(.6);page.evaluate('turntable.controls.returnArm()')
        page.wait_for_function('!turntable.state.tonearmMotion');page.mouse.up();page.wait_for_timeout(120)
        check(not state()['directScrubbing'] and abs(state()['tonearmAngle']-g['rest'])<.001,'Return Arm cancels active HUD capture without an old release restoring its groove')
        page.evaluate('turntable.controls.play()');page.wait_for_function("turntable.state.assistPhase!=='idle'")
        page.mouse.move(*point(.1));page.mouse.down();move(.4,40);release();page.wait_for_timeout(1100)
        check(state()['assistPhase']=='idle' and not state()['seeking'] and .399<state()['grooveProgress']<.403,'Intentional direct scrub cancels auto-cue and no stale automation moves the arm later')

        final_graph=page.evaluate('({...__scrubPerf,worklets:__probe.worklets,starts:__probe.starts})')
        check(final_graph==initial_graph,'All pointer events reuse decoded PCM and the existing audio graph',before=initial_graph,after=final_graph)
        check(all(f['signal']['finite'] and f['signal']['peak']<1 for f in forward+reverse),'Rapid bidirectional scrubbing stays finite and below digital clipping')
        check(not errors,'No browser or worklet errors during direct manipulation',errors=errors)
        page.screenshot(path=ROOT/'artifacts/direct-scrub-desktop.png',full_page=True)
        audio_frames=page.evaluate('__audioFrames')
        browser.close()
        (ROOT/'artifacts/direct-scrub.json').write_text(json.dumps({'result':'passed','total':len(checks),'checks':checks,'pointerFrames':frames,'clickFrames':click_frames,'forward':forward,'reverse':reverse,'audioFrames':audio_frames},indent=2)+'\n')
        print(f'PASS {len(checks)} direct scrubbing browser checks',flush=True)


if __name__=='__main__':run()
