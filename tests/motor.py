"""Measure an actual output pitch glide, plus browser audio/visual synchronization."""
import json
import math
import struct
import tempfile
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright
from acceptance import PROBE, select_speed

ROOT = Path(__file__).resolve().parents[1]


def run():
    (ROOT / "artifacts").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as directory, sync_playwright() as p:
        fixture = Path(directory) / "motor-test.wav"
        with wave.open(str(fixture), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            wav.writeframes(b''.join(struct.pack('<h', int(12000 * math.sin(i * 2 * math.pi * 440 / 48000))) for i in range(48000 * 12)))
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 1100})
        page.add_init_script(PROBE)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:42069')
        page.locator('#file-input').set_input_files(fixture)
        page.wait_for_function('turntable.state.recordLoaded')
        select_speed(page, 100 / 3)
        page.locator('#start-stop').click()
        page.locator('#tonearm').focus()
        page.keyboard.press('Home')
        page.locator('#cue').click()
        page.wait_for_function("turntable.state.grooveRegion === 'music' && turntable.state.position > .15 && !turntable.state.motorRamping")

        def sample():
            return page.evaluate("""() => {
              const a = __probe.analyser;
              const pcm = new Float32Array(a.fftSize);
              a.getFloatTimeDomainData(pcm);
              const crossings = [];
              for (let i = 1; i < pcm.length; i++) if (pcm[i-1] <= 0 && pcm[i] > 0) crossings.push(i);
              const hz = crossings.length > 1 ? (crossings.length - 1) * a.context.sampleRate / (crossings.at(-1) - crossings[0]) : 0;
              return {...turntable.state, hz};
            }""")

        page.locator('#turntable-details summary').click()
        baseline = sample()
        assert abs(baseline['hz'] - 440) < 5, baseline
        records = []
        for button, expected in [('rpm-45', 2.34), ('rpm-33', 1.35), ('rpm-33', 2.34), ('rpm-45', 1)]:
            before = sample()
            page.locator(f'#{button}').click()
            samples = []
            for _ in range(3):
                page.wait_for_timeout(75)
                samples.append(sample())
            rates = [s['actualRate'] for s in samples]
            hz = [s['hz'] for s in samples]
            ascending = expected > before['actualRate']
            assert rates == sorted(rates, reverse=not ascending), rates
            assert hz == sorted(hz, reverse=not ascending), hz
            assert all(min(before['actualRate'], expected) < rate < max(before['actualRate'], expected) for rate in rates), rates
            assert all(abs(s['motorActualRate'] - s['actualRate']) < .0001 for s in samples)
            assert '→' in page.locator('#speed-readout').inner_text()
            for s in samples:
                audio_degrees = (s['position'] - before['position']) * 200
                vinyl_degrees = s['recordRotation'] - before['recordRotation']
                platter_degrees = (s['rotation'] - before['rotation']) % 360
                assert abs(vinyl_degrees - audio_degrees) < .05, (vinyl_degrees, audio_degrees)
                assert abs(platter_degrees - vinyl_degrees % 360) < .05, (platter_degrees, vinyl_degrees)
            page.wait_for_timeout(300)
            after = sample()
            assert abs(after['actualRate'] - expected) < .0001
            assert abs(after['hz'] - 440 * expected) < 5, after
            records.append({'selection': button, 'intermediate_rates': rates, 'measured_hz': hz, 'final_hz': after['hz']})
            print(f'PASS {button}: measured output frequencies {hz}, final {after["hz"]:.1f} Hz', flush=True)
        assert not errors, errors
        assert page.evaluate('__probe.worklets === 1 && __probe.starts === 0')
        browser.close()
    (ROOT / 'artifacts/motor.json').write_text(json.dumps({'result': 'passed', 'transitions': records}, indent=2) + '\n')
    print('PASS RPM browser: audible upward/downward pitch glide, 33/45/78 endpoints, synchronized PCM/vinyl/platter travel, live RPM readout, one processor, no errors.')


if __name__ == '__main__':
    run()
