"""Drop targeting, keyboard-only arm guidance, and coherent responsive HUD actions."""
import json
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW, arm_point

checks = []
def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)


def run():
    artifacts = ROOT / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1440,'height':1250})
        errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        check(page.locator('h1').inner_text() == 'Why spend $449 on a turntable when you can vibe code one for $10?', 'Hero preserves the exact public turntable joke')
        check(page.locator('.intro-note').inner_text()=='Drop in an MP3 or WAV and play it like a record.', 'Supporting copy stays concise')
        check(page.evaluate("!document.querySelector('footer,.edition')"), 'Decorative edition and footer content stay removed')
        page.evaluate('''() => {
          window.dropData = new DataTransfer();
          dropData.items.add(new File(['test'], 'record.wav', {type:'audio/wav'}));
          window.drag = (type, selector='body') => document.querySelector(selector).dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dropData}));
          drag('dragenter');drag('dragover');
        }''')
        page.wait_for_timeout(200)
        overlay=page.locator('.drop-overlay')
        check(overlay.is_visible(), 'A file drag anywhere on the page shows the platter target')
        bounds=overlay.bounding_box()
        center=page.locator('#deck').evaluate('el=>{const p=new DOMPoint(498,598).matrixTransform(el.getScreenCTM());return {x:p.x,y:p.y}}')
        check(abs(bounds['x']+bounds['width']/2-center['x'])<1 and abs(bounds['y']+bounds['height']/2-center['y'])<1, 'The drop circle is centered on the physical spindle')
        check(abs(bounds['width']-bounds['height'])<1 and overlay.evaluate("el=>getComputedStyle(el).backgroundColor.endsWith('0.06)')"), 'Drop feedback is circular and transparent enough to see the record')
        page.evaluate("drag('dragenter','#deck');drag('dragleave','#deck')")
        check(overlay.is_visible(), 'Crossing nested SVG elements does not flicker the drop target')
        page.screenshot(path=str(artifacts/'polish-drop-desktop.png'),full_page=True)
        page.evaluate("drag('dragleave')")
        overlay.wait_for(state='hidden')
        check(not overlay.is_visible(), 'Leaving the page clears the drop target')
        page.evaluate("drag('dragenter')");page.keyboard.press('Escape')
        overlay.wait_for(state='hidden')
        check(not overlay.is_visible(), 'Escape cancels drag feedback')
        page.evaluate("drag('dragenter');window.dispatchEvent(new Event('blur'))")
        overlay.wait_for(state='hidden')
        check(not overlay.is_visible(), 'Window blur clears drag feedback')
        page.evaluate('''()=>{const dt=new DataTransfer();dt.items.add(new File(['x'],'image.png',{type:'image/png'}));document.body.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:dt}));document.body.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));}''')
        overlay.wait_for(state='hidden')
        check(not overlay.is_visible(), 'Known non-audio drags do not advertise a valid drop')
        page.evaluate("document.dispatchEvent(new Event('dragend'))")
        page.evaluate('''bytes=>{
          const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],'dropped-record.wav',{type:'audio/wav'}));
          document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
        }''',list(RAW.read_bytes()))
        page.wait_for_function("turntable.state.recordPhase==='inserting'")
        overlay.wait_for(state='hidden')
        check(not overlay.is_visible(), 'Dropping clears feedback before the existing insertion animation')
        page.wait_for_function("turntable.state.recordPhase==='ready'")
        check(page.evaluate("turntable.state.filename==='dropped-record.wav' && turntable.state.labelColor==='Blue' && turntable.state.vinylColor==='Black'"), 'A dropped file seats as the shared default black/blue record')
        # Real keyboard focus exposes a separate contextual hint, never the hit area.
        page.locator('#tonearm').focus();page.keyboard.press('ArrowRight')
        check(page.locator('#tonearm-focus').is_visible(), 'Keyboard arm manipulation has a nearby seek hint')
        hint=page.locator('#tonearm-focus').bounding_box()
        led=page.locator('#range-16-led').bounding_box()
        check(hint['y']+hint['height']<led['y'], 'Keyboard hint leaves the tempo-range indicators unobscured')
        path=page.locator('#tonearm .arm-hit-area')
        check(path.evaluate("el=>getComputedStyle(el).strokeOpacity==='0'") and page.locator('#tonearm').evaluate("el=>getComputedStyle(el).outlineStyle==='none'"), 'Keyboard focus leaves the arm hit path invisible and has no bounding box')
        page.screenshot(path=str(artifacts/'polish-focus-desktop.png'),full_page=True)
        page.locator('#customize-open').click();page.keyboard.press('Escape')
        g=page.evaluate('turntable.geometry');s=page.evaluate('turntable.state')
        page.mouse.move(*arm_point(page,g,s['tonearmAngle']));page.mouse.down()
        check(page.evaluate('turntable.state.dragging'), 'The enlarged invisible arm target still captures pointer gestures')
        check(path.evaluate("el=>getComputedStyle(el).strokeOpacity==='0'") and not page.locator('#tonearm-focus').is_visible(), 'Pointer dragging shows neither the hit path nor keyboard-only guidance')
        page.mouse.up()
        page.locator('#transport').click()
        page.wait_for_function("turntable.state.stylusContact && turntable.state.position>1.5")
        page.locator('#transport').click()
        for width,height,name in [(1440,1250,'desktop'),(900,1000,'tablet'),(390,844,'mobile')]:
            page.set_viewport_size({'width':width,'height':height})
            check(page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'{name}: no horizontal overflow')
            boxes=[page.locator('#'+id).bounding_box() for id in ['customize-open','load','eject']]
            check(all(b['height']>=44 for b in boxes) and max(b['height'] for b in boxes)-min(b['height'] for b in boxes)<1,f'{name}: all record actions have matching accessible heights')
            styles=page.locator('.record-action').evaluate_all("els=>els.map(el=>{const s=getComputedStyle(el);return [s.fontSize,s.borderRadius,s.borderWidth].join('|')})")
            check(len(set(styles))==1,f'{name}: record actions share typography, borders, and corners')
            check(page.locator('#customize-open').get_attribute('aria-label')=='Customize turntable and record', f'{name}: concise visual action keeps its full accessible name')
            page.screenshot(path=str(artifacts/f'polish-{name}.png'),full_page=True)
            if name=='mobile':
                page.evaluate("drag('dragenter');drag('dragover')");page.wait_for_timeout(200)
                page.screenshot(path=str(artifacts/'polish-drop-mobile.png'),full_page=True)
                page.keyboard.press('Escape')
        check(not errors,'No browser exceptions during drop, focus, and responsive controls')
        browser.close()
    (artifacts/'polish.json').write_text(json.dumps({'total':len(checks),'checks':checks},indent=2)+'\n')
    print(f'All {len(checks)} polish checks passed.')

if __name__=='__main__': run()
