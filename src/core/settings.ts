import { events } from './events';
import { loadJSON, saveJSON } from './storage';
import type { CameraMode, Difficulty, QualityLevel, Sensitivity } from './types';

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
  /** Has the "turn on Rotation Lock" tip been shown. */
  seenRotationTip: boolean;
}

const KEY = 'dirtrace.settings.v1';

const DEFAULTS: Settings = {
  quality: 'medium',
  autoQuality: true,
  sensitivity: 'medium',
  difficulty: 'easy',
  camera: 'close',
  musicVolume: 0.6,
  sfxVolume: 0.9,
  steerButtons: false,
  tiltInvert: false,
  seenRotationTip: false,
};

/** Live settings object. Mutate via `updateSettings` so changes persist and broadcast. */
export const settings: Settings = loadJSON<Settings>(KEY, DEFAULTS);

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  saveJSON(KEY, settings);
  events.emit('settings:changed', {});
}
