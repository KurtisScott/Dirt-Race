import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash2 } from './noise';

/**
 * Low-poly procedural prop templates (vertex-coloured, no textures) and a spatial chunk merger that
 * bakes thousands of static props into a handful of meshes (one draw call per chunk, frustum-culled).
 */

export interface Template {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
  idx: Uint32Array;
}

/** Colour every vertex of a geometry, optionally jittered per vertex for a hand-painted look. */
export function paint(g: THREE.BufferGeometry, color: number, jitter = 0, seed = 1): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = 1 + (hash2(i, seed, 5) - 0.5) * jitter;
    arr[i * 3] = c.r * j;
    arr[i * 3 + 1] = c.g * j;
    arr[i * 3 + 2] = c.b * j;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  // Keep only position/normal/color so everything merges.
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'color') g.deleteAttribute(k);
  return g;
}

export function toTemplate(parts: THREE.BufferGeometry[], flat = false): Template {
  let g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)).map(prep), false)!;
  if (flat) {
    g.computeVertexNormals();
  } else {
    g = mergeVertices(g, 1e-4);
    g.computeVertexNormals();
  }
  const idx = g.index ? new Uint32Array(g.index.array) : new Uint32Array(Array.from({ length: g.attributes.position.count }, (_, i) => i));
  return {
    pos: new Float32Array(g.attributes.position.array),
    nrm: new Float32Array(g.attributes.normal.array),
    col: new Float32Array(g.attributes.color.array),
    idx,
  };
}

/** Displace vertices of a sphere-ish geometry with low-frequency noise (rocks, canopies). */
function lumpy(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // Same displacement for coincident vertices (non-indexed polyhedra): key by rounded position.
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + (hash2(Math.round(v.x * 100), Math.round(v.y * 100) * 7 + Math.round(v.z * 100), seed) - 0.5) * amount;
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  return g;
}

// ------------------------------------------------------------------ templates

export function treeTemplate(variant: number): Template {
  const trunk = paint(new THREE.CylinderGeometry(0.16, 0.26, 3.2, 6).translate(0, 1.6, 0), 0x6b4a2f, 0.15, 2);
  const greens = [0x4f7f2e, 0x5d8a34, 0x467a35, 0x6b8f2c];
  const parts = [trunk];
  const blobs = 3;
  for (let b = 0; b < blobs; b++) {
    const r = 1.7 - b * 0.25;
    const g = lumpy(new THREE.IcosahedronGeometry(r, 0), 0.3, variant * 10 + b);
    g.scale(1, 0.85, 1).translate((b - 0.8) * 0.7 * (variant % 2 ? 1 : 0.6), 3.4 + b * 0.9, (b % 2 ? 0.5 : -0.4));
    parts.push(paint(g, greens[(variant + b) % 4], 0.25, 3 + b));
  }
  return toTemplate(parts, true);
}

export function pineTemplate(variant: number): Template {
  const trunk = paint(new THREE.CylinderGeometry(0.12, 0.22, 2.0, 5).translate(0, 1.0, 0), 0x5a3e28, 0.1, 4);
  const parts = [trunk];
  const col = [0x2f5a2e, 0x355f33, 0x2b5230, 0x3b6634][variant % 4];
  const tiers = 3;
  for (let t = 0; t < tiers; t++) {
    const r = 1.9 - t * 0.5;
    const h = 2.4 - t * 0.35;
    parts.push(paint(new THREE.ConeGeometry(r, h, 7).translate(0, 2.0 + t * 1.35 + h / 2 - 0.4, 0), col, 0.2, 5 + t));
  }
  return toTemplate(parts, true);
}

export function bushTemplate(variant: number, desert: boolean): Template {
  const col = desert ? [0x8a8a4a, 0x7a7d48, 0x9a8d55, 0x6f7a45][variant % 4] : [0x4c7a2c, 0x5a8530, 0x416f2a, 0x6a8d33][variant % 4];
  const a = lumpy(new THREE.IcosahedronGeometry(0.8, 0), 0.4, 20 + variant).scale(1.2, 0.7, 1).translate(0, 0.4, 0);
  const b = lumpy(new THREE.IcosahedronGeometry(0.6, 0), 0.4, 30 + variant).scale(1, 0.7, 1).translate(0.6, 0.35, 0.3);
  return toTemplate([paint(a, col, 0.25, 7), paint(b, col, 0.3, 8)], true);
}

export function rockTemplate(variant: number, color = 0x8f877c): Template {
  const g = lumpy(new THREE.IcosahedronGeometry(1, variant === 2 ? 1 : 0), 0.45, 40 + variant);
  g.scale(1.2, 0.75, 1).translate(0, 0.25, 0);
  return toTemplate([paint(g, color, 0.22, 9 + variant)], true);
}

/** Grass tuft: 4 thin crossed blades, both windings (single-sided material, no flipped dark backs). */
export function tuftTemplate(variant: number): Template {
  const cols = [0x6f9e3c, 0x7fa845, 0x8ca64a];
  const pos: number[] = [];
  const col: number[] = [];
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI + variant * 0.7;
    const h = 0.32 + hash2(b, variant, 11) * 0.22;
    const w = 0.09;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const lx = 0.08 * sa;
    const lz = 0.08 * ca;
    const v0 = [-w * ca, 0, w * sa];
    const v1 = [w * ca, 0, -w * sa];
    const v2 = [lx, h, lz];
    const c = new THREE.Color(cols[(b + variant) % 3]);
    const base = c.clone().multiplyScalar(0.7);
    for (const tri of [[v0, v1, v2], [v1, v0, v2]]) {
      for (let k = 0; k < 3; k++) {
        pos.push(...tri[k]);
        const cc = k === 2 ? c : base;
        col.push(cc.r, cc.g, cc.b);
      }
    }
  }
  const n = pos.length / 3;
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1; // light like the ground
  return { pos: new Float32Array(pos), nrm, col: new Float32Array(col), idx: new Uint32Array(Array.from({ length: n }, (_, i) => i)) };
}

const HOUSE_COLORS = [0xe8dcc0, 0xc9d7e0, 0xe6c49a, 0xd8e2c4];
const ROOF_COLORS = [0x9c3b2e, 0x5b5f66, 0x7a4a2e, 0x8a3530];

/** Simple house (8 × 6 m footprint, door facing +Z). Variant 10 = big red barn with a silo. */
export function houseTemplate(variant: number): Template {
  if (variant >= 10) return barnTemplate();
  const W = 8;
  const D = 6;
  const H = 3.2;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(W, H, D).translate(0, H / 2, 0), HOUSE_COLORS[variant % 4], 0.04, 12));
  // Gable roof: a triangular prism.
  const roof = new THREE.CylinderGeometry(1, 1, W + 0.6, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6 + Math.PI);
  roof.scale(1, 1.0, (D / 2 + 0.5) / 0.866).translate(0, H + 0.5, 0);
  parts.push(paint(roof, ROOF_COLORS[variant % 4], 0.06, 13));
  // Door, windows, chimney.
  parts.push(paint(new THREE.BoxGeometry(1.1, 2.1, 0.1).translate(-1.6, 1.05, D / 2 + 0.03), 0x6b4226));
  for (const x of [1.2, 3.0]) parts.push(paint(new THREE.BoxGeometry(1.1, 1.0, 0.1).translate(x, 1.8, D / 2 + 0.03), 0x34495e));
  for (const x of [-2.5, 2.5]) parts.push(paint(new THREE.BoxGeometry(1.1, 1.0, 0.1).translate(x, 1.8, -D / 2 - 0.03), 0x34495e));
  parts.push(paint(new THREE.BoxGeometry(0.6, 1.6, 0.6).translate(2.4, H + 1.4, -0.8), 0x8b5a44));
  return toTemplate(parts, true);
}

function barnTemplate(): Template {
  const W = 9;
  const D = 7;
  const H = 4;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(W, H, D).translate(0, H / 2, 0), 0xa8322a, 0.05, 14));
  const roof = new THREE.CylinderGeometry(1, 1, W + 0.6, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6 + Math.PI);
  roof.scale(1, 1.3, (D / 2 + 0.5) / 0.866).translate(0, H + 0.65, 0);
  parts.push(paint(roof, 0x4f5358, 0.05, 15));
  parts.push(paint(new THREE.BoxGeometry(3.2, 3.2, 0.1).translate(0, 1.6, D / 2 + 0.03), 0xf2efe6));
  parts.push(paint(new THREE.BoxGeometry(2.8, 2.8, 0.12).translate(0, 1.6, D / 2 + 0.04), 0x8f2a23));
  parts.push(paint(new THREE.CylinderGeometry(1.6, 1.6, 9, 10).translate(W / 2 + 2.2, 4.5, -1), 0xb9bfc4, 0.05, 16));
  parts.push(paint(new THREE.SphereGeometry(1.6, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(W / 2 + 2.2, 9, -1), 0x9aa1a7));
  return toTemplate(parts, true);
}

/** One fence bay along +X from 0 to 1 (scaled to the bay length): post at x=0, two rails. */
export function fenceTemplate(): Template {
  const wood = 0x8a6a45;
  const parts = [
    paint(new THREE.BoxGeometry(0.14, 1.2, 0.14).translate(0, 0.6, 0), 0x6f5236, 0.1, 17),
    paint(new THREE.BoxGeometry(1, 0.12, 0.05).translate(0.5, 0.95, 0), wood, 0.1, 18),
    paint(new THREE.BoxGeometry(1, 0.12, 0.05).translate(0.5, 0.5, 0), wood, 0.1, 19),
  ];
  return toTemplate(parts, true);
}

/** Wooden jump ramp: wedge rising along +Z, origin at the leading edge, width 2·hw. */
export function rampTemplate(hw: number, len: number, h: number): Template {
  const g = new THREE.BufferGeometry();
  // prettier-ignore
  const v = [-hw,0,0, hw,0,0, -hw,0,len, hw,0,len, -hw,h,len, hw,h,len];
  // prettier-ignore
  const tris = [0,4,1, 1,4,5, 2,3,4, 3,5,4, 0,2,4, 1,5,3];
  const arr: number[] = [];
  for (const i of tris) arr.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  const parts = [paint(g, 0xa47a48, 0.1, 20)];
  // Plank stripes + yellow/black warning edge at the lip.
  for (let k = 1; k < 6; k++) {
    const z = (k / 6) * len;
    const y = (z / len) * h + 0.02;
    const ang = Math.atan2(h, len);
    parts.push(paint(new THREE.BoxGeometry(hw * 2, 0.03, 0.08).rotateX(-ang).translate(0, y, z), 0x7c5a33));
  }
  for (let k = 0; k < 8; k++) {
    const x = -hw + (k + 0.5) * ((hw * 2) / 8);
    parts.push(paint(new THREE.BoxGeometry((hw * 2) / 8, 0.25, 0.06).translate(x, h - 0.12, len + 0.03), k % 2 ? 0x222222 : 0xf2c12e));
  }
  return toTemplate(parts, true);
}

/** Log bridge: deck of logs across +Z (travel direction = Z), with sloped ends and side rails. */
export function bridgeTemplate(len: number, hw: number, rise: number, rampLen: number): Template {
  const parts: THREE.BufferGeometry[] = [];
  const logR = 0.17;
  const n = Math.floor(len / (logR * 2.05));
  for (let k = 0; k < n; k++) {
    const z = -len / 2 + (k + 0.5) * (len / n);
    const az = Math.abs(z);
    const y = az > len / 2 - rampLen ? rise * (1 - (az - (len / 2 - rampLen)) / rampLen) : rise;
    parts.push(paint(new THREE.CylinderGeometry(logR, logR, hw * 2 + 0.3, 7).rotateZ(Math.PI / 2).translate(0, y - logR, z), [0x7a5634, 0x6c4b2d, 0x85603a][k % 3], 0.1, 21 + k));
  }
  // Two big support logs underneath and rails.
  for (const sx of [-1, 1]) {
    parts.push(paint(new THREE.CylinderGeometry(0.3, 0.3, len - rampLen, 8).rotateX(Math.PI / 2).translate(sx * (hw - 0.4), rise - 0.6, 0), 0x5e4128));
    parts.push(paint(new THREE.CylinderGeometry(0.1, 0.1, len - rampLen * 2, 6).rotateX(Math.PI / 2).translate(sx * (hw + 0.1), rise + 0.85, 0), 0x6b4a2f));
    for (let k = 0; k <= 4; k++) {
      const z = -(len / 2 - rampLen) + (k / 4) * (len - rampLen * 2);
      parts.push(paint(new THREE.CylinderGeometry(0.1, 0.12, 1.4, 6).translate(sx * (hw + 0.1), rise + 0.3, z), 0x5a3e28));
    }
  }
  return toTemplate(parts, true);
}

// ------------------------------------------------------------------ chunk merger

interface ChunkBuf {
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
}

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Accumulates transformed templates into grid chunks; `build()` returns one mesh per chunk. */
export class ChunkMerger {
  private chunks = new Map<string, ChunkBuf>();
  constructor(private size: number) {}

  add(t: Template, x: number, y: number, z: number, yaw: number, scale: number | THREE.Vector3, tint = 1, matrix?: THREE.Matrix4): void {
    const key = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { pos: [], nrm: [], col: [], idx: [] };
      this.chunks.set(key, c);
    }
    if (matrix) _m.copy(matrix);
    else {
      _q.setFromAxisAngle(UP, yaw);
      if (typeof scale === 'number') _s.setScalar(scale);
      else _s.copy(scale);
      _m.compose(_p.set(x, y, z), _q, _s);
    }
    _nm.getNormalMatrix(_m);
    const base = c.pos.length / 3;
    const n = t.pos.length / 3;
    for (let i = 0; i < n; i++) {
      _v.set(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]).applyMatrix4(_m);
      c.pos.push(_v.x, _v.y, _v.z);
      _v.set(t.nrm[i * 3], t.nrm[i * 3 + 1], t.nrm[i * 3 + 2]).applyMatrix3(_nm).normalize();
      c.nrm.push(_v.x, _v.y, _v.z);
      c.col.push(t.col[i * 3] * tint, t.col[i * 3 + 1] * tint, t.col[i * 3 + 2] * tint);
    }
    for (let i = 0; i < t.idx.length; i++) c.idx.push(t.idx[i] + base);
  }

  build(material: THREE.Material, castShadow: boolean): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const c of this.chunks.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(c.nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
      g.setIndex(c.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(c.idx, 1) : new THREE.Uint16BufferAttribute(c.idx, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, material);
      m.castShadow = castShadow;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      out.push(m);
    }
    this.chunks.clear();
    return out;
  }
}
