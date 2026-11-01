import { events, type GamePhase } from '../core/events';
import type { RacerId, System } from '../core/types';
import type { Vehicle } from '../vehicles/types';
import type { World } from '../world/types';
import { DEFAULT_RACE_CONFIG, type RaceConfig, type RacerProgress, type RaceView } from './types';

export * from './types';
export { session } from './session';

/**
 * Race state machine + rules. Owns phase transitions after the title/calibrate screens.
 *
 * Phases: spin → countdown → racing → bonus → results (see GamePhase in core/events.ts).
 * M1 uses only 'freeDrive' (free roam on the test ground) via `startFreeDrive()`.
 *
 * TODO(race agent):
 *  - spin: pick random vehicles (vehicles/catalog.randomVehicle) for player & cpu; UI shows the reel,
 *    then calls `startCountdown()`.
 *  - countdown 3-2-1-Go (emit race:countdown / race:go), vehicles frozen until GO.
 *  - racing: update RacerProgress from world.track.project(vehicle.position, prev.s); checkpoints from
 *    world.checkpoints; finish at config.finishAt; 4-min timeout → farthest wins.
 *  - bonus: 45 s; summit when s ≥ track.summitS (or a sensor near world.summit) → +1.
 *  - results: build RaceResults, add to session, emit race:results.
 *  - Reset: requestReset(racer) → wait config.resetDelayS → vehicle.reset(last checkpoint respawn).
 *    Auto-reset on 'vehicle:flipped'.
 */
export class RaceController implements System, RaceView {
  phase: GamePhase = 'title';
  elapsedS = 0;
  readonly config: RaceConfig;
  readonly progress: Record<RacerId, RacerProgress>;
  private vehicles: Partial<Record<RacerId, Vehicle>> = {};
  private pendingReset: Partial<Record<RacerId, number>> = {};

  constructor(
    private world: World,
    config: Partial<RaceConfig> = {},
  ) {
    this.config = { ...DEFAULT_RACE_CONFIG, ...config };
    const blank = (racer: RacerId): RacerProgress => ({ racer, s: 0, checkpoint: -1, finished: false, finishTimeS: null, summit: false, position: 1 });
    this.progress = { player: blank('player'), cpu: blank('cpu') };
    events.on('vehicle:flipped', ({ racer }) => this.requestReset(racer, 0.5));
  }

  get timeLeftS(): number {
    return Math.max(0, this.config.timeLimitS - this.elapsedS);
  }

  setVehicle(racer: RacerId, v: Vehicle | undefined): void {
    this.vehicles[racer] = v;
  }

  setPhase(to: GamePhase): void {
    if (to === this.phase) return;
    const from = this.phase;
    this.phase = to;
    events.emit('phase:changed', { from, to });
  }

  /** M1: free driving on the test ground. */
  startFreeDrive(): void {
    this.elapsedS = 0;
    this.setPhase('freeDrive');
  }

  /** Reset the racer to the last checkpoint after `delay` seconds (SPEC: 2 s for the button). */
  requestReset(racer: RacerId, delay = this.config.resetDelayS): void {
    if (this.pendingReset[racer] !== undefined) return;
    this.pendingReset[racer] = delay;
  }

  /** Where `racer` would respawn right now. */
  respawnFor(racer: RacerId) {
    const p = this.progress[racer];
    const cps = this.world.checkpoints;
    if (p.checkpoint >= 0 && cps[p.checkpoint]) return cps[p.checkpoint].respawn;
    // Fallback: nearest point on the track behind the car.
    const sp = this.world.spawns[racer];
    if (p.s < 15) return sp;
    const s = Math.max(0, p.s - 5);
    const pt = this.world.track.pointAt(s);
    const t = this.world.track.tangentAt(s);
    return { x: pt.x, y: pt.y, z: pt.z, yaw: Math.atan2(t.x, t.z) };
  }

  fixedUpdate(dt: number): void {
    for (const racer of ['player', 'cpu'] as RacerId[]) {
      const left = this.pendingReset[racer];
      if (left === undefined) continue;
      const next = left - dt;
      if (next > 0) this.pendingReset[racer] = next;
      else {
        delete this.pendingReset[racer];
        this.vehicles[racer]?.reset(this.respawnFor(racer));
      }
    }
  }

  postPhysics(dt: number): void {
    if (this.phase === 'racing' || this.phase === 'freeDrive') this.elapsedS += dt;
    for (const racer of ['player', 'cpu'] as RacerId[]) {
      const v = this.vehicles[racer];
      if (!v) continue;
      const p = this.progress[racer];
      p.s = this.world.track.project(v.position, p.s).s;
      // TODO(race agent): checkpoints, finish, summit, positions, timeout.
    }
  }

  /** Is a reset countdown running for this racer (UI can show "Resetting…"). */
  isResetting(racer: RacerId): boolean {
    return this.pendingReset[racer] !== undefined;
  }
}
