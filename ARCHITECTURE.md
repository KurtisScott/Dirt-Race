# Dirt Race: Architecture

SPEC.md is the source of truth for *what* to build. This file covers *where* code lives and *how modules talk to each other*, so the work streams can run in parallel without editing each other's files.

```
src/
  main.ts          composition root: builds everything, wires callbacks. No game rules.
  pwa.ts           service-worker registration (update only on menus)
  style.css        global CSS: iOS lock-down, screens, touch controls, rotate overlay
  core/            engine services every module may import
  input/           tilt, touch pedals/buttons, keyboard → DriveInput
  vehicles/        catalog (6 kinds), stats → physics params, ray-cast vehicle, models
  world/           World interface, TrackPath, surfaces, test ground (M1), real track (TODO)
  race/            race state machine, rules, checkpoints, scoring, session score
  ai/              computer driver → DriveInput
  ui/              HTML/CSS screens + HUD
  audio/           Web Audio (procedural)
  fx/              chase camera, particles, skid marks, confetti
scripts/           icons, headless physics/tilt tests, browser smoke test
```

## Rules of the road

1. **Depend on interfaces, not implementations.** Each module has a `types.ts` with its public interfaces and an `index.ts` that re-exports what others may use. Import from `../world` or `../world/types`, never from another module's internals.
2. **Cross-module notifications go through the event bus** (`core/events.ts`). To add an event, add one line to `GameEvents`. Don't import another module just to call it back.
3. **Only `vehicles/` writes vehicle physics.** AI and input produce a `DriveInput`; race calls `vehicle.reset()` / `setFrozen()`. Nothing else touches the chassis rigid body.
4. **Only `core/loop.ts` steps physics.** Modules hook into the loop by implementing `System` and being registered with `loop.add()` in `main.ts`.
5. **Be frugal** (A10X/A12 GPUs): read `ctx.quality.preset` (`detail`, `textureSize`, `shadows`, `viewDistance`) and listen to `'quality:changed'`. Prefer `MeshLambertMaterial`/`MeshStandardMaterial`, instancing and merged geometry. Keep draw calls well under ~150.
6. **No network assets.** Everything is procedural or comes from an npm/GitHub package with a permissive license, logged in `ASSETS.md`.
7. **localStorage only via `core/storage.ts`** (wrapped in try/catch).

## core/

| File | Public surface |
| --- | --- |
| `types.ts` | `RacerId` (`'player' \| 'cpu'`), `SpeedUnit` (`'mph' \| 'kmh'`), `SurfaceType`, `SurfaceProps`, `VehicleKind`, `VehicleStats`, `DriveInput {steer -1..1, throttle 0..1, brake 0..1}`, `SpawnPoint {x,y,z,yaw}` (y = **ground** height; yaw 0 = +Z), `QualityLevel`, `Sensitivity`, `Difficulty`, `CameraMode`, `System` |
| `events.ts` | `events` (the single typed `EventBus<GameEvents>`), `GameEvents` map, `GamePhase`, `TiltStatus`, `RaceResults` |
| `context.ts` | `GameContext {physics, renderer, loop, quality, overlay}`, passed to module constructors |
| `loop.ts` | `GameLoop`: fixed 60 Hz physics with render interpolation. `add(system)`, `paused`, `simTime`, `stepOnce()` |
| `physics.ts` | `initRapier()`, `PhysicsWorld {world, tag(), getTag(), onCollision(), onContactForce()}`, `PHYSICS_DT`, collision `Group` bits + `groups(member, filter)`, `ColliderTag` |
| `interpolation.ts` | `InterpolatedPose`: `capture()` after each step, `apply(obj, alpha)` per frame, `snap()` after teleports |
| `renderer.ts` | `Renderer {scene, camera, sun, sunDir, setShadowFocus(), applyQuality()}`: sky dome, fog, hemisphere + sun light |
| `quality.ts` | `QualityManager {preset, set(level), setMonitoring(on)}`, `QUALITY_PRESETS` |
| `settings.ts` | live `settings` object + `updateSettings(patch)` (persists, emits `settings:changed`) |
| `storage.ts` | `loadJSON`, `saveJSON` |
| `math.ts` | `clamp`, `lerp`, `smoothing(dt, tau)`, `approach`, `wrapAngle`, seeded `rng(seed)` |
| `wakeLock.ts` | `setWakeLock(on)` (feature-detected, re-acquired on visibility change) |

### System lifecycle (per rendered frame)

```
repeat 0..4 times while accumulator ≥ 1/60:
    every system.fixedUpdate(dt)     ← vehicles apply input/forces, race timers
    physics.step()                   ← Rapier step + collision/contact-force event dispatch
    every system.postPhysics(dt)     ← vehicles read wheel contacts, race reads progress
every system.update(frameDt, alpha)  ← input sampling, render-pose interpolation, camera, fx, HUD
renderer.render()
```

Systems run in **registration order** (see `main.ts`): input → world → race → AI → vehicles → camera → fx → audio → HUD.

### Collision groups

`GROUND` (terrain/road/hill/ramps), `STATIC` (boulders, logs, bumps), `VEHICLE`, `DEBRIS` (hay, cones), `ANIMAL`, `SENSOR` (checkpoints/finish/summit). Wheel rays hit `GROUND | STATIC | DEBRIS` and skip sensors. Tag every collider with `physics.tag(collider, {kind, ...})` so contact handlers can tell what was hit. A ground collider can carry `surface` in its tag, which overrides `surfaceAt()` for wheels touching it.

## input/

```ts
class PlayerInput implements PlayerControls, System {
  readonly state: DriveInput;        // assign to vehicle.input once
  enabled: boolean;                  // false → zeros (menus, countdown)
  readonly tilt: TiltSteering;       // requestPermission() from the Start tap; calibrate() on Ready
  readonly touch: TouchControls;     // pedals, steer buttons, reset/camera/pause, setSpeed(kmh)
  onAction('reset' | 'pause' | 'camera', fn): unsubscribe
  usingSteerButtons: boolean;        // tilt denied/unavailable or forced in settings
}
preventBrowserGestures()             // call once at boot
```

* **Tilt** (`tilt.ts`): beta/gamma → gravity in device space → rotate into screen space using `window.orientation` (or `screen.orientation.angle`) → wheel angle `atan2(right, down)`. It works the same in both landscape orientations and at any backward tilt, with a blend to `asin` near flat. Dead zone 3°, full lock 22/30/38° (sensitivity High/Med/Low), 70 ms smoothing, gentle response curve. `settings.tiltInvert` is a safety valve. `scripts/tilt-test.ts` checks the maths for both orientations at 0/30/60° pitch.
* **Steering priority:** keyboard (if pressed), then on-screen buttons (if in use), then tilt. Digital sources ramp at 3.2 full-locks/s.
* Elements with class `allow-touch` opt out of gesture blocking (e.g. a scrollable list).

## vehicles/

```ts
createVehicle({ physics, parent?, surfaces, spec, paint, racer, spawn, modelBuilder?, paramOverrides? }): Vehicle
interface Vehicle extends VehicleState, System {
  input: DriveInput;  reset(at: SpawnPoint); setFrozen(b); object; dispose();
}
interface VehicleState {          // what race/ai/ui/audio/fx read
  racer, spec, paint, speed (m/s, signed), position, quaternion, forward (interpolated render pose),
  rpm (0..1), steerAngle, input, wheelsOnGround, airTime, surface, flipped,
  wheels[4]: { contact, point, surface, slip 0..1, compression 0..1 }   // FL, FR, RL, RR
}
VEHICLES, VEHICLE_KINDS, randomVehicle(rand?) → { spec, paint }
paramsFromSpec(spec) → VehicleParams     // the ONE place stats become physics
```

* Physics: Rapier `DynamicRayCastVehicleController`. Chassis local axes are **+Z forward, +Y up, +X left**. The chassis is a round-cuboid plus a massless roof collider. Mass properties are set explicitly with a lowered centre of mass, CCD is on, and the car never sleeps.
* Assists in `vehicle.ts`: speed-sensitive and rate-limited steering, roll PD assist (strongest for the sedan), air levelling, surface grip/drag/rolling resistance (reduced by the off-road stat), hill-climb torque boost when nose-up, coasting decel, hold-still brake, brake-to-reverse below 0.6 m/s.
* Emits `vehicle:surface`, `vehicle:landed {impact}`, `vehicle:flipped` (on side/roof and slow for 1.5 s), `vehicle:reset`.
* **Models** (`model.ts`): implement `ModelBuilder = (spec, paint, params) => VehicleModel {root, wheels[4], animate?, dispose}`. The root sits at the chassis collider centre. Each wheel is centred on its axle with the axle along local X; the vehicle positions and rotates it. M1 has one placeholder pickup-ish model for every kind.
* `npm run physics-test` drives all 6 vehicles headless (settle, 0-60, top speed, full-lock turn, slalom, braking, reverse, coast, ramp jump) and fails on regressions. Run it after tuning.

## world/

```ts
interface World extends SurfaceQuery, System {
  track: TrackPath;                 // centre-line, arc-length parameterised (s in metres)
  zones: Zone[];                    // {id: 'town'|'farm'|'mud'|'rocky'|'desert'|'river'|'finish'|'hill'|'test', startS, endS}
  checkpoints: Checkpoint[];        // {index, s, respawn: SpawnPoint}, ~every 300 m
  spawns: { player, cpu };          // side-by-side grid slots
  summit: Vector3;
  surfaceAt(x, z): SurfaceType;     // called per wheel per step: must be cheap (no raycasts)
  heightAt(x, z): number;           // cheap approximate ground height for placing props/particles
  zoneAt(s): Zone;
  resetDynamic(): void;             // restore hay/cones, clear animals (race restart)
}
interface TrackPath {
  length, finishS, summitS;
  pointAt(s), tangentAt(s), halfWidthAt(s);
  project(pos, hintS?) → { s, lateral }   // lateral > 0 = right of travel; pass last s as hint
}
createWorld(ctx, level)             // 'test' today; add 'race'
SURFACES                            // grip/drag/rolling per surface, tune here
PolylineTrack.fromControlPoints(ctrl, halfWidth, finishS, summitS)   // reusable TrackPath impl
```

`TestGround` is a 140 × 220 m asphalt loop with speed bumps, a field of moguls, two ramps, a mud patch, a sand patch and 6 hay bales. It implements the full `World` interface, so race/AI/UI can be built against it before the real track exists.

## race/

```ts
class RaceController implements System, RaceView {
  phase; elapsedS; timeLeftS; countdownLeftS; winner; progress: Record<RacerId, RacerProgress>; config; lastResults;
  setVehicle(racer, v); setDriver(racer, input, control?);     // race owns vehicle.input (driver vs "hold")
  startSpin(); startCountdown(); abort(); startFreeDrive(); setPhase(p);
  requestReset(racer, delay = 2 s); isResetting(racer); respawnFor(racer); canDrive(racer); dispose();
}
RaceConfig { timeLimitS 240, bonusTimeS 45, finishAt 'hillFoot'|'summit', resetDelayS 2,
             countdownS 3, resultsDelayS 1.5, summitRadiusM 7, cpuGraceS 12 }
RacerProgress { s, bestS, lateral, checkpoint, finished, finishTimeS, summit, position, stage, bonusLeftS, points }
class RaceFlow { newRace(); prepare(); quit(); vehicles; computer; picks; aiSystem; vehicleSystem }
randomSpin(): VehiclePicks                                     // stub SpinFn until the vehicles spin lands
session.score / session.add(racer, pts) / session.clear()     // localStorage
```

* **Phases:** `title → calibrate → spin → countdown → racing → bonus → results → (spin | title)`. Each racer also has a
  `stage`: `waiting → racing → bonus → done`. The phase becomes `bonus` when the first car finishes.
* **Who drives:** race assigns `vehicle.input` itself. It uses the driver's input (`PlayerInput.state` / `AIDriver.input`)
  only while `canDrive(racer)` is true. Otherwise it uses a *hold* input that brakes to a stop and never reverses.
  Don't use `vehicle.setFrozen()` for the countdown: its brake=1 makes a stopped car reverse. `control.enabled`
  (PlayerInput / AIDriver) is toggled to match.
* **Rules:** first across `finishS` wins 1 point. Each finisher gets its own 45 s bonus window, and reaching the summit
  (`bestS ≥ summitS − 1` or within `summitRadiusM` of `world.summit`) gives +1. When the 4-minute timer runs out,
  anyone still racing is done. If nobody finished, the higher `bestS` wins (a gap under 0.5 m is a tie with no
  points). Once Brooks is done, the computer gets at most `cpuGraceS` more seconds. When every racer is done, the
  results screen follows `resultsDelayS` later. Distances in the results are measured from the grid.
* **Resets:** `requestReset` → `race:resetting` → teleport after the delay to the last checkpoint. On the bonus
  hill the car goes back to the finish line instead. Flips auto-reset after 0.5 s. Resets are ignored when the car
  can't drive.
* **Spin integration:** pass `spin: SpinFn` (returns `{player, cpu}` picks) and `showSpin(picks) → Promise` (the reel UI)
  to `RaceFlow`. Until those are merged, main uses `randomSpin` plus the placeholder `ui.spin` card.
* **Events emitted:** `phase:changed`, `race:countdown {n}` (3, 2, 1), `race:go`, `race:checkpoint`,
  `race:finish {winner}`, `race:bonus`, `race:summit`, `race:timeout`, `race:lead {leader}`, `race:resetting`,
  `race:done`, `race:results` (`RaceResults` also carries optional `reason`, `finishM`, `summitM`).
* `npm run race-test`: headless full races on TestGround (each difficulty, idle player / 4-minute timer, farthest rule,
  tie, reset delay, Hard shortcut, AI cost). It's part of `npm test`.

## ai/

`new AIDriver(vehicleState, world, difficulty, seed?)` writes `input` in **fixedUpdate** (register it before vehicles;
`RaceFlow.aiSystem` does this). Optional members: `sensor: ObstacleSensor` (`createPhysicsSensor(physics, 'cpu')`,
Rapier rays vs STATIC|DEBRIS|ANIMAL|VEHICLE), `rival: { gapM() }` (Easy eases off when ahead), `onRequestReset`.
`DIFFICULTY` holds the per-level profile (topFrac 0.8/0.92/1, mistake frequency, line cut, shortcuts).

* At construction it precomputes, for its own car: a racing line (lateral offset toward the inside of curves, smoothed)
  and a speed profile (curvature × surface grip, slowed for steep descents and crests, then a backward braking pass).
  Per step it does a pure-pursuit steer to a look-ahead of 5 + 0.55·v m and runs a throttle/brake P-controller. On
  slopes steeper than 0.2 it holds full throttle (the bonus hill).
* Obstacles: 5 rays at 12 Hz. Hits are stored in track space (s, lateral) for 1.5 s, and a tiny lane planner picks
  the clear lateral offset closest to the line.
* Stuck: reverses out when it's slow with throttle down, or does a three-point turn when facing backwards. With no
  progress for 9 s (or after 3 recoveries) it calls `onRequestReset` (the same 2 s Reset as Brooks).
* Mistakes (seeded): wobble, throttle lift, running wide, braking late. Easy every 5–10 s, Normal every 14–26 s, Hard never.
* **World extras (optional, duck-typed):** `world.shortcuts?: TrackShortcut[]` (`{id, startS, endS, points, halfWidth?, maxSpeed?}`).
  Hard follows a shortcut's points when it reaches `startS`. **World engineer:** expose the log bridge this way.
* Cost: about 10 µs per step in Node, including rays.

## ui/

`new UI(root, handlers: UIHandlers)` provides the title, calibrate ("hold it like a wheel"), and pause/settings screens plus `toast()`. Screens are plain HTML via the `Screen` helper. Buttons use `onTap` (a click on an element with `touch-action: manipulation`, which counts as a user activation on iOS). The UI reads `RaceView`, `VehicleState` and the event bus. It never touches physics. The HUD speedometer lives in `input/touch.ts` between the pedals (`touch.setSpeed(kmh, settings.speedUnit)`).

Race UI (`ui/raceHud.ts`):
* `RaceHud` (a System): position badge, race clock (red under 30 s), progress strip (start, finish flag, hill, summit
  flag, both cars in their paint colours), bonus-hill banner with its own countdown, the big 3-2-1-GO (driven by
  `race.countdownLeftS`, so it stays in sync with sim time), "Resetting…", and short messages (lead change,
  win, summit, time's up).
* `ResultsScreen` (`ui.results`): winner, how it was decided, a card per racer (vehicle, distance bar, finish time or
  distance reached, summit bonus, points), session score, plus RACE AGAIN / Menu (`handlers.onRaceAgain`, `onResultsMenu`).
* `SpinCard` (`ui.spin`): **placeholder** vehicle reveal with stat bars. The Vehicles engineer's reel replaces it via `RaceFlow.showSpin`.
* Pause screen adds **Computer: Easy / Normal / Hard** (takes effect from the next race) and **Speed in: mph / km/h**
  (`settings.speedUnit`, default mph; results distances are shown in feet or metres to match).

## audio/

`AudioSystem.unlock()` **must** be called synchronously in the Start tap (it already is). `attachVehicle(v)` reads `rpm`, `input.throttle`, `surface` and `wheels[].slip`. Subscribe to bus events for one-shots. `setCountdownVoice(urls | null)` is the swappable slot for Brooks's voice. Music and SFX volumes come from `settings`.

## fx/

* `ChaseCamera` (done): `target`, `toggleMode()` (close/far, persisted), `shake(amount)`, `snap()`, `override` (for results/finish cinematics). Shake fires automatically on hard landings.
* `Effects` (stub): `track(vehicleState)`. Build particles and skid marks from `wheels[]` and scale by `quality.preset.detail`.

## Debug hooks

`window.__dirt` exposes `{loop, player, cpu, ai, flow, hud, input, race, quality, renderer, ui, world}` (`player`/`cpu` are getters: cars are rebuilt every spin) for console poking and the smoke test. The pause screen shows quality, frame time, tilt status, draw calls and version.

## Scripts

| Command | What |
| --- | --- |
| `npm run dev` | Vite dev server on LAN (`--host`). iOS tilt needs **HTTPS**, so test tilt on the deployed build or behind an HTTPS tunnel. |
| `npm run build` | icons → typecheck → `dist/` (relative base, service worker, manifest) |
| `npm run typecheck` | strict TS for app and node scripts |
| `npm test` | tilt maths, headless physics and headless race/AI tests (no browser) |
| `npm run race-test` | full headless races on TestGround (rules, scoring, difficulties) |
| `npm run smoke` | serves `dist/` under `/dirt-race/`, plays spin → countdown → race → results → Race Again in headless Chrome, checks settings, SW/offline/rotate overlay, writes `screenshots/m1*.png` and `race-*.png` (`QUALITY=medium npm run smoke` for shadows) |
