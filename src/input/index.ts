import { events } from '../core/events';
import { approach } from '../core/math';
import { settings } from '../core/settings';
import type { DriveInput, System } from '../core/types';
import { KeyboardInput } from './keyboard';
import { TiltSteering } from './tilt';
import { TouchControls } from './touch';
import type { InputAction, PlayerControls } from './types';

export type { InputAction, PlayerControls, SteerSource } from './types';
export { TiltSteering, FULL_LOCK_DEG, DEAD_ZONE_DEG, screenAngle } from './tilt';
export { TouchControls } from './touch';
export { preventBrowserGestures } from './gestures';

/** Steering rate for digital sources (buttons/keys), full lock per second. */
const DIGITAL_STEER_RATE = 3.2;
const DIGITAL_RETURN_RATE = 5;

/**
 * Combines tilt, on-screen controls and keyboard into one DriveInput for the player.
 * Priority for steering: keyboard (if pressed) > steer buttons (if shown & pressed) > tilt.
 */
export class PlayerInput implements PlayerControls, System {
  readonly tilt = new TiltSteering();
  readonly touch: TouchControls;
  readonly keyboard: KeyboardInput;
  readonly state: DriveInput = { steer: 0, throttle: 0, brake: 0 };
  enabled = false;
  private digitalSteer = 0;
  private listeners = new Map<InputAction, Set<() => void>>();

  constructor(overlay: HTMLElement) {
    const fire = (a: InputAction): void => this.listeners.get(a)?.forEach((fn) => fn());
    this.touch = new TouchControls(overlay, fire);
    this.keyboard = new KeyboardInput(fire);
    events.on('tilt:status', () => this.refreshSteerButtons());
    events.on('settings:changed', () => this.refreshSteerButtons());
  }

  onAction(action: InputAction, fn: () => void): () => void {
    let set = this.listeners.get(action);
    if (!set) this.listeners.set(action, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Whether on-screen steering buttons are needed (tilt unavailable/denied or forced in settings). */
  get usingSteerButtons(): boolean {
    return settings.steerButtons || this.tilt.status !== 'granted';
  }

  refreshSteerButtons(): void {
    this.touch.showSteerButtons(this.usingSteerButtons && isTouchDevice());
  }

  update(dt: number): void {
    const s = this.state;
    if (!this.enabled) {
      s.steer = s.throttle = s.brake = 0;
      this.digitalSteer = 0;
      this.tilt.readSteer(dt); // keep smoothing warm
      return;
    }
    const kb = this.keyboard;
    const digitalTarget = kb.anySteer ? kb.steer : this.usingSteerButtons ? this.touch.steer : 0;
    const rate = digitalTarget === 0 || Math.sign(digitalTarget) !== Math.sign(this.digitalSteer) ? DIGITAL_RETURN_RATE : DIGITAL_STEER_RATE;
    this.digitalSteer = approach(this.digitalSteer, digitalTarget, rate * dt);

    const tilt = this.tilt.readSteer(dt);
    if (kb.anySteer || this.usingSteerButtons || tilt == null) s.steer = this.digitalSteer;
    else s.steer = tilt;

    s.throttle = Math.max(kb.throttle, this.touch.throttle);
    s.brake = Math.max(kb.brake, this.touch.brake);
  }
}

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
