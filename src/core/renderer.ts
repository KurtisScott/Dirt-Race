import * as THREE from 'three';
import { events } from './events';
import type { QualityManager } from './quality';

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
  /** Direction *towards* the sun (normalised). Afternoon sun, from the south-west. */
  readonly sunDir = new THREE.Vector3(-0.45, 0.75, 0.5).normalize();
  private sky: THREE.Mesh;
  private shadowFocus = new THREE.Vector3();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private quality: QualityManager,
  ) {
    const p = quality.preset;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: p.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.2, p.viewDistance);

    const fogColor = new THREE.Color(0xcfe3f0);
    this.scene.background = fogColor;
    this.scene.fog = new THREE.Fog(fogColor, p.fogNear, p.viewDistance);

    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a6b3a, 1.1);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.sky = makeSky(fogColor);
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
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    if (this.sun.shadow.mapSize.x !== p.shadowMapSize) {
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
    // Materials must recompile when shadow on/off flips.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
    this.resize();
  }

  /** Keep the shadow camera centred on the player so a small shadow map covers what matters. */
  setShadowFocus(pos: THREE.Vector3): void {
    // Snap to texel-ish grid to reduce shadow shimmering when moving.
    const step = 0.5;
    this.shadowFocus.set(Math.round(pos.x / step) * step, Math.round(pos.y / step) * step, Math.round(pos.z / step) * step);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.sunDir, 100);
    this.sky.position.copy(this.camera.position);
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
}

/** Cheap gradient sky dome (one draw call, no textures, ignores fog). */
function makeSky(horizon: THREE.Color): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x4f95dc) },
      horizon: { value: horizon.clone() },
      bottom: { value: new THREE.Color(0xb9cbb0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // push to far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(min(h * 1.6, 1.0), 0.7)) : mix(horizon, bottom, min(-h * 4.0, 1.0));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
