import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/addons/geometries/RoundedBoxGeometry.js';
import { FINISHES, VINYL, LABELS, contrastColor } from './record-customization.js';
import { CONDITIONS } from './condition-profiles.js';
import { RECORD_FILE } from './record-lifecycle.js';

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const TOP = .075, MAT_TOP = .103, RECORD_Y = .1045;
const CENTER = Object.freeze({ x: -.104, z: .004 });
const PIVOT = Object.freeze({ x: .349, z: -.179 });
const REST = Math.atan2(95, 511) / DEG;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const svg = (x, y, z) => [(x - 602) / 1000, y, (z - 594) / 1000];

/** Circular groove direction for anisotropic highlights, plus track bands in roughness. */
function grooveSheen(anisotropy) {
  const size = 512, direction = document.createElement('canvas'), bands = document.createElement('canvas');
  direction.width = direction.height = bands.width = bands.height = size;
  const dirCtx = direction.getContext('2d'), bandCtx = bands.getContext('2d');
  const dirData = dirCtx.createImageData(size, size), bandData = bandCtx.createImageData(size, size);
  // Lead-in, five tracks separated by smoother gaps, then the run-out.
  const gaps = [.94, .8, .66, .55, .45];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size * 2 - 1, v = 1 - (y + .5) / size * 2, r = Math.hypot(u, v), i = (y * size + x) * 4;
    const tangentX = r ? -v / r : 1, tangentY = r ? u / r : 0;
    const groove = r > .335 && r < .985, gap = gaps.some(g => Math.abs(r - g) < .006);
    dirData.data[i] = Math.round((tangentX * .5 + .5) * 255); dirData.data[i + 1] = Math.round((tangentY * .5 + .5) * 255);
    dirData.data[i + 2] = groove && !gap ? 255 : 60; dirData.data[i + 3] = 255;
    const rough = !groove ? 120 : gap ? 70 : 150 + Math.round(Math.sin(r * 900) * 10);
    bandData.data[i] = bandData.data[i + 1] = bandData.data[i + 2] = rough; bandData.data[i + 3] = 255;
  }
  dirCtx.putImageData(dirData, 0, 0); bandCtx.putImageData(bandData, 0, 0);
  const map = canvas => { const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.NoColorSpace; texture.anisotropy = anisotropy; return texture; };
  return { anisotropy: map(direction), roughness: map(bands) };
}

/** Physical presentation only: no playback clock, control handlers or stored
 * simulator state. Removable-media presentation is supplied by the lifecycle. */
/** Duration of a full dust-cover swing; record handling waits for the lid to clear. */
export const COVER_SWING_MS = 1100;

export function createStudioTurntable({ anisotropy = 4, printScale = 1 } = {}) {
  const group = new THREE.Group(); group.name = 'vhs-turntable';
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const parts = {}, cache = {};
  const material = (options, physical = false) => {
    const result = physical ? new THREE.MeshPhysicalMaterial(options) : new THREE.MeshStandardMaterial(options);
    materials.add(result); return result;
  };
  const mesh = (geometry, paint, parent = group, name = '') => {
    geometries.add(geometry); const result = new THREE.Mesh(geometry, paint);
    result.name = name; result.castShadow = true; result.receiveShadow = true; parent.add(result); return result;
  };
  const box = (w, h, d, paint, xyz, parent = group, radius = .002, name = '', segments = 2) => {
    const result = mesh(new RoundedBoxGeometry(w, h, d, segments, Math.min(radius, w / 3, h / 3, d / 3)), paint, parent, name);
    result.position.set(...xyz); return result;
  };
  const cylinder = (r, h, paint, xyz, parent = group, segments = 64, name = '') => {
    const result = mesh(new THREE.CylinderGeometry(r, r, h, segments), paint, parent, name);
    result.position.set(...xyz); return result;
  };
  const torus = (r, thickness, paint, xyz, parent = group, segments = 96) => {
    const result = mesh(new THREE.TorusGeometry(r, thickness, 8, segments), paint, parent);
    result.rotation.x = Math.PI / 2; result.position.set(...xyz); return result;
  };
  const tube = (points, radius, paint, parent = group, segments = 48) => {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)), false, 'centripetal');
    return mesh(new THREE.TubeGeometry(curve, segments, radius, 10, false), paint, parent);
  };
  const canvasMap = (w, h, draw = () => {}) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const context = canvas.getContext('2d'); draw(context, w, h);
    // Print stays crisp at grazing angles: full mip chain and the GPU's maximum anisotropy.
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = anisotropy;
    texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
    textures.add(texture); return { texture, context };
  };
  // The same original disc mark used by the SVG/header, drawn into print only.
  const discMark = (ctx, x, y, radius) => {
    ctx.save(); ctx.lineWidth = radius * .12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, radius * .31, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, radius * .07, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, radius * .7, Math.PI, Math.PI * 1.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, radius * .7, 0, Math.PI / 2); ctx.stroke();
    ctx.restore();
  };
  // Print samples half a mip level sharper: box-filtered mips otherwise soften small
  // lettering more than the browser's own SVG text rasterization.
  const decalMaterial = texture => {
    const result = material({ map: texture, transparent: true, alphaTest: .035, depthWrite: false, roughness: 1, envMapIntensity: .25, polygonOffset: true, polygonOffsetFactor: -1 });
    result.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv, -.5 )')); };
    result.customProgramCacheKey = () => 'sharp-print'; return result;
  };
  const plane = (w, d, paint, xyz, parent = group, horizontal = true) => {
    const result = mesh(new THREE.PlaneGeometry(w, d), paint, parent); result.position.set(...xyz);
    if (horizontal) result.rotation.x = -Math.PI / 2; result.castShadow = false; return result;
  };
  // Control labels: 4× the former 512-px tiles, sized to the plane so glyphs keep their
  // proportions; `size` keeps its former meaning (text height in 160ths of the plane).
  const textTile = (text, w, d, parent, xyz, size = 38, weight = 600) => {
    const cw = Math.round(2048 * printScale), ch = Math.max(16, Math.round(cw * d / w));
    const { texture } = canvasMap(cw, ch, ctx => {
      ctx.fillStyle = '#f0f4ef'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `${weight} ${size / 160 * ch}px Arial,Helvetica,sans-serif`; ctx.fillText(text, cw / 2, ch / 2);
    });
    return plane(w, d, decalMaterial(texture), xyz, parent);
  };
  const ring = (inner, outer, paint, y, parent) => {
    const result = mesh(new THREE.RingGeometry(inner, outer, 160), paint, parent);
    result.rotation.x = -Math.PI / 2; result.position.y = y; return result;
  };

  const chassisPaint = material({ color: FINISHES.Silver.surface[1], roughness: .3, metalness: .32, clearcoat: .45, clearcoatRoughness: .22 }, true);
  const edgePaint = material({ color: FINISHES.Silver.edge[1], roughness: .36, metalness: .3, clearcoat: .3, clearcoatRoughness: .28 }, true);
  const black = material({ color: '#11191d', roughness: .5, metalness: .12 });
  const rubber = material({ color: '#080d10', roughness: .86, metalness: .01 });
  const satin = material({ color: '#4f5d63', roughness: .36, metalness: .86 });
  const chrome = material({ color: '#e1e8ec', roughness: .14, metalness: 1 });
  const darkChrome = material({ color: '#48545a', roughness: .25, metalness: .94 });
  const rimMetal = material({ color: '#bcc7cb', roughness: .3, metalness: .95 });
  // A generously radiused body reads as a bevelled cast plinth under side light.
  parts.chassis = box(.999, .055, .783, edgePaint, [-.0005, .0455, .0075], group, .016, 'painted-chassis', 5);
  parts.top = box(.991, .004, .775, chassisPaint, [-.0005, .073, .0075], group, .009, 'painted-top', 4);
  box(.984, .012, .769, black, [-.0005, .018, .0075], group, .006, 'lower-pan');
  parts.feet = [];
  for (const x of [-.425, .424]) for (const z of [-.313, .326]) {
    parts.feet.push(cylinder(.044, .013, rubber, [x, .0065, z], group, 40, 'isolation-foot'));
    cylinder(.0445, .004, darkChrome, [x, .014, z], group, 40);
    torus(.040, .0013, satin, [x, .018, z], group, 48);
  }
  for (const x of [-.314, .314]) { box(.080, .015, .034, black, [x, TOP + .004, -.379]); box(.030, .024, .025, satin, [x, TOP + .011, -.390]); }
  parts.adapter = cylinder(.045, .007, rubber, svg(180, TOP + .004, 289));
  torus(.038, .0015, darkChrome, svg(180, TOP + .008, 289));
  torus(.012, .003, darkChrome, svg(180, TOP + .010, 289), group, 48);
  cylinder(.006, .0008, black, svg(180, TOP + .011, 289), group, 24);
  cylinder(.014, .003, satin, svg(805, TOP + .002, 269), group, 36);
  cylinder(.010, .004, rubber, svg(805, TOP + .003, 269), group, 32);

  // Transparent decals contain printed lettering only, never controls or a photograph
  // of the deck. Mechanical parts are individually lit/shadowed meshes. Print is split
  // into tight sheets so it reaches 4× the former texel density without huge atlases.
  // Lit print lifts toward grey under studio light, unlike the flat SVG: dark inks on
  // light finishes are deepened so the 3D lettering keeps the original's contrast.
  const printInk = finish => {
    const ink = new THREE.Color(finish.ink), hsl = ink.getHSL({});
    return hsl.l < .5 ? `#${ink.lerp(new THREE.Color('#000000'), .55).getHexString()}` : finish.ink;
  };
  const drawDeckPrint = (ctx, finish) => {
    const ink = printInk(finish);
    ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineWidth = 1.15; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    // SVG positions, sizes and baselines, one weight heavier: lit print reads lighter than flat SVG.
    const word = (text, x, z, size = 8, weight = 600, spacing = 0) => { ctx.font = `${weight} ${size}px Arial,Helvetica,sans-serif`; ctx.letterSpacing = `${spacing}px`; ctx.fillText(text, x, z); };
    word('TEMPO RANGE', 1022, 659, 7); word('16%', 1022, 582, 7); word('8%', 1022, 603, 7);
    word('QUARTZ', 942, 940, 7); word('78', 288, 939, 9);
    ctx.textBaseline = 'middle'; word('CUE', 1013, 476, 6.5); ctx.textBaseline = 'alphabetic';
    ctx.beginPath(); ctx.moveTo(989, 478); ctx.lineTo(994, 478); ctx.lineTo(991.5, 474); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(989, 485); ctx.lineTo(994, 485); ctx.lineTo(991.5, 489); ctx.closePath(); ctx.fill();
    ctx.textAlign = 'left'; word('78', 206, 862, 6.5); word('33', 206, 878, 6.5); word('45', 206, 886, 6.5);
    for (const [z, r] of [[860, 1.6], [868, 2.7], [876, 1.9], [884, 2.6]]) { ctx.beginPath(); ctx.arc(201, z, r, 0, TAU); ctx.fill(); }
    for (let i = 0; i <= 22; i++) { const z = 700 + i * 224 / 22; ctx.beginPath(); ctx.moveTo(i % 2 ? 987 : 981, z); ctx.lineTo(995, z); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(263, 946); ctx.lineTo(263, 936); ctx.lineTo(279, 936); ctx.moveTo(296, 936); ctx.lineTo(316, 936); ctx.lineTo(316, 946); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(942, 834); ctx.lineTo(942, 891); ctx.stroke();
    for (const z of [700, 924]) { ctx.beginPath(); ctx.arc(975, z, 4.4, 0, TAU); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(972.5, 700); ctx.lineTo(977.5, 700); ctx.moveTo(972.5, 924); ctx.lineTo(977.5, 924); ctx.moveTo(975, 921.5); ctx.lineTo(975, 926.5); ctx.stroke();
    word('VIRTUAL HOME STUDIO', 803, 953, 9.5, 700, .7); word('VHS-42069', 803, 966, 7.2, 600, 1.3);
    discMark(ctx, 786, 959, 10);
  };
  // Former fascia canvas: 4096 × 160 over 0.94 × 0.0367 m. Coordinates below keep it.
  const drawFascia = (ctx, finish) => {
    const ink = printInk(finish);
    ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = '600 56px Arial,sans-serif'; ctx.fillText('VHS-42069', 150, 80);
    ctx.font = '500 21px Arial,sans-serif'; ctx.fillText('V I R T U A L   H O M E   S T U D I O', 152, 114);
    discMark(ctx, 3330, 74, 24);
    ctx.font = '600 26px Arial,sans-serif'; ctx.fillText('V I R T U A L   H O M E   S T U D I O', 3374, 84);
  };
  const sheets = [];
  // Top print at 8 px per SVG unit (formerly 2), in deck-local SVG coordinates.
  parts.lettering = new THREE.Group(); group.add(parts.lettering);
  for (const [x0, z0, x1, z1] of [[922, 462, 1062, 945], [190, 852, 328, 952], [772, 945, 962, 975]]) {
    const density = 8 * printScale, { texture, context } = canvasMap(Math.ceil((x1 - x0) * density), Math.ceil((z1 - z0) * density));
    plane((x1 - x0) / 1000, (z1 - z0) / 1000, decalMaterial(texture), svg((x0 + x1) / 2, TOP + .00018, (z0 + z1) / 2), parts.lettering).name = `print-sheet-${sheets.length}`;
    sheets.push({ texture, context, draw: (ctx, finish) => { ctx.setTransform(density, 0, 0, density, -x0 * density, -z0 * density); drawDeckPrint(ctx, finish); } });
  }
  // Fascia at 4 px per former canvas unit (4× density): model at left, mark and name at right.
  parts.frontPrint = new THREE.Group(); group.add(parts.frontPrint);
  const fasciaUnit = .94 / 4096;
  for (const [u0, u1] of [[100, 680], [3280, 3990]]) {
    const density = 4 * printScale, { texture, context } = canvasMap(Math.ceil((u1 - u0) * density), Math.ceil(160 * density));
    plane((u1 - u0) * fasciaUnit, .0367, decalMaterial(texture), [-.4705 + (u0 + u1) / 2 * fasciaUnit, .045, .3996], parts.frontPrint, false).name = `fascia-sheet-${sheets.length - 3}`;
    sheets.push({ texture, context, draw: (ctx, finish) => { ctx.setTransform(density, 0, 0, density, -u0 * density, 0); drawFascia(ctx, finish); } });
  }
  const drawPrinting = finish => {
    for (const sheet of sheets) {
      const ctx = sheet.context; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.save(); sheet.draw(ctx, finish); ctx.restore(); sheet.texture.needsUpdate = true;
    }
  };

  const platter = new THREE.Group(); platter.name = 'platter'; platter.position.set(CENTER.x, 0, CENTER.z); group.add(platter); parts.platter = platter;
  cylinder(.377, .024, darkChrome, [0, .088, 0], platter, 160, 'metal-platter-wall');
  torus(.376, .0016, chrome, [0, .080, 0], platter, 160); torus(.377, .0012, chrome, [0, .098, 0], platter, 160);
  cylinder(.374, .0014, black, [0, .0996, 0], platter, 160, 'strobe-band');
  const dotGeometry = new THREE.SphereGeometry(1, 6, 4); geometries.add(dotGeometry);
  const rows = [[.369, 228, .0017], [.361, 220, .0025], [.353, 212, .0017], [.345, 204, .00245]];
  const dots = new THREE.InstancedMesh(dotGeometry, rimMetal, 864); dots.name = 'instanced-strobe-dots'; dots.receiveShadow = true;
  const dummy = new THREE.Object3D(); let dotIndex = 0;
  rows.forEach(([radius, count, size], row) => { for (let i = 0; i < count; i++) {
    const a = (i + row * .31) / count * TAU; dummy.position.set(Math.cos(a) * radius, .10065, Math.sin(a) * radius);
    dummy.scale.set(size, .00045, size); dummy.updateMatrix(); dots.setMatrixAt(dotIndex++, dummy.matrix);
  } });
  dots.instanceMatrix.needsUpdate = true; platter.add(dots); parts.strobeDots = dots;
  const felt = canvasMap(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
    let seed = 42069;
    for (let i = 0; i < 8500; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const x = seed & 255, z = seed >>> 8 & 255;
      ctx.fillStyle = i % 2 ? '#787878' : '#8a8a8a'; ctx.fillRect(x, z, 1, i % 3 ? 1 : 2);
    }
  });
  felt.texture.colorSpace = THREE.NoColorSpace;
  const feltPaint = material({ color: '#0b1013', roughness: .93, metalness: 0, bumpMap: felt.texture, bumpScale: .00012 });
  cylinder(.339, .0028, feltPaint, [0, MAT_TOP - .0014, 0], platter, 160, 'rubber-slipmat');
  torus(.340, .00115, rimMetal, [0, .1013, 0], platter, 160);
  const matPrint = canvasMap(Math.round(4096 * printScale), Math.round(600 * printScale), ctx => {
    ctx.scale(4 * printScale, 4 * printScale); ctx.fillStyle = '#b7c0bd'; ctx.strokeStyle = '#b7c0bd'; discMark(ctx, 66, 75, 64);
    ctx.font = '500 49px Arial,sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText('VIRTUAL HOME STUDIO', 184, 76);
  });
  parts.slipmatPrint = plane(.340, .050, decalMaterial(matPrint.texture), [-.130, MAT_TOP + .0002, -.004], platter);

  // Real annular media and opaque annular label; the spindle is independent.
  const record = new THREE.Group(); record.name = 'removable-record'; record.position.set(CENTER.x, RECORD_Y, CENTER.z); group.add(record); parts.record = record;
  const groove = canvasMap(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#919191'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 210; i++) { ctx.strokeStyle = i % 4 ? '#8a8a8a' : '#a0a0a0'; ctx.lineWidth = .75; ctx.beginPath(); ctx.arc(w / 2, h / 2, 170 + i * 1.53, 0, TAU); ctx.stroke(); }
  });
  groove.texture.colorSpace = THREE.NoColorSpace;
  const sheen = grooveSheen(anisotropy); textures.add(sheen.anisotropy); textures.add(sheen.roughness);
  const vinylSide = material({ color: '#101316', roughness: .2, metalness: .025, clearcoat: .55, clearcoatRoughness: .18 }, true);
  const vinylTop = material({ color: '#141719', roughness: .3, roughnessMap: sheen.roughness, metalness: .02, clearcoat: .55, clearcoatRoughness: .2,
    anisotropy: .85, anisotropyMap: sheen.anisotropy, bumpMap: groove.texture, bumpScale: .00018 }, true);
  const profile = [[.006, -.0015], [.3338, -.0015], [.335, -.00065], [.335, .00065], [.3338, .0015], [.006, .0015], [.006, -.0015]].map(p => new THREE.Vector2(...p));
  parts.vinylBody = mesh(new THREE.LatheGeometry(profile, 160), vinylSide, record, 'vinyl-thickness-and-hole');
  parts.vinylSurface = ring(.006, .334, vinylTop, .00152, record);
  const labelPrint = canvasMap(Math.round(3072 * printScale), Math.round(3072 * printScale)), paper = material({ color: '#ffffff', roughness: .91, metalness: 0, map: labelPrint.texture });
  parts.label = ring(.006, .110, paper, .0017, record);
  const drawLabel = state => {
    const ctx = labelPrint.context, color = LABELS[state.labelColor] || LABELS.Blue, ink = contrastColor(color);
    const labelSize = ctx.canvas.width; ctx.setTransform(labelSize / 768, 0, 0, labelSize / 768, 0, 0);
    ctx.fillStyle = color; ctx.fillRect(0, 0, 768, 768); ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = .28; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(384, 384, 356, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(384, 384, 112, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.font = '600 31px Arial,sans-serif'; ctx.fillText('V I R T U A L  H O M E  S T U D I O', 384, 167, 610);
    ctx.globalAlpha = .38; ctx.beginPath(); ctx.moveTo(116, 227); ctx.lineTo(652, 227); ctx.stroke(); ctx.globalAlpha = 1;
    const name = (state.pendingFilename || state.filename || 'Your own pressing').replace(RECORD_FILE, '').replace(/_/g, ' ');
    ctx.font = '600 66px Georgia,serif'; ctx.fillText(name.length > 20 ? `${name.slice(0, 19)}…` : name, 384, 300, 625);
    ctx.font = '600 31px Arial,sans-serif'; ctx.fillText('S I D E  A', 384, 525); ctx.font = '500 28px Arial,sans-serif'; ctx.fillText('33⅓ RPM · STEREO', 384, 612);
    ctx.font = '24px Arial,sans-serif'; ctx.fillText('PRESSED LOCALLY. PLAYED HERE.', 384, 665); labelPrint.texture.needsUpdate = true;
  };
  const wearVertices = [];
  for (let i = 0; i < 28; i++) { const a = i * 2.39996, r = .158 + (i * 53 % 160) / 1000, length = .004 + (i % 9) * .001, x = Math.cos(a) * r, z = Math.sin(a) * r;
    wearVertices.push(x, .0018, z, x + Math.cos(a + .6) * length, .0018, z + Math.sin(a + .6) * length); }
  const wearGeometry = new THREE.BufferGeometry(); wearGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wearVertices, 3)); geometries.add(wearGeometry);
  const wearPaint = new THREE.LineBasicMaterial({ color: '#c6d3ca', transparent: true, opacity: .1, depthWrite: false }); materials.add(wearPaint);
  const wear = new THREE.LineSegments(wearGeometry, wearPaint); wear.name = 'condition-hairlines'; record.add(wear); parts.wear = wear;
  parts.spindle = cylinder(.0052, .024, chrome, [CENTER.x, .112, CENTER.z], group, 32, 'permanent-spindle');
  const spindleTip = parts.spindleTip = mesh(new THREE.SphereGeometry(.0052, 20, 10, 0, TAU, 0, Math.PI / 2), chrome); spindleTip.position.set(CENTER.x, .124, CENTER.z);

  cylinder(.130, .021, black, svg(945, TOP + .0105, 419), group, 80, 'tonearm-base');
  cylinder(.115, .010, satin, svg(945, TOP + .024, 419), group, 80); cylinder(.104, .005, black, svg(952, TOP + .031, 418), group, 80);
  torus(.102, .0014, darkChrome, svg(952, TOP + .034, 418));
  cylinder(.032, .032, chrome, [PIVOT.x, .118, PIVOT.z], group, 48, 'tonearm-bearing'); cylinder(.022, .037, black, [PIVOT.x, .123, PIVOT.z], group, 48);
  const outerGimbal = torus(.044, .006, black, [PIVOT.x, .147, PIVOT.z], group, 64); outerGimbal.rotation.x = 0;
  const innerGimbal = torus(.032, .0038, satin, [PIVOT.x, .147, PIVOT.z], group, 64); innerGimbal.rotation.set(0, Math.PI / 2, 0);
  for (const x of [-.044, .044]) { const pin = cylinder(.007, .008, chrome, [PIVOT.x + x, .147, PIVOT.z], group, 24); pin.rotation.z = Math.PI / 2; }
  cylinder(.023, .016, black, svg(1045, .118, 425), group, 48, 'anti-skate-knob'); torus(.022, .0012, satin, svg(1045, .126, 425), group, 48);
  const arm = new THREE.Group(); arm.name = 'tonearm'; arm.position.set(PIVOT.x, 0, PIVOT.z); group.add(arm); parts.tonearm = arm;
  const ap = (x, y, z) => [(x - 951) / 1000, y, (z - 415) / 1000];
  tube([ap(958, .145, 365), ap(958, .145, 438), ap(951, .145, 490), ap(959, .143, 548), ap(975, .141, 620), ap(981, .139, 681), ap(968, .136, 749), ap(933, .133, 804), ap(917, .132, 832)], .0092, chrome, arm, 96).name = 's-shaped-metal-arm';
  tube([ap(956, .151, 373), ap(961, .151, 326), ap(965, .151, 280)], .008, satin, arm, 16);
  const counterweight = cylinder(.034, .062, chrome, ap(965, .151, 297), arm, 64, 'counterweight'); counterweight.rotation.x = Math.PI / 2;
  for (const z of [270, 276, 282, 312, 318, 324]) { const band = torus(.0342, .001, darkChrome, ap(965, .151, z), arm, 64); band.rotation.x = 0; }
  const weightEnd = cylinder(.030, .004, black, ap(965, .151, 265), arm, 48); weightEnd.rotation.x = Math.PI / 2;
  const headshellShape = new THREE.Shape();
  [[918, 830], [933, 840], [902, 887], [895, 911], [884, 926], [876, 935], [863, 935], [846, 924], [845, 912], [858, 891], [870, 885], [885, 871]].forEach(([x, z], i) => {
    if (i) headshellShape.lineTo((x - 951) / 1000, -(z - 415) / 1000); else headshellShape.moveTo((x - 951) / 1000, -(z - 415) / 1000); });
  headshellShape.closePath();
  const headshell = mesh(new THREE.ExtrudeGeometry(headshellShape, { depth: .006, bevelEnabled: true, bevelThickness: .0007, bevelSize: .0007, bevelSegments: 1, steps: 1 }), black, arm, 'headshell');
  headshell.rotation.x = -Math.PI / 2; headshell.position.y = .124;
  for (const [x, z] of [[858, 907], [881, 921]]) { const screw = cylinder(.0037, .002, chrome, ap(x, .132, z), arm, 20); box(.005, .0005, .0008, black, [screw.position.x, .1331, screw.position.z], arm, .0001); }
  const collar = cylinder(.014, .031, darkChrome, ap(924, .132, 820), arm, 40); collar.rotation.x = Math.PI / 2; collar.rotation.z = -.52;
  const cartridge = box(.022, .017, .031, black, ap(860, .1155, 920), arm, .0015, 'cartridge'); cartridge.rotation.y = -.54; parts.cartridge = cartridge;
  const stylus = box(.018, .005, .013, material({ color: '#537f70', roughness: .5, metalness: .05 }), ap(854, .1065, 925), arm, .001, 'stylus-housing'); stylus.rotation.y = -.54;
  tube([ap(855, .1065, 924), ap(856, .1045, 926)], .0009, chrome, arm, 4);
  tube([ap(904, .133, 885), ap(922, .137, 897), ap(943, .137, 911)], .0021, chrome, arm, 14);
  cylinder(.008, .044, black, svg(940, .099, 535), group, 32, 'arm-rest-post'); box(.028, .006, .012, satin, svg(941, .123, 531));
  const cue = new THREE.Group(); cue.position.set(...svg(980, .104, 470)); group.add(cue); parts.cue = cue;
  tube([[0, 0, 0], [0, .018, -.017], [.043, .018, -.024]], .003, darkChrome, cue, 12);
  const cueGrip = box(.033, .007, .012, black, [.034, .019, -.025], cue); cueGrip.rotation.y = -.23;
  textTile('CUE', .028, .008, group, svg(1010, .109, 477), 62);

  cylinder(.035, .005, darkChrome, svg(149, TOP + .0025, 837));
  const power = new THREE.Group(); power.position.set(...svg(149, TOP + .005, 837)); group.add(power); parts.power = power;
  cylinder(.029, .025, black, [0, .0125, 0], power); cylinder(.027, .002, satin, [0, .026, 0], power);
  const knurlGeometry = new THREE.CylinderGeometry(.0008, .0008, .019, 4); geometries.add(knurlGeometry);
  const knurl = new THREE.InstancedMesh(knurlGeometry, darkChrome, 56);
  for (let i = 0; i < 56; i++) { const a = i / 56 * TAU; dummy.position.set(Math.cos(a) * .029, .012, Math.sin(a) * .029); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); knurl.setMatrixAt(i, dummy.matrix); } power.add(knurl);
  box(.002, .0008, .009, rimMetal, [0, .0275, -.019], power, .0002); textTile('POWER', .034, .013, power, [-.004, .0276, .016], 84);
  textTile('off', .014, .009, power, [-.009, .0276, -.017], 121);
  textTile('on', .012, .009, power, [.017, .0276, .005], 121);
  box(.097, .006, .074, darkChrome, svg(173, TOP + .002, 932));
  const start = box(.087, .007, .064, black, svg(173, TOP + .007, 932), group, .002, 'start-stop-button'); parts.start = start;
  textTile('START/STOP', .075, .023, start, [0, .0037, 0], 56);
  const speeds = [];
  for (const [text, x] of [['33', 260.5], ['45', 313.5]]) {
    box(.054, .003, .023, darkChrome, svg(x, TOP + .001, 959), group, .0008);
    const button = new THREE.Group(); button.position.set(...svg(x, TOP + .0045, 959)); group.add(button);
    box(.049, .006, .019, black, [0, 0, 0], button, .0008); textTile(text, .021, .013, button, [-.011, .0032, 0], 105);
    const paint = material({ color: '#491d25', roughness: .3, metalness: .05, emissive: '#c9233f', emissiveIntensity: 0 });
    const led = box(.009, .001, .0024, paint, [.015, .0035, 0], button, .0002); speeds.push({ button, led, material: paint });
  }
  parts.speed33 = speeds[0].button; parts.speed45 = speeds[1].button;
  const cap = (x, z) => { cylinder(.019, .003, satin, svg(x, TOP + .0015, z), group, 48); return cylinder(.016, .007, black, svg(x, TOP + .0055, z), group, 48); };
  parts.range = cap(1022, 628); parts.quartz = cap(942, 912);
  const led = (x, z, w = .012) => {
    const paint = material({ color: '#62323a', roughness: .32, metalness: .02, emissive: '#ff2449', emissiveIntensity: 0 });
    return { node: box(w, .0008, .0036, paint, svg(x, TOP + .0008, z), group, .0003), material: paint };
  };
  const range8 = led(1022, 591), range16 = led(1022, 570), zero = led(971, 812, .011);
  const railPaint = material({ color: FINISHES.Silver.rail[0], roughness: .54, metalness: .27 });
  box(.050, .003, .281, railPaint, svg(1022, TOP + .001, 810.5), group, .004, 'pitch-rail'); box(.006, .002, .246, rubber, svg(1022, TOP + .0024, 812), group, .002, 'pitch-slot');
  const fader = new THREE.Group(); fader.position.set(...svg(1022, TOP + .010, 812)); group.add(fader); parts.pitch = fader;
  box(.043, .017, .039, black, [0, 0, 0], fader, .002, 'pitch-cap'); box(.040, .001, .006, satin, [0, .009, -.002], fader, .0004); box(.040, .0005, .0017, chrome, [0, .0097, -.004], fader, .0003);
  for (const z of [-.012, .012]) box(.037, .00055, .0018, darkChrome, [0, .0088, z], fader, .0003);
  parts.targetLight = cylinder(.014, .022, satin, svg(680, TOP + .011, 959), group, 48, 'target-light'); cylinder(.012, .002, darkChrome, svg(680, TOP + .023, 959), group, 48);
  const lampPaint = material({ color: '#62787b', roughness: .2, emissive: '#b0ddff', emissiveIntensity: 0 });
  const lamp = mesh(new THREE.SphereGeometry(.0025, 16, 10), lampPaint); lamp.position.set(...svg(672, TOP + .025, 950));
  const strobePaint = material({ color: '#5d2630', roughness: .35, emissive: '#ee243f', emissiveIntensity: 0 }); box(.013, .004, .008, strobePaint, svg(196, TOP + .005, 850), group, .001);
  // The dust cover swings on its rear hinges (the blocks at the back edge): the hinge
  // group sits on that axis and the lid is offset so rotation.x lifts the front.
  const HINGE = { y: .076, z: -.3765, open: 98 * DEG, duration: COVER_SWING_MS };
  const hinge = new THREE.Group(); hinge.position.set(0, HINGE.y, HINGE.z); group.add(hinge); parts.coverHinge = hinge;
  const cover = new THREE.Group(); cover.position.set(0, -HINGE.y, -HINGE.z); hinge.add(cover); parts.cover = cover;
  // Plain alpha glass, not transmission: the cover is always on screen now and transmission
  // would re-render the opaque scene every frame. Reflections come from the plate environment.
  const coverPaint = material({ color: '#d6e3e8', roughness: .05, metalness: 0, clearcoat: 1, clearcoatRoughness: .04, transparent: true, opacity: .07, envMapIntensity: 1.3, side: THREE.DoubleSide, depthWrite: false }, true);
  box(.985, .0025, .768, coverPaint, [-.0005, .205, .0075], cover, .0006);
  for (const x of [-.492, .491]) box(.0025, .128, .768, coverPaint, [x, .140, .0075], cover, .0006);
  box(.985, .128, .0025, coverPaint, [-.0005, .140, .390], cover, .0006); // VSM draws shadow receivers into the map too, so the glass must neither cast nor receive.
  cover.traverse(node => { if (node.isMesh) { node.name = 'dust-cover-glass'; node.castShadow = node.receiveShadow = false; } });
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const lid = { amount: null, from: 0, to: 0, start: 0 };
  // Presentation only: eases toward the model's coverClosed, retargeting from wherever it is.
  const swingCover = (closed, now) => {
    const to = closed ? 0 : 1;
    if (lid.amount === null || reduceMotion.matches) Object.assign(lid, { amount: to, from: to, to });
    else if (to !== lid.to) Object.assign(lid, { from: lid.amount, to, start: now });
    const span = Math.abs(lid.to - lid.from) * HINGE.duration, t = span ? clamp((now - lid.start) / span, 0, 1) : 1;
    lid.amount = lid.from + (lid.to - lid.from) * (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    hinge.rotation.x = -lid.amount * HINGE.open;
  };

  // Cue presentation: the arm follows the model's damped descent exactly (contact happens at
  // its end) and rises over 300 ms when lifted; the lever itself moves quickly.
  const CUE_HEIGHT = .008, LIFT_MS = 300, LEVER_MS = 160;
  const cueState = { lift: null, lever: null, last: 0 };
  const settleCue = (state, now) => {
    const dt = cueState.last ? Math.min(100, now - cueState.last) : 0; cueState.last = now;
    const descent = state.cueDescent, raised = Boolean(state.stylusRaised);
    const p = descent ? (descent.duration ? clamp((now - descent.started) / descent.duration, 0, 1) : 1) : null;
    const leverTarget = raised && !descent ? 1 : 0;
    if (cueState.lift === null || reduceMotion.matches) { cueState.lift = descent ? 1 - p * p * (3 - 2 * p) : raised ? 1 : 0; cueState.lever = leverTarget; }
    else {
      if (descent) cueState.lift = Math.min(cueState.lift, 1 - p * p * (3 - 2 * p));
      else if (raised) cueState.lift = Math.min(1, cueState.lift + dt / LIFT_MS);
      else cueState.lift = 0;
      const step = dt / LEVER_MS; cueState.lever += clamp(leverTarget - cueState.lever, -step, step);
    }
    const lift = cueState.lift, ease = lift * lift * (3 - 2 * lift);
    arm.position.y = CUE_HEIGHT * (raised && !descent ? ease : lift);
    cue.rotation.x = -.26 * (1 - cueState.lever);
  };
  const setLed = (entry, lit) => { entry.material.color.set(lit ? '#dc4255' : '#572f37'); entry.material.emissiveIntensity = lit ? .55 : 0; };
  function update(state, presentation = {}, now = performance.now()) {
    if (!state) return;
    platter.rotation.y = -(Number(state.rotation) || 0) * DEG; record.rotation.y = -(Number(state.recordRotation) || 0) * DEG;
    arm.rotation.y = -((Number(state.tonearmAngle) || REST) - REST) * DEG; settleCue(state, now);
    power.rotation.y = -(Number(state.powerAngle) || 0) * DEG;
    fader.position.z = .106 + (clamp((Number(state.pitch) || 0) / (Number(state.pitchRange) || 8), -1, 1) + 1) * .112;
    start.position.y = TOP + (state.platterRunning ? .0055 : .007); swingCover(Boolean(state.coverClosed), now); record.visible = Boolean(state.recordPresent);
    record.position.set(CENTER.x + (Number(presentation.recordOffsetX) || 0), RECORD_Y + (Number(presentation.recordLift) || 0), CENTER.z + (Number(presentation.recordOffsetZ) || 0));
    record.scale.setScalar(Number.isFinite(presentation.recordScale) ? presentation.recordScale : 1);
    const opacity = Number.isFinite(presentation.recordOpacity) ? clamp(presentation.recordOpacity, 0, 1) : 1;
    for (const [i, key] of ['speed33Pressed', 'speed45Pressed'].entries()) { speeds[i].button.position.y = TOP + (state[key] ? .0025 : .0045); setLed(speeds[i], Boolean(state.power && state[key])); }
    setLed(range8, Boolean(state.power && state.pitchRange === 8)); setLed(range16, Boolean(state.power && state.pitchRange === 16)); setLed(zero, Boolean(state.power && (state.quartzLock || !state.pitch)));
    lampPaint.emissiveIntensity = state.power && state.targetLight ? 1.3 : 0; strobePaint.emissiveIntensity = state.power ? .6 : 0;
    if (cache.finish !== state.turntableColor) {
      cache.finish = state.turntableColor; const finish = FINISHES[state.turntableColor] || FINISHES.Silver;
      chassisPaint.color.set(finish.surface[1]); edgePaint.color.set(finish.edge[1]); railPaint.color.set(finish.rail[0]); drawPrinting(finish);
    }
    const mediaKey = `${state.vinylColor}|${state.condition}|${opacity}`;
    if (cache.media !== mediaKey) {
      cache.media = mediaKey; const [base, , density] = VINYL[state.vinylColor] || VINYL.Black, wearLevel = CONDITIONS[state.condition]?.visualWear || 0;
      for (const paint of [vinylSide, vinylTop]) {
        paint.color.set(base); paint.opacity = density * opacity; const transparent = paint.opacity < .999;
        if (paint.transparent !== transparent) { paint.transparent = transparent; paint.needsUpdate = true; } paint.depthWrite = !transparent;
      }
      vinylTop.roughness = .3 + wearLevel * .2; vinylSide.roughness = .18 + wearLevel * .13;
      wearPaint.opacity = wearLevel * .38 * opacity; wearPaint.color.set(['White', 'Clear'].includes(state.vinylColor) ? '#334942' : '#c6d3ca');
      paper.opacity = opacity; const fading = opacity < .999;
      if (paper.transparent !== fading) { paper.transparent = fading; paper.needsUpdate = true; } paper.depthWrite = !fading;
    }
    const labelKey = `${state.labelColor}|${state.pendingFilename}|${state.filename}`;
    if (cache.label !== labelKey) { cache.label = labelKey; drawLabel(state); }
  }
  for (const [key, node] of Object.entries(parts)) if (node?.isObject3D) node.name = `vhs-${key}`;
  function snapshot() {
    return {
      type: 'physical-mesh-turntable', chassisColor: `#${chassisPaint.color.getHexString()}`,
      platterDegrees: -platter.rotation.y / DEG, recordDegrees: -record.rotation.y / DEG,
      tonearmAngle: REST - arm.rotation.y / DEG, cueLift: arm.position.y,
      powerAngle: -power.rotation.y / DEG, pitchZ: fader.position.z,
      recordPresent: record.visible, recordLift: record.position.y - RECORD_Y,
      recordScale: record.scale.x, recordOpacity: paper.opacity, vinylOpacity: vinylTop.opacity,
      speed33Pressed: speeds[0].button.position.y < TOP + .0035,
      speed45Pressed: speeds[1].button.position.y < TOP + .0035,
      strobeInstances: dots.count, coverOpen: lid.amount, coverMoving: lid.amount !== lid.to,
      mediaGeometry: { vinylHole: parts.vinylSurface.geometry.parameters.innerRadius, labelHole: parts.label.geometry.parameters.innerRadius, labelRadius: parts.label.geometry.parameters.outerRadius },
    };
  }
  function dispose() {
    dots.dispose(); knurl.dispose();
    group.removeFromParent(); for (const geometry of geometries) geometry.dispose(); for (const paint of materials) paint.dispose(); for (const texture of textures) texture.dispose();
  }
  update({ turntableColor: 'Silver', vinylColor: 'Black', labelColor: 'Blue', condition: 'Very Good+', tonearmAngle: REST, pitchRange: 8, power: true, stylusRaised: true, coverClosed: true });
  return { group, parts, update, dispose, metadata: Object.freeze({ type: 'physical-mesh-turntable', topY: TOP, chassis: { width: .999, depth: .783 }, center: CENTER, pivot: PIVOT, restAngle: REST, recordRadius: .335, centerHoleRadius: .006, strobeInstances: dots.count, materialCount: materials.size, snapshot }) };
}
