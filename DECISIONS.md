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
- The `runVehicleSpin()` function (promise) is the integration point. Events are for audio and fx. `main.ts` is **not** wired to it: that's the race agent's flow (title → calibrate → spin → countdown).
