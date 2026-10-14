import { TranceGate } from './trance-gate.js';
import { CAT_PATTERNS, GATE_RATES, GATE_SHAPES, GATE_STEPS, GATE_STYLES, KEY_NAMES, KIT_BARS, KIT_PATTERNS, KIT_SOUNDS, confidenceLabel, gateCycle, kitName, styleName } from './tempo-grid.js';

const $ = id => document.getElementById(id);
const percent = value => `${Math.round(value * 100)}%`;

/** Tempo and effects column of the presets popup (Trance Gate, Hardstyle, Pixel Cat), plus
 * the BPM chip on the track line. Presentation only: every action delegates to the model
 * through `controls`; the bar the kit lanes show is view state. */
export class RhythmPanel {
  constructor(controls, { open }) {
    this.controls = controls; this.clock = new TranceGate(1); this.frame = null; this.gridBeats = null;
    const steps = $('gate-steps');
    for (let i = 0; i < GATE_STEPS; i++) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'gate-step'; button.dataset.step = i;
      button.setAttribute('aria-label', `Step ${i + 1}`); button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => controls.setGate({ toggleStep: i }));
      steps.append(button);
    }
    // Styles set shape, rate, depth, length and steps together; edits make it Custom.
    const style = $('gate-style');
    for (const name of [...Object.keys(GATE_STYLES), 'Custom']) {
      const option = document.createElement('option'); option.value = name; option.textContent = name; option.disabled = name === 'Custom';
      style.append(option);
    }
    style.addEventListener('change', () => controls.setGate({ style: style.value }));
    const segment = (container, name, values, label, apply) => {
      for (const value of values) {
        const option = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
        input.type = 'radio'; input.name = name; input.value = value; text.textContent = label(value);
        input.addEventListener('change', () => { if (input.checked) apply(value); });
        option.append(input, text); container.append(option);
      }
    };
    segment(document.querySelector('.gate-rate-options'), 'gate-rate', Object.keys(GATE_RATES), rate => rate, rate => controls.setGate({ rate }));
    // Chop: hard 16th stutter. Pump: duck-and-swell on each step, the sidechain "push".
    segment(document.querySelector('.gate-shapes'), 'gate-shape', GATE_SHAPES, shape => shape[0].toUpperCase() + shape.slice(1), shape => controls.setGate({ shape }));
    $('gate-enabled').addEventListener('change', event => controls.setGate({ enabled: event.target.checked }));
    // Hardstyle kit: kick, clap and hat lanes (8-bar phrases of sixteenths, shown a bar at a
    // time) with kit presets, crashes, drops (button, random, D key) and the air horn; tuned
    // to the song's root.
    for (const name of [...Object.keys(KIT_PATTERNS), 'Custom']) { const option = document.createElement('option'); option.value = option.textContent = name; option.disabled = name === 'Custom'; $('kick-pattern').append(option); }
    $('kick-pattern').addEventListener('change', event => controls.setKick({ pattern: event.target.value }));
    for (const [value, label] of Object.entries(KIT_SOUNDS)) { const option = document.createElement('option'); option.value = value; option.textContent = label; $('kick-sound').append(option); }
    $('kick-sound').addEventListener('change', event => controls.setKick({ sound: event.target.value }));
    for (const lane of ['kick', 'clap', 'hat']) for (let i = 0; i < 16; i++) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `gate-step kit-step ${lane}-step`; button.dataset.step = i;
      button.setAttribute('aria-label', `${lane[0].toUpperCase() + lane.slice(1)} on sixteenth ${i + 1}`); button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => controls.setKick({ lane, toggleStep: this.kitBar * 16 + i }));
      $(`${lane}-steps`).append(button);
    }
    this.kitBar = 0;
    for (let bar = 0; bar < KIT_BARS; bar++) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'kit-bar'; button.dataset.bar = bar; button.textContent = String(bar + 1);
      button.setAttribute('aria-label', `Show bar ${bar + 1}`); button.setAttribute('aria-pressed', String(bar === 0));
      button.addEventListener('click', () => { this.kitBar = bar; if (this.state) this.render(this.state); });
      $('kit-bars').append(button);
    }
    $('kit-copy').addEventListener('click', () => controls.setKick({ copyBar: this.kitBar }));
    // Pixel Cat: an 8-bit remix, a chiptune band in the song's chords over the crunched record.
    for (const name of Object.keys(CAT_PATTERNS)) { const option = document.createElement('option'); option.value = option.textContent = name; $('cat-pattern').append(option); }
    $('cat-pattern').addEventListener('change', event => controls.setCat({ pattern: event.target.value }));
    $('cat-enabled').addEventListener('change', event => controls.setCat({ enabled: event.target.checked }));
    $('cat-meow').addEventListener('change', event => controls.setCat({ meow: event.target.checked }));
    for (const key of ['volume', 'crunch']) $(`cat-${key}`).addEventListener('input', event => controls.setCat({ [key]: Number(event.target.value) }));
    segment(document.querySelector('.crash-options'), 'kick-crash', ['0', '4', '8'], every => every === '0' ? 'Off' : `Every ${every} bars`, every => controls.setKick({ crashEvery: Number(every) }));
    $('kick-drops').addEventListener('change', event => controls.setKick({ drops: event.target.checked }));
    $('kick-horn').addEventListener('change', event => controls.setKick({ horn: event.target.checked }));
    $('drop-now').addEventListener('click', () => { controls.dropNow(); const button = $('drop-now'); button.classList.remove('pulse'); void button.offsetWidth; button.classList.add('pulse'); });
    const auto = document.createElement('option'); auto.value = 'auto'; $('kick-tune').append(auto);
    KEY_NAMES.forEach((name, tonic) => { const option = document.createElement('option'); option.value = String(tonic); option.textContent = name; $('kick-tune').append(option); });
    $('kick-tune').addEventListener('change', event => controls.setKick({ tune: event.target.value }));
    $('kick-enabled').addEventListener('change', event => controls.setKick({ enabled: event.target.checked }));
    for (const key of ['volume', 'drive', 'tail']) $(`kick-${key}`).addEventListener('input', event => controls.setKick({ [key]: Number(event.target.value) }));
    $('gate-depth').addEventListener('input', event => controls.setGate({ depth: Number(event.target.value) }));
    $('gate-length').addEventListener('input', event => controls.setGate({ length: Number(event.target.value) }));
    $('tempo-half').addEventListener('click', () => controls.scaleTempo(.5));
    $('tempo-double').addEventListener('click', () => controls.scaleTempo(2));
    $('tempo-auto').addEventListener('click', () => controls.useDetectedTempo());
    // Tap coaching: count the taps, then confirm the tempo they set.
    const tapStatus = $('tempo-tap-status'), idleHint = tapStatus.textContent;
    $('tempo-tap').addEventListener('click', () => {
      const { taps, bpm } = controls.tapTempo();
      const button = $('tempo-tap'); button.classList.remove('pulse'); void button.offsetWidth; button.classList.add('pulse');
      tapStatus.textContent = bpm ? `Got it: ${bpm} BPM. Keep tapping to refine.` : taps === 1 ? 'Keep tapping with the beat… 2 more' : 'One more…';
      clearTimeout(this.tapTimer); this.tapTimer = setTimeout(() => { tapStatus.textContent = idleHint; }, 3500);
    });
    const manual = $('tempo-manual');
    manual.addEventListener('change', () => { const value = Number(manual.value); if (manual.value !== '' && Number.isFinite(value)) controls.setManualBpm(value); });
    manual.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); manual.dispatchEvent(new Event('change')); } });
    $('grid-earlier').addEventListener('click', () => controls.nudgeGrid(-10));
    $('grid-later').addEventListener('click', () => controls.nudgeGrid(10));
    $('grid-bar').addEventListener('click', () => controls.shiftBar());
    $('tempo-chip').addEventListener('click', open);  // toggles: a second click closes the popup
    controls.subscribe(state => this.render(state));
  }

  render(s) {
    const tempo = s.tempo, gate = s.gate, record = tempo.status !== 'empty';
    const level = tempo.status === 'ready' ? confidenceLabel(tempo.confidence).toLowerCase() : 'none';
    // Show the tempo as it plays: speed buttons, presets and the pitch fader change it (the
    // gate follows song time, so it stays on the beat either way). Always whole BPM.
    const rate = s.effectiveRate > 0 ? s.effectiveRate : 1, playing = tempo.bpm * rate;
    const bpm = tempo.bpm ? String(Math.round(playing)) : '—';
    $('tempo-bpm').value = $('tempo-bpm').textContent = tempo.status === 'analyzing' && !tempo.bpm ? '…' : bpm;
    const confidence = $('tempo-confidence');
    confidence.dataset.level = tempo.source === 'auto' ? level : 'manual';
    confidence.textContent = !record ? 'Waiting for a record' : tempo.status === 'analyzing' ? 'Analyzing…'
      : tempo.source !== 'auto' ? 'Set by you' : tempo.status === 'unavailable' ? 'No steady beat · tap or type one'
      : `${confidenceLabel(tempo.confidence)} confidence`;
    // Plain language: where the tempo came from, and whether the record plays faster/slower.
    const origin = tempo.source === 'tap' ? 'From your taps' : tempo.source === 'manual' ? 'Set by you'
      : tempo.status === 'unavailable' ? 'No clear beat found, so the gate uses 120 BPM. Tap along to set one.'
      : `Detected from the song${tempo.multiplier === 2 ? ' (doubled)' : tempo.multiplier === .5 ? ' (halved)' : ''}${tempo.varies ? '; its tempo changes' : ''}`;
    $('tempo-source').textContent = !record ? 'Load a record to detect its tempo.' : tempo.status === 'analyzing' ? 'Listening for the beat…'
      : Math.abs(rate - 1) > .004 && tempo.bpm ? `Song is ${Math.round(tempo.bpm)} BPM, playing ${rate > 1 ? 'faster' : 'slower'} · ${origin}` : origin;
    const manual = $('tempo-manual');
    if (document.activeElement !== manual) manual.value = tempo.bpm ? String(Math.round(tempo.bpm)) : '';
    const offset = Math.round(tempo.offsetMs);
    $('grid-offset').value = $('grid-offset').textContent = `${offset > 0 ? '+' : offset < 0 ? '−' : ''}${Math.abs(offset)} ms`;
    for (const id of ['tempo-half', 'tempo-double', 'tempo-tap', 'tempo-auto', 'tempo-manual', 'grid-earlier', 'grid-later', 'grid-bar']) $(id).disabled = !record;
    $('tempo-auto').disabled = !record || (tempo.source === 'auto' && tempo.multiplier === 1 && !tempo.offsetMs && !tempo.barShift);

    $('gate-enabled').checked = gate.enabled;
    $('gate-enabled').nextElementSibling.textContent = gate.enabled ? 'On' : 'Off';
    document.querySelector('.rhythm-panel').dataset.gate = gate.enabled ? 'on' : 'off';
    const cycle = gateCycle(gate.rate);
    for (const button of $('gate-steps').children) {
      const step = Number(button.dataset.step);
      button.setAttribute('aria-pressed', String(gate.steps[step]));
      // Triplets repeat 12 steps per bar; the last four cells sit out.
      button.disabled = step >= cycle; button.classList.toggle('unused', step >= cycle);
    }
    $('gate-style').value = styleName(gate);
    for (const input of document.querySelectorAll('input[name=gate-rate]')) input.checked = input.value === gate.rate;
    for (const input of document.querySelectorAll('input[name=gate-shape]')) input.checked = input.value === gate.shape;
    $('gate-length-label').textContent = gate.shape === 'pump' ? 'Swell' : 'Gate length';
    $('gate-depth').value = gate.depth; $('gate-depth-value').textContent = percent(gate.depth);
    $('gate-length').value = gate.length; $('gate-length-value').textContent = percent(gate.length);

    const kick = s.kick;
    $('kick-enabled').checked = kick.enabled; $('kick-enabled').nextElementSibling.textContent = kick.enabled ? 'On' : 'Off';
    $('kick-tune').value = kick.tune;
    $('kick-tune').options[0].textContent = tempo.key ? `Auto · ${KEY_NAMES[tempo.key.tonic]}` : 'Auto';
    $('kick-pattern').value = kitName(kick); $('kick-sound').value = kick.sound;
    // The lanes show one bar of the phrase; bars that differ from bar 1 are marked as fills.
    const first = this.kitBar * 16;
    for (const [lane, key] of [['kick', 'steps'], ['clap', 'clap'], ['hat', 'hat']]) for (const button of $(`${lane}-steps`).children) {
      const step = Number(button.dataset.step);
      button.setAttribute('aria-pressed', String(Boolean(kick[key][first + step])));
      button.setAttribute('aria-label', `${lane[0].toUpperCase() + lane.slice(1)} on sixteenth ${step + 1} of bar ${this.kitBar + 1}`);
    }
    for (const button of $('kit-bars').children) {
      const bar = Number(button.dataset.bar);
      button.setAttribute('aria-pressed', String(bar === this.kitBar));
      button.classList.toggle('fill', ['steps', 'clap', 'hat'].some(key => kick[key].slice(bar * 16, bar * 16 + 16).some((on, i) => Boolean(on) !== Boolean(kick[key][i]))));
    }
    for (const input of document.querySelectorAll('input[name=kick-crash]')) input.checked = Number(input.value) === kick.crashEvery;
    $('kick-drops').checked = kick.drops; $('kick-horn').checked = kick.horn; $('drop-now').disabled = !kick.enabled;
    for (const key of ['volume', 'drive', 'tail']) { $(`kick-${key}`).value = kick[key]; $(`kick-${key}-value`).textContent = percent(kick[key]); }

    const cat = s.cat;
    $('cat-enabled').checked = cat.enabled; $('cat-enabled').nextElementSibling.textContent = cat.enabled ? 'On' : 'Off';
    $('cat-pattern').value = cat.pattern; $('cat-meow').checked = cat.meow;
    for (const key of ['volume', 'crunch']) { $(`cat-${key}`).value = cat[key]; $(`cat-${key}-value`).textContent = percent(cat[key]); }

    // BPM chip on the track line: tempo, confidence and whether the gate is running.
    const chip = $('tempo-chip');
    chip.hidden = !record;
    chip.dataset.level = confidence.dataset.level; chip.dataset.gate = gate.enabled ? 'on' : 'off';
    chip.textContent = tempo.status === 'analyzing' && !tempo.bpm ? 'BPM…' : tempo.bpm ? `${bpm} BPM` : 'BPM';
    chip.setAttribute('aria-label', `${tempo.bpm ? `Tempo ${bpm} BPM, ${confidence.textContent.toLowerCase()}` : 'Tempo'}${gate.enabled ? ', Trance Gate on' : ''}. Open tempo and Trance Gate`);
    this.state = s;
    this.follow();
  }

  /** While the popup is open, light the gate step, the kit step and the playing bar. */
  follow() {
    const open = !$('preset-options').hidden, s = this.state, running = state => state.gate.enabled || state.kick.enabled;
    const lanes = () => [...$('kick-steps').children, ...$('clap-steps').children, ...$('hat-steps').children];
    const clear = () => { for (const button of [...$('gate-steps').children, ...lanes(), ...$('kit-bars').children]) button.classList.remove('now'); };
    if (!open || !s || !running(s) || s.tempo.status === 'empty') { cancelAnimationFrame(this.frame); this.frame = null; clear(); return; }
    if (this.frame) return;
    const tick = () => {
      this.frame = null;
      const state = this.controls.getState(), grid = this.controls.beatGrid();
      if (grid.beats !== this.gridBeats) { this.gridBeats = grid.beats; this.clock.setGrid(grid.beats, grid.downbeat); }
      this.clock.downbeat = grid.downbeat;
      const beat = this.clock.beatAt(state.position), cycle = gateCycle(state.gate.rate);
      const gateStep = beat === null || !state.gate.enabled ? -1 : ((Math.floor((beat - grid.downbeat) * GATE_RATES[state.gate.rate]) % cycle) + cycle) % cycle;
      const phrase = KIT_BARS * 16, kickStep = beat === null || !state.kick.enabled ? -1 : ((Math.floor((beat - grid.downbeat) * 4) % phrase) + phrase) % phrase;
      for (const button of $('gate-steps').children) button.classList.toggle('now', Number(button.dataset.step) === gateStep);
      for (const button of lanes()) button.classList.toggle('now', kickStep >= 0 && kickStep - this.kitBar * 16 === Number(button.dataset.step));
      for (const button of $('kit-bars').children) button.classList.toggle('now', kickStep >= 0 && Math.floor(kickStep / 16) === Number(button.dataset.bar));
      if (!$('preset-options').hidden && running(state)) this.frame = requestAnimationFrame(tick); else clear();
    };
    this.frame = requestAnimationFrame(tick);
  }
}
