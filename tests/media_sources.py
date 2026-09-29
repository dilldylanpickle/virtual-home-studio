"""Local record chooser, drag/drop, onboarding, and disabled future-source UI."""
import base64
import json
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW, PROBE

checks = []


def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)


def run():
    out = ROOT / 'artifacts/media-sources'
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1300})
        page.add_init_script(PROBE)
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: requests.append(request.url))
        page.goto('http://127.0.0.1:42069/')
        page.wait_for_function('window.turntable')
        state = lambda: page.evaluate('turntable.state')
        modal = page.locator('#media-source')
        load = page.locator('#load')
        future = page.locator('#source-youtube')
        ready = lambda: page.wait_for_function("turntable.state.recordPhase === 'ready'")
        layout_audit = {}

        def action_rects():
            return page.evaluate(r"""() => Object.fromEntries(
              ['#customize-open', '#load', '#eject', '#volume', '.hud-volume'].map(selector => {
                const rect = document.querySelector(selector).getBoundingClientRect();
                return [selector, {x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height}];
              }))""")

        def stable_actions(viewport, phase):
            current = action_rects()
            layout_audit[viewport][phase] = current
            expected = layout_audit[viewport]['empty']
            differences = {selector: {key: round(current[selector][key] - expected[selector][key], 3)
                           for key in expected[selector] if abs(current[selector][key] - expected[selector][key]) > .25}
                           for selector in expected}
            differences = {selector: changes for selector, changes in differences.items() if changes}
            check(not differences, f'{viewport}: record actions and volume keep their position and dimensions after {phase}: {differences}')

        def source_menu():
            load.click()
            check(modal.is_visible(), 'Choose/Replace opens the integrated source dialog')

        def chooser():
            source_menu()
            with page.expect_file_chooser() as choice:
                page.locator('#source-local').click()
            return choice.value

        def drag(event, valid=True):
            page.evaluate(r"""({event, name, data, type}) => {
              const transfer = new DataTransfer();
              const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
              transfer.items.add(new File([bytes], name, {type}));
              document.dispatchEvent(new DragEvent(event, {dataTransfer: transfer, bubbles: true, cancelable: true}));
            }""", {'event': event, 'name': RAW.name if valid else 'not-a-record.txt',
                    'data': base64.b64encode(RAW.read_bytes() if valid else b'not audio').decode(),
                    'type': 'audio/wav' if valid else 'text/plain'})

        def trace_action():
            page.evaluate(r"""() => {
              const button = document.getElementById('load');
              const audit = {samples: [], frames: 0};
              const sample = kind => {
                const state = turntable.state;
                const current = {kind, phase: state.recordPhase, busy: state.busy,
                  loaded: state.recordLoaded, present: state.recordPresent,
                  text: button.textContent.trim(), label: button.getAttribute('aria-label'),
                  attention: button.classList.contains('needs-record'),
                  actionY: button.getBoundingClientRect().y + scrollY};
                const previous = audit.samples.at(-1);
                if (!previous || Object.keys(current).some(key => key !== 'kind' && current[key] !== previous[key])) audit.samples.push(current);
              };
              const observer = new MutationObserver(() => sample('mutation'));
              observer.observe(button, {subtree: true, childList: true, characterData: true,
                attributes: true, attributeFilter: ['aria-label', 'class', 'disabled']});
              let frame;
              const tick = () => {audit.frames++; sample('frame'); frame = requestAnimationFrame(tick)};
              const unsubscribe = turntable.controls.subscribe(() => queueMicrotask(() => sample('model')));
              tick();
              window.finishActionTrace = () => {
                sample('finish'); cancelAnimationFrame(frame); observer.disconnect(); unsubscribe();
                return audit;
              };
            }""")

        def action_trace():
            return page.evaluate('finishActionTrace()')

        def glow():
            return load.evaluate("node => ({enabled: node.classList.contains('needs-record'), opacity: +getComputedStyle(node,'::after').opacity, animation: getComputedStyle(node,'::after').animationName})")

        check(not state()['recordPresent'] and glow()['enabled'], 'Fresh empty page highlights Choose Record')
        check(glow()['animation'] != 'none', 'Default empty-state invitation uses a gentle continuous animation')
        check(page.locator('#record-helper').count() == 0 and load.get_attribute('aria-describedby') is None, 'Redundant local-audio helper text and its description reference are removed')
        layout_audit['desktop'] = {'empty': action_rects()}
        page.screenshot(path=str(out / 'empty-desktop.png'), full_page=True)
        load.focus(); page.keyboard.press('Enter')
        check(modal.is_visible() and page.evaluate("document.querySelector('#media-source').contains(document.activeElement)"), 'Keyboard opens the source dialog and moves focus inside')
        check(future.is_disabled() and 'coming soon' in future.inner_text().lower(), 'YouTube link is only a disabled Coming soon placeholder')
        check(page.locator('#youtube-form, #youtube-url, #youtube-area, iframe').count() == 0, 'The placeholder exposes no URL form or embedded player')
        before = state(); future.evaluate('node => node.click()')
        check(modal.is_visible() and state() == before, 'Clicking the disabled future-source option changes no turntable state')
        focused = []
        for _ in range(8):
            page.keyboard.press('Tab')
            focused.append(page.evaluate('document.activeElement.id'))
        check('source-youtube' not in focused, 'Keyboard navigation skips the disabled future-source option')
        check(page.evaluate("document.querySelector('#media-source').contains(document.activeElement)"), 'Native modal keeps tab focus inside its usable controls')
        page.keyboard.press('Escape'); modal.wait_for(state='hidden')
        check(not modal.is_visible() and load.evaluate('node => node === document.activeElement'), 'Escape closes the dialog and returns focus to Choose Record')
        source_menu(); page.mouse.click(5, 5); modal.wait_for(state='hidden')
        check(not modal.is_visible(), 'Clicking the backdrop dismisses the source dialog')
        before = state(); choice = chooser(); choice.set_files([])
        check(not modal.is_visible() and state()['recordPhase'] == before['recordPhase'] and not state()['recordPresent'], 'Canceling the local picker leaves the platter empty')
        choice = chooser(); trace_action(); choice.set_files(RAW); ready()
        page.wait_for_function("document.querySelector('#load').textContent.trim() === 'Replace'")
        initial_load = action_trace()
        check(initial_load['frames'] > 5 and {'loading', 'inserting', 'ready'} <= {sample['phase'] for sample in initial_load['samples']}, 'Initial-load action is observed across preparation, insertion and readiness')
        labels = [sample['text'] for sample in initial_load['samples']]
        changes = [label for index, label in enumerate(labels) if index == 0 or label != labels[index - 1]]
        check(changes == ['Choose record', 'Replace'] and all(sample['label'] == ('Replace record' if sample['text'] == 'Replace' else 'Choose a record') and (sample['text'] != 'Replace' or sample['phase'] == 'ready') for sample in initial_load['samples']), 'First load changes Choose to Replace once, only after the record is ready')
        check(all(not sample['attention'] for sample in initial_load['samples'] if sample['busy']), 'First-load busy phases suppress the empty invitation')
        page.wait_for_timeout(450)
        check(state()['filename'] == RAW.name and state()['recordLoaded'], 'Source menu local selection uses the existing decoded-record lifecycle')
        check(not glow()['enabled'] and glow()['opacity'] == 0 and glow()['animation'] == 'none', 'Successful local load fades and stops the empty attention treatment')
        stable_actions('desktop', 'loaded')
        check(not page.locator('#pitch').is_disabled() and not page.locator('#preset-toggle').is_disabled(), 'Local pitch adjustment and playback presets remain available')
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase === 'idle' && turntable.state.position > 1.6")
        level = page.evaluate("() => {const a=__probe.analyser,d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);return Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length)}")
        check(level > .001, 'Local source produces measured master audio after menu loading')
        before = state(); choice = chooser(); choice.set_files([]); page.wait_for_timeout(180)
        check(state()['filename'] == before['filename'] and state()['position'] > before['position'] and not state()['transportPaused'], 'Canceling Replace leaves the current record playing')
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.transportState === 'paused' && document.querySelector('#transport').getAttribute('aria-label') === 'Resume playback'")
        check(state()['transportPaused'] and page.locator('#transport-label').inner_text() == 'Play' and page.locator('#transport-hint').inner_text() == '', 'HUD Pause retains paused playback and accessible Resume without a duplicate Paused hint')
        before = state(); source_menu(); page.keyboard.press('Escape'); modal.wait_for(state='hidden')
        check(state()['position'] == before['position'] and state()['tonearmAngle'] == before['tonearmAngle'] and state()['transportPaused'], 'Opening and dismissing Replace preserves the exact paused groove')
        choice = chooser()
        check(state()['filename'] == RAW.name and state()['recordPhase'] == 'ready', 'Current media stays seated until a replacement file is selected')
        trace_action()
        choice.set_files({'name': 'replacement.wav', 'mimeType': 'audio/wav', 'buffer': RAW.read_bytes()})
        page.wait_for_function("turntable.state.recordPhase === 'ready' && turntable.state.filename === 'replacement.wav'")
        replacement = action_trace()
        check(replacement['frames'] > 5 and {'loading', 'ejecting', 'inserting', 'ready'} <= {sample['phase'] for sample in replacement['samples']}, 'Replacement action is observed throughout old-record removal and new-record insertion')
        check(all(sample['text'] == 'Replace' and sample['label'] == 'Replace record' for sample in replacement['samples']), 'Replace text and accessible name remain stable throughout the complete replacement')
        check(all(not sample['attention'] for sample in replacement['samples']), 'Replacement never re-enables the empty Choose Record invitation')
        check(state()['recordLoaded'] and state()['stylusRaised'] and not state()['platterRunning'], 'Selected replacement finishes the shared physical loading sequence safely parked')
        stable_actions('desktop', 'replacement')
        check(page.locator('#file-input').input_value() == '', 'File input resets to permit choosing the same file again')
        before = state(); drag('drop', False)
        check(state()['filename'] == before['filename'] and state()['duration'] == before['duration'] and bool(page.locator('#notice').inner_text()), 'Invalid dropped file preserves existing media and displays a short error')
        trace_action()
        page.locator('#eject').click(); page.wait_for_function("turntable.state.recordPhase === 'empty'")
        page.wait_for_function("document.querySelector('#load').textContent.trim() === 'Choose record'")
        ejection = action_trace()
        check(any(sample['phase'] == 'ejecting' for sample in ejection['samples']), 'Eject action is observed during physical removal')
        check(all(sample['text'] == 'Replace' and sample['label'] == 'Replace record' and not sample['attention'] for sample in ejection['samples'] if sample['phase'] != 'empty'), 'Eject retains Replace and suppresses onboarding until physical removal finishes')
        empty = ejection['samples'][-1]
        check(empty['phase'] == 'empty' and not empty['present'] and not empty['loaded'] and empty['text'] == 'Choose record' and empty['label'] == 'Choose a record' and empty['attention'], 'Choose and its invitation return only after the platter genuinely becomes empty')
        check(glow()['enabled'], 'Ejecting the record restores the empty attention treatment')
        stable_actions('desktop', 'ejected')
        drag('dragenter'); page.wait_for_timeout(400)
        check(page.locator('#drop-zone').evaluate("node => node.classList.contains('drag-over')") and page.locator('.drop-overlay').is_visible(), 'Valid audio drag reveals the integrated platter drop overlay')
        check('drop record to load' in page.locator('.drop-overlay').inner_text().lower(), 'The drop target clearly explains the available action')
        check(glow()['opacity'] == 0, 'Drag state temporarily suppresses the empty Choose Record glow')
        page.screenshot(path=str(out / 'drop-desktop.png'), full_page=True)
        page.keyboard.press('Escape'); page.wait_for_timeout(400)
        check(not page.locator('#drop-zone').evaluate("node => node.classList.contains('drag-over')") and glow()['enabled'] and glow()['opacity'] == 1, 'Escape cancels drop preview and restores empty onboarding')
        drag('dragenter'); page.evaluate("window.dispatchEvent(new Event('blur'))")
        check(not page.locator('#drop-zone').evaluate("node => node.classList.contains('drag-over')"), 'Window blur clears an abandoned drag preview')
        drag('dragenter', False)
        check(not page.locator('#drop-zone').evaluate("node => node.classList.contains('drag-over')"), 'Invalid file drag does not invite a record drop')
        drag('drop', False)
        check(not state()['recordPresent'] and bool(page.locator('#notice').inner_text()), 'Invalid dropped file leaves the empty turntable usable with a short message')
        drag('dragenter'); drag('drop'); ready(); page.wait_for_timeout(450)
        check(state()['filename'] == RAW.name and not glow()['enabled'], 'Audio drop loads through the same local path and clears onboarding')
        check(page.evaluate('__probe.worklets === 1 && __probe.starts === 0'), 'File choice, replacement and drop retain one persistent worklet without duplicate sources')
        page.locator('#eject').click(); page.wait_for_function("turntable.state.recordPhase === 'empty'")

        for width, height, name in [(1440,1300,'desktop'), (900,1000,'tablet'), (390,844,'mobile')]:
            page.set_viewport_size({'width':width,'height':height}); source_menu()
            box = modal.bounding_box()
            check(0 <= box['x'] and box['x'] + box['width'] <= width and 0 <= box['y'] and box['y'] + box['height'] <= height, f'{name}: source dialog fits the viewport')
            check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{name}: source selection has no horizontal overflow')
            check(future.is_visible() and future.is_disabled() and page.locator('#source-local').bounding_box()['height'] >= 44, f'{name}: local choice stays touch-friendly and Coming soon remains visibly unavailable')
            page.screenshot(path=str(out / f'{name}-source.png'), full_page=True)
            page.keyboard.press('Escape'); modal.wait_for(state='hidden')
            if name == 'mobile':
                layout_audit[name] = {'empty': action_rects()}
                choice = chooser(); trace_action(); choice.set_files(RAW); ready()
                page.wait_for_function("document.querySelector('#load').textContent.trim() === 'Replace'")
                mobile_loading = action_trace()
                check(mobile_loading['frames'] > 5 and {'loading', 'inserting', 'ready'} <= {sample['phase'] for sample in mobile_loading['samples']}, 'Mobile action geometry is observed during loading, insertion and readiness')
                initial_y = mobile_loading['samples'][0]['actionY']
                check(all(sample['actionY'] == initial_y for sample in mobile_loading['samples']), 'Mobile record actions never move vertically during transient loading and insertion captions')
                stable_actions(name, 'loaded')
                choice = chooser()
                choice.set_files({'name': 'mobile-replacement.wav', 'mimeType': 'audio/wav', 'buffer': RAW.read_bytes()})
                page.wait_for_function("turntable.state.recordPhase === 'ready' && turntable.state.filename === 'mobile-replacement.wav'")
                stable_actions(name, 'replacement')
                page.locator('#eject').click()
                page.wait_for_function("turntable.state.recordPhase === 'empty' && document.querySelector('#load').textContent.trim() === 'Choose record'")
                stable_actions(name, 'ejected')
        page.emulate_media(reduced_motion='reduce'); page.wait_for_timeout(100)
        check(glow()['enabled'] and glow()['animation'] == 'none' and glow()['opacity'] == 1, 'Reduced motion retains static empty highlighting without continuous animation')
        check(page.evaluate("typeof window.YT === 'undefined' && !('loadYouTube' in turntable.controls)"), 'No embedded-player API or YouTube loading command is installed')
        external = [url for url in requests if urlsplit(url).scheme in ('http', 'https') and urlsplit(url).hostname not in ('127.0.0.1', 'localhost')]
        check(not external, 'The complete loading and placeholder flow makes no external media or API requests')
        check(not errors, 'No browser exceptions in local source selection, playback, drop or replacement')
        browser.close()
    (out / 'checks.json').write_text(json.dumps({'checks': checks, 'action_transitions': {'first_load': initial_load, 'replacement': replacement, 'eject': ejection, 'mobile_loading': mobile_loading}, 'action_geometry': layout_audit}, indent=2) + '\n')
    print(f'All {len(checks)} local media-source checks passed.', flush=True)


if __name__ == '__main__':
    run()
