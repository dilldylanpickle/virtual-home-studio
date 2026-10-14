/** Offline tempo and beat analysis for rhythmic effects. Pure functions: no DOM, audio
 * graph or model state, so the same code runs in the analysis worker and in Node tests.
 *
 * Pipeline: mono PCM → log-magnitude spectral flux (onset strength) → autocorrelation
 * tempo estimate with a broad octave prior → windowed local tempo (changing tempos) →
 * dynamic-programming beat tracking (Ellis 2007) → sub-frame refinement → a constant
 * grid fit when the tempo is steady → downbeat phase from low-band (kick) onsets. */
// Bump when results change, so cached analyses from older versions are recomputed.
export const ANALYSIS_VERSION = 4;

const TARGET_RATE = 22050, FRAME = 1024, HOP = 256;
// A spectral-flux peak at frame f marks an attack ~0.72 frames after the frame's start
// (34 ms at 22.05 kHz; measured on synthetic kick/hat tracks, see tests/tempo-engine.mjs).
const ONSET_LAG_FRAMES = .7235;

function fftMagnitudes(frame, real, imag, cos, sin, bits) {
  const n = real.length;
  for (let i = 0; i < n; i++) {
    let j = 0; for (let b = 0; b < bits; b++) j |= ((i >> b) & 1) << (bits - 1 - b);
    real[j] = frame[i]; imag[j] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step], s = sin[k * step], a = start + k, b = a + half;
        const tr = real[b] * c + imag[b] * s, ti = imag[b] * c - real[b] * s;
        real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
      }
    }
  }
}

/** Onset strength per hop (full band and low band) at `fps` frames per second. */
export function onsetEnvelope(mono, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE)), rate = sampleRate / factor;
  const length = Math.floor(mono.length / factor), signal = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0; for (let k = 0; k < factor; k++) sum += mono[i * factor + k]; signal[i] = sum / factor;
  }
  const frames = Math.max(0, Math.floor((length - FRAME) / HOP) + 1), bins = FRAME / 2;
  const window = Float32Array.from({ length: FRAME }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / FRAME));
  const cos = Float64Array.from({ length: bins }, (_, k) => Math.cos(2 * Math.PI * k / FRAME));
  const sin = Float64Array.from({ length: bins }, (_, k) => Math.sin(2 * Math.PI * k / FRAME));
  const real = new Float64Array(FRAME), imag = new Float64Array(FRAME), buffer = new Float32Array(FRAME);
  let previous = new Float32Array(bins), current = new Float32Array(bins); const lowPrevious = new Float32Array(bins);
  const full = new Float32Array(frames), low = new Float32Array(frames), lowBins = Math.max(2, Math.round(160 / (rate / FRAME)));
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i++) buffer[i] = signal[offset + i] * window[i];
    fftMagnitudes(buffer, real, imag, cos, sin, Math.log2(FRAME));
    let flux = 0, lowFlux = 0;
    for (let k = 1; k < bins; k++) {
      // Log compression keeps quiet hi-hats and loud kicks on comparable scales for timing.
      const magnitude = Math.hypot(real[k], imag[k]), value = Math.log1p(100 * magnitude);
      current[k] = value;
      const rise = value - previous[k];
      if (rise > 0) flux += rise;
      // The low band stays linear so loudness counts: a kick outweighs offbeat bass.
      if (k <= lowBins) { lowFlux += Math.max(0, magnitude - lowPrevious[k]); lowPrevious[k] = magnitude; }
    }
    full[f] = f ? flux : 0; low[f] = f ? lowFlux : 0;
    [previous, current] = [current, previous];
  }
  return { full: normalize(full), low: normalize(low), fps: rate / HOP, lag: ONSET_LAG_FRAMES * FRAME / rate };
}

// Remove the slowly varying loudness, keep positive onsets, scale to unit spread.
function normalize(values) {
  const n = values.length, out = new Float32Array(n), radius = 24;
  let sum = 0; const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius), b = Math.min(n, i + radius + 1);
    out[i] = Math.max(0, values[i] - (prefix[b] - prefix[a]) / (b - a));
    sum += out[i] * out[i];
  }
  const scale = Math.sqrt(sum / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= scale;
  return out;
}

function autocorrelation(onset, start, end, minLag, maxLag) {
  const acf = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0; for (let i = start + lag; i < end; i++) sum += onset[i] * onset[i - lag];
    acf[lag] = sum / Math.max(1, end - start - lag);
  }
  return acf;
}

/** Best period in frames within [minLag, maxLag], weighted by a log-tempo prior around
 * `centerBpm`; the 2× lag reinforces the true beat over off-grid lags. */
function bestPeriod(onset, start, end, fps, minBpm, maxBpm, centerBpm, octaveWidth) {
  const minLag = Math.max(2, Math.floor(fps * 60 / maxBpm)), maxLag = Math.ceil(fps * 60 / minBpm);
  const acf = autocorrelation(onset, start, end, minLag, Math.min(maxLag * 2, end - start - 2));
  const at = lag => { const i = Math.floor(lag), t = lag - i; return (acf[i] ?? 0) * (1 - t) + (acf[i + 1] ?? 0) * t; };
  let best = minLag, bestScore = -Infinity; const scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * fps / lag, prior = Math.exp(-.5 * (Math.log2(bpm / centerBpm) / octaveWidth) ** 2);
    const score = (at(lag) + .5 * at(lag * 2)) * prior;
    scores.push(score);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // Parabolic interpolation for a sub-frame period.
  const i = best - minLag, a = scores[i - 1] ?? scores[i], b = scores[i], c = scores[i + 1] ?? scores[i];
  const shift = a - 2 * b + c ? Math.max(-.5, Math.min(.5, .5 * (a - c) / (a - 2 * b + c))) : 0;
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return { period: best + shift, clarity: bestScore > 0 ? (bestScore - mean) / bestScore : 0 };
}

// Krumhansl–Kessler key profiles (major, minor), tonic first.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const pearson = (a, b) => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};

/** Song key from a long-window chroma profile (100–2000 Hz, 4096-point frames every ~0.2 s)
 * correlated with the 24 rotated key profiles. Returns tonic pitch class (0 = C), mode and a
 * confidence (margin of the best key over the runner-up). */
export function analyzeKey(mono, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE)), rate = sampleRate / factor, size = 4096, hop = 4096;
  const length = Math.floor(mono.length / factor), signal = new Float32Array(length);
  for (let i = 0; i < length; i++) { let sum = 0; for (let k = 0; k < factor; k++) sum += mono[i * factor + k]; signal[i] = sum / factor; }
  const bins = size / 2, window = Float32Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / size));
  const cos = Float64Array.from({ length: bins }, (_, k) => Math.cos(2 * Math.PI * k / size)), sin = Float64Array.from({ length: bins }, (_, k) => Math.sin(2 * Math.PI * k / size));
  const real = new Float64Array(size), imag = new Float64Array(size), buffer = new Float32Array(size), chroma = new Float64Array(12);
  const lowBin = Math.ceil(100 * size / rate), highBin = Math.min(bins - 1, Math.floor(2000 * size / rate));
  const pitchClass = new Int8Array(bins).fill(-1);
  for (let k = lowBin; k <= highBin; k++) pitchClass[k] = ((Math.round(12 * Math.log2(k * rate / size / 440)) + 9) % 12 + 12) % 12;
  for (let offset = 0; offset + size <= length; offset += hop) {
    for (let i = 0; i < size; i++) buffer[i] = signal[offset + i] * window[i];
    fftMagnitudes(buffer, real, imag, cos, sin, Math.log2(size));
    for (let k = lowBin; k <= highBin; k++) chroma[pitchClass[k]] += Math.sqrt(Math.hypot(real[k], imag[k]));
  }
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12]);
    scores.push({ tonic, mode: 'major', score: pearson(rotated, MAJOR_PROFILE) }, { tonic, mode: 'minor', score: pearson(rotated, MINOR_PROFILE) });
  }
  scores.sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  return { tonic: best.tonic, mode: best.mode, confidence: Math.max(0, Math.min(1, (best.score - next.score) * 8 + best.score * .4)) };
}

// Chords: 24 major/minor triads. A chord in the key gets a small prior: I ii iii IV V vi in
// major; i III iv v V VI VII in minor.
const DIATONIC = { major: [[0, 0], [2, 1], [4, 1], [5, 0], [7, 0], [9, 1]], minor: [[0, 1], [3, 0], [5, 1], [7, 1], [7, 0], [8, 0], [10, 0]] };
const TRIADS = Array.from({ length: 24 }, (_, i) => {
  const root = i >> 1, minor = i & 1, template = new Array(12).fill(0);
  template[root] = template[(root + (minor ? 3 : 4)) % 12] = template[(root + 7) % 12] = 1;
  return { root, minor, template };
});

/** Chords along the beat grid, for effects that play along. Per-beat treble (180–2000 Hz)
 * chroma is correlated with each triad, plus a bonus when the bass (40–180 Hz) sits on its
 * root and a small prior for chords in the key; Viterbi decoding with a cost per change
 * keeps it from flickering. Returns changes as [time (s), root pitch class, minor (0/1)].
 * Full mixes make this approximate; mistakes are mostly the key's related chords, which
 * still fit. Without beats it uses half-second steps. */
export function analyzeChords(mono, sampleRate, beats, key) {
  const factor = Math.max(1, Math.round(sampleRate / 11025)), rate = sampleRate / factor, size = 4096, hop = 1024, bins = size / 2;
  const length = Math.floor(mono.length / factor), signal = new Float32Array(length), duration = mono.length / sampleRate;
  for (let i = 0; i < length; i++) { let sum = 0; for (let k = 0; k < factor; k++) sum += mono[i * factor + k]; signal[i] = sum / factor; }
  const window = Float32Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / size));
  const cos = Float64Array.from({ length: bins }, (_, k) => Math.cos(2 * Math.PI * k / size)), sin = Float64Array.from({ length: bins }, (_, k) => Math.sin(2 * Math.PI * k / size));
  const real = new Float64Array(size), imag = new Float64Array(size), buffer = new Float32Array(size);
  // Each bin feeds its nearest pitch class, weighted by how close it sits to the semitone.
  const pitchClass = new Int8Array(bins).fill(-1), weight = new Float32Array(bins), isBass = new Uint8Array(bins);
  for (let k = 1; k < bins; k++) {
    const frequency = k * rate / size; if (frequency < 40 || frequency > 2000) continue;
    const midi = 69 + 12 * Math.log2(frequency / 440), nearest = Math.round(midi);
    pitchClass[k] = ((nearest % 12) + 12) % 12; weight[k] = Math.cos(Math.PI * (midi - nearest)) ** 2; isBass[k] = frequency < 180 ? 1 : 0;
  }
  const frames = [];
  for (let offset = 0; offset + size <= length; offset += hop) {
    for (let i = 0; i < size; i++) buffer[i] = signal[offset + i] * window[i];
    fftMagnitudes(buffer, real, imag, cos, sin, Math.log2(size));
    const chroma = new Float32Array(24);  // 0–11 treble, 12–23 bass
    for (let k = 1; k < bins; k++) if (pitchClass[k] >= 0) chroma[pitchClass[k] + 12 * isBass[k]] += Math.sqrt(Math.hypot(real[k], imag[k])) * weight[k];
    frames.push({ time: (offset + size / 2) / rate, chroma });
  }
  if (!frames.length) return [];
  const grid = beats?.length > 1 ? [...beats] : Array.from({ length: Math.ceil(duration / .5) }, (_, i) => i * .5);
  const inKey = new Set((key ? DIATONIC[key.mode] ?? [] : []).map(([offset, minor]) => ((key.tonic + offset) % 12) * 2 + minor));
  let frame = 0;
  const emissions = grid.map((start, i) => {
    const end = grid[i + 1] ?? start + (start - (grid[i - 1] ?? start - .5)), chroma = new Float32Array(24);
    while (frame < frames.length - 1 && frames[frame].time < start) frame++;
    let count = 0;
    for (let j = frame; j < frames.length && frames[j].time < end; j++, count++) for (let p = 0; p < 24; p++) chroma[p] += frames[j].chroma[p];
    if (!count) chroma.set(frames[frame].chroma);
    const treble = [...chroma.subarray(0, 12)], bass = chroma.subarray(12), bassPeak = Math.max(...bass) || 1;
    return TRIADS.map(({ root, template }, s) => pearson(treble, template) + .3 * bass[root] / bassPeak + (inKey.has(s) ? .1 : 0));
  });
  // Viterbi: staying is free, changing chord costs .2.
  const states = TRIADS.length, links = [];
  let score = Float64Array.from(emissions[0]);
  for (let i = 1; i < emissions.length; i++) {
    let best = 0; for (let s = 1; s < states; s++) if (score[s] > score[best]) best = s;
    const next = new Float64Array(states), link = new Uint8Array(states);
    for (let s = 0; s < states; s++) {
      const stay = score[s] >= score[best] - .2; link[s] = stay ? s : best;
      next[s] = (stay ? score[s] : score[best] - .2) + emissions[i][s];
    }
    links.push(link); score = next;
  }
  let state = 0; for (let s = 1; s < states; s++) if (score[s] > score[state]) state = s;
  const path = new Array(emissions.length); path[path.length - 1] = state;
  for (let i = path.length - 1; i > 0; i--) path[i - 1] = state = links[i - 1][state];
  const changes = [];
  path.forEach((s, i) => { if (i === 0 || s !== path[i - 1]) changes.push([Math.round(Math.max(0, grid[i]) * 1000) / 1000, TRIADS[s].root, TRIADS[s].minor]); });
  if (changes.length) changes[0][0] = 0;
  return changes;
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[sorted.length >> 1] : 0; };

/** Full analysis. Returns beat times (seconds), tempo, confidence (0–1), downbeat phase
 * (index of the first downbeat among the first four beats) and whether tempo varies. */
export function analyzeTempo(mono, sampleRate, { minBpm = 60, maxBpm = 200, fit = true } = {}) {
  const { full: onset, low, fps, lag } = onsetEnvelope(mono, sampleRate);
  const toFrame = time => Math.round((time - lag) * fps);
  const peakNear = (envelope, time) => { const f = toFrame(time); let peak = 0; for (let k = f - 2; k <= f + 2; k++) peak = Math.max(peak, envelope[k] ?? 0); return peak; };
  const n = onset.length, duration = mono.length / sampleRate;
  if (n < fps * 4) { const key = analyzeKey(mono, sampleRate); return { version: ANALYSIS_VERSION, bpm: 0, confidence: 0, beats: [], downbeat: 0, varies: false, duration, key, chords: analyzeChords(mono, sampleRate, [], key) }; }
  // Tempo uses full-band plus kick-band onsets: dense hats correlate at every 16th-note lag,
  // so the kick's periodicity is what separates the beat from 3/4- or 3/2-beat lags.
  const pulse = Float32Array.from(onset, (value, i) => value + 1.5 * low[i]);
  const global = bestPeriod(pulse, 0, n, fps, minBpm, maxBpm, 120, 1);
  const globalBpm = 60 * fps / global.period;

  // Local tempo over 8 s windows (2 s hop), held near the global octave by a narrow prior.
  const span = Math.round(8 * fps), hop = Math.round(2 * fps), local = [];
  for (let start = 0; start + span <= n || (!local.length && start < n); start += hop) {
    const end = Math.min(n, start + span);
    const estimate = bestPeriod(pulse, start, end, fps, globalBpm / 1.45, globalBpm * 1.45, globalBpm, .25);
    local.push({ center: (start + end) / 2, period: estimate.period });
    if (end === n) break;
  }
  const smoothed = local.map((_, i) => median(local.slice(Math.max(0, i - 2), i + 3).map(item => item.period)));
  const periodAt = frame => {
    if (local.length === 1 || frame <= local[0].center) return smoothed[0];
    for (let i = 1; i < local.length; i++) if (frame <= local[i].center) {
      const t = (frame - local[i - 1].center) / (local[i].center - local[i - 1].center);
      return smoothed[i - 1] + (smoothed[i] - smoothed[i - 1]) * t;
    }
    return smoothed[smoothed.length - 1];
  };

  // Dynamic-programming beat tracking on the kick-weighted pulse, with a log-interval
  // penalty against the local period (so a tempo change never slips onto the hats).
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1), tightness = 100;
  for (let t = 0; t < n; t++) {
    const period = periodAt(t), from = Math.max(0, Math.round(t - 2 * period)), to = Math.round(t - period / 2);
    let best = 0, link = -1;
    for (let p = from; p <= to; p++) {
      const value = score[p] - tightness * Math.log((t - p) / period) ** 2;
      if (link < 0 || value > best) { best = value; link = p; }
    }
    score[t] = pulse[t] + (link >= 0 ? Math.max(0, best) : 0); back[t] = link >= 0 && best > 0 ? link : -1;
  }
  let last = n - 1; const tail = Math.round(periodAt(n - 1));
  for (let t = Math.max(0, n - tail); t < n; t++) if (score[t] > score[last]) last = t;
  const frames = []; for (let t = last; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();

  // Sub-frame refinement at each beat's onset peak, then frames → seconds.
  let beats = frames.map(t => {
    let peak = t; for (let k = Math.max(1, t - 2); k <= Math.min(n - 2, t + 2); k++) if (onset[k] > onset[peak]) peak = k;
    const a = onset[peak - 1] ?? 0, b = onset[peak], c = onset[peak + 1] ?? 0, curve = a - 2 * b + c;
    const shift = curve ? Math.max(-.5, Math.min(.5, .5 * (a - c) / curve)) : 0;
    return (peak + shift) / fps + lag;
  }).filter(time => time >= 0 && time <= duration);

  // Beat or offbeat? Dense hats (8ths/16ths) or an offbeat bassline can pull the grid a
  // quarter or half beat off. In most music the kick lands on the beat, so keep the
  // quarter-beat phase whose positions carry the most kick-like onsets.
  if (beats.length > 4) {
    const shifted = fraction => beats.slice(0, -1).map((time, i) => time + fraction * (beats[i + 1] - time));
    const energy = times => times.reduce((sum, time) => sum + peakNear(low, time), 0);
    const base = energy(shifted(0)); let best = 0, bestEnergy = base;
    for (const fraction of [.25, .5, .75]) { const value = energy(shifted(fraction)); if (value > bestEnergy) { best = fraction; bestEnergy = value; } }
    if (best && bestEnergy > base * 1.15) {
      const moved = shifted(best), period = beats[beats.length - 1] - beats[beats.length - 2];
      beats = [...(moved[0] - period >= 0 ? [moved[0] - period] : []), ...moved, moved[moved.length - 1] + period].filter(time => time >= 0 && time <= duration);
    }
  }

  // Steady tempo: fit one straight grid so sync does not jitter. Produced music almost
  // always sits on a whole BPM, so a fitted tempo within 0.1 BPM of one is rounded; the
  // phase is then placed on the attacks (within ±1/8 beat, never onto hats or offbeats).
  const intervals = beats.slice(1).map((time, i) => time - beats[i]);
  const spread = local.length > 1 ? (Math.max(...smoothed) - Math.min(...smoothed)) / median(smoothed) : 0;
  let varies = spread > .04, bpm = intervals.length ? 60 / median(intervals) : globalBpm;
  if (fit && !varies && beats.length > 8) {
    const mk = (beats.length - 1) / 2, mt = beats.reduce((a, b) => a + b, 0) / beats.length;
    let sxy = 0, sxx = 0; beats.forEach((time, i) => { sxy += (i - mk) * (time - mt); sxx += (i - mk) ** 2; });
    let period = sxy / sxx; const origin = mt - period * mk;
    const residual = Math.sqrt(beats.reduce((sum, time, i) => sum + (time - origin - period * i) ** 2, 0) / beats.length);
    if (residual < .03) {
      const whole = Math.round(60 / period);
      if (Math.abs(60 / period - whole) <= .1) period = 60 / whole;
      const attackAt = time => { const f = (time - lag) * fps, i = Math.floor(f), t = f - i; return (onset[i] ?? 0) * (1 - t) + (onset[i + 1] ?? 0) * t; };
      const count = Math.floor((duration - origin) / period) + Math.ceil(origin / period) + 1;
      let phase = origin, best = -Infinity;
      for (let shift = -period / 8; shift <= period / 8; shift += .0005) {
        let sum = 0; for (let k = -Math.ceil(origin / period); k < count; k++) sum += attackAt(origin + shift + k * period);
        if (sum > best) { best = sum; phase = origin + shift; }
      }
      bpm = 60 / period;
      let first = phase; while (first - period >= 0) first -= period; while (first < 0) first += period;
      beats = []; for (let time = first; time <= duration; time += period) beats.push(time);
    } else varies = true;
  }

  // Downbeat: the beat phase (mod 4) carrying the most low-band (kick) onset energy.
  const phase = [0, 0, 0, 0]; beats.forEach((time, i) => { phase[i % 4] += peakNear(low, time); });
  const downbeat = phase.indexOf(Math.max(...phase));

  // Confidence = periodicity × regularity. Periodicity is the onset envelope's correlation
  // with itself one local beat period later (≈0 for noise, pads and irregular hits; high
  // for a steady pulse), averaged over the windows so tempo changes still count.
  const correlation = (start, end, lag) => {
    let mean = 0; for (let i = start; i < end; i++) mean += onset[i]; mean /= Math.max(1, end - start);
    let numerator = 0, denominator = 0, whole = Math.floor(lag), t = lag - whole;
    for (let i = start; i < end; i++) {
      const e = onset[i] - mean; denominator += e * e;
      if (i - whole - 1 >= start) numerator += e * ((onset[i - whole] - mean) * (1 - t) + (onset[i - whole - 1] - mean) * t);
    }
    return denominator ? numerator / denominator : 0;
  };
  const periodicity = local.reduce((sum, item, i) => {
    const start = Math.max(0, Math.round(item.center - span / 2)), end = Math.min(n, start + span), lag = smoothed[i];
    return sum + Math.max(correlation(start, end, lag - .5), correlation(start, end, lag), correlation(start, end, lag + .5));
  }, 0) / local.length;
  // Regularity: tracked intervals should change smoothly, not jump around between hits.
  const steps = intervals.slice(1).map((value, i) => Math.abs(value - intervals[i]));
  const regularity = intervals.length > 2 ? Math.max(0, Math.min(1, 1 - (median(steps) / median(intervals)) / .08)) : 0;
  // Impulsiveness: a pulse makes a spiky onset curve; slow swells (pads) a smooth one.
  const sorted = Float32Array.from(onset).sort(), spikes = sorted[Math.floor(sorted.length * .99)];
  const impulsive = Math.max(0, Math.min(1, (spikes - 2) / 1.5));
  const confidence = Math.max(0, Math.min(1, (periodicity - .05) / .3)) * regularity * impulsive;
  const key = analyzeKey(mono, sampleRate);
  return { version: ANALYSIS_VERSION, bpm, confidence, beats, downbeat, varies, duration, key, chords: analyzeChords(mono, sampleRate, beats, key),
    tempo: local.map((item, i) => ({ time: item.center / fps, bpm: 60 * fps / smoothed[i] })) };
}
