"""Rendered chassis branding and permanent-hardware stability across media lifecycles.

Run against the local app on port 42069. Pixel checks use Chromium to decode its
own screenshots, so this suite needs no image-library dependency.
"""
import base64
import json
import math
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW

checks = []


def check(condition, message):
    assert condition, message
    checks.append(message)
    print(f'PASS {message}', flush=True)


def run():
    artifacts = ROOT / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1600}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        check(page.title() == 'Virtual Home Studio' and 'VIRTUAL HOME STUDIO' in page.locator('.brand').inner_text(),
              'Public page title and header share the fictional studio identity')
        check(page.locator('#chassis-brand').get_attribute('aria-label') == 'Virtual Home Studio VHS-42069'
              and 'VHS-42069' in page.locator('#chassis-brand').text_content(),
              'Printed chassis and accessible name identify the fictional VHS-42069')
        check('VIRTUAL HOME STUDIO' in page.locator('#mat-brand').text_content()
              and 'VIRTUAL HOME STUDIO' in page.locator('#record-label').text_content(),
              'Slipmat and record label use the public studio branding')
        logo = '/static/assets/virtual-home-studio-logo.svg'
        check(page.locator(f'use[href="{logo}#disc"]').count() == 4,
              'Header, slipmat, headshell and chassis reuse one original disc mark')
        check(page.locator('link[rel="icon"]').get_attribute('href') == logo
              and page.request.get('http://127.0.0.1:42069' + logo).status == 200,
              'The same project-owned SVG serves the favicon without external assets')
        page.evaluate('''() => {
          const ids = ['chassis-brand', 'tonearm-base', 'rpm-78', 'start-stop', 'rpm-33',
            'rpm-45', 'power', 'pitch-range', 'target-light', 'strobe-dots', 'spindle', 'mat-brand'];
          const nodes = ids.map(id => document.getElementById(id));
          window.brandAudit = {frames: 0, phases: {}, violations: [], pixelSamples: []};
          const initialBrand = nodes[0].getBoundingClientRect();
          function sample() {
            const audit = window.brandAudit, phase = turntable.state.recordPhase;
            audit.frames++; audit.phases[phase] = (audit.phases[phase] || 0) + 1;
            nodes.forEach((node, index) => {
              if (document.getElementById(ids[index]) !== node)
                audit.violations.push({phase, id: ids[index], problem: 'node replaced'});
              for (let parent = node; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) < .999)
                  audit.violations.push({phase, id: ids[index], problem: 'hidden or faded', ancestor: parent.id});
              }
            });
            const brand = nodes[0].getBoundingClientRect();
            if (['x', 'y', 'width', 'height'].some(key => Math.abs(brand[key] - initialBrand[key]) > .01))
              audit.violations.push({phase, id: 'chassis-brand', problem: 'moved'});
            window.brandFrame = requestAnimationFrame(sample);
          }
          sample();
          window.decodeBrandPixels = async data => {
            const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
            const canvas = document.createElement('canvas');canvas.width = image.width;canvas.height = image.height;
            const ctx = canvas.getContext('2d');ctx.drawImage(image, 0, 0);image.close();
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          };
        }''')
        check(page.evaluate('''() => {
          const media = document.getElementById('record-lift');
          return ['chassis-brand', 'tonearm-base', 'rpm-78', 'power', 'pitch-range',
            'target-light', 'strobe-dots', 'spindle', 'mat-brand']
            .every(id => !media.contains(document.getElementById(id)))
            && ['vinyl-body', 'grooves', 'record-label', 'record-wear']
            .every(id => media.contains(document.getElementById(id)));
        }'''), 'Permanent branding and hardware are outside the removable-record layer')
        bounds = page.locator('#chassis-brand').bounding_box()
        clip = {'x': math.floor(bounds['x']) - 2, 'y': math.floor(bounds['y']) - 2,
                'width': math.ceil(bounds['width']) + 5, 'height': math.ceil(bounds['height']) + 5}
        initial = page.screenshot(clip=clip, path=str(artifacts / 'branding-empty.png'))
        page.evaluate('async data => {window.brandBaseline = await decodeBrandPixels(data)}',
                      base64.b64encode(initial).decode())

        def screenshot(name, deck=False):
            data = page.screenshot(clip=clip, path=str(artifacts / f'branding-{name}.png'))
            result = page.evaluate('''async ([name, encoded]) => {
              const image = await decodeBrandPixels(encoded), baseline = window.brandBaseline;
              let total = 0, max = 0, ink = 0, initialInk = 0;
              for (let i = 0; i < image.length; i += 4) {
                for (let c = 0; c < 3; c++) {
                  const difference = Math.abs(image[i+c] - baseline[i+c]);
                  max = Math.max(max, difference);
                }
                const luminance = .2126*image[i]+.7152*image[i+1]+.0722*image[i+2];
                const initial = .2126*baseline[i]+.7152*baseline[i+1]+.0722*baseline[i+2];
                total += Math.abs(luminance-initial);
                ink += Math.max(0,170-luminance);initialInk += Math.max(0,170-initial);
              }
              const result = {name, meanDifference:total/(image.length/4), maxDifference:max,
                visibleInk:ink/initialInk, phase:turntable.state.recordPhase};
              brandAudit.pixelSamples.push(result);return result;
            }''', [name, base64.b64encode(data).decode()])
            # Chromium switches between grayscale and subpixel text antialiasing
            # as adjacent SVG content is composited. Compare luminance and retained
            # printed ink rather than requiring identical colored edge pixels.
            check(result['meanDifference'] < 3 and .97 <= result['visibleInk'] <= 1.08,
                  f'Chassis logo and model retain their rendered pixels: {name}')
            if deck:
                page.locator('#deck').screenshot(path=str(artifacts / f'branding-deck-{name}.png'))

        def phase(value):
            page.wait_for_function('value => turntable.state.recordPhase === value', arg=value)

        def motion(kind, cycle):
            phase('inserting' if kind == 'insert' else 'ejecting')
            page.wait_for_function("document.getElementById('record-lift').getAnimations().length > 0")
            page.evaluate("document.getAnimations().forEach(animation => animation.pause())")
            try:
                for part in [0, .25, .5, .75, .98]:
                    page.evaluate('part => document.getAnimations().forEach(animation => '
                                  'animation.currentTime = part * animation.effect.getTiming().duration)', part)
                    screenshot(f'{cycle}-{kind}-{int(part*100)}', deck=part == .5)
                    check(page.locator('#mat-brand').evaluate("node => getComputedStyle(node).display !== 'none'"),
                          f'Slipmat print stays underneath the moving vinyl: {cycle}-{kind}-{int(part*100)}')
            finally:
                page.evaluate("document.getAnimations().forEach(animation => animation.play())")

        screenshot('fresh')
        page.locator('#file-input').set_input_files(RAW)
        motion('insert', 1);phase('ready');screenshot('loaded', deck=True)
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase !== 'idle'")
        screenshot('assisted-play')
        page.wait_for_function("turntable.state.assistPhase === 'idle' && turntable.state.position > .05")
        screenshot('playback')
        page.locator('#transport').click();page.wait_for_function('turntable.state.transportPaused')
        screenshot('paused')
        page.locator('#transport').click()
        page.locator('#vinyl-hit-area').focus();page.keyboard.down('ArrowLeft')
        page.wait_for_function('turntable.state.scratching');screenshot('scratching')
        page.keyboard.up('ArrowLeft')
        page.evaluate('turntable.controls.seek(1)')
        page.wait_for_function("!turntable.state.seeking && turntable.state.grooveRegion === 'run-out'")
        screenshot('run-out')
        page.locator('#eject').click();motion('eject', 1);phase('empty');screenshot('empty-again', deck=True)

        # Repeat insertion/ejection, then exercise both direct file replacement
        # and the chooser-first Replace Record action exposed by the HUD.
        page.locator('#file-input').set_input_files(RAW)
        motion('insert', 2);phase('ready')
        page.locator('#file-input').set_input_files(RAW)
        motion('eject', 'direct-replace');motion('insert', 'direct-replace');phase('ready')
        screenshot('replaced')
        with page.expect_file_chooser() as chooser:
            page.locator('#load').click()
        check(page.evaluate("turntable.state.recordPresent && turntable.state.recordPhase === 'ready'"),
              'Replace opens the chooser while the current record remains seated')
        screenshot('replace-choosing-file')
        chooser.value.set_files(RAW)
        motion('eject', 'hud-replace');motion('insert', 'hud-replace');phase('ready');screenshot('replace-ready')
        page.locator('#eject').click();motion('eject', 3);phase('empty');screenshot('final-empty')
        audit = page.evaluate('''() => {cancelAnimationFrame(window.brandFrame);return brandAudit}''')
        check(audit['frames'] > 100, 'Permanent hardware visibility is sampled on every animation frame')
        check(all(audit['phases'].get(value, 0) for value in ['empty', 'loading', 'inserting', 'ready', 'ejecting']),
              'Frame audit covers every record lifecycle phase')
        check(not audit['violations'], f"No permanent component disappears, fades, moves unexpectedly, or is recreated ({audit['frames']} frames): {audit['violations'][:3]}")
        check(page.evaluate("document.querySelector('#record-lift').getAnimations().length === 0"),
              'Completed lifecycle animations release their effects')
        check(not errors, 'No browser exceptions during repeated branding lifecycle tests')
        (artifacts / 'branding.json').write_text(json.dumps({'result': 'passed', 'total': len(checks),
                                                           'checks': checks, 'audit': audit}, indent=2) + '\n')
        browser.close()
        print(f'All {len(checks)} branding checks passed.')


if __name__ == '__main__':
    run()
