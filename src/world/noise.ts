/**
 * Small, dependency-free noise helpers used to build terrain and textures.
 * Everything is deterministic (hash-based) so the course looks the same every launch.
 */

/** Integer hash → [0, 1). */
export function hash2(ix: number, iy: number, seed = 0): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * (3 - 2 * t);

/** 2D value noise in [-1, 1]. `period` (in lattice cells) makes it tile (for textures). */
export function valueNoise(x: number, y: number, seed = 0, period = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  let ax = x0;
  let ay = y0;
  let bx = x0 + 1;
  let by = y0 + 1;
  if (period > 0) {
    ax = ((ax % period) + period) % period;
    ay = ((ay % period) + period) % period;
    bx = ((bx % period) + period) % period;
    by = ((by % period) + period) % period;
  }
  const a = hash2(ax, ay, seed);
  const b = hash2(bx, ay, seed);
  const c = hash2(ax, by, seed);
  const d = hash2(bx, by, seed);
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * 2 - 1;
}

/** Fractal value noise in roughly [-1, 1]. */
export function fbm(x: number, y: number, octaves = 4, seed = 0, period = 0): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, seed + o * 17, period ? period * f : 0) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Worley F1/F2 (distance to nearest & second nearest feature point), tiling with `period` cells. */
export function worley(x: number, y: number, period: number, seed = 0): { f1: number; f2: number; id: number } {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 2);
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id };
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
