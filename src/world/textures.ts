import * as THREE from 'three';
import { fbm, hash2, valueNoise, worley } from './noise';

/**
 * Procedural textures, generated into typed arrays (no canvas, no downloads, works headless).
 * Terrain layers go into one DataArrayTexture so the terrain shader blends them in a single draw call.
 */

type RGB = [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Fill an RGBA buffer by calling f(u, v) (u, v in lattice units 0..P) for every pixel. */
function fill(size: number, data: Uint8Array, offset: number, f: (x: number, y: number, out: RGB) => void): void {
  const c: RGB = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      f(x / size, y / size, c);
      const i = offset + (y * size + x) * 4;
      data[i] = clamp255(c[0]);
      data[i + 1] = clamp255(c[1]);
      data[i + 2] = clamp255(c[2]);
      data[i + 3] = 255;
    }
  }
}

const tn = (u: number, v: number, cells: number, oct: number, seed: number): number => fbm(u * cells, v * cells, oct, seed, cells);

const LAYER_FNS: ((u: number, v: number, o: RGB, px: number) => void)[] = [
  // 0 grass
  (u, v, o, px) => {
    const n = tn(u, v, 4, 3, 1);
    const blade = hash2(Math.floor(u * px), Math.floor(v * px * 0.5), 3);
    const dry = Math.max(0, tn(u, v, 3, 2, 7)) * 1.4;
    const k = 0.85 + n * 0.22 + (blade - 0.5) * 0.28;
    o[0] = (78 + dry * 40) * k;
    o[1] = (118 + dry * 18) * k;
    o[2] = (46 + dry * 6) * k;
  },
  // 1 dirt road
  (u, v, o) => {
    const n = tn(u, v, 6, 4, 11);
    const w = worley(u * 24, v * 24, 24, 5);
    const pebble = w.f1 < 0.22 ? 0.12 * (1 - w.f1 / 0.22) * (w.id - 0.3) : 0;
    const k = 1 + n * 0.18 + pebble;
    o[0] = 142 * k;
    o[1] = 108 * k;
    o[2] = 74 * k;
  },
  // 2 gravel
  (u, v, o) => {
    const w = worley(u * 40, v * 40, 40, 9);
    const edge = Math.min(1, (w.f2 - w.f1) * 4);
    const tint = w.id;
    const n = tn(u, v, 5, 2, 13);
    const k = (0.62 + 0.38 * edge) * (0.9 + tint * 0.22) * (1 + n * 0.12);
    o[0] = 160 * k;
    o[1] = 150 * k;
    o[2] = 136 * k;
  },
  // 3 mud
  (u, v, o) => {
    const n = tn(u, v, 5, 4, 17);
    const wet = Math.max(0, tn(u, v, 3, 2, 19));
    const ridge = Math.abs(valueNoise(u * 18, v * 18, 23, 18));
    const k = 0.9 + n * 0.2 - ridge * 0.12 + wet * 0.35;
    o[0] = 92 * k;
    o[1] = 68 * k;
    o[2] = 44 * k;
  },
  // 4 sand (wind ripples)
  (u, v, o) => {
    const n = tn(u, v, 4, 3, 29);
    const rip = Math.sin((v * 22 + tn(u, v, 2, 2, 31) * 1.5) * Math.PI * 2) * 0.5 + 0.5;
    const grain = hash2(Math.floor(u * 512), Math.floor(v * 512), 33) - 0.5;
    const k = 0.95 + n * 0.1 + rip * 0.07 + grain * 0.08;
    o[0] = 226 * k;
    o[1] = 196 * k;
    o[2] = 142 * k;
  },
  // 5 rock
  (u, v, o) => {
    const w = worley(u * 7, v * 7, 7, 41);
    const crack = Math.min(1, (w.f2 - w.f1) * 6);
    const n = tn(u, v, 6, 4, 43);
    const k = (0.75 + 0.25 * crack) * (0.9 + n * 0.25) * (0.9 + w.id * 0.2);
    o[0] = 138 * k;
    o[1] = 132 * k;
    o[2] = 124 * k;
  },
  // 6 river bed (wet pebbles, a bit green)
  (u, v, o) => {
    const w = worley(u * 26, v * 26, 26, 51);
    const edge = Math.min(1, (w.f2 - w.f1) * 4);
    const algae = Math.max(0, tn(u, v, 3, 2, 53));
    const k = (0.55 + 0.45 * edge) * (0.85 + w.id * 0.3);
    o[0] = (104 - algae * 30) * k;
    o[1] = (96 + algae * 10) * k;
    o[2] = (78 - algae * 10) * k;
  },
  // 7 field / dry grass
  (u, v, o, px) => {
    const n = tn(u, v, 4, 3, 61);
    const blade = hash2(Math.floor(u * px * 0.5), Math.floor(v * px), 63);
    const k = 0.88 + n * 0.18 + (blade - 0.5) * 0.3;
    o[0] = 160 * k;
    o[1] = 150 * k;
    o[2] = 74 * k;
  },
];

export const TERRAIN_LAYER_COUNT = LAYER_FNS.length;

/** The 8 terrain layers as one sRGB DataArrayTexture (mipmapped, repeat-wrapped). */
export function makeTerrainLayers(size: number): THREE.DataArrayTexture {
  const n = LAYER_FNS.length;
  const data = new Uint8Array(size * size * 4 * n);
  for (let l = 0; l < n; l++) {
    const fn = LAYER_FNS[l];
    fill(size, data, l * size * size * 4, (u, v, o) => fn(u, v, o, size));
  }
  const tex = new THREE.DataArrayTexture(data, size, size, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function dataTex(size: number, w: number, h: number, f: (x: number, y: number, o: RGB) => void, srgb = true): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  const c: RGB = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      f(x, y, c);
      const i = (y * w + x) * 4;
      data[i] = clamp255(c[0]);
      data[i + 1] = clamp255(c[1]);
      data[i + 2] = clamp255(c[2]);
      data[i + 3] = 255;
    }
  }
  void size;
  const t = new THREE.DataTexture(data, w, h);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Asphalt with painted lines. u = across the road (0..1 = full width), v repeats every 12 m:
 * solid white edge lines and a dashed white centre line.
 */
export function makeAsphaltTexture(size: number): THREE.DataTexture {
  const w = Math.min(512, size);
  const h = w * 2;
  return dataTex(size, w, h, (x, y, o) => {
    const u = x / w;
    const v = y / h;
    const n = fbm(u * 8, v * 16, 3, 71, 8);
    const grain = hash2(x, y, 73) - 0.5;
    const patch = Math.max(0, fbm(u * 3, v * 6, 2, 75, 3)) * 0.25;
    let k = 0.92 + n * 0.12 + grain * 0.18 - patch;
    let r = 74 * k;
    let g = 76 * k;
    let b = 80 * k;
    const edge = (u > 0.035 && u < 0.055) || (u > 0.945 && u < 0.965);
    const dash = Math.abs(u - 0.5) < 0.011 && v % 1 < 0.38;
    if (edge || dash) {
      const wear = 0.82 + (hash2(x >> 1, y >> 1, 77) - 0.5) * 0.3;
      r = g = 225 * wear;
      b = 215 * wear;
    }
    // Darker wheel-worn lanes.
    const lane = Math.exp(-(((u - 0.27) / 0.06) ** 2)) + Math.exp(-(((u - 0.73) / 0.06) ** 2));
    k = 1 - lane * 0.08;
    o[0] = r * k;
    o[1] = g * k;
    o[2] = b * k;
  });
}

/** Tiling water normal map (for the river). */
export function makeWaterNormal(size: number): THREE.DataTexture {
  const s = Math.min(256, size);
  const P = 8;
  const hgt = (x: number, y: number): number => fbm((x / s) * P, (y / s) * P, 3, 81, P);
  return dataTex(
    s,
    s,
    s,
    (x, y, o) => {
      const dx = hgt(x + 1, y) - hgt(x - 1, y);
      const dy = hgt(x, y + 1) - hgt(x, y - 1);
      const nx = -dx * 6;
      const ny = -dy * 6;
      const l = Math.hypot(nx, ny, 1);
      o[0] = (nx / l) * 127 + 128;
      o[1] = (ny / l) * 127 + 128;
      o[2] = (1 / l) * 127 + 128;
    },
    false,
  );
}

/** Black/white checker strip (start/finish lines and banners). */
export function makeCheckerTexture(): THREE.DataTexture {
  const t = dataTex(16, 16, 4, (x, y, o) => {
    const c = (x + y) % 2 ? 240 : 25;
    o[0] = o[1] = o[2] = c;
  });
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  return t;
}

// ---------------------------------------------------------------- bitmap text (banners & signs)

// 5x7 glyphs, rows top→bottom, 5 bits each (MSB = left).
const GLYPHS: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  Y: [17, 17, 10, 4, 4, 4, 4],
  '!': [4, 4, 4, 4, 4, 0, 4],
  '+': [0, 4, 4, 31, 4, 4, 0],
  '1': [4, 12, 4, 4, 4, 4, 14],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

/**
 * Render a short text banner into a texture. Pixel-font letters on a coloured board
 * (optionally with a checker border), scaled `px` texels per font pixel.
 */
export function makeBannerTexture(text: string, fg: RGB, bg: RGB, checker = false, px = 6): THREE.DataTexture {
  const chars = text.toUpperCase().split('');
  const cw = 6 * px;
  const pad = checker ? 4 * px : 2 * px;
  const w = chars.length * cw - px + pad * 2;
  const h = 7 * px + pad * 2;
  const W = THREE.MathUtils.ceilPowerOfTwo(w);
  const H = THREE.MathUtils.ceilPowerOfTwo(h);
  const t = dataTex(0, W, H, (x, yy, o) => {
    // DataTexture row 0 is the bottom; flip so text reads upright.
    const y = H - 1 - yy;
    const sx = (x / W) * w;
    const sy = (y / H) * h;
    let c: RGB = bg;
    if (checker && (sy < 2 * px || sy >= h - 2 * px)) c = (Math.floor(sx / (2 * px)) + Math.floor(sy / (2 * px))) % 2 ? [245, 245, 245] : [20, 20, 20];
    const gx = Math.floor((sx - pad) / px);
    const gy = Math.floor((sy - pad) / px);
    if (gx >= 0 && gy >= 0 && gy < 7) {
      const ci = Math.floor(gx / 6);
      const col = gx % 6;
      const g = GLYPHS[chars[ci] ?? ' '];
      if (g && col < 5 && (g[gy] >> (4 - col)) & 1) c = fg;
    }
    o[0] = c[0];
    o[1] = c[1];
    o[2] = c[2];
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.NearestFilter;
  return t;
}
