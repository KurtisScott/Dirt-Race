import type { QualityLevel, RacerId, SurfaceType, VehicleKind } from './types';

/**
 * All cross-module events. Add new events here (one line each) rather than
 * importing other modules directly — this keeps the five work-streams decoupled.
 */
export interface GameEvents {
  // ---- game flow / race (emitted by src/race, src/main) ----
  'phase:changed': { from: GamePhase; to: GamePhase };
  'race:countdown': { n: number }; // 3, 2, 1
  'race:go': Record<string, never>;
  'race:checkpoint': { racer: RacerId; index: number };
  'race:finish': { racer: RacerId; timeS: number; winner: boolean };
  'race:summit': { racer: RacerId };
  'race:timeout': Record<string, never>;
  'race:results': RaceResults;
  /** The leading car changed during the race (not emitted at GO). */
  'race:lead': { leader: RacerId };
  /** A racer crossed the finish line and its bonus-hill window started. */
  'race:bonus': { racer: RacerId; seconds: number };
  /** A racer's race is over (summit reached, bonus window ran out, or time ran out). */
  'race:done': { racer: RacerId };
  /** A reset was requested; the car moves after `delayS`. */
  'race:resetting': { racer: RacerId; delayS: number };
  // Optional (added by audio; race/ui emit them when ready — listeners must tolerate them never firing):
  /** Spin reel advanced one item (UI/race emits per visible tick; audio throttles). */
  'spin:tick': { racer: RacerId };
  /** Spin reel stopped on a vehicle. */
  'spin:land': { racer: RacerId; kind: VehicleKind };

  // ---- vehicles (emitted by src/vehicles) ----
  'vehicle:reset': { racer: RacerId };
  /** Hard landing after airtime; impact = downward speed in m/s at touchdown. */
  'vehicle:landed': { racer: RacerId; impact: number };
  'vehicle:collision': { racer: RacerId; other: 'vehicle' | 'obstacle' | 'animal' | 'world'; impulse: number };
  'vehicle:flipped': { racer: RacerId };
  'vehicle:surface': { racer: RacerId; surface: SurfaceType };
  /** Round 2: a car took damage. `damage` = new total 0..100 (%), `delta` = this hit. */
  'car:damage': { racer: RacerId; damage: number; delta: number; source?: DamageSource };

  // ---- vehicle spin screen (src/ui/spin also emits spin:tick / spin:land above) ----
  /** GO tapped on the spin screen: both picks final. */
  'spin:done': { player: { kind: VehicleKind; paint: number }; cpu: { kind: VehicleKind; paint: number } };

  // ---- world (emitted by src/world) ----
  'animal:crossing': { kind: string; x: number; z: number };
  'obstacle:hit': { kind: string; racer: RacerId; x: number; y: number; z: number };
  /**
   * Optional: a vehicle bumped an animal (kind as in animal:crossing). Audio plays the animal's voice.
   * Round 2 (optional fields): `damaging` = a big animal that dents the car, `speed` = car speed (m/s).
   */
  'animal:bump': { kind: string; racer: RacerId; x: number; z: number; damaging?: boolean; speed?: number };

  // ---- settings / system ----
  'quality:changed': { level: QualityLevel; auto: boolean };
  /** Frames are still slow at the lowest quality level (world drops to its cheapest terrain shader). */
  'quality:slow': Record<string, never>;
  'settings:changed': Record<string, never>;
  'tilt:status': { status: TiltStatus };
  'app:paused': { paused: boolean };
}

/** What caused a 'car:damage' (optional detail). */
export type DamageSource = 'obstacle' | 'wall' | 'vehicle' | 'landing' | 'animal' | 'other';

export type GamePhase = 'title' | 'calibrate' | 'spin' | 'countdown' | 'racing' | 'bonus' | 'results' | 'freeDrive';
export type TiltStatus = 'unknown' | 'granted' | 'denied' | 'unavailable';

export interface RacerResult {
  racer: RacerId;
  vehicle: string;
  distanceM: number;
  finished: boolean;
  timeS: number | null;
  bonus: boolean;
  points: number;
  /** Optional (Round 2): the car's damage at the end of the race, 0..100 (%). */
  damage?: number;
}
export interface RaceResults {
  winner: RacerId | null;
  racers: RacerResult[];
  session: Record<RacerId, number>;
  /** Optional detail: how the winner was decided ('finish' = first across the line, 'distance' = timer ran out, 'tie'). */
  reason?: 'finish' | 'distance' | 'tie';
  /** Optional: distance of the finish line / summit along the track (m), for result bars. */
  finishM?: number;
  summitM?: number;
}

type Handler<T> = (payload: T) => void;

/** Tiny typed pub/sub. Handlers run synchronously in subscription order. */
export class EventBus<E extends object = GameEvents> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(type, fn);
  }

  once<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof E>(type: K, fn: Handler<E[K]>): void {
    this.handlers.get(type)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<E[K]>)(payload);
      } catch (err) {
        console.error(`[events] handler for "${String(type)}" threw`, err);
      }
    }
  }
}

/** The single app-wide bus. Import this rather than creating new buses. */
export const events = new EventBus<GameEvents>();
