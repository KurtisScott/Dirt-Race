import * as THREE from 'three';
import type { TrackPath } from './types';

/**
 * A TrackPath built from a dense list of centre-line points (e.g. sampled from a
 * CatmullRomCurve3). Arc-length parameterised; projection is a local search around
 * `hintS`, falling back to a global search. Reusable by the real track.
 */
export class PolylineTrack implements TrackPath {
  readonly length: number;
  private pts: THREE.Vector3[];
  private cum: number[];
  private widths: number[];

  constructor(
    points: THREE.Vector3[],
    halfWidth: number | number[],
    readonly finishS: number,
    readonly summitS: number,
  ) {
    if (points.length < 2) throw new Error('PolylineTrack needs at least 2 points');
    this.pts = points.map((p) => p.clone());
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + this.pts[i].distanceTo(this.pts[i - 1]));
    this.length = this.cum[this.cum.length - 1];
    this.widths = Array.isArray(halfWidth) ? halfWidth : this.pts.map(() => halfWidth);
  }

  /** Build from control points via a centripetal Catmull-Rom spline, sampled every `step` metres. */
  static fromControlPoints(ctrl: THREE.Vector3[], halfWidth: number, finishS: number, summitS: number, step = 2): PolylineTrack {
    const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
    const n = Math.max(2, Math.ceil(curve.getLength() / step));
    return new PolylineTrack(curve.getSpacedPoints(n), halfWidth, finishS, summitS);
  }

  private segAt(s: number): number {
    s = THREE.MathUtils.clamp(s, 0, this.length);
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  pointAt(s: number, target = new THREE.Vector3()): THREE.Vector3 {
    const i = this.segAt(s);
    const segLen = this.cum[i + 1] - this.cum[i] || 1;
    const t = THREE.MathUtils.clamp((s - this.cum[i]) / segLen, 0, 1);
    return target.lerpVectors(this.pts[i], this.pts[i + 1], t);
  }

  tangentAt(s: number, target = new THREE.Vector3()): THREE.Vector3 {
    const i = this.segAt(s);
    return target.subVectors(this.pts[i + 1], this.pts[i]).normalize();
  }

  halfWidthAt(s: number): number {
    return this.widths[this.segAt(s)];
  }

  project(pos: THREE.Vector3, hintS?: number): { s: number; lateral: number } {
    let from = 0;
    let to = this.pts.length - 2;
    if (hintS !== undefined) {
      const i = this.segAt(hintS);
      from = Math.max(0, i - 25);
      to = Math.min(this.pts.length - 2, i + 25);
    }
    let best = this.searchRange(pos, from, to);
    if (hintS !== undefined && best.d2 > 40 * 40) best = this.searchRange(pos, 0, this.pts.length - 2);
    return { s: best.s, lateral: best.lateral };
  }

  private searchRange(pos: THREE.Vector3, from: number, to: number): { s: number; lateral: number; d2: number } {
    let bestD2 = Infinity;
    let bestS = 0;
    let bestLat = 0;
    for (let i = from; i <= to; i++) {
      const a = this.pts[i];
      const b = this.pts[i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1;
      const t = THREE.MathUtils.clamp(((pos.x - a.x) * abx + (pos.z - a.z) * abz) / len2, 0, 1);
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const dx = pos.x - px;
      const dz = pos.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestS = this.cum[i] + Math.sqrt(len2) * t;
        // Right of travel direction (Y up, right-handed) = cross(tangent, up) = (−tz, 0, tx).
        const len = Math.sqrt(len2);
        bestLat = dx * (-abz / len) + dz * (abx / len);
      }
    }
    return { s: bestS, lateral: bestLat, d2: bestD2 };
  }
}
