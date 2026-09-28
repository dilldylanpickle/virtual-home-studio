# Direct manipulation and scrub audio

## Ownership and motion

The interaction classes are defined in [AGENTS.md](../AGENTS.md#tonearm-and-timeline-interactions); physical timings are in [REFERENCE.md](../REFERENCE.md#playback-and-simulation-assumptions).

| Operation | Implementation constraint |
| --- | --- |
| HUD drag | Capture the pointer; apply only the latest event each animation frame; reports cannot overwrite its anchor |
| Physical arm drag | Assign the groove immediately while preserving CUE; ordinary motor playback continues when movement stops |
| Click or range-key seek | Traverse from the worklet's current cursor; retarget without jumping to a stale UI position |
| Assisted Play / Return Arm | Store every animated angle through `TonearmMotion`; cancel by generation, not visual transform alone |
| Lifecycle parking | Use the same motion primitive; finish mandatory parking before removing media |

Return cancels scrub/seek before lifting. The existing physical contact edge supplies its release sound; a second synthetic return sound would duplicate it.

## Failure mechanisms

| Regression | Cause | Preserved correction |
| --- | --- | --- |
| Drag lag | Every input restarted a finite eased destination seek; rendering wrote that delayed cursor back into the thumb | Separate immediate pointer ownership from commanded click traversal |
| Return teleportation | A state assignment jumped straight to rest; a separate visual-only parking animation left model geometry stale | One state-driven, cancellable pivot sweep |
| Harsh HUD audio | Source-seconds per pointer-second became PCM playback rate, capped at ±2048×; click seeking used the whole-song traversal derivative | Choose source neighborhoods quickly but read bounded, near-normal-speed fragments |

In the lag reproduction, a pointer at 70% left the displayed cursor near 30.1%, still reaching only 53.9% after 350 ms. The defect was destination easing, not source-node recreation or a CSS transition.

The original manual arm reader jumped to the new groove, blended for 4 ms and played locally forward at normal motor speed. HUD audio already shared its PCM, interpolation and effects, but excessive sample skipping/pitch multiplication made it harsh; similar motion became worse on longer recordings.

## Shared fragment reader

`VinylProcessor.anchorScrub(position, velocity)` serves manual arm movement, HUD drag and click traversal.

- Normalize velocity by recording duration; direction applies at the newest anchor.
- At steady 33⅓ RPM, local fragment magnitude is about 1–1.25×. Moving motor speed supplies the base; stopped transport uses a nominal reference; the ceiling is ±2.5×.
- Keep the logical groove independent of this audible readhead. Click motion stays continuous while audio anchors refresh at 60 Hz.
- Reuse the manual reader's convex 4 ms sample-value blend and apply 0.9 scrub gain (about −0.9 dB).
- Expire stale movement after 24 ms. A held HUD anchor stays silent; a resting physical arm returns to ordinary playback.
- Releasing HUD capture restores prior play/pause intent at the exact anchor. Raised CUE and power gating still apply.
- Preserve independent physical motor/record travel; temporary fragment rate must not drive platter rotation or manual logical-position prediction.
- Keep one PCM buffer, one condition-effects instance and the existing cartridge/master graph; no grain queue or per-gesture source nodes.

## Timeline preview and cancellation

Hover updates a separate marker/time using the HUD formatter and the same 5 px thumb-inset mapping as click/drag. Position updates are immediate; only opacity transitions over 110 ms, and the label clamps within the track.

The control retains a 3 px visible track, 10 px thumb and 28 px invisible vertical target. Pressing near the thumb enters direct mode; elsewhere, movement beyond 3 px distinguishes drag from click. Hover uses a pointer cursor, active dragging uses grabbing, and direct manipulation has no persistent status message.

Pointer cancellation, lost capture, page blur/hiding and explicit control takeovers clear gesture frames. Hover never sends an audio command or changes actual playback progress.

## Audio measurements and regression coverage

An original 64-second stereo phrase with equivalent anchor schedules reproduced the rate defect:

| Gesture | Earlier HUD rate | Earlier energy above 6 kHz | Shared reader energy above 6 kHz |
| --- | --- | --- | --- |
| Fast, 1 s per leg | −25.6 to +32× | 6.82% | 0.28% |
| Reversals, 150 ms per leg | −170.7 to +213.3× | 89.23% | 0.31% |
| Repeated clicks | −96.4 to +143.6× | 32.58% | 0.14% |

Equivalent manual/HUD schedules produced identical samples for Mint, Very Good+ and Poor. Fast scrub measured RMS 0.072 versus normal playback 0.084, peak 0.352 versus 0.392, and no full-scale samples; ordinary playback matched the saved baseline exactly.

These are test-signal measurements before the cartridge/master stage, not universal comfort scores. Real speakers/headphones and different recordings still need listening review.

- `tests/direct_scrub.py` and `tests/direct_scrub-engine.mjs`: next-frame pointer agreement, measured PCM slopes, motor independence, contact gates, release and takeover.
- `tests/seeking.py` and `tests/seeking-engine.mjs`: commanded traversal, audible fragments, retargeting and exact paused endpoints.
- `tests/return_arm.py`: lift clearance, pivot geometry, motor preservation and cancellation.
- `tests/timeline_hover.py`: preview independence, click mapping, pointer states and responsive bounds.
- `tests/scrub-audio-comparison.mjs`: musical A/B, condition equivalence, spectral energy/headroom, and 24 duration/source-rate/velocity combinations.

The comparison suite writes `artifacts/scrub-audio-comparison.json` and `artifacts/scrub-audio-ab.wav`; the JSON owns segment timestamps. Its optional `--baseline` argument accepts an older worklet to include the former manual reference. A normal run needs no temporary baseline file; review output is scaled to 69% and does not include cartridge coloration.
