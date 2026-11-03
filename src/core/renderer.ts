import * as THREE from 'three';
import { ATMOS, installAtmosphere, makeSkyMaterial, SUN_DIR } from './atmosphere';
import { events } from './events';
import { look } from './look';
import { PostFX } from './post';
import type { QualityManager } from './quality';

/** Sunny-afternoon palette for the classic (Low/Medium) lights (sRGB hex). */
export const SKY = {
  zenith: 0x3d86d8,
  horizon: 0xcfe2ee,
  haze: 0xffe7c2,
  ground: 0xa9b993,
  sunColor: 0xfff0d2,
  hemiSky: 0xd3e8ff,
  hemiGround: 0x7d7650,
};

/** Thrown when the device can't create a WebGL2 context (three.js r150+ needs WebGL2). */
export class NoWebGLError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NoWebGLError';
  }
}

/**
 * Owns the WebGLRenderer and the main scene's lighting/sky/fog (+ post-processing on High/Ultra).
 * World code adds meshes to `scene`; fx adds to `scene` too.
 *
 * Two lighting tiers (Round 2):
 * - classic (Low/Medium): hemisphere + sun, Neutral tone mapping, straight to the screen (as before).
 * - PBR (High/Ultra): sun + image-based lighting from a PMREM of the same analytic sky
 *   (`scene.environment`), soft fitted shadows, clouds, HDR post chain with AgX tone mapping (core/post.ts).
 * Both use the aerial-perspective fog from core/atmosphere.ts.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Direction *towards* the sun (normalised). Afternoon sun, from the south-west, fairly high. */
  readonly sunDir = SUN_DIR.clone();
  /** Number of shader programs that failed to compile/link (see `programFailed`). */
  shaderErrors = 0;
  private sky: THREE.Mesh;
  private skyMats: { classic: THREE.ShaderMaterial; pbr: THREE.ShaderMaterial };
  private shadowFocus = new THREE.Vector3();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private post: PostFX | null = null;
  private postFailed = false;
  private timer = new THREE.Timer();
  private speedBlur = 0;
  private fwd = new THREE.Vector3();
  /** Dev/test hook: skip rendering (screenshot scripts fast-forward the simulation on software GL). */
  hold = (globalThis as { __dirtHold?: boolean }).__dirtHold === true;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private quality: QualityManager,
  ) {
    installAtmosphere();
    const p = quality.preset;
    this.renderer = createWebGLRenderer(canvas, p.antialias);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Count the whole frame (scene + shadow + post passes) in renderer.info, not just the last pass.
    this.renderer.info.autoReset = false;
    // Keep three's shader checks but count failures instead of only logging (fallbacks look at this).
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      this.shaderErrors++;
      const log = (s: WebGLShader) => (gl.getShaderInfoLog(s) ?? '').trim().slice(0, 400);
      console.warn('[renderer] shader failed to compile/link; a fallback will be used where possible.', gl.getProgramInfoLog(program)?.slice(0, 400), log(vs), log(fs));
    };

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.2, p.viewDistance);

    const fogColor = ATMOS.horizon.clone();
    this.scene.background = fogColor;
    this.scene.fog = new THREE.Fog(fogColor, p.fogNear, p.viewDistance);

    this.hemi = new THREE.HemisphereLight(SKY.hemiSky, SKY.hemiGround, 1.45);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(SKY.sunColor, 2.7);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.sun.position.copy(this.sunDir).multiplyScalar(100);

    this.skyMats = { classic: makeSkyMaterial({ clouds: false, sunIntensity: 1.6 }), pbr: makeSkyMaterial({ clouds: true, sunIntensity: 60 }) };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.skyMats.classic);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.sky.name = 'sky';
    this.scene.add(this.sky);

    this.applyQuality();
    events.on('quality:changed', () => this.applyQuality());
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // iOS sometimes reports stale sizes right after rotation.
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
  }

  /** The image-based-lighting environment (High/Ultra), or null on Low/Medium. */
  get environment(): THREE.Texture | null {
    return this.scene.environment;
  }

  /** Is the post-processing chain active (debug/tests)? */
  get postMode(): string {
    return this.post?.mode ?? 'none';
  }

  applyQuality(): void {
    const p = this.quality.preset;
    look.pbr = p.pbr;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatioCap));
    const shadowsChanged = this.renderer.shadowMap.enabled !== p.shadows;
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    if (this.sun.shadow.mapSize.x !== p.shadowMapSize || !p.shadows) {
      this.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.radius = p.shadowRadius;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -p.shadowRange;
    cam.right = cam.top = p.shadowRange;
    cam.near = 1;
    cam.far = 320;
    cam.updateProjectionMatrix();
    this.camera.far = p.viewDistance;
    this.camera.updateProjectionMatrix();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = p.fogNear;
    fog.far = p.viewDistance * 0.95;
    this.sky.scale.setScalar(p.viewDistance * 0.9);

    // ---- lighting tier
    const pbrChanged = (this.scene.environment !== null) !== p.pbr;
    if (p.pbr) {
      this.scene.environment = this.envMap();
      this.scene.environmentIntensity = 1.0;
      this.hemi.visible = false;
      this.sun.color.copy(ATMOS.sun);
      this.sun.intensity = 3.4;
      this.sun.shadow.bias = -0.0002;
      this.sun.shadow.normalBias = p.shadowMapSize >= 4096 ? 0.02 : 0.035;
      this.sky.material = this.skyMats.pbr;
    } else {
      this.scene.environment = null;
      this.hemi.visible = true;
      this.sun.color.set(SKY.sunColor);
      this.sun.intensity = 2.7;
      this.sun.shadow.bias = -0.0005;
      this.sun.shadow.normalBias = 0.03;
      this.sky.material = this.skyMats.classic;
    }
    look.env = this.scene.environment;

    // ---- post chain
    const wantPost = this.postFailed ? 'none' : p.post;
    if (this.post && this.post.mode !== wantPost) {
      this.post.dispose();
      this.post = null;
    }
    if (wantPost !== 'none' && !this.post) {
      try {
        this.post = new PostFX(this.renderer, this.scene, this.camera, wantPost);
      } catch (e) {
        console.warn('[renderer] post-processing unavailable, rendering directly', e);
        this.postFailed = true;
        this.post = null;
      }
    }
    // Tone mapping happens in the post chain when it runs; otherwise in the materials (Neutral as before).
    this.renderer.toneMapping = this.post ? THREE.NoToneMapping : p.pbr ? THREE.AgXToneMapping : THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Materials only need recompiling when shadows / lighting tier flip (recompiling everything is a hitch).
    if (shadowsChanged || pbrChanged) {
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
      });
    }
    this.resize();
  }

  /** PMREM of the analytic sky (+ ground below the horizon), built once on first use. */
  private envMap(): THREE.Texture {
    if (this.envRT) return this.envRT.texture;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const mat = makeSkyMaterial({ clouds: true, env: true, sunIntensity: 25 });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), mat);
    envScene.add(dome);
    this.envRT = pmrem.fromScene(envScene, 0, 0.1, 400);
    dome.geometry.dispose();
    mat.dispose();
    pmrem.dispose();
    this.envRT.texture.name = 'sky-env';
    return this.envRT.texture;
  }

  /** True if this material's shader program failed to compile/link (checked after it was first drawn). */
  programFailed(material: THREE.Material): boolean {
    const props = this.renderer.properties.get(material) as { currentProgram?: { diagnostics?: { runnable: boolean } } };
    return props.currentProgram?.diagnostics?.runnable === false;
  }

  /** Has this material been drawn at least once (so `programFailed` is meaningful)? */
  programReady(material: THREE.Material): boolean {
    const props = this.renderer.properties.get(material) as { currentProgram?: unknown };
    return !!props.currentProgram;
  }

  /**
   * Keep the shadow camera on the player, pushed forward along the view so the shadow map covers what's on
   * screen (a "fitted" single cascade: ~75 % of the box ahead of the car).
   */
  setShadowFocus(pos: THREE.Vector3): void {
    const range = this.quality.preset.shadowRange;
    this.camera.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() > 1e-6) this.fwd.normalize();
    // Snap to the shadow-map texel grid (in world XZ, close enough for a high sun) to reduce shimmering.
    const step = (2 * range) / this.sun.shadow.mapSize.x;
    const fx = pos.x + this.fwd.x * range * 0.5;
    const fz = pos.z + this.fwd.z * range * 0.5;
    this.shadowFocus.set(Math.round(fx / step) * step, Math.round(pos.y / step) * step, Math.round(fz / step) * step);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.sunDir, 150);
  }

  /** 0..1: speed for the Ultra radial speed blur (main sets it from the player's car). */
  setSpeedBlur(k: number): void {
    this.speedBlur = k;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    if (this.post) {
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.post.setSize(s.x / this.renderer.getPixelRatio(), s.y / this.renderer.getPixelRatio());
    }
  }

  render(): void {
    if (this.hold) return;
    this.renderer.info.reset();
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.sky.position.copy(this.camera.position);
    const sm = this.sky.material as THREE.ShaderMaterial;
    sm.uniforms.time.value += dt;
    if (this.post) {
      this.post.setSpeedBlur(this.speedBlur);
      this.post.render(dt);
    } else this.renderer.render(this.scene, this.camera);
  }

  /** Free GPU memory held by the renderer (page teardown / tests). */
  dispose(): void {
    this.post?.dispose();
    this.envRT?.dispose();
    this.renderer.dispose();
  }
}

/**
 * WebGL2 context with progressively safer attributes. Old iPads occasionally refuse MSAA or
 * 'high-performance'; never fail just because of an attribute.
 */
function createWebGLRenderer(canvas: HTMLCanvasElement, antialias: boolean): THREE.WebGLRenderer {
  const base = { canvas, stencil: false, depth: true, alpha: false } as const;
  const attempts: THREE.WebGLRendererParameters[] = [
    { ...base, antialias, powerPreference: 'high-performance' },
    { ...base, antialias: false, powerPreference: 'high-performance' },
    { ...base, antialias: false },
  ];
  let last: unknown;
  for (const a of attempts) {
    try {
      return new THREE.WebGLRenderer(a);
    } catch (e) {
      last = e;
      console.warn('[renderer] WebGL context failed with', a, e);
    }
  }
  throw new NoWebGLError(String((last as Error)?.message ?? last));
}
