"""Real-browser acceptance tests. Run against `uv run python app.py`."""
import json
import math
import struct
import subprocess
import tempfile
import time
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright
from audio_fixtures import generated_long_record

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
RAW = ROOT / "tests" / "fixtures" / "audio" / "short-record.wav"
checks = []


def check(condition, message, **details):
    assert condition, f"{message}: {details}"
    checks.append({"check": message, **details})
    print(f"PASS {message}", flush=True)


def deck_point(page, x, y):
    """Map deck coordinates through its current viewBox and responsive transform."""
    return tuple(page.locator("#deck").evaluate("""(deck, [x, y]) => {
      const point = new DOMPoint(x, y).matrixTransform(deck.getScreenCTM());
      return [point.x, point.y];
    }""", [x, y]))


def select_speed(page, rpm):
    """Operate the two UI latches, adding before releasing to avoid an idle gap."""
    desired = {"speed33Pressed": rpm in (100 / 3, 78), "speed45Pressed": rpm in (45, 78)}
    for value in (True, False):
        for key, id in [("speed33Pressed", "rpm-33"), ("speed45Pressed", "rpm-45")]:
            actual = page.evaluate("turntable.state")[key]
            if desired[key] == value and actual != value:
                page.locator(f"#{id}").click()


def set_power(page, on):
    page.locator("#power").focus()
    page.keyboard.press("End" if on else "Home")
    page.wait_for_function("on => turntable.state.power === on && !turntable.state.powerSettling", arg=on)


def arm_point(page, geometry, angle):
    angle = math.radians(angle)
    return deck_point(page,
                      geometry["px"] - geometry["length"] * math.sin(angle),
                      geometry["py"] + geometry["length"] * math.cos(angle))


def groove_angle(geometry, fraction):
    radius = geometry["outer"] - fraction * (geometry["outer"] - geometry["inner"])
    dx, dy = geometry["px"] - geometry["cx"], geometry["cy"] - geometry["py"]
    distance, length = math.hypot(dx, dy), geometry["length"]
    cosine = (distance**2 + length**2 - radius**2) / (2 * distance * length)
    angle = math.atan2(dx, dy) - math.acos(max(-1, min(1, cosine)))
    return math.degrees(angle)


PROBE = """(() => {
  window.__probe = {active: 0, max: 0, starts: 0, analyser: null};
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(destination, ...args) {
    const result = connect.call(this, destination, ...args);
    if (destination instanceof AudioDestinationNode) {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 2048;
      connect.call(this, analyser);
      window.__probe.analyser = analyser;
    }
    return result;
  };
  const NativeWorklet = AudioWorkletNode;
  window.__probe.worklets = 0;
  window.AudioWorkletNode = class extends NativeWorklet {
    constructor(...args) { super(...args); window.__probe.worklets++; }
  };
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function(...args) {
    this.__counted = true;
    window.__probe.active++;
    window.__probe.starts++;
    window.__probe.max = Math.max(window.__probe.max, window.__probe.active);
    this.addEventListener('ended', () => {if(this.__counted) {this.__counted = false; window.__probe.active--;}});
    return start.apply(this, args);
  };
  AudioBufferSourceNode.prototype.stop = function(...args) {
    if(this.__counted) {this.__counted = false; window.__probe.active--;}
    return stop.apply(this, args);
  };
})();"""


def run():
    ARTIFACTS.mkdir(exist_ok=True)
    with generated_long_record() as long_record, sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1150}, device_scale_factor=1)
        page.add_init_script(PROBE)
        errors, failures, requests = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("response", lambda response: failures.append(f"{response.status} {response.url}") if response.status >= 400 else None)
        page.on("request", lambda request: requests.append((request.method, request.url)))
        response = page.goto("http://127.0.0.1:42069")
        page.wait_for_function("window.turntable !== undefined")
        check(response.status == 200, "Local page and static resources load")
        state = lambda: page.evaluate("window.turntable.state")
        probe = lambda: page.evaluate("({active: turntable.metrics.activeSources, max: __probe.worklets, starts: __probe.starts})")
        rms = lambda: page.evaluate("""() => {
          const a = __probe.analyser; if (!a) return 0;
          const data = new Float32Array(a.fftSize); a.getFloatTimeDomainData(data);
          return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        }""")
        def click(id):
            page.locator(f"#{id}").click()
            if id == "eject":
                page.wait_for_function("turntable.state.recordPhase === 'empty'")
            if id == "start-stop" and not state()["platterRunning"]:
                # The audio thread acknowledges commands on a rendering boundary.
                page.wait_for_function("turntable.state.actualRate === 0 && turntable.state.motorActualRate === 0")

        def load(path):
            page.locator("#file-input").set_input_files(path)
            page.wait_for_function("name => turntable.state.recordPhase === 'ready' && turntable.state.filename === name", arg=path.name, timeout=90000)

        def seek(fraction):
            # Cue explicitly; dragging no longer changes the lever automatically.
            if not state()["stylusRaised"]:
                click("cue")
            s = state()
            g = page.evaluate("turntable.geometry")
            page.mouse.move(*arm_point(page, g, s["tonearmAngle"]))
            page.mouse.down()
            page.mouse.move(*arm_point(page, g, groove_angle(g, fraction)), steps=8)
            page.mouse.up()
            s = state()
            check(s["stylusRaised"] and not s["dragging"], f"Dragging preserves explicitly raised cue at {fraction:.0%}")
            check(abs(s["position"] - s["duration"] * fraction) < 0.05, f"Radial seek maps to {fraction:.0%}", position=s["position"])
            return s

        def pitch(value):
            page.locator("#pitch").evaluate("(el, value) => {el.value=value; el.dispatchEvent(new Event('input',{bubbles:true}));}", value)

        check(not state()["recordLoaded"] and not state()["platterRunning"], "Initial platter is empty and stopped")
        page.screenshot(path=ARTIFACTS / "empty-desktop.png", full_page=True)
        select_speed(page, 100 / 3)
        load(RAW)
        with wave.open(str(RAW)) as wav:
            raw_duration = wav.getnframes() / wav.getframerate()
        check(abs(state()["duration"] - raw_duration) < .002, "Short fixture decodes at its full duration", seconds=state()["duration"])
        check(page.locator("#record").is_visible(), "Loaded vinyl appears")
        click("start-stop")
        initial = state()["rotation"]
        page.wait_for_timeout(350)
        check(state()["rotation"] != initial and probe()["active"] == 0, "Platter rotates silently with arm on rest")
        seek(.35)
        click("cue")
        page.wait_for_timeout(450)
        check(probe()["active"] == 1 and state()["position"] > raw_duration * .35 + .25, "Lowering stylus starts one advancing audio source")
        check(rms() > .0001, "Short fixture produces a real nonzero Web Audio signal", rms=rms())
        click("start-stop")
        stopped = state()
        page.wait_for_timeout(250)
        check(abs(state()["position"] - stopped["position"]) < .001 and state()["rotation"] == stopped["rotation"] and probe()["active"] == 0, "STOP freezes sound, groove position and platter")
        click("start-stop")
        page.wait_for_timeout(150)
        check(probe()["active"] == 1, "START resumes from the same groove")
        for fraction in [.2, .55, .1, .65, .3, .5]:
            seek(fraction)
            check(probe()["active"] == 0, "Seeking mutes the raised stylus")
            click("cue")
            page.wait_for_timeout(70)
            check(probe()["active"] == 1, "Repeated seek resumes one source")
        click("quartz")
        pitch(8)
        check(abs(state()["effectiveRate"] - 1.08) < 1e-8, "Pitch +8% changes audio/platter rate")
        click("pitch-range")
        pitch(-16)
        check(abs(state()["effectiveRate"] - .84) < 1e-8, "Pitch -16% range works")
        select_speed(page, 45)
        check(abs(state()["effectiveRate"] - 1.35 * .84) < 1e-8, "45 RPM combines with pitch")
        click("quartz")
        check(abs(state()["effectiveRate"] - 1.35) < 1e-8 and state()["pitch"] == -16, "Quartz bypasses slider without losing its setting")
        select_speed(page, 78)
        check(abs(state()["effectiveRate"] - 2.34) < 1e-8, "78 RPM uses reference speed ratio")
        select_speed(page, 100 / 3)
        check(probe()["max"] == 1, "Repeated short-fixture operations keep one audio processor", **probe())
        set_power(page, False)
        check(not state()["power"] and not state()["platterRunning"] and probe()["active"] == 0, "Power off stops the motor and audio")
        set_power(page, True)
        check(not state()["platterRunning"], "Power on requires a fresh START")
        click("eject")
        check(not state()["recordLoaded"] and state()["stylusRaised"] and state()["position"] == 0, "Eject clears record and returns raised arm")
        load(RAW)
        check(state()["recordLoaded"], "Same record can be loaded again")
        # Test completion independently of UI polling.
        click("start-stop")
        seek(.94)
        click("cue")
        page.wait_for_timeout(550)
        check(probe()["active"] == 0 and state()["position"] == state()["duration"] and state()["platterRunning"], "End of side stops audio but keeps the manual platter spinning")
        click("cue")
        page.locator("#tonearm").focus()
        page.keyboard.press("Home")
        check(state()["position"] < .01 and state()["stylusRaised"], "Keyboard Home returns to first groove with stylus raised")
        click("cue")
        page.wait_for_function("turntable.state.grooveRegion === 'music'")
        check(probe()["active"] == 1, "Record can play again after the run-in")

        load(long_record)
        click("start-stop")
        with wave.open(str(long_record)) as wav:
            long_duration = wav.getnframes() / wav.getframerate()
        check(abs(state()["duration"] - long_duration) < .002, "Long WAV decodes completely", seconds=state()["duration"])
        check(state()["stylusRaised"] and probe()["active"] == 0, "Replacing a playing record safely lifts and parks arm")
        angles = []
        for fraction in [.01, .25, .5, .75, .98]:
            s = seek(fraction)
            angles.append(s["tonearmAngle"])
            click("cue")
            page.wait_for_timeout(220)
            check(probe()["active"] == 1 and state()["position"] > long_duration * fraction + .1, f"Long track plays after {fraction:.0%} seek")
        check(angles == sorted(angles), "Long-track groove positions move progressively inward")
        seek(.25)
        click("cue")
        click("quartz")
        pitch(12)
        select_speed(page, 45)
        page.wait_for_timeout(500)  # Let the intentional RPM glide settle.
        start = state()
        before = time.monotonic()
        page.wait_for_timeout(1600)
        after = state()
        elapsed = time.monotonic() - before
        check(abs(after["position"] - start["position"] - elapsed * 1.512) < .13, "Long-track time stays synchronized at changed pitch/RPM")
        check(after["tonearmAngle"] > start["tonearmAngle"], "Arm advances inward during long-track playback")
        click("quartz")
        select_speed(page, 100 / 3)
        for _ in range(8):
            click("start-stop")
            paused = state()["position"]
            page.wait_for_timeout(45)
            check(abs(state()["position"] - paused) < .001 and probe()["active"] == 0, "Long-track stop preserves playback position")
            click("start-stop")
            page.wait_for_timeout(45)
        page.screenshot(path=ARTIFACTS / "loaded-desktop.png", full_page=True)
        # Sustain playback, checking source count and drift across a full minute.
        start = state()
        before = time.monotonic()
        for i in range(12):
            page.wait_for_timeout(5000)
            s = state()
            drift = abs(s["position"] - start["position"] - (time.monotonic() - before))
            check(drift < .2 and probe()["active"] == 1, f"Long playback remains synchronized at {(i + 1) * 5}s", drift=round(drift, 4))
        check(probe()["max"] == 1, "Long-track operations keep one audio processor", **probe())
        check(page.locator("#elapsed").inner_text() == f'{int(state()["position"])//60:02}:{int(state()["position"])%60:02}', "Displayed elapsed time follows audio clock")

        click("target-light")
        check(page.locator("#light-beam").is_visible(), "Target light responds")
        page.locator("#turntable-details").evaluate("el => el.open = true")
        click("cover-toggle")
        check(page.locator("#dust-cover").is_visible(), "Dust cover responds")
        page.locator("#turntable-details").evaluate("el => el.open = true")
        click("cover-toggle")
        click("arm-rest")
        check(probe()["active"] == 0 and state()["stylusRaised"], "Return arm stops audio without stopping motor")

        # Arbitrary independent uploads, including MP3 and drag-and-drop.
        with tempfile.TemporaryDirectory() as directory:
            wav_path = Path(directory) / "independent-test.wav"
            with wave.open(str(wav_path), "wb") as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(22050)
                wav.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 22050))) for i in range(22050 * 2)))
            load(wav_path)
            check(abs(state()["duration"] - 2) < .002, "Arbitrary mono WAV upload works")
            mp3_path = Path(directory) / "independent-test.mp3"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(wav_path), str(mp3_path)], check=True)
            load(mp3_path)
            click("start-stop")
            check(abs(state()["duration"] - 2) < .15, "Arbitrary MP3 upload decodes")
            seek(.1)
            click("cue")
            page.wait_for_timeout(200)
            check(rms() > .005, "Independent MP3 produces audio")
            # Decode errors leave the existing record intact.
            invalid = Path(directory) / "invalid.wav"
            invalid.write_bytes(b"not audio")
            page.locator("#file-input").set_input_files(invalid)
            page.wait_for_function("!turntable.state.loading")
            check(state()["filename"] == mp3_path.name and "Could not load" in page.locator("#notice").inner_text(), "Corrupt file reports error and preserves existing record")
            wav_bytes = list(wav_path.read_bytes())
            page.evaluate("""bytes => {
              const dt = new DataTransfer();
              dt.items.add(new File([new Uint8Array(bytes)], 'dropped.wav', {type:'audio/wav'}));
              document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop', {dataTransfer:dt,bubbles:true,cancelable:true}));
            }""", wav_bytes)
            page.wait_for_function("turntable.state.filename === 'dropped.wav' && !turntable.state.loading")
            check(state()["recordLoaded"], "Drag-and-drop imports a local audio file")
        check(all(method == "GET" and url.startswith("http://127.0.0.1:42069") for method, url in requests), "All requests stay local; audio is never uploaded", requests=len(requests))
        click("help-open")
        check(page.locator("#help").is_visible(), "Help dialog opens")
        page.keyboard.press("Escape")
        check(not page.locator("#help").is_visible(), "Help dialog closes with Escape")
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=ARTIFACTS / "mobile.png", full_page=True)
        check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile layout has no horizontal overflow")
        seek(.4)
        check(state()["stylusRaised"], "Tonearm pointer geometry works at mobile scale")
        check(not errors and not failures, "No browser errors or failed resource requests", errors=errors, failures=failures)
        browser.close()
    report = {"result": "passed", "checks": checks, "total": len(checks)}
    (ARTIFACTS / "acceptance.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"\nAll {len(checks)} checks passed. Report: artifacts/acceptance.json", flush=True)


if __name__ == "__main__":
    run()
