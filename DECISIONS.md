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
