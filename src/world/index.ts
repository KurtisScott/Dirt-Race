export type { World, TrackPath, Checkpoint, Zone, ZoneId, SurfaceQuery } from './types';
export { SURFACES, SURFACE_COLORS } from './surfaces';
export { PolylineTrack } from './polylineTrack';
export { TestGround } from './testGround';

import type { GameContext } from '../core/context';
import { TestGround } from './testGround';
import type { World } from './types';

/**
 * Which level to build. M1 = 'test'.
 * TODO(world agent): add 'race' → the real ~2.5 km track (town, farm, mud, rocky, desert, river,
 * finish, bonus hill) implementing the same World interface. Suggested files:
 *   track.ts (spline + zones + checkpoints), terrain.ts (heightfield collider + mesh),
 *   obstacles.ts (hay/cones dynamic, boulders/logs fixed, potholes, ramps), animals.ts, hill.ts.
 * Animals must be cheap (instanced/low-poly), only bump cars (light dynamic or kinematic bodies),
 * and emit 'animal:crossing'.
 */
export function createWorld(ctx: GameContext, level: 'test' = 'test'): World {
  switch (level) {
    case 'test':
    default:
      return new TestGround(ctx);
  }
}
