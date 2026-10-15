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
# Click a button and sample, every frame, the panel's slide (--hud-away), the deck's width,
# the Hide/Show pill's centre and the panel's top edge (both in viewport pixels).
GLIDE = r'''selector => new Promise(done => {
  const room = document.querySelector('.room'), deck = document.querySelector('#deck'), samples = [];
  const pill = document.querySelector('#hud-toggle'), hud = document.querySelector('#listening-hud');
  const away = () => +getComputedStyle(room).getPropertyValue('--hud-away');
  document.querySelector(selector).click();
  const start = performance.now(), inert = hud.inert;
  const moving = document.querySelector('#studio').dataset.moving === 'true';
  const tick = now => {
    const p = pill.getBoundingClientRect();
    samples.push([now - start, away(), Math.round(deck.getBoundingClientRect().width * 10) / 10,
                  p.top + p.height / 2, hud.getBoundingClientRect().top]);
    if (now - start < 900) requestAnimationFrame(tick); else done({inert, moving, samples});
  };
  requestAnimationFrame(tick);
})'''
TOGGLE = "(() => { const p = document.querySelector('#hud-toggle'), r = p.getBoundingClientRect(), s = getComputedStyle(p); return {x: r.x + r.width / 2, y: r.y + r.height / 2, bottom: innerHeight - r.bottom, visible: s.visibility === 'visible' && +s.opacity > .99, label: p.getAttribute('aria-label'), expanded: p.getAttribute('aria-expanded'), count: document.querySelectorAll('.hud-toggle').length}; })()"


def glides(trace, to):
    """A smooth, monotonic slide that reaches `to` in about 450 ms, never faster than the
    curve allows (a snap is one or two frames covering most of the way)."""
    samples = [(0, 1 - to)] + [sample[:2] for sample in trace['samples']]
    done = next((t for t, away in samples if abs(away - to) < .001), None)
    steps = [(b[1] - a[1]) * (1 if to else -1) / max(1, b[0] - a[0]) for a, b in zip(samples, samples[1:])]
    trace.update(done=done if done is not None else 1e9, speed=max(steps), decks=[sample[2] for sample in trace['samples']])
    middle = [away for _, away in samples[1:] if .02 < away < .98]
    return done is not None and 350 < done < 700 and min(steps) >= 0 and max(steps) < 1.6 * 1.5 / 450 and len(middle) >= 4


def glide_summary(trace):
    return {'done_ms': round(trace.get('done', -1)), 'peak_per_ms': round(trace.get('speed', -1), 5), 'frames': len(trace['samples'])}


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

        # Skyline: the UI fades and the view tilts up to the city; Escape returns.
        sky = page_for(1600, 1000)
        place = "(r => Math.round(r.top))(document.querySelector('#studio-plate').getBoundingClientRect())"
        settled_top = sky.evaluate(place)
        sky.locator('#skyline-toggle').click(); sky.wait_for_timeout(1700)
        up = sky.evaluate(f"[{place}, getComputedStyle(document.querySelector('.intro')).opacity, document.querySelector('#listening-hud').inert, getComputedStyle(document.querySelector('#studio-focus')).visibility, document.querySelector('#skyline-toggle').innerText]")
        check(up[0] == 0 and settled_top < -100 and up[1] == '0' and up[2] and up[3] == 'hidden' and 'Back to studio' in up[4],
              'Skyline fades the controls and tilts the view up to the city', settled=settled_top, skyline=up)
        sky.keyboard.press('Escape'); sky.wait_for_timeout(1700)
        back = sky.evaluate(f"[{place}, getComputedStyle(document.querySelector('.intro')).opacity, document.querySelector('#listening-hud').inert]")
        check(back == [settled_top, '1', False], 'Escape returns from the skyline to the settled studio view', back=back)
        sky.context.close()

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
        # Entering the close-up slides the controls away from the click, while the camera is
        # still moving, over the same smooth glide as Hide and Show.
        entering = page.evaluate(GLIDE, '#studio-enter')
        check(entering['inert'] and entering['moving'] and glides(entering, 1), 'Clicking into the close-up slides the controls away at once, smoothly', **glide_summary(entering))
        # One pill rides the panel's top edge down and rests above the bottom of the screen;
        # it never jumps, and the panel never shows a second button.
        pill_path = [round(y, 1) for *_, y, _ in entering['samples']]
        check(all(b >= a - .5 for a, b in zip(pill_path, pill_path[1:])) and abs(pill_path[0] - entering['samples'][0][4]) < 6
              and max(b - a for a, b in zip(pill_path, pill_path[1:])) < 40,
              'Entering, the one Hide/Show pill glides down with the panel without jumping', path=pill_path[:12])
        page.wait_for_function("document.querySelector('#studio').dataset.view==='turntable' && document.querySelector('#studio').dataset.moving==='false'")
        plate_style = page.evaluate("getComputedStyle(document.getElementById('studio-plate')).filter")
        page.wait_for_timeout(300)
        deck_hidden = page.locator('#deck').bounding_box()
        rest = page.evaluate(TOGGLE)
        check(rest['visible'] and rest['label'] == 'Show controls' and rest['expanded'] == 'false' and rest['count'] == 1
              and 12 <= rest['bottom'] <= 30 and abs(rest['x'] - page.viewport_size['width'] / 2) < 2
              and page.locator('#listening-hud').evaluate('el => el.inert')
              and page.evaluate('document.documentElement.scrollHeight <= innerHeight + 1'),
              'The close-up opens with the controls hidden and the pill resting as Show controls, without scrolling', pill=rest)
        showing = page.evaluate(GLIDE, '#hud-toggle'); page.wait_for_timeout(100)
        deck_shown = page.locator('#deck').bounding_box()
        check(not page.locator('#listening-hud').evaluate('el => el.inert') and page.evaluate(TOGGLE)['label'] == 'Hide controls'
              and page.locator('#listening-hud').evaluate("el => getComputedStyle(el).getPropertyValue('--hud-docked').trim()") == '1'
              and deck_hidden['width'] > deck_shown['width'] * 1.05,
              'Show controls brings back the slim docked panel; hidden, the deck is larger', shown=deck_shown['width'], hidden=deck_hidden['width'])
        check(page.evaluate(hud_rect) == studio_hud, 'The docked panel keeps its size and place between the studio and close-up',
              studio=studio_hud, close=page.evaluate(hud_rect))
        tab, panel = page.evaluate(TOGGLE), page.locator('#listening-hud').bounding_box()
        check(tab['visible'] and tab['expanded'] == 'true' and abs(tab['x'] - (panel['x'] + panel['width'] / 2)) < 2
              and abs(tab['y'] - panel['y']) < 2, 'The pill turns into Hide controls, centered on the panel\'s top edge', tab=tab, panel=panel)
        hiding = page.evaluate(GLIDE, '#hud-toggle'); page.wait_for_timeout(100)
        check(page.evaluate(TOGGLE)['label'] == 'Show controls' and page.locator('#listening-hud').evaluate('el => el.inert')
              and abs(page.locator('#deck').bounding_box()['width'] - deck_hidden['width']) < 1,
              'Hide controls clears the panel away again for the fuller close-up')
        rides = [abs(y - top) < 2 for *_, y, top in showing['samples'][-3:]] + [abs(y - rest['y']) < 2 for *_, y, _ in hiding['samples'][-3:]]
        check(all(rides) and all(b[3] <= a[3] + .5 for a, b in zip(showing['samples'], showing['samples'][1:]))
              and all(b[3] >= a[3] - .5 for a, b in zip(hiding['samples'], hiding['samples'][1:])),
              'The pill rides up with the panel on Show and back down to rest on Hide, smoothly')
        check(glides(showing, 0) and glides(hiding, 1) and abs(showing['done'] - hiding['done']) < 120,
              'Show and Hide glide smoothly at the same speed', show=glide_summary(showing), hide=glide_summary(hiding))
        check(min(len(set(showing['decks'])), len(set(hiding['decks']))) >= 5,
              'The close-up frame grows and shrinks with the panel instead of jumping',
              show=len(set(showing['decks'])), hide=len(set(hiding['decks'])))
        page.locator('#hud-toggle').click(); page.wait_for_timeout(600)
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
