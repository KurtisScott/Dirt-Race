// Build-time generator for the photographic-style PBR texture set (Round 2, High/Ultra graphics).
// Everything is procedural and original (no downloads): heightfields built from tileable noise, scattered
// stones / blades / leaves with per-object colour, then baked cavity AO and normals.
//
// Output (public/tex/):
//   terrain-albedo-<N>.webp   12 layers stacked vertically (N × 12N), sRGB albedo with baked cavity AO
//   terrain-nh-<N>.webp       same layout: R,G = tangent-space normal x,y; B = height (0..1)
//   asphalt-albedo-<N>.webp / asphalt-nh-<N>.webp   road surface (markings are drawn in the shader)
//   bark-albedo-512.webp / bark-nh-512.webp, foliage-512.webp (+ alpha), rock-albedo-512.webp ...
// for N = 1024 (Ultra) and 512 (High). Layer order = world/course.ts LAYERS (+ 'track').
//
// Usage: npx tsx scripts/gen-textures.ts [--force] [--preview]
// Skips work when the outputs exist and this file hasn't changed (hash stamp in public/tex/.stamp).
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/tex/', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const force = process.argv.includes('--force');
const preview = process.argv.includes('--preview');
mkdirSync(OUT, { recursive: true });
const stampFile = OUT + '.stamp';
const stamp = createHash('sha1').update(readFileSync(SELF)).digest('hex').slice(0, 12);
if (!force && existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp && existsSync(OUT + 'terrain-albedo-1024.webp')) {
  console.log('[gen-textures] up to date');
  process.exit(0);
}

// ------------------------------------------------------------------ noise (all tileable on [0,1)²)

function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const mod = (a: number, p: number): number => ((a % p) + p) % p;

/** Gradient noise in about [-1, 1], period p cells. */
function gnoise(x: number, y: number, p: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const g = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = hash(mod(ix, p), mod(iy, p), seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fade(fx);
  const v = fade(fy);
  const n00 = g(x0, y0, fx, fy);
  const n10 = g(x0 + 1, y0, fx - 1, fy);
  const n01 = g(x0, y0 + 1, fx, fy - 1);
  const n11 = g(x0 + 1, y0 + 1, fx - 1, fy - 1);
  return (n00 + (n10 - n00) * u + (n01 - n00) * v + (n00 - n10 - n01 + n11) * u * v) * 1.41;
}

/** fBm of gradient noise, u,v in [0,1); base = cells of the first octave. */
function fbm(u: number, v: number, base: number, oct: number, seed: number, gain = 0.5): number {
  let s = 0;
  let a = 1;
  let n = 0;
  let c = base;
  for (let o = 0; o < oct; o++) {
    s += gnoise(u * c, v * c, c, seed + o * 31) * a;
    n += a;
    a *= gain;
    c *= 2;
  }
  return s / n;
}

/** Ridged fbm in [0, 1]. */
function ridged(u: number, v: number, base: number, oct: number, seed: number): number {
  let s = 0;
  let a = 1;
  let n = 0;
  let c = base;
  for (let o = 0; o < oct; o++) {
    s += (1 - Math.abs(gnoise(u * c, v * c, c, seed + o * 17))) * a;
    n += a;
    a *= 0.5;
    c *= 2;
  }
  return s / n;
}

/** Worley (cellular) noise, tileable: f1, f2 in cell units, id of the nearest cell. */
function worley(u: number, v: number, cells: number, seed: number): { f1: number; f2: number; id: number } {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const hx = hash(mod(cx, cells), mod(cy, cells), seed);
      const hy = hash(mod(cx, cells), mod(cy, cells), seed + 7);
      const d = Math.hypot(cx + hx - x, cy + hy - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash(mod(cx, cells), mod(cy, cells), seed + 13);
      } else if (d < f2) f2 = d;
    }
  return { f1, f2, id };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ------------------------------------------------------------------ canvas of height + colour

type RGB = [number, number, number];

class Tex {
  readonly h: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  /** Per-pixel roughness hint (unused in the shipped maps, kept for wetness masks). */
  constructor(readonly n: number) {
    this.h = new Float32Array(n * n);
    this.r = new Float32Array(n * n);
    this.g = new Float32Array(n * n);
    this.b = new Float32Array(n * n);
  }
  /** Fill every pixel from f(u, v) → [height, r, g, b] (colour 0..255 sRGB). */
  fill(f: (u: number, v: number, out: number[]) => void): this {
    const o = [0, 0, 0, 0];
    const n = this.n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        f(x / n, y / n, o);
        const i = y * n + x;
        this.h[i] = o[0];
        this.r[i] = o[1];
        this.g[i] = o[2];
        this.b[i] = o[3];
      }
    return this;
  }
  set(x: number, y: number, h: number, c: RGB, k = 1): void {
    const n = this.n;
    const i = mod(y, n) * n + mod(x, n);
    this.h[i] = h;
    this.r[i] = c[0] * k;
    this.g[i] = c[1] * k;
    this.b[i] = c[2] * k;
  }
  hAt(x: number, y: number): number {
    const n = this.n;
    return this.h[mod(y, n) * n + mod(x, n)];
  }
}

/**
 * Scatter rounded stones: each an irregular ellipse (radius wobbles with angle), dome-shaped height on top of
 * whatever is there (max blend), its own colour with a little noise, a darker rim (contact shadow).
 */
function stones(t: Tex, count: number, rMin: number, rMax: number, colour: (rnd: number, rnd2: number) => RGB, seed: number, opts: { lift?: number; flat?: number; sink?: number; shade?: number } = {}): void {
  const n = t.n;
  const flat = opts.flat ?? 0.6;
  const sink = opts.sink ?? 0.35;
  for (let k = 0; k < count; k++) {
    const cx = hash(k, 1, seed) * n;
    const cy = hash(k, 2, seed) * n;
    const rr = hash(k, 3, seed);
    const r = rMin + (rMax - rMin) * rr * rr;
    const el = 0.6 + hash(k, 4, seed) * 0.4;
    const rot = hash(k, 5, seed) * Math.PI;
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    const col = colour(hash(k, 6, seed), hash(k, 7, seed));
    const top = (opts.lift ?? 1) * r * (0.5 + 0.5 * hash(k, 8, seed));
    const ph = hash(k, 9, seed) * 6.28;
    const R = Math.ceil(r + 2);
    // Base height under the stone: it sits in the ground.
    const base = t.hAt(Math.round(cx), Math.round(cy)) - top * sink;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const lx = (dx * ca + dy * sa) / r;
        const ly = (-dx * sa + dy * ca) / (r * el);
        const ang = Math.atan2(ly, lx);
        const wob = 1 + 0.12 * Math.sin(ang * 3 + ph) + 0.07 * Math.sin(ang * 5 + ph * 2);
        const d = Math.hypot(lx, ly) / wob;
        if (d > 1.08) continue;
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (d > 1) {
          // Contact shadow ring just outside the stone.
          const i = mod(y, n) * n + mod(x, n);
          const k2 = 0.82 + 0.18 * (d - 1) / 0.08;
          t.r[i] *= k2;
          t.g[i] *= k2;
          t.b[i] *= k2;
          continue;
        }
        const dome = Math.pow(1 - d * d, flat);
        const h = base + top * dome;
        if (h < t.hAt(x, y)) continue;
        const grain = 1 + (hash(x * 7 + k, y * 3, seed + 11) - 0.5) * 0.18;
        const shade = (opts.shade ?? 1) * (0.86 + 0.14 * dome) * grain;
        t.set(x, y, h, col, shade);
      }
  }
}

/** Grass / straw blades: tapered strokes, root dark → tip light, rising height. */
function blades(t: Tex, count: number, len: [number, number], colour: (rnd: number, rnd2: number) => RGB, seed: number, opts: { width?: number; tilt?: number; dir?: number } = {}): void {
  const w = opts.width ?? 1.2;
  for (let k = 0; k < count; k++) {
    const x0 = hash(k, 1, seed) * t.n;
    const y0 = hash(k, 2, seed) * t.n;
    const L = len[0] + (len[1] - len[0]) * hash(k, 3, seed);
    const a = (opts.dir ?? 0) + (hash(k, 4, seed) - 0.5) * Math.PI * 2 * (opts.tilt ?? 1);
    const col = colour(hash(k, 5, seed), hash(k, 6, seed));
    const bend = (hash(k, 7, seed) - 0.5) * 0.04;
    let x = x0;
    let y = y0;
    let ang = a;
    const steps = Math.ceil(L);
    const baseH = t.hAt(Math.round(x0), Math.round(y0));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const h = baseH + 2 + f * L * 0.45;
      const ww = w * (1 - f * 0.7);
      const shade = 0.55 + 0.6 * f;
      const R = Math.ceil(ww);
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > ww * ww + 0.25) continue;
          const px = Math.round(x + dx);
          const py = Math.round(y + dy);
          if (h < t.hAt(px, py)) continue;
          t.set(px, py, h, col, shade);
        }
      x += Math.cos(ang);
      y += Math.sin(ang);
      ang += bend;
    }
  }
}

/** Darken thin crack lines from worley cell edges. */
function cracks(t: Tex, cells: number, width: number, depth: number, seed: number, amount = 1): void {
  const n = t.n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const wu = u + fbm(u, v, 3, 4, seed + 5) * 0.07;
      const wv = v + fbm(u, v, 3, 4, seed + 6) * 0.07;
      const w = worley(mod(wu, 1), mod(wv, 1), cells, seed);
      const e = w.f2 - w.f1;
      const c = (1 - smooth(0, width, e)) * amount * (0.5 + 0.5 * smooth(-0.2, 0.4, fbm(u, v, 3, 2, seed + 9)));
      if (c <= 0) continue;
      const i = y * n + x;
      t.h[i] -= depth * c;
      const k = 1 - 0.55 * c;
      t.r[i] *= k;
      t.g[i] *= k;
      t.b[i] *= k;
    }
}

/** Box blur (wrapping) of a scalar map. */
function blur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[y * n + mod(k, n)];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = s / w;
      s += src[y * n + mod(x + r + 1, n)] - src[y * n + mod(x - r, n)];
    }
  }
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[mod(k, n) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = s / w;
      s += tmp[mod(y + r + 1, n) * n + x] - tmp[mod(y - r, n) * n + x];
    }
  }
  return out;
}

/**
 * Finish a layer: bake cavity AO into the colour (low spots darker, optionally tinted), compute the normal
 * map from the height (`strength` = height units per pixel slope), normalise height to 0..1.
 */
function finish(t: Tex, strength: number, ao = 0.5, aoTint: RGB = [1, 1, 1], target?: RGB): { albedo: Uint8Array; nh: Uint8Array } {
  const n = t.n;
  const H = t.h;
  const b1 = blur(H, n, Math.max(2, n >> 7));
  const b2 = blur(H, n, Math.max(4, n >> 5));
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n * n; i++) {
    lo = Math.min(lo, H[i]);
    hi = Math.max(hi, H[i]);
  }
  const range = Math.max(1e-6, hi - lo);
  // Typical relief for AO normalisation.
  let dev = 0;
  for (let i = 0; i < n * n; i++) dev += Math.abs(H[i] - b2[i]);
  dev = Math.max(1e-6, dev / (n * n));
  const albedo = new Uint8Array(n * n * 3);
  const nh = new Uint8Array(n * n * 3);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const cav = clamp01(0.5 + ((H[i] - b1[i]) * 0.6 + (H[i] - b2[i]) * 0.4) / (dev * 3));
      const occ = 1 - ao * (1 - cav) * 0.9;
      albedo[i * 3] = Math.max(0, Math.min(255, t.r[i] * lerp(aoTint[0], 1, cav) * occ));
      albedo[i * 3 + 1] = Math.max(0, Math.min(255, t.g[i] * lerp(aoTint[1], 1, cav) * occ));
      albedo[i * 3 + 2] = Math.max(0, Math.min(255, t.b[i] * lerp(aoTint[2], 1, cav) * occ));
      // Sobel normal.
      const h = (dx: number, dy: number): number => H[mod(y + dy, n) * n + mod(x + dx, n)];
      const gx = (h(1, -1) + 2 * h(1, 0) + h(1, 1) - h(-1, -1) - 2 * h(-1, 0) - h(-1, 1)) / 8;
      const gy = (h(-1, 1) + 2 * h(0, 1) + h(1, 1) - h(-1, -1) - 2 * h(0, -1) - h(1, -1)) / 8;
      let nx = -gx * strength;
      let ny = -gy * strength;
      const l = Math.hypot(nx, ny, 1);
      nx /= l;
      ny /= l;
      nh[i * 3] = Math.round((nx * 0.5 + 0.5) * 255);
      nh[i * 3 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nh[i * 3 + 2] = Math.round(((H[i] - lo) / range) * 255);
    }
  if (target) {
    // Calibrate the mean colour to a measured real-world albedo (sRGB), keeping the texture's variation.
    const m = [0, 0, 0];
    for (let i = 0; i < n * n; i++) for (let c = 0; c < 3; c++) m[c] += albedo[i * 3 + c];
    const k = m.map((v, c) => target[c] / Math.max(1, v / (n * n)));
    for (let i = 0; i < n * n; i++) for (let c = 0; c < 3; c++) albedo[i * 3 + c] = Math.min(255, Math.round(albedo[i * 3 + c] * k[c]));
  }
  return { albedo, nh };
}

const jit = (c: RGB, rnd: number, k = 0.2): RGB => {
  const f = 1 + (rnd - 0.5) * k;
  return [c[0] * f, c[1] * f, c[2] * f];
};
const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ------------------------------------------------------------------ layers (pixel sizes assume 4 m tiles)

type Layer = (n: number) => { albedo: Uint8Array; nh: Uint8Array };
const S = (n: number, px: number): number => (px * n) / 1024; // scale pixel sizes from the 1024 design

const LAYER_GEN: Record<string, Layer> = {
  grass: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const f = fbm(u, v, 6, 4, 101);
      o[0] = f * 3;
      const soil: RGB = mix3([92, 74, 52], [70, 60, 42], clamp01(f + 0.5));
      [o[1], o[2], o[3]] = soil;
    });
    const dry = (u: number, v: number): number => smooth(0.05, 0.45, fbm(u, v, 3, 3, 105));
    blades(t, Math.round(S(n, 1) * S(n, 1) * 200000), [S(n, 9), S(n, 26)], (a, b) => {
      const greens: RGB[] = [[58, 82, 30], [78, 106, 38], [100, 124, 48], [124, 136, 58], [86, 98, 40]];
      return jit(greens[Math.floor(a * greens.length)], b, 0.3);
    }, 107, { width: S(n, 1.4) });
    // Yellowed patches + clover dots.
    const N = t.n;
    for (let i = 0; i < N * N; i++) {
      const d = dry((i % N) / N, Math.floor(i / N) / N);
      t.r[i] = lerp(t.r[i], t.r[i] * 1.35 + 18, d * 0.6);
      t.g[i] = lerp(t.g[i], t.g[i] * 1.12 + 8, d * 0.6);
    }
    return finish(t, 0.9, 0.75, [0.7, 0.8, 0.6], [96, 116, 50]);
  },
  dirt: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const f = fbm(u, v, 4, 6, 201);
      const d = fbm(u, v, 12, 3, 203);
      o[0] = f * S(n, 14) + d * S(n, 3) + ridged(u, v, 3, 3, 209) * S(n, 4);
      const damp = smooth(-0.1, 0.4, fbm(u, v, 3, 3, 205));
      const c = mix3([150, 116, 82], [112, 84, 58], damp * 0.7);
      const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 207) - 0.5) * 0.12;
      o[1] = c[0] * g * (1 + f * 0.12);
      o[2] = c[1] * g * (1 + f * 0.12);
      o[3] = c[2] * g * (1 + f * 0.12);
    });
    stones(t, Math.round(1800 * (n / 1024) ** 2), S(n, 2), S(n, 7), (a, b) => jit(mix3([170, 150, 122], [120, 104, 86], a), b), 211, { lift: 0.5 });
    stones(t, Math.round(60 * (n / 1024) ** 2), S(n, 7), S(n, 16), (a, b) => jit(mix3([158, 140, 112], [110, 98, 84], a), b), 213, { lift: 0.4, sink: 0.6 });
    cracks(t, 6, 0.02, S(n, 2), 215, 0.14);
    return finish(t, 1.1, 0.6, [1, 1, 1], [156, 124, 90]);
  },
  gravel: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      o[0] = fbm(u, v, 5, 3, 301) * S(n, 6);
      [o[1], o[2], o[3]] = [86, 78, 68];
    });
    const col = (a: number, b: number): RGB => {
      const pal: RGB[] = [[150, 144, 134], [128, 120, 108], [168, 156, 136], [104, 100, 96], [140, 126, 104], [182, 176, 166]];
      return jit(pal[Math.floor(a * pal.length)], b, 0.25);
    };
    stones(t, Math.round(2600 * (n / 1024) ** 2), S(n, 6), S(n, 13), col, 303, { lift: 0.55, flat: 0.5 });
    stones(t, Math.round(9000 * (n / 1024) ** 2), S(n, 2.5), S(n, 6), col, 305, { lift: 0.6, flat: 0.5 });
    return finish(t, 1.2, 0.85, [1, 1, 1], [122, 114, 102]);
  },
  mud: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const f = fbm(u, v, 3, 6, 401);
      // Ruts (soft tracks) + clumps.
      const rut = Math.sin((u + fbm(u, v, 2, 2, 403) * 0.08) * Math.PI * 2 * 3) * 0.5 + 0.5;
      const clump = ridged(u, v, 8, 3, 405);
      o[0] = f * S(n, 20) + rut * S(n, 8) + clump * S(n, 5);
      const wet = smooth(0.15, -0.35, f + rut * 0.2 - 0.1);
      const c = mix3([96, 72, 50], [52, 40, 30], wet);
      const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 407) - 0.5) * 0.08;
      o[1] = c[0] * g;
      o[2] = c[1] * g;
      o[3] = c[2] * g;
    });
    stones(t, Math.round(300 * (n / 1024) ** 2), S(n, 2), S(n, 6), (a, b) => jit([118, 100, 80], b), 409, { lift: 0.3, sink: 0.7, shade: 0.8 });
    return finish(t, 0.8, 0.5, [1, 1, 1], [96, 74, 54]);
  },
  sand: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const w = fbm(u, v, 2, 3, 501);
      const rip = Math.sin((v * 26 + u * 3 + w * 2.2) * Math.PI * 2);
      const ripple = Math.pow(rip * 0.5 + 0.5, 1.6);
      const f = fbm(u, v, 5, 4, 503);
      o[0] = ripple * S(n, 4) + f * S(n, 6);
      const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 505) - 0.5) * 0.16;
      const c = mix3([220, 190, 142], [196, 162, 112], clamp01(0.5 + f * 1.4));
      o[1] = c[0] * g * (0.95 + 0.07 * ripple);
      o[2] = c[1] * g * (0.95 + 0.07 * ripple);
      o[3] = c[2] * g * (0.95 + 0.07 * ripple);
    });
    stones(t, Math.round(120 * (n / 1024) ** 2), S(n, 1.5), S(n, 4), (a, b) => jit([150, 120, 90], b, 0.4), 507, { lift: 0.4, sink: 0.6 });
    return finish(t, 0.7, 0.4, [0.92, 0.88, 0.85], [216, 186, 140]);
  },
  rock: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const w = worley(u, v, 5, 601);
      const f = fbm(u, v, 3, 6, 603);
      const r = ridged(u, v, 4, 5, 605);
      o[0] = f * S(n, 40) + r * S(n, 22) + (w.f2 - w.f1) * S(n, 16) + w.id * S(n, 10);
      const strata = Math.sin((v * 9 + f * 1.4) * Math.PI * 2) * 0.5 + 0.5;
      const c = mix3([134, 128, 120], [104, 100, 96], strata * 0.6 + w.id * 0.3);
      const lichen = smooth(0.35, 0.6, fbm(u, v, 10, 3, 607)) * smooth(0.4, 0.8, r);
      const cc = mix3(c, [150, 148, 98], lichen * 0.6);
      const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 609) - 0.5) * 0.1;
      o[1] = cc[0] * g;
      o[2] = cc[1] * g;
      o[3] = cc[2] * g;
    });
    cracks(t, 3, 0.025, S(n, 10), 611, 0.4);
    cracks(t, 9, 0.015, S(n, 4), 613, 0.15);
    return finish(t, 0.9, 0.8, [1, 1, 1], [140, 134, 124]);
  },
  riverbed: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      o[0] = fbm(u, v, 4, 3, 701) * S(n, 6);
      [o[1], o[2], o[3]] = [104, 96, 78];
    });
    const col = (a: number, b: number): RGB => {
      const pal: RGB[] = [[120, 112, 98], [96, 92, 86], [136, 118, 96], [110, 100, 82], [82, 80, 74], [128, 104, 86]];
      return jit(pal[Math.floor(a * pal.length)], b, 0.25);
    };
    stones(t, Math.round(900 * (n / 1024) ** 2), S(n, 10), S(n, 26), col, 703, { lift: 0.45, flat: 0.75 });
    stones(t, Math.round(4000 * (n / 1024) ** 2), S(n, 3), S(n, 9), col, 705, { lift: 0.45, flat: 0.75 });
    // Algae tint in the gaps.
    const N = t.n;
    for (let i = 0; i < N * N; i++) {
      const a = smooth(0.2, 0.6, fbm((i % N) / N, Math.floor(i / N) / N, 4, 3, 707));
      t.g[i] *= 1 + a * 0.12;
      t.r[i] *= 1 - a * 0.1;
    }
    return finish(t, 1.0, 0.85, [1, 1, 1], [116, 108, 92]);
  },
  field: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      o[0] = fbm(u, v, 5, 3, 801) * S(n, 4);
      [o[1], o[2], o[3]] = [120, 100, 66];
    });
    blades(t, Math.round(110000 * (n / 1024) ** 2), [S(n, 10), S(n, 30)], (a, b) => {
      const pal: RGB[] = [[196, 174, 104], [176, 152, 86], [212, 192, 128], [158, 140, 80], [140, 136, 70]];
      return jit(pal[Math.floor(a * pal.length)], b, 0.25);
    }, 803, { width: S(n, 1.2) });
    return finish(t, 0.9, 0.7, [1, 1, 1], [178, 158, 98]);
  },
  snow: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const f = fbm(u, v, 3, 6, 901);
      const drift = ridged(u, v, 2, 3, 903);
      o[0] = f * S(n, 18) + drift * S(n, 10) + fbm(u, v, 24, 2, 905) * S(n, 1.2);
      const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 907) - 0.5) * 0.03;
      o[1] = 240 * g;
      o[2] = 244 * g;
      o[3] = 250 * g;
    });
    return finish(t, 0.6, 0.12, [0.9, 0.94, 1.0], [236, 240, 247]);
  },
  forest: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const f = fbm(u, v, 5, 5, 1001);
      o[0] = f * S(n, 8);
      const c = mix3([70, 54, 36], [52, 40, 28], clamp01(0.5 + f));
      [o[1], o[2], o[3]] = c;
    });
    // Leaves (flat ellipses), needles (blades), twigs.
    stones(t, Math.round(2400 * (n / 1024) ** 2), S(n, 5), S(n, 12), (a, b) => {
      const pal: RGB[] = [[132, 86, 44], [150, 110, 52], [104, 70, 40], [168, 124, 62], [96, 84, 46]];
      return jit(pal[Math.floor(a * pal.length)], b, 0.3);
    }, 1003, { lift: 0.12, flat: 0.2, sink: 0 });
    blades(t, Math.round(40000 * (n / 1024) ** 2), [S(n, 8), S(n, 18)], (a, b) => jit(mix3([150, 104, 60], [110, 80, 48], a), b, 0.3), 1005, { width: S(n, 0.7) });
    blades(t, Math.round(260 * (n / 1024) ** 2), [S(n, 40), S(n, 110)], (a, b) => jit([84, 64, 44], b, 0.3), 1007, { width: S(n, 2.4), tilt: 1 });
    return finish(t, 0.8, 0.8, [1, 1, 1], [98, 78, 54]);
  },
  redrock: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const f = fbm(u, v, 3, 6, 1101);
      const strata = Math.sin((v * 11 + f * 1.1) * Math.PI * 2);
      const band = smooth(-0.2, 0.6, strata);
      const r = ridged(u, v, 4, 4, 1103);
      o[0] = f * S(n, 30) + band * S(n, 14) + r * S(n, 14);
      const c = mix3([186, 104, 68], [146, 76, 52], band * 0.7 + clamp01(f) * 0.3);
      const pale = smooth(0.3, 0.7, fbm(u, v, 6, 3, 1105));
      const cc = mix3(c, [204, 150, 110], pale * 0.35);
      const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 1107) - 0.5) * 0.1;
      o[1] = cc[0] * g;
      o[2] = cc[1] * g;
      o[3] = cc[2] * g;
    });
    cracks(t, 3, 0.03, S(n, 10), 1109, 0.45);
    return finish(t, 0.9, 0.75, [1, 1, 1], [180, 102, 70]);
  },
  // Packed road surface (hardpack) — desert/snow/canyon road base: compact, darker than the sand around it.
  track: (n) => {
    const t = new Tex(n).fill((u, v, o) => {
      const f = fbm(u, v, 4, 5, 1201);
      o[0] = f * S(n, 6) + fbm(u, v, 16, 2, 1203) * S(n, 1.5);
      const c = mix3([138, 108, 78], [112, 88, 64], clamp01(0.5 + f * 1.2));
      const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 1205) - 0.5) * 0.14;
      o[1] = c[0] * g;
      o[2] = c[1] * g;
      o[3] = c[2] * g;
    });
    stones(t, Math.round(3500 * (n / 1024) ** 2), S(n, 1.5), S(n, 5), (a, b) => jit(mix3([160, 142, 118], [96, 86, 74], a), b), 1207, { lift: 0.4, sink: 0.6 });
    return finish(t, 1.0, 0.6, [1, 1, 1], [170, 138, 100]);
  },
};
export const TERRAIN_LAYERS = ['grass', 'dirt', 'gravel', 'mud', 'sand', 'rock', 'riverbed', 'field', 'snow', 'forest', 'redrock', 'track'];

function asphalt(n: number): { albedo: Uint8Array; nh: Uint8Array } {
  const t = new Tex(n).fill((u, v, o) => {
    const f = fbm(u, v, 4, 5, 1301);
    o[0] = f * S(n, 3);
    const wear = smooth(-0.3, 0.5, fbm(u, v, 2, 3, 1303));
    const c = mix3([62, 62, 64], [92, 90, 88], wear * 0.6);
    const g = 1 + (hash(Math.floor(u * n), Math.floor(v * n), 1305) - 0.5) * 0.25;
    o[1] = c[0] * g;
    o[2] = c[1] * g;
    o[3] = c[2] * g;
  });
  // Aggregate: lots of tiny light and dark stones.
  stones(t, Math.round(26000 * (n / 1024) ** 2), S(n, 1), S(n, 3), (a, b) => jit(a > 0.75 ? [118, 116, 112] : a > 0.3 ? [90, 88, 86] : [52, 52, 54], b, 0.2), 1307, { lift: 0.5, sink: 0.6 });
  cracks(t, 3, 0.012, S(n, 3), 1309, 0.12);
  // Tar-sealed crack lines (dark, glossy) and a couple of patch repairs.
  const N = t.n;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const i = y * N + x;
      const pu = mod(u - 0.62, 1);
      const pv = mod(v - 0.18, 1);
      if (pu < 0.22 && pv < 0.3) {
        const e = Math.min(pu, 0.22 - pu, pv, 0.3 - pv);
        const k = e < 0.004 ? 0.6 : 0.82;
        t.r[i] *= k;
        t.g[i] *= k;
        t.b[i] *= k;
      }
      const stain = smooth(0.45, 0.75, fbm(u, v, 6, 3, 1311));
      t.r[i] *= 1 - stain * 0.25;
      t.g[i] *= 1 - stain * 0.25;
      t.b[i] *= 1 - stain * 0.22;
    }
  return finish(t, 1.3, 0.55, [1, 1, 1], [84, 84, 84]);
}

// ------------------------------------------------------------------ write

async function writeStack(name: string, n: number, parts: Uint8Array[], quality: number): Promise<number> {
  const buf = Buffer.alloc(n * n * 3 * parts.length);
  parts.forEach((p, i) => buf.set(p, i * n * n * 3));
  const file = `${OUT}${name}-${n}.webp`;
  const info = await sharp(buf, { raw: { width: n, height: n * parts.length, channels: 3 } })
    .webp({ quality, effort: 5, smartSubsample: true })
    .toFile(file);
  return info.size;
}

const t0 = Date.now();
let total = 0;
for (const n of (process.env.SIZES ?? "1024,512").split(",").map(Number)) {
  const albedo: Uint8Array[] = [];
  const nh: Uint8Array[] = [];
  for (const name of TERRAIN_LAYERS) {
    const t1 = Date.now();
    const r = LAYER_GEN[name](n);
    albedo.push(r.albedo);
    nh.push(r.nh);
    console.log(`[gen-textures] ${name} ${n}px ${Date.now() - t1} ms`);
  }
  total += await writeStack('terrain-albedo', n, albedo, 82);
  total += await writeStack('terrain-nh', n, nh, 88);
  const a = asphalt(n);
  total += await writeStack('asphalt-albedo', n, [a.albedo], 84);
  total += await writeStack('asphalt-nh', n, [a.nh], 88);
  if (preview && n === 1024) {
    // Contact sheet (not shipped): 4 × 3 layers at 256 px + asphalt.
    const P = 256;
    const sheet = Buffer.alloc(P * 4 * P * 4 * 3);
    [...albedo, a.albedo].forEach((al, k) => {
      const ox = (k % 4) * P;
      const oy = Math.floor(k / 4) * P;
      for (let y = 0; y < P; y++)
        for (let x = 0; x < P; x++) {
          const si = ((y * 4) * n + x * 4) * 3;
          const di = ((oy + y) * P * 4 + ox + x) * 3;
          sheet[di] = al[si];
          sheet[di + 1] = al[si + 1];
          sheet[di + 2] = al[si + 2];
        }
    });
    await sharp(sheet, { raw: { width: P * 4, height: P * 4, channels: 3 } }).png().toFile(process.env.PREVIEW ?? '/tmp/tex-preview.png');
  }
}
writeFileSync(stampFile, stamp + '\n');
console.log(`[gen-textures] done in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(total / 1024 / 1024).toFixed(2)} MB`);
