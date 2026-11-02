import type { ZoneId } from './types';

/**
 * Course layout: the single place to tune the shape of the real track.
 *
 * The centre-line is built by a "turtle": each segment is a horizontal length (m) and a total heading
 * change (degrees, + = left) spread evenly over that length (so turns are circular arcs). Start at the
 * origin facing +Z. Zones are distance ranges along the centre-line. All distances `s` in the world
 * module are HORIZONTAL metres along the centre-line (the landing hill and snowy pass slope, so 3D length differs).
 */
export interface Segment {
  len: number;
  turn: number;
  /** Marks this segment (used to anchor features: the river loop, ramps, the gorge, the end jump). */
  tag?: SegmentTag;
}
export type SegmentTag =
  | 'riverLoop0'
  | 'riverLoopEnd'
  | 'ford'
  | 'riverside'
  | 'finishStraight'
  | 'jump'
  | 'rampA'
  | 'rampB'
  | 'rampForest'
  | 'rampCanyon'
  | 'gorge'
  | 'rampDesertA'
  | 'rampDesertB';

// ------------------------------------------------------------------ the end jump (replaces the bonus hill)
// Tune the jump HERE. Distances are horizontal metres along the centre-line. See DECISIONS.md ("End jump").
/** Straight asphalt run-up from the finish line to the foot of the ramp (m). */
export const JUMP_RUNUP_M = 230;
/** Ramp: horizontal length (m), lip angle (deg) and lip height above the run-up (m). The face is a circular arc. */
export const JUMP_RAMP_LEN_M = 16;
export const JUMP_RAMP_DEG = 8;
export const JUMP_RAMP_HEIGHT_M = 1.3;
/** THE bonus line: land (on the wheels) at least this far past the lip for +1 point. */
export const JUMP_BONUS_M = 45;
/**
 * Landing hill below the lip (shaped so a clean landing is soft at every distance, like a ski-jump hill):
 * a flat "table" (m), then the drop follows a parabola drop = JUMP_LAND_CURVE·(u − table)² (it bends away
 * under the cars' flight paths), its slope capped at JUMP_LAND_DEG, and it rounds out over the last
 * JUMP_ROUNDOUT_M of the landing zone into the flat run-off.
 */
export const JUMP_TABLE_M = 20;
export const JUMP_LAND_CURVE = 0.0018;
export const JUMP_LAND_DEG = 24;
export const JUMP_ROUNDOUT_M = 25;
/** Landing zone length (lip → start of the run-off), and the sand run-off with a berm at the end (m). */
export const JUMP_LANDING_M = 150;
export const JUMP_RUNOFF_M = 100;
/** Distance markers every this many metres from the lip (kid-readable signs beside the landing zone). */
export const JUMP_MARKER_STEP_M = 10;

/**
 * Finish line placement: metres of the 'finishStraight' segment before the line. The run-up (asphalt,
 * dead straight) starts at the line. SPEC: the finish line stays before the run-up.
 */
export const FINISH_STRAIGHT_M = 170;

/** Snowy pass: how high the road climbs over the saddle (m), and the length of the climb/descent ramps. */
export const SNOW_RISE_M = 22;
export const SNOW_RAMP_M = 220;
/** Gorge in the canyon: depth (m) under the road bridge, and bridge deck length (m). */
export const GORGE_DEPTH_M = 13;
export const GORGE_BRIDGE_M = 26;

// Turn radius notes: a 90° turn over L metres has radius 2L/π (e.g. 80 m → 51 m).
export const SEGMENTS: Segment[] = [
  // ---- Town (asphalt, wide corners)
  { len: 130, turn: 0 },
  { len: 85, turn: -90 },
  { len: 70, turn: 0 },
  { len: 85, turn: 80 },
  // ---- Farm road (dirt)
  { len: 50, turn: 0 },
  { len: 110, turn: 45 },
  { len: 120, turn: -75 },
  { len: 60, turn: 0 },
  { len: 70, turn: 30 },
  // ---- Mud pit
  { len: 240, turn: 15 },
  // ---- Rocky hills (gravel, boulders, two jump ramps on the straights)
  { len: 110, turn: -60 },
  { len: 90, turn: 0, tag: 'rampA' },
  { len: 120, turn: 85 },
  { len: 80, turn: 0, tag: 'rampB' },
  { len: 60, turn: -25 },
  // ---- Forest trail (narrow dirt track through dense trees, fallen logs, a log ramp)
  { len: 90, turn: -35 },
  { len: 70, turn: 0 },
  { len: 110, turn: 65 },
  { len: 60, turn: 0, tag: 'rampForest' },
  { len: 100, turn: -50 },
  { len: 70, turn: 20 },
  { len: 90, turn: 90 },
  // ---- Rocky canyon (red rock walls close in, gravel, boulders, a ramp, a bridge over a gorge)
  { len: 80, turn: 0 },
  { len: 100, turn: -40 },
  { len: 70, turn: 0, tag: 'rampCanyon' },
  { len: 100, turn: 45 },
  { len: 60, turn: 0, tag: 'gorge' },
  { len: 90, turn: -20 },
  { len: 80, turn: 25 },
  // ---- Snowy pass (climbs over a snowy saddle: packed snow, cones, snowy pines)
  { len: 110, turn: 85 },
  { len: 90, turn: 0 },
  { len: 100, turn: -55 },
  { len: 90, turn: 45 },
  { len: 120, turn: 0 },
  // ---- Desert run (sand dunes, two dune jumps): down the east side, then a sweeping turn west
  { len: 100, turn: 0 },
  { len: 110, turn: -10 },
  { len: 90, turn: 0, tag: 'rampDesertA' },
  { len: 120, turn: 10 },
  { len: 160, turn: 0, tag: 'rampDesertB' },
  { len: 160, turn: 90 },
  // ---- River: a long riverside run with the water on the right, a left turn that the river follows,
  //      then the Ω-loop out to the shallow ford and back (the log bridge cuts straight across the loop).
  { len: 20, turn: 0 },
  { len: 150, turn: 0, tag: 'riverside' },
  { len: 120, turn: 90 },
  { len: 40, turn: 0, tag: 'riverLoop0' },
  { len: 42, turn: 90 },
  { len: 14, turn: 0 },
  { len: 42, turn: -90 },
  { len: 46, turn: 0, tag: 'ford' },
  { len: 42, turn: -90 },
  { len: 14, turn: 0 },
  { len: 42, turn: 90, tag: 'riverLoopEnd' },
  // ---- Finish straight up to the finish line
  { len: FINISH_STRAIGHT_M, turn: 0, tag: 'finishStraight' },
  // ---- End jump: run-up, ramp, landing zone, sand run-off (all dead straight)
  { len: JUMP_RUNUP_M + JUMP_RAMP_LEN_M + JUMP_LANDING_M + JUMP_RUNOFF_M, turn: 0, tag: 'jump' },
];

/** How many segments belong to each zone, in order. */
const ZONE_SEGMENTS: [ZoneId, number][] = [
  ['town', 4],
  ['farm', 5],
  ['mud', 1],
  ['rocky', 5],
  ['forest', 7],
  ['canyon', 7],
  ['snow', 5],
  ['desert', 6],
  ['river', 11],
  ['finish', 1],
  ['jump', 1],
];

/** Road half-width per zone (m). */
export const ROAD_HALF_WIDTH: Record<ZoneId, number> = {
  town: 7,
  farm: 5.5,
  mud: 6.5,
  rocky: 6,
  forest: 5,
  canyon: 6,
  snow: 6,
  desert: 6.5,
  river: 6,
  finish: 7,
  jump: 7,
  test: 6,
};

export interface ZoneSpan {
  id: ZoneId;
  startS: number;
  endS: number;
}

export interface CourseLine {
  /** Centre-line points every `step` m of horizontal distance (x, z). */
  xs: Float64Array;
  zs: Float64Array;
  step: number;
  length: number;
  zones: ZoneSpan[];
  /** s at which tagged segments begin / end. */
  tagS: Partial<Record<SegmentTag, number>>;
  tagEndS: Partial<Record<SegmentTag, number>>;
}

/** Run the turtle. */
export function buildCourseLine(step = 2): CourseLine {
  const total = SEGMENTS.reduce((a, s) => a + s.len, 0);
  const n = Math.round(total / step) + 1;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  let x = 0;
  let z = 0;
  let yaw = 0;
  let segIdx = 0;
  let segStart = 0;
  const sub = 8;
  const ds = step / sub;
  let s = 0;
  for (let k = 1; k < n; k++) {
    for (let j = 0; j < sub; j++) {
      while (segIdx < SEGMENTS.length - 1 && s >= segStart + SEGMENTS[segIdx].len - 1e-9) {
        segStart += SEGMENTS[segIdx].len;
        segIdx++;
      }
      const seg = SEGMENTS[segIdx];
      const rate = (seg.turn * Math.PI) / 180 / seg.len;
      const mid = yaw + rate * ds * 0.5;
      x += Math.sin(mid) * ds;
      z += Math.cos(mid) * ds;
      yaw += rate * ds;
      s += ds;
    }
    xs[k] = x;
    zs[k] = z;
  }
  const tagS: CourseLine['tagS'] = {};
  const tagEndS: CourseLine['tagEndS'] = {};
  let acc = 0;
  for (const seg of SEGMENTS) {
    if (seg.tag) {
      tagS[seg.tag] = acc;
      tagEndS[seg.tag] = acc + seg.len;
    }
    acc += seg.len;
  }
  const zones: ZoneSpan[] = [];
  let si = 0;
  acc = 0;
  for (const [id, count] of ZONE_SEGMENTS) {
    const start = acc;
    for (let i = 0; i < count; i++) acc += SEGMENTS[si++].len;
    zones.push({ id, startS: start, endS: acc });
  }
  return { xs, zs, step, length: (n - 1) * step, zones, tagS, tagEndS };
}
