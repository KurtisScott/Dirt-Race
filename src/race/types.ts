import type { RacerId } from '../core/types';

/** Race-level config. */
export interface RaceConfig {
  /** Race time limit, seconds (SPEC round 2: 8 minutes). */
  timeLimitS: number;
  /** Seconds each finisher has for its one end-jump attempt (SPEC: 45 s). */
  bonusTimeS: number;
  /** Wait before a manual reset takes effect (SPEC: 2 s). */
  resetDelayS: number;
  /** Length of the 3-2-1 countdown before GO, seconds. */
  countdownS: number;
  /** Pause between "everyone is done" and the results screen (finish celebration), seconds. */
  resultsDelayS: number;
  /** A jump landing counts once the car has stayed upright on its wheels this long after touchdown (s). */
  jumpLandS: number;
  /** Passing the lip by this many metres without ever leaving the ground ends the attempt (drove round / crept off). */
  jumpMissM: number;
  /**
   * Once Brooks's race is over (jump done, bonus window used up, or timer), the computer gets at most this
   * many more seconds to finish / jump, so a kid isn't left waiting.
   */
  cpuGraceS: number;
}

export const DEFAULT_RACE_CONFIG: RaceConfig = {
  timeLimitS: 480,
  bonusTimeS: 45,
  resetDelayS: 2,
  countdownS: 3,
  resultsDelayS: 1.5,
  jumpLandS: 1.0,
  jumpMissM: 25,
  cpuGraceS: 12,
};

/** Where a racer is in its one end-jump attempt. */
export type JumpPhase = 'none' | 'air' | 'landing' | 'done';

/**
 * Where a racer is in its own race:
 * waiting (before GO) → racing → bonus (crossed the finish, 45 s for the end jump) → done.
 * A racer still racing when the timer runs out goes straight to done.
 */
export type RacerStage = 'waiting' | 'racing' | 'bonus' | 'done';

/** Per-racer live progress, read by UI (progress strip/position) and AI (rubber-banding). */
export interface RacerProgress {
  racer: RacerId;
  /** Distance along track.path, metres (monotonic-ish; uses project with hint). */
  s: number;
  /** Farthest distance reached this race (used for the timer/farthest rule and the results). */
  bestS: number;
  /** Signed distance from the centre-line (m, > 0 = right of travel). */
  lateral: number;
  /** Highest checkpoint index passed (−1 = none). */
  checkpoint: number;
  finished: boolean;
  finishTimeS: number | null;
  /** End jump: attempt state, distance (m past the lip, null = no attempt yet), crash, bonus earned. */
  jump: JumpPhase;
  jumpM: number | null;
  jumpCrashed: boolean;
  jumpBonus: boolean;
  /** 1 or 2. */
  position: 1 | 2;
  stage: RacerStage;
  /** Seconds left in this racer's bonus-jump window (0 when not in bonus). */
  bonusLeftS: number;
  /** Points earned this race so far (finish win + jump bonus). */
  points: number;
}

/** Read-only view of the race for UI/AI/audio. */
export interface RaceView {
  readonly phase: import('../core/events').GamePhase;
  /** Seconds since GO (excludes pause). */
  readonly elapsedS: number;
  readonly timeLeftS: number;
  readonly progress: Readonly<Record<RacerId, RacerProgress>>;
  /** Seconds left in the 3-2-1 countdown (0 outside the countdown). Optional for older views. */
  readonly countdownLeftS?: number;
  /** Winner once decided (first across the finish, or by distance when time runs out). */
  readonly winner?: RacerId | null;
  readonly config?: Readonly<RaceConfig>;
}

/** Something whose input can be switched on/off by the race (PlayerInput, AIDriver). */
export interface DriverControl {
  enabled: boolean;
}
