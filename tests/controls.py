"""Rotary power gestures and loaded-record speed-latch integration, port 42069."""
import json
import math
import struct
import tempfile
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright
from audio_assertions import wait_for_silence

from acceptance import PROBE, ROOT, deck_point, select_speed, set_power

checks = []


def check(condition, message):
    assert condition, message
    checks.append(message)
    print(f"PASS {message}", flush=True)


def run():
    (ROOT / "artifacts").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        fixture = Path(tmp) / "control-tone.wav"
        with wave.open(str(fixture), "wb") as wav:
            wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            wav.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 24000))) for i in range(24000 * 12)))
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1440, "height": 1250}, has_touch=True)
        page = context.new_page()
        page.add_init_script(PROBE)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("http://127.0.0.1:42069")
        page.wait_for_function("window.turntable")
        state = lambda: page.evaluate("turntable.state")
        click = lambda name: page.locator(f"#{name}").click()
        rms = lambda: page.evaluate("""() => {
          const a=__probe.analyser; if(!a) return 0;
          const data=new Float32Array(a.fftSize); a.getFloatTimeDomainData(data);
          return Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length);
        }""")

        def knob_point(angle, radius=23):
            return deck_point(page, 149 + radius * math.cos(math.radians(angle)), 837 + radius * math.sin(math.radians(angle)))

        def begin(angle=0):
            page.mouse.move(*knob_point(angle))
            page.mouse.down()

        def move(angle):
            page.mouse.move(*knob_point(angle), steps=4)

        def settled(angle):
            page.wait_for_function("a=>!turntable.state.powerDragging && !turntable.state.powerSettling && Math.abs(turntable.state.powerAngle-a)<.01", arg=angle)

        select_speed(page, 100 / 3)
        click("start-stop")
        begin()
        check(state()["powerAngle"] == 0 and state()["power"], "Grabbing POWER does not toggle or jump its angle")
        for angle in [-12, -24, -36]:
            move(angle)
            s = state()
            displayed = float(page.locator("#power-rotor").get_attribute("transform").split("(")[1].split()[0])
            check(abs(s["powerAngle"] - angle) < 1 and abs(displayed - s["powerAngle"]) < .01 and s["power"],
                  f"POWER follows the pointer continuously at {angle} degrees")
        move(-56)
        check(not state()["power"] and not state()["platterRunning"], "Crossing the OFF detent switches power and stops the running motor during drag")
        move(-46)
        check(not state()["power"], "Small movements around the switch point do not chatter power")
        move(-39)
        check(state()["power"] and not state()["platterRunning"], "Returning across ON restores power without restarting the motor")
        page.mouse.up()
        settled(0)
        check(state()["power"], "Release gently settles at the ON endpoint")

        begin()
        move(-120)
        check(state()["powerAngle"] == -90, "Counterclockwise travel clamps at the OFF endpoint")
        move(-115)
        check(-87 < state()["powerAngle"] < -83, "Reversing at a hard stop responds immediately without accumulated travel")
        page.mouse.up()
        settled(-90)
        begin(170)
        move(-170)
        check(-72 < state()["powerAngle"] < -68, "Dragging across the pointer-angle seam has no rotational jump")
        move(-60)
        check(state()["powerAngle"] == 0 and state()["power"], "Clockwise travel clamps at ON")
        page.mouse.up()
        settled(0)

        for event in ["pointercancel", "lostpointercapture", "blur"]:
            begin()
            move(-58)
            if event == "blur":
                page.evaluate("window.dispatchEvent(new Event('blur'))")
            else:
                page.locator("#power").evaluate("(el,type)=>el.dispatchEvent(new PointerEvent(type,{pointerId:1}))", event)
            page.mouse.up()
            settled(-90)
            check(not state()["powerDragging"], f"POWER releases cleanly after {event}")
            set_power(page, True)

        # Starting at the exact center still permits an intuitive upward/right drag.
        set_power(page, False)
        page.mouse.move(*deck_point(page, 149, 837))
        page.mouse.down()
        page.mouse.move(*deck_point(page, 180, 806), steps=5)
        check(-42 < state()["powerAngle"] < -38 and state()["power"], "Center-grab fallback rotates the knob without an angular singularity")
        page.mouse.up()
        settled(0)
        page.locator("#power").focus()
        page.keyboard.press("ArrowLeft")
        check(state()["powerAngle"] == -5, "Keyboard arrow makes a fine rotary adjustment")
        page.keyboard.press("Home")
        settled(-90)
        check(page.locator("#power").get_attribute("aria-valuenow") == "0.0", "Accessible rotary value reaches OFF")

        # Real touch events also follow the quarter-turn, rather than toggling on tap.
        session = context.new_cdp_session(page)
        def touch(kind, angle):
            x, y = knob_point(angle)
            session.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"id": 8, "x": x, "y": y}]})
        touch("touchStart", -90)
        touch("touchMove", -65)
        check(-67 < state()["powerAngle"] < -63 and not state()["power"], "Touch rotates POWER through intermediate positions")
        touch("touchMove", -10)
        touch("touchEnd", -10)
        settled(0)
        check(state()["power"], "Touch release settles POWER at ON")

        page.locator("#file-input").set_input_files(fixture)
        page.wait_for_function("turntable.state.recordLoaded")
        page.locator("#tonearm").focus()
        page.keyboard.press("Home")
        page.keyboard.press("ArrowRight")
        click("cue")
        click("start-stop")
        page.wait_for_timeout(250)
        check(rms() > .01 and state()["position"] > .2, "Loaded record plays through the existing audio processor")
        click("rpm-33")
        page.wait_for_timeout(150)
        stopped = state()
        page.wait_for_timeout(150)
        wait_for_silence(page, 1e-5)
        check(state()["rpm"] is None and state()["effectiveRate"] == 0 and not state()["platterRunning"] and rms() < .00001,
              "Releasing the last speed latch stops actual sound and motor")
        check(abs(state()["position"] - stopped["position"]) < .001 and state()["rotation"] == stopped["rotation"],
              "No-speed idle freezes the platter and preserves the current groove")
        page.locator("#turntable-details summary").click()
        check("NO SPEED" in page.locator("#speed-readout").inner_text() and "No speed" in page.locator("#status").inner_text(),
              "Readout and status explicitly report no speed selected")
        click("quartz")
        page.locator("#pitch").focus()
        page.keyboard.press("End")
        check(state()["effectiveRate"] == 0, "Pitch cannot manufacture an RPM when both latches are released")
        click("quartz")
        click("start-stop")
        check(state()["effectiveRate"] == 0 and not state()["platterRunning"], "Quartz and START respect no-speed idle")

        page.locator("#vinyl-hit-area").focus()
        before = state()["position"]
        for _ in range(8):
            page.keyboard.down("ArrowRight")
            page.wait_for_timeout(20)
        check(state()["position"] > before and rms() > .01 and not state()["platterRunning"],
              "Manual scratching remains audible with no motor speed selected")
        page.keyboard.up("ArrowRight")
        page.wait_for_timeout(150)
        wait_for_silence(page, 1e-5)
        check(rms() < .00001 and not state()["stylusRaised"], "Scratch release returns to silence and preserves manual CUE")

        click("rpm-45")
        check(state()["rpm"] == 45 and not state()["platterRunning"], "Selecting a speed after idle waits for START")
        click("start-stop")
        page.wait_for_timeout(120)
        click("rpm-33")
        page.wait_for_timeout(550)
        check(state()["rpm"] == 78 and abs(state()["motorActualRate"] - 2.34) < .001 and rms() > .01,
              "Both latched keys drive audible 78 RPM through the existing motor glide")
        click("quartz")
        check(abs(state()["effectiveRate"] - 2.34 * 1.08) < .001, "Pitch scales the RPM derived from both latches")
        click("rpm-33")
        check(abs(state()["effectiveRate"] - 1.35 * 1.08) < .001, "Releasing 33 derives pitched 45 RPM without losing the other latch")
        click("quartz")
        check(abs(state()["effectiveRate"] - 1.35) < 1e-9, "Quartz locks to the remaining latch's nominal speed")
        begin()
        move(-65)
        page.wait_for_timeout(120)
        wait_for_silence(page, 1e-5)
        check(not state()["power"] and rms() < .00001, "Rotating POWER across OFF silences actual playback before pointer release")
        page.mouse.up()
        settled(-90)
        set_power(page, True)
        check(state()["rpm"] == 45 and not state()["platterRunning"], "Power cycling preserves latch selection and requires START")
        page.locator("#file-input").set_input_files(fixture)
        page.wait_for_function("turntable.state.recordPhase === 'ready' && turntable.state.stylusRaised")
        check(state()["rpm"] == 45 and state()["stylusRaised"], "Record replacement preserves speed selection and parks the arm")
        click("eject")
        page.wait_for_function("turntable.state.recordPhase === 'empty'")
        check(state()["rpm"] == 45 and not state()["recordLoaded"], "Eject preserves physical speed latches")
        check(page.evaluate("__probe.worklets===1 && __probe.starts===0"), "All control changes reuse one audio processor with no source restarts")
        check(not errors, "No browser errors during rotary and idle integration checks")
        browser.close()
    (ROOT / "artifacts/controls.json").write_text(json.dumps({"result": "passed", "total": len(checks), "checks": checks}, indent=2) + "\n")
    print(f"All {len(checks)} rotary and idle checks passed.")


if __name__ == "__main__":
    run()
