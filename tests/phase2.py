"""Quartz matrix and shared HUD/physical transport browser acceptance."""
import json
import math
import struct
import tempfile
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright
from audio_assertions import wait_for_silence
from acceptance import PROBE, ROOT, select_speed, set_power
checks=[]
def check(ok,message):
    assert ok,message
    checks.append(message);print('PASS '+message,flush=True)

def run():
    (ROOT / "artifacts").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        path=Path(tmp)/'shared-state-tone.wav'
        with wave.open(str(path),'wb') as f:
            f.setparams((1,2,24000,0,'NONE','not compressed'))
            one=b''.join(struct.pack('<h',int(9000*math.sin(i*2*math.pi*440/24000))) for i in range(24000))
            f.writeframes(one*24)
        browser=p.chromium.launch();page=browser.new_page(viewport={'width':1440,'height':1250});page.add_init_script(PROBE)
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto('http://127.0.0.1:42069');page.wait_for_function('window.turntable')
        state=lambda:page.evaluate('turntable.state');click=lambda id:page.locator('#'+id).click()
        rms=lambda:page.evaluate('''()=>{const a=__probe.analyser;if(!a)return 0;const d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return Math.sqrt(d.reduce((s,x)=>s+x*x,0)/d.length)}''')
        page.locator('#file-input').set_input_files(path);page.wait_for_function("turntable.state.recordPhase==='ready'")
        click('transport');page.wait_for_function('turntable.state.rpm !== null');check(abs(state()['rpm']-100/3)<1e-8,'HUD Play selects 33 only when neither speed is latched')
        page.wait_for_function("turntable.state.position>.1 && turntable.state.grooveRegion==='music'")
        check(state()['stylusContact'] and rms()>.01,'HUD Play starts the shared motor and places a parked needle')
        click('transport');held=state();page.wait_for_timeout(65);mid=state()
        check(mid['transportPaused'] and mid['platterRunning'] and 0<mid['actualRPM']<held['targetRPM'],'HUD Pause slows the platter while retaining the physical motor request')
        page.wait_for_function("turntable.state.transportState==='paused'");page.wait_for_timeout(100);paused=state()
        check(abs(paused['position']-held['position'])<1e-8 and paused['tonearmAngle']==held['tonearmAngle'],'Soft pause preserves the exact logical position and tonearm angle')
        wait_for_silence(page, 1e-7)
        check(rms()<1e-7 and paused['recordLoaded'],'Paused record is retained and output becomes silent')
        check(page.locator('#transport').get_attribute('aria-label')=='Resume playback','HUD reports the authoritative paused transport state')
        page.locator('#groove-progress').fill('55')
        page.wait_for_function('!turntable.state.seeking')
        check(abs(state()['position']/state()['duration']-.55)<1e-8 and state()['transportPaused'],'HUD seek moves the shared groove while staying paused')
        angle=state()['tonearmAngle'];page.locator('#tonearm').focus();page.keyboard.press('ArrowRight')
        check(state()['tonearmAngle']>angle and abs(float(page.locator('#groove-progress').input_value())-56)<.01,'Tonearm seeking updates HUD progress in the opposite direction')
        before=state()['position'];click('customize-open');page.get_by_role('button',name='Vinyl: Purple',exact=True).click();page.get_by_role('button',name='Label: Red',exact=True).click();page.get_by_role('radio',name='Poor',exact=True).check();page.keyboard.press('Escape')
        check(state()['position']==before and state()['transportPaused'],'Live customization preserves a paused groove')
        check(page.locator('#mini-record').evaluate("el=>el.style.getPropertyValue('--record-color')==='#3b204e' && el.style.getPropertyValue('--label-color')==='#a94249'"),'HUD thumbnail shares the vinyl and label material state')
        page.evaluate('turntable.controls.setVolume(.37)');page.wait_for_timeout(160)
        check(page.locator('#volume').input_value()=='0.37' and abs(page.evaluate('turntable.outputLevel')-.37)<.001,'Presentation-independent volume command updates audio and HUD')
        click('transport');page.wait_for_timeout(260)
        check(not state()['transportPaused'] and before<state()['position']<before+.35 and rms()>.01,'Resume ramps from the preserved groove instead of restarting')
        click('start-stop');page.wait_for_function('turntable.state.motorActualRate===0')
        check(not state()['platterRunning'] and not state()['transportPaused'],'Physical STOP remains a distinct motor action')
        click('transport');page.wait_for_timeout(300);check(state()['platterRunning'],'HUD Play restarts a physically stopped platter')

        # A slider event counter proves Quartz tests never nudge or synthesize pitch input.
        page.evaluate("window.pitchEvents=0;document.querySelector('#pitch').addEventListener('input',()=>pitchEvents++)")
        for rpm in [100/3,45,78]:
            select_speed(page,rpm)
            for limit in [8,16]:
                if state()['pitchRange']!=limit:click('pitch-range')
                for pitch in [-limit,limit]:
                    for running in [True,False]:
                        if state()['platterRunning']!=running:click('start-stop')
                        page.wait_for_function('!turntable.state.motorRamping && Math.abs(turntable.state.actualRPM-turntable.state.motorTargetRPM)<.005')
                        if state()['quartzLock']:click('quartz')
                        page.locator('#pitch').fill(str(pitch))
                        page.evaluate('turntable.controls.seek(.2)')
                        page.wait_for_timeout(80)
                        count=page.evaluate('pitchEvents')
                        click('quartz');s=state()
                        check(s['effectivePitch']==0 and abs(s['targetRPM']-rpm)<1e-8 and s['pitch']==pitch,
                              f'Quartz immediately derives nominal {rpm:g} RPM from {pitch:+}% ({"running" if running else "stopped"})')
                        page.wait_for_timeout(100);s=state()
                        check(abs(s['actualRPM']-(rpm if running else 0))<.01 and page.evaluate('pitchEvents')==count,
                              'Actual motor follows Quartz without any additional slider event')
                        click('quartz');page.wait_for_timeout(100);s=state()
                        expected=rpm*(1+pitch/100)
                        check(s['effectivePitch']==pitch and abs(s['actualRPM']-(expected if running else 0))<.01,
                              'Unlocking Quartz restores the untouched physical slider setting')

        if not state()['quartzLock']:click('quartz')
        select_speed(page,100/3)
        page.evaluate('turntable.controls.customize("surface",false);turntable.controls.customize("contacts",false);turntable.controls.setVolume(.75)')
        click('transport');page.wait_for_timeout(350);click('transport');page.wait_for_function("turntable.state.transportState==='paused'")
        # Conditions, speed and Quartz can change while paused without losing the anchor.
        anchor=state()['position'];select_speed(page,78);page.locator('#pitch').fill('-16');click('quartz')
        check(state()['position']==anchor and state()['actualRPM']==0,'Changing RPM and pitch while paused preserves its silent anchor')
        click('transport');page.wait_for_timeout(230)
        check(abs(state()['actualRPM']-78*.84)<.01 and state()['position']>anchor,'Resume uses the latest effective speed')
        click('transport');page.wait_for_function("turntable.state.transportState==='paused'")
        page.locator('#vinyl-hit-area').focus();start=state()['position'];page.keyboard.down('ArrowLeft');page.wait_for_timeout(120);page.keyboard.up('ArrowLeft');page.wait_for_timeout(150)
        check(state()['position']<start and state()['transportPaused'] and state()['motorActualRate']==0,'Manual scratching remains available during software pause without restarting the motor')
        for _ in range(3):
            click('transport');page.wait_for_timeout(30);click('transport');page.wait_for_timeout(30)
        page.wait_for_function("turntable.state.transportState==='paused'");anchor=state()['position'];page.wait_for_timeout(150)
        wait_for_silence(page, 1e-7)
        check(state()['position']==anchor and rms()<1e-7,'Rapid pause/resume leaves no stale moving audio reader')
        set_power(page,False);check(not state()['transportPaused'] and not state()['platterRunning'],'POWER off clears the software pause override')
        set_power(page,True);click('transport');page.wait_for_timeout(200);click('transport');page.wait_for_function("turntable.state.transportState==='paused'")
        click('eject');page.wait_for_function("turntable.state.recordPhase==='empty'")
        check(not state()['transportPaused'] and page.locator('#transport').is_disabled() and float(page.locator('#groove-progress').input_value())==0,'Eject clears transport and progress through the same lifecycle')
        page.locator('#file-input').set_input_files(path);page.wait_for_function("turntable.state.recordPhase==='ready'")
        click('transport');page.wait_for_timeout(300)
        check(not state()['transportPaused'] and state()['platterRunning'],'Replacement does not inherit a stale pause')
        for width,height in [(1440,1250),(900,1000),(390,844)]:
            page.set_viewport_size({'width':width,'height':height})
            page.locator('#listening-hud').scroll_into_view_if_needed()
            bounds=page.locator('#listening-hud').bounding_box()
            deck=page.locator('#deck').bounding_box()
            check(page.evaluate('document.documentElement.scrollWidth<=innerWidth') and bounds['y']>=deck['y']+deck['height'],f'HUD remains responsive and does not cover hardware at {width}px')
            for id in ['transport','volume','groove-progress','customize-open','load','eject']:
                box=page.locator('#'+id).bounding_box()
                check(box['x']>=bounds['x'] and box['x']+box['width']<=bounds['x']+bounds['width']+1,f'{id} remains inside the HUD at {width}px')
        page.locator('#transport').focus();page.keyboard.press('Space');page.wait_for_function("turntable.state.transportState==='paused'")
        check(state()['platterRunning'],'Keyboard HUD pause does not leak into the physical Space shortcut')
        click('customize-open');check(page.locator('#customize').evaluate('el=>el.open'),'Customization dialog opens above the HUD');page.keyboard.press('Escape')
        check(page.evaluate('__probe.worklets===1 && __probe.starts===0'),'HUD and physical controls share one persistent audio processor')
        page.evaluate('window.snapshots=[];window.unsubscribe=turntable.controls.subscribe(s=>snapshots.push(s.volume));turntable.controls.setVolume(.42)')
        page.wait_for_timeout(140)
        check(page.evaluate('snapshots.at(-1)===.42') and page.locator('#volume').input_value()=='0.42','Presentation subscribers receive the same authoritative snapshots as the HUD')
        page.evaluate('unsubscribe();window.count=snapshots.length;turntable.controls.setVolume(.7)')
        page.wait_for_timeout(140)
        check(page.evaluate('snapshots.length===count') and page.locator('#volume').input_value()=='0.7','Unsubscribing a presentation leaves the model and HUD functional')
        check(not errors,'No browser errors throughout Phase 2 controls')
        browser.close()
    (ROOT/'artifacts/phase2.json').write_text(json.dumps({'result':'passed','total':len(checks),'checks':checks},indent=2)+'\n')
    print(f'All {len(checks)} Phase 2 browser checks passed.')
if __name__=='__main__':run()
