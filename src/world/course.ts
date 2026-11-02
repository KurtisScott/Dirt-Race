import * as THREE from 'three';
import { rng } from '../core/math';
import type { SpawnPoint, SurfaceType } from '../core/types';
import {
  buildCourseLine,
  GORGE_BRIDGE_M,
  GORGE_DEPTH_M,
  JUMP_BONUS_M,
  JUMP_LAND_DEG,
  JUMP_LANDING_M,
  JUMP_MARKER_STEP_M,
  JUMP_RAMP_DEG,
  JUMP_RAMP_HEIGHT_M,
  JUMP_RAMP_LEN_M,
  JUMP_RUNOFF_M,
  JUMP_RUNUP_M,
  JUMP_TABLE_M,
  ROAD_HALF_WIDTH,
  SNOW_RAMP_M,
  SNOW_RISE_M,
  type CourseLine,
  type SegmentTag,
} from './layout';
import { fbm, smoothstep, valueNoise } from './noise';
import type { Checkpoint, JumpInfo, TrackPath, Zone, ZoneId } from './types';

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
/** Distance from the centre-line where the valley walls start rising, and where they top out (open country). */
export const WALL_START = 48;
export const WALL_END = 72;
const WALL_HEIGHT = 24;
/** Canyon: the walls close in and tower over the road. */
const CANYON_WALL_START = 17;
const CANYON_WALL_END = 34;
const CANYON_WALL_HEIGHT = 34;
/** River centre-line distance from the road centre on the riverside run (m). */
const RIVER_OFFSET = 24;

export const SURFACE_CODES: SurfaceType[] = ['asphalt', 'dirt', 'gravel', 'mud', 'sand', 'water'];
const SC: Record<SurfaceType, number> = { asphalt: 0, dirt: 1, gravel: 2, mud: 3, sand: 4, water: 5 };

/** Visual terrain layers (texture array order). Weights travel as 3 vec4 attributes (12 slots). */
export const LAYERS = ['grass', 'dirt', 'gravel', 'mud', 'sand', 'rock', 'riverbed', 'field', 'snow', 'forest', 'redrock'] as const;
export type LayerName = (typeof LAYERS)[number];
export const LAYER_SLOTS = 12;
const L_GRASS = 0;
const L_DIRT = 1;
const L_GRAVEL = 2;
const L_MUD = 3;
const L_SAND = 4;
const L_ROCK = 5;
const L_RIVERBED = 6;
const L_FIELD = 7;
const L_SNOW = 8;
const L_FOREST = 9;
const L_REDROCK = 10;

export interface Placement {
  x: number;
  z: number;
  y: number;
  yaw: number;
  scale: number;
  /** Variant index / free parameter. */
  v: number;
}

/**
 * The river: a polyline channel. It runs beside the road on the riverside stretch (on the right), follows
 * the road round the left turn, bends across the road line where the log bridge is, and on through the ford.
 * River coordinates: `b` = distance along the river (0 at the log-bridge crossing, + downstream toward the
 * ford), `a` = distance from the river's centre-line.
 */
export interface RiverFrame {
  /** Centre of the river on the bridge line. */
  origin: THREE.Vector2;
  /** Unit vector across the river at the bridge (= direction of travel on the bridge). */
  across: THREE.Vector2;
  /** Unit vector along the river at the bridge (downstream, toward the ford). */
  along: THREE.Vector2;
  /** Water surface height. */
  water: number;
  /** Bank-top height (road level through the river zone). */
  level: number;
  /** River coordinate (b) of the ford crossing. */
  fordB: number;
  bMin: number;
  bMax: number;
  /** River centre-line (x, z) every ~2 m from bMin to bMax, with b per point. */
  points: THREE.Vector2[];
  bs: number[];
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

/** The road bridge over the canyon gorge: deck from s0 to s1 (straight), deck top heights at both ends. */
export interface GorgeDef {
  s: number;
  s0: number;
  s1: number;
  y0: number;
  y1: number;
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
  /** Visual style: 0 wood (rocky/forest), 1 sand/dune (desert), 2 red rock (canyon). */
  style: number;
}

/** A fallen log lying across part of the road edge (fixed obstacle). */
export interface LogDef {
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
  radius: number;
}

export type AnimalKind = 'deer' | 'bear' | 'mouse' | 'duck' | 'croc' | 'moose' | 'boar' | 'bull' | 'cow' | 'goat' | 'rabbit' | 'camel';

export interface AnimalSpot {
  kind: AnimalKind;
  zone: ZoneId;
  /** Where on the course the crossing happens. */
  s: number;
}

/** Jump geometry (the end jump that replaced the bonus hill). */
export interface JumpGeom extends JumpInfo {
  /** s of the foot of the ramp. */
  footS: number;
  rampLen: number;
  rampDeg: number;
  rampHeight: number;
  /** Ramp half-width (m). */
  halfWidth: number;
}

// Scratch arrays for layerWeights (called for every terrain vertex: no allocations).
const _off = new Float32Array(LAYER_SLOTS);
const _road = new Float32Array(LAYER_SLOTS);
const _f = { d: 0, s: 0, lat: 0 };

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
  /** Per-node river coordinates (a = distance from the river centre-line, b = along it); a = 1e3 when far. */
  private riverA: Float32Array;
  private riverB: Float32Array;
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
  readonly jump: JumpGeom;
  readonly river: RiverFrame;
  readonly shortcut: ShortcutDef;
  readonly bridge: BridgeDef;
  readonly gorge: GorgeDef;
  readonly ramps: RampDef[] = [];
  readonly logs: LogDef[] = [];
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
  readonly snowPines: Placement[] = [];
  readonly cacti: Placement[] = [];
  readonly bushes: Placement[] = [];
  readonly tufts: Placement[] = [];
  readonly houses: Placement[] = [];
  readonly fences: { a: THREE.Vector2; b: THREE.Vector2; ya: number; yb: number }[] = [];
  readonly animalSpots: AnimalSpot[] = [];

  /** Landing-hill drop below the run-up level every 0.5 m from the lip. */
  private jumpProfile: Float32Array;
  private keepOut: { x: number; z: number; r: number }[] = [];
  private zoneById = new Map<ZoneId, Zone>();

  constructor() {
    const line = (this.line = buildCourseLine(2));
    this.length = line.length;
    this.zones = line.zones.map((z) => ({ id: z.id, startS: z.startS, endS: z.endS }));
    for (const z of this.zones) this.zoneById.set(z.id, z);
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

    // ---- the end jump: finish line → straight run-up → ramp → landing hill → sand run-off
    this.finishS = line.tagS.jump!;
    const footS = this.finishS + JUMP_RUNUP_M;
    const lipS = footS + JUMP_RAMP_LEN_M;
    const runoffS = lipS + JUMP_LANDING_M;
    this.jumpProfile = new Float32Array(Math.ceil((JUMP_LANDING_M + JUMP_RUNOFF_M + 2) / 0.5) + 1);
    let drop = 0;
    for (let i = 1; i < this.jumpProfile.length; i++) {
      const u = (i - 0.5) * 0.5;
      drop += Math.tan(landAngle(u) * (Math.PI / 180)) * 0.5;
      this.jumpProfile[i] = drop;
    }

    // ---- road elevation profile along s (before the river carve)
    this.roadY = new Float32Array(n);
    const raw = new Float32Array(n);
    for (let k = 0; k < n; k++) raw[k] = baseT(line.xs[k], line.zs[k]);
    const sm = boxBlur(boxBlur(raw, 20), 20);
    const riverZ = this.zone('river');
    const riverLevel = sm[Math.round(riverZ.startS / line.step)] - 0.4;
    const runupY = sm[Math.round(this.zone('finish').startS / line.step)];
    const desert = this.zone('desert');
    for (let k = 0; k < n; k++) {
      const s = k * line.step;
      let y = sm[k];
      // Mud pit: the road sinks into a shallow pit.
      y -= 0.55 * this.mudPitW(s);
      // Snowy pass: the road climbs over a saddle.
      y += SNOW_RISE_M * this.snowW(s);
      // Desert dunes across the road (after the descent from the pass).
      const dw = this.zoneW('desert', s, -25) * smoothstep(desert.startS + 110, desert.startS + 160, s);
      if (dw > 0) y += 1.0 * dw * Math.sin(((s - desert.startS) / 46) * Math.PI * 2);
      // River section held level; finish straight + run-up level too; then the landing hill drops away.
      y = THREE.MathUtils.lerp(y, riverLevel, this.zoneW('river', s, 40));
      const fw = Math.max(this.zoneW('finish', s, 40), this.zoneW('jump', s, 40));
      y = THREE.MathUtils.lerp(y, runupY, fw);
      y -= this.jumpDrop(s - lipS);
      this.roadY[k] = y;
    }
    const lipBaseY = runupY;

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
    this.riverA = new Float32Array(N).fill(1e3);
    this.riverB = new Float32Array(N);
    this.buildDistanceField();

    // ---- river (polyline beside the road, across the bridge line, through the ford)
    this.river = this.buildRiver(riverLevel);
    this.buildRiverField();

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

    // ---- gorge bridge (canyon)
    {
      const gs = line.tagS.gorge! + 30;
      const s0 = gs - GORGE_BRIDGE_M / 2;
      const s1 = gs + GORGE_BRIDGE_M / 2;
      this.gorge = { s: gs, s0, s1, y0: this.roadYAt(s0) + 0.03, y1: this.roadYAt(s1) + 0.03, halfWidth: this.halfWidthAt(gs) + 0.4 };
    }

    this.buildHeights();
    // Track points take their height from the final terrain (exactly what the wheels touch).
    this.track = new CourseTrack(this);
    for (const p of scPts) p.y = this.heightAt(p.x, p.z);

    // Bridge deck over the river on the shortcut line.
    const D = this.river.across;
    const deckY = this.river.level + 0.35;
    const o = this.river.origin;
    this.bridge = { x: o.x, y: deckY, z: o.y, yaw: Math.atan2(D.x, D.y), length: 22, halfWidth: 1.9 };
    for (const p of scPts) {
      const da = Math.abs((p.x - o.x) * D.x + (p.z - o.y) * D.y);
      if (da < this.bridge.length / 2) p.y = deckY;
    }

    this.buildSurfaces();

    // ---- jump info
    const lipSp = this.spawnAt(lipS, 0);
    const bonusSp = this.spawnAt(lipS + JUMP_BONUS_M, 0);
    this.jump = {
      lipS,
      bonusM: JUMP_BONUS_M,
      bonusS: lipS + JUMP_BONUS_M,
      runoffS,
      markerStepM: JUMP_MARKER_STEP_M,
      lip: new THREE.Vector3(lipSp.x, lipBaseY + JUMP_RAMP_HEIGHT_M, lipSp.z),
      bonusLine: new THREE.Vector3(bonusSp.x, bonusSp.y, bonusSp.z),
      footS,
      rampLen: JUMP_RAMP_LEN_M,
      rampDeg: JUMP_RAMP_DEG,
      rampHeight: JUMP_RAMP_HEIGHT_M,
      halfWidth: ROAD_HALF_WIDTH.jump - 0.6,
    };

    // ---- spawns, checkpoints
    this.spawns = { player: this.spawnAt(8, -2.8), cpu: this.spawnAt(8, 2.8) };

    this.placeFeatures();
    for (let s = 300; s < this.finishS - 60; s += 300) {
      let cs = s;
      // Never respawn onto a ramp, boulder, log, the gorge bridge or the water.
      for (let tries = 0; tries < 12 && !this.clearForRespawn(cs); tries++) cs += 8;
      this.checkpoints.push({ index: this.checkpoints.length, s: cs, respawn: this.spawnAt(cs, 0) });
    }
  }

  // ------------------------------------------------------------------ queries

  zone(id: ZoneId): Zone {
    return this.zoneById.get(id)!;
  }

  zoneAt(s: number): Zone {
    for (const z of this.zones) if (s < z.endS) return z;
    return this.zones[this.zones.length - 1];
  }

  /** 0..1 membership of zone `id` at s, with smooth ramps of `ramp` m (negative = ramp inside the zone). */
  zoneW(id: ZoneId, s: number, ramp: number): number {
    const z = this.zoneById.get(id);
    if (!z) return 0;
    if (ramp >= 0) return smoothstep(z.startS - ramp, z.startS + 0.001, s) * (1 - smoothstep(z.endS - 0.001, z.endS + ramp, s));
    const r = -ramp;
    return smoothstep(z.startS, z.startS + r, s) * (1 - smoothstep(z.endS - r, z.endS, s));
  }

  mudPitW(s: number): number {
    const z = this.zone('mud');
    return smoothstep(z.startS + 30, z.startS + 52, s) * (1 - smoothstep(z.endS - 52, z.endS - 30, s));
  }

  /** 0..1: how far up the snowy pass (1 = on the saddle). Smooth: max grade ≈ 1.5·rise/ramp. */
  snowW(s: number): number {
    const z = this.zone('snow');
    return smoothstep(z.startS - SNOW_RAMP_M / 2, z.startS + SNOW_RAMP_M / 2, s) * (1 - smoothstep(z.endS - SNOW_RAMP_M / 2, z.endS + SNOW_RAMP_M / 2, s));
  }

  /** Metres the landing hill / run-off sits below the run-up level at `u` m past the lip (berm at the end). */
  jumpDrop(u: number): number {
    if (u <= 0) return 0;
    const f = u / 0.5;
    const k = Math.min(Math.floor(f), this.jumpProfile.length - 2);
    const t = Math.min(1, f - k);
    let d = this.jumpProfile[k] + (this.jumpProfile[k + 1] - this.jumpProfile[k]) * t;
    // Berm: the last 34 m of the run-off rise ~4 m (a soft stop before the end of the world).
    const e = u - (JUMP_LANDING_M + JUMP_RUNOFF_M - 34);
    if (e > 0) d -= 4 * smoothstep(0, 34, e);
    return d;
  }

  /** Is s on the gorge bridge deck? */
  onGorgeBridge(s: number): boolean {
    return s > this.gorge.s0 && s < this.gorge.s1;
  }

  /** Deck-top height of the gorge bridge at s. */
  gorgeDeckY(s: number): number {
    const g = this.gorge;
    return g.y0 + (g.y1 - g.y0) * THREE.MathUtils.clamp((s - g.s0) / (g.s1 - g.s0), 0, 1);
  }

  halfWidthAt(s: number): number {
    const k = THREE.MathUtils.clamp(Math.round(s / this.line.step), 0, this.halfW.length - 1);
    return this.halfW[k];
  }

  private roadYAt(s: number): number {
    const f = THREE.MathUtils.clamp(s / this.line.step, 0, this.roadY.length - 1.0001);
    const k = Math.floor(f);
    return this.roadY[k] + (this.roadY[k + 1] - this.roadY[k]) * (f - k);
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

  /** Unit horizontal direction of travel at s (x, z). */
  dirAt(s: number, target = new THREE.Vector2()): THREE.Vector2 {
    const k = THREE.MathUtils.clamp(Math.floor(s / this.line.step), 0, this.line.xs.length - 2);
    return target.set(this.line.xs[k + 1] - this.line.xs[k], this.line.zs[k + 1] - this.line.zs[k]).normalize();
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

  /** River-local coordinates: a = distance from the river centre-line (1e3 when far), b = along it. */
  riverCoords(x: number, z: number): { a: number; b: number } {
    const fx = THREE.MathUtils.clamp((x - this.x0) / CELL, 0, this.NX - 1.001);
    const fz = THREE.MathUtils.clamp((z - this.z0) / CELL, 0, this.NZ - 1.001);
    const j = Math.floor(fx);
    const i = Math.floor(fz);
    const tx = fx - j;
    const tz = fz - i;
    const NZ = this.NZ;
    const A = this.riverA;
    const k = i + j * NZ;
    const a00 = A[k];
    const a01 = A[k + NZ];
    const a10 = A[k + 1];
    const a11 = A[k + 1 + NZ];
    if (a00 > 999 || a01 > 999 || a10 > 999 || a11 > 999) return { a: Math.min(a00, a01, a10, a11), b: this.riverB[k] };
    const B = this.riverB;
    return {
      a: (a00 * (1 - tx) + a01 * tx) * (1 - tz) + (a10 * (1 - tx) + a11 * tx) * tz,
      b: (B[k] * (1 - tx) + B[k + NZ] * tx) * (1 - tz) + (B[k + 1] * (1 - tx) + B[k + 1 + NZ] * tx) * tz,
    };
  }

  /** Inside the river channel's extent (with margin m)? */
  nearRiver(x: number, z: number, aMax: number, margin = 0): boolean {
    const rc = this.riverCoords(x, z);
    return rc.a < aMax && rc.b > this.river.bMin - margin && rc.b < this.river.bMax + margin;
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

  /** Visual layer weights (LAYER_SLOTS, sum 1) at a terrain vertex. */
  layerWeights(x: number, z: number, h: number, slope: number, out: Float32Array): void {
    out.fill(0);
    const f = this.fieldsAt(x, z, _f);
    const s = f.s;
    const hw = this.halfWidthAt(s);
    const n1 = valueNoise(x * 0.11, z * 0.11, 5);
    const n2 = fbm(x * 0.03, z * 0.03, 2, 9);
    const edge = hw + 0.4 + n1 * 0.9;
    const road = 1 - smoothstep(edge - 0.8, edge + 1.2, f.d);
    const zone = this.zoneAt(s).id;

    // Off-road base by zone.
    const off = _off.fill(0);
    const wDesert = this.zoneW('desert', s, 18);
    const wRocky = this.zoneW('rocky', s, 18);
    const wFarm = this.zoneW('farm', s, 18);
    const wMud = this.zoneW('mud', s, 10);
    const wForest = this.zoneW('forest', s, 25);
    const wCanyon = this.zoneW('canyon', s, 25);
    const wSnow = smoothstep(0.35, 0.7, this.snowW(s));
    off[L_GRASS] = 1;
    // Farm fields: striped crop rows / dry grass patches.
    if (wFarm > 0 && f.d > hw + 6) {
      const row = Math.sin((x * 0.7 + z * 0.35) * 0.9) > 0.2 ? 1 : 0;
      off[L_FIELD] = wFarm * (n2 > -0.1 ? 0.6 + 0.4 * row : 0.2);
    }
    off[L_FIELD] += smoothstep(0.25, 0.6, n2) * 0.5 * (1 - wForest) * (1 - wSnow);
    off[L_ROCK] += wRocky * smoothstep(0.15, 0.55, n1 * 0.5 + n2) * 0.9;
    off[L_GRAVEL] += wRocky * 0.25;
    off[L_SAND] += wDesert * 4;
    off[L_FOREST] += wForest * (2.2 + n2 * 1.5);
    off[L_REDROCK] += wCanyon * (1.2 + smoothstep(0, 0.5, n1) * 1.5);
    off[L_SAND] += wCanyon * 0.8;
    off[L_SNOW] += wSnow * 8;
    const pit = this.mudPitW(s) * (1 - smoothstep(hw + 3 + n1 * 2, hw + 7 + n1 * 2, f.d));
    off[L_MUD] += wMud * pit * 6;

    // Road layer by zone.
    const onRoad = _road.fill(0);
    if (zone === 'town' || (zone === 'jump' && s < this.finishS + JUMP_RUNUP_M + 2)) onRoad[L_GRAVEL] = 1; // under the asphalt ribbon / shoulders
    else if (zone === 'farm' || zone === 'finish' || zone === 'forest' || zone === 'jump') onRoad[L_DIRT] = 1;
    else if (zone === 'mud') {
      onRoad[L_MUD] = this.mudPitW(s);
      onRoad[L_DIRT] = 1 - onRoad[L_MUD];
    } else if (zone === 'rocky') onRoad[L_GRAVEL] = 1;
    else if (zone === 'canyon') {
      onRoad[L_GRAVEL] = 0.7;
      onRoad[L_REDROCK] = 0.3;
    } else if (zone === 'snow') {
      // Packed snow with gravel showing through in the wheel tracks.
      onRoad[L_SNOW] = 0.2 + wSnow * 0.25;
      onRoad[L_GRAVEL] = 1 - onRoad[L_SNOW];
    } else if (zone === 'desert') {
      onRoad[L_SAND] = 1;
      onRoad[L_DIRT] = 0.25;
    } else onRoad[L_DIRT] = 1;
    for (let k = 0; k < LAYER_SLOTS; k++) out[k] = off[k] * (1 - road) + onRoad[k] * road * 2;

    // End jump: landing zone dirt, sand run-off across the whole width.
    if (zone === 'jump') {
      const j = this.jump;
      const ro = smoothstep(j.runoffS - 2, j.runoffS + 4, s) * (1 - smoothstep(hw + 14, hw + 24, f.d));
      if (ro > 0) {
        for (let k = 0; k < LAYER_SLOTS; k++) out[k] *= 1 - ro;
        out[L_SAND] += ro;
      }
    }
    // Shortcut path.
    const sc = this.shortcutDist(x, z);
    const scw = 1 - smoothstep(1.8 + n1, 3.4 + n1, sc.d);
    if (scw > 0) {
      for (let k = 0; k < LAYER_SLOTS; k++) out[k] *= 1 - scw;
      out[L_DIRT] += scw;
    }
    // River banks & bed.
    const rc = this.riverCoords(x, z);
    if (rc.a < 20 && rc.b > this.river.bMin - 8 && rc.b < this.river.bMax + 8) {
      const wet = 1 - smoothstep(5.5, 8.5 + n1, rc.a);
      if (wet > 0) {
        for (let k = 0; k < LAYER_SLOTS; k++) out[k] *= 1 - wet;
        out[L_RIVERBED] += wet;
      }
    }
    // Steep slopes show rock (valley walls): red sandstone in the canyon, snow-dusted rock on the pass.
    const steep = smoothstep(0.65, 0.95, slope) * (1 - 0.75 * wDesert);
    if (steep > 0) {
      for (let k = 0; k < LAYER_SLOTS; k++) out[k] *= 1 - steep;
      out[L_ROCK] += steep * (1 - wCanyon) * (1 - wSnow * 0.4);
      out[L_REDROCK] += steep * wCanyon;
      out[L_SNOW] += steep * wSnow * 0.4;
    }
    // Snow caps on high ground around the pass.
    if (wSnow > 0 && f.d > hw + 4) {
      const cap = wSnow * smoothstep(0.2, 0.6, (h - this.roadYAt(s)) / 12 + n1 * 0.3);
      for (let k = 0; k < LAYER_SLOTS; k++) out[k] *= 1 - cap;
      out[L_SNOW] += cap;
    }
    let sum = 0;
    for (let k = 0; k < LAYER_SLOTS; k++) sum += out[k];
    for (let k = 0; k < LAYER_SLOTS; k++) out[k] /= sum || 1;
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
          // Past the ends the field keeps growing (behind the start / beyond the run-off).
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

  /** River centre-line: offset beside the riverside road, a bend across the road line, then on through the ford. */
  private buildRiver(level: number): RiverFrame {
    const line = this.line;
    const loopS = line.tagS.riverLoop0! + 40;
    const P0 = this.centre(loopS);
    const D = this.dirAt(loopS);
    const R = new THREE.Vector2(-D.y, D.x); // right of travel (x,z): (−tz, tx)
    const fordMid = this.centre(line.tagS.ford! + 23);
    const M = fordMid.clone().sub(P0);
    const fwd = M.dot(D);
    const fordLat = M.dot(R); // the ford is on the left (−R side) of the loop
    const origin = P0.clone().addScaledVector(D, fwd);
    const fs = fordLat >= 0 ? 1 : -1;
    const along = R.clone().multiplyScalar(fs); // downstream: toward the ford
    const side = -fs; // the upstream river runs on the side away from the ford
    const pts: THREE.Vector2[] = [];
    // 1) Beside the road (riverside run, round the turn), RIVER_OFFSET to the side, up to the loop start.
    const s0 = line.tagS.riverside! - 30;
    const c = new THREE.Vector2();
    const d = new THREE.Vector2();
    for (let s = s0; s <= loopS; s += 3) {
      this.centre(s, c);
      this.dirAt(s, d);
      pts.push(new THREE.Vector2(c.x - d.y * RIVER_OFFSET * side, c.y + d.x * RIVER_OFFSET * side));
    }
    // 2) Straight on, parallel to the road line, then a quarter bend (radius RIVER_OFFSET) across it.
    const sideV = R.clone().multiplyScalar(side);
    const C = origin.clone().addScaledVector(D, -RIVER_OFFSET);
    const startStraight = pts[pts.length - 1].clone();
    const straightEnd = C.clone().addScaledVector(sideV, RIVER_OFFSET);
    const nS = Math.max(1, Math.ceil(startStraight.distanceTo(straightEnd) / 3));
    for (let i = 1; i <= nS; i++) pts.push(startStraight.clone().lerp(straightEnd, i / nS));
    for (let i = 1; i <= 12; i++) {
      const ang = (i / 12) * (Math.PI / 2);
      pts.push(C.clone().addScaledVector(sideV, Math.cos(ang) * RIVER_OFFSET).addScaledVector(D, Math.sin(ang) * RIVER_OFFSET));
    }
    const iOrigin = pts.length - 1;
    // 3) From the bridge line downstream through the ford and 38 m beyond.
    const fordB = Math.abs(fordLat);
    for (let b = 3; b <= fordB + 38; b += 3) pts.push(origin.clone().addScaledVector(along, b));
    // Arc lengths, 0 at the bridge crossing.
    const bs: number[] = [0];
    for (let i = 1; i < pts.length; i++) bs.push(bs[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const b0 = bs[iOrigin];
    for (let i = 0; i < bs.length; i++) bs[i] -= b0;
    return {
      origin,
      across: D.clone(),
      along,
      level,
      water: level - 0.5,
      fordB,
      bMin: bs[0],
      bMax: bs[bs.length - 1],
      points: pts,
      bs,
    };
  }

  /** Rasterise the river polyline into per-node (a, b). */
  private buildRiverField(): void {
    const { points: P, bs } = this.river;
    const Rr = 40;
    const NZ = this.NZ;
    const A = this.riverA;
    const B = this.riverB;
    for (let k = 0; k < P.length - 1; k++) {
      const ax = P[k].x;
      const az = P[k].y;
      const abx = P[k + 1].x - ax;
      const abz = P[k + 1].y - az;
      const len2 = abx * abx + abz * abz || 1;
      const j0 = Math.max(0, Math.floor((Math.min(ax, ax + abx) - Rr - this.x0) / CELL));
      const j1 = Math.min(this.NX - 1, Math.ceil((Math.max(ax, ax + abx) + Rr - this.x0) / CELL));
      const i0 = Math.max(0, Math.floor((Math.min(az, az + abz) - Rr - this.z0) / CELL));
      const i1 = Math.min(NZ - 1, Math.ceil((Math.max(az, az + abz) + Rr - this.z0) / CELL));
      const first = k === 0;
      const last = k === P.length - 2;
      for (let j = j0; j <= j1; j++) {
        const x = this.x0 + j * CELL;
        for (let i = i0; i <= i1; i++) {
          const z = this.z0 + i * CELL;
          let t = ((x - ax) * abx + (z - az) * abz) / len2;
          if (!first && t < 0) t = 0;
          if (!last && t > 1) t = 1;
          const tc = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = x - (ax + abx * tc);
          const dz = z - (az + abz * tc);
          const dd = Math.sqrt(dx * dx + dz * dz);
          const idx = i + j * NZ;
          if (dd < A[idx]) {
            A[idx] = dd;
            // Past the ends b keeps going (so the end taper works).
            B[idx] = bs[k] + t * (bs[k + 1] - bs[k]);
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
    const g = this.gorge;
    const jumpZ = this.zone('jump');
    const lipS = this.finishS + JUMP_RUNUP_M + JUMP_RAMP_LEN_M;
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
        const wCanyon = this.zoneW('canyon', s, 40);
        const wForest = this.zoneW('forest', s, 30);
        const snow = this.snowW(s);
        off += wRocky * 3.2 * (fbm(x / 55, z / 55, 3, 41) + 0.35);
        off += wForest * 2.0 * (fbm(x / 40, z / 40, 2, 43) + 0.3);
        off += wDesert * 2.2 * Math.abs(fbm(x / 42, z / 42, 2, 47)) * 2;
        // The pass: the surrounding mountains rise with the road (and a bit more), snowy peaks behind.
        off += snow * (SNOW_RISE_M + 4 + 5 * fbm(x / 70, z / 70, 3, 49));
        off = THREE.MathUtils.lerp(off, ry + 0.3, wTown * 0.8);
        off = Math.max(off, THREE.MathUtils.lerp(off, riv.level + 0.35 + 0.6 * Math.abs(fbm(x / 30, z / 30, 2, 3)), wRiver));
        // Mud pit: the low ground around the road is boggy too.
        off = THREE.MathUtils.lerp(off, ry + 0.25, wMud * this.mudPitW(s) * (1 - smoothstep(hw + 6, hw + 16, d)));
        // End jump: the countryside drops away with the landing hill (it's a wide valley, not a trench).
        const wJump = smoothstep(jumpZ.startS + JUMP_RUNUP_M - 20, jumpZ.startS + JUMP_RUNUP_M, s);
        if (wJump > 0) off -= wJump * this.jumpDrop(s - lipS) * 0.85;

        const blend = smoothstep(hw + 1.2, hw + 24, d);
        let h = ry + (off - ry) * blend;
        // Off-road roughness (slows cars a little and looks natural) — none in the town.
        const rough = fbm(x / 6, z / 6, 2, 77) * 0.22 * (1 - wTown * 0.8);
        h += rough * smoothstep(hw + 0.6, hw + 3.5, d);
        // Mud ruts on the road surface.
        h += valueNoise(x / 2.3, z / 2.3, 91) * 0.05 * this.mudPitW(s) * (1 - smoothstep(hw, hw + 2, d));
        // Valley walls keep everyone in the world (close, tall and rocky in the canyon).
        const ws = THREE.MathUtils.lerp(WALL_START, CANYON_WALL_START, wCanyon);
        const we = THREE.MathUtils.lerp(WALL_END, CANYON_WALL_END, wCanyon);
        const wh = THREE.MathUtils.lerp(WALL_HEIGHT, CANYON_WALL_HEIGHT, wCanyon) + snow * 10;
        h += wh * smoothstep(ws, we, d) * (0.8 + 0.3 * fbm(x / 60, z / 60, 2, 13)) * (1 + wCanyon * 0.25 * valueNoise(x / 9, z / 9, 17));

        // Canyon gorge: a deep slot across the canyon floor under the road bridge.
        if (Math.abs(s - g.s) < 14 && d < we + 6) {
          const gd = GORGE_DEPTH_M * (1 - smoothstep(GORGE_BRIDGE_M / 2 - 6.5, GORGE_BRIDGE_M / 2 - 3, Math.abs(s - g.s))) * (1 - smoothstep(we - 4, we + 6, d));
          h -= gd * (0.9 + 0.2 * valueNoise(x / 4, z / 4, 19));
        }

        // Log-bridge shortcut path: graded flat across the loop.
        const sc = this.shortcutDist(x, z);
        if (sc.d < 9) {
          const ya = this.roadY[Math.round(this.shortcut.startS / st)];
          const yb = this.roadY[Math.round(this.shortcut.endS / st)];
          const py = ya + (yb - ya) * sc.t;
          const w = 1 - smoothstep(3, 9, sc.d);
          h += (py - h) * w;
        }

        // River channel.
        const ra = this.riverA[idx];
        const rb = this.riverB[idx];
        if (ra < 30 && rb > riv.bMin - 12 && rb < riv.bMax + 12) {
          const endTaper = smoothstep(riv.bMin - 12, riv.bMin, rb) * (1 - smoothstep(riv.bMax, riv.bMax + 12, rb));
          const ford = 1 - smoothstep(7.5, 12, Math.abs(rb - riv.fordB));
          const depth = THREE.MathUtils.lerp(1.45, 0.85, ford) * endTaper;
          const halfBed = THREE.MathUtils.lerp(4, 5, ford);
          const bank = THREE.MathUtils.lerp(0.55, 0.12, ford); // bank slope (rise per m)
          const bed = riv.level - depth + Math.max(0, ra - halfBed) * bank + valueNoise(x / 3, z / 3, 61) * 0.05;
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
    const lipS = this.finishS + JUMP_RUNUP_M + JUMP_RAMP_LEN_M;
    const runoffS = lipS + JUMP_LANDING_M;
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
        else if (zone === 'rocky' || zone === 'canyon') st = onRoad ? 'gravel' : 'dirt';
        // Snowy pass: packed snow is loose and slippery: gravel grip (no new surface type, see DECISIONS.md).
        else if (zone === 'snow') st = 'gravel';
        else if (zone === 'desert') st = 'sand';
        else if (zone === 'jump') {
          if (f.s >= runoffS - 1) st = 'sand';
          else if (f.s < lipS && onRoad) st = 'asphalt';
          else st = 'dirt';
        }
        if (this.shortcutDist(x, z).d < 2.4 && zone === 'river') st = 'dirt';
        const rc = this.riverCoords(x, z);
        if (rc.a < 12 && rc.b > riv.bMin - 12 && rc.b < riv.bMax + 12 && this.heightAt(x, z) < riv.water - 0.02) st = 'water';
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
    for (const l of this.logs) if (Math.hypot(l.x - p.x, l.z - p.z) < l.length / 2 + 5) return false;
    if (s > this.gorge.s0 - 10 && s < this.gorge.s1 + 10) return false;
    if (this.surfaceAt(p.x, p.z) === 'water') return false;
    return true;
  }

  private tagS(tag: SegmentTag): number {
    return this.line.tagS[tag]!;
  }

  private placeFeatures(): void {
    const r = this.rand;
    const zFarm = this.zone('farm');
    const zRocky = this.zone('rocky');
    const zTown = this.zone('town');
    const zForest = this.zone('forest');
    const zCanyon = this.zone('canyon');
    const zSnow = this.zone('snow');
    const zDesert = this.zone('desert');

    // ---- jump ramps on the straights: rocky hills ×2, forest log ramp, canyon rock ramp, desert dune jumps ×2
    const ramp = (tag: SegmentTag, style: number, halfWidth: number, length = 9, height = 1.35, off = 40): void => {
      const s = this.tagS(tag) + off;
      const sp = this.spawnAt(s, 0);
      this.ramps.push({ x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, halfWidth, length, height, style });
      this.keepOut.push({ x: sp.x, z: sp.z, r: 16 });
    };
    ramp('rampA', 0, 3.6);
    ramp('rampB', 0, 3.6);
    ramp('rampForest', 0, 3.2, 8, 1.1, 30);
    ramp('rampCanyon', 2, 4.2, 10, 1.5, 35);
    ramp('rampDesertA', 1, 4.4, 11, 1.4, 45);
    ramp('rampDesertB', 1, 4.4, 11, 1.6, 70);

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
    // A soft wall of hay at the far end of the run-off (in front of the berm).
    {
      const s = this.jump.runoffS + JUMP_RUNOFF_M - 40;
      for (let k = -4; k <= 4; k++) this.hay.push(this.at(s, k * 1.5, Math.PI / 2, 1, 0));
    }

    // ---- cones: slalom gates on the farm road, roadworks in town, gates over the snowy pass
    for (let g = 0; g < 4; g++) {
      const s = zFarm.startS + 70 + g * 85;
      for (let k = 0; k < 4; k++) this.cones.push(this.at(s + k * 7, (k % 2 ? 1 : -1) * 2.2, 0, 1, 0));
    }
    for (let k = 0; k < 6; k++) this.cones.push(this.at(zTown.startS + 230 + k * 4, -4.5 + k * 0.15, 0, 1, 0));
    for (let g = 0; g < 4; g++) {
      const s = zSnow.startS + 90 + g * 105;
      for (let k = 0; k < 5; k++) this.cones.push(this.at(s + k * 6, (k % 2 ? 1 : -1) * 2.4, 0, 1, 0));
    }
    // Cones lining the run-up (a kid-readable "drag strip").
    for (let s = this.finishS + 20; s < this.jump.footS - 8; s += 24) {
      for (const side of [-1, 1]) this.cones.push(this.at(s, side * (ROAD_HALF_WIDTH.jump + 0.8), 0, 1, 0));
    }

    // ---- potholes on the farm road
    for (let k = 0; k < 10; k++) {
      const s = zFarm.startS + 45 + k * 36 + r() * 12;
      const hw = this.halfWidthAt(s);
      this.potholes.push(this.at(s, (r() * 2 - 1) * (hw - 1.6), r() * Math.PI, 0.8 + r() * 0.5, 0));
    }

    // ---- boulders: on the road edges (steer around) and many off-road, in the rocky hills and the canyon
    const roadBoulders = (z: Zone, list: number[], v0: number): void => {
      for (const ds of list) {
        const s = z.startS + ds;
        const c = this.centre(s);
        if (this.keepOut.some((k) => Math.hypot(c.x - k.x, c.y - k.z) < k.r)) continue;
        if (s > this.gorge.s0 - 12 && s < this.gorge.s1 + 12) continue;
        const hw = this.halfWidthAt(s);
        const side = r() < 0.5 ? -1 : 1;
        this.boulders.push(this.at(s, side * (hw - 2.0 - r() * 0.8), r() * 6, 1.0 + r() * 0.35, v0 + Math.floor(r() * 3)));
      }
    };
    roadBoulders(zRocky, [40, 120, 175, 255, 330, 395, 430], 0);
    roadBoulders(zCanyon, [30, 95, 150, 230, 310, 420, 470, 540], 3);
    const offBoulders = (z: Zone, count: number, spread: number, v0: number): void => {
      for (let k = 0; k < count; k++) {
        const s = z.startS - 20 + r() * (z.endS - z.startS + 40);
        const hw = this.halfWidthAt(s);
        const side = r() < 0.5 ? -1 : 1;
        const lat = side * (hw + 2.5 + r() * spread);
        this.boulders.push(this.at(s, lat, r() * 6, 0.9 + r() * 1.6, v0 + Math.floor(r() * 3)));
      }
    };
    offBoulders(zRocky, 70, 38, 0);
    offBoulders(zCanyon, 50, 10, 3);
    offBoulders(zSnow, 25, 36, 0);

    // ---- fallen logs on the forest trail (fixed; poke onto the road from alternating sides)
    for (const ds of [60, 150, 250, 330, 420, 520]) {
      const s = zForest.startS + ds;
      const c = this.centre(s);
      if (this.keepOut.some((k) => Math.hypot(c.x - k.x, c.y - k.z) < k.r)) continue;
      const hw = this.halfWidthAt(s);
      const side = (ds / 10) % 2 ? 1 : -1;
      const len = 5 + r() * 2;
      // Lying roughly across the edge: the inner end ~1.8 m into the road.
      const p = this.at(s, side * (hw - 1.8 + len / 2 - 0.4), Math.PI / 2 + (r() - 0.5) * 0.5);
      this.logs.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, length: len, radius: 0.32 + r() * 0.08 });
      this.keepOut.push({ x: p.x, z: p.z, r: len / 2 + 1 });
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

    // ---- fences: both sides of the farm road, short runs in town, along the run-up
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
      fenceRun(this.finishS + 12, this.jump.footS - 4, side * (ROAD_HALF_WIDTH.jump + 3));
    }

    // ---- trees, bushes, rocks and grass tufts by zone (jittered grid, cheap rejection)
    const step = 9;
    const f = { d: 0, s: 0, lat: 0 };
    const DENSITY: Partial<Record<ZoneId, number>> = { desert: 0.03, town: 0.18, farm: 0.22, mud: 0.3, rocky: 0.28, river: 0.4, forest: 0.62, canyon: 0.04, snow: 0.3, finish: 0.25, jump: 0.2 };
    for (let x = this.x0 + 4; x < this.x0 + (this.NX - 1) * CELL - 4; x += step) {
      for (let z = this.z0 + 4; z < this.z0 + (this.NZ - 1) * CELL - 4; z += step) {
        const px = x + (r() - 0.5) * step;
        const pz = z + (r() - 0.5) * step;
        this.fieldsAt(px, pz, f);
        if (f.d > WALL_END + 6) continue;
        const hw = this.halfWidthAt(f.s);
        const zone = this.zoneAt(f.s).id;
        if (f.d < hw + (zone === 'forest' ? 3.5 : 6)) continue;
        if (zone === 'jump' && f.d < hw + 18 && f.s > this.jump.footS - 30) continue; // keep the landing zone open
        if (this.keepOut.some((k) => Math.hypot(px - k.x, pz - k.z) < k.r)) continue;
        if (this.shortcutDist(px, pz).d < 6) continue;
        if (this.nearRiver(px, pz, 10, 14)) continue;
        if (Math.abs(f.s - this.gorge.s) < 16) continue;
        const y = this.heightAt(px, pz);
        const roll = r();
        const pl = (): Placement => ({ x: px, z: pz, y, yaw: r() * Math.PI * 2, scale: 0.75 + r() * 0.6, v: Math.floor(r() * 4) });
        const nearRoad = f.d < hw + 18;
        const density = DENSITY[zone] ?? 0.25;
        const snowy = this.snowW(f.s) > 0.45;
        if (roll < density * (nearRoad ? (zone === 'forest' ? 0.9 : 0.6) : 1) * (f.d > WALL_START ? 1.4 : 1)) {
          if (zone === 'desert') (r() < 0.45 ? this.cacti : this.bushes).push(pl());
          else if (zone === 'canyon') this.bushes.push(pl());
          else if (snowy) this.snowPines.push(pl());
          else if (zone === 'forest') (r() < 0.6 ? this.pines : this.trees).push(pl());
          else if (zone === 'rocky' || f.d > WALL_START + 6) (r() < 0.75 ? this.pines : this.trees).push(pl());
          else (r() < 0.25 ? this.pines : this.trees).push(pl());
        } else if (roll < density + (zone === 'snow' || zone === 'canyon' ? 0.02 : 0.12)) {
          this.bushes.push(pl());
        } else if (roll < density + 0.12 + (zone === 'rocky' || zone === 'desert' || zone === 'canyon' || zone === 'snow' ? 0.35 : 0.08)) {
          this.rocks.push(pl());
        }
      }
    }
    // Grass tufts: dense near the road edges (where the camera is), sparse farther out.
    const noTufts = new Set<ZoneId>(['desert', 'canyon', 'snow']);
    for (let k = 0; k < 15000; k++) {
      const s = r() * this.length;
      const zone = this.zoneAt(s).id;
      if (noTufts.has(zone)) continue;
      if (zone === 'mud' && this.mudPitW(s) > 0.1) continue;
      if (zone === 'jump' && s > this.jump.runoffS - 10) continue;
      if (this.snowW(s) > 0.3) continue;
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

    // ---- animal crossing spots (zone-matched). The animal system picks 4–6 of these per race.
    const spot = (kind: AnimalKind, zone: ZoneId, fr: number): void => {
      const z = this.zone(zone);
      this.animalSpots.push({ kind, zone, s: z.startS + (z.endS - z.startS) * fr });
    };
    spot('mouse', 'town', 0.55);
    spot('mouse', 'town', 0.8);
    spot('deer', 'farm', 0.35);
    spot('cow', 'farm', 0.2);
    spot('bull', 'farm', 0.6);
    spot('rabbit', 'farm', 0.85);
    spot('bear', 'farm', 0.75);
    spot('croc', 'mud', 0.5);
    spot('deer', 'rocky', 0.3);
    spot('goat', 'rocky', 0.55);
    spot('bear', 'rocky', 0.8);
    spot('moose', 'forest', 0.3);
    spot('boar', 'forest', 0.55);
    spot('rabbit', 'forest', 0.75);
    spot('deer', 'forest', 0.9);
    spot('goat', 'canyon', 0.25);
    spot('goat', 'canyon', 0.75);
    spot('moose', 'snow', 0.5);
    spot('camel', 'desert', 0.45);
    spot('camel', 'desert', 0.8);
    spot('duck', 'river', 0.15);
    spot('croc', 'river', 0.45);
    void zDesert;
  }
}

/** Horizontal-distance TrackPath over the course centre-line (uniform 2 m samples → O(1) lookups). */
export class CourseTrack implements TrackPath {
  readonly length: number;
  readonly finishS: number;
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
    this.ys = new Float32Array(this.xs.length);
    // Ground under the wheels: the terrain, except on the gorge bridge deck.
    for (let k = 0; k < this.xs.length; k++) {
      const s = k * this.step;
      this.ys[k] = c.onGorgeBridge(s) ? c.gorgeDeckY(s) : c.heightAt(this.xs[k], this.zs[k]);
    }
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

/**
 * Landing-hill angle (degrees, downhill) at u m past the lip: a short flat "table", then it steepens to
 * JUMP_LAND_DEG, holds, and rounds out into the flat run-off (so landings are gentle glancing blows).
 */
function landAngle(u: number): number {
  const T = JUMP_TABLE_M;
  const L = JUMP_LANDING_M;
  if (u < T) return 0;
  if (u < T + 20) return JUMP_LAND_DEG * smoothstep(T, T + 20, u);
  if (u < L - 30) return JUMP_LAND_DEG;
  if (u < L) return JUMP_LAND_DEG * (1 - smoothstep(L - 30, L, u));
  return 0;
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
