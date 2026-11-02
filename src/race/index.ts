import * as THREE from 'three';
import { events, type GamePhase, type RaceResults, type RacerResult } from '../core/events';
import type { DriveInput, RacerId, SpawnPoint, System } from '../core/types';
import type { Vehicle } from '../vehicles/types';
import type { World } from '../world/types';
import { session } from './session';
import { DEFAULT_RACE_CONFIG, type DriverControl, type RaceConfig, type RacerProgress, type RaceView } from './types';

export * from './types';
export { session } from './session';
export { randomSpin, type VehiclePick, type VehiclePicks, type SpinFn } from './spin';
export { RaceFlow, type RaceFlowDeps, type ComputerDriver } from './flow';

const RACERS: readonly RacerId[] = ['player', 'cpu'];
/** Max plausible forward jump of `s` in one physics step (stops projection snapping to a far part of the track). */
const MAX_S_JUMP = 30;
/** Hysteresis for lead changes (m), so two cars side by side don't spam race:lead. */
const LEAD_HYSTERESIS = 2;
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Race state machine + rules (SPEC "Game flow" / "Rules").
 *
 *   title → calibrate → spin → countdown → racing → bonus → results → (spin | title)
 *
 * - `startCountdown()` (after the spin): resets world + cars to the grid, 3-2-1-GO (`race:countdown`, `race:go`).
 *   Cars are held still during the countdown (race owns `vehicle.input`, see `setDriver`).
 * - racing: progress `s` = projection on the centre-line; checkpoints are passed in order; the first car
 *   across `finishS` wins 1 point (`race:finish`) and the phase becomes 'bonus'.
 * - Every car that crosses the finish gets its own `bonusTimeS` window for ONE end-jump attempt: take off
 *   from the ramp (`race:takeoff`), touch down, stay upright on the wheels for `jumpLandS` → `race:jump`
 *   {distanceM, bonus, crashed}. Landing past `world.jump.bonusS` on the wheels = +1. The car then stops
 *   in the run-off (race holds it: brake to a stop).
 * - 8-minute timer: any car still racing when it expires is done (`race:timeout`). If nobody finished,
 *   the farthest car (best `s`) wins.
 * - When the player is done (jump / bonus over / timeout) the cpu gets at most `cpuGraceS` more seconds
 *   (to finish and/or jump), so Brooks isn't kept waiting.
 * - All done → `resultsDelayS` → 'results' (`race:results`, session score saved).
 * - Reset: `requestReset(racer)` waits `resetDelayS`, then respawns at the last checkpoint
 *   (after the finish: at the finish line; a reset mid-jump counts as a crash). Flips auto-reset after 0.5 s.
 */
export class RaceController implements System, RaceView {
  phase: GamePhase = 'title';
  elapsedS = 0;
  countdownLeftS = 0;
  winner: RacerId | null = null;
  readonly config: RaceConfig;
  readonly progress: Record<RacerId, RacerProgress>;
  /** Last results (null until a race completes). */
  lastResults: RaceResults | null = null;
  private vehicles: Partial<Record<RacerId, Vehicle>> = {};
  private drivers: Partial<Record<RacerId, { input: DriveInput; control?: DriverControl }>> = {};
  /** Inputs used while a car is not allowed to drive: brake to a stop, never reverse. */
  private hold: Record<RacerId, DriveInput> = {
    player: { steer: 0, throttle: 0, brake: 0 },
    cpu: { steer: 0, throttle: 0, brake: 0 },
  };
  private pendingReset: Partial<Record<RacerId, number>> = {};
  private lastCount = 0;
  private leader: RacerId | null = null;
  private resultsTimer = -1;
  private finishOrder = 0;
  /** Seconds left for the computer after Brooks is done (−1 = not running). */
  private cpuGraceLeft = -1;
  /** Track distance of the grid (results distances are measured from here). */
  private gridS: Record<RacerId, number> = { player: 0, cpu: 0 };
  private unsub: (() => void)[] = [];
  /** Per-racer jump bookkeeping: time in the current jump phase and the touchdown s. */
  private jumpT: Record<RacerId, { t: number; landS: number }> = { player: { t: 0, landS: 0 }, cpu: { t: 0, landS: 0 } };

  constructor(
    private world: World,
    config: Partial<RaceConfig> = {},
  ) {
    this.config = { ...DEFAULT_RACE_CONFIG, ...config };
    this.progress = { player: this.blank('player'), cpu: this.blank('cpu') };
    this.unsub.push(
      events.on('vehicle:flipped', ({ racer }) => {
        if (this.canDrive(racer) || this.phase === 'freeDrive') this.requestReset(racer, 0.5);
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  private blank(racer: RacerId): RacerProgress {
    return {
      racer,
      s: 0,
      bestS: 0,
      lateral: 0,
      checkpoint: -1,
      finished: false,
      finishTimeS: null,
      jump: 'none',
      jumpM: null,
      jumpCrashed: false,
      jumpBonus: false,
      position: 1,
      stage: 'waiting',
      bonusLeftS: 0,
      points: 0,
    };
  }

  get timeLeftS(): number {
    return Math.max(0, this.config.timeLimitS - this.elapsedS);
  }

  /** Distance along the track of the finish line (the end-jump run-up starts here). */
  get finishS(): number {
    return this.world.track.finishS;
  }

  setVehicle(racer: RacerId, v: Vehicle | undefined): void {
    this.vehicles[racer] = v;
    if (v) v.input = this.canDrive(racer) || this.phase === 'freeDrive' ? (this.drivers[racer]?.input ?? v.input) : this.hold[racer];
  }

  /**
   * Who drives `racer`: its DriveInput (PlayerInput.state / AIDriver.input) and, optionally, an object
   * whose `enabled` flag race toggles (AIDriver). Race assigns `vehicle.input` itself: the driver's input
   * while that car may drive, a brake-to-stop "hold" input otherwise (countdown, after its race is over).
   */
  setDriver(racer: RacerId, input: DriveInput, control?: DriverControl): void {
    this.drivers[racer] = { input, control };
    this.applyDrivers();
  }

  setPhase(to: GamePhase): void {
    if (to === this.phase) return;
    const from = this.phase;
    this.phase = to;
    events.emit('phase:changed', { from, to });
  }

  /** M1: free driving on the test ground (no rules). */
  startFreeDrive(): void {
    this.elapsedS = 0;
    for (const r of RACERS) this.progress[r].stage = 'racing';
    this.setPhase('freeDrive');
    this.applyDrivers();
  }

  /** The vehicle spin is running (UI/vehicles own the reel). */
  startSpin(): void {
    this.pendingReset = {};
    for (const r of RACERS) this.progress[r].stage = 'waiting';
    this.setPhase('spin');
    this.applyDrivers();
  }

  /** Back to the grid and run 3-2-1-GO. Call after both vehicles are set. */
  startCountdown(): void {
    this.world.resetDynamic();
    this.elapsedS = 0;
    this.winner = null;
    this.leader = null;
    this.resultsTimer = -1;
    this.finishOrder = 0;
    this.cpuGraceLeft = -1;
    this.pendingReset = {};
    this.lastResults = null;
    for (const r of RACERS) {
      const sp = this.world.spawns[r];
      const gs = this.world.track.project(_p.set(sp.x, sp.y, sp.z)).s;
      this.gridS[r] = gs;
      Object.assign(this.progress[r], this.blank(r), { s: gs, bestS: gs });
      this.vehicles[r]?.reset(sp);
    }
    this.countdownLeftS = this.config.countdownS;
    this.lastCount = Math.ceil(this.countdownLeftS);
    this.setPhase('countdown');
    this.applyDrivers();
    events.emit('race:countdown', { n: this.lastCount });
  }

  /** Leave the race (menu). Cars stop, nothing is scored. */
  abort(): void {
    this.pendingReset = {};
    this.countdownLeftS = 0;
    for (const r of RACERS) this.progress[r].stage = 'waiting';
    this.setPhase('title');
    this.applyDrivers();
  }

  /** Reset the racer to the last checkpoint after `delay` seconds (SPEC: 2 s for the button). */
  requestReset(racer: RacerId, delay = this.config.resetDelayS): void {
    if (this.pendingReset[racer] !== undefined) return;
    if (!this.canDrive(racer) && this.phase !== 'freeDrive') return;
    this.pendingReset[racer] = delay;
    events.emit('race:resetting', { racer, delayS: delay });
  }

  /** Is a reset countdown running for this racer (UI can show "Resetting…"). */
  isResetting(racer: RacerId): boolean {
    return this.pendingReset[racer] !== undefined;
  }

  /** Where `racer` would respawn right now. */
  respawnFor(racer: RacerId): SpawnPoint {
    const p = this.progress[racer];
    const cps = this.world.checkpoints;
    const track = this.world.track;
    const cp = p.checkpoint >= 0 ? cps[p.checkpoint] : undefined;
    // After the finish line, back to the finish (start of the jump run-up), unless a checkpoint sits farther on.
    if (p.finished && (!cp || cp.s < this.finishS)) return this.trackSpawn(Math.min(this.finishS, track.length - 1));
    if (cp) return cp.respawn;
    if (p.bestS < 15) return this.world.spawns[racer];
    return this.trackSpawn(Math.max(0, p.s - 5));
  }

  private trackSpawn(s: number): SpawnPoint {
    const pt = this.world.track.pointAt(s, _p);
    const t = this.world.track.tangentAt(s, _t);
    return { x: pt.x, y: pt.y, z: pt.z, yaw: Math.atan2(t.x, t.z) };
  }

  /** May this racer drive right now (GO given and its race not over)? */
  canDrive(racer: RacerId): boolean {
    const st = this.progress[racer].stage;
    return (this.phase === 'racing' || this.phase === 'bonus') && (st === 'racing' || st === 'bonus');
  }

  private applyDrivers(): void {
    for (const r of RACERS) {
      const d = this.drivers[r];
      const drive = this.phase === 'freeDrive' || this.canDrive(r);
      if (d?.control) d.control.enabled = drive;
      const v = this.vehicles[r];
      if (v) v.input = drive && d ? d.input : this.hold[r];
    }
  }

  // ------------------------------------------------------------------ simulation

  fixedUpdate(dt: number): void {
    // Hold inputs: brake while moving, release once stopped (brake at standstill would reverse).
    for (const r of RACERS) {
      const v = this.vehicles[r];
      const h = this.hold[r];
      h.brake = v && Math.abs(v.speed) > 0.7 ? 1 : 0;
    }

    for (const racer of RACERS) {
      const left = this.pendingReset[racer];
      if (left === undefined) continue;
      const next = left - dt;
      if (next > 0) this.pendingReset[racer] = next;
      else {
        delete this.pendingReset[racer];
        // A reset mid-jump ends the attempt as a crash.
        const pj = this.progress[racer];
        if (pj.stage === 'bonus' && (pj.jump === 'air' || pj.jump === 'landing')) {
          if (pj.jump === 'air') this.jumpT[racer].landS = pj.s;
          this.resolveJump(racer, true);
        }
        const v = this.vehicles[racer];
        if (v) {
          const sp = this.respawnFor(racer);
          v.reset(sp);
          this.progress[racer].s = this.world.track.project(_p.set(sp.x, sp.y, sp.z)).s;
        }
      }
    }

    if (this.phase === 'countdown') {
      this.countdownLeftS -= dt;
      const n = Math.ceil(this.countdownLeftS);
      if (this.countdownLeftS <= 0) {
        this.countdownLeftS = 0;
        for (const r of RACERS) this.progress[r].stage = 'racing';
        this.setPhase('racing');
        this.applyDrivers();
        events.emit('race:go', {});
      } else if (n !== this.lastCount) {
        this.lastCount = n;
        events.emit('race:countdown', { n });
      }
    }
  }

  postPhysics(dt: number): void {
    const racing = this.phase === 'racing' || this.phase === 'bonus';
    if (racing || this.phase === 'freeDrive') this.elapsedS += dt;

    const track = this.world.track;
    for (const racer of RACERS) {
      const v = this.vehicles[racer];
      if (!v) continue;
      const p = this.progress[racer];
      const proj = track.project(v.position, p.s);
      p.s = Math.min(proj.s, p.s + MAX_S_JUMP);
      p.lateral = proj.lateral;
      if (p.stage === 'racing' || p.stage === 'bonus') p.bestS = Math.max(p.bestS, p.s);
    }
    if (!racing) return;

    for (const racer of RACERS) {
      const p = this.progress[racer];
      if (p.stage === 'racing') {
        // Checkpoints in order.
        const cps = this.world.checkpoints;
        while (p.checkpoint + 1 < cps.length && p.bestS >= cps[p.checkpoint + 1].s) {
          p.checkpoint++;
          events.emit('race:checkpoint', { racer, index: p.checkpoint });
        }
        if (p.bestS >= this.finishS) this.finish(racer);
      } else if (p.stage === 'bonus') {
        p.bonusLeftS = Math.max(0, p.bonusLeftS - dt);
        this.updateJump(racer, dt);
        // Time's up (an attempt already in the air still gets to land).
        if (p.stage === 'bonus' && p.bonusLeftS <= 0 && p.jump !== 'air' && p.jump !== 'landing') this.done(racer);
      }
    }

    // Timer.
    if (this.elapsedS >= this.config.timeLimitS && RACERS.some((r) => this.progress[r].stage === 'racing')) {
      events.emit('race:timeout', {});
      for (const r of RACERS) if (this.progress[r].stage === 'racing') this.done(r);
    }

    if (this.cpuGraceLeft >= 0 && this.progress.cpu.stage !== 'done') {
      this.cpuGraceLeft -= dt;
      if (this.cpuGraceLeft <= 0) this.done('cpu');
    }

    this.updatePositions();

    // Everyone done → short celebration → results.
    if (RACERS.every((r) => this.progress[r].stage === 'done')) {
      if (this.resultsTimer < 0) this.resultsTimer = this.config.resultsDelayS;
      this.resultsTimer -= dt;
      if (this.resultsTimer <= 0) this.showResults();
    }
  }

  /** One end-jump attempt per racer: take-off → touchdown → stay upright `jumpLandS` → resolve. */
  private updateJump(racer: RacerId, dt: number): void {
    const p = this.progress[racer];
    const v = this.vehicles[racer];
    const j = this.world.jump;
    if (!v || p.jump === 'done') return;
    const st = this.jumpT[racer];
    st.t += dt;
    const upY = _up.set(0, 1, 0).applyQuaternion(v.quaternion).y;
    if (p.jump === 'none') {
      if (p.s > j.lipS - 4 && p.s < j.lipS + 15 && v.wheelsOnGround === 0 && v.airTime > 0.12) {
        p.jump = 'air';
        st.t = 0;
        events.emit('race:takeoff', { racer });
      } else if (p.s > j.lipS + this.config.jumpMissM) {
        // Never left the ground (drove round the ramp, or crept off it): the attempt is over, 0 m.
        st.landS = j.lipS;
        this.resolveJump(racer, false);
      }
    } else if (p.jump === 'air') {
      if (v.wheelsOnGround >= 2) {
        p.jump = 'landing';
        st.t = 0;
        st.landS = p.s;
      } else if (st.t > 7 || (upY < 0.2 && st.t > 0.5 && v.wheelsOnGround === 0 && Math.abs(v.speed) < 2)) {
        // Came down on the roof/side (no wheel contact) or something odd: a crash where it is.
        st.landS = p.s;
        this.resolveJump(racer, true);
      }
    } else if (p.jump === 'landing') {
      if (upY < 0.5 || v.flipped) this.resolveJump(racer, true);
      else if (st.t >= this.config.jumpLandS) this.resolveJump(racer, false);
    }
  }

  private resolveJump(racer: RacerId, crashed: boolean): void {
    const p = this.progress[racer];
    if (p.jump === 'done') return;
    const j = this.world.jump;
    const dist = Math.max(0, this.jumpT[racer].landS - j.lipS);
    p.jump = 'done';
    p.jumpM = Math.round(dist * 10) / 10;
    p.jumpCrashed = crashed;
    p.jumpBonus = !crashed && dist >= j.bonusM;
    if (p.jumpBonus) p.points += 1;
    events.emit('race:jump', { racer, distanceM: p.jumpM, bonus: p.jumpBonus, crashed });
    this.done(racer);
  }

  private finish(racer: RacerId): void {
    const p = this.progress[racer];
    p.finished = true;
    p.finishTimeS = this.elapsedS;
    const winner = this.winner === null;
    this.finishOrder++;
    if (winner) {
      this.winner = racer;
      p.points += 1;
    }
    events.emit('race:finish', { racer, timeS: this.elapsedS, winner });
    if (winner && this.phase === 'racing') this.setPhase('bonus');
    p.stage = 'bonus';
    p.jump = 'none';
    this.jumpT[racer].t = 0;
    p.bonusLeftS = this.config.bonusTimeS;
    delete this.pendingReset[racer];
    events.emit('race:bonus', { racer, seconds: this.config.bonusTimeS });
  }

  private done(racer: RacerId): void {
    const p = this.progress[racer];
    if (p.stage === 'done') return;
    p.stage = 'done';
    p.bonusLeftS = 0;
    delete this.pendingReset[racer];
    this.applyDrivers();
    events.emit('race:done', { racer });
    // Don't make Brooks wait long for the computer (see config.cpuGraceS).
    if (racer === 'player' && this.progress.cpu.stage !== 'done') this.cpuGraceLeft = this.config.cpuGraceS;
  }

  private updatePositions(): void {
    const a = this.progress.player;
    const b = this.progress.cpu;
    let lead: RacerId;
    if (a.finished || b.finished) {
      if (a.finished && b.finished) lead = (a.finishTimeS ?? 0) <= (b.finishTimeS ?? 0) ? 'player' : 'cpu';
      else lead = a.finished ? 'player' : 'cpu';
    } else {
      // Done-by-timeout cars are ranked by the farthest point they reached.
      const sa = a.stage === 'done' ? a.bestS : a.s;
      const sb = b.stage === 'done' ? b.bestS : b.s;
      const cur = this.leader ?? 'player';
      const diff = sa - sb;
      lead = Math.abs(diff) < LEAD_HYSTERESIS ? cur : diff > 0 ? 'player' : 'cpu';
    }
    a.position = lead === 'player' ? 1 : 2;
    b.position = lead === 'cpu' ? 1 : 2;
    if (lead !== this.leader) {
      const first = this.leader === null;
      this.leader = lead;
      if (!first) events.emit('race:lead', { leader: lead });
    }
  }

  private showResults(): void {
    if (this.phase === 'results') return;
    const a = this.progress.player;
    const b = this.progress.cpu;
    let reason: RaceResults['reason'] = 'finish';
    if (this.winner === null) {
      // Nobody finished: farthest along the centre-line wins (SPEC).
      const diff = a.bestS - b.bestS;
      if (Math.abs(diff) < 0.5) reason = 'tie';
      else {
        reason = 'distance';
        this.winner = diff > 0 ? 'player' : 'cpu';
        this.progress[this.winner].points += 1;
      }
    }
    const racerResult = (p: RacerProgress): RacerResult => ({
      racer: p.racer,
      vehicle: this.vehicles[p.racer]?.spec.name ?? '',
      distanceM: Math.max(0, Math.round((p.finished ? Math.max(p.bestS, this.finishS) : p.bestS) - this.gridS[p.racer])),
      finished: p.finished,
      timeS: p.finishTimeS,
      bonus: p.jumpBonus,
      points: p.points,
      jumpM: p.jumpM,
      jumpCrashed: p.jumpCrashed,
    });
    for (const p of [a, b]) if (p.points) session.add(p.racer, p.points);
    const results: RaceResults = {
      winner: this.winner,
      racers: [racerResult(a), racerResult(b)],
      session: { ...session.score },
      reason,
      finishM: Math.round(this.finishS - this.gridS.player),
      jumpBonusM: this.world.jump.bonusM,
    };
    this.lastResults = results;
    this.setPhase('results');
    this.applyDrivers();
    events.emit('race:results', results);
  }
}
