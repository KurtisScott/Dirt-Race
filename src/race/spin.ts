import type { RacerId } from '../core/types';
import { randomVehicle } from '../vehicles/catalog';
import type { VehicleSpec } from '../vehicles/types';

/** One racer's vehicle from the spin. */
export interface VehiclePick {
  spec: VehicleSpec;
  paint: number;
}
export type VehiclePicks = Record<RacerId, VehiclePick>;
/** Something that returns both picks (the Vehicles engineer's spin screen exposes one of these). */
export type SpinFn = (rand?: () => number) => VehiclePicks;

/**
 * Stub spin until the vehicles spin screen is merged: an independent random pick for each racer
 * (SPEC: the computer gets the same random spin as Brooks, no special treatment).
 */
export const randomSpin: SpinFn = (rand = Math.random) => ({
  player: randomVehicle(rand),
  cpu: randomVehicle(rand),
});
