import type { VehicleStats } from '../core/types';
import type { VehicleParams, VehicleSpec } from './types';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Map a 1..5 stat to 0..1. */
const n = (stat: number): number => Math.min(1, Math.max(0, (stat - 1) / 4));

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
  const climb = n(s.hillClimb);

  // Mass from bounding volume: pickup ≈ 1900 kg, sports ≈ 1150, buggy ≈ 1000, monster ≈ 2000.
  const volume = length * width * height;
  const mass = Math.round(Math.min(3000, Math.max(800, 90 * volume + 300)));

  const wheelRadius = spec.wheelRadius;
  // Off-road vehicles get longer, softer suspension; road cars short and stiff.
  const suspensionRest = lerp(0.18, 0.45, off) + (spec.kind === 'monster' ? 0.25 : 0);
  const suspensionTravel = suspensionRest * 0.85;
  const stiffness = lerp(48, 26, off); // ω ≈ 2.2–1.6 Hz
  const crit = Math.sqrt(stiffness);
  const halfY = height * 0.28;

  return {
    mass,
    halfExtents: { x: width / 2, y: halfY, z: length / 2 },
    // Low centre of mass is our main anti-flip tool. Grandma's sedan: very low (SPEC: never flips).
    comDrop: halfY * (spec.kind === 'sedan' ? 1.6 : spec.kind === 'monster' ? 1.4 : 1.0),
    wheelRadius,
    wheelX: width / 2 - 0.12 + (spec.kind === 'monster' ? 0.25 : 0),
    wheelZ: length / 2 - Math.max(0.55, wheelRadius * 1.25),
    wheelY: -halfY * 0.4,
    suspensionRest,
    suspensionTravel,
    suspensionStiffness: stiffness,
    suspensionCompression: crit * 0.55,
    suspensionRelaxation: crit * 0.75,
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
    antiRoll: spec.kind === 'sedan' ? 9 : spec.kind === 'buggy' ? 3 : 5,
    airControl: 0.6,
    linearDamping: 0.02,
    angularDamping: 0.6,
  };
}
