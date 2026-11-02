import * as THREE from 'three';
import type { VehicleKind } from '../../core/types';
import type { VehicleModel } from '../model';
import type { VehicleParams, VehicleSpec, VehicleState } from '../types';
import { box, buildWheel, C, cyl, groundOffset, paintMaterial, Parts, profile, rbox, sharedMaterials, topStrip, tube, wheelCentreY, type MatKey } from './kit';
import type { Loft } from './loft';
import { LinkRig, type Link } from './rig';

import { addLoft, bump, contrast, doorSeams, handle, mirror, onEnd, pair, plan, roundLamp, shade, V, type BumperEnd, type Ctx, type Design } from './common';
import { DamageFx } from './damageFx';
import { DESIGNS2 } from './designs2';

// =========================================================================== SPORTS
function sports(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [2.0, 0.15],
    { q: [2.17, 0.15, 2.17, 0.32] },
    { q: [2.17, 0.5, 1.9, 0.58] },
    [0.6, 0.78],
    [0.02, 1.09],
    { q: [-0.14, 1.16, -0.38, 1.15] },
    { q: [-0.95, 1.12, -1.38, 0.95] },
    [-2.02, 0.86],
    { q: [-2.17, 0.85, -2.17, 0.68] },
    [-2.15, 0.3],
    { q: [-2.13, 0.15, -1.95, 0.15] },
  ]);
  const base = plan(0.95, 2.17, -2.17, 0.24, 0.1, 1.2, -1.5);
  const loft = addLoft(c, {
    shape,
    belt: 0.8,
    halfWidth: (z) => base(z) + 0.025 * Math.max(0, 1 - Math.abs(z + wz) / 0.7),
    tumble: 0.3,
    shoulder: 0.09,
    crown: 0.06,
    tuck: 0.08,
    windscreen: [0.06, 0.6],
    rearWindow: [-1.36, -0.42],
    sideWindows: [[-1.2, 0.5]],
    arches: [
      [wz, r + 0.03, r + 0.06],
      [-wz, r + 0.03, r + 0.07],
    ],
    stations: [1.9, 0.6, -0.38, -1.38, -2.02],
    step: 0.26,
  });
  // Front: slim headlights, big lower intake, splitter
  pair((s) => onEnd(c, 'lamp', rbox(0.34, 0.07, 0.05, 0, 0, 0, 0.03), loft, s * 0.6, 0.5, 1, C.headlight));
  onEnd(c, 'trim', rbox(1.1, 0.13, 0.05, 0, 0, 0, 0.05), loft, 0, 0.3, 1, C.black);
  bump(c, 'front', 'trim', rbox(1.7, 0.03, 0.2, 0, 0.16, 2.06, 0.01), C.black);
  bump(c, 'front', 'trim', rbox(1.5, 0.08, 0.06, 0, 0.21, 2.12, 0.02), C.black);
  // Rear: thin light bar, diffuser, twin exhausts, wing
  pair((s) => onEnd(c, 'tail', rbox(0.5, 0.06, 0.05, 0, 0, 0, 0.025), loft, s * 0.55, 0.75, -1, C.tail));
  bump(c, 'rear', 'trim', rbox(1.3, 0.14, 0.05, 0, 0, 0, 0.03).applyMatrix4(loft.onEnd(0, 0.27, -1, 0.01)), C.black);
  pair((s) => c.parts.add('chrome', cyl(0.045, 0.14, s * 0.32, 0.26, -2.14, 'z', 8), { color: 0xffffff }));
  c.parts.add('paint', rbox(1.6, 0.035, 0.28, 0, 1.03, -1.98, 0.015), { color: c.paint });
  pair((s) => c.parts.add('trim', box(0.04, 0.16, 0.12, s * 0.55, 0.93, -1.98), { color: C.black }));
  // Side intakes behind the doors
  pair((s) => {
    const z = -0.95;
    const hw = loft.halfWidthAt(z, 0.55);
    c.parts.add('trim', rbox(0.02, 0.14, 0.34, s * (hw + 0.004), 0.55, z, 0.04), { color: C.black });
  });
  mirror(c, loft, 0.42, 0.84, 0.85);
  doorSeams(c, loft, [0.6, -0.75], 0.3, 0.78);
  handle(c, loft, -0.55, 0.7);
  return { wheel: { radius: r, width: 0.27, rim: 0.66, spokes: 5, dish: 0.05, seg: 12 } };
}

// =========================================================================== MUSCLE
function muscle(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [2.22, 0.18],
    { q: [2.36, 0.18, 2.36, 0.34] },
    [2.35, 0.72],
    { q: [2.34, 0.8, 2.22, 0.81] },
    [0.55, 0.88],
    [-0.08, 1.27],
    { q: [-0.18, 1.31, -0.38, 1.3] },
    [-0.98, 1.27],
    [-1.62, 0.95],
    [-2.24, 0.93],
    { q: [-2.36, 0.92, -2.36, 0.8] },
    [-2.36, 0.32],
    { q: [-2.35, 0.18, -2.2, 0.18] },
  ]);
  const loft = addLoft(c, {
    shape,
    belt: 0.9,
    halfWidth: plan(0.975, 2.36, -2.36, 0.08, 0.06, 1.7, -1.8),
    tumble: 0.22,
    shoulder: 0.07,
    crown: 0.04,
    tuck: 0.06,
    windscreen: [-0.06, 0.53],
    rearWindow: [-1.6, -1.0],
    sideWindows: [[-1.42, 0.42]],
    arches: [
      [wz, r + 0.03, r + 0.07],
      [-wz, r + 0.03, r + 0.08],
    ],
    stations: [2.22, 0.55, -0.98, -1.62, -2.24],
    step: 0.26,
  });
  // Racing stripes over hood, roof and boot
  const stripe = contrast(c.paint);
  for (const [x0, x1] of [
    [0.08, 0.24],
    [-0.24, -0.08],
  ]) {
    c.parts.add('paint', topStrip(loft.pts, 2.3, 0.56, x0, x1, 0.008, 0.25), { color: stripe });
    c.parts.add('paint', topStrip(loft.pts, -0.12, -0.97, x0, x1, 0.008, 0.3), { color: stripe });
    c.parts.add('paint', topStrip(loft.pts, -1.66, -2.32, x0, x1, 0.008, 0.3), { color: stripe });
  }
  // Hood scoop
  c.parts.add('paint', rbox(0.5, 0.1, 0.62, 0, 0.9, 1.15, 0.04), { color: stripe });
  c.parts.add('trim', box(0.4, 0.06, 0.02, 0, 0.92, 1.47), { color: C.black });
  // Front: full-width grille with round lamps, chrome bumper
  onEnd(c, 'trim', rbox(1.62, 0.3, 0.05, 0, 0, 0, 0.04), loft, 0, 0.6, 1, 0x1a1a1a, 0.02);
  pair((s) => roundLamp(c, loft, s * 0.66, 0.6, 1, 0.095, C.headlight));
  pair((s) => roundLamp(c, loft, s * 0.43, 0.6, 1, 0.08, C.headlight));
  bump(c, 'front', 'chrome', rbox(1.98, 0.13, 0.16, 0, 0.32, 2.34, 0.05), 0xffffff);
  bump(c, 'rear', 'chrome', rbox(1.98, 0.13, 0.16, 0, 0.34, -2.34, 0.05), 0xffffff);
  // Rear: wide tail lights, ducktail spoiler, twin exhausts
  pair((s) => onEnd(c, 'tail', rbox(0.62, 0.12, 0.05, 0, 0, 0, 0.03), loft, s * 0.5, 0.72, -1, C.tail));
  c.parts.add('paint', rbox(1.7, 0.06, 0.16, 0, 0.97, -2.28, 0.02), { color: c.paint });
  pair((s) => c.parts.add('chrome', cyl(0.05, 0.22, s * 0.55, 0.22, -2.36, 'z', 8), { color: 0xffffff }));
  mirror(c, loft, 0.4, 0.94);
  doorSeams(c, loft, [0.5, -0.95], 0.3, 0.88);
  handle(c, loft, -0.78, 0.8);
  return { wheel: { radius: r, width: 0.3, rim: 0.62, spokes: 5, dish: 0.07, seg: 12, face: 0x3a3d42 } };
}

// =========================================================================== PICKUP
/**
 * The pickup's cab + bed, raised by `lift` (0 for the pickup; the lifted pickup in designs2.ts reuses it).
 * Returns the loft and bed extents so callers can add their own bumpers and extras.
 */
export function pickupBody(c: Ctx, lift = 0): { loft: Loft; L: number; bz0: number; bz1: number; top: number; sill: number } {
  const { r, wz } = c;
  const L = c.spec.size.length / 2;
  const Y = (y: number) => y + lift;
  const sill = Y(0.5);
  const shape = profile([
    [L - 0.1, sill],
    { q: [L, sill, L, sill + 0.15] },
    [L - 0.02, Y(1.13)],
    { q: [L - 0.04, Y(1.2), L - 0.16, Y(1.21)] },
    [1.0, Y(1.28)],
    [0.38, Y(1.75)],
    { q: [0.3, Y(1.8), 0.16, Y(1.8)] },
    [-0.58, Y(1.79)],
    { q: [-0.66, Y(1.78), -0.67, Y(1.7)] },
    [-0.68, sill],
  ]);
  const loft = addLoft(c, {
    shape,
    belt: Y(1.29),
    halfWidth: plan(1.0, L, -0.68, 0.05, 0, 1.8, -0.68),
    tumble: 0.12,
    shoulder: 0.05,
    crown: 0.03,
    tuck: 0.04,
    windscreen: [0.39, 0.98],
    sideWindows: [
      [-0.52, 0.06],
      [0.14, 0.9],
    ],
    pillar: 'black',
    arches: [[wz, r + 0.04, r + 0.09]],
    stations: [L - 0.1, 1.0, 0.16, -0.58],
    step: 0.28,
  });
  // Bed: side walls with wheel arches, floor, front wall, tailgate
  const bz0 = -L;
  const bz1 = -0.72;
  const top = Y(1.29);
  const sideShape = profile([
    [bz1, sill],
    [bz1, top],
    [bz0 + 0.04, top],
    [bz0, top - 0.04],
    [bz0, sill],
    { arch: [-wz, r + 0.04, r + 0.09] },
    [bz1, sill],
  ]);
  pair((s) => {
    const g = new THREE.ExtrudeGeometry(sideShape, { depth: 0.08, bevelEnabled: false, curveSegments: 6 });
    g.translate(0, 0, -0.04).rotateY(-Math.PI / 2).translate(s * 0.96, 0, 0);
    c.parts.add('paint', g, { color: c.paint, crease: 0.5 });
    c.parts.add('trim', box(0.12, 0.03, bz1 - bz0, s * 0.94, top + 0.015, (bz0 + bz1) / 2), { color: C.bedliner });
  });
  c.parts.add('trim', box(1.84, 0.06, bz1 - bz0 - 0.06, 0, Y(0.85), (bz0 + bz1) / 2 + 0.03), { color: C.bedliner });
  c.parts.add('trim', box(1.6, 0.36, bz1 - bz0 - 0.1, 0, Y(0.64), (bz0 + bz1) / 2), { color: C.darkGrey });
  pair((s) => c.parts.add('trim', rbox(0.3, 0.3, 0.9, s * 0.78, Y(0.92), -wz, 0.1), { color: C.bedliner }));
  c.parts.add('paint', rbox(2.0, 0.78, 0.07, 0, sill + 0.4, bz0 + 0.035, 0.03), { color: c.paint });
  c.parts.add('trim', box(1.0, 0.05, 0.02, 0, Y(1.12), bz0 - 0.005), { color: C.black });
  c.parts.add('paint', rbox(1.84, 0.5, 0.06, 0, Y(1.06), bz1 - 0.03, 0.02), { color: c.paint });
  // Cab back window
  c.parts.add('glass', rbox(1.3, 0.32, 0.03, 0, Y(1.52), -0.69, 0.05), { color: 0xffffff });
  // Front: chrome grille with bars, square headlights
  onEnd(c, 'chrome', rbox(1.2, 0.42, 0.05, 0, 0, 0, 0.04), loft, 0, Y(0.92), 1, 0xffffff);
  for (const y of [0.8, 0.92, 1.04]) onEnd(c, 'trim', box(1.08, 0.06, 0.04, 0, 0, 0), loft, 0, Y(y), 1, 0x161616, 0.0);
  pair((s) => onEnd(c, 'lamp', rbox(0.26, 0.2, 0.05, 0, 0, 0, 0.03), loft, s * 0.78, Y(0.98), 1, C.headlight));
  pair((s) => onEnd(c, 'lamp', rbox(0.2, 0.07, 0.04, 0, 0, 0, 0.02), loft, s * 0.8, Y(0.8), 1, C.amber));
  // Rear: tall tail lights on the bed corners
  pair((s) => c.parts.add('tail', rbox(0.1, 0.36, 0.05, s * 0.93, Y(1.02), bz0 - 0.005, 0.02), { color: C.tail }));
  mirror(c, loft, 0.85, Y(1.36), 1.25, C.darkGrey);
  doorSeams(c, loft, [0.92, 0.1, -0.62], Y(0.55), Y(1.27));
  handle(c, loft, -0.02, Y(1.15));
  handle(c, loft, -0.5, Y(1.15));
  return { loft, L, bz0, bz1, top, sill };
}

function pickup(c: Ctx): Design {
  const { r } = c;
  const { L } = pickupBody(c, 0);
  // Chrome bumpers + hitch
  bump(c, 'front', 'chrome', rbox(2.06, 0.2, 0.2, 0, 0.55, L + 0.04, 0.06), 0xffffff);
  bump(c, 'rear', 'chrome', rbox(2.06, 0.16, 0.22, 0, 0.55, -L - 0.06, 0.05), 0xffffff);
  bump(c, 'rear', 'trim', box(0.12, 0.08, 0.2, 0, 0.5, -L - 0.2), C.darkGrey);
  // Roof marker lights (old-school truck charm)
  for (const x of [-0.3, 0, 0.3]) c.parts.add('lamp', rbox(0.1, 0.035, 0.05, x, 1.8, 0.12, 0.015), { color: C.amber });
  // Side steps
  pair((s) => c.parts.add('trim', rbox(0.18, 0.05, 1.1, s * 0.98, 0.42, 0.25, 0.02), { color: C.darkGrey }));
  return { wheel: { radius: r, width: 0.32, rim: 0.6, spokes: 6, lug: 0.018, seg: 12, dish: 0.06, face: 0x50555c } };
}

// =========================================================================== MONSTER
function monster(c: Ctx): Design {
  const { r, wz, wx } = c;
  const yb = 1.42; // body floor height
  const shape = profile([
    [1.92, yb],
    { q: [2.08, yb, 2.08, yb + 0.16] },
    [2.06, 1.94],
    { q: [2.04, 2.0, 1.92, 2.0] },
    [0.9, 2.06],
    [0.38, 2.5],
    { q: [0.3, 2.55, 0.16, 2.55] },
    [-0.52, 2.54],
    { q: [-0.6, 2.53, -0.61, 2.44] },
    [-0.64, 2.1],
    [-1.92, 2.1],
    { q: [-2.02, 2.1, -2.02, 2.0] },
    [-2.02, yb + 0.12],
    { q: [-2.0, yb, -1.88, yb] },
  ]);
  const loft = addLoft(c, {
    shape,
    belt: 2.08,
    halfWidth: plan(0.98, 2.08, -2.02, 0.06, 0.03, 1.5, -1.6),
    tumble: 0.12,
    shoulder: 0.05,
    crown: 0.03,
    windscreen: [0.39, 0.88],
    sideWindows: [[-0.5, 0.82]],
    arches: [
      [wz, r, r + 0.12],
      [-wz, r, r + 0.12],
    ],
    roof: shade(c.paint, 0.55),
    stations: [0.9, 0.16, -0.52, -0.64, -1.92],
    step: 0.28,
  });
  // Tonneau cover over the bed + rear window
  c.parts.add('trim', topStrip(loft.pts, -0.7, -1.95, -0.88, 0.88, 0.01, 0.6), { color: C.bedliner });
  c.parts.add('glass', rbox(1.25, 0.26, 0.03, 0, 2.32, -0.63, 0.05), { color: 0xffffff });
  // Fender flares (black half-hoops over the giant tyres)
  pair((s) => {
    for (const z of [wz, -wz]) {
      const t = new THREE.TorusGeometry(r + 0.14, 0.06, 4, 10, Math.PI);
      t.rotateY(Math.PI / 2).translate(s * (loft.halfWidthAt(z, yb + 0.2) + 0.02), r, z);
      c.parts.add('trim', t, { color: C.black });
    }
  });
  // Side flash
  pair((s) => {
    const hw = loft.halfWidthAt(0, 1.8);
    c.parts.add('paint', box(0.01, 0.1, 1.2, s * (hw + 0.004), 1.86, 0.2), { color: c.accent });
  });
  // Front: grille, headlights, tube bumper; roof light bar
  onEnd(c, 'trim', rbox(1.1, 0.34, 0.05, 0, 0, 0, 0.04), loft, 0, 1.75, 1, 0x161616);
  for (const y of [1.66, 1.75, 1.84]) onEnd(c, 'chrome', box(1.0, 0.03, 0.03, 0, 0, 0), loft, 0, y, 1, 0xffffff, 0.0);
  pair((s) => roundLamp(c, loft, s * 0.72, 1.78, 1, 0.1, C.headlight));
  bump(c, 'front', 'trim', tube(V(-0.95, 1.32, 2.15), V(0.95, 1.32, 2.15), 0.06), C.darkGrey);
  pair((s) => bump(c, 'front', 'trim', tube(V(s * 0.6, 1.32, 2.15), V(s * 0.6, 1.5, 2.0), 0.05), C.darkGrey));
  bump(c, 'rear', 'trim', tube(V(-0.95, 1.4, -2.1), V(0.95, 1.4, -2.1), 0.06), C.darkGrey);
  c.parts.add('trim', rbox(1.3, 0.1, 0.14, 0, 2.62, 0.15, 0.03), { color: C.black });
  for (let i = 0; i < 4; i++) c.parts.add('lamp', cyl(0.06, 0.03, -0.45 + i * 0.3, 2.62, 0.23, 'z', 8), { color: C.headlight });
  pair((s) => c.parts.add('tail', rbox(0.08, 0.3, 0.05, s * 0.9, 1.8, -2.03, 0.02), { color: C.tail }));
  // Chassis: frame rails, skid plate
  pair((s) => c.parts.add('trim', box(0.12, 0.16, 3.9, s * 0.45, 1.3, 0), { color: C.darkGrey }));
  c.parts.add('trim', box(0.9, 0.06, 0.8, 0, 1.2, 1.6, 0.2), { color: C.grey });
  mirror(c, loft, 0.8, 2.12, 1.2, C.black);
  doorSeams(c, loft, [0.86, -0.56], 1.5, 2.06);
  handle(c, loft, -0.36, 1.98);
  // Exposed suspension: twin shocks per wheel + solid axles
  const links: Link[] = [];
  const shock = 0xff8a1a;
  for (let i = 0; i < 4; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    const z = i < 2 ? wz : -wz;
    for (const dz of [0.22, -0.22]) {
      links.push({ a: { fixed: V(s * 0.62, 1.45, z + dz * 1.4) }, b: { wheel: i, offset: V(-s * 0.42, 0.05, dz), noSteer: true }, radius: 0.055, color: shock });
    }
  }
  links.push({ a: { wheel: 0, offset: V(-0.3, 0, 0), noSteer: true }, b: { wheel: 1, offset: V(0.3, 0, 0), noSteer: true }, radius: 0.08, color: C.darkGrey });
  links.push({ a: { wheel: 2, offset: V(-0.3, 0, 0), noSteer: true }, b: { wheel: 3, offset: V(0.3, 0, 0), noSteer: true }, radius: 0.08, color: C.darkGrey });
  void wx;
  return { wheel: { radius: r, width: 0.66, rim: 0.5, spokes: 6, lug: 0.035, seg: 16, dish: 0.16, face: 0x3a3d42 }, links };
}

// =========================================================================== BUGGY
function buggy(c: Ctx): Design {
  const { r, wz } = c;
  const cage = 0x26282b;
  // Wedge nose
  const shape = profile([
    [1.6, 0.6],
    { q: [1.72, 0.6, 1.72, 0.66] },
    [1.64, 0.76],
    [0.32, 0.98],
    [0.22, 0.98],
    [0.22, 0.6],
  ]);
  const loft = addLoft(c, {
    shape,
    belt: 3,
    halfWidth: (z) => 0.48 + 0.24 * Math.min(1, Math.max(0, (1.72 - z) / 1.4)) ** 0.7,
    tumble: 0,
    crown: 0.07,
    tuck: 0.15,
    stations: [0.32, 1.58],
    step: 0.26,
  });
  // Floor pan + side pods
  c.parts.add('trim', box(1.24, 0.07, 1.6, 0, 0.5, -0.5), { color: C.darkGrey });
  pair((s) => {
    const side = profile([
      [0.24, 0.48],
      [0.24, 0.82],
      [-0.2, 0.8],
      [-1.0, 0.66],
      [-1.15, 0.48],
    ]);
    const g = new THREE.ExtrudeGeometry(side, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 2 });
    g.translate(0, 0, -0.03).rotateY(-Math.PI / 2).translate(s * 0.66, 0, 0);
    c.parts.add('paint', g, { color: c.paint, crease: 0.5 });
  });
  // Seats
  pair((s) => {
    c.parts.add('trim', rbox(0.42, 0.12, 0.45, s * 0.29, 0.6, -0.25, 0.05), { color: 0x2f3338 });
    c.parts.add('trim', rbox(0.42, 0.62, 0.1, s * 0.29, 0.92, -0.52, 0.05, -0.18), { color: 0x2f3338 });
    c.parts.add('paint', rbox(0.3, 0.12, 0.11, s * 0.29, 1.15, -0.565, 0.04, -0.18), { color: c.accent });
  });
  // Steering wheel
  const sw = new THREE.TorusGeometry(0.15, 0.025, 4, 10).rotateX(-0.9).translate(0.29, 0.98, 0.18);
  c.parts.add('trim', sw, { color: C.black });
  c.parts.add('trim', tube(V(0.29, 0.98, 0.18), V(0.29, 0.86, 0.45), 0.02, 4), { color: C.black });
  // Roll cage
  const T = (a: THREE.Vector3, b: THREE.Vector3, rad = 0.04) => c.parts.add('trim', tube(a, b, rad, 6), { color: cage });
  const mainTop = 1.5;
  pair((s) => {
    T(V(s * 0.62, 0.52, -0.66), V(s * 0.5, mainTop, -0.72)); // main hoop legs
    T(V(s * 0.62, 0.8, 0.32), V(s * 0.46, mainTop - 0.05, -0.05)); // A-pillars
    T(V(s * 0.46, mainTop - 0.05, -0.05), V(s * 0.5, mainTop, -0.72)); // roof rails
    T(V(s * 0.5, mainTop, -0.72), V(s * 0.42, 0.78, -1.62)); // rear braces
    T(V(s * 0.62, 0.62, 0.3), V(s * 0.62, 0.55, -0.66), 0.035); // side bar
  });
  T(V(-0.5, mainTop, -0.72), V(0.5, mainTop, -0.72));
  T(V(-0.46, mainTop - 0.05, -0.05), V(0.46, mainTop - 0.05, -0.05));
  T(V(-0.5, mainTop, -0.72), V(0.55, 0.62, -0.68), 0.03); // diagonal
  T(V(-0.42, 0.78, -1.62), V(0.42, 0.78, -1.62));
  // Light bar on the cage
  c.parts.add('trim', rbox(0.9, 0.08, 0.1, 0, mainTop + 0.02, -0.02, 0.02), { color: C.black });
  for (let i = 0; i < 4; i++) c.parts.add('lamp', cyl(0.045, 0.03, -0.3 + i * 0.2, mainTop + 0.02, 0.04, 'z', 8), { color: C.headlight });
  // Nose details: headlights, skid plate, number board
  pair((s) => roundLamp(c, loft, s * 0.36, 0.72, 1, 0.07, C.headlight));
  c.parts.add('trim', rbox(0.8, 0.05, 0.6, 0, 0.58, 1.4, 0.02), { color: C.grey });
  bump(c, 'front', 'trim', tube(V(-0.5, 0.62, 1.8), V(0.5, 0.62, 1.8), 0.035), cage);
  pair((s) => bump(c, 'front', 'trim', tube(V(s * 0.5, 0.62, 1.8), V(s * 0.45, 0.7, 1.58), 0.03), cage));
  // Exposed engine (rear)
  c.parts.add('trim', rbox(0.62, 0.36, 0.6, 0, 0.78, -1.15, 0.05), { color: C.engine });
  pair((s) => c.parts.add('trim', rbox(0.2, 0.12, 0.56, s * 0.38, 0.86, -1.15, 0.03, 0), { color: 0x8a1c1c }));
  for (let i = 0; i < 4; i++) c.parts.add('trim', box(0.7, 0.02, 0.04, 0, 0.97, -0.92 - i * 0.14), { color: 0x55595f });
  c.parts.add('chrome', cyl(0.14, 0.12, 0, 1.06, -1.1, 'y', 10), { color: 0xffffff });
  c.parts.add('trim', cyl(0.12, 0.06, 0, 1.15, -1.1, 'y', 10), { color: 0xc93030 });
  pair((s) => {
    c.parts.add('chrome', tube(V(s * 0.3, 0.8, -1.42), V(s * 0.25, 0.92, -1.72), 0.045));
    c.parts.add('chrome', tube(V(s * 0.25, 0.92, -1.72), V(s * 0.22, 1.12, -1.78), 0.045));
  });
  c.parts.add('trim', box(0.6, 0.08, 0.5, 0, 0.56, -1.3), { color: C.darkGrey });
  pair((s) => c.parts.add('tail', rbox(0.08, 0.08, 0.04, s * 0.42, 0.82, -1.65, 0.02), { color: C.tail }));
  // Suspension: A-arms + coil-overs (front), trailing arms + coil-overs (rear)
  const links: Link[] = [];
  const coil = c.accent;
  for (let i = 0; i < 4; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    const front = i < 2;
    const z = front ? wz : -wz;
    if (front) {
      for (const [y, dz] of [
        [0.4, 0.16],
        [0.4, -0.16],
        [0.56, 0.12],
        [0.56, -0.12],
      ]) {
        links.push({ a: { fixed: V(s * 0.36, y, z + dz) }, b: { wheel: i, offset: V(-s * 0.14, y > 0.5 ? 0.1 : -0.06, 0) }, radius: 0.025, color: cage });
      }
    } else {
      links.push({ a: { fixed: V(s * 0.5, 0.58, -0.5) }, b: { wheel: i, offset: V(-s * 0.2, 0, 0), noSteer: true }, radius: 0.04, color: cage });
      links.push({ a: { fixed: V(s * 0.5, 1.02, -1.2) }, b: { wheel: i, offset: V(-s * 0.22, 0.05, 0), noSteer: true }, radius: 0.05, color: coil });
    }
  }
  return {
    wheel: { radius: r * 0.92, width: 0.24, rim: 0.56, spokes: 5, lug: 0.03, seg: 12, dish: 0.06, face: 0x3a3d42 },
    rearWheel: { radius: r, width: 0.4, rim: 0.56, spokes: 5, lug: 0.035, seg: 12, dish: 0.1, face: 0x3a3d42 },
    links,
  };
}

// =========================================================================== SEDAN
function sedan(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [2.2, 0.19],
    { q: [2.3, 0.19, 2.3, 0.3] },
    [2.3, 0.72],
    { q: [2.3, 0.8, 2.2, 0.81] },
    [0.95, 0.86],
    [0.52, 1.39],
    { q: [0.47, 1.43, 0.37, 1.43] },
    [-0.92, 1.42],
    { q: [-0.98, 1.41, -1.02, 1.36] },
    [-1.36, 0.92],
    [-2.2, 0.88],
    { q: [-2.3, 0.88, -2.3, 0.78] },
    [-2.3, 0.3],
    { q: [-2.3, 0.19, -2.2, 0.19] },
  ]);
  const roof = 0xf3ecd8;
  const loft = addLoft(c, {
    shape,
    belt: 0.88,
    halfWidth: plan(0.925, 2.3, -2.3, 0.05, 0.05, 1.8, -1.9),
    tumble: 0.1,
    shoulder: 0.04,
    crown: 0.03,
    tuck: 0.05,
    windscreen: [0.53, 0.93],
    rearWindow: [-1.34, -1.02],
    sideWindows: [
      [-1.2, -0.18],
      [-0.1, 0.86],
    ],
    roof,
    arches: [
      [wz, r + 0.03, r + 0.08],
      [-wz, r + 0.03, r + 0.08],
    ],
    stations: [0.95, 0.37, -0.92, -1.36],
    step: 0.28,
  });
  // Chrome everywhere: bumpers, grille with slats, beltline trim, hood ornament
  bump(c, 'front', 'chrome', rbox(1.98, 0.17, 0.2, 0, 0.36, 2.33, 0.07), 0xffffff);
  bump(c, 'rear', 'chrome', rbox(1.98, 0.17, 0.2, 0, 0.36, -2.33, 0.07), 0xffffff);
  onEnd(c, 'chrome', rbox(0.95, 0.3, 0.05, 0, 0, 0, 0.05), loft, 0, 0.6, 1, 0xffffff);
  for (let i = -3; i <= 3; i++) onEnd(c, 'trim', box(0.03, 0.24, 0.04, 0, 0, 0), loft, i * 0.12, 0.6, 1, 0x222222, 0.0);
  pair((s) => roundLamp(c, loft, s * 0.7, 0.6, 1, 0.11, C.headlight));
  pair((s) => onEnd(c, 'lamp', cyl(0.045, 0.04, 0, 0, 0, 'z', 8), loft, s * 0.7, 0.4, 1, C.amber));
  c.parts.add('chrome', cyl(0.02, 0.1, 0, 0.88, 2.15, 'y', 6, 0.005), { color: 0xffffff });
  pair((s) => {
    for (let z = -2.0; z < 2.0; z += 0.5) {
      const hw = loft.halfWidthAt(z + 0.25, 0.62);
      c.parts.add('chrome', box(0.02, 0.03, 0.5, s * (hw + 0.004), 0.62, z + 0.25), { color: 0xffffff });
    }
  });
  // Rear: tall rounded tail lights
  pair((s) => onEnd(c, 'tail', rbox(0.2, 0.3, 0.05, 0, 0, 0, 0.06), loft, s * 0.74, 0.66, -1, C.tail));
  c.parts.add('chrome', cyl(0.035, 0.1, 0.55, 0.24, -2.33, 'z', 6), { color: 0xffffff });
  mirror(c, loft, 0.84, 0.92, 0.9, 0xd8dde3);
  doorSeams(c, loft, [0.9, -0.14, -1.25], 0.3, 0.86);
  handle(c, loft, -0.32, 0.8);
  handle(c, loft, -1.3, 0.8);
  return { wheel: { radius: r, width: 0.22, rim: 0.6, spokes: 0, hubcap: true, whitewall: true, seg: 12, dish: 0.03, face: 0xd7dbe0 } };
}

const DESIGNS: Record<VehicleKind, (c: Ctx) => Design> = { sports, muscle, pickup, monster, buggy, sedan, ...DESIGNS2 };

/** Accent colour (seat trims, coil springs, side flash) per paint. */
function accentFor(kind: VehicleKind, paint: number): number {
  if (kind === 'buggy') return paint === 0xffeb3b ? 0x1e88e5 : 0xffeb3b;
  if (kind === 'monster') return paint === 0xffb300 ? 0xd62828 : 0xffd54f;
  if (kind === 'rally') return paint === 0xe8501a ? 0x1e5bd8 : 0xffc400;
  if (kind === 'trophy') return paint === 0xf4f4f0 ? 0xe53935 : 0xffc400;
  if (kind === 'atv') return paint === 0x9ccc00 ? 0x2962ff : 0xf4f4f0;
  if (kind === 'van') return paint === 0xf5f5f5 ? 0x1e88e5 : 0xf4f4f0;
  return contrast(paint);
}

const BRAKE_ON = new THREE.Color(C.tail).multiplyScalar(1.7);
const BRAKE_OFF = new THREE.Color(C.tail).multiplyScalar(0.75);

/** Build one end's bumper parts into a pivot group hinged at its +X (left) end, so the right end can drop. */
function bumperPivot(parts: Parts, mats: Record<MatKey, THREE.Material>, paint: number, end: BumperEnd): THREE.Group | null {
  const meshes = parts.build(mats, null, paint);
  if (!meshes.length) return null;
  const box = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!);
  }
  const pivot = new THREE.Group();
  pivot.name = `bumper-${end}`;
  pivot.position.set(box.max.x, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
  for (const m of meshes) {
    m.name = `bumper-${m.name}`;
    m.position.copy(pivot.position).negate();
    pivot.add(m);
  }
  return pivot;
}

/**
 * The ModelBuilder for all sixteen kinds. Plug into createVehicle({ modelBuilder }) (it is the default).
 * Draw calls: paint, glass, trim, chrome, lamp, tail + bumpers (1–2 per end) + 2 per wheel style + 1 suspension
 * rig (+1 cracked-windscreen decal once damaged). Materials are the shared, named PBR ones from kit.ts.
 */
export function buildVehicleModel(spec: VehicleSpec, paint: number, p: VehicleParams): VehicleModel {
  const mats = sharedMaterials();
  const paintMat = paintMaterial();
  paintMat.name = 'vehicle-paint';
  const tailMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: BRAKE_OFF.clone() });
  tailMat.name = 'vehicle-tail';
  const allMats: Record<MatKey, THREE.Material> = { ...mats, paint: paintMat, tail: tailMat };

  const root = new THREE.Group();
  root.name = `vehicle-${spec.kind}`;
  const body = new THREE.Group();
  const g0 = groundOffset(p);
  body.position.y = g0;
  root.add(body);

  const c: Ctx = {
    spec,
    p,
    paint,
    accent: accentFor(spec.kind, paint),
    parts: new Parts(),
    bumpers: { front: new Parts(), rear: new Parts() },
    r: p.wheelRadius,
    rr: p.wheelRadiusRear ?? p.wheelRadius,
    wx: p.wheelX,
    wz: p.wheelZ,
  };
  const design = DESIGNS[spec.kind](c);
  for (const m of c.parts.build(allMats, null, paint)) body.add(m);
  const pivots: Partial<Record<BumperEnd, THREE.Group>> = {};
  for (const end of ['front', 'rear'] as BumperEnd[]) {
    const pv = bumperPivot(c.bumpers[end], allMats, paint, end);
    if (pv) {
      body.add(pv);
      pivots[end] = pv;
    }
  }
  const _w = new THREE.Vector3();
  const damage = new DamageFx(body, pivots, () => {
    // Lowest wheel bottom in world space = the road under the car.
    let y = Infinity;
    for (let i = 0; i < wheels.length; i++) {
      wheels[i].getWorldPosition(_w);
      y = Math.min(y, _w.y - (i < 2 ? p.wheelRadius : (p.wheelRadiusRear ?? p.wheelRadius)));
    }
    return Number.isFinite(y) ? y : 0;
  });

  // Wheels: vehicle positions/rotates each `wheels[i]`; right-side wheels flip so the rim faces out.
  const wheels: THREE.Object3D[] = [];
  const wheelGeos: THREE.BufferGeometry[] = [];
  const styles = [design.wheel, design.rearWheel ?? design.wheel];
  const built = styles.map((st) => buildWheel(st, mats));
  const restY = [0, 1, 2, 3].map((i) => wheelCentreY(p, i >= 2));
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Group();
    const g = built[i < 2 ? 0 : 1].group.clone();
    if (i % 2 === 1) g.rotation.y = Math.PI;
    w.add(g);
    w.position.set(i % 2 === 0 ? p.wheelX : -p.wheelX, restY[i], i < 2 ? p.wheelZ : -p.wheelZ);
    root.add(w);
    wheels.push(w);
  }
  for (const b of built) wheelGeos.push(...b.geos);

  let rig: LinkRig | null = null;
  if (design.links?.length) {
    rig = new LinkRig(design.links, wheels, mats.trim, body);
    root.add(rig.mesh);
    rig.update();
  }

  // Body motion: exaggerate the physics roll/pitch a little from the wheel travel so the
  // suspension reads clearly to a kid (wheels stay put, the body leans and dips).
  let roll = 0;
  let pitch = 0;
  let braking = false;
  const animate = (dt: number, state?: VehicleState): void => {
    const d = (i: number) => wheels[i].position.y - restY[i];
    const left = (d(0) + d(2)) / 2;
    const right = (d(1) + d(3)) / 2;
    const front = (d(0) + d(1)) / 2;
    const rear = (d(2) + d(3)) / 2;
    const k = 1 - Math.exp(-dt * 14);
    const tRoll = THREE.MathUtils.clamp(((left - right) / (2 * p.wheelX)) * 0.6, -0.06, 0.06);
    const tPitch = THREE.MathUtils.clamp(((rear - front) / (2 * p.wheelZ)) * 0.6, -0.05, 0.05);
    roll += (tRoll - roll) * k;
    pitch += (tPitch - pitch) * k;
    body.rotation.set(-pitch, 0, roll);
    rig?.update();
    damage.update(dt, state?.speed ?? 0);
    if (state) {
      const b = state.input.brake > 0.1 && state.speed > 0.3;
      if (b !== braking) {
        braking = b;
        tailMat.color.copy(b ? BRAKE_ON : BRAKE_OFF);
      }
    }
  };

  return {
    root,
    wheels,
    animate,
    applyDamage: (hit, total) => damage.apply(hit, total),
    dispose() {
      damage.dispose();
      paintMat.dispose();
      tailMat.dispose();
      body.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      wheelGeos.forEach((g) => g.dispose());
      rig?.dispose();
    },
  };
}
