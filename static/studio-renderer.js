import * as THREE from './vendor/three.module.min.js';
import { Reflector } from './vendor/addons/objects/Reflector.js';
import { RoomEnvironment } from './vendor/addons/environments/RoomEnvironment.js';
import { EffectComposer } from './vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from './vendor/addons/postprocessing/ShaderPass.js';
import { OutputPass } from './vendor/addons/postprocessing/OutputPass.js';
import { CopyShader } from './vendor/addons/shaders/CopyShader.js';
import { FullScreenQuad } from './vendor/addons/postprocessing/Pass.js';
import { createStudioTurntable } from './studio-turntable-3d.js';
import { PLATE, platePitch } from './studio-plate.js';

const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const smooth = t => t * t * (3 - 2 * t);
const CLOSE_DISTANCE = 1.405;
// Only the turntable is rendered, so every profile draws at the device pixel ratio
// (capped); profiles trade shadow/reflection resolution and multisampling.
const QUALITY = Object.freeze({
  performance: { dpr: 1.5, shadow: 1024, reflection: 256, samples: 2, fps: 30 },
  balanced: { dpr: 2, shadow: 2048, reflection: 512, samples: 4, fps: 60 },
  cinematic: { dpr: 2, shadow: 4096, reflection: 1024, samples: 8, fps: 60 },
});
// Colour match to the plate: its warm daylight, deep blacks and saturated sky.
const GRADE = Object.freeze({
  name: 'StudioGrade',
  uniforms: { tDiffuse: { value: null }, contrast: { value: .16 }, saturation: { value: 1.06 }, warmth: { value: new THREE.Vector3(1.01, 1, .985) }, lift: { value: .012 } },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `uniform sampler2D tDiffuse;uniform float contrast,saturation,lift;uniform vec3 warmth;varying vec2 vUv;
    void main(){vec4 source=texture2D(tDiffuse,vUv);vec3 color=clamp(source.rgb*warmth,0.,1.);
      float luma=dot(color,vec3(.2126,.7152,.0722));color=clamp(mix(vec3(luma),color,saturation),0.,1.);
      color=mix(color,color*color*(3.-2.*color),contrast);color=color*(1.-lift)+lift*vec3(.86,.9,1.);
      gl_FragColor=vec4(color,source.a);}`,
});

/** A visual subscriber only: the native turntable composited over the studio plate.
 * Audio, mechanics and all controls remain in app.js. */
export class StudioRenderer {
  constructor(host, { onFailure = () => {} } = {}) {
    this.onFailure = onFailure;
    this.host = host; this.quality = 'balanced'; this.frameId = 0; this.reflectionUpdates = 0;
    this.dirty = true; this.visible = true; this.inspection = 0; this.ready = false;
    this.resolution = { scale: 1, samples: 0, slow: 0, calm: 0 };
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
      this.canvas = this.renderer.domElement; this.canvas.id = 'studio-canvas';
      this.canvas.setAttribute('aria-hidden', 'true'); host.prepend(this.canvas);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.info.autoReset = false;
      this.renderer.toneMapping = THREE.NeutralToneMapping; this.renderer.toneMappingExposure = 1.16;
      this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.VSMShadowMap;
      this.renderer.shadowMap.autoUpdate = false;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, 1, .05, 60);
      this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, .05, 60);
      // Small-screen devices get half-density print textures; still several texels per device pixel.
      const printScale = Math.min(screen.width, screen.height) * devicePixelRatio < 1400 ? .5 : 1;
      this.deck = createStudioTurntable({ anisotropy: this.renderer.capabilities.getMaxAnisotropy(), printScale });
      this.deck.group.scale.y = 1.45;
      this.scene.add(this.deck.group);
      this.setupLighting(); this.setupGround(); this.setupPostprocessing();
      this.resizeObserver = new ResizeObserver(() => this.guard(() => this.resize())); this.resizeObserver.observe(host);
      this.intersection = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; if (this.visible) this.invalidate(); }, { rootMargin: '150px' });
      this.intersection.observe(host);
      this.onContextLost = event => {
        event.preventDefault(); this.lost = true; host.dataset.graphics = 'lost';
        document.getElementById('studio-description').textContent = 'Graphics paused. Your record and audio controls remain available.';
      };
      this.onContextRestored = () => this.guard(() => {
        this.lost = false; delete host.dataset.graphics; this.refreshEnvironment();
        document.getElementById('studio-description').textContent = 'Studio graphics restored. Playback and controls are ready.';
        this.renderer.shadowMap.needsUpdate = true; this.invalidate();
      });
      this.canvas.addEventListener('webglcontextlost', this.onContextLost);
      this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
      this.setQuality('balanced'); this.resize();
      this.loadPlateEnvironment().catch(() => {}).then(() => { if (!this.disposed) { this.ready = true; this.invalidate(); } });
    } catch (error) {
      this.dispose(); throw error;
    }
  }

  /** Reflections come from the plate itself, so chrome and vinyl pick up its sky and floor. */
  loadPlateEnvironment() {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(new URL('./assets/studio-plate-mobile.webp', import.meta.url).href, map => {
        if (this.disposed) { map.dispose(); resolve(); return; }
        map.mapping = THREE.EquirectangularReflectionMapping; map.colorSpace = THREE.SRGBColorSpace;
        this.plateMap?.dispose(); this.plateMap = map;
        this.guard(() => { this.refreshEnvironment(); this.invalidate(); }); resolve();
      }, undefined, reject);
    });
  }

  refreshEnvironment() {
    const previous = this.environmentTarget;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    try {
      if (this.plateMap) this.environmentTarget = pmrem.fromEquirectangular(this.plateMap);
      else { const room = new RoomEnvironment(); this.environmentTarget = pmrem.fromScene(room, .035, .1, 100); room.dispose(); }
      this.scene.environment = this.environmentTarget.texture; this.scene.environmentIntensity = this.plateMap ? 1 : .45;
      previous?.dispose();
    } finally { pmrem.dispose(); }
  }

  setupLighting() {
    this.refreshEnvironment();
    // Cool window sky above, warm floor bounce below, as in the plate.
    this.fill = new THREE.HemisphereLight('#d9e8fb', '#8c6f52', .55); this.scene.add(this.fill);
    // Warm late sun from the left: the plate's floor stripes and speaker shading.
    const [dx, dy, dz] = PLATE.sun.direction;
    this.sun = new THREE.DirectionalLight(PLATE.sun.color, PLATE.sun.intensity);
    this.sun.target.position.set(0, 0, 0); this.sun.position.set(-dx * 6, -dy * 6, -dz * 6);
    this.sun.castShadow = true; this.sun.shadow.bias = -.0004; this.sun.shadow.normalBias = .002;
    Object.assign(this.sun.shadow.camera, { left: -1.05, right: 1.05, top: 1.05, bottom: -1.05, near: 2, far: 10 });
    // Soft penumbra like the plate's speaker shadows.
    this.sun.shadow.radius = 9; this.sun.shadow.blurSamples = 16;
    this.scene.add(this.sun, this.sun.target);
    // Light returned by the bright room behind the camera keeps the fascia readable.
    this.bounce = new THREE.DirectionalLight('#fff3e6', .7); this.bounce.position.set(.4, 2.5, 6); this.scene.add(this.bounce);
    // The window behind the desk backlights everything in the plate: bright tops and rims.
    this.window = new THREE.DirectionalLight('#eaf3ff', 1.15); this.window.position.set(0, 3.2, -4); this.scene.add(this.window);
    // Overhead key for inspection only (faded in by updateCamera).
    this.key = new THREE.DirectionalLight('#fffaf2', 0); this.key.position.set(.3, 6, 1.2); this.scene.add(this.key);
  }

  /** Grounding on the glass: a sun shadow catcher, a soft contact shadow and a faint,
   * fading reflection like the speakers' reflections in the plate. */
  setupGround() {
    this.surfaceShadow = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.ShadowMaterial({ color: 0x1d1610, opacity: .5, depthWrite: false }));
    this.surfaceShadow.name = 'glass-shadow-receiver'; this.surfaceShadow.rotation.x = -Math.PI / 2;
    this.surfaceShadow.position.y = .0012; this.surfaceShadow.receiveShadow = true; this.surfaceShadow.renderOrder = 4;
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d');
    // Blurred footprint via an offset canvas shadow (works without ctx.filter).
    ctx.shadowColor = 'rgba(0,0,0,1)'; ctx.shadowBlur = 46; ctx.shadowOffsetX = 2000; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.roundRect(-2000 + 70, 92, 372, 328, 26); ctx.fill();
    const contactMap = new THREE.CanvasTexture(canvas);
    this.contact = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 1.24), new THREE.MeshBasicMaterial({ map: contactMap, transparent: true, opacity: .62, depthWrite: false, toneMapped: false, color: 0x1a130d }));
    this.contact.name = 'contact-shadow'; this.contact.rotation.x = -Math.PI / 2; this.contact.position.set(0, .001, .01); this.contact.renderOrder = 3;
    // Tight occlusion where each foot meets the glass: the deck reads as resting, not floating.
    const foot = document.createElement('canvas'); foot.width = foot.height = 128;
    const footCtx = foot.getContext('2d'), gradient = footCtx.createRadialGradient(64, 64, 6, 64, 64, 62);
    gradient.addColorStop(0, 'rgba(0,0,0,.9)'); gradient.addColorStop(.45, 'rgba(0,0,0,.45)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    footCtx.fillStyle = gradient; footCtx.fillRect(0, 0, 128, 128);
    const footMaterial = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(foot), transparent: true, opacity: .8, depthWrite: false, toneMapped: false, color: 0x120d09 });
    this.feet = new THREE.Group(); this.feet.name = 'foot-contact';
    const footGeometry = new THREE.PlaneGeometry(.17, .17);
    for (const x of [-.425, .424]) for (const z of [-.313, .326]) {
      const pad = new THREE.Mesh(footGeometry, footMaterial); pad.rotation.x = -Math.PI / 2; pad.position.set(x, .0011, z); pad.renderOrder = 3; this.feet.add(pad);
    }
    const shader = {
      uniforms: { color: { value: new THREE.Color(0xffffff) }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() },
        strength: { value: .55 }, texel: { value: new THREE.Vector2(1 / 512, 1 / 512) }, front: { value: .4 }, fade: { value: .65 }, presence: { value: 1 } },
      vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vWorld;
        void main(){vUv=textureMatrix*vec4(position,1.);vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `uniform sampler2D tDiffuse;uniform float strength,front,fade,presence;uniform vec2 texel;varying vec4 vUv;varying vec3 vWorld;
        void main(){vec2 uv=vUv.xy/vUv.w;vec4 sum=texture2D(tDiffuse,uv)*.36;
          sum+=(texture2D(tDiffuse,uv+vec2(texel.x,0.))+texture2D(tDiffuse,uv-vec2(texel.x,0.))+texture2D(tDiffuse,uv+vec2(0.,texel.y))+texture2D(tDiffuse,uv-vec2(0.,texel.y)))*.16;
          // The reflection weakens with height above the glass, like the plate's speakers.
          float away=1.-smoothstep(front-.06,front+fade,vWorld.z);
          gl_FragColor=vec4(sum.rgb,sum.a*strength*away*presence);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    };
    this.reflector = new Reflector(new THREE.PlaneGeometry(3, 3), { textureWidth: 512, textureHeight: 512, clipBias: .0005, multisample: 0, shader });
    this.reflector.name = 'glass-reflection'; this.reflector.rotation.x = -Math.PI / 2; this.reflector.position.y = .0008;
    this.reflector.material.transparent = true; this.reflector.material.depthWrite = false; this.reflector.renderOrder = 2;
    const reflect = this.reflector.onBeforeRender.bind(this.reflector);
    this.reflector.onBeforeRender = (renderer, scene, camera, ...args) => {
      if (scene.overrideMaterial || this.reflectionFrame === this.frameId || this.suppressReflections || !this.reflector.material.uniforms.presence.value) return;
      const hidden = [this.surfaceShadow, this.contact, this.feet].filter(object => object.visible);
      for (const object of hidden) object.visible = false;
      try { reflect(renderer, scene, camera, ...args); this.reflectionFrame = this.frameId; this.reflectionUpdates++; }
      finally { for (const object of hidden) object.visible = true; }
    };
    this.scene.add(this.reflector, this.contact, this.feet, this.surfaceShadow);
  }

  setupPostprocessing() {
    // Multisampling keeps fine print crisp; FXAA would soften it.
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.renderPass = new RenderPass(this.scene, this.camera); this.renderPass.clearAlpha = 0; this.composer.addPass(this.renderPass);
    this.output = new OutputPass(); this.composer.addPass(this.output);
    this.grade = new ShaderPass(GRADE); this.composer.addPass(this.grade);
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.quality = name; const settings = QUALITY[name];
    Object.assign(this.resolution, { scale: 1, samples: 0, slow: 0, calm: 0 });
    this.sun.shadow.mapSize.set(settings.shadow, settings.shadow);
    // VSM keeps a second blur target; both must be reallocated at the new size, or the
    // stale pass corrupts the map and the catcher reads everything as shadowed.
    for (const key of ['map', 'mapPass']) { this.sun.shadow[key]?.dispose(); this.sun.shadow[key] = null; }
    this.reflector.getRenderTarget().setSize(settings.reflection, settings.reflection);
    this.reflector.material.uniforms.texel.value.setScalar(1.6 / settings.reflection);
    for (const buffer of [this.composer.renderTarget1, this.composer.renderTarget2]) { buffer.samples = settings.samples; buffer.dispose(); }
    this.renderer.shadowMap.needsUpdate = true; this.resizeKey = null; this.resize(); this.invalidate();
  }

  /** Device pixel ratio up to the profile cap. Dynamic resolution may lower it, but never
   * below one device pixel per CSS pixel, so text stays sharp on capable displays. */
  basePixelRatio() { return Math.min(devicePixelRatio || 1, QUALITY[this.quality].dpr); }
  minimumScale() { return Math.min(1, 1 / this.basePixelRatio()); }

  resize() {
    // Allocate integer buffers explicitly: a fractional target height corrupts readback row stride.
    this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight);
    const resizeKey = `${this.width}|${this.height}|${devicePixelRatio}|${this.quality}|${this.resolution.scale}`;
    if (this.resizeKey === resizeKey) return;
    this.resizeKey = resizeKey;
    this.pixelRatio = this.basePixelRatio() * this.resolution.scale;
    this.drawWidth = Math.max(1, Math.floor(this.width * this.pixelRatio));
    this.drawHeight = Math.max(1, Math.floor(this.height * this.pixelRatio));
    this.renderer.setPixelRatio(this.pixelRatio); this.renderer.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(1); this.composer.setSize(this.drawWidth, this.drawHeight);
    this.updateCamera(this.inspection); this.invalidate();
  }

  /** Resizing clears the drawing buffer; redraw before the browser paints it blank. */
  redraw() {
    if (!this.dirty || !this.state || this.lost || document.hidden) return;
    this.frameId++; this.renderer.info.reset(); this.composer.render(); this.dirty = false;
  }

  /** Stage areas from StudioView in CSS pixels: the displayed plate and the open areas. */
  setFraming(framing) {
    this.framing = framing; this.updateCamera(this.inspection); this.invalidate();
  }

  frames() {
    const { width, height } = this, f = this.framing;
    if (!f || Math.abs(f.width - width) > 1 || Math.abs(f.height - height) > 1) {
      const full = { x: 0, y: 0, width, height };
      return { close: full, plate: { x: 0, y: (height - width / PLATE.aspect) / 2, width, height: width / PLATE.aspect } };
    }
    return f;
  }

  /** Perspective of the calibrated plate camera, mapped through the plate's on-screen rectangle. */
  plateProjection(plate) {
    const { width, height } = this, near = this.camera.near, far = this.camera.far;
    const focal = PLATE.focal * plate.width;
    const fx = 2 * focal / width, fy = 2 * focal / height;
    const px = 2 * (plate.x + plate.width * PLATE.principal[0]) / width - 1;
    const py = 1 - 2 * (plate.y + plate.height * PLATE.principal[1]) / height;
    return new THREE.Matrix4().set(fx, 0, -px, 0, 0, fy, -py, 0, 0, 0, -(far + near) / (far - near), -2 * far * near / (far - near), 0, 0, -1, 0);
  }

  updateCamera(progress) {
    this.inspection = progress; const aspect = this.width / this.height;
    const { close: closeRect, plate } = this.frames();
    // Wide pose is the plate camera: level yaw, pitched down, above and in front of the deck.
    const pitch = platePitch(), height = PLATE.cameraHeight, distance = PLATE.deckDistance;
    const wideTargetY = height - distance * Math.tan(pitch), wideDistance = distance / Math.cos(pitch);
    // Dolly first, then sweep overhead about the deck centre.
    const tilt = smooth(clamp((progress - .18) / .82, 0, 1));
    const angle = mix(pitch, Math.PI / 2, tilt), range = mix(wideDistance, CLOSE_DISTANCE, progress);
    const targetY = mix(wideTargetY, .075, tilt);
    this.camera.position.set(0, targetY + Math.sin(angle) * range, Math.cos(angle) * range);
    this.camera.lookAt(0, targetY, 0);
    this.camera.aspect = aspect;
    // The endpoint is orthographic so the SVG input mapping stays exact for raised parts.
    const scale = Math.min(closeRect.width * (this.width < 600 ? .99 : .94) / 1024, closeRect.height * .96 / 828);
    this.controlScale = scale;
    const orthoHeight = this.height / (scale * 1000), orthoWidth = orthoHeight * aspect;
    Object.assign(this.ortho, { left: -orthoWidth / 2, right: orthoWidth / 2, top: orthoHeight / 2, bottom: -orthoHeight / 2 });
    this.ortho.updateProjectionMatrix();
    const o = this.ortho.projectionMatrix.elements, closeShift = [(closeRect.x + closeRect.width / 2) / this.width * 2 - 1, 1 - (closeRect.y + closeRect.height / 2) / this.height * 2];
    for (let column = 0; column < 4; column++) { o[column * 4] += closeShift[0] * o[column * 4 + 3]; o[column * 4 + 1] += closeShift[1] * o[column * 4 + 3]; }
    const p = this.plateProjection(plate).elements, projectionMix = smooth(clamp(progress / .85, 0, 1));
    for (let index = 0; index < 16; index++) this.camera.projectionMatrix.elements[index] = mix(p[index], o[index], projectionMix);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.updateMatrixWorld();
    // Plate-specific grounding fades as the view leaves the plate's perspective.
    this.reflector.material.uniforms.presence.value = 1 - smooth(clamp(progress / .35, 0, 1));
    this.reflector.visible = this.reflector.material.uniforms.presence.value > 0;
    // Off the deck, the sun shadow only makes sense on the plate's glass; in close-up it
    // fades, and an overhead key flattens the top like a product shot so print reads clearly.
    const away = smooth(clamp(progress / .6, 0, 1));
    this.surfaceShadow.material.opacity = .5 * (1 - away); this.surfaceShadow.visible = away < 1;
    this.key.intensity = .55 * away; this.sun.intensity = PLATE.sun.intensity * (1 - .25 * away);
    // Plate reflections read as blue blotches on the flat chassis once the plate is out of view.
    if (this.plateMap) this.scene.environmentIntensity = mix(1, .45, away);
    this.dirty = true;
  }

  guard(operation) {
    if (this.disposed) return;
    try { return operation(); } catch (error) { this.onFailure(error); }
  }

  invalidate() { if (!this.disposed) this.dirty = true; }

  update(state, now, audible = false) {
    this.state = state;
    // The app frame loop stretches when the GPU cannot finish the previous frame.
    if (this.renderedLast) this.adaptResolution(now - this.lastUpdate);
    this.lastUpdate = now; this.renderedLast = false;
    const record = document.getElementById('record-lift'); let presentation;
    if (state.recordPhase === 'inserting' || state.recordPhase === 'ejecting') {
      const style = getComputedStyle(record), matrix = new DOMMatrix(style.transform);
      presentation = { recordLift: -matrix.f / 1000, recordOffsetX: matrix.e / 1000, recordOffsetZ: 0,
        recordScale: Math.hypot(matrix.a, matrix.b), recordOpacity: Number(style.opacity) };
    }
    this.deck.update(state, presentation ?? {}, now);
    const signature = [audible, state.rotation, state.recordRotation, state.tonearmAngle, state.stylusRaised, state.powerAngle,
      state.pitch, state.pitchRange, state.quartzLock, state.speed33Pressed, state.speed45Pressed, state.recordPresent,
      state.recordPhase, state.turntableColor, state.vinylColor, state.labelColor, state.condition, state.targetLight, this.deck.parts.coverHinge.rotation.x].join('|');
    if (this.signature !== signature || presentation) this.dirty = true;
    this.signature = signature;
    const shadowSignature = [state.tonearmAngle.toFixed(2), state.stylusRaised, state.recordPresent, state.pitch.toFixed(2), state.pitchRange, state.speed33Pressed, state.speed45Pressed, state.coverClosed, presentation?.recordLift.toFixed(3)].join('|');
    if (this.shadowSignature !== shadowSignature) { this.shadowSignature = shadowSignature; this.renderer.shadowMap.needsUpdate = true; }
    if (!this.dirty || !this.visible || this.lost || document.hidden || now - (this.lastFrame || 0) < 1000 / QUALITY[this.quality].fps - 1) return;
    this.lastFrame = now; this.frameId++;
    this.renderer.info.reset(); this.composer.render(); this.dirty = false; this.renderedLast = true;
  }

  /** Dynamic resolution: when most frames after a render arrive late, lower the pixel
   * ratio in 15% steps, but never below one device pixel per CSS pixel; sustained
   * headroom restores it. On 1× displays it is effectively disabled. */
  adaptResolution(interval) {
    const budget = 1000 / QUALITY[this.quality].fps, state = this.resolution;
    if (!(interval > 0) || interval > budget * 4) return;
    state.samples++; if (interval > budget * 1.3) state.slow++;
    if (state.samples < 90) return;
    const slow = state.slow / state.samples, floor = this.minimumScale(); let scale = state.scale;
    state.samples = state.slow = 0; state.calm = slow < .05 ? state.calm + 1 : 0;
    if (slow > .5 && scale > floor) scale = Math.max(floor, scale * .85);
    else if (state.calm >= 4 && scale < 1) { scale = Math.min(1, scale * 1.1); state.calm = 0; }
    if (scale !== state.scale) { state.scale = scale; this.resize(); }
  }

  projectPoint(name, local = [0, 0, 0]) {
    const object = this.scene.getObjectByName(name); if (!object) return null;
    const world = object.localToWorld(new THREE.Vector3(...local)), projected = world.clone().project(this.camera);
    return { world: world.toArray(), x: (projected.x + 1) * this.width / 2, y: (1 - projected.y) * this.height / 2,
      depth: projected.z, visible: object.visible && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1 };
  }

  snapshot({ bounds: includeBounds = true } = {}) {
    this.scene.updateMatrixWorld(true);
    const objects = {};
    this.scene.traverse(object => {
      if (!object.name || object.name.startsWith('_')) return;
      const material = object.material, bounds = includeBounds ? new THREE.Box3().setFromObject(object) : null;
      let effectiveVisible = true, removableMedia = false;
      for (let parent = object; parent; parent = parent.parent) { effectiveVisible &&= parent.visible; removableMedia ||= parent === this.deck.parts.record; }
      const map = material?.map;
      objects[object.name] = { id: object.id, type: object.type, localPosition: object.position.toArray(), parent: object.parent?.name, effectiveVisible, removableMedia, position: object.getWorldPosition(new THREE.Vector3()).toArray(),
        rotation: object.rotation.toArray().slice(0, 3), scale: object.scale.toArray(), bounds: bounds ? { min: bounds.min.toArray(), max: bounds.max.toArray() } : undefined, visible: object.visible, castShadow: object.castShadow, receiveShadow: object.receiveShadow,
        material: material ? { type: material.type, color: material.color?.getHexString(), roughness: material.roughness, metalness: material.metalness,
          transmission: material.transmission, thickness: material.thickness, ior: material.ior, opacity: material.opacity, depthWrite: material.depthWrite, depthTest: material.depthTest,
          map: map ? { width: map.image?.width, height: map.image?.height, anisotropy: map.anisotropy, mipmaps: map.generateMipmaps, minFilter: map.minFilter } : null } : null };
    });
    const { calls, triangles } = this.renderer.info.render;
    return { ready: this.ready, renderer: 'Three.js WebGL', composite: 'studio plate', quality: this.quality, frameId: this.frameId, reflectionUpdates: this.reflectionUpdates, render: { calls, triangles },
      size: { width: this.width, height: this.height, pixelRatio: this.pixelRatio, devicePixelRatio, resolutionScale: this.resolution.scale, minimumPixelRatio: this.basePixelRatio() * this.minimumScale() },
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
      plate: this.frames().plate, calibration: { pitch: platePitch(), height: PLATE.cameraHeight, distance: PLATE.deckDistance, focal: PLATE.focal },
      camera: { fov: this.camera.fov, aspect: this.camera.aspect,
        position: this.camera.position.toArray(), quaternion: this.camera.quaternion.toArray(), projection: this.camera.projectionMatrix.toArray(), inspection: this.inspection },
      lighting: { shadows: this.renderer.shadowMap.enabled, shadowResolution: this.sun.shadow.mapSize.x, sun: this.sun.intensity, sunPosition: this.sun.position.toArray(), sunTarget: this.sun.target.position.toArray(), environment: this.scene.environmentIntensity },
      objects, visual: this.deck.metadata?.snapshot?.() ?? null };
  }

  capturePass(modes = ['beauty']) {
    // Explicit diagnostics only: render one frozen pose offscreen. Visibility pairs
    // retain depth testing and a shared shadow/reflection solution.
    const list = Array.isArray(modes) ? modes : [modes], result = {};
    const hiddenByMode = {
      'without-spindle': ['vhs-spindle', 'vhs-spindleTip'],
      'without-slipmat-print': ['vhs-slipmatPrint'],
      'without-chassis-print': ['vhs-lettering', 'vhs-frontPrint'],
    };
    const originals = new Map();
    for (const name of Object.values(hiddenByMode).flat()) {
      const object = this.scene.getObjectByName(name);
      if (object) originals.set(object, object.visible);
    }
    const restoreObjects = () => { for (const [object, visible] of originals) object.visible = visible; };
    const original = { screen: this.composer.renderToScreen, shadows: this.renderer.shadowMap.enabled,
      shadowAuto: this.renderer.shadowMap.autoUpdate, reflection: this.reflector.visible, contact: this.contact.visible,
      suppressReflections: this.suppressReflections, target: this.renderer.getRenderTarget() };
    // Read RGBA8, not HALF_FLOAT: D3D12/ANGLE can return zero-filled half-float readback.
    const source = this.composer.readBuffer;
    const staging = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(source.width)), Math.max(1, Math.floor(source.height)), {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    });
    const copyMaterial = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
    const copyQuad = new FullScreenQuad(copyMaterial);
    let sharedShadowsReady = false;
    try {
      this.composer.renderToScreen = false;
      for (const mode of list) {
        if (!['beauty', 'without-shadows', 'without-reflections', 'media-visibility', ...Object.keys(hiddenByMode)].includes(mode)) throw new Error('Unknown studio diagnostic pass');
        restoreObjects();
        const visibility = mode === 'media-visibility' || Boolean(hiddenByMode[mode]);
        this.renderer.shadowMap.enabled = mode !== 'without-shadows';
        this.contact.visible = this.feet.visible = mode !== 'without-shadows' && original.contact;
        this.renderer.shadowMap.autoUpdate = visibility ? false : original.shadowAuto;
        this.reflector.visible = mode !== 'without-reflections' && original.reflection;
        this.suppressReflections = visibility || original.suppressReflections;
        if (visibility && !sharedShadowsReady) {
          this.renderer.shadowMap.needsUpdate = true; this.frameId++; this.composer.render();
          sharedShadowsReady = true;
        }
        this.renderer.shadowMap.needsUpdate = !visibility;
        for (const name of hiddenByMode[mode] || []) {
          const object = this.scene.getObjectByName(name);
          if (!object) throw new Error(`Missing diagnostic mesh: ${name}`);
          object.visible = false;
        }
        this.frameId++; this.composer.render();
        const target = this.composer.readBuffer, width = Math.max(1, Math.floor(target.width)), height = Math.max(1, Math.floor(target.height));
        if (staging.width !== width || staging.height !== height) staging.setSize(width, height);
        copyMaterial.uniforms.tDiffuse.value = target.texture;
        this.renderer.setRenderTarget(staging); copyQuad.render(this.renderer);
        const rgba = new Uint8Array(width * height * 4);
        this.renderer.readRenderTargetPixels(staging, 0, 0, width, height, rgba);
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d'), pixels = context.createImageData(width, height);
        for (let y = 0; y < height; y++) {
          const sourceRow = (height - 1 - y) * width * 4;
          pixels.data.set(rgba.subarray(sourceRow, sourceRow + width * 4), y * width * 4);
        }
        context.putImageData(pixels, 0, 0); result[mode] = canvas.toDataURL('image/png');
      }
    } finally {
      restoreObjects(); this.composer.renderToScreen = original.screen;
      this.renderer.shadowMap.enabled = original.shadows; this.renderer.shadowMap.autoUpdate = original.shadowAuto;
      this.reflector.visible = original.reflection; this.contact.visible = this.feet.visible = original.contact; this.suppressReflections = original.suppressReflections;
      this.renderer.setRenderTarget(original.target); this.renderer.shadowMap.needsUpdate = true;
      staging.dispose(); copyQuad.dispose(); copyMaterial.dispose(); this.invalidate();
    }
    return Array.isArray(modes) ? result : result[modes];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect(); this.intersection?.disconnect();
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);
    // Also handles partially initialized scenes after a failed constructor.
    const resources = [this.deck, this.reflector?.geometry, this.reflector,
      this.surfaceShadow?.geometry, this.surfaceShadow?.material, this.contact?.geometry, this.contact?.material?.map, this.contact?.material, this.feet?.children[0]?.geometry, this.feet?.children[0]?.material?.map, this.feet?.children[0]?.material,
      ...(this.composer?.passes || []), this.composer, this.environmentTarget, this.plateMap, this.sun?.shadow, this.renderer];
    for (const resource of resources) {
      try { resource?.dispose?.(); } catch { /* Finish releasing the remaining resources. */ }
    }
    this.canvas?.remove();
  }
}
