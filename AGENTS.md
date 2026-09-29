# AGENTS.md

## Project

Virtual Home Studio is a local browser simulation of the fictional VHS-42069 direct-drive turntable. Start with [README.md](README.md) to run it; use [REFERENCE.md](REFERENCE.md) for hardware geometry and simulation assumptions.

## Public identity

The public turntable is the fictional **Virtual Home Studio VHS-42069**.

- Keep public branding original; do not add third-party manufacturer logos, commercial model names or product photography.
- The vinyl-disc logo in `static/assets/virtual-home-studio-logo.svg` is original project-owned artwork; reuse it for hardware, header and favicon.
- Preserve subtle monochrome equipment lettering and the restrained model designation.
- Public screenshots belong in `docs/images/`, use generated audio with neutral metadata, and must match the current branding.
- The first public commit must already be sanitized. Keep private photography and generated test artifacts outside Git; do not configure a remote or publish without an explicit request.

## Golden rules

- Preserve the established turntable geometry and the established interaction model.
- Keep one authoritative model; do not add separate HUD or playback state.
- Treat manual tonearm sound as the reference for the shared scrub reader.
- Animate removable media independently of permanent hardware.
- Keep audio decoding and playback local to the browser.
- Reuse existing motion, lifecycle and audio primitives.
- Keep changes focused; avoid unrelated visual redesigns.

## Repository map

Paths below are relative to the repository root; module names are under `static/`.

| File | Responsibility |
| --- | --- |
| `app.py` | FastAPI static server; loopback port 42069 |
| `static/index.html` | Physical SVG, HUD, customization and help dialogs |
| `static/app.js` | `Turntable` model, bootstrap, control bindings, rendering and worklet synchronization |
| `static/simulation-state.js` | Pure selectors for speed, contact and transport; no stored model |
| `static/mechanics.js` | Audio-clock motor acceleration/coast integration |
| `static/vinyl-processor.js` | Persistent PCM reader, cursor, scrub/scratch behavior and worklet reports |
| `static/audio-chain.js` | Cartridge coloration, dry/wet routing, peak protection and master volume |
| `static/vinyl-effects.js` | Procedural surface/contact sounds, wear, wow/flutter and centering |
| `static/condition-profiles.js` | Shared condition coefficients, default and descriptions |
| `static/assisted-playback.js` | Cancellable Play preparation and auto-cue sequence |
| `static/tonearm-motion.js` | Shared pivot sweep for auto-cue, Return Arm and lifecycle parking |
| `static/listening-hud.js` | Snapshot presentation; actions delegate to the model command API |
| `static/progress-control.js` | Timeline pointer capture, latest-event drag, click and hover preview |
| `static/record-lifecycle.js` | Validation/decode, serialized removal/insertion, stale-request rejection |
| `static/record-customization.js` | Chassis finishes, material palettes, condition UI and coordinated record/thumbnail appearance |
| `static/style.css` | Hardware and software presentation, hit areas and responsive layout |
| `tests/` | Standalone browser scripts, Node DSP suites and generated-fixture helpers |
| `docs/` | Focused engineering diagnostics and public screenshots |

## State and clock ownership

```text
UI / physical controls
        ↓ commands
Turntable.state in app.js
        ↓ pure selectors in simulation-state.js
   derived physical state
      ↙              ↘
SVG + HUD       worklet control messages
                      ↓
             PCM + motor audio clock
                      ↓ revision-tagged reports
               app.js synchronization
```

- Change physical inputs through model commands; render from shared snapshots.
- Effective RPM/pitch are selectors, not independently writable caches.
- The worklet owns ordinary playback position and motor/record travel.
- Direct HUD input owns its exact logical anchor; mechanical arm motion owns its animated angle.
- Reject obsolete worklet revisions and canceled operation generations.
- Do not independently seek audio, rotate the arm or set the HUD thumb from unrelated handlers.
- `window.turntable` is a frozen command/diagnostic facade that returns model snapshots; use commands rather than mutating returned objects.

## Tonearm and timeline interactions

| Class | Inputs | Position owner |
| --- | --- | --- |
| Direct | Physical tonearm drag; HUD drag | Latest pointer/groove, immediate |
| Commanded | Timeline click or native range keyboard input | Worklet's finite 120–450 ms traversal |
| Automated | Assisted Play; Return Arm; record parking | Shared cancellable `TonearmMotion` sweep |

- Cue position belongs to the user during manual movement and seeking.
- `replayEnabled` defaults off. The HUD repeat toggle persists within the page session; natural worklet completion reuses assisted Play to lift, sweep and cue the current record. Manual end-seeks, scratching, Pause and record handling never trigger replay. Turning repeat off prevents the next replay; an already-started cue sequence remains cancellable through the normal controls.
- Play can lower the stylus; it chooses 33⅓ only when no speed is selected and respects a chosen groove.
- Direct gestures cancel older commanded/automated moves; canceled callbacks must not regain ownership.
- Return Arm lifts, sweeps outward and settles; it does not reset platter settings.
- Mandatory record-handling parking cannot be canceled by controls while the lifecycle is busy.
- Timeline hover is presentation only: no seek, pause, arm motion or progress freeze.
- A stationary HUD drag holds its anchor silently; release preserves prior play/pause intent.
- Pointer cancel, lost capture, blur and page hiding must release gestures and pending frames.

## Record lifecycle

```text
Choose / Drop / Replace
    ↓ file selection (picker cancellation ends here)
validate extension → park arm / stop motor → decode
    ↓ success
remove old record if present → transfer PCM → insert → ready

Eject: ready → park / stop → lift / fade → clear PCM → empty
```

- Picker opening alone changes nothing; same-file selection works because the input resets.
- Generation checks discard stale decodes; insertion/removal operations serialize.
- Decode failure retains existing media, though parking may already have lifted/stopped it.
- `pendingFilename` labels incoming media; active filename/duration change after seating.
- Colors, condition and volume persist across replacement and eject/reload within a page session.
- Animate the record and shadow only; never fade chassis branding, slipmat print or spindle.
- Labels remain opaque, including on Clear/Smoke bodies. Spindle exposure follows the moving center hole and paint order.

## Audio and speed invariants

- Web Audio uses one persistent `AudioWorkletNode` and one PCM transfer per successful load.
- `anchorScrub()` serves manual arm, HUD drag and click traversal; reuse it instead of a HUD-only effect.
- Keep logical groove travel separate from local PCM rate. Whole-song pointer velocity must not become extreme playback pitch.
- Preserve micro-blends, bounded signed rates, stale-motion expiry and shared gain staging.
- Physical vinyl scratching retains its independent hand-rotation model; motor travel continues underneath.
- Condition affects noise, crackle, pops, wear, treble and stereo width through one effects instance.
- Defaults: Very Good+, 69% volume, surface/contact/cartridge enabled, wow/flutter and centering off.
- Avoid duplicate `AudioBufferSourceNode` playback or per-gesture graph rebuilds. Clean up any transient nodes/object URLs introduced by changes; current loading reads `File.arrayBuffer()` directly.
- Full-file decoding uses memory proportional to duration/channels; processing uses at most two channels.

| 33 latch | 45 latch | Selected speed |
| --- | --- | --- |
| Off | Off | None; motor stopped |
| On | Off | 33⅓ RPM |
| Off | On | 45 RPM |
| On | On | 78 RPM |

Each button toggles independently; the printed 78 bracket is inert. Tempo Range toggles ±8% / ±16% while retaining `pitch / pitchRange`; Quartz overrides effective pitch without moving the fader. Audio and platter derive from selected RPM and the shared motor curve.

## Presentation and keyboard

- Preserve the established geometry and dark physical controls. Silver is the default chassis finish; the eight turntable palettes recolor chassis paint, fader surround and contrasting printed markings only.
- `turntableColor` belongs to the model, persists across media changes within the page session, and never changes audio settings, chrome, controls or vinyl/label colors.
- Hardware controls retain physical shapes; transparent hit areas must stay invisible.
- Use muted-blue software accents. Default media is black vinyl with a blue label.
- Site, chassis, slipmat and record-label identity is **Virtual Home Studio**.
- Keep the headline “Why spend $449 on a turntable when you can vibe code one for $10?”, responsive desktop line fit and concise in-app help.
- Put technical details here or in `docs/`, not into product copy.

| Scope | Existing bindings |
| --- | --- |
| Page/deck, outside dialogs and ordinary form controls | Space: platter START/STOP; C: cue; R: lift and return arm |
| Focused physical buttons | Enter/Space: activate; speed keys ignore repeats |
| Focused POWER | Arrows: rotate; Home/End: off/on; Enter/Space: toggle endpoint |
| Focused tonearm | Left/Down or Right/Up: −/+1% groove; Shift: 10%; Home/End: first/last |
| Focused vinyl | Hold Left/Right: turn backward/forward; release: let go |
| Native controls | Tab: focus; range arrows/Home/End: adjust; Escape: dismiss dialog |
| File-drop preview | Escape or window blur: clear preview |

Space on the deck is a motor control, not HUD Play/Pause. Global C/R/Space are suppressed in dialogs, normal form controls, Ctrl/Alt/Meta combinations and repeated keydown events.

## Tests

Use the setup in [README.md](README.md#development). Browser scripts target the running app at `http://127.0.0.1:42069`; they are standalone scripts, not pytest tests. Run from the repository root.

```sh
uv run --group dev python tests/acceptance.py
node tests/audio-engine.mjs
```

Use the same Python prefix or `node` with the relevant paths below. There is no aggregate test runner. Chromium is required for browser suites; `ffmpeg` is also required by acceptance and record-path checks; Node DSP suites need no server or npm packages.

| Area | Browser files under `tests/` |
| --- | --- |
| Broad acceptance | `acceptance.py` |
| Physical controls, RPM and geometry | `controls.py`, `hardware.py`, `motor.py` |
| Assisted transport and arm motion | `assisted.py`, `return_arm.py`, `phase2.py`, `replay.py` |
| Scratching, seeking and HUD input | `scratching.py`, `seeking.py`, `direct_scrub.py`, `timeline_hover.py` |
| Media handling and appearance | `record_paths.py`, `customization.py`, `branding.py`, `occlusion.py` |
| Effects and UI polish | `realism.py`, `condition_audio.py`, `polish.py` |

| DSP coverage | Node files under `tests/` |
| --- | --- |
| PCM/motor and transport | `audio-engine.mjs`, `phase2-engine.mjs` |
| Effects and conditions | `realism-engine.mjs`, `condition-engine.mjs` |
| Scrub/seek quality and ownership | `seeking-engine.mjs`, `direct_scrub-engine.mjs`, `scrub-audio-comparison.mjs` |

- Use the bundled [short WAV](tests/fixtures/audio/short-record.wav); its [provenance/generator](tests/fixtures/audio/README.md) is included.
- Long audio is generated temporarily by `audio_fixtures.py`; tests must not depend on personal media.
- `artifacts/` contains disposable screenshots, reports and A/B WAVs and is ignored by Git.
- Audio changes need output measurements and listening review; numerical assertions alone do not establish comfort.
- Product photographs are not public assets or runtime/test dependencies. Use the original SVG and generated screenshots.

## Regression traps

- Quartz depending on another fader event; range changes moving the fader; a separate 78 button.
- HUD dragging chasing an old destination or using harsh, excessive-rate audio.
- Return Arm or record insertion teleporting instead of completing physical motion.
- Replace ejecting before file selection; canceled decode callbacks restoring stale media.
- Chassis/slipmat branding fading with media, or spindle pixels crossing an opaque label.
- Visible interaction hitboxes or software theme changes recoloring hardware.

## Before finishing

- Run relevant tests with the small fixture and check browser console/server output.
- For interaction changes, verify manual and assisted operation plus pointer cancellation.
- For presentation changes, inspect desktop, tablet and mobile; keep keyboard focus usable.
- Preserve unrelated appearance and behavior; update the owning document when behavior changes.
- Keep generated artifacts, caches, secrets and personal/third-party media out of commits.

## Engineering details

- [Audio engine](docs/audio-engine.md): condition processing, graph and calibrated measurements.
- [Physical lifecycle](docs/physical-lifecycle.md): compositing, file replacement and race prevention.
- [Direct manipulation](docs/direct-manipulation.md): scrub diagnosis, pointer ownership and quality checks.
