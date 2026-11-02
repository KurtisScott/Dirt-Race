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
| `renderer.ts` | `Renderer {scene, camera, sun, sunDir, setShadowFocus(), applyQuality(), programFailed(mat), programReady(mat), shaderErrors}`: sky dome with sun disc + warm haze, fog = sky horizon colour, Neutral tone mapping, safe WebGL2 context creation (`NoWebGLError`), `SKY` palette |
| `quality.ts` | `QualityManager {preset, set(level, auto?), setMonitoring(on), sample(), autoDrops}`, `QUALITY_PRESETS`. Drops a level after 3 slow 1 s windows (>22 ms) and persists it; on Low, >40 ms emits `quality:slow` once |
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

`GROUND` (terrain/road/ramps/bridge decks), `STATIC` (boulders, logs, bumps), `VEHICLE`, `DEBRIS` (hay, cones), `ANIMAL`, `SENSOR` (checkpoints/finish). Wheel rays hit `GROUND | STATIC | DEBRIS` and skip sensors. Tag every collider with `physics.tag(collider, {kind, ...})` so contact handlers can tell what was hit. A ground collider can carry `surface` in its tag, which overrides `surfaceAt()` for wheels touching it.

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
* Optional `VehicleParams.climbTraction` (added in vehicles M2): on steep (> 6°) non-flat ground, engine force is capped at `mass·g·cos(slope)·climbTraction·(surfaceGrip/gravelGrip)`. It comes from the hill-climb stat, and tyre friction is raised to match so the stat, not Rapier wheelspin, decides who climbs. Optional `VehicleParams.climbPower` (W/kg) additionally caps drive force at `mass·climbPower/speed` on slopes over 14° (full at 20°), which sets the crawl speed up the bonus hill. Both come from the per-stat tables `CLIMB_TRACTION` / `CLIMB_POWER` in `vehicles/params.ts`.
* Surface top-speed caps live in `SURFACE_SPEED_PENALTY` (vehicle.ts), scaled by `1 − offroad`. The top-speed fade is compensated for aero, rolling resistance and damping, so flat-asphalt top speed equals `params.topSpeed`.

## world/

```ts
interface World extends SurfaceQuery, System {
  track: TrackPath;                 // centre-line, arc-length parameterised (s in metres)
  zones: Zone[];                    // {id: 'town'|'farm'|'mud'|'rocky'|'forest'|'canyon'|'snow'|'desert'|'river'|'finish'|'jump'|'test', startS, endS}
  checkpoints: Checkpoint[];        // {index, s, respawn: SpawnPoint}, ~every 300 m
  spawns: { player, cpu };          // side-by-side grid slots
  jump: JumpInfo;                   // the end jump: {lipS, bonusM, bonusS, runoffS, markerStepM, lip, bonusLine}
  surfaceAt(x, z): SurfaceType;     // called per wheel per step: must be cheap (no raycasts)
  heightAt(x, z): number;           // cheap approximate ground height for placing props/particles
  zoneAt(s): Zone;
  resetDynamic(): void;             // restore hay/cones, clear animals (race restart)
}
interface TrackPath {
  length, finishS;                  // length = to the end of the jump run-off
  pointAt(s), tangentAt(s), halfWidthAt(s);
  project(pos, hintS?) → { s, lateral }   // lateral > 0 = right of travel; pass last s as hint
}
createWorld(ctx, level)             // 'race' (default: the real course) | 'test' (M1 test ground; ?level=test)
SURFACES                            // grip/drag/rolling per surface, tune here
PolylineTrack.fromControlPoints(ctrl, halfWidth, finishS)   // reusable TrackPath impl
```

`TestGround` is a 140 × 220 m asphalt loop with speed bumps, a field of moguls, two ramps, a mud patch, a sand patch and 6 hay bales. It implements the full `World` interface, so race/AI/UI can be built against it before the real track exists.

### The real course (`RaceCourse`)

| File | What |
| --- | --- |
| `layout.ts` | **Tune the course here.** Turtle segments (length + turn) → centre-line; zones; road widths; `FINISH_STRAIGHT_M`; the **end-jump values** (`JUMP_RUNUP_M`, `JUMP_RAMP_LEN_M/DEG/HEIGHT_M`, `JUMP_BONUS_M` = the bonus line, `JUMP_TABLE_M`, `JUMP_LAND_DEG`, `JUMP_LANDING_M`, `JUMP_RUNOFF_M`, `JUMP_MARKER_STEP_M`); snowy-pass rise; gorge depth/bridge length |
| `course.ts` | `CourseData`: pure data, no DOM/GL. Elevation profile (snow saddle, landing hill), 2 m terrain height grid, 1 m surface grid, river polyline (riverside run + crossing + ford) rasterised to per-node `(a, b)`, gorge, shortcut, jump geometry, checkpoints, spawns, and every prop/obstacle/animal placement. `CourseTrack` is the `TrackPath` (its heights follow the gorge-bridge deck) |
| `terrain.ts` | Rapier heightfield (same grid and triangle split as the mesh, so `heightAt` is exact) + chunked render mesh. Layer weights in three vec4 attributes (`wA`, `wB`, `wC`, 12 slots, 11 used). `TerrainShading`: `full` (11-layer texture-array splat + macro), `lite` (Low: no macro fetch), `simple` (no textures: per-vertex blend of each layer's average colour). `handles.setShading(mode)` swaps materials without rebuilding geometry |
| `textures.ts` | Procedural textures from typed arrays (terrain layers incl. snow / forest floor / red sandstone, asphalt with lines, water normals, checker, banners, the jump-marker sign atlas `makeSignAtlas`) |
| `props.ts` | Low-poly vertex-coloured templates (trees, pines, snowy pines, cacti, bushes, rocks, tufts, houses, barn, fence, ramps by style, log bridge, fallen logs, gorge bridge, the big curved jump ramp, sign posts) + `ChunkMerger` (one mesh per 120–160 m chunk) |
| `obstacles.ts` | Hay bales and cones (dynamic, sleeping, instanced), fixed boulders and fallen logs; emits `obstacle:hit` (`'hay bale' \| 'cone' \| 'boulder' \| 'log'`) |
| `animals.ts` | 12 kinds (`ANIMAL_SPECS`): crossing schedule (4–6 per race, ≤ 2 damaging, ≥ 300 m apart, no repeated kind), light dynamic bodies, procedural models; emits `animal:crossing` / `animal:bump {damaging, speed}` |
| `raceCourse.ts` | Assembles everything and implements `World` |

All `s` values on the course are **horizontal** metres along the centre-line. `track.pointAt(s).y` is the real ground height. `tangentAt` is horizontal.

**Course zones (5.13 km; finish line at 4.64 km):** town 370 m → farm 410 → mud 240 → rocky hills 460 (2 ramps) → forest trail 590 (fallen logs, ramp) → rocky canyon 580 (close red-rock walls, boulders, ramp, wooden road bridge over a 12 m gorge) → snowy pass 510 (22 m saddle, packed snow = `gravel`, cones) → desert 740 (dunes, 2 dune jumps, cacti) → river 572 (riverside run with the water on the right, then the Ω-loop ford / log-bridge shortcut) → finish straight 170 → jump 496 (230 m asphalt run-up, 16 m curved ramp, 140 m landing hill with distance boards every 10 m and the gold bonus gate, 110 m sand run-off ending in a berm and a hay wall).

**The end jump** (`world.jump: JumpInfo`): the race measures each finisher's one attempt; jump distance = horizontal metres along the centre-line from `lipS` to the touchdown point. The ramp is 8 convex wedge slices (asphalt) approximating a circular arc; the landing hill is part of the road elevation profile (`CourseData.jumpDrop`).

**Optional members on `RaceCourse`** (not on `World`, so they are duck-typed; `TestGround` has none of them):
* `shortcuts: TrackShortcut[]`: `[{ id: 'log-bridge', startS, endS, points, halfWidth, maxSpeed }]` (AIWorldExtras, taken by the Hard computer).
* `animals: AnimalInfo[]`: `{ kind, position, velocity, radius, active, damaging }`. The AI should steer around entries with `active === true`. Animals are also `Group.ANIMAL` colliders, so the existing ray sensor sees them.
* `data: CourseData` (debug/tests), `animalsEnabled` (setter), `plannedAnimals`.

**Terrain fallback** (`RaceCourse`): Low → `lite`, Medium/High → `full`. Falls to `simple` (and remembers it in localStorage `dirtrace.gpu.v1`) when the terrain program fails to compile/link (checked via `renderer.programFailed` after the first frame), on `quality:slow`, or with `?terrain=simple`. Decorative rocks, bushes and tufts are hidden on Low.

Event kinds: obstacles `'hay bale' | 'cone' | 'boulder' | 'log'`; animals `'deer' | 'bear' | 'mouse' | 'duck' | 'croc' | 'moose' | 'boar' | 'bull' | 'cow' | 'goat' | 'rabbit' | 'camel'`. **Damaging** (`animal:bump.damaging === true`): bear, moose, bull, boar, croc. `animal:bump.speed` = relative horizontal impact speed (m/s, car vs the animal's pre-contact velocity).

Collider tags: ramps (incl. the end-jump ramp) `ground/asphalt`, log bridge and gorge bridge decks `ground/dirt`, potholes `static/'bump'` (the AI sensor ignores bumps), fences and gorge-bridge rails `static/'fence'`, houses `static/'wall'`, near-road tree trunks `static/'tree'`, boulders `static/'boulder'`, fallen logs `static/'log'`.

Tests: `npm run world-test` (headless, ~8 min: course/zone/surface/grade/gorge/river/jump-geometry checks, animal schedule, every animal kind bumps with the right `damaging` flag, all six vehicles drive to the finish, **jump outcomes per vehicle** (from a run-up and from a standing start at the finish line), the shortcut, the computer driver on several difficulties incl. its jump). `npx tsx scripts/jump-tune.ts [kinds]` prints lip speed / distance / airtime / landing per vehicle (`START=0` standing start, `NOISE=0.3` wobbly steering). `npx tsx scripts/course-stats.ts` prints build time, grid size, triangles, buffer memory and colliders. `node scripts/world-shots.mjs` (after a build; `PREFIX=r2-` for the round-2 set) writes screenshots of every zone, the jump (ramp, mid-air, landing markers, bonus) and every animal, and prints draw calls per shot.

## race/

```ts
class RaceController implements System, RaceView {
  phase; elapsedS; timeLeftS; countdownLeftS; winner; progress: Record<RacerId, RacerProgress>; config; lastResults;
  setVehicle(racer, v); setDriver(racer, input, control?);     // race owns vehicle.input (driver vs "hold")
  startSpin(); startCountdown(); abort(); startFreeDrive(); setPhase(p);
  requestReset(racer, delay = 2 s); isResetting(racer); respawnFor(racer); canDrive(racer); dispose();
}
RaceConfig { timeLimitS 480, bonusTimeS 45, resetDelayS 2, countdownS 3, resultsDelayS 1.5,
             jumpLandS 1.0, jumpMissM 25, cpuGraceS 12 }
RacerProgress { s, bestS, lateral, checkpoint, finished, finishTimeS, jump: 'none'|'air'|'landing'|'done',
                jumpM, jumpCrashed, jumpBonus, position, stage, bonusLeftS, points }
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
* **Rules:** first across `finishS` wins 1 point. Each finisher gets its own 45 s bonus window for **one end-jump attempt**:
  airborne (no wheel contact, `airTime > 0.12 s`) within `lipS − 4 … lipS + 15` → `race:takeoff`; touchdown = first step
  with ≥ 2 wheels on the ground (records `s`); the landing counts if the car stays upright (`up.y ≥ 0.5`, not flipped)
  for `jumpLandS`; otherwise it's a crash. Distance = touchdown `s − lipS`. Clean and ≥ `world.jump.bonusM` → +1.
  Passing `lipS + jumpMissM` without leaving the ground ends the attempt at 0 m; a Reset mid-jump is a crash. After the
  attempt (`race:jump {distanceM, bonus, crashed}`) the racer is done and the race holds its car (brakes to a stop in the
  run-off). An attempt already in the air when the window runs out still gets to land. When the 8-minute timer runs out,
  anyone still racing is done. If nobody finished, the higher `bestS` wins (a gap under 0.5 m is a tie with no
  points). Once Brooks is done, the computer gets at most `cpuGraceS` more seconds. When every racer is done, the
  results screen follows `resultsDelayS` later. Distances in the results are measured from the grid.
* **Resets:** `requestReset` → `race:resetting` → teleport after the delay to the last checkpoint. After the finish
  the car goes back to the finish line (start of the run-up) instead. Flips auto-reset after 0.5 s. Resets are ignored when the car
  can't drive.
* **Spin integration:** pass `spin: SpinFn` (returns `{player, cpu}` picks) and `showSpin(picks) → Promise` (the reel UI)
  to `RaceFlow`. Until those are merged, main uses `randomSpin` plus the placeholder `ui.spin` card.
* **Events emitted:** `phase:changed`, `race:countdown {n}` (3, 2, 1), `race:go`, `race:checkpoint`,
  `race:finish {winner}`, `race:bonus`, `race:takeoff`, `race:jump {distanceM, bonus, crashed}`, `race:timeout`,
  `race:lead {leader}`, `race:resetting`, `race:done`, `race:results` (`RaceResults` also carries optional `reason`,
  `finishM`, `jumpBonusM`; each `RacerResult` has `bonus` (jump bonus), `jumpM`, `jumpCrashed`).
* `npm run race-test`: headless full races on TestGround (each difficulty, idle player / 8-minute timer, farthest rule,
  tie, reset delay, Hard shortcut, AI cost) plus **scripted end-jump rule checks** with fake cars (bonus, short, crash,
  no take-off, one attempt, window expiry, reset mid-air). It's part of `npm test`. `WORLD=race` runs it on the real course.

## ai/

`new AIDriver(vehicleState, world, difficulty, seed?)` writes `input` in **fixedUpdate** (register it before vehicles;
`RaceFlow.aiSystem` does this). Optional members: `sensor: ObstacleSensor` (`createPhysicsSensor(physics, 'cpu')`,
Rapier rays vs STATIC|DEBRIS|ANIMAL|VEHICLE), `rival: { gapM() }` (Easy eases off when ahead), `onRequestReset`.
`DIFFICULTY` holds the per-level profile (topFrac 0.8/0.92/1, mistake frequency, line cut, shortcuts).

* At construction it precomputes, for its own car: a racing line (lateral offset toward the inside of curves, smoothed)
  and a speed profile (curvature × surface grip, slowed for steep descents and crests, then a backward braking pass).
  Per step it does a pure-pursuit steer to a look-ahead of 5 + 0.55·v m and runs a throttle/brake P-controller. On
  slopes steeper than 0.2 it holds full throttle. **After `track.finishS`** (the end-jump run-up) every difficulty
  drives flat out at its car's full top speed: no mistakes, no easing off.
* Obstacles: 5 rays at 12 Hz. Hits are stored in track space (s, lateral) for 1.5 s, and a tiny lane planner picks
  the clear lateral offset closest to the line.
* Stuck: reverses out when it's slow with throttle down, or does a three-point turn when facing backwards. With no
  progress for 9 s (or after 3 recoveries) it calls `onRequestReset` (the same 2 s Reset as Brooks).
* Mistakes (seeded): wobble, throttle lift, running wide, braking late. Easy every 5–10 s, Normal every 14–26 s, Hard never.
* **World extras (optional, duck-typed):** `world.shortcuts?: TrackShortcut[]` (`{id, startS, endS, points, halfWidth?, maxSpeed?}`).
  Hard follows a shortcut's points when it reaches `startS`. **World engineer:** expose the log bridge this way.
* Cost: about 10 µs per step in Node, including rays.

## ui/

`new UI(root, handlers: UIHandlers)` provides the title (SVG logo, loading bar via `ui.setLoading(f, label)`, Start, How to play, first-launch Rotation Lock / Add to Home Screen tip), calibrate ("hold it like a wheel"; Ready waits for `handlers.courseReady`), the How to play card (`help`), and pause/settings screens (sensitivity, tilt direction, steering, computer, graphics Low/Med/High/Auto, units, volumes) plus `toast()`. Screens are plain HTML via the `Screen` helper. Buttons use `onTap` (a click on an element with `touch-action: manipulation`, which counts as a user activation on iOS). The UI reads `RaceView`, `VehicleState` and the event bus. It never touches physics. The HUD speedometer lives in `input/touch.ts` between the pedals (`touch.setSpeed(kmh, settings.speedUnit)`).

Race UI (`ui/raceHud.ts`):
* `RaceHud` (a System): position badge, race clock (8:00, red under 30 s), progress strip (start, finish flag, a little
  ramp wedge at the jump lip, a ⭐ at the bonus line, both cars in their paint colours; `setTrack({length, finishS, jumpS,
  bonusS})`), bonus-jump banner with its own countdown, the big 3-2-1-GO (driven by `race.countdownLeftS`, so it stays in
  sync with sim time), "Resetting…", and short messages (lead change, win, jump distance / bonus / crash, time's up).
* `ResultsScreen` (`ui.results`): winner, how it was decided, a card per racer (vehicle, distance bar, finish time or
  distance reached, **jump distance** and whether it earned the bonus, points), session score, plus RACE AGAIN / Menu.
  CSS confetti + bouncing trophy when Brooks wins (gold stars for a jump bonus).
* Pause screen adds **Computer: Easy / Normal / Hard** (takes effect from the next race) and **Speed in: mph / km/h**
  (`settings.speedUnit`, default mph; results distances are shown in feet or metres to match).

**Vehicle spin** (`ui/spin/`, SPEC flow step 3):

```ts
runVehicleSpin(uiRoot, { rand?, force?: {player?, cpu?}, playerName?, cpuName?, speed?, onTick? })
  → Promise<{ player: {spec, paint}, cpu: {spec, paint} }>   // resolves when GO is tapped
```

It adds a full-screen overlay (`[data-screen="spin"]`) with two slot-machine reels of rendered model cards. Brooks's reel lands first, then the Computer's. Stat bars (Top speed, Acceleration, Grip, Off-road, Hill climb) fill as each reel lands. GO (`[data-tap="spin-go"]`) appears after both reels stop, and the overlay removes itself on tap. Bus events: `spin:tick {racer}` (each card passing, for reel clatter), `spin:land {racer, kind}` (both consumed by audio), and `spin:done {player, cpu}`. **Wired into the race flow** in `main.ts`: `RaceFlowDeps.spin = pickVehicles` (random picks), and `showSpin = (picks) => showVehicleSpin(uiRoot, picks)` plays the reels landing on exactly those picks and resolves on GO. CSS classes are prefixed `vspin-`. Dev page: `src/ui/spin/dev.html?seed=7&speed=1`. `node scripts/spin-shot.mjs` checks the spin screen and writes `screenshots/spin.png`.


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

**Events consumed:** `phase:changed` (music: title/calibrate/spin → menu, countdown → silence, racing/bonus/freeDrive → race, results → menu after 2.8 s), `app:paused`, `settings:changed`, `race:countdown` (voice clip or beep), `race:go` (horn, plus the voice clip if present), `race:checkpoint` (player chime), `race:finish` (cheer + win jingle, or "good try" jingle), `race:jump` with `bonus` (fanfare), `race:timeout` (buzzer), `vehicle:landed` (thump scaled by impact), `vehicle:collision` (crash / car bump / boing), `vehicle:surface` (splash / squelch / crunch on entering), `vehicle:flipped`, `vehicle:reset`, `obstacle:hit` (hay / cone / crash by `kind`), `animal:crossing`, and optional events (below). Per-frame state comes from `VehicleState`: `rpm`, `input.throttle`, `speed`, `surface`, `wheels[].slip/contact/surface`, `wheelsOnGround`, `airTime`, `position`, `forward`.

**Optional events added for audio** (emit them when ready; nothing breaks if they never fire): `spin:tick {racer}` (one per reel item, throttled to 35 ms), `spin:land {racer, kind}`, `race:lead {leader}` (lead changes only), `animal:bump {kind, racer, x, z}`. Animal kinds are matched by substring (duck, mouse, deer, bear, croc), and anything else gets a boing. Obstacle kinds: hay/bale, cone, fence/crate/barrel → bump, anything else → crash.

Tests: `npm run audio-test` (in `npm test`) renders every generator in Node and checks for NaN, clipping, silence, loop seams and render time. `npm run audio-render` renders through a real `OfflineAudioContext` in headless Chrome and writes `screenshots/audio/*.wav` + waveform PNGs, checking levels and dropouts.

## fx/

* `ChaseCamera`: `target`, `toggleMode()` (close/far, persisted), `shake(amount)`, `snap()`, `override` (main uses it for the slow title-screen orbit around the parked cars). Shake fires automatically on hard landings.
* `Effects` (`fx/index.ts`): `track(v)` / `untrack(v)`, `setWorld(world)`, `clear()`, `dispose()`. At most **3 draw calls**, each hidden when empty:
  * `particles.ts` `ParticleSystem`: one `THREE.Points` pool (700, live cap = 700 × `detail`) with a metre-sized round sprite shader, fog-aware, on-screen size capped. Dust on dirt/gravel/sand (rear wheels, fronts when sliding), mud spray, water splashes, exhaust, tyre smoke, landing puffs, jump-bonus sparkles.
  * `debris.ts` `DebrisSystem`: one `InstancedMesh` pool (260) of tumbling flat pieces that settle on `heightAt`: hay strands (`obstacle:hit`), finish confetti cannons on both gantry posts (`race:finish`), golden flakes from the bonus gate's banner + a fountain around the car (`race:jump` with `bonus`).
  * `skidMarks.ts` `SkidMarks`: one ring-buffer mesh (600 quads) on asphalt when `wheel.slip > 0.4`, fading in quarters.
  * Blob shadows (one small quad per car) only when real shadows are off (Low).
  * Events: `vehicle:landed`, `obstacle:hit`, `animal:bump`, `race:finish`, `race:jump`, `quality:changed`; cleared on `phase:changed` → spin/title. `FxWorld` needs `jump.bonusLine`.

## Debug hooks

`window.__dirt` exposes `{loop, player, cpu, ai, flow, hud, input, race, quality, renderer, ui, world, camera, audio, events, fx, physics}` (`player`/`cpu` are getters: cars are rebuilt every spin) for console poking and the smoke test. The pause screen shows quality, frame time, tilt status, pixel ratio, draw calls, triangles, terrain shading, GPU texture/geometry counts and version.

### Boot sequence (`main.ts`)
1. Renderer, input, camera, audio, UI → the title screen (logo + loading bar) is up and **Start already works**: it calls `audio.unlock()` and `tilt.requestPermission()` synchronously in the tap, before anything is awaited.
2. Rapier WASM, then `createWorldAsync` (course data, yield, meshes/colliders) with the bar moving. Ready on the calibrate screen stays disabled ("LOADING…") until the course exists.
3. Race, HUD, flow; two cars parked on the grid; the camera orbits them behind the title; `body.ready`.

World, race, AI, vehicles and HUD are registered in the loop as *slots* (in the documented order) that are filled in step 3.

## Scripts

| Command | What |
| --- | --- |
| `npm run dev` | Vite dev server on LAN (`--host`). iOS tilt needs **HTTPS**, so test tilt on the deployed build or behind an HTTPS tunnel. |
| `npm run build` | icons → typecheck → `dist/` (relative base, service worker, manifest) |
| `npm run typecheck` | strict TS for app and node scripts |
| `npm test` | tilt maths, headless physics, race/AI and audio generator tests (no browser) |
| `npm run race-test` | full headless races on TestGround (rules, scoring, difficulties) |
| `npm run smoke` | serves `dist/` under `/dirt-race/`, plays spin → countdown → race → results → Race Again ×5 in headless Chrome. Checks: GPU memory/bodies flat across races, effects, settings, quality auto-drop + persistence, Low → simple terrain, Start-during-loading requests tilt permission inside the gesture (4× CPU throttle, fake iOS API), `?terrain=simple` renders, SW/offline/rotate overlay. Writes `screenshots/` (`QUALITY=medium npm run smoke` for shadows) |
| `node scripts/world-shots.mjs` | after a build: every zone, the gorge/log bridges, the end jump (ramp, mid-air, landed, landing markers, bonus), every animal and `fx-splash/hay/confetti`, with draw calls/triangles per shot (`QUALITY=low|medium|high`, `PREFIX=r2-`, `ZONES=a,b`, `FX=1`, `JUMP=0`, `ANIMALS=0`, `ANIMAL_KINDS=a,b`) |
| `npx tsx scripts/jump-tune.ts` | end-jump outcome per vehicle (lip speed, distance, airtime, landing) |
| `npx tsx scripts/course-stats.ts` | course build time, grid size, triangles, buffer memory, colliders |
| `npm run audio-render` | renders sounds via OfflineAudioContext in headless Chrome → `screenshots/audio/` |
