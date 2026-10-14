import { TranceGate } from './trance-gate.js';
import { GATE_RATES, GATE_SHAPES, GATE_STEPS, GATE_STYLES, confidenceLabel, gateCycle, styleName } from './tempo-grid.js';

const $ = id => document.getElementById(id);
const percent = value => `${Math.round(value * 100)}%`;

/** Tempo and Trance Gate column of the presets popup, plus the BPM chip on the track
 * line. Presentation only: every action delegates to the model through `controls`. */
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

    // BPM chip on the track line: tempo, confidence and whether the gate is running.
    const chip = $('tempo-chip');
    chip.hidden = !record;
    chip.dataset.level = confidence.dataset.level; chip.dataset.gate = gate.enabled ? 'on' : 'off';
    chip.textContent = tempo.status === 'analyzing' && !tempo.bpm ? 'BPM…' : tempo.bpm ? `${bpm} BPM` : 'BPM';
    chip.setAttribute('aria-label', `${tempo.bpm ? `Tempo ${bpm} BPM, ${confidence.textContent.toLowerCase()}` : 'Tempo'}${gate.enabled ? ', Trance Gate on' : ''}. Open tempo and Trance Gate`);
    this.state = s;
    this.follow();
  }

  /** While the popup is open and the gate runs, light the step under the read head. */
  follow() {
    const open = !$('preset-options').hidden, s = this.state;
    if (!open || !s?.gate.enabled || s.tempo.status === 'empty') {
      cancelAnimationFrame(this.frame); this.frame = null;
      for (const button of $('gate-steps').children) button.classList.remove('now');
      return;
    }
    if (this.frame) return;
    const tick = () => {
      this.frame = null;
      const state = this.controls.getState(), grid = this.controls.beatGrid();
      if (grid.beats !== this.gridBeats) { this.gridBeats = grid.beats; this.clock.setGrid(grid.beats, grid.downbeat); }
      this.clock.downbeat = grid.downbeat;
      const beat = this.clock.beatAt(state.position), current = beat === null ? -1
        : ((Math.floor((beat - grid.downbeat) * GATE_RATES[state.gate.rate]) % gateCycle(state.gate.rate)) + gateCycle(state.gate.rate)) % gateCycle(state.gate.rate);
      for (const button of $('gate-steps').children) button.classList.toggle('now', Number(button.dataset.step) === current);
      if (!$('preset-options').hidden && state.gate.enabled) this.frame = requestAnimationFrame(tick);
      else for (const button of $('gate-steps').children) button.classList.remove('now');
    };
    this.frame = requestAnimationFrame(tick);
  }
}
