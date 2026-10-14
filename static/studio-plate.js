/** Studio background plate: camera calibration and placement.
 *
 * Calibration was measured on a 2000-px-wide copy of the plate (2000 × 1126) and is
 * stored as fractions of plate width, so it holds for every derivative:
 * - The glass top's side edges, (75,835)→(340,595) and (1925,858)→(1645,598), meet
 *   at (999,−2): the depth vanishing point lies on the image centre line at the top
 *   edge. Front/back edges and the window transom are level, so yaw and roll are 0.
 * - Horizon check: back/front edge rows 595/845 = 0.704 equal back/front edge widths
 *   1305/1850 = 0.705, as they must for a ground plane with its horizon at y = 0.
 * - Focal length: window posts and table legs stay near-vertical (f ≳ 2300 px), and
 *   the speaker tops foreshorten to ~0.21 of their width (a ~9° view onto a box ~1.3×
 *   deeper than wide). f = 2400 px satisfies both: 45° horizontal FOV, pitch
 *   atan(563 / 2400) = 13.2°.
 * - Scale: the deck is 1.0 world unit wide. The left speaker's front (187 px wide, its
 *   base at y ≈ 692) makes a turntable about 2.2 speakers wide when the camera is
 *   1.73 units above the glass. Deck distance puts its front edge near y ≈ 800, just
 *   behind the table's front edge (y ≈ 845, distance 4.79).
 */
export const PLATE = Object.freeze({
  aspect: 6688 / 3764,
  principal: Object.freeze([.5, .5]),         // fractions of plate width / height
  horizon: -.002 / 1.126,                      // fraction of plate height (depth VP row)
  focal: 1.2,                                  // focal length in plate widths (2400 / 2000)
  cameraHeight: 1.73,                          // world units above the glass (deck width = 1)
  deckDistance: 5.4,                           // horizontal distance, camera to deck centre
  // Empty table spot between the speakers; the placement keeps it in the open band.
  anchor: Object.freeze([.5, .655]),
  // The deck plus margin, as plate fractions [left, top, right, bottom].
  deckRegion: Object.freeze([.37, .58, .63, .73]),
  // The deck's projected width as a fraction of the plate width, and the share of the
  // screen width it should fill in the default view: a close, speaker-framed composition.
  deckWidth: .225,
  wideDeckShare: .36,
  // Light read from the plate: warm late sun from the left and slightly behind.
  sun: Object.freeze({ direction: Object.freeze([.78, -.56, .28]), color: '#ffe2bd', intensity: 3.4 }),
});

/** Plate pitch below horizontal, in radians. */
export function platePitch() {
  return Math.atan((PLATE.principal[1] - PLATE.horizon) / PLATE.aspect / PLATE.focal);
}

/** Cover-style placement that keeps the table spot inside the open band.
 * Returns the displayed plate rectangle in stage pixels. The plate covers the stage
 * whenever it can; on tall phones it may stop short of the bottom, behind the panel. */
export function placePlate(width, height, band) {
  const aspect = PLATE.aspect, cover = Math.max(width / aspect, height);
  const regionScale = ([left, top, right, bottom], fill) =>
    Math.min(band.width * fill / ((right - left) * aspect), band.height * fill / (bottom - top));
  // Cover the stage, zooming in when a tall panel would otherwise hide the table spot
  // (the deck region must be able to clear the band's bottom while still covering), but
  // never so far that the deck and its margin outgrow the band. Narrow screens crop the
  // speakers rather than shrinking the deck further.
  const clearance = (height - (band.y + band.height)) / (1 - PLATE.deckRegion[3]);
  // Default framing pushes in until the deck fills its share of the screen width; the
  // monitors then frame the edges. Phones already cover at a larger scale.
  // Short, wide screens measure the share against a reference proportion, not raw width.
  const framed = PLATE.wideDeckShare * Math.min(width, height * 1.47) / PLATE.deckWidth / aspect;
  const plateHeight = Math.min(Math.max(cover, clearance, framed), regionScale(PLATE.deckRegion, .96));
  const plateWidth = plateHeight * aspect;
  const [ax, ay] = PLATE.anchor;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  // Priorities: the table spot sits in the band, then no gap at the top or sides, then
  // none at the bottom (a shortfall there lies behind the frosted panel).
  const wantX = band.x + band.width / 2 - ax * plateWidth, wantY = band.y + band.height * .52 - ay * plateHeight;
  const left = plateWidth >= width ? clamp(wantX, width - plateWidth, 0) : (width - plateWidth) / 2;
  const top = plateHeight >= height ? clamp(wantY, height - plateHeight, 0) : Math.min(0, wantY);
  return { x: left, y: top, width: plateWidth, height: plateHeight };
}
