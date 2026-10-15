# Virtual Home Studio VHS-42069 Reference

## Hardware model

The VHS-42069 is a fictional direct-drive deck with a manual S-shaped tonearm, two speed buttons, pitch adjustment and Quartz lock. Its chassis defaults to Silver, with Black, White, Red, Blue, Green, Purple and Rose finishes available in Customize. Dark controls and original vinyl-disc branding retain the public product identity. The selected finish persists through media changes within the page session; reloading restores Silver.

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

Reduced-motion settings shorten visual transitions. Rendered materials and partly hidden mechanisms remain approximations; the desktop layout provides the largest physical control targets.

## Studio composition and renderer

The wide Studio view is a 2.5D composite. The owner-approved photographic plate supplies the room: the window, Manhattan skyline, two white monitors and the cyan-edged glass table on a wood floor. WebGL draws only the native VHS-42069 on a transparent canvas over it, standing on the empty table spot between the monitors, with a sun shadow catcher, a soft contact shadow and a faint reflection in the glass.

`studio-plate.js` holds the plate calibration (`PLATE`) and `placePlate()`, the single placement shared by the `<img>` and the camera. `studio-view.js` measures the open band between the hero and the listening panel, places the plate, maps the original transparent SVG controls through the camera, and fades the plate during travel. `studio-renderer.js` owns the camera, lighting, catchers and quality budgets; `studio-turntable-3d.js` builds the visible hardware and applies the existing model's state. The original SVG stays mounted for input and accessibility, and becomes visible if WebGL initialization fails.

### Plate camera calibration

Measured on a 2000 × 1126 copy of the plate:

| Cue | Measurement | Result |
| --- | --- | --- |
| Glass top side edges | (75,835)→(340,595) and (1925,858)→(1645,598) meet at (999, −2) | Depth vanishing point on the centre line at the top edge: zero yaw, horizon row ≈ 0 |
| Front/back edges, transom | Level | Zero roll |
| Ground-plane check | Edge rows 595/845 = 0.704; edge widths 1305/1850 = 0.705 | Confirms the horizon row |
| Window posts, table legs | Near-vertical | f ≳ 2300 px |
| Speaker tops | Foreshortened to ~0.21 of their width | ~9° view onto them, consistent with f = 2400 px |
| Speaker front | 187 px wide, base at y ≈ 692 | Deck (1.0 world unit) ≈ 2.2 speakers wide with the camera 1.73 units above the glass |

So `PLATE.focal` = 1.2 plate widths (45° horizontal field of view), pitch = atan(563 / 2400) = 13.2°, camera height 1.73 and deck distance 5.4 world units (deck front just behind the table's front edge). The projection is built directly from those intrinsics and the plate's on-screen rectangle, so the camera follows the plate under any crop. `placePlate()` frames the default view close: it pushes in until the deck spans `PLATE.wideDeckShare` (36%) of the screen width, measured against at most 1.47 × the screen height so ultrawide screens do not over-zoom, with the monitors framing the edges. It also zooms when a tall panel would hide the table spot, and never so far that the deck outgrows the open band. On narrow screens the monitors crop at the sides, and on tall phones any shortfall lies behind the panel.

### Light, grounding and travel

A warm late sun from the left casts the deck's soft (VSM) shadow onto a `ShadowMaterial` catcher on the glass; a blurred footprint adds contact darkening. A planar reflection fades with height above the glass, like the monitors' reflections in the plate. The plate itself is the environment map, so chrome and vinyl reflect its sky and floor. A display-space grade matches the plate's warmth and contrast.

The camera begins with a dolly from the plate pose and then pitches into overhead inspection; the endpoint is orthographic and lens-shifted into the area above the panel, so the canonical control mapping remains affine. As the camera leaves the plate's perspective, the plate pushes in about the table spot, blurs and dims, and the reflection fades out. Ordinary travel lasts 1.65 seconds; interruptions retarget from the current position, and reduced motion settles directly. Playback and physical simulation continue on their existing clocks.

The world uses metres with Y up, +Z toward the listener and the glass desktop at Y = 0. `app.js` updates the visual subscriber after its normal model/worklet synchronization. During insertion/ejection, the renderer reads the current record-lift animation only to match its visible transform and opacity. Record, opaque label, center hole and permanent spindle remain separate geometry.

### Print sharpness

All printed text is canvas-rendered at ≥4× its former texel density, mipmapped and sampled with the GPU's maximum anisotropy: three tight deck-top sheets at 8 px per SVG unit, two front-fascia sheets, control labels sized to their planes, a 3072-px record label and a 4096-px slipmat print. Devices whose short screen side is under 1400 device pixels use half density, still several texels per device pixel. Deck print and control labels reproduce the SVG's positions, font sizes and baselines; decals sample with a −0.5 mip bias so small lettering is not softened by box-filtered mips. Rendering uses 4× multisampling instead of FXAA.

### Quality budgets

Cinematic is the default; dynamic resolution still protects frame rate on slower GPUs. Profiles change rendering cost without changing audio or simulation.

| Profile | Maximum pixel ratio | Shadow | Reflection | Multisampling |
| --- | --- | --- | --- | --- |
| Performance | 1.5 | 1024 | 256 | 2× |
| Balanced | 2.0 | 2048 | 512 | 4× |
| Cinematic | 2.0 | 4096 | 1024 | 8× |

`QUALITY` in `studio-renderer.js` is authoritative. Unchanged shadows are cached, and settled/hidden views avoid unnecessary rendering. Dynamic resolution samples the app frame interval after each render: when most of a 90-frame window runs 30% over budget it lowers the pixel ratio by 15%, but never below one device pixel per CSS pixel (so on 1× displays it never acts); sustained headroom restores it. The profile selector lives in **Turntable details**. These budgets are limits on rendering work, not measured frame-rate guarantees.

### Local assets

Three.js 0.180.0 and the required addons are bundled in `static/vendor/` under the MIT license. [Dependency provenance](static/vendor/README.txt) records the package source and checksum; [the upstream license](static/vendor/THREE-LICENSE.txt) must accompany redistribution. Runtime imports remain local and work with static hosting.

The wide Studio background is the owner-approved studio plate. Its 6688 × 3764 master lives in `docs/source/studio-plate-master.png` and is never published; `tools/make-plates.py` derives `static/assets/studio-plate-xl.webp` (5600 px, large and high-DPI screens at the close default framing), `static/assets/studio-plate.webp` (3200 px) and `static/assets/studio-plate-mobile.webp` (1600 px). The `<img>` `sizes` hint approximates the plate's rendered width before scripts run, and `StudioView` replaces it with the exact width, so the browser picks the smallest derivative that stays sharp. The plate supplies the room, monitors, window, table and skyline; there is no separate skyline image or procedural room. It must not contain third-party logos or commercial model names. Third-party product photography is not a runtime asset.
