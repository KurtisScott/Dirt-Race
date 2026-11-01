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
  dispose(): void;
}

export type ModelBuilder = (spec: VehicleSpec, paint: number, params: VehicleParams) => VehicleModel;
