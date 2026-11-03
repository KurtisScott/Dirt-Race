import { events } from './events';
import { settings, updateSettings } from './settings';
import type { QualityLevel } from './types';

/** Everything that changes with the graphics setting. Other modules read `quality.preset`. */
export interface QualityPreset {
  level: QualityLevel;
  /** Upper bound for renderer pixel ratio (also capped by devicePixelRatio). */
  pixelRatioCap: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Half-size of the sun's shadow camera box around the player, metres. */
  shadowRange: number;
  /** Camera far plane & fog end, metres. */
  viewDistance: number;
  fogNear: number;
  /** MSAA. Can only be set when the WebGL context is created → applies on next launch. */
  antialias: boolean;
  /** Multiplier for particle counts / decorative instance density (fx & world read this). */
  detail: number;
  /** Max texture size for procedural textures (world reads this). */
  textureSize: number;
  // ---- Round 2 realism knobs (High/Ultra). Low/Medium keep the original lightweight look.
  /** Physically based materials everywhere + sky image-based lighting (PMREM). False → Lambert look. */
  pbr: boolean;
  /** Post-processing chain: none (direct to screen), light (bloom + grade), full (+ AO, speed blur, SMAA). */
  post: 'none' | 'light' | 'full';
  /** Soft-shadow filter radius in shadow-map texels (PCF). */
  shadowRadius: number;
  /** Resolution of the photographic PBR terrain set (albedo + normal/roughness/height); 0 = procedural layers. */
  terrainPBR: 0 | 512 | 1024;
  /** Instanced grass blades around the camera (count; 0 = off). */
  grass: number;
  /** Layered foliage cards with wind sway instead of solid low-poly crowns. */
  foliageCards: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    level: 'low',
    pixelRatioCap: 1,
    shadows: false,
    shadowMapSize: 512,
    shadowRange: 30,
    viewDistance: 240,
    fogNear: 90,
    antialias: false,
    detail: 0.4,
    textureSize: 256,
    pbr: false,
    post: 'none',
    shadowRadius: 1,
    terrainPBR: 0,
    grass: 0,
    foliageCards: false,
  },
  medium: {
    level: 'medium',
    pixelRatioCap: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    shadowRange: 35,
    viewDistance: 420,
    fogNear: 170,
    antialias: false,
    detail: 0.7,
    textureSize: 512,
    pbr: false,
    post: 'none',
    shadowRadius: 1,
    terrainPBR: 0,
    grass: 0,
    foliageCards: false,
  },
  high: {
    level: 'high',
    pixelRatioCap: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    shadowRange: 45,
    viewDistance: 700,
    fogNear: 190,
    antialias: true,
    detail: 1,
    textureSize: 1024,
    pbr: true,
    post: 'light',
    shadowRadius: 2,
    terrainPBR: 512,
    grass: 0,
    foliageCards: true,
  },
  /** Round 2 default on every device: max realism, accepting a lower frame rate on the old iPads. */
  ultra: {
    level: 'ultra',
    pixelRatioCap: 1.5,
    shadows: true,
    shadowMapSize: 4096,
    shadowRange: 60,
    viewDistance: 900,
    fogNear: 200,
    antialias: false, // SMAA in the post chain instead
    detail: 1,
    textureSize: 1024,
    pbr: true,
    post: 'full',
    shadowRadius: 3,
    terrainPBR: 1024,
    grass: 14000,
    foliageCards: true,
  },
};

export const QUALITY_ORDER: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
const ORDER = QUALITY_ORDER;

/**
 * Holds the active preset and watches frame times. With `settings.autoQuality` (opt-in "Auto" in Settings)
 * it drops one level when the average frame time stays above the budget (never auto-raises). Otherwise
 * (the Round 2 default) it only raises `quality:prompt` once when racing stays under ~20 fps for ~10 s.
 * Listen to 'quality:changed' to re-apply settings in your module.
 */
export class QualityManager {
  preset: QualityPreset;
  /** Rolling average frame time in ms (exposed for the debug overlay). */
  avgFrameMs = 16.7;

  private windowSum = 0;
  private windowCount = 0;
  private windowStart = 0;
  private slowWindows = 0;
  private warmupUntil = 0;
  private enabled = true;

  /** Average frame time above this for SLOW_WINDOWS consecutive 1 s windows triggers a downgrade. ~45 fps. */
  static readonly BUDGET_MS = 22;
  /**
   * Already on Low: above this (≈ 25 fps) for SLOW_WINDOWS windows emits 'quality:slow' once (the world
   * then switches to its cheapest terrain shader). Higher than BUDGET_MS so a 30 fps cap (iOS Low Power
   * Mode) does not trigger it.
   */
  static readonly LOW_FLOOR_MS = 40;
  /** Number of automatic drops so far (debug/tests). */
  autoDrops = 0;
  private slowEmitted = false;
  static readonly SLOW_WINDOWS = 3;
  static readonly WARMUP_MS = 4000;
  /** Prompt threshold (auto-quality off): average frame above this (≈ 20 fps)… */
  static readonly PROMPT_MS = 50;
  /** …for this many consecutive 1 s windows of racing. */
  static readonly PROMPT_WINDOWS = 10;
  private promptWindows = 0;
  private promptFrameSum = 0;
  /** The prompt has been raised this session (it is asked at most once ever: settings.slowPrompt). */
  promptRaised = false;

  constructor() {
    this.preset = QUALITY_PRESETS[settings.quality] ?? QUALITY_PRESETS.ultra;
  }

  /** Level one step down (or two when very slow), for the slow prompt. */
  suggestLower(avgMs: number): QualityLevel {
    const i = ORDER.indexOf(this.preset.level);
    const steps = avgMs > 75 && i >= 2 ? 2 : 1;
    return ORDER[Math.max(0, i - steps)];
  }

  /** Change level. `auto` = chosen by the frame-time monitor (persisted too, so the next launch starts there). */
  set(level: QualityLevel, auto = false): void {
    if (level === this.preset.level) return;
    this.preset = QUALITY_PRESETS[level];
    updateSettings({ quality: level });
    this.resetMonitor();
    events.emit('quality:changed', { level, auto });
  }

  /** Pause monitoring (menus, hidden tab) — only gameplay frames should count. */
  setMonitoring(on: boolean): void {
    this.enabled = on;
    this.resetMonitor();
  }

  resetMonitor(): void {
    this.windowSum = 0;
    this.windowCount = 0;
    this.windowStart = performance.now();
    this.slowWindows = 0;
    this.promptWindows = 0;
    this.promptFrameSum = 0;
    this.warmupUntil = performance.now() + QualityManager.WARMUP_MS;
  }

  /** Feed one frame's real duration (ms). Called by the game loop. */
  sample(frameMs: number, now: number): void {
    if (frameMs > 250) return; // tab switch / GC hiccup: ignore
    this.avgFrameMs += (frameMs - this.avgFrameMs) * 0.05;
    if (!this.enabled || now < this.warmupUntil) return;
    this.windowSum += frameMs;
    this.windowCount++;
    if (now - this.windowStart < 1000) return;
    const avg = this.windowSum / Math.max(1, this.windowCount);
    this.windowSum = 0;
    this.windowCount = 0;
    this.windowStart = now;
    const i = ORDER.indexOf(this.preset.level);
    if (!settings.autoQuality) {
      // Round 2: never drop by itself. If it stays under ~20 fps for ~10 s, ask once (UI shows the prompt).
      if (i === 0 || settings.slowPrompt !== 'unasked' || this.promptRaised) return;
      if (avg > QualityManager.PROMPT_MS) {
        this.promptWindows++;
        this.promptFrameSum += avg;
      } else {
        this.promptWindows = 0;
        this.promptFrameSum = 0;
      }
      if (this.promptWindows >= QualityManager.PROMPT_WINDOWS) {
        const mean = this.promptFrameSum / this.promptWindows;
        this.promptRaised = true;
        console.info(`[quality] avg frame ${mean.toFixed(1)} ms for ${this.promptWindows} s → asking to lower graphics`);
        events.emit('quality:prompt', { fps: Math.round(1000 / mean), suggest: this.suggestLower(mean) });
      }
      return;
    }
    const budget = i > 0 ? QualityManager.BUDGET_MS : QualityManager.LOW_FLOOR_MS;
    this.slowWindows = avg > budget ? this.slowWindows + 1 : 0;
    if (this.slowWindows >= QualityManager.SLOW_WINDOWS) {
      if (i > 0) {
        console.info(`[quality] avg frame ${avg.toFixed(1)} ms → dropping to ${ORDER[i - 1]}`);
        this.autoDrops++;
        this.set(ORDER[i - 1], true);
      } else {
        this.slowWindows = 0;
        if (!this.slowEmitted) {
          this.slowEmitted = true;
          console.info(`[quality] avg frame ${avg.toFixed(1)} ms on Low → asking for the cheapest terrain`);
          events.emit('quality:slow', {});
        }
      }
    }
  }
}
