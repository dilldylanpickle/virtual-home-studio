# Record lifecycle and compositing

## Layer ownership

```text
platter / slipmat → shadow → permanent spindle → removable record → upper hardware
                                            └─ body, grooves, wear, opaque label
```

A user-space mask cuts a center hole through the removable record and moves with it. Seated spindle pixels remain visible only through that hole; no opacity flag or timeout controls the spindle itself.

- Clear/Smoke translucency applies to the playable body only; the paper label stays opaque.
- Slipmat print stays present and is naturally covered by opaque media.
- Chassis logo, model text and permanent hardware never join record animations.
- Lift/shadow layers sit outside platter rotation, so media travels vertically at any motor angle.
- Fade occurs only at the elevated ends of insertion/ejection; the near-platter portion remains opaque.
- Reduced motion shortens animation while retaining the same seated geometry and paint order.

## File handling

[AGENTS.md](../AGENTS.md#record-lifecycle) defines the shared lifecycle. Choose/Replace opens the source chooser. Selecting Local File opens the native picker synchronously; only selection enters loading, and the input resets so the same file can be selected again. Choosing Local File and dropping an MP3/WAV both call the same `load(file)` command.

| Ownership | Rule |
| --- | --- |
| Incoming file | Extension validation and generation checks precede adoption; park/decode before discarding existing media |
| Physical operations | One removal promise serializes callers; new requests wait for in-flight insertion/removal |
| Metadata | `pendingFilename` belongs to incoming media; active filename/duration change after seating |
| Decode failure | Keep existing media available; prior parking may have stopped/lifted its transport |
| Customization | Colors, condition and volume persist through replacement and eject/reload |

## Failure mechanisms and checks

| Regression | Cause to avoid | Coverage |
| --- | --- | --- |
| Instant insertion | First keyframe already opaque | `tests/record_paths.py`, `tests/realism.py` |
| Replace acts like Eject | Loaded-record handler removes media before opening the picker | `tests/record_paths.py` |
| Spindle crosses label | Permanent spindle paints after all removable media | `tests/occlusion.py` |
| Branding blinks | Render-time slipmat hide class or permanent spindle fade | `tests/branding.py` |

Occlusion checks compare pixels at five insertion and five ejection frames for Black, White, Blue, Red, Clear and Smoke. Branding checks preserve permanent node identity, bounds and logo pixels across record and transport states.

Media handling cancels stale seeking/gestures before moving the record. Groove traversal and arm cancellation are described in [direct manipulation](direct-manipulation.md); reference geometry and physical timings belong in [REFERENCE.md](../REFERENCE.md).
