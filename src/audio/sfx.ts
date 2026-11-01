/**
 * Procedural one-shot sounds and surface/tyre loops, rendered to Float32Arrays in plain JS.
 * Each generator is tiny, deterministic (seeded) and renders in a few ms; buffers are cached
 * per AudioContext the first time they're needed (and pre-warmed in idle time after unlock).
 */
import { clamp } from '../core/math';
import type { SurfaceType } from '../core/types';
import { bandpass, brown, highpass, loopify, lowpass, normalize, normalizeRms, removeDC, type Rand, seeded, sprinkle, white } from './dsp';

const TAU = Math.PI * 2;

function make(sr: number, dur: number, fn: (t: number, i: number) => number): Float32Array {
  const n = Math.max(1, Math.floor(dur * sr));
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = fn(i / sr, i);
  return b;
}
const att = (t: number, a: number): number => (t < a ? t / a : 1);
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
function add(dst: Float32Array, src: Float32Array, at: number, gain = 1): void {
  for (let i = 0; i < src.length && at + i < dst.length; i++) dst[at + i] += src[i] * gain;
}
/** Release fade at the very end (prevents clicks if a buffer is cut short). */
function tailFade(b: Float32Array, sr: number, ms = 8): Float32Array {
  const n = Math.min(b.length, Math.floor((sr * ms) / 1000));
  for (let i = 0; i < n; i++) b[b.length - 1 - i] *= i / n;
  return b;
}

/** Time-varying band-pass (coefficients refreshed every 32 samples). */
function sweepBand(buf: Float32Array, sr: number, hzAt: (t: number) => number, q: number): Float32Array {
  let b0 = 0, b2 = 0, a1 = 0, a2 = 0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    if ((i & 31) === 0) {
      const w = (TAU * clamp(hzAt(i / sr), 20, sr * 0.45)) / sr;
      const alpha = Math.sin(w) / (2 * q);
      const a0 = 1 + alpha;
      b0 = alpha / a0;
      b2 = -alpha / a0;
      a1 = (-2 * Math.cos(w)) / a0;
      a2 = (1 - alpha) / a0;
    }
    const x = buf[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
  return buf;
}

/** Sine with an arbitrary frequency curve (integrated phase). */
function glide(sr: number, dur: number, hzAt: (t: number) => number, envAt: (t: number) => number, harmonics: number[] = [1]): Float32Array {
  let ph = 0;
  return make(sr, dur, (t) => {
    ph += (TAU * hzAt(t)) / sr;
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) s += harmonics[h] * Math.sin(ph * (h + 1));
    return s * envAt(t);
  });
}

/** Inharmonic struck-metal / bell partials. */
function partials(sr: number, dur: number, f: number[], amp: number[], decay: number[], r?: Rand): Float32Array {
  const ph = f.map(() => (r ? r() * TAU : 0));
  return make(sr, dur, (t) => {
    let s = 0;
    for (let k = 0; k < f.length; k++) s += amp[k] * Math.exp(-t / decay[k]) * Math.sin(TAU * f[k] * t + ph[k]);
    return s * att(t, 0.001);
  });
}

function noiseBurst(sr: number, dur: number, r: Rand, decay: number, lpHz: number): Float32Array {
  const b = white(Math.floor(sr * dur), r);
  for (let i = 0; i < b.length; i++) b[i] *= Math.exp(-i / sr / decay);
  return lowpass(lowpass(b, sr, lpHz), sr, lpHz);
}

/** Soft-square / brass-ish additive tone with an envelope. */
function tone(sr: number, dur: number, hz: number, opts: { h?: number[]; a?: number; r?: number; vib?: number; bright?: (t: number) => number } = {}): Float32Array {
  const h = opts.h ?? [1, 0, 1 / 3, 0, 1 / 5];
  const a = opts.a ?? 0.005;
  const rel = opts.r ?? 0.05;
  let ph = 0;
  return make(sr, dur, (t) => {
    const vib = opts.vib ? 1 + opts.vib * Math.sin(TAU * 5.5 * t) * clamp((t - 0.1) * 5, 0, 1) : 1;
    ph += (TAU * hz * vib) / sr;
    const br = opts.bright ? opts.bright(t) : 1;
    let s = 0;
    for (let k = 0; k < h.length; k++) if (h[k]) s += h[k] * Math.sin(ph * (k + 1)) * (k === 0 ? 1 : br);
    const env = att(t, a) * clamp((dur - t) / rel, 0, 1);
    return s * env;
  });
}

function pluck(sr: number, hz: number, dur = 0.6, decay = 0.25): Float32Array {
  return make(sr, dur, (t) => {
    const ph = TAU * hz * t;
    return (Math.sin(ph) + 0.25 * Math.sin(2 * ph) * Math.exp(-t / 0.1) + 0.15 * Math.sin(4 * ph) * Math.exp(-t / 0.04)) * Math.exp(-t / decay) * att(t, 0.002);
  });
}

function bell(sr: number, hz: number, dur = 1.2, decay = 0.8): Float32Array {
  return partials(sr, dur, [hz, hz * 2.0, hz * 2.76, hz * 5.4], [1, 0.35, 0.45, 0.18], [decay, decay * 0.5, decay * 0.4, decay * 0.15]);
}

function seq(sr: number, dur: number, parts: [Float32Array, number, number][]): Float32Array {
  const out = new Float32Array(Math.floor(sr * dur));
  for (const [b, t, g] of parts) add(out, b, Math.floor(t * sr), g);
  return out;
}

// ------------------------------------------------------------------ one-shots

export type SfxName =
  | 'click' | 'beep' | 'beepHi' | 'goHorn' | 'cheer' | 'fanfare' | 'reelTick' | 'reelLand'
  | 'landSoft' | 'landHard' | 'crash' | 'hay' | 'cone' | 'carBump' | 'splash' | 'squelch' | 'crunch'
  | 'boing' | 'quack' | 'squeak' | 'bleat' | 'grunt' | 'chomp'
  | 'whoosh' | 'chime' | 'buzzer' | 'jingleWin' | 'jingleTry' | 'leadUp' | 'leadDown' | 'pop' | 'cough' | 'tootCpu';

type Gen = (sr: number) => Float32Array;

export const SFX: Record<SfxName, Gen> = {
  click: (sr) => glide(sr, 0.05, (t) => 1500 - 14000 * t, (t) => Math.exp(-t / 0.012) * att(t, 0.0008) * 0.7),

  beep: (sr) => normalize(tone(sr, 0.24, 587.33, { a: 0.004, r: 0.06 }), 0.8),
  beepHi: (sr) => normalize(tone(sr, 0.4, 1174.66, { a: 0.004, r: 0.12 }), 0.8),

  // Two-tone air horn (Bb major chord), with a little vibrato.
  goHorn: (sr) => {
    const h = [1, 0.55, 0.4, 0.28, 0.2, 0.14, 0.1];
    const parts = [466.16, 587.33, 698.46].map((f) => tone(sr, 1.0, f, { h, a: 0.025, r: 0.25, vib: 0.006, bright: (t) => 0.7 + 0.3 * Math.exp(-t / 0.3) }));
    const out = new Float32Array(parts[0].length);
    for (const p of parts) add(out, p, 0, 0.6);
    return normalize(out, 0.9);
  },

  // Crowd "yaaay": formant-filtered noise swells + applause clicks + a couple of whistles.
  cheer: (sr) => {
    const r = seeded(11);
    const dur = 3.2;
    const n = Math.floor(sr * dur);
    const env = (t: number): number => att(t, 0.18) * clamp((dur - t) / 1.6, 0, 1);
    const a = bandpass(white(n, r), sr, 850, 0.8);
    const b = bandpass(white(n, r), sr, 1700, 1.6);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const m1 = 0.65 + 0.35 * Math.sin(TAU * 3.1 * t) * Math.sin(TAU * 0.7 * t + 1);
      const m2 = 0.6 + 0.4 * Math.sin(TAU * 4.3 * t + 2);
      out[i] = (a[i] * m1 * 1.4 + b[i] * m2 * 0.9) * env(t);
    }
    const clap = new Float32Array(n);
    sprinkle(clap, sr, r, 170, 0.012, (t, k) => (r() * 2 - 1) * Math.exp(-t / 0.0025) * (0.4 + 0.6 * k));
    highpass(clap, sr, 900);
    for (let i = 0; i < n; i++) out[i] += clap[i] * env(i / sr) * 0.9;
    add(out, glide(sr, 0.6, (t) => 1300 + 900 * Math.min(1, t * 3), (t) => Math.sin((Math.PI * t) / 0.6) * 0.18), Math.floor(sr * 0.35));
    add(out, glide(sr, 0.5, (t) => 1600 + 700 * Math.min(1, t * 4), (t) => Math.sin((Math.PI * t) / 0.5) * 0.14), Math.floor(sr * 1.1));
    return normalize(out, 0.8);
  },

  // Trumpet arpeggio C-E-G-C' + cymbal.
  fanfare: (sr) => {
    const h = [1, 0.7, 0.5, 0.35, 0.25, 0.16, 0.1, 0.06];
    const brass = (m: number, d: number): Float32Array => tone(sr, d, midiHz(m), { h, a: 0.02, r: 0.08, vib: d > 0.5 ? 0.007 : 0, bright: (t) => 0.4 + 0.6 * clamp(t / 0.06, 0, 1) });
    const r = seeded(5);
    const cym = white(Math.floor(sr * 1.4), r);
    highpass(highpass(cym, sr, 5000), sr, 5000);
    for (let i = 0; i < cym.length; i++) cym[i] *= Math.exp(-i / sr / 0.45) * 1.5;
    const out = seq(sr, 2.1, [
      [brass(72, 0.16), 0, 0.5], [brass(76, 0.16), 0.17, 0.5], [brass(79, 0.16), 0.34, 0.5],
      [brass(84, 1.2), 0.52, 0.55], [brass(76, 1.2), 0.52, 0.3], [brass(79, 1.2), 0.52, 0.3],
      [cym, 0.52, 0.5],
    ]);
    return normalize(out, 0.85);
  },

  reelTick: (sr) => {
    const r = seeded(3);
    const b = bandpass(white(Math.floor(sr * 0.035), r), sr, 2600, 2.5);
    for (let i = 0; i < b.length; i++) {
      const t = i / sr;
      b[i] = b[i] * 3 * Math.exp(-t / 0.006) + 0.5 * Math.sin(TAU * 1700 * t) * Math.exp(-t / 0.004);
    }
    return normalize(b, 0.7);
  },
  reelLand: (sr) => {
    const clunk = noiseBurst(sr, 0.08, seeded(4), 0.012, 900);
    return normalize(seq(sr, 1.3, [[clunk, 0, 1.5], [bell(sr, 1318.5, 1.25, 0.7), 0.01, 0.8], [bell(sr, 1975.5, 1.0, 0.5), 0.01, 0.3]]), 0.85);
  },

  landSoft: (sr) => {
    let ph = 0;
    const thud = make(sr, 0.4, (t) => {
      ph += (TAU * (38 + 50 * Math.exp(-t / 0.04))) / sr;
      return Math.sin(ph) * Math.exp(-t / 0.1) * att(t, 0.002);
    });
    return normalize(seq(sr, 0.4, [[thud, 0, 1], [noiseBurst(sr, 0.15, seeded(8), 0.03, 500), 0, 1.2]]), 0.85);
  },
  landHard: (sr) => {
    const r = seeded(9);
    let ph = 0;
    const thud = make(sr, 0.6, (t) => {
      ph += (TAU * (34 + 70 * Math.exp(-t / 0.05))) / sr;
      return Math.sin(ph) * Math.exp(-t / 0.16) * att(t, 0.002);
    });
    const clank = partials(sr, 0.4, [310, 523, 847, 1290], [0.5, 0.4, 0.3, 0.15], [0.12, 0.08, 0.06, 0.04], r);
    return normalize(seq(sr, 0.6, [[thud, 0, 1], [noiseBurst(sr, 0.25, r, 0.05, 700), 0, 1.5], [clank, 0.01, 0.35], [clank, 0.09, 0.15]]), 0.9);
  },

  crash: (sr) => {
    const r = seeded(13);
    const metal = partials(sr, 0.9, [180, 433, 671, 1210, 1890], [0.6, 0.5, 0.4, 0.25, 0.15], [0.35, 0.22, 0.18, 0.1, 0.07], r);
    const crunch = new Float32Array(Math.floor(sr * 0.3));
    sprinkle(crunch, sr, r, 120, 0.01, (t) => (r() * 2 - 1) * Math.exp(-t / 0.003));
    bandpass(crunch, sr, 1800, 0.8);
    return normalize(seq(sr, 0.9, [[noiseBurst(sr, 0.5, r, 0.12, 1100), 0, 2.2], [metal, 0, 0.5], [crunch, 0.01, 2.5]]), 0.9);
  },
  hay: (sr) => {
    const r = seeded(17);
    let ph = 0;
    const thud = make(sr, 0.3, (t) => {
      ph += (TAU * (60 + 70 * Math.exp(-t / 0.04))) / sr;
      return Math.sin(ph) * Math.exp(-t / 0.07);
    });
    const rustle = bandpass(white(Math.floor(sr * 0.6), r), sr, 3800, 0.7);
    let g = 0;
    for (let i = 0; i < rustle.length; i++) {
      if (i % Math.floor(sr * 0.006) === 0) g = r();
      rustle[i] *= g * g * Math.exp(-i / sr / 0.18) * 3;
    }
    return normalize(seq(sr, 0.6, [[thud, 0, 1], [rustle, 0.005, 1]]), 0.8);
  },
  cone: (sr) => {
    const bonk = partials(sr, 0.35, [520, 1230, 2100], [1, 0.5, 0.25], [0.09, 0.05, 0.03]);
    return normalize(seq(sr, 0.35, [[bonk, 0, 1], [noiseBurst(sr, 0.03, seeded(19), 0.006, 3000), 0, 0.6]]), 0.8);
  },
  carBump: (sr) => {
    const r = seeded(23);
    const metal = partials(sr, 0.45, [140, 290, 520, 760], [0.6, 0.5, 0.3, 0.2], [0.15, 0.1, 0.07, 0.05], r);
    return normalize(seq(sr, 0.45, [[metal, 0, 1], [noiseBurst(sr, 0.2, r, 0.04, 800), 0, 1.4]]), 0.85);
  },

  splash: (sr) => {
    const r = seeded(29);
    const dur = 1.0;
    const nz = white(Math.floor(sr * dur), r);
    for (let i = 0; i < nz.length; i++) {
      const t = i / sr;
      nz[i] *= att(t, 0.01) * Math.exp(-t / 0.22);
    }
    sweepBand(nz, sr, (t) => 3200 * Math.exp(-t / 0.25) + 500, 0.7);
    const bub = new Float32Array(nz.length);
    sprinkle(bub, sr, r, 26, 0.03, (t, k) => Math.sin(TAU * (400 + 900 * k) * t * (1 + t * 25)) * Math.exp(-t / 0.01) * 0.5);
    for (let i = 0; i < bub.length; i++) bub[i] *= clamp(1 - i / sr / 0.9, 0, 1);
    return normalize(seq(sr, dur, [[nz, 0, 2.2], [bub, 0, 1]]), 0.85);
  },
  squelch: (sr) => {
    let ph = 0;
    const body = make(sr, 0.45, (t) => {
      const f = t < 0.12 ? 130 + 1600 * t : 322 - 500 * (t - 0.12);
      ph += (TAU * Math.max(70, f)) / sr;
      return Math.sin(ph) * (1 + 0.6 * Math.sin(2 * ph)) * Math.sin(Math.PI * clamp(t / 0.42, 0, 1));
    });
    return normalize(seq(sr, 0.45, [[body, 0, 0.8], [noiseBurst(sr, 0.4, seeded(31), 0.08, 600), 0, 1.2]]), 0.8);
  },
  crunch: (sr) => {
    const r = seeded(37);
    const b = new Float32Array(Math.floor(sr * 0.35));
    sprinkle(b, sr, r, 160, 0.008, (t, k) => (r() * 2 - 1) * Math.exp(-t / 0.002) * (0.3 + k));
    bandpass(b, sr, 2500, 0.7);
    for (let i = 0; i < b.length; i++) b[i] *= Math.exp(-i / sr / 0.12);
    return normalize(b, 0.8);
  },

  // ---- cartoon animals (friendly)
  boing: (sr) => normalize(glide(sr, 0.6, (t) => 280 * (1 + 0.45 * Math.exp(-t / 0.18) * Math.sin(TAU * 13 * t)), (t) => Math.exp(-t / 0.22) * att(t, 0.003), [1, 0.3, 0.1]), 0.8),
  quack: (sr) => {
    const one = (): Float32Array => {
      let ph = 0;
      const saw = make(sr, 0.2, (t) => {
        ph += (TAU * (270 - 200 * t)) / sr;
        let s = 0;
        for (let k = 1; k <= 12; k++) s += Math.sin(ph * k) / k;
        return s * att(t, 0.008) * Math.exp(-t / 0.09);
      });
      const f1 = bandpass(saw.slice(), sr, 1100, 3);
      const f2 = bandpass(saw, sr, 2600, 4);
      for (let i = 0; i < f1.length; i++) f1[i] += f2[i] * 0.6;
      return f1;
    };
    return normalize(seq(sr, 0.5, [[one(), 0, 1], [one(), 0.24, 0.85]]), 0.85);
  },
  squeak: (sr) => {
    const s = (): Float32Array => glide(sr, 0.12, (t) => 2300 + 1200 * Math.sin(Math.PI * t / 0.12) + 120 * Math.sin(TAU * 40 * t), (t) => Math.sin((Math.PI * t) / 0.12));
    return normalize(seq(sr, 0.32, [[s(), 0, 1], [s(), 0.17, 0.8]]), 0.6);
  },
  bleat: (sr) => {
    let ph = 0;
    const saw = make(sr, 0.55, (t) => {
      ph += (TAU * 430 * (1 + 0.04 * Math.sin(TAU * 7 * t))) / sr;
      let s = 0;
      for (let k = 1; k <= 10; k++) s += Math.sin(ph * k) / k;
      return s * att(t, 0.03) * clamp((0.55 - t) / 0.15, 0, 1) * (0.7 + 0.3 * Math.sin(TAU * 14 * t));
    });
    const f1 = bandpass(saw.slice(), sr, 900, 3);
    const f2 = bandpass(saw, sr, 2400, 4);
    for (let i = 0; i < f1.length; i++) f1[i] += f2[i] * 0.5;
    return normalize(f1, 0.75);
  },
  grunt: (sr) => {
    let ph = 0;
    const saw = make(sr, 0.5, (t) => {
      ph += (TAU * (110 - 40 * t)) / sr;
      let s = 0;
      for (let k = 1; k <= 14; k++) s += Math.sin(ph * k) / k;
      return s * att(t, 0.03) * Math.exp(-t / 0.18);
    });
    bandpass(saw, sr, 420, 1.5);
    return normalize(seq(sr, 0.5, [[saw, 0, 1], [noiseBurst(sr, 0.3, seeded(41), 0.08, 900), 0, 0.3]]), 0.85);
  },
  chomp: (sr) => {
    const clack = (): Float32Array => partials(sr, 0.08, [700, 1650, 2900], [1, 0.6, 0.3], [0.02, 0.012, 0.008]);
    let ph = 0;
    const purr = make(sr, 0.4, (t) => {
      ph += (TAU * 62) / sr;
      return (Math.sin(ph) + 0.4 * Math.sin(3 * ph)) * (0.5 + 0.5 * Math.sin(TAU * 18 * t)) * Math.sin(Math.PI * t / 0.4) * 0.5;
    });
    return normalize(seq(sr, 0.6, [[clack(), 0, 1], [clack(), 0.14, 0.9], [purr, 0.2, 0.7]]), 0.85);
  },

  whoosh: (sr) => {
    const dur = 0.6;
    const nz = white(Math.floor(sr * dur), seeded(43));
    for (let i = 0; i < nz.length; i++) nz[i] *= Math.sin((Math.PI * i) / nz.length) ** 2;
    sweepBand(nz, sr, (t) => 400 + 2400 * Math.sin((Math.PI * t) / dur), 1.2);
    return normalize(nz, 0.7);
  },
  chime: (sr) => normalize(seq(sr, 1.0, [[bell(sr, 1568, 0.6, 0.35), 0, 0.7], [bell(sr, 2093, 0.9, 0.45), 0.1, 0.8]]), 0.7),
  buzzer: (sr) => {
    const h = [1, 0, 0.33, 0, 0.2];
    const a = tone(sr, 0.7, 196, { h, a: 0.01, r: 0.15 });
    const b = tone(sr, 0.7, 233.08, { h, a: 0.01, r: 0.15 });
    for (let i = 0; i < a.length; i++) a[i] = (a[i] + b[i]) * (0.75 + 0.25 * Math.sin((TAU * 12 * i) / sr));
    return normalize(a, 0.7);
  },
  jingleWin: (sr) => {
    const notes: [number, number][] = [[72, 0], [76, 0.1], [79, 0.2], [84, 0.3], [88, 0.42]];
    const parts: [Float32Array, number, number][] = notes.map(([m, t]) => [pluck(sr, midiHz(m), 0.9, 0.3), t, 0.6]);
    parts.push([bell(sr, midiHz(84), 1.2, 0.7), 0.42, 0.35], [pluck(sr, midiHz(79), 1.0, 0.4), 0.42, 0.4], [pluck(sr, midiHz(76), 1.0, 0.4), 0.42, 0.4]);
    return normalize(seq(sr, 1.6, parts), 0.85);
  },
  jingleTry: (sr) => {
    const notes: [number, number][] = [[67, 0], [72, 0.16], [76, 0.32], [74, 0.48], [72, 0.7]];
    return normalize(seq(sr, 1.6, notes.map(([m, t]) => [pluck(sr, midiHz(m), 0.9, 0.35), t, 0.6] as [Float32Array, number, number])), 0.75);
  },
  leadUp: (sr) => normalize(seq(sr, 0.7, [[bell(sr, 1318.5, 0.5, 0.25), 0, 0.6], [bell(sr, 1975.5, 0.6, 0.3), 0.08, 0.7]]), 0.7),
  leadDown: (sr) => normalize(seq(sr, 0.7, [[pluck(sr, 220, 0.5, 0.2), 0, 0.7], [pluck(sr, 164.8, 0.6, 0.25), 0.12, 0.7]]), 0.6),
  pop: (sr) => {
    const r = seeded(47);
    let ph = 0;
    const low = make(sr, 0.15, (t) => {
      ph += (TAU * (90 - 200 * t)) / sr;
      return Math.sin(ph) * Math.exp(-t / 0.035);
    });
    return normalize(seq(sr, 0.15, [[noiseBurst(sr, 0.12, r, 0.018, 1200), 0, 2.5], [low, 0, 0.8]]), 0.85);
  },
  // Sedan "cough": pop-pop-ppff
  cough: (sr) => {
    const r = seeded(53);
    const p = (): Float32Array => noiseBurst(sr, 0.1, r, 0.02, 700);
    return normalize(seq(sr, 0.5, [[p(), 0, 1], [p(), 0.11, 0.7], [noiseBurst(sr, 0.25, r, 0.06, 400), 0.2, 0.6]]), 0.8);
  },
  tootCpu: (sr) => normalize(tone(sr, 0.35, 392, { h: [1, 0.5, 0.33, 0.2], a: 0.02, r: 0.1 }), 0.7),
};

/** Map an animal kind string (from the world agent) to a voice. Unknown kinds get a friendly boing. */
export function animalVoice(kind: string): SfxName {
  const k = kind.toLowerCase();
  if (k.includes('duck')) return 'quack';
  if (k.includes('mouse') || k.includes('rat')) return 'squeak';
  if (k.includes('deer')) return 'bleat';
  if (k.includes('bear')) return 'grunt';
  if (k.includes('croc') || k.includes('gator')) return 'chomp';
  return 'boing';
}

/** Map an obstacle kind string to a hit sound. */
export function obstacleSound(kind: string): SfxName {
  const k = kind.toLowerCase();
  if (k.includes('hay') || k.includes('bale')) return 'hay';
  if (k.includes('cone')) return 'cone';
  if (k.includes('fence') || k.includes('crate') || k.includes('barrel')) return 'carBump';
  return 'crash'; // boulder, rock, log, wall, tree, ...
}

// ------------------------------------------------------------------ loops

export type LoopName = SurfaceType | 'squeal';

const LOOP_S = 1.5;
const FADE_S = 0.1;

function bubbleBed(sr: number, r: Rand, n: number, perS: number, lo: number, hi: number, dur: number): Float32Array {
  const b = new Float32Array(n);
  sprinkle(b, sr, r, perS, dur, (t, k) => {
    const f = lo + (hi - lo) * k;
    return Math.sin(TAU * f * t * (1 + (t / dur) * 1.5)) * Math.sin((Math.PI * t) / dur);
  });
  return b;
}

export const LOOPS: Record<LoopName, (sr: number) => Float32Array> = {
  asphalt: (sr) => {
    const r = seeded(101);
    const n = Math.floor(sr * (LOOP_S + FADE_S));
    const roar = lowpass(lowpass(brown(n, r), sr, 500), sr, 700);
    const hiss = bandpass(white(n, r), sr, 1100, 0.7);
    for (let i = 0; i < n; i++) roar[i] += hiss[i] * 0.06;
    return normalizeRms(removeDC(loopify(roar, Math.floor(sr * LOOP_S))), 0.2);
  },
  dirt: (sr) => {
    const r = seeded(103);
    const len = Math.floor(sr * LOOP_S);
    const n = len + Math.floor(sr * FADE_S);
    const bed = loopify(lowpass(brown(n, r), sr, 900), len);
    const grains = new Float32Array(len);
    sprinkle(grains, sr, r, 70, 0.01, (t, k) => (r() * 2 - 1) * Math.exp(-t / 0.003) * (0.3 + k));
    bandpass(grains, sr, 1200, 0.8);
    for (let i = 0; i < len; i++) bed[i] += grains[i] * 3;
    return normalizeRms(removeDC(bed), 0.2);
  },
  gravel: (sr) => {
    const r = seeded(107);
    const len = Math.floor(sr * LOOP_S);
    const n = len + Math.floor(sr * FADE_S);
    const bed = loopify(lowpass(brown(n, r), sr, 600), len);
    const grains = new Float32Array(len);
    sprinkle(grains, sr, r, 320, 0.006, (t, k) => (r() * 2 - 1) * Math.exp(-t / 0.0018) * (0.2 + k * k));
    bandpass(grains, sr, 3000, 0.6);
    for (let i = 0; i < len; i++) bed[i] = bed[i] * 0.5 + grains[i] * 4;
    return normalizeRms(removeDC(bed), 0.2);
  },
  mud: (sr) => {
    const r = seeded(109);
    const len = Math.floor(sr * LOOP_S);
    const n = len + Math.floor(sr * FADE_S);
    const slosh = loopify(lowpass(brown(n, r), sr, 350), len);
    const bub = bubbleBed(sr, r, len, 16, 110, 260, 0.05);
    for (let i = 0; i < len; i++) {
      const m = 0.6 + 0.4 * Math.sin((TAU * 2 * i) / len); // 2 cycles per loop → seamless
      slosh[i] = slosh[i] * m + bub[i] * 0.5;
    }
    return normalizeRms(removeDC(slosh), 0.2);
  },
  sand: (sr) => {
    const r = seeded(113);
    const len = Math.floor(sr * LOOP_S);
    const n = len + Math.floor(sr * FADE_S);
    const hiss = loopify(bandpass(white(n, r), sr, 4200, 0.6), len);
    for (let i = 0; i < len; i++) hiss[i] *= 0.7 + 0.3 * Math.sin((TAU * 3 * i) / len);
    const grains = new Float32Array(len);
    sprinkle(grains, sr, r, 90, 0.004, (t) => (r() * 2 - 1) * Math.exp(-t / 0.0015));
    highpass(grains, sr, 2500);
    for (let i = 0; i < len; i++) hiss[i] += grains[i];
    return normalizeRms(removeDC(hiss), 0.17);
  },
  water: (sr) => {
    const r = seeded(127);
    const len = Math.floor(sr * LOOP_S);
    const n = len + Math.floor(sr * FADE_S);
    const wash = loopify(bandpass(white(n, r), sr, 1300, 0.7), len);
    for (let i = 0; i < len; i++) wash[i] *= 0.6 + 0.4 * Math.sin((TAU * 4 * i) / len + Math.sin((TAU * i) / len));
    const bub = bubbleBed(sr, r, len, 40, 500, 1600, 0.025);
    for (let i = 0; i < len; i++) wash[i] += bub[i] * 0.25;
    return normalizeRms(removeDC(wash), 0.2);
  },
  // Tyre squeal: periodic over exactly 1 s (integer Hz + integer-rate vibrato) so it loops cleanly.
  squeal: (sr) => {
    const len = sr; // 1 s
    const r = seeded(131);
    const nz = loopify(bandpass(white(len + Math.floor(sr * FADE_S), r), sr, 2200, 3), len);
    return normalizeRms(
      make(sr, 1, (t, i) => {
        const ph = TAU * 1050 * t + (30 / 6) * Math.sin(TAU * 6 * t) + 2 * Math.sin(TAU * 13 * t);
        const am = 0.75 + 0.25 * Math.sin(TAU * 11 * t);
        return (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph)) * am + nz[i] * 0.8;
      }),
      0.22,
    );
  },
};

// ------------------------------------------------------------------ cache

type BufName = SfxName | `loop:${LoopName}`;
const cache = new WeakMap<BaseAudioContext, Map<BufName, AudioBuffer>>();

/** Cached buffer for a one-shot or `loop:<name>`, rendered at `sr` (the context resamples on playback). */
export function sfxBuffer(ctx: BaseAudioContext, name: BufName, sr = ctx.sampleRate): AudioBuffer {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = new Map()));
  let b = m.get(name);
  if (!b) {
    const data = name.startsWith('loop:') ? LOOPS[name.slice(5) as LoopName](sr) : tailFade(SFX[name as SfxName](sr), sr);
    b = ctx.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    m.set(name, b);
  }
  return b;
}

export const ALL_SFX = Object.keys(SFX) as SfxName[];
export const ALL_LOOPS = Object.keys(LOOPS) as LoopName[];
