"""Photographic plate composite: placement, camera calibration, grounding and print sharpness.

Replaces the procedural-room depth suite. Run against the local server with
``VHS_TEST_GPU=1 uv run --group dev python tests/studio_plate.py``.
"""
import base64
import json

from playwright.sync_api import sync_playwright
from studio_helpers import launch_browser
from acceptance import ROOT, RAW

OUT = ROOT / 'artifacts/studio-plate'
URL = 'http://127.0.0.1:42069/?studioDiagnostics=1'
checks = []


def check(ok, message, **details):
    checks.append({'passed': bool(ok), 'check': message, **details})
    print(('PASS ' if ok else 'FAIL ') + message + ('' if ok else f': {details}'), flush=True)


# Calibration expectations, independent of the app's implementation: the speaker front
# is 187/2000 of the plate width, the table's depth lines meet at the top-centre of the
# plate, and the table spot between the speakers is at (0.5, ~0.655) of the plate.
GEOMETRY = r'''() => {
  const s = studioView.snapshot({bounds:false}), plate = s.plate, hud = document.getElementById('listening-hud').getBoundingClientRect();
  const P = (x, y, z) => studioView.projectPoint('vhs-turntable', [x, y, z]);
  // Two table-plane lines along depth; their intersection is the depth vanishing point.
  const line = x => [P(x, 0, -20), P(x, 0, 1)];
  const intersect = ([a, b], [c, d]) => {
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / ((b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x));
    return {x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y)};
  };
  const vp = intersect(line(-1), line(1));
  const corners = [[-.5,0,-.4],[.5,0,-.4],[-.5,0,.4],[.5,0,.4],[-.5,.11,.4],[.5,.11,.4]].map(p => P(...p));
  const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
  const img = document.getElementById('studio-plate'), r = img.getBoundingClientRect();
  return {plate, vp: {x: (vp.x - plate.x) / plate.width, y: (vp.y - plate.y) / plate.height},
    deck: {left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys)},
    centre: P(0, 0, 0), hudTop: hud.top, image: [r.x, r.y, r.width, r.height], source: img.currentSrc,
    viewport: [innerWidth, innerHeight], size: s.size};
}'''


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {}
    with sync_playwright() as p:
        browser = launch_browser(p)
        requests, errors = [], []

        def page_for(width, height, scale=1):
            context = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=scale)
            page = context.new_page()
            page.on('request', lambda request: requests.append(request.url))
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
            page.goto(URL)
            page.wait_for_function('window.studioView?.snapshot().ready && studioView.snapshot({bounds:false}).frameId > 0', timeout=30000)
            page.wait_for_function("document.getElementById('studio-plate').complete")
            return page

        for width, height, scale, label in [(2000, 1200, 1, 'desktop'), (1440, 900, 2, 'laptop-2x'), (2560, 1080, 1, 'ultrawide'),
                                            (1024, 900, 1, 'tablet'), (390, 844, 1, 'phone'), (844, 390, 1, 'phone-landscape')]:
            page = page_for(width, height, scale)
            g = page.evaluate(GEOMETRY); report[label] = g
            plate, deck = g['plate'], g['deck']
            check(abs(g['image'][0] - plate['x']) < 1 and abs(g['image'][2] - plate['width']) < 1 and abs(g['image'][3] - plate['height']) < 1,
                  f'{label}: the displayed plate and the camera share one placement', image=g['image'], plate=plate)
            check(plate['x'] <= .5 and plate['x'] + plate['width'] >= width - .5 and plate['y'] <= .5,
                  f'{label}: the plate covers the sides and top of the stage', plate=plate)
            check(abs(g['vp']['x'] - .5) < .01 and abs(g['vp']['y'] - 0) < .01,
                  f'{label}: table depth lines meet at the plate\'s measured vanishing point', vp=g['vp'])
            anchor = {'x': (g['centre']['x'] - plate['x']) / plate['width'], 'y': (g['centre']['y'] - plate['y']) / plate['height']}
            check(abs(anchor['x'] - .5) < .005 and .6 < anchor['y'] < .72,
                  f'{label}: the deck stands on the empty table spot between the speakers', anchor=anchor)
            ratio = (deck['right'] - deck['left']) / (plate['width'] * 187 / 2000)
            check(2 < ratio < 2.6, f'{label}: the deck is a little wider than two speakers side by side', ratio=ratio)
            check(deck['bottom'] < g['hudTop'] - 4 and deck['left'] >= -1 and deck['right'] <= width + 1,
                  f'{label}: the whole deck is visible above the listening panel', deck=deck, hud=g['hudTop'])
            if label in ('desktop', 'laptop-2x', 'ultrawide'):
                # Very wide screens cap the push-in at a reference proportion (height × 1.47).
                share = (deck['right'] - deck['left']) / min(width, height * 1.47)
                check(share > .3, f'{label}: the default view is a close, speaker-framed shot of the deck', share=share)
            # srcset `sizes` follows the plate's rendered width: the smallest derivative that
            # covers it at the device pixel ratio, else the largest.
            need = plate['width'] * scale
            expected = next((name for name, w in [('studio-plate-mobile.webp', 1600), ('studio-plate.webp', 3200), ('studio-plate-xl.webp', 5600)] if w >= need), 'studio-plate-xl.webp')
            check(g['source'].endswith(expected), f'{label}: the browser selects the {expected} derivative', source=g['source'])
            check(abs(g['size']['pixelRatio'] - min(scale, 2)) < 1e-6 and g['size']['minimumPixelRatio'] >= min(scale, 1),
                  f'{label}: rendering uses the device pixel ratio and never drops below one device pixel per CSS pixel', size=g['size'])
            page.screenshot(path=OUT / f'{label}.png')
            page.context.close()

        check(not any('docs/source' in url or 'studio-plate-master' in url for url in requests),
              'The unpublished master plate is never requested')

        for width, docked in [(1366, False), (1440, True)]:
            row = page_for(width, 860)
            layout = row.evaluate('''() => { const r = s => document.querySelector(s).getBoundingClientRect(), hud = document.querySelector('#listening-hud');
              return {docked: getComputedStyle(hud).getPropertyValue('--hud-docked').trim() === '1', presetsRight: r('.playback-presets').right, listeningLeft: r('.hud-listening').left,
                presetHeight: r('.preset-toggle').height}; }''')
            check(layout['docked'] == docked and (not docked or (layout['presetsRight'] <= layout['listeningLeft'] and layout['presetHeight'] < 40)),
                  f'{width}px: {"the slim docked row fits without collisions" if docked else "narrower screens keep the full panel"}', **layout)
            row.context.close()

        page = page_for(1600, 1000)
        hud_height = "Math.round(document.querySelector('#listening-hud').getBoundingClientRect().height)"
        heights, lid_states = [page.evaluate(hud_height)], []
        page.locator('#file-input').set_input_files(RAW)
        for _ in range(12):
            heights.append(page.evaluate(hud_height)); page.wait_for_timeout(120)
            lid_states.append(page.evaluate("[turntable.state.recordPhase, turntable.state.coverClosed]"))
        check(len(set(heights)) == 1, 'Loading and seating a record never changes the panel height', heights=sorted(set(heights)))
        page.wait_for_function("turntable.state.recordPhase === 'ready'", timeout=15000)
        page.wait_for_function("studioView.snapshot({bounds:false}).visual.coverOpen === 0", timeout=4000)
        # The lid lifts while the record is handled (and before it moves), then closes over the seated record.
        check(any(phase != 'ready' and not closed for phase, closed in lid_states)
              and all(not closed for phase, closed in lid_states if phase == 'inserting')
              and page.evaluate('turntable.state.coverClosed'),
              'Adding a record in the studio lifts the dust cover, then closes it once the record is seated', samples=lid_states)
        page.wait_for_function("turntable.state.recordPhase==='ready' && studioView.snapshot({bounds:false}).visual.recordPresent", timeout=15000)
        snap = page.evaluate('studioView.snapshot()')
        objects = snap['objects']
        check(snap['composite'] == 'studio plate' and not any(name.startswith(('monitor-', 'window-', 'glass-tabletop', 'wood-floor', 'distant-')) for name in objects),
              'WebGL renders only the turntable and its catchers over the plate')
        check(all(name in objects for name in ['glass-shadow-receiver', 'contact-shadow', 'glass-reflection'])
              and objects['glass-shadow-receiver']['material']['type'] == 'ShadowMaterial' and objects['glass-shadow-receiver']['receiveShadow'],
              'Grounding uses a shadow catcher, a contact shadow and a glass reflection')
        sun = [t - s for t, s in zip(snap['lighting']['sunTarget'], snap['lighting']['sunPosition'])]
        check(sun[0] > 0 and sun[1] < 0, 'Sunlight arrives from the left, as in the plate', direction=sun)

        sheets = {name: value for name, value in objects.items() if name.startswith(('print-sheet-', 'fascia-sheet-'))}
        brand = objects['print-sheet-2']['material']['map'] if 'print-sheet-2' in objects else None
        check(len(sheets) == 5 and all(v['material']['map']['anisotropy'] == snap['maxAnisotropy'] and v['material']['map']['mipmaps'] for v in sheets.values()),
              'Every print sheet is mipmapped with the GPU\'s maximum anisotropy', anisotropy=snap['maxAnisotropy'], sheets=len(sheets))
        check(brand and brand['width'] >= (932 - 772) * 8 * .5,
              'Deck branding is printed at 4× the former texel density', brand=brand)
        fascia = [objects[f'fascia-sheet-{i}']['material']['map'] for i in range(2)]
        check(all(m['height'] >= 320 for m in fascia), 'Front fascia branding is printed at 4× the former texel density', fascia=fascia)

        images = page.evaluate("studioView.capturePass(['beauty', 'without-shadows', 'without-reflections'])")
        for mode, data in images.items():
            (OUT / f'{mode}.png').write_bytes(base64.b64decode(data.split(',', 1)[1]))
        g = page.evaluate(GEOMETRY)
        stats = page.evaluate(r'''async ([images, g]) => {
          const decode = async src => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height); };
          const [beauty, shadowless, mirrorless] = await Promise.all([images.beauty, images['without-shadows'], images['without-reflections']].map(decode));
          const scale = beauty.width / innerWidth, d = g.deck, height = d.bottom - d.top;
          const count = (other, x0, y0, x1, y1) => { let changed = 0, total = 0;
            for (let y = Math.round(y0 * scale); y < Math.round(y1 * scale); y++) for (let x = Math.round(x0 * scale); x < Math.round(x1 * scale); x++) {
              const i = (y * beauty.width + x) * 4; total++; if (Math.abs(beauty.data[i + 3] - other.data[i + 3]) > 6) changed++; }
            return {changed, total}; };
          return {shadowRight: count(shadowless, d.right, d.top, d.right + height * 1.5, d.bottom), contact: count(shadowless, d.left, d.bottom, d.right, d.bottom + height * .15),
            reflection: count(mirrorless, d.left, d.bottom, d.right, d.bottom + height * .5)};
        }''', [images, g])
        check(stats['shadowRight']['changed'] > 200, 'The deck casts a soft sun shadow on the glass to its right', stats=stats['shadowRight'])
        check(stats['contact']['changed'] > 200, 'A contact shadow grounds the deck where it meets the glass', stats=stats['contact'])
        check(stats['reflection']['changed'] > 200, 'A faint reflection of the deck appears in the glass below it', stats=stats['reflection'])

        # Switching to Cinematic must not leave a stale shadow map that darkens the whole catcher.
        page.locator('#turntable-details summary').click()
        page.locator('#studio-quality').select_option('cinematic')
        page.wait_for_timeout(600)
        cinematic = page.evaluate(r'''async () => { const src = studioView.capturePass('beauty'), img = new Image(); img.src = src; await img.decode();
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
          // Alpha far from the deck: the catcher must stay transparent there.
          const d = x.getImageData(Math.round(img.width * .12), Math.round(img.height * .55), 8, 8).data; let a = 0; for (let i = 3; i < d.length; i += 4) a = Math.max(a, d[i]); return a; }''')
        check(cinematic < 20, 'Cinematic quality keeps the shadow catcher clear away from the deck', alpha=cinematic)
        page.locator('#studio-quality').select_option('balanced')
        closed = page.evaluate("[turntable.state.coverClosed, studioView.snapshot({bounds:false}).visual.coverOpen]")
        check(closed == [True, 0], 'The studio view shows the dust cover closed over the deck', lid=closed)
        glass = page.evaluate("(({castShadow, receiveShadow}) => [castShadow, receiveShadow])(studioView.snapshot({bounds:false}).objects['dust-cover-glass'])")
        # VSM renders receivers into the shadow map: a receiving lid left a cached shadow of itself.
        check(glass == [False, False], 'The glass dust cover stays out of the sun shadow map', flags=glass)
        before = page.evaluate("JSON.stringify(turntable.state, ['filename','duration','position','pitch','quartzLock'])")
        hud_rect = "(r => [r.top, r.height, r.width].map(Math.round))(document.querySelector('#listening-hud').getBoundingClientRect())"
        studio_hud = page.evaluate(hud_rect)
        page.locator('#studio-enter').click()
        page.wait_for_function("document.querySelector('#studio').dataset.view==='turntable' && document.querySelector('#studio').dataset.moving==='false'")
        plate_style = page.evaluate("getComputedStyle(document.getElementById('studio-plate')).filter")
        # Close-up docks the panel by default; Hide controls trades it for a fuller deck.
        page.wait_for_timeout(300)
        deck_shown = page.locator('#deck').bounding_box()
        check(not page.locator('#listening-hud').evaluate('el => el.inert') and page.locator('#hud-show').is_hidden()
              and page.locator('#listening-hud').evaluate("el => getComputedStyle(el).getPropertyValue('--hud-docked').trim()") == '1',
              'Close-up opens with the slim docked panel')
        check(page.evaluate(hud_rect) == studio_hud, 'The docked panel keeps its size and place between the studio and close-up',
              studio=studio_hud, close=page.evaluate(hud_rect))
        page.locator('#hud-hide').click(); page.wait_for_timeout(450)
        deck_hidden = page.locator('#deck').bounding_box()
        check(page.locator('#hud-show').is_visible() and page.locator('#listening-hud').evaluate('el => el.inert')
              and deck_hidden['width'] > deck_shown['width'] * 1.05
              and page.evaluate('document.documentElement.scrollHeight <= innerHeight + 1'),
              'Hide controls gives the deck a fuller close-up without scrolling', shown=deck_shown['width'], hidden=deck_hidden['width'])
        page.locator('#hud-show').click(); page.wait_for_timeout(450)
        check(not page.locator('#listening-hud').evaluate('el => el.inert') and page.locator('#hud-show').is_hidden()
              and abs(page.locator('#deck').bounding_box()['width'] - deck_shown['width']) < 1,
              'Show controls restores the panel and the docked framing')
        lid = page.evaluate("[turntable.state.coverClosed, studioView.snapshot({bounds:false}).visual.coverOpen]")
        check(lid == [False, 1], 'Close-up lifts the dust cover fully open', lid=lid)
        exit_button = page.locator('#studio-focus')
        check('Back to studio' in exit_button.inner_text() and exit_button.bounding_box()['height'] >= 38,
              'Close-up turns the header toggle into an obvious Back to studio button')
        exit_button.click(); page.wait_for_timeout(400)
        # The hero follows the camera home instead of popping in at the click.
        early = page.evaluate("[+getComputedStyle(document.querySelector('.intro')).opacity, studioView.snapshot({bounds:false}).inspection ?? null]")
        page.wait_for_function("document.querySelector('#studio').dataset.view==='studio' && document.querySelector('#studio').dataset.moving==='false'")
        check(early[0] < .05 and float(page.evaluate("getComputedStyle(document.querySelector('.intro')).opacity")) == 1,
              'Hero copy stays hidden early in the return and is fully visible once the studio settles', early=early)
        check(page.locator('#studio-focus').inner_text() == 'Close-up', 'Back to studio returns to the wide view and restores the Close-up link')
        page.wait_for_function("studioView.snapshot({bounds:false}).visual.coverOpen === 0", timeout=4000)
        check(page.evaluate('turntable.state.coverClosed'), 'Back to studio swings the dust cover closed again')
        page.locator('#studio-enter').click()
        page.wait_for_function("document.querySelector('#studio').dataset.view==='turntable' && document.querySelector('#studio').dataset.moving==='false'")
        check('blur' in plate_style and page.evaluate("studioView.snapshot({bounds:false}).objects['glass-reflection'].visible") is False,
              'Close-up blurs the plate and retires the perspective-bound reflection', filter=plate_style)
        page.locator('#studio-focus').click()
        page.wait_for_function("document.querySelector('#studio').dataset.view==='studio' && document.querySelector('#studio').dataset.moving==='false'")
        check(page.evaluate("getComputedStyle(document.getElementById('studio-plate')).filter") == 'none'
              and page.evaluate("JSON.stringify(turntable.state, ['filename','duration','position','pitch','quartzLock'])") == before,
              'Returning restores the sharp plate without touching playback state')
        check(not errors, 'No browser errors', errors=errors)
        browser.close()
    (OUT / 'geometry.json').write_text(json.dumps(report, indent=2))
    failed = [item for item in checks if not item['passed']]
    (OUT / 'checks.json').write_text(json.dumps({'total': len(checks), 'failed': len(failed), 'checks': checks}, indent=2) + '\n')
    assert not failed, f'{len(failed)} plate checks failed: ' + ', '.join(item['check'] for item in failed)
    print(f'All {len(checks)} studio plate checks passed.')


if __name__ == '__main__':
    run()
