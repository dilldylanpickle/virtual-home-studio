"""Observe actual browser UI motion, reversal, focus and reduced-motion behavior."""
import json

from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW, PROBE

checks = []


def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)


def run():
    out = ROOT / 'artifacts/ui-motion'
    out.mkdir(parents=True, exist_ok=True)
    traces = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1300})
        page.add_init_script(PROBE)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:42069/')
        page.wait_for_function('window.turntable')
        state = lambda: page.evaluate('turntable.state')
        dialogs = [('media-source', 'load', 'media-source-close'),
                   ('customize', 'customize-open', 'customize-close'),
                   ('help', 'help-open', 'help-close')]
        page.evaluate(r"""() => {
          window.startUIMotionTrace = selector => {
            const node = document.querySelector(selector), samples = [];
            let frame;
            const sample = () => {
              const style = getComputedStyle(node), rect = node.getBoundingClientRect();
              samples.push({time: performance.now(), opacity: Number(style.opacity),
                transform: style.transform, translate: style.translate, scale: style.scale,
                height: rect.height, visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0,
                open: Boolean(node.open), hidden: node.hidden, text: node.textContent.trim()});
            };
            const tick = () => {sample(); frame = requestAnimationFrame(tick)};
            tick();
            window.finishUIMotionTrace = () => {sample(); cancelAnimationFrame(frame); return samples;};
          };
        }""")

        def settled(selector):
            page.wait_for_function("selector => !document.querySelector(selector).getAnimations().some(a => a.playState === 'running' || a.playState === 'pending')", arg=selector)

        def capture(name, selector, action, delay=420):
            page.evaluate('startUIMotionTrace', selector)
            action()
            page.wait_for_timeout(delay)
            result = page.evaluate('finishUIMotionTrace()')
            traces[name] = result
            (out / 'motion-samples.json').write_text(json.dumps(traces, indent=2))
            return result

        def fades(samples):
            return any(s['visible'] and .005 < s['opacity'] < .995 for s in samples)

        def moves(samples):
            visible = [s for s in samples if s['visible']]
            return len({(s['transform'], s['translate'], s['scale']) for s in visible}) > 1

        def closed(id):
            page.locator('#' + id).wait_for(state='hidden')

        def open_dialog(id, opener):
            page.locator('#' + opener).click()
            page.wait_for_function('id => document.getElementById(id).open', arg=id)
            settled('#' + id)

        deck_before = page.locator('#deck').evaluate('node => {const r=node.getBoundingClientRect();return [r.x+scrollX,r.y+scrollY,r.width,r.height]}')
        for id, opener, closer in dialogs:
            opening = capture(id + '-open', '#' + id, lambda: page.locator('#' + opener).click())
            check(fades(opening) and moves(opening), f'{id}: opening contains real intermediate opacity and transform frames')
            check(page.locator('#' + id).is_visible() and page.evaluate('id => document.getElementById(id).contains(document.activeElement)', id), f'{id}: completed opening has usable native modal focus')
            closing = capture(id + '-escape', '#' + id, lambda: page.keyboard.press('Escape'))
            closed(id)
            check(fades(closing) and any(s['open'] and s['opacity'] < .99 for s in closing), f'{id}: Escape visibly animates before releasing native modal state')
            close_state = page.locator('#' + id).evaluate("node => ({open:node.open, active:document.activeElement.id, opacity:getComputedStyle(node).opacity, animations:node.getAnimations().map(a=>({state:a.playState,time:a.currentTime}))})")
            check(not page.locator('#' + id).is_visible() and page.locator('#' + opener).evaluate('node => node === document.activeElement'), f'{id}: completed close restores its opener focus: {close_state}')
            # Call the same button handlers while a close is unfinished to exercise
            # cancellation without Playwright waiting for the old animation first.
            page.evaluate('opener => document.getElementById(opener).click()', opener)
            page.wait_for_timeout(35)
            page.evaluate('closer => document.getElementById(closer).click()', closer)
            page.wait_for_timeout(35)
            page.evaluate('opener => document.getElementById(opener).click()', opener)
            page.wait_for_timeout(400); settled('#' + id)
            check(page.locator('#' + id).is_visible() and page.locator('#' + id).evaluate('node => node.open && +getComputedStyle(node).opacity === 1'), f'{id}: rapid close/reopen cancels stale completion and finishes open')
            page.mouse.click(2, 2); closed(id)
            check(page.locator('#' + opener).evaluate('node => node === document.activeElement'), f'{id}: pointer backdrop closes and restores focus')

        toggle, options = page.locator('#preset-toggle'), page.locator('#preset-options')
        opening = capture('presets-open', '#preset-options', lambda: toggle.click())
        check(fades(opening) and moves(opening), 'Preset popup animates actual intermediate opacity and movement')
        check(toggle.get_attribute('aria-expanded') == 'true' and options.is_visible(), 'Preset popup finishes open with accurate expanded state')
        closing = capture('presets-close', '#preset-options', lambda: page.keyboard.press('Escape'))
        options.wait_for(state='hidden')
        check(fades(closing) and not options.is_visible() and toggle.get_attribute('aria-expanded') == 'false', 'Preset Escape closes smoothly and finishes hidden')
        check(toggle.evaluate('node => node === document.activeElement'), 'Preset Escape returns keyboard focus to its toggle')
        page.evaluate("document.querySelector('#preset-toggle').click()")
        page.wait_for_timeout(35)
        page.evaluate("document.querySelector('#preset-toggle').click()")
        page.wait_for_timeout(35)
        page.evaluate("document.querySelector('#preset-toggle').click()")
        page.wait_for_timeout(400)
        check(options.is_visible() and toggle.get_attribute('aria-expanded') == 'true', 'Rapid preset toggle reversal cannot hide the newly reopened menu')
        page.locator('#track-name').click(); options.wait_for(state='hidden')
        check(toggle.get_attribute('aria-expanded') == 'false', 'Pointer outside the preset chooser dismisses it')
        toggle.focus(); page.keyboard.press('ArrowDown'); page.keyboard.press('End'); page.keyboard.press('Enter')
        options.wait_for(state='hidden')
        check(state()['rpm'] == 78 and page.locator('#preset-name').inner_text() == 'Chipmunk' and toggle.evaluate('node => node === document.activeElement'), 'Keyboard preset selection still commands hardware and returns focus')

        for selector, label in [('#turntable-details', 'Turntable details'), ('.help-focus-keys', 'Focused keyboard help')]:
            if selector.startswith('.'): open_dialog('help', 'help-open')
            summary = page.locator(selector + ' > summary')
            before = page.locator(selector).bounding_box()['height']
            opening = capture(label + '-open', selector, lambda: summary.click())
            settled(selector)
            after = page.locator(selector).bounding_box()['height']
            check(after > before + 5 and any(before + .5 < s['height'] < after - .5 for s in opening), f'{label}: expansion contains real intermediate layout heights')
            closing = capture(label + '-close', selector, lambda: summary.click())
            settled(selector)
            check(any(before + .5 < s['height'] < after - .5 for s in closing) and not page.locator(selector).evaluate('node => node.open'), f'{label}: collapse animates height then restores native closed state')
            page.evaluate('selector => document.querySelector(selector + " > summary").click()', selector)
            page.wait_for_timeout(35)
            page.evaluate('selector => document.querySelector(selector + " > summary").click()', selector)
            page.wait_for_timeout(35)
            page.evaluate('selector => document.querySelector(selector + " > summary").click()', selector)
            page.wait_for_timeout(400)
            check(page.locator(selector).evaluate('node => node.open') and page.locator(selector).bounding_box()['height'] > before + 5, f'{label}: quick reversal follows the latest expansion intent')
            motor_before = state()['platterRunning']
            summary.focus(); page.keyboard.press('Space'); settled(selector)
            page.wait_for_function('selector => !document.querySelector(selector).open', arg=selector)
            check(summary.evaluate('node => node === document.activeElement') and state()['platterRunning'] == motor_before, f'{label}: Space collapses while preserving focus and motor intent')
            if selector.startswith('.'): page.keyboard.press('Escape'); closed('help')

        page.locator('#preset-name').scroll_into_view_if_needed()
        text = capture('preset-text', '#preset-name', lambda: page.evaluate("turntable.controls.applyPreset('nightcore')"), delay=240)
        check(fades(text) and any('Nightcore' in s['text'] for s in text), 'Changing preset text uses real opacity interpolation while updating its content immediately')
        page.evaluate("turntable.controls.applyPreset('slowed');turntable.controls.applyPreset('hyperpop')")
        page.wait_for_function('!turntable.state.presetMotion')
        settled('#preset-name')
        check(page.locator('#preset-name').inner_text() == 'Hyperpop', 'Rapid label retargeting settles on current model content without stale text')
        page.evaluate("turntable.controls.applyPreset('original')")
        page.wait_for_function('!turntable.state.presetMotion')

        open_dialog('media-source', 'load')
        with page.expect_file_chooser() as choice:
            page.locator('#source-local').click()
        check(not page.locator('#media-source').is_visible() and state()['recordPhase'] == 'empty', 'Local file action closes synchronously and preserves the native picker gesture')
        choice.value.set_files(RAW)
        page.wait_for_function("turntable.state.recordPhase === 'ready'")
        check(page.locator('#load').get_attribute('aria-label') == 'Replace record', 'Loading retains immediate accessible record-action state')
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase === 'idle' && turntable.state.position > 1.6")
        position = state()['position']; open_dialog('help', 'help-open')
        signal = page.evaluate('''() => {const a=__probe.analyser,d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length)}''')
        check(signal > .001 and state()['position'] > position and not state()['transportPaused'], 'Dialog motion leaves actual local audio and the shared playback clock running')
        page.keyboard.press('Escape'); closed('help')
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.transportState === 'paused'")
        check(page.locator('#transport-hint').inner_text() == '', 'Animated transport labels do not restore the redundant paused hint')
        deck_after = page.locator('#deck').evaluate('node => {const r=node.getBoundingClientRect();return [r.x+scrollX,r.y+scrollY,r.width,r.height]}')
        check(all(abs(a - b) < .1 for a, b in zip(deck_before, deck_after)), 'UI transitions preserve the physical deck geometry')
        check(page.evaluate('__probe.worklets === 1 && __probe.starts === 0'), 'UI motion keeps the existing single-worklet audio architecture')

        page.emulate_media(reduced_motion='reduce')
        for id, opener, closer in dialogs:
            page.locator('#' + opener).click()
            check(page.locator('#' + id).evaluate("node => node.open && +getComputedStyle(node).opacity === 1 && !node.getAnimations().some(a => a.playState === 'running')"), f'{id}: reduced-motion opening is immediate and fully visible')
            page.locator('#' + closer).click()
            check(not page.locator('#' + id).is_visible(), f'{id}: reduced-motion closing is immediate')
        toggle.click()
        check(options.evaluate("node => !node.hidden && +getComputedStyle(node).opacity === 1 && !node.getAnimations().some(a => a.playState === 'running')"), 'Reduced-motion preset popup opens without animation')
        page.keyboard.press('Escape')
        check(not options.is_visible(), 'Reduced-motion preset popup closes immediately')
        for selector in ['#turntable-details', '.help-focus-keys']:
            if selector.startswith('.'): page.locator('#help-open').click()
            page.locator(selector + ' > summary').click()
            check(page.locator(selector).evaluate("node => node.open && !node.getAnimations().some(a => a.playState === 'running')"), f'{selector}: reduced-motion disclosure opens without animation')
            page.locator(selector + ' > summary').click()
            check(not page.locator(selector).evaluate('node => node.open'), f'{selector}: reduced-motion disclosure closes immediately')
            if selector.startswith('.'): page.keyboard.press('Escape')
        check(not errors, 'No browser exceptions across animated panels, reversal, labels and reduced motion')
        browser.close()
    (out / 'checks.json').write_text(json.dumps({'checks': checks, 'motion_samples': traces}, indent=2) + '\n')
    print(f'All {len(checks)} UI motion checks passed.', flush=True)


if __name__ == '__main__':
    run()
