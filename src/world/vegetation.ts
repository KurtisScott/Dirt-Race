import * as THREE from 'three';
import { hash2, valueNoise } from './noise';
import type { PBRSet } from './pbrTextures';
import { paint, tagMat, toTemplate, type Template } from './props';

/**
 * Round 2 realistic props for High/Ultra (Low/Medium keep the classic low-poly templates in props.ts):
 *
 *  - Trees, pines, snowy pines and bushes with layered alpha-tested foliage cards (a procedural leaf /
 *    needle atlas drawn once on a canvas), spherical "volume" normals so crowns shade softly, darker
 *    inner/lower leaves, and wind sway in the vertex shader (`aWind` weight).
 *  - Trunks and branches with a bark shader; noise-displaced, smooth-shaded boulders and rocks that use
 *    the terrain's rock textures (triplanar) so they sit in the landscape.
 *  - One "uber" PBR prop material: per-vertex surface id `aMat` picks roughness / metalness / detail
 *    (rock, bark, painted wood, roof metal, window glass, snow, glossy paint).
 */
export const PROP_MAT = { matte: 0, rock: 1, bark: 2, roof: 3, wood: 4, glass: 5, snow: 6, gloss: 7 } as const;

/** Shared wind clock (seconds) for every swaying material. RaceCourse advances it. */
export const windTime = { value: 0 };

// ------------------------------------------------------------------ foliage atlas

/**
 * 1024² RGBA atlas, 2×2 cells: [0,0] broadleaf cluster, [1,0] pine spray, [0,1] snowy pine spray,
 * [1,1] small-leaf bush cluster. Drawn with Canvas 2D (no downloads). Null without a DOM (tests).
 */
export function makeFoliageAtlas(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const S = 1024;
  const C = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, S, S);
  let seed = 1;
  const rnd = (): number => hash2(seed++, 7, 77);
  const leaf = (x: number, y: number, len: number, wid: number, ang: number, col: string, vein: string | null): void => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(len * 0.45, -wid, len, 0);
    g.quadraticCurveTo(len * 0.45, wid, 0, 0);
    g.fillStyle = col;
    g.fill();
    if (vein) {
      g.strokeStyle = vein;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(len * 0.9, 0);
      g.stroke();
    }
    g.restore();
  };
  const hsl = (h: number, s: number, l: number): string => `hsl(${h.toFixed(0)},${s.toFixed(0)}%,${l.toFixed(0)}%)`;

  // Cell 0: broadleaf cluster — twigs, then ~1100 small leaves in 8 sub-clumps (irregular outline),
  // lighter toward the top of each clump, darker in the middle.
  {
    const ox = 0;
    const oy = 0;
    g.strokeStyle = '#4a3624';
    for (let k = 0; k < 7; k++) {
      g.lineWidth = 2 + rnd() * 3;
      g.beginPath();
      g.moveTo(ox + C / 2, oy + C * 0.98);
      g.quadraticCurveTo(ox + C / 2 + (rnd() - 0.5) * 120, oy + C * 0.6, ox + C * (0.2 + rnd() * 0.6), oy + C * (0.2 + rnd() * 0.45));
      g.stroke();
    }
    const subs: [number, number, number, number][] = [];
    for (let k = 0; k < 8; k++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * C * 0.22;
      subs.push([ox + C / 2 + Math.cos(a) * r, oy + C * 0.46 + Math.sin(a) * r * 0.85, C * (0.14 + rnd() * 0.09), rnd()]);
    }
    for (let k = 0; k < 1500; k++) {
      const sc = subs[k % subs.length];
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * sc[2];
      const x = sc[0] + Math.cos(a) * r;
      const y = sc[1] + Math.sin(a) * r;
      const topK = 1 - (y - (sc[1] - sc[2])) / (2 * sc[2]);
      const l = 20 + topK * 18 + rnd() * 9 + sc[3] * 6 - (r / sc[2] < 0.5 ? 4 : 0);
      leaf(x, y, 15 + rnd() * 12, 6 + rnd() * 4, rnd() * Math.PI * 2, hsl(78 + rnd() * 30 + sc[3] * 10, 38 + rnd() * 20, l), null);
    }
  }
  // Pine spray (cells 1 and 2): a twig along the cell with needles both sides; snowy variant adds clumps.
  const spray = (ox: number, oy: number, snowy: boolean): void => {
    for (let b = 0; b < 3; b++) {
      const y0 = oy + C * (0.25 + b * 0.25);
      // Dense inner mass (keeps the spray solid in the small mip levels, where thin needles vanish).
      for (let k = 0; k < 70; k++) {
        const t = rnd();
        const x = ox + 10 + t * (C - 40);
        const y = y0 + t * t * 28 + 18 + (rnd() - 0.5) * 20;
        g.fillStyle = hsl(128 + rnd() * 20, 34, 20 + rnd() * 8);
        g.beginPath();
        g.ellipse(x, y, (1 - t * 0.6) * 34 + 8, (1 - t * 0.6) * 26 + 6, 0.25, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = '#3d2b1c';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(ox + 4, y0);
      g.quadraticCurveTo(ox + C * 0.5, y0 + 10, ox + C - 10, y0 + 28);
      g.stroke();
      for (let k = 0; k < 260; k++) {
        const t = rnd();
        const x = ox + 6 + t * (C - 20);
        const y = y0 + t * t * 28 + (rnd() - 0.5) * 6;
        const side = rnd() < 0.5 ? -1 : 1;
        const len = (70 - t * 40) * (0.7 + rnd() * 0.5);
        const ang = side * (0.9 + rnd() * 0.5) + 0.35;
        g.strokeStyle = hsl(118 + rnd() * 30, 32 + rnd() * 18, 22 + rnd() * 16 + (side < 0 ? 8 : 0));
        g.lineWidth = 3 + rnd() * 2;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len);
        g.stroke();
      }
      if (snowy) {
        for (let k = 0; k < 40; k++) {
          const t = rnd();
          const x = ox + 10 + t * (C - 30);
          const y = y0 - 18 + t * t * 28 + rnd() * 10;
          g.fillStyle = hsl(210, 30, 90 + rnd() * 8);
          g.beginPath();
          g.ellipse(x, y, 16 + rnd() * 22, 8 + rnd() * 9, 0.1, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  };
  spray(C, 0, false);
  spray(0, C, true);
  // Cell 3: bush — small rounded leaves.
  {
    const ox = C;
    const oy = C;
    for (let k = 0; k < 700; k++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * C * 0.46;
      const x = ox + C / 2 + Math.cos(a) * r;
      const y = oy + C * 0.5 + Math.sin(a) * r * 0.85;
      const top = 1 - (y - oy) / C;
      leaf(x, y, 18 + rnd() * 12, 8 + rnd() * 5, rnd() * Math.PI * 2, hsl(78 + rnd() * 30, 36 + rnd() * 18, 18 + top * 16 + rnd() * 10), null);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false; // atlas cells are addressed top-left = (0, 0)
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.name = 'foliage-atlas';
  return tex;
}

// ------------------------------------------------------------------ card geometry

interface CardBuf {
  pos: number[];
  nrm: number[];
  col: number[];
  uv: number[];
  wind: number[];
  idx: number[];
}
const newBuf = (): CardBuf => ({ pos: [], nrm: [], col: [], uv: [], wind: [], idx: [] });
const CELLS: Record<'leaf' | 'pine' | 'snowpine' | 'bush', [number, number]> = { leaf: [0, 0], pine: [0.5, 0], snowpine: [0, 0.5], bush: [0.5, 0.5] };

/**
 * One textured quad: centre `c`, half-extent axes `ax`/`ay`, atlas cell, tint, wind weight per corner
 * (from height), normals pointing away from `centre` (crown volume) mixed with `up`.
 */
function card(b: CardBuf, c: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, cell: [number, number], tint: THREE.Color, crown: THREE.Vector3, windBase: number, windH: number, up = 0.35): void {
  const base = b.pos.length / 3;
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const [sx, sy] of corners) {
    v.copy(c).addScaledVector(ax, sx).addScaledVector(ay, sy);
    b.pos.push(v.x, v.y, v.z);
    n.copy(v).sub(crown).normalize();
    n.y += up;
    n.normalize();
    b.nrm.push(n.x, n.y, n.z);
    // Darker toward the inside / bottom of the crown (cheap ambient occlusion).
    const occ = THREE.MathUtils.clamp(0.62 + 0.38 * (v.y - crown.y) / Math.max(0.5, windH) + 0.15, 0.45, 1.1);
    b.col.push(tint.r * occ, tint.g * occ, tint.b * occ);
    b.uv.push(cell[0] + (sx * 0.5 + 0.5) * 0.5, cell[1] + (sy * 0.5 + 0.5) * 0.5);
    b.wind.push(THREE.MathUtils.clamp(windBase + Math.max(0, v.y) / Math.max(1, windH) * 0.8, 0, 1));
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function bufToTemplate(b: CardBuf): Template {
  const n = b.pos.length / 3;
  return {
    pos: new Float32Array(b.pos),
    nrm: new Float32Array(b.nrm),
    col: new Float32Array(b.col),
    idx: new Uint32Array(b.idx),
    uv: new Float32Array(b.uv),
    wind: new Float32Array(b.wind),
    mat: new Float32Array(n),
  };
}

const rand = (v: number, k: number, s: number): number => hash2(v * 131 + k, s, 91);
const randomAxes = (v: number, k: number, size: number, ax: THREE.Vector3, ay: THREE.Vector3): void => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(v, k, 1) * Math.PI * 2, rand(v, k, 2) * Math.PI * 2, rand(v, k, 3) * Math.PI * 2));
  ax.set(size, 0, 0).applyQuaternion(q);
  ay.set(0, size, 0).applyQuaternion(q);
};

/** Tapered, slightly bent wood cylinder from a to b (bark surface id). */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, color: number, seg = 7): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 3, true).translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q).translate(a.x, a.y, a.z);
  return tagMat(paint(g, color, 0.12, Math.round(len * 100)), PROP_MAT.bark);
}

/** Broadleaf tree: trunk + branches (wood template) and ~40 leaf cards (foliage template). */
export function broadleafHQ(variant: number): { wood: Template; leaves: Template } {
  const th = 2.4 + rand(variant, 0, 4) * 1.1;
  const lean = new THREE.Vector3((rand(variant, 0, 5) - 0.5) * 0.4, 0, (rand(variant, 0, 6) - 0.5) * 0.4);
  const top = new THREE.Vector3(0, th, 0).add(lean);
  const wood = [limb(new THREE.Vector3(0, -0.3, 0), top, 0.3, 0.2, 0x5c4532, 8)];
  const crown = top.clone().add(new THREE.Vector3(0, 1.7, 0));
  const R = new THREE.Vector3(2.3 + rand(variant, 1, 7) * 0.7, 1.9 + rand(variant, 1, 8) * 0.5, 2.3 + rand(variant, 1, 9) * 0.7);
  const ends: THREE.Vector3[] = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rand(variant, k, 10);
    const e = crown.clone().add(new THREE.Vector3(Math.cos(a) * R.x * 0.65, (rand(variant, k, 11) - 0.2) * R.y * 0.8, Math.sin(a) * R.z * 0.65));
    wood.push(limb(top.clone().add(new THREE.Vector3(0, -0.3 - k * 0.15, 0)), e, 0.13, 0.05, 0x5c4532, 5));
    ends.push(e);
  }
  const b = newBuf();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const greens = [0x8fbf52, 0x7fb04a, 0x9cc65a, 0x86b24e];
  const tint = new THREE.Color();
  let k = 0;
  // Clusters on and inside the crown ellipsoid (+ at branch ends).
  const clusters: THREE.Vector3[] = [...ends];
  for (let i = 0; i < 22; i++) {
    const u = rand(variant, i, 12) * Math.PI * 2;
    const w = Math.acos(rand(variant, i, 13) * 1.6 - 0.6);
    const r = 0.55 + 0.4 * rand(variant, i, 14);
    clusters.push(crown.clone().add(new THREE.Vector3(Math.sin(w) * Math.cos(u) * R.x * r, Math.cos(w) * R.y * r, Math.sin(w) * Math.sin(u) * R.z * r)));
  }
  for (const cl of clusters) {
    for (let j = 0; j < 3; j++, k++) {
      const size = 1.0 + rand(variant, k, 15) * 0.5;
      randomAxes(variant, k, size, ax, ay);
      tint.set(greens[(variant + k) % 4]).multiplyScalar(0.9 + rand(variant, k, 16) * 0.25);
      card(b, cl.clone().add(new THREE.Vector3((rand(variant, k, 17) - 0.5) * 0.6, (rand(variant, k, 18) - 0.5) * 0.4, (rand(variant, k, 19) - 0.5) * 0.6)), ax, ay, CELLS.leaf, tint, crown, 0.15, th + R.y * 2);
    }
  }
  return { wood: toTemplate(wood, false, true), leaves: bufToTemplate(b) };
}

/** Conifer: tall trunk + tiers of drooping needle-spray cards radiating from the trunk. */
export function pineHQ(variant: number, snowy: boolean): { wood: Template; leaves: Template } {
  const H = 7 + rand(variant, 0, 21) * 2.5;
  const wood = [limb(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, H, 0), 0.26, 0.05, 0x4d3a2a, 7)];
  const b = newBuf();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const tint = new THREE.Color();
  // The needle atlas is dark (real conifer albedo ≈ 0.05–0.08): the tint must stay bright or pines read as
  // black silhouettes under the sky light.
  const base = snowy ? 0xc4d4c8 : [0xc6e2b0, 0xd0e8b8, 0xbcdba6, 0xd8eec4][variant % 4];
  const crown = new THREE.Vector3(0, H * 0.55, 0);
  const tiers = 9;
  let k = 0;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = 1.6 + f * (H - 2.2);
    const reach = (1 - f) * 2.3 + 0.45;
    const n = 8 - Math.floor(f * 3);
    for (let i = 0; i < n; i++, k++) {
      const a = (i / n) * Math.PI * 2 + t * 0.7 + rand(variant, k, 22) * 0.5;
      const dir = new THREE.Vector3(Math.cos(a), -0.32 - rand(variant, k, 23) * 0.15, Math.sin(a)).normalize();
      const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      // Card spans from the trunk outward (ax along the branch), ay across, tilted a little.
      ax.copy(dir).multiplyScalar(reach * 0.5);
      ay.copy(side).multiplyScalar(reach * 0.42 + 0.3).addScaledVector(new THREE.Vector3(0, 1, 0), 0.18);
      const c = new THREE.Vector3(0, y, 0).addScaledVector(dir, reach * 0.5);
      tint.set(base).multiplyScalar(0.85 + rand(variant, k, 24) * 0.3);
      card(b, c, ax, ay, snowy ? CELLS.snowpine : CELLS.pine, tint, crown, 0.05, H, 0.6);
    }
  }
  // Pointed top.
  for (let i = 0; i < 2; i++) {
    ax.set(Math.cos(i * 1.57) * 0.35, 0, Math.sin(i * 1.57) * 0.35);
    ay.set(0, 0.9, 0);
    tint.set(base);
    card(b, new THREE.Vector3(0, H - 0.2, 0), ax, ay, snowy ? CELLS.snowpine : CELLS.pine, tint, crown, 0.2, H, 0.3);
  }
  return { wood: toTemplate(wood, false, true), leaves: bufToTemplate(b) };
}

/** Bush: ~8 bush-cell cards around a low dome. */
export function bushHQ(variant: number, desert: boolean): Template {
  const b = newBuf();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const tint = new THREE.Color();
  const crown = new THREE.Vector3(0, 0.45, 0);
  for (let k = 0; k < 9; k++) {
    const a = rand(variant, k, 31) * Math.PI * 2;
    const r = rand(variant, k, 32) * 0.55;
    randomAxes(variant, k + 50, 0.55 + rand(variant, k, 33) * 0.3, ax, ay);
    tint.set(desert ? 0xc9c48a : [0x8cbc58, 0x7cae50, 0x98c462][k % 3]).multiplyScalar(0.85 + rand(variant, k, 34) * 0.3);
    card(b, new THREE.Vector3(Math.cos(a) * r, 0.45 + rand(variant, k, 35) * 0.35, Math.sin(a) * r), ax, ay, CELLS.bush, tint, crown, 0.1, 1.2, 0.5);
  }
  return bufToTemplate(b);
}

/** Smooth, noise-displaced boulder (rock surface id → terrain rock texture, triplanar). */
export function rockHQ(variant: number, color: number): Template {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const sd = variant * 17 + 3;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n1 = valueNoise(v.x * 1.3 + sd, v.z * 1.3 + v.y * 0.7, sd);
    const n2 = valueNoise(v.x * 3.1 - v.y, v.z * 3.1 + sd, sd + 1);
    const n3 = valueNoise(v.y * 6 + sd, v.x * 6 - v.z, sd + 2);
    // Flattened facets (rocks break along planes) + lumps.
    let k = 1 + n1 * 0.28 + n2 * 0.12 + n3 * 0.04;
    k = Math.round(k * 7) / 7 * 0.35 + k * 0.65;
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.scale(1.25, 0.72, 1).translate(0, 0.22, 0);
  const t = toTemplate([tagMat(paint(g, color, 0.1, 40 + variant), PROP_MAT.rock)], false, true);
  return t;
}

/** Re-tag a classic template's vertices by colour for the PBR prop shader (houses, barns, ramps, bridges). */
export function classifyMats(t: Template, rule: (r: number, g: number, b: number) => number): Template {
  const n = t.pos.length / 3;
  const mat = new Float32Array(n);
  for (let i = 0; i < n; i++) mat[i] = rule(t.col[i * 3], t.col[i * 3 + 1], t.col[i * 3 + 2]);
  return { ...t, uv: new Float32Array(n * 2), wind: new Float32Array(n), mat };
}

// ------------------------------------------------------------------ materials

/**
 * The PBR prop material (High/Ultra). `aMat` picks the surface; rocks sample the terrain's rock layers
 * triplanar (grey rock, or red sandstone for reddish vertex colours) when the texture set is loaded.
 */
export function makePropMaterial(set: PBRSet | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.name = 'props-pbr';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uAlb = { value: set?.albedo ?? null };
    sh.uniforms.uNH = { value: set?.nh ?? null };
    sh.uniforms.uTime = windTime;
    if (set) sh.defines = { ...(sh.defines ?? {}), ROCK_TEX: 1 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n attribute float aMat; attribute float aWind; varying float vMat; varying vec3 vPPos; varying vec3 vPNrm; uniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vMat = aMat;
        vPPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vPNrm = normalize(mat3(modelMatrix) * normal);
        if (aWind > 0.0) {
          float ph = vPPos.x * 0.21 + vPPos.z * 0.17;
          transformed.xz += vec2(sin(uTime * 1.3 + ph), cos(uTime * 1.1 + ph * 1.3)) * aWind * 0.05;
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vMat; varying vec3 vPPos; varying vec3 vPNrm;
        #ifdef ROCK_TEX
        precision highp sampler2DArray;
        uniform sampler2DArray uAlb; uniform sampler2DArray uNH;
        #endif
        float pRough; float pMetal; vec3 pNrmW; float pHasN;
        float ph21(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
        float pvn(vec2 p) { vec2 i = floor(p); vec2 g = fract(p); g = g * g * (3.0 - 2.0 * g);
          return mix(mix(ph21(i), ph21(i + vec2(1, 0)), g.x), mix(ph21(i + vec2(0, 1)), ph21(i + vec2(1, 1)), g.x), g.y); }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          int id = int(vMat + 0.5);
          pRough = 0.85; pMetal = 0.0; pHasN = 0.0; pNrmW = normalize(vPNrm);
          vec3 N = pNrmW;
          if (id == 1) {
            #ifdef ROCK_TEX
            float layer = (diffuseColor.r > diffuseColor.g * 1.25) ? 10.0 : 5.0;
            vec3 an = abs(N) + 1e-3; an /= an.x + an.y + an.z;
            float sc = 1.0 / 3.0;
            vec3 a = texture(uAlb, vec3(vPPos.zy * sc, layer)).rgb * an.x + texture(uAlb, vec3(vPPos.xz * sc, layer)).rgb * an.y + texture(uAlb, vec3(vPPos.xy * sc, layer)).rgb * an.z;
            vec2 nx = texture(uNH, vec3(vPPos.zy * sc, layer)).rg * 2.0 - 1.0;
            vec2 ny = texture(uNH, vec3(vPPos.xz * sc, layer)).rg * 2.0 - 1.0;
            vec2 nz = texture(uNH, vec3(vPPos.xy * sc, layer)).rg * 2.0 - 1.0;
            // Whiteout blend of the three projections.
            vec3 n = normalize(vec3(0.0, nx.y, nx.x) * an.x * sign(N.x) + vec3(ny.x, 0.0, ny.y) * an.y + vec3(nz.x, nz.y, 0.0) * an.z * sign(N.z));
            pNrmW = normalize(N + n * 1.1);
            diffuseColor.rgb = a * clamp(dot(diffuseColor.rgb, vec3(0.333)) / 0.27, 0.8, 1.25);
            // Moss / dust on the upward faces.
            float up = smoothstep(0.55, 0.95, N.y) * pvn(vPPos.xz * 1.7);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.85, 0.95, 0.7), up * 0.5);
            #else
            diffuseColor.rgb *= 0.85 + 0.3 * pvn(vPPos.xz * 3.0 + vPPos.y * 2.0);
            #endif
            pRough = 0.82;
          } else if (id == 2) {
            // Bark: vertical fibres and ridges.
            float a = atan(vPNrm.z, vPNrm.x);
            float f = pvn(vec2(a * 6.0, vPPos.y * 1.2)) * 0.6 + pvn(vec2(a * 18.0, vPPos.y * 4.0)) * 0.4;
            diffuseColor.rgb *= 0.65 + 0.55 * f;
            pRough = 0.95;
          } else if (id == 3) { pRough = 0.5; pMetal = 0.35; diffuseColor.rgb *= 0.9 + 0.15 * step(0.5, fract(vPPos.y * 3.0 + vPPos.x * 0.02)); }
          else if (id == 4) {
            // Painted boards / plaster: faint horizontal planks + grime near the ground.
            diffuseColor.rgb *= 0.92 + 0.08 * smoothstep(0.0, 0.08, fract(vPPos.y * 4.0));
            diffuseColor.rgb *= 0.9 + 0.2 * pvn(vPPos.xz * 1.3 + vPPos.y * 0.5);
            pRough = 0.78;
          }
          else if (id == 5) { pRough = 0.06; pMetal = 0.6; diffuseColor.rgb *= 0.35; }
          else if (id == 6) { pRough = 0.6; }
          else if (id == 7) { pRough = 0.35; }
          else { diffuseColor.rgb *= 0.92 + 0.12 * pvn(vPPos.xz * 2.0 + vPPos.y); }
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = pRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = pMetal;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(pNrmW, 0.0)).xyz);');
  };
  mat.customProgramCacheKey = () => `dirt-race-props-pbr-v1-${set ? 1 : 0}`;
  return mat;
}

/** Foliage cards: alpha-tested atlas, two-sided with un-flipped volume normals, wind sway, soft translucency. */
export function makeFoliageMaterial(atlas: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 });
  mat.name = 'foliage';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n attribute float aWind; uniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
          float ph = wp.x * 0.23 + wp.z * 0.19;
          float gust = 0.6 + 0.4 * sin(uTime * 0.37 + wp.x * 0.01);
          transformed.xz += vec2(sin(uTime * 1.7 + ph), cos(uTime * 1.3 + ph * 1.4)) * aWind * 0.12 * gust;
          transformed.y += sin(uTime * 2.3 + ph * 2.0) * aWind * 0.04;
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize( vNormal );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.12;');
  };
  mat.customProgramCacheKey = () => 'dirt-race-foliage-v1';
  return mat;
}

// ------------------------------------------------------------------ tier swap for small dynamic things

const twins = new WeakMap<THREE.Material, THREE.Material>();

/**
 * Round 2: give the low-poly dynamic objects (animals, hay bales, cones) proper PBR materials on
 * High/Ultra without touching their geometry: each Lambert material gets a cached Standard/Physical
 * twin chosen by the mesh's `userData.surface` ('fur' → sheen + fine strand noise, 'hay' → straw
 * fibres, 'plastic' → satin). `pbr = false` restores the originals.
 */
export function tierSwap(root: THREE.Object3D, pbr: boolean): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    if (!pbr) {
      if (m.userData.classicMat) m.material = m.userData.classicMat as THREE.Material;
      return;
    }
    const classic = (m.userData.classicMat as THREE.Material | undefined) ?? m.material;
    if (!(classic as THREE.MeshLambertMaterial).isMeshLambertMaterial) return;
    let twin = twins.get(classic);
    if (!twin) {
      twin = makeTwin(classic as THREE.MeshLambertMaterial, (m.userData.surface as string | undefined) ?? 'matte');
      twins.set(classic, twin);
    }
    m.userData.classicMat = classic;
    m.material = twin;
  });
}

function makeTwin(src: THREE.MeshLambertMaterial, surface: string): THREE.Material {
  const base = { vertexColors: src.vertexColors, color: src.color.clone(), map: src.map, side: src.side, transparent: src.transparent, opacity: src.opacity };
  if (surface === 'fur') {
    const m = new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.92, metalness: 0, sheen: 0.6, sheenRoughness: 0.75, sheenColor: new THREE.Color(0.55, 0.5, 0.42) });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n varying vec3 vFurP;').replace('#include <begin_vertex>', '#include <begin_vertex>\n vFurP = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n varying vec3 vFurP;\n float fh(vec3 p){ p = fract(p * vec3(443.9, 441.4, 437.2)); p += dot(p, p.yzx + 19.19); return fract((p.x + p.y) * p.z); }')
        .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= 0.82 + 0.3 * fh(floor(vFurP * vec3(60.0, 160.0, 60.0)));');
    };
    m.customProgramCacheKey = () => 'dirt-race-fur-v1';
    m.name = `${src.name || 'animal'}-fur`;
    return m;
  }
  const m = new THREE.MeshStandardMaterial({ ...base, roughness: surface === 'plastic' ? 0.42 : surface === 'hay' ? 0.95 : 0.8, metalness: 0 });
  if (surface === 'hay') {
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n varying vec3 vHayP;').replace('#include <begin_vertex>', '#include <begin_vertex>\n vHayP = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n varying vec3 vHayP;\n float hh(vec2 p){ p = fract(p * vec2(233.3, 851.7)); p += dot(p, p + 23.4); return fract(p.x * p.y); }')
        .replace('#include <color_fragment>', '#include <color_fragment>\n { float a = atan(vHayP.z, vHayP.y); float f = hh(floor(vec2(a * 40.0, vHayP.x * 6.0))) * 0.6 + hh(floor(vec2(a * 120.0, vHayP.x * 30.0))) * 0.4; diffuseColor.rgb *= 0.7 + 0.5 * f; }');
    };
    m.customProgramCacheKey = () => 'dirt-race-hay-v1';
  }
  m.name = `${src.name || 'prop'}-${surface}`;
  return m;
}
