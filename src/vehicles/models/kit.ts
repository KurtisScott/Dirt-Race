import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { events } from '../../core/events';
import { look } from '../../core/look';
import type { VehicleParams } from '../types';

/**
 * Procedural vehicle modelling kit (no downloads). Bodies are side-profile extrusions with bevels,
 * then "warped" (tumblehome above the beltline, rounded nose/tail in plan view, tucked sills) and
 * given creased normals so curved panels shade smoothly while hard edges stay crisp.
 *
 * Model space ("ground space"): +Z forward, +Y up, +X left, y = 0 is the ground under the car at rest,
 * wheel centres sit at y = wheelRadius, z = ±wheelZ. The model group is offset so this lines up with
 * the physics chassis (see groundOffset).
 */

// ------------------------------------------------------------------ materials

let envMap: THREE.CubeTexture | null | undefined;
/**
 * Tiny procedural sky/ground cube map so paint, glass and chrome have something to reflect.
 * Returns null when no usable 2D canvas exists (headless tests with DOM shims).
 */
export function vehicleEnvMap(): THREE.CubeTexture | null {
  if (envMap !== undefined) return envMap;
  try {
    envMap = makeEnvMap();
  } catch {
    envMap = null;
  }
  return envMap;
}

function makeEnvMap(): THREE.CubeTexture {
  const S = 64;
  const face = (kind: 'side' | 'top' | 'bottom'): HTMLCanvasElement | OffscreenCanvas => {
    const c = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: S, height: S }) : new OffscreenCanvas(S, S);
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    if (kind === 'top') {
      const r = g.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S * 0.75);
      r.addColorStop(0, '#d9ecff');
      r.addColorStop(1, '#6ea8e0');
      g.fillStyle = r;
    } else if (kind === 'bottom') {
      g.fillStyle = '#5d5850';
    } else {
      const l = g.createLinearGradient(0, 0, 0, S);
      l.addColorStop(0, '#5f9ad6');
      l.addColorStop(0.42, '#cfe3f3');
      l.addColorStop(0.5, '#f4f1e6');
      l.addColorStop(0.53, '#8a8478');
      l.addColorStop(1, '#4e4a44');
      g.fillStyle = l;
    }
    g.fillRect(0, 0, S, S);
    return c;
  };
  const side = face('side');
  const tex = new THREE.CubeTexture([side, side, face('top'), face('bottom'), side, side] as unknown as HTMLImageElement[]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export type MatKey = 'paint' | 'glass' | 'trim' | 'chrome' | 'lamp' | 'tail';

type SharedKey = Exclude<MatKey, 'paint' | 'tail'> | 'tyre';
let shared: Record<SharedKey, THREE.Material> | null = null;

/** Classic (Low/Medium) shared materials: as before Round 2. */
function classicShared(env: THREE.CubeTexture | null): Record<SharedKey, THREE.Material> {
  const trim = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.05, envMap: env, envMapIntensity: 0.35 });
  return {
    glass: new THREE.MeshStandardMaterial({ color: 0x1c2a36, roughness: 0.06, metalness: 0.55, envMap: env, envMapIntensity: 1.25 }),
    trim,
    tyre: trim,
    chrome: new THREE.MeshStandardMaterial({ color: 0xe3e8ee, roughness: 0.16, metalness: 1, envMap: env, envMapIntensity: 1.1 }),
    lamp: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  };
}

/**
 * Round 2 PBR shared materials (High/Ultra, lit by the sky environment): dark tinted glass with Fresnel
 * reflections, polished chrome, satin plastic trim, rubber tyres with a procedural tread / sidewall
 * normal pattern, HDR lamps (they bloom).
 */
function pbrShared(): Record<SharedKey, THREE.Material> {
  const lamp = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(2.2, 2.2, 2.2) });
  return {
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1116, roughness: 0.02, metalness: 0, envMapIntensity: 1.5, clearcoat: 1, clearcoatRoughness: 0.0, ior: 1.52, specularIntensity: 1 }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.08, envMapIntensity: 0.7 }),
    tyre: makeTyreMaterial(),
    chrome: new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.08, metalness: 1, envMapIntensity: 1.2 }),
    lamp,
  };
}

/** Rubber with tread grooves across the tyre face and fine sidewall rings (wheel-local space, axle = X). */
function makeTyreMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vTyre; varying vec3 vTyreN; varying vec3 vTanV; varying vec3 vRadV;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vTyre = position; vTyreN = normal; vTanV = normalMatrix * normalize(vec3(0.0, -position.z, position.y) + 1e-5); vRadV = normalMatrix * normalize(vec3(0.0, position.y, position.z) + 1e-5);',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n varying vec3 vTyre; varying vec3 vTyreN; varying vec3 vTanV; varying vec3 vRadV;')
      .replace(
        '#include <normal_fragment_maps>',
        `{
          float r = length(vTyre.yz);
          float ang = atan(vTyre.z, vTyre.y);
          float tread = 1.0 - smoothstep(0.35, 0.6, abs(vTyreN.x));          // facing outward (the tread)
          float g = abs(fract(ang * 9.549 + abs(vTyre.x) * 9.0) - 0.5);       // 60 chevron grooves
          float groove = (1.0 - smoothstep(0.08, 0.16, g)) * tread;
          float ring = (1.0 - tread) * (0.5 + 0.5 * sin(r * 260.0));          // sidewall moulding rings
          diffuseColor.rgb *= 1.0 - 0.45 * groove + 0.06 * ring;
          normal = normalize(normal + normalize(vTanV) * (g - 0.25) * tread + normalize(vRadV) * ring * 0.04);
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = 0.9;');
  };
  m.customProgramCacheKey = () => 'dirt-race-tyre-v1';
  m.name = 'vehicle-tyre';
  return m;
}

/** Materials shared by every vehicle (never disposed). Trim and lamp use vertex colours. */
export function sharedMaterials(): Record<SharedKey, THREE.Material> {
  if (shared) return shared;
  const hasDom = typeof document !== 'undefined';
  const classic = classicShared(hasDom ? vehicleEnvMap() : null);
  const pbr = hasDom ? pbrShared() : classic;
  // One stable object per role; its entries are swapped when the lighting tier changes, so models built
  // later pick the right ones (cars are rebuilt every race).
  shared = { ...(look.pbr ? pbr : classic) };
  for (const [k, m] of Object.entries(classic)) m.name ||= `vehicle-${k}`;
  for (const [k, m] of Object.entries(pbr)) m.name ||= `vehicle-${k}`;
  events.on('quality:changed', () => Object.assign(shared!, look.pbr ? pbr : classic));
  return shared;
}

/**
 * Car paint. Vertex colours carry the paint + accent (stripes, two-tone roof), so one material covers
 * the whole painted body.
 * - Low/Medium: plain glossy Standard material with the little cube env map (as before).
 * - High/Ultra (Round 2): clearcoat + metallic flake sparkle under the coat, and dirt build-up on the lower
 *   body (`userData.dirt.value` 0..1, `userData.dirtColor`), driven by the model's animate() from the
 *   surface the car drives on.
 */
export function paintMaterial(): THREE.MeshStandardMaterial {
  const env = typeof document !== 'undefined' && !look.pbr ? vehicleEnvMap() : null;
  if (look.pbr) {
    const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.22, clearcoat: 1, clearcoatRoughness: 0.035, envMapIntensity: 1.1 });
    const dirt = { value: 0 };
    const dirtColor = { value: new THREE.Color(0.32, 0.24, 0.16) };
    m.userData.dirt = dirt;
    m.userData.dirtColor = dirtColor;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uDirt = dirt;
      sh.uniforms.uDirtColor = dirtColor;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n varying vec3 vCarPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vCarPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vCarPos; uniform float uDirt; uniform vec3 uDirtColor; float carDirt;
          float ch31(vec3 p) { p = fract(p * vec3(443.897, 441.423, 437.195)); p += dot(p, p.yzx + 19.19); return fract((p.x + p.y) * p.z); }
          float cvn(vec3 p) { vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(ch31(i), ch31(i + vec3(1,0,0)), f.x), mix(ch31(i + vec3(0,1,0)), ch31(i + vec3(1,1,0)), f.x), f.y),
                       mix(mix(ch31(i + vec3(0,0,1)), ch31(i + vec3(1,0,1)), f.x), mix(ch31(i + vec3(0,1,1)), ch31(i + vec3(1,1,1)), f.x), f.y), f.z); }`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          {
            // Dirt: thickest low down and behind the wheels, patchy, rising with uDirt.
            float n = cvn(vCarPos * 7.0) * 0.6 + cvn(vCarPos * 23.0) * 0.4;
            float line = 0.35 + uDirt * 0.75 + (n - 0.5) * 0.35;
            carDirt = uDirt * smoothstep(line, line - 0.35, vCarPos.y) * smoothstep(0.25, 0.6, n + uDirt * 0.3);
            diffuseColor.rgb = mix(diffuseColor.rgb, uDirtColor * (0.8 + 0.4 * n), clamp(carDirt * 1.4, 0.0, 0.92));
          }`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.95, clamp(carDirt * 1.5, 0.0, 1.0));')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor *= 1.0 - clamp(carDirt * 1.5, 0.0, 1.0);')
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            // Metallic flake: tiny facets under the clear coat catch the light at different angles.
            vec3 fp = floor(vCarPos * 900.0);
            vec3 fl = vec3(ch31(fp), ch31(fp + 7.1), ch31(fp + 3.3)) - 0.5;
            normal = normalize(normal + fl * 0.05 * (1.0 - clamp(carDirt * 2.0, 0.0, 1.0)));
          }`,
        )
        .replace('#include <clearcoat_normal_fragment_maps>', '#include <clearcoat_normal_fragment_maps>')
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n material.clearcoat *= 1.0 - clamp(carDirt * 1.6, 0.0, 1.0);');
    };
    m.customProgramCacheKey = () => 'dirt-race-paint-v1';
    return m;
  }
  // Low metalness keeps the paint bright and saturated against the terrain (metal darkens the diffuse colour).
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.08, envMap: env, envMapIntensity: 0.9 });
}

export const C = {
  black: 0x161616,
  rubber: 0x1d1d1f,
  darkGrey: 0x2d3034,
  grey: 0x5b6066,
  silver: 0xa9afb6,
  white: 0xf2f2ee,
  cream: 0xf1e8d2,
  headlight: 0xfff8e0,
  amber: 0xffa21a,
  tail: 0xd8141c,
  tailDark: 0x7a0a10,
  bedliner: 0x26282b,
  engine: 0x3a3d42,
};

// ------------------------------------------------------------------ profiles

/** A profile segment in (z, y): a point, a quadratic curve `{ q: [cz, cy, z, y] }`, or a wheel arch cut into the bottom edge. */
export type Seg = [number, number] | { q: [number, number, number, number] } | { arch: [zc: number, yc: number, radius: number] };

/**
 * Build a side profile (shape x = model z, shape y = model y). Trace it front-bottom → up the nose →
 * over the top to the tail → down → back along the bottom with increasing z. `arch` cuts a semicircle
 * (plus vertical sides down to the current sill height) for a wheel.
 */
export function profile(segs: Seg[]): THREE.Shape {
  const s = new THREE.Shape();
  let cur: [number, number] | null = null;
  for (const seg of segs) {
    if (Array.isArray(seg)) {
      if (!cur) s.moveTo(seg[0], seg[1]);
      else s.lineTo(seg[0], seg[1]);
      cur = [seg[0], seg[1]];
    } else if ('q' in seg) {
      const [cz, cy, z, y] = seg.q;
      s.quadraticCurveTo(cz, cy, z, y);
      cur = [z, y];
    } else {
      const [zc, yc, ra] = seg.arch;
      const y: number = cur![1];
      if (y <= yc) {
        s.lineTo(zc - ra, y);
        if (y < yc) s.lineTo(zc - ra, yc);
        s.absarc(zc, yc, ra, Math.PI, 0, true);
        s.lineTo(zc + ra, y);
      } else {
        // Bottom edge is above the arch centre: clip the arch where it meets the edge.
        const a1 = Math.asin(Math.min(1, (y - yc) / ra));
        const a2 = Math.PI - a1;
        s.lineTo(zc + ra * Math.cos(a2), y);
        s.absarc(zc, yc, ra, a2, a1, true);
      }
      cur = [zc + ra, y];
    }
  }
  return s;
}

/** Profile → polygon (for surface queries). */
export function outline(shape: THREE.Shape, curveSegs = 8): THREE.Vector2[] {
  return shape.extractPoints(curveSegs).shape;
}

/** Highest y of the outline at z (top surface), or NaN. */
export function topY(pts: THREE.Vector2[], z: number): number {
  let best = NaN;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if ((a.x - z) * (b.x - z) > 0 || a.x === b.x) continue;
    const y = a.y + ((z - a.x) / (b.x - a.x)) * (b.y - a.y);
    if (!(y <= best)) best = y;
  }
  return best;
}

/** Front-most (side = 1) or rear-most (side = -1) z of the outline at height y. */
export function edgeZ(pts: THREE.Vector2[], y: number, side: 1 | -1): number {
  let best = NaN;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue;
    const z = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (Number.isNaN(best) || z * side > best * side) best = z;
  }
  return best;
}

/** Extrude a side profile across X (centred), with rounded edges of radius `bevel`. Walls sit exactly on the profile. */
export function extrudeX(shape: THREE.Shape, width: number, bevel = 0.04, curveSegs = 5, bevelSegs = 2): THREE.BufferGeometry {
  const b = Math.min(bevel, width * 0.45);
  const depth = Math.max(0.002, width - 2 * b);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: bevelSegs,
    curveSegments: curveSegs,
    steps: 1,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2); // shape x → +Z, extrude axis → X
  return g;
}

/** Box with optional rotation (Euler XYZ, radians). */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

/** Chamfered box (bevelled edges, ~44 tris). Width along X. */
export function rbox(w: number, h: number, d: number, x: number, y: number, z: number, r = 0.03, rx = 0): THREE.BufferGeometry {
  const hz = d / 2;
  const hy = h / 2;
  const rr = Math.min(r, hz * 0.9, hy * 0.9);
  const s = new THREE.Shape();
  s.moveTo(-hz + rr, -hy);
  s.lineTo(hz - rr, -hy);
  s.lineTo(hz, -hy + rr);
  s.lineTo(hz, hy - rr);
  s.lineTo(hz - rr, hy);
  s.lineTo(-hz + rr, hy);
  s.lineTo(-hz, hy - rr);
  s.lineTo(-hz, -hy + rr);
  s.closePath();
  const g = extrudeX(s, w, Math.min(rr, w * 0.3), 1, 1);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return g;
}

/** Cylinder along an axis ('x' | 'y' | 'z'). */
export function cyl(r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'z', seg = 10, r2 = r): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** Tube (thin cylinder) between two points. */
export function tube(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, seg = 6): THREE.BufferGeometry {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len + r * 0.8, seg, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate((va.x + vb.x) / 2, (va.y + vb.y) / 2, (va.z + vb.z) / 2);
  return g;
}

/** A flat quad strip following points (for windscreens), given as rows of [left, right] vertices. */
export function strip(rows: [THREE.Vector3, THREE.Vector3][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const [a, b] = rows[i];
    const [c, d] = rows[i + 1];
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Make it face outward regardless of the order rows were given in: caller passes `outward`.
  return g;
}

/**
 * A panel lying on a profile surface between heights y0..y1 (front or rear face), offset `off` outward
 * along the surface normal, spanning ±halfW. Used for windscreens and rear windows.
 */
export function facePanel(pts: THREE.Vector2[], side: 1 | -1, y0: number, y1: number, halfW: number, off = 0.012, rows = 2): THREE.BufferGeometry {
  const r: [THREE.Vector3, THREE.Vector3][] = [];
  const zs: number[] = [];
  for (let i = 0; i <= rows; i++) zs.push(edgeZ(pts, y0 + ((y1 - y0) * i) / rows, side));
  for (let i = 0; i <= rows; i++) {
    const y = y0 + ((y1 - y0) * i) / rows;
    const z = zs[i];
    // Surface tangent (dz, dy) → outward normal.
    const j = Math.min(rows, Math.max(1, i));
    const dz = zs[j] - zs[j - 1];
    const dy = (y1 - y0) / rows;
    const len = Math.hypot(dz, dy);
    const nz = (dy / len) * side * (dz * side <= 0 ? 1 : 1);
    const ny = (-dz / len) * side;
    const p = (x: number) => new THREE.Vector3(x, y + ny * off, z + nz * off);
    r.push(side === 1 ? [p(-halfW), p(halfW)] : [p(halfW), p(-halfW)]);
  }
  return strip(r);
}

/** A strip lying on the top surface of a profile between z0..z1 at x ∈ [x0, x1], offset upward. */
export function topStrip(pts: THREE.Vector2[], z0: number, z1: number, x0: number, x1: number, off = 0.006, step = 0.12): THREE.BufferGeometry {
  const rows: [THREE.Vector3, THREE.Vector3][] = [];
  const n = Math.max(1, Math.ceil(Math.abs(z1 - z0) / step));
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    const y = topY(pts, z) + off;
    rows.push([new THREE.Vector3(x1, y, z), new THREE.Vector3(x0, y, z)]);
  }
  if (z1 < z0) rows.forEach((r) => r.reverse());
  return strip(rows);
}

// ------------------------------------------------------------------ warps

export interface WarpOpts {
  /** Beltline height: above it the sides lean in (tumblehome). */
  belt: number;
  /** Roof height (tumblehome reaches `tumble` at this height). */
  roof: number;
  /** Fraction the half-width shrinks at roof height (0.1–0.25). */
  tumble: number;
  /** z where nose rounding starts / fraction narrower at the very nose. */
  noseZ: number;
  nose: number;
  tailZ: number;
  tail: number;
  /** Front/rear extremes (for the rounding curves). */
  front: number;
  rear: number;
  /** Bottom tuck: below `sill + tuckH` the sides tuck in by `tuck` fraction. */
  sill: number;
  tuck: number;
  tuckH?: number;
}

export type Warp = (x: number, y: number, z: number) => number;

/** Standard car-body warp (returns the new x). */
export function bodyWarp(o: WarpOpts): Warp {
  const tuckH = o.tuckH ?? 0.18;
  return (x, y, z) => {
    let f = 1;
    if (y > o.belt) f *= 1 - o.tumble * Math.min(1.15, ((y - o.belt) / Math.max(0.05, o.roof - o.belt)) ** 1.15);
    if (z > o.noseZ) f *= 1 - o.nose * Math.min(1, (z - o.noseZ) / Math.max(0.05, o.front - o.noseZ)) ** 2;
    if (z < o.tailZ) f *= 1 - o.tail * Math.min(1, (o.tailZ - z) / Math.max(0.05, o.tailZ - o.rear)) ** 2;
    if (y < o.sill + tuckH) f *= 1 - o.tuck * Math.min(1, (o.sill + tuckH - y) / tuckH);
    return x * f;
  };
}

// ------------------------------------------------------------------ part collection

interface PartOpts {
  color?: number;
  warp?: boolean;
  /** Crease angle (radians) for normals. */
  crease?: number;
}

/** Collects geometries per material, then warps + merges them into one mesh per material. */
export class Parts {
  private items: { key: MatKey; geo: THREE.BufferGeometry; opts: PartOpts }[] = [];
  private raw: { key: MatKey; geo: THREE.BufferGeometry }[] = [];
  add(key: MatKey, geo: THREE.BufferGeometry, opts: PartOpts = {}): void {
    this.items.push({ key, geo, opts });
  }
  /** Pre-built geometry that already has position, normal and colour attributes. */
  addRaw(key: MatKey, geo: THREE.BufferGeometry): void {
    this.raw.push({ key, geo });
  }
  /** Merge everything into meshes (one per material). */
  build(mats: Record<MatKey, THREE.Material>, warp: Warp | null, defaultColor: number): THREE.Mesh[] {
    const byKey = new Map<MatKey, THREE.BufferGeometry[]>();
    const col = new THREE.Color();
    for (const { key, geo, opts } of this.items) {
      let g = geo.index ? geo.toNonIndexed() : geo;
      if (g !== geo) geo.dispose();
      for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
      const pos = g.attributes.position as THREE.BufferAttribute;
      if (warp && opts.warp !== false) {
        for (let i = 0; i < pos.count; i++) pos.setX(i, warp(pos.getX(i), pos.getY(i), pos.getZ(i)));
      }
      g = toCreasedNormals(g, opts.crease ?? 0.62);
      col.setHex(opts.color ?? defaultColor);
      const c = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) c.set([col.r, col.g, col.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(g);
    }
    for (const { key, geo } of this.raw) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(geo);
    }
    const meshes: THREE.Mesh[] = [];
    for (const [key, geos] of byKey) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mats[key]);
      m.name = key;
      m.castShadow = key !== 'lamp' && key !== 'tail' && key !== 'glass';
      meshes.push(m);
    }
    return meshes;
  }
}

// ------------------------------------------------------------------ wheels

export interface WheelStyle {
  radius: number;
  width: number;
  /** Rim radius as a fraction of tyre radius. */
  rim: number;
  spokes: number;
  /** Tread lug height (0 = slick). */
  lug?: number;
  /** Radial segments (lugs alternate per segment). */
  seg?: number;
  whitewall?: boolean;
  /** Dome hubcap instead of spokes (sedan). */
  hubcap?: boolean;
  /** Rim dish depth (m). */
  dish?: number;
  /** Colour of the recessed rim face. */
  face?: number;
}

/**
 * Builds a wheel: lathed tyre (rounded section, optional knobbly tread), recessed rim face, chrome lip,
 * spokes and hub. Returns a group centred on the axle (axle along X, outer face towards +X).
 */
export function buildWheel(st: WheelStyle, mats: Record<'trim' | 'chrome', THREE.Material> & { tyre?: THREE.Material }): { group: THREE.Group; geos: THREE.BufferGeometry[] } {
  const R = st.radius;
  const w = st.width;
  const rim = R * st.rim;
  const seg = st.seg ?? 12;
  const lug = st.lug ?? 0;
  const sh = Math.min(w * 0.3, (R - rim) * 0.45); // shoulder roundness
  const hw = w / 2;
  // Tyre section (radius, axial), from inner bead to outer bead.
  const sec = [
    new THREE.Vector2(rim * 0.98, -hw + 0.01),
    new THREE.Vector2(R - sh, -hw),
    new THREE.Vector2(R, -hw + sh),
    new THREE.Vector2(R, hw - sh),
    new THREE.Vector2(R - sh, hw),
    new THREE.Vector2(rim * 0.98, hw - 0.01),
  ];
  let tyre: THREE.BufferGeometry = new THREE.LatheGeometry(sec, seg);
  if (lug > 0) {
    // Knobbly tread: push alternating columns of tread/shoulder vertices outward.
    const p = tyre.attributes.position as THREE.BufferAttribute;
    const per = sec.length;
    for (let i = 0; i < p.count; i++) {
      const col = Math.floor(i / per);
      const j = i % per;
      if (j < 1 || j > per - 2 || col % 2) continue;
      const x = p.getX(i);
      const z = p.getZ(i);
      const r = Math.hypot(x, z);
      const k = (r + (j === 2 || j === 3 ? lug : lug * 0.6)) / r;
      p.setXYZ(i, x * k, p.getY(i), z * k);
    }
  }
  tyre.rotateZ(-Math.PI / 2);
  const trimGeos: THREE.BufferGeometry[] = [];
  const chromeGeos: THREE.BufferGeometry[] = [];
  const colorize = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex);
    const n = g.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const prep = (g: THREE.BufferGeometry, crease = 0.7) => {
    let n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== 'position') n.deleteAttribute(name);
    n = toCreasedNormals(n, crease);
    return n;
  };
  // Round 2: the tyre is its own mesh when a separate tyre material exists (tread shader on High/Ultra).
  const tyreGeo = colorize(prep(tyre, lug > 0 ? 1.2 : 1.0), C.rubber);
  const ownTyre = !!mats.tyre && mats.tyre !== mats.trim;
  if (!ownTyre) trimGeos.push(tyreGeo);
  if (st.whitewall) {
    const ww = new THREE.RingGeometry(rim * 1.08, rim + (R - rim) * 0.62, seg, 1).rotateY(Math.PI / 2).translate(hw + 0.004, 0, 0);
    trimGeos.push(colorize(prep(ww), C.white));
  }
  const dish = st.dish ?? Math.min(0.08, w * 0.3);
  // Recessed rim face (dark) and the inner cover so you can't see through the wheel.
  const face = new THREE.LatheGeometry(
    [new THREE.Vector2(0.0001, hw - dish), new THREE.Vector2(rim * 0.9, hw - dish * 0.75), new THREE.Vector2(rim * 0.96, hw - 0.02)],
    Math.min(seg, 10),
  ).rotateZ(-Math.PI / 2);
  trimGeos.push(colorize(prep(face, 1.2), st.face ?? C.darkGrey));
  const inner = new THREE.CircleGeometry(rim, 8).rotateY(-Math.PI / 2).translate(-hw + 0.02, 0, 0);
  trimGeos.push(colorize(prep(inner), C.black));
  // Chrome lip ring.
  const lip = new THREE.LatheGeometry([new THREE.Vector2(rim * 0.84, hw - 0.01), new THREE.Vector2(rim * 1.02, hw - 0.004)], seg).rotateZ(-Math.PI / 2);
  chromeGeos.push(prep(lip, 1.2));
  if (st.hubcap) {
    const cap = new THREE.LatheGeometry(
      [new THREE.Vector2(rim * 0.92, hw - 0.01), new THREE.Vector2(rim * 0.7, hw + 0.02), new THREE.Vector2(rim * 0.3, hw + 0.04), new THREE.Vector2(0.0001, hw + 0.045)],
      10,
    ).rotateZ(-Math.PI / 2);
    chromeGeos.push(prep(cap, 1.2));
  } else {
    for (let i = 0; i < st.spokes; i++) {
      const a = (i / st.spokes) * Math.PI * 2;
      const len = rim * 0.78;
      const g = new THREE.BoxGeometry(0.03, len, Math.max(0.035, rim * 0.22));
      g.translate(0, rim * 0.2 + len / 2, 0);
      g.rotateZ(0); // radial in the YZ plane
      g.applyMatrix4(new THREE.Matrix4().makeRotationX(a));
      g.translate(hw - dish * 0.55, 0, 0);
      chromeGeos.push(prep(g));
    }
    chromeGeos.push(prep(cyl(rim * 0.22, 0.05, hw - dish * 0.45, 0, 0, 'x', 6)));
  }
  const tg = mergeGeometries(trimGeos, false)!;
  const cg = mergeGeometries(chromeGeos.map((g) => (g.deleteAttribute('color'), g)), false)!;
  trimGeos.forEach((g) => g.dispose());
  chromeGeos.forEach((g) => g.dispose());
  const group = new THREE.Group();
  const tm = new THREE.Mesh(tg, mats.trim);
  tm.castShadow = true;
  group.add(tm, new THREE.Mesh(cg, mats.chrome));
  if (ownTyre) {
    const ty = new THREE.Mesh(tyreGeo, mats.tyre);
    ty.castShadow = true;
    group.add(ty);
    return { group, geos: [tg, cg, tyreGeo] };
  }
  return { group, geos: [tg, cg] };
}

// ------------------------------------------------------------------ layout helpers

/** Ground height relative to the chassis collider centre when the car sits at rest (static sag). */
export function groundOffset(p: VehicleParams): number {
  return wheelCentreY(p) - p.wheelRadius;
}

/** Wheel centre height relative to the chassis centre at rest (front axle; `rear` adds the bigger-rear-wheel offset). */
export function wheelCentreY(p: VehicleParams, rear = false): number {
  const sag = Math.min(p.suspensionTravel, 9.81 / (4 * p.suspensionStiffness));
  const lift = rear ? (p.wheelRadiusRear ?? p.wheelRadius) - p.wheelRadius : 0;
  return p.wheelY + lift - (p.suspensionRest - sag);
}

export function triangleCount(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}
