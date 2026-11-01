# Decisions log

Decisions made without the family (they're on a flight). Each one is easy to revisit.

## Milestone 1 (core driving + skeleton), 2026-11-01

### Stack
- **Vite 8 + TypeScript (strict) + three 0.187 + @dimforge/rapier3d-compat 0.21.** The `-compat` build inlines Rapier's WASM as base64 inside JS. That's about 1.7 MB gzipped, but there's no separate `.wasm` fetch or MIME problems on GitHub Pages, and the service worker precaches it like any other JS.
- **Vendor chunks split** (`rapier`, `three`, app), so a game-code update re-downloads only ~20 KB gzipped.
- **vite-plugin-pwa (generateSW)** precaches every emitted asset. `registerType: 'prompt'`: a new version is applied only from the title/menu, never mid-race.
- Rapier's TS docs say `setIndexForwardAxis` is a setter property (`controller.setIndexForwardAxis = 2`). That's a quirk of the binding, not a typo.

### Driving physics
- Fixed **60 Hz** physics, max 4 steps per frame, with render interpolation (`InterpolatedPose`). 6 solver iterations.
- Chassis axes: +Z forward, +Y up, +X left. Wheel order FL, FR, RL, RR.
- **Anti-flip:** lowered centre of mass, explicit inertia from the full body box with 1.6× roll inertia, a roll PD assist (sedan strongest per SPEC "never flips"), and air levelling. Hard crashes can still tip a car, and auto-reset covers that.
- **Brake = reverse** below 0.6 m/s forward speed, held until throttle is pressed. When coasting the car slows at 1.6 m/s² so it doesn't roll forever. When stopped with no pedals it holds still (no creeping on slopes).
- Rapier's ray-cast vehicle has no rolling resistance or drag, so we add surface drag, rolling resistance and light aero ourselves (tables in `world/surfaces.ts`).
- **Stats → physics** all live in `vehicles/params.ts`. Current top speeds are roughly 86 km/h (sedan) to 137 km/h (sports car) on asphalt. Steering is speed-sensitive (0.6 rad at a standstill, about 0.11–0.16 rad at top speed), and the full-lock radius at top speed is about 21–74 m. These are tuning starting points for the playtest.
- CCD is enabled on chassis bodies (no tunnelling through thin ramps or logs at speed).

### Input
- Tilt angle = **angle of gravity within the screen plane**, `atan2(screenRight, screenDown)`. It works whether the iPad is held upright like a wheel or tipped back on a lap, and in both landscape orientations (uses `window.orientation` on iOS, `screen.orientation.angle` elsewhere). Near-flat it blends to `asin`. Compass (alpha) is never used.
- Sensitivity sets the full-lock angle: Low 38°, Medium 30°, High 22°. Dead zone 3°. The response is slightly curved for finer control near centre.
- `settings.tiltInvert` was added as a safety valve in case a device reports the opposite sign. It's not in the UI yet.
- If tilt is denied or unavailable, the ◀ ▶ steer buttons appear automatically. They can also be forced in Pause → Steering.
- Desktop detection: if `deviceorientation` data doesn't arrive within 1.2 s after permission, tilt is marked `unavailable`.
- iOS `DeviceOrientationEvent.requestPermission()` only works on **HTTPS** and inside a user gesture. The dev server over a LAN IP is plain HTTP, so tilt can't be tested that way. Test tilt on GitHub Pages or behind an HTTPS tunnel.
- Pedals use Pointer Events with per-pointer tracking (multi-touch). Sliding a finger off a pedal releases it.

### Camera
- Close: 7 m behind, 2.6 m up. Far: 11.5 m, 4.4 m. FOV goes 60° → 76° with speed (close). Yaw trails with a 0.28 s time constant. The choice is persisted in settings.

### Quality
- Presets (Low / Medium / High): pixel-ratio cap 1 / 1.25 / 1.75, shadows off / 1024 / 2048, view distance 260 / 420 / 650 m, antialias off / off / on.
- **Antialias is off on Medium** to save fill rate on A10X/A12. MSAA can only be chosen when the WebGL context is created, so switching to High takes effect on the next launch.
- Auto-downgrade: after 4 s of warm-up, three consecutive 1 s windows averaging over 22 ms per frame drop one level. Quality is never raised automatically (avoids flip-flopping), and changing it manually turns auto off. Monitoring only runs during gameplay.
- The shadow camera follows the player (35 m box on Medium) so a small shadow map covers what matters.

### App shell
- Portrait overlay ("Turn your iPad sideways") only shows on coarse-pointer (touch) devices, so desktop testing in a tall window still works. Rotating to portrait mid-drive pauses the game.
- Going to the background or switching tabs pauses the game and suspends audio. Wake Lock is held only while driving.
- The service worker is not registered in dev mode (avoids stale-cache confusion).
- Icons come from an inline SVG (`scripts/gen-icons.mjs` + sharp). Generic truck art, no brands.

### Not done in M1 (owned by other agents per ARCHITECTURE.md)
- Real track, terrain, obstacles, animals, hill (world). Race rules, spin, countdown, results (race/ui). AI. Audio. Particles and skid marks (fx). Per-kind vehicle models.

## Race, AI and race HUD (race agent), 2026-11-01

### Rules and flow
- **The race owns `vehicle.input`.** It switches between the driver's input and a "hold" input (brake to a stop, then release). I didn't use `vehicle.setFrozen()`, because its brake=1 makes a stopped car reverse (it rolled 14 m backwards in 4 s on the grid). Pressing gas during 3-2-1 does nothing; the test checks the cars move 0.00 m.
- **Every finisher gets its own 45 s bonus-hill window**, so the loser can still earn the summit point (SPEC). The finish point goes to the first car across. The summit counts within 7 m of the flag or at the end of the centre-line.
- **Brooks isn't kept waiting.** Once his race is over (summit, bonus window used, or timer), the computer gets at most 12 s more (`cpuGraceS`). After that the results show 1.5 s after the last car is done.
- **Timer rule:** cars still racing at 4:00 stop. If nobody finished, the higher *farthest-reached* distance wins 1 point. A gap under 0.5 m is a tie and nobody scores. If one car finished, it already won; the other car's distance is shown but doesn't matter.
- **Results distances** are measured from the grid. A finisher shows at least the finish distance.
- **Reset on the bonus hill** returns the car to the finish line (bottom of the hill), not to a checkpoint back down the track.
- **Race Again** spins new random cars for both (SPEC). The placeholder spin card has a "LET'S RACE!" button so Brooks controls when the countdown starts. The real reel replaces it.
- **Lead-change events** use a 2 m hysteresis so two cars side by side don't spam `race:lead`. No lead event fires at GO.
- **Pause** is allowed during countdown/racing/bonus only, not on spin or results.

### Computer driver
- **No speed cheating.** It uses the same vehicle and physics, and the speed caps are fractions of *its own* car's top speed (80 / 92 / 100 %). Easy also eases off up to 40 % when more than 35 m ahead of Brooks. No rubber-band *boost* when behind.
- The **speed profile is precomputed per car** from curvature, surface grip (with the car's off-road stat), steep descents and crests, plus a backward braking pass. Per step it only does a pure-pursuit steer, a P-controller on speed, and 5 rays at 12 Hz. That costs about 10 µs per step in Node.
- **On slopes steeper than ~11° it holds full throttle**, so it actually tries the bonus hill. This is unverified on a real 35° hill: TestGround is flat. Revisit once the real hill is in.
- **Mistakes:** wobble, throttle lift, running wide, braking late. Easy every 5–10 s, Normal every 14–26 s, Hard never.
- **Shortcut contract:** Hard takes any `world.shortcuts[]` it reaches (optional and duck-typed, so the World interface is unchanged). The world engineer should publish the log bridge as `{id:'log-bridge', startS, endS, points}`.
- **Stuck handling:** reverse out (with mirrored steer). After 9 s with no progress or 3 failed recoveries it asks for a Reset and waits out the same 2 s as Brooks.

### HUD / settings
- **mph by default**, with km/h in Pause → "Speed in". The results show distances in feet with mph and metres with km/h. Internally everything stays SI.
- **Difficulty** is in Pause → "Computer". Changing it mid-race applies from the next race (toast says so), so the current opponent doesn't suddenly change.
- The big 3-2-1-GO is driven by race sim time, not CSS timers, so it can't drift on a slow iPad frame.
- Progress-strip markers use the cars' paint colours, with YOU/CPU labels.
- Names on screen are "Brooks" and "Computer" (SPEC).
## Audio, 2026-11-01

- **Everything is synthesized**, with no audio files shipped. Loops and one-shots are rendered into `AudioBuffer`s in plain JS (deterministic, seeded), lazily or in ~6 ms idle chunks starting 250 ms after the Start tap. That's about 1 s of total CPU on a desktop, spread out. Loops render at 24 kHz and one-shots at 32 kHz, and the context resamples. Buffer memory is about 3 MB. Zero bytes of download. Music is sequenced live from short oscillator notes.
- **Engines = one looping buffer per vehicle kind**, pitched by `playbackRate` (rpm) and brightened by one low-pass (rpm + throttle). Cost per car: 1 source + 1 biquad + 1 gain + 1 panner. Main-thread cost of `AudioSystem.update` is about 0.016 ms/frame (measured headless). AudioParam updates are skipped when the change is tiny. The loop length is an integer number of firing periods, so it loops seamlessly (seam check in tests). Characters:
  - muscle **v8**: uneven cross-plane burble, pops on lift-off
  - pickup **truck**: smoother, lower V8
  - **monster**: 30 Hz, sub-heavy
  - **sport**: smooth flat-six with tonal scream, about 5× rev range
  - **buggy**: buzzy twin with a nasal whine
  - grandma **sedan**: weedy 4-cylinder with 9% misfires, a slow pitch wobble, a cough on lift-off and an occasional idle cough (the comedic one)
- **CPU car** uses the same engine voice, attenuated `0.75/(1+d/12)`, panned relative to the player's heading and low-passed with distance. The player's car is the listener (the camera follows it).
- **Tyres:** one surface bed per car (asphalt road roar is quiet; dirt, gravel, mud, sand and water are louder), crossfaded on change and scaled by speed and slip. Squeal comes **only from asphalt slip** (`wheels[].slip` above about 0.35). Off-road slip makes the bed louder instead. Entering water, mud or gravel above 3 m/s also triggers a one-shot splash, squelch or crunch.
- **Landing** thumps scale with `impact` (soft below about 7 m/s, hard with metal clank above). Big air (>0.45 s) gives a soft whoosh.
- **Animals** sound cartoonish and friendly: quack, squeak, bleat (deer), a gentle grunt (bear), a croc "clack-clack + purr", plus a boing on contact. They are never hurt or pained.
- **Volumes:** use `settings.musicVolume` / `sfxVolume` (persisted by `core/settings`, which already wraps localStorage in try/catch). The gain curve is squared for a usable low end. Music sits at 0.55× under effects. Settings get **Off / Low / Med / High** segmented buttons instead of sliders (big kid-sized targets that match the existing UI), mounted into the pause screen via `mountVolumeControls()` with one line in main.ts.
- **Mute:** pausing ramps master to 0 in 40 ms (UI clicks still play). Hiding the app suspends the context (already wired in main). The context resumes on the next touch, keydown, `pageshow` or `focus`, and on `statechange` (covers iOS "interrupted" after calls or Siri). A DynamicsCompressor limiter on the output prevents clipping when many sounds stack. At most 12 one-shots play at once, with per-sound cooldowns.
- **Music:** hand-written (not random) 16-bar A-A-B-C songs, so they're pleasant on repeat. Menu: 104 bpm swing, music-box lead, walking bass, light drums. Race: 146 bpm, square lead, octave bass, full drums. A lead-less arpeggio "break" section gives the ears a rest. No music during the countdown (the beeps need to be heard). Results bring the menu loop back after 2.8 s so the cheer and jingle land first.
- **Countdown voice slot:** the build lists `public/audio/countdown-{3,2,1,go}.{m4a,mp3,wav,ogg}` (in `vite.config.ts` → `__COUNTDOWN_VOICE__`), so the runtime never fetches missing files (no 404s, works offline). The service worker precaches them. Any missing clip falls back to its beep. GO plays the clip plus a quieter horn. `decodeAudioData` uses the callback form for older Safari. **For Brooks:** record each word on the iPad (Voice Memos), trim it so the word starts right away, export or share it as `.m4a`, name the files `countdown-3.m4a`, `countdown-2.m4a`, `countdown-1.m4a` and `countdown-go.m4a`, put them in `public/audio/`, then run `npm run build` and deploy.
- **Optional events added to `GameEvents`** (for the race and world agents to emit): `spin:tick`, `spin:land`, `race:lead`, `animal:bump`. Every handler is wrapped in try/catch and tolerates events that never fire.
- UI clicks use one capture-phase `pointerdown` listener on `button, [data-tap], [data-action]` (pedals excluded), so the UI module needs no changes.
- `screenshots/audio/*.wav` are gitignored (about 4 MB, regenerate with `npm run audio-render`). The waveform PNGs are committed.

## Vehicles M2 (models, tuning, spin), 2026-11-01

### Physics tuning
- **Top speeds now hit their targets.** The engine fade targets a higher internal top speed, solved per vehicle so that engine force equals aero + asphalt rolling + linear damping exactly at `params.topSpeed`. Measured on flat asphalt: sports 151, muscle 133, pickup 115, buggy 115, monster 97, sedan 95 km/h (targets 151/133/115/115/97/97). The original stat→target mapping (`lerp(22, 42, top)` m/s) is unchanged.
- **Surface speed caps for road cars** (`SURFACE_SPEED_PENALTY`, scaled by 1 − off-road): mud 70%, sand 50%, water 40%, gravel 18%, dirt 12% for an off-road-1 car. Results after 12 s of full throttle: sports car 150 km/h on asphalt vs 38 in mud; monster 96 vs 78; buggy 115 vs 105 on sand (fastest on sand). The sedan does 30 in mud, which is fine: it's grandma's.
- **Hill climbing is decided by the hill-climb stat.** New optional `climbTraction` param (0.6 → 1.1 for stat 1 → 5) caps drive force on slopes over 6° (blended in to 12°), and tyre friction on steep slopes is raised above that cap. Without this, Rapier's friction model either let everything climb or collapsed into wheelspin and let nothing climb. On a 36° gravel hill start (4 s): monster 8.8 m, pickup 8.3, muscle 2.5, buggy 1.6, sports slides back 1.5, sedan slides back 2.7. With a run-up on a 20°→28°→36° hill, everyone except the sedan summits on momentum, and the sedan stalls about 30 of 48 m up. **The real bonus hill (world agent) decides how "nearly impossible" feels:** the steeper and longer its top section, the more the stat matters.
- **Buggy is under-damped** (compression 0.3·crit, relaxation 0.4·crit, versus 0.55/0.75 for the rest), so it's visibly bouncy. It's the only vehicle with a second rebound in the drop test.
- Monster truck and pickup crawl over a half-sunk 0.6 m log at half throttle. The sports car, muscle car and sedan can't.

### Models
- **Lofted bodies rather than extrusions.** Plain profile extrusions read as "boxes with a side shape" from the chase camera. Each body is lofted instead: a side profile, a plan-width function, and a 9-point cross-section with sill tuck, shoulder, tumblehome greenhouse, crowned hood and fender bulges over the wheel arches. Glass is assigned per station range on the same mesh (windscreen, side windows, rear window), so windows sit flush and cost no extra geometry.
- **One material per role, vertex colours for detail:** paint (per vehicle, stripes and two-tone roof via vertex colours), glass, trim, chrome, lamp and tail are shared, and the tail colour changes for brake lights. Everything per role is merged, giving 9–10 draw calls per vehicle including wheels and the suspension rig.
- **Paint:** `MeshStandardMaterial` (roughness 0.3, small metalness) with a tiny procedural sky cube env map for reflections. On **High only** it's a `MeshPhysicalMaterial` with clearcoat. Paint colours are unchanged from the catalog.
- **Triangles:** sports 3068, muscle 3316, sedan 3252, buggy 3128, pickup 3576, monster 3574. Wheels are about 1.3–1.6k of that. These are slightly over the ~3k guidance; two cars on screen is about 7k triangles, which is trivial even for the A10X. Lowering the wheel segment count from 12 to 10 would bring every model under 3k if needed.
- **Visible suspension:** wheels move with physics travel. The body also leans and dips (up to about 3.5°) from wheel travel. The monster truck and buggy have animated shocks, A-arms and axles (one InstancedMesh each).
- Monster-truck shocks are orange, and buggy coil-overs use an accent colour. All vehicles are generic: no logos, badges or real-brand grille shapes.

### Spin screen
- A plain HTML/CSS overlay in `src/ui/spin/` with its own CSS file, styled like the title screen (navy glass, orange buttons, rounded type). It does **not** use backdrop-filter, which is expensive over WebGL on old iPads.
- Card art is the real 3D models, rendered once to PNG thumbnails (18 images: 6 kinds × 3 paints) in a throwaway WebGL context. That takes about 100–300 ms on first spin, and the results are cached.
- The reel animates with `transform: translate3d` + rAF and an ease-out with a slight settle. Each card passing emits `spin:tick` for the audio agent's reel clatter.
- The Computer's reel shows a "?" mystery card until it spins. GO only appears once both reels have landed.
- The integration point is `showVehicleSpin(root, picks)`, wired as `RaceFlowDeps.showSpin` in main.ts (race picks, reel reveals, GO resolves). The race keeps ownership of the picks, so headless race tests are unaffected. `runVehicleSpin()` is the standalone version. Events use the audio agent's names (`spin:tick`, `spin:land`), plus `spin:done`.
- The env map is built defensively (null if there's no real 2D canvas), so vehicles build under the race test's DOM shims.

## World M2 (the real course), 2026-11-01

### Layout
- **Point-to-point course, 2.49 km.** The centre-line is built by a "turtle" from (length, turn) segments in `world/layout.ts`, so corners are true circular arcs (radius ≥ 50 m in town, about 45–80 m elsewhere). Zones run town 0–370 m, farm –780, mud –1020, rocky –1480, desert –1910, river –2232, finish straight –2362, bonus hill –2486.
- **Folded shape.** The desert is a long U-turn, so the course is about 460 × 1310 m instead of a 2 km noodle. This keeps the terrain grid small, and the bonus hill is visible from the farm road onward. No two legs come within 160 m of each other, so the valley walls never merge.
- **All `s` values are horizontal metres** (the 37° hill would otherwise distort distances). `track.pointAt(s).y` is the exact ground height; `tangentAt` is horizontal.
- **Finish placement:** `FINISH_BEFORE_HILL_M = 4` in `layout.ts` is the single value. Race's `finishAt: 'hillFoot' | 'summit'` still chooses between that line and the summit.
- Course time: about 115 s for a pickup and 150 s for the sedan, driving the centre-line flat out with no shortcut. That leaves the 4-minute timer generous.

### Terrain & physics
- **One Rapier heightfield** (2 m grid, about 310 × 680 nodes) for everything: road, verges, mud pit, dunes, river channel, bonus hill and valley walls. The render mesh uses the same vertices and the same triangle diagonal near the road, so what you see is what you drive on, and `heightAt` is exact (not approximate).
- **Keeping cars in the world:** about 48 m either side of the centre-line the ground rises into 24 m valley walls (rock textured), so there are no invisible walls. Off-road grass is rough (±0.2 m noise) and counts as **dirt** for grip/drag. Grass is not a `SurfaceType`, and adding one would ripple into vehicles/audio. The roughness and the vehicles' loose-surface speed caps are what slow you down.
- **Fences** on the farm road and town have gaps every ~120 m, so a car outside can get back. Fence colliders are low-friction so they redirect rather than stop. Farm fences sit 4 m outside the road edge: at 2.4 m, the buggy got caught between a pothole and a fence.
- **Potholes** can't be cut into a 2 m grid, so each is a pair of low half-buried capsules (an edge in, an edge out) tagged `static/'bump'`. The wheels drop and bounce, and the AI sensor ignores them.
- Ramps are convex wedges (1.35 m lip, 9 m long) on the two rocky-hills straights. The log bridge is a cuboid deck plus two wedge ramps.
- Tree trunks within 25 m of the road and the house walls have colliders. Everything farther out is scenery only (saves colliders: about 620 total).

### Bonus hill
- *(Superseded by "Bonus hill retune" below: now 38.5° max, and the climb is power-limited.)* Profile: 6° at the foot, rising to 26° over the first 45 m, then 26°→37° held over the last ~25 m, a round-over and a 14 m plateau with the flag. 150 m long horizontally, 79 m high. Loose gravel everywhere on the mound. 
- Tuned against the merged vehicles (`climbTraction`). With a run-up, pickup, monster, buggy, muscle and sports all summit in about 7 s. **The sedan stalls at about 47 m of 79** (about 38 m from a standing start). From a standing start at the finish line, every car except the sedan summits in 9–12 s, well within the 45 s bonus window. "Hard" here means steep, loud and scary rather than a coin-flip for the pickup. If playtesting wants it harder for the pickup too, raise `HILL_MAX_DEG` or `HILL_CLIMB_M` in `layout.ts`. The sports car is then the first to drop out.
- The summit flag, pole and beacon use `fog: false`, so the gold flag reads from the start line even on Low.

### River
- The road makes an Ω-loop out to a 46 m-wide shallow ford (0.85 m deep at the crossing, 1.45 m elsewhere, so cars don't drive up the river). The log bridge cuts straight across the loop: 155 m instead of 270 m.
- Water surface: one transparent Phong plane with a scrolling procedural normal map. Surface `water` comes from the surface grid wherever terrain is under the water line.
- `world.shortcuts = [{ id: 'log-bridge', startS, endS, points, halfWidth: 1.6, maxSpeed: 11 }]`. The Hard computer takes it (verified); Easy/Normal take the ford.

### Animals
- 2–3 crossings per race, picked at random from zone-matched spots (mouse in town, deer/bear on farm and rocky, croc in the mud pit, a duck family of 4 at the river), at least 300 m apart and no repeated kinds.
- They are staged on the verge when the leading car is 140 m away, and dash when it is about 2.4 s away, never closer than 22 m, so they're always avoidable. They're light **dynamic** capsules with rotations locked (mouse 6 kg … bear 160 kg) driven by velocity. A car shoves them aside with a small bump; they emit `animal:bump`, then flee at 1.35× speed and despawn. They're never hurt.
- Wheel rays don't hit `ANIMAL`, so you can't drive up onto one. They are exposed as `world.animals` (`AnimalInfo`) and are ray-sensor visible.
- Models: about 200–700 triangles each, merged per animal, with legs on hip pivots for a diagonal-gait walk/run cycle. Ducks waddle, and the croc's tail swishes. The mouse is cartoon-sized (60 cm) so a kid can actually see it.

### Look & budget
- **Terrain shader:** `MeshLambertMaterial` + `onBeforeCompile`. Eight procedural layers (grass, dirt, gravel, mud, sand, rock, river bed, dry field) live in one `DataArrayTexture` (256² on Low/Medium, 512² on High). Per-vertex weights are blended with noise at the edges, and a low-frequency macro-variation breaks up tiling. The shader skips layers with near-zero weight.
- Town asphalt is its own ribbon mesh with a procedural texture (edge lines, dashed centre line, worn lanes). The other roads are terrain layers.
- **Props:** procedural low-poly, vertex-coloured, merged per 120–160 m chunk (trees, pines, houses, barn+silo, boulders, fences, ramps, bridge in one layer; rocks; bushes; grass tufts). The tuft layer is hidden on Low; detail scales its density.
- **Medium measured (headless Chrome, 1112×834):** 54–118 draw calls including the shadow pass (worst: the mud pit and the animal shot), 50k–175k triangles. Whole scene about 390k triangles, of which about 210k is terrain, culled per 80 m chunk. Terrain far from the road uses half/quarter resolution with skirts.
- **Build time:** about 1.7–2.5 s on a desktop CPU (Node/Chrome). On an A12 expect about 4–6 s at load (behind the title screen). Biggest costs: fbm noise in the height/surface grids and texture generation. **Not measured on a real iPad.**
- Shadows: only the sun casts them, and only on Medium/High (core renderer). Big props cast; rocks, bushes and tufts don't.

### Tests
- `npm run world-test`: course checks, then drives all six vehicles with a centre-line follower (zero stuck resets for all six), hill/sedan checks, standing-start hill climbs, the shortcut, and the real `src/ai` computer on the course (Hard takes the bridge, Easy doesn't, pickup and monster summit, sedan doesn't). It's not part of `npm test`, because it takes about 60 s.
- `WORLD=race npx tsx scripts/race-test.ts` runs the race agent's full race suite on the real course (solo timers scaled ×3). Plain `npm test` still runs it on TestGround for speed.
- `node scripts/world-shots.mjs` (after a build) writes `screenshots/world-*.png` and prints draw calls/triangles per zone.
- `?level=test` in the URL loads the old test ground.

## Milestone 4 (polish), 2026-11-01

### Effects (`src/fx`)
- **Three pooled systems, at most 3 draw calls in total:** one `Points` sprite pool (700) for all soft particles, one `InstancedMesh` (260) for tumbling flat pieces (hay, confetti, golden flakes), and one ring-buffer mesh (600 quads) for skid marks. Each is hidden when empty. Nothing is allocated per frame. The live cap is the pool × `quality.detail` (Low 0.4).
- Particle sprites are sized in metres, with on-screen size capped (60–200 px by quality) and faded near the camera. Large overlapping translucent sprites are the fill-rate killer on A10X, and this keeps them under control.
- Dust comes from the rear wheels (fronts only when sliding), with the rate scaled by speed and slip. Sand is dustier and gravel less so. There's no dust on asphalt (skid marks and tyre smoke instead) or in mud (heavy spray instead).
- **Confetti fires from cannons on both finish-gantry posts.** The finish line is where the camera is when someone crosses it. The **summit** gets golden flakes from the flag top *and* a fountain around the car, because the chase camera looks at the car, not the 14 m pole.
- **Blob shadows on Low:** a soft dark quad under each car, tilted to the terrain, appears only when real shadows are off. Without it, cars on Low looked like they were floating.

### Look
- **Neutral tone mapping** (Khronos PBR Neutral) instead of ACES. ACES greyed out and darkened the car paints, and bright saturated colours read better for a kid. Car paint metalness dropped from 0.18 to 0.08 for the same reason.
- The sky dome now has a sun disc plus a warm haze toward the sun. The fog colour is exactly the sky's horizon colour, so the distant terrain melts into the sky. The hemisphere fill is a touch brighter and warmer.
- Fog starts later (Low 90 m, Medium 170 m, High 250 m). The old 70–120 m start washed out the mid-ground, especially the bonus hill.
- **No `backdrop-filter`** on menus. A full-screen blur over a WebGL canvas that redraws every frame is expensive on old iPads, so menus use a translucent tint instead (the spin screen already did this).

### Old-iPad safety
- **Terrain shading modes:** `full` (Medium/High), `lite` (Low: drops the second "macro" texture fetch per pixel) and `simple` (no textures or sampler arrays; a per-vertex blend of each layer's average colour).
  - The game switches to `simple` when the terrain program fails to compile or link. This is detected through three's shader diagnostics after the first frame (`renderer.programFailed`). It also switches when frames are still slower than 40 ms on Low (`quality:slow`), or with `?terrain=simple`.
  - A shader failure is remembered in localStorage (`dirtrace.gpu.v1`), so the next launch starts safe.
  - Switching only swaps materials (no geometry rebuild) and frees the texture array.
- **WebGL1-only devices:** three.js r187 only supports WebGL2, so there's no WebGL1 render path to fall back to. iPadOS 15+ has WebGL2, including both target iPads. If the context can't be created (after retrying without MSAA and without `high-performance`), the game shows a friendly message asking to update iPadOS instead of a blank screen.
- **Low preset:** pixel ratio 1, no shadows (blob shadows instead), view distance 240 m (was 260), and grass tufts, bushes and small decorative rocks hidden. Texture sizes are already ≤ 512 on Low/Medium (terrain layers 256², asphalt ≤ 512×1024 on High only).
- **Quality auto-drop** verified to trigger and persist (smoke test). It persisted before too, through `quality.set → updateSettings`. A new **Auto** button on the graphics row turns monitoring back on after a manual choice. `applyQuality` no longer marks every material for recompile unless shadows actually flip, so a drop doesn't cause a long hitch.
- **Leak check:** the smoke test runs 5 Race Agains. GPU textures (9), programs (19), physics bodies and scene children stay identical. Geometries wobble ±1 because vehicle kinds differ.

### Loading
- The UI and title screen are created *before* the Rapier WASM and the course. Start is usable while the course builds, and it still calls `requestPermission()` and `audio.unlock()` synchronously in the tap. The calibrate screen's Ready shows "LOADING…" until the course exists.
- The course is built in two halves (`CourseData`, then meshes and colliders) with a paint in between, so the bar moves on the iPad. It can't be finer-grained without making the world code asynchronous. Each half is still one long task, about 1–3 s on an A12 (estimate).
- The title backdrop is a slow camera orbit around the two parked cars on the grid.

### Menus
- The logo is inline SVG (gradient + stroke text, a waving checkered flag, a dust puff), animated in CSS. There's no web font: it uses `ui-rounded` (SF Pro Rounded on iPad).
- The first-launch tip (Rotation Lock, plus Add to Home Screen only when not standalone) shows on touch devices until "Got it". `?tip=1` forces it.
- "How to play" (4 cards) is available from the title and the pause screen.
- **Tilt direction: Normal / Flipped** is on the settings screen (`settings.tiltInvert`).
- The Start button's "ready" pulse is a glow ring on a pseudo-element, not a scale on the button itself, so the tap target doesn't move.
- The results screen has CSS confetti and a bouncing trophy when Brooks wins, gold stars for a summit bonus, and a "So close! Race again?" line otherwise.

### Cleanup
- Removed the placeholder `SpinCard` and its CSS, `buildPlaceholderModel`, and stale TODO/M1 comments. `randomSpin` stays as RaceFlow's default for headless tests.
- Added `.github/workflows/pages.yml`, which tests, builds and deploys to GitHub Pages.

## Bonus hill retune (independent check), 2026-11-01

The check found the hill too easy: 5 of 6 cars summited in 7–12 s of the 45 s window, and the hill-climb stat barely mattered (sports car, stat 2: 11.7 s from a standing start; monster, stat 5: 10.2 s). The cause: the traction cap only limits *force*, so every car built 18–28 m/s on the lower slope and coasted over the short steepest section on momentum.

- **New `climbPower` (W/kg) per vehicle:** on slopes over 14° (fully at 20°) drive force is also capped at `mass·climbPower/speed`. That gives a stat-dependent crawl speed on the steep top (≈ P / 6.5 m/s²), so run-up speed bleeds off on the lower slope and the stat decides how long the climb takes. Jump ramps (~8°) and the rest of the course stay below 14°, so race finish times are unchanged.
- **Per-stat tables in `vehicles/params.ts`** (index = hill-climb stat 1..5) instead of a linear lerp, because the targets are not linear:
  - `CLIMB_TRACTION = [0.62, 0.835, 0.875, 0.96, 1.05]` (was `lerp(0.6, 1.1)`). The 38.5° top needs ≈ 0.80 + rolling resistance ≈ 0.83–0.85, so the sports car sits right at the limit, muscle/buggy have a thin margin, and pickup/monster have plenty.
  - `CLIMB_POWER = [14, 18, 20, 28, 36]` W/kg.
- **`HILL_MAX_DEG` 37 → 38.5** in `world/layout.ts` (profile and `HILL_CLIMB_M = 150` unchanged; the hill is now 81 m high). That's still "~35°" to the eye, steepest near the top. The hill surface stays plain gravel (no new surface type).
- **Measured (`npm run world-test`, centre-line, full throttle; seconds after the finish line):**

  | Vehicle (hill-climb) | After a full race (run-up) | Standing start at the finish line |
  | --- | --- | --- |
  | Monster truck (5) | 17.4 s | 23.3 s |
  | Pickup (4) | 19.5 s | 27.7 s |
  | Dune buggy (3) | 23.0 s | 35.2 s |
  | Muscle car (3) | 26.2 s | 37.3 s |
  | Sports car (2) | 35.7 s (barely; stalls 77 of 81 m from a 0 s run-up in a harness) | 50.2 s (outside the 45 s window) |
  | Grandma's sedan (1) | stalls 34 m up | stalls 34 m up |

  The computer driver (Normal): monster +18.0 s, buggy +24.3 s, pickup +19.5 s (Hard) / +21.4 s (Easy), sports stalls 75 m up then resets, sedan stalls 34 m up. The AI already holds full throttle uphill and reverses/retries, then Resets to the finish line when stalled; no AI change was needed.
- The sports car's result is deliberately on a knife edge (a good run-up and a straight line get it up; a wobble doesn't). A diagonal line lowers the effective slope, so a clever kid can also zig-zag it.
- **world-test now asserts the tuning:** pickup/monster 12–30 s after the race, buggy/muscle 20–45 s and slower than both, sports ≥ 30 s or a stall and slower than buggy/muscle, sedan never; from a standing start monster < pickup < buggy/muscle, sports fails or > 38 s; computer pickup/monster/buggy summit inside 45 s and the computer sports car gets > 40 m up. The synthetic physics-test hill got a short 18° round-over (a sharp 36°→flat lip high-centred the low muscle car at crawl speed, which the real hill's round-over doesn't do) and a 60 s limit.
- If playtesting finds it too hard for the buggy/muscle car, raise `CLIMB_POWER[2]` (speed) or `CLIMB_TRACTION[2]` (whether it makes it); for the sports car, `CLIMB_TRACTION[1]` 0.835 → 0.85 makes it summit from a standing start in about 42 s.
