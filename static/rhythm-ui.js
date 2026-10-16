import { TranceGate } from './trance-gate.js';
import { GATE_RATES, GATE_STEPS, GATE_STYLES, STEP_OFF, STEP_ON, STEP_TIE, confidenceLabel, envelopeMs, envelopeSlider, gateCycle, styleName } from './tempo-grid.js';

const $ = id => document.getElementById(id);
const percent = value => `${Math.round(value * 100)}%`;
const milliseconds = value => `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ms`;

/** Tempo and Trance Gate column of the presets popup, plus the BPM chip on the track
 * line. Presentation only: every action delegates to the model through `controls`. */
export class RhythmPanel {
  constructor(controls, { open }) {
    this.controls = controls; this.clock = new TranceGate(1); this.scope = new TranceGate(1); this.frame = null; this.gridBeats = null;
    const steps = $('gate-steps');
    for (let i = 0; i < GATE_STEPS; i++) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'gate-step'; button.dataset.step = i;
      button.setAttribute('aria-label', `Step ${i + 1}`); button.setAttribute('aria-pressed', 'false');
      // Click toggles a step; Shift-click holds the note before it through this step.
      button.addEventListener('click', event => controls.setGate(event.shiftKey && i > 0 ? { tie: [i - 1, i] } : { toggleStep: i }));
      steps.append(button);
    }
    // Drag across steps: one note from the first step, tied through the last (like the step
    // editor of a trance gate plugin). The release outside the row still counts.
    const stepAt = event => document.elementFromPoint(event.clientX, event.clientY)?.closest?.('#gate-steps .gate-step:not(:disabled)');
    const preview = (from, to) => { for (const button of steps.children) { const i = Number(button.dataset.step); button.classList.toggle('tie-preview', to > from && i >= from && i <= to); } };
    steps.addEventListener('pointerdown', event => {
      const button = event.target.closest('.gate-step'); if (!button || button.disabled || event.button > 0) return;
      this.drag = { from: Number(button.dataset.step), to: Number(button.dataset.step) };
    });
    addEventListener('pointermove', event => {
      if (!this.drag) return;
      const button = stepAt(event); if (!button) return;
      this.drag.to = Math.max(this.drag.from, Number(button.dataset.step)); preview(this.drag.from, this.drag.to);
    });
    const finish = commit => {
      if (!this.drag) return;
      const { from, to } = this.drag; this.drag = null; preview(0, 0);
      if (commit && to > from) controls.setGate({ tie: [from, to] });
    };
    addEventListener('pointerup', () => finish(true));
    for (const type of ['pointercancel', 'blur']) addEventListener(type, () => finish(false));
    // Styles set rate, pattern, envelope and mix together; edits make it Custom.
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
    $('gate-enabled').addEventListener('change', event => controls.setGate({ enabled: event.target.checked }));
    // Attack, Decay and Release move on a log scale (fine control of short times); Sustain and Mix are linear.
    for (const key of ['attack', 'decay', 'release']) $(`gate-${key}`).addEventListener('input', event => controls.setGate({ [key]: envelopeMs(key, Number(event.target.value)) }));
    for (const key of ['sustain', 'mix']) $(`gate-${key}`).addEventListener('input', event => controls.setGate({ [key]: Number(event.target.value) }));
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
      const step = Number(button.dataset.step), state = gate.steps[step], next = gate.steps[(step + 1) % cycle];
      button.setAttribute('aria-pressed', String(state !== STEP_OFF));
      button.classList.toggle('tie', state === STEP_TIE); button.classList.toggle('held', state !== STEP_OFF && next === STEP_TIE && step + 1 < cycle);
      button.setAttribute('aria-label', `Step ${step + 1}: ${state === STEP_TIE ? 'held from the step before' : state === STEP_ON ? 'on' : 'off'}`);
      // Triplets repeat 12 steps per bar; the last four cells sit out.
      button.disabled = step >= cycle; button.classList.toggle('unused', step >= cycle);
    }
    $('gate-style').value = styleName(gate);
    for (const input of document.querySelectorAll('input[name=gate-rate]')) input.checked = input.value === gate.rate;
    for (const key of ['attack', 'decay', 'release']) { $(`gate-${key}`).value = envelopeSlider(key, gate[key]); $(`gate-${key}-value`).textContent = milliseconds(gate[key]); }
    for (const key of ['sustain', 'mix']) { $(`gate-${key}`).value = gate[key]; $(`gate-${key}-value`).textContent = percent(gate[key]); }

    // BPM chip on the track line: tempo, confidence and whether the gate is running.
    const chip = $('tempo-chip');
    chip.hidden = !record;
    chip.dataset.level = confidence.dataset.level; chip.dataset.gate = gate.enabled ? 'on' : 'off';
    chip.textContent = tempo.status === 'analyzing' && !tempo.bpm ? 'BPM…' : tempo.bpm ? `${bpm} BPM` : 'BPM';
    chip.setAttribute('aria-label', `${tempo.bpm ? `Tempo ${bpm} BPM, ${confidence.textContent.toLowerCase()}` : 'Tempo'}${gate.enabled ? ', Trance Gate on' : ''}. Open tempo and Trance Gate`);
    this.state = s;
    this.follow();
  }

  /** While the popup is open, draw the gate's envelope; while the gate runs, light the step
   * under the read head and move a playhead across the envelope. */
  follow() {
    const open = !$('preset-options').hidden, s = this.state;
    const clear = () => { for (const button of $('gate-steps').children) button.classList.remove('now'); };
    if (!open || !s) { cancelAnimationFrame(this.frame); this.frame = null; clear(); return; }
    if (!s.gate.enabled || s.tempo.status === 'empty') { cancelAnimationFrame(this.frame); this.frame = null; clear(); this.drawScope(s, null); return; }
    if (this.frame) return;
    const tick = () => {
      this.frame = null;
      const state = this.controls.getState(), grid = this.controls.beatGrid(), cycle = gateCycle(state.gate.rate);
      if (grid.beats !== this.gridBeats) { this.gridBeats = grid.beats; this.clock.setGrid(grid.beats, grid.downbeat); }
      this.clock.downbeat = grid.downbeat;
      const beat = this.clock.beatAt(state.position), position = beat === null ? null : (beat - grid.downbeat) * GATE_RATES[state.gate.rate];
      const current = position === null ? -1 : ((Math.floor(position) % cycle) + cycle) % cycle;
      for (const button of $('gate-steps').children) button.classList.toggle('now', Number(button.dataset.step) === current);
      this.drawScope(state, position === null ? null : (((position % cycle) + cycle) % cycle) / cycle);
      if (!$('preset-options').hidden && state.gate.enabled) this.frame = requestAnimationFrame(tick);
      else { clear(); this.drawScope(state, null); }
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** The gate's gain over one pattern cycle, computed by the same envelope the audio engine
   * runs (on a steady grid at the song's tempo), with a playhead at `playhead` (0–1). */
  drawScope(state, playhead) {
    const canvas = $('gate-scope'), width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); this.scopeKey = null; }
    const gate = state.gate, bpm = state.tempo.bpm || 120, cycle = gateCycle(gate.rate), stepsPerBeat = GATE_RATES[gate.rate];
    const key = JSON.stringify([gate.rate, gate.steps, gate.attack, gate.decay, gate.sustain, gate.release, gate.mix, Math.round(bpm), width]);
    if (key !== this.scopeKey) {
      this.scopeKey = key;
      const span = cycle / stepsPerBeat, beats = Float64Array.from({ length: Math.ceil(span * 3) + 4 }, (_, i) => i * 60 / bpm);
      this.scope.setGrid(beats, 0);
      this.scope.configure({ enabled: true, stepsPerBeat, steps: gate.steps, cycle, attackMs: gate.attack, decayMs: gate.decay, sustain: gate.sustain, releaseMs: gate.release, mix: gate.mix });
      // The second cycle, so releases ringing over from the end of the pattern show at its start.
      const samples = Math.max(64, Math.round(width));
      this.scopePoints = Float32Array.from({ length: samples + 1 }, (_, i) => this.scope.target((span + span * i / samples) * 60 / bpm));
    }
    const context = canvas.getContext('2d'), style = getComputedStyle(canvas), accent = style.getPropertyValue('--hud-accent').trim() || '#4c6a85';
    const muted = style.getPropertyValue('--hud-border').trim() || '#c8d0d6', points = this.scopePoints;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    // Beat lines (strong) and step lines (faint).
    for (let step = 1; step < cycle; step++) {
      const x = Math.round(width * step / cycle) + .5, beatLine = (step / stepsPerBeat) % 1 < 1e-6;
      context.strokeStyle = muted; context.globalAlpha = beatLine ? .9 : .35; context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    }
    context.globalAlpha = gate.enabled ? 1 : .45;
    const y = value => 2 + (1 - value) * (height - 4);
    context.beginPath(); context.moveTo(0, height);
    points.forEach((value, i) => context.lineTo(width * i / (points.length - 1), y(value)));
    context.lineTo(width, height); context.closePath();
    context.fillStyle = accent; context.globalAlpha *= .22; context.fill();
    context.globalAlpha = gate.enabled ? 1 : .45; context.beginPath();
    points.forEach((value, i) => (i ? context.lineTo : context.moveTo).call(context, width * i / (points.length - 1), y(value)));
    context.strokeStyle = accent; context.lineWidth = 1.5; context.stroke();
    if (playhead !== null) {
      const x = playhead * width; context.globalAlpha = 1; context.strokeStyle = accent; context.lineWidth = 2;
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    }
    context.globalAlpha = 1;
  }
}
