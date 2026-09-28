"""Rendered record/spindle occlusion at controlled production-animation frames.

The counterfactual screenshot temporarily hides only the test page's spindle.
Pixels that change reveal exactly where permanent hardware was visible; this
catches wrong SVG paint order even when normal silver and paper colors are close.
Production never hides or fades that hardware.
"""
import base64
import json
import math
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW

checks = []


def check(value, description, **details):
    assert value, f'{description}: {details}'
    checks.append({'check': description, **details})
    print(f'PASS {description}', flush=True)


SETUP = '''() => {
  const hardware = ['chassis-brand', 'tonearm-base', 'rpm-78', 'start-stop', 'rpm-33',
    'rpm-45', 'power', 'pitch-range', 'target-light', 'strobe-dots', 'spindle', 'mat-brand'];
  window.occlusionHardware = hardware.map(id => {
    const node = document.getElementById(id), box = node.getBoundingClientRect();
    return {id, node, box: {x:box.x,y:box.y,width:box.width,height:box.height}};
  });
  window.occlusionHardwareCheck = () => occlusionHardware.every(({id,node,box}) => {
    if(document.getElementById(id)!==node || document.getElementById('record-lift').contains(node)) return false;
    const now = node.getBoundingClientRect();
    if(Object.keys(box).some(key => Math.abs(now[key]-box[key]) > .01)) return false;
    for(let ancestor=node; ancestor; ancestor=ancestor.parentElement) {
      const style=getComputedStyle(ancestor);
      if(style.display==='none' || style.visibility!=='visible' || Number(style.opacity)<.999) return false;
    }
    return !node.getAnimations().length;
  });
  window.occlusionPixels = async encoded => {
    const bitmap = await createImageBitmap(await(await fetch('data:image/png;base64,'+encoded)).blob());
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
    return {width:canvas.width,data:context.getImageData(0,0,canvas.width,canvas.height).data};
  };
  // Pause only the two record animations at creation, avoiding any race with
  // decoding, a slow screenshot, or the intentionally short production timing.
  const animate=Element.prototype.animate;
  Element.prototype.animate=function(...args) {
    const animation=animate.apply(this,args);
    if(['record-lift','record-shadow'].includes(this.id)) {animation.pause();animation.currentTime=0;}
    return animation;
  };
}'''


def run():
    artifacts = ROOT / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    samples = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 1500}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        page.evaluate(SETUP)
        bounds = page.locator('#deck').bounding_box()
        clip = {'x': math.floor(bounds['x']), 'y': math.floor(bounds['y']),
                'width': math.ceil(bounds['width']), 'height': math.ceil(bounds['height'])}
        check(page.evaluate('''() => {
          const spindle=document.getElementById('spindle'), record=document.getElementById('record');
          return !!(spindle.compareDocumentPosition(record)&Node.DOCUMENT_POSITION_FOLLOWING)
            && getComputedStyle(record).maskImage !== 'none';
        }'''), 'Permanent spindle paints beneath a record with a real center-hole mask')

        def phase(value):
            page.wait_for_function('value => turntable.state.recordPhase===value', arg=value)

        def motion(kind, color):
            phase('inserting' if kind == 'insert' else 'ejecting')
            page.wait_for_function("document.getElementById('record-lift').getAnimations().length>0")
            duration = page.evaluate("document.getElementById('record-lift').getAnimations()[0].effect.getTiming().duration")
            check(100 < duration < 2000, f'{color} {kind}: production timing remains enabled', duration=duration)
            for progress in [0, .25, .5, .75, 1]:
                name = f'{color.lower()}-{kind}-{round(progress*100)}'
                page.evaluate('''progress => {
                  for(const id of ['record-lift','record-shadow'])
                    for(const animation of document.getElementById(id).getAnimations()) {
                      animation.pause();animation.currentTime=progress*animation.effect.getTiming().duration;
                    }
                }''', progress)
                state = page.evaluate('''() => {
                  const record=document.getElementById('record'),lift=document.getElementById('record-lift');
                  const matrix=record.getScreenCTM(),center=new DOMPoint(498,598).matrixTransform(matrix);
                  const spindle=new DOMPoint(498,598).matrixTransform(document.getElementById('spindle').getScreenCTM());
                  return {opacity:Number(getComputedStyle(lift).opacity),center:[center.x,center.y],
                    scale:Math.hypot(matrix.a,matrix.b),separation:Math.hypot(center.x-spindle.x,center.y-spindle.y),
                    paperOpacity:Number(getComputedStyle(document.querySelector('.label-paper')).fillOpacity),
                    hardware:occlusionHardwareCheck(),hidden:getComputedStyle(record).display==='none'};
                }''')
                normal = page.screenshot(clip=clip, path=str(artifacts / f'occlusion-{name}.png'))
                # This is a diagnostic counterfactual in a disposable browser,
                # never the lifecycle's production approach to spindle visibility.
                page.locator('#spindle').evaluate("node=>node.style.visibility='hidden'")
                without = page.screenshot(clip=clip)
                page.locator('#spindle').evaluate("node=>node.style.removeProperty('visibility')")
                result = page.evaluate('''async ([normal,without,state,clip,color]) => {
                  const a=await occlusionPixels(normal),b=await occlusionPixels(without);
                  let visiblePixels=0,forbiddenPixels=0,holePixels=0,maxForbiddenDifference=0;
                  const opaqueRadius=(['Clear','Smoke'].includes(color)?110:333)*state.scale;
                  const holeRadius=6*state.scale;
                  for(let i=0;i<a.data.length;i+=4) {
                    const difference=Math.max(...[0,1,2].map(c=>Math.abs(a.data[i+c]-b.data[i+c])));
                    if(difference<=3) continue;
                    visiblePixels++;
                    const x=clip.x+(i/4)%a.width+.5,y=clip.y+Math.floor((i/4)/a.width)+.5;
                    const distance=Math.hypot(x-state.center[0],y-state.center[1]);
                    if(distance<holeRadius+1.5) holePixels++;
                    // Exclude the narrow antialiased edges of both real circles.
                    if(state.opacity>.999 && !state.hidden && distance>holeRadius+1.5 && distance<opaqueRadius-1.5) {
                      forbiddenPixels++;maxForbiddenDifference=Math.max(maxForbiddenDifference,difference);
                    }
                  }
                  return {visiblePixels,forbiddenPixels,holePixels,maxForbiddenDifference};
                }''', [base64.b64encode(normal).decode(), base64.b64encode(without).decode(), state, clip, color])
                sample = {'name': name, 'progress': progress, **state, **result}
                samples.append(sample)
                check(state['hardware'] and state['paperOpacity'] == 1,
                      f'{name}: permanent hardware and opaque label retain their styles and geometry')
                check(result['forbiddenPixels'] == 0,
                      f'{name}: spindle never paints through solid vinyl or paper', **result)
                if (kind == 'insert' and progress == 0) or (kind == 'eject' and progress == 1):
                    check(state['opacity'] == 0,
                          f'{name}: media enters or leaves invisibly at the elevated endpoint')
                if state['opacity'] < .999 and not state['hidden']:
                    check(state['separation'] > 110 * state['scale'],
                          f'{name}: any lifecycle fade occurs with the label physically separated from the spindle',
                          separation=state['separation'], opacity=state['opacity'])
                if (kind == 'insert' and progress == 1) or (kind == 'eject' and progress == 0):
                    check(state['opacity'] == 1 and state['separation'] < .1
                          and result['holePixels'] > 8 and result['holePixels'] == result['visiblePixels'],
                          f'{name}: only the spindle visible through the aligned real hole remains exposed', **result)
            page.evaluate("for(const id of ['record-lift','record-shadow']) document.getElementById(id).getAnimations().forEach(a=>a.play())")
            phase('ready' if kind == 'insert' else 'empty')

        for color in ['Black', 'White', 'Blue', 'Red', 'Clear', 'Smoke']:
            page.evaluate("color=>turntable.controls.customize('vinylColor',color)", color)
            # Use the real chooser entry point, then the same record lifecycle.
            with page.expect_file_chooser() as picker:
                page.locator('#load').click()
            picker.value.set_files(RAW)
            motion('insert', color)
            seated = page.screenshot(clip=clip)
            page.locator('#mat-brand').evaluate("node=>node.style.visibility='hidden'")
            plain = page.screenshot(clip=clip)
            page.locator('#mat-brand').evaluate("node=>node.style.removeProperty('visibility')")
            platter_pixels = page.evaluate('''async ([a,b]) => {
              const actual=await occlusionPixels(a),plain=await occlusionPixels(b);let visible=0;
              for(let i=0;i<actual.data.length;i+=4)
                if([0,1,2].some(c=>Math.abs(actual.data[i+c]-plain.data[i+c])>3)) visible++;
              return visible;
            }''', [base64.b64encode(seated).decode(), base64.b64encode(plain).decode()])
            transparent = color in ['Clear', 'Smoke']
            check(platter_pixels > 50 if transparent else platter_pixels == 0,
                  f'{color}: playable body {"intentionally reveals" if transparent else "fully occludes"} the slipmat print',
                  visible_pixels=platter_pixels)
            page.locator('#eject').click()
            motion('eject', color)
        check(page.evaluate('occlusionHardwareCheck()'), 'All permanent hardware survives six complete record lifecycles')
        check(not errors, 'No browser exceptions during color and occlusion frame checks', errors=errors)
        (artifacts / 'occlusion.json').write_text(json.dumps({'result': 'passed', 'total': len(checks),
                                                            'checks': checks, 'samples': samples}, indent=2) + '\n')
        browser.close()
    print(f'All {len(checks)} occlusion checks passed.')


if __name__ == '__main__':
    run()
