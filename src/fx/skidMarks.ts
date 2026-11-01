import * as THREE from 'three';

/**
 * Tyre marks: a ring buffer of quads in ONE mesh (one draw call). Each wheel that slides adds a quad
 * from its previous contact point to the current one; when the buffer is full the oldest marks are
 * overwritten. Older marks fade (alpha is rewritten only for the few quads that cross a fade step).
 */
const FADE_STEPS = 4;

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly max: number;
  private next = 0;
  private used = 0;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private material: THREE.MeshBasicMaterial;
  private dirty = false;

  constructor(max: number) {
    this.max = max;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(max * 4 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('color', this.col);
    const idx = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'fx-skids';
    this.mesh.visible = false;
  }

  /**
   * Add one quad: a → b (world points on the ground), `side` is the unit vector across the tyre,
   * `half` the half-width. `alpha` 0..1, `rgb` the mark colour (linear).
   */
  add(a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, half: number, alpha: number, rgb: THREE.Color): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.used = Math.min(this.max, this.used + 1);
    const p = this.pos.array as Float32Array;
    const o = i * 12;
    const sx = side.x * half;
    const sz = side.z * half;
    p[o] = a.x - sx;
    p[o + 1] = a.y;
    p[o + 2] = a.z - sz;
    p[o + 3] = a.x + sx;
    p[o + 4] = a.y;
    p[o + 5] = a.z + sz;
    p[o + 6] = b.x - sx;
    p[o + 7] = b.y;
    p[o + 8] = b.z - sz;
    p[o + 9] = b.x + sx;
    p[o + 10] = b.y;
    p[o + 11] = b.z + sz;
    const c = this.col.array as Float32Array;
    for (let k = 0; k < 4; k++) {
      c[i * 16 + k * 4] = rgb.r;
      c[i * 16 + k * 4 + 1] = rgb.g;
      c[i * 16 + k * 4 + 2] = rgb.b;
      c[i * 16 + k * 4 + 3] = alpha;
    }
    // Fade: the quads that just crossed into an older quarter of the buffer lose some opacity.
    for (let s = 1; s < FADE_STEPS; s++) {
      const j = (i - Math.floor((this.max * s) / FADE_STEPS) + this.max) % this.max;
      if (s * (this.max / FADE_STEPS) > this.used) break;
      for (let k = 0; k < 4; k++) c[j * 16 + k * 4 + 3] *= 0.7;
    }
    this.dirty = true;
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.visible = this.used > 0;
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
  }

  clear(): void {
    (this.pos.array as Float32Array).fill(0);
    (this.col.array as Float32Array).fill(0);
    this.used = 0;
    this.next = 0;
    this.dirty = true;
    this.update();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
