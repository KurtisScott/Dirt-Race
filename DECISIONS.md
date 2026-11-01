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
