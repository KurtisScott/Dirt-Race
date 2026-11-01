export type { World, TrackPath, Checkpoint, Zone, ZoneId, SurfaceQuery } from './types';
export { SURFACES, SURFACE_COLORS } from './surfaces';
export { PolylineTrack } from './polylineTrack';
export { TestGround } from './testGround';
export { RaceCourse } from './raceCourse';
export type { AnimalInfo } from './animals';

import type { GameContext } from '../core/context';
import { RaceCourse } from './raceCourse';
import { TestGround } from './testGround';
import type { World } from './types';

/** Which level to build: 'race' = the real course (default), 'test' = the M1 test ground. */
export function createWorld(ctx: GameContext, level: 'race' | 'test' = 'race'): World {
  switch (level) {
    case 'test':
      return new TestGround(ctx);
    case 'race':
    default:
      return new RaceCourse(ctx);
  }
}
