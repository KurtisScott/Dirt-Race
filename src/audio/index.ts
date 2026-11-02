import { events, type GamePhase } from '../core/events';
import { clamp } from '../core/math';
import { settings, updateSettings } from '../core/settings';
import type { RacerId, SurfaceType, System } from '../core/types';
import type { VehicleState } from '../vehicles/types';
import { EngineVoice, ENGINE_PROFILES, engineBuffer, type EngineSoundId } from './engine';
import { MENU_SONG, RACE_SONG, Sequencer } from './music';
import { ALL_LOOPS, ALL_SFX, animalVoice, obstacleSound, sfxBuffer, type LoopName, type SfxName } from './sfx';
import { bundledVoiceUrls, loadVoice, type VoiceKey } from './voice';

export { ENGINE_PROFILES, renderEngineLoop } from './engine';
export { mountVolumeControls } from './controls';
export { SFX, LOOPS } from './sfx';
export { MENU_SONG, RACE_SONG, Sequencer } from './music';

/**
 * Web Audio, fully procedural (no downloads; SPEC build constraints).
 *
 * Graph:  engines/surfaces/one-shots → game bus ┐
 *         music sequencer            → music bus ├→ master (pause/hide mute) → limiter → destination
 *         UI clicks                  → ui bus   ┘   (ui bus bypasses the pause mute so menus still click)
 *
 * Public API (used by main/ui):
 *  - `unlock()`              call synchronously in the Start tap (iOS gesture). Safe to repeat.
 *  - `setSuspended(hidden)`  app hidden → suspend context; visible → resume.
 *  - `attachVehicle(v)` / `detachVehicle(v)`  engines + tyres follow VehicleState.
 *  - `playMusic('menu' | 'race' | null)` (normally automatic from `phase:changed`).
 *  - `setCountdownVoice(urls | null)`  swappable voice slot (see voice.ts for dropping files in).
 *  - `musicVolume` / `sfxVolume` getters/setters (0..1, persisted via settings) for the settings screen.
 *  - `play(name)` for any one-shot, e.g. `audio.play('click')`.
 *
 * Every event handler tolerates events that never fire; nothing here throws into the game.
 */

type Bus = 'game' | 'ui';
type MusicTrack = 'menu' | 'race' | null;

/** Engines/tyres are only audible in these phases (menus stay quiet). */
const DRIVING: ReadonlySet<GamePhase> = new Set(['countdown', 'racing', 'bonus', 'freeDrive', 'results']);
const MUSIC_FOR_PHASE: Partial<Record<GamePhase, MusicTrack>> = {
  title: 'menu',
  calibrate: 'menu',
  spin: 'menu',
  countdown: null,
  racing: 'race',
  bonus: 'race',
  freeDrive: 'race',
  // results: menu music starts after the finish jingle (see onPhase)
};

/** Gain trims (relative loudness of each one-shot before the sfx volume). */
const TRIM: Partial<Record<SfxName, number>> = {
  click: 0.35, beep: 0.55, beepHi: 0.6, goHorn: 0.55, cheer: 0.6, fanfare: 0.6, reelTick: 0.28, reelLand: 0.55,
  landSoft: 0.7, landHard: 0.85, crash: 0.7, hay: 0.6, cone: 0.5, carBump: 0.6, splash: 0.55, squelch: 0.5, crunch: 0.4,
  boing: 0.45, quack: 0.5, squeak: 0.45, bleat: 0.45, grunt: 0.55, chomp: 0.5,
  moo: 0.5, bellow: 0.55, mooseCall: 0.5, oink: 0.5, goatBleat: 0.45, hop: 0.45, camelGroan: 0.5, whoosh: 0.35, chime: 0.45, buzzer: 0.4,
  jingleWin: 0.5, jingleTry: 0.45, leadUp: 0.35, leadDown: 0.3, pop: 0.45, cough: 0.5, tootCpu: 0.35,
};
/** Minimum seconds between two plays of the same sound (anti-spam). */
const COOLDOWN: Partial<Record<SfxName, number>> = {
  reelTick: 0.035, click: 0.04, crunch: 0.25, squelch: 0.35, splash: 0.4, landSoft: 0.15, landHard: 0.15, crash: 0.12,
  hay: 0.08, cone: 0.06, carBump: 0.2, leadUp: 3, leadDown: 3, pop: 0.25, cough: 2, whoosh: 0.8,
};
const MAX_ONESHOTS = 12;
/** Render rates for procedural buffers: lower = less memory/CPU at startup; the context resamples. */
const LOOP_SR = 24000;
const SFX_SR = 32000;

interface SurfaceLayer {
  name: LoopName;
  src: AudioBufferSourceNode;
  gain: GainNode;
}
interface VehicleAudio {
  v: VehicleState;
  engine: EngineVoice | null;
  out: GainNode; // per-vehicle send (distance attenuation applied to engine via set(); this is for tyres)
  surface: SurfaceLayer | null;
  squeal: SurfaceLayer | null;
  lastThrottle: number;
  airborneWhoosh: boolean;
  idleCoughT: number;
}

export class AudioSystem implements System {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private buses: Record<'game' | 'music' | 'ui', GainNode> | null = null;
  private vehicles: VehicleAudio[] = [];
  private phase: GamePhase = 'title';
  private paused = false;
  private hidden = false;
  private music: Sequencer | null = null;
  private musicTrack: MusicTrack = null;
  private wantedMusic: MusicTrack = null;
  private musicTimer = 0;
  private lastPlay = new Map<SfxName, number>();
  private active = 0;
  private voice: Partial<Record<VoiceKey, AudioBuffer>> = {};
  private voiceToken = 0;
  private lastObstacleHit: Record<RacerId, number> = { player: -1, cpu: -1 };
  private warmQueue: (() => void)[] = [];
  private bound = false;
  /** For tests/debug: counts one-shots actually started. */
  readonly stats = { oneShots: 0, dropped: 0 };
  private pendingVoice: Partial<Record<VoiceKey, string>> | null = null;

  // ------------------------------------------------------------------ lifecycle

  /** Create/resume the AudioContext. Call from inside a user gesture. Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        // 'interactive' latency; let the device choose its native sample rate.
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.buildGraph(this.ctx);
        // Play a silent buffer: required on older iOS to fully unlock output.
        const buf = this.ctx.createBuffer(1, 1, 22050);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(0);
        this.ctx.onstatechange = () => this.maybeResume();
        this.installResumeHooks();
        this.scheduleWarmup();
        // Bundled countdown voice (only if files were present at build time).
        const urls = this.pendingVoice ?? bundledVoiceUrls();
        this.pendingVoice = null;
        if (Object.keys(urls).length) this.setCountdownVoice(urls);
        this.applyMusicForPhase();
      }
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    } catch (e) {
      console.warn('[audio] unlock failed', e);
    }
  }

  /** Suspend when the app is hidden (saves battery), resume on return. */
  setSuspended(s: boolean): void {
    this.hidden = s;
    if (!this.ctx) return;
    this.applyMute();
    try {
      void (s ? this.ctx.suspend() : this.ctx.resume()).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  private buildGraph(ctx: AudioContext): void {
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.2;
    this.limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(this.limiter);
    const mk = (): GainNode => ctx.createGain();
    this.buses = { game: mk(), music: mk(), ui: mk() };
    this.buses.game.connect(this.master);
    this.buses.music.connect(this.master);
    this.buses.ui.connect(this.limiter); // UI clicks keep working while the game is muted (pause menu)
    this.applyVolumes();
    this.applyMute();
  }

  /** iOS: the context can be 'suspended'/'interrupted' by calls, Siri, other apps or the lock screen. */
  private installResumeHooks(): void {
    const kick = (): void => this.maybeResume();
    for (const t of ['touchend', 'pointerdown', 'keydown']) document.addEventListener(t, kick, { capture: true, passive: true });
    window.addEventListener('pageshow', kick);
    window.addEventListener('focus', kick);
  }

  private maybeResume(): void {
    const ctx = this.ctx;
    if (!ctx || this.hidden || document.visibilityState === 'hidden') return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  }

  /** Render buffers in small chunks after unlock so the first crash/landing doesn't hitch. */
  private scheduleWarmup(): void {
    const ctx = this.ctx!;
    const engines = Object.keys(ENGINE_PROFILES) as EngineSoundId[];
    this.warmQueue = [
      ...engines.map((id) => () => void engineBuffer(ctx, id, LOOP_SR)),
      ...ALL_LOOPS.map((l) => () => void sfxBuffer(ctx, `loop:${l}`, LOOP_SR)),
      ...ALL_SFX.map((n) => () => void sfxBuffer(ctx, n, SFX_SR)),
    ];
    const step = (): void => {
      const t0 = performance.now();
      while (this.warmQueue.length && performance.now() - t0 < 6) this.warmQueue.shift()!();
      if (this.warmQueue.length) setTimeout(step, 30);
    };
    setTimeout(step, 250);
  }

  // ------------------------------------------------------------------ volumes / mute

  /** Which music loop is playing (for debug/tests). */
  get currentMusic(): MusicTrack {
    return this.musicTrack;
  }

  get musicVolume(): number {
    return settings.musicVolume;
  }
  set musicVolume(v: number) {
    updateSettings({ musicVolume: clamp(v, 0, 1) });
  }
  get sfxVolume(): number {
    return settings.sfxVolume;
  }
  set sfxVolume(v: number) {
    updateSettings({ sfxVolume: clamp(v, 0, 1) });
  }

  private applyVolumes(): void {
    if (!this.buses || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Perceptual curve: slider 0..1 → gain (squared) so the low end is usable.
    const m = clamp(settings.musicVolume, 0, 1);
    const s = clamp(settings.sfxVolume, 0, 1);
    this.buses.music.gain.setTargetAtTime(m * m * 0.55, t, 0.05);
    this.buses.game.gain.setTargetAtTime(s * s, t, 0.05);
    this.buses.ui.gain.setTargetAtTime(s * s, t, 0.05);
  }

  private applyMute(): void {
    if (!this.master || !this.ctx) return;
    const muted = this.paused || this.hidden;
    this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.04);
  }

  // ------------------------------------------------------------------ vehicles

  attachVehicle(v: VehicleState): void {
    if (this.vehicles.some((x) => x.v === v)) return;
    this.vehicles.push({ v, engine: null, out: null as unknown as GainNode, surface: null, squeal: null, lastThrottle: 0, airborneWhoosh: false, idleCoughT: 6 + Math.random() * 10 });
  }

  detachVehicle(v: VehicleState): void {
    const va = this.vehicles.find((x) => x.v === v);
    if (va) this.silence(va, true);
    this.vehicles = this.vehicles.filter((x) => x.v !== v);
  }

  private get listener(): VehicleState | null {
    return (this.vehicles.find((x) => x.v.racer === 'player') ?? this.vehicles[0])?.v ?? null;
  }

  /** Distance attenuation + pan relative to the player's car (the camera follows it). */
  private spatial(x: number, z: number): { level: number; pan: number; muffle: number } {
    const l = this.listener;
    if (!l) return { level: 1, pan: 0, muffle: 0 };
    const dx = x - l.position.x;
    const dz = z - l.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) return { level: 1, pan: 0, muffle: 0 };
    const f = l.forward;
    // Right vector = forward × up (chassis +X is left).
    const rx = -f.z;
    const rz = f.x;
    const rl = Math.hypot(rx, rz) || 1;
    const pan = clamp(((dx * rx + dz * rz) / rl / d) * 0.8, -0.8, 0.8);
    return { level: 1 / (1 + d / 12), pan, muffle: clamp(d / 120, 0, 1) };
  }

  private ensureVehicleNodes(va: VehicleAudio): void {
    const ctx = this.ctx!;
    if (!va.out) {
      va.out = ctx.createGain();
      va.out.connect(this.buses!.game);
    }
    const id = va.v.spec.engineSound;
    if (va.engine && va.engine.id !== id) {
      va.engine.stop();
      va.engine = null;
    }
    if (!va.engine) va.engine = new EngineVoice(ctx, id, this.buses!.game, ctx.currentTime, LOOP_SR);
  }

  private silence(va: VehicleAudio, disconnect = false): void {
    const t = this.ctx?.currentTime ?? 0;
    va.engine?.stop(t);
    va.engine = null;
    for (const layer of [va.surface, va.squeal]) if (layer) this.stopLayer(layer, t);
    va.surface = va.squeal = null;
    if (disconnect && va.out) {
      const out = va.out;
      setTimeout(() => out.disconnect(), 600);
      va.out = null as unknown as GainNode;
    }
  }

  private startLayer(name: LoopName, out: AudioNode): SurfaceLayer {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = sfxBuffer(ctx, `loop:${name}`, LOOP_SR);
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(out);
    src.start(ctx.currentTime, Math.random() * src.buffer.duration);
    return { name, src, gain };
  }

  private stopLayer(layer: SurfaceLayer, t: number): void {
    layer.gain.gain.cancelScheduledValues(t);
    layer.gain.gain.setTargetAtTime(0, t, 0.08);
    try {
      layer.src.stop(t + 0.5);
    } catch {
      /* ignore */
    }
    layer.src.onended = () => layer.gain.disconnect();
  }

  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.buses) return;
    const now = ctx.currentTime;
    this.music?.pump(now + 0.25);
    if (ctx.state !== 'running') return;

    const driving = DRIVING.has(this.phase);
    for (const va of this.vehicles) {
      if (!driving) {
        if (va.engine) this.silence(va);
        continue;
      }
      try {
        this.updateVehicle(va, dt, now);
      } catch (e) {
        // Never let audio break the frame loop.
        console.warn('[audio] vehicle update failed', e);
        this.silence(va);
      }
    }
  }

  private updateVehicle(va: VehicleAudio, dt: number, now: number): void {
    this.ensureVehicleNodes(va);
    const v = va.v;
    const isPlayer = v.racer === 'player' || v === this.listener;
    const sp = isPlayer ? { level: 1, pan: 0, muffle: 0 } : this.spatial(v.position.x, v.position.z);
    const level = isPlayer ? 1 : sp.level * 0.75; // computer car a bit quieter overall
    const throttle = v.input?.throttle ?? 0;
    const results = this.phase === 'results';
    va.engine!.set(v.rpm, throttle, now, results ? level * 0.5 : level, sp.pan, sp.muffle);

    // Backfire / cough when lifting off at high revs.
    const prof = va.engine!.profile;
    if (va.lastThrottle > 0.7 && throttle < 0.2 && v.rpm > 0.55 && Math.random() < prof.backfire) {
      this.play(prof.wobble > 0 ? 'cough' : 'pop', { gain: level * 0.9, pan: sp.pan, rate: 0.9 + Math.random() * 0.2 });
    }
    va.lastThrottle = throttle;
    // Grandma's sedan clears its throat now and then while idling (comedic, rare).
    if (prof.misfire > 0 && Math.abs(v.speed) < 1 && throttle < 0.1) {
      va.idleCoughT -= dt;
      if (va.idleCoughT <= 0) {
        va.idleCoughT = 12 + Math.random() * 14;
        this.play('cough', { gain: level * 0.6, pan: sp.pan });
      }
    }

    // Tyres/surface: player gets full beds; the CPU gets a quieter, distance-scaled version.
    const speed = Math.abs(v.speed);
    let grounded = 0;
    let slip = 0;
    let slipAsphalt = 0;
    for (const w of v.wheels) {
      if (!w.contact) continue;
      grounded++;
      slip += w.slip;
      if (w.surface === 'asphalt') slipAsphalt += w.slip;
    }
    slip = grounded ? slip / grounded : 0;
    slipAsphalt = grounded ? slipAsphalt / 4 : 0;
    const onGround = grounded > 0 && v.wheelsOnGround > 0;
    const surf: SurfaceType = v.surface;
    va.out.gain.setTargetAtTime(isPlayer ? 1 : sp.level * 0.6, now, 0.1);

    // Surface bed: crossfade on change. Asphalt is a soft road roar; off-road surfaces are louder.
    const want: LoopName | null = speed > 0.8 && onGround ? surf : null;
    if (want !== (va.surface?.name ?? null)) {
      if (va.surface) this.stopLayer(va.surface, now);
      va.surface = want ? this.startLayer(want, va.out) : null;
    }
    if (va.surface) {
      const base = surf === 'asphalt' ? 0.18 : surf === 'water' ? 0.7 : 0.55;
      const sNorm = clamp(speed / 22, 0, 1);
      const g = base * Math.sqrt(sNorm) * (0.6 + 0.4 * (grounded / 4)) * (1 + slip * 0.8);
      const rate = surf === 'asphalt' ? 0.7 + 0.6 * sNorm : 0.8 + 0.45 * sNorm;
      va.surface.gain.gain.setTargetAtTime(g, now, 0.08);
      va.surface.src.playbackRate.setTargetAtTime(rate, now, 0.1);
    }

    // Squeal: asphalt slip only (off-road slip just makes the surface bed louder above).
    const squealAmt = clamp((slipAsphalt - 0.35) / 0.4, 0, 1) * clamp(speed / 6, 0, 1);
    if (squealAmt > 0.02 && !va.squeal) va.squeal = this.startLayer('squeal', va.out);
    if (va.squeal) {
      va.squeal.gain.gain.setTargetAtTime(squealAmt * 0.55, now, squealAmt > 0 ? 0.03 : 0.08);
      va.squeal.src.playbackRate.setTargetAtTime(0.9 + squealAmt * 0.25 + speed / 200, now, 0.05);
      if (squealAmt === 0 && (va.squeal.gain.gain.value < 0.005)) {
        this.stopLayer(va.squeal, now);
        va.squeal = null;
      }
    }

    // Big air: a soft whoosh once per jump.
    if (!onGround && v.airTime > 0.45 && speed > 8 && !va.airborneWhoosh) {
      va.airborneWhoosh = true;
      if (isPlayer) this.play('whoosh', { gain: 0.6 });
    }
    if (onGround) va.airborneWhoosh = false;
  }

  // ------------------------------------------------------------------ one-shots

  /** Play a one-shot. Returns false if skipped (no context, cooldown, voice limit). */
  play(name: SfxName, o: { gain?: number; rate?: number; pan?: number; bus?: Bus; at?: number } = {}): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.buses || ctx.state !== 'running') return false;
    const now = ctx.currentTime;
    const cd = COOLDOWN[name] ?? 0.03;
    const last = this.lastPlay.get(name) ?? -1;
    if (now - last < cd) return false;
    if (this.active >= MAX_ONESHOTS) {
      this.stats.dropped++;
      return false;
    }
    let buffer: AudioBuffer;
    try {
      buffer = sfxBuffer(ctx, name, SFX_SR);
    } catch (e) {
      console.warn('[audio] could not render', name, e);
      return false;
    }
    this.lastPlay.set(name, now);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (o.rate) src.playbackRate.value = o.rate;
    const g = ctx.createGain();
    g.gain.value = clamp((o.gain ?? 1) * (TRIM[name] ?? 0.5), 0, 1.5);
    let node: AudioNode = src.connect(g);
    if (o.pan && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      node = node.connect(p);
    }
    node.connect(this.buses[o.bus ?? 'game']);
    this.active++;
    this.stats.oneShots++;
    src.onended = () => {
      this.active--;
      g.disconnect();
    };
    src.start(o.at ?? now);
    return true;
  }

  private playAt(name: SfxName, x: number, z: number, gain = 1): void {
    const s = this.spatial(x, z);
    if (s.level < 0.05) return;
    this.play(name, { gain: gain * s.level, pan: s.pan });
  }

  private racerPos(racer: RacerId): { x: number; z: number } | null {
    const v = this.vehicles.find((x) => x.v.racer === racer)?.v;
    return v ? { x: v.position.x, z: v.position.z } : null;
  }

  /** One-shot for something that happened to a racer's car (spatialised for the CPU). */
  private playFor(racer: RacerId, name: SfxName, gain = 1, rate?: number): void {
    if (racer === 'player') {
      this.play(name, { gain, rate });
      return;
    }
    const p = this.racerPos(racer);
    if (!p) return;
    const s = this.spatial(p.x, p.z);
    if (s.level < 0.05) return;
    this.play(name, { gain: gain * s.level * 0.8, pan: s.pan, rate });
  }

  // ------------------------------------------------------------------ music

  playMusic(track: MusicTrack): void {
    this.wantedMusic = track;
    clearTimeout(this.musicTimer);
    const ctx = this.ctx;
    if (!ctx || !this.buses) return; // started on unlock
    if (track === this.musicTrack && this.music) return;
    this.music?.stop(ctx.currentTime, 0.6);
    this.music = null;
    this.musicTrack = track;
    if (!track) return;
    this.music = new Sequencer(ctx, track === 'menu' ? MENU_SONG : RACE_SONG, this.buses.music, ctx.currentTime + 0.1, track === 'race' ? 0.3 : 1.2);
  }

  private applyMusicForPhase(): void {
    const t = MUSIC_FOR_PHASE[this.phase];
    if (t !== undefined) this.playMusic(t);
    else this.playMusic(this.wantedMusic);
  }

  // ------------------------------------------------------------------ countdown voice

  /**
   * Swappable countdown voice slot. Pass URLs for any of '3','2','1','go' (missing ones keep the beep),
   * or null to use beeps only. Loading is async; until it finishes the beeps play.
   */
  setCountdownVoice(urls: Partial<Record<VoiceKey, string>> | null): void {
    const token = ++this.voiceToken;
    this.voice = {};
    if (!this.ctx) {
      this.pendingVoice = urls ?? {};
      return;
    }
    if (!urls) return;
    void loadVoice(this.ctx, urls).then((bufs) => {
      if (token === this.voiceToken) this.voice = bufs;
    });
  }
  private playVoice(key: VoiceKey): boolean {
    const b = this.voice[key];
    const ctx = this.ctx;
    if (!b || !ctx || !this.buses || ctx.state !== 'running') return false;
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    g.gain.value = 1;
    src.connect(g).connect(this.buses.game);
    src.onended = () => g.disconnect();
    src.start();
    return true;
  }

  // ------------------------------------------------------------------ events

  /** Wire bus events. Called once by main. */
  bindEvents(): void {
    if (this.bound) return;
    this.bound = true;
    const on = events.on.bind(events) as typeof events.on;
    const safe =
      <T>(fn: (p: T) => void) =>
      (p: T): void => {
        try {
          fn(p);
        } catch (e) {
          console.warn('[audio] handler failed', e);
        }
      };

    on('settings:changed', safe(() => this.applyVolumes()));
    on('app:paused', safe(({ paused }) => {
      this.paused = paused;
      this.applyMute();
    }));
    on('phase:changed', safe(({ to }) => this.onPhase(to)));

    // ---- countdown / race
    on('race:countdown', safe(({ n }) => {
      const key = String(n) as VoiceKey;
      if (!this.playVoice(key)) this.play('beep', { bus: 'game' });
    }));
    on('race:go', safe(() => {
      const voiced = this.playVoice('go');
      if (!voiced) this.play('beepHi');
      this.play('goHorn', { gain: voiced ? 0.5 : 1 });
    }));
    on('race:checkpoint', safe(({ racer }) => {
      if (racer === 'player') this.play('chime', { gain: 0.6 });
    }));
    on('race:finish', safe(({ racer, winner }) => {
      if (racer === 'player') {
        if (winner) {
          this.play('cheer');
          this.play('jingleWin', { gain: 0.9 });
        } else {
          this.play('jingleTry');
          this.play('cheer', { gain: 0.45 });
        }
      } else if (winner) {
        this.play('tootCpu');
      }
    }));
    on('race:jump', safe(({ racer, bonus }) => {
      if (!bonus) return;
      if (racer === 'player') this.play('fanfare');
      else this.play('chime', { gain: 0.5 });
    }));
    on('race:timeout', safe(() => this.play('buzzer')));
    on('race:lead', safe(({ leader }) => this.play(leader === 'player' ? 'leadUp' : 'leadDown')));

    // ---- spin reel
    on('spin:tick', safe(() => this.play('reelTick', { rate: 0.95 + Math.random() * 0.1, bus: 'ui' })));
    on('spin:land', safe(() => this.play('reelLand', { bus: 'ui' })));

    // ---- vehicles
    on('vehicle:landed', safe(({ racer, impact }) => {
      // impact = downward m/s at touchdown (vehicles emit only above 3 m/s).
      const k = clamp((impact - 3) / 9, 0, 1);
      this.playFor(racer, k > 0.45 ? 'landHard' : 'landSoft', 0.45 + 0.55 * k, 1.1 - 0.2 * k);
    }));
    on('vehicle:collision', safe(({ racer, other, impulse }) => {
      // obstacle:hit / animal:bump carry the specific kind; skip the generic sound if one just played.
      const now = this.ctx?.currentTime ?? 0;
      if ((other === 'obstacle' || other === 'animal') && now - this.lastObstacleHit[racer] < 0.15) return;
      const k = clamp(impulse / 6000, 0.2, 1); // impulse in N·s; ~6000 ≈ a hard hit for a ~1.5 t car
      if (other === 'vehicle') this.playFor(racer, 'carBump', k);
      else if (other === 'animal') this.playFor(racer, 'boing', 0.8);
      else if (k > 0.3) this.playFor(racer, 'crash', k);
    }));
    on('vehicle:surface', safe(({ racer, surface }) => {
      const v = this.vehicles.find((x) => x.v.racer === racer)?.v;
      const speed = v ? Math.abs(v.speed) : 10;
      if (speed < 3) return;
      const g = clamp(speed / 15, 0.3, 1);
      if (surface === 'water') this.playFor(racer, 'splash', g);
      else if (surface === 'mud') this.playFor(racer, 'squelch', g);
      else if (surface === 'gravel') this.playFor(racer, 'crunch', g * 0.7);
      else if (surface === 'snow') this.playFor(racer, 'crunch', g * 0.6, 0.7); // lower, softer crunch into snow
    }));
    on('vehicle:flipped', safe(({ racer }) => this.playFor(racer, 'boing', 0.6, 0.8)));
    on('vehicle:reset', safe(({ racer }) => {
      if (racer === 'player' && DRIVING.has(this.phase)) this.play('whoosh', { gain: 0.6, rate: 1.3 });
    }));

    // ---- world
    on('obstacle:hit', safe(({ kind, racer, x, z }) => {
      this.lastObstacleHit[racer] = this.ctx?.currentTime ?? 0;
      this.playAt(obstacleSound(kind), x, z);
    }));
    on('animal:bump', safe(({ kind, racer, x, z, damaging }) => {
      this.lastObstacleHit[racer] = this.ctx?.currentTime ?? 0;
      this.playAt(damaging ? 'carBump' : 'boing', x, z, 0.7); // big animals dent the car: a thud, not a boing
      this.playAt(animalVoice(kind), x, z);
    }));
    on('animal:crossing', safe(({ kind, x, z }) => this.playAt(animalVoice(kind), x, z, 0.5)));

    // ---- UI clicks: any button/[data-tap] in the document (no UI changes needed). Pedals excluded.
    document.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target instanceof Element ? e.target.closest('button, [data-tap], [data-action]') : null;
        if (t && !t.closest('[data-hold]') && !(t as HTMLButtonElement).disabled) this.play('click', { bus: 'ui' });
      },
      { capture: true, passive: true },
    );
  }

  private onPhase(to: GamePhase): void {
    this.phase = to;
    if (to === 'results') {
      // Let the finish cheer/jingle have its moment, then bring the menu loop back in.
      this.playMusic(null);
      this.musicTimer = window.setTimeout(() => {
        if (this.phase === 'results') this.playMusic('menu');
      }, 2800);
      return;
    }
    this.applyMusicForPhase();
  }
}
