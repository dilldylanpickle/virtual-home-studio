import { ANALYSIS_VERSION } from './tempo-analysis.js';
import { BPM_RANGE, DEFAULT_GATE, DEFAULT_TEMPO, GATE_RATES, GATE_SHAPES, GATE_STEPS, MIN_CONFIDENCE, effectiveGrid, patternSteps, tapBpm } from './tempo-grid.js';

const CACHE_PREFIX = 'vhs-tempo:', CACHE_INDEX = 'vhs-tempo-index', CACHE_LIMIT = 40;
const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

/** Tempo analysis, beat-grid corrections and Trance Gate settings for the Turntable model.
 * The model owns `state.tempo` and `state.gate`; the worklet receives the effective grid
 * and gate settings and applies the gate at the read head's song time. Analysis is offline
 * (one worker request per loaded file) and cached per file, including user corrections. */
export class Rhythm {
  constructor(deck) {
    this.deck = deck; this.analysis = null; this.grid = { beats: new Float64Array(0), downbeat: 0, bpm: 0 };
    this.key = null; this.duration = 0; this.request = 0; this.taps = []; this.memory = new Map(); this.analyses = 0;
    deck.state.gate = { ...DEFAULT_GATE, steps: [...DEFAULT_GATE.steps] };
    deck.state.tempo = { status: 'empty', bpm: 0, detectedBpm: 0, confidence: 0, varies: false, ...DEFAULT_TEMPO };
  }

  // --- Analysis lifecycle -------------------------------------------------------------
  /** Start (or reuse) analysis for a freshly decoded record. Stale results are discarded. */
  analyze(file, decoded) {
    const key = `${ANALYSIS_VERSION}|${file.name}|${file.size}|${file.lastModified}|${decoded.duration.toFixed(2)}`;
    const token = ++this.request; this.key = key; this.duration = decoded.duration; this.analysis = null; this.taps = [];
    const saved = storage.get(CACHE_PREFIX + key);
    this.updateTempo({ status: 'analyzing', bpm: 0, detectedBpm: 0, confidence: 0, varies: false, ...DEFAULT_TEMPO, ...(saved?.settings ?? {}) });
    const cached = this.memory.get(key) ?? saved?.analysis;
    if (cached) { this.apply(cached); return Promise.resolve(cached); }
    // Downmix to mono once; the copy is transferred to the worker.
    const mono = new Float32Array(decoded.length), channels = Math.min(2, decoded.numberOfChannels);
    for (let c = 0; c < channels; c++) { const data = decoded.getChannelData(c); for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels; }
    this.analyses++;
    return this.run(mono, decoded.sampleRate).then(result => {
      if (token !== this.request) return null;
      const compact = { ...result, beats: result.beats.map(time => Math.round(time * 1e5) / 1e5), tempo: undefined };
      this.memory.set(key, compact); this.store(key, { analysis: compact });
      this.apply(compact);
      return compact;
    }, error => {
      if (token !== this.request) return null;
      console.warn('Tempo analysis failed; manual BPM and tap tempo remain available.', error);
      this.updateTempo({ status: 'unavailable' }); this.sync();
      return null;
    });
  }
  run(mono, sampleRate) {
    try {
      this.worker ??= new Worker(new URL('./tempo-worker.js', import.meta.url), { type: 'module' });
    } catch { this.worker = null; }
    if (!this.worker) return import('./tempo-analysis.js').then(({ analyzeTempo }) => new Promise(resolve => setTimeout(() => resolve(analyzeTempo(mono, sampleRate)))));
    const id = this.request;
    return new Promise((resolve, reject) => {
      const listener = ({ data }) => {
        if (data.id !== id) return;
        this.worker.removeEventListener('message', listener);
        if (data.error) reject(new Error(data.error)); else resolve(data.result);
      };
      this.worker.addEventListener('message', listener);
      this.worker.postMessage({ id, mono, sampleRate }, [mono.buffer]);
    });
  }
  apply(analysis) {
    this.analysis = analysis;
    // Without a usable beat the gate falls back to a steady grid (tempo-grid FALLBACK_BPM).
    this.updateTempo({ status: analysis.beats?.length > 1 && analysis.confidence >= MIN_CONFIDENCE ? 'ready' : 'unavailable', detectedBpm: analysis.bpm || 0, confidence: analysis.confidence || 0, varies: Boolean(analysis.varies) });
    this.sync();
  }
  clear() {
    ++this.request; this.key = null; this.analysis = null; this.duration = 0; this.taps = [];
    this.updateTempo({ status: 'empty', bpm: 0, detectedBpm: 0, confidence: 0, varies: false, ...DEFAULT_TEMPO });
    this.sync();
  }

  // --- Worklet synchronization ----------------------------------------------------------
  /** Recalculate the effective grid and send it with the gate settings. */
  sync() {
    const tempo = this.deck.state.tempo;
    this.grid = effectiveGrid(this.analysis, tempo, this.duration);
    if (Math.abs(tempo.bpm - this.grid.bpm) > 1e-9) this.deck.state.tempo = { ...tempo, bpm: this.grid.bpm };
    this.post({ type: 'beats', beats: this.grid.beats, downbeat: this.grid.downbeat });
    this.syncGate();
  }
  syncGate() {
    const gate = this.deck.state.gate;
    this.post({ type: 'gate', settings: { enabled: gate.enabled, depth: gate.depth, stepsPerBeat: GATE_RATES[gate.rate], length: gate.length, shape: gate.shape, steps: gate.steps } });
  }
  post(message) { this.deck.engine?.port.postMessage(message); }

  // --- Commands -------------------------------------------------------------------------
  setGate(patch) {
    const gate = { ...this.deck.state.gate };
    if ('enabled' in patch) gate.enabled = Boolean(patch.enabled);
    if (patch.rate in GATE_RATES) gate.rate = patch.rate;
    if (GATE_SHAPES.includes(patch.shape)) gate.shape = patch.shape;
    if (Number.isFinite(patch.depth)) gate.depth = Math.max(0, Math.min(1, patch.depth));
    if (Number.isFinite(patch.length)) gate.length = Math.max(.1, Math.min(1, patch.length));
    if (typeof patch.pattern === 'string') gate.steps = patternSteps(patch.pattern);
    if (Array.isArray(patch.steps) && patch.steps.length === GATE_STEPS) gate.steps = patch.steps.map(Boolean);
    if (Number.isInteger(patch.toggleStep) && patch.toggleStep >= 0 && patch.toggleStep < GATE_STEPS) gate.steps = gate.steps.map((on, i) => i === patch.toggleStep ? !on : on);
    this.deck.state.gate = gate; this.syncGate(); this.deck.emit();
  }
  /** Tempo corrections. Each recalculates the grid immediately and is remembered for the file. */
  setManualBpm(bpm, anchor) {
    if (!Number.isFinite(bpm)) return;
    // Tempos are always whole BPM.
    const value = Math.round(Math.max(BPM_RANGE[0], Math.min(BPM_RANGE[1], bpm)));
    this.correct({ source: 'manual', manualBpm: value, ...(Number.isFinite(anchor) ? { anchor } : {}) });
  }
  useDetected() { this.taps = []; this.correct({ ...DEFAULT_TEMPO }); }
  scaleTempo(factor) {
    if (factor !== 2 && factor !== .5) return;
    const tempo = this.deck.state.tempo;
    if (tempo.source === 'auto') {
      const multiplier = Math.max(.5, Math.min(2, tempo.multiplier * factor));
      this.correct({ multiplier });
    } else if (tempo.manualBpm) this.setManualBpm(tempo.manualBpm * factor);
  }
  nudge(ms) { if (Number.isFinite(ms)) this.correct({ offsetMs: Math.max(-500, Math.min(500, Math.round(this.deck.state.tempo.offsetMs + ms))) }); }
  shiftBar() { this.correct({ barShift: (this.deck.state.tempo.barShift + 1) % 4 }); }
  /** Tap along: three taps set tempo; while the record plays, the last tap also sets the
   * beat phase (song time), so the gate lands where you tapped. */
  tap(now = performance.now() / 1000) {
    const playing = this.deck.audible, song = this.deck.state.position;
    const last = this.taps[this.taps.length - 1];
    if (!last || now - last.wall > 2 || last.playing !== playing) this.taps = [];
    this.taps.push({ wall: now, song, playing }); this.taps = this.taps.slice(-8);
    const bpm = tapBpm(this.taps.map(tap => playing ? tap.song : tap.wall));
    if (bpm) this.correct({ source: 'tap', manualBpm: bpm, ...(playing ? { anchor: song } : {}) });
    return { taps: this.taps.length, bpm };
  }
  correct(patch) {
    this.updateTempo(patch); this.sync(); this.deck.emit();
    if (this.key) {
      const { source, manualBpm, anchor, multiplier, offsetMs, barShift } = this.deck.state.tempo;
      this.store(this.key, { settings: { source, manualBpm, anchor, multiplier, offsetMs, barShift } });
    }
  }
  updateTempo(patch) { this.deck.state.tempo = { ...this.deck.state.tempo, ...patch }; }

  // --- Cache ----------------------------------------------------------------------------
  store(key, entry) {
    const previous = storage.get(CACHE_PREFIX + key) ?? {};
    if (!storage.set(CACHE_PREFIX + key, { ...previous, ...entry })) return;
    const index = (storage.get(CACHE_INDEX) ?? []).filter(item => item !== key);
    index.push(key);
    while (index.length > CACHE_LIMIT) storage.remove(CACHE_PREFIX + index.shift());
    storage.set(CACHE_INDEX, index);
  }
}
