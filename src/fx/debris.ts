import * as THREE from 'three';

/**
 * Pooled tumbling flat pieces (hay strands, confetti, golden flakes) as ONE InstancedMesh.
 * Ring buffer, no allocations after construction; hidden when nothing is alive.
 */
export interface DebrisSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  /** Piece size (x = width, y = length), metres. */
  w: number;
  l: number;
  color: THREE.Color;
  /** Tumble rate, rad/s. */
  spin: number;
  /** Air drag per second (confetti ~2.5 flutters, hay ~0.6). */
  drag: number;
  gravity: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const G = 9.81;

export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh;
  limit: number;
  private readonly max: number;
  private next = 0;
  private alive = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private axis: Float32Array;
  private angle: Float32Array;
  private spin: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private dims: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private material: THREE.MeshLambertMaterial;

  constructor(max: number) {
    this.max = max;
    this.limit = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.axis = new Float32Array(max * 3);
    this.angle = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.dims = new Float32Array(max * 2);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    const geo = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, emissive: 0x222222 });
    this.mesh = new THREE.InstancedMesh(geo, this.material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'fx-debris';
    _m.makeScale(0, 0, 0);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < max; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, white);
    }
  }

  get count(): number {
    return this.alive;
  }

  spawn(d: DebrisSpawn): void {
    if (this.alive >= this.limit) return;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.life[i] <= 0) this.alive++;
    this.pos[i * 3] = d.x;
    this.pos[i * 3 + 1] = d.y;
    this.pos[i * 3 + 2] = d.z;
    this.vel[i * 3] = d.vx;
    this.vel[i * 3 + 1] = d.vy;
    this.vel[i * 3 + 2] = d.vz;
    _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.axis[i * 3] = _axis.x;
    this.axis[i * 3 + 1] = _axis.y;
    this.axis[i * 3 + 2] = _axis.z;
    this.angle[i] = Math.random() * 6.28;
    this.spin[i] = d.spin;
    this.life[i] = d.life;
    this.maxLife[i] = d.life;
    this.dims[i * 2] = d.w;
    this.dims[i * 2 + 1] = d.l;
    this.drag[i] = d.drag;
    this.grav[i] = d.gravity;
    this.mesh.setColorAt(i, d.color);
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** `groundAt(x, z)` keeps pieces from falling through the terrain (they settle and fade). */
  update(dt: number, groundAt?: (x: number, z: number) => number): void {
    if (this.alive === 0) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      const l = (this.life[i] -= dt);
      if (l <= 0) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      alive++;
      const k = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[k] *= damp;
      this.vel[k + 1] = this.vel[k + 1] * damp - G * this.grav[i] * dt;
      this.vel[k + 2] *= damp;
      const x = (this.pos[k] += this.vel[k] * dt);
      let y = (this.pos[k + 1] += this.vel[k + 1] * dt);
      const z = (this.pos[k + 2] += this.vel[k + 2] * dt);
      let spin = this.spin[i];
      if (groundAt) {
        const gy = groundAt(x, z) + 0.03;
        if (y < gy) {
          y = this.pos[k + 1] = gy;
          this.vel[k] *= 0.3;
          this.vel[k + 2] *= 0.3;
          this.vel[k + 1] = 0;
          spin = this.spin[i] = 0;
        }
      }
      this.angle[i] += spin * dt;
      _axis.set(this.axis[k], this.axis[k + 1], this.axis[k + 2]);
      _q.setFromAxisAngle(_axis, this.angle[i]);
      const t = l / this.maxLife[i];
      const shrink = t < 0.2 ? t / 0.2 : 1;
      _s.set(this.dims[i * 2] * shrink, this.dims[i * 2 + 1] * shrink, 1);
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.alive = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (alive === 0) this.mesh.visible = false;
  }

  clear(): void {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) {
      this.life[i] = 0;
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alive = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
