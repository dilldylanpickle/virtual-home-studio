# Vinyl condition audio

## Signal path

Selected files decode once to PCM in the browser and transfer to one persistent worklet. Motor playback, physical scratching and the shared needle-fragment reader use that audio clock; [scrub diagnostics](direct-manipulation.md) explain the separate logical and audible cursors. Wow/flutter changes motor velocity; centering changes groove-read velocity once per revolution.

```mermaid
flowchart LR
    PCM[Decoded PCM] --> Read[Motor / scratch / groove reader]
    Read --> Gate[Trance Gate: beat grid at read-head song time]
    Gate --> Wear[Groove softening / treble shelf / saturation]
    Wear --> Width[Condition stereo width]
    Width --> Mix[Worklet output mix]
    Surface[Filtered procedural surface texture] --> Mix
    Crackle[Independent fine-crackle voices] --> Mix
    Pops[Independent pop voices] --> Mix
    Contact[Physical stylus contact] --> Mix
    Mix --> Cartridge[18 Hz high-pass / gentle treble shelf]
    Mix --> Dry[Advanced dry bypass]
    Cartridge --> Safety[Peak safety knee]
    Dry --> Safety
    Safety --> Volume[Output volume]
    Volume --> Destination[AudioContext destination]
```

The cartridge path defaults on and crossfades with its dry bypass. It is separate from record condition. The cartridge's low-frequency filter has a short decay after motor stop; tests wait for measured silence rather than assuming an immediate zero sample.

The final safety curve is linear below 0.9 amplitude and smoothly reduces rare near-full-scale peaks after all coloration, before volume. It prevents added defects/filter overshoot from clipping without continually compressing normal musical levels.

## Calibration rationale

The earlier condition engine reached the master output but was masked by music; the problem was effect balance rather than disconnected routing.

Its strongest profile produced approximately **−66.7 dBFS** surface sound against a **−16.6 dBFS** test chord at 75% volume. A 24% blend of a 6.5 kHz one-pole low-pass attenuated only 0.27 dB at 3.3 kHz and 1.04 dB at 11 kHz, explaining the weak audible difference.

## Shared profiles and processing

`static/condition-profiles.js` defines Mint, Near Mint, Very Good+, Very Good, Fair and Poor for both audio and visual wear. Numeric parameters interpolate from current values over 60 ms; changes send settings without resending PCM, seeking or restarting the motor. Defaults and persistence rules are in [AGENTS.md](../AGENTS.md#audio-and-speed-invariants).

- Surface texture combines filtered random components with condition-dependent level and spectral balance; it is generated continuously, never looped from a short recording.
- Fine crackles and larger pops use separate stochastic schedules and fixed voice pools (eight and four). Each event varies amplitude, duration, frequency, texture, polarity, and stereo position. Occasional stronger Poor pops remain bounded.
- Groove wear blends a fast smoothing filter, attenuates the upper spectrum with a shelf, and adds a parallel soft saturator that affects louder passages more. Bass remains substantially intact.
- Stereo narrowing reduces the side signal progressively; it does not change the playback clock.
- Surface sound requires moving vinyl, actual stylus contact, and power. Contact thumps/releases use independent physical contact edges and their own flag.

Surface, contact, and cartridge flags remain in the authoritative model and command API, but their checkboxes are absent from the primary panel. The advanced surface bypass also removes condition coloration; it preserves the independent contact and cartridge settings.

## Signal measurements

`tests/condition_audio.py` captures the same master output connected to the browser destination. It synthesizes its own stereo musical phrase, silence, calibrated frequency probes, and full-scale stress signal. At the original test volume of 75%, measured surface RMS progresses approximately as follows:

| Condition | Master surface RMS |
| --- | --- |
| Mint | −92.3 dBFS |
| Near Mint | −79.7 dBFS |
| Very Good+ | −65.8 dBFS |
| Very Good | −55.8 dBFS |
| Fair | −46.8 dBFS |
| Poor | −40.1 dBFS |

On calibrated probes, Poor reduces 9.6 kHz by about **7.7 dB**, with approximately **0.18 dB** change at 220 Hz. Returning to Mint restores the measured treble response. Full-scale input with Poor defects at maximum volume peaked at **0.9571**, with no full-scale or nonfinite samples. Exact random-event counts and surface measurements vary with capture timing.

The musical preview `artifacts/condition-ab.wav` contains Mint → Poor → Mint, eight seconds per section. It is intended for listening as well as the automated measurements.

The browser report also records audio-node routing, live playback continuity, and one playback engine/one PCM upload. Sample-level checks independently verify profile progression, harmonic restraint, stereo behavior, nonperiodic defects, and rapid parameter ramps.

## Tempo analysis and beat-synced effects

Tempo analysis is offline (once per file, in a worker): log-magnitude spectral flux at ~86 frames/s for timing, a linear low-band flux for kick weighting, autocorrelation tempo with a log-tempo prior, 8 s local tempo windows for changing tempos, dynamic-programming beat tracking on the kick-weighted pulse, a quarter-beat phase check against kick energy, and for steady tracks a whole-BPM grid placed on the attacks. On synthetic grooves (70–174 BPM, offbeat hats and offbeat bass, 44.1 and 48 kHz) `tests/tempo-engine.mjs` measures beats within about 1 ms; a 120→136 BPM ramp is tracked within 3 ms; noise and irregular hits report near-zero confidence.

The same offline pass estimates the key (chroma against key profiles) and chords along the beat grid: per-beat treble chroma (180–2000 Hz, 11 kHz analysis rate, 4096-point frames) correlated with the 24 major/minor triads, plus a bonus when the 40–180 Hz bass sits on the root and a small prior for chords in the key, decoded with Viterbi at a fixed cost per change. Synthetic progressions are recovered on ≥90% of beats; on dense electronic mixes it often holds one in-key chord for long stretches, which still fits.

The gate multiplies only the music sample (before wear and width) by a smoothed 16-step envelope. Its clock is the beat grid evaluated at the read head's song time, not wall time, which is why seeks, pauses, scratches and 45/78 RPM stay on the beat in the same test.

Per sample the music runs Trance Gate → Pixel Cat → hardstyle kit, before cartridge coloration, wear and width; surface noise and contact sounds bypass all three. Pixel Cat's crunch is a per-channel sample-and-hold (16 kHz × 0.25^crunch) followed by quantization to 12 − 8 × crunch bits; its band (band-limited 25% pulse lead with a dotted-eighth echo, 4-bit stepped triangle bass) is soft-clipped and scaled by the Band level, and the record under it is lowered by a quarter of that level. On a dense 126 BPM electronic master at the default 60% Band the band measures about 4–6 dB below the song. The hardstyle kit lanes are 8-bar phrases indexed by the absolute sixteenth since the grid's first downbeat.
