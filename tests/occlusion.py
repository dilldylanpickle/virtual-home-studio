"""Native mesh depth/center-hole checks at controlled production lifecycle frames.

Counterfactuals use gated offscreen renderer passes. They hide only the measured
mesh, share shadows/reflections, and disable AO equally; production never hides
permanent hardware. Browser canvas decoding requires no image-library package.
"""
import base64
import json
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW
from studio_helpers import enter_turntable, launch_browser

checks = []


def check(value, description, **details):
    assert value, f'{description}: {details}'
    checks.append({'check': description, **details})
    print(f'PASS {description}', flush=True)


NATIVE_SETUP = '''() => {
  const names = ['vhs-chassis','vhs-top','vhs-platter','tonearm-base',
    'vhs-power','vhs-range','vhs-targetLight','vhs-strobeDots',
    'vhs-spindle','vhs-spindleTip','vhs-lettering','vhs-frontPrint','vhs-slipmatPrint'];
  const initial = studioView.snapshot({bounds:false});
  window.nativeHardware = names.map(name => ({name, initial:initial.objects[name]}));
  window.nativeHardwareCheck = () => {
    const snapshot = studioView.snapshot({bounds:false});
    return nativeHardware.every(({name,initial}) => {
      const now = snapshot.objects[name];
      return initial && now && now.id === initial.id && now.effectiveVisible
        && !now.removableMedia && now.material?.opacity !== 0
        && JSON.stringify(now.localPosition) === JSON.stringify(initial.localPosition)
        && JSON.stringify(now.scale) === JSON.stringify(initial.scale)
        && JSON.stringify(now.material) === JSON.stringify(initial.material);
    });
  };
  window.nativePixels = async url => {
    const bitmap = await createImageBitmap(await(await fetch(url)).blob());
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
    return {width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data};
  };
  window.nativeAuditPixels = async (mode, color='Black') => {
    // Apply the paused lifecycle's current presentation before freezing a pair.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const snapshot=studioView.snapshot({bounds:false});
    const pair=studioView.capturePass(['media-visibility', mode]);
    const a=await nativePixels(pair['media-visibility']),b=await nativePixels(pair[mode]);
    const sx=a.width/snapshot.size.width,sy=a.height/snapshot.size.height;
    const project=(name,p)=>{const v=studioView.projectPoint(name,p);return {x:v.x*sx,y:v.y*sy};};
    const center=project('vhs-record',[0,.0017,0]);
    const outer=project('vhs-record',[.335,.0017,0]);
    const scale=Math.hypot(outer.x-center.x,outer.y-center.y)/.335;
    const hole=snapshot.visual.mediaGeometry.labelHole*scale;
    const opaque=(['Clear','Smoke'].includes(color)?.110:.333)*scale;
    let roi=null;
    if(mode==='without-slipmat-print') {
      const points=[[-.170,-.025,0],[-.170,.025,0],[.170,-.025,0],[.170,.025,0]].map(p=>project('vhs-slipmatPrint',p));
      roi={left:Math.min(...points.map(p=>p.x))-2,right:Math.max(...points.map(p=>p.x))+2,
        top:Math.min(...points.map(p=>p.y))-2,bottom:Math.max(...points.map(p=>p.y))+2};
    } else if(mode==='without-chassis-print') {
      const points=[[773,939],[1005,939],[773,978],[1005,978]].map(([x,z])=>project('vhs-turntable',[(x-602)/1000,.07518,(z-594)/1000]));
      roi={left:Math.min(...points.map(p=>p.x))-2,right:Math.max(...points.map(p=>p.x))+2,
        top:Math.min(...points.map(p=>p.y))-2,bottom:Math.max(...points.map(p=>p.y))+2};
    }
    let visiblePixels=0,nearPixels=0,forbiddenPixels=0,holePixels=0,maxForbiddenDifference=0,minChannel=255,maxChannel=0;
    for(let i=0;i<a.data.length;i+=4) {
      const x=(i/4)%a.width+.5,y=Math.floor((i/4)/a.width)+.5;
      minChannel=Math.min(minChannel,a.data[i],a.data[i+1],a.data[i+2]);
      maxChannel=Math.max(maxChannel,a.data[i],a.data[i+1],a.data[i+2]);
      if(roi&&(x<roi.left||x>roi.right||y<roi.top||y>roi.bottom)) continue;
      const difference=Math.max(...[0,1,2].map(c=>Math.abs(a.data[i+c]-b.data[i+c])));
      if(difference<=3) continue;
      visiblePixels++;
      if(mode==='without-spindle') {
        const distance=Math.hypot(x-center.x,y-center.y);
        // The spindle can only appear within the record; the translucent open lid can
        // flicker a lone edge pixel elsewhere between the two passes.
        if(distance<opaque+2) nearPixels++;
        if(distance<hole+2) holePixels++;
        if(snapshot.visual.recordPresent&&snapshot.visual.recordOpacity>.999&&distance>hole+2&&distance<opaque-2) {
          forbiddenPixels++;maxForbiddenDifference=Math.max(maxForbiddenDifference,difference);
        }
      }
    }
    return {visiblePixels,nearPixels,forbiddenPixels,holePixels,maxForbiddenDifference,
      dynamicRange:maxChannel-minChannel,hardware:nativeHardwareCheck(),visual:snapshot.visual,
      image:pair['media-visibility'],center,scale,roi};
  };
  // Keep original production timing; pause only shared removable-media effects.
  const animate=Element.prototype.animate;
  Element.prototype.animate=function(...args) {
    const animation=animate.apply(this,args);
    if(['record-lift','record-shadow'].includes(this.id)) {animation.pause();animation.currentTime=0;}
    return animation;
  };
}'''


def open_native(page):
    page.goto('http://127.0.0.1:42069/?studioDiagnostics=1')
    page.wait_for_function('window.turntable && window.studioView?.snapshot().ready')
    assert page.evaluate("studioView.snapshot({bounds:false}).renderer==='Three.js WebGL'"), 'Native renderer required for mesh occlusion'
    enter_turntable(page)
    page.evaluate(NATIVE_SETUP)


def phase(page, value):
    page.wait_for_function('value=>turntable.state.recordPhase===value', arg=value)


def set_motion_frame(page, progress):
    page.evaluate('''progress => {
      for(const id of ['record-lift','record-shadow'])
        for(const animation of document.getElementById(id).getAnimations()) {
          animation.pause();animation.currentTime=progress*animation.effect.getTiming().duration;
        }
    }''', progress)


def resume_motion(page):
    page.evaluate("for(const id of ['record-lift','record-shadow']) document.getElementById(id).getAnimations().forEach(a=>a.play())")


def native_sample(page, mode, color, path=None):
    sample = page.evaluate('([mode,color])=>nativeAuditPixels(mode,color)', [mode, color])
    image = sample.pop('image')
    if path:
        path.write_bytes(base64.b64decode(image.split(',', 1)[1]))
    return sample


def run():
    artifacts = ROOT / 'artifacts'; artifacts.mkdir(exist_ok=True)
    samples = []
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page(viewport={'width': 1440, 'height': 1500}, device_scale_factor=1)
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        open_native(page)
        geometry = page.evaluate('studioView.snapshot({bounds:false}).visual.mediaGeometry')
        check(geometry == {'vinylHole': .006, 'labelHole': .006, 'labelRadius': .11},
              'Visible native vinyl and opaque label have real aligned annular center holes')
        empty = native_sample(page, 'without-spindle', 'Black')
        check(empty['dynamicRange'] > 40 and empty['visiblePixels'] > 4,
              'Native RGBA8 readback contains a visible spindle before media loads', pixels=empty['visiblePixels'])

        def motion(kind, color):
            phase(page, 'inserting' if kind == 'insert' else 'ejecting')
            page.wait_for_function("document.getElementById('record-lift').getAnimations().length>0")
            duration = page.evaluate("document.getElementById('record-lift').getAnimations()[0].effect.getTiming().duration")
            check(100 < duration < 2000, f'{color} {kind}: shared production timing remains enabled', duration=duration)
            for progress in [0, .25, .5, .75, 1]:
                name = f'{color.lower()}-{kind}-{round(progress*100)}'
                set_motion_frame(page, progress)
                sample = native_sample(page, 'without-spindle', color, artifacts / f'occlusion-{name}.png')
                samples.append({'name': name, 'progress': progress, **sample})
                visual = sample['visual']
                check(sample['dynamicRange'] > 40 and sample['hardware'],
                      f'{name}: permanent native hardware retains identity, material, transform and visibility')
                check(sample['forbiddenPixels'] == 0,
                      f'{name}: native depth prevents spindle pixels crossing solid vinyl or opaque paper',
                      forbidden_pixels=sample['forbiddenPixels'], max_difference=sample['maxForbiddenDifference'])
                if (kind == 'insert' and progress == 0) or (kind == 'eject' and progress == 1):
                    check(visual['recordOpacity'] == 0 and visual['recordLift'] > .12,
                          f'{name}: only elevated media fades at the lifecycle endpoint')
                if (kind == 'insert' and progress == 1) or (kind == 'eject' and progress == 0):
                    check(visual['recordOpacity'] == 1 and abs(visual['recordLift']) < .00001
                          and sample['holePixels'] > 4 and sample['holePixels'] == sample['nearPixels'],
                          f'{name}: seated spindle is exposed only through the real center hole',
                          hole_pixels=sample['holePixels'], visible_pixels=sample['nearPixels'], stray_pixels=sample['visiblePixels'] - sample['nearPixels'])
            resume_motion(page)
            phase(page, 'ready' if kind == 'insert' else 'empty')

        for color in ['Black', 'White', 'Blue', 'Red', 'Clear', 'Smoke']:
            page.evaluate("color=>turntable.controls.customize('vinylColor',color)", color)
            with page.expect_file_chooser() as picker:
                page.locator('#load').click(); page.locator('#source-local').click()
            picker.value.set_files(RAW)
            motion('insert', color)
            print_sample = native_sample(page, 'without-slipmat-print', color)
            transparent = color in ['Clear', 'Smoke']
            check(print_sample['visiblePixels'] > 25 if transparent else print_sample['visiblePixels'] == 0,
                  f'{color}: native media {"reveals" if transparent else "occludes"} the actual slipmat print',
                  visible_pixels=print_sample['visiblePixels'])
            check(print_sample['visual']['recordOpacity'] == 1,
                  f'{color}: paper label stays fully opaque regardless of vinyl transparency')
            page.locator('#eject').click(); motion('eject', color)
        check(page.evaluate('nativeHardwareCheck()'), 'All permanent meshes survive six complete record lifecycles')
        check(not errors, 'No browser exceptions during native depth and color lifecycle checks', errors=errors)
        (artifacts / 'occlusion.json').write_text(json.dumps({'result': 'passed', 'total': len(checks), 'checks': checks, 'samples': samples}, indent=2) + '\n')
        browser.close()
    print(f'All {len(checks)} native occlusion checks passed.')


if __name__ == '__main__':
    run()
