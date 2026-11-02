import type * as THREE from 'three';
import type { SpawnPoint, SurfaceType, System } from '../core/types';

/**
 * Centre-line of the race route, parameterised by distance `s` in metres from the start line.
 * Used by: race (progress, checkpoints), ai (racing line), ui (progress strip), world (placing things).
 */
export interface TrackPath {
  /** Total length in metres from the start line to the end of the course (after the end jump's run-off). */
  readonly length: number;
  /** Distance along the path of the finish line (SPEC: before the end-jump run-up). */
  readonly finishS: number;
  /** World position on the centre-line at distance s (y = road surface height). */
  pointAt(s: number, target?: THREE.Vector3): THREE.Vector3;
  /** Unit tangent (direction of travel) at distance s. */
  tangentAt(s: number, target?: THREE.Vector3): THREE.Vector3;
  /** Drivable half-width at s (metres either side of centre-line). */
  halfWidthAt(s: number): number;
  /**
   * Project a world position onto the path. `hintS` (the racer's last s) makes this O(1)
   * and avoids snapping to a different part of the track that passes nearby.
   * lateral > 0 = right of centre-line when facing along the tangent.
   */
  project(pos: THREE.Vector3, hintS?: number): { s: number; lateral: number };
}

export interface Checkpoint {
  index: number;
  /** Distance along the track. */
  s: number;
  /** Where a car resets to when it uses Reset after passing this checkpoint. */
  respawn: SpawnPoint;
}

/** Track zones from SPEC (used for animals, music intensity, HUD labels). */
export type ZoneId = 'town' | 'farm' | 'mud' | 'rocky' | 'forest' | 'canyon' | 'snow' | 'desert' | 'river' | 'finish' | 'jump' | 'test';

export interface Zone {
  id: ZoneId;
  startS: number;
  endS: number;
}

/**
 * The end jump (SPEC round 2: replaces the bonus hill). After the finish line a straight run-up leads to a
 * ramp; landing on the wheels at least `bonusM` past the lip earns +1. Jump distance = horizontal metres
 * along the centre-line from the lip to the touchdown point.
 */
export interface JumpInfo {
  /** s of the ramp lip (take-off). */
  readonly lipS: number;
  /** The bonus line: metres past the lip. */
  readonly bonusM: number;
  /** = lipS + bonusM. */
  readonly bonusS: number;
  /** s where the landing zone ends and the run-off begins. */
  readonly runoffS: number;
  /** Spacing of the distance markers in the landing zone (m). */
  readonly markerStepM: number;
  /** Lip centre (top of the ramp) and the centre of the bonus line on the ground (camera / effects). */
  readonly lip: THREE.Vector3;
  readonly bonusLine: THREE.Vector3;
}

/** Physical surface lookup. Vehicles call this per wheel per physics step: keep it cheap (no raycasts). */
export interface SurfaceQuery {
  surfaceAt(x: number, z: number): SurfaceType;
}

/**
 * Everything the rest of the game needs from a world/level.
 * Implemented by RaceCourse (the real track) and TestGround (?level=test).
 */
export interface World extends SurfaceQuery, System {
  readonly track: TrackPath;
  readonly zones: readonly Zone[];
  readonly checkpoints: readonly Checkpoint[];
  /** Two side-by-side grid slots behind the start line. */
  readonly spawns: { player: SpawnPoint; cpu: SpawnPoint };
  /** The end jump after the finish line. */
  readonly jump: JumpInfo;
  /** Approximate terrain height at (x, z) (no raycast; for placing props/particles). */
  heightAt(x: number, z: number): number;
  zoneAt(s: number): Zone;
  /** Called by the race when restarting: put scattered debris back, despawn animals. */
  resetDynamic(): void;
}
