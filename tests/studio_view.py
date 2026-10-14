"""Cinematic camera continuity, audio persistence and transformed hardware input.

Run against the local server with ``uv run --group dev python tests/studio_view.py``.
Audio fixtures are generated temporarily; camera traces/screenshots are disposable.
"""
import json
import math
from pathlib import Path
import struct
import tempfile
import wave

from playwright.sync_api import sync_playwright
from studio_helpers import launch_browser
from acceptance import ROOT, PROBE, arm_point, deck_point, groove_angle, select_speed

URL = 'http://127.0.0.1:42069/'
OUT = ROOT / 'artifacts/studio-view'
checks = []


def check(ok, message, **details):
    assert ok, f'{message}: {details}'
    checks.append({'check': message, **details})
    print('PASS ' + message, flush=True)


# Observe the existing graph, without creating a second audio source or changing
# its control stream. A PCM reload or graph reconstruction during camera travel
# would otherwise be difficult to detect from a screenshot or model snapshot.
CAMERA_PROBE = r'''(() => {
  window.__studioProbe = {loads: 0, clears: 0, processors: [], contexts: []};
  const Worklet = window.AudioWorkletNode;
  window.AudioWorkletNode = class extends Worklet {
    constructor(...args) {
      super(...args);
      if (args[1] !== 'vinyl-processor') return;
      __studioProbe.processors.push(this);
      __studioProbe.contexts.push(this.context);
      const post = this.port.postMessage.bind(this.port);
      this.port.postMessage = (message, ...rest) => {
        if (message.type === 'load') __studioProbe.loads++;
        if (message.type === 'clear') __studioProbe.clears++;
        return post(message, ...rest);
      };
    }
  };
})();'''

TRACE_SETUP = r'''() => {
  window.__originalDeck = document.getElementById('deck');
  window.__originalCanvas = document.getElementById('studio-canvas');
  window.__originalTurntable = window.turntable;
  window.__originalControls = turntable.controls;
  const initial = studioView.snapshot({bounds:false});
  window.__originalMeshIds = Object.fromEntries(Object.entries(initial.objects).map(([name, value]) => [name, value.id]));
  const projectedBounds = (name, corners) => {
    const points = corners.map(point => studioView.projectPoint(name, point));
    if (points.some(point => !point)) throw new Error('Missing projected studio object: '+name);
    const xs=points.map(point=>point.x), ys=points.map(point=>point.y);
    const x=Math.min(...xs), y=Math.min(...ys), width=Math.max(...xs)-x, height=Math.max(...ys)-y;
    return {x,y,width,height,centerX:x+width/2,centerY:y+height/2};
  };
  window.studioProjectedGeometry = () => ({
    // Canonical control footprint lies on the chassis top in the physical room.
    deck: projectedBounds('vhs-turntable', [[-.512,.075,-.414],[.512,.075,-.414],[-.512,.075,.414],[.512,.075,.414]]),
    // The photographic plate's presentation scale (it pushes in as the camera leaves it).
    plateScale: new DOMMatrix(getComputedStyle(document.getElementById('studio-plate')).transform).a
  });
  window.beginStudioTrace = () => {
    const frames = [];
    let frame;
    const sample = () => {
      const state = turntable.state, node = document.getElementById('deck');
      const canvas = document.getElementById('studio-canvas'), rendered = studioView.snapshot({bounds:false});
      const analyser = window.__probe?.analyser;
      let rms = null;
      if (analyser) {
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      }
      frames.push({time: performance.now(), ...studioProjectedGeometry(),
        camera: rendered.camera, frameId: rendered.frameId, reflectionUpdates: rendered.reflectionUpdates,
        visual: rendered.visual, meshIds: Object.fromEntries(Object.entries(rendered.objects).map(([name,value])=>[name,value.id])),
        sameMeshes: Object.entries(__originalMeshIds).every(([name,id])=>rendered.objects[name]?.id===id),
        opacity: +getComputedStyle(canvas).opacity, connected: node.isConnected && canvas.isConnected,
        sameDeck: node === __originalDeck, sameCanvas: canvas === __originalCanvas,
        canvasVisible: getComputedStyle(canvas).visibility === 'visible' && canvas.getBoundingClientRect().width > 0,
        position: state.position, rotation: state.rotation, recordRotation: state.recordRotation,
        rms, rate: state.actualRate, phase: state.recordPhase, context: turntable.audioState});
    };
    const tick = () => {sample(); frame = requestAnimationFrame(tick);};
    tick();
    window.endStudioTrace = () => {sample(); cancelAnimationFrame(frame); return frames;};
  };
}'''


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    traces = {}
    with tempfile.TemporaryDirectory(prefix='studio-view-') as tmp, sync_playwright() as p:
        fixture = Path(tmp) / 'studio-continuity.wav'
        second = b''.join(struct.pack('<h', round(8000 * math.sin(2 * math.pi * 440 * i / 24000))) for i in range(24000))
        with wave.open(str(fixture), 'wb') as wav:
            wav.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
            wav.writeframes(second * 90)
        browser = launch_browser(p)
        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
        page.add_init_script(PROBE)
        page.add_init_script(CAMERA_PROBE)
        errors, bad_responses = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.on('response', lambda response: bad_responses.append(response.url) if response.status >= 400 else None)
        page.goto(URL)
        page.wait_for_function('window.turntable && window.studioView && studioView.snapshot().ready && studioView.snapshot().frameId > 0', timeout=30000)
        page.evaluate(TRACE_SETUP)
        state = lambda: page.evaluate('turntable.state')

        def settle(view):
            page.wait_for_function("view => {const s=document.querySelector('#studio'); return s.dataset.view===view && s.dataset.moving!=='true'}", arg=view, timeout=7000)

        def go(view):
            page.locator('#studio-enter' if view == 'turntable' else '#studio-focus').click()
            settle(view)

        def trace(name, action, view):
            page.evaluate('beginStudioTrace()')
            action()
            settle(view)
            page.wait_for_timeout(80)
            samples = page.evaluate('endStudioTrace()')
            traces[name] = samples
            (OUT / 'camera-traces.json').write_text(json.dumps(traces, indent=2))
            return samples

        settle('studio')
        check(page.locator('#deck').count() == 1 and page.locator('#studio-enter').is_visible()
              and page.evaluate('studioView.snapshot().objects["vhs-turntable"].visible'),
              'Initial view contains one native turntable and a discoverable object entrance')
        plate = page.evaluate('''() => {
          const img = document.getElementById('studio-plate'), r = img.getBoundingClientRect(), s = studioView.snapshot({bounds:false});
          const deck = studioView.projectPoint('vhs-turntable', [0, 0, 0]), hud = document.getElementById('listening-hud').getBoundingClientRect();
          return {loaded: img.complete && img.naturalWidth > 0, source: img.currentSrc, rect: [r.x, r.y, r.width, r.height], plate: s.plate,
            deck, hudTop: hud.top, objects: Object.keys(s.objects)};
        }''')
        check(plate['loaded'] and abs(plate['rect'][0] - plate['plate']['x']) < 1 and abs(plate['rect'][2] - plate['plate']['width']) < 1
              and not any(name.startswith(('monitor-', 'window-', 'wood-floor', 'glass-tabletop')) for name in plate['objects']),
              'Wide view shows the photographic plate where the camera expects it, with no procedural room', source=plate['source'])
        check(plate['deck']['visible'] and plate['deck']['y'] < plate['hudTop'],
              'The calibrated deck sits on the plate table above the listening panel', deck=plate['deck'], hud=plate['hudTop'])
        check(not state()['recordLoaded'] and page.evaluate('__probe.worklets') == 0,
              'Entering the studio does not start audio or create an empty processor')
        wide = page.evaluate('studioProjectedGeometry().deck')
        page.screenshot(path=OUT / 'desktop-studio.png', full_page=True)

        # Local selection remains accessible before travelling toward the deck.
        page.locator('#load').click()
        with page.expect_file_chooser() as picker:
            page.locator('#source-local').click()
        picker.value.set_files(fixture)
        page.wait_for_function("turntable.state.recordPhase==='ready'")
        check(state()['filename'] == fixture.name and page.evaluate('__studioProbe.loads') == 1,
              'Wide-view source chooser loads one local PCM buffer through the existing lifecycle')
        page.locator('#transport').click()
        page.wait_for_function('turntable.state.position > 1 && turntable.state.stylusContact')
        page.wait_for_timeout(150)
        before = state()
        inward = trace('enter-playing', lambda: page.locator('#studio-enter').click(), 'turntable')
        close = page.evaluate('studioProjectedGeometry().deck')
        widths = [s['deck']['width'] for s in inward]
        distinct = len({round(w, 1) for w in widths})
        check(close['width'] > wide['width'] * 1.15 and distinct >= 10,
              'Approach grows the same physical deck through many genuine intermediate sizes', widths=[wide['width'], close['width']], distinct=distinct)
        check(all(s['sameDeck'] and s['sameCanvas'] and s['connected'] and s['canvasVisible'] and s['opacity'] == 1 for s in inward),
              'Approach retains the same visible WebGL canvas and original canonical controls throughout')
        check(all(s['sameMeshes'] and s['meshIds'] == inward[0]['meshIds'] for s in inward),
              'Native room and turntable meshes persist throughout camera travel')
        check(len({json.dumps(s['camera'], sort_keys=True) for s in inward}) >= 10
              and len({s['frameId'] for s in inward}) >= 10,
              'Camera movement produces many distinct native WebGL frames', rendered_frames=len({s['frameId'] for s in inward}))
        ratios = [s['deck']['height'] / s['deck']['width'] for s in inward]
        check(max(ratios) - min(ratios) > .08,
              'Camera pitches downward as it approaches, rather than only scaling a flat scene')
        check(inward[0]['plateScale'] == 1 and max(s['plateScale'] for s in inward) > 1.3,
              'The photographic plate pushes in behind the deck during the same camera travel')
        travel_ms = inward[-1]['time'] - inward[0]['time']
        check(650 < travel_ms < 3000,
              'Default camera movement has deliberate cinematic travel time', elapsed_ms=travel_ms)
        check(all(s['rms'] is not None and s['rms'] > .002 and s['context'] == 'running' for s in inward),
              'Real audio output remains nonzero throughout every sampled approach frame', min_rms=min(s['rms'] or 0 for s in inward))
        check(state()['position'] > before['position'] + .5 and state()['recordRotation'] != before['recordRotation'],
              'Audio cursor and visible record rotation advance during the approach')
        check(len({round(s['visual']['recordDegrees'], 2) for s in inward}) >= 3,
              'The native vinyl mesh visibly rotates during the approach using the shared simulation')
        page.screenshot(path=OUT / 'desktop-turntable.png', full_page=True)

        # Set several independent physical/material inputs, then navigate while
        # playing. Camera state must never be a parallel playback model.
        select_speed(page, 45)
        page.locator('#quartz').click()
        page.locator('#pitch').focus(); page.keyboard.press('End')
        page.locator('#customize-open').click()
        page.get_by_role('button', name='Turntable: Red', exact=True).click()
        page.get_by_role('button', name='Vinyl: Blue', exact=True).click()
        page.get_by_role('button', name='Label: Cream', exact=True).click()
        page.get_by_role('radio', name='Very Good', exact=True).check()
        page.keyboard.press('Escape'); page.locator('#customize').wait_for(state='hidden')
        check(page.locator('#studio').get_attribute('data-view') == 'turntable',
              'Escape dismisses an active dialog without also backing the camera away')
        page.locator('#volume').evaluate("el => {el.value='.43';el.dispatchEvent(new Event('input',{bubbles:true}));}")
        stable_keys = ['filename', 'duration', 'recordLoaded', 'recordPhase', 'stylusRaised',
                       'platterRunning', 'transportPaused', 'speed33Pressed', 'speed45Pressed',
                       'pitch', 'pitchRange', 'quartzLock', 'turntableColor', 'vinylColor',
                       'labelColor', 'condition', 'surface', 'contacts', 'cartridge', 'volume']
        before = state()
        outward = trace('return-playing', lambda: page.locator('#studio-focus').click(), 'studio')
        after = state()
        check(all(before[k] == after[k] for k in stable_keys),
              'Return preserves song, transport, RPM, pitch, quartz, cue, materials, condition and volume')
        visual=page.evaluate('studioView.snapshot().visual')
        check(visual['chassisColor'] == '#923137'
              and visual['speed33Pressed'] == after['speed33Pressed']
              and visual['speed45Pressed'] == after['speed45Pressed']
              and (visual['cueLift'] > 0) == after['stylusRaised']
              and abs(visual['pitchZ'] - (.218 + .112 * after['pitch'] / after['pitchRange'])) < .0001,
              'Native chassis finish, speed latches, cue and physical fader match the authoritative model')
        check(after['position'] > before['position'] + .5 and all(s['rms'] and s['rms'] > .002 for s in outward),
              'Backing away preserves an advancing audio cursor and uninterrupted real waveform')
        check(page.evaluate('turntable===__originalTurntable && turntable.controls===__originalControls && document.querySelector("#deck")===__originalDeck && __probe.worklets===1 && __studioProbe.loads===1 && __studioProbe.clears===0 && __probe.starts===0'),
              'Round trip preserves one model, one canonical control surface, one worklet and its original transferred PCM')
        page.wait_for_timeout(250)
        check(state()['position'] > after['position'] + .2 and state()['recordRotation'] != after['recordRotation'],
              'Record visibly rotates and music continues after settling in the wide studio')

        # The return command reverses in-flight travel without stale completion.
        page.locator('#studio-enter').click()
        page.wait_for_timeout(350)
        check('Back to studio' in page.locator('#studio-focus').inner_text(),
              'The Close-up toggle names the studio as its destination as soon as travel begins')
        page.locator('#studio-focus').click()
        page.wait_for_timeout(180)
        page.locator('#studio-focus').click()
        settle('turntable')
        page.wait_for_timeout(350)
        check(page.locator('#studio').get_attribute('data-view') == 'turntable',
              'Rapid enter/back/enter ends at the newest destination without a stale camera callback')

        # Compare geometric projection to a rendered marker, rather than merely
        # inverting the same potentially wrong affine matrix in both test and app.
        mapping = page.locator('#deck').evaluate(r'''deck => {
          return [[149,837],[498,598],[1020,820],[950,415]].map(([x,y]) => {
            const marker = document.createElementNS('http://www.w3.org/2000/svg','circle');
            marker.setAttribute('cx',x); marker.setAttribute('cy',y); marker.setAttribute('r','.1');
            marker.style.pointerEvents='none'; deck.append(marker);
            const r=marker.getBoundingClientRect(), p=new DOMPoint(x,y).matrixTransform(deck.getScreenCTM());
            marker.remove(); return Math.hypot(p.x-r.x-r.width/2,p.y-r.y-r.height/2);
          });
        }''')
        check(max(mapping) < 1, 'Settled close view preserves accurate screen-to-SVG hardware mapping', pixel_errors=mapping)
        mesh_mapping=page.evaluate(r'''() => {
          const deck=document.querySelector('#deck'), canvas=document.querySelector('#studio-canvas').getBoundingClientRect();
          const s=turntable.state;
          return [['vhs-power',149,837],['vhs-platter',498,598],['vhs-tonearm',951,415],
                  ['vhs-speed33',260.5,959],['vhs-speed45',313.5,959],['vhs-pitch',1022,812+112*s.pitch/s.pitchRange]]
            .map(([name,x,y])=>{
              const mesh=studioView.projectPoint(name), svg=new DOMPoint(x,y).matrixTransform(deck.getScreenCTM());
              return {name,error:Math.hypot(mesh.x+canvas.x-svg.x,mesh.y+canvas.y-svg.y)};
            });
        }''')
        check(max(item['error'] for item in mesh_mapping) < 2,
              'Visible native hardware and transparent SVG input anchors agree at settled close view', pixel_errors=mesh_mapping)
        page.locator('#transport').click()
        page.wait_for_function('turntable.state.transportPaused && !turntable.state.motorRamping')
        page.wait_for_function('Math.abs(studioView.snapshot().visual.tonearmAngle-turntable.state.tonearmAngle) < .01')
        stylus_mapping=page.evaluate(r'''() => {
          const deck=document.querySelector('#deck'), canvas=document.querySelector('#studio-canvas').getBoundingClientRect();
          const g=turntable.geometry, angle=turntable.state.tonearmAngle*Math.PI/180;
          const svg=new DOMPoint(g.px-g.length*Math.sin(angle),g.py+g.length*Math.cos(angle)).matrixTransform(deck.getScreenCTM());
          const needle=studioView.projectPoint('vhs-tonearm',[-.095,.1045,.511]);
          return Math.hypot(needle.x+canvas.x-svg.x,needle.y+canvas.y-svg.y);
        }''')
        check(stylus_mapping < 2,
              'Visible 3D stylus tip meets the exact groove selected by the canonical tonearm geometry', pixel_error=stylus_mapping)
        if not state()['stylusRaised']: page.locator('#cue').click()
        g, before = page.evaluate('turntable.geometry'), state()
        page.mouse.move(*arm_point(page, g, before['tonearmAngle'])); page.mouse.down()
        page.mouse.move(*arm_point(page, g, groove_angle(g, .42)), steps=10); page.mouse.up()
        check(abs(state()['position'] / state()['duration'] - .42) < .003 and state()['stylusRaised'],
              'Direct tonearm drag on the aligned control surface selects the chosen groove and preserves CUE')
        page.locator('#cue').click()
        page.wait_for_function('!turntable.state.stylusRaised && !turntable.state.cueDescent')  # Damped cue: contact begins at touchdown.
        start = state()['position']
        radius = 230
        def vinyl_point(degrees):
            a = math.radians(degrees)
            return deck_point(page, g['cx'] + radius * math.cos(a), g['cy'] + radius * math.sin(a))
        page.mouse.move(*vinyl_point(175)); page.mouse.down()
        for angle in [165,155,145,135,125,115]:
            page.mouse.move(*vinyl_point(angle)); page.wait_for_timeout(15)
        held = state()
        check(held['scratching'] and abs(held['position'] - start + .3) < .03,
              'Direct vinyl gesture still rewinds the original PCM reader by the physical turn angle',
              scratching=held['scratching'], travel=round(held['position'] - start, 4))
        page.locator('#vinyl-hit-area').dispatch_event('pointercancel', {'pointerId': 1})
        page.mouse.up()
        check(not state()['scratching'] and not state()['dragging'],
              'Pointer cancellation releases direct manipulation after camera navigation')

        # Leaving while a physical speed key is held must cancel its captured
        # release, then allow the next ordinary click after returning.
        speed_before = {key: state()[key] for key in ['speed33Pressed', 'speed45Pressed']}
        page.locator('#rpm-33').evaluate("node => node.addEventListener('pointerdown', event => window.__studioSpeedPointer = event.pointerId, {once:true})")
        page.locator('#rpm-33').hover(); page.mouse.down()
        held_capture = page.locator('#rpm-33').evaluate('node => node.hasPointerCapture(__studioSpeedPointer)')
        page.keyboard.press('Escape'); settle('studio'); page.mouse.up()
        check(held_capture and not page.locator('#rpm-33').evaluate('node => node.hasPointerCapture(__studioSpeedPointer)')
              and all(state()[key] == value for key, value in speed_before.items()),
              'Leaving while holding a physical speed key releases capture without latching its stale release')
        go('turntable'); page.locator('#rpm-33').click()
        check(state()['speed33Pressed'] != speed_before['speed33Pressed']
              and state()['speed45Pressed'] == speed_before['speed45Pressed'],
              'A canceled speed-key press accepts the next normal click after returning')
        page.locator('#rpm-33').click()

        # Focus enters the inspected object; keyboard users can travel back and
        # forth without accidentally toggling the platter through global Space.
        go('studio')
        page.locator('#studio-enter').focus(); page.keyboard.press('Enter'); settle('turntable')
        check(page.locator('#studio-enter').evaluate('node => document.activeElement !== node'),
              'Entering by keyboard moves focus away from the inactive wide-view target')
        page.locator('#rpm-33').focus()
        page.wait_for_function('!document.querySelector("#studio-control-focus").hidden')
        focus_alignment=page.evaluate('''() => {
          const ring=document.querySelector('#studio-control-focus').getBoundingClientRect();
          const control=document.querySelector('#rpm-33').getBoundingClientRect();
          return {x: Math.abs(ring.x+ring.width/2-control.x-control.width/2),
                  y: Math.abs(ring.y+ring.height/2-control.y-control.height/2),
                  width: ring.width, controlWidth: control.width};
        }''')
        check(focus_alignment['x'] < 2 and focus_alignment['y'] < 2
              and focus_alignment['width'] >= focus_alignment['controlWidth'],
              'Transparent hardware controls retain a visible aligned keyboard focus indicator', alignment=focus_alignment)
        page.locator('#studio-focus').focus(); page.keyboard.press('Enter'); settle('studio')
        check(page.locator('#studio-enter').evaluate('node => document.activeElement === node'),
              'Returning by keyboard restores focus to the studio object target')

        # A listener may move into the live HUD while the camera is travelling.
        # Completion must preserve that newer intent, including an open menu.
        page.locator('#studio-enter').focus(); page.keyboard.press('Enter')
        page.wait_for_function('document.querySelector("#studio").dataset.moving === "true"')
        page.locator('#volume').focus()
        volume_during_travel = page.locator('#studio').get_attribute('data-moving') == 'true'
        settle('turntable')
        check(volume_during_travel and page.locator('#volume').evaluate('node => document.activeElement === node'),
              'Approach completion preserves focus deliberately moved into the live HUD')
        page.locator('#studio-focus').focus(); page.keyboard.press('Enter')
        page.wait_for_function('document.querySelector("#studio").dataset.moving === "true"')
        page.locator('#preset-toggle').focus(); page.keyboard.press('ArrowDown')
        preset_during_travel = page.locator('#studio').get_attribute('data-moving') == 'true'
        settle('studio')
        check(preset_during_travel and page.locator('#preset-toggle').get_attribute('aria-expanded') == 'true'
              and page.locator('#preset-options').evaluate('node => node.contains(document.activeElement)'),
              "Return completion preserves an open preset menu and the listener's focused option")
        page.keyboard.press('Escape'); page.locator('#preset-options').wait_for(state='hidden')

        for width, height, label in [(1024, 900, 'tablet'), (390, 844, 'mobile')]:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(150)
            check(page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),
                  f'{label}: studio framing does not overflow the viewport horizontally')
            page.screenshot(path=OUT / f'{label}-studio.png', full_page=True)
            go('turntable')
            box = page.locator('#deck').bounding_box()
            check(box['x'] >= -2 and box['x'] + box['width'] <= width + 2,
                  f'{label}: inspection frames the complete deck without stretching', bounds=box)
            page.screenshot(path=OUT / f'{label}-turntable.png', full_page=True)
            go('studio')

        page.set_viewport_size({'width': 1440, 'height': 1100})
        page.locator('#studio-enter').click(); page.wait_for_timeout(200)
        page.set_viewport_size({'width': 1100, 'height': 950}); settle('turntable')
        box = page.locator('#deck').bounding_box()
        check(box['x'] >= -2 and box['x'] + box['width'] <= 1102,
              'Resizing during travel settles into the current viewport without clipping')
        go('studio')
        page.emulate_media(reduced_motion='reduce')
        reduced = trace('reduced-motion-enter', lambda: page.locator('#studio-enter').click(), 'turntable')
        duration = reduced[-1]['time'] - reduced[0]['time']
        check(duration < 700, 'Reduced motion reaches the same object with shortened camera travel', elapsed_ms=duration)
        go('studio')
        page.emulate_media(reduced_motion='no-preference')
        page.locator('#studio-enter').click(); page.wait_for_timeout(220)
        page.emulate_media(reduced_motion='reduce'); settle('turntable')
        check(page.locator('#studio-canvas').is_visible() and page.evaluate('__probe.worklets') == 1,
              'Enabling reduced motion during travel settles cleanly and preserves the audio instance')
        check(not errors and not bad_responses, 'Studio navigation produces no browser errors or missing assets', errors=errors, bad_responses=bad_responses)
        browser.close()
    (OUT / 'checks.json').write_text(json.dumps({'result':'passed','total':len(checks),'checks':checks}, indent=2) + '\n')
    print(f'All {len(checks)} cinematic studio checks passed.')


if __name__ == '__main__':
    run()
