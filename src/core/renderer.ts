import * as THREE from 'three';
import { events } from './events';
import type { QualityManager } from './quality';

/** Sunny-afternoon palette (sRGB hex). Fog = sky horizon, so distant terrain melts into the sky. */
export const SKY = {
  zenith: 0x3d86d8,
  horizon: 0xcfe2ee,
  haze: 0xffe7c2, // warm glow around the sun near the horizon
  ground: 0xa9b993,
  sunColor: 0xfff0d2,
  hemiSky: 0xd3e8ff,
  hemiGround: 0x6b6a3e,
};

/** Thrown when the device can't create a WebGL2 context (three.js r150+ needs WebGL2). */
export class NoWebGLError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'NoWebGLError';
  }
}

/** Can this browser create a WebGL2 context at all? (iPadOS 15+ can; older iPadOS can't.) */
export function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = !!gl;
    (gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Owns the WebGLRenderer and the main scene's lighting/sky/fog.
 * World code adds meshes to `scene`; fx adds to `scene` too.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Direction *towards* the sun (normalised). Afternoon sun, from the south-west, fairly high. */
  readonly sunDir = new THREE.Vector3(-0.45, 0.62, 0.55).normalize();
  /** Number of shader programs that failed to compile/link (see `programFailed`). */
  shaderErrors = 0;
  private sky: THREE.Mesh;
  private shadowFocus = new THREE.Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private quality: QualityManager,
  ) {
    const p = quality.preset;
    this.renderer = createWebGLRenderer(canvas, p.antialias);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral (Khronos PBR Neutral) keeps paint colours bright and saturated, unlike ACES which greys
    // and darkens them — this is a kids' game in the sun.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Keep three's shader checks but count failures instead of only logging (fallbacks look at this).
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      this.shaderErrors++;
      const log = (s: WebGLShader) => (gl.getShaderInfoLog(s) ?? '').trim().slice(0, 400);
      console.warn('[renderer] shader failed to compile/link; a fallback will be used where possible.', gl.getProgramInfoLog(program)?.slice(0, 400), log(vs), log(fs));
    };

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.2, p.viewDistance);

    const fogColor = new THREE.Color(SKY.horizon);
    this.scene.background = fogColor;
    this.scene.fog = new THREE.Fog(fogColor, p.fogNear, p.viewDistance);

    this.hemi = new THREE.HemisphereLight(SKY.hemiSky, SKY.hemiGround, 1.25);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(SKY.sunColor, 2.7);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.sun.position.copy(this.sunDir).multiplyScalar(100);

    this.sky = makeSky(fogColor, this.sunDir);
    this.scene.add(this.sky);

    this.applyQuality();
    events.on('quality:changed', () => this.applyQuality());
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // iOS sometimes reports stale sizes right after rotation.
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
  }

  applyQuality(): void {
    const p = this.quality.preset;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatioCap));
    const shadowsChanged = this.renderer.shadowMap.enabled !== p.shadows;
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    if (this.sun.shadow.mapSize.x !== p.shadowMapSize || !p.shadows) {
      this.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -p.shadowRange;
    cam.right = cam.top = p.shadowRange;
    cam.near = 1;
    cam.far = 200;
    cam.updateProjectionMatrix();
    this.camera.far = p.viewDistance;
    this.camera.updateProjectionMatrix();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = p.fogNear;
    fog.far = p.viewDistance * 0.95;
    this.sky.scale.setScalar(p.viewDistance * 0.9);
    // Materials only need recompiling when shadows flip on/off (recompiling everything is a hitch).
    if (shadowsChanged) {
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
      });
    }
    this.resize();
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

  /** Keep the shadow camera centred on the player so a small shadow map covers what matters. */
  setShadowFocus(pos: THREE.Vector3): void {
    // Snap to texel-ish grid to reduce shadow shimmering when moving.
    const step = 0.5;
    this.shadowFocus.set(Math.round(pos.x / step) * step, Math.round(pos.y / step) * step, Math.round(pos.z / step) * step);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.sunDir, 100);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  /** Free GPU memory held by the renderer (page teardown / tests). */
  dispose(): void {
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

/**
 * Cheap gradient sky dome (one draw call, no textures, ignores fog): deep blue overhead, the fog colour
 * exactly at the horizon (so terrain fades seamlessly), a warm haze toward the sun and a soft sun disc.
 */
function makeSky(horizon: THREE.Color, sunDir: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(SKY.zenith) },
      horizon: { value: horizon.clone() },
      haze: { value: new THREE.Color(SKY.haze) },
      bottom: { value: new THREE.Color(SKY.ground) },
      sunDir: { value: sunDir.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // push to far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 haze; uniform vec3 bottom; uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float s = max(dot(d, sunDir), 0.0);
        vec3 c = h > 0.0 ? mix(horizon, top, pow(min(h * 1.5, 1.0), 0.65)) : mix(horizon, bottom, min(-h * 4.0, 1.0));
        // Warm haze toward the sun, strongest low in the sky.
        c = mix(c, haze, pow(s, 6.0) * 0.45 * (1.0 - min(abs(h) * 1.4, 1.0)));
        // Sun: bright disc + glow.
        c += vec3(1.0, 0.93, 0.78) * (pow(s, 900.0) * 1.6 + pow(s, 60.0) * 0.18);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'sky';
  return mesh;
}
