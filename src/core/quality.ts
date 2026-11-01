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
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    level: 'low',
    pixelRatioCap: 1,
    shadows: false,
    shadowMapSize: 512,
    shadowRange: 30,
    viewDistance: 260,
    fogNear: 70,
    antialias: false,
    detail: 0.4,
    textureSize: 256,
  },
  medium: {
    level: 'medium',
    pixelRatioCap: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    shadowRange: 35,
    viewDistance: 420,
    fogNear: 120,
    antialias: false,
    detail: 0.7,
    textureSize: 512,
  },
  high: {
    level: 'high',
    pixelRatioCap: 1.75,
    shadows: true,
    shadowMapSize: 2048,
    shadowRange: 45,
    viewDistance: 650,
    fogNear: 180,
    antialias: true,
    detail: 1,
    textureSize: 1024,
  },
};

const ORDER: QualityLevel[] = ['low', 'medium', 'high'];

/**
 * Holds the active preset and watches frame times. If the average frame time
 * stays above the budget it drops one level (never auto-raises, to avoid flip-flopping).
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
  static readonly SLOW_WINDOWS = 3;
  static readonly WARMUP_MS = 4000;

  constructor() {
    this.preset = QUALITY_PRESETS[settings.quality] ?? QUALITY_PRESETS.medium;
  }

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
    this.warmupUntil = performance.now() + QualityManager.WARMUP_MS;
  }

  /** Feed one frame's real duration (ms). Called by the game loop. */
  sample(frameMs: number, now: number): void {
    if (frameMs > 250) return; // tab switch / GC hiccup: ignore
    this.avgFrameMs += (frameMs - this.avgFrameMs) * 0.05;
    if (!this.enabled || !settings.autoQuality || now < this.warmupUntil) return;
    this.windowSum += frameMs;
    this.windowCount++;
    if (now - this.windowStart < 1000) return;
    const avg = this.windowSum / Math.max(1, this.windowCount);
    this.windowSum = 0;
    this.windowCount = 0;
    this.windowStart = now;
    this.slowWindows = avg > QualityManager.BUDGET_MS ? this.slowWindows + 1 : 0;
    if (this.slowWindows >= QualityManager.SLOW_WINDOWS) {
      const i = ORDER.indexOf(this.preset.level);
      if (i > 0) {
        console.info(`[quality] avg frame ${avg.toFixed(1)} ms → dropping to ${ORDER[i - 1]}`);
        this.set(ORDER[i - 1], true);
      } else {
        this.slowWindows = 0;
      }
    }
  }
}
