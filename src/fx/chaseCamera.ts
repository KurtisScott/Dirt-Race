import * as THREE from 'three';
import { events } from '../core/events';
import { clamp, smoothing } from '../core/math';
import { settings, updateSettings } from '../core/settings';
import type { CameraMode, System } from '../core/types';
import type { VehicleState } from '../vehicles/types';

interface CamPreset {
  distance: number;
  height: number;
  lookAhead: number;
  lookHeight: number;
  fovBase: number;
  fovMax: number;
}

const PRESETS: Record<CameraMode, CamPreset> = {
  close: { distance: 7.0, height: 2.6, lookAhead: 4, lookHeight: 1.0, fovBase: 60, fovMax: 76 },
  far: { distance: 11.5, height: 4.4, lookAhead: 6, lookHeight: 1.2, fovBase: 58, fovMax: 72 },
};

/**
 * Chase camera: sits behind/above the target, lags its heading so it trails in turns,
 * widens FOV with speed, and supports a decaying shake (`shake(amount)`) e.g. on hard landings.
 * Uses the vehicle's *velocity* direction blended with its heading so reversing doesn't spin the camera.
 */
export class ChaseCamera implements System {
  target: VehicleState | null = null;
  /** Extra framing offset for other modules (e.g. results orbit) — leave null for normal chase. */
  override: ((cam: THREE.PerspectiveCamera, dt: number) => void) | null = null;
  private yaw = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shakeAmt = 0;
  private shakeT = 0;
  private initialised = false;
  private blend = { ...PRESETS.close };
  private desired = new THREE.Vector3();
  private lookAt = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {
    events.on('vehicle:landed', ({ racer, impact }) => {
      if (racer === this.target?.racer) this.shake(clamp((impact - 3) / 8, 0, 1) * 0.35);
    });
    events.on('vehicle:reset', ({ racer }) => {
      if (racer === this.target?.racer) this.snap();
    });
  }

  toggleMode(): void {
    updateSettings({ camera: settings.camera === 'close' ? 'far' : 'close' });
  }

  shake(amount: number): void {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  snap(): void {
    this.initialised = false;
  }

  update(dt: number): void {
    if (this.override) {
      this.override(this.camera, dt);
      return;
    }
    const t = this.target;
    if (!t) return;
    const preset = PRESETS[settings.camera] ?? PRESETS.close;
    // Smoothly morph between close/far.
    const k = smoothing(dt, 0.25);
    for (const key of Object.keys(preset) as (keyof CamPreset)[]) this.blend[key] += (preset[key] - this.blend[key]) * k;
    const c = this.blend;

    const heading = Math.atan2(t.forward.x, t.forward.z);
    if (!this.initialised) {
      this.yaw = heading;
    }
    // Trail the heading: faster catch-up at speed, slower when nearly stopped.
    let dYaw = heading - this.yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    const speed = Math.abs(t.speed);
    this.yaw += dYaw * smoothing(dt, speed > 2 ? 0.28 : 0.6);

    const dist = c.distance + clamp(speed / 30, 0, 1) * 1.2;
    const desired = this.desired.set(t.position.x - Math.sin(this.yaw) * dist, t.position.y + c.height, t.position.z - Math.cos(this.yaw) * dist);
    const lookAt = this.lookAt.set(t.position.x + Math.sin(this.yaw) * c.lookAhead, t.position.y + c.lookHeight, t.position.z + Math.cos(this.yaw) * c.lookAhead);

    if (!this.initialised) {
      this.pos.copy(desired);
      this.look.copy(lookAt);
      this.initialised = true;
    } else {
      // Position follows tightly horizontally, a bit looser vertically (absorbs bumps).
      const kh = smoothing(dt, 0.08);
      const kv = smoothing(dt, 0.18);
      this.pos.x += (desired.x - this.pos.x) * kh;
      this.pos.z += (desired.z - this.pos.z) * kh;
      this.pos.y += (desired.y - this.pos.y) * kv;
      this.look.lerp(lookAt, smoothing(dt, 0.06));
    }
    // Never dip below the target's ground level (crude anti-clip for M1; world agent may add terrain test).
    this.pos.y = Math.max(this.pos.y, t.position.y + 0.8);

    this.camera.position.copy(this.pos);
    if (this.shakeAmt > 0.001) {
      this.shakeT += dt * 40;
      const a = this.shakeAmt;
      this.camera.position.x += Math.sin(this.shakeT * 1.3) * a;
      this.camera.position.y += Math.sin(this.shakeT * 1.7 + 1) * a;
      this.shakeAmt *= Math.exp(-dt * 6);
    }
    this.camera.lookAt(this.look);

    const fov = c.fovBase + (c.fovMax - c.fovBase) * clamp(speed / 35, 0, 1);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * smoothing(dt, 0.3);
      this.camera.updateProjectionMatrix();
    }
  }
}
