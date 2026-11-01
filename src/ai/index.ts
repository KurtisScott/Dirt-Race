import type { Difficulty, DriveInput, System } from '../core/types';
import type { VehicleState } from '../vehicles/types';
import type { World } from '../world/types';

/**
 * Computer driver. Produces a DriveInput for its vehicle each frame; never touches physics directly
 * (SPEC: same physics, no speed cheating). Assign `vehicle.input = ai.input` once.
 *
 * Inputs available:
 *  - world.track (TrackPath): pointAt/tangentAt/halfWidthAt/project(pos, hintS) for the racing line.
 *  - world.checkpoints for Reset when stuck (ask race to reset; see RaceController.requestReset).
 *  - VehicleState: position, forward, speed, wheelsOnGround, surface, flipped.
 *
 * TODO(ai agent):
 *  - Pure-pursuit steering toward a look-ahead point on the racing line (look-ahead grows with speed).
 *  - Speed target from upcoming curvature; brake before corners.
 *  - Obstacle avoidance: lateral offset around fixed obstacles/animals ahead (query world).
 *  - Difficulty: easy 80% top speed + frequent mistakes + rubber-band ease-off when far ahead;
 *    normal 92%; hard 100% and takes the log-bridge shortcut.
 *  - Stuck detection → request reset. Attempt the bonus hill after finishing.
 */
export class AIDriver implements System {
  readonly input: DriveInput = { steer: 0, throttle: 0, brake: 0 };
  enabled = false;
  /** Called when the AI wants a reset (stuck/flipped). Race controller wires this. */
  onRequestReset: (() => void) | null = null;
  private s = 0;

  constructor(
    private vehicle: VehicleState,
    private world: World,
    public difficulty: Difficulty,
  ) {}

  update(_dt: number): void {
    if (!this.enabled) {
      this.input.steer = this.input.throttle = 0;
      this.input.brake = 0;
      return;
    }
    // Placeholder: naive line follower so race/ui work can be tested against a moving opponent.
    const proj = this.world.track.project(this.vehicle.position, this.s);
    this.s = proj.s;
    const target = this.world.track.pointAt(this.s + 10 + Math.abs(this.vehicle.speed) * 0.6);
    const dx = target.x - this.vehicle.position.x;
    const dz = target.z - this.vehicle.position.z;
    const f = this.vehicle.forward;
    // cross(forward, toTarget).y > 0 → target is to the left
    const cross = f.z * dx - f.x * dz;
    const dot = f.x * dx + f.z * dz;
    const angle = Math.atan2(cross, dot);
    this.input.steer = Math.max(-1, Math.min(1, -angle * 2));
    const topFrac = this.difficulty === 'easy' ? 0.8 : this.difficulty === 'normal' ? 0.92 : 1;
    this.input.throttle = Math.abs(angle) > 0.6 ? 0.4 : topFrac;
    this.input.brake = 0;
  }
}
