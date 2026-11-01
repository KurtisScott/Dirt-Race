import * as THREE from 'three';
import { clamp, lerp, rng } from '../core/math';
import type { Difficulty, DriveInput, System } from '../core/types';
import { paramsFromSpec } from '../vehicles/params';
import type { VehicleParams, VehicleState } from '../vehicles/types';
import { PolylineTrack } from '../world/polylineTrack';
import { SURFACES } from '../world/surfaces';
import type { World } from '../world/types';
import type { AIWorldExtras, ObstacleSensor, RivalInfo, TrackShortcut } from './types';

export type { AIWorldExtras, ObstacleSensor, RivalInfo, TrackShortcut } from './types';

/** Per-difficulty personality (SPEC "Computer opponent"). */
export interface DifficultyProfile {
  /** Fraction of the car's own top speed it will ever ask for. */
  topFrac: number;
  /** Cornering aggressiveness (scales the lateral-acceleration budget). */
  corner: number;
  /** Seconds between mistakes [min, max]; null = clean driver. */
  mistakeGap: [number, number] | null;
  /** How far toward the inside of a curve the racing line cuts (0 = centre-line, 1 = full width). */
  lineCut: number;
  /** Ease off when this far ahead (m); null = never. */
  easeOffAheadM: number | null;
  /** Take shortcuts the world exposes. */
  shortcuts: boolean;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  easy: {
    topFrac: 0.8,
    corner: 0.8,
    mistakeGap: [5, 10],
    lineCut: 0.25,
    easeOffAheadM: 35,
    shortcuts: false,
  },
  normal: {
    topFrac: 0.92,
    corner: 0.92,
    mistakeGap: [14, 26],
    lineCut: 0.45,
    easeOffAheadM: null,
    shortcuts: false,
  },
  hard: {
    topFrac: 1,
    corner: 1.05,
    mistakeGap: null,
    lineCut: 0.6,
    easeOffAheadM: null,
    shortcuts: true,
  },
};

type Mistake = 'wobble' | 'lift' | 'wide' | 'late';

const DS = 2; // profile sample spacing (m)
const SENSE_EVERY = 5; // obstacle rays every N steps (12 Hz)
const RAY_ANGLES = [0, 0.1, -0.1, 0.22, -0.22];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

/**
 * Computer driver. Produces a DriveInput for its vehicle every physics step; never touches physics
 * (SPEC: same physics, no speed cheating). The race controller assigns its `input` to the cpu vehicle
 * and toggles `enabled`.
 *
 * How it drives (all O(1) per step except a ±25-segment projection):
 *  - Racing line: centre-line plus a smoothed lateral offset toward the inside of curves (precomputed).
 *  - Speed profile (precomputed per car): v = √(a_lat·R) from curvature × surface grip, slowed for steep
 *    downhills and crests, then a backward braking pass so it brakes *before* curves.
 *  - Pure-pursuit steering toward a look-ahead point that grows with speed.
 *  - Obstacles: five forward rays (via ObstacleSensor) at 12 Hz; hits are remembered in track space and a
 *    tiny lane planner picks the clear lateral offset closest to the racing line.
 *  - Stuck: reverses out, then asks the race for a Reset (same 2 s rule as Brooks) if still not moving.
 *  - Mistakes: wobbles, throttle lifts, wide lines, late braking (seeded RNG, per difficulty).
 */
export class AIDriver implements System {
  readonly input: DriveInput = { steer: 0, throttle: 0, brake: 0 };
  enabled = false;
  /** Called when the AI wants a reset (stuck). Race controller wires this to requestReset('cpu'). */
  onRequestReset: (() => void) | null = null;
  /** Optional obstacle sensor (ray casts). Without it the AI just follows its line. */
  sensor: ObstacleSensor | null = null;
  /** Optional rival info for Easy's ease-off. */
  rival: RivalInfo | null = null;
  /** Debug: what the AI is doing right now. */
  state: 'drive' | 'recover' | 'waitReset' = 'drive';
  mistake: Mistake | null = null;

  private profile: DifficultyProfile;
  private params: VehicleParams;
  private s = 0;
  private lateral = 0;
  private vmax: Float32Array; // speed profile (m/s)
  private line: Float32Array; // racing-line lateral offset (m, + = right)
  private slope: Float32Array; // dy/ds
  private n: number;
  private rand: () => number;
  private steps = 0;
  private time = 0;

  // obstacle avoidance: remembered ray hits in track space
  private obstacles: { s: number; lat: number; ttl: number }[] = [];
  private avoidLat: number | null = null;
  // mistakes
  private nextMistakeT = 0;
  private mistakeT = 0;
  private mistakeSign = 1;
  // stuck handling
  private slowT = 0;
  private recoverT = 0;
  private recoverSteer = 0;
  private recoveries = 0;
  private watchS = 0;
  private watchT = 0;
  private waitResetT = 0;
  // shortcut
  private shortcut: {
    def: TrackShortcut;
    path: PolylineTrack;
    s: number;
  } | null = null;
  private shortcutsTaken = new Set<string>();

  constructor(
    private vehicle: VehicleState,
    private world: World,
    public difficulty: Difficulty,
    seed = (Math.random() * 1e9) | 0,
  ) {
    this.profile = DIFFICULTY[difficulty];
    this.params = paramsFromSpec(vehicle.spec);
    this.rand = rng(seed);
    this.n = Math.max(2, Math.ceil(world.track.length / DS) + 1);
    this.vmax = new Float32Array(this.n);
    this.line = new Float32Array(this.n);
    this.slope = new Float32Array(this.n);
    this.buildProfile();
    this.scheduleMistake();
  }

  /** Change difficulty between races (rebuilds the speed profile). */
  setDifficulty(d: Difficulty): void {
    this.difficulty = d;
    this.profile = DIFFICULTY[d];
    this.buildProfile();
    this.scheduleMistake();
  }

  /** Current distance along the track the AI believes it is at. */
  get trackS(): number {
    return this.shortcut ? this.shortcut.def.startS : this.s;
  }

  // ------------------------------------------------------------------ precompute

  private buildProfile(): void {
    const track = this.world.track;
    const n = this.n;
    const p = this.params;
    const prof = this.profile;
    const curv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i * DS;
      track.tangentAt(Math.max(0, s - 5), _t1);
      track.tangentAt(Math.min(track.length, s + 5), _t2);
      // Signed heading change, + = turning right (lateral > 0 side).
      const cross = _t1.x * _t2.z - _t1.z * _t2.x;
      const dot = _t1.x * _t2.x + _t1.z * _t2.z;
      curv[i] = Math.atan2(cross, dot) / 10;
      const y0 = track.pointAt(Math.max(0, s - 4), _a).y;
      const y1 = track.pointAt(Math.min(track.length, s + 4), _b).y;
      this.slope[i] = (y1 - y0) / 8;
    }
    // Racing line: offset toward the inside of curves, smoothed so it drifts in to the apex.
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const hw = track.halfWidthAt(i * DS);
      const k = curv[i];
      raw[i] = Math.sign(k) * clamp(Math.abs(k) * 40, 0, 1) * Math.max(0, hw - 2) * prof.lineCut;
    }
    const W = 10; // ±20 m
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let c = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) {
        sum += raw[j];
        c++;
      }
      this.line[i] = sum / c;
    }
    // Speed limits.
    const top = p.topSpeed * prof.topFrac;
    const gripCar = clamp(p.frictionSlip / 1.7, 0.75, 1.25);
    for (let i = 0; i < n; i++) {
      const s = i * DS;
      const c = track.pointAt(s, _a);
      const surf = SURFACES[this.world.surfaceAt(c.x, c.z)];
      const surfGrip = 1 - (1 - surf.grip) * (1 - 0.55 * p.offroad);
      // Peak curvature nearby (a short window catches hairpins between samples).
      let k = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) k = Math.max(k, Math.abs(curv[j]));
      const aLat = 6.5 * gripCar * surfGrip * prof.corner;
      let v = k > 1e-4 ? Math.sqrt(aLat / k) : top;
      const slope = this.slope[i];
      if (slope < -0.18) v = Math.min(v, lerp(18, 11, clamp((-slope - 0.18) / 0.25, 0, 1))); // steep downhill
      const next = this.slope[Math.min(n - 1, i + 3)];
      if (slope - next > 0.18) v = Math.min(v, 15); // crest: don't launch into the air
      this.vmax[i] = Math.min(top, Math.max(6, v));
    }
    // Backward pass: be able to brake down to every later limit.
    const aBrake = 6 * prof.corner;
    for (let i = n - 2; i >= 0; i--) this.vmax[i] = Math.min(this.vmax[i], Math.sqrt(this.vmax[i + 1] ** 2 + 2 * aBrake * DS));
  }

  private idx(s: number): number {
    return clamp(Math.round(s / DS), 0, this.n - 1);
  }

  private scheduleMistake(): void {
    const g = this.profile.mistakeGap;
    this.nextMistakeT = g ? this.time + lerp(g[0], g[1], this.rand()) : Infinity;
  }

  // ------------------------------------------------------------------ driving

  fixedUpdate(dt: number): void {
    const inp = this.input;
    if (!this.enabled) {
      inp.steer = inp.throttle = inp.brake = 0;
      return;
    }
    this.time += dt;
    this.steps++;
    const v = this.vehicle;
    const track = this.world.track;
    const speed = v.speed;
    const absSpeed = Math.abs(speed);

    const proj = track.project(v.position, this.s);
    if (Math.abs(proj.s - this.s) > 40 && this.steps > 1) {
      // Teleported (reset): resync without hint.
      const fresh = track.project(v.position);
      this.s = fresh.s;
      this.lateral = fresh.lateral;
      this.onTeleport();
    } else {
      this.s = proj.s;
      this.lateral = proj.lateral;
    }

    // ---- waiting for a requested reset: sit still
    if (this.state === 'waitReset') {
      this.waitResetT -= dt;
      inp.steer = 0;
      inp.throttle = 0;
      inp.brake = absSpeed > 0.7 ? 1 : 0;
      if (this.waitResetT <= 0) this.state = 'drive';
      return;
    }

    this.updateMistakes(dt);

    // ---- target point (racing line or shortcut)
    const lookAhead = 5 + absSpeed * 0.55;
    let tx: number;
    let tz: number;
    let targetSpeed: number;
    const sc = this.updateShortcut();
    if (sc) {
      const sp = sc.path.project(v.position, sc.s);
      sc.s = sp.s;
      const pt = sc.path.pointAt(sc.s + lookAhead, _a);
      tx = pt.x;
      tz = pt.z;
      targetSpeed = Math.min(sc.def.maxSpeed ?? 12, this.params.topSpeed * this.profile.topFrac);
    } else {
      const sAhead = Math.min(this.s + lookAhead, track.length);
      const hw = track.halfWidthAt(sAhead);
      let lat = this.line[this.idx(sAhead)];
      if (this.mistake === 'wide') lat = this.mistakeSign * hw * 0.6;
      lat = clamp(lat, -hw + 1.2, hw - 1.2);
      if (this.sensor && this.steps % SENSE_EVERY === 0) this.sense();
      this.avoidLat = this.planLateral(lat, hw, dt);
      if (this.avoidLat !== null) lat = this.avoidLat;
      const pt = track.pointAt(sAhead, _a);
      const tg = track.tangentAt(sAhead, _t1);
      // right of travel = (−tz, 0, tx)
      tx = pt.x - tg.z * lat;
      tz = pt.z + tg.x * lat;
      // Speed: limit a little ahead (reaction time) and right here.
      const lead = this.mistake === 'late' ? 0 : absSpeed * 0.35;
      targetSpeed = Math.min(this.vmax[this.idx(this.s + lead)], this.vmax[this.idx(this.s + lead + 6)]);
      if (this.mistake === 'late') targetSpeed *= 1.3;
      if (this.avoidLat !== null) targetSpeed = Math.min(targetSpeed, Math.max(10, absSpeed * 0.92));
    }

    // Easy: ease off when well ahead (SPEC).
    const ease = this.profile.easeOffAheadM;
    if (ease !== null && this.rival) {
      const gap = this.rival.gapM();
      if (gap > ease) targetSpeed *= lerp(1, 0.6, clamp((gap - ease) / 80, 0, 1));
    }

    // ---- pure pursuit
    const fx = v.forward.x;
    const fz = v.forward.z;
    const dx = tx - v.position.x;
    const dz = tz - v.position.z;
    const cross = fz * dx - fx * dz; // > 0 → target on the left
    const dot = fx * dx + fz * dz;
    const alpha = Math.atan2(cross, dot); // + = left
    const ld = Math.max(3, Math.hypot(dx, dz));
    const wheelbase = this.params.wheelZ * 2;
    const delta = Math.atan2(2 * wheelbase * Math.sin(alpha), ld);
    const speedT = clamp(absSpeed / this.params.topSpeed, 0, 1);
    const maxSteer = this.params.steerLow + (this.params.steerHigh - this.params.steerLow) * Math.sqrt(speedT);
    let steer = clamp(-delta / maxSteer, -1, 1);

    // ---- mistakes
    if (this.mistake === 'wobble') steer = clamp(steer + Math.sin(this.time * 8) * 0.45, -1, 1);

    // ---- speed control
    let throttle = 0;
    let brake = 0;
    const err = targetSpeed - speed;
    if (err > 0) throttle = clamp(0.35 + err * 0.4, 0, 1);
    else if (err < -2.5 && speed > 3) brake = clamp((-err - 2.5) / 6, 0.2, 1);
    else throttle = clamp(0.3 + err * 0.15, 0, 0.6);
    // Sharp angle to the target at speed: lift.
    if (Math.abs(alpha) > 0.7 && absSpeed > 8) {
      throttle = Math.min(throttle, 0.3);
      if (absSpeed > 14) brake = Math.max(brake, 0.4);
    }
    // Uphill (bonus hill): never feather the throttle.
    if (this.slope[this.idx(this.s)] > 0.2 && err > -1) throttle = 1;
    if (this.mistake === 'lift') throttle *= 0.15;

    // ---- facing the wrong way (after a spin): three-point turn
    if (Math.abs(alpha) > 1.9 && absSpeed < 5 && this.recoverT <= 0) {
      this.startRecovery(alpha > 0 ? 1 : -1, 1.6);
    }

    // ---- stuck detection
    this.updateStuck(dt, throttle);
    if (this.recoverT > 0) {
      this.recoverT -= dt;
      inp.steer = this.recoverSteer;
      inp.throttle = 0;
      inp.brake = 1; // brake at standstill = reverse
      return;
    }

    inp.steer = steer;
    inp.throttle = throttle;
    inp.brake = brake;
  }

  private updateMistakes(dt: number): void {
    if (this.mistake) {
      this.mistakeT -= dt;
      if (this.mistakeT <= 0) {
        this.mistake = null;
        this.scheduleMistake();
      }
      return;
    }
    if (this.time < this.nextMistakeT) return;
    const r = this.rand();
    this.mistake = r < 0.3 ? 'wobble' : r < 0.55 ? 'lift' : r < 0.8 ? 'wide' : 'late';
    this.mistakeSign = this.rand() < 0.5 ? -1 : 1;
    this.mistakeT = this.mistake === 'wide' ? lerp(1.5, 3, this.rand()) : lerp(0.6, 1.4, this.rand());
  }

  /**
   * Fan of five forward rays. Each hit is remembered as (s, lateral) in track space for ~1.5 s, then
   * `planLateral` picks the lane that clears every remembered obstacle ahead while staying closest to
   * the racing line. Handles slaloms (drive the gap) and single blockers (go round the freer side).
   */
  private sense(): void {
    const v = this.vehicle;
    const sensor = this.sensor!;
    const absSpeed = Math.abs(v.speed);
    if (absSpeed < 2) return;
    const half = v.spec.size.length / 2 + 0.3;
    const ox = v.position.x + v.forward.x * half;
    const oy = v.position.y + 0.1;
    const oz = v.position.z + v.forward.z * half;
    const range = Math.min(45, 10 + absSpeed * 1.3);
    const yaw = Math.atan2(v.forward.x, v.forward.z);
    const fy = v.forward.y;
    const track = this.world.track;
    for (const a of RAY_ANGLES) {
      const dx = Math.sin(yaw + a);
      const dz = Math.cos(yaw + a);
      const d = sensor.cast(ox, oy, oz, dx, fy, dz, range);
      if (d === null) continue;
      _a.set(ox + dx * d, oy, oz + dz * d);
      const pr = track.project(_a, this.s);
      this.addObstacle(pr.s, pr.lateral);
    }
  }

  private addObstacle(s: number, lateral: number): void {
    // Merge with a nearby remembered hit.
    for (const o of this.obstacles) {
      if (Math.abs(o.s - s) < 1.5 && Math.abs(o.lat - lateral) < 1.2) {
        o.s = (o.s + s) / 2;
        o.lat = (o.lat + lateral) / 2;
        o.ttl = 1.5;
        return;
      }
    }
    if (this.obstacles.length >= 12) this.obstacles.shift();
    this.obstacles.push({ s, lat: lateral, ttl: 1.5 });
  }

  /** Lateral target (m) that avoids remembered obstacles, or null if the preferred line is clear. */
  private planLateral(preferred: number, hw: number, dt: number): number | null {
    const obs = this.obstacles;
    for (let i = obs.length - 1; i >= 0; i--) {
      obs[i].ttl -= dt;
      if (obs[i].ttl <= 0 || obs[i].s < this.s - 2) obs.splice(i, 1);
    }
    if (!obs.length) return null;
    const clear = this.vehicle.spec.size.width / 2 + 1.0; // car half-width + hay radius + margin
    const horizon = this.s + 10 + Math.abs(this.vehicle.speed) * 1.6;
    const blocked = (lat: number): boolean => {
      for (const o of obs) if (o.s > this.s - 1 && o.s < horizon && Math.abs(lat - o.lat) < clear) return true;
      return false;
    };
    // Avoid only if the racing line actually passes an obstacle (checked at each obstacle's own s).
    let need = false;
    for (const o of obs) {
      if (o.s > this.s - 1 && o.s < horizon && Math.abs(this.line[this.idx(o.s)] - o.lat) < clear) {
        need = true;
        break;
      }
    }
    if (!need && !blocked(preferred)) return null;
    const lo = -hw + 1.2;
    const hi = hw - 1.2;
    let best: number | null = null;
    let bestCost = Infinity;
    for (let lat = lo; lat <= hi + 1e-6; lat += 0.5) {
      if (blocked(lat)) continue;
      const cost = Math.abs(lat - preferred) * 0.6 + Math.abs(lat - this.lateral);
      if (cost < bestCost) {
        bestCost = cost;
        best = lat;
      }
    }
    // Nothing clear: slow down and aim for the preferred line (bump through light debris).
    return best ?? preferred;
  }

  private startRecovery(dirSign: number, seconds: number): void {
    // Reversing: steering is mirrored, so steer away from the target to swing the nose toward it.
    this.recoverSteer = dirSign;
    this.recoverT = seconds;
    this.recoveries++;
  }

  private updateStuck(dt: number, throttle: number): void {
    const absSpeed = Math.abs(this.vehicle.speed);
    if (this.recoverT <= 0 && throttle > 0.4 && absSpeed < 1) this.slowT += dt;
    else if (absSpeed > 3) this.slowT = 0;
    if (this.slowT > 1.3 && this.recoverT <= 0) {
      this.slowT = 0;
      this.startRecovery(this.rand() < 0.5 ? -1 : 1, 1.3);
    }
    // Progress watchdog: no real progress for a while (or too many recoveries) → Reset like Brooks would.
    this.watchT += dt;
    const progressed = this.s - this.watchS > 12;
    if (progressed) {
      this.watchS = this.s;
      this.watchT = 0;
      this.recoveries = 0;
    } else if (this.watchT > 9 || this.recoveries >= 3) {
      this.requestReset();
    }
  }

  private requestReset(): void {
    this.watchT = 0;
    this.recoveries = 0;
    this.recoverT = 0;
    this.slowT = 0;
    this.state = 'waitReset';
    this.waitResetT = 3; // race waits 2 s, then teleports
    this.onRequestReset?.();
  }

  private onTeleport(): void {
    this.state = 'drive';
    this.recoverT = 0;
    this.slowT = 0;
    this.avoidLat = null;
    this.obstacles.length = 0;
    this.shortcut = null;
    this.watchS = this.s;
    this.watchT = 0;
  }

  /** Hard only: follow a world-exposed shortcut (log bridge) when we reach its entrance. */
  private updateShortcut(): {
    def: TrackShortcut;
    path: PolylineTrack;
    s: number;
  } | null {
    if (!this.profile.shortcuts) return null;
    const list = (this.world as World & AIWorldExtras).shortcuts;
    if (!list?.length) return null;
    if (this.shortcut) {
      const sc = this.shortcut;
      if (sc.s >= sc.path.length - 4 || this.s >= sc.def.endS - 2) {
        this.shortcut = null;
        return null;
      }
      return sc;
    }
    for (const def of list) {
      if (this.shortcutsTaken.has(def.id) || def.points.length < 2) continue;
      if (this.s > def.startS - 12 && this.s < def.startS + 5) {
        const path = new PolylineTrack(def.points as THREE.Vector3[], def.halfWidth ?? 2, 0, 0);
        this.shortcut = { def, path, s: path.project(this.vehicle.position).s };
        this.shortcutsTaken.add(def.id);
        return this.shortcut;
      }
    }
    return null;
  }

  /** New race: forget per-race state (shortcuts taken, timers). */
  resetRace(): void {
    this.s = 0;
    this.steps = 0;
    this.time = 0;
    this.shortcutsTaken.clear();
    this.onTeleport();
    this.mistake = null;
    this.scheduleMistake();
  }

  update(): void {
    // All work happens in fixedUpdate (deterministic, before the vehicle reads its input).
  }
}
export { createPhysicsSensor } from './sensor';
