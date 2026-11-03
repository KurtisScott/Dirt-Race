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
  // 8 snow (soft drifts, faint blue shadows, sparkle)
  (u, v, o, px) => {
    const n = tn(u, v, 4, 3, 71);
    const drift = tn(u, v, 2, 2, 73);
    const sparkle = hash2(Math.floor(u * px), Math.floor(v * px), 75) > 0.985 ? 10 : 0;
    const k = 0.93 + n * 0.06;
    o[0] = (232 - Math.max(0, -drift) * 30) * k + sparkle;
    o[1] = (238 - Math.max(0, -drift) * 18) * k + sparkle;
    o[2] = 248 * k + sparkle;
  },
  // 9 forest floor (needles, dark loam, leaf litter)
  (u, v, o, px) => {
    const n = tn(u, v, 6, 4, 81);
    const leaf = worley(u * 30, v * 30, 30, 83);
    const litter = leaf.f1 < 0.3 ? (leaf.id - 0.5) * 0.5 : 0;
    const needle = (hash2(Math.floor(u * px), Math.floor(v * px * 0.3), 85) - 0.5) * 0.25;
    const k = 0.9 + n * 0.25 + needle;
    o[0] = (88 + litter * 60) * k;
    o[1] = (70 + litter * 25) * k;
    o[2] = 46 * k;
  },
  // 10 red sandstone (canyon): horizontal strata + cracks
  (u, v, o) => {
    const w = worley(u * 6, v * 6, 6, 91);
    const crack = Math.min(1, (w.f2 - w.f1) * 6);
    const strata = Math.sin((v * 18 + tn(u, v, 3, 2, 93) * 2.5) * Math.PI * 2) * 0.5 + 0.5;
    const n = tn(u, v, 6, 4, 95);
    const k = (0.78 + 0.22 * crack) * (0.9 + n * 0.22);
    o[0] = (176 + strata * 30) * k;
    o[1] = (98 + strata * 22) * k;
    o[2] = (66 + strata * 12) * k;
  },
  // 11 track (Round 2): packed road hardpack — darker and browner than the sand/snow around it so the
  // desert and snowy-pass roads read clearly.
  (u, v, o, px) => {
    const n = tn(u, v, 5, 3, 101);
    const grit = hash2(Math.floor(u * px), Math.floor(v * px), 103) - 0.5;
    const w = worley(u * 30, v * 30, 30, 105);
    const pebble = w.f1 < 0.2 ? 0.14 * (1 - w.f1 / 0.2) * (w.id - 0.4) : 0;
    const k = 1 + n * 0.14 + grit * 0.1 + pebble;
    o[0] = 128 * k;
    o[1] = 100 * k;
    o[2] = 72 * k;
  },
];

export const TERRAIN_LAYER_COUNT = LAYER_FNS.length;

/** The terrain layers (12) as one sRGB DataArrayTexture (mipmapped, repeat-wrapped). */
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
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  J: [7, 2, 2, 2, 2, 18, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

/**
 * Sign/banner texture with `text` centred on `bg`, drawn at the aspect of the plane it goes on
 * (`aspect` = plane width / height) so letters aren't stretched. Uses a 2D canvas with a heavy rounded
 * font when one exists (crisp at any distance thanks to mipmaps + anisotropy); headless tests without a
 * canvas get the 5×7 pixel font, drawn at an integer scale (no resampling, so still sharp-edged).
 */
export function makeBannerTexture(text: string, fg: RGB, bg: RGB, checker = false, px = 6, aspect?: number): THREE.Texture {
  return canvasBanner(text, fg, bg, checker, aspect) ?? pixelBanner(text, fg, bg, checker, px, aspect);
}

const rgb = (c: RGB): string => `rgb(${c[0]},${c[1]},${c[2]})`;

function canvasBanner(text: string, fg: RGB, bg: RGB, checker: boolean, aspect?: number): THREE.Texture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const H = 128;
  const W = Math.min(2048, Math.max(H, Math.round(H * (aspect ?? text.length * 0.9 + 0.6))));
  let c: HTMLCanvasElement;
  let g: CanvasRenderingContext2D | null = null;
  try {
    c = Object.assign(document.createElement('canvas'), { width: W, height: H });
    g = c.getContext('2d');
  } catch {
    return null;
  }
  // Test shims hand out stub contexts: only use a real one.
  const probe = g && typeof g.measureText === 'function' ? g.measureText('M') : null;
  if (!g || !probe || typeof probe.width !== 'number' || typeof g.fillText !== 'function') return null;
  g.fillStyle = rgb(bg);
  g.fillRect(0, 0, W, H);
  const strip = checker ? 16 : 0;
  if (checker) {
    for (let x = 0; x < W; x += strip) {
      for (const [y, o] of [[0, 0], [H - strip, 1]] as const) {
        g.fillStyle = (x / strip + o) % 2 ? '#f5f5f5' : '#141414';
        g.fillRect(x, y, strip, strip);
      }
    }
  }
  const avail = H - strip * 2;
  let size = Math.round(avail * 0.9);
  const font = (sz: number): string => `900 ${sz}px ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif`;
  g.font = font(size);
  const maxW = W * 0.9;
  let tw = g.measureText(text).width;
  if (tw > maxW) {
    size = Math.floor((size * maxW) / tw);
    g.font = font(size);
    tw = g.measureText(text).width;
  }
  // Wide boards (the gantries): stretch the letters sideways (up to 1.8×) so the word fills about 60%
  // of the board and reads from far away, like a painted race banner.
  const sx = Math.min(1.8, Math.max(1, (W * 0.6) / Math.max(1, tw)));
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = Math.max(2, size * 0.1);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.setTransform(sx, 0, 0, 1, W / 2, H / 2 + size * 0.04);
  g.strokeText(text, 0, 0);
  g.fillStyle = rgb(fg);
  g.fillText(text, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8; // clamped to the GPU's max by three
  return t;
}

function pixelBanner(text: string, fg: RGB, bg: RGB, checker: boolean, px: number, aspect?: number): THREE.DataTexture {
  const chars = text.toUpperCase().split('');
  const cw = 6 * px;
  const pad = checker ? 4 * px : 2 * px;
  const tw = chars.length * cw - px;
  const h = 7 * px + pad * 2;
  // Integer texel grid at the plane's aspect: the text is centred and the sides are board colour.
  const w = Math.max(tw + pad * 2, Math.round(h * (aspect ?? 0)));
  const x0 = Math.floor((w - tw) / 2);
  const t = dataTex(0, w, h, (x, yy, o) => {
    // DataTexture row 0 is the bottom; flip so text reads upright.
    const y = h - 1 - yy;
    let c: RGB = bg;
    if (checker && (y < 2 * px || y >= h - 2 * px)) c = (Math.floor(x / (2 * px)) + Math.floor(y / (2 * px))) % 2 ? [245, 245, 245] : [20, 20, 20];
    const gx = Math.floor((x - x0) / px);
    const gy = Math.floor((y - pad) / px);
    if (x >= x0 && gx >= 0 && gy >= 0 && gy < 7) {
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

// ---------------------------------------------------------------- sign atlas (jump distance markers)

export interface SignCell {
  text: string;
  fg: RGB;
  bg: RGB;
  /** Border colour (a thick frame makes the boards readable from the car). */
  border: RGB;
}

/**
 * One texture holding `cells` square signs in a grid of `cols` columns (one draw call for every marker
 * board). Returns the texture and the UV rectangle of each cell: [u0, v0, u1, v1].
 */
export function makeSignAtlas(cells: SignCell[], cols = 4): { texture: THREE.Texture; uv: [number, number, number, number][] } {
  const rows = Math.ceil(cells.length / cols);
  const uv = cells.map((_, i): [number, number, number, number] => {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    // Canvas row 0 is the top; texture v = 1 at the top (flipY).
    return [cx / cols, 1 - (cy + 1) / rows, (cx + 1) / cols, 1 - cy / rows];
  });
  const texture = canvasAtlas(cells, cols, rows) ?? pixelAtlas(cells, cols, rows);
  return { texture, uv };
}

function canvasAtlas(cells: SignCell[], cols: number, rows: number): THREE.Texture | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const C = 128;
  let c: HTMLCanvasElement;
  let g: CanvasRenderingContext2D | null = null;
  try {
    c = Object.assign(document.createElement('canvas'), { width: C * cols, height: C * rows });
    g = c.getContext('2d');
  } catch {
    return null;
  }
  const probe = g && typeof g.measureText === 'function' ? g.measureText('M') : null;
  if (!g || !probe || typeof probe.width !== 'number' || typeof g.fillText !== 'function') return null;
  cells.forEach((cell, i) => {
    const x = (i % cols) * C;
    const y = Math.floor(i / cols) * C;
    g!.fillStyle = rgb(cell.border);
    g!.fillRect(x, y, C, C);
    g!.fillStyle = rgb(cell.bg);
    g!.fillRect(x + 10, y + 10, C - 20, C - 20);
    let size = cell.text.length > 3 ? 44 : 80;
    const font = (sz: number): string => `900 ${sz}px ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif`;
    g!.font = font(size);
    const lines = cell.text.split('\n');
    const tw = Math.max(...lines.map((l) => g!.measureText(l).width));
    if (tw > C - 28) {
      size = Math.floor((size * (C - 28)) / tw);
      g!.font = font(size);
    }
    g!.textAlign = 'center';
    g!.textBaseline = 'middle';
    g!.fillStyle = rgb(cell.fg);
    lines.forEach((l, k) => g!.fillText(l, x + C / 2, y + C / 2 + (k - (lines.length - 1) / 2) * size * 1.05 + size * 0.04));
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  return t;
}

function pixelAtlas(cells: SignCell[], cols: number, rows: number): THREE.DataTexture {
  const C = 64;
  const W = C * cols;
  const H = C * rows;
  return dataTex(0, W, H, (x, yy, o) => {
    const y = H - 1 - yy; // DataTexture row 0 = bottom
    const i = Math.floor(y / C) * cols + Math.floor(x / C);
    const cell = cells[i];
    let col: RGB = [0, 0, 0];
    if (cell) {
      const lx = x % C;
      const ly = y % C;
      col = lx < 5 || ly < 5 || lx >= C - 5 || ly >= C - 5 ? cell.border : cell.bg;
      const line = cell.text.split('\n')[0];
      const px = line.length > 3 ? 2 : 3;
      const tw = line.length * 6 * px - px;
      const x0 = Math.floor((C - tw) / 2);
      const y0 = Math.floor((C - 7 * px) / 2);
      const gx = Math.floor((lx - x0) / px);
      const gy = Math.floor((ly - y0) / px);
      if (lx >= x0 && gx >= 0 && gy >= 0 && gy < 7) {
        const ch = GLYPHS[line[Math.floor(gx / 6)]?.toUpperCase() ?? ' '];
        const cx = gx % 6;
        if (ch && cx < 5 && (ch[gy] >> (4 - cx)) & 1) col = cell.fg;
      }
    }
    o[0] = col[0];
    o[1] = col[1];
    o[2] = col[2];
  });
}
