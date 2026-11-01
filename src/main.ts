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
import { VEHICLES, createVehicle } from './vehicles';
import { createWorld } from './world';
import { RaceController } from './race';
import { ChaseCamera, Effects } from './fx';
import { AudioSystem, mountVolumeControls } from './audio';
import { UI } from './ui';
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
  const world = loop.add(createWorld(ctx, 'test'));
  const race = loop.add(new RaceController(world));

  const player = loop.add(
    createVehicle({
      physics,
      parent: renderer.scene,
      surfaces: world,
      spec: VEHICLES.pickup,
      paint: VEHICLES.pickup.paints[0],
      racer: 'player',
      spawn: world.spawns.player,
    }),
  );
  player.input = input.state;
  race.setVehicle('player', player);

  const camera = loop.add(new ChaseCamera(renderer.camera));
  camera.target = player;
  const fx = loop.add(new Effects(ctx));
  fx.track(player);
  const audio = loop.add(new AudioSystem());
  audio.bindEvents();
  audio.attachVehicle(player);

  // Shadow camera + HUD follow the player.
  loop.add({
    update: () => {
      renderer.setShadowFocus(player.position);
      input.touch.setSpeed(player.speed * 3.6);
      if (ui.calibrate.el.hidden === false) ui.setTiltReadout(input.tilt.status === 'granted' ? `tilt ${input.tilt.rawAngle.toFixed(0)}°` : '');
    },
  });

  // ---- flow: title → calibrate → drive
  let paused = false;
  const setDriving = (on: boolean): void => {
    input.enabled = on;
    player.setFrozen(!on);
    input.touch.setVisible(on);
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
      race.startFreeDrive();
      setDriving(true);
    },
    onResume: () => togglePause(false),
    onMenu: () => {
      togglePause(false);
      setDriving(false);
      player.reset(world.spawns.player);
      race.setPhase('title');
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
    if (race.phase === 'title' || race.phase === 'calibrate') return;
    paused = force ?? !paused;
    loop.paused = paused;
    input.enabled = !paused;
    quality.setMonitoring(!paused);
    ui.show(paused ? 'pause' : null);
    events.emit('app:paused', { paused });
  };

  input.onAction('reset', () => {
    if (input.enabled) race.requestReset('player');
  });
  input.onAction('camera', () => camera.toggleMode());
  input.onAction('pause', () => togglePause());

  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    audio.setSuspended(hidden);
    if (hidden && input.enabled) togglePause(true);
  });
  // Pause when rotated to portrait mid-drive (the CSS overlay covers the screen).
  const portrait = window.matchMedia('(orientation: portrait)');
  portrait.addEventListener('change', () => {
    if (portrait.matches && input.enabled) togglePause(true);
  });

  setDriving(false);
  ui.show('title');
  loop.start();
  document.body.classList.add('ready');

  // Dev/test hook (used by scripts/smoke.mjs). Harmless in production.
  (window as unknown as { __dirt: unknown }).__dirt = { loop, player, input, race, quality, renderer, ui, world, audio, events };
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('fatal');
  if (el) {
    el.hidden = false;
    el.textContent = `Oops, the game could not start: ${String(err?.message ?? err)}`;
  }
});
