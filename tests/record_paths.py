"""Real file chooser, cancellation, replacement and drop lifecycle invariants."""
import base64
import json
import math
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright
from acceptance import ROOT, PROBE

checks = []


def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)


def run():
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as directory, sync_playwright() as p:
        files = []
        for name, seconds, frequency in [('record-a', 24, 440), ('record-b', 27, 880)]:
            path = Path(directory) / (name + '.wav')
            second = b''.join(struct.pack('<h', round(8500 * math.sin(i * 2 * math.pi * frequency / 24000))) for i in range(24000))
            with wave.open(str(path), 'wb') as wav:
                wav.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                wav.writeframes(second * seconds)
            files.append(path)
        mp3 = Path(directory) / 'record-c.mp3'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(files[1]), str(mp3)], check=True)
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1250})
        page.add_init_script(PROBE)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        state = lambda: page.evaluate('turntable.state')
        phase = lambda value: page.wait_for_function('value => turntable.state.recordPhase === value', arg=value)
        page.evaluate('''() => {
          window.phases = [];
          turntable.controls.subscribe(s => {
            if (phases.at(-1) !== s.recordPhase) phases.push(s.recordPhase);
          });
        }''')

        def picker():
            with page.expect_file_chooser(timeout=1500) as chooser:
                page.locator('#load').click()
                page.locator('#source-local').click()
            return chooser.value

        def settled(path, duration):
            phase('ready')
            s = state()
            check(s['recordLoaded'] and s['filename'] == path.name and abs(s['duration'] - duration) < .2 and not s['pendingFilename'],
                  f'{path.name} metadata becomes active after settling')
            check(s['stylusRaised'] and not s['platterRunning'] and not s['scratching'] and s['position'] == 0,
                  'Newly seated record is safely parked with no old playback')
            check(page.locator('#transport').is_enabled(), 'Assisted Play is available after insertion')

        def insertion(path):
            phase('inserting')
            s = state()
            check(s['recordPresent'] and not s['recordLoaded'] and not s['filename'] and s['duration'] == 0 and s['pendingFilename'] == path.name,
                  'Insertion stages the new title without activating playback metadata')
            check(page.locator('#track-name').inner_text() == 'Seating your record' and page.locator('#transport').is_disabled(),
                  'HUD waits for physical seating before exposing the next record')
            check(page.locator('#record-lift').evaluate('el => el.getAnimations().some(a => a.playState === "running")'),
                  'Every selected or dropped record uses the animated insertion')

        def drop(path):
            page.evaluate('''({name, encoded}) => {
              const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
              const transfer = new DataTransfer();
              transfer.items.add(new File([bytes], name, {type: name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'}));
              document.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
            }''', {'name': path.name, 'encoded': base64.b64encode(path.read_bytes()).decode()})

        choice = picker()
        check(state()['recordPhase'] == 'empty' and not state()['recordPresent'], 'Choose opens the native picker while preserving the empty platter')
        choice.set_files(files[0]); insertion(files[0]); settled(files[0], 24)
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase === 'idle' && turntable.state.position > .2")
        before = state(); choice = picker(); after = state()
        invariants = ['recordPhase', 'filename', 'duration', 'stylusRaised', 'platterRunning', 'transportPaused', 'speed33Pressed', 'speed45Pressed', 'pitch', 'quartzLock', 'condition', 'volume']
        check(all(before[key] == after[key] for key in invariants) and after['position'] >= before['position'],
              'Replace opens immediately and current music keeps playing before selection')
        choice.set_files([])
        page.wait_for_timeout(140); after = state()
        check(all(before[key] == after[key] for key in invariants) and after['position'] > before['position'],
              'Canceling Replace leaves the playing record and every physical setting unchanged')
        level = page.evaluate('''() => { const a=__probe.analyser, d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return Math.sqrt(d.reduce((s,x)=>s+x*x,0)/d.length); }''')
        check(level > .01, 'Playback remains audible after canceled replacement')
        page.locator('#transport').click();page.wait_for_function("turntable.state.transportState === 'paused'")
        before = state(); choice = picker(); choice.set_files([]);page.wait_for_timeout(100);after = state()
        check(all(before[key] == after[key] for key in invariants) and before['position'] == after['position'] and before['tonearmAngle'] == after['tonearmAngle'],
              'Canceling Replace preserves the exact paused groove and tonearm')
        page.evaluate('phases=[]')
        choice = picker()
        check(state()['filename'] == files[0].name and state()['recordPhase'] == 'ready', 'Replacement preserves Record A until a file is selected')
        choice.set_files(files[1]);insertion(files[1]);settled(files[1], 27)
        check(page.evaluate("JSON.stringify(phases.filter((phase, i) => i || phase!=='ready'))===JSON.stringify(['loading','ejecting','inserting','ready'])"),
              'Valid replacement serializes loading, old-record ejection, new-record insertion, and readiness')
        choice=picker();choice.set_files(files[1]);insertion(files[1]);settled(files[1],27)
        check(page.locator('#file-input').input_value() == '', 'Cleared file input permits the identical file to be selected again')
        page.locator('#eject').click();phase('empty')
        check(not state()['filename'] and not state()['pendingFilename'] and not state()['recordPresent'], 'Eject removes active and staged metadata')
        drop(files[0]);insertion(files[0]);settled(files[0],24)
        page.evaluate('phases=[]')
        drop(mp3);insertion(mp3);settled(mp3,27)
        check(page.evaluate("JSON.stringify(phases.filter((phase, i) => i || phase!=='ready'))===JSON.stringify(['loading','ejecting','inserting','ready'])"),
              'MP3 drag/drop uses the same replacement lifecycle as WAV file selection')
        page.locator('#transport').click();page.wait_for_function("turntable.state.assistPhase==='idle' && turntable.state.position>.2")
        check(state()['stylusContact'] and state()['platterRunning'], 'Assisted playback starts the newly dropped record')
        check(page.evaluate('__probe.worklets===1 && __probe.starts===0'), 'Every picker and drop path shares one persistent audio processor')
        check(not errors, 'No browser exceptions across picker, cancellation, replacement and drop')
        browser.close()
    (ROOT / 'artifacts/record-paths.json').write_text(json.dumps({'result': 'passed', 'total': len(checks), 'checks': checks}, indent=2) + '\n')
    print(f'All {len(checks)} record path checks passed.', flush=True)


if __name__ == '__main__':
    run()
