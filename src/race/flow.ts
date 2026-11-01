import { events, type RaceResults } from '../core/events';
import { settings } from '../core/settings';
import type { DriveInput, RacerId, SpawnPoint, System } from '../core/types';
import type { Vehicle } from '../vehicles/types';
import type { World } from '../world/types';
import type { RaceController } from './index';
import { randomSpin, type SpinFn, type VehiclePicks } from './spin';
import type { DriverControl } from './types';

/** What the flow needs from a computer driver (AIDriver satisfies this; race does not import ai/). */
export interface ComputerDriver extends System, DriverControl {
  readonly input: DriveInput;
  onRequestReset: (() => void) | null;
  rival?: { gapM(): number } | null;
}

export interface RaceFlowDeps {
  race: RaceController;
  world: World;
  /** Player's live input + on/off switch (PlayerInput). */
  player: { readonly state: DriveInput } & DriverControl;
  /** Build a vehicle for a pick at a spawn (main passes createVehicle with scene/physics/model builder). */
  createVehicle(racer: RacerId, pick: VehiclePicks[RacerId], spawn: SpawnPoint): Vehicle;
  /** Build the computer driver for the cpu vehicle (main passes `new AIDriver(...)` + sensor). */
  createComputer(cpu: Vehicle, rivalGap: () => number): ComputerDriver;
  /** Returns both picks. Defaults to the random stub until the vehicles spin is merged. */
  spin?: SpinFn;
  /**
   * Show the spin/reveal for these picks; resolve when the player is ready to race.
   * Omit to go straight to the countdown (tests).
   */
  showSpin?(picks: VehiclePicks): Promise<void>;
  /** New cars exist (attach camera/audio/fx, HUD colours). `old` are about to be disposed. */
  onVehicles?(now: Record<RacerId, Vehicle>, old: Partial<Record<RacerId, Vehicle>>): void;
  onResults?(res: RaceResults): void;
}

/**
 * Glue for one full race: spin → countdown → racing → bonus → results, then Race Again or Menu.
 * Owns the per-race vehicles and AI driver. Register `aiSystem` and `vehicleSystem` with the loop
 * right after the race controller (AI must write its input before vehicles read it).
 */
export class RaceFlow {
  vehicles: Partial<Record<RacerId, Vehicle>> = {};
  computer: ComputerDriver | null = null;
  picks: VehiclePicks | null = null;
  private token = 0;

  /** Ticks the current computer driver (fixedUpdate before vehicles). */
  readonly aiSystem: System = {
    fixedUpdate: (dt) => this.computer?.fixedUpdate?.(dt),
    update: (dt, a) => this.computer?.update?.(dt, a),
  };
  /** Ticks the current vehicles. */
  readonly vehicleSystem: System = {
    fixedUpdate: (dt) => {
      for (const v of this.list()) v.fixedUpdate?.(dt);
    },
    postPhysics: (dt) => {
      for (const v of this.list()) v.postPhysics?.(dt);
    },
    update: (dt, a) => {
      for (const v of this.list()) v.update?.(dt, a);
    },
  };

  constructor(private deps: RaceFlowDeps) {
    events.on('race:results', (res) => this.deps.onResults?.(res));
  }

  private list(): Vehicle[] {
    const out: Vehicle[] = [];
    if (this.vehicles.player) out.push(this.vehicles.player);
    if (this.vehicles.cpu) out.push(this.vehicles.cpu);
    return out;
  }

  /** Spin new cars and run a race. Safe to call from results (Race Again) or from the calibrate screen. */
  async newRace(): Promise<void> {
    const token = ++this.token;
    const { race, world } = this.deps;
    race.startSpin();
    const picks = (this.deps.spin ?? randomSpin)();
    this.picks = picks;
    this.buildCars(picks);
    world.resetDynamic();
    if (this.deps.showSpin) await this.deps.showSpin(picks);
    if (token !== this.token || race.phase !== 'spin') return; // menu pressed meanwhile
    race.startCountdown();
  }

  /** Build a pair of cars on the grid without starting a race (title-screen backdrop). */
  prepare(): void {
    this.picks = (this.deps.spin ?? randomSpin)();
    this.buildCars(this.picks);
  }

  /** Back to the menu: stop scoring, keep the cars parked on the grid. */
  quit(): void {
    this.token++;
    this.deps.race.abort();
  }

  private buildCars(picks: VehiclePicks): void {
    const { race, world, player } = this.deps;
    const old = { ...this.vehicles };
    const pv = this.deps.createVehicle('player', picks.player, world.spawns.player);
    const cv = this.deps.createVehicle('cpu', picks.cpu, world.spawns.cpu);
    this.vehicles = { player: pv, cpu: cv };
    race.setVehicle('player', pv);
    race.setVehicle('cpu', cv);
    const gap = (): number => race.progress.cpu.s - race.progress.player.s;
    const ai = this.deps.createComputer(cv, gap);
    ai.onRequestReset = () => race.requestReset('cpu');
    this.computer = ai;
    race.setDriver('player', player.state, player);
    race.setDriver('cpu', ai.input, ai);
    this.deps.onVehicles?.({ player: pv, cpu: cv }, old);
    for (const v of Object.values(old)) v?.dispose();
  }

  /** Difficulty to use for the next computer driver. */
  get difficulty() {
    return settings.difficulty;
  }
}
