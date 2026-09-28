"""Six-condition A/B controls, shared visual state, palettes, and responsive dialog."""
import json
import math
from pathlib import Path
import struct
import tempfile
import wave

from playwright.sync_api import sync_playwright
from acceptance import ROOT

checks = []
DESCRIPTIONS = {
    'Mint': 'Pristine. Nearly silent surface with virtually no audible wear.',
    'Near Mint': 'Extremely clean. Faint surface texture with only occasional tiny imperfections.',
    'Very Good+': 'Clean but played. Light vinyl texture with occasional clicks and subtle crackle.',
    'Very Good': 'Clearly used. Audible surface noise, regular crackle and mild groove wear.',
    'Fair': 'Heavily played. Frequent crackle and pops with noticeable loss of clarity.',
    'Poor': 'Worn hard. Dense crackle, frequent pops and obvious groove wear.',
}
CONDITIONS = list(DESCRIPTIONS)
SETTINGS_PROBE = '''(() => {
  const NativeWorklet = AudioWorkletNode;
  window.__conditionSettings = null;
  window.AudioWorkletNode = class extends NativeWorklet {
    constructor(...args) {
      super(...args);
      if (args[1] !== 'vinyl-processor') return;
      const post = this.port.postMessage.bind(this.port);
      this.port.postMessage = (message, ...rest) => {
        if (message.type === 'settings') window.__conditionSettings = {...message.settings};
        return post(message, ...rest);
      };
    }
  };
})();'''

VINYL = ['Black', 'Clear', 'Smoke', 'White', 'Red', 'Orange', 'Amber', 'Yellow', 'Lime', 'Green', 'Teal', 'Cyan', 'Blue', 'Navy', 'Purple', 'Violet', 'Pink', 'Rose']
LABELS = ['Cream', 'White', 'Charcoal', 'Black', 'Red', 'Burgundy', 'Orange', 'Amber', 'Yellow', 'Olive', 'Green', 'Teal', 'Cyan', 'Blue', 'Navy', 'Purple', 'Violet', 'Pink', 'Rose']


def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)


def run():
    artifacts = ROOT / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='condition-ui-') as directory, sync_playwright() as p:
        path = Path(directory) / 'condition-ui-tone.wav'
        with wave.open(str(path), 'wb') as wav:
            wav.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
            second = b''.join(struct.pack('<h', round(6000 * math.sin(i * 2 * math.pi * 440 / 24000))) for i in range(24000))
            wav.writeframes(second * 60)
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width':1440, 'height':1250})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(SETTINGS_PROBE)
        page.goto('http://127.0.0.1:42069')
        page.wait_for_function('window.turntable')
        state = lambda: page.evaluate('turntable.state')
        check(state()['turntableColor'] == 'Silver', 'A fresh session preserves the original silver chassis')
        check(state()['condition'] == 'Very Good+', 'A fresh session uses Very Good+ before loading or opening customization')
        check(state()['volume'] == .69 and page.locator('#volume').input_value() == '0.69' and page.locator('#volume-value').inner_text() == '69%', 'Fresh state and HUD start at 69% output volume')
        check(state()['vinylColor'] == 'Black' and state()['labelColor'] == 'Blue', 'Default material remains black vinyl with a blue label')
        check(all(state()[key] for key in ['surface', 'contacts', 'cartridge']), 'Core surface, contact and cartridge processing default to enabled')
        page.locator('#file-input').set_input_files(path)
        page.wait_for_function("turntable.state.recordPhase==='ready'")
        page.locator('#transport').click()
        page.wait_for_function('turntable.state.position > 1')
        check(not page.locator('#customize').evaluate('el=>el.open') and state()['condition'] == 'Very Good+' and page.evaluate('__conditionSettings.condition') == 'Very Good+', 'Playback starts with Very Good+ in the audio engine before customization is opened')
        check(abs(page.evaluate('turntable.outputLevel') - .69) < .000001, 'The initialized audio output gain uses the 69% default')
        wear = page.evaluate("async () => Object.fromEntries(Object.entries((await import('/static/condition-profiles.js')).CONDITIONS).map(([name, profile]) => [name, profile.visualWear]))")
        check(float(page.locator('#record-wear').get_attribute('opacity')) == wear['Very Good+'], 'First loaded record displays Very Good+ wear before opening customization')
        page.locator('#customize-open').click()
        check(page.get_by_role('radio', name='Very Good+', exact=True).is_checked() and page.locator('#condition-help').inner_text() == DESCRIPTIONS['Very Good+'], 'The first panel opening selects Very Good+ and explains its audible character')
        check(page.locator('#condition-help').get_attribute('aria-live') == 'polite' and page.locator('#condition-help').count() == 1, 'One polite live description serves the active condition')
        check(page.locator('#condition input').evaluate_all('els=>els.map(el=>el.value)') == CONDITIONS, 'The selector exposes exactly six full condition names')
        check(page.locator('#customize select, #customize input[type=checkbox]').count() == 0, 'The primary panel contains neither a condition dropdown nor feature toggles')
        finishes = ['Silver', 'Black', 'White', 'Red', 'Blue', 'Green', 'Purple', 'Rose']
        fixed_materials = page.locator('#chrome, #button, #vinyl, #record-label').evaluate_all('els=>els.map(el=>el.outerHTML)')
        for finish in finishes:
            before = state()['position']
            button = page.get_by_role('button', name=f'Turntable: {finish}', exact=True)
            button.click()
            check(state()['turntableColor'] == finish and button.get_attribute('aria-pressed') == 'true' and page.locator('#turntable-swatches [aria-pressed=true]').count() == 1, f'{finish}: chassis finish has one authoritative, accessible selection')
            check(state()['position'] >= before and state()['stylusContact'] and state()['platterRunning'], f'{finish}: changing the chassis preserves active playback')
        check(page.locator('#chrome, #button, #vinyl, #record-label').evaluate_all('els=>els.map(el=>el.outerHTML)') == fixed_materials, 'Chassis finishes preserve chrome, physical controls, vinyl and label materials')
        page.evaluate("turntable.controls.customize('turntableColor', 'Invalid')")
        check(state()['turntableColor'] == 'Rose', 'Unknown chassis finishes are rejected by the model')
        black = page.get_by_role('button', name='Turntable: Black', exact=True)
        black.focus(); page.keyboard.press('Enter')
        check(state()['turntableColor'] == 'Black' and page.locator('#deck').get_attribute('aria-label').startswith('Black '), 'Keyboard activation updates the finish and accessible deck description')
        previous = state()['position']
        for condition in CONDITIONS + ['Poor', 'Mint', 'Very Good+']:
            page.get_by_role('radio', name=condition, exact=True).check()
            current = state()
            check(current['condition'] == condition and page.get_by_role('radio', name=condition, exact=True).is_checked(), f'{condition}: click updates authoritative condition and selected segment')
            check(page.locator('#condition-help').inner_text() == DESCRIPTIONS[condition] and page.evaluate('__conditionSettings.condition') == condition, f'{condition}: the active description and audio settings match the same selected condition')
            check(float(page.locator('#record-wear').get_attribute('opacity')) == wear[condition], f'{condition}: visual wear uses the shared condition profile')
            check(current['position'] >= previous and current['platterRunning'] and current['stylusContact'] and current['assistPhase'] == 'idle', f'{condition}: live selection preserves continuous playback and groove contact')
            previous = current['position']
        page.get_by_role('radio', name='Mint', exact=True).focus()
        page.keyboard.press('ArrowRight')
        check(state()['condition'] == 'Near Mint' and page.get_by_role('radio', name='Near Mint', exact=True).evaluate('el=>document.activeElement===el'), 'Arrow keys select and focus the next condition using native radio behavior')
        page.keyboard.press('ArrowLeft')
        check(state()['condition'] == 'Mint', 'Arrow keys can return to Mint without leaving the selector')
        check(page.locator('#condition input:checked + span').evaluate("el=>getComputedStyle(el).backgroundColor") == page.locator('#transport').evaluate("el=>getComputedStyle(el).backgroundColor"), 'Selected condition uses the shared blue software accent')
        for key, names in [('vinylColor', VINYL), ('labelColor', LABELS)]:
            prefix = 'Vinyl' if key == 'vinylColor' else 'Label'
            check(page.locator('#vinyl-swatches button' if prefix == 'Vinyl' else '#label-swatches button').count() == len(names), f'{prefix} palette includes all {len(names)} requested colors')
            for name in names:
                button = page.get_by_role('button', name=f'{prefix}: {name}', exact=True)
                button.click()
                check(state()[key] == name and button.get_attribute('aria-pressed') == 'true', f'{prefix}: {name} applies and has an accessible selected state')
            check(page.locator('#grooves circle').count() == 191, f'{prefix} palette preserves the record groove texture')
        page.get_by_role('button', name='Label: Black', exact=True).click()
        check(page.locator('#record-label').evaluate("el=>el.style.getPropertyValue('--label-ink')") == '#ffffff', 'Dark labels automatically receive light text')
        page.get_by_role('button', name='Label: White', exact=True).click()
        check(page.locator('#record-label').evaluate("el=>el.style.getPropertyValue('--label-ink')") == '#000000', 'Light labels automatically receive dark text')
        for key, maximum in [('wow', 'Noticeable'), ('centering', 'Off-center')]:
            page.locator('#' + key).fill('1')
            check(page.locator('#' + key + '-value').inner_text() == maximum and page.locator('#' + key).get_attribute('aria-valuetext') == maximum, f'{key} uses a clear human-readable maximum for sighted and screen-reader users')
            page.locator('#' + key).fill('0')
        check(page.locator('#wow-value').inner_text() == 'Off' and page.locator('#centering-value').inner_text() == 'Perfect', 'Mechanical defaults communicate off and perfect centering')
        page.get_by_role('button', name='Vinyl: Black', exact=True).click()
        page.get_by_role('button', name='Label: Blue', exact=True).click()
        page.get_by_role('radio', name='Very Good+', exact=True).check()
        for width, height, name in [(1440,1250,'desktop'), (900,1000,'tablet'), (390,844,'mobile'), (320,740,'narrow')]:
            page.set_viewport_size({'width':width,'height':height})
            panel = page.locator('#customize')
            check(panel.evaluate('el=>el.scrollWidth<=el.clientWidth') and page.evaluate('document.documentElement.scrollWidth<=innerWidth'), f'{name}: panel and page have no horizontal overflow')
            check(page.locator('#condition input').count() == 6 and page.locator('#customize select').count() == 0, f'{name}: all six conditions remain direct controls')
            check(page.locator('.swatch').evaluate_all('els=>els.every(el=>el.getBoundingClientRect().width>=24 && el.getBoundingClientRect().height>=24)'), f'{name}: color swatches retain accessible pointer targets')
            page.locator('#customize').evaluate('el=>el.scrollTop=0')
            page.screenshot(path=str(artifacts / f'condition-customize-{name}.png'), full_page=True)
        page.keyboard.press('Escape')
        check(not page.locator('#customize').evaluate('el=>el.open'), 'Escape closes customization normally')
        page.set_viewport_size({'width':1440, 'height':1250})
        page.evaluate("turntable.controls.customize('condition', 'Fair')")
        replacement = Path(directory) / 'replacement.wav'
        replacement.write_bytes(path.read_bytes())
        page.locator('#file-input').set_input_files(replacement)
        page.wait_for_function("turntable.state.recordPhase==='ready' && turntable.state.filename==='replacement.wav'")
        check(state()['condition'] == 'Fair' and page.evaluate('__conditionSettings.condition') == 'Fair' and float(page.locator('#record-wear').get_attribute('opacity')) == wear['Fair'], 'Direct replacement preserves the chosen condition in state, audio and visual wear')
        page.locator('#eject').click()
        page.wait_for_function("turntable.state.recordPhase==='empty'")
        check(state()['condition'] == 'Fair' and state()['turntableColor'] == 'Black', 'Ejection preserves record condition and turntable finish')
        page.locator('#file-input').set_input_files(path)
        page.wait_for_function("turntable.state.recordPhase==='ready'")
        page.locator('#customize-open').click()
        check(state()['turntableColor'] == 'Black' and page.get_by_role('button', name='Turntable: Black', exact=True).get_attribute('aria-pressed') == 'true', 'Replacement and eject/reload retain the selected chassis finish')
        check(state()['condition'] == 'Fair' and page.get_by_role('radio', name='Fair', exact=True).is_checked() and page.locator('#condition-help').inner_text() == DESCRIPTIONS['Fair'], 'Loading after eject preserves the selection and description')
        check(float(page.locator('#record-wear').get_attribute('opacity')) == wear['Fair'] and page.evaluate('__conditionSettings.condition') == 'Fair', 'Loading after eject preserves the same visual and audio profile')
        page.reload()
        page.wait_for_function('window.turntable')
        check(state()['condition'] == 'Very Good+' and state()['volume'] == .69 and state()['turntableColor'] == 'Silver', 'A new page resets condition, volume and chassis to their defaults')
        check(not errors, 'Customization produces no browser exceptions')
        browser.close()
    (artifacts / 'customization.json').write_text(json.dumps({'total':len(checks), 'checks':checks}, indent=2) + '\n')
    print(f'All {len(checks)} customization checks passed.')


if __name__ == '__main__':
    run()
