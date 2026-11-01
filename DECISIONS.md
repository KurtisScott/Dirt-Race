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
