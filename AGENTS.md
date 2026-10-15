# AGENTS.md

## Project

Virtual Home Studio is a local browser simulation of the fictional VHS-42069 direct-drive turntable. Start with [README.md](README.md) to run it; use [REFERENCE.md](REFERENCE.md) for hardware geometry and simulation assumptions.

## Public identity

The public turntable is the fictional **Virtual Home Studio VHS-42069**.

- Keep public branding original; do not add third-party manufacturer logos, commercial model names or third-party product photography.
- The owner-approved studio background plate (master `docs/source/studio-plate-master.png`) may be shown in the wide Studio view. Ship only the generated WebP derivatives in `static/assets/`; never ship the master. The plate must not show third-party logos or commercial model names.
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
- Preserve static hosting under a repository URL prefix: HTML uses document-relative asset/home links; worklet URLs resolve against `import.meta.url`. Verify loading and playback under a subdirectory as well as the local server when changing entry points or deployment packaging.
- Reuse existing motion, lifecycle and audio primitives.
- Keep changes focused; avoid unrelated visual redesigns.

## Repository map

Paths below are relative to the repository root; module names are under `static/`.

| File | Responsibility |
| --- | --- |
| `app.py` | FastAPI static server; loopback port 42069 |
| `.github/workflows/pages.yml` | Static GitHub Pages deployment from `master`; publishes the entry page and browser assets only |
| `static/index.html` | Physical SVG, HUD, customization and help dialogs |
| `static/studio-view.js` / `static/studio-view.css` | Full-bleed page layout, Close-up toggle, open-area measurement for framing, canonical SVG input projection, focus and WebGL fallback |
| `static/studio-renderer.js` | Transparent Three.js renderer for the turntable over the plate: calibrated plate camera, close-up travel, plate-derived environment, sun, shadow/contact/reflection catchers, grade, quality budgets and dynamic resolution; visual frame subscriber |
| `static/studio-plate.js` | Studio plate camera calibration (`PLATE`) and the shared plate placement used by the DOM plate and the 3D camera |
| `static/studio-turntable-3d.js` | Native turntable meshes and materials updated from the existing model and lifecycle presentation |
| `tools/make-plates.py` | Derives the shipped plate WebPs from the unpublished master in `docs/source/` (`uv run tools/make-plates.py`) |
| `static/vendor/` | Locally bundled Three.js 0.180.0 and required addons, with MIT license and source provenance |
| `static/app.js` | `Turntable` model, bootstrap, control bindings, rendering and worklet synchronization |
| `static/simulation-state.js` | Pure selectors for speed, contact and transport; no stored model |
| `static/mechanics.js` | Audio-clock motor acceleration/coast integration |
| `static/vinyl-processor.js` | Persistent PCM reader, cursor, scrub/scratch behavior and worklet reports |
| `static/audio-chain.js` | Cartridge coloration, dry/wet routing, peak protection and master volume |
| `static/vinyl-effects.js` | Procedural surface/contact sounds, wear, wow/flutter and centering |
| `static/condition-profiles.js` | Shared condition coefficients, default and descriptions |
| `static/tempo-analysis.js` / `static/tempo-worker.js` | Offline tempo and beat analysis (onsets, tempo, beat tracking, confidence, downbeat), run once per file in a worker |
| `static/tempo-grid.js` | Effective beat grid from analysis plus corrections (half/double, manual/tap, offset, bar), tap tempo, gate patterns |
| `static/rhythm.js` / `static/rhythm-ui.js` | Model-side tempo/gate commands, analysis cache and worklet sync / presets-popup tempo and gate column and BPM chip |
| `static/trance-gate.js` | Worklet Trance Gate clocked by the beat grid at the read head's song time |
| `static/assisted-playback.js` | Cancellable Play preparation and auto-cue sequence |
| `static/tonearm-motion.js` | Shared pivot sweep for auto-cue, Return Arm and lifecycle parking |
| `static/playback-presets.js` | Physical speed/pitch presets, derived selection and cancellable fader motion |
| `static/listening-hud.js` | Snapshot presentation; actions delegate to the model command API |
| `static/progress-control.js` | Timeline pointer capture, latest-event drag, click and hover preview |
| `static/ui-motion.js` | Shared motion timing, reversible preset popup and immediate-value label transitions |
| `static/dialog-motion.js` | Animated native dialogs, focus restoration and safe closing/reopening |
| `static/details-motion.js` | Reversible native details expansion/collapse |
| `static/media-source-ui.js` | Local-file source chooser and empty-state attention |
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
3D + SVG + HUD  worklet control messages
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

## Native Studio rendering

- Keep one `Turntable` model, one audio worklet and the same mounted `#deck`. WebGL draws the visible turntable throughout studio view, travel and inspection. The transparent original SVG retains canonical controls, accessibility and pointer handling; never add a second interaction or playback model.
- The plate (`#studio-plate`) and a transparent canvas are fixed full-viewport; header, hero and the frosted listening panel float above them. `StudioView` measures `#scene-frame` (wide) and header-to-panel (inspection), computes the plate rectangle with `placePlate()` (a close, speaker-framed default: the deck fills `PLATE.wideDeckShare` of the width, plus zoom to keep the table spot above the panel), positions the image and passes everything to `StudioRenderer.setFraming()`. The wide camera is the calibrated plate camera mapped through that same rectangle, so the deck stays on the table at every aspect ratio; change calibration only in `PLATE`, from measured plate lines. In the studio view the header **Skyline** button (`#skyline-toggle`) fades the hero and panel (inert) and tilts the view straight up to the city in 1.4 s (a pure vertical pan, no zoom) by animating the plate rectangle the camera maps through (`placeShot`); playback continues, and the button (then **← Back to studio**), Escape or a click outside the header returns. Close-up travel and graphics fallback leave it immediately. During travel the plate pushes in, blurs and dims (presentation only); it never moves with independent timing. Measurements ignore scroll. The header **Close-up** button (`#studio-focus`) is the only navigation toggle; in inspection it becomes a prominent **← Back to studio** pill. Screens ≥1440 px dock the listening panel into one slim row (`--hud-docked`) in both views, so travel never resizes it (narrower screens keep the full panel in both); **Hide controls** (`#hud-hide`, on the Turntable details summary line) / **Show controls** (`#hud-show`) slide it away (inert) for a full view of the deck or bring it back, that preference lasts for the page session, and the studio view always shows the panel. `#notice` remains the live status region, but routine narration is screen-reader only; only alerts (errors and blocked actions, `showNotice(message, error, alert)`) are visible: above the panel, in the header row during wide inspection, or above **Show controls** when the panel is hidden, never over the deck. The close-up frame follows the preference, not the travel target, so returning never resizes it mid-travel. Travel also commands the model's dust cover (`setCover`): the studio view shows it closed, inspection lifts it, and returning closes it; the native lid swings on its rear hinge toward `coverClosed` (presentation only, retargetable, immediate under reduced motion), and the SVG fallback keeps it open. The hero (`--intro-away`) and a hidden panel (`--hud-away`) follow camera progress, not the click: they leave early on the way in and return only as the studio settles. Measurements use layout offsets so the slide transform and docking never move the plate. Text over the plate relies on the top scrim plus strong text shadows; keep header, hero and Turntable details text at readable sizes and contrast. 3D print and control labels use the SVG's own positions, font sizes and baselines (one weight heavier), darken dark inks on light finishes, and sample half a mip level sharp on a matte decal so close-up lettering keeps the SVG's legibility; inspection fades the off-deck sun shadow and adds a soft overhead key.
- `StudioView` owns navigation and input projection. Ordinary travel follows one reversible 1.65-second path: dolly first, then overhead inspection. Interrupted movement retargets from the current position. Real scene depth produces parallax; do not animate scenery independently of the camera.
- The Three.js world uses metres: X across, Y up, +Z toward the listener. The glass desktop is Y = 0. The original input plane projects through the rendering camera at chassis height; inspection finishes with an affine orthographic projection for accurate existing SVG pointer coordinates.
- `app.js` drives `studio.renderFrame()` after `turntable.syncPosition()` in its existing frame loop. Native meshes consume that state; renderer caches, camera progress and quality settings are visual only. Rendering must not seek, advance playback or create audio nodes.
- During insertion/ejection only, read the existing record-lift animation's presentation transform and opacity for the native record. Keep removable media, permanent hardware, center hole and opaque label separate. Do not start another lifecycle animation or hide the spindle to approximate occlusion.
- Hardware remains inert in wide view and during travel. The deck entrance is keyboard accessible; HUD, file handling and camera navigation remain available. Transparent controls need the visible projected focus indicator in inspection.
- Before travel, release direct gestures and pointer captures through existing cancellation primitives. Do not stop playback, reset transport or cancel assisted/lifecycle motion. Escape dismisses dialogs, presets and file-drop previews first; reduced motion settles immediately, and page hiding finishes travel without moving focus.
- The wide Studio view is a 2.5D composite: the photoreal background plate supplies the room, speakers, window, table and skyline, and WebGL renders only the native turntable (plus its shadow/reflection catchers) over it. Room, speakers, window and skyline need not be procedural meshes. The turntable itself stays native geometry: never substitute a screenshot or photograph of the turntable, CSS depth bands or projected SVG relief.
- `StudioRenderer` owns the sun shadow catcher, contact shadow, fading glass reflection, plate-derived environment and grade. Keep catchers out of the reflection pass, cache unchanged shadows (VSM also draws shadow receivers into the map, so moving glass such as the dust cover neither casts nor receives; the cache key includes the arm's cue height so its shadow follows the damped cue), present synchronously after each plate/camera motion step (`StudioView.present()`, so the deck never lags the photograph), and avoid unnecessary frames while settled, offscreen or hidden. Cinematic is the default; Performance and Balanced change bounded render budgets in `QUALITY`, never model timing or audio. The Graphics selector sits in Turntable details. Rendering uses the device pixel ratio (cap 2); dynamic resolution reacts only to sustained late frames and never drops below one device pixel per CSS pixel, so print stays sharp. Print textures (deck sheets, fascia, control labels, record label, slipmat) stay at ≥4× their former density, mipmapped, with the GPU's maximum anisotropy; do not reintroduce FXAA or full-deck print atlases.
- The monitors are part of the plate; nothing animates them. If WebGL initialization or a render operation fails, dispose the native resources and reveal the original SVG controls. Context restoration regenerates the environment map; graphics interruption must leave model/audio ownership and the shared app frame loop intact.
- Three.js 0.180.0 and required addons are local MIT-licensed assets under `static/vendor/`. Preserve its license/provenance and relative imports. Plate images use document-relative URLs so static hosting under a repository prefix keeps working.

## Tonearm and timeline interactions

| Class | Inputs | Position owner |
| --- | --- | --- |
| Direct | Physical tonearm drag; HUD drag | Latest pointer/groove, immediate |
| Commanded | Timeline click or native range keyboard input | Worklet's finite 120–450 ms traversal |
| Automated | Assisted Play; Return Arm; record parking | Shared cancellable `TonearmMotion` sweep |

- Cue position belongs to the user during manual movement and seeking.
- `replayEnabled` defaults off. The HUD repeat toggle persists within the page session; natural worklet completion reuses assisted Play to lift, sweep and cue the current record. Manual end-seeks, scratching, Pause and record handling never trigger replay. Turning repeat off prevents the next replay; an already-started cue sequence remains cancellable through the normal controls.
- Playback presets switch RPM latches together, then animate the actual pitch fader through `PresetMotion` and the existing model/audio path. Range changes preserve `pitch / pitchRange` exactly like the manual range button; the fader then takes one uninterrupted path to its target, with no centering detour. Quartz unlocks without moving the fader; zero-pitch presets lock only after reaching zero. Manual fader/range/Quartz/speed input, power changes and media handling cancel pending motion; newer presets retarget from the current controls. `presetMotion` holds model-owned operation metadata, not a separate speed or selected preset. Settled selection derives from physical inputs. Presets preserve transport, cue and groove; media handling blocks commands.
- HUD Play/Pause and physical START/STOP use the same motor ramp (280 ms from rest, 360 ms to stop). Pause retains its exact logical groove while the audible tail coasts; resume starts from that anchor.
- Play can lower the stylus; it chooses 33⅓ only when no speed is selected and respects a chosen groove.
- Direct gestures cancel older commanded/automated moves; canceled callbacks must not regain ownership.
- Return Arm lifts, sweeps outward and settles; it does not reset platter settings.
- Mandatory record-handling parking cannot be canceled by controls while the lifecycle is busy.
- Timeline hover is presentation only: no seek, pause, arm motion or progress freeze.
- A stationary HUD drag holds its anchor silently; release preserves prior play/pause intent.
- Pointer cancel, lost capture, blur and page hiding must release gestures and pending frames.

## Record lifecycle

```text
Choose / Replace → source chooser → Local File
    ↓ file selection, or Drop (picker cancellation ends here)
validate extension → park arm / stop motor → decode
    ↓ success
remove old record if present → transfer PCM → insert → ready

Eject: ready → park / stop → lift / fade → clear PCM → empty
```

- Opening the source chooser or file picker alone changes nothing; same-file selection works because the input resets.
- Local File and drag-and-drop use the same `load(file)` command. The grey, disabled “YouTube link — Coming soon” entry is only a placeholder.
- Keep the Choose/Replace action label stable during decoding, removal and insertion; update it only when the lifecycle settles empty or ready. Keep the action row’s dimensions stable across those labels and avoid helper text that shifts it when media loads.
- Empty-state attention belongs to the source chooser: fade it after media loads, let valid file dragging take priority, and use a static highlight for reduced motion.
- Generation checks discard stale decodes; insertion/removal operations serialize.
- Decode failure retains existing media, though parking may already have lifted/stopped it.
- `pendingFilename` labels incoming media; active filename/duration change after seating.
- Colors, condition and volume persist across replacement and eject/reload within a page session.
- Animate the record and shadow only; never fade chassis branding, slipmat print or spindle.
- Labels remain opaque, including on Clear/Smoke bodies. Spindle exposure follows the moving center hole and paint order.

## Audio and speed invariants

- Web Audio uses one persistent `AudioWorkletNode` and one PCM transfer per successful load.
- The worklet loads as `vinyl-processor.js?v=ENGINE_VERSION` and reports `engine` in every report. Bump `ENGINE_VERSION` in both `app.js` and `vinyl-processor.js` whenever worklet messages or behavior change: a browser holding a stale cached engine otherwise ignores new messages silently; a mismatch shows a reload alert.
- `anchorScrub()` serves manual arm, HUD drag and click traversal; reuse it instead of a HUD-only effect.
- Keep logical groove travel separate from local PCM rate. Whole-song pointer velocity must not become extreme playback pitch.
- Preserve micro-blends, bounded signed rates, stale-motion expiry and shared gain staging.
- Physical vinyl scratching retains its independent hand-rotation model; motor travel continues underneath.
- Condition affects noise, crackle, pops, wear, treble and stereo width through one effects instance.
- Defaults: Very Good+, 69% volume, surface/contact/cartridge enabled, wow/flutter and centering off.
- Avoid duplicate `AudioBufferSourceNode` playback or per-gesture graph rebuilds. Clean up any transient nodes/object URLs introduced by changes; current loading reads `File.arrayBuffer()` directly.
- Full-file decoding uses memory proportional to duration/channels; processing uses at most two channels.
- The cue is damped: `lowerStylus()` keeps `stylusRaised` true during a ~1.1 s descent (`cueDescent`, which the 3D arm follows) and contact/sound begins at touchdown; lifting breaks contact at once. Return Arm and assisted cueing are weighted, unhurried sweeps (~1–1.4 s) after a 320 ms lift.

## Tempo and Trance Gate

- Analysis runs once per loaded file, offline in `tempo-worker.js` (main-thread fallback), never during playback. Results and the user's corrections are cached per file (name, size, modification time, duration, analysis version) in memory and `localStorage` (40 files).
- Beats are song (record) seconds. Steady tracks get one straight grid snapped to a whole BPM when within 0.1 BPM; changing tempos keep tracked beats. Confidence combines periodicity, regularity and impulsiveness. All tempos display and enter as whole BPM.
- `Rhythm` owns `state.tempo` and `state.gate` and sends the effective grid (`beats`) and gate settings (`gate`) to the worklet whenever they change. Corrections never change speed, pitch or transport.
- The gate must complement the music, not muffle it: pumps let the first 25 ms after each step through (kick attack), a ~180 Hz one-pole crossover ducks lows fully and highs by `highs`, and a bounded make-up gain (≤ +1.5 dB, `gateMakeup`) restores lost loudness. Depth and gate length/swell run 0–100%.
- The worklet's `TranceGate` reads the beat grid at the read head's song time, so seeking, pausing, scratching, direct scrubbing and speed/pitch changes stay on the beat without resynchronization. It gates music only; surface noise and contact sounds pass through. Edges use a 1.5 ms attack and 9 ms release.
- The presets popup has two columns: presets (left) and, on the right, Tempo above the Trance Gate above a disabled **Reverb · Coming soon** placeholder. The BPM chip on the track line toggles it. Interacting with the right column keeps the popup open.
- Tempo shows the playing BPM (song BPM × `effectiveRate`, whole number), a confidence dot and plain-language origin ("Detected from the song", "From your taps"), with **Tap the beat** and live tap coaching. Corrections live in the closed **Fix the beat** drawer, phrased as questions: Half/Double, Exact BPM, Earlier/Later (±10 ms), Move by a beat, Reset to the detected beat. Keep product copy free of jargon. Speed changes never alter the song's beat grid.
- Gate styles (`GATE_STYLES` in `tempo-grid.js`: Push, Pulse, Bounce, Breathe, Trance, Gallop) are voiced for full mixes: no total drop-outs, and `soft` edges (longer attack/release ramps). They set shape, rate, depth, length, softness and steps together; the selected style is derived (`styleName`), any later edit shows Custom. Rates are 1/2–1/32 plus 1/8T; triplet patterns cycle every bar (12 steps, `gateCycle`).

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
- Keep the headline “Why spend $449 on a turntable when you can vibe code one for $10?” with its punchline (a line strikes through “$10”, then “$449 in tokens” writes in; immediate under reduced motion), one-line desktop fit (font sized to the column) and concise in-app help.
- Long HUD titles use the shared `marquee()` (glide to the end and back with pauses, full text in the tooltip; ellipsis under reduced motion).
- Put technical details here or in `docs/`, not into product copy.
- Software UI motion uses shared 220 ms panel / 140 ms feedback timing. Animate both entry and exit; newer input reverses/cancels old transitions. Keep panel placement and action dimensions stable.
- Dialogs retain native modality until the closing animation ends, then restore focus. Closing preset options become inert immediately and hide after the fade. Native Local File selection closes its dialog synchronously before opening the picker so the trusted gesture is preserved.
- Label values and accessible names update immediately; only their visual presentation animates. Never animate clocks, timeline input, audio commands or physical model state through the UI helpers. Reduced motion applies immediately, including to animations already running.

| Scope | Existing bindings |
| --- | --- |
| Page/deck, outside dialogs and ordinary form controls | Space: platter START/STOP; C: cue; R: lift and return arm; G: Trance Gate on/off; T: tap tempo |
| Focused physical buttons | Enter/Space: activate; speed keys ignore repeats |
| Focused POWER | Arrows: rotate; Home/End: off/on; Enter/Space: toggle endpoint |
| Focused tonearm | Left/Down or Right/Up: −/+1% groove; Shift: 10%; Home/End: first/last |
| Focused vinyl | Hold Left/Right: turn backward/forward; release: let go |
| Native controls | Tab: focus; range arrows/Home/End: adjust; Escape: dismiss dialog |
| File-drop preview | Escape or window blur: clear preview |

Space on the deck is a motor control, not HUD Play/Pause. Global C/R/G/T/Space are suppressed in dialogs, normal form controls, Ctrl/Alt/Meta combinations and repeated keydown events.

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
| Native Studio camera, model/audio continuity, plate composite and responsive input | `studio_view.py`, `studio_plate.py`, `studio_recovery.py` |
| Physical controls, RPM and geometry | `controls.py`, `hardware.py`, `motor.py` |
| Assisted transport and arm motion | `assisted.py`, `return_arm.py`, `phase2.py`, `replay.py`, `presets.py`, `preset_motion.py` |
| Scratching, seeking and HUD input | `scratching.py`, `seeking.py`, `direct_scrub.py`, `timeline_hover.py` |
| Media handling and appearance | `media_sources.py`, `record_paths.py`, `customization.py`, `branding.py`, `occlusion.py` |
| Effects and UI polish | `realism.py`, `condition_audio.py`, `polish.py`, `ui_motion.py` |
| Tempo detection and Trance Gate | `trance_gate.py` |

| DSP coverage | Node files under `tests/` |
| --- | --- |
| PCM/motor and transport | `audio-engine.mjs`, `phase2-engine.mjs` |
| Effects and conditions | `realism-engine.mjs`, `condition-engine.mjs` |
| Scrub/seek quality and ownership | `seeking-engine.mjs`, `direct_scrub-engine.mjs`, `scrub-audio-comparison.mjs` |
| Tempo analysis, grid corrections and Trance Gate | `tempo-engine.mjs` |

- Physical-control and top-down geometry suites use `studio_helpers.enter_turntable(page)` after navigation; HUD/media suites can exercise the default wide view. `studio_view.py` checks native camera continuity, aligned controls, focus and persistent model/worklet output; `studio_plate.py` checks plate placement and derivative selection, the calibrated vanishing point, deck spot/scale/visibility across aspect ratios, grounding pixels and print-texture sharpness settings. These checks do not establish a guaranteed frame rate or photographic fidelity.
- Headless SwiftShader renders the full-viewport studio at only a few frames per second, below what `studio_view.py`'s camera-continuity sampling needs; run the studio suites with the GPU path where available.
- Browser suites using `studio_helpers.launch_browser()` accept `VHS_TEST_GPU=1`, for example `VHS_TEST_GPU=1 uv run --group dev python tests/studio_view.py` (or `tests/studio_plate.py`). This opts into the local Chromium / ANGLE OpenGL / WSL Mesa D3D12 NVIDIA path without changing app quality. Headless modes cannot reach the GPU under WSL, so it uses real windows, minimized via CDP (WSLg parks them off-screen) with background throttling disabled; set `VHS_TEST_SHOW=1` to watch them; omit the variable for the normal headless launch. See `studio_helpers.launch_browser()` before using it on another graphics stack.
- Use the bundled [short WAV](tests/fixtures/audio/short-record.wav); its [provenance/generator](tests/fixtures/audio/README.md) is included.
- Long audio is generated temporarily by `audio_fixtures.py`; tests must not depend on personal media.
- `artifacts/` contains disposable screenshots, reports and A/B WAVs and is ignored by Git.
- Audio changes need output measurements and listening review; numerical assertions alone do not establish comfort.
- Third-party product photographs are not public assets or runtime/test dependencies. Use the original SVG, the approved studio plate and generated screenshots.

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
