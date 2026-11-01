import { MAX_STEPS_PER_FRAME, PHYSICS_DT, type PhysicsWorld } from './physics';
import type { QualityManager } from './quality';
import type { System } from './types';

/**
 * Fixed-timestep loop with render interpolation.
 *
 * Per frame:  for each fixed step { systems.fixedUpdate → physics.step → systems.postPhysics }
 *             then systems.update(frameDt, alpha) → render.
 * Systems run in registration order; register input before vehicles, vehicles before camera.
 */
export class GameLoop {
  private systems: System[] = [];
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  /** When paused, physics does not advance but `update` and render still run (menus stay live). */
  paused = false;
  /** Simulation time in seconds (advances only while not paused). */
  simTime = 0;

  constructor(
    private physics: PhysicsWorld,
    private render: () => void,
    private quality?: QualityManager,
  ) {}

  add<T extends System>(s: T): T {
    this.systems.push(s);
    return s;
  }
  remove(s: System): void {
    this.systems = this.systems.filter((x) => x !== s);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Advance exactly one fixed step (used by tests / headless). */
  stepOnce(): void {
    for (const s of this.systems) s.fixedUpdate?.(PHYSICS_DT);
    this.physics.step();
    for (const s of this.systems) s.postPhysics?.(PHYSICS_DT);
    this.simTime += PHYSICS_DT;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const frameMs = now - this.last;
    this.last = now;
    this.quality?.sample(frameMs, now);
    const dt = Math.min(frameMs / 1000, 0.1);

    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
        this.stepOnce();
        this.acc -= PHYSICS_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.acc = Math.min(this.acc, PHYSICS_DT);
    }
    const alpha = this.paused ? 1 : this.acc / PHYSICS_DT;
    for (const s of this.systems) s.update?.(dt, alpha);
    this.render();
  };
}
