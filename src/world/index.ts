export type { World, TrackPath, Checkpoint, Zone, ZoneId, SurfaceQuery, JumpInfo } from './types';
export { SURFACES, SURFACE_COLORS } from './surfaces';
export { PolylineTrack } from './polylineTrack';
export { TestGround } from './testGround';
export { RaceCourse } from './raceCourse';
export type { AnimalInfo } from './animals';

import type { GameContext } from '../core/context';
import { CourseData } from './course';
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

/** Let the browser paint (loading bar) between heavy synchronous steps. */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = (): void => {
      if (done) return;
      done = true;
      setTimeout(resolve, 0);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 50); // hidden tab / headless: rAF may not fire
  });
}

/**
 * Same as `createWorld`, but builds the race course in two halves (course data, then meshes/colliders)
 * and yields in between, reporting progress 0..1 so the loading bar moves.
 */
export async function createWorldAsync(ctx: GameContext, level: 'race' | 'test', progress?: (f: number, label: string) => void): Promise<World> {
  if (level === 'test') return new TestGround(ctx);
  progress?.(0, 'Shaping the hills…');
  await breathe();
  const data = new CourseData();
  progress?.(0.55, 'Planting trees and stacking hay…');
  await breathe();
  const course = new RaceCourse(ctx, data);
  // High/Ultra: the photographic texture set (a few MB of WebP, precached for offline play).
  if (ctx.quality.preset.terrainPBR > 0) {
    progress?.(0.85, 'Painting the scenery…');
    await course.loadLook((f) => progress?.(0.85 + f * 0.15, 'Painting the scenery…'));
  }
  return course;
}
