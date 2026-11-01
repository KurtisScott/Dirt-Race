import type { RacerId } from '../core/types';

/** Race-level config. FINISH_AT is the single switch SPEC asks for (foot vs summit). */
export interface RaceConfig {
  /** Race time limit, seconds (SPEC: 4 minutes). */
  timeLimitS: number;
  /** Seconds allowed on the bonus hill after the race is decided (SPEC: 45 s). */
  bonusTimeS: number;
  /** Where the finish line is: 'hillFoot' (default) or 'summit'. */
  finishAt: 'hillFoot' | 'summit';
  /** Wait before a manual reset takes effect (SPEC: 2 s). */
  resetDelayS: number;
}

export const DEFAULT_RACE_CONFIG: RaceConfig = {
  timeLimitS: 240,
  bonusTimeS: 45,
  finishAt: 'hillFoot',
  resetDelayS: 2,
};

/** Per-racer live progress, read by UI (progress strip/position) and AI (rubber-banding). */
export interface RacerProgress {
  racer: RacerId;
  /** Distance along track.path, metres (monotonic-ish; uses project with hint). */
  s: number;
  /** Highest checkpoint index passed (−1 = none). */
  checkpoint: number;
  finished: boolean;
  finishTimeS: number | null;
  summit: boolean;
  /** 1 or 2. */
  position: 1 | 2;
}

/** Read-only view of the race for UI/AI/audio. */
export interface RaceView {
  readonly phase: import('../core/events').GamePhase;
  /** Seconds since GO (excludes pause). */
  readonly elapsedS: number;
  readonly timeLeftS: number;
  readonly progress: Readonly<Record<RacerId, RacerProgress>>;
}
