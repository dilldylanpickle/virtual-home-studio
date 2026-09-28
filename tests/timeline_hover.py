"""Real-pointer checks for the independent timeline preview and gesture semantics."""
import json
from playwright.sync_api import sync_playwright
from acceptance import ROOT
from audio_fixtures import generated_long_record

checks = []


def check(ok, message, **details):
    assert ok, f'{message}: {details}'
    checks.append({'check': message, **details})
    print('PASS ' + message, flush=True)


def run():
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    with generated_long_record() as record, sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1450})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        page.locator('#file-input').set_input_files(record)
        page.wait_for_function("turntable.state.recordPhase === 'ready'", timeout=90000)
        state = lambda: page.evaluate('turntable.state')
        progress = page.locator('#groove-progress')
        preview = page.locator('.timeline-preview')
        marker = page.locator('.timeline-preview-marker')
        label = page.locator('.timeline-preview-time')
        progress.scroll_into_view_if_needed()

        def point(fraction, offset=0):
            r = progress.bounding_box()
            return (r['x'] + 5 + fraction * (r['width'] - 10), r['y'] + r['height'] / 2 + offset)

        def hover(fraction, offset=0):
            page.mouse.move(*point(fraction, offset))
            return label.text_content()

        def seek(fraction):
            page.evaluate('f => turntable.controls.seek(f)', fraction)
            page.wait_for_function('!turntable.state.seeking')

        def expected_time(fraction):
            whole = int(fraction * state()['duration'])
            minutes = f'{whole // 60 % 60:02d}:{whole % 60:02d}'
            return f'{whole // 3600}:{minutes}' if whole >= 3600 else minutes

        page.evaluate('turntable.controls.pause()')
        seek(.1)
        paused = state()
        check(progress.bounding_box()['height'] >= 28, 'Timeline preserves its generous 28px invisible hit region')
        check(progress.get_attribute('title') is None and label.get_attribute('title') is None,
              'Hover timestamp uses custom UI without a browser title tooltip')
        for fraction in [.25, .5, .75]:
            timestamp = hover(fraction)
            rectangle = marker.bounding_box()
            check(abs(rectangle['x'] + rectangle['width'] / 2 - point(fraction)[0]) < .6,
                  f'{fraction:.0%} hover marker follows the pointer immediately')
            check(timestamp == expected_time(fraction), f'{fraction:.0%} hover timestamp matches the click target', timestamp=timestamp)
            current = state()
            check(current['position'] == paused['position'] and current['tonearmAngle'] == paused['tonearmAngle']
                  and current['transportPaused'] and not current['seeking'] and not current['directScrubbing'],
                  f'{fraction:.0%} hover leaves paused playback and physical arm untouched')
            check(progress.evaluate('el => getComputedStyle(el).cursor') == 'pointer',
                  f'{fraction:.0%} hover has the standard pointer cursor')
        page.wait_for_timeout(140)
        check(preview.evaluate('el => Number(getComputedStyle(el).opacity)') == 1, 'Preview fades fully into view')
        transition = preview.evaluate('el => ({property:getComputedStyle(el).transitionProperty,duration:getComputedStyle(el).transitionDuration})')
        check(transition == {'property': 'opacity', 'duration': '0.11s'},
              'Only preview opacity transitions, over 110ms; positions never ease', transition=transition)
        rect = label.bounding_box()
        check(rect['y'] + rect['height'] < point(.75)[1] - 5, 'Compact preview timestamp floats above the visible track')
        page.screenshot(path=ROOT / 'artifacts/timeline-hover-desktop.png', full_page=True)
        hover(.5, 11)
        check(preview.get_attribute('data-visible') == 'true', 'Hover activates throughout the invisible vertical hit region')
        page.mouse.move(10, 10)
        page.wait_for_timeout(140)
        check(preview.evaluate('el => Number(getComputedStyle(el).opacity)') == 0, 'Pointer leave fades the preview away')

        # Click keeps the brief physical sweep and uses the exact preview mapping.
        timestamp = hover(.65)
        page.evaluate("""() => {
          window.__hoverClickFrames=[]; window.__hoverCapture=true;
          const frame=()=>{if(!__hoverCapture)return;const s=turntable.state;
            __hoverClickFrames.push({at:performance.now(),seeking:s.seeking,p:s.grooveProgress});requestAnimationFrame(frame)};
          requestAnimationFrame(frame);
        }""")
        page.mouse.click(*point(.65))
        page.wait_for_function('!turntable.state.seeking')
        frames = page.evaluate('__hoverCapture=false; __hoverClickFrames')
        traversing = [f for f in frames if f['seeking']]
        check(len(traversing) >= 3 and traversing[-1]['at'] - traversing[0]['at'] <= 470,
              'Clicking a hover target retains a brief physical traversal', frames=len(traversing))
        check(abs(state()['grooveProgress'] - .65) < .001 and timestamp == expected_time(.65),
              'Click settles at the exact timestamp and marker preview target')
        check(state()['transportPaused'], 'Click seeking preserves paused intent')

        # Direct drag keeps the pointer authoritative and has no progress status.
        page.mouse.move(*point(state()['grooveProgress']))
        page.mouse.down()
        page.wait_for_function('turntable.state.directScrubbing')
        check(progress.evaluate('el => getComputedStyle(el).cursor') == 'grabbing', 'Active direct dragging uses a grabbing cursor')
        for fraction in [.31, .81, .41]:
            hover(fraction)
            page.evaluate('() => new Promise(requestAnimationFrame)')
            current = state()
            check(abs(current['grooveProgress'] - fraction) < .001 and not current['seeking'],
                  f'{fraction:.0%} drag updates the actual groove immediately without a click sweep')
            check(label.text_content() == expected_time(fraction) and page.locator('#transport-hint').text_content() == '',
                  f'{fraction:.0%} drag follows with the preview time and no asynchronous status message', timestamp=label.text_content(), expected=expected_time(fraction), hint=page.locator('#transport-hint').text_content())
        page.mouse.up()
        page.wait_for_function('!turntable.state.directScrubbing')
        check(progress.evaluate('el => getComputedStyle(el).cursor') == 'pointer' and state()['transportPaused'],
              'Release restores the pointer cursor and preserves paused intent')

        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase === 'idle' && turntable.state.stylusContact && !turntable.state.transportPaused")
        hover(.75)
        playing = state()
        marker_before = marker.bounding_box()
        timestamp = label.text_content()
        page.wait_for_timeout(420)
        current = state()
        check(current['position'] > playing['position'] + .2 and not current['seeking'] and not current['directScrubbing'],
              'Playback continues normally while the timeline is hovered')
        check(label.text_content() == timestamp and marker.bounding_box() == marker_before,
              'Hover preview stays fixed under the pointer while actual playback moves')

        page.evaluate('turntable.controls.pause()')
        page.set_viewport_size({'width': 390, 'height': 950})
        progress.scroll_into_view_if_needed()
        for fraction in [0, 1]:
            hover(fraction)
            rect = label.bounding_box()
            container = page.locator('.timeline-control').bounding_box()
            check(rect['x'] >= container['x'] - .1 and rect['x'] + rect['width'] <= container['x'] + container['width'] + .1,
                  f'{fraction:.0%} mobile hover label stays inside its track bounds')
        page.wait_for_timeout(140)
        page.screenshot(path=ROOT / 'artifacts/timeline-hover-mobile.png', full_page=True)
        check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Hover preview introduces no mobile horizontal overflow')

        page.evaluate('turntable.controls.eject()')
        page.wait_for_function("turntable.state.recordPhase === 'empty'")
        check(preview.get_attribute('data-visible') == 'false' and progress.is_disabled(),
              'Record removal clears preview and disables timeline interaction')
        check(not errors, 'No browser errors during hover, click, drag, resize or ejection', errors=errors)
        browser.close()
        (ROOT / 'artifacts/timeline-hover.json').write_text(json.dumps({'result': 'passed', 'total': len(checks), 'checks': checks}, indent=2) + '\n')
        print(f'PASS {len(checks)} timeline hover browser checks', flush=True)


if __name__ == '__main__':
    run()
