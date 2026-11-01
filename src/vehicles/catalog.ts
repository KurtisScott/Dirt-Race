import type { VehicleKind } from '../core/types';
import type { VehicleSpec } from './types';

/**
 * The six vehicles from SPEC. Stats are the 1–5 design values; params.ts turns them into physics.
 * TODO(vehicles agent): fill in sizes/paints/blurbs for real models; tune in playtesting.
 */
export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  sports: {
    kind: 'sports',
    name: 'Sports Car',
    stats: { topSpeed: 5, accel: 5, grip: 4, offroad: 1, hillClimb: 2 },
    paints: [0xd62828, 0xf7c600, 0x1e88e5],
    blurb: 'Flies on pavement, bottoms out in mud',
    size: { length: 4.3, width: 1.9, height: 1.15 },
    wheelRadius: 0.34,
    drive: 'rear',
    engineSound: 'sport',
  },
  muscle: {
    kind: 'muscle',
    name: 'Muscle Car',
    stats: { topSpeed: 4, accel: 4, grip: 2, offroad: 2, hillClimb: 3 },
    paints: [0xff6f00, 0x212121, 0x2e7d32],
    blurb: 'Fast and loud, slides in corners',
    size: { length: 4.7, width: 1.95, height: 1.3 },
    wheelRadius: 0.36,
    drive: 'rear',
    engineSound: 'v8',
  },
  pickup: {
    kind: 'pickup',
    name: 'Pickup Truck',
    stats: { topSpeed: 3, accel: 3, grip: 3, offroad: 4, hillClimb: 4 },
    paints: [0x1565c0, 0xc62828, 0xeeeeee],
    blurb: 'Steady all-rounder',
    size: { length: 5.0, width: 2.0, height: 1.8 },
    wheelRadius: 0.42,
    drive: 'all',
    engineSound: 'truck',
  },
  monster: {
    kind: 'monster',
    name: 'Monster Truck',
    stats: { topSpeed: 2, accel: 2, grip: 3, offroad: 5, hillClimb: 5 },
    paints: [0x7b1fa2, 0x43a047, 0xffb300],
    blurb: 'Rolls over anything, slow on straights',
    size: { length: 4.6, width: 2.6, height: 1.6 },
    wheelRadius: 0.8,
    drive: 'all',
    engineSound: 'monster',
  },
  buggy: {
    kind: 'buggy',
    name: 'Dune Buggy',
    stats: { topSpeed: 3, accel: 4, grip: 3, offroad: 5, hillClimb: 3 },
    paints: [0xffeb3b, 0x00acc1, 0xff7043],
    blurb: 'Light, bouncy, great on sand and jumps',
    size: { length: 3.4, width: 1.8, height: 1.3 },
    wheelRadius: 0.4,
    drive: 'rear',
    engineSound: 'buggy',
  },
  sedan: {
    kind: 'sedan',
    name: "Grandma's Sedan",
    stats: { topSpeed: 2, accel: 1, grip: 4, offroad: 2, hillClimb: 1 },
    paints: [0xb0bec5, 0xa1887f, 0x9ccc65],
    blurb: 'Slow and steady, never flips',
    size: { length: 4.6, width: 1.85, height: 1.45 },
    wheelRadius: 0.33,
    drive: 'front',
    engineSound: 'sedan',
  },
};

export const VEHICLE_KINDS = Object.keys(VEHICLES) as VehicleKind[];

/** Random vehicle + paint (the spin). Pass a custom rng for tests. */
export function randomVehicle(rand: () => number = Math.random): { spec: VehicleSpec; paint: number } {
  const spec = VEHICLES[VEHICLE_KINDS[Math.floor(rand() * VEHICLE_KINDS.length)]];
  const paint = spec.paints[Math.floor(rand() * 3)];
  return { spec, paint };
}
