"""Browser lifecycle races, customization, contact/groove audio and animation checks."""
import json
import math
import struct
import tempfile
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright
from audio_assertions import wait_for_silence
from acceptance import PROBE, ROOT, select_speed, arm_point, groove_angle

checks = []
def check(condition, message):
    assert condition, message
    checks.append(message)
    print(f"PASS {message}", flush=True)


def run():
    (ROOT / "artifacts").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        paths = []
        for name in ['first', 'second', 'latest', 'slow']:
            path = Path(tmp) / f'{name}.wav'
            with wave.open(str(path), 'wb') as f:
                f.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                f.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * 2 * math.pi * 440 / 24000))) for i in range(24000 * 5)))
            paths.append(path)
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1440, 'height':1250})
        page.add_init_script(PROBE)
        errors=[]
        page.on('pageerror', lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        state=lambda:page.evaluate('turntable.state')
        click=lambda id:page.locator('#'+id).click()
        phase=lambda value:page.wait_for_function('value=>turntable.state.recordPhase===value',arg=value)
        rms=lambda:page.evaluate('''() => {
          const a=__probe.analyser;if(!a)return 0;
          const data=new Float32Array(a.fftSize);a.getFloatTimeDomainData(data);
          return Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length);
        }''')
        page.evaluate('''() => {
          window.phases=[];function record(){const phase=turntable.state.recordPhase;if(phases.at(-1)!==phase)phases.push(phase);requestAnimationFrame(record)}record();
        }''')
        page.locator('#file-input').set_input_files(paths[0]);phase('inserting')
        check(state()['recordPresent'] and not state()['recordLoaded'], 'Inserting record is visible but not yet playable')
        matrix=page.locator('#record-lift').evaluate('el=>new DOMMatrix(getComputedStyle(el).transform).f')
        check(matrix < -2, 'Insertion physically descends from above the platter')
        page.evaluate("['cue','start-stop'].forEach(id=>document.getElementById(id).dispatchEvent(new MouseEvent('click')))")
        check(state()['stylusRaised'] and not state()['platterRunning'], 'Insertion blocks needle drop and motor start')
        phase('ready')
        check(page.evaluate("phases.includes('loading')&&phases.includes('inserting')&&phases.at(-1)==='ready'"), 'Loading follows explicit loading, inserting, ready phases')
        check(page.locator('#record').is_visible(), 'Record stays seated after insertion animation finishes')

        select_speed(page,100/3)
        g=page.evaluate('turntable.geometry')
        page.mouse.move(*arm_point(page,g,state()['tonearmAngle']));page.mouse.down()
        page.mouse.move(*arm_point(page,g,groove_angle(g,.003)),steps=8);page.mouse.up()
        check(state()['position']==0, 'Hand placement near the outer edge enters the run-in area')
        click('cue');click('start-stop');page.wait_for_timeout(90)
        check(0 < state()['motorActualRate'] < 1 and state()['motorRamping'], 'START accelerates through intermediate velocities')
        check(state()['grooveRegion']=='run-in' and state()['position']==0, 'Outer edge enters the virtual run-in before music')
        page.wait_for_timeout(260)
        check(0 < rms() < .001, 'Run-in emits only a subtle surface signal')
        page.wait_for_function("turntable.state.grooveRegion==='music' && turntable.state.position>.1")
        check(rms()>.01, 'Source music starts naturally after run-in')
        before=state();click('start-stop');page.wait_for_timeout(100)
        s=state()
        check(0<s['motorActualRate']<1 and s['position']>before['position'], 'STOP audibly coasts instead of freezing')
        page.wait_for_function('turntable.state.motorActualRate===0')
        page.wait_for_timeout(80)
        wait_for_silence(page, 1e-6)
        check(rms()<.000001, 'Settled platter is silent')

        click('customize-open')
        pos=state()['position'];angle=state()['tonearmAngle']
        page.get_by_role('button',name='Vinyl: Blue',exact=True).click()
        page.get_by_role('button',name='Label: Black',exact=True).click()
        check(state()['vinylColor']=='Blue' and state()['labelColor']=='Black', 'Vinyl and center label customize independently')
        check(state()['position']==pos and state()['tonearmAngle']==angle and not state()['stylusRaised'], 'Color changes preserve playback cursor and manual cue')
        ink=page.locator('#record-label').evaluate("el=>el.style.getPropertyValue('--label-ink')")
        check(ink=='#ffffff', 'Dark center label automatically gets readable light text')
        page.get_by_role('button',name='Label: White',exact=True).click()
        check(page.locator('#record-label').evaluate("el=>el.style.getPropertyValue('--label-ink')")=='#000000', 'Light center label automatically gets dark text')
        page.get_by_role('button',name='Vinyl: Clear',exact=True).click()
        check(float(page.locator('#vinyl-body').get_attribute('opacity'))<.5 and page.locator('#mat-brand').is_visible(), 'Clear vinyl reveals the mat while retaining grooves')
        check(page.locator('#grooves circle').count()==191, 'All waveform groove rings survive customization')
        page.get_by_role('radio',name='Poor',exact=True).check()
        check(state()['condition']=='Poor' and float(page.locator('#record-wear').get_attribute('opacity'))>.2, 'Record condition connects sound settings to subtle wear marks')
        page.evaluate('turntable.controls.customize("surface",false);turntable.controls.customize("contacts",false);turntable.controls.customize("cartridge",true)')
        check(not state()['surface'] and not state()['contacts'] and state()['cartridge'], 'Advanced feature flags remain independently controllable through the shared API')
        page.keyboard.press('Escape')
        check(not page.locator('#customize').evaluate('el=>el.open'), 'Customization closes with Escape and restores the page')
        click('start-stop');page.wait_for_timeout(350)
        check(rms()>.01, 'Cartridge stage preserves source playback')
        page.locator('#tonearm').focus();page.keyboard.press('End')  # The cartridge stage remains enabled during run-out.
        wait_for_silence(page, 1e-6)
        check(state()['grooveRegion']=='run-out' and rms()<.000001 and state()['motorActualRate']>0, 'Clean run-out stops music while the platter continues')
        click('customize-open');page.evaluate('turntable.controls.customize("surface",true);turntable.controls.customize("contacts",true)');page.keyboard.press('Escape')
        page.wait_for_timeout(150)
        check(rms()>.00001, 'Worn run-out produces continuing surface sound')
        count=page.evaluate('turntable.audioDiagnostics.contactCount')
        click('cue');page.wait_for_timeout(250)
        wait_for_silence(page, 1e-6)
        check(rms()<.000001 and page.evaluate('turntable.audioDiagnostics.contactCount')==count+1, 'Actual stylus separation triggers one lift and then silence')
        click('cue');page.wait_for_timeout(250)
        check(page.evaluate('turntable.audioDiagnostics.contactCount')==count+2, 'Actual groove contact triggers one needle drop')
        click('arm-rest');page.wait_for_function('turntable.state.tonearmMotion===null && turntable.state.tonearmAngle===turntable.geometry.rest')
        count=page.evaluate('turntable.audioDiagnostics.contactCount')
        click('cue');page.wait_for_timeout(250)
        wait_for_silence(page, 1e-6)
        check(rms()<.000001 and page.evaluate('turntable.audioDiagnostics.contactCount')==count, 'Cueing over the arm rest creates no false contact or surface sound')

        click('target-light');page.wait_for_timeout(65)
        glow=lambda:page.locator('#light-glow').evaluate('el=>Number(getComputedStyle(el).opacity)')
        check(0<glow()<1, 'Target light visibly warms through intermediate brightness')
        page.wait_for_timeout(400);check(glow()==1,'Target light reaches full brightness')
        click('target-light');page.wait_for_timeout(65)
        check(0<glow()<1,'Target light fades naturally on deactivation')
        page.wait_for_timeout(400);check(glow()==0,'Target light returns fully dark')
        for id in ['power','rpm-33','cue','tonearm','pitch']:
            check(page.locator('#'+id).evaluate("el=>getComputedStyle(el).outlineStyle==='none'"),f'{id} has no browser bounding-box outline')
        page.locator('#power').focus();page.keyboard.press('ArrowLeft')
        check(page.locator('#power').evaluate("el=>el.matches(':focus-visible') && getComputedStyle(el).filter!=='none'"),'Keyboard hardware focus retains a shaped visual indicator')

        # Repeated eject requests share a physical removal; the record remains until lifted.
        page.evaluate('phases=[]')
        click('eject');phase('ejecting')
        check(state()['recordPresent'] and state()['stylusRaised'], 'Eject raises the stylus before removing the visible record')
        page.locator('#eject').evaluate("el=>{for(let i=0;i<4;i++)el.dispatchEvent(new MouseEvent('click'))}")
        phase('empty')
        check(not state()['recordPresent'] and not state()['filename'] and state()['duration']==0, 'Eject clears audio metadata only after the record leaves')
        check(page.evaluate("phases.filter(x=>x==='ejecting').length===1"), 'Repeated eject does not create concurrent animations')
        check(page.locator('#record-lift').evaluate('el=>el.getAnimations().length')==0,'Finished animations release their effect objects')

        # An invalid replacement during insertion must leave the seated record usable.
        invalid=Path(tmp)/'invalid.wav';invalid.write_text('not an audio file')
        page.locator('#file-input').set_input_files(paths[0]);phase('inserting')
        page.locator('#file-input').set_input_files(invalid)
        page.wait_for_function("document.querySelector('#notice').classList.contains('error')")
        check(state()['recordPhase']=='ready' and state()['recordLoaded'] and state()['filename']=='first.wav',
              'Invalid replacement during insertion restores a fully usable original record')
        click('eject');phase('empty')
        page.locator('#file-input').set_input_files(paths[3]);click('eject');phase('empty')
        click('start-stop');page.wait_for_timeout(350);click('start-stop')
        page.wait_for_function('turntable.state.motorActualRate===0')
        check(not state()['recordPresent'], 'Cancelling an empty-platter load finishes parking before unlocking START')

        # Latest file wins even while a record is in flight.
        page.locator('#file-input').set_input_files(paths[0]);phase('inserting')
        page.locator('#file-input').set_input_files(paths[1])
        page.locator('#file-input').set_input_files(paths[2]);phase('ready')
        check(state()['filename']=='latest.wav' and state()['recordLoaded'], 'Latest replacement wins during an insertion without a stale record swap')
        check(state()['vinylColor']=='Clear' and state()['condition']=='Poor','Record preferences survive replacement')
        invalid=Path(tmp)/'invalid.wav';invalid.write_text('not an audio file')
        page.locator('#file-input').set_input_files(invalid)
        page.wait_for_function("document.querySelector('#notice').classList.contains('error')")
        check(state()['recordPhase']=='ready' and state()['filename']=='latest.wav','Decode failure preserves the existing record without stranding a transition')

        # A decoder that resolves after eject must not resurrect its file.
        page.evaluate('''() => {const original=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){if(this.name==='slow.wav')await new Promise(r=>setTimeout(r,500));return original.call(this)}}''')
        page.locator('#file-input').set_input_files(paths[3]);phase('loading');click('eject');phase('empty');page.wait_for_timeout(650)
        check(state()['recordPhase']=='empty' and not state()['filename'], 'Eject invalidates an outstanding decode')
        page.locator('#file-input').set_input_files(paths[0]);phase('ready')
        click('load')
        with page.expect_file_chooser() as chooser: click('source-local')
        check(state()['recordPhase']=='ready' and state()['filename']=='first.wav',
              'Replace opens the picker before changing or ejecting the current record')
        chooser.value.set_files(paths[2]);phase('loading');phase('ready')
        check(state()['filename']=='latest.wav','Replacement selection inserts the new record coherently')
        check(page.evaluate('__probe.worklets===1 && __probe.starts===0'),'All loads and effects retain one processor with no duplicate source nodes')
        page.set_viewport_size({'width':390,'height':844});click('customize-open')
        check(page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Customization keeps mobile layout within the viewport')
        page.screenshot(path=str(ROOT/'artifacts/customize-mobile.png'))
        page.keyboard.press('Escape')
        page.emulate_media(reduced_motion='reduce')
        click('eject');phase('empty')
        page.locator('#file-input').set_input_files(paths[0]);phase('ready')
        check(page.locator('#record-lift').evaluate('el=>el.getAnimations().length')==0 and state()['recordLoaded'],
              'Reduced-motion handling completes with a seated, playable record')
        check(not errors,'No browser exceptions during lifecycle and realism tests')
        browser.close()
    (ROOT/'artifacts/realism.json').write_text(json.dumps({'result':'passed','total':len(checks),'checks':checks},indent=2)+'\n')
    print(f'All {len(checks)} realism browser checks passed.')

if __name__=='__main__':run()
