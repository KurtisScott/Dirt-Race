import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MatKey } from './kit';

/**
 * Lofted car body. A side profile (z, y) gives top and bottom heights per station; a plan-width function
 * gives the half width; each station gets a 9-point half cross-section:
 *
 *        8 ──── 7          roof centre / roof edge (crown)
 *                \
 *                 6        window top (tumblehome leans in)
 *                 |
 *                 5        window base, just inboard of the shoulder
 *            4 ──┘         shoulder (beltline)
 *            3
 *            |             body side
 *            2
 *       0 ── 1             underbody / sill tuck
 *
 * Quad bands between rows are assigned a material per station interval: bottom → trim,
 * band 5 → side glass inside window ranges, band 7 → windscreen / rear-window glass.
 * Over the hood and boot (top below the beltline) rows 5–8 fold flat into a gently crowned panel.
 */
export interface LoftSpec {
  shape: THREE.Shape;
  /** Beltline height (bottom of the side windows). */
  belt: number;
  halfWidth: (z: number) => number;
  /** Fraction the cabin narrows from window base to window top. */
  tumble: number;
  /** Inward step of the greenhouse from the shoulder, metres. */
  shoulder?: number;
  /** Sill tuck-under fraction and height. */
  tuck?: number;
  tuckH?: number;
  /** Hood/boot crown height. */
  crown?: number;
  /** Glass ranges (z0 < z1). */
  windscreen?: [number, number];
  rearWindow?: [number, number];
  sideWindows?: [number, number][];
  /** Colour of the band-5 pillars between side windows. */
  pillar?: 'paint' | 'black';
  paint: number;
  /** Optional roof colour (two-tone) for bands 6–7 above the windows. */
  roof?: number;
  /** Wheel arches cut into the bottom: [zc, yc, radius]. Fenders bulge over them on the hood/boot edges. */
  arches?: [number, number, number][];
  /** Extra stations to place exactly (feature edges). */
  stations?: number[];
  step?: number;
}

type Sec = [number, number][]; // 9 half-section points (x ≥ 0, y)

const ROWS = 9;

export class Loft {
  readonly pts: THREE.Vector2[];
  readonly zMin: number;
  readonly zMax: number;
  constructor(readonly spec: LoftSpec) {
    this.pts = spec.shape.extractPoints(10).shape;
    let a = Infinity;
    let b = -Infinity;
    for (const p of this.pts) {
      a = Math.min(a, p.x);
      b = Math.max(b, p.x);
    }
    this.zMin = a;
    this.zMax = b;
  }

  /** [bottom, top] of the side profile at z. */
  span(z: number): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    const P = this.pts;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      const q = P[(i + 1) % P.length];
      if (p.x === q.x || (p.x - z) * (q.x - z) > 0) continue;
      const y = p.y + ((z - p.x) / (q.x - p.x)) * (q.y - p.y);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    return [lo, hi];
  }

  /** Greenhouse blend 0 (hood) → 1 (full cabin) at z. */
  cabinBlend(z: number): number {
    const [, yt] = this.span(z);
    return Math.min(1, Math.max(0, (yt - this.spec.belt) / 0.1));
  }

  /** Arch-raised bottom at z (−Infinity outside arches). */
  archBottom(z: number): number {
    let y = -Infinity;
    for (const [zc, yc, r] of this.spec.arches ?? []) {
      const d = Math.abs(z - zc);
      if (d <= r) y = Math.max(y, yc + Math.sqrt(r * r - d * d));
    }
    return y;
  }

  /** Fender crest height over the arches (−Infinity away from them). */
  fender(z: number): number {
    let y = -Infinity;
    for (const [zc, yc, r] of this.spec.arches ?? []) {
      const R = r + 0.16;
      const d = Math.abs(z - zc);
      if (d < R) y = Math.max(y, yc + Math.sqrt(R * R - d * d) - 0.07);
    }
    return y;
  }

  section(z: number): Sec {
    const s = this.spec;
    const [ybRaw, yt] = this.span(z);
    const yb = Math.min(Math.max(ybRaw, this.archBottom(z)), yt - 0.06);
    const hw = Math.max(0.02, s.halfWidth(z));
    const tuck = s.tuck ?? 0.06;
    const crown = s.crown ?? 0.045;
    // Edge (shoulder) height of the hood/boot: crowned below the centre, or raised by a fender bulge.
    const ye = Math.max(yt - crown, Math.min(this.fender(z), s.belt + 0.02, yt + 0.035));
    const h = Math.max(0.02, Math.min(ye, s.belt) - yb);
    const th = Math.min(s.tuckH ?? 0.16, h * 0.3);
    const bev = Math.min(0.05, h * 0.2);
    const hood: Sec = [
      [0, yb],
      [hw * (1 - tuck), yb],
      [hw, yb + th],
      [hw, Math.max(yb + th + 0.005, ye - bev)],
      [hw - bev * 0.6, ye],
      [hw * 0.8, yt + (ye - yt) * 0.55],
      [hw * 0.55, yt + (ye - yt) * 0.22],
      [hw * 0.28, yt + (ye - yt) * 0.05],
      [0, yt],
    ];
    const g = Math.min(1, Math.max(0, (yt - s.belt) / 0.1));
    if (g <= 0) return hood;
    const gh = Math.max(0.001, yt - s.belt);
    const hwg = hw - (s.shoulder ?? 0.05);
    const xTop = hwg * (1 - s.tumble);
    const hb = Math.max(0.02, s.belt - yb);
    const thb = Math.min(s.tuckH ?? 0.16, hb * 0.3);
    const bevb = Math.min(0.05, hb * 0.2);
    const cab: Sec = [
      [0, yb],
      [hw * (1 - tuck), yb],
      [hw, yb + thb],
      [hw, s.belt - bevb],
      [hw - bevb * 0.6, s.belt],
      [hwg, s.belt + Math.min(0.015, gh * 0.1)],
      [xTop, yt - Math.min(0.09, gh * 0.28)],
      [Math.max(0.02, xTop - Math.min(0.07, gh * 0.4)), yt - Math.min(0.03, gh * 0.12)],
      [0, yt],
    ];
    if (g >= 1) return cab;
    return hood.map((p, i) => [p[0] + (cab[i][0] - p[0]) * g, p[1] + (cab[i][1] - p[1]) * g]) as Sec;
  }

  /** Half width of the body at height y in the section at z (0 if outside). */
  halfWidthAt(z: number, y: number): number {
    const sec = this.section(z);
    let best = 0;
    for (let i = 0; i < ROWS - 1; i++) {
      const [x0, y0] = sec[i];
      const [x1, y1] = sec[i + 1];
      if ((y0 - y) * (y1 - y) > 0) continue;
      const x = y0 === y1 ? Math.max(x0, x1) : x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
      best = Math.max(best, x);
    }
    return best;
  }

  /** Top surface height at (x, z) (upper chain, rows 3..8). */
  topAt(x: number, z: number): number {
    const sec = this.section(z);
    const ax = Math.abs(x);
    for (let i = 8; i > 3; i--) {
      const [x0, y0] = sec[i];
      const [x1, y1] = sec[i - 1];
      if (ax >= x0 && ax <= x1) return y0 + ((ax - x0) / Math.max(1e-6, x1 - x0)) * (y1 - y0);
    }
    return sec[3][1];
  }

  /** z of the front-most (dir 1) or rear-most (dir −1) body surface at (x, y). */
  endAt(x: number, y: number, dir: 1 | -1): number {
    const ax = Math.abs(x);
    const from = dir === 1 ? this.zMax : this.zMin;
    for (let d = 0.002; d < this.zMax - this.zMin; d += 0.008) {
      const z = from - dir * d;
      const [yb, yt] = this.span(z);
      if (y >= yb && y <= yt && ax <= this.halfWidthAt(z, y)) return z;
    }
    return from;
  }

  /**
   * Matrix placing a part on the nose (dir 1) or tail (dir −1) surface at (x, y), aligned to the
   * surface slope, with its local +Z pointing out of the body. `sink` pushes it into the surface.
   */
  onEnd(x: number, y: number, dir: 1 | -1, sink = 0.01): THREE.Matrix4 {
    const z = this.endAt(x, y, dir);
    const e = 0.03;
    const dzdy = (this.endAt(x, y + e, dir) - this.endAt(x, y - e, dir)) / (2 * e);
    const dzdx = (this.endAt(x + e, y, dir) - this.endAt(x - e, y, dir)) / (2 * e);
    const out = new THREE.Vector3(dir === 1 ? -dzdx : dzdx, -dzdy * dir, dir).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), out);
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z).addScaledVector(out, -sink), q, new THREE.Vector3(1, 1, 1));
  }

  /** Station list: dense near the ends, plus feature edges. */
  stations(): number[] {
    const s = this.spec;
    const L = this.zMax - this.zMin;
    const n = Math.max(12, Math.round(L / (s.step ?? 0.16)));
    const keys = [...(s.stations ?? [])];
    for (const r of [s.windscreen, s.rearWindow, ...(s.sideWindows ?? [])]) if (r) keys.push(r[0], r[1]);
    const zs: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 0.5 * t + 0.5 * (0.5 - 0.5 * Math.cos(Math.PI * t));
      zs.push(this.zMin + 0.004 + (L - 0.008) * u);
    }
    const archKeys = (s.arches ?? []).flatMap(([zc, , r]) => [zc - r, zc + r]);
    const out = zs.filter((z, i) => i === 0 || i === zs.length - 1 || [...keys, ...archKeys].every((k) => Math.abs(k - z) > 0.05));
    for (const k of keys) if (k > this.zMin + 0.01 && k < this.zMax - 0.01) out.push(k);
    // Arches: a station just outside each edge and a few across the curve.
    for (const [zc, , r] of s.arches ?? []) {
      out.push(zc - r - 0.003, zc + r + 0.003);
      for (let k = 1; k < 4; k++) out.push(zc + r * Math.cos(Math.PI - (Math.PI * k) / 4));
    }
    const lo = this.zMin + 0.004;
    const hi = this.zMax - 0.004;
    const ok = out.filter((z) => z >= lo && z <= hi && Number.isFinite(this.span(z)[0])).sort((a, b) => a - b);
    return ok.filter((z, i) => i === 0 || z - ok[i - 1] > 0.002);
  }

  /** Build geometries per material (non-indexed, with vertex colours, creased normals). */
  build(): Partial<Record<MatKey, THREE.BufferGeometry>> {
    const s = this.spec;
    const zs = this.stations();
    const secs = zs.map((z) => this.section(z));
    const blend = zs.map((z) => this.cabinBlend(z));
    const buf: Partial<Record<MatKey, { p: number[]; c: number[] }>> = {};
    const col = new THREE.Color();
    const tri = (key: MatKey, hex: number, a: number[], b: number[], c: number[]) => {
      const B = (buf[key] ??= { p: [], c: [] });
      B.p.push(...a, ...b, ...c);
      col.setHex(hex);
      for (let i = 0; i < 3; i++) B.c.push(col.r, col.g, col.b);
    };
    const inR = (r: [number, number] | undefined, z: number) => !!r && z > r[0] && z < r[1];
    const roofCol = s.roof ?? s.paint;
    for (let i = 0; i < zs.length - 1; i++) {
      const z0 = zs[i];
      const z1 = zs[i + 1];
      const zm = (z0 + z1) / 2;
      const cab = Math.min(blend[i], blend[i + 1]);
      const sideGlass = (s.sideWindows ?? []).some((r) => inR(r, zm));
      const betweenWindows = !sideGlass && (s.sideWindows ?? []).some((r) => zm > r[1]) && (s.sideWindows ?? []).some((r) => zm < r[0]);
      for (let r = 0; r < ROWS - 1; r++) {
        let key: MatKey = 'paint';
        let hex = s.paint;
        if (r === 0) {
          key = 'trim';
          hex = 0x1a1a1a;
        } else if (r === 5 && cab > 0.3) {
          if (sideGlass) key = 'glass';
          else if (betweenWindows && s.pillar === 'black') {
            key = 'trim';
            hex = 0x151515;
          } else hex = roofCol;
        } else if (r === 7 && (inR(s.windscreen, zm) || inR(s.rearWindow, zm))) key = 'glass';
        else if ((r === 6 || r === 7) && cab > 0.9) hex = roofCol;
        for (const side of [1, -1]) {
          const a = secs[i][r];
          const b = secs[i][r + 1];
          const c = secs[i + 1][r];
          const d = secs[i + 1][r + 1];
          const A = [a[0] * side, a[1], z0];
          const Bv = [b[0] * side, b[1], z0];
          const Cv = [c[0] * side, c[1], z1];
          const D = [d[0] * side, d[1], z1];
          // Outward winding (rows go bottom → top, stations go rear → front).
          if (side === -1) {
            tri(key, hex, A, Cv, Bv);
            tri(key, hex, Bv, Cv, D);
          } else {
            tri(key, hex, A, Bv, Cv);
            tri(key, hex, Bv, D, Cv);
          }
        }
      }
    }
    // End caps (fan from the section centroid).
    for (const [idx, dir] of [
      [0, -1],
      [zs.length - 1, 1],
    ] as const) {
      const sec = secs[idx];
      const z = zs[idx];
      const ring: number[][] = [];
      for (let r = 0; r < ROWS; r++) ring.push([sec[r][0], sec[r][1], z]);
      for (let r = ROWS - 2; r >= 1; r--) ring.push([-sec[r][0], sec[r][1], z]);
      const cy = (sec[0][1] + sec[8][1]) / 2;
      const ctr = [0, cy, z];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        if (dir === 1) tri('paint', s.paint, ctr, a, b);
        else tri('paint', s.paint, ctr, b, a);
      }
    }
    const out: Partial<Record<MatKey, THREE.BufferGeometry>> = {};
    for (const k of Object.keys(buf) as MatKey[]) {
      const B = buf[k]!;
      let g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.c, 3));
      g = toCreasedNormals(g, k === 'glass' ? 0.35 : 0.75);
      out[k] = g;
    }
    return out;
  }
}
