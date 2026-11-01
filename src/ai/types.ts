import type * as THREE from 'three';

/**
 * Optional extras a World may expose to help the computer driver. None are required:
 * the AI works on any World using only `track`, `checkpoints` and (if given) physics ray casts.
 * The real track can add these as optional members of its World implementation; the AI duck-types them.
 */
export interface TrackShortcut {
  /** e.g. 'log-bridge'. */
  id: string;
  /** Distance along the main centre-line where the shortcut leaves / rejoins it. */
  startS: number;
  endS: number;
  /** Drivable centre-line of the shortcut, from the leave point to the rejoin point (≥ 2 points). */
  points: readonly THREE.Vector3[];
  /** Half-width of the shortcut path (m). Default 2. */
  halfWidth?: number;
  /** Safe speed on the shortcut (m/s). Default 12. */
  maxSpeed?: number;
}

export interface AIWorldExtras {
  /** Shortcuts only the Hard computer takes (SPEC: log-bridge across the river). */
  readonly shortcuts?: readonly TrackShortcut[];
}

/** Ray-cast hook so the AI can "see" obstacles, animals and the other car without touching bodies. */
export interface ObstacleSensor {
  /**
   * Distance (m) to the first obstacle along the ray, or null. Implemented in main with
   * `physics.world.castRay` against STATIC | DEBRIS | ANIMAL | VEHICLE colliders.
   */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number | null;
}

/** Live rival info for rubber-banding (Easy eases off when far ahead). */
export interface RivalInfo {
  /** Own distance along the track minus the rival's (m). Positive = AI is ahead. */
  gapM(): number;
}
