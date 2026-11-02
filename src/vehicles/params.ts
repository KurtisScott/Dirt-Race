import type { VehicleStats } from '../core/types';
import type { VehicleParams, VehicleSpec } from './types';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Map a 1..5 stat to 0..1. */
const n = (stat: number): number => Math.min(1, Math.max(0, (stat - 1) / 4));
/** Look up a per-stat table (index 0 = stat 1), interpolating between entries. */
const byStat = (table: readonly number[], stat: number): number => {
  const x = Math.min(table.length - 1, Math.max(0, stat - 1));
  const i = Math.min(table.length - 2, Math.floor(x));
  return lerp(table[i], table[i + 1], x - i);
};

/**
 * Steep-slope tuning by the hidden `spec.climb` value (1..5; it was the visible "Hill climb" stat before Round 2). The old bonus hill tops out at 38.5° of loose gravel, which needs a
 * traction coefficient of ≈ 0.80 + rolling resistance (≈ 0.83–0.85 in total) to keep moving.
 *  - CLIMB_TRACTION: max drive force on steep loose slopes = mass·g·cos(slope)·μ. Sedan (1) stalls about
 *    40% up; sports (2) sits right at the limit (needs a run-up); muscle/buggy (3) have a thin margin;
 *    pickup (4) and monster (5) climb reliably.
 *  - CLIMB_POWER (W/kg): drive force ≤ mass·P/speed on slopes over 14°. Sets the crawl speed on the steep
 *    top (P / ~6.5 m/s²: about 2.8 m/s for the sports car up to 5.5 m/s for the monster), so a run-up is
 *    bled off on the lower slope and the stat decides how long the climb takes.
 * Measured times are in DECISIONS.md ("Bonus hill retune"); physics-test (personality) asserts the ordering on the same profile.
 */
export const CLIMB_TRACTION = [0.62, 0.835, 0.875, 0.96, 1.05] as const;
export const CLIMB_POWER = [14, 18, 20, 28, 36] as const;

/**
 * Jump stat (1..5) → how the car flies and lands. Jump *distance* is set by launch speed (top speed and
 * acceleration over the run-up; mass doesn't change a ballistic arc), so the course's end ramp is tuned
 * on speed. The jump stat adds what happens in the air and on touchdown:
 *  - AIR_CONTROL: torque factor that levels pitch/roll in the air (lands on the wheels more often).
 *  - LANDING_TOLERANCE (m/s downward at touchdown): harder landings than this cause damage.
 */
export const AIR_CONTROL = [0.45, 0.55, 0.65, 0.8, 0.95] as const;
export const LANDING_TOLERANCE = [8, 8.8, 9.6, 10.5, 11.5] as const;

/**
 * Stats (1–5) → physics. This is the single place to tune how vehicles feel.
 *
 * Notes on Rapier's ray-cast vehicle (read from rapier/src/control/ray_cast_vehicle_controller.rs):
 *  - suspension force per wheel = (stiffness·Δlen − damping·v_rel) · chassisMass, so stiffness and
 *    damping are *per unit mass*. Static sag = g / (wheels · stiffness).
 *    Natural freq ω ≈ √(4·k) for 4 wheels; critical damping ≈ √k.
 *  - brake is a max *impulse* per step (we pass force·dt), and is ignored when engine force ≠ 0.
 *  - forward grip limit ≈ 2 · frictionSlip · normal load; side grip limit ≈ frictionSlip · load.
 *  - no rolling resistance or drag: we add our own (vehicle.ts).
 */
export function paramsFromSpec(spec: VehicleSpec): VehicleParams {
  const s: VehicleStats = spec.stats;
  const { length, width, height } = spec.size;
  const top = n(s.topSpeed);
  const acc = n(s.accel);
  const grip = n(s.grip);
  const off = n(s.offroad);
  const climb = n(spec.climb);
  const tune = spec.tune ?? {};

  // Mass from bounding volume: pickup ≈ 1900 kg, sports ≈ 1150, buggy ≈ 1000, monster ≈ 2000, bus 3000 (cap).
  const volume = length * width * height * (tune.massScale ?? 1);
  const mass = Math.round(Math.min(3000, Math.max(800, 90 * volume + 300)));

  const wheelRadius = spec.wheelRadius;
  // Off-road vehicles get longer, softer suspension; road cars short and stiff.
  const suspensionRest = lerp(0.18, 0.45, off) + (tune.extraRest ?? 0);
  const suspensionTravel = suspensionRest * 0.85;
  const stiffness = lerp(48, 26, off); // ω ≈ 2.2–1.6 Hz
  const crit = Math.sqrt(stiffness);
  const halfY = height * 0.28;

  return {
    mass,
    halfExtents: { x: width / 2, y: halfY, z: length / 2 },
    // Low centre of mass is our main anti-flip tool. Grandma's sedan: very low (SPEC: never flips).
    comDrop: halfY * (tune.comDrop ?? 1),
    wheelRadius,
    wheelRadiusRear: spec.rearWheelRadius,
    wheelX: width / 2 - 0.12 + (tune.wheelXAdd ?? 0),
    wheelZ: tune.wheelZ ?? length / 2 - Math.max(0.55, wheelRadius * 1.25),
    wheelY: -halfY * 0.4,
    suspensionRest,
    suspensionTravel,
    suspensionStiffness: stiffness,
    // Buggy: under-damped on purpose (SPEC: light and bouncy).
    suspensionCompression: crit * (tune.bouncy ? 0.3 : 0.55),
    suspensionRelaxation: crit * (tune.bouncy ? 0.4 : 0.75),
    maxSuspensionForce: mass * 9.81 * 3,
    frictionSlip: lerp(1.35, 2.1, grip),
    // Lower side stiffness = more slide (muscle car). 1 is Rapier's default.
    sideFrictionStiffness: lerp(0.75, 1.15, grip),
    engineForce: mass * lerp(4.5, 9.5, acc),
    topSpeed: lerp(22, 42, top), // 79–151 km/h
    reverseSpeed: 7,
    brakeDecel: 11,
    steerLow: 0.6,
    steerHigh: lerp(0.11, 0.16, grip),
    steerRate: 2.6,
    drive: spec.drive,
    offroad: off,
    climbBoost: lerp(0.0, 1.6, climb),
    // Traction limit and crawl power on steep loose slopes (see CLIMB_TRACTION / CLIMB_POWER above).
    climbTraction: byStat(CLIMB_TRACTION, spec.climb),
    climbPower: byStat(CLIMB_POWER, spec.climb),
    antiRoll: tune.antiRoll ?? 5,
    airControl: byStat(AIR_CONTROL, s.jump),
    landingTolerance: byStat(LANDING_TOLERANCE, s.jump),
    damageScale: spec.toughness ?? 1,
    linearDamping: 0.02,
    angularDamping: 0.6,
  };
}
