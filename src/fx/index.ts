import type { GameContext } from '../core/context';
import type { System } from '../core/types';
import type { VehicleState } from '../vehicles/types';

export { ChaseCamera } from './chaseCamera';

/**
 * Visual effects driven purely by read-only vehicle state + events (no physics writes).
 *
 * TODO(fx agent):
 *  - Dust / mud / water / sand particles per wheel (VehicleState.wheels[i].surface, .slip, .point),
 *    budget scaled by `ctx.quality.preset.detail`. Use one InstancedMesh or Points per effect.
 *  - Skid marks on asphalt when wheels[i].slip > ~0.4 (ring-buffer of quads, one draw call).
 *  - Confetti on 'race:finish' (winner), golden sparkle on 'race:summit'.
 *  - Hay scatter puffs on 'obstacle:hit'.
 *  - Camera shake already lives in ChaseCamera.shake(); call it from here if you add more triggers.
 */
export class Effects implements System {
  private tracked: VehicleState[] = [];
  constructor(private ctx: GameContext) {}

  track(v: VehicleState): void {
    this.tracked.push(v);
  }
  untrack(v: VehicleState): void {
    this.tracked = this.tracked.filter((t) => t !== v);
  }

  update(_dt: number): void {
    // TODO(fx agent): emit/update particles for this.tracked using this.ctx.quality.preset.detail.
    void this.ctx;
  }
}
