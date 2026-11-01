import { clamp } from '../core/math';
import type { VehicleSpec } from '../vehicles/types';
import { bandpass, highpass, loopify, normalizeRms, removeDC, seeded, white } from './dsp';

export type EngineSoundId = VehicleSpec['engineSound'];

/**
 * Engine character. The loop buffer is rendered once per profile (≈0.7 s) at the idle firing rate;
 * at runtime only `playbackRate` (pitch) and a low-pass (brightness) move with rpm/throttle,
 * so one engine costs one BufferSource + one Biquad + one Gain.
 */
export interface EngineProfile {
  /** Firing rate (Hz) baked into the loop = pitch at idle. */
  baseHz: number;
  /** playbackRate at rpm = 1 (idle is 1). */
  maxRate: number;
  /** Relative amplitude of each firing within one engine cycle (length = cylinders fired per cycle). */
  fires: number[];
  /** Firing-time jitter (fraction of period) and amplitude jitter (0..1). */
  jitter: number;
  ampJitter: number;
  /** Exhaust resonance of each pulse (Hz) and its decay (s). */
  pulseHz: number;
  decay: number;
  /** Continuous fundamental (sine) amount and sub-rumble at crank rate. */
  sub: number;
  rumble: number;
  /** Tonal "whine" at a harmonic of the firing rate. */
  whine: number;
  whineH: number;
  /** Band-passed mechanical noise. */
  noise: number;
  noiseHz: number;
  /** Probability that a firing is skipped (comedic sputter). */
  misfire: number;
  /** Low-pass cutoff (Hz) at idle/no throttle, plus range added by rpm and throttle. */
  lpBase: number;
  lpRpm: number;
  lpThrottle: number;
  /** Output trim. */
  gain: number;
  /** Slow pitch wobble depth (sedan "is it going to make it?"). */
  wobble: number;
  /** Chance of a backfire pop on throttle lift at high rpm. */
  backfire: number;
}

export const ENGINE_PROFILES: Record<EngineSoundId, EngineProfile> = {
  // Cross-plane V8 burble: uneven amplitudes + crank-rate rumble.
  v8: {
    baseHz: 46, maxRate: 3.7, fires: [1, 0.55, 0.9, 0.45, 1, 0.6, 0.8, 0.5], jitter: 0.04, ampJitter: 0.25,
    pulseHz: 180, decay: 0.012, sub: 0.5, rumble: 0.55, whine: 0.02, whineH: 6, noise: 0.06, noiseHz: 900,
    misfire: 0, lpBase: 520, lpRpm: 2600, lpThrottle: 1400, gain: 0.95, wobble: 0, backfire: 0.35,
  },
  // Pickup: smoother, lower V8.
  truck: {
    baseHz: 40, maxRate: 3.0, fires: [1, 0.7, 0.9, 0.65, 1, 0.75, 0.85, 0.7], jitter: 0.03, ampJitter: 0.18,
    pulseHz: 140, decay: 0.014, sub: 0.6, rumble: 0.35, whine: 0.03, whineH: 4, noise: 0.08, noiseHz: 700,
    misfire: 0, lpBase: 420, lpRpm: 2000, lpThrottle: 1000, gain: 0.95, wobble: 0, backfire: 0,
  },
  // Monster truck: huge, slow, sub-heavy.
  monster: {
    baseHz: 30, maxRate: 2.6, fires: [1, 0.6, 0.95, 0.55, 1, 0.65, 0.9, 0.5], jitter: 0.05, ampJitter: 0.3,
    pulseHz: 95, decay: 0.022, sub: 0.75, rumble: 0.8, whine: 0.04, whineH: 3, noise: 0.1, noiseHz: 450,
    misfire: 0, lpBase: 300, lpRpm: 1500, lpThrottle: 900, gain: 1.05, wobble: 0, backfire: 0.15,
  },
  // Sports car: smooth flat-six, bright, revs high with a tonal scream.
  sport: {
    baseHz: 68, maxRate: 4.9, fires: [1, 0.92, 1, 0.94, 1, 0.9], jitter: 0.01, ampJitter: 0.06,
    pulseHz: 420, decay: 0.006, sub: 0.35, rumble: 0.08, whine: 0.16, whineH: 2, noise: 0.05, noiseHz: 2400,
    misfire: 0, lpBase: 900, lpRpm: 5200, lpThrottle: 1800, gain: 0.8, wobble: 0, backfire: 0.1,
  },
  // Dune buggy: buzzy air-cooled whine, nasal.
  buggy: {
    baseHz: 52, maxRate: 4.3, fires: [1, 0.85], jitter: 0.02, ampJitter: 0.12,
    pulseHz: 650, decay: 0.005, sub: 0.15, rumble: 0.05, whine: 0.22, whineH: 3, noise: 0.12, noiseHz: 3200,
    misfire: 0, lpBase: 1100, lpRpm: 4200, lpThrottle: 1500, gain: 0.7, wobble: 0, backfire: 0,
  },
  // Grandma's sedan: weedy 4-cylinder that sputters and coughs (comedic).
  sedan: {
    baseHz: 36, maxRate: 2.4, fires: [1, 0.8, 0.95, 0.75], jitter: 0.06, ampJitter: 0.35,
    pulseHz: 260, decay: 0.009, sub: 0.3, rumble: 0.15, whine: 0.05, whineH: 5, noise: 0.14, noiseHz: 1300,
    misfire: 0.09, lpBase: 650, lpRpm: 1900, lpThrottle: 900, gain: 0.85, wobble: 0.035, backfire: 0.6,
  },
};

/** Render a seamless engine loop (mono) for a profile. Pure JS: deterministic and testable in Node. */
export function renderEngineLoop(p: EngineProfile, sr: number, seed = 7): Float32Array {
  const r = seeded(seed);
  const perCycle = p.fires.length;
  const cycles = Math.max(2, Math.round((p.baseHz * 0.7) / perCycle));
  const n = cycles * perCycle; // firings in the loop
  const len = Math.round((n * sr) / p.baseHz);
  const f0 = (n * sr) / len; // exact firing rate so everything has an integer number of periods
  const crank = (cycles * sr) / len; // one engine cycle
  const out = new Float32Array(len);
  const period = len / n;
  const pulseLen = Math.min(len, Math.floor(p.decay * 6 * sr));

  for (let k = 0; k < n; k++) {
    if (p.misfire > 0 && r() < p.misfire) continue;
    const amp = p.fires[k % perCycle] * (1 - p.ampJitter * r());
    const start = k * period + (r() - 0.5) * 2 * p.jitter * period;
    const s0 = Math.floor(start);
    const ph = r() * Math.PI * 2;
    for (let i = 0; i < pulseLen; i++) {
      const t = i / sr;
      const env = Math.exp(-t / p.decay);
      const v = env * (Math.sin(2 * Math.PI * p.pulseHz * t + ph) + 0.6 * Math.sin(Math.PI * p.pulseHz * t));
      let j = (s0 + i) % len;
      if (j < 0) j += len;
      out[j] += amp * v;
    }
  }
  // Tonal parts (integer periods within the loop → seamless).
  const tau = 2 * Math.PI;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    out[i] +=
      p.sub * Math.sin(tau * f0 * t) +
      p.rumble * Math.sin(tau * crank * 2 * t) * (0.6 + 0.4 * Math.sin(tau * crank * t)) +
      p.whine * Math.sin(tau * f0 * p.whineH * t);
  }
  // Mechanical noise: band-passed and crossfaded so it loops.
  if (p.noise > 0) {
    const fade = Math.floor(sr * 0.05);
    const nz = bandpass(white(len + fade, r), sr, p.noiseHz, 1.2);
    const looped = loopify(nz, len);
    // Amplitude-modulate by the firing rate so the hiss "chugs" with the engine.
    for (let i = 0; i < len; i++) out[i] += looped[i] * p.noise * 4 * (0.55 + 0.45 * Math.sin(tau * f0 * (i / sr)));
  }
  highpass(out, sr, 18);
  removeDC(out);
  // One-pole filters break the very first samples' continuity slightly; a second pass over the
  // wrapped start smooths it (the filter state carries over from the end of the loop).
  smoothSeam(out, sr);
  return normalizeRms(out, 0.28);
}

/** Blend the first few ms toward the loop end so filtering can't leave a click at the seam. */
function smoothSeam(buf: Float32Array, sr: number): void {
  const n = Math.min(buf.length >> 2, Math.floor(sr * 0.004));
  const end = buf[buf.length - 1];
  const d = buf[0] - end;
  for (let i = 0; i < n; i++) buf[i] -= d * (1 - i / n) * 0.5;
  for (let i = 0; i < n; i++) buf[buf.length - 1 - i] += d * (1 - i / n) * 0.5;
}

const loopCache = new WeakMap<BaseAudioContext, Map<EngineSoundId, AudioBuffer>>();

/**
 * Cached loop buffer. `sr` lets us render at a lower rate than the context (e.g. 24 kHz): the engine
 * has little content above ~8 kHz, rendering is ~2x cheaper and the context resamples on playback.
 */
export function engineBuffer(ctx: BaseAudioContext, id: EngineSoundId, sr = ctx.sampleRate): AudioBuffer {
  let m = loopCache.get(ctx);
  if (!m) loopCache.set(ctx, (m = new Map()));
  let b = m.get(id);
  if (!b) {
    const data = renderEngineLoop(ENGINE_PROFILES[id], sr, id.length * 31 + 5);
    b = ctx.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    m.set(id, b);
  }
  return b;
}

/**
 * One running engine: loop → low-pass → gain → (optional pan) → out.
 * `set()` schedules smooth parameter moves at time `at` (works for live and offline contexts).
 */
export class EngineVoice {
  readonly id: EngineSoundId;
  readonly profile: EngineProfile;
  private src: AudioBufferSourceNode;
  private filter: BiquadFilterNode;
  readonly gain: GainNode;
  private pan: StereoPannerNode | null;
  private stopped = false;
  private lastRate = -1;
  private lastCut = -1;
  private lastGain = -1;
  private lastPan = 2;

  constructor(
    private ctx: BaseAudioContext,
    id: EngineSoundId,
    out: AudioNode,
    at = ctx.currentTime,
    sr = ctx.sampleRate,
  ) {
    this.id = id;
    this.profile = ENGINE_PROFILES[id];
    this.src = ctx.createBufferSource();
    this.src.buffer = engineBuffer(ctx, id, sr);
    this.src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.9;
    this.filter.frequency.value = this.profile.lpBase;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.src.connect(this.filter).connect(this.gain);
    this.pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (this.pan) this.gain.connect(this.pan).connect(out);
    else this.gain.connect(out);
    // Random start offset so two identical engines don't phase.
    this.src.start(at, Math.random() * (this.src.buffer?.duration ?? 0));
  }

  /**
   * rpm 0..1, throttle 0..1, level = distance attenuation (1 = close), pan -1..1, muffle 0..1 (distance low-pass).
   * `wobbleT` is a time value for the sedan's pitch wobble.
   */
  set(rpm: number, throttle: number, at: number, level = 1, pan = 0, muffle = 0): void {
    if (this.stopped) return;
    const p = this.profile;
    const x = clamp((rpm - 0.12) / 0.88, 0, 1);
    let rate = 1 + (p.maxRate - 1) * x;
    if (p.wobble > 0) rate *= 1 + p.wobble * Math.sin(at * 5.3) * Math.sin(at * 1.7);
    const cut = (p.lpBase + p.lpRpm * x + p.lpThrottle * throttle) * (1 - 0.75 * muffle);
    const g = p.gain * level * (0.42 + 0.38 * throttle + 0.25 * x);
    const tc = 0.04;
    if (Math.abs(rate - this.lastRate) > 0.004) {
      this.src.playbackRate.setTargetAtTime(rate, at, tc);
      this.lastRate = rate;
    }
    if (Math.abs(cut - this.lastCut) > 15) {
      this.filter.frequency.setTargetAtTime(cut, at, tc);
      this.lastCut = cut;
    }
    if (Math.abs(g - this.lastGain) > 0.005) {
      this.gain.gain.setTargetAtTime(g, at, 0.06);
      this.lastGain = g;
    }
    if (this.pan && Math.abs(pan - this.lastPan) > 0.02) {
      this.pan.pan.setTargetAtTime(pan, at, 0.08);
      this.lastPan = pan;
    }
  }

  stop(at = this.ctx.currentTime, fade = 0.25): void {
    if (this.stopped) return;
    this.stopped = true;
    this.gain.gain.cancelScheduledValues(at);
    this.gain.gain.setTargetAtTime(0, at, fade / 4);
    try {
      this.src.stop(at + fade + 0.05);
    } catch {
      /* already stopped */
    }
    this.src.onended = () => {
      this.gain.disconnect();
      this.pan?.disconnect();
    };
  }
}
