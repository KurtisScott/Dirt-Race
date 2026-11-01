# Dirt Race

A tilt-to-steer 3D racing game for iPad, made for Brooks. Two players (Brooks and the computer) each get a random vehicle from a slot-machine spin. Then they race across town, farm, mud, rocks, desert and a river to the finish line. A steep bonus hill with a golden flag gives an extra point.

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
npm run world-test   # drives the real course with all six vehicles + the computer (~1–2 min)
WORLD=race npm run race-test   # full race rules on the real course
```

`npm run smoke` needs Chrome (`/usr/bin/google-chrome`, or set `CHROME=/path/to/chrome`). It serves `dist/` under `/dirt-race/` like GitHub Pages does and covers the following:
- Start while loading, which must ask for tilt permission inside the tap.
- Spin → countdown → race → results, then Race Again ×5 with checks that GPU memory and physics bodies stay flat.
- Effects, pause and settings.
- The quality auto-drop.
- The `?terrain=simple` fallback.
- Offline reload from the service worker and the portrait overlay.

Screenshots go to `screenshots/`.

`node scripts/world-shots.mjs` (after a build; `QUALITY=low|medium|high`) takes a screenshot of every course zone plus the effects (splash, hay, confetti, summit) and prints draw calls and triangles.

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

The game starts on **Medium** with **Auto** on. If the frame rate sags during a race, it drops a level (Medium → Low) and remembers that for next time. If it is still slow on Low, the terrain switches to a texture-free shader. On a GPU where the terrain shader fails to compile, the same fallback is used automatically and remembered, so the world is never black or pink. Parents can pick Low / Medium / High / Auto on the pause screen.

| | Low | Medium | High |
| --- | --- | --- | --- |
| Pixel ratio cap | 1 | 1.25 | 1.75 |
| Shadows | blob shadows only | 1024² sun shadow | 2048² sun shadow |
| View distance | 240 m | 420 m | 650 m |
| Decoration | no grass tufts, bushes or small rocks | most | all |
| Terrain | lite splat (1 fetch fewer) | full splat | full splat (512² layers) |
| MSAA | off | off | on (after a restart) |

## Project layout

```
src/core     renderer, loop, physics, quality, settings, events
src/input    tilt, touch pedals, keyboard
src/vehicles six procedural vehicles + ray-cast physics
src/world    the course: terrain, props, obstacles, animals, river, hill
src/race     race rules + flow (spin → countdown → race → results)
src/ai       the computer driver
src/ui       title, how to play, settings, HUD, results, vehicle spin
src/audio    procedural engines, effects, music, countdown voice slot
src/fx       chase camera, particles, skid marks, confetti
scripts/     tests, smoke test, screenshot scripts, icon generator
```
