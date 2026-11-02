import type * as THREE from 'three';
import type { VehicleParams, VehicleSpec, VehicleState } from './types';

/**
 * Visual model contract. `root` is placed at the chassis collider centre each frame;
 * `wheels[i]` (FL, FR, RL, RR) are positioned/rotated by the vehicle for suspension travel,
 * steering and spin. Each wheel object should be centred on its axle with the axle along local X.
 */
export interface VehicleModel {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  /**
   * Optional: called every frame after the wheels are placed, for extra animation (body lean, brake
   * lights). `state` (optional, added in vehicles M2) is the owning vehicle.
   */
  animate?(dt: number, state?: VehicleState): void;
  /**
   * Optional (Round 2): show a damaging hit (dents, scratches, cracked glass, loose bumpers). `total` is
   * the car's damage after this hit (0..100). Must not allocate GPU resources per hit (geometry is
   * edited in place) so Race Again doesn't leak.
   */
  applyDamage?(hit: DamageHit, total: number): void;
  dispose(): void;
}

export interface DamageHit {
  /** Unit direction from the chassis centre towards the hit, chassis space (+Z forward, +X left, +Y up). */
  dir: { x: number; y: number; z: number };
  /** Damage this hit added (%). */
  amount: number;
}

export type ModelBuilder = (spec: VehicleSpec, paint: number, params: VehicleParams) => VehicleModel;
