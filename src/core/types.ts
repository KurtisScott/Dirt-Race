/**
 * Shared, dependency-free types used across modules.
 * Keep this file small and stable: every agent imports from it.
 */

/** Which racer an event/vehicle belongs to. One human vs one computer (SPEC). */
export type RacerId = 'player' | 'cpu';

/** Ground surface kinds (SPEC "Surfaces"). */
export type SurfaceType = 'asphalt' | 'dirt' | 'gravel' | 'mud' | 'sand' | 'water' | 'snow';

/** Physical effect of a surface on tyres and chassis. */
export interface SurfaceProps {
  /** Multiplier on tyre friction (1 = asphalt). */
  grip: number;
  /** Longitudinal drag as deceleration in m/s^2 per (m/s) of speed (applied as a force by vehicles). */
  drag: number;
  /** Extra rolling resistance in m/s^2 (constant, applied while moving). */
  rolling: number;
}

/** The sixteen vehicle kinds (SPEC "Vehicles" + Round 2 item 6). */
export type VehicleKind =
  | 'sports'
  | 'muscle'
  | 'pickup'
  | 'monster'
  | 'buggy'
  | 'sedan'
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

/** Stats on the 1–5 scale used by the spin screen. */
export interface VehicleStats {
  topSpeed: number;
  accel: number;
  grip: number;
  offroad: number;
  /**
   * End-jump ability (Round 2: the long jump replaced the bonus hill). Shown on the spin screen. Distance
   * comes from launch speed (top speed / accel); this stat also sets how well the car flies and lands
   * (air levelling, hard-landing damage tolerance). See vehicles/params.ts.
   */
  jump: number;
}

/** Per-frame driving intent, produced by a human (input module) or the AI. */
export interface DriveInput {
  /** -1 = full left, +1 = full right. */
  steer: number;
  /** 0..1 gas pedal. */
  throttle: number;
  /** 0..1 brake pedal. Holding brake at (near) standstill engages reverse. */
  brake: number;
}

export const NO_INPUT: Readonly<DriveInput> = Object.freeze({ steer: 0, throttle: 0, brake: 0 });

/**
 * Position + heading used for spawning and resets. `y` is the GROUND height at (x, z): the vehicle
 * adds its own ride height. Heading is yaw in radians, 0 = facing +Z, positive = turning left (CCW from above).
 */
export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type Sensitivity = 'low' | 'medium' | 'high';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type CameraMode = 'close' | 'far';
export type SpeedUnit = 'mph' | 'kmh';

/** Something the game loop ticks. All methods optional. */
export interface System {
  /** Fixed-rate simulation tick (PHYSICS_DT), called before the physics step. */
  fixedUpdate?(dt: number): void;
  /** Called after each physics step (read results, emit events). */
  postPhysics?(dt: number): void;
  /** Per rendered frame. `alpha` is the interpolation factor between the last two physics states. */
  update?(dt: number, alpha: number): void;
  dispose?(): void;
}
