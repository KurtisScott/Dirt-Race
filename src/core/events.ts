import type { QualityLevel, RacerId, SurfaceType } from './types';

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

  // ---- vehicles (emitted by src/vehicles) ----
  'vehicle:reset': { racer: RacerId };
  /** Hard landing after airtime; impact = downward speed in m/s at touchdown. */
  'vehicle:landed': { racer: RacerId; impact: number };
  'vehicle:collision': { racer: RacerId; other: 'vehicle' | 'obstacle' | 'animal' | 'world'; impulse: number };
  'vehicle:flipped': { racer: RacerId };
  'vehicle:surface': { racer: RacerId; surface: SurfaceType };

  // ---- world (emitted by src/world) ----
  'animal:crossing': { kind: string; x: number; z: number };
  'obstacle:hit': { kind: string; racer: RacerId; x: number; y: number; z: number };

  // ---- settings / system ----
  'quality:changed': { level: QualityLevel; auto: boolean };
  'settings:changed': Record<string, never>;
  'tilt:status': { status: TiltStatus };
  'app:paused': { paused: boolean };
}

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
}
export interface RaceResults {
  winner: RacerId | null;
  racers: RacerResult[];
  session: Record<RacerId, number>;
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
