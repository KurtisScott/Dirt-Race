import { events } from './events';
import { loadJSON, saveJSON } from './storage';
import type { CameraMode, Difficulty, QualityLevel, Sensitivity, SpeedUnit } from './types';

export interface Settings {
  quality: QualityLevel;
  /** When true the quality manager may drop a level if frame time is high. */
  autoQuality: boolean;
  sensitivity: Sensitivity;
  difficulty: Difficulty;
  camera: CameraMode;
  musicVolume: number; // 0..1
  sfxVolume: number; // 0..1
  /** Force on-screen steering buttons even if tilt works. */
  steerButtons: boolean;
  /** Flip tilt direction (safety valve if a device reports the opposite sign). */
  tiltInvert: boolean;
  /** Speedometer/distance units. Default mph (family is US-based). */
  speedUnit: SpeedUnit;
  /** Has the "turn on Rotation Lock" tip been shown. */
  seenRotationTip: boolean;
  /**
   * Settings schema for graphics. Round 2 (= 2): Ultra became the default and everyone was moved to it
   * once (the family asked for max realism); later choices are respected.
   */
  qualityVersion: number;
  /** The one-time "game running slow — lower the graphics?" prompt: not asked yet, or the answer. */
  slowPrompt: 'unasked' | 'lowered' | 'kept';
}

const KEY = 'dirtrace.settings.v1';
export const QUALITY_VERSION = 2;

const DEFAULTS: Settings = {
  quality: 'ultra',
  // Round 2: no automatic dropping by default; a one-time prompt asks instead (core/quality.ts).
  autoQuality: false,
  sensitivity: 'medium',
  difficulty: 'easy',
  camera: 'close',
  musicVolume: 0.6,
  sfxVolume: 0.9,
  steerButtons: false,
  tiltInvert: false,
  seenRotationTip: false,
  speedUnit: 'mph',
  qualityVersion: QUALITY_VERSION,
  slowPrompt: 'unasked',
};

/** Live settings object. Mutate via `updateSettings` so changes persist and broadcast. */
export const settings: Settings = loadJSON<Settings>(KEY, DEFAULTS);
migrate();

/**
 * One-time migration of saved settings from before Round 2 (no `qualityVersion`): move to Ultra with
 * auto-dropping off. Runs once; any later choice in Settings is kept.
 */
function migrate(): void {
  const raw = loadJSON<Partial<Settings>>(KEY, {});
  const stored = typeof raw.qualityVersion === 'number' ? raw.qualityVersion : Object.keys(raw).length ? 1 : QUALITY_VERSION;
  if (stored >= QUALITY_VERSION) return;
  Object.assign(settings, { quality: 'ultra', autoQuality: false, qualityVersion: QUALITY_VERSION, slowPrompt: 'unasked' } satisfies Partial<Settings>);
  saveJSON(KEY, settings);
}

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  saveJSON(KEY, settings);
  events.emit('settings:changed', {});
}
