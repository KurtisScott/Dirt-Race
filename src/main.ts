import './style.css';
import type { TiltStatus } from './core/events';
import { events } from './core/events';
import { GameLoop } from './core/loop';
import { initRapier, PhysicsWorld } from './core/physics';
import { QualityManager } from './core/quality';
import { Renderer } from './core/renderer';
import { setWakeLock } from './core/wakeLock';
import type { GameContext } from './core/context';
import { preventBrowserGestures, PlayerInput } from './input';
import { createVehicle, type Vehicle } from './vehicles';
import { createWorld } from './world';
import { RaceController, RaceFlow } from './race';
import { AIDriver, createPhysicsSensor } from './ai';
import { ChaseCamera, Effects } from './fx';
import { AudioSystem, mountVolumeControls } from './audio';
import { RaceHud, UI } from './ui';
import { pickVehicles, showVehicleSpin } from './ui/spin';
import { settings } from './core/settings';
import { applyPendingUpdate, registerPWA } from './pwa';

/**
 * Composition root. Wires modules together; contains no game rules itself.
 * Other agents should rarely need to edit this file beyond adding a line to construct/register
 * their system — keep logic inside the modules.
 */
async function boot(): Promise<void> {
  preventBrowserGestures();
  let onTitle = true;
  registerPWA(() => onTitle);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('hud') as HTMLElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;

  await initRapier();
  const quality = new QualityManager();
  const renderer = new Renderer(canvas, quality);
  const physics = new PhysicsWorld();
  const loop = new GameLoop(physics, () => renderer.render(), quality);
  const ctx: GameContext = { physics, renderer, loop, quality, overlay };

  // ---- modules (registration order = update order)
  const input = loop.add(new PlayerInput(overlay));
  const world = loop.add(createWorld(ctx, new URLSearchParams(location.search).get('level') === 'test' ? 'test' : 'race'));
  const race = loop.add(new RaceController(world));

  // Per-race vehicles + computer driver live in RaceFlow (rebuilt on every spin).
  // Order: race → computer driver (writes its input) → vehicles (read inputs). `flow` is assigned below,
  // before the loop starts.
  let flow!: RaceFlow;
  loop.add({ fixedUpdate: (dt: number) => flow.aiSystem.fixedUpdate!(dt) });
  loop.add({
    fixedUpdate: (dt: number) => flow.vehicleSystem.fixedUpdate!(dt),
    postPhysics: (dt: number) => flow.vehicleSystem.postPhysics!(dt),
    update: (dt: number, a: number) => flow.vehicleSystem.update!(dt, a),
  });

  const camera = loop.add(new ChaseCamera(renderer.camera));
  const fx = loop.add(new Effects(ctx));
  const audio = loop.add(new AudioSystem());
  audio.bindEvents();
  const hud = loop.add(new RaceHud(overlay, race));
  hud.setTrack(world.track);

  flow = new RaceFlow({
    race,
    world,
    player: input,
    createVehicle: (racer, pick, spawn) =>
      createVehicle({
        physics,
        parent: renderer.scene,
        surfaces: world,
        spec: pick.spec,
        paint: pick.paint,
        racer,
        spawn,
      }),
    createComputer: (cpu, gap) => {
      const ai = new AIDriver(cpu, world, settings.difficulty);
      ai.sensor = createPhysicsSensor(physics, 'cpu');
      ai.rival = { gapM: gap };
      return ai;
    },
    spin: pickVehicles,
    showSpin: async (picks) => {
      ui.show(null);
      await showVehicleSpin(uiRoot, picks);
      setDriving(true);
    },
    onVehicles: (now, old) => {
      for (const v of Object.values(old) as Vehicle[]) {
        audio.detachVehicle(v);
        fx.untrack(v);
      }
      for (const v of [now.player, now.cpu]) {
        audio.attachVehicle(v);
        fx.track(v);
      }
      camera.target = now.player;
      camera.snap();
      hud.setCarColors({ player: now.player.paint, cpu: now.cpu.paint });
    },
    onResults: (res) => {
      setDriving(false);
      hud.setVisible(false);
      ui.results.show(res, {
        player: flow.vehicles.player?.paint,
        cpu: flow.vehicles.cpu?.paint,
      });
      ui.show('results');
    },
  });
  flow.prepare();
  const playerCar = (): Vehicle | undefined => flow.vehicles.player;

  // Shadow camera + HUD follow the player.
  loop.add({
    update: () => {
      const p = playerCar();
      if (p) {
        renderer.setShadowFocus(p.position);
        input.touch.setSpeed(p.speed * 3.6, settings.speedUnit);
      }
      if (ui.calibrate.el.hidden === false) ui.setTiltReadout(input.tilt.status === 'granted' ? `tilt ${input.tilt.rawAngle.toFixed(0)}°` : '');
    },
  });

  // ---- flow: title → calibrate → drive
  let paused = false;
  // HUD/controls visible + wake lock during countdown/race. Who may actually drive is the race's call.
  const setDriving = (on: boolean): void => {
    input.touch.setVisible(on);
    hud.setVisible(on);
    setWakeLock(on);
    quality.setMonitoring(on);
  };

  const ui = new UI(uiRoot, {
    onStart: async (): Promise<TiltStatus> => {
      // Both calls start synchronously inside the tap (iOS gesture requirement).
      audio.unlock();
      const p = input.tilt.requestPermission();
      onTitle = false;
      ui.show('calibrate');
      const status = await p;
      input.refreshSteerButtons();
      return status;
    },
    onReady: () => {
      input.tilt.calibrate();
      ui.show(null);
      void flow.newRace();
    },
    onRaceAgain: () => {
      ui.show(null);
      applyPendingUpdate();
      void flow.newRace();
    },
    onResume: () => togglePause(false),
    onMenu: () => {
      togglePause(false);
      setDriving(false);
      flow.quit();
      ui.show('title');
      onTitle = true;
      applyPendingUpdate();
    },
    onRecalibrate: () => {
      input.tilt.calibrate();
      ui.toast('Tilt recalibrated: current position is now straight');
    },
    onQuality: (level) => quality.set(level),
    debugInfo: () =>
      [
        `quality ${quality.preset.level}  frame ${quality.avgFrameMs.toFixed(1)} ms`,
        `tilt ${input.tilt.status}  raw ${input.tilt.rawAngle.toFixed(1)}°`,
        `dpr ${window.devicePixelRatio}  draw calls ${renderer.renderer.info.render.calls}`,
        `v${__APP_VERSION__}`,
      ].join('\n'),
  });

  // Music / Effects volume rows on the pause/settings screen (persisted in settings).
  const settingsGrid = ui.pause.el.querySelector('.settings-grid');
  if (settingsGrid) mountVolumeControls(settingsGrid);

  const togglePause = (force?: boolean): void => {
    if (race.phase === 'title' || race.phase === 'calibrate' || race.phase === 'spin' || race.phase === 'results') return;
    paused = force ?? !paused;
    loop.paused = paused;
    quality.setMonitoring(!paused);
    ui.show(paused ? 'pause' : null);
    hud.setVisible(!paused);
    events.emit('app:paused', { paused });
  };

  input.onAction('reset', () => {
    if (!paused) race.requestReset('player');
  });
  input.onAction('camera', () => camera.toggleMode());
  input.onAction('pause', () => togglePause());

  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    audio.setSuspended(hidden);
    if (hidden && race.canDrive('player')) togglePause(true);
  });
  // Pause when rotated to portrait mid-drive (the CSS overlay covers the screen).
  const portrait = window.matchMedia('(orientation: portrait)');
  portrait.addEventListener('change', () => {
    if (portrait.matches && (race.canDrive('player') || race.phase === 'countdown')) togglePause(true);
  });

  setDriving(false);
  ui.show('title');
  loop.start();
  document.body.classList.add('ready');

  // Dev/test hook (used by scripts/smoke.mjs). Harmless in production.
  (window as unknown as { __dirt: unknown }).__dirt = {
    loop,
    get player() {
      return flow.vehicles.player;
    },
    get cpu() {
      return flow.vehicles.cpu;
    },
    get ai() {
      return flow.computer;
    },
    flow,
    hud,
    input,
    race,
    quality,
    renderer,
    ui,
    world,
    audio,
    events,
  };
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('fatal');
  if (el) {
    el.hidden = false;
    el.textContent = `Oops, the game could not start: ${String(err?.message ?? err)}`;
  }
});
