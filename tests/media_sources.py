"""Local record chooser, drag/drop, onboarding, and the local-server YouTube link (mocked)."""
import base64
import json
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from studio_helpers import launch_browser
from acceptance import ROOT, RAW, PROBE

checks = []


def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)


def youtube_links(page, state, modal, load, future, ready, out):
    """The server endpoint is mocked; tests/youtube_server.py covers the server itself."""
    status = page.locator('#youtube-status')
    submit = page.locator('#youtube-submit')
    url = page.locator('#youtube-url')
    held, posted = [], []

    def answer(route):
        if route.request.method != 'POST': return route.continue_()
        body = route.request.post_data_json
        posted.append(body['url'])
        mode = body['url'].rsplit('=', 1)[-1]
        if mode == 'hold': held.append(route); return
        if mode == 'private':
            return route.fulfill(status=502, json={'detail': 'That video is private, age-restricted or unavailable.'})
        video = re.search(r'(?:v=|youtu\.be/)([\w-]+)', body['url']).group(1)
        title = 'Mocked%20Session%20%2F%20Live' if video == 'success' else f'Video%20{video}'
        route.fulfill(status=200, body=RAW.read_bytes(), headers={'Content-Type': 'audio/mp4', 'X-Record-Title': title, 'X-Record-Id': video, 'X-Record-Duration': '199'})

    page.route('**/api/youtube', answer)
    page.set_viewport_size({'width': 1440, 'height': 1300})
    load.click(); future.click()
    check(page.locator('#youtube-form').is_visible() and url.evaluate('node => node === document.activeElement') and future.get_attribute('aria-expanded') == 'true', 'Choosing YouTube link reveals the form and focuses the link field')
    before = state()
    url.fill('https://example.com/watch?v=x'); page.keyboard.press('Enter')
    check('youtube' in status.inner_text().lower() and status.evaluate("node => node.classList.contains('error')") and state() == before, 'A non-YouTube link is explained in place without touching the turntable')
    url.focus(); page.keyboard.type(' gtrc'); page.wait_for_timeout(150)
    check(state() == before, 'Typing in the link field never triggers deck shortcuts')
    url.fill('https://www.youtube.com/watch?v=private'); page.keyboard.press('Enter')
    page.wait_for_function("document.querySelector('#youtube-status').textContent.includes('private')")
    check(modal.is_visible() and not submit.is_disabled() and not state()['recordPresent'] and state()['recordPhase'] == 'empty', 'A refused video reports the reason and leaves the empty platter unchanged')
    url.fill('https://www.youtube.com/watch?v=hold'); page.keyboard.press('Enter')
    page.wait_for_function('document.querySelector("#youtube-submit").disabled')
    check(submit.inner_text() == 'Fetching…' and url.evaluate('node => node.readOnly'), 'A pending download shows its progress and locks the form')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')
    check(load.evaluate('node => node === document.activeElement') and state()['recordPhase'] == 'empty', 'Closing the chooser cancels the download and returns focus')
    held[0].fulfill(status=200, body=RAW.read_bytes(), headers={'Content-Type': 'audio/mp4', 'X-Record-Title': 'Late'}); page.wait_for_timeout(500)
    check(not state()['recordPresent'] and state()['recordPhase'] == 'empty', 'A canceled download never loads a record later')
    load.click(); future.click()
    check(not submit.is_disabled() and status.inner_text() == '', 'Reopening the chooser starts with a fresh, usable link form')
    url.fill('youtu.be/success'); page.keyboard.press('Enter')
    modal.wait_for(state='hidden'); ready()
    page.wait_for_function("turntable.state.filename && !turntable.state.pendingFilename")
    page.wait_for_timeout(450)
    check(state()['filename'] == 'Mocked Session - Live.m4a' and state()['recordLoaded'] and page.locator('#track-name').inner_text() == 'Mocked Session - Live', 'A fetched video seats through the shared lifecycle with its title as the record name')
    check(page.evaluate('__probe.worklets === 1 && __probe.starts === 0'), 'Linked audio uses the same persistent worklet without extra sources')
    page.screenshot(path=str(out / 'youtube-loaded.png'), full_page=True)
    load.click(); future.click(); url.fill('https://www.youtube.com/watch?v=hold'); page.keyboard.press('Enter')
    page.wait_for_function('document.querySelector("#youtube-submit").disabled')
    page.evaluate(r"""data => {
      const transfer = new DataTransfer(); const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      transfer.items.add(new File([bytes], 'dropped.wav', {type: 'audio/wav'}));
      document.dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
    }""", base64.b64encode(RAW.read_bytes()).decode())
    page.wait_for_function("turntable.state.recordPhase === 'ready' && turntable.state.filename === 'dropped.wav'")
    held[-1].fulfill(status=200, body=RAW.read_bytes(), headers={'Content-Type': 'audio/mp4', 'X-Record-Title': 'Superseded'}); page.wait_for_timeout(600)
    check(state()['filename'] == 'dropped.wav' and not submit.is_disabled(), 'A record dropped during a download supersedes it')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')
    pastes(page, state, modal, load, future, held)
    recents(page, modal, load, posted)
    page.unroute('**/api/youtube')


PASTE = '''([text, selector]) => {
  const data = new DataTransfer(); data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true});
  document.querySelector(selector).dispatchEvent(event);
  return event.defaultPrevented;
}'''


def pastes(page, state, modal, load, future, held):
    """Paste button (clipboard), paste into the field and paste anywhere on the page."""
    status = page.locator('#youtube-status')
    submit = page.locator('#youtube-submit')
    url = page.locator('#youtube-url')
    HOLD = 'https://youtu.be/session?si=hold'  # The mock holds links ending in '=hold'.
    paste = lambda text, selector='body': page.evaluate(PASTE, [text, selector])
    page.context.grant_permissions(['clipboard-read', 'clipboard-write'], origin='http://127.0.0.1:42069')
    first = len(held)
    clipboard = lambda text: page.evaluate('text => navigator.clipboard.writeText(text)', text)
    load.click(); future.click(); url.fill('')
    check(submit.inner_text() == 'Paste' and not submit.is_disabled(), 'An empty link field offers a Paste button')
    url.focus(); page.keyboard.type('y')
    check(submit.inner_text() == 'Put it on', 'Typing in the link field turns Paste into Put it on')
    url.fill(''); before = state()
    clipboard('just some words'); submit.click()
    page.wait_for_function("document.querySelector('#youtube-status').classList.contains('error')")
    check(url.input_value() == '' and modal.is_visible() and state() == before and 'copy' in status.inner_text().lower(), 'Paste with no YouTube link on the clipboard explains itself and changes nothing')
    clipboard(HOLD); submit.click()
    page.wait_for_function('document.querySelector("#youtube-submit").disabled')
    check(url.input_value() == HOLD and submit.inner_text() == 'Fetching…', 'Paste reads the clipboard link and starts fetching at once')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')
    load.click(); future.click(); url.fill('https://www.youtube.com/watch?v=stale')
    check(paste(HOLD, '#youtube-url') and url.input_value() == HOLD and submit.is_disabled(), 'Pasting a link into the field replaces it and starts fetching without another click')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')
    check(not paste('not a link') and not paste('https://www.youtube.com/watch?v=x and more') and not modal.is_visible(), 'Ordinary pastes on the page are left alone')
    page.locator('#help-open').click(); page.locator('#help').wait_for(state='visible')
    check(not paste(HOLD, '#help') and not modal.is_visible(), 'Another open panel keeps its own paste')
    page.keyboard.press('Escape'); page.wait_for_function("!document.querySelector('#help').open")
    check(paste(HOLD) and modal.is_visible() and page.locator('#youtube-form').is_visible() and submit.is_disabled() and url.input_value() == HOLD, 'Pasting a YouTube link anywhere opens the chooser and starts fetching')
    # Pasting again the moment the chooser closes replaces the abandoned download.
    reopened = page.evaluate(f"args => {{ document.querySelector('#media-source-close').click(); return ({PASTE})(args); }}", ['https://youtu.be/success', 'body'])
    check(reopened and modal.is_visible(), 'A paste right after closing reopens the chooser with the new link')
    modal.wait_for(state='hidden')
    page.wait_for_function("turntable.state.recordPhase === 'ready' && turntable.state.filename === 'Mocked Session - Live.m4a'")
    load.click(); future.click()
    check(url.input_value() == '' and submit.inner_text() == 'Paste', 'A record put on by pasting leaves the field clear for the next link')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')
    for route in held[first:]: route.abort()


def recents(page, modal, load, posted):
    """Recent links: played videos, newest first, one per video, kept in this browser."""
    section = page.locator('#recent-links')
    rows = lambda: page.locator('#recent-list .recent-play').evaluate_all('nodes => nodes.map(node => [node.querySelector(".recent-name").textContent, node.querySelector("small").textContent])')
    paste = lambda text: page.evaluate(PASTE, [text, 'body'])
    load.click()
    check(section.is_visible() and rows() == [['Mocked Session - Live', '3:19']], 'Played links appear under Recent links with title and length, once per video')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')
    paste('https://www.youtube.com/watch?v=second1&si=tracking'); modal.wait_for(state='hidden')
    page.wait_for_function("turntable.state.recordPhase === 'ready' && turntable.state.filename === 'Video second1.m4a'")
    load.click()
    check([name for name, _ in rows()] == ['Video second1', 'Mocked Session - Live'], 'The newest link comes first')
    page.locator('#recent-list .recent-play').nth(1).click(); modal.wait_for(state='hidden')
    page.wait_for_function("turntable.state.recordPhase === 'ready' && turntable.state.filename === 'Mocked Session - Live.m4a'")
    check(posted[-1] == 'https://www.youtube.com/watch?v=success', 'A recent link puts its video on again through the same download')
    load.click()
    check([name for name, _ in rows()] == ['Mocked Session - Live', 'Video second1'], 'Playing a recent link moves it back to the top')
    page.locator('#recent-list .recent-forget').first.click()
    check([name for name, _ in rows()] == ['Video second1'] and page.evaluate("document.activeElement.classList.contains('recent-forget')"), 'Forgetting a link removes only it and keeps focus in the list')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')
    page.reload(); page.wait_for_function("window.turntable && !document.querySelector('#source-youtube').disabled")
    load.click()
    check([name for name, _ in rows()] == ['Video second1'], 'Recent links survive a reload in this browser')
    page.locator('#recent-list .recent-forget').first.click()
    check(section.is_hidden() and page.evaluate("document.activeElement.id") == 'source-youtube', 'Forgetting the last link hides the list and returns focus to the YouTube option')
    page.keyboard.press('Escape'); modal.wait_for(state='hidden')


def run():
    out = ROOT / 'artifacts/media-sources'
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = launch_browser(p)
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
        page.wait_for_function("!document.querySelector('#source-youtube').disabled")
        check(future.is_enabled() and 'paste a link' in future.inner_text().lower() and future.get_attribute('aria-expanded') == 'false', 'The local server enables the YouTube link source')
        check(not page.locator('#youtube-form').is_visible() and page.locator('iframe').count() == 0, 'The link form stays collapsed until chosen, with no embedded player')
        focused = []
        for _ in range(8):
            page.keyboard.press('Tab')
            focused.append(page.evaluate('document.activeElement.id'))
        check('source-youtube' in focused and 'youtube-url' not in focused, 'Keyboard reaches the YouTube source but not its collapsed form')
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
            check(future.is_visible() and future.is_enabled() and page.locator('#source-local').bounding_box()['height'] >= 44, f'{name}: local choice stays touch-friendly and the YouTube source is available')
            future.click(); page.locator('#youtube-url').wait_for(state='visible')
            page.wait_for_function("!document.querySelector('#media-source').getAnimations({subtree: true}).length")
            box = modal.bounding_box(); row = page.locator('.youtube-row').bounding_box()
            check(box['y'] + box['height'] <= height and row['x'] + row['width'] <= box['x'] + box['width'] and page.locator('#youtube-submit').bounding_box()['height'] >= 44, f'{name}: the open link form fits the dialog with a touch-friendly button')
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
        check(page.evaluate("typeof window.YT === 'undefined' && !('loadYouTube' in turntable.controls)"), 'YouTube audio uses the shared load command, not an embedded player or separate command')
        youtube_links(page, state, modal, load, future, ready, out)
        external = [url for url in requests if urlsplit(url).scheme in ('http', 'https') and urlsplit(url).hostname not in ('127.0.0.1', 'localhost')]
        check(not external, 'The complete loading flow, including mocked links, makes no external requests from the browser')
        check(not errors, 'No browser exceptions in local source selection, playback, drop, replacement or links')
        static = browser.new_page(viewport={'width': 1440, 'height': 1000})
        static.route('**/api/youtube', lambda route: route.fulfill(status=404, body='Not Found'))
        static.goto('http://127.0.0.1:42069/'); static.wait_for_function('window.turntable'); static.wait_for_timeout(300)
        static.locator('#load').click()
        option = static.locator('#source-youtube')
        check(option.is_disabled() and 'run the studio yourself' in option.inner_text().lower() and not static.locator('#youtube-form').is_visible(), 'A static host (no server API) keeps YouTube links visibly unavailable')
        static.evaluate("localStorage.setItem('vhs-recent-links', JSON.stringify([{url: 'https://www.youtube.com/watch?v=abcdefg', title: 'Left over', duration: 60}]))")
        static.reload(); static.wait_for_function('window.turntable'); static.wait_for_timeout(300); static.locator('#load').click()
        check(static.locator('#recent-links').is_hidden(), 'A static host never offers recent YouTube links')
        static.keyboard.press('Escape'); static.locator('#media-source').wait_for(state='hidden')
        check(not static.evaluate(PASTE, ['https://youtu.be/x', 'body']) and not static.locator('#media-source').is_visible(), 'A static host ignores pasted YouTube links')
        browser.close()
    (out / 'checks.json').write_text(json.dumps({'checks': checks, 'action_transitions': {'first_load': initial_load, 'replacement': replacement, 'eject': ejection, 'mobile_loading': mobile_loading}, 'action_geometry': layout_audit}, indent=2) + '\n')
    print(f'All {len(checks)} local media-source checks passed.', flush=True)


if __name__ == '__main__':
    run()
