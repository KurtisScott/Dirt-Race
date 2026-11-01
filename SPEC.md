# Dirt Race — Game Spec (build copy)

Source of truth for the build agents. Mirrors the "Brooks Racing Game — Game Spec" doc agreed with the family on 2026-11-01.

## Who and where
- Player: Brooks (a kid), playing on an **iPad Air (3rd gen, A12)**; parent also has an **iPad Pro 10.5" (A10X, 2017)**. Both are older GPUs: performance matters more than eye candy.
- Runs in **iPad Safari**, added to the home screen (standalone PWA, landscape, full-screen). Must **work offline** after first load (service worker caching all assets).
- Hosting later: GitHub Pages (static files only, relative paths, no server). Possibly App Store later — keep the code portable (no Safari-only hacks that would block wrapping in a WebView).

## Locked decisions
| Area | Decision |
| --- | --- |
| Format | 3D web game (Three.js + Rapier physics), TypeScript, Vite |
| Opponent | One human vs one computer driver |
| Steering | Tilt the iPad like a wheel; on-screen gas (bottom right) and brake/reverse (bottom left) pedals |
| Look | Semi-realistic 3D, sunny countryside afternoon, bright and readable |
| Win | First across the finish line wins (1 point). If the 4-minute timer runs out, farthest along the track wins |
| Bonus | Reaching the summit flag of the bonus hill = +1 point (45 s allowed after finishing; loser can earn it too) |

## Game flow
1. Title screen "DIRT RACE". Tap Start — this single tap requests `DeviceOrientationEvent.requestPermission()` (iOS) and unlocks Web Audio.
2. "Hold it like a wheel" — hold iPad, tap Ready; current tilt becomes neutral (calibration).
3. Vehicle spin: slot-machine reel for Brooks's vehicle, then the computer's. Show stat bars.
4. Countdown 3-2-1-Go, both cars side by side.
5. Race over mixed terrain with obstacles; progress strip shows both cars and the hill.
6. Finish line at the **foot** of the bonus hill decides the race (placement may change to the summit — keep it a single config value).
7. Bonus hill climb; summit flag = +1.
8. Results: winner, distance each car reached, bonus points, running session score (Brooks vs Computer). Buttons: Race Again (new spin), Menu.

Rules: Reset button returns car to last checkpoint after a 2 s wait; flipping over auto-resets. Session score accumulates across races (localStorage, wrapped in try/catch).

## Vehicles (stats 1–5, tune in playtesting)
| Vehicle | Top speed | Accel | Grip | Off-road | Hill climb | Personality |
| --- | --- | --- | --- | --- | --- | --- |
| Sports car | 5 | 5 | 4 | 1 | 2 | Flies on pavement, bottoms out in mud |
| Muscle car | 4 | 4 | 2 | 2 | 3 | Fast and loud, slides in corners |
| Pickup truck | 3 | 3 | 3 | 4 | 4 | Steady all-rounder |
| Monster truck | 2 | 2 | 3 | 5 | 5 | Rolls over anything, slow on straights |
| Dune buggy | 3 | 4 | 3 | 5 | 3 | Light, bouncy, great on sand and jumps |
| Grandma's sedan | 2 | 1 | 4 | 2 | 1 | Slow and steady, never flips; hill nearly impossible |

Stats map to real physics (engine force, top speed, tire friction, suspension height/stiffness, ride height, mass). Each vehicle has 3 random paint colors. Generic vehicles only — no real brands or logos.

## Track (~2.5 km point-to-point, 2–3 min race)
1. Town start — asphalt straight, wide corners
2. Farm road — dirt, hay bales, cones, potholes
3. Mud pit — deep mud, slows low cars a lot
4. Rocky hills — gravel, boulders, two jump ramps
5. Desert run — soft sand dunes
6. River crossing — shallow water, plus a log-bridge shortcut
7. Finish line at the foot of the bonus hill
8. Bonus hill — ~35° loose gravel climb, steepest near the top, summit flag; visible from far away

Surfaces: asphalt (high grip, no drag), dirt (medium, slight drag), gravel (medium-low, slight), mud (low, heavy drag), sand (low, medium drag), shallow water (medium, medium drag).

Obstacles: hay bales and cones scatter when hit; boulders and logs are fixed; potholes bounce; jump ramps. Checkpoints about every 300 m.

**Animals** (requested by Brooks): occasionally run across the road, matched to zone — deer and a bear on the farm road / rocky hills, a mouse in town, ducks at the river, a crocodile in the mud pit. Rare (2–3 per race), easy to steer around, they bump the car rather than stop it. Never hurt or killed: on contact they scamper off. Keep them light on polygons.

## Computer opponent
Same physics and random spin as Brooks (no speed cheating). Follows a racing line (spline), brakes before corners, steers around obstacles ahead, makes human-like mistakes, uses Reset when stuck, attempts the hill.
| Difficulty | Behavior |
| --- | --- |
| Easy (default) | 80% of its car's top speed, frequent mistakes, eases off when far ahead |
| Normal | 92%, occasional mistakes |
| Hard | Full speed, clean lines, takes the log-bridge shortcut |

## Controls
- Tilt steering from `deviceorientation`, landscape-aware (handle both landscape orientations). Dead zone 3°, full lock ~30°, smoothed. Sensitivity setting Low/Med/High. Recalibrate in settings.
- Permission denied/unavailable → explain how to allow it and fall back to on-screen left/right steering buttons.
- Landscape only; show "rotate your iPad" overlay in portrait. First-launch tip: turn on Rotation Lock.
- Large pedals, multi-touch (gas + steer buttons simultaneously). Reset (top left), Pause (top right), camera toggle.
- Desktop/dev: keyboard (arrows/WASD, space brake, R reset) so the game is testable without an iPad.
- Screen Wake Lock during races (feature-detect).

## Look, camera, feel
- Semi-realistic: PBR materials, sky with sun lighting, procedural textures where needed, sun shadows on Medium/High.
- Chase camera behind/above, trailing in turns, FOV widens with speed, brief shake on hard landings; close/far toggle.
- Effects: dust/mud/water particles, skid marks on asphalt, visible suspension travel, scattering hay, confetti at finish, golden summit flag.
- HUD: position + timer top, progress strip with both cars and hill, speedometer between pedals.
- Graphics setting Low/Medium/High (shadows, view distance, texture size, pixel ratio). Auto-drop a level if frame rate sags. Target 60 fps, never below 30. Start Medium, auto-adjust (the Pro 10.5 will likely land on Low).

## Sound
Web Audio. Per-vehicle engine sound pitched by RPM (rumbling truck, whiny buggy, sputtering sedan), tire squeal, gravel crunch, mud squelch, splash, landing thumps, crash sounds, countdown beeps, Go horn, finish cheer, summit fanfare, reel clatter, upbeat menu loop and faster race loop. Separate music/effects volume. Later: Brooks will record his own countdown voice — make the countdown voice a swappable audio slot.

## Build constraints
- The build machine's network allows only npm and GitHub. Asset sites (Poly Haven etc.) are NOT reachable: generate geometry, textures and sounds procedurally, or use assets from npm packages / GitHub repos with permissive licenses (log every license in ASSETS.md).
- Static output only (`vite build` → `dist/`), relative base path so it works under a GitHub Pages subpath.
- Total download size small enough for a phone connection (aim < 15 MB).
