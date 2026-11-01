/**
 * Tiny offline DSP helpers used to render short looping buffers procedurally at startup
 * (engine loops, surface beds, noise). Plain JS on Float32Arrays: no AudioContext needed,
 * so the same generators run in tests and in OfflineAudioContext renders.
 */
import { rng } from '../core/math';

export type Rand = () => number;
export const seeded = (seed: number): Rand => rng(seed);

/** One-pole low-pass in place. `hz` cutoff. */
export function lowpass(buf: Float32Array, sr: number, hz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

/** One-pole high-pass in place. */
export function highpass(buf: Float32Array, sr: number, hz: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * hz) / sr);
  let xPrev = 0;
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    y = a * (y + x - xPrev);
    xPrev = x;
    buf[i] = y;
  }
  return buf;
}

/** RBJ band-pass (constant peak gain) in place. */
export function bandpass(buf: Float32Array, sr: number, hz: number, q: number): Float32Array {
  const w = (2 * Math.PI * hz) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
  return buf;
}

export function white(n: number, r: Rand): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = r() * 2 - 1;
  return b;
}

/** Brown-ish noise (integrated white, leaky). */
export function brown(n: number, r: Rand): Float32Array {
  const b = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    y = y * 0.985 + (r() * 2 - 1) * 0.15;
    b[i] = y;
  }
  return b;
}

export function removeDC(buf: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m += buf[i];
  m /= buf.length || 1;
  for (let i = 0; i < buf.length; i++) buf[i] -= m;
  return buf;
}

/** Scale so the peak is `peak`. */
export function normalize(buf: Float32Array, peak = 0.9): Float32Array {
  let mx = 0;
  for (let i = 0; i < buf.length; i++) mx = Math.max(mx, Math.abs(buf[i]));
  if (mx > 1e-9) {
    const k = peak / mx;
    for (let i = 0; i < buf.length; i++) buf[i] *= k;
  }
  return buf;
}

/** Scale to an RMS level (then soft-clip safety). Keeps different loops at a consistent loudness. */
export function normalizeRms(buf: Float32Array, rms = 0.25): Float32Array {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  const cur = Math.sqrt(s / (buf.length || 1));
  if (cur > 1e-9) {
    const k = rms / cur;
    for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * k);
  }
  return buf;
}

/**
 * Make a seamless loop of length `len` from a longer buffer (len + fade): the tail beyond `len`
 * is equal-power crossfaded into the head. Use for noise-like beds.
 */
export function loopify(src: Float32Array, len: number): Float32Array {
  const fade = src.length - len;
  const out = src.slice(0, len);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = src[i] * Math.sin((t * Math.PI) / 2) + src[len + i] * Math.cos((t * Math.PI) / 2);
  }
  return out;
}

/** Sprinkle short decaying events (clicks, bubbles) at random times. `fn(t)` is the event at t seconds after onset. */
export function sprinkle(buf: Float32Array, sr: number, r: Rand, perSecond: number, durS: number, fn: (t: number, k: number) => number): void {
  const count = Math.round((buf.length / sr) * perSecond);
  const evLen = Math.floor(durS * sr);
  for (let e = 0; e < count; e++) {
    const start = Math.floor(r() * buf.length);
    const k = r();
    for (let i = 0; i < evLen; i++) {
      const j = (start + i) % buf.length; // wrap: keeps the loop seamless
      buf[j] += fn(i / sr, k);
    }
  }
}
