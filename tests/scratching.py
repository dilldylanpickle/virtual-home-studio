"""Browser coverage for hand-driven vinyl and independently controlled cueing."""
import json
import math
from pathlib import Path

from playwright.sync_api import sync_playwright
from audio_assertions import wait_for_silence
from audio_fixtures import generated_long_record
from acceptance import RAW, select_speed, PROBE, arm_point, deck_point, groove_angle

ROOT = Path(__file__).resolve().parents[1]
checks = []


def check(condition, message, **details):
    assert condition, f"{message}: {details}"
    checks.append({"check": message, **details})
    print(f"PASS {message}", flush=True)


def run():
    (ROOT / "artifacts").mkdir(exist_ok=True)
    with generated_long_record() as long_record, sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1280, "height": 1100}, has_touch=True)
        page = context.new_page()
        page.add_init_script(PROBE)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.goto("http://127.0.0.1:42069")
        page.wait_for_function("window.turntable !== undefined")
        state = lambda: page.evaluate("turntable.state")
        click = lambda id: page.locator(f"#{id}").click()

        def vinyl_point(degrees):
            g = page.evaluate("turntable.geometry")
            radius = (g["outer"] + g["inner"]) / 2
            return deck_point(page,
                              g["cx"] + radius * math.cos(math.radians(degrees)),
                              g["cy"] + radius * math.sin(math.radians(degrees)))

        def arm_seek(fraction):
            s = state()
            g = page.evaluate("turntable.geometry")
            page.mouse.move(*arm_point(page, g, s["tonearmAngle"]))
            page.mouse.down()
            page.mouse.move(*arm_point(page, g, groove_angle(g, fraction)), steps=8)
            page.mouse.up()
            check(state()["stylusRaised"] == s["stylusRaised"], "Arm dragging preserves the user's cue setting", raised=s["stylusRaised"])
            check(abs(state()["position"] - state()["duration"] * fraction) < .1, "Manual arm placement seeks without changing cue")

        def signal():
            return page.evaluate("""() => {
              const a=__probe.analyser; const data=new Float32Array(a.fftSize);
              a.getFloatTimeDomainData(data);
              return Math.sqrt(data.reduce((sum,v)=>sum+v*v,0)/data.length);
            }""")

        def grab(angle=170):
            page.mouse.move(*vinyl_point(angle))
            page.mouse.down()
            page.wait_for_timeout(160)
            check(state()["scratching"], "Pointer captures the record")
            held = state()
            page.wait_for_timeout(160)
            after = state()
            check(abs(after["position"] - held["position"]) < .002, "Holding still freezes audio position")
            check(abs(after["recordRotation"] - held["recordRotation"]) < .001, "Holding still freezes vinyl rotation")
            wait_for_silence(page, 1e-5)
            check(signal() < .00001, "Holding still produces silence")
            if held["platterRunning"]:
                check(after["rotation"] != held["rotation"], "Motor-driven strobe rim continues underneath the held vinyl")
            return after

        def turn(start_angle, delta):
            start = state()
            rates, levels = [], []
            for step in range(1, 17):
                page.mouse.move(*vinyl_point(start_angle + delta * step / 16))
                page.wait_for_timeout(12)
                rates.append(state()["actualRate"])
                levels.append(signal())
            page.wait_for_timeout(140)
            return start, state(), rates, levels

        select_speed(page, 100 / 3)
        for fixture in [RAW, long_record]:
            filename = fixture.name
            page.locator("#file-input").set_input_files(fixture)
            page.wait_for_function("name=>turntable.state.filename===name && turntable.state.recordPhase==='ready'", arg=filename, timeout=90000)
            if not state()["platterRunning"]:
                click("start-stop")
            arm_seek(.5)
            click("cue")
            page.wait_for_timeout(70)
            check(not state()["stylusRaised"], "CUE lowers only when explicitly selected")
            # This is the user's requested behavior: no automatic lift on pointerdown/move/up.
            arm_seek(.48)
            page.wait_for_timeout(70)
            check(page.evaluate("turntable.metrics.activeSources") == 1, "Moving the lowered needle keeps playback engaged")
            page.locator("#tonearm").focus()
            page.keyboard.press("ArrowRight")
            check(not state()["stylusRaised"], "Keyboard arm movement also preserves lowered cue")
            grab()
            before, after, rates, levels = turn(170, -100)
            check(min(rates) < -.1, "Counterclockwise gesture produces reverse playback")
            check(abs(after["position"] - before["position"] + .5) < .025, "A backward 100-degree drag rewinds half a second", file=filename)
            check(max(levels) > .0001, "Backward scratching outputs the fixture's audio", rms=max(levels))
            check(abs(after["recordRotation"] - before["recordRotation"] + 100) < .001, "Vinyl follows the hand's backward angle")
            before, after, rates, levels = turn(70, 100)
            check(max(rates) > .1, "Clockwise gesture produces forward playback")
            check(abs(after["position"] - before["position"] - .5) < .025, "A forward 100-degree drag advances half a second", file=filename)
            check(max(levels) > .0001, "Forward scratching outputs the fixture's audio")
            # Cross the -180/180 seam without jumping a full revolution.
            before, after, _, _ = turn(170, 30)
            check(abs(after["position"] - before["position"] - .15) < .025, "Angle wraparound stays continuous")
            page.mouse.up()
            page.wait_for_timeout(200)
            check(not state()["scratching"] and abs(state()["actualRate"] - state()["effectiveRate"]) < .001, "Release resumes selected motor speed")
            start = state()["position"]
            page.wait_for_timeout(120)
            check(state()["position"] > start + .07, "Playback continues after scratch release")
            click("cue")
            arm_seek(.5)
            grab()
            before, after, _, _ = turn(170, -90)
            check(abs(after["position"] - before["position"]) < .001, "Scratching with CUE raised does not seek the audio")
            wait_for_silence(page, 1e-5)
            check(signal() < .00001 and state()["stylusRaised"], "Scratching preserves a raised and silent cue")
            page.mouse.up()

        click("cue")
        click("start-stop")
        grab()
        before, after, rates, levels = turn(170, -60)
        check(abs(after["position"] - before["position"] + .3) < .025 and max(levels) > .0001, "Hand-driven scratching works while motor is stopped")
        page.mouse.up()
        page.wait_for_timeout(180)
        stopped = state()["position"]
        page.wait_for_timeout(100)
        check(abs(state()["position"] - stopped) < .001 and not state()["platterRunning"], "Release does not restart a stopped motor")

        click("start-stop")
        select_speed(page, 45)
        click("quartz")
        page.locator("#pitch").evaluate("el=>{el.value=8;el.dispatchEvent(new Event('input',{bubbles:true}));}")
        grab()
        turn(170, -45)
        page.mouse.up()
        page.wait_for_timeout(200)
        check(abs(state()["actualRate"] - 1.458) < .001, "Release respects RPM and unlocked pitch")
        grab()
        page.evaluate("window.dispatchEvent(new Event('blur'))")
        page.wait_for_timeout(200)
        check(not state()["scratching"] and abs(state()["actualRate"] - 1.458) < .001, "Window blur releases the record without leaving it stuck")
        page.mouse.up()
        grab()
        page.locator("#vinyl-hit-area").dispatch_event("pointercancel", {"pointerId": 1})
        page.wait_for_timeout(180)
        check(not state()["scratching"], "Pointer cancellation releases the record")
        page.mouse.up()

        # Touch input through Chromium's actual touch-to-pointer dispatch.
        session = context.new_cdp_session(page)
        x, y = vinyl_point(170)
        session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        page.wait_for_timeout(140)
        check(state()["scratching"], "Touch captures the vinyl")
        before = state()["position"]
        for step in range(1, 9):
            x, y = vinyl_point(170 - 80 * step / 8)
            session.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
            page.wait_for_timeout(20)
        page.wait_for_timeout(120)
        check(abs(state()["position"] - before + .4) < .03, "Touch rotates and rewinds the actual audio", before=before, after=state()["position"], scratching=state()["scratching"])
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(200)
        check(not state()["scratching"], "Touch release resumes the motor")

        page.locator("#vinyl-hit-area").focus()
        page.keyboard.down("ArrowLeft")
        page.wait_for_timeout(120)
        check(state()["scratching"], "Keyboard can hold and turn the vinyl")
        page.keyboard.up("ArrowLeft")
        page.wait_for_timeout(180)
        check(not state()["scratching"], "Keyboard release lets go of vinyl")
        grab()
        page.locator("#eject").evaluate("el=>el.click()")
        page.wait_for_function("turntable.state.recordPhase === 'empty'")
        wait_for_silence(page, 1e-5)
        check(not state()["recordLoaded"] and not state()["scratching"] and signal() < .00001, "Eject during a gesture clears the record and scratch state")
        page.mouse.up()
        check(page.evaluate("__probe.worklets === 1 && __probe.starts === 0"), "Every gesture and record replacement uses exactly one processor and no restarted buffer sources")
        check(not errors, "No browser errors during scratching", errors=errors)
        browser.close()
    (ROOT / "artifacts/scratching.json").write_text(json.dumps({"result": "passed", "total": len(checks), "checks": checks}, indent=2) + "\n")
    print(f"All {len(checks)} scratching checks passed.", flush=True)


if __name__ == '__main__':
    run()
