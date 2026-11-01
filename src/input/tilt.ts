import { events, type TiltStatus } from '../core/events';
import { clamp, DEG, smoothing } from '../core/math';
import { settings } from '../core/settings';
import type { Sensitivity } from '../core/types';
import type { SteerSource } from './types';

/** Full-lock tilt angle per sensitivity (SPEC: ~30° on Medium). */
export const FULL_LOCK_DEG: Record<Sensitivity, number> = { low: 38, medium: 30, high: 22 };
export const DEAD_ZONE_DEG = 3;
/** Smoothing time constant (s). ~70 ms removes hand jitter without feeling laggy. */
const SMOOTH_TAU = 0.07;

type DOEWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

/**
 * Tilt steering from `deviceorientation`.
 *
 * We convert (beta, gamma) into the gravity vector in device coordinates, rotate it into
 * *screen* coordinates using the current orientation angle (handles both landscape orientations,
 * and portrait for desktop testing), then take the angle of gravity within the screen plane:
 * atan2(screen-right, screen-down) is exactly the "steering wheel" rotation and does not depend
 * on how far the iPad is tipped back. When the iPad is nearly flat that angle is undefined/noisy,
 * so we blend toward asin(screen-right) there. alpha (compass) is never used.
 */
export class TiltSteering implements SteerSource {
  status: TiltStatus = 'unknown';
  /** Raw wheel angle in degrees (right side down = positive), before calibration. */
  rawAngle = 0;
  /** Calibrated angle in degrees. */
  angle = 0;
  private neutral = 0;
  private smoothed = 0;
  private lastEventTime = 0;
  private listening = false;

  /**
   * Must be called synchronously inside a user gesture (the Start tap) for iOS 13+.
   * Resolves to the resulting status; never throws.
   */
  async requestPermission(): Promise<TiltStatus> {
    if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
      return this.setStatus('unavailable');
    }
    const DOE = DeviceOrientationEvent as DOEWithPermission;
    try {
      if (typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return this.setStatus('denied');
      }
    } catch {
      // Throws if not called from a gesture or on insecure origins (http://LAN IP).
      return this.setStatus('denied');
    }
    this.listen();
    // Desktop browsers expose the API but never fire events: wait briefly for real data.
    const ok = await this.waitForData(1200);
    return this.setStatus(ok ? 'granted' : 'unavailable');
  }

  /** Make the current physical tilt the "straight ahead" position (the Ready button). */
  calibrate(): void {
    this.neutral = this.rawAngle;
    this.smoothed = 0;
  }

  get active(): boolean {
    return this.status === 'granted' && performance.now() - this.lastEventTime < 1000;
  }

  readSteer(dt: number): number | null {
    if (!this.active) return null;
    const lock = FULL_LOCK_DEG[settings.sensitivity] ?? 30;
    let a = this.rawAngle - this.neutral;
    if (settings.tiltInvert) a = -a;
    this.angle = a;
    const mag = Math.abs(a);
    let target = 0;
    if (mag > DEAD_ZONE_DEG) {
      const t = clamp((mag - DEAD_ZONE_DEG) / (lock - DEAD_ZONE_DEG), 0, 1);
      // Gentle curve: finer control near centre, still reaches full lock at `lock`.
      target = Math.sign(a) * (0.35 * t + 0.65 * t * t);
    }
    this.smoothed += (target - this.smoothed) * smoothing(dt, SMOOTH_TAU);
    return this.smoothed;
  }

  private setStatus(s: TiltStatus): TiltStatus {
    this.status = s;
    events.emit('tilt:status', { status: s });
    return s;
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.onOrientation);
  }

  private waitForData(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.lastEventTime) return resolve(true);
      const start = performance.now();
      const poll = (): void => {
        if (this.lastEventTime) resolve(true);
        else if (performance.now() - start > ms) resolve(false);
        else setTimeout(poll, 50);
      };
      poll();
    });
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta == null || e.gamma == null) return;
    this.lastEventTime = performance.now();
    const b = e.beta * DEG;
    const g = e.gamma * DEG;
    // "Down" vector in device coordinates (W3C ZXY Euler convention).
    const dx = Math.cos(b) * Math.sin(g);
    const dy = -Math.sin(b);
    // Screen-right axis expressed in device coordinates for the current orientation.
    const o = screenAngle() * DEG;
    const sx = dx * Math.cos(o) - dy * Math.sin(o); // gravity along screen-right
    const sy = -(dx * Math.sin(o) + dy * Math.cos(o)); // gravity along screen-down
    const inPlane = Math.hypot(sx, sy);
    const wheel = Math.atan2(sx, sy);
    const flat = Math.asin(clamp(sx, -1, 1));
    const w = clamp((inPlane - 0.2) / 0.25, 0, 1);
    this.rawAngle = (w * wheel + (1 - w) * flat) / DEG;
  };
}

/** Screen rotation in degrees (0, 90, -90/270, 180). Prefers iOS's window.orientation. */
export function screenAngle(): number {
  const w = window as Window & { orientation?: number };
  if (typeof w.orientation === 'number') return w.orientation;
  return screen.orientation?.angle ?? 0;
}
