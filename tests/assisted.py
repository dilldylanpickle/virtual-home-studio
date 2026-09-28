"""Assisted Play operates the same physical deck and yields to manual input."""
import json
import time
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW, PROBE, select_speed, set_power, arm_point

from audio_fixtures import generated_long_record

checks = []
def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)

def run():
    (ROOT / "artifacts").mkdir(exist_ok=True)
    with generated_long_record() as long_record, sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1440, 'height':1500})
        page.add_init_script(PROBE)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        state = lambda: page.evaluate('turntable.state')
        click = lambda id: page.locator('#'+id).click()
        def load(path):
            page.locator('#file-input').set_input_files(path)
            page.wait_for_function("turntable.state.recordPhase==='ready'")
        def wait_cue():
            page.wait_for_function("turntable.state.assistPhase==='cueing'")
        def wait_play():
            page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.stylusContact && turntable.state.grooveRegion==='music' && turntable.state.position>.05")
        def begin_parked():
            page.evaluate('turntable.controls.returnArm()')
            page.evaluate('turntable.controls.play()')
            wait_cue()
        def no_stale(message):
            before = state()
            page.wait_for_timeout(1100)
            after = state()
            check(after['assistPhase']=='idle' and after['stylusRaised']==before['stylusRaised'] and after['platterRunning']==before['platterRunning'] and abs(after['tonearmAngle']-before['tonearmAngle'])<1e-7, message)

        load(RAW)
        check(state()['labelColor']=='Blue' and state()['vinylColor']=='Black', 'Default record and shared material state are black with a blue label')
        page.evaluate('window.motion=[];turntable.controls.subscribe(s=>motion.push({phase:s.assistPhase,angle:s.tonearmAngle,raised:s.stylusRaised,rpm:s.actualRPM}))')
        started=time.monotonic()
        click('transport');wait_cue()
        check(state()['rpm']==100/3 and state()['platterRunning'], 'Upload → Play chooses 33⅓ and starts the physical motor')
        check(page.locator('#transport-label').inner_text()=='Starting…' and not page.locator('#transport').is_disabled(), 'Startup is visible and can be cancelled from the same button')
        page.wait_for_timeout(180)
        g=page.evaluate('turntable.geometry');s=state()
        check(g['rest']<s['tonearmAngle']<g['outerAngle'] and s['stylusRaised'], 'Assisted arm travels continuously around its pivot with the stylus raised')
        wait_play()
        check(time.monotonic()-started<4, 'The easy path reaches music within a few seconds')
        page.wait_for_function('turntable.state.position>1.6')
        rms=page.evaluate('''()=>{const a=__probe.analyser,d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return Math.sqrt(d.reduce((s,x)=>s+x*x,0)/d.length)}''')
        check(rms>.001 and state()['stylusContact'], 'Short fixture produces real audio after automatic contact and run-in')
        click('transport');held=state();page.wait_for_timeout(65)
        check(state()['transportPaused'] and 0<state()['actualRPM']<held['targetRPM'], 'HUD Pause retains the physical soft slowdown')
        page.wait_for_function("turntable.state.transportState==='paused'")
        check(abs(state()['position']-held['position'])<1e-8 and abs(state()['tonearmAngle']-held['tonearmAngle'])<1e-8, 'Pause preserves the exact groove and arm')
        click('transport');page.wait_for_timeout(240)
        check(state()['assistPhase']=='idle' and held['position']<state()['position']<held['position']+.35, 'Play resumes the paused groove without an auto-cue detour')
        page.wait_for_function("turntable.state.grooveRegion==='run-out'")
        page.wait_for_function("document.querySelector('#transport-label').textContent==='Play again'")
        check(state()['platterRunning'] and state()['stylusContact'], 'Run-out keeps the manual motor/contact behavior while offering Play again')
        click('transport');wait_cue();page.wait_for_timeout(150)
        check(state()['stylusRaised'] and g['outerAngle']<state()['tonearmAngle']<g['innerAngle'], 'Play again lifts and rotates the arm outward')
        wait_play()
        check(state()['position']<.5 and state()['rpm']==100/3, 'Replay passes through run-in and starts the same record from the beginning')
        page.evaluate('turntable.controls.pause()')

        load(long_record);click('transport');wait_play();click('transport')
        page.wait_for_function("turntable.state.transportState==='paused'")
        page.locator('#tonearm').focus();page.keyboard.press('Home')
        for _ in range(5): page.keyboard.press('Shift+ArrowRight')
        anchor=state()['position']
        check(abs(anchor/state()['duration']-.5)<1e-7, 'Manual tonearm keyboard movement selects the middle of the generated long record while paused')
        click('transport');page.wait_for_timeout(240)
        check(anchor<state()['position']<anchor+.4 and state()['tonearmAngle']>g['outerAngle'], 'Play respects the manually selected middle groove')
        click('transport');click('cue')
        before=state()['tonearmAngle'];click('transport')
        page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.stylusContact")
        check(abs(state()['tonearmAngle']-before)<.1 and state()['position']>anchor, 'Play lowers a raised cue at the selected groove without moving to the beginning')
        for rpm in [45,78]:
            page.evaluate('turntable.controls.pause()')
            select_speed(page,rpm)
            page.evaluate('async()=>{await turntable.controls.returnArm();turntable.controls.customize("condition","Very Good");turntable.controls.customize("cartridge",true);turntable.controls.customize("centering",.2);turntable.controls.setVolume(.42)}')
            if state()['quartzLock']: click('quartz')
            page.locator('#pitch').fill('3')
            click('transport');wait_play()
            s=state()
            check(s['rpm']==rpm and abs(s['actualRPM']-rpm*1.03)<.02, f'Assisted start respects selected {rpm} RPM and pitch')
            check(s['pitch']==3 and not s['quartzLock'] and s['volume']==.42 and s['condition']=='Very Good' and s['cartridge'] and s['centering']==.2, 'Assistance preserves deliberate listening and simulation settings')
        page.evaluate('turntable.controls.pause()');select_speed(page,100/3);click('quartz')
        set_power(page,False)
        click('transport');page.wait_for_function("turntable.state.assistPhase==='powering'")
        page.wait_for_timeout(70)
        check(-90<state()['powerAngle']<0, 'Assisted power-on visibly rotates the existing knob')
        page.wait_for_function("turntable.state.assistPhase==='idle'")
        check(state()['power'] and state()['powerAngle']==0, 'Assisted power-on reaches the real ON endpoint')

        # Same-frame cancellation also invalidates the pending audio-unlock continuation.
        page.evaluate('turntable.controls.returnArm();turntable.controls.play();turntable.controls.pause()')
        no_stale('Pause cancels even before audio preparation finishes')
        begin_parked();click('transport');no_stale('Pause during cueing cannot later lower the stylus or move the arm')
        begin_parked();click('start-stop');no_stale('Physical START/STOP cancels automation and retains the manual motor choice')
        check(not state()['platterRunning'], 'Physical STOP during cueing leaves the motor stopped')
        begin_parked();click('rpm-45');no_stale('A speed latch change takes priority over automatic cueing')
        begin_parked();page.wait_for_timeout(120)
        page.locator('#deck').scroll_into_view_if_needed()
        xy=arm_point(page,g,state()['tonearmAngle']);page.mouse.move(*xy);page.mouse.down()
        check(state()['dragging'] and state()['assistPhase']=='idle', 'Grabbing the moving headshell immediately takes over the physical arm')
        page.mouse.up();no_stale('Releasing the manually grabbed arm leaves no stale auto-cue')
        begin_parked();click('eject')
        page.wait_for_function("turntable.state.recordPhase==='empty'")
        no_stale('Eject during cueing completes safely without delayed contact')
        check(not state()['recordPresent'] and state()['stylusRaised'], 'An ejected record cannot receive automatic stylus contact')
        load(RAW);begin_parked()
        with page.expect_file_chooser() as chooser: click('load')
        check(state()['recordPhase']=='ready' and state()['recordLoaded'] and state()['filename']==RAW.name,
              'Replace opens the picker before changing the record during assisted cueing')
        chooser.value.set_files(RAW)
        page.wait_for_function("turntable.state.recordPhase==='ready' && turntable.state.assistPhase==='idle'")
        no_stale('Selected replacement cancels cueing before removal and leaves the new record parked')
        load(RAW);begin_parked();load(long_record)
        no_stale('Direct replacement during cueing leaves the new record safely parked')
        page.evaluate('turntable.controls.play()');wait_play()
        check(page.evaluate('__probe.worklets')==1 and page.evaluate('__probe.starts')==0, 'All assisted starts and replacements retain one audio processor and no source restarts')
        # Existing running motor is never stopped or ramped again by assistance.
        page.evaluate('async()=>{await turntable.controls.returnArm();window.motorTrace=[];window.stopTrace=turntable.controls.subscribe(s=>motorTrace.push(s.actualRPM))}')
        page.evaluate('turntable.controls.play()');wait_play()
        check(page.evaluate('motorTrace.every(rpm=>rpm>33)'),'A spinning platter keeps its speed throughout assisted arm movement')
        page.evaluate('stopTrace();turntable.controls.pause()')
        for width,height,name in [(1440,1200,'desktop'),(900,1000,'tablet'),(390,844,'mobile')]:
            page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(100)
            check(page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'{name} layout has no horizontal overflow')
            check(not page.locator('#physical-rpm').is_visible(),f'{name} technical readouts stay in collapsed details')
            box=page.locator('#customize-open').bounding_box()
            check(box['height']>=44 and box['width']>=88,f'{name} customization has a readable label and generous hitbox')
            page.screenshot(path=str(ROOT/f'artifacts/assisted-{name}.png'),full_page=True)
        page.set_viewport_size({'width':1440,'height':1200})
        click('customize-open');page.screenshot(path=str(ROOT/'artifacts/assisted-customize.png'),full_page=True)
        page.keyboard.press('Escape');page.locator('#turntable-details summary').click()
        check(page.locator('#physical-rpm').is_visible(), 'Technical details remain available through the accessible disclosure')
        check(not errors,'No browser errors during assisted playback or interruptions')
        browser.close()
    (ROOT/'artifacts/assisted.json').write_text(json.dumps({'checks':checks},indent=2))
    print(f'{len(checks)} assisted playback checks passed')

if __name__=='__main__': run()
