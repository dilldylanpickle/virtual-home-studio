"""Tempo detection, beat-grid corrections and the Trance Gate in the browser.

Generates a 128 BPM groove (kick, offbeat hats, sustained chord) so gating is audible,
then checks detection, the BPM chip and two-column presets popup, corrections (half and
double time, manual, tap, offset, bar), audible gating through seek and pause, the
per-file analysis cache, and that tempo changes never touch playback speed or pitch.
"""
import json
import math
import random
import struct
import tempfile
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright
from studio_helpers import launch_browser

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'trance-gate'
URL = 'http://127.0.0.1:42069/'
checks = []

# Short-window analyser on the master output (the shared probe's 2048-sample window is
# too long to resolve 16th-note gating).
PROBE = """(() => {
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(destination, ...args) {
    const result = connect.call(this, destination, ...args);
    if (destination instanceof AudioDestinationNode && !window.__gateProbe) {
      const analyser = this.context.createAnalyser(); analyser.fftSize = 256;
      connect.call(this, analyser); window.__gateProbe = analyser;
    }
    return result;
  };
})();"""
LEVELS = """async ms => {
  const a = window.__gateProbe, d = new Float32Array(a.fftSize), out = [], end = performance.now() + ms;
  while (performance.now() < end) {
    a.getFloatTimeDomainData(d); out.push(Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length));
    await new Promise(r => setTimeout(r, 4));
  }
  return out;
}"""


def check(value, description, **details):
    checks.append({'check': description, 'passed': bool(value), **details})
    assert value, f'{description}: {details}'
    print(f'PASS {description}', flush=True)


def groove(path, bpm=128, seconds=40, offset=.25):
    rate, n = 44100, int(44100 * seconds); out = [0.0] * n; random.seed(3); beat = 60 / bpm
    b = 0
    while offset + b * beat < seconds:
        start = int((offset + b * beat) * rate)
        for i in range(int(rate * .2)):
            if start + i >= n: break
            x = i / rate; out[start + i] += .6 * math.sin(2 * math.pi * (45 + 90 * math.exp(-x * 35)) * x) * math.exp(-x * 10)
        hat = int((offset + b * beat + beat / 2) * rate)
        for i in range(int(rate * .03)):
            if hat + i >= n: break
            out[hat + i] += .12 * (random.random() * 2 - 1) * math.exp(-i / rate * 150)
        b += 1
    for i in range(n):
        out[i] += .06 * (math.sin(2 * math.pi * 261.6 * i / rate) + math.sin(2 * math.pi * 329.6 * i / rate) + math.sin(2 * math.pi * 392 * i / rate))
    with wave.open(str(path), 'wb') as w:
        w.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        w.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, int(v * 26000)))) for v in out))


def spread(levels):
    ordered = sorted(levels); return ordered[int(len(ordered) * .1)], ordered[int(len(ordered) * .9)]


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory, sync_playwright() as p:
        track = Path(directory) / 'Groove 128.wav'; groove(track)
        browser = launch_browser(p); context = browser.new_context(viewport={'width': 1600, 'height': 1000})
        context.add_init_script(PROBE)
        page = context.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        state = lambda: page.evaluate('turntable.state')
        page.goto(URL); page.wait_for_function('window.turntable')
        page.evaluate('localStorage.clear()')
        page.locator('#file-input').set_input_files(str(track))
        page.wait_for_function("turntable.state.tempo.status === 'ready'", timeout=30000)
        page.wait_for_function("turntable.state.recordPhase === 'ready'", timeout=20000)
        tempo, grid = state()['tempo'], page.evaluate('turntable.rhythm')
        check(round(tempo['bpm']) == 128 and tempo['confidence'] >= .7 and not tempo['varies'],
              'A loaded record is analyzed offline: 128 BPM, steady, high confidence', bpm=tempo['bpm'], confidence=tempo['confidence'])
        check(abs(grid['beats'][0] - .25) < .006 and all(abs((b - a) - 60 / 128) < 1e-6 for a, b in zip(grid['beats'], grid['beats'][1:])),
              'Detected beats land on the kicks as a straight 128 BPM grid', first=grid['beats'][0])
        chip = page.locator('#tempo-chip')
        check(chip.is_visible() and chip.inner_text() == '128 BPM' and chip.get_attribute('data-level') == 'high',
              'The player shows the detected BPM and a high-confidence indicator', text=chip.inner_text())

        # Two-column presets popup: presets left, tempo and gate right.
        chip.click(); page.wait_for_timeout(350)
        options, panel, presets = page.locator('#preset-options'), page.locator('.rhythm-panel'), page.locator('.preset-list')
        a, b, box = presets.bounding_box(), panel.bounding_box(), options.bounding_box()
        check(options.is_visible() and b['x'] >= a['x'] + a['width'] - 1 and box['x'] >= 0 and box['x'] + box['width'] <= 1600,
              'The BPM chip opens the presets popup with tempo and gate in a right-hand column')
        check(page.locator('#tempo-bpm').inner_text() == '128' and 'High confidence' in page.locator('#tempo-confidence').inner_text(),
              'The tempo column shows a whole-number BPM and its confidence')
        chip.click(); options.wait_for(state='hidden')
        chip.click(); options.wait_for(state='visible')
        check(options.is_visible(), 'Clicking the BPM chip again closes the popup; once more reopens it')
        before = {k: state()[k] for k in ('rpm', 'pitch', 'pitchRange', 'quartzLock')}

        page.locator('#tempo-half').click()
        check(round(state()['tempo']['bpm']) == 64 and abs(page.evaluate('turntable.rhythm.beats[1] - turntable.rhythm.beats[0]') - 60 / 64) < 1e-6, 'Half time recalculates the grid at 64 BPM')
        page.locator('#tempo-double').click(); page.locator('#tempo-double').click()
        check(round(state()['tempo']['bpm']) == 256 and state()['tempo']['multiplier'] == 2, 'Double time from the detected grid gives 256 BPM')
        page.locator('#tempo-manual').fill('100'); page.locator('#tempo-manual').press('Enter')
        check(state()['tempo']['source'] == 'manual' and state()['tempo']['bpm'] == 100
              and abs(page.evaluate('turntable.rhythm.beats[1] - turntable.rhythm.beats[0]') - .6) < 1e-6, 'Manual BPM entry recalculates the gate timing')
        page.locator('#tempo-manual').fill('99.6'); page.locator('#tempo-manual').press('Enter')
        check(state()['tempo']['bpm'] == 100, 'Entered tempos round to whole BPM')
        page.locator('#tempo-auto').click()
        check(state()['tempo']['source'] == 'auto' and round(state()['tempo']['bpm']) == 128, 'Auto restores the detected tempo')
        first = page.evaluate('turntable.rhythm.beats[0]')
        page.locator('#grid-later').click(); page.locator('#grid-later').click()
        check(abs(page.evaluate('turntable.rhythm.beats[0]') - first - .02) < 1e-6 and page.locator('#grid-offset').inner_text() == '+20 ms',
              'The beat-grid offset can be adjusted in 10 ms steps')
        down = page.evaluate('turntable.rhythm.downbeat'); page.locator('#grid-bar').click()
        check(page.evaluate('turntable.rhythm.downbeat') == (down + 1) % 4, 'Bar shift moves the downbeat by one beat')
        page.locator('#grid-earlier').click(); page.locator('#grid-earlier').click()

        # Tap tempo with the T key while stopped: wall-time taps at 120 BPM.
        page.keyboard.press('Escape'); page.locator('#track-name').click()
        for _ in range(4):
            page.keyboard.press('t'); page.wait_for_timeout(500)
        tapped = state()['tempo']
        check(tapped['source'] == 'tap' and abs(tapped['bpm'] - 120) <= 2, 'Tap tempo (T) sets the BPM from your taps', bpm=tapped['bpm'])
        page.evaluate('turntable.controls.useDetectedTempo()')
        check({k: state()[k] for k in before} == before, 'Tempo corrections never change playback speed or pitch')

        # Audible gating: the master output pulses with the gate on and is steady with it off.
        page.evaluate('turntable.controls.play()')
        page.wait_for_function('turntable.state.stylusContact && !turntable.state.stylusRaised && turntable.state.position > 1.5', timeout=20000)
        page.wait_for_timeout(300)
        dry = spread(page.evaluate(LEVELS, 1500))
        page.keyboard.press('g'); page.wait_for_timeout(150)
        check(state()['gate']['enabled'], 'G toggles the Trance Gate')
        defaults = spread(page.evaluate(LEVELS, 1500)); print('default gate levels', defaults, 'dry', dry, flush=True)
        page.evaluate("turntable.controls.setGate({ pattern: 'Straight', depth: 1, length: .5, rate: '1/16' })")
        gated = spread(page.evaluate(LEVELS, 1500))
        check(gated[0] < dry[0] * .35 and gated[1] > dry[1] * .5,
              'With the gate on the music pulses on and off; off it stays steady', dry=dry, gated=gated)
        page.evaluate('turntable.controls.seek(.55)'); page.wait_for_timeout(700)
        after_seek = spread(page.evaluate(LEVELS, 1200))
        check(after_seek[0] < dry[0] * .35 and state()['position'] > 20, 'Gating continues after seeking', levels=after_seek)
        page.evaluate('turntable.controls.pause()'); page.wait_for_timeout(600)
        page.evaluate('turntable.controls.play()'); page.wait_for_timeout(900)
        resumed = spread(page.evaluate(LEVELS, 1200))
        check(resumed[0] < dry[0] * .35, 'Gating continues after pause and resume', levels=resumed)
        page.keyboard.press('g'); page.wait_for_timeout(200)
        open_again = spread(page.evaluate(LEVELS, 1200))
        check(open_again[0] > dry[0] * .6, 'Turning the gate off restores the steady signal', levels=open_again)
        page.screenshot(path=str(OUT / 'popup.png'))

        # Cache: the same file loads without a second analysis, keeping your corrections.
        page.evaluate('turntable.controls.setManualBpm(126)')
        page.reload(); page.wait_for_function('window.turntable')
        page.locator('#file-input').set_input_files(str(track))
        page.wait_for_function("turntable.state.tempo.status === 'ready'", timeout=10000)
        check(page.evaluate('turntable.rhythm.analyses') == 0 and state()['tempo']['source'] == 'manual' and state()['tempo']['bpm'] == 126,
              'Reloading the same file reuses the cached analysis and your tempo correction')
        # A cached grid must reach the worklet: the gate is audible on a cached load too.
        page.wait_for_function("turntable.state.recordPhase === 'ready'", timeout=20000)
        page.evaluate('turntable.controls.useDetectedTempo()')
        page.evaluate('turntable.controls.play()')
        page.wait_for_function('turntable.state.stylusContact && !turntable.state.stylusRaised && turntable.state.position > 1.5', timeout=20000)
        cached_dry = spread(page.evaluate(LEVELS, 1200))
        page.evaluate("turntable.controls.setGate({ enabled: true, shape: 'chop', pattern: 'Straight', depth: 1, length: .5, rate: '1/16' })")
        cached_gated = spread(page.evaluate(LEVELS, 1200))
        check(cached_gated[0] < cached_dry[0] * .35, 'The gate is audible on a cached (repeat) load too', dry=cached_dry, gated=cached_gated)
        # 1/8 pump: the offbeat ducks fall on the sustained chord (the on-beat ones under the kick).
        page.evaluate("turntable.controls.setGate({ shape: 'pump', rate: '1/8', length: .8 })")
        pumped = spread(page.evaluate(LEVELS, 2000))
        check(pumped[0] < cached_dry[0] * .35 and page.locator('#gate-length-label').inner_text() == 'Swell',
              'Pump shape ducks and swells on the beat', levels=pumped)
        check(not errors, 'No browser errors', errors=errors)
        browser.close()
    (OUT / 'checks.json').write_text(json.dumps({'total': len(checks), 'checks': checks}, indent=2) + '\n')
    print(f'All {len(checks)} trance gate checks passed.')


if __name__ == '__main__':
    run()
