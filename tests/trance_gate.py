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
    # Sustained chords so gating is audible: C–F–G–C, one bar each, so the key is C major.
    chords = [(261.6, 329.6, 392.0), (349.2, 440.0, 523.3), (392.0, 493.9, 587.3), (261.6, 329.6, 392.0)]
    for i in range(n):
        chord = chords[int((i / rate - offset) / (4 * beat)) % 4] if i / rate >= offset else chords[0]
        out[i] += .06 * sum(math.sin(2 * math.pi * f * i / rate) for f in chord)
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
        check(page.locator('#tempo-half').is_hidden() and page.locator('.reverb-section .coming-soon').is_visible(),
              'Tempo shows just the BPM and Tap; fixes sit in Adjust; Reverb is marked coming soon')

        # Styles set the whole gate; editing one setting makes it Custom; triplets use 12 steps.
        page.locator('#gate-style').select_option('Gallop')
        gate = state()['gate']
        check(gate['rate'] == '1/8T' and gate['shape'] == 'chop' and page.locator('.gate-step.unused').count() == 4,
              'A gate style sets shape, rate, depth, length and steps together (Gallop: 1/8 triplets, 12 steps)')
        page.locator('#gate-style').select_option('Push')
        page.evaluate("turntable.controls.setGate({ depth: .4 })")
        check(page.locator('#gate-style').input_value() == 'Custom', 'Changing a setting after a style makes it Custom')
        page.locator('#gate-style').select_option('Push')

        page.locator('#tempo-adjust summary').click()
        page.locator('#tempo-half').click()
        check(round(state()['tempo']['bpm']) == 64 and abs(page.evaluate('turntable.rhythm.beats[1] - turntable.rhythm.beats[0]') - 60 / 64) < 1e-6, 'Half time recalculates the grid at 64 BPM')
        page.locator('#tempo-double').click(); page.locator('#tempo-double').click()
        check(round(state()['tempo']['bpm']) == 256 and state()['tempo']['multiplier'] == 2, 'Double time from the detected grid gives 256 BPM')
        page.locator('#tempo-half').click()
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

        # The shown tempo follows playback speed; the song's beat grid does not change.
        grid_before = page.evaluate('turntable.rhythm.beats.slice(0, 4)')
        page.evaluate("turntable.controls.applyPreset('sped-up-pitched-up')")
        page.wait_for_function('!turntable.state.presetMotion', timeout=10000)
        check(page.locator('#tempo-bpm').inner_text() == str(round(128 * 45 / (100 / 3))) and 'Song is 128 BPM' in page.locator('#tempo-source').inner_text()
              and page.evaluate('turntable.rhythm.beats.slice(0, 4)') == grid_before,
              'At 45 RPM the shown tempo rises with the record while the beat grid stays on the song', shown=page.locator('#tempo-bpm').inner_text())
        page.evaluate("turntable.controls.applyPreset('original')"); page.wait_for_function('!turntable.state.presetMotion', timeout=10000)

        # Audible gating: the master output pulses with the gate on and is steady with it off.
        page.evaluate('turntable.controls.play()')
        page.wait_for_function('turntable.state.stylusContact && !turntable.state.stylusRaised && turntable.state.position > 1.5', timeout=20000)
        page.wait_for_timeout(300)
        dry = spread(page.evaluate(LEVELS, 1500))
        page.keyboard.press('g'); page.wait_for_timeout(150)
        check(state()['gate']['enabled'], 'G toggles the Trance Gate')
        defaults = spread(page.evaluate(LEVELS, 1500)); print('default gate levels', defaults, 'dry', dry, flush=True)
        page.evaluate("turntable.controls.setGate({ shape: 'chop', pattern: 'Straight', depth: 1, length: .5, rate: '1/16', highs: 1 })")
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

        # Hardstyle: the key is detected (C–F–G–C), the kick is tuned to its root and fires on
        # the beat in the engine while the record plays.
        page.locator('#tempo-chip').click(); options.wait_for(state='visible')
        key = state()['tempo']['key']
        check(key['tonic'] == 0 and key['mode'] == 'major' and page.locator('#kick-tune option').first.inner_text() == 'Auto · C',
              'The song key is detected and the hardstyle kick tunes to its root (C)', key=key)
        fired = page.evaluate('turntable.audioDiagnostics.kick?.fired ?? 0')
        page.locator('#kick-enabled').check(); page.wait_for_timeout(2000)
        kicks = page.evaluate('turntable.audioDiagnostics.kick.fired') - fired
        check(state()['kick']['enabled'] and 3 <= kicks <= 5, 'Hardstyle mode slams a kick on every beat (128 BPM ≈ 4 in 2 s)', kicks=kicks)
        # Kick lanes: presets fill the shown bar; clicking a step edits it (Custom).
        # Two seconds: Roll's bar 8 leaves a four-sixteenth gap before the phrase restarts.
        page.locator('#kick-pattern').select_option('Roll'); fired = page.evaluate('turntable.audioDiagnostics.kick.fired'); page.wait_for_timeout(2000)
        rolled = page.evaluate('turntable.audioDiagnostics.kick.fired') - fired
        check(page.locator('#kick-steps .kick-step[aria-pressed=true]').count() == 16 and rolled >= 11,
              'The Roll preset fills the kick bar and fires sixteenths (≈8 per second at 128 BPM)', kicks=rolled)
        page.locator('#kick-pattern').select_option('Build'); page.locator('#kick-steps .kick-step').nth(1).click()
        check(state()['kick']['steps'][1] and page.locator('#kick-pattern').input_value() == 'Custom', 'Clicking a kick-bar step adds a kick and makes the pattern Custom')
        # Kit and drops: Classic adds claps and offbeat hats; Drop it! builds, pauses and lands with a crash.
        # Kick sounds: each school can be picked; it reaches the model (and so the engine).
        for value in ('raw', 'techno', 'gabber', 'euphoric'):
            page.locator('#kick-sound').select_option(value)
        check(state()['kick']['sound'] == 'euphoric' and page.locator('#kick-sound option').count() == 4,
              'The kick Sound picker offers Euphoric, Rawstyle, Techno drive and Gabber')
        page.locator('#kick-pattern').select_option('Classic'); page.locator('#kick-horn').check()
        before = page.evaluate('turntable.audioDiagnostics.kick'); page.wait_for_timeout(1900)
        after = page.evaluate('turntable.audioDiagnostics.kick')
        check(after['claps'] - before['claps'] >= 1 and after['hats'] - before['hats'] >= 3, 'The Classic kit plays claps on 2 and 4 and open hats on the offbeats', claps=after['claps'] - before['claps'], hats=after['hats'] - before['hats'])
        page.locator('#drop-now').click(); page.wait_for_timeout(4200)
        dropped = page.evaluate('turntable.audioDiagnostics.kick')
        check(dropped['drops'] - after['drops'] == 1 and dropped['crashes'] > after['crashes'] and dropped['horns'] > after['horns'],
              'Drop it! builds, pauses and lands with a crash and the air horn', kick=dropped)
        # 8-bar phrases: the bar buttons show one bar at a time; Classic's bar 8 is a fill.
        bars = page.locator('#kit-bars .kit-bar')
        bars.nth(7).click()
        fill = page.locator('#kick-steps .kick-step[aria-pressed=true]').count()
        check(bars.count() == 8 and fill == 8 and bars.nth(7).get_attribute('aria-pressed') == 'true' and 'fill' in bars.nth(7).get_attribute('class'),
              'Hardstyle patterns span 8 bars: bar 8 of Classic shows its kick fill', kicks=fill)
        page.locator('#kick-steps .kick-step').nth(2).click()
        kick = state()['kick']
        check(len(kick['steps']) == 128 and kick['steps'][7 * 16 + 2] and not kick['steps'][2], 'Editing a step in bar 8 changes only bar 8')
        page.locator('#kit-copy').click(); kick = state()['kick']
        check(all(kick['steps'][i] == kick['steps'][7 * 16 + i % 16] for i in range(128)) and not any('fill' in bars.nth(i).get_attribute('class') for i in range(8)),
              'Copy to all repeats the shown bar across the phrase')
        bars.nth(0).click(); page.locator('#kick-pattern').select_option('Classic')
        page.locator('#kick-enabled').uncheck()

        # Pixel Cat: the song's chords (C–F–G–C) reach the engine; the band plays on the beat.
        diag = page.evaluate('turntable.audioDiagnostics.cat')
        check(diag and diag['chords'] >= 3, "The song's chords reach the engine for Pixel Cat (C–F–G–C)", cat=diag)
        page.locator('#cat-enabled').check(); before = page.evaluate('turntable.audioDiagnostics.cat'); page.wait_for_timeout(1500)
        after = page.evaluate('turntable.audioDiagnostics.cat')
        check(state()['cat']['enabled'] and after['notes'] - before['notes'] >= 6 and after['bassNotes'] > before['bassNotes'] and after['meows'] > before['meows'],
              'Pixel Cat plays a chiptune melody, bass and nya vocals on the beat', before=before, after=after)
        page.locator('#cat-pattern').select_option('Sparkle'); page.locator('#cat-meow').uncheck()
        page.evaluate("turntable.controls.setCat({ crunch: 1, volume: .4 })")
        cat = state()['cat']
        check(cat['pattern'] == 'Sparkle' and not cat['meow'] and cat['crunch'] == 1 and page.locator('#cat-crunch-value').inner_text() == '100%',
              'Melody, nya vocals, band level and 8-bit crunch reach the model and the panel', cat=cat)
        page.screenshot(path=str(OUT / 'pixel-cat.png'))
        page.locator('#cat-enabled').uncheck(); page.keyboard.press('Escape')

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
        page.evaluate("turntable.controls.setGate({ enabled: true, shape: 'chop', pattern: 'Straight', depth: 1, length: .5, rate: '1/16', highs: 1 })")
        cached_gated = spread(page.evaluate(LEVELS, 1200))
        check(cached_gated[0] < cached_dry[0] * .35, 'The gate is audible on a cached (repeat) load too', dry=cached_dry, gated=cached_gated)
        # 1/8 pump: the offbeat ducks fall on the sustained chord (the on-beat ones under the kick).
        page.evaluate("turntable.controls.setGate({ shape: 'pump', rate: '1/8', length: .8 })")
        pumped = spread(page.evaluate(LEVELS, 2000))
        # Pumps keep the kick attack and add make-up gain, so they dip less deeply than a chop.
        check(pumped[0] < cached_dry[0] * .6 and page.locator('#gate-length-label').inner_text() == 'Swell',
              'Pump shape ducks and swells on the beat', levels=pumped)
        check(not errors, 'No browser errors', errors=errors)
        browser.close()
    (OUT / 'checks.json').write_text(json.dumps({'total': len(checks), 'checks': checks}, indent=2) + '\n')
    print(f'All {len(checks)} trance gate checks passed.')


if __name__ == '__main__':
    run()
