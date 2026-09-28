"""Focused physical controls and reference-layout checks; run against port 42069."""
import json
import math
from pathlib import Path

from playwright.sync_api import sync_playwright

from acceptance import arm_point, deck_point, select_speed, set_power

ROOT = Path(__file__).resolve().parents[1]
checks = []


def check(condition, message, **details):
    assert condition, f"{message}: {details}"
    checks.append({"check": message, **details})
    print(f"PASS {message}", flush=True)


def run():
    (ROOT / "artifacts").mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1440, "height": 1250}, has_touch=True)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("http://127.0.0.1:42069")
        page.wait_for_function("window.turntable !== undefined")
        state = lambda: page.evaluate("turntable.state")
        click = lambda name: page.locator(f"#{name}").click()
        pressed = lambda name: page.locator(f"#{name}").get_attribute("aria-pressed") == "true"

        view_box = page.locator("#deck").evaluate("el => {const v=el.viewBox.baseVal; return [v.x,v.y,v.width,v.height];}")
        check(view_box == [90, 180, 1024, 828], "Deck uses the measured reference viewBox", view_box=view_box)
        geometry = page.evaluate("turntable.geometry")
        platter = page.locator("#vinyl-hit-area").evaluate("el => ({x:el.cx.baseVal.value,y:el.cy.baseVal.value,r:el.r.baseVal.value})")
        check(platter["x"] == geometry["cx"] and platter["y"] == geometry["cy"] and platter["r"] >= geometry["outer"],
              "Vinyl interaction surface aligns with the modeled spindle and grooves")
        check(geometry["px"] == 951 and geometry["py"] == 415 and
              abs(geometry["length"] - math.hypot(95, 511)) < 1e-8 and
              abs(geometry["rest"] - math.degrees(math.atan2(95, 511))) < 1e-8,
              "Arm geometry uses the measured bearing and parked needle coordinates")
        angle = state()["tonearmAngle"]
        check(angle == geometry["rest"], "Tonearm initially rests at its modeled parked angle")
        rendered_arm = page.locator("#tonearm").evaluate("""(arm, length) => {
          const matrix=arm.getScreenCTM();
          const pivot=new DOMPoint(0,0).matrixTransform(matrix);
          const tip=new DOMPoint(0,length).matrixTransform(matrix);
          return {pivot:[pivot.x,pivot.y],tip:[tip.x,tip.y]};
        }""", geometry["length"])
        check(math.dist(rendered_arm["pivot"], deck_point(page, geometry["px"], geometry["py"])) < .01 and
              math.dist(rendered_arm["tip"], arm_point(page, geometry, angle)) < .01,
              "Rendered arm pivot and parked stylus agree with the interactive geometry")

        rendered_tip = page.locator("#tonearm .arm-hit-area").evaluate("""path => {
          const tip=path.getPointAtLength(path.getTotalLength());
          const screen=new DOMPoint(tip.x,tip.y).matrixTransform(path.getScreenCTM());
          return [screen.x,screen.y];
        }""")
        check(math.dist(rendered_tip, arm_point(page, geometry, angle)) < .01,
              "Actual headshell interaction path ends at the modeled stylus contact")

        def check_control_bounds(label):
            deck = page.locator("#deck").bounding_box()
            control_ids = ["power", "start-stop", "rpm-33", "rpm-45", "rpm-78", "cue", "pitch-range", "quartz", "target-light", "pitch"]
            outside = []
            for name in control_ids:
                box = page.locator(f"#{name}").bounding_box()
                if not box or box["x"] < deck["x"] - 1 or box["y"] < deck["y"] - 1 or box["x"] + box["width"] > deck["x"] + deck["width"] + 1 or box["y"] + box["height"] > deck["y"] + deck["height"] + 1:
                    outside.append(name)
            check(not outside, f"All physical controls remain within the deck at {label}", outside=outside)
            check(abs(deck["width"] / deck["height"] - view_box[2] / view_box[3]) < .005,
                  f"Reference proportions stay undistorted at {label}")

            rail = page.locator("#pitch-rail").bounding_box()
            fader = page.locator("#pitch").bounding_box()
            rail_center = (rail["x"] + rail["width"] / 2, rail["y"] + rail["height"] / 2)
            fader_center = (fader["x"] + fader["width"] / 2, fader["y"] + fader["height"] / 2)
            check(math.dist(rail_center, fader_center) < 2 and .9 < fader["height"] / rail["height"] < 1.1,
                  f"Native pitch fader stays aligned with its physical rail at {label}")

        check_control_bounds("desktop size")
        check(state()["rpm"] is None and state()["effectiveRate"] == 0 and not pressed("rpm-33") and not pressed("rpm-45"),
              "Initial state has neither speed latch selected")
        click("start-stop")
        check(not state()["platterRunning"] and "speed" in page.locator("#notice").inner_text(), "START cannot run the motor without a speed")
        sequence = [("rpm-33", 100/3), ("rpm-33", None), ("rpm-45", 45), ("rpm-45", None),
                    ("rpm-33", 100/3), ("rpm-45", 78), ("rpm-45", 100/3), ("rpm-45", 78), ("rpm-33", 45)]
        for button, rpm in sequence:
            click(button)
            s = state()
            check(s["rpm"] == rpm and s["effectiveRate"] == (rpm / (100/3) if rpm is not None else 0),
                  f"Requested transition: {button} -> {rpm}")
            check(pressed("rpm-33") == s["speed33Pressed"] == (rpm in (100/3, 78)) and
                  pressed("rpm-45") == s["speed45Pressed"] == (rpm in (45, 78)),
                  "Indicators and pressed states reflect the independent latches")
        check(page.locator("#rpm-78").get_attribute("role") != "button" and page.locator("#rpm-78").get_attribute("tabindex") is None,
              "78 is a non-focusable printed marking")
        box = page.locator("#rpm-78").bounding_box()
        before = state()
        page.mouse.click(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
        page.locator("#rpm-78").evaluate("el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true}))")
        check(state()["rpm"] == before["rpm"], "Clicking 78 cannot independently select a speed")
        page.locator("#rpm-33").focus()
        page.keyboard.press("Enter")
        check(state()["rpm"] == 78, "Keyboard latches 33 alongside the already latched 45")
        page.keyboard.press("Space")
        check(state()["rpm"] == 45, "Keyboard releases only its focused speed latch")
        # Each pointer commits exactly one latch on release; browser click synthesis
        # must never toggle the same key a second time.
        session = context.new_cdp_session(page)
        for first, second in [("rpm-33", "rpm-45"), ("rpm-45", "rpm-33")]:
            select_speed(page, None)
            touches = []
            for index, name in enumerate([first, second], start=1):
                box = page.locator(f"#{name}").bounding_box()
                touches.append({"id": index, "x": box["x"] + box["width"]/2, "y": box["y"] + box["height"]/2})
                session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": touches.copy()})
            session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": touches[:1]})
            check(state()["rpm"] == (100/3 if first == "rpm-33" else 45), "First touch release latches only its speed key")
            session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            page.wait_for_timeout(80)
            check(state()["rpm"] == 78 and pressed("rpm-33") and pressed("rpm-45"), "Both touch releases latch 78 without double toggles")
        select_speed(page, None)
        for expected in [100/3, None]:
            page.locator("#rpm-33").tap()
            check(state()["rpm"] == expected, "A single touch tap toggles its latch exactly once")
        box = page.locator("#rpm-45").bounding_box()
        page.mouse.move(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
        page.mouse.down()
        page.mouse.move(box["x"] + box["width"] + 30, box["y"] - 30)
        page.mouse.up()
        check(state()["rpm"] is None, "Dragging off a speed key cancels its click")
        select_speed(page, 45)

        click("start-stop")
        check(state()["platterRunning"] and pressed("start-stop"), "Physical START starts the powered platter")
        click("start-stop")
        check(not state()["platterRunning"] and not pressed("start-stop"), "Physical STOP stops the platter")
        set_power(page, False)
        check(not state()["power"] and state()["powerAngle"] == -90, "Keyboard rotates the power knob to OFF")
        click("start-stop")
        check(not state()["platterRunning"], "START respects the physical power switch")
        set_power(page, True)
        check(state()["power"] and not state()["platterRunning"], "Power knob turns on without starting the motor")
        click("cue")
        check(not state()["stylusRaised"] and pressed("cue"), "Physical cue lever lowers the stylus")
        click("cue")
        check(state()["stylusRaised"] and not pressed("cue"), "Physical cue lever raises the stylus")
        click("pitch-range")
        check(state()["pitchRange"] == 16 and page.locator("#pitch").get_attribute("max") == "16", "Physical range control exposes the 16 percent pitch range")
        click("quartz")
        check(not state()["quartzLock"] and not pressed("quartz"), "Physical quartz button unlocks pitch")
        pitch = page.locator("#pitch")
        check(pitch.get_attribute("type") == "range" and bool(pitch.get_attribute("aria-label")), "Pitch fader retains a labeled native range input")
        pitch.focus()
        page.keyboard.press("End")
        check(state()["pitch"] == 16 and abs(state()["effectiveRate"] - 1.35 * 1.16) < 1e-8,
              "Keyboard pitch input changes actual selected playback rate")
        page.keyboard.press("Home")
        check(state()["pitch"] == -16 and "-16" in pitch.get_attribute("aria-valuetext"), "Pitch minimum updates its accessible value")
        click("pitch-range")
        check(state()["pitchRange"] == 8 and state()["pitch"] == -8, "Returning to the 8 percent range preserves the minimum fader position")
        # Preserve physical fader position, including interior positions where
        # clamping the absolute pitch would incorrectly move the control.
        for value in [-6, -2, 0, 3, 6]:
            pitch.fill(str(value))
            before = state()
            click("pitch-range")
            high = state()
            check(high["pitchRange"] == 16 and high["pitch"] == value * 2 and
                  high["quartzLock"] == before["quartzLock"] and
                  abs(float(pitch.input_value()) / float(pitch.get_attribute("max")) - value / 8) < 1e-8,
                  f"Range toggle preserves the physical fader position at {value:+d} percent")
            click("pitch-range")
            check(state()["pitch"] == value and state()["pitchRange"] == 8,
                  "Returning range restores the original unlocked pitch")
        click("quartz")
        check(state()["quartzLock"] and abs(state()["effectiveRate"] - 1.35) < 1e-8, "Quartz restores the selected nominal RPM")
        click("pitch-range")
        check(state()["quartzLock"] and state()["pitch"] == 12 and abs(state()["effectiveRate"] - 1.35) < 1e-8,
              "Range preserves locked nominal speed and the latent fader position")
        click("quartz")
        check(abs(state()["effectiveRate"] - 1.35 * 1.12) < 1e-8,
              "Releasing Quartz uses the preserved position in the new range")
        click("quartz")
        hit = page.locator('#pitch-range circle[fill="transparent"]').evaluate("""el => ({
          fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).stroke,
          outline: getComputedStyle(el.parentElement).outlineStyle
        })""")
        check(hit["fill"] == "rgba(0, 0, 0, 0)" and hit["stroke"] == "none" and hit["outline"] == "none",
              "Physical range hit area remains invisible without a browser outline")
        click("target-light")
        check(state()["targetLight"] and page.locator("#light-beam").is_visible(), "Physical target light illuminates the record area")
        click("target-light")
        page.wait_for_function("getComputedStyle(document.querySelector('#light-glow')).opacity === '0'")
        check(not state()["targetLight"], "Physical target light fades off")

        page.set_viewport_size({"width": 390, "height": 844})
        check_control_bounds("mobile size")
        check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Reference deck has no horizontal overflow on mobile")
        select_speed(page, 78)
        check(state()["rpm"] == 78 and pressed("rpm-33") and pressed("rpm-45"), "Both physical speed latches work on mobile")
        check(not errors, "No browser errors during hardware checks", errors=errors)
        browser.close()
    report = ROOT / "artifacts/hardware.json"
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps({"result": "passed", "total": len(checks), "checks": checks}, indent=2) + "\n")
    print(f"All {len(checks)} hardware checks passed.", flush=True)


if __name__ == "__main__":
    run()
