import { events } from '../core/events';
import { settings } from '../core/settings';
import type { System } from '../core/types';
import type { VehicleState } from '../vehicles/types';

/**
 * Web Audio. Everything procedural (oscillators/noise) — no downloads (SPEC build constraints).
 *
 * Contract:
 *  - `unlock()` MUST be called synchronously from the Start tap (iOS requires a gesture).
 *  - Engine sound per VehicleSpec.engineSound, pitched by VehicleState.rpm, gain by throttle.
 *  - React to bus events: race:countdown (beep), race:go (horn), vehicle:landed (thump),
 *    vehicle:collision (crash), vehicle:surface (crunch/squelch/splash), race:finish (cheer),
 *    race:summit (fanfare). Music loops via `playMusic('menu' | 'race' | null)`.
 *  - Countdown voice is a swappable slot: `setCountdownVoice(urls | null)` (Brooks will record his own).
 *  - Volumes from settings.musicVolume / settings.sfxVolume; listen to 'settings:changed'.
 *
 * TODO(audio agent): implement everything below. The stub only creates/resumes the context.
 */
export class AudioSystem implements System {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private vehicles: VehicleState[] = [];

  /** Create/resume the AudioContext. Call from inside a user gesture. Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = settings.sfxVolume;
        this.master.connect(this.ctx.destination);
        // Play a silent buffer: required on older iOS to fully unlock output.
        const buf = this.ctx.createBuffer(1, 1, 22050);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.master);
        src.start(0);
      }
      if (this.ctx.state !== 'running') void this.ctx.resume();
    } catch (e) {
      console.warn('[audio] unlock failed', e);
    }
  }

  /** Suspend when the app is hidden (saves battery), resume on return. */
  setSuspended(s: boolean): void {
    if (!this.ctx) return;
    void (s ? this.ctx.suspend() : this.ctx.resume());
  }

  attachVehicle(v: VehicleState): void {
    this.vehicles.push(v);
  }
  detachVehicle(v: VehicleState): void {
    this.vehicles = this.vehicles.filter((x) => x !== v);
  }

  playMusic(_track: 'menu' | 'race' | null): void {
    // TODO(audio agent)
  }

  setCountdownVoice(_urls: Record<'3' | '2' | '1' | 'go', string> | null): void {
    // TODO(audio agent)
  }

  update(_dt: number): void {
    // TODO(audio agent): update engine oscillators from this.vehicles[i].rpm / input.throttle.
  }

  /** Wire bus events. Called once by main. */
  bindEvents(): void {
    events.on('settings:changed', () => {
      if (this.master) this.master.gain.value = settings.sfxVolume;
    });
    // TODO(audio agent): subscribe to race/vehicle events listed above.
  }
}
