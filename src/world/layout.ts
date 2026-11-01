import type { ZoneId } from './types';

/**
 * Course layout: the single place to tune the shape of the real track.
 *
 * The centre-line is built by a "turtle": each segment is a horizontal length (m) and a total heading
 * change (degrees, + = left) spread evenly over that length (so turns are circular arcs). Start at the
 * origin facing +Z. Zones are distance ranges along the centre-line. All distances `s` in the world
 * module are HORIZONTAL metres along the centre-line (the hill is steep, so 3D length would differ).
 */
export interface Segment {
  len: number;
  turn: number;
  /** Marks this segment (used to anchor features: the river loop, the hill). */
  tag?: SegmentTag;
}
export type SegmentTag = 'riverLoop0' | 'riverLoopEnd' | 'ford' | 'finishStraight' | 'hill' | 'rampA' | 'rampB';

/** Bonus hill: horizontal length of the climb (foot → start of summit plateau) and plateau radius. */
export const HILL_CLIMB_M = 150;
export const SUMMIT_PLATEAU_R = 7;
/** Steepest angle of the climb (reached near the top), and the angle at the foot. */
export const HILL_MAX_DEG = 37;
export const HILL_FOOT_DEG = 6;

/**
 * THE finish placement switch (SPEC: "make finish placement a single config value").
 * Metres of road BEFORE the foot of the bonus hill where the finish line sits (0 = right at the foot).
 * The race module's `finishAt: 'hillFoot' | 'summit'` still chooses between this line and the summit.
 */
export const FINISH_BEFORE_HILL_M = 4;

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
  // ---- Desert run (sand dunes): a long sweeping U-turn back towards the start
  { len: 150, turn: 95 },
  { len: 120, turn: 0 },
  { len: 160, turn: 85 },
  // ---- River crossing: an Ω-loop out to the shallow ford and back; the log bridge cuts straight across.
  { len: 40, turn: 0, tag: 'riverLoop0' },
  { len: 42, turn: -90 },
  { len: 14, turn: 0 },
  { len: 42, turn: 90 },
  { len: 46, turn: 0, tag: 'ford' },
  { len: 42, turn: 90 },
  { len: 14, turn: 0 },
  { len: 42, turn: -90, tag: 'riverLoopEnd' },
  // ---- Run-in to the finish line at the foot of the bonus hill
  { len: 130, turn: 0, tag: 'finishStraight' },
  // ---- Bonus hill (straight up) + summit plateau (flag in its middle)
  { len: HILL_CLIMB_M + SUMMIT_PLATEAU_R * 2, turn: 0, tag: 'hill' },
];

/** How many segments belong to each zone, in order. */
const ZONE_SEGMENTS: [ZoneId, number][] = [
  ['town', 4],
  ['farm', 5],
  ['mud', 1],
  ['rocky', 5],
  ['desert', 3],
  ['river', 8],
  ['finish', 1],
  ['hill', 1],
];

/** Road half-width per zone (m). */
export const ROAD_HALF_WIDTH: Record<ZoneId, number> = {
  town: 7,
  farm: 5.5,
  mud: 6.5,
  rocky: 6,
  desert: 6.5,
  river: 6,
  finish: 7,
  hill: 6,
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
