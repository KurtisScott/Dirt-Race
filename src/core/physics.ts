import RAPIER from '@dimforge/rapier3d-compat';
import type { SurfaceType } from './types';

export { RAPIER };
export type Rapier = typeof RAPIER;

/** Fixed physics step. 60 Hz matches the display on iPad and keeps the ray-cast vehicle stable. */
export const PHYSICS_DT = 1 / 60;
/** Never run more than this many physics steps per rendered frame (avoids spiral of death on slow frames). */
export const MAX_STEPS_PER_FRAME = 4;
export const GRAVITY = -9.81;

/**
 * Collision groups (Rapier InteractionGroups = membership << 16 | filter).
 * Use `groups(member, ...collidesWith)` to build masks.
 */
export const Group = {
  GROUND: 1 << 0, // terrain, road, ramps
  STATIC: 1 << 1, // boulders, logs, walls, ramps
  VEHICLE: 1 << 2,
  DEBRIS: 1 << 3, // hay bales, cones (dynamic, light)
  ANIMAL: 1 << 4,
  SENSOR: 1 << 5, // checkpoints, finish
} as const;

export function groups(member: number, filter: number): number {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

/** What a collider represents. Attach via `physics.tag(collider, tag)` so contact handlers can identify it. */
export type ColliderTag =
  | { kind: 'ground'; surface?: SurfaceType }
  | { kind: 'static'; name: string }
  | { kind: 'debris'; name: string }
  | { kind: 'animal'; name: string }
  | { kind: 'vehicle'; racer: string }
  | { kind: 'sensor'; name: string; index?: number };

let initPromise: Promise<void> | null = null;
/** Loads the Rapier WASM once. Must resolve before creating a PhysicsWorld. */
export function initRapier(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

/**
 * Thin owner of the Rapier world. Modules create their own bodies/colliders on `world`
 * and register tags for identification. Stepping is done only by the game loop.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly eventQueue: RAPIER.EventQueue;
  private tags = new Map<number, ColliderTag>();
  private collisionHandlers: ((h1: number, h2: number, started: boolean) => void)[] = [];
  private contactForceHandlers: ((e: RAPIER.TempContactForceEvent) => void)[] = [];

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_DT;
    // A couple of extra solver iterations keep stacked debris and the car on ramps stable.
    this.world.numSolverIterations = 6;
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  tag(collider: RAPIER.Collider, tag: ColliderTag): void {
    this.tags.set(collider.handle, tag);
  }
  untag(collider: RAPIER.Collider): void {
    this.tags.delete(collider.handle);
  }
  getTag(handle: number): ColliderTag | undefined {
    return this.tags.get(handle);
  }

  /** Called for colliders with ActiveEvents.COLLISION_EVENTS. Returns an unsubscribe fn. */
  onCollision(fn: (h1: number, h2: number, started: boolean) => void): () => void {
    this.collisionHandlers.push(fn);
    return () => (this.collisionHandlers = this.collisionHandlers.filter((f) => f !== fn));
  }
  /** Called for colliders with ActiveEvents.CONTACT_FORCE_EVENTS. */
  onContactForce(fn: (e: RAPIER.TempContactForceEvent) => void): () => void {
    this.contactForceHandlers.push(fn);
    return () => (this.contactForceHandlers = this.contactForceHandlers.filter((f) => f !== fn));
  }

  /** One fixed step + event dispatch. Only the game loop calls this. */
  step(): void {
    this.world.step(this.eventQueue);
    if (this.collisionHandlers.length) {
      this.eventQueue.drainCollisionEvents((a, b, s) => {
        for (const fn of this.collisionHandlers) fn(a, b, s);
      });
    } else {
      this.eventQueue.drainCollisionEvents(() => {});
    }
    if (this.contactForceHandlers.length) {
      this.eventQueue.drainContactForceEvents((e) => {
        for (const fn of this.contactForceHandlers) fn(e);
      });
    } else {
      this.eventQueue.drainContactForceEvents(() => {});
    }
  }

  removeBody(body: RAPIER.RigidBody): void {
    for (let i = 0; i < body.numColliders(); i++) this.untag(body.collider(i));
    this.world.removeRigidBody(body);
  }

  dispose(): void {
    this.eventQueue.free();
    this.world.free();
  }
}
