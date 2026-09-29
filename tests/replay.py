"""Repeat uses natural audio completion and the existing cancellable physical cue."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW, PROBE, select_speed

checks = []
def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)

def run():
    out = ROOT / 'artifacts/replay'; out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1440,'height':1300})
        page.add_init_script(PROBE)
        page.add_init_script('''window.__loads=0; const post=MessagePort.prototype.postMessage;
          MessagePort.prototype.postMessage=function(m,...rest){if(m?.type==='load')__loads++;return post.call(this,m,...rest)};''')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto('http://127.0.0.1:42069'); page.wait_for_function('window.turntable')
        state = lambda: page.evaluate('turntable.state')
        repeat = page.locator('#replay-toggle')
        play = page.locator('#transport')
        def music():
            page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.stylusContact && turntable.state.grooveRegion==='music' && turntable.state.position>.05")
        def cue():
            page.wait_for_function("turntable.state.assistPhase==='cueing'", timeout=12000)
        def finish_soon():
            page.evaluate('turntable.controls.seek(.96)')
            page.wait_for_function('!turntable.state.seeking')
        def load():
            page.locator('#file-input').set_input_files(RAW)
            page.wait_for_function("turntable.state.recordPhase==='ready'")
        check(not state()['replayEnabled'] and repeat.is_disabled(), 'Repeat starts off and is disabled until a record is loaded')
        check(page.locator('#catastrophe-button').count() == 0, 'The clean branch has no catastrophe button')
        load()
        check(not repeat.is_disabled(), 'Loading a record enables the repeat control')
        repeat.focus(); page.keyboard.press('Space')
        check(state()['replayEnabled'] and repeat.get_attribute('aria-pressed') == 'true' and not state()['platterRunning'], 'Keyboard toggles repeat without triggering the motor shortcut')
        page.keyboard.press('Enter')
        check(not state()['replayEnabled'] and repeat.get_attribute('aria-pressed') == 'false', 'Keyboard can turn repeat off again')
        repeat.click(); play.click(); music()
        for lap in range(2):
            cue()
            start = state()
            check(start['stylusRaised'] and start['platterRunning'], f'Lap {lap+1}: natural completion lifts the stylus while the platter keeps spinning')
            page.wait_for_timeout(160)
            check(state()['tonearmAngle'] < start['tonearmAngle'] and state()['stylusRaised'], f'Lap {lap+1}: replay sweeps the real arm outward instead of teleporting')
            music()
            check(state()['position'] < .5 and state()['replayEnabled'], f'Lap {lap+1}: the same song starts again with repeat still enabled')
        page.wait_for_function('turntable.state.position>1.6')
        rms = page.evaluate('''()=>{const a=__probe.analyser,d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return Math.sqrt(d.reduce((s,x)=>s+x*x,0)/d.length)}''')
        check(rms > .001, f'Repeated playback reaches the fixture music (RMS {rms:.5f})')
        check(page.evaluate('__loads===1&&__probe.worklets===1'), 'Repeated playback reuses one PCM upload and one worklet')
        # Directly seeking to the endpoint is not natural completion.
        page.evaluate('turntable.controls.seek(1)'); page.wait_for_function('!turntable.state.seeking'); page.wait_for_timeout(1000)
        check(state()['assistPhase']=='idle' and state()['position']==state()['duration'], 'Seeking to the end never unexpectedly starts a replay')
        play.click(); music(); finish_soon(); cue(); play.click(); page.wait_for_timeout(1200)
        check(state()['transportPaused'] and state()['assistPhase']=='idle', 'Pause cancels an automatic replay without a stale cue callback')
        page.evaluate('turntable.controls.beginDirectScrub(1);turntable.controls.endDirectScrub()'); page.wait_for_timeout(350)
        check(state()['transportPaused'] and state()['assistPhase']=='idle', 'Paused endpoint scrubbing cannot restart playback')
        # Disabling while music is playing restores the ordinary physical run-out.
        play.click(); music(); repeat.click(); finish_soon()
        page.wait_for_function("turntable.state.grooveRegion==='run-out'"); page.wait_for_timeout(1000)
        check(state()['assistPhase']=='idle' and state()['stylusContact'] and play.get_attribute('aria-label')=='Play again', 'Repeat off leaves normal run-out and Play again behavior intact')
        repeat.click(); page.wait_for_timeout(300)
        check(state()['assistPhase']=='idle', 'Enabling repeat at an already-finished record does not start playback by itself')
        # Repeat preserves selected hardware and sound settings at faster speeds.
        for rpm in [45,78]:
            select_speed(page,rpm)
            page.evaluate("turntable.controls.setVolume(.42);turntable.controls.customize('condition','Fair')")
            play.click(); music(); finish_soon(); cue(); music()
            check(state()['rpm']==rpm and state()['volume']==.42 and state()['condition']=='Fair', f'{rpm} RPM replay preserves speed, volume, and condition')
            page.evaluate('turntable.controls.pause()')
            page.evaluate('turntable.controls.seek(1)'); page.wait_for_function('!turntable.state.seeking')
        # Lifecycle cancellation and page-session preference.
        play.click(); music(); finish_soon(); cue()
        page.evaluate('turntable.controls.eject()'); page.wait_for_function("turntable.state.recordPhase==='empty'"); page.wait_for_timeout(1000)
        check(not state()['recordLoaded'] and state()['assistPhase']=='idle' and not state()['platterRunning'], 'Eject during replay cancels preparation and leaves the empty deck stopped')
        check(state()['replayEnabled'] and repeat.is_disabled(), 'The repeat preference survives eject without enabling empty playback')
        load(); check(state()['replayEnabled'] and not repeat.is_disabled() and not state()['platterRunning'], 'Reload retains repeat but waits for Play')
        for width,height,name in [(1440,1300,'desktop'),(900,1000,'tablet'),(390,844,'mobile')]:
            page.set_viewport_size({'width':width,'height':height})
            a,b=play.bounding_box(),repeat.bounding_box()
            check(b['x']>a['x']+a['width'] and abs((a['y']+a['height']/2)-(b['y']+b['height']/2))<2, f'{name}: repeat sits immediately to the right of Play/Pause')
            check(page.evaluate('document.documentElement.scrollWidth<=innerWidth'), f'{name}: transport controls fit without horizontal overflow')
            page.screenshot(path=str(out/f'{name}.png'),full_page=True)
        check(not errors, 'Replay and cancellation produce no browser or audio errors')
        browser.close()
    (out/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
    print(f'All {len(checks)} replay checks passed.')

if __name__ == '__main__':
    run()
