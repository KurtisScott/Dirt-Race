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
* **Models** (`model.ts`): implement `ModelBuilder = (spec, paint, params) => VehicleModel {root, wheels[4], animate?(dt, state?), dispose}`. The root sits at the chassis collider centre. Each wheel is centred on its axle with the axle along local X; the vehicle positions and rotates it. The default builder is now `buildVehicleModel` (`models/build.ts`): six procedural models, 3.1k–3.6k triangles each, 9–10 draw calls (paint, glass, trim, chrome, lamp, tail, 2 per wheel style, 1 instanced suspension rig). `buildPlaceholderModel` is still exported.
  * `models/loft.ts`: lofted bodies (side profile + plan width + 9-point cross-section with tumblehome, fender bulges and wheel arches). `models/kit.ts`: shared materials (procedural env map; paint is `MeshPhysicalMaterial` with clearcoat on High only), wheel builder, part merging. `models/rig.ts`: shocks/arms/axles as one `InstancedMesh` that follows the wheels.
  * Body motion: `animate` leans and dips the body from wheel travel (on top of the physics pose) and lights the brake lights when `state.input.brake` is held while moving forward.
  * `renderVehicleThumbnails(items?, size?) → {kind, paint, url}[]`: PNG data URLs of the real models (3/4 view, transparent). Uses one short-lived WebGL context, cached per kind and paint.
  * Dev only: `src/vehicles/dev/preview.html?kind=sports|…|all|thumbs&view=34|side|rear|top&q=low|medium|high`. `node scripts/vehicle-shots.mjs [each|all|<kind>] [view] [quality]` writes `screenshots/vehicle-<kind>.png`.
* `npm run physics-test` drives all 6 vehicles headless (settle, 0-60, top speed, full-lock turn, slalom, braking, reverse, coast, ramp jump) and fails on regressions. It then runs the **personality checks** with the real `SURFACES` table: speed per surface, a 20°/28°/36° gravel bonus-hill climb, a 36° hill start, a suspension bounce test and a log crawl. Run only those with `npx tsx scripts/physics-test.ts personality`. Run it after tuning.
* Optional `VehicleParams.climbTraction` (added in vehicles M2): on steep (> 6°) non-flat ground, engine force is capped at `mass·g·cos(slope)·climbTraction·(surfaceGrip/gravelGrip)`. It comes from the hill-climb stat, and tyre friction is raised to match so the stat, not Rapier wheelspin, decides who climbs.
* Surface top-speed caps live in `SURFACE_SPEED_PENALTY` (vehicle.ts), scaled by `1 − offroad`. The top-speed fade is compensated for aero, rolling resistance and damping, so flat-asphalt top speed equals `params.topSpeed`.

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
createWorld(ctx, level)             // 'race' (default: the real course) | 'test' (M1 test ground; ?level=test)
SURFACES                            // grip/drag/rolling per surface, tune here
PolylineTrack.fromControlPoints(ctrl, halfWidth, finishS, summitS)   // reusable TrackPath impl
```

`TestGround` is a 140 × 220 m asphalt loop with speed bumps, a field of moguls, two ramps, a mud patch, a sand patch and 6 hay bales. It implements the full `World` interface, so race/AI/UI can be built against it before the real track exists.

### The real course (`RaceCourse`)

| File | What |
| --- | --- |
| `layout.ts` | **Tune the course here.** Turtle segments (length + turn) → centre-line; zones; road widths; `FINISH_BEFORE_HILL_M` (the single finish-placement value); hill length/angles |
| `course.ts` | `CourseData`: pure data, no DOM/GL. Elevation profile, 2 m terrain height grid, 1 m surface grid, river/hill/shortcut geometry, checkpoints, spawns, and every prop/obstacle/animal placement. `CourseTrack` is the `TrackPath` |
| `terrain.ts` | Rapier heightfield (same grid and triangle split as the mesh, so `heightAt` is exact) + chunked render mesh with an 8-layer texture-array splat shader |
| `textures.ts` | Procedural textures from typed arrays (terrain layers, asphalt with lines, water normals, checker, pixel-font banners) |
| `props.ts` | Low-poly vertex-coloured templates (trees, pines, bushes, rocks, tufts, houses, barn, fence, ramp, log bridge) + `ChunkMerger` (one mesh per 120–160 m chunk) |
| `obstacles.ts` | Hay bales and cones (dynamic, sleeping, instanced), fixed boulders; emits `obstacle:hit` |
| `animals.ts` | Deer, bear, mouse, ducks, croc: crossing schedule, light dynamic bodies, procedural models; emits `animal:crossing` / `animal:bump` |
| `raceCourse.ts` | Assembles everything and implements `World` |

All `s` values on the course are **horizontal** metres along the centre-line. `track.pointAt(s).y` is the real ground height. `tangentAt` is horizontal.

**Optional members on `RaceCourse`** (not on `World`, so they are duck-typed; `TestGround` has none of them):
* `shortcuts: TrackShortcut[]`: `[{ id: 'log-bridge', startS, endS, points, halfWidth, maxSpeed }]` (AIWorldExtras, taken by the Hard computer).
* `animals: AnimalInfo[]`: `{ kind, position, velocity, radius, active }`. The AI should steer around entries with `active === true`. Animals are also `Group.ANIMAL` colliders, so the existing ray sensor sees them.
* `data: CourseData` (debug/tests), `animalsEnabled` (setter), `plannedAnimals`.

Event kinds: obstacles `'hay bale' | 'cone' | 'boulder'`; animals `'deer' | 'bear' | 'mouse' | 'duck' | 'croc'`.

Collider tags: ramps `ground/asphalt`, bridge `ground/dirt`, potholes `static/'bump'` (the AI sensor ignores bumps), fences `static/'fence'`, houses `static/'wall'`, near-road tree trunks `static/'tree'`, boulders `static/'boulder'`.

Tests: `npm run world-test` (headless: drives the course with all six vehicles, checks the hill, the shortcut and the zones). `node scripts/world-shots.mjs` (after a build) writes `screenshots/world-*.png` and prints draw calls per zone.

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
* `SpinCard` (`ui.spin`): placeholder vehicle reveal, **superseded** by the reel in `ui/spin/` (wired via `RaceFlow.showSpin` in main.ts). Safe to delete.
* Pause screen adds **Computer: Easy / Normal / Hard** (takes effect from the next race) and **Speed in: mph / km/h**
  (`settings.speedUnit`, default mph; results distances are shown in feet or metres to match).

**Vehicle spin** (`ui/spin/`, SPEC flow step 3):

```ts
runVehicleSpin(uiRoot, { rand?, force?: {player?, cpu?}, playerName?, cpuName?, speed?, onTick? })
  → Promise<{ player: {spec, paint}, cpu: {spec, paint} }>   // resolves when GO is tapped
```

It adds a full-screen overlay (`[data-screen="spin"]`) with two slot-machine reels of rendered model cards. Brooks's reel lands first, then the Computer's. Stat bars (Top speed, Acceleration, Grip, Off-road, Hill climb) fill as each reel lands. GO (`[data-tap="spin-go"]`) appears after both reels stop, and the overlay removes itself on tap. Bus events: `spin:tick {racer}` (each card passing, for reel clatter), `spin:land {racer, kind}` (both consumed by audio), and `spin:done {player, cpu}`. **Wired into the race flow** in `main.ts`: `RaceFlowDeps.spin = pickVehicles` (random picks), and `showSpin = (picks) => showVehicleSpin(uiRoot, picks)` plays the reels landing on exactly those picks and resolves on GO. CSS classes are prefixed `vspin-` so they can't clash with the old placeholder's `.spin-*` styles. The placeholder `SpinCard` (`ui.spin`) is no longer shown but is still constructed, so `ui.show('spin')` keeps compiling. Dev page: `src/ui/spin/dev.html?seed=7&speed=1`. `node scripts/spin-shot.mjs` checks the spin screen and writes `screenshots/spin.png`.


## audio/

All procedural (Web Audio): nothing is downloaded except optional countdown voice clips.

| File | What |
| --- | --- |
| `index.ts` | `AudioSystem` (graph, vehicles, one-shots, music switching, event wiring) |
| `engine.ts` | `ENGINE_PROFILES` per `VehicleSpec.engineSound`, `renderEngineLoop()` (pure JS), `EngineVoice` (loop → low-pass → gain → pan) |
| `sfx.ts` | `SFX` one-shot generators, `LOOPS` (surface beds + tyre squeal), `animalVoice(kind)`, `obstacleSound(kind)` |
| `music.ts` | `Sequencer` + `MENU_SONG` (104 bpm) / `RACE_SONG` (146 bpm) |
| `voice.ts` | countdown voice slot (`public/audio/countdown-{3,2,1,go}.m4a`) |
| `controls.ts` | `mountVolumeControls(settingsGrid)`: Music / Sound effects Off-Low-Med-High rows |

```ts
audio.unlock()                      // synchronously in the Start tap (already wired)
audio.setSuspended(hidden)          // visibilitychange (already wired); pause mute comes from 'app:paused'
audio.attachVehicle(v) / detachVehicle(v)   // race agent: attach the CPU car too, and swap on each new spin
audio.playMusic('menu' | 'race' | null)     // normally automatic from 'phase:changed'
audio.play('click' | 'chime' | ...)         // any SfxName one-shot
audio.musicVolume / audio.sfxVolume         // 0..1 get/set, persisted via settings
audio.setCountdownVoice(urls | null)
```

Graph: engines, tyres and one-shots go to the **game** bus and the sequencer goes to the **music** bus. Both feed **master**, which mutes on pause or hide, then a limiter, then the output. UI clicks use a **ui** bus that bypasses the pause mute. Engines and tyres only sound in `countdown`, `racing`, `bonus`, `freeDrive` and `results` (at half volume in `results`). The player's car is the listener: the CPU car and world sounds are attenuated (`1/(1+d/12)`), panned and low-passed by distance.

**Events consumed:** `phase:changed` (music: title/calibrate/spin → menu, countdown → silence, racing/bonus/freeDrive → race, results → menu after 2.8 s), `app:paused`, `settings:changed`, `race:countdown` (voice clip or beep), `race:go` (horn, plus the voice clip if present), `race:checkpoint` (player chime), `race:finish` (cheer + win jingle, or "good try" jingle), `race:summit` (fanfare), `race:timeout` (buzzer), `vehicle:landed` (thump scaled by impact), `vehicle:collision` (crash / car bump / boing), `vehicle:surface` (splash / squelch / crunch on entering), `vehicle:flipped`, `vehicle:reset`, `obstacle:hit` (hay / cone / crash by `kind`), `animal:crossing`, and optional events (below). Per-frame state comes from `VehicleState`: `rpm`, `input.throttle`, `speed`, `surface`, `wheels[].slip/contact/surface`, `wheelsOnGround`, `airTime`, `position`, `forward`.

**Optional events added for audio** (emit them when ready; nothing breaks if they never fire): `spin:tick {racer}` (one per reel item, throttled to 35 ms), `spin:land {racer, kind}`, `race:lead {leader}` (lead changes only), `animal:bump {kind, racer, x, z}`. Animal kinds are matched by substring (duck, mouse, deer, bear, croc), and anything else gets a boing. Obstacle kinds: hay/bale, cone, fence/crate/barrel → bump, anything else → crash.

Tests: `npm run audio-test` (in `npm test`) renders every generator in Node and checks for NaN, clipping, silence, loop seams and render time. `npm run audio-render` renders through a real `OfflineAudioContext` in headless Chrome and writes `screenshots/audio/*.wav` + waveform PNGs, checking levels and dropouts.

## fx/

* `ChaseCamera` (done): `target`, `toggleMode()` (close/far, persisted), `shake(amount)`, `snap()`, `override` (for results/finish cinematics). Shake fires automatically on hard landings.
* `Effects` (stub): `track(vehicleState)`. Build particles and skid marks from `wheels[]` and scale by `quality.preset.detail`.

## Debug hooks

`window.__dirt` exposes `{loop, player, cpu, ai, flow, hud, input, race, quality, renderer, ui, world, audio, events}` (`player`/`cpu` are getters: cars are rebuilt every spin) for console poking and the smoke test. The pause screen shows quality, frame time, tilt status, draw calls and version.

## Scripts

| Command | What |
| --- | --- |
| `npm run dev` | Vite dev server on LAN (`--host`). iOS tilt needs **HTTPS**, so test tilt on the deployed build or behind an HTTPS tunnel. |
| `npm run build` | icons → typecheck → `dist/` (relative base, service worker, manifest) |
| `npm run typecheck` | strict TS for app and node scripts |
| `npm test` | tilt maths, headless physics, race/AI and audio generator tests (no browser) |
| `npm run race-test` | full headless races on TestGround (rules, scoring, difficulties) |
| `npm run smoke` | serves `dist/` under `/dirt-race/`, plays spin → countdown → race → results → Race Again in headless Chrome, checks settings, SW/offline/rotate overlay, writes `screenshots/m1*.png` and `race-*.png` (`QUALITY=medium npm run smoke` for shadows) |
| `npm run audio-render` | renders sounds via OfflineAudioContext in headless Chrome → `screenshots/audio/` |
