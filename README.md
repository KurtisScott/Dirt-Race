# Dirt Race

A tilt-to-steer 3D racing game for iPad, made for Brooks. Two players (Brooks and the computer) each get a random vehicle from a slot-machine spin. Then they race about 5 km across town, farm, mud, rocky hills, a forest trail, a canyon, a snowy pass, desert and a river to the finish line. After the finish a big jump ramp gives an extra point to anyone who lands past the golden bonus line.

Three.js + Rapier physics + TypeScript, built with Vite. Everything (models, textures, sounds, music) is generated in code, so there's nothing to download except the game itself. It works offline after the first visit.

- **What to build:** [SPEC.md](SPEC.md). **How the code fits together:** [ARCHITECTURE.md](ARCHITECTURE.md). **Why it is the way it is:** [DECISIONS.md](DECISIONS.md). **Licences:** [ASSETS.md](ASSETS.md).

## Run it

Needs Node 20+ (22 recommended).

```bash
npm install
npm run dev          # http://localhost:5173 (also on your LAN IP)
```

On a computer: arrow keys / WASD to drive, Space to brake/reverse, R to reset, P to pause, C for the camera.

**Tilt steering on an iPad needs HTTPS.** iOS only allows motion sensors on secure pages. The dev server on a LAN IP is plain HTTP, so on the iPad you'll get the on-screen ◀ ▶ buttons instead. To test tilt, use the deployed GitHub Pages site (below) or put an HTTPS tunnel in front of `npm run dev`.

Handy URL options: `?level=test` (small test ground), `?terrain=simple` (force the texture-free fallback terrain), `?tip=1` (show the first-launch tip again).

## Test

```bash
npm run typecheck    # strict TypeScript (app + scripts)
npm test             # tilt maths, headless physics, race/AI rules, audio generators (~1 min, no browser)
npm run build        # icons → typecheck → dist/
npm run smoke        # plays the BUILT game in headless Chrome (see below)
npm run world-test   # drives the real course with all 16 vehicles + the computer, jump + damage checks (~6 min)
WORLD=race npm run race-test   # full race rules on the real course
```

`npm run smoke` needs Chrome (`/usr/bin/google-chrome`, or set `CHROME=/path/to/chrome`). It serves `dist/` under `/dirt-race/` like GitHub Pages does and covers the following:
- Start while loading, which must ask for tilt permission inside the tap.
- Spin → countdown → race → results, then Race Again ×5 with checks that GPU memory and physics bodies stay flat.
- Effects, pause and settings.
- The quality auto-drop (opt-in Auto), the one-time "game running slow" prompt, and the Round 2 settings migration to Ultra.
- The `?terrain=simple` fallback.
- Offline reload from the service worker and the portrait overlay.

Screenshots go to `screenshots/`.

`node scripts/world-shots.mjs` (after a build; `QUALITY=low|medium|high|ultra`) takes a screenshot of every course zone plus the effects (splash, hay, confetti, the end jump) and prints draw calls and triangles.

## Deploy to GitHub Pages

The build uses relative paths, so it works at any address such as `https://<you>.github.io/dirt-race/`.

**Automatic (recommended).** `.github/workflows/pages.yml` runs the tests, builds and publishes on every push to `master`/`main`.
1. Create a GitHub repo and push this project to it.
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push. After a minute or two the site appears at the URL shown on the Actions run.

**Manual.** `npm run build` and upload the contents of `dist/` to any static host (for example, a `gh-pages` branch).

**On the iPad:** open the address in Safari, tap **Share → Add to Home Screen**, then start it from the home-screen icon (full screen, landscape, works offline). Turn on **Rotation Lock** so the screen doesn't flip while steering. After an update is pushed, the new version is applied the next time the game is on its title screen, never in the middle of a race.

## Add Brooks's countdown voice

The countdown beeps can be replaced by Brooks saying "3, 2, 1, GO!":

1. Record four short clips, trimmed so the word starts right away (under 1 second each, mono is fine). An iPhone's Voice Memos → Share → Save to Files gives `.m4a`, which is ideal.
2. Name them exactly `countdown-3.m4a`, `countdown-2.m4a`, `countdown-1.m4a`, `countdown-go.m4a` (`.mp3`, `.wav`, `.ogg` and `.aac` also work).
3. Put them in `public/audio/` (create the folder).
4. `npm run build` (or push, if you use the GitHub Pages workflow). The build lists whichever clips exist. Any missing one keeps its beep, and the clips are cached for offline play. The GO clip plays together with the horn.

## Graphics and old iPads

The game starts on **Ultra** (the family chose maximum realism, accepting a lower frame rate on the old iPads). Automatic dropping is **off**: if a race stays under ~20 fps for ~10 s, a small card asks once "Game running slow — lower the graphics?" (Lower / Keep) and remembers the answer. Parents can pick Low / Med / High / Ultra / Auto on the pause screen at any time; Auto brings back the old behaviour (drops a level when slow; on Low, a texture-free terrain). On a GPU where a terrain shader fails to compile, a simpler one is used automatically, so the world is never black or pink.

| | Low | Medium | High | Ultra |
| --- | --- | --- | --- | --- |
| Look | original low-poly | original low-poly | realistic (PBR + sky lighting) | realistic, everything on |
| Pixel ratio cap | 1 | 1.25 | 1.5 | 1.5 |
| Shadows | blob shadows only | 1024² sun shadow | 2048² soft, fitted ahead of the car | 3072² soft, fitted |
| View distance | 240 m | 420 m | 700 m | 900 m |
| Terrain | lite splat | full splat | photographic textures 512 px | photographic textures 1024 px |
| Trees / grass | low-poly | low-poly | leafy trees with wind | + grass blades around the car |
| Post-processing | none | none | bloom, grade, SMAA | + ambient occlusion, speed blur |
| GPU memory (measured) | ~40 MB | ~70 MB | ~350 MB | ~470 MB |

## Project layout

```
src/core     renderer, loop, physics, quality, settings, events
src/input    tilt, touch pedals, keyboard
src/vehicles 16 procedural vehicles + damage, + ray-cast physics
src/world    the course: terrain, props, obstacles, animals, river, end jump
src/race     race rules + flow (spin → countdown → race → results)
src/ai       the computer driver
src/ui       title, how to play, settings, HUD, results, vehicle spin
src/audio    procedural engines, effects, music, countdown voice slot
src/fx       chase camera, particles, skid marks, confetti
scripts/     tests, smoke test, screenshot scripts, icon generator
```
