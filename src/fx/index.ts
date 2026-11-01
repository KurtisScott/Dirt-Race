import * as THREE from 'three';
import type { GameContext } from '../core/context';
import { events } from '../core/events';
import { clamp } from '../core/math';
import type { RacerId, SurfaceType, System } from '../core/types';
import type { VehicleState } from '../vehicles/types';
import { DebrisSystem } from './debris';
import { ParticleSystem } from './particles';
import { SkidMarks } from './skidMarks';

export { ChaseCamera } from './chaseCamera';

/** What the effects need from the world (World satisfies it). */
export interface FxWorld {
  heightAt(x: number, z: number): number;
  track: { finishS: number; pointAt(s: number, t?: THREE.Vector3): THREE.Vector3; tangentAt(s: number, t?: THREE.Vector3): THREE.Vector3; halfWidthAt(s: number): number };
  summit: THREE.Vector3;
}

/** Pool sizes (fixed GPU buffers); the live caps scale with `quality.preset.detail`. */
const MAX_PARTICLES = 700;
const MAX_DEBRIS = 260;
const MAX_SKIDS = 600;

/** Dust colour per surface (sRGB hex); null = no dust. */
const DUST: Record<SurfaceType, number | null> = {
  asphalt: null,
  dirt: 0xb8946a,
  gravel: 0xb5ada0,
  mud: null,
  sand: 0xe6d3a2,
  water: null,
};

const CONFETTI = [0xff4d4d, 0xffd23f, 0x3fb6ff, 0x6ee06e, 0xff8ad8, 0xffffff, 0xff9a3d];

interface Track {
  v: VehicleState;
  blob: THREE.Mesh;
  prev: THREE.Vector3[];
  had: boolean[];
  acc: number[];
  exhaustAcc: number;
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const SKID_RGB = new THREE.Color(0x141414);

/** Soft radial alpha (white RGB, so the material colour sets the tint). 64², no canvas needed. */
function makeBlobTexture(): THREE.DataTexture {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5;
      const dy = (y + 0.5) / S - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = Math.pow(1 - r, 1.6) * 0.62;
      const i = (y * S + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  const t = new THREE.DataTexture(data, S, S);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Visual effects driven purely by read-only vehicle state + bus events (no physics writes):
 * - one point-sprite system (dust on dirt/gravel/sand, mud spray, water splashes, exhaust, tyre smoke,
 *   landing puffs, summit sparkles),
 * - one instanced mesh of tumbling pieces (hay strands, finish confetti, golden summit flakes),
 * - one ring-buffer mesh of skid marks on asphalt.
 * Three draw calls at most, each hidden when empty. Particle budget = pool × quality detail.
 */
export class Effects implements System {
  readonly particles = new ParticleSystem(MAX_PARTICLES);
  readonly debris = new DebrisSystem(MAX_DEBRIS);
  readonly skids = new SkidMarks(MAX_SKIDS);
  private tracked: Track[] = [];
  private world: FxWorld | null = null;
  private detail = 1;
  private offs: (() => void)[] = [];
  private pending: { at: number; fn: () => void }[] = [];
  private time = 0;
  private bufSize = new THREE.Vector2();
  // Blob shadow under each car when real shadows are off (Low): grounds the car, one tiny draw each.
  private blobTex = makeBlobTexture();
  private blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private blobMat = new THREE.MeshBasicMaterial({
    map: this.blobTex,
    transparent: true,
    depthWrite: false,
    color: 0x000000,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });

  constructor(private ctx: GameContext) {
    const scene = ctx.renderer.scene;
    scene.add(this.particles.points, this.debris.mesh, this.skids.mesh);
    this.applyQuality();
    this.offs.push(
      events.on('quality:changed', () => this.applyQuality()),
      events.on('vehicle:landed', ({ racer, impact }) => this.onLanded(racer, impact)),
      events.on('obstacle:hit', (e) => this.onObstacle(e.kind, e.racer, e.x, e.y, e.z)),
      events.on('animal:bump', (e) => this.puff(e.x, this.groundY(e.x, e.z) + 0.3, e.z, 0xc9b28a, 8, 1.2)),
      events.on('race:finish', ({ racer, winner }) => this.onFinish(racer, winner)),
      events.on('race:summit', ({ racer }) => this.onSummit(racer)),
      events.on('phase:changed', ({ to }) => {
        if (to === 'spin' || to === 'title') this.clear();
      }),
    );
  }

  /** The course, for ground height (settling debris) and the finish/summit positions. */
  setWorld(world: FxWorld): void {
    this.world = world;
  }

  track(v: VehicleState): void {
    const blob = new THREE.Mesh(this.blobGeo, this.blobMat);
    blob.name = 'fx-blob-shadow';
    blob.renderOrder = 1;
    blob.matrixAutoUpdate = false;
    blob.visible = !this.ctx.quality.preset.shadows;
    this.ctx.renderer.scene.add(blob);
    this.tracked.push({ v, blob, prev: [0, 1, 2, 3].map(() => new THREE.Vector3()), had: [false, false, false, false], acc: [0, 0, 0, 0], exhaustAcc: 0 });
  }
  untrack(v: VehicleState): void {
    for (const t of this.tracked) if (t.v === v) t.blob.removeFromParent();
    this.tracked = this.tracked.filter((t) => t.v !== v);
  }

  /** Remove every live particle, piece and mark (new race). */
  clear(): void {
    this.particles.clear();
    this.debris.clear();
    this.skids.clear();
    this.pending.length = 0;
  }

  dispose(): void {
    for (const off of this.offs) off();
    for (const t of this.tracked) t.blob.removeFromParent();
    this.tracked = [];
    this.blobGeo.dispose();
    this.blobMat.dispose();
    this.blobTex.dispose();
    this.particles.points.removeFromParent();
    this.debris.mesh.removeFromParent();
    this.skids.mesh.removeFromParent();
    this.particles.dispose();
    this.debris.dispose();
    this.skids.dispose();
  }

  private applyQuality(): void {
    const q = this.ctx.quality.preset;
    this.detail = q.detail;
    this.particles.limit = Math.round(MAX_PARTICLES * q.detail);
    this.debris.limit = Math.round(MAX_DEBRIS * Math.max(0.5, q.detail));
    for (const t of this.tracked) t.blob.visible = !q.shadows;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.time += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= this.time) {
        const fn = this.pending[i].fn;
        this.pending.splice(i, 1);
        fn();
      }
    }
    for (const t of this.tracked) {
      this.emitFor(t, dt);
      if (t.blob.visible) this.placeBlob(t);
    }
    const r = this.ctx.renderer;
    r.renderer.getDrawingBufferSize(this.bufSize);
    // Cap on-screen sprite size: big overlapping sprites are what costs fill-rate on old iPads.
    this.particles.setView(this.bufSize.y, r.camera.fov, 60 + 140 * this.detail);
    this.particles.update(dt);
    this.debris.update(dt, this.world ? (x, z) => this.world!.heightAt(x, z) : undefined);
    this.skids.update();
  }

  // ------------------------------------------------------------------ per-vehicle emitters

  private emitFor(t: Track, dt: number): void {
    const v = t.v;
    const speed = Math.abs(v.speed);
    const fwd = v.forward;
    _side.set(fwd.z, 0, -fwd.x).normalize();
    const d = this.detail;
    const tyreHalf = clamp(v.spec.wheelRadius * 0.38, 0.11, 0.3);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const rear = i >= 2;
      if (!w.contact) {
        t.had[i] = false;
        continue;
      }
      const surf = w.surface;
      // ---- skid marks (asphalt) + tyre smoke
      if (surf === 'asphalt' && w.slip > 0.4 && speed > 2) {
        if (t.had[i] && t.prev[i].distanceToSquared(w.point) > 0.04) {
          _p.copy(w.point);
          _p.y += 0.03;
          _v.copy(t.prev[i]);
          _v.y += 0.03;
          this.skids.add(_v, _p, _side, tyreHalf, clamp(0.35 + w.slip * 0.5, 0, 0.8), SKID_RGB);
          t.prev[i].copy(w.point);
        } else if (!t.had[i]) {
          t.prev[i].copy(w.point);
        }
        t.had[i] = true;
        if (rear) this.emitRate(t, i, dt, 14 * w.slip * d, () => this.smoke(w.point, v));
      } else {
        t.had[i] = false;
      }
      // ---- surface particles
      const dust = DUST[surf];
      if (dust !== null && speed > 2.5) {
        // Rear wheels make the trail; fronts only when sliding.
        const rate = (rear ? 1 : w.slip) * (speed * 1.1 + w.slip * 25) * d * (surf === 'sand' ? 1.25 : surf === 'gravel' ? 0.8 : 1);
        this.emitRate(t, i, dt, rate, () => this.dust(w.point, v, dust, speed));
      } else if (surf === 'mud' && (speed > 1.5 || (v.input.throttle > 0.3 && w.slip > 0.2))) {
        const rate = (rear ? 1 : 0.5) * (speed * 2 + v.input.throttle * 14) * d;
        this.emitRate(t, i, dt, rate, () => this.mud(w.point, v));
      } else if (surf === 'water' && speed > 1.2) {
        const rate = (speed * 3 + 6) * d;
        this.emitRate(t, i, dt, rate, () => this.splash(w.point, v, speed));
      }
    }
    // ---- exhaust: soft puffs, more when accelerating from low speed.
    if (v.wheelsOnGround > 0 || speed > 0.5) {
      const rate = (2 + v.input.throttle * (speed < 12 ? 16 : 5)) * d;
      t.exhaustAcc += rate * dt;
      if (t.exhaustAcc > 4) t.exhaustAcc = 4;
      while (t.exhaustAcc >= 1) {
        t.exhaustAcc -= 1;
        this.exhaust(v);
      }
    }
  }

  /** Lay the blob shadow on the ground under the car, tilted to the terrain, fading with height. */
  private placeBlob(t: Track): void {
    const v = t.v;
    const w = this.world;
    const x = v.position.x;
    const z = v.position.z;
    const gy = w ? w.heightAt(x, z) : v.position.y - 0.6;
    const d = 1.2;
    const nx = w ? (w.heightAt(x - d, z) - w.heightAt(x + d, z)) / (2 * d) : 0;
    const nz = w ? (w.heightAt(x, z - d) - w.heightAt(x, z + d)) / (2 * d) : 0;
    _n.set(nx, 1, nz).normalize();
    const yaw = Math.atan2(v.forward.x, v.forward.z);
    _q.setFromUnitVectors(_up, _n).multiply(_q2.setFromAxisAngle(_up, yaw));
    // Spread out (and so look fainter) as the car jumps higher.
    const h = Math.max(0, v.position.y - gy - v.spec.size.height * 0.5);
    const spread = 1 + clamp(h / 4, 0, 0.85);
    _s.set(v.spec.size.width * 1.35 * spread, 1, v.spec.size.length * 1.2 * spread);
    _p.set(x, gy + 0.06, z);
    t.blob.matrix.compose(_p, _q, _s);
    t.blob.matrixWorldNeedsUpdate = true;
  }

  private emitRate(t: Track, i: number, dt: number, rate: number, fn: () => void): void {
    t.acc[i] += rate * dt;
    if (t.acc[i] > 4) t.acc[i] = 4; // never a burst after a hitch
    while (t.acc[i] >= 1) {
      t.acc[i] -= 1;
      fn();
    }
  }

  // ------------------------------------------------------------------ particle recipes

  private dust(at: THREE.Vector3, v: VehicleState, hex: number, speed: number): void {
    const r = Math.random;
    _c.setHex(hex).multiplyScalar(0.85 + r() * 0.3);
    this.particles.spawn({
      x: at.x + (r() - 0.5) * 0.4,
      y: at.y + 0.15,
      z: at.z + (r() - 0.5) * 0.4,
      vx: -v.forward.x * speed * 0.15 + (r() - 0.5) * 1.6,
      vy: 0.6 + r() * 1.2,
      vz: -v.forward.z * speed * 0.15 + (r() - 0.5) * 1.6,
      life: 0.9 + r() * 0.9,
      size0: 0.5 + r() * 0.3,
      size1: 2.4 + r() * 1.6 + speed * 0.05,
      color: _c,
      alpha: 0.32,
      gravity: -0.02,
      drag: 1.6,
    });
  }

  private mud(at: THREE.Vector3, v: VehicleState): void {
    const r = Math.random;
    _c.setHex(r() < 0.5 ? 0x4a3420 : 0x5e4429);
    const kick = 2.5 + Math.abs(v.speed) * 0.25 + v.input.throttle * 2;
    this.particles.spawn({
      x: at.x,
      y: at.y + 0.2,
      z: at.z,
      vx: -v.forward.x * kick + (r() - 0.5) * 2,
      vy: 2.5 + r() * 3,
      vz: -v.forward.z * kick + (r() - 0.5) * 2,
      life: 0.6 + r() * 0.4,
      size0: 0.18 + r() * 0.15,
      size1: 0.3,
      color: _c,
      alpha: 0.95,
      gravity: 1,
      drag: 0.3,
    });
  }

  private splash(at: THREE.Vector3, v: VehicleState, speed: number): void {
    const r = Math.random;
    _c.setHex(r() < 0.6 ? 0xeaf6ff : 0xa9d3ea);
    const side = r() < 0.5 ? -1 : 1;
    this.particles.spawn({
      x: at.x,
      y: at.y + 0.25,
      z: at.z,
      vx: _side.x * side * (1 + speed * 0.25) * r() + v.forward.x * speed * 0.3,
      vy: 2 + r() * 2 + speed * 0.15,
      vz: _side.z * side * (1 + speed * 0.25) * r() + v.forward.z * speed * 0.3,
      life: 0.55 + r() * 0.35,
      size0: 0.3 + r() * 0.2,
      size1: 0.9 + r() * 0.5,
      color: _c,
      alpha: 0.75,
      gravity: 0.9,
      drag: 0.4,
    });
  }

  private smoke(at: THREE.Vector3, v: VehicleState): void {
    const r = Math.random;
    _c.setHex(0xdadada);
    this.particles.spawn({
      x: at.x,
      y: at.y + 0.2,
      z: at.z,
      vx: -v.forward.x * 1.5 + (r() - 0.5),
      vy: 0.6 + r() * 0.6,
      vz: -v.forward.z * 1.5 + (r() - 0.5),
      life: 1 + r() * 0.6,
      size0: 0.5,
      size1: 2.6,
      color: _c,
      alpha: 0.3,
      gravity: -0.03,
      drag: 1.4,
    });
  }

  private exhaust(v: VehicleState): void {
    const r = Math.random;
    const half = v.spec.size.length * 0.5;
    // Rear of the body, low, slightly to one side (tailpipe).
    _p.copy(v.position).addScaledVector(v.forward, -half - 0.1).addScaledVector(_side, 0.35);
    _p.y += 0.1 - v.spec.size.height * 0.15;
    _c.setHex(0xb8b8b8);
    this.particles.spawn({
      x: _p.x,
      y: _p.y,
      z: _p.z,
      vx: -v.forward.x * 1.2 + (r() - 0.5) * 0.4,
      vy: 0.4 + r() * 0.3,
      vz: -v.forward.z * 1.2 + (r() - 0.5) * 0.4,
      life: 0.6 + r() * 0.4,
      size0: 0.15,
      size1: 0.8,
      color: _c,
      alpha: 0.22,
      gravity: -0.03,
      drag: 1.5,
    });
  }

  /** Ring of dust (landings, bumps, boulder hits). */
  private puff(x: number, y: number, z: number, hex: number, n: number, spread: number, upward = 1): void {
    const r = Math.random;
    const count = Math.max(3, Math.round(n * (0.5 + this.detail * 0.5)));
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + r() * 0.5;
      const s = spread * (1.5 + r() * 2);
      _c.setHex(hex).multiplyScalar(0.85 + r() * 0.3);
      this.particles.spawn({
        x: x + Math.cos(a) * 0.6,
        y,
        z: z + Math.sin(a) * 0.6,
        vx: Math.cos(a) * s,
        vy: (0.5 + r() * 1.2) * upward,
        vz: Math.sin(a) * s,
        life: 1 + r() * 0.8,
        size0: 0.8,
        size1: 3 + r() * 1.5,
        color: _c,
        alpha: 0.38,
        gravity: -0.01,
        drag: 2.2,
      });
    }
  }

  private groundY(x: number, z: number): number {
    return this.world ? this.world.heightAt(x, z) : 0;
  }

  // ------------------------------------------------------------------ event effects

  private vehicle(racer: RacerId): VehicleState | undefined {
    return this.tracked.find((t) => t.v.racer === racer)?.v;
  }

  private onLanded(racer: RacerId, impact: number): void {
    const v = this.vehicle(racer);
    if (!v) return;
    const surf = v.surface;
    const hex = surf === 'water' ? 0xeaf6ff : surf === 'mud' ? 0x5e4429 : surf === 'asphalt' ? 0xcfcac2 : (DUST[surf] ?? 0xb8946a);
    const n = clamp(6 + impact * 2.2, 8, 26);
    this.puff(v.position.x, this.groundY(v.position.x, v.position.z) + 0.3, v.position.z, hex, n, clamp(impact / 6, 0.6, 1.6));
  }

  private onObstacle(kind: string, racer: RacerId, x: number, y: number, z: number): void {
    const r = Math.random;
    const v = this.vehicle(racer);
    const vx = v ? v.forward.x * Math.abs(v.speed) : 0;
    const vz = v ? v.forward.z * Math.abs(v.speed) : 0;
    if (/hay|bale/.test(kind)) {
      const n = Math.round(26 * (0.5 + this.detail * 0.5));
      for (let k = 0; k < n; k++) {
        _c.setHex(r() < 0.5 ? 0xe8c75a : r() < 0.5 ? 0xd4a93c : 0xf2dc8a);
        this.debris.spawn({
          x: x + (r() - 0.5) * 1.2,
          y: y + 0.3 + r() * 0.6,
          z: z + (r() - 0.5) * 1.2,
          vx: vx * 0.35 + (r() - 0.5) * 6,
          vy: 3 + r() * 4,
          vz: vz * 0.35 + (r() - 0.5) * 6,
          life: 2.5 + r() * 1.5,
          w: 0.05,
          l: 0.35 + r() * 0.25,
          color: _c,
          spin: 6 + r() * 10,
          drag: 0.9,
          gravity: 0.7,
        });
      }
      this.puff(x, y, z, 0xe0cf8a, 8, 0.8);
    } else if (/cone/.test(kind)) {
      this.puff(x, this.groundY(x, z) + 0.2, z, 0xc9b28a, 4, 0.6);
    } else {
      this.puff(x, this.groundY(x, z) + 0.4, z, 0xb5ada0, 10, 1);
    }
  }

  private onFinish(racer: RacerId, winner: boolean): void {
    const w = this.world;
    if (!w) return;
    const s = w.track.finishS;
    const at = w.track.pointAt(s, new THREE.Vector3());
    const tan = w.track.tangentAt(s, new THREE.Vector3());
    const hw = w.track.halfWidthAt(s) + 1.2;
    // Confetti cannons on both gantry posts, plus a shower over the line. Smaller for the 2nd finisher.
    const big = winner || racer === 'player';
    const burst = (scale: number): void => {
      for (const side of [-1, 1]) {
        const px = at.x - tan.z * hw * side;
        const pz = at.z + tan.x * hw * side;
        this.confetti(px, w.heightAt(px, pz) + 5.2, pz, tan.z * side, -tan.x * side, Math.round(55 * scale));
      }
    };
    burst(big ? 1 : 0.4);
    if (big) this.later(0.45, () => burst(0.7));
    if (big) this.later(1.0, () => burst(0.5));
  }

  /** `dirX/dirZ` = horizontal direction the cannon points (towards the road centre). */
  private confetti(x: number, y: number, z: number, dirX: number, dirZ: number, n: number): void {
    const r = Math.random;
    const count = Math.round(n * (0.5 + this.detail * 0.5));
    for (let k = 0; k < count; k++) {
      _c.setHex(CONFETTI[(r() * CONFETTI.length) | 0]);
      const sp = 4 + r() * 6;
      this.debris.spawn({
        x,
        y,
        z,
        vx: dirX * sp + (r() - 0.5) * 4,
        vy: 5 + r() * 7,
        vz: dirZ * sp + (r() - 0.5) * 4,
        life: 3.5 + r() * 2,
        w: 0.16,
        l: 0.24,
        color: _c,
        spin: 5 + r() * 8,
        drag: 1.6,
        gravity: 0.35,
      });
    }
  }

  private onSummit(racer: RacerId): void {
    const w = this.world;
    if (!w) return;
    const r = Math.random;
    const top = w.summit;
    const v = this.vehicle(racer);
    // Golden flakes from the flag top, a fountain of sparkles around the pole, and a ring of puffs at the car.
    const flakes = (scale: number): void => {
      const n = Math.round(70 * scale * (0.5 + this.detail * 0.5));
      for (let k = 0; k < n; k++) {
        _c.setHex(r() < 0.6 ? 0xffd34d : r() < 0.5 ? 0xffb81c : 0xfff2b0);
        const a = r() * Math.PI * 2;
        const sp = 2 + r() * 5;
        this.debris.spawn({
          x: top.x,
          y: top.y + 13.5,
          z: top.z,
          vx: Math.cos(a) * sp,
          vy: 3 + r() * 6,
          vz: Math.sin(a) * sp,
          life: 4 + r() * 2,
          w: 0.18,
          l: 0.18,
          color: _c,
          spin: 4 + r() * 6,
          drag: 1.4,
          gravity: 0.3,
        });
      }
      const m = Math.round(40 * scale * this.detail);
      for (let k = 0; k < m; k++) {
        _c.setHex(r() < 0.5 ? 0xffe680 : 0xffffff);
        const a = r() * Math.PI * 2;
        this.particles.spawn({
          x: top.x + Math.cos(a) * 0.5,
          y: top.y + 1 + r() * 13,
          z: top.z + Math.sin(a) * 0.5,
          vx: Math.cos(a) * (1 + r() * 2),
          vy: 1 + r() * 2,
          vz: Math.sin(a) * (1 + r() * 2),
          life: 1.2 + r() * 1,
          size0: 0.5,
          size1: 0.1,
          color: _c,
          alpha: 0.95,
          gravity: -0.05,
          drag: 0.8,
        });
      }
    };
    flakes(racer === 'player' ? 1 : 0.4);
    if (racer === 'player') {
      this.later(0.6, () => flakes(0.6));
      if (v) this.puff(v.position.x, this.groundY(v.position.x, v.position.z) + 0.3, v.position.z, 0xffe8a0, 14, 1.4);
    }
  }

  private later(sec: number, fn: () => void): void {
    this.pending.push({ at: this.time + sec, fn });
  }
}

