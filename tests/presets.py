"""Playback presets command the existing physical state and motor in the browser."""
import json
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW, PROBE

PRESETS = [
    ('original', 'Original', 100/3, 0),
    ('slowed', 'Slowed + Pitched Down', 100/3, -16),
    ('slightly-sped-up', 'Slightly Sped Up + Pitched Up', 100/3, 16),
    ('sped-up', 'Sped Up', 45, -8),
    ('sped-up-pitched-up', 'Sped Up + Pitched Up', 45, 0),
    ('nightcore', 'Nightcore', 45, 16),
    ('hyperpop', 'Hyperpop', 78, -16),
    ('chipmunk', 'Chipmunk', 78, 0),
]
checks = []
def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)

def run():
    out = ROOT / 'artifacts/presets'; out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1440,'height':1300})
        page.add_init_script(PROBE)
        errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)
        page.goto('http://127.0.0.1:42069');page.wait_for_function('window.turntable')
        state=lambda:page.evaluate('turntable.state')
        toggle=page.locator('#preset-toggle');options=page.locator('#preset-options')
        def choose(id):
            toggle.click();page.locator(f'[data-preset="{id}"]').click()
            page.wait_for_function("!turntable.state.presetMotion")
        def load():
            page.locator('#file-input').set_input_files(RAW)
            page.wait_for_function("turntable.state.recordPhase==='ready'")
        def pause():
            page.evaluate('turntable.controls.pause()')
            page.wait_for_function("turntable.state.transportState==='paused'")
        check(state()['rpm'] is None and page.locator('#preset-name').inner_text()=='Choose a preset', 'Empty default does not falsely claim Original or select a speed')
        toggle.focus();page.keyboard.press('Space')
        check(options.is_visible() and not state()['platterRunning'], 'Space opens presets without triggering the deck motor shortcut')
        check(page.locator('#preset-options button > span').all_text_contents()==[x[1] for x in PRESETS], 'All seven requested names and Original appear exactly as specified')
        page.keyboard.press('ArrowDown');page.keyboard.press('End');page.keyboard.press('Enter')
        check(state()['rpm']==78 and page.locator('#preset-name').inner_text()=='Chipmunk' and not state()['platterRunning'], 'Keyboard selection configures empty hardware without starting it')
        check(not options.is_visible() and toggle.evaluate('el=>el===document.activeElement'), 'Selection closes the menu and restores focus')
        toggle.click();page.keyboard.press('Escape');check(not options.is_visible(), 'Escape dismisses the chooser')
        toggle.click();page.locator('#track-name').click();check(not options.is_visible(), 'Outside click dismisses the chooser')
        load();page.locator('#transport').click()
        page.wait_for_function("turntable.state.stylusContact && turntable.state.assistPhase==='idle'")
        pause()
        for id,name,rpm,pitch in PRESETS:
            before=state();choose(id);s=state();limit=16 if abs(pitch)>8 else 8
            check(s['rpm']==rpm and s['pitch']==pitch and s['pitchRange']==limit and s['quartzLock']==(pitch==0), f'{name}: correct RPM, fader range, pitch and Quartz')
            check(s['speed33Pressed']==(rpm!=45) and s['speed45Pressed']==(rpm!=100/3)
                and page.locator('#rpm-33').get_attribute('aria-pressed')==str(rpm!=45).lower()
                and page.locator('#rpm-45').get_attribute('aria-pressed')==str(rpm!=100/3).lower()
                and float(page.locator('#pitch').input_value())==pitch, f'{name}: physical buttons and slider reflect the preset')
            check(s['transportPaused'] and s['position']==before['position'] and s['tonearmAngle']==before['tonearmAngle'] and s['stylusRaised']==before['stylusRaised'], f'{name}: paused groove and cue remain unchanged')
            check(page.locator('#preset-name').inner_text()==name and page.locator(f'[data-preset="{id}"]').get_attribute('aria-pressed')=='true', f'{name}: HUD derives the matching selection')
        page.locator('#pitch').fill('3')
        check(page.locator('#preset-name').inner_text()=='Custom', 'Manual pitch movement reports Custom even under Quartz')
        choose('nightcore');page.locator('#quartz').click()
        check(page.locator('#preset-name').inner_text()=='Custom', 'Manual Quartz changes report Custom')
        page.locator('#quartz').click()
        check(page.locator('#preset-name').inner_text()=='Nightcore', 'Returning the physical controls to a preset derives its name again')
        page.locator('#pitch-range').click()
        check(page.locator('#preset-name').inner_text()=='Custom', 'Manual range changes report Custom')
        choose('original');page.locator('#rpm-45').click()
        check(page.locator('#preset-name').inner_text()=='Chipmunk', 'Speed latches derive a matching preset without a second selection state')
        choose('original');page.locator('#transport').click()
        page.wait_for_function("turntable.state.position>1.6 && !turntable.state.motorRamping")
        live=[]
        for id,name,rpm,pitch in PRESETS:
            page.evaluate('turntable.controls.seek(.35)');page.wait_for_function('!turntable.state.seeking')
            before=state();choose(id)
            page.wait_for_function('rate=>Math.abs(turntable.state.motorActualRate-rate)<.00001 && !turntable.state.motorRamping',arg=rpm/(100/3)*(1+pitch/100))
            s=state()
            check(s['platterRunning'] and not s['transportPaused'] and s['stylusContact'] and s['position']>before['position'], f'{name}: live playback continues at the selected speed')
            signal=page.evaluate('''()=>{const a=__probe.analyser,d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return {rms:Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length),peak:Math.max(...d.map(Math.abs)),finite:d.every(Number.isFinite)}}''')
            check(signal['rms']>.001 and signal['peak']<1 and signal['finite'], f'{name}: actual master output stays audible and unclipped')
            live.append({'preset':id,'rate':s['motorActualRate'],**signal})
        pause();before=state();page.evaluate("turntable.controls.applyPreset('invalid')")
        check(state()==before, 'Unknown preset IDs leave the model unchanged')
        page.evaluate('async()=>{await turntable.controls.returnArm();turntable.controls.play()}')
        page.wait_for_function("turntable.state.assistPhase==='cueing'")
        choose('slowed');angle=state()['tonearmAngle'];page.wait_for_timeout(800)
        check(state()['assistPhase']=='idle' and state()['stylusRaised'] and state()['tonearmAngle']==angle, 'Preset selection cancels older assisted cueing without stale lowering')
        choose('nightcore');page.evaluate('void turntable.controls.eject()')
        page.wait_for_function("turntable.state.recordPhase!=='ready'")
        check(toggle.is_disabled(), 'Record handling disables the preset chooser')
        page.evaluate("turntable.controls.applyPreset('original')")
        page.wait_for_function("turntable.state.recordPhase==='empty'")
        check(state()['pitch']==16 and state()['rpm']==45, 'Busy lifecycle rejects preset commands and preserves the chosen settings')
        load();check(page.locator('#preset-name').inner_text()=='Nightcore' and not state()['platterRunning'], 'Preset settings persist through eject and reload without autoplay')
        for width,height,name in [(1440,1300,'desktop'),(900,1000,'tablet'),(390,844,'mobile')]:
            page.set_viewport_size({'width':width,'height':height});toggle.scroll_into_view_if_needed();toggle.click()
            a,b=toggle.bounding_box(),options.bounding_box();timeline=page.locator('.groove-timeline').bounding_box()
            check(a['y']>=timeline['y']+timeline['height'] and b['x']>=0 and b['x']+b['width']<=width and b['y']>=0 and b['y']+b['height']<=height, f'{name}: visible chooser sits below the timeline and menu fits the viewport')
            check(page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'{name}: no horizontal overflow')
            page.screenshot(path=str(out/f'{name}.png'),full_page=True)
            page.locator('#listening-hud').screenshot(path=str(out/f'{name}-hud.png'))
            page.keyboard.press('Escape')
        check(page.evaluate('__probe.worklets===1&&__probe.starts===0'), 'Presets reuse the persistent audio processor')
        check(not errors, 'No browser or audio errors')
        browser.close()
    (out/'checks.json').write_text(json.dumps({'checks':checks,'audio':live},indent=2))
    print(f'All {len(checks)} preset checks passed.')

if __name__=='__main__':run()
