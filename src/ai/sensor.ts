import { Group, groups, RAPIER, type PhysicsWorld } from '../core/physics';
import type { RacerId } from '../core/types';
import type { ObstacleSensor } from './types';

/**
 * ObstacleSensor backed by Rapier ray casts against obstacles, debris, animals and the other car.
 * Ignores ground, sensors, the AI's own car and low speed bumps. ~36 rays/s per AI: negligible cost.
 */
export function createPhysicsSensor(physics: PhysicsWorld, self: RacerId): ObstacleSensor {
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  const filter = groups(0xffff, Group.STATIC | Group.DEBRIS | Group.ANIMAL | Group.VEHICLE);
  const pred = (c: RAPIER.Collider): boolean => {
    const tag = physics.getTag(c.handle);
    if (!tag) return true;
    if (tag.kind === 'vehicle') return tag.racer !== self;
    if (tag.kind === 'static' && tag.name === 'bump') return false;
    return tag.kind !== 'ground' && tag.kind !== 'sensor';
  };
  return {
    cast(ox, oy, oz, dx, dy, dz, maxDist) {
      ray.origin = { x: ox, y: oy, z: oz };
      ray.dir = { x: dx, y: dy, z: dz };
      const hit = physics.world.castRay(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, filter, undefined, undefined, pred);
      return hit ? hit.timeOfImpact : null;
    },
  };
}
