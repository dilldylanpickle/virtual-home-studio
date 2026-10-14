import { TranceGate } from './trance-gate.js';
import { GATE_PATTERNS, GATE_RATES, GATE_SHAPES, GATE_STEPS, confidenceLabel, patternName } from './tempo-grid.js';

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
    const pattern = $('gate-pattern');
    for (const name of [...Object.keys(GATE_PATTERNS), 'Custom']) {
      const option = document.createElement('option'); option.value = name; option.textContent = name; option.disabled = name === 'Custom';
      pattern.append(option);
    }
    pattern.addEventListener('change', () => controls.setGate({ pattern: pattern.value }));
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
    $('tempo-tap').addEventListener('click', () => controls.tapTempo());
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
    // Tempos always display as whole BPM.
    const bpm = tempo.bpm ? String(Math.round(tempo.bpm)) : '—';
    $('tempo-bpm').value = $('tempo-bpm').textContent = tempo.status === 'analyzing' && !tempo.bpm ? '…' : bpm;
    const confidence = $('tempo-confidence');
    confidence.dataset.level = tempo.source === 'auto' ? level : 'manual';
    confidence.textContent = !record ? 'Waiting for a record' : tempo.status === 'analyzing' ? 'Analyzing…'
      : tempo.source !== 'auto' ? 'Set by you' : tempo.status === 'unavailable' ? 'No steady beat · tap or type one'
      : `${confidenceLabel(tempo.confidence)} confidence`;
    $('tempo-source').textContent = !record ? '' : tempo.source === 'tap' ? 'Tapped' : tempo.source === 'manual' ? 'Manual'
      : tempo.status === 'unavailable' ? 'Default grid'
      : `Detected${tempo.multiplier === 2 ? ' ×2' : tempo.multiplier === .5 ? ' ×½' : ''}${tempo.varies ? ' · tempo varies' : ''}`;
    const manual = $('tempo-manual');
    if (document.activeElement !== manual) manual.value = tempo.bpm ? String(Math.round(tempo.bpm)) : '';
    const offset = Math.round(tempo.offsetMs);
    $('grid-offset').value = $('grid-offset').textContent = `${offset > 0 ? '+' : offset < 0 ? '−' : ''}${Math.abs(offset)} ms`;
    for (const id of ['tempo-half', 'tempo-double', 'tempo-tap', 'tempo-auto', 'tempo-manual', 'grid-earlier', 'grid-later', 'grid-bar']) $(id).disabled = !record;
    $('tempo-auto').disabled = !record || (tempo.source === 'auto' && tempo.multiplier === 1 && !tempo.offsetMs && !tempo.barShift);

    $('gate-enabled').checked = gate.enabled;
    $('gate-enabled').nextElementSibling.textContent = gate.enabled ? 'On' : 'Off';
    document.querySelector('.rhythm-panel').dataset.gate = gate.enabled ? 'on' : 'off';
    for (const button of $('gate-steps').children) button.setAttribute('aria-pressed', String(gate.steps[Number(button.dataset.step)]));
    $('gate-pattern').value = patternName(gate.steps);
    for (const input of document.querySelectorAll('input[name=gate-rate]')) input.checked = input.value === gate.rate;
    for (const input of document.querySelectorAll('input[name=gate-shape]')) input.checked = input.value === gate.shape;
    $('gate-length-label').textContent = gate.shape === 'pump' ? 'Swell' : 'Gate length';
    $('gate-depth').value = gate.depth; $('gate-depth-value').textContent = percent(gate.depth);
    $('gate-length').value = gate.length; $('gate-length-value').textContent = percent(gate.length);

    // BPM chip on the track line: tempo, confidence and whether the gate is running.
    const chip = $('tempo-chip');
    chip.hidden = !record;
    chip.dataset.level = confidence.dataset.level; chip.dataset.gate = gate.enabled ? 'on' : 'off';
    chip.textContent = tempo.status === 'analyzing' && !tempo.bpm ? 'BPM…' : tempo.bpm ? `${Math.round(tempo.bpm)} BPM` : 'BPM';
    chip.setAttribute('aria-label', `${tempo.bpm ? `Tempo ${Math.round(tempo.bpm)} BPM, ${confidence.textContent.toLowerCase()}` : 'Tempo'}${gate.enabled ? ', Trance Gate on' : ''}. Open tempo and Trance Gate`);
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
        : ((Math.floor((beat - grid.downbeat) * GATE_RATES[state.gate.rate]) % GATE_STEPS) + GATE_STEPS) % GATE_STEPS;
      for (const button of $('gate-steps').children) button.classList.toggle('now', Number(button.dataset.step) === current);
      if (!$('preset-options').hidden && state.gate.enabled) this.frame = requestAnimationFrame(tick);
      else for (const button of $('gate-steps').children) button.classList.remove('now');
    };
    this.frame = requestAnimationFrame(tick);
  }
}
