import type { DriveInput } from '../core/types';

/** Discrete button actions (keyboard or on-screen). */
export type InputAction = 'reset' | 'pause' | 'camera';

/** Anything that can produce a steering value in [-1, 1] (tilt, buttons, keyboard). */
export interface SteerSource {
  /** Latest steer value -1..1, or null when this source has no opinion this frame. */
  readSteer(dt: number): number | null;
}

/** Public surface of the player's input system (what main/race/ui use). */
export interface PlayerControls {
  /** Combined, smoothed intent for the player's vehicle. Updated every frame. */
  readonly state: Readonly<DriveInput>;
  /** Disable to freeze input (menus, countdown). Returns zeros while disabled. */
  enabled: boolean;
  onAction(action: InputAction, fn: () => void): () => void;
}
