import * as THREE from 'three';
import { rng } from '../core/math';
import type { SpawnPoint, SurfaceType } from '../core/types';
import {
  buildCourseLine,
  FINISH_BEFORE_HILL_M,
  HILL_CLIMB_M,
  HILL_FOOT_DEG,
  HILL_MAX_DEG,
  ROAD_HALF_WIDTH,
  SUMMIT_PLATEAU_R,
  type CourseLine,
} from './layout';
import { fbm, smoothstep, valueNoise } from './noise';
import type { Checkpoint, TrackPath, Zone, ZoneId } from './types';

/**
 * Pure data for the real course (no rendering, no physics, no DOM): centre-line, terrain heights,
 * surface map, zones, checkpoints and where every prop/obstacle goes. `RaceCourse` turns this into
 * Rapier colliders and three.js meshes; headless tests can use it directly.
 *
 * Terrain = one regular grid (CELL m) shared by the Rapier heightfield and the visual mesh, so
 * `heightAt` is exact (same triangle split as Rapier: diagonal from (x+, z) to (x, z+)).
 */

export const CELL = 2;
/** Surface map resolution (m). */
const SCELL = 1;
const MARGIN = 88;
/** Distance from the centre-line where the valley walls start rising, and where they top out. */
export const WALL_START = 48;
export const WALL_END = 72;
const WALL_HEIGHT = 24;

export const SURFACE_CODES: SurfaceType[] = ['asphalt', 'dirt', 'gravel', 'mud', 'sand', 'water'];
const SC: Record<SurfaceType, number> = { asphalt: 0, dirt: 1, gravel: 2, mud: 3, sand: 4, water: 5 };

/** Visual terrain layers (texture array order). */
export const LAYERS = ['grass', 'dirt', 'gravel', 'mud', 'sand', 'rock', 'riverbed', 'field'] as const;
export type LayerName = (typeof LAYERS)[number];

export interface Placement {
  x: number;
  z: number;
  y: number;
  yaw: number;
  scale: number;
  /** Variant index / free parameter. */
  v: number;
}

export interface RiverFrame {
  /** Centre of the river on the bridge line. */
  origin: THREE.Vector2;
  /** Unit vector across the river (= direction of travel on the bridge). */
  across: THREE.Vector2;
  /** Unit vector along the river (right of travel at the loop start). */
  along: THREE.Vector2;
  /** Water surface height. */
  water: number;
  /** Bank-top height (road level through the river zone). */
  level: number;
  /** River coordinate (along) of the ford crossing. */
  fordB: number;
  bMin: number;
  bMax: number;
}

export interface ShortcutDef {
  id: 'log-bridge';
  startS: number;
  endS: number;
  points: THREE.Vector3[];
  halfWidth: number;
  maxSpeed: number;
}

export interface BridgeDef {
  /** Centre of the deck (x, deck top y, z) and heading. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Deck length (m) across the river incl. ramps, and half-width. */
  length: number;
  halfWidth: number;
}

export interface RampDef {
  x: number;
  y: number;
  z: number;
  yaw: number;
  halfWidth: number;
  length: number;
  height: number;
}

export interface AnimalSpot {
  kind: 'deer' | 'bear' | 'mouse' | 'duck' | 'croc';
  zone: ZoneId;
  /** Where on the course the crossing happens. */
  s: number;
}

const HW_KEYS: ZoneId[] = ['town', 'farm', 'mud', 'rocky', 'desert', 'river', 'finish', 'hill'];

export class CourseData {
  readonly line: CourseLine;
  readonly length: number;
  readonly zones: Zone[];
  // ---- terrain grid (Rapier heightfield layout: index = i + j * NZ, i along z, j along x)
  readonly x0: number;
  readonly z0: number;
  readonly NX: number;
  readonly NZ: number;
  readonly heights: Float32Array;
  /** Per-node nearest centre-line distance, s and signed lateral (right = +). */
  readonly dist: Float32Array;
  readonly nearS: Float32Array;
  readonly lat: Float32Array;
  // ---- surface map
  private sx0 = 0;
  private sz0 = 0;
  private SNX = 0;
  private SNZ = 0;
  private surf = new Uint8Array(0);
  // ---- centre-line 1D data (every line.step m)
  readonly roadY: Float32Array;
  readonly halfW: Float32Array;
  readonly track: CourseTrack;

  readonly finishS: number;
  readonly summitS: number;
  readonly hillStartS: number;
  readonly hillTop: number;
  readonly summit = new THREE.Vector3();
  readonly river: RiverFrame;
  readonly shortcut: ShortcutDef;
  readonly bridge: BridgeDef;
  readonly ramps: RampDef[] = [];
  readonly checkpoints: Checkpoint[] = [];
  readonly spawns: { player: SpawnPoint; cpu: SpawnPoint };

  // Placements (filled by place*()).
  readonly hay: Placement[] = [];
  readonly cones: Placement[] = [];
  readonly potholes: Placement[] = [];
  readonly boulders: Placement[] = [];
  readonly rocks: Placement[] = [];
  readonly trees: Placement[] = [];
  readonly pines: Placement[] = [];
  readonly bushes: Placement[] = [];
  readonly tufts: Placement[] = [];
  readonly houses: Placement[] = [];
  readonly fences: { a: THREE.Vector2; b: THREE.Vector2; ya: number; yb: number }[] = [];
  readonly animalSpots: AnimalSpot[] = [];

  private hillO = new THREE.Vector2();
  private hillD = new THREE.Vector2();
  private hillProfile: Float32Array; // height every 0.5 m of u
  private keepOut: { x: number; z: number; r: number }[] = [];

  constructor() {
    const line = (this.line = buildCourseLine(2));
    this.length = line.length;
    this.zones = line.zones.map((z) => ({ id: z.id, startS: z.startS, endS: z.endS }));
    const n = line.xs.length;

    // ---- half widths (smooth between zones)
    this.halfW = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const s = k * line.step;
      let w = 0;
      let ws = 0;
      for (const z of this.zones) {
        const wt = this.zoneW(z.id, s, 15);
        w += ROAD_HALF_WIDTH[z.id] * wt;
        ws += wt;
      }
      this.halfW[k] = ws > 0 ? w / ws : 6;
    }

    // ---- key distances
    this.hillStartS = line.tagS.hill!;
    this.finishS = this.hillStartS - FINISH_BEFORE_HILL_M;
    this.summitS = this.hillStartS + HILL_CLIMB_M + SUMMIT_PLATEAU_R;

    // ---- hill frame + profile
    const hk = Math.round(this.hillStartS / line.step);
    this.hillO.set(line.xs[hk], line.zs[hk]);
    this.hillD.set(line.xs[hk + 1] - line.xs[hk], line.zs[hk + 1] - line.zs[hk]).normalize();
    this.hillProfile = new Float32Array(Math.ceil((HILL_CLIMB_M + 1) / 0.5) + 1);
    let h = 0;
    for (let i = 1; i < this.hillProfile.length; i++) {
      const u = (i - 0.5) * 0.5;
      h += Math.tan(hillAngle(u) * (Math.PI / 180)) * 0.5;
      this.hillProfile[i] = h;
    }
    this.hillTop = h;

    // ---- road elevation profile along s (before the hill mound / river carve)
    this.roadY = new Float32Array(n);
    const raw = new Float32Array(n);
    for (let k = 0; k < n; k++) raw[k] = baseT(line.xs[k], line.zs[k]);
    const sm = boxBlur(boxBlur(raw, 20), 20);
    const riverZ = this.zone('river');
    const riverLevel = sm[Math.round(riverZ.startS / line.step)] - 0.4;
    const footY = sm[Math.round(this.zone('finish').startS / line.step)];
    for (let k = 0; k < n; k++) {
      const s = k * line.step;
      let y = sm[k];
      // Mud pit: the road sinks into a shallow pit.
      y -= 0.55 * this.mudPitW(s);
      // Desert dunes across the road.
      const dw = this.zoneW('desert', s, -25);
      if (dw > 0) y += 1.0 * dw * Math.sin(((s - this.zone("desert").startS) / 46) * Math.PI * 2);
      // River section held level; finish straight + hill foot level too.
      y = THREE.MathUtils.lerp(y, riverLevel, this.zoneW('river', s, 40));
      const fw = Math.max(this.zoneW('finish', s, 40), this.zoneW('hill', s, 40));
      y = THREE.MathUtils.lerp(y, footY, fw);
      this.roadY[k] = y;
    }

    // ---- river frame (from the Ω-loop geometry)
    const loopS = line.tagS.riverLoop0! + 40;
    const lk = Math.round(loopS / line.step);
    const P0 = new THREE.Vector2(line.xs[lk], line.zs[lk]);
    const D = new THREE.Vector2(line.xs[lk + 1] - line.xs[lk], line.zs[lk + 1] - line.zs[lk]).normalize();
    const R = new THREE.Vector2(-D.y, D.x); // right of travel (x,z): (−tz, tx)
    const fk = Math.round((line.tagS.ford! + 23) / line.step);
    const M = new THREE.Vector2(line.xs[fk], line.zs[fk]).sub(P0);
    const fwd = M.dot(D);
    const fordB = M.dot(R);
    this.river = {
      origin: P0.clone().addScaledVector(D, fwd),
      across: D.clone(),
      along: R.clone(),
      level: riverLevel,
      water: riverLevel - 0.5,
      fordB,
      bMin: -38,
      bMax: fordB + 38,
    };

    // ---- terrain grid bounds
    let minx = Infinity;
    let maxx = -Infinity;
    let minz = Infinity;
    let maxz = -Infinity;
    for (let k = 0; k < n; k++) {
      minx = Math.min(minx, line.xs[k]);
      maxx = Math.max(maxx, line.xs[k]);
      minz = Math.min(minz, line.zs[k]);
      maxz = Math.max(maxz, line.zs[k]);
    }
    this.x0 = Math.floor((minx - MARGIN) / CELL) * CELL;
    this.z0 = Math.floor((minz - MARGIN) / CELL) * CELL;
    this.NX = Math.ceil((maxx + MARGIN - this.x0) / CELL) + 1;
    this.NZ = Math.ceil((maxz + MARGIN - this.z0) / CELL) + 1;
    const N = this.NX * this.NZ;
    this.heights = new Float32Array(N);
    this.dist = new Float32Array(N).fill(1e6);
    this.nearS = new Float32Array(N);
    this.lat = new Float32Array(N);
    this.buildDistanceField();

    // ---- shortcut (log bridge) — straight across the Ω-loop
    const scStart = line.tagS.riverLoop0! + 26;
    const scEnd = line.tagEndS.riverLoopEnd! + 12;
    const a = this.centre(scStart);
    const b = this.centre(scEnd);
    const scPts: THREE.Vector3[] = [];
    const nSc = Math.ceil(a.distanceTo(b) / 6);
    for (let i = 0; i <= nSc; i++) {
      const t = i / nSc;
      scPts.push(new THREE.Vector3(a.x + (b.x - a.x) * t, 0, a.y + (b.y - a.y) * t));
    }
    this.shortcut = { id: 'log-bridge', startS: scStart, endS: scEnd, points: scPts, halfWidth: 1.6, maxSpeed: 11 };

    this.buildHeights();
    // Track points take their height from the final terrain (exactly what the wheels touch).
    this.track = new CourseTrack(this);
    for (const p of scPts) p.y = this.heightAt(p.x, p.z);

    // Bridge deck over the river on the shortcut line.
    const deckY = this.river.level + 0.35;
    const o = this.river.origin;
    this.bridge = { x: o.x, y: deckY, z: o.y, yaw: Math.atan2(D.x, D.y), length: 22, halfWidth: 1.9 };
    for (const p of scPts) {
      const da = Math.abs((p.x - o.x) * D.x + (p.z - o.y) * D.y);
      if (da < this.bridge.length / 2) p.y = deckY;
    }

    this.buildSurfaces();

    // ---- summit, spawns, checkpoints
    this.summit.copy(this.track.pointAt(this.summitS));
    this.spawns = { player: this.spawnAt(8, -2.8), cpu: this.spawnAt(8, 2.8) };

    this.placeFeatures();
    for (let s = 300; s < this.finishS - 60; s += 300) {
      let cs = s;
      // Never respawn onto a ramp, boulder or the water.
      for (let tries = 0; tries < 12 && !this.clearForRespawn(cs); tries++) cs += 8;
      this.checkpoints.push({ index: this.checkpoints.length, s: cs, respawn: this.spawnAt(cs, 0) });
    }
  }

  // ------------------------------------------------------------------ queries

  zone(id: ZoneId): Zone {
    return this.zones.find((z) => z.id === id)!;
  }

  zoneAt(s: number): Zone {
    for (const z of this.zones) if (s < z.endS) return z;
    return this.zones[this.zones.length - 1];
  }

  /** 0..1 membership of zone `id` at s, with smooth ramps of `ramp` m (negative = ramp inside the zone). */
  zoneW(id: ZoneId, s: number, ramp: number): number {
    const z = this.zones.find((zz) => zz.id === id);
    if (!z) return 0;
    if (ramp >= 0) return smoothstep(z.startS - ramp, z.startS + 0.001, s) * (1 - smoothstep(z.endS - 0.001, z.endS + ramp, s));
    const r = -ramp;
    return smoothstep(z.startS, z.startS + r, s) * (1 - smoothstep(z.endS - r, z.endS, s));
  }

  mudPitW(s: number): number {
    const z = this.zone('mud');
    return smoothstep(z.startS + 30, z.startS + 52, s) * (1 - smoothstep(z.endS - 52, z.endS - 30, s));
  }

  halfWidthAt(s: number): number {
    const k = THREE.MathUtils.clamp(Math.round(s / this.line.step), 0, this.halfW.length - 1);
    return this.halfW[k];
  }

  centre(s: number, target = new THREE.Vector2()): THREE.Vector2 {
    const st = this.line.step;
    const f = THREE.MathUtils.clamp(s / st, 0, this.line.xs.length - 1.0001);
    const k = Math.floor(f);
    const t = f - k;
    return target.set(
      this.line.xs[k] + (this.line.xs[k + 1] - this.line.xs[k]) * t,
      this.line.zs[k] + (this.line.zs[k + 1] - this.line.zs[k]) * t,
    );
  }

  /** Exact physics ground height (same triangulation as the Rapier heightfield). */
  heightAt(x: number, z: number): number {
    const fx = (x - this.x0) / CELL;
    const fz = (z - this.z0) / CELL;
    const j = THREE.MathUtils.clamp(Math.floor(fx), 0, this.NX - 2);
    const i = THREE.MathUtils.clamp(Math.floor(fz), 0, this.NZ - 2);
    const tx = THREE.MathUtils.clamp(fx - j, 0, 1);
    const tz = THREE.MathUtils.clamp(fz - i, 0, 1);
    const H = this.heights;
    const NZ = this.NZ;
    const h00 = H[i + j * NZ];
    const h01 = H[i + (j + 1) * NZ]; // x+
    const h10 = H[i + 1 + j * NZ]; // z+
    if (tx + tz <= 1) return h00 + (h01 - h00) * tx + (h10 - h00) * tz;
    const h11 = H[i + 1 + (j + 1) * NZ];
    return h11 + (h10 - h11) * (1 - tx) + (h01 - h11) * (1 - tz);
  }

  surfaceAt(x: number, z: number): SurfaceType {
    const j = Math.floor((x - this.sx0) / SCELL);
    const i = Math.floor((z - this.sz0) / SCELL);
    if (i < 0 || j < 0 || i >= this.SNZ || j >= this.SNX) return 'dirt';
    return SURFACE_CODES[this.surf[i + j * this.SNZ]];
  }

  /** Bilinear nearest-centre-line distance, plus the nearest node's s and lateral. */
  fieldsAt(x: number, z: number, out = { d: 0, s: 0, lat: 0 }): { d: number; s: number; lat: number } {
    const fx = THREE.MathUtils.clamp((x - this.x0) / CELL, 0, this.NX - 1.001);
    const fz = THREE.MathUtils.clamp((z - this.z0) / CELL, 0, this.NZ - 1.001);
    const j = Math.floor(fx);
    const i = Math.floor(fz);
    const tx = fx - j;
    const tz = fz - i;
    const NZ = this.NZ;
    const D = this.dist;
    const a = i + j * NZ;
    out.d = (D[a] * (1 - tx) + D[a + NZ] * tx) * (1 - tz) + (D[a + 1] * (1 - tx) + D[a + 1 + NZ] * tx) * tz;
    const near = (tz < 0.5 ? 0 : 1) + (tx < 0.5 ? 0 : NZ) + a;
    out.s = this.nearS[near];
    out.lat = (this.lat[a] * (1 - tx) + this.lat[a + NZ] * tx) * (1 - tz) + (this.lat[a + 1] * (1 - tx) + this.lat[a + 1 + NZ] * tx) * tz;
    return out;
  }

  /** River-local coordinates: a = across (distance from the river axis), b = along. */
  riverCoords(x: number, z: number): { a: number; b: number } {
    const r = this.river;
    const dx = x - r.origin.x;
    const dz = z - r.origin.y;
    const b = dx * r.along.x + dz * r.along.y;
    // Gentle meander that is zero at the bridge (b = 0) and at the ford.
    const a = dx * r.across.x + dz * r.across.y - 4 * Math.sin((Math.PI * b) / r.fordB);
    return { a, b };
  }

  /** Distance from the log-bridge shortcut line (and position along it 0..1). */
  shortcutDist(x: number, z: number): { d: number; t: number } {
    const p = this.shortcut.points;
    const a = p[0];
    const b = p[p.length - 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
    return { d: Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)), t };
  }

  spawnAt(s: number, lateral: number): SpawnPoint {
    const p = this.track.pointAt(s);
    const t = this.track.tangentAt(s);
    const x = p.x - t.z * lateral;
    const z = p.z + t.x * lateral;
    return { x, y: this.heightAt(x, z), z, yaw: Math.atan2(t.x, t.z) };
  }

  /** Visual layer weights (8, sum 1) at a terrain vertex. */
  layerWeights(x: number, z: number, h: number, slope: number, out: Float32Array): void {
    out.fill(0);
    const f = this.fieldsAt(x, z);
    const s = f.s;
    const hw = this.halfWidthAt(s);
    const n1 = valueNoise(x * 0.11, z * 0.11, 5);
    const n2 = fbm(x * 0.03, z * 0.03, 2, 9);
    const edge = hw + 0.4 + n1 * 0.9;
    const road = 1 - smoothstep(edge - 0.8, edge + 1.2, f.d);
    const zone = this.zoneAt(s).id;
    const hill = this.hillU(x, z);

    // Off-road base by zone.
    const off = new Float32Array(8);
    const wDesert = this.zoneW('desert', s, 18);
    const wRocky = this.zoneW('rocky', s, 18);
    const wFarm = this.zoneW('farm', s, 18);
    const wMud = this.zoneW('mud', s, 10);
    off[0] = 1;
    // Farm fields: striped crop rows / dry grass patches.
    if (wFarm > 0 && f.d > hw + 6) {
      const row = Math.sin((x * 0.7 + z * 0.35) * 0.9) > 0.2 ? 1 : 0;
      off[7] = wFarm * (n2 > -0.1 ? 0.6 + 0.4 * row : 0.2);
    }
    off[7] += smoothstep(0.25, 0.6, n2) * 0.5;
    off[5] += wRocky * smoothstep(0.15, 0.55, n1 * 0.5 + n2) * 0.9;
    off[2] += wRocky * 0.25;
    off[4] += wDesert * 4;
    const pit = this.mudPitW(s) * (1 - smoothstep(hw + 3 + n1 * 2, hw + 7 + n1 * 2, f.d));
    off[3] += wMud * pit * 6;

    // Road layer by zone.
    const onRoad = new Float32Array(8);
    if (zone === 'town') onRoad[2] = 1; // under the asphalt ribbon / shoulders
    else if (zone === 'farm' || zone === 'finish') onRoad[1] = 1;
    else if (zone === 'mud') {
      onRoad[3] = this.mudPitW(s);
      onRoad[1] = 1 - onRoad[3];
    } else if (zone === 'rocky' || zone === 'hill') onRoad[2] = 1;
    else if (zone === 'desert') {
      onRoad[4] = 1;
      onRoad[1] = 0.25;
    } else onRoad[1] = 1;
    // Wheel ruts: darker dirt stripes along the road.
    for (let k = 0; k < 8; k++) out[k] = off[k] * (1 - road) + onRoad[k] * road * 2;

    // Bonus hill: loose gravel everywhere on the mound.
    if (hill.h > 0.6) {
      const g = smoothstep(0.6, 3, hill.h);
      for (let k = 0; k < 8; k++) out[k] *= 1 - g;
      out[2] += g;
      out[5] += g * smoothstep(0.2, 0.6, n1) * 0.4;
    }
    // Shortcut path.
    const sc = this.shortcutDist(x, z);
    const scw = 1 - smoothstep(1.8 + n1, 3.4 + n1, sc.d);
    if (scw > 0) {
      for (let k = 0; k < 8; k++) out[k] *= 1 - scw;
      out[1] += scw;
    }
    // River banks & bed.
    const rc = this.riverCoords(x, z);
    if (rc.b > this.river.bMin - 8 && rc.b < this.river.bMax + 8) {
      const wet = 1 - smoothstep(5.5, 8.5 + n1, Math.abs(rc.a));
      if (wet > 0) {
        for (let k = 0; k < 8; k++) out[k] *= 1 - wet;
        out[6] += wet;
      }
    }
    // Steep slopes show rock (valley walls).
    const steep = smoothstep(0.65, 0.95, slope) * (hill.h > 0.6 ? 0.3 : 1);
    if (steep > 0) {
      for (let k = 0; k < 8; k++) out[k] *= 1 - steep;
      out[5] += steep;
    }
    void h;
    let sum = 0;
    for (let k = 0; k < 8; k++) sum += out[k];
    for (let k = 0; k < 8; k++) out[k] /= sum || 1;
  }

  /** Hill-local coordinates and mound height at (x, z). */
  hillU(x: number, z: number): { u: number; v: number; h: number } {
    const dx = x - this.hillO.x;
    const dz = z - this.hillO.y;
    const u = dx * this.hillD.x + dz * this.hillD.y;
    const v = -dx * this.hillD.y + dz * this.hillD.x;
    return { u, v, h: this.mound(u, v) };
  }

  private profileAt(u: number): number {
    if (u <= 0) return 0;
    const top = HILL_CLIMB_M + SUMMIT_PLATEAU_R * 2;
    if (u <= HILL_CLIMB_M) {
      const f = u / 0.5;
      const k = Math.floor(f);
      const t = f - k;
      return this.hillProfile[k] + (this.hillProfile[Math.min(k + 1, this.hillProfile.length - 1)] - this.hillProfile[k]) * t;
    }
    if (u <= top) return this.hillTop;
    // Back side: round over, then 30° down.
    const e = u - top;
    return Math.max(0, this.hillTop - (e < 6 ? (e * e) / 12 * Math.tan(0.52) : (e - 3) * Math.tan(0.52)));
  }

  private mound(u: number, v: number): number {
    if (u < -60 || u > HILL_CLIMB_M + 140) return 0;
    const p = this.profileAt(u);
    if (p <= 0) return 0;
    const shoulder = 9.5;
    const av = Math.abs(v);
    if (av <= shoulder) return p;
    // Flanks: rounded edge, then ~32°.
    const e = av - shoulder;
    const drop = e < 4 ? (e * e) / 8 * 0.62 : (e - 2) * 0.62;
    return Math.max(0, p - drop);
  }

  // ------------------------------------------------------------------ build steps

  private buildDistanceField(): void {
    const { xs, zs } = this.line;
    const R = WALL_END + 12;
    const NZ = this.NZ;
    const D = this.dist;
    const S = this.nearS;
    const L = this.lat;
    const st = this.line.step;
    for (let k = 0; k < xs.length - 1; k++) {
      const ax = xs[k];
      const az = zs[k];
      const abx = xs[k + 1] - ax;
      const abz = zs[k + 1] - az;
      const len2 = abx * abx + abz * abz || 1;
      const len = Math.sqrt(len2);
      const j0 = Math.max(0, Math.floor((Math.min(ax, ax + abx) - R - this.x0) / CELL));
      const j1 = Math.min(this.NX - 1, Math.ceil((Math.max(ax, ax + abx) + R - this.x0) / CELL));
      const i0 = Math.max(0, Math.floor((Math.min(az, az + abz) - R - this.z0) / CELL));
      const i1 = Math.min(NZ - 1, Math.ceil((Math.max(az, az + abz) + R - this.z0) / CELL));
      const first = k === 0;
      const last = k === xs.length - 2;
      for (let j = j0; j <= j1; j++) {
        const x = this.x0 + j * CELL;
        for (let i = i0; i <= i1; i++) {
          const z = this.z0 + i * CELL;
          let t = ((x - ax) * abx + (z - az) * abz) / len2;
          // Past the ends the field keeps growing (behind the start / beyond the summit).
          if (!first && t < 0) t = 0;
          if (!last && t > 1) t = 1;
          const tc = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + abx * tc;
          const pz = az + abz * tc;
          const dx = x - px;
          const dz = z - pz;
          const d2 = dx * dx + dz * dz;
          const idx = i + j * NZ;
          if (d2 < D[idx] * D[idx]) {
            D[idx] = Math.sqrt(d2);
            S[idx] = k * st + tc * len;
            L[idx] = (dx * -abz + dz * abx) / len;
          }
        }
      }
    }
  }

  private buildHeights(): void {
    const NZ = this.NZ;
    const H = this.heights;
    const st = this.line.step;
    const riv = this.river;
    for (let j = 0; j < this.NX; j++) {
      const x = this.x0 + j * CELL;
      for (let i = 0; i < NZ; i++) {
        const z = this.z0 + i * CELL;
        const idx = i + j * NZ;
        const d = this.dist[idx];
        const s = this.nearS[idx];
        const k = Math.min(this.roadY.length - 1, Math.round(s / st));
        const hw = this.halfW[k];
        const ry = this.roadY[k];

        // Off-road base terrain.
        let off = baseT(x, z);
        const wRocky = this.zoneW('rocky', s, 30);
        const wDesert = this.zoneW('desert', s, 30);
        const wRiver = this.zoneW('river', s, 30);
        const wTown = this.zoneW('town', s, 30);
        const wMud = this.zoneW('mud', s, 20);
        off += wRocky * 3.2 * (fbm(x / 55, z / 55, 3, 41) + 0.35);
        off += wDesert * 2.2 * Math.abs(fbm(x / 42, z / 42, 2, 47)) * 2;
        off = THREE.MathUtils.lerp(off, ry + 0.3, wTown * 0.8);
        off = Math.max(off, THREE.MathUtils.lerp(off, riv.level + 0.35 + 0.6 * Math.abs(fbm(x / 30, z / 30, 2, 3)), wRiver));
        // Mud pit: the low ground around the road is boggy too.
        off = THREE.MathUtils.lerp(off, ry + 0.25, wMud * this.mudPitW(s) * (1 - smoothstep(hw + 6, hw + 16, d)));

        const blend = smoothstep(hw + 1.2, hw + 24, d);
        let h = ry + (off - ry) * blend;
        // Off-road roughness (slows cars a little and looks natural) — none in the town.
        const rough = fbm(x / 6, z / 6, 2, 77) * 0.22 * (1 - wTown * 0.8);
        h += rough * smoothstep(hw + 0.6, hw + 3.5, d);
        // Mud ruts on the road surface.
        h += valueNoise(x / 2.3, z / 2.3, 91) * 0.05 * this.mudPitW(s) * (1 - smoothstep(hw, hw + 2, d));
        // Valley walls keep everyone in the world.
        h += WALL_HEIGHT * smoothstep(WALL_START, WALL_END, d) * (0.8 + 0.3 * fbm(x / 60, z / 60, 2, 13));

        // Log-bridge shortcut path: graded flat across the loop.
        const sc = this.shortcutDist(x, z);
        if (sc.d < 9) {
          const p = this.shortcut.points;
          const ya = this.roadY[Math.round(this.shortcut.startS / st)];
          const yb = this.roadY[Math.round(this.shortcut.endS / st)];
          const py = ya + (yb - ya) * sc.t;
          const w = 1 - smoothstep(3, 9, sc.d);
          h += (py - h) * w;
          void p;
        }

        // Bonus hill mound.
        h += this.hillU(x, z).h;

        // River channel.
        const rc = this.riverCoords(x, z);
        if (rc.b > riv.bMin - 12 && rc.b < riv.bMax + 12) {
          const endTaper = smoothstep(riv.bMin - 12, riv.bMin, rc.b) * (1 - smoothstep(riv.bMax, riv.bMax + 12, rc.b));
          const ford = 1 - smoothstep(7.5, 12, Math.abs(rc.b - riv.fordB));
          const depth = THREE.MathUtils.lerp(1.45, 0.85, ford) * endTaper;
          const halfBed = THREE.MathUtils.lerp(4, 5, ford);
          const bank = THREE.MathUtils.lerp(0.55, 0.12, ford); // bank slope (rise per m)
          const aa = Math.abs(rc.a);
          const bed = riv.level - depth + Math.max(0, aa - halfBed) * bank + valueNoise(x / 3, z / 3, 61) * 0.05;
          if (bed < h) h = bed;
        }
        H[idx] = h;
      }
    }
  }

  private buildSurfaces(): void {
    this.sx0 = this.x0;
    this.sz0 = this.z0;
    this.SNX = Math.floor(((this.NX - 1) * CELL) / SCELL);
    this.SNZ = Math.floor(((this.NZ - 1) * CELL) / SCELL);
    this.surf = new Uint8Array(this.SNX * this.SNZ);
    const f = { d: 0, s: 0, lat: 0 };
    const riv = this.river;
    for (let j = 0; j < this.SNX; j++) {
      const x = this.sx0 + (j + 0.5) * SCELL;
      for (let i = 0; i < this.SNZ; i++) {
        const z = this.sz0 + (i + 0.5) * SCELL;
        this.fieldsAt(x, z, f);
        const hw = this.halfWidthAt(f.s);
        const zone = this.zoneAt(f.s).id;
        const onRoad = f.d <= hw + 0.6;

        let st: SurfaceType = 'dirt'; // off-road grass behaves like dirt (see DECISIONS.md)
        if (zone === 'town') st = onRoad ? 'asphalt' : 'dirt';
        else if (zone === 'mud') st = this.mudPitW(f.s) > 0.15 && f.d < hw + 5 ? 'mud' : 'dirt';
        else if (zone === 'rocky') st = onRoad ? 'gravel' : 'dirt';
        else if (zone === 'desert') st = 'sand';
        else if (zone === 'hill' && onRoad) st = 'gravel';
        if (this.hillU(x, z).h > 0.8) st = 'gravel';
        if (this.shortcutDist(x, z).d < 2.4 && zone === 'river') st = 'dirt';
        const rc = this.riverCoords(x, z);
        if (Math.abs(rc.a) < 12 && rc.b > riv.bMin - 12 && rc.b < riv.bMax + 12 && this.heightAt(x, z) < riv.water - 0.02) st = 'water';
        this.surf[i + j * this.SNZ] = SC[st];
      }
    }
  }

  // ------------------------------------------------------------------ placement

  private rand = rng(20261101);

  /** A point at (s, lateral) on the ground. */
  at(s: number, lateral: number, yawOffset = 0, scale = 1, v = 0): Placement {
    const sp = this.spawnAt(s, lateral);
    return { x: sp.x, z: sp.z, y: sp.y, yaw: sp.yaw + yawOffset, scale, v };
  }

  private clearForRespawn(s: number): boolean {
    const p = this.track.pointAt(s);
    for (const r of this.ramps) if (Math.hypot(r.x - p.x, r.z - p.z) < r.length + 6) return false;
    for (const b of this.boulders) if (Math.hypot(b.x - p.x, b.z - p.z) < 8) return false;
    for (const b of this.potholes) if (Math.hypot(b.x - p.x, b.z - p.z) < 6) return false;
    if (this.surfaceAt(p.x, p.z) === 'water') return false;
    return true;
  }

  private placeFeatures(): void {
    const r = this.rand;
    const zFarm = this.zone('farm');
    const zRocky = this.zone('rocky');
    const zTown = this.zone('town');

    // ---- ramps (rocky hills), on the straights
    for (const tag of ['rampA', 'rampB'] as const) {
      const s = this.line.tagS[tag]! + 40;
      const sp = this.spawnAt(s, 0);
      this.ramps.push({ x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, halfWidth: 3.6, length: 9, height: 1.35 });
      this.keepOut.push({ x: sp.x, z: sp.z, r: 16 });
    }

    // ---- hay bales: small clusters at the farm road edges (some poke onto the road)
    for (let c = 0; c < 9; c++) {
      const s = zFarm.startS + 30 + c * ((zFarm.endS - zFarm.startS - 60) / 8) + (r() - 0.5) * 10;
      const side = c % 2 ? 1 : -1;
      const hw = this.halfWidthAt(s);
      const n = 2 + Math.floor(r() * 2);
      for (let b = 0; b < n; b++) {
        const lat = side * (hw - 1.2 + r() * 2.2);
        this.hay.push(this.at(s + b * 1.4, lat, r() * 0.4, 1, b === n - 1 && n === 3 ? 1 : 0));
      }
    }
    // A stack by the finish straight for fun.
    const fz = this.zone('finish');
    for (let b = 0; b < 3; b++) this.hay.push(this.at(fz.startS + 60 + b * 1.4, 5.2, 0, 1, 0));

    // ---- cones: slalom gates on the farm road and roadworks in town
    for (let g = 0; g < 4; g++) {
      const s = zFarm.startS + 70 + g * 85;
      for (let k = 0; k < 4; k++) this.cones.push(this.at(s + k * 7, (k % 2 ? 1 : -1) * 2.2, 0, 1, 0));
    }
    for (let k = 0; k < 6; k++) this.cones.push(this.at(zTown.startS + 230 + k * 4, -4.5 + k * 0.15, 0, 1, 0));

    // ---- potholes on the farm road
    for (let k = 0; k < 10; k++) {
      const s = zFarm.startS + 45 + k * 36 + r() * 12;
      const hw = this.halfWidthAt(s);
      this.potholes.push(this.at(s, (r() * 2 - 1) * (hw - 1.6), r() * Math.PI, 0.8 + r() * 0.5, 0));
    }

    // ---- boulders (rocky hills): a few on the road edges (steer around), many off-road
    const onRoadS = [40, 120, 175, 255, 330, 395, 430];
    for (const ds of onRoadS) {
      const s = zRocky.startS + ds;
      if (this.keepOut.some((k) => Math.hypot(this.centre(s).x - k.x, this.centre(s).y - k.z) < k.r)) continue;
      const hw = this.halfWidthAt(s);
      const side = r() < 0.5 ? -1 : 1;
      this.boulders.push(this.at(s, side * (hw - 2.0 - r() * 0.8), r() * 6, 1.0 + r() * 0.35, Math.floor(r() * 3)));
    }
    for (let k = 0; k < 70; k++) {
      const s = zRocky.startS - 20 + r() * (zRocky.endS - zRocky.startS + 40);
      const hw = this.halfWidthAt(s);
      const side = r() < 0.5 ? -1 : 1;
      const lat = side * (hw + 2.5 + r() * 38);
      this.boulders.push(this.at(s, lat, r() * 6, 0.9 + r() * 1.6, Math.floor(r() * 3)));
    }
    // A ring of boulders behind the summit plateau (gentle stop, not a wall).
    for (let k = -3; k <= 3; k++) {
      const s = this.summitS + SUMMIT_PLATEAU_R + 1.5;
      this.boulders.push(this.at(s, k * 2.6, k, 0.75, k & 1));
    }

    // ---- houses (town), well back from the road
    const houseS = [25, 60, 100, 150, 175, 260, 300, 335, 45, 110, 280];
    houseS.forEach((ds, idx) => {
      const s = zTown.startS + ds;
      const side = idx < 8 ? (idx % 2 ? 1 : -1) : idx % 2 ? -1 : 1;
      const hw = this.halfWidthAt(s);
      const p = this.at(s, side * (hw + 11 + r() * 6), side > 0 ? -Math.PI / 2 : Math.PI / 2, 1, Math.floor(r() * 4));
      // Skip if it would land near another part of the road (corners).
      const f = this.fieldsAt(p.x, p.z);
      if (f.d < hw + 8) return;
      this.houses.push(p);
      this.keepOut.push({ x: p.x, z: p.z, r: 9 });
    });
    // Barn + silo on the farm.
    {
      const s = zFarm.startS + 140;
      const p = this.at(s, 26, Math.PI / 2, 1.6, 10);
      if (this.fieldsAt(p.x, p.z).d > 16) {
        this.houses.push(p);
        this.keepOut.push({ x: p.x, z: p.z, r: 14 });
      }
    }

    // ---- fences: both sides of the farm road, and short runs in town
    const fenceRun = (s0: number, s1: number, lateral: number): void => {
      let prev: THREE.Vector2 | null = null;
      let prevY = 0;
      for (let s = s0; s <= s1; s += 3) {
        const sp = this.spawnAt(s, lateral);
        const pt = new THREE.Vector2(sp.x, sp.z);
        const f = this.fieldsAt(sp.x, sp.z);
        const ok = Math.abs(f.d - Math.abs(lateral)) < 1.5 && !this.keepOut.some((k) => Math.hypot(sp.x - k.x, sp.z - k.z) < k.r * 0.6);
        if (prev && ok) this.fences.push({ a: prev, b: pt, ya: prevY, yb: sp.y });
        prev = ok ? pt : null;
        prevY = sp.y;
      }
    };
    for (const side of [-1, 1]) {
      // Gaps every ~120 m so a car that ends up outside can get back in.
      for (let s = zFarm.startS + 8; s < zFarm.endS - 10; s += 120) fenceRun(s, Math.min(s + 105, zFarm.endS - 10), side * (this.halfWidthAt(s) + 4));
      fenceRun(zTown.startS + 140, zTown.startS + 200, side * (ROAD_HALF_WIDTH.town + 3));
    }

    // ---- trees, bushes, rocks and grass tufts by zone (jittered grid, cheap rejection)
    const step = 9;
    const f = { d: 0, s: 0, lat: 0 };
    for (let x = this.x0 + 4; x < this.x0 + (this.NX - 1) * CELL - 4; x += step) {
      for (let z = this.z0 + 4; z < this.z0 + (this.NZ - 1) * CELL - 4; z += step) {
        const px = x + (r() - 0.5) * step;
        const pz = z + (r() - 0.5) * step;
        this.fieldsAt(px, pz, f);
        if (f.d > WALL_END + 6) continue;
        const hw = this.halfWidthAt(f.s);
        if (f.d < hw + 6) continue;
        if (this.keepOut.some((k) => Math.hypot(px - k.x, pz - k.z) < k.r)) continue;
        if (this.shortcutDist(px, pz).d < 6) continue;
        const rc = this.riverCoords(px, pz);
        if (Math.abs(rc.a) < 10 && rc.b > this.river.bMin - 14 && rc.b < this.river.bMax + 14) continue;
        const hill = this.hillU(px, pz);
        if (hill.h > 2 && Math.abs(hill.v) < 16) continue;
        const zone = this.zoneAt(f.s).id;
        const y = this.heightAt(px, pz);
        const roll = r();
        const pl = (): Placement => ({ x: px, z: pz, y, yaw: r() * Math.PI * 2, scale: 0.75 + r() * 0.6, v: Math.floor(r() * 4) });
        const nearRoad = f.d < hw + 18;
        const density =
          zone === 'desert' ? 0.03 : zone === 'town' ? 0.18 : zone === 'farm' ? 0.22 : zone === 'mud' ? 0.3 : zone === 'rocky' ? 0.28 : zone === 'river' ? 0.4 : 0.25;
        if (roll < density * (nearRoad ? 0.6 : 1) * (f.d > WALL_START ? 1.4 : 1)) {
          if (zone === 'desert') this.bushes.push(pl());
          else if (zone === 'rocky' || (zone === 'hill' && r() < 0.5) || f.d > WALL_START + 6) (r() < 0.75 ? this.pines : this.trees).push(pl());
          else (r() < 0.25 ? this.pines : this.trees).push(pl());
        } else if (roll < density + 0.12) {
          this.bushes.push(pl());
        } else if (roll < density + 0.12 + (zone === 'rocky' || zone === 'desert' ? 0.35 : 0.08)) {
          this.rocks.push(pl());
        }
      }
    }
    // Grass tufts: dense near the road edges (where the camera is), sparse farther out.
    for (let k = 0; k < 9000; k++) {
      const s = r() * this.length;
      const zone = this.zoneAt(s).id;
      if (zone === 'desert' || zone === 'hill') continue;
      if (zone === 'mud' && this.mudPitW(s) > 0.1) continue;
      const hw = this.halfWidthAt(s);
      const side = r() < 0.5 ? -1 : 1;
      const lat = side * (hw + 0.8 + Math.pow(r(), 1.8) * 30);
      const p = this.at(s, lat, r() * 6, 0.6 + r() * 0.8, Math.floor(r() * 3));
      const ff = this.fieldsAt(p.x, p.z);
      if (ff.d < this.halfWidthAt(ff.s) + 0.6) continue;
      if (this.surfaceAt(p.x, p.z) === 'water') continue;
      if (this.shortcutDist(p.x, p.z).d < 2.6) continue;
      this.tufts.push(p);
    }

    // ---- animal crossing spots (zone-matched). The animal system picks 2–3 of these per race.
    const spot = (kind: AnimalSpot['kind'], zone: ZoneId, fr: number): void => {
      const z = this.zone(zone);
      this.animalSpots.push({ kind, zone, s: z.startS + (z.endS - z.startS) * fr });
    };
    spot('mouse', 'town', 0.55);
    spot('mouse', 'town', 0.8);
    spot('deer', 'farm', 0.35);
    spot('deer', 'farm', 0.75);
    spot('bear', 'farm', 0.55);
    spot('croc', 'mud', 0.5);
    spot('deer', 'rocky', 0.3);
    spot('bear', 'rocky', 0.6);
    spot('deer', 'rocky', 0.85);
    spot('duck', 'river', 0.12);
  }
}

/** Horizontal-distance TrackPath over the course centre-line (uniform 2 m samples → O(1) lookups). */
export class CourseTrack implements TrackPath {
  readonly length: number;
  readonly finishS: number;
  readonly summitS: number;
  private xs: Float64Array;
  private zs: Float64Array;
  private ys: Float32Array;
  private step: number;
  private hw: Float32Array;

  constructor(c: CourseData) {
    this.xs = c.line.xs;
    this.zs = c.line.zs;
    this.step = c.line.step;
    this.hw = c.halfW;
    this.length = c.length;
    this.finishS = c.finishS;
    this.summitS = c.summitS;
    this.ys = new Float32Array(this.xs.length);
    for (let k = 0; k < this.xs.length; k++) this.ys[k] = c.heightAt(this.xs[k], this.zs[k]);
  }

  private seg(s: number): { k: number; t: number } {
    const f = THREE.MathUtils.clamp(s / this.step, 0, this.xs.length - 1.000001);
    const k = Math.floor(f);
    return { k, t: f - k };
  }

  pointAt(s: number, target = new THREE.Vector3()): THREE.Vector3 {
    const { k, t } = this.seg(s);
    return target.set(
      this.xs[k] + (this.xs[k + 1] - this.xs[k]) * t,
      this.ys[k] + (this.ys[k + 1] - this.ys[k]) * t,
      this.zs[k] + (this.zs[k + 1] - this.zs[k]) * t,
    );
  }

  /** Horizontal unit tangent (y = 0). */
  tangentAt(s: number, target = new THREE.Vector3()): THREE.Vector3 {
    const { k } = this.seg(s);
    return target.set(this.xs[k + 1] - this.xs[k], 0, this.zs[k + 1] - this.zs[k]).normalize();
  }

  halfWidthAt(s: number): number {
    const { k } = this.seg(s);
    return this.hw[k];
  }

  project(pos: THREE.Vector3, hintS?: number): { s: number; lateral: number } {
    const n = this.xs.length - 1;
    let from = 0;
    let to = n - 1;
    if (hintS !== undefined) {
      const k = this.seg(hintS).k;
      from = Math.max(0, k - 25);
      to = Math.min(n - 1, k + 25);
    }
    let best = this.search(pos.x, pos.z, from, to);
    if (hintS !== undefined && best.d2 > 40 * 40) best = this.search(pos.x, pos.z, 0, n - 1);
    return { s: best.s, lateral: best.lat };
  }

  private search(x: number, z: number, from: number, to: number): { s: number; lat: number; d2: number } {
    let bd = Infinity;
    let bs = 0;
    let bl = 0;
    for (let k = from; k <= to; k++) {
      const ax = this.xs[k];
      const az = this.zs[k];
      const abx = this.xs[k + 1] - ax;
      const abz = this.zs[k + 1] - az;
      const len2 = abx * abx + abz * abz || 1;
      let t = ((x - ax) * abx + (z - az) * abz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + abx * t);
      const dz = z - (az + abz * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) {
        bd = d2;
        const len = Math.sqrt(len2);
        bs = (k + t) * this.step;
        bl = (dx * -abz + dz * abx) / len;
      }
    }
    return { s: bs, lat: bl, d2: bd };
  }
}

/** Hill climb angle (degrees) at horizontal distance u from the foot: steepest near the top. */
function hillAngle(u: number): number {
  const t = THREE.MathUtils.clamp(u / HILL_CLIMB_M, 0, 1);
  // Foot → 26° over the first 30 %, then a long, loose 26° → 37° pitch held for the last ~25 m (steepest near the top) that
  // eats any run-up momentum, then a short round-over onto the summit plateau.
  if (t < 0.3) return HILL_FOOT_DEG + (26 - HILL_FOOT_DEG) * smoothstep(0, 0.3, t);
  if (t < 0.93) return 26 + (HILL_MAX_DEG - 26) * smoothstep(0.3, 0.76, t);
  const k = (t - 0.93) / 0.07;
  return HILL_MAX_DEG * (0.5 + 0.5 * Math.cos(k * Math.PI));
}

/** Low-frequency rolling countryside (shared by road profile and off-road terrain). */
function baseT(x: number, z: number): number {
  return 7 * fbm(x / 380, z / 380, 3, 11) + 1.8 * fbm(x / 95, z / 95, 2, 23);
}

function boxBlur(a: Float32Array, r: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let sum = 0;
    let c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(a.length - 1, i + r); j++) {
      sum += a[j];
      c++;
    }
    out[i] = sum / c;
  }
  return out;
}

export { HW_KEYS };
