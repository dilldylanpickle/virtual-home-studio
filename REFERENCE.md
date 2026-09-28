# Virtual Home Studio VHS-42069 Reference

## Hardware model

The VHS-42069 is a fictional direct-drive deck with a manual S-shaped tonearm, two speed buttons, pitch adjustment and Quartz lock. Its silver chassis, dark controls and original vinyl-disc branding form the public product identity.

Geometry below defines the simulator's established layout, not dimensions for a commercial product. Developer ownership and interaction rules are in [AGENTS.md](AGENTS.md).

## Hardware layout

The SVG uses deck-local coordinates with `viewBox="90 180 1024 828"`. Dimensions below are simulation design coordinates, not millimeters.

| Feature | Deck geometry |
| --- | --- |
| Chassis | x102, y210, approximately 999 × 781; aspect ratio 1.279 |
| Platter / mat | Center (498, 598); radii approximately 377 / 339–340 |
| Strobe rows | Four staggered rows at radii 369, 361, 353, 345 |
| Tonearm base | Center (945, 419), radius 130; inner trim centered at (952, 418) |
| Arm swing axis | (951, 415) |
| Parked needle | (856, 926) |
| Effective arm length / rest angle | 519.756 / 10.532° from those endpoints |
| Playable groove radii | Outer 327; inner 140 |
| POWER | Center (149, 837); visible face radius 29 |
| START/STOP | x125–221, y895–969 |
| 33 / 45 buttons | x234–287 / 287–340, y949–969 |
| Target light | Center (680, 959); cylindrical body |
| Tempo range | Center (1022, 628); 8% / 16% indicators above |
| Pitch fader | Outer x997–1047, y670–951; slot x1021, y690–933 |
| Quartz | Center (942, 912); printed leader above |
| Adapter / spare headshell storage | (180, 289), radius 46 / (805, 269), radius 15 |
| Chassis branding | Disc centered at (786, 959); brand at (803, 953); VHS-42069 at (803, 966) |

The deck includes the S-shaped arm, counterweight, asymmetric gimbal, cue platform, rest/clamp, cartridge, finger lift and headshell screws. Branding occupies the existing chassis print area without moving physical controls.

## Controls

These describe the simulator's physical control model; approximations are identified below.

| Control | Behavior |
| --- | --- |
| POWER | Continuous simulated 90° rotary arc, endpoint settle and midpoint switching hysteresis |
| START/STOP | Start or coast the motor independently of arm position |
| 33 / 45 | Two independently toggled speed selections; both select 78, neither selects no speed; 78 bracket is printed only |
| CUE | Raise/lower the stylus; manual arm movement preserves its setting |
| Tempo range | Toggle ±8% / ±16%, preserving the fader's relative position |
| Pitch / Quartz | Adjust speed; Quartz locks effective pitch to the selected nominal RPM |
| Target light | The cylinder toggles illumination; no extra physical switch is modeled |
| Anti-skate, counterweight, adapter | Display details; no tracking-force or anti-skate physics |

The speed latches are a simulation interaction convention, not a mechanically modeled latch. Power travel and motion timings are visual approximations.

## Tonearm and record handling

- The complete arm pivots around the bearing; the needle follows a circular arc, not a straight line.
- Groove progress maps needle distance from the spindle between the outer and inner radii.
- Raised CUE allows silent repositioning. A lowered, powered stylus reads the selected groove.
- Return Arm lifts, sweeps outward and parks. Ordinary run-out leaves the arm near the inner groove.
- Vinyl can be held or turned by hand while the motor-driven strobe rim continues underneath.
- Insertion/ejection move removable media vertically relative to the deck, independent of platter rotation.
- Opaque labels cover the spindle except through the physical center hole. Clear/Smoke bodies reveal the underlying mat; labels remain opaque.

## Playback and simulation assumptions

- Loaded audio is treated as mastered at 33⅓ RPM; 45/78 and pitch changes alter tempo and pitch together.
- Assisted Play is a software convenience: it can power on, start the platter, cue and lower the arm. The manual hardware controls remain independently operable.
- Soft Pause holds a logical groove while a brief audible tail slows; resume returns to that groove.
- A short run-in precedes source audio. At run-out, the platter and surface sound may continue until cue lift or motor stop.
- Radial scrubbing scans bounded audio fragments; it is an approximation of moving a stylus across grooves.
- Condition, cartridge character, wow/flutter and centering are digital approximations, not measured reproductions of a particular cartridge or pressing.

| Simulated transition | Timing |
| --- | --- |
| Motor start / coast | 280 / 360 ms |
| RPM change / pitch or Quartz correction | 450 / 35 ms |
| Soft pause / resume | 160 ms |
| Click-to-seek | 120–450 ms, by distance |
| Return Arm | Up to 150 ms lift, 400–650 ms sweep, 50 ms settle |
| Physical scratch release | 120 ms catch-up |
| Record insertion / lift | 780 / 620 ms |
| Run-in at nominal speed | 1.4 s |

Reduced-motion settings shorten visual transitions. SVG materials and partly hidden mechanisms remain approximations; the desktop layout provides the largest physical control targets.
