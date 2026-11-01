import * as THREE from 'three';

/**
 * One pooled GPU point-sprite system for every soft particle (dust, mud spray, splashes, exhaust,
 * landing puffs, sparkles). A single draw call; a ring buffer that overwrites the oldest particle when
 * full, so nothing is ever allocated after construction.
 *
 * Sizes are in metres (converted to pixels in the vertex shader), colours are linear RGB.
 */
export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds. */
  life: number;
  /** Diameter at birth / death, metres. */
  size0: number;
  size1: number;
  color: THREE.Color;
  /** Peak opacity (fades out over life, quick fade-in). */
  alpha: number;
  /** Multiplier on gravity (0 = floats, 1 = ballistic, negative = rises). */
  gravity: number;
  /** Velocity damping per second (0 = none). */
  drag: number;
}

const G = 9.81;

export class ParticleSystem {
  readonly points: THREE.Points;
  /** Active cap (quality scales it); the pool itself is fixed at `max`. */
  limit: number;
  private readonly max: number;
  private next = 0;
  private alive = 0;
  // Per-particle simulation state.
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private alpha0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  // GPU attributes.
  private pos: THREE.BufferAttribute;
  private size: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private material: THREE.ShaderMaterial;

  constructor(max: number) {
    this.max = max;
    this.limit = max;
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.size = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aSize', this.size);
    geo.setAttribute('aColor', this.col);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uScale: { value: 400 },
        uMaxPx: { value: 160 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec4 aColor;
        uniform float uScale;
        uniform float uMaxPx;
        varying vec4 vColor;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float d = -mvPosition.z;
          gl_PointSize = min(aSize * uScale / max(d, 0.1), uMaxPx);
          vColor = aColor;
          // Fade sprites that get right up against the camera (they would fill the screen: fill-rate).
          vColor.a *= smoothstep(0.6, 2.5, d);
          if (aSize <= 0.0) gl_PointSize = 0.0;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        #include <fog_pars_fragment>
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r = dot(c, c);
          float a = vColor.a * (1.0 - smoothstep(0.3, 1.0, r));
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = 'fx-particles';
  }

  get count(): number {
    return this.alive;
  }

  /** Pixel scale for metre-sized sprites: drawing-buffer height / (2·tan(fov/2)). */
  setView(bufferHeight: number, fovDeg: number, maxPx: number): void {
    this.material.uniforms.uScale.value = bufferHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.material.uniforms.uMaxPx.value = maxPx;
  }

  spawn(p: ParticleSpawn): void {
    if (this.alive >= this.limit) return;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.life[i] <= 0) this.alive++;
    const a = this.pos.array as Float32Array;
    a[i * 3] = p.x;
    a[i * 3 + 1] = p.y;
    a[i * 3 + 2] = p.z;
    this.vel[i * 3] = p.vx;
    this.vel[i * 3 + 1] = p.vy;
    this.vel[i * 3 + 2] = p.vz;
    this.life[i] = p.life;
    this.maxLife[i] = p.life;
    this.size0[i] = p.size0;
    this.size1[i] = p.size1;
    this.alpha0[i] = p.alpha;
    this.grav[i] = p.gravity;
    this.drag[i] = p.drag;
    const c = this.col.array as Float32Array;
    c[i * 4] = p.color.r;
    c[i * 4 + 1] = p.color.g;
    c[i * 4 + 2] = p.color.b;
  }

  update(dt: number): void {
    if (this.alive === 0) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    const pos = this.pos.array as Float32Array;
    const size = this.size.array as Float32Array;
    const col = this.col.array as Float32Array;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      const l = (this.life[i] -= dt);
      if (l <= 0) {
        size[i] = 0;
        col[i * 4 + 3] = 0;
        continue;
      }
      alive++;
      const k = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[k] *= damp;
      this.vel[k + 2] *= damp;
      this.vel[k + 1] = this.vel[k + 1] * damp - G * this.grav[i] * dt;
      pos[k] += this.vel[k] * dt;
      pos[k + 1] += this.vel[k + 1] * dt;
      pos[k + 2] += this.vel[k + 2] * dt;
      const t = 1 - l / this.maxLife[i]; // 0 → 1 over life
      size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      // Quick fade-in, long fade-out.
      col[i * 4 + 3] = this.alpha0[i] * Math.min(1, t * 8) * (1 - t) * (1 - t * 0.3);
    }
    this.alive = alive;
    this.pos.needsUpdate = true;
    this.size.needsUpdate = true;
    this.col.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    (this.size.array as Float32Array).fill(0);
    this.size.needsUpdate = true;
    this.alive = 0;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
