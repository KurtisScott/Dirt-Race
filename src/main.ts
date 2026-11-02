import './style.css';
import type { TiltStatus } from './core/events';
import { events } from './core/events';
import { GameLoop } from './core/loop';
import { initRapier, PhysicsWorld } from './core/physics';
import { QualityManager } from './core/quality';
import { NoWebGLError, Renderer } from './core/renderer';
import { setWakeLock } from './core/wakeLock';
import type { GameContext } from './core/context';
import type { System } from './core/types';
import { preventBrowserGestures, PlayerInput } from './input';
import { createVehicle, type Vehicle } from './vehicles';
import { createWorldAsync, type World } from './world';
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
 *
 * Boot order (so the title + loading bar appear as early as possible):
 *   1. renderer, input, audio, camera, fx, UI  (cheap) → title screen with a loading bar, Start enabled
 *   2. Rapier WASM, then the course in two halves (yielding so the bar moves)
 *   3. race, flow, HUD → cars parked on the grid, title camera orbits them, body.ready
 * Start can be tapped during step 2: it still unlocks audio and asks for tilt permission synchronously
 * inside the tap; the calibrate screen's Ready button waits for the course.
 */
async function boot(): Promise<void> {
  preventBrowserGestures();
  let onTitle = true;
  registerPWA(() => onTitle);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('hud') as HTMLElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const loadingEl = document.getElementById('loading');
  const setBootProgress = (f: number): void => loadingEl?.style.setProperty('--p', f.toFixed(3));
  setBootProgress(0.1);

  const quality = new QualityManager();
  const renderer = new Renderer(canvas, quality);
  setBootProgress(0.2);

  // ---- modules that don't need physics or the course (the title screen works with just these)
  let world: World | null = null;
  let race: RaceController | null = null;
  let flow: RaceFlow | null = null;
  let hud: RaceHud | null = null;
  let togglePause: (force?: boolean) => void = () => {};
  const input = new PlayerInput(overlay);
  const camera = new ChaseCamera(renderer.camera);
  const audio = new AudioSystem();
  audio.bindEvents();

  let paused = false;
  // HUD/controls visible + wake lock during countdown/race. Who may actually drive is the race's call.
  const setDriving = (on: boolean): void => {
    input.touch.setVisible(on);
    hud?.setVisible(on);
    setWakeLock(on);
    quality.setMonitoring(on);
  };

  let resolveCourse!: () => void;
  const courseReady = new Promise<void>((r) => (resolveCourse = r));

  const ui = new UI(uiRoot, {
    onStart: async (): Promise<TiltStatus> => {
      // Both calls start synchronously inside the tap (iOS gesture requirement). Nothing may be awaited
      // before them — the course may still be building; Ready waits for it instead.
      audio.unlock();
      const p = input.tilt.requestPermission();
      onTitle = false;
      ui.show('calibrate');
      const status = await p;
      input.refreshSteerButtons();
      return status;
    },
    courseReady,
    onReady: () => {
      input.tilt.calibrate();
      ui.show(null);
      void flow?.newRace();
    },
    onRaceAgain: () => {
      // Never apply a waiting app update here: it reloads the page and would dump Brooks on the title
      // screen instead of the new spin. Updates apply from Menu (or on the next cold launch).
      ui.show(null);
      void flow?.newRace();
    },
    onResume: () => togglePause(false),
    onMenu: () => {
      togglePause(false);
      setDriving(false);
      flow?.quit();
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
        `quality ${quality.preset.level}${settings.autoQuality ? ' (auto)' : ''}  frame ${quality.avgFrameMs.toFixed(1)} ms`,
        `tilt ${input.tilt.status}  raw ${input.tilt.rawAngle.toFixed(1)}°`,
        `dpr ${window.devicePixelRatio} × ${renderer.renderer.getPixelRatio().toFixed(2)}  draw calls ${renderer.renderer.info.render.calls}  tris ${(renderer.renderer.info.render.triangles / 1000).toFixed(0)}k`,
        `terrain ${(world as { terrainShading?: string } | null)?.terrainShading ?? '-'}  textures ${renderer.renderer.info.memory.textures}  geometries ${renderer.renderer.info.memory.geometries}`,
        `v${__APP_VERSION__}`,
      ].join('\n'),
  });
  // Music / Effects volume rows on the settings screen (persisted in settings).
  const settingsGrid = ui.pause.el.querySelector('.settings-grid');
  if (settingsGrid) mountVolumeControls(settingsGrid);
  ui.show('title');
  ui.setLoading(0.05, 'Warming up the engines…');
  loadingEl?.classList.add('done'); // the title screen has its own bar from here on
  setDriving(false);

  // ---- physics + loop. Registration order = update order:
  // input → world → race → AI → vehicles → camera → fx → audio → HUD (world/race/AI/vehicles/HUD are
  // slots filled once the course exists).
  await initRapier();
  const physics = new PhysicsWorld();
  const loop = new GameLoop(physics, () => renderer.render(), quality);
  const ctx: GameContext = { physics, renderer, loop, quality, overlay };
  const slot = (get: () => System | null | undefined): System => ({
    fixedUpdate: (dt) => get()?.fixedUpdate?.(dt),
    postPhysics: (dt) => get()?.postPhysics?.(dt),
    update: (dt, a) => get()?.update?.(dt, a),
  });
  loop.add(input);
  loop.add(slot(() => world));
  loop.add(slot(() => race));
  loop.add(slot(() => flow?.aiSystem));
  loop.add(slot(() => flow?.vehicleSystem));
  loop.add(camera);
  const fx = loop.add(new Effects(ctx));
  loop.add(audio);
  loop.add(slot(() => hud));

  // Title backdrop: a slow orbit around the cars on the grid.
  let orbitT = 0;
  const titleOrbit = (cam: import('three').PerspectiveCamera, dt: number): void => {
    const p = flow?.vehicles.player;
    const c = flow?.vehicles.cpu;
    if (!p || !c || !world) return;
    orbitT += dt;
    const cx = (p.position.x + c.position.x) / 2;
    const cz = (p.position.z + c.position.z) / 2;
    const cy = Math.max(p.position.y, c.position.y);
    const yaw = world.spawns.player.yaw + Math.PI * 0.8 + Math.sin(orbitT * 0.12) * 0.7;
    const r = 11.5;
    cam.position.set(cx + Math.sin(yaw) * r, cy + 3.2, cz + Math.cos(yaw) * r);
    cam.lookAt(cx + Math.sin(world.spawns.player.yaw) * 4, cy + 0.6, cz + Math.cos(world.spawns.player.yaw) * 4);
    if (cam.fov !== 55) {
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
  };
  const updateCameraMode = (): void => {
    const onMenus = !race || race.phase === 'title' || race.phase === 'calibrate';
    camera.override = onMenus ? titleOrbit : null;
    if (!onMenus) camera.snap();
  };
  events.on('phase:changed', updateCameraMode);
  updateCameraMode();
  loop.start();

  // ---- the course (the slow part)
  const level = new URLSearchParams(location.search).get('level') === 'test' ? 'test' : 'race';
  world = await createWorldAsync(ctx, level, (f, label) => ui.setLoading(0.1 + f * 0.8, label));
  ui.setLoading(0.92, 'Painting the cars…');
  await new Promise((r) => setTimeout(r, 0));
  fx.setWorld(world);
  const w = world;
  race = new RaceController(w);
  const r = race;
  hud = new RaceHud(overlay, r);
  hud.setTrack({ length: w.track.length, finishS: w.track.finishS, jumpS: w.jump.lipS, bonusS: w.jump.bonusS });
  hud.setVisible(false);

  const f = (flow = new RaceFlow({
    race: r,
    world: w,
    player: input,
    createVehicle: (racer, pick, spawn) =>
      createVehicle({
        physics,
        parent: renderer.scene,
        surfaces: w,
        spec: pick.spec,
        paint: pick.paint,
        racer,
        spawn,
      }),
    createComputer: (cpu, gap) => {
      const ai = new AIDriver(cpu, w, settings.difficulty);
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
      hud!.setCarColors({ player: now.player.paint, cpu: now.cpu.paint });
    },
    onResults: (res) => {
      setDriving(false);
      hud!.setVisible(false);
      ui.results.show(res, {
        player: f.vehicles.player?.paint,
        cpu: f.vehicles.cpu?.paint,
      });
      ui.show('results');
    },
  }));
  f.prepare();
  const playerCar = (): Vehicle | undefined => f.vehicles.player;

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

  // ---- pause / system events
  togglePause = (force?: boolean): void => {
    if (r.phase === 'title' || r.phase === 'calibrate' || r.phase === 'spin' || r.phase === 'results') return;
    paused = force ?? !paused;
    loop.paused = paused;
    quality.setMonitoring(!paused);
    ui.show(paused ? 'pause' : null);
    hud!.setVisible(!paused);
    events.emit('app:paused', { paused });
  };

  input.onAction('reset', () => {
    if (!paused) r.requestReset('player');
  });
  input.onAction('camera', () => camera.toggleMode());
  input.onAction('pause', () => togglePause());

  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    audio.setSuspended(hidden);
    if (hidden && r.canDrive('player')) togglePause(true);
  });
  // Pause when rotated to portrait mid-drive (the CSS overlay covers the screen).
  const portrait = window.matchMedia('(orientation: portrait)');
  portrait.addEventListener('change', () => {
    if (portrait.matches && (r.canDrive('player') || r.phase === 'countdown')) togglePause(true);
  });

  updateCameraMode();
  ui.setLoading(1, '');
  resolveCourse();
  document.body.classList.add('ready');

  // Dev/test hook (used by scripts/smoke.mjs). Harmless in production.
  (window as unknown as { __dirt: unknown }).__dirt = {
    loop,
    get player() {
      return f.vehicles.player;
    },
    get cpu() {
      return f.vehicles.cpu;
    },
    get ai() {
      return f.computer;
    },
    flow: f,
    hud,
    input,
    race: r,
    quality,
    renderer,
    ui,
    world: w,
    camera,
    audio,
    events,
    fx,
    physics,
  };
}

function showFatal(text: string): void {
  const el = document.getElementById('fatal');
  document.getElementById('loading')?.classList.add('done');
  if (el) {
    el.hidden = false;
    el.textContent = text;
  }
}

boot().catch((err) => {
  console.error(err);
  if (err instanceof NoWebGLError) {
    showFatal(
      "Sorry! This browser can't show the 3D race track (it needs WebGL 2). On an iPad, update to iPadOS 15 or newer (Settings → General → Software Update), then open the game again.",
    );
  } else {
    showFatal(`Oops, the game could not start: ${String(err?.message ?? err)}. Try closing it and opening it again.`);
  }
});
