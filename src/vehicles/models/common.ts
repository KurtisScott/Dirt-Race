import * as THREE from 'three';
import type { VehicleParams, VehicleSpec } from '../types';
import { box, C, cyl, extrudeX, Parts, rbox, type MatKey, type WheelStyle } from './kit';
import { Loft, type LoftSpec } from './loft';
import type { Link } from './rig';

/**
 * Shared helpers for the per-kind vehicle designs (build.ts: the original six; designs2.ts: Round 2's ten).
 * Everything is built in "ground space" (y = 0 under the car at rest, +Z forward, +X left).
 */

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export type BumperEnd = 'front' | 'rear';

export interface Ctx {
  spec: VehicleSpec;
  p: VehicleParams;
  paint: number;
  accent: number;
  parts: Parts;
  /** Bumper parts per end: built as separate pivots so damage can make them hang and fall off. */
  bumpers: Record<BumperEnd, Parts>;
  /** Front wheel centre height in ground space at rest (= front wheel radius). */
  r: number;
  /** Rear wheel radius (= r unless the rear wheels are bigger, e.g. the tractor). */
  rr: number;
  wx: number;
  wz: number;
}

export interface Design {
  wheel: WheelStyle;
  /** Optional rear wheel style (buggy: fatter rears; tractor: giant rears). */
  rearWheel?: WheelStyle;
  links?: Link[];
}

/** Add a bumper part (front or rear). */
export function bump(c: Ctx, end: BumperEnd, key: MatKey, geo: THREE.BufferGeometry, color: number): void {
  c.bumpers[end].add(key, geo, { color });
}

/** Arch-shaped fender flare over a wheel: a band of thickness `t` around radius `R`, `w` wide across X, centred at x. */
export function flare(c: Ctx, x: number, zc: number, yc: number, R: number, t: number, w: number, color: number, key: MatKey = 'trim', spread = 0.12): void {
  const s = new THREE.Shape();
  s.absarc(zc, yc, R + t, -spread, Math.PI + spread, false);
  s.absarc(zc, yc, R, Math.PI + spread, -spread, true);
  s.closePath();
  c.parts.add(key, extrudeX(s, w, Math.min(0.02, t * 0.3), 10, 1).translate(x, 0, 0), { color, crease: 0.5 });
}

/** A spare tyre (tyre + rim face + hub) as body parts, axis along `axis`. */
export function spareTyre(c: Ctx, x: number, y: number, z: number, R: number, w: number, axis: 'x' | 'y' | 'z', face = C.darkGrey): void {
  c.parts.add('trim', cyl(R, w, x, y, z, axis, 14), { color: C.rubber, crease: 1.2 });
  const o = w / 2 + 0.004;
  const off = (d: number) => (axis === 'x' ? [x + d, y, z] : axis === 'y' ? [x, y + d, z] : [x, y, z + d]);
  for (const sgn of [1, -1]) {
    const [px, py, pz] = off(sgn * o);
    c.parts.add('trim', cyl(R * 0.6, 0.01, px, py, pz, axis, 12), { color: face });
    const [hx, hy, hz] = off(sgn * (o + 0.01));
    c.parts.add('chrome', cyl(R * 0.15, 0.02, hx, hy, hz, axis, 8), { color: 0xffffff });
  }
}

/** Box-ish lamp (a rounded lens with a dark bezel) on a flat face pointing along ±Z. */
export function flatLamp(c: Ctx, x: number, y: number, z: number, w: number, h: number, dir: 1 | -1, color: number, key: MatKey = 'lamp'): void {
  c.parts.add('trim', rbox(w + 0.04, h + 0.04, 0.04, x, y, z + dir * 0.005, 0.02), { color: C.black });
  c.parts.add(key, rbox(w, h, 0.04, x, y, z + dir * 0.02, 0.02), { color });
}

/** Round spot lamp (lens + chrome-free dark housing) facing +Z, at any point. */
export function spotLamp(c: Ctx, x: number, y: number, z: number, rad: number, color: number = C.headlight): void {
  c.parts.add('trim', cyl(rad * 1.18, 0.1, x, y, z - 0.03, 'z', 10, rad * 0.9), { color: C.black });
  c.parts.add('lamp', cyl(rad, 0.03, x, y, z + 0.03, 'z', 10), { color });
}

/** Window pane (glass) on a flat side of a box body at x = ±hx (s = side). */
export function sidePane(c: Ctx, s: 1 | -1, hx: number, y0: number, y1: number, z0: number, z1: number): void {
  c.parts.add('glass', rbox(0.03, y1 - y0, z1 - z0, s * (hx + 0.006), (y0 + y1) / 2, (z0 + z1) / 2, 0.03), { color: 0xffffff });
}

void box;




/** Lightness-aware contrast colour for stripes etc. */
export function contrast(hex: number): number {
  const c = new THREE.Color(hex);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return l > 0.35 ? 0x161616 : 0xf4f4f0;
}

export function shade(hex: number, k: number): number {
  return new THREE.Color(hex).multiplyScalar(k).getHex();
}

/** Tapered plan-view half width. */
export function plan(hw: number, front: number, rear: number, noseT: number, tailT: number, noseStart: number, tailStart: number) {
  return (z: number) => {
    let f = 1;
    if (z > noseStart) f -= noseT * ((z - noseStart) / (front - noseStart)) ** 2;
    if (z < tailStart) f -= tailT * ((tailStart - z) / (tailStart - rear)) ** 2;
    return hw * f;
  };
}

export function addLoft(c: Ctx, spec: Omit<LoftSpec, 'paint'>): Loft {
  const loft = new Loft({ ...spec, paint: c.paint });
  const geos = loft.build();
  for (const k of Object.keys(geos) as MatKey[]) c.parts.addRaw(k, geos[k]!);
  return loft;
}

/** Add a part placed on the nose/tail surface of a loft (local +Z = outward). */
export function onEnd(c: Ctx, key: MatKey, geo: THREE.BufferGeometry, loft: Loft, x: number, y: number, dir: 1 | -1, color: number, sink = 0.01) {
  const m = loft.onEnd(x, y, dir, sink);
  c.parts.add(key, geo.applyMatrix4(m), { color });
}

/** Mirrored pair helper. */
export function pair(fn: (s: 1 | -1) => void) {
  fn(1);
  fn(-1);
}

export function roundLamp(c: Ctx, loft: Loft, x: number, y: number, dir: 1 | -1, rad: number, color: number, key: MatKey = 'lamp', ring = true) {
  onEnd(c, key, cyl(rad, 0.05, 0, 0, 0.0, 'z', 10), loft, x, y, dir, color, -0.012);
  if (ring) onEnd(c, 'chrome', cyl(rad * 1.22, 0.04, 0, 0, -0.01, 'z', 10), loft, x, y, dir, 0xffffff, -0.012);
}

export function mirror(c: Ctx, loft: Loft, z: number, y: number, size = 1, color = c.paint) {
  pair((s) => {
    const hw = loft.halfWidthAt(z, y - 0.02);
    c.parts.add('paint', rbox(0.1 * size, 0.1 * size, 0.16 * size, s * (hw + 0.09 * size), y + 0.03, z, 0.025), { color });
    c.parts.add('trim', box(0.08, 0.025, 0.06, s * (hw + 0.03), y, z), { color: C.black });
  });
}

export function doorSeams(c: Ctx, loft: Loft, zs: number[], y0: number, y1: number) {
  pair((s) => {
    for (const z of zs) {
      const hw = loft.halfWidthAt(z, (y0 + y1) / 2);
      c.parts.add('trim', box(0.006, y1 - y0, 0.012, s * (hw + 0.002), (y0 + y1) / 2, z), { color: 0x101010 });
    }
  });
}

export function handle(c: Ctx, loft: Loft, z: number, y: number) {
  pair((s) => {
    const hw = loft.halfWidthAt(z, y);
    c.parts.add('chrome', box(0.02, 0.03, 0.14, s * (hw + 0.006), y, z), { color: 0xffffff });
  });
}