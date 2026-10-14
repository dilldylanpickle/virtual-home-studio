"""WebGL context recovery and graceful native-renderer failure isolation.

Run against the local server, optionally with VHS_TEST_GPU=1 for the shared
hardware browser helper. Faults are injected into routed module responses only;
production source and diagnostic APIs gain no fault-injection hooks.
"""
import json
import math
from pathlib import Path
import re
import struct
import tempfile
import wave

from playwright.sync_api import sync_playwright
from acceptance import ROOT, PROBE, deck_point
from studio_helpers import launch_browser

URL = 'http://127.0.0.1:42069/'
OUT = ROOT / 'artifacts/studio-recovery'
checks = []


def check(ok, message, **details):
    checks.append({'passed': bool(ok), 'check': message, **details})
    (OUT / 'checks.json').write_text(json.dumps({'checks': checks}, indent=2) + '\n')
    assert ok, f'{message}: {details}'
    print('PASS ' + message, flush=True)


AUDIO_PROBE = r'''(() => {
  window.__recoveryAudio = {loads: 0, clears: 0, nodes: [], contexts: []};
  const Native = window.AudioWorkletNode;
  window.AudioWorkletNode = class extends Native {
    constructor(...args) {
      super(...args);
      if (args[1] !== 'vinyl-processor') return;
      __recoveryAudio.nodes.push(this); __recoveryAudio.contexts.push(this.context);
      const post = this.port.postMessage.bind(this.port);
      this.port.postMessage = (message, ...rest) => {
        if (message.type === 'load') __recoveryAudio.loads++;
        if (message.type === 'clear') __recoveryAudio.clears++;
        return post(message, ...rest);
      };
    }
  };
})();'''

IDENTITY = r'''() => {
  window.__originalModel = turntable;
  window.__originalControls = turntable.controls;
  window.__originalDeck = document.querySelector('#deck');
  window.__originalCanvas = document.querySelector('#studio-canvas');
  window.__originalWorklet = __recoveryAudio.nodes[0];
  window.__originalAudioContext = __recoveryAudio.contexts[0];
  window.__platterMutations = 0;
  window.__platterObserver = new MutationObserver(records => { __platterMutations += records.length; });
  __platterObserver.observe(document.querySelector('#platter-rotation'), {attributes: true, attributeFilter: ['transform']});
}'''

AUDIO_STATE = r'''() => {
  const values = new Float32Array(__probe.analyser?.fftSize || 2048);
  __probe.analyser?.getFloatTimeDomainData(values);
  return {position: turntable.state.position, audio: turntable.audioState,
    hudProgress: +document.querySelector('#groove-progress').value,
    rms: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
    sameModel: turntable === __originalModel, sameControls: turntable.controls === __originalControls,
    sameDeck: document.querySelector('#deck') === __originalDeck,
    sameWorklet: __recoveryAudio.nodes[0] === __originalWorklet,
    sameContext: __recoveryAudio.contexts[0] === __originalAudioContext,
    worklets: __probe.worklets, loads: __recoveryAudio.loads, clears: __recoveryAudio.clears,
    sources: __probe.starts, mutations: __platterMutations};
}'''

# Inspect the *rendered* PMREM atlas through an unsigned-byte staging target.
# ANGLE/D3D12 half-float readback can be zero-filled despite valid rendering.
# This checks restored GPU texture contents, not just replacement JS identities.
ENVIRONMENT_PIXELS = r'''async phase => {
  const THREE = await import('./static/vendor/three.module.min.js');
  const {FullScreenQuad} = await import('./static/vendor/addons/postprocessing/Pass.js');
  const {CopyShader} = await import('./static/vendor/addons/shaders/CopyShader.js');
  const graphics = window.__recoveryGraphics, renderer = graphics.renderer;
  const target = new THREE.WebGLRenderTarget(192, 128, {type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false});
  const paint = new THREE.ShaderMaterial({uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
    vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false});
  paint.uniforms.tDiffuse.value = graphics.environmentTarget.texture;
  const quad = new FullScreenQuad(paint), previous = renderer.getRenderTarget();
  const rgba = new Uint8Array(192 * 128 * 4);
  try {
    renderer.setRenderTarget(target); quad.render(renderer);
    renderer.readRenderTargetPixels(target, 0, 0, 192, 128, rgba);
  } finally {
    renderer.setRenderTarget(previous); target.dispose(); quad.dispose(); paint.dispose(); graphics.invalidate();
  }
  let sum=0, squared=0, lit=0, difference=0, count=0;
  for(let i=0;i<rgba.length;i++) {
    if(i%4===3) continue;
    const value=rgba[i]; sum+=value; squared+=value*value; count++;
    if(value>8) lit++;
    if(phase==='after') difference+=Math.abs(value-__environmentBefore[i]);
  }
  if(phase==='before') {window.__environmentBefore=rgba;window.__environmentTargetBefore=graphics.environmentTarget;}
  return {mean:sum/count, deviation:Math.sqrt(Math.max(0,squared/count-(sum/count)**2)),
    litFraction:lit/count, meanAbsoluteDifference:phase==='after'?difference/count:null,
    targetReplaced:phase==='after'?graphics.environmentTarget!==__environmentTargetBefore:null,
    connected:graphics.scene.environment===graphics.environmentTarget.texture};
}'''


def instrument_renderer(route):
    response = route.fetch()
    source = response.text()
    marker = 'this.host = host;'
    assert source.count(marker) == 1, 'Renderer constructor instrumentation anchor changed'
    source = source.replace(marker, marker + ' window.__recoveryGraphics = this;', 1)
    setup = 'this.setupLighting(); this.setupGround(); this.setupPostprocessing();'
    assert source.count(setup) == 1, 'Renderer setup instrumentation anchor changed'
    source = source.replace(setup, setup + r'''
      if (window.__failStudioConstruction) {
        window.__disposedStudioResources = [];
        for (const [name, resource] of [['reflector-geometry', this.reflector.geometry],
          ['contact-material', this.contact.material], ['shadow-material', this.surfaceShadow.material],
          ['environment-target', this.environmentTarget]]) {
          resource.addEventListener('dispose', () => __disposedStudioResources.push(name));
        }
        const disposeRenderer = this.renderer.dispose.bind(this.renderer);
        this.renderer.dispose = () => { __disposedStudioResources.push('renderer'); disposeRenderer(); };
        throw new Error('Injected partial Studio constructor failure');
      }
    ''', 1)
    source, changes = re.subn(r'(\n  update\(state, now[^)]*\)\s*\{)', r'''\1
    if (window.__failStudioUpdate) {
      window.__failStudioUpdate = false;
      throw new Error('Injected Studio update failure');
    }
''', source, count=1)
    assert changes == 1, 'Renderer update instrumentation anchor changed'
    route.fulfill(response=response, body=source)


def new_page(browser, mode):
    page = browser.new_page(viewport={'width': 1280, 'height': 1000})
    page.set_default_timeout(20000)
    page.add_init_script(PROBE + '\n' + AUDIO_PROBE)
    page.route('**/static/studio-renderer.js', instrument_renderer)
    if mode == 'unavailable':
        page.add_init_script(r'''(() => {
          const context = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(type, ...args) {
            return /webgl/i.test(type) ? null : context.call(this, type, ...args);
          };
        })();''')
    if mode == 'partial':
        page.add_init_script('window.__failStudioConstruction = true;')
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url)
            if request.url.startswith(('http://', 'https://')) and not request.url.startswith(URL) else None)
    page.goto(URL)
    page.wait_for_function('window.turntable && window.studioView && document.querySelector("#studio").dataset.ready === "true"')
    return page, errors, external


def load_play(page, fixture):
    page.locator('#load').click()
    with page.expect_file_chooser() as picker:
        page.locator('#source-local').click()
    picker.value.set_files(fixture)
    page.wait_for_function("turntable.state.recordPhase === 'ready'")
    page.locator('#transport').click()
    page.wait_for_function('turntable.state.position > .5 && turntable.state.stylusContact')
    page.wait_for_timeout(100)
    page.evaluate(IDENTITY)


def assert_audio_continues(page, before, description):
    page.wait_for_function('position => turntable.state.position > position + .2', arg=before['position'])
    after = page.evaluate(AUDIO_STATE)
    check(all(after[key] for key in ['sameModel', 'sameControls', 'sameDeck', 'sameWorklet', 'sameContext'])
          and after['worklets'] == 1 and after['loads'] == 1 and after['clears'] == 0 and after['sources'] == 0,
          description + ': the original model, controls, worklet and PCM remain intact', audio=after)
    check(after['audio'] == 'running' and after['rms'] > .001 and after['mutations'] > before['mutations'] + 2
          and after['hudProgress'] > before['hudProgress'],
          description + ': audio, HUD progress and the shared application frame loop continue', audio=after)
    return after


def assert_fallback(page, description):
    page.wait_for_function('document.querySelector("#studio").dataset.renderer === "fallback"')
    check(page.locator('#studio-canvas').count() == 0
          and page.locator('#deck').count() == 1
          and page.locator('.deck-wrap').evaluate('node => +getComputedStyle(node).opacity') == 1
          and not page.locator('#drop-zone').evaluate('node => node.inert')
          and page.locator('#studio').get_attribute('data-moving') == 'false',
          description + ': one visible canonical SVG remains usable without a leaked WebGL canvas')
    check(page.locator('#studio-focus').is_hidden() and page.locator('#studio-quality').is_hidden(),
          description + ': unavailable graphics navigation and quality controls are disabled')
    check(page.locator('#studio-description').inner_text() == 'Graphics unavailable. The turntable and audio controls are ready to use.',
          description + ': accessible guidance describes the usable fallback without offering disabled Studio navigation')
    before = page.evaluate('turntable.state.quartzLock')
    # Quartz's group bounds include the printed leader above the round button.
    page.mouse.click(*deck_point(page, 942, 912))
    check(page.evaluate('turntable.state.quartzLock') != before,
          description + ': physical SVG controls still command the original model')


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='studio-recovery-') as tmp, sync_playwright() as p:
        fixture = Path(tmp) / 'recovery-tone.wav'
        second = b''.join(struct.pack('<h', round(8000 * math.sin(2 * math.pi * 440 * i / 24000))) for i in range(24000))
        with wave.open(str(fixture), 'wb') as wav:
            wav.setparams((1, 2, 24000, 0, 'NONE', 'not compressed')); wav.writeframes(second * 90)
        browser = launch_browser(p)
        try:
            page, errors, external = new_page(browser, 'context')
            page.wait_for_function('studioView.snapshot({bounds:false}).ready && studioView.snapshot({bounds:false}).frameId > 0')
            load_play(page, fixture)
            pixels_before = page.evaluate(ENVIRONMENT_PIXELS, 'before')
            check(pixels_before['connected'] and pixels_before['litFraction'] > .1 and pixels_before['deviation'] > 2,
                  'The initial PMREM environment contains actual rendered lighting pixels', pixels=pixels_before)
            before = page.evaluate(AUDIO_STATE)
            supported = page.evaluate(r'''() => {
              window.__lossExtension = __originalCanvas.getContext('webgl2').getExtension('WEBGL_lose_context');
              if (!__lossExtension) return false;
              __lossExtension.loseContext(); return true;
            }''')
            check(supported, 'The browser exposes WEBGL_lose_context for a real GPU context-loss test')
            page.wait_for_function('document.querySelector("#studio").dataset.graphics === "lost"')
            during = assert_audio_continues(page, before, 'While the WebGL context is lost')
            frame = page.evaluate('studioView.snapshot({bounds:false}).frameId')
            page.evaluate('__lossExtension.restoreContext()')
            page.wait_for_function('frame => document.querySelector("#studio").dataset.graphics !== "lost" && studioView.snapshot({bounds:false}).frameId > frame', arg=frame, timeout=30000)
            pixels_after = page.evaluate(ENVIRONMENT_PIXELS, 'after')
            check(pixels_after['targetReplaced'] and pixels_after['connected']
                  and pixels_after['litFraction'] > .1 and pixels_after['deviation'] > 2
                  and pixels_after['meanAbsoluteDifference'] < 3,
                  'Context restoration regenerates the environment map with matching nonblank GPU pixels', pixels=pixels_after)
            check(page.evaluate('document.querySelector("#studio-canvas") === __originalCanvas')
                  and page.locator('#studio-canvas').is_visible()
                  and page.locator('#studio').get_attribute('data-renderer') == 'webgl',
                  'Context restoration resumes rendering on the same visible canvas')
            assert_audio_continues(page, during, 'After WebGL restoration')
            page.screenshot(path=OUT / 'context-restored.png', full_page=True)
            check(not errors and not external, 'Context recovery produces no uncaught errors or external runtime requests', errors=errors, external=external)
            page.close()

            for mode, description in [('unavailable', 'Unavailable WebGL at startup'), ('partial', 'Failure after native scene construction')]:
                page, errors, external = new_page(browser, mode)
                assert_fallback(page, description)
                if mode == 'partial':
                    disposed = page.evaluate('({disposed: __recoveryGraphics.disposed, resources: __disposedStudioResources})')
                    check(disposed['disposed'] and set(disposed['resources']) == {'reflector-geometry', 'contact-material', 'shadow-material', 'environment-target', 'renderer'},
                          'Partial construction releases its renderer, reflector, AO and environment resources', disposal=disposed)
                load_play(page, fixture)
                before = page.evaluate(AUDIO_STATE)
                assert_audio_continues(page, before, description)
                check(not errors and not external, description + ': no uncaught errors or external runtime requests', errors=errors, external=external)
                page.close()

            page, errors, external = new_page(browser, 'runtime')
            page.wait_for_function('studioView.snapshot({bounds:false}).ready && studioView.snapshot({bounds:false}).frameId > 0')
            load_play(page, fixture)
            before = page.evaluate(AUDIO_STATE)
            page.locator('#studio-enter').click()
            page.wait_for_function('document.querySelector("#studio").dataset.moving === "true"')
            page.evaluate('window.__failStudioUpdate = true')
            assert_fallback(page, 'A renderer exception during playback')
            assert_audio_continues(page, before, 'After a runtime renderer exception')
            check(page.evaluate('__recoveryGraphics.disposed'), 'Runtime fallback disposes the failed native renderer')
            page.keyboard.press('Tab'); page.locator('#power').focus()
            page.wait_for_function('!document.querySelector("#studio-control-focus").hidden')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(150)
            bounds = page.locator('#deck').bounding_box()
            check(bounds['x'] >= -2 and bounds['x'] + bounds['width'] <= 392,
                  'The live SVG fallback remains correctly mapped after a mobile resize', bounds=bounds)
            focus = page.evaluate('''() => {
              const node=document.querySelector('#power'), indicator=document.querySelector('#studio-control-focus');
              const control=node.getBoundingClientRect(), ring=indicator.getBoundingClientRect();
              return {focused:document.activeElement===node, visible:!indicator.hidden,
                x:Math.abs(ring.x+ring.width/2-control.x-control.width/2),
                y:Math.abs(ring.y+ring.height/2-control.y-control.height/2),
                width:ring.width, controlWidth:control.width};
            }''')
            check(focus['focused'] and focus['visible'] and focus['x'] <= 2 and focus['y'] <= 2
                  and focus['width'] >= focus['controlWidth'],
                  'Fallback resize keeps the focused physical control and its visible indicator aligned', alignment=focus)
            page.keyboard.press('Home')
            page.wait_for_function('!turntable.state.power && !turntable.state.powerSettling')
            check(not page.evaluate('turntable.state.power'), 'Keyboard physical controls still work after native rendering fails')
            page.screenshot(path=OUT / 'runtime-fallback-mobile.png', full_page=True)
            check(not errors and not external, 'Runtime recovery produces no uncaught errors or external runtime requests', errors=errors, external=external)
            page.close()
        finally:
            browser.close()
    (OUT / 'checks.json').write_text(json.dumps({'result': 'passed', 'total': len(checks), 'checks': checks}, indent=2) + '\n')
    print(f'All {len(checks)} native Studio recovery checks passed.')


if __name__ == '__main__':
    run()
