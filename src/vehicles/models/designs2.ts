import * as THREE from 'three';
import type { VehicleKind } from '../../core/types';
import { addLoft, bump, doorSeams, flare, flatLamp, handle, mirror, onEnd, pair, plan, roundLamp, shade, sidePane, spareTyre, spotLamp, V, type Ctx, type Design } from './common';
import { box, C, cyl, extrudeX, profile, rbox, tube } from './kit';
import type { Link } from './rig';
import { pickupBody } from './build';

/**
 * Round 2 vehicles (SPEC item 6): ten more procedural models, each with its own silhouette. Same ground-space
 * conventions and shared materials as build.ts (y = 0 under the car, +Z forward, +X left).
 */

/** Smooth bump of height `h` around |z| = zc (fender bulge over the wheels in plan view). */
const archBulge = (z: number, zc: number, h: number, span: number) => h * Math.max(0, 1 - ((Math.abs(z) - zc) / span) ** 2);

/** A stripe that follows the body side at height y between z0..z1 (segments hug the loft). */
function sideStripe(c: Ctx, loft: { halfWidthAt(z: number, y: number): number }, y: number, h: number, z0: number, z1: number, color: number, seg = 0.4, off = 0.006): void {
  pair((s) => {
    for (let z = z0; z < z1 - 1e-3; z += seg) {
      const zz = Math.min(z1, z + seg);
      const hw = loft.halfWidthAt((z + zz) / 2, y);
      if (hw <= 0.05) continue;
      c.parts.add('paint', box(0.012, h, zz - z + 0.01, s * (hw + off), y, (z + zz) / 2), { color });
    }
  });
}

/** Racing roundel with a "7" on each door. */
function roundel(c: Ctx, loft: { halfWidthAt(z: number, y: number): number }, z: number, y: number, rad: number): void {
  pair((s) => {
    const hw = loft.halfWidthAt(z, y);
    c.parts.add('paint', cyl(rad, 0.012, s * (hw + 0.012), y, z, 'x', 16), { color: C.white });
    c.parts.add('trim', box(0.006, rad * 0.16, rad * 0.8, s * (hw + 0.02), y + rad * 0.45, z), { color: C.black });
    c.parts.add('trim', box(0.006, rad * 1.05, rad * 0.17, s * (hw + 0.02), y - rad * 0.1, z - s * 0, 0.45 * s, 0, 0), { color: C.black });
  });
}

// =========================================================================== RALLY
function rally(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [1.93, 0.3],
    { q: [2.07, 0.3, 2.07, 0.44] },
    [2.05, 0.68],
    { q: [2.03, 0.78, 1.9, 0.79] },
    [0.78, 0.93],
    [0.08, 1.37],
    { q: [-0.02, 1.42, -0.18, 1.42] },
    [-1.42, 1.39],
    { q: [-1.58, 1.38, -1.66, 1.28] },
    [-1.98, 0.95],
    { q: [-2.06, 0.88, -2.06, 0.76] },
    [-2.06, 0.44],
    { q: [-2.05, 0.3, -1.92, 0.3] },
  ]);
  const base = plan(0.85, 2.07, -2.06, 0.13, 0.1, 1.5, -1.6);
  const loft = addLoft(c, {
    shape,
    belt: 0.95,
    halfWidth: (z) => base(z) + archBulge(z, wz, 0.07, 0.75),
    tumble: 0.2,
    shoulder: 0.07,
    crown: 0.05,
    tuck: 0.06,
    windscreen: [0.1, 0.76],
    rearWindow: [-1.95, -1.64],
    sideWindows: [
      [-1.4, -0.72],
      [-0.64, 0.66],
    ],
    pillar: 'black',
    arches: [
      [wz, r + 0.05, r + 0.1],
      [-wz, r + 0.05, r + 0.1],
    ],
    stations: [1.93, 0.78, -0.18, -1.42, -1.66, -1.98],
    step: 0.24,
  });
  // Front: grille, headlights, light pod with four spots, skid plate + lip (bumper)
  onEnd(c, 'trim', rbox(0.95, 0.2, 0.05, 0, 0, 0, 0.04), loft, 0, 0.58, 1, 0x1a1a1a);
  pair((s) => onEnd(c, 'lamp', rbox(0.32, 0.12, 0.05, 0, 0, 0, 0.04), loft, s * 0.58, 0.66, 1, C.headlight));
  c.parts.add('trim', rbox(1.3, 0.06, 0.08, 0, 0.5, 2.08, 0.02), { color: C.black });
  for (const x of [-0.5, -0.17, 0.17, 0.5]) spotLamp(c, x, 0.6, 2.12, 0.085);
  bump(c, 'front', 'trim', rbox(1.72, 0.14, 0.2, 0, 0.36, 1.98, 0.04), C.black);
  bump(c, 'front', 'trim', rbox(1.1, 0.04, 0.55, 0, 0.27, 1.78, 0.02), C.grey);
  bump(c, 'front', 'paint', rbox(0.08, 0.06, 0.08, 0.6, 0.36, 2.1, 0.02), 0xd62828);
  // Hood vents, roof scoop, antenna
  pair((s) => c.parts.add('trim', rbox(0.3, 0.02, 0.32, s * 0.3, loft.topAt(0.3, 1.25) + 0.008, 1.25, 0.01), { color: C.black }));
  c.parts.add('paint', rbox(0.42, 0.09, 0.4, 0, 1.45, -0.3, 0.04), { color: c.paint });
  c.parts.add('trim', box(0.36, 0.06, 0.02, 0, 1.44, -0.09), { color: C.black });
  c.parts.add('trim', cyl(0.008, 0.45, 0.3, 1.62, -1.1, 'y', 4), { color: C.black });
  // Big rear wing on the hatch
  c.parts.add('paint', rbox(1.65, 0.04, 0.34, 0, 1.52, -1.74, 0.015), { color: c.accent });
  pair((s) => {
    c.parts.add('paint', rbox(0.03, 0.2, 0.4, s * 0.82, 1.48, -1.74, 0.01), { color: c.paint });
    c.parts.add('trim', box(0.04, 0.3, 0.07, s * 0.4, 1.37, -1.72), { color: C.black });
  });
  // Livery: two stripes + door roundels
  sideStripe(c, loft, 0.62, 0.09, -1.95, 1.95, c.accent);
  sideStripe(c, loft, 0.5, 0.04, -1.95, 1.95, shade(c.accent, 0.7));
  roundel(c, loft, -0.15, 0.7, 0.19);
  // Mudflaps behind each wheel
  pair((s) => {
    for (const z of [wz - r - 0.12, -wz - r - 0.12]) c.parts.add('trim', box(0.28, 0.3, 0.015, s * 0.7, 0.26, z), { color: c.accent === 0xffc400 ? 0xd62828 : 0xffc400 });
  });
  // Rear: tail lights, exhaust, bumper
  pair((s) => onEnd(c, 'tail', rbox(0.26, 0.14, 0.05, 0, 0, 0, 0.03), loft, s * 0.64, 0.72, -1, C.tail));
  c.parts.add('chrome', cyl(0.065, 0.2, -0.5, 0.36, -2.08, 'z', 10), { color: 0xffffff });
  bump(c, 'rear', 'trim', rbox(1.72, 0.16, 0.16, 0, 0.42, -2.03, 0.04), C.black);
  bump(c, 'rear', 'paint', rbox(0.08, 0.06, 0.08, 0.55, 0.36, -2.13, 0.02), 0xd62828);
  mirror(c, loft, 0.62, 0.99, 0.9);
  doorSeams(c, loft, [0.72, -0.68], 0.34, 0.93);
  handle(c, loft, -0.45, 0.86);
  return { wheel: { radius: r, width: 0.25, rim: 0.62, spokes: 6, lug: 0.012, seg: 12, dish: 0.05, face: 0xeeeeee } };
}

// =========================================================================== HOT HATCH
function hatch(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [1.85, 0.2],
    { q: [1.97, 0.2, 1.97, 0.34] },
    [1.95, 0.64],
    { q: [1.93, 0.74, 1.8, 0.76] },
    [0.85, 0.9],
    [0.15, 1.38],
    { q: [0.05, 1.44, -0.1, 1.44] },
    [-1.2, 1.41],
    { q: [-1.36, 1.4, -1.46, 1.3] },
    [-1.9, 0.98],
    { q: [-1.96, 0.92, -1.96, 0.82] },
    [-1.96, 0.6],
    { q: [-1.96, 0.21, -1.84, 0.2] },
  ]);
  const base = plan(0.88, 1.97, -1.96, 0.12, 0.08, 1.3, -1.5);
  const roof = 0x1a1a1a;
  const loft = addLoft(c, {
    shape,
    belt: 0.92,
    halfWidth: (z) => base(z) + archBulge(z, wz, 0.035, 0.6),
    tumble: 0.17,
    shoulder: 0.07,
    crown: 0.04,
    tuck: 0.06,
    windscreen: [0.17, 0.82],
    rearWindow: [-1.84, -1.42],
    sideWindows: [
      [-1.16, -0.62],
      [-0.54, 0.76],
    ],
    pillar: 'black',
    roof,
    arches: [
      [wz, r + 0.03, r + 0.07],
      [-wz, r + 0.03, r + 0.07],
    ],
    stations: [1.85, 0.85, -0.1, -1.2, -1.46, -1.9],
    step: 0.24,
  });
  const red = c.paint === 0xe53935 ? 0xf4f4f0 : 0xe02020;
  // Front: honeycomb grille with a red pinstripe, slim headlights, lower lip
  onEnd(c, 'trim', rbox(1.0, 0.22, 0.05, 0, 0, 0, 0.05), loft, 0, 0.47, 1, 0x1c1c1c);
  for (let i = 0; i < 6; i++) onEnd(c, 'trim', box(0.9, 0.012, 0.03, 0, 0, 0), loft, 0, 0.39 + i * 0.035, 1, 0x2e2e2e, -0.004);
  onEnd(c, 'paint', box(1.0, 0.025, 0.05, 0, 0, 0), loft, 0, 0.62, 1, red, -0.002);
  pair((s) => onEnd(c, 'lamp', rbox(0.36, 0.1, 0.05, 0, 0, 0, 0.04), loft, s * 0.6, 0.64, 1, C.headlight));
  bump(c, 'front', 'trim', rbox(1.62, 0.1, 0.18, 0, 0.25, 1.9, 0.04), C.black);
  pair((s) => bump(c, 'front', 'lamp', cyl(0.045, 0.04, s * 0.62, 0.3, 1.99, 'z', 8), C.headlight));
  // Side skirts and a red pinstripe
  pair((s) => c.parts.add('trim', box(0.05, 0.08, 2.0, s * (loft.halfWidthAt(0, 0.3) + 0.01), 0.27, 0.0), { color: C.black }));
  sideStripe(c, loft, 0.82, 0.03, -1.6, 1.6, red);
  // Rear: roof spoiler, tail lights, twin centre exhausts, diffuser
  c.parts.add('paint', rbox(1.3, 0.05, 0.32, 0, 1.4, -1.38, 0.02, -0.12), { color: roof });
  pair((s) => onEnd(c, 'tail', rbox(0.32, 0.14, 0.05, 0, 0, 0, 0.04), loft, s * 0.6, 0.86, -1, C.tail));
  pair((s) => c.parts.add('chrome', cyl(0.05, 0.16, s * 0.12, 0.27, -1.98, 'z', 10), { color: 0xffffff }));
  bump(c, 'rear', 'trim', rbox(1.5, 0.14, 0.14, 0, 0.3, -1.93, 0.04), C.black);
  mirror(c, loft, 0.72, 0.95, 0.9, roof);
  doorSeams(c, loft, [0.8, -0.6], 0.28, 0.9);
  handle(c, loft, -0.38, 0.84);
  return { wheel: { radius: r, width: 0.24, rim: 0.7, spokes: 5, dish: 0.04, seg: 12, face: 0x2a2d31 } };
}

// =========================================================================== LIFTED PICKUP
function lifted(c: Ctx): Design {
  const { r, wz } = c;
  const lift = 0.4;
  const Y = (y: number) => y + lift;
  const { L, top } = pickupBody(c, lift);
  // Bull bar (front bumper), steel rear bumper with hitch
  bump(c, 'front', 'trim', rbox(2.0, 0.22, 0.2, 0, Y(0.55), L + 0.05, 0.05), C.darkGrey);
  bump(c, 'front', 'trim', tube(V(-0.85, Y(0.62), L + 0.2), V(0.85, Y(0.62), L + 0.2), 0.05), C.black);
  pair((s) => {
    bump(c, 'front', 'trim', tube(V(s * 0.38, Y(0.5), L + 0.18), V(s * 0.38, Y(1.12), L + 0.08), 0.05), C.black);
    bump(c, 'front', 'trim', tube(V(s * 0.85, Y(0.62), L + 0.2), V(s * 0.95, Y(0.55), L + 0.08), 0.05), C.black);
  });
  bump(c, 'front', 'trim', tube(V(-0.38, Y(1.12), L + 0.08), V(0.38, Y(1.12), L + 0.08), 0.05), C.black);
  bump(c, 'rear', 'trim', rbox(2.06, 0.2, 0.22, 0, Y(0.55), -L - 0.06, 0.05), C.darkGrey);
  bump(c, 'rear', 'trim', box(0.12, 0.08, 0.22, 0, Y(0.48), -L - 0.22), C.darkGrey);
  // Black fender flares over the big tyres
  pair((s) => {
    for (const z of [wz, -wz]) flare(c, s * 1.05, z, r, r + 0.06, 0.07, 0.26, C.black);
  });
  // Roof light bar, snorkel, bed roll bar with spots
  c.parts.add('trim', rbox(1.5, 0.1, 0.14, 0, Y(1.87), 0.28, 0.03), { color: C.black });
  for (let i = 0; i < 6; i++) c.parts.add('lamp', rbox(0.17, 0.06, 0.03, -0.62 + i * 0.25, Y(1.87), 0.36, 0.01), { color: C.headlight });
  c.parts.add('trim', tube(V(-1.03, Y(0.95), 1.05), V(-1.03, Y(1.35), 0.95), 0.06), { color: C.black });
  c.parts.add('trim', tube(V(-1.03, Y(1.35), 0.95), V(-0.97, Y(1.86), 0.45), 0.06), { color: C.black });
  c.parts.add('trim', rbox(0.16, 0.12, 0.2, -0.97, Y(1.9), 0.48, 0.04), { color: C.black });
  pair((s) => c.parts.add('trim', tube(V(s * 0.85, top, -0.95), V(s * 0.75, Y(1.78), -0.95), 0.05), { color: C.black }));
  c.parts.add('trim', tube(V(-0.75, Y(1.78), -0.95), V(0.75, Y(1.78), -0.95), 0.05), { color: C.black });
  pair((s) => spotLamp(c, s * 0.42, Y(1.9), -0.9, 0.1));
  // Rock sliders, frame rails, visible lift (shocks + solid axles in the rig)
  pair((s) => {
    c.parts.add('trim', tube(V(s * 1.0, Y(0.42), 0.9), V(s * 1.0, Y(0.42), -0.55), 0.045), { color: C.black });
    c.parts.add('trim', box(0.12, 0.18, 4.2, s * 0.48, Y(0.32), 0), { color: C.darkGrey });
  });
  const links: Link[] = [];
  const shock = 0xe53935;
  for (let i = 0; i < 4; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    const z = i < 2 ? wz : -wz;
    links.push({ a: { fixed: V(s * 0.62, Y(0.5), z + 0.18) }, b: { wheel: i, offset: V(-s * 0.24, 0.05, 0.1), noSteer: true }, radius: 0.05, color: shock });
    links.push({ a: { fixed: V(s * 0.5, Y(0.32), z - 0.6 * Math.sign(z)) }, b: { wheel: i, offset: V(-s * 0.3, -0.05, 0), noSteer: true }, radius: 0.04, color: C.darkGrey });
  }
  links.push({ a: { wheel: 0, offset: V(-0.24, 0, 0), noSteer: true }, b: { wheel: 1, offset: V(0.24, 0, 0), noSteer: true }, radius: 0.075, color: C.darkGrey });
  links.push({ a: { wheel: 2, offset: V(-0.24, 0, 0), noSteer: true }, b: { wheel: 3, offset: V(0.24, 0, 0), noSteer: true }, radius: 0.075, color: C.darkGrey });
  return { wheel: { radius: r, width: 0.36, rim: 0.55, spokes: 6, lug: 0.035, seg: 14, dish: 0.1, face: 0x2a2a2a }, links };
}

// =========================================================================== CLASSIC 4x4
function jeep(c: Ctx): Design {
  const { r, wz } = c;
  const top = 0xf2efe6;
  const shape = profile([
    [1.82, 0.5],
    [1.84, 1.1],
    { q: [1.84, 1.15, 1.78, 1.15] },
    [0.62, 1.2],
    [0.52, 1.84],
    { q: [0.5, 1.88, 0.42, 1.88] },
    [-1.78, 1.86],
    { q: [-1.84, 1.86, -1.84, 1.8] },
    [-1.84, 0.55],
    { q: [-1.84, 0.5, -1.78, 0.5] },
  ]);
  const loft = addLoft(c, {
    shape,
    belt: 1.22,
    halfWidth: plan(0.76, 1.84, -1.84, 0.03, 0.02, 1.6, -1.7),
    tumble: 0.04,
    shoulder: 0.03,
    crown: 0.02,
    tuck: 0.02,
    sideWindows: [
      [-1.62, -0.7],
      [-0.6, 0.4],
    ],
    pillar: 'black',
    roof: top,
    arches: [
      [wz, r + 0.02, r + 0.08],
      [-wz, r + 0.02, r + 0.08],
    ],
    stations: [0.62, 0.52, 0.42, -1.78],
    step: 0.24,
  });
  // Flat-topped fenders standing proud of the narrow tub
  const fFront = profile([
    [1.88, 0.72],
    [1.88, 1.0],
    [0.72, 1.02],
    [0.5, 0.58],
    { arch: [wz, r + 0.02, r + 0.1] },
    [1.88, 0.58],
  ]);
  const fRear = profile([
    [-0.55, 0.58],
    [-0.78, 0.98],
    [-1.86, 0.98],
    [-1.88, 0.72],
    [-1.88, 0.58],
    { arch: [-wz, r + 0.02, r + 0.1] },
    [-0.55, 0.58],
  ]);
  pair((s) => {
    for (const sh of [fFront, fRear]) c.parts.add('paint', extrudeX(sh, 0.26, 0.02, 8, 1).translate(s * 0.88, 0, 0), { color: c.paint, crease: 0.5 });
    // Turn signals on the fender fronts, exterior hinges on the doors
    c.parts.add('lamp', rbox(0.12, 0.06, 0.03, s * 0.88, 0.92, 1.89, 0.01), { color: C.amber });
    for (const y of [0.78, 1.08]) c.parts.add('trim', box(0.03, 0.08, 0.1, s * 0.78, y, 0.38), { color: C.black });
  });
  // Flat upright windscreen in a black frame
  c.parts.add('trim', rbox(1.42, 0.66, 0.04, 0, 1.52, 0.575, 0.03, -0.155), { color: C.black });
  c.parts.add('glass', rbox(1.3, 0.56, 0.03, 0, 1.52, 0.595, 0.03, -0.155), { color: 0xffffff });
  // Grille (horizontal bars: generic) with round headlights
  c.parts.add('trim', rbox(1.1, 0.46, 0.04, 0, 0.84, 1.85, 0.03), { color: 0x1c1c1c });
  for (let i = 0; i < 4; i++) c.parts.add('chrome', box(0.6, 0.03, 0.03, 0, 0.7 + i * 0.09, 1.87), { color: 0xffffff });
  pair((s) => roundLamp(c, loft, s * 0.48, 0.86, 1, 0.12, C.headlight));
  // Steel bumpers with red tow hooks
  bump(c, 'front', 'trim', rbox(1.95, 0.18, 0.18, 0, 0.5, 1.95, 0.03), C.black);
  pair((s) => bump(c, 'front', 'paint', box(0.06, 0.08, 0.12, s * 0.55, 0.5, 2.06), 0xd62828));
  bump(c, 'rear', 'trim', rbox(1.95, 0.18, 0.18, 0, 0.5, -1.95, 0.03), C.black);
  // Rear: spare tyre on the tailgate, small tail lights, rear glass
  spareTyre(c, 0, 1.08, -2.02, 0.4, 0.26, 'z', 0xe8e8e0);
  pair((s) => c.parts.add('tail', rbox(0.12, 0.22, 0.04, s * 0.66, 0.85, -1.86, 0.02), { color: C.tail }));
  c.parts.add('glass', rbox(1.15, 0.42, 0.03, 0, 1.55, -1.85, 0.04), { color: 0xffffff });
  // Hood latches, roof rack with a cargo box
  pair((s) => c.parts.add('trim', box(0.05, 0.06, 0.04, s * 0.72, 1.12, 1.2), { color: C.black }));
  pair((s) => {
    c.parts.add('trim', tube(V(s * 0.6, 2.02, 0.25), V(s * 0.6, 2.02, -1.6), 0.025), { color: C.black });
    for (const z of [0.2, -1.55]) c.parts.add('trim', tube(V(s * 0.6, 1.88, z), V(s * 0.6, 2.02, z), 0.025), { color: C.black });
  });
  for (const z of [0.2, -0.45, -1.1, -1.55]) c.parts.add('trim', tube(V(-0.6, 2.02, z), V(0.6, 2.02, z), 0.022), { color: C.black });
  c.parts.add('trim', rbox(0.8, 0.22, 0.9, 0, 2.15, -0.75, 0.08), { color: 0x3c4a34 });
  mirror(c, loft, 0.42, 1.26, 0.9, C.black);
  doorSeams(c, loft, [0.4, -0.62], 0.55, 1.2);
  handle(c, loft, -0.45, 1.1);
  return { wheel: { radius: r, width: 0.3, rim: 0.6, spokes: 0, lug: 0.03, seg: 12, dish: 0.07, face: 0xe8e8e0 } };
}

// =========================================================================== SUV
function suv(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [2.3, 0.38],
    { q: [2.42, 0.38, 2.42, 0.52] },
    [2.4, 0.95],
    { q: [2.38, 1.03, 2.25, 1.05] },
    [1.15, 1.18],
    [0.35, 1.68],
    { q: [0.25, 1.74, 0.08, 1.74] },
    [-1.95, 1.7],
    { q: [-2.15, 1.68, -2.25, 1.55] },
    [-2.38, 1.05],
    [-2.4, 0.6],
    { q: [-2.42, 0.38, -2.25, 0.38] },
  ]);
  const base = plan(0.95, 2.42, -2.42, 0.08, 0.06, 1.8, -1.9);
  const loft = addLoft(c, {
    shape,
    belt: 1.19,
    halfWidth: (z) => base(z) + archBulge(z, wz, 0.03, 0.7),
    tumble: 0.14,
    shoulder: 0.06,
    crown: 0.04,
    tuck: 0.05,
    windscreen: [0.37, 1.12],
    rearWindow: [-2.33, -2.0],
    sideWindows: [
      [-1.95, -1.05],
      [-0.97, -0.02],
      [0.06, 1.0],
    ],
    pillar: 'black',
    arches: [
      [wz, r + 0.04, r + 0.09],
      [-wz, r + 0.04, r + 0.09],
    ],
    stations: [2.3, 1.15, 0.08, -1.95, -2.25],
    step: 0.26,
  });
  // Black cladding: arch flares + lower body band
  pair((s) => {
    for (const z of [wz, -wz]) flare(c, s * (loft.halfWidthAt(z, 1.0) + 0.0), z, r + 0.04, r + 0.09, 0.07, 0.1, 0x222426);
    c.parts.add('trim', box(0.03, 0.14, 2.0, s * (loft.halfWidthAt(0, 0.5) + 0.012), 0.5, 0), { color: 0x222426 });
  });
  // Roof rails, shark-fin antenna
  pair((s) => {
    c.parts.add('trim', tube(V(s * 0.62, 1.8, 0.05), V(s * 0.62, 1.78, -1.85), 0.025), { color: C.silver });
    for (const z of [0.05, -1.85]) c.parts.add('trim', rbox(0.05, 0.07, 0.12, s * 0.62, 1.76, z, 0.02), { color: C.black });
  });
  c.parts.add('trim', rbox(0.06, 0.07, 0.18, 0, 1.75, -1.7, 0.03), { color: C.black });
  // Front: grille with two chrome bars, LED strip headlights, bumper with skid plate
  onEnd(c, 'trim', rbox(1.1, 0.32, 0.05, 0, 0, 0, 0.06), loft, 0, 0.8, 1, 0x1a1a1a);
  for (const y of [0.74, 0.86]) onEnd(c, 'chrome', box(1.0, 0.03, 0.03, 0, 0, 0), loft, 0, y, 1, 0xffffff, -0.006);
  pair((s) => onEnd(c, 'lamp', rbox(0.42, 0.08, 0.05, 0, 0, 0, 0.03), loft, s * 0.62, 0.95, 1, C.headlight));
  bump(c, 'front', 'trim', rbox(1.92, 0.2, 0.18, 0, 0.5, 2.36, 0.05), 0x222426);
  bump(c, 'front', 'trim', rbox(1.0, 0.05, 0.2, 0, 0.42, 2.42, 0.02), C.silver);
  // Rear: spoiler, tail lights, bumper with tow bar
  c.parts.add('paint', rbox(1.5, 0.05, 0.22, 0, 1.73, -2.08, 0.02), { color: c.paint });
  pair((s) => onEnd(c, 'tail', rbox(0.42, 0.12, 0.05, 0, 0, 0, 0.03), loft, s * 0.6, 1.0, -1, C.tail));
  bump(c, 'rear', 'trim', rbox(1.92, 0.22, 0.18, 0, 0.52, -2.37, 0.05), 0x222426);
  bump(c, 'rear', 'chrome', cyl(0.04, 0.2, 0, 0.42, -2.5, 'z', 8), 0xffffff);
  mirror(c, loft, 1.0, 1.22, 1.1, 0x222426);
  doorSeams(c, loft, [1.04, 0.02, -1.02], 0.42, 1.17);
  handle(c, loft, 0.55, 1.08);
  handle(c, loft, -0.5, 1.08);
  return { wheel: { radius: r, width: 0.27, rim: 0.64, spokes: 5, dish: 0.05, seg: 12, face: 0x50555c } };
}

// =========================================================================== DELIVERY VAN
function van(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [2.6, 0.32],
    { q: [2.72, 0.32, 2.72, 0.46] },
    [2.7, 0.92],
    { q: [2.68, 1.0, 2.55, 1.02] },
    [1.95, 1.22],
    [1.25, 2.3],
    { q: [1.1, 2.43, 0.85, 2.43] },
    [-2.55, 2.43],
    { q: [-2.7, 2.43, -2.7, 2.3] },
    [-2.7, 0.45],
    { q: [-2.7, 0.32, -2.55, 0.32] },
  ]);
  const loft = addLoft(c, {
    shape,
    belt: 1.25,
    halfWidth: plan(0.99, 2.72, -2.7, 0.08, 0.01, 2.2, -2.6),
    tumble: 0.04,
    shoulder: 0.03,
    crown: 0.03,
    tuck: 0.03,
    windscreen: [1.27, 1.93],
    sideWindows: [[0.72, 1.55]],
    pillar: 'black',
    arches: [
      [wz, r + 0.04, r + 0.08],
      [-wz, r + 0.04, r + 0.08],
    ],
    stations: [2.6, 1.95, 1.25, 0.85, -2.55],
    step: 0.3,
  });
  // Front: grille, headlights, bumper
  onEnd(c, 'trim', rbox(1.1, 0.22, 0.05, 0, 0, 0, 0.04), loft, 0, 0.72, 1, 0x1c1c1c);
  pair((s) => onEnd(c, 'lamp', rbox(0.3, 0.18, 0.05, 0, 0, 0, 0.04), loft, s * 0.66, 0.8, 1, C.headlight));
  pair((s) => onEnd(c, 'lamp', rbox(0.12, 0.08, 0.04, 0, 0, 0, 0.02), loft, s * 0.82, 0.62, 1, C.amber));
  bump(c, 'front', 'trim', rbox(2.0, 0.24, 0.18, 0, 0.42, 2.66, 0.05), C.darkGrey);
  // Sides: delivery stripes, sliding-door seams, step
  sideStripe(c, loft, 0.95, 0.14, -2.55, 2.0, c.accent, 0.5);
  sideStripe(c, loft, 1.08, 0.04, -2.55, 2.0, shade(c.accent, 0.7), 0.5);
  doorSeams(c, loft, [1.62, 0.62, -0.78], 0.4, 2.15);
  pair((s) => c.parts.add('trim', box(0.012, 0.012, 1.4, s * (loft.halfWidthAt(-0.08, 2.15) + 0.004), 2.15, -0.08), { color: 0x101010 }));
  handle(c, loft, 0.3, 1.25);
  handle(c, loft, 1.0, 1.15);
  pair((s) => c.parts.add('trim', rbox(0.2, 0.05, 0.8, s * 0.98, 0.34, 0.0, 0.02), { color: C.darkGrey }));
  // Roof ribs
  for (let z = -2.2; z < 0.6; z += 0.6) c.parts.add('paint', rbox(1.7, 0.03, 0.08, 0, 2.445, z, 0.012), { color: c.paint });
  // Rear: barn doors with small windows, tall tail lights, step bumper
  c.parts.add('trim', box(0.015, 1.85, 0.015, 0, 1.3, -2.705), { color: 0x101010 });
  pair((s) => {
    c.parts.add('glass', rbox(0.66, 0.5, 0.03, s * 0.44, 1.88, -2.7, 0.04), { color: 0xffffff });
    c.parts.add('chrome', box(0.14, 0.03, 0.03, s * 0.12, 1.3, -2.72), { color: 0xffffff });
    c.parts.add('tail', rbox(0.12, 0.5, 0.05, s * 0.9, 0.95, -2.71, 0.02), { color: C.tail });
  });
  bump(c, 'rear', 'trim', rbox(2.0, 0.2, 0.24, 0, 0.42, -2.72, 0.04), C.darkGrey);
  mirror(c, loft, 1.38, 1.3, 1.4, C.black);
  return { wheel: { radius: r, width: 0.24, rim: 0.62, spokes: 0, hubcap: true, seg: 12, dish: 0.03, face: 0xbfc4ca } };
}

// =========================================================================== SCHOOL BUS
function bus(c: Ctx): Design {
  const { r, wz } = c;
  const roof = 0xf2f2ee;
  const shape = profile([
    [3.5, 0.55],
    { q: [3.62, 0.55, 3.62, 0.68] },
    [3.6, 1.32],
    { q: [3.58, 1.42, 3.45, 1.43] },
    [2.45, 1.55],
    [2.35, 1.6],
    [2.25, 2.72],
    { q: [2.2, 2.9, 1.98, 2.9] },
    [-3.42, 2.9],
    { q: [-3.6, 2.9, -3.6, 2.7] },
    [-3.6, 0.62],
    { q: [-3.6, 0.5, -3.45, 0.5] },
  ]);
  const W = 1.2;
  const loft = addLoft(c, {
    shape,
    belt: 2.42,
    halfWidth: (z) => {
      const t = Math.min(1, Math.max(0, (z - 2.32) / 0.14));
      const hood = W + (0.95 - W) * t * t * (3 - 2 * t);
      return z > 3.2 ? hood * (1 - 0.1 * ((z - 3.2) / 0.42) ** 2) : hood;
    },
    tumble: 0.04,
    shoulder: 0.02,
    crown: 0.05,
    tuck: 0.03,
    roof,
    arches: [
      [wz, r + 0.04, r + 0.1],
      [-wz, r + 0.04, r + 0.1],
    ],
    stations: [3.5, 2.45, 2.35, 2.32, 2.25, 1.98, -3.42],
    step: 0.32,
  });
  // Side windows (glass panes on the flat sides), entry door on the right, driver's window on the left
  for (let i = 0; i < 7; i++) {
    const z0 = -3.28 + i * 0.66;
    pair((s) => sidePane(c, s, W, 1.74, 2.3, z0, z0 + 0.56));
  }
  sidePane(c, 1, W, 1.74, 2.3, 1.38, 2.12);
  sidePane(c, -1, W, 1.74, 2.3, 1.38, 1.96);
  for (const [z0, z1] of [
    [1.48, 1.79],
    [1.83, 2.14],
  ]) sidePane(c, -1, W + 0.005, 0.72, 2.32, z0, z1);
  c.parts.add('trim', box(0.02, 1.66, 0.7, -(W + 0.004), 1.5, 1.81), { color: C.black });
  // Black rub rails
  pair((s) => {
    for (const y of [0.88, 1.24, 1.62]) c.parts.add('trim', box(0.025, 0.06, 6.95, s * (W + 0.012), y, -0.3), { color: C.black });
  });
  // Windscreen (two panes) + warning lights and a sign board above it
  pair((s) => c.parts.add('glass', rbox(1.06, 0.95, 0.03, s * 0.56, 2.12, 2.315, 0.04, -0.087), { color: 0xffffff }));
  c.parts.add('trim', box(0.06, 1.0, 0.04, 0, 2.12, 2.31, -0.087), { color: C.black });
  c.parts.add('trim', rbox(1.1, 0.2, 0.03, 0, 2.73, 2.235, 0.03), { color: C.black });
  c.parts.add('paint', rbox(0.95, 0.12, 0.03, 0, 2.73, 2.25, 0.02), { color: c.paint });
  pair((s) => {
    for (const [x, col] of [
      [0.75, C.amber],
      [1.0, C.tail],
    ] as const) {
      c.parts.add('trim', cyl(0.085, 0.04, s * x, 2.73, 2.23, 'z', 10), { color: C.black });
      c.parts.add('lamp', cyl(0.065, 0.04, s * x, 2.73, 2.25, 'z', 10), { color: col });
    }
  });
  // Hood front: grille with chrome bars, round headlights; big black bumper
  onEnd(c, 'trim', rbox(0.95, 0.55, 0.05, 0, 0, 0, 0.04), loft, 0, 0.98, 1, 0x1c1c1c);
  for (let i = 0; i < 5; i++) onEnd(c, 'chrome', box(0.85, 0.025, 0.03, 0, 0, 0), loft, 0, 0.78 + i * 0.1, 1, 0xffffff, -0.006);
  pair((s) => roundLamp(c, loft, s * 0.66, 1.12, 1, 0.11, C.headlight));
  pair((s) => roundLamp(c, loft, s * 0.66, 0.84, 1, 0.06, C.amber, 'lamp', false));
  bump(c, 'front', 'trim', rbox(2.36, 0.26, 0.22, 0, 0.55, 3.68, 0.05), C.black);
  // Stop arm on the driver's side
  c.parts.add('trim', cyl(0.25, 0.02, W + 0.03, 1.95, 1.05, 'x', 8), { color: C.white });
  c.parts.add('tail', cyl(0.22, 0.03, W + 0.04, 1.95, 1.05, 'x', 8), { color: C.tail });
  // Mirror arms
  pair((s) => {
    c.parts.add('trim', tube(V(s * 1.15, 2.0, 2.2), V(s * 1.42, 2.15, 2.45), 0.025), { color: C.black });
    c.parts.add('trim', rbox(0.1, 0.36, 0.14, s * 1.45, 2.1, 2.46, 0.04), { color: C.black });
  });
  // Rear: emergency door window, rear windows, round tail lights, warning lights, bumper
  c.parts.add('glass', rbox(0.66, 0.62, 0.03, 0, 2.02, -3.605, 0.04), { color: 0xffffff });
  pair((s) => c.parts.add('glass', rbox(0.62, 0.62, 0.03, s * 0.78, 2.02, -3.605, 0.04), { color: 0xffffff }));
  c.parts.add('trim', box(0.012, 1.95, 0.012, 0.36, 1.5, -3.61), { color: 0x101010 });
  c.parts.add('trim', box(0.012, 1.95, 0.012, -0.36, 1.5, -3.61), { color: 0x101010 });
  pair((s) => {
    c.parts.add('tail', cyl(0.11, 0.04, s * 0.92, 1.05, -3.62, 'z', 12), { color: C.tail });
    c.parts.add('lamp', cyl(0.08, 0.04, s * 0.92, 0.8, -3.62, 'z', 10), { color: C.amber });
    c.parts.add('lamp', cyl(0.065, 0.04, s * 0.9, 2.73, -3.61, 'z', 10), { color: C.amber });
  });
  bump(c, 'rear', 'trim', rbox(2.36, 0.26, 0.22, 0, 0.55, -3.68, 0.05), C.black);
  // Roof hatches
  for (const z of [0.6, -2.0]) c.parts.add('trim', rbox(0.6, 0.06, 0.6, 0, 2.92, z, 0.03), { color: 0xd6d6d0 });
  return { wheel: { radius: r, width: 0.3, rim: 0.6, spokes: 0, hubcap: true, seg: 14, dish: 0.06, face: 0x2d3034 } };
}

// =========================================================================== TRACTOR
function tractor(c: Ctx): Design {
  const { r, rr, wz } = c;
  const roof = 0xf2f2ee;
  // Narrow engine hood in front of the cab
  const shape = profile([
    [1.88, 0.72],
    { q: [1.96, 0.72, 1.96, 0.82] },
    [1.95, 1.47],
    { q: [1.94, 1.57, 1.82, 1.58] },
    [-0.1, 1.7],
    [-0.1, 0.72],
  ]);
  const loft = addLoft(c, {
    shape,
    belt: 3,
    halfWidth: plan(0.43, 1.96, -0.1, 0.12, 0, 1.5, -0.1),
    tumble: 0,
    crown: 0.06,
    tuck: 0.08,
    stations: [1.88],
    step: 0.22,
  });
  // Grille + headlights; louvres along the hood sides
  onEnd(c, 'trim', rbox(0.66, 0.56, 0.04, 0, 0, 0, 0.04), loft, 0, 1.08, 1, 0x1c1c1c);
  for (let i = 0; i < 6; i++) onEnd(c, 'trim', box(0.6, 0.02, 0.03, 0, 0, 0), loft, 0, 0.86 + i * 0.08, 1, 0x3a3a3a, -0.004);
  pair((s) => onEnd(c, 'lamp', rbox(0.16, 0.1, 0.04, 0, 0, 0, 0.03), loft, s * 0.21, 1.42, 1, C.headlight));
  pair((s) => {
    for (let i = 0; i < 4; i++) {
      const z = 0.6 + i * 0.22;
      c.parts.add('trim', box(0.01, 0.2, 0.12, s * (loft.halfWidthAt(z, 1.25) + 0.004), 1.25, z), { color: C.black });
    }
  });
  // Engine block / frame between the front wheels, front weights (the "bumper")
  c.parts.add('trim', rbox(0.62, 0.36, 2.1, 0, 0.62, 0.8, 0.04), { color: C.engine });
  for (let i = 0; i < 5; i++) bump(c, 'front', 'trim', rbox(0.18, 0.4, 0.26, -0.44 + i * 0.22, 0.75, 2.06, 0.02), C.darkGrey);
  bump(c, 'front', 'trim', rbox(1.1, 0.08, 0.3, 0, 0.53, 2.06, 0.02), C.darkGrey);
  // Short front fenders over the steering wheels
  pair((s) => flare(c, s * 0.93, wz, r, r + 0.05, 0.04, 0.3, c.paint, 'paint', -0.55));
  // Exhaust stack + air pre-cleaner
  c.parts.add('chrome', tube(V(-0.26, 1.6, 1.2), V(-0.26, 2.55, 1.2), 0.045), { color: 0xffffff });
  c.parts.add('trim', cyl(0.06, 0.06, -0.26, 2.56, 1.2, 'y', 8), { color: C.black });
  c.parts.add('trim', cyl(0.08, 0.3, 0.26, 1.85, 1.15, 'y', 10), { color: C.darkGrey });
  // Cab: floor, four posts, glass all round, white roof, seat and steering wheel inside
  const z0 = -1.6;
  const z1 = -0.12;
  const hx = 0.62;
  c.parts.add('trim', rbox(1.3, 0.1, 1.6, 0, 1.28, -0.86, 0.02), { color: C.darkGrey });
  pair((s) => {
    for (const z of [z0, z1]) c.parts.add('paint', rbox(0.09, 1.36, 0.09, s * hx, 1.98, z, 0.03), { color: c.paint });
    // Lower door panel in paint, glass above, a handle
    c.parts.add('paint', rbox(0.04, 0.42, z1 - z0 - 0.08, s * (hx - 0.01), 1.55, (z0 + z1) / 2, 0.02), { color: c.paint });
    sidePane(c, s, hx - 0.02, 1.78, 2.58, z0 + 0.06, z1 - 0.06);
    c.parts.add('chrome', box(0.03, 0.03, 0.14, s * (hx + 0.02), 1.7, z1 - 0.3), { color: 0xffffff });
  });
  c.parts.add('glass', rbox(1.18, 1.18, 0.03, 0, 1.98, z1, 0.03), { color: 0xffffff });
  c.parts.add('glass', rbox(1.18, 0.82, 0.03, 0, 2.14, z0, 0.03), { color: 0xffffff });
  c.parts.add('paint', rbox(1.18, 0.4, 0.04, 0, 1.52, z0, 0.02), { color: c.paint });
  c.parts.add('paint', rbox(1.56, 0.12, 1.82, 0, 2.7, -0.86, 0.05), { color: roof });
  c.parts.add('trim', rbox(1.4, 0.04, 1.64, 0, 2.63, -0.86, 0.02), { color: C.black });
  pair((s) => c.parts.add('lamp', rbox(0.12, 0.06, 0.04, s * 0.55, 2.66, 0.04, 0.02), { color: C.headlight }));
  c.parts.add('trim', rbox(0.5, 0.12, 0.45, 0, 1.58, -1.15, 0.04), { color: 0x2f3338 });
  c.parts.add('trim', rbox(0.5, 0.55, 0.1, 0, 1.9, -1.4, 0.04, -0.15), { color: 0x2f3338 });
  c.parts.add('trim', new THREE.TorusGeometry(0.17, 0.02, 4, 12).rotateX(-1.0).translate(0, 1.98, -0.52), { color: C.black });
  c.parts.add('trim', tube(V(0, 1.98, -0.52), V(0, 1.45, -0.28), 0.025, 4), { color: C.black });
  // Big rear fenders with amber lamps, steps, rear lights
  pair((s) => {
    flare(c, s * 0.93, -wz, rr, rr + 0.07, 0.05, 0.52, c.paint, 'paint', -0.05);
    c.parts.add('lamp', rbox(0.1, 0.08, 0.06, s * 1.12, rr + 0.35, -wz + rr * 0.72, 0.02), { color: C.amber });
    c.parts.add('tail', rbox(0.1, 0.1, 0.04, s * 1.0, rr + 0.25, -wz - rr * 0.9, 0.02), { color: C.tail });
  });
  for (const y of [0.55, 0.95]) c.parts.add('trim', rbox(0.3, 0.04, 0.2, 0.74, y, -0.05, 0.01), { color: C.darkGrey });
  c.parts.add('trim', tube(V(0.74, 0.5, 0.0), V(0.74, 1.28, -0.12), 0.02, 4), { color: C.darkGrey });
  // Rear three-point hitch + PTO
  pair((s) => c.parts.add('trim', tube(V(s * 0.28, 0.75, -1.3), V(s * 0.38, 0.5, -2.0), 0.035), { color: C.darkGrey }));
  c.parts.add('trim', tube(V(0, 1.15, -1.55), V(0, 0.95, -2.0), 0.035), { color: C.darkGrey });
  c.parts.add('trim', cyl(0.05, 0.12, 0, 0.72, -1.85, 'z', 8), { color: C.grey });
  // Front axle (rig) between the front wheels
  const links: Link[] = [{ a: { wheel: 0, offset: V(-0.15, 0, 0), noSteer: true }, b: { wheel: 1, offset: V(0.15, 0, 0), noSteer: true }, radius: 0.07, color: C.darkGrey }];
  const rim = c.paint;
  return {
    wheel: { radius: r, width: 0.26, rim: 0.55, spokes: 0, lug: 0.03, seg: 14, dish: 0.06, face: rim },
    rearWheel: { radius: rr, width: 0.46, rim: 0.55, spokes: 0, lug: 0.065, seg: 20, dish: 0.12, face: rim },
    links,
  };
}

// =========================================================================== QUAD BIKE
function atv(c: Ctx): Design {
  const { r, wz } = c;
  const jacket = c.accent;
  const denim = 0x2c3e60;
  // Frame, engine, footrests
  pair((s) => c.parts.add('trim', tube(V(s * 0.17, 0.38, 0.85), V(s * 0.17, 0.38, -0.85), 0.03), { color: C.darkGrey }));
  c.parts.add('trim', rbox(0.36, 0.32, 0.55, 0, 0.5, -0.05, 0.05), { color: C.engine });
  pair((s) => c.parts.add('trim', rbox(0.2, 0.03, 0.38, s * 0.36, 0.42, -0.05, 0.01), { color: C.darkGrey }));
  // Front bodywork: nose with headlights + mudguards over the front wheels + rack
  const nose = profile([
    [1.05, 0.52],
    [1.02, 0.68],
    [0.72, 0.76],
    [0.32, 0.8],
    [0.25, 0.62],
    [0.3, 0.52],
  ]);
  c.parts.add('paint', extrudeX(nose, 0.6, 0.04, 6, 2), { color: c.paint, crease: 0.6 });
  pair((s) => {
    flare(c, s * 0.53, wz, r, r + 0.05, 0.05, 0.3, c.paint, 'paint', 0.3);
    flare(c, s * 0.53, -wz, r, r + 0.05, 0.05, 0.34, c.paint, 'paint', 0.3);
    spotLamp(c, s * 0.15, 0.64, 1.04, 0.06);
  });
  pair((s) => c.parts.add('trim', tube(V(s * 0.34, 0.86, 0.45), V(s * 0.34, 0.86, 0.98), 0.018, 4), { color: C.black }));
  for (const z of [0.5, 0.95]) c.parts.add('trim', tube(V(-0.34, 0.86, z), V(0.34, 0.86, z), 0.018, 4), { color: C.black });
  // Tank, seat, rear deck + rack, tail light
  c.parts.add('paint', rbox(0.42, 0.2, 0.36, 0, 0.82, 0.2, 0.08), { color: c.paint });
  c.parts.add('trim', rbox(0.34, 0.12, 0.72, 0, 0.88, -0.32, 0.05), { color: 0x202224 });
  c.parts.add('paint', rbox(0.62, 0.12, 0.66, 0, 0.74, -0.72, 0.05), { color: c.paint });
  pair((s) => c.parts.add('trim', tube(V(s * 0.34, 0.86, -0.5), V(s * 0.34, 0.86, -1.02), 0.018, 4), { color: C.black }));
  for (const z of [-0.55, -1.0]) c.parts.add('trim', tube(V(-0.34, 0.86, z), V(0.34, 0.86, z), 0.018, 4), { color: C.black });
  c.parts.add('tail', rbox(0.18, 0.06, 0.04, 0, 0.72, -1.06, 0.02), { color: C.tail });
  bump(c, 'front', 'trim', tube(V(-0.3, 0.45, 1.12), V(0.3, 0.45, 1.12), 0.03), C.black);
  pair((s) => bump(c, 'front', 'trim', tube(V(s * 0.3, 0.45, 1.12), V(s * 0.25, 0.6, 1.02), 0.025), C.black));
  bump(c, 'rear', 'trim', tube(V(-0.32, 0.5, -1.1), V(0.32, 0.5, -1.1), 0.03), C.black);
  // Handlebars
  c.parts.add('trim', tube(V(0, 0.72, 0.28), V(0, 1.02, 0.38), 0.025, 6), { color: C.black });
  c.parts.add('trim', tube(V(-0.38, 1.02, 0.38), V(0.38, 1.02, 0.38), 0.02, 6), { color: C.black });
  pair((s) => c.parts.add('trim', cyl(0.028, 0.12, s * 0.33, 1.02, 0.38, 'x', 6), { color: C.rubber }));
  // Rider: helmet (paint colour) with visor, jacket, jeans, boots
  c.parts.add('paint', new THREE.SphereGeometry(0.15, 12, 8).scale(1, 1.05, 1.1).translate(0, 1.62, -0.08), { color: c.paint });
  c.parts.add('glass', rbox(0.22, 0.08, 0.06, 0, 1.62, 0.07, 0.03), { color: 0xffffff });
  c.parts.add('trim', rbox(0.38, 0.5, 0.26, 0, 1.25, -0.22, 0.08, 0.35), { color: jacket });
  c.parts.add('trim', rbox(0.34, 0.18, 0.28, 0, 0.98, -0.38, 0.06), { color: denim });
  c.parts.add('trim', cyl(0.06, 0.1, 0, 1.48, -0.13, 'y', 6), { color: 0x2a2a2a });
  pair((s) => {
    c.parts.add('trim', tube(V(s * 0.2, 1.42, -0.12), V(s * 0.3, 1.2, 0.14), 0.05, 6), { color: jacket });
    c.parts.add('trim', tube(V(s * 0.3, 1.2, 0.14), V(s * 0.35, 1.04, 0.36), 0.045, 6), { color: jacket });
    c.parts.add('trim', rbox(0.08, 0.08, 0.1, s * 0.35, 1.03, 0.38, 0.03), { color: C.black });
    c.parts.add('trim', tube(V(s * 0.12, 0.98, -0.38), V(s * 0.27, 1.02, -0.02), 0.065, 6), { color: denim });
    c.parts.add('trim', tube(V(s * 0.27, 1.02, -0.02), V(s * 0.34, 0.5, -0.1), 0.055, 6), { color: denim });
    c.parts.add('trim', rbox(0.12, 0.12, 0.24, s * 0.35, 0.49, -0.04, 0.03), { color: C.black });
  });
  // Exposed suspension: A-arms + shocks front, swing arms + shocks rear, rear axle
  const links: Link[] = [];
  const shock = c.accent;
  for (let i = 0; i < 4; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    if (i < 2) {
      for (const [y, dz, oy] of [
        [0.34, 0.1, -0.04],
        [0.34, -0.1, -0.04],
        [0.5, 0.0, 0.06],
      ]) links.push({ a: { fixed: V(s * 0.16, y, wz + dz) }, b: { wheel: i, offset: V(-s * 0.1, oy, 0) }, radius: 0.018, color: C.black });
      links.push({ a: { fixed: V(s * 0.2, 0.7, wz - 0.12) }, b: { wheel: i, offset: V(-s * 0.1, 0.05, 0) }, radius: 0.03, color: shock });
    } else {
      links.push({ a: { fixed: V(s * 0.15, 0.4, -0.15) }, b: { wheel: i, offset: V(-s * 0.12, 0, 0), noSteer: true }, radius: 0.03, color: C.black });
      links.push({ a: { fixed: V(s * 0.12, 0.78, -0.45) }, b: { wheel: i, offset: V(-s * 0.2, 0.05, 0), noSteer: true }, radius: 0.03, color: shock });
    }
  }
  links.push({ a: { wheel: 2, offset: V(-0.1, 0, 0), noSteer: true }, b: { wheel: 3, offset: V(0.1, 0, 0), noSteer: true }, radius: 0.035, color: C.darkGrey });
  return {
    wheel: { radius: r, width: 0.22, rim: 0.55, spokes: 5, lug: 0.03, seg: 12, dish: 0.05, face: 0x2a2a2a },
    rearWheel: { radius: r, width: 0.27, rim: 0.55, spokes: 5, lug: 0.03, seg: 12, dish: 0.06, face: 0x2a2a2a },
    links,
  };
}

// =========================================================================== TROPHY TRUCK
function trophy(c: Ctx): Design {
  const { r, wz } = c;
  const shape = profile([
    [2.7, 0.62],
    { q: [2.84, 0.62, 2.84, 0.78] },
    [2.82, 1.08],
    { q: [2.8, 1.16, 2.66, 1.17] },
    [0.75, 1.26],
    [0.22, 1.74],
    { q: [0.12, 1.8, -0.04, 1.8] },
    [-0.82, 1.78],
    { q: [-0.9, 1.77, -0.93, 1.68] },
    [-0.98, 1.28],
    [-2.66, 1.24],
    { q: [-2.8, 1.24, -2.8, 1.12] },
    [-2.8, 0.78],
    { q: [-2.8, 0.62, -2.65, 0.62] },
  ]);
  const base = plan(0.9, 2.84, -2.8, 0.12, 0.06, 2.2, -2.4);
  const loft = addLoft(c, {
    shape,
    belt: 1.27,
    halfWidth: (z) => base(z) + archBulge(z, wz, 0.24, 1.0),
    tumble: 0.18,
    shoulder: 0.1,
    crown: 0.05,
    tuck: 0.1,
    tuckH: 0.2,
    windscreen: [0.24, 0.72],
    sideWindows: [[-0.82, 0.14]],
    pillar: 'black',
    arches: [
      [wz, r + 0.02, r + 0.12],
      [-wz, r + 0.02, r + 0.12],
    ],
    stations: [2.7, 0.75, -0.04, -0.82, -0.93, -0.98, -2.66],
    step: 0.26,
  });
  // Livery: accent band low on the flanks, number boards on the doors
  sideStripe(c, loft, 1.02, 0.12, -2.7, 2.7, c.accent, 0.3);
  pair((s) => {
    const hw = loft.halfWidthAt(-0.35, 1.06);
    c.parts.add('paint', rbox(0.012, 0.3, 0.46, s * (hw + 0.012), 1.06, -0.35, 0.03), { color: C.white });
    c.parts.add('trim', box(0.006, 0.22, 0.05, s * (hw + 0.02), 1.06, -0.35), { color: C.black });
  });
  // Roof light bar, hood light pod, round headlights, grille
  c.parts.add('trim', rbox(1.4, 0.12, 0.14, 0, 1.88, 0.02, 0.03), { color: C.black });
  for (let i = 0; i < 6; i++) c.parts.add('lamp', rbox(0.17, 0.07, 0.03, -0.62 + i * 0.25, 1.88, 0.1, 0.01), { color: C.headlight });
  for (const x of [-0.42, -0.14, 0.14, 0.42]) spotLamp(c, x, loft.topAt(x, 2.45) + 0.12, 2.48, 0.09);
  c.parts.add('trim', rbox(1.2, 0.05, 0.12, 0, loft.topAt(0, 2.45) + 0.04, 2.44, 0.02), { color: C.black });
  onEnd(c, 'trim', rbox(1.0, 0.26, 0.05, 0, 0, 0, 0.05), loft, 0, 0.88, 1, 0x1a1a1a);
  pair((s) => roundLamp(c, loft, s * 0.62, 0.95, 1, 0.09, C.headlight));
  // Tube bumpers + skid plate
  bump(c, 'front', 'trim', tube(V(-0.85, 0.7, 2.9), V(0.85, 0.7, 2.9), 0.05), C.black);
  pair((s) => bump(c, 'front', 'trim', tube(V(s * 0.85, 0.7, 2.9), V(s * 0.9, 0.85, 2.72), 0.045), C.black));
  bump(c, 'front', 'trim', rbox(1.2, 0.04, 0.7, 0, 0.6, 2.5, 0.02), C.grey);
  bump(c, 'rear', 'trim', tube(V(-0.85, 0.75, -2.88), V(0.85, 0.75, -2.88), 0.05), C.black);
  pair((s) => bump(c, 'rear', 'trim', tube(V(s * 0.85, 0.75, -2.88), V(s * 0.9, 0.9, -2.72), 0.045), C.black));
  // Rear deck: spare tyre lying flat, cage, tail lights, exhausts
  spareTyre(c, 0, 1.4, -1.9, 0.46, 0.3, 'y', 0x2d3034);
  pair((s) => {
    c.parts.add('trim', tube(V(s * 0.82, 1.24, -1.0), V(s * 0.7, 1.82, -1.05), 0.04), { color: C.black });
    c.parts.add('trim', tube(V(s * 0.7, 1.82, -1.05), V(s * 0.78, 1.26, -2.7), 0.04), { color: C.black });
    flatLamp(c, s * 0.82, 1.06, -2.82, 0.2, 0.1, -1, C.tail, 'tail');
    c.parts.add('chrome', tube(V(s * 0.42, 0.78, -2.7), V(s * 0.44, 0.84, -2.95), 0.05), { color: 0xffffff });
  });
  c.parts.add('trim', tube(V(-0.7, 1.82, -1.05), V(0.7, 1.82, -1.05), 0.04), { color: C.black });
  c.parts.add('glass', rbox(1.2, 0.34, 0.03, 0, 1.52, -0.95, 0.04, 0.12), { color: 0xffffff });
  mirror(c, loft, 0.3, 1.32, 1.0, C.black);
  doorSeams(c, loft, [0.7, -0.88], 0.7, 1.26);
  handle(c, loft, -0.7, 1.18);
  // Long-travel suspension: A-arms + twin coil-overs (front), trailing arms + bypass shocks (rear), rear axle
  const links: Link[] = [];
  const coil = c.accent;
  for (let i = 0; i < 4; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    if (i < 2) {
      for (const [y, dz, oy] of [
        [0.66, 0.22, -0.08],
        [0.66, -0.22, -0.08],
        [0.98, 0.0, 0.12],
      ]) links.push({ a: { fixed: V(s * 0.42, y, wz + dz) }, b: { wheel: i, offset: V(-s * 0.18, oy, 0) }, radius: 0.035, color: C.darkGrey });
      for (const dz of [0.12, -0.12]) links.push({ a: { fixed: V(s * 0.55, 1.18, wz + dz) }, b: { wheel: i, offset: V(-s * 0.2, 0.08, dz * 0.5) }, radius: 0.045, color: coil });
    } else {
      links.push({ a: { fixed: V(s * 0.55, 0.72, -0.6) }, b: { wheel: i, offset: V(-s * 0.2, 0, 0), noSteer: true }, radius: 0.05, color: C.darkGrey });
      for (const dz of [0.25, 0.0]) links.push({ a: { fixed: V(s * 0.62, 1.22, -wz + dz + 0.1) }, b: { wheel: i, offset: V(-s * 0.22, 0.1, dz * 0.3), noSteer: true }, radius: 0.045, color: coil });
    }
  }
  links.push({ a: { wheel: 2, offset: V(-0.2, 0, 0), noSteer: true }, b: { wheel: 3, offset: V(0.2, 0, 0), noSteer: true }, radius: 0.07, color: C.darkGrey });
  return { wheel: { radius: r, width: 0.38, rim: 0.55, spokes: 8, lug: 0.035, seg: 16, dish: 0.09, face: 0x2d3034 }, links };
}

export const DESIGNS2: Record<Exclude<VehicleKind, 'sports' | 'muscle' | 'pickup' | 'monster' | 'buggy' | 'sedan'>, (c: Ctx) => Design> = {
  rally,
  hatch,
  lifted,
  jeep,
  suv,
  van,
  bus,
  tractor,
  atv,
  trophy,
};
