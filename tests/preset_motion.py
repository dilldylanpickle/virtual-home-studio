"""Measure physical preset travel, audible pitch glide, and manual takeover."""
import json
from playwright.sync_api import sync_playwright
from acceptance import ROOT, RAW, PROBE, set_power
from audio_fixtures import generated_long_record

checks=[]
def check(ok,message):
    assert ok,message
    checks.append(message);print('PASS '+message,flush=True)

TRACE='''async id => {
  const rows=[];
  const sample=()=>{
    const s=turntable.state,a=__probe.analyser,d=new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(d);const edges=[];
    for(let i=1;i<d.length;i++)if(d[i-1]<=0&&d[i]>0)edges.push(i);
    rows.push({pitch:s.pitch,range:s.pitchRange,quartz:s.quartzLock,rpm:s.rpm,
      fraction:s.pitch/s.pitchRange,position:s.position,moving:!!s.presetMotion,
      slider:Number(document.querySelector('#pitch').value),rate:s.motorActualRate,
      hz:edges.length>1?(edges.length-1)*a.context.sampleRate/(edges.at(-1)-edges[0]):0,
      rms:Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length),peak:Math.max(...d.map(Math.abs))});
  };
  sample();turntable.controls.applyPreset(id);sample();
  await new Promise(resolve=>{let settled=null;const tick=now=>{
    sample();if(!turntable.state.presetMotion){settled??=now;if(now-settled>150){resolve();return;}}
    requestAnimationFrame(tick);
  };requestAnimationFrame(tick)});
  return rows;
}'''

def run():
    out=ROOT/'artifacts/preset-motion';out.mkdir(parents=True,exist_ok=True)
    with generated_long_record() as record,sync_playwright() as p:
        browser=p.chromium.launch();page=browser.new_page(viewport={'width':1440,'height':1400});page.add_init_script(PROBE)
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:42069');page.locator('#file-input').set_input_files(record)
        page.wait_for_function("turntable.state.recordPhase==='ready'")
        state=lambda:page.evaluate('turntable.state')
        def apply(id):
            page.evaluate('id=>turntable.controls.applyPreset(id)',id)
        def settle():page.wait_for_function('!turntable.state.presetMotion')
        def pause():
            page.evaluate('turntable.controls.pause()');page.wait_for_function("turntable.state.transportState==='paused'")
        page.evaluate("turntable.controls.customize('surface',false);turntable.controls.customize('contacts',false);turntable.controls.customize('cartridge',false)")
        page.locator('#transport').click();page.wait_for_function("turntable.state.position>1.6 && !turntable.state.motorRamping")
        traces={}
        for id,end in [('slowed',-16),('slightly-sped-up',16),('original',0)]:
            rows=page.evaluate(TRACE,id);traces[id]=rows
            check(sum(r['moving'] and abs(r['pitch']-end)>.1 for r in rows)>8, f'{id}: fader moves through multiple real model positions')
            check(max(abs(b['fraction']-a['fraction']) for a,b in zip(rows,rows[1:]))<.2,f'{id}: fader never teleports, including range changes')
            check(all(abs(r['slider']-r['pitch'])<=.051 for r in rows[2:]),f'{id}: rendered physical fader follows the audio-driving pitch')
            check(rows[-1]['pitch']==end and all(r['rms']>.01 and r['peak']<1 for r in rows),f'{id}: audio remains present and unclipped throughout travel')
            check(abs(rows[-1]['hz']-440*(1+end/100))<5,f'{id}: measured output reaches the requested pitch')
            lo,hi=sorted((rows[0]['hz'],rows[-1]['hz']))
            check(sum(lo+6<r['hz']<hi-6 for r in rows)>5,f'{id}: actual audio glides through intermediate frequencies')
            check(all(not r['quartz'] or abs(r['pitch'])<.001 for r in rows),f'{id}: Quartz only locks at center')
        check(all(abs(a['fraction']-b['fraction'])<1e-8 for a,b in zip(traces['original'],traces['original'][1:]) if a['range']!=b['range']), 'Range switch preserves the physical fader position without a centering detour')
        # A real manual fader offset may be hidden by Quartz until it is unlocked.
        page.locator('#pitch').fill('6');rows=page.evaluate(TRACE,'nightcore');traces['locked-offset']=rows
        unlocking=[(a,b) for a,b in zip(rows,rows[1:]) if a['quartz'] and not b['quartz']]
        check(unlocking and all(abs(a['fraction']-b['fraction'])<1e-8 for a,b in unlocking), 'Quartz unlocks at the current fader position, just like a manual button press')
        check(rows[1]['rpm']==45 and abs(rows[1]['fraction']-rows[0]['fraction'])<1e-8, 'RPM latches change immediately while the fader starts from its actual position')
        pause();apply('sped-up');settle()
        for id,pitch in [('hyperpop',-16),('sped-up',-8)]:
            before=state();apply(id);after=state();page.wait_for_timeout(300)
            check(after['pitch']==pitch and after['pitch']/after['pitchRange']==before['pitch']/before['pitchRange'] and not after['presetMotion'] and state()['pitch']==pitch, f'{id}: −8% ↔ −16% changes range without moving the fader at all')
        apply('nightcore');settle()
        pause();before=state();apply('hyperpop');page.wait_for_timeout(150);middle=state()
        check(middle['presetMotion'] and middle['rpm']==78 and middle['transportPaused'] and middle['position']==before['position'], 'Preset movement preserves paused groove and switches RPM immediately')
        apply('sped-up');settle();page.wait_for_timeout(300)
        check(state()['pitch']==-8 and state()['rpm']==45 and state()['transportPaused'], 'A newer preset retargets and the old preset never returns')
        for control in ['pitch','pitch-range','quartz','rpm-33']:
            apply('slightly-sped-up');page.wait_for_timeout(130)
            if control=='pitch':page.locator('#pitch').fill('3')
            else:page.locator('#'+control).click()
            before=state();page.wait_for_timeout(1100);after=state()
            keys=['pitch','pitchRange','quartzLock','speed33Pressed','speed45Pressed']
            check(not after['presetMotion'] and all(before[k]==after[k] for k in keys),f'Manual {control} takes over with no stale preset callback')
        apply('slowed');page.wait_for_timeout(120)
        pitch=page.locator('#pitch');pitch.scroll_into_view_if_needed();b=pitch.bounding_box()
        page.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2);page.mouse.down();page.mouse.up()
        before=state();page.wait_for_timeout(900)
        check(not state()['presetMotion'] and state()['pitch']==before['pitch'],'Grabbing the fader cancels automatic travel immediately')
        apply('nightcore');page.wait_for_timeout(100);set_power(page,False);before=state();page.wait_for_timeout(900)
        check(not state()['presetMotion'] and state()['pitch']==before['pitch'],'Power off cancels pending preset travel')
        apply('original');settle();apply('slowed');page.wait_for_timeout(120)
        page.evaluate('void turntable.controls.eject()');before=state()
        page.wait_for_function("turntable.state.recordPhase==='empty'")
        check(not state()['presetMotion'] and state()['pitch']==before['pitch'],'Eject cancels fader motion before handling the record')
        page.locator('#file-input').set_input_files(RAW);page.wait_for_function("turntable.state.recordPhase==='ready'")
        apply('nightcore');page.wait_for_timeout(120)
        page.locator('#file-input').set_input_files(RAW);page.wait_for_function("turntable.state.recordPhase==='ready'")
        before=state();page.wait_for_timeout(1000)
        check(not state()['presetMotion'] and state()['pitch']==before['pitch'],'Replacement cannot inherit a stale preset animation')
        check(page.evaluate('__probe.worklets===1&&__probe.starts===0'),'Preset travel retains one persistent audio processor')
        check(not errors,'No browser or audio errors during preset motion')
        browser.close()
    (out/'checks.json').write_text(json.dumps({'checks':checks,'traces':traces},indent=2))
    print(f'All {len(checks)} preset motion checks passed.')

if __name__=='__main__':run()
