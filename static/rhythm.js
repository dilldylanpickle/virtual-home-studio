import { ANALYSIS_VERSION } from './tempo-analysis.js';
import { BPM_RANGE, CAT_PATTERNS, DEFAULT_CAT, DEFAULT_GATE, DEFAULT_KICK, DEFAULT_TEMPO, GATE_RATES, GATE_SHAPES, GATE_STEPS, KIT_BARS, KIT_PATTERNS, KIT_SOUNDS, MIN_CONFIDENCE, catLanes, effectiveGrid, gateCycle, gateMakeup, kickTune, kitLanes, patternSteps, styleSettings, tapBpm } from './tempo-grid.js';

const CACHE_PREFIX = 'vhs-tempo:', CACHE_INDEX = 'vhs-tempo-index', CACHE_LIMIT = 40;
const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

/** Tempo analysis, beat-grid corrections and beat-synced effect settings for the Turntable
 * model. The model owns `state.tempo`, `state.gate`, `state.kick` and `state.cat`; the
 * worklet receives the effective grid, the detected chords and each effect's settings and
 * applies them at the read head's song time. Analysis is offline
 * (one worker request per loaded file) and cached per file, including user corrections. */
export class Rhythm {
  constructor(deck) {
    this.deck = deck; this.analysis = null; this.grid = { beats: new Float64Array(0), downbeat: 0, bpm: 0 };
    this.key = null; this.duration = 0; this.request = 0; this.taps = []; this.memory = new Map(); this.analyses = 0;
    deck.state.gate = { ...DEFAULT_GATE, steps: [...DEFAULT_GATE.steps] };
    deck.state.tempo = { status: 'empty', bpm: 0, detectedBpm: 0, confidence: 0, varies: false, key: null, ...DEFAULT_TEMPO };
    deck.state.kick = { ...DEFAULT_KICK, ...kitLanes('Classic') };
    deck.state.cat = { ...DEFAULT_CAT };
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
    this.updateTempo({ status: analysis.beats?.length > 1 && analysis.confidence >= MIN_CONFIDENCE ? 'ready' : 'unavailable', detectedBpm: analysis.bpm || 0, confidence: analysis.confidence || 0, varies: Boolean(analysis.varies), key: analysis.key ?? null });
    this.sync();
  }
  clear() {
    ++this.request; this.key = null; this.analysis = null; this.duration = 0; this.taps = [];
    this.updateTempo({ status: 'empty', bpm: 0, detectedBpm: 0, confidence: 0, varies: false, key: null, ...DEFAULT_TEMPO });
    this.sync();
  }

  // --- Worklet synchronization ----------------------------------------------------------
  /** Recalculate the effective grid and send it with the gate settings. */
  sync() {
    const tempo = this.deck.state.tempo;
    this.grid = effectiveGrid(this.analysis, tempo, this.duration);
    if (Math.abs(tempo.bpm - this.grid.bpm) > 1e-9) this.deck.state.tempo = { ...tempo, bpm: this.grid.bpm };
    this.post({ type: 'beats', beats: this.grid.beats, downbeat: this.grid.downbeat });
    // Chords are song times from the analysis; grid corrections never move them.
    const chords = this.analysis?.chords ?? [];
    this.post({ type: 'chords', times: chords.map(chord => chord[0]), roots: chords.map(chord => chord[1]), minors: chords.map(chord => chord[2]) });
    this.syncGate(); this.syncKick(); this.syncCat();
  }
  syncGate() {
    const gate = this.deck.state.gate;
    this.post({ type: 'gate', settings: { enabled: gate.enabled, depth: gate.depth, stepsPerBeat: GATE_RATES[gate.rate], length: gate.length, shape: gate.shape, steps: gate.steps, cycle: gateCycle(gate.rate),
      // Softer edges: longer attack/release ramps keep chops musical on a full mix.
      attackMs: 1.5 + (gate.soft ?? 0) * 12, releaseMs: 9 + (gate.soft ?? 0) * 45,
      // Pumps let the kick's first 25 ms through; highs take part of the duck; small make-up gain.
      punchMs: gate.shape === 'pump' ? 25 : 0, highs: gate.highs ?? 1, makeup: gateMakeup(gate) } });
  }
  syncKick() {
    const kick = this.deck.state.kick;
    // The sidechain duck scales with the kick's volume so louder kicks cut through further.
    this.post({ type: 'kick', settings: { enabled: kick.enabled, volume: kick.volume, drive: kick.drive, tail: kick.tail, steps: kick.steps, clap: kick.clap, hat: kick.hat,
      crashEvery: kick.crashEvery, drops: kick.drops, horn: kick.horn, seed: this.request || 1, sound: kick.sound,
      tune: kickTune(kick.tune, this.deck.state.tempo.key), duck: .45 + kick.volume * .35 } });
  }
  syncCat() {
    const cat = this.deck.state.cat, key = this.deck.state.tempo.key;
    // Without detected chords the band plays the song's key chord (C major without a key).
    this.post({ type: 'cat', settings: { enabled: cat.enabled, volume: cat.volume, crunch: cat.crunch, meow: cat.meow, ...catLanes(cat.pattern),
      tonic: key?.tonic ?? 0, minor: key?.mode === 'minor' } });
  }
  post(message) { this.deck.engine?.port.postMessage(message); }

  // --- Commands -------------------------------------------------------------------------
  setGate(patch) {
    const gate = { ...this.deck.state.gate };
    if ('enabled' in patch) gate.enabled = Boolean(patch.enabled);
    // A style sets everything at once; later individual changes make the gate Custom.
    if (typeof patch.style === 'string' && styleSettings(patch.style)) Object.assign(gate, styleSettings(patch.style));
    if (patch.rate in GATE_RATES) gate.rate = patch.rate;
    if (GATE_SHAPES.includes(patch.shape)) gate.shape = patch.shape;
    if (Number.isFinite(patch.depth)) gate.depth = Math.max(0, Math.min(1, patch.depth));
    if (Number.isFinite(patch.length)) gate.length = Math.max(0, Math.min(1, patch.length));
    if (Number.isFinite(patch.highs)) gate.highs = Math.max(0, Math.min(1, patch.highs));
    if (typeof patch.pattern === 'string') gate.steps = patternSteps(patch.pattern);
    if (Array.isArray(patch.steps) && patch.steps.length === GATE_STEPS) gate.steps = patch.steps.map(Boolean);
    if (Number.isInteger(patch.toggleStep) && patch.toggleStep >= 0 && patch.toggleStep < GATE_STEPS) gate.steps = gate.steps.map((on, i) => i === patch.toggleStep ? !on : on);
    this.deck.state.gate = gate; this.syncGate(); this.deck.emit();
  }
  setKick(patch) {
    const kick = { ...this.deck.state.kick };
    if ('enabled' in patch) kick.enabled = Boolean(patch.enabled);
    if (patch.pattern in KIT_PATTERNS) Object.assign(kick, kitLanes(patch.pattern));
    // Lanes: kick (`steps`), clap and hat, an 8-bar phrase of sixteenths each.
    const lane = { kick: 'steps', clap: 'clap', hat: 'hat' }[patch.lane ?? 'kick'];
    if (lane && Number.isInteger(patch.toggleStep) && patch.toggleStep >= 0 && patch.toggleStep < kick[lane].length) kick[lane] = kick[lane].map((on, i) => i === patch.toggleStep ? !on : on);
    // Copy one bar of every lane across the whole phrase.
    if (Number.isInteger(patch.copyBar) && patch.copyBar >= 0 && patch.copyBar < KIT_BARS) for (const key of ['steps', 'clap', 'hat']) {
      const bar = kick[key].slice(patch.copyBar * 16, patch.copyBar * 16 + 16); kick[key] = kick[key].map((_, i) => bar[i % 16]);
    }
    if ([0, 4, 8].includes(patch.crashEvery)) kick.crashEvery = patch.crashEvery;
    if ('drops' in patch) kick.drops = Boolean(patch.drops);
    if ('horn' in patch) kick.horn = Boolean(patch.horn);
    if (patch.sound in KIT_SOUNDS) kick.sound = patch.sound;
    for (const key of ['volume', 'drive', 'tail']) if (Number.isFinite(patch[key])) kick[key] = Math.max(0, Math.min(1, patch[key]));
    if (patch.tune === 'auto' || /^(?:[0-9]|1[01])$/.test(String(patch.tune ?? ''))) kick.tune = String(patch.tune);
    this.deck.state.kick = kick; this.syncKick(); this.deck.emit();
  }
  setCat(patch) {
    const cat = { ...this.deck.state.cat };
    if ('enabled' in patch) cat.enabled = Boolean(patch.enabled);
    if (patch.pattern in CAT_PATTERNS) cat.pattern = patch.pattern;
    if ('meow' in patch) cat.meow = Boolean(patch.meow);
    for (const key of ['volume', 'crunch']) if (Number.isFinite(patch[key])) cat[key] = Math.max(0, Math.min(1, patch[key]));
    this.deck.state.cat = cat; this.syncCat(); this.deck.emit();
  }
  /** Drop it: build next bar, pause, then crash + kick (+ air horn) on the bar after. */
  dropNow() { if (this.deck.state.kick.enabled) this.post({ type: 'drop' }); }
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
