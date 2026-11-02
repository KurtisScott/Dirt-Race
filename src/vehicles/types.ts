import type * as THREE from 'three';
import type { DriveInput, RacerId, SpawnPoint, SurfaceType, System, VehicleKind, VehicleStats } from '../core/types';

/** Static description of a vehicle kind (catalog entry). */
export interface VehicleSpec {
  kind: VehicleKind;
  /** Display name for the spin reel / results. */
  name: string;
  stats: VehicleStats;
  /** Three paint colours to pick from at random (hex). */
  paints: [number, number, number];
  /** Short line shown on the spin screen. */
  blurb: string;
  /** Body dimensions (metres) used by params and the procedural models. */
  size: { length: number; width: number; height: number };
  wheelRadius: number;
  /** Optional bigger rear wheels (tractor). Front wheels use `wheelRadius`. */
  rearWheelRadius?: number;
  drive: 'front' | 'rear' | 'all';
  /** Sound profile id the audio module uses to pick an engine synth. */
  engineSound: EngineSoundId;
  /**
   * Hidden hill-climb ability 1..5 (was the visible "Hill climb" stat before Round 2). Still drives the
   * steep-slope traction/power limits in params.ts, so steep terrain keeps its personality.
   */
  climb: number;
  /** Optional chassis tuning (defaults reproduce the original six). See params.ts. */
  tune?: VehicleTune;
  /** Where the engine sits along the body, as a fraction of length from the centre (+ = front). Smoke comes from here. Default 0.3. */
  engineZ?: number;
  /** Damage multiplier: < 1 shrugs off hits (bus, tractor), > 1 dents easily (sports car). Default 1. */
  toughness?: number;
}

export type EngineSoundId =
  | 'truck'
  | 'v8'
  | 'sport'
  | 'buggy'
  | 'sedan'
  | 'monster'
  | 'rally'
  | 'hatch'
  | 'lifted'
  | 'jeep'
  | 'suv'
  | 'van'
  | 'bus'
  | 'tractor'
  | 'atv'
  | 'trophy';

/** Per-vehicle chassis tweaks (all optional; defaults = a normal car). */
export interface VehicleTune {
  /** Centre-of-mass drop as a multiple of the collider half height (1 = default; sedan 1.6, monster 1.4). */
  comDrop?: number;
  /** Extra suspension rest length (m) on top of the off-road mapping (monster 0.25). */
  extraRest?: number;
  /** Extra half-track (m) beyond the body (monster 0.25). */
  wheelXAdd?: number;
  /** Under-damped, bouncy suspension (buggy). */
  bouncy?: boolean;
  /** Roll-assist strength (default 5; sedan 9, buggy 3). */
  antiRoll?: number;
  /** Override the half wheelbase (m). Default: length/2 − max(0.55, 1.25·wheelRadius). */
  wheelZ?: number;
  /** Scale on the bounding-volume mass estimate (boxy vans are mostly air). */
  massScale?: number;
}

/**
 * Concrete physics parameters derived from stats (see params.ts). Everything is SI:
 * kg, metres, Newtons, m/s. Per-wheel values apply to every wheel.
 */
export interface VehicleParams {
  mass: number;
  /** Half extents of the chassis collider. */
  halfExtents: { x: number; y: number; z: number };
  /** Centre of mass offset below the collider centre (positive = lower). Lower = harder to flip. */
  comDrop: number;
  wheelRadius: number;
  /** Half track width (x of wheel connection points) and half wheelbase (z). */
  wheelX: number;
  wheelZ: number;
  /** Local y of the suspension mount points (relative to chassis centre). */
  wheelY: number;
  suspensionRest: number;
  suspensionTravel: number;
  /** Rapier per-mass stiffness/damping (multiplied by chassis mass internally). */
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionForce: number;
  /** Base tyre friction (Rapier frictionSlip ≈ μ). Multiplied by surface grip. */
  frictionSlip: number;
  sideFrictionStiffness: number;
  /** Total engine force at low speed, Newtons (split across driven wheels). */
  engineForce: number;
  /** Top speed on asphalt, m/s. Engine force fades to 0 approaching it. */
  topSpeed: number;
  reverseSpeed: number;
  /** Braking deceleration, m/s^2. */
  brakeDecel: number;
  /** Max steering angle at standstill / at top speed (radians). */
  steerLow: number;
  steerHigh: number;
  /** Max steering angular rate (rad/s) — avoids twitchy direction changes. */
  steerRate: number;
  drive: 'front' | 'rear' | 'all';
  /** 0..1 how strongly the car resists off-road drag/grip loss (from off-road stat). */
  offroad: number;
  /** Multiplier on engine force when climbing (from hill-climb stat). */
  climbBoost: number;
  /**
   * Optional (added by vehicles M2): max tyre traction on steep (> 7°) non-asphalt slopes, as a
   * friction coefficient: engine force is capped at mass·g·cos(slope)·climbTraction. Defaults to 0.85.
   */
  climbTraction?: number;
  /**
   * Optional: engine power available on steep climbs, in W/kg (drive force ≤ mass·climbPower/speed,
   * blended in from 14° to 20° nose-up). It sets the crawl speed up very steep slopes, so a run-up is
   * bled off and the hidden climb value decides how long the climb takes. Unset = no power limit.
   */
  climbPower?: number;
  /**
   * Optional rear wheel radius (tractor). Rear suspension mounts are raised by the difference so the
   * chassis still sits level.
   */
  wheelRadiusRear?: number;
  /**
   * Hard-landing tolerance: downward speed (m/s) at touchdown below which a landing does no damage.
   * From the jump stat (see params.ts). Optional so older param overrides stay valid; default 9.
   */
  landingTolerance?: number;
  /** Damage multiplier (spec.toughness). Optional, default 1. */
  damageScale?: number;
  /** Roll-stability assist strength (Nm per rad of excess roll). Sedan is very high. */
  antiRoll: number;
  /** Air control torque factor (small: lets the car level out in the air). */
  airControl: number;
  linearDamping: number;
  angularDamping: number;
}

/** Read-only view of a vehicle used by race / ai / ui / audio / fx. */
export interface VehicleState {
  readonly racer: RacerId;
  readonly spec: VehicleSpec;
  readonly paint: number;
  /** Signed forward speed, m/s (negative = reversing). */
  readonly speed: number;
  /** Interpolated render pose (updated each frame). */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** Unit forward vector of the chassis (render pose). */
  readonly forward: THREE.Vector3;
  /** 0..1 engine load/RPM estimate for audio. */
  readonly rpm: number;
  /** Current steering angle (radians) and input. */
  readonly steerAngle: number;
  readonly input: Readonly<DriveInput>;
  /** Number of wheels touching ground (0 = airborne). */
  readonly wheelsOnGround: number;
  /** Seconds since all wheels left the ground (0 when grounded). */
  readonly airTime: number;
  /** Surface under most wheels. */
  readonly surface: SurfaceType;
  /** Per-wheel info for fx (skid marks, dust). Order: FL, FR, RL, RR. */
  readonly wheels: readonly WheelState[];
  /** True when upside-down/on its side. */
  readonly flipped: boolean;
  /**
   * Damage 0..100 (%). Builds up from hard hits during a race and never goes down (Reset does not repair;
   * each race builds fresh cars). Emitted as 'car:damage'. Costs up to 25% top speed/acceleration.
   */
  readonly damage: number;
}

export interface WheelState {
  contact: boolean;
  /** World contact point (valid when contact). */
  point: THREE.Vector3;
  surface: SurfaceType;
  /** 0..1 lateral/longitudinal slip estimate (skid marks/squeal when > ~0.4). */
  slip: number;
  /** Suspension compression 0..1. */
  compression: number;
}

/** A spawned, drivable vehicle. */
export interface Vehicle extends VehicleState, System {
  /** The driver (PlayerInput.state or AI output). Read every physics step. */
  input: DriveInput;
  /** Teleport to a spawn point and zero velocities. Emits 'vehicle:reset'. */
  reset(at: SpawnPoint): void;
  /** Freeze in place (countdown, results) without removing. */
  setFrozen(frozen: boolean): void;
  /**
   * Add damage directly (tests/debug, or a source the vehicle can't detect itself). `localDir` is the
   * direction from the car centre towards the hit in chassis space (+Z forward, +X left); default: front.
   */
  addDamage(amount: number, localDir?: { x: number; y: number; z: number }): void;
  readonly object: THREE.Object3D;
  dispose(): void;
}
