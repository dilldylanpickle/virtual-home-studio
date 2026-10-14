"""Visible native branding and permanent-mesh stability through media lifecycles.

Uses the real canvas renderer's gated frozen-pose counterfactuals. Hardware text
may receive changing physical shadows, so compare the print's presence in each
pose instead of requiring identical brightness across unrelated poses.
"""
import json
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW
from studio_helpers import launch_browser
from occlusion import open_native, phase, set_motion_frame, resume_motion, native_sample

checks = []


def check(condition, message):
    assert condition, message
    checks.append(message)
    print(f'PASS {message}', flush=True)


def run():
    artifacts = ROOT / 'artifacts'; artifacts.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page(viewport={'width': 1440, 'height': 1600}, device_scale_factor=1)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        open_native(page)
        check(page.title() == 'Virtual Home Studio' and 'VIRTUAL HOME STUDIO' in page.locator('.brand').inner_text(),
              'Page title and header share the fictional studio identity')
        check(page.locator('#chassis-brand').get_attribute('aria-label') == 'Virtual Home Studio VHS-42069'
              and 'VHS-42069' in page.locator('#chassis-brand').text_content(),
              'Accessible physical controls retain the fictional VHS-42069 identity')
        check('VIRTUAL HOME STUDIO' in page.locator('#mat-brand').text_content()
              and 'VIRTUAL HOME STUDIO' in page.locator('#record-label').text_content(),
              'Slipmat and record label retain the public studio branding')
        check(page.locator('use[href$="virtual-home-studio-logo.svg#disc"]').count() == 4,
              'Header and canonical control surface retain the shared original disc mark')
        favicon = page.locator('link[rel="icon"]').evaluate('node=>node.href')
        check(favicon.endswith('/static/assets/virtual-home-studio-logo.svg') and page.request.get(favicon).status == 200,
              'The project-owned favicon resolves through document-relative hosting paths')
        check(page.evaluate('''() => {
          const objects=studioView.snapshot({bounds:false}).objects;
          return ['vhs-lettering','vhs-frontPrint','vhs-slipmatPrint','vhs-spindle','vhs-spindleTip']
            .every(name=>objects[name]?.effectiveVisible&&!objects[name].removableMedia)
            && ['vhs-vinylBody','vhs-vinylSurface','vhs-label','vhs-wear']
            .every(name=>objects[name]?.removableMedia);
        }'''), 'Native chassis/slipmat print and permanent spindle are outside removable media')
        page.evaluate('''() => {
          window.brandAudit={frames:0,phases:{},violations:[],pixelSamples:[]};
          const tick=()=>{
            const phase=turntable.state.recordPhase;
            brandAudit.frames++;brandAudit.phases[phase]=(brandAudit.phases[phase]||0)+1;
            if(!nativeHardwareCheck()&&brandAudit.violations.length<10) brandAudit.violations.push({phase,frame:brandAudit.frames});
            window.brandFrame=requestAnimationFrame(tick);
          };tick();
        }''')

        def screenshot(name):
            sample = native_sample(page, 'without-chassis-print', 'Black', artifacts / f'branding-{name}.png')
            page.evaluate('(sample)=>brandAudit.pixelSamples.push(sample)', {'name': name, **sample})
            check(sample['dynamicRange'] > 40 and sample['visiblePixels'] > 20,
                  f'Actual native chassis identity remains visibly printed in this pose: {name}')
            check(sample['hardware'], f'Permanent native hardware stays present and unchanged: {name}')

        def motion(kind, cycle):
            phase(page, 'inserting' if kind == 'insert' else 'ejecting')
            page.wait_for_function("document.getElementById('record-lift').getAnimations().length>0")
            duration = page.evaluate("document.getElementById('record-lift').getAnimations()[0].effect.getTiming().duration")
            check(100 < duration < 2000, f'{cycle}-{kind}: production lifecycle animation remains active')
            try:
                for progress in [0, .25, .5, .75, 1]:
                    set_motion_frame(page, progress)
                    screenshot(f'{cycle}-{kind}-{int(progress*100)}')
                    check(page.evaluate("studioView.snapshot({bounds:false}).objects['vhs-slipmatPrint'].effectiveVisible"),
                          f'Slipmat print remains permanent beneath moving media: {cycle}-{kind}-{int(progress*100)}')
            finally:
                resume_motion(page)
            # Replacement serializes directly into insertion without an idle
            # empty phase; only a standalone eject settles at empty.
            next_phase = 'ready' if kind == 'insert' else 'inserting' if cycle in ['direct-replace', 'hud-replace'] else 'empty'
            phase(page, next_phase)

        screenshot('fresh')
        empty_print = native_sample(page, 'without-slipmat-print', 'Black')
        check(empty_print['visiblePixels'] > 50, 'Empty native platter visibly carries the original slipmat print')
        page.locator('#file-input').set_input_files(RAW)
        motion('insert', 1); screenshot('loaded')
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.assistPhase!=='idle'")
        screenshot('assisted-play')
        page.wait_for_function("turntable.state.assistPhase==='idle'&&turntable.state.position>.05")
        screenshot('playback')
        page.evaluate('turntable.controls.pause()'); page.wait_for_function('turntable.state.transportPaused')
        screenshot('paused')
        page.locator('#vinyl-hit-area').focus(); page.keyboard.down('ArrowLeft')
        page.wait_for_function('turntable.state.scratching'); screenshot('scratching'); page.keyboard.up('ArrowLeft')
        page.evaluate('turntable.controls.seek(1)')
        page.wait_for_function("!turntable.state.seeking&&turntable.state.grooveRegion==='run-out'")
        screenshot('run-out')
        page.locator('#eject').click(); motion('eject', 1); screenshot('empty-again')

        page.locator('#file-input').set_input_files(RAW); motion('insert', 2)
        page.locator('#file-input').set_input_files(RAW)
        motion('eject', 'direct-replace'); motion('insert', 'direct-replace'); screenshot('replaced')
        with page.expect_file_chooser() as chooser:
            page.locator('#load').click(); page.locator('#source-local').click()
        check(page.evaluate("turntable.state.recordPresent&&turntable.state.recordPhase==='ready'"),
              'Replace opens the chooser while the existing native record remains seated')
        screenshot('replace-choosing-file')
        chooser.value.set_files(RAW)
        motion('eject', 'hud-replace'); motion('insert', 'hud-replace'); screenshot('replace-ready')
        page.locator('#eject').click(); motion('eject', 3); screenshot('final-empty')
        audit = page.evaluate('''()=>{cancelAnimationFrame(window.brandFrame);return brandAudit}''')
        check(audit['frames'] > 100, 'Permanent native hardware is sampled across animation frames')
        check(all(audit['phases'].get(value, 0) for value in ['empty', 'loading', 'inserting', 'ready', 'ejecting']),
              'Native frame audit covers every record lifecycle phase')
        check(not audit['violations'], f'Permanent meshes keep their IDs, local transforms, materials and visible ancestry: {audit["violations"][:3]}')
        check(page.evaluate("document.querySelector('#record-lift').getAnimations().length===0"),
              'Completed native lifecycle presentation releases shared animation effects')
        check(not errors, f'No browser exceptions during repeated native branding tests: {errors}')
        (artifacts / 'branding.json').write_text(json.dumps({'result': 'passed', 'total': len(checks), 'checks': checks, 'audit': audit}, indent=2) + '\n')
        browser.close()
    print(f'All {len(checks)} native branding checks passed.')


if __name__ == '__main__':
    run()
