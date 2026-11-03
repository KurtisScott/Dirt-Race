// Headless smoke test of the BUILT game: serves dist/, loads it in Chrome, drives with the keyboard,
// checks the car moves, collects console errors, saves screenshots/m1.png.
// Usage: npm run build && npm run smoke   (CHROME=/path/to/chrome to override)
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const shots = fileURLToPath(new URL('../screenshots/', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const PORT = Number(process.env.PORT ?? 4173);
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // Serve under a subpath to prove the relative base works (like GitHub Pages /dirt-race/).
  if (!url.startsWith('/dirt-race/')) {
    res.writeHead(302, { location: '/dirt-race/' });
    return res.end();
  }
  let p = normalize(join(root, url.slice('/dirt-race/'.length) || 'index.html'));
  if (!p.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(p);
    res.writeHead(200, {
      'content-type': types[extname(p)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const candidates = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const executablePath = candidates.find((c) => existsSync(c));
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
// iPad Air 3 landscape CSS size. Software GL (SwiftShader) is very slow, so render at DPR 1 / Low and
// wait on *simulated* time rather than wall time.
const page = await browser.newPage({
  viewport: { width: 1112, height: 834 },
  deviceScaleFactor: 1,
});
const QUALITY = process.env.QUALITY ?? 'low';
await page.addInitScript((q) => {
  try {
    localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: q, autoQuality: false, qualityVersion: 2 }));
  } catch {}
}, QUALITY);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (process.env.VERBOSE) console.log(`[console.${m.type()}]`, m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${msg}`);
  if (!ok) failed = true;
};

await page.goto(`http://localhost:${PORT}/dirt-race/`, { waitUntil: 'load' });
await mkdir(shots, { recursive: true });
// The title (logo + loading bar) shows while the course is still building, and Start already works:
// it must request tilt permission synchronously in the tap; Ready waits for the course.
await page.waitForSelector('[data-screen="title"]:not([hidden])', { timeout: 30000 });
const early = await page.evaluate(() => !document.body.classList.contains('ready'));
if (early) await page.screenshot({ path: join(shots, 'title-loading.png') });
console.log(`  info title visible ${early ? 'before' : 'after'} the course finished building`);
await page.click('[data-tap="start"]');
await page.waitForSelector('[data-screen="calibrate"]:not([hidden])');
check(true, 'calibrate screen after Start (tapped while loading)');
if (early) {
  const st = await page.evaluate(() => ({ disabled: document.querySelector('[data-tap="ready"]').disabled, ready: document.body.classList.contains('ready') }));
  check(st.disabled || st.ready, 'Ready waits for the course to finish building');
}
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 60000 });
const loadInfo = await page.evaluate(() => ({ ms: performance.now() }));
console.log(`  info course ready after ${(loadInfo.ms / 1000).toFixed(1)} s (software GL)`);
// Wait for tilt detection to resolve (desktop → unavailable), then Ready.
await page.waitForTimeout(1500);
await page.click('[data-tap="ready"]');
check(await page.isHidden('[data-screen="calibrate"]'), 'Ready → vehicle spin');

const simWait = async (seconds) => {
  const start = await page.evaluate(() => window.__dirt.loop.simTime);
  await page.waitForFunction((t) => window.__dirt.loop.simTime >= t, start + seconds, { timeout: 120000, polling: 100 });
};
const phase = () => page.evaluate(() => window.__dirt.race.phase);

// Spin → countdown → GO
await page.waitForSelector('[data-screen="spin"]:not([hidden])');
check(true, 'vehicle spin reels showing');
await page.waitForSelector('.vspin-go.ready', { timeout: 60000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: join(shots, 'race-spin.png') });
const reelKinds = await page.evaluate(() => [...document.querySelectorAll('.vspin-col.landed')].length);
check(reelKinds === 2, 'both reels landed');
await page.click('[data-tap="spin-go"]', { force: true });
await page.waitForFunction(() => window.__dirt.race.phase === 'countdown', null, { timeout: 5000 }).catch(() => {});
check((await phase()) === 'countdown', 'countdown after GO');
const picked = await page.evaluate(() => [window.__dirt.flow?.picks?.player?.spec.kind, window.__dirt.player?.spec?.kind]);
console.log(`  info spin picks: ${JSON.stringify(picked)}`);
await page.waitForFunction(() => window.__dirt.race.countdownLeftS < 2.6, null, { timeout: 60000, polling: 50 });
await page.screenshot({ path: join(shots, 'race-countdown.png') });
await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, {
  timeout: 60000,
  polling: 100,
});
check(true, 'GO → racing');
const pos = () =>
  page.evaluate(() => {
    const p = window.__dirt.player;
    return {
      x: p.position.x,
      y: p.position.y - window.__dirt.world.heightAt(p.position.x, p.position.z),
      z: p.position.z,
      speed: p.speed,
    };
  });
const p0 = await pos();
await page.keyboard.down('ArrowUp');
await simWait(3);
await page.keyboard.down('ArrowLeft');
await simWait(1);
await page.keyboard.up('ArrowLeft');
const p1 = await pos();
const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
check(moved > 15, `car moved ${moved.toFixed(1)} m, speed ${(p1.speed * 3.6).toFixed(0)} km/h`);
check(p1.y > 0.2 && p1.y < 3, `car on the ground (${p1.y.toFixed(2)} m above the terrain)`);
await page.screenshot({
  path: join(shots, QUALITY === 'low' ? 'm1.png' : `m1-${QUALITY}.png`),
});
const cpuS = await page.evaluate(() => window.__dirt.race.progress.cpu.s);
check(cpuS > 20, `computer is driving (s=${cpuS.toFixed(0)} m)`);
check(await page.isVisible('.race-hud .rh-clock'), 'race HUD visible (position, timer, progress strip)');
await page.screenshot({ path: join(shots, 'race-hud.png') });
await page.keyboard.up('ArrowUp');

// Brake → reverse
await page.keyboard.down('Space');
await simWait(5);
const p2 = await pos();
check(p2.speed < -1, `holding brake reverses (speed ${(p2.speed * 3.6).toFixed(1)} km/h)`);
await page.keyboard.up('Space');

const info = await page.evaluate(() => {
  const d = window.__dirt;
  return {
    quality: d.quality.preset.level,
    frameMs: d.quality.avgFrameMs,
    calls: d.renderer.renderer.info.render.calls,
    tris: d.renderer.renderer.info.render.triangles,
  };
});
console.log(`  info quality=${info.quality} avgFrame=${info.frameMs.toFixed(1)}ms (software GL, not representative) drawCalls=${info.calls} tris=${info.tris}`);

// Audio: context unlocked by the Start tap, engine running, event handlers tolerate everything.
const audioInfo = await page.evaluate(async () => {
  const d = window.__dirt;
  const a = d.audio;
  const ev = d.events;
  const before = a.stats.oneShots;
  ev.emit('race:countdown', { n: 3 });
  ev.emit('race:go', {});
  ev.emit('vehicle:landed', { racer: 'player', impact: 9 });
  ev.emit('vehicle:collision', { racer: 'player', other: 'world', impulse: 5000 });
  ev.emit('obstacle:hit', { kind: 'hay', racer: 'player', x: d.player.position.x + 2, y: 0, z: d.player.position.z });
  ev.emit('animal:bump', { kind: 'duck', racer: 'player', x: d.player.position.x, z: d.player.position.z + 3 });
  ev.emit('vehicle:surface', { racer: 'cpu', surface: 'mud' }); // no cpu attached: must be ignored quietly
  ev.emit('spin:tick', { racer: 'player' });
  ev.emit('race:jump', { racer: 'player', distanceM: 70, bonus: true, crashed: false });
  await new Promise((r) => setTimeout(r, 300));
  return { state: a.ctx?.state, music: a.currentMusic, oneShots: a.stats.oneShots - before, vol: [a.musicVolume, a.sfxVolume] };
});
check(audioInfo.state === 'running', `audio context running after Start tap (${audioInfo.state})`);
check(audioInfo.oneShots >= 6, `audio one-shots fired from bus events (${audioInfo.oneShots}), music=${audioInfo.music}`);

// Pause screen
await page.keyboard.press('KeyP');
check(await page.isVisible('[data-screen="pause"]'), 'pause screen opens');
check(await page.isVisible('[data-seg="difficulty"] button.on[data-v="easy"]'), 'difficulty selector (Easy default)');
check(await page.isVisible('[data-seg="speedUnit"] button.on[data-v="mph"]'), 'speed unit toggle (mph default)');
await page.screenshot({ path: join(shots, 'm1-pause.png') });
const label = () => page.textContent('.tc-speed small');
await page.click('[data-seg="speedUnit"] [data-v="kmh"]');
const kmhOk = await page
  .waitForFunction(() => document.querySelector('.tc-speed small')?.textContent === 'km/h', null, { timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
await page.click('[data-seg="speedUnit"] [data-v="mph"]');
const mphOk = await page
  .waitForFunction(() => document.querySelector('.tc-speed small')?.textContent === 'mph', null, { timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
check(kmhOk && mphOk, `speedometer switches mph ↔ km/h (now ${await label()})`);
await page.click('[data-tap="resume"]');

// Finish the race and do the end jump: Brooks is put on the finish straight, holds the gas through the finish
// line, up the run-up and off the ramp. One attempt, then the car is held; the results show the jump distance.
await page.evaluate(() => {
  const d = window.__dirt;
  d.player.reset(d.world.data.spawnAt(d.world.track.finishS - 120, 0));
});
await page.keyboard.down('ArrowUp');
// Steer along the road with the arrow keys like a player would (holding straight on lets a low-grip car
// drift off the curving run-up into the fence). Software GL runs the sim ~5–10× slower than real time,
// so the deadline is generous and the loop ends on the game's own state.
let jumpEvt = null;
{
  let held = null;
  const deadline = Date.now() + 900000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const d = window.__dirt;
      const p = d.race.progress.player;
      if (p.jump === 'done' || p.stage === 'done') return { done: true };
      const v = d.player;
      const tr = d.world.track;
      const t = v.position.clone();
      tr.pointAt(Math.min(tr.length, p.s + 7 + Math.max(0, v.speed) * 0.55), t);
      const dx = t.x - v.position.x;
      const dz = t.z - v.position.z;
      const f = v.forward;
      return { done: false, steer: -Math.atan2(f.z * dx - f.x * dz, f.x * dx + f.z * dz) * 2.2 };
    });
    if (st.done) break;
    const want = st.steer > 0.12 ? 'ArrowRight' : st.steer < -0.12 ? 'ArrowLeft' : null;
    if (want !== held) {
      if (held) await page.keyboard.up(held);
      if (want) await page.keyboard.down(want);
      held = want;
    }
    await page.waitForTimeout(120);
  }
  if (held) await page.keyboard.up(held);
  jumpEvt = await page.evaluate(() => {
    const p = window.__dirt.race.progress.player;
    return p.jump === 'done' ? { ...p } : null;
  });
}
await page.keyboard.up('ArrowUp');
check(!!jumpEvt && jumpEvt.finished && jumpEvt.stage === 'done' && (jumpEvt.jumpM ?? 0) > 15, // the random pick may be the sedan (~25 m) or the tractor (~20 m)
   `end jump: ${jumpEvt?.jumpM} m, bonus ${jumpEvt?.jumpBonus}, crashed ${jumpEvt?.jumpCrashed}`);
await page.screenshot({ path: join(shots, 'race-jump.png') });
// Don't wait for the computer's 5 km: shorten the clock → results.
await page.evaluate(() => {
  const r = window.__dirt.race;
  r.config.timeLimitS = r.elapsedS + 1;
});
await page.waitForSelector('[data-screen="results"]:not([hidden])', {
  timeout: 120000,
});
const res = await page.evaluate(() => window.__dirt.race.lastResults);
check(
  !!res && res.racers.length === 2 && res.winner === 'player' && res.reason === 'finish' && res.racers[0].jumpM === jumpEvt?.jumpM,
  `results: winner ${res?.winner} (${res?.reason}), Brooks ${res?.racers[0].distanceM} m + jump ${res?.racers[0].jumpM} m, Computer ${res?.racers[1].distanceM} m`,
);
const jumpText = await page.textContent('[data-screen="results"] [data-r="cards"]');
check(/jump/.test(jumpText ?? ''), `results screen shows the jump (${(jumpText ?? '').replace(/\s+/g, ' ').slice(0, 120)})`);
await page.screenshot({ path: join(shots, 'race-results.png') });
check(res?.racers.every((r) => typeof r.damage === 'number') && (await page.isVisible('.res-damage')), `results show damage per car (${res?.racers.map((r) => r.damage + '%').join(' / ')})`);

// Effects: fire the event-driven ones and check the pooled systems come alive (and stay ≤ 3 draw calls).
const fxInfo = await page.evaluate(() => {
  const d = window.__dirt;
  const p = d.player.position;
  d.events.emit('obstacle:hit', { kind: 'hay bale', racer: 'player', x: p.x, y: p.y, z: p.z });
  d.events.emit('vehicle:landed', { racer: 'player', impact: 8 });
  d.events.emit('race:finish', { racer: 'player', timeS: 100, winner: true });
  d.events.emit('race:jump', { racer: 'player', distanceM: 70, bonus: true, crashed: false });
  d.fx.update(1 / 60);
  return { particles: d.fx.particles.count, debris: d.fx.debris.count };
});
check(fxInfo.particles > 10 && fxInfo.debris > 20, `effects: hay/landing/confetti/jump-bonus spawn pooled particles (${fxInfo.particles} sprites, ${fxInfo.debris} pieces)`);

// Race Again ×5: GPU memory (geometries/textures), programs and physics bodies must stay flat.
const mem = () =>
  page.evaluate(() => {
    const d = window.__dirt;
    const i = d.renderer.renderer.info;
    return { geo: i.memory.geometries, tex: i.memory.textures, prog: i.programs?.length ?? 0, bodies: d.physics.world.bodies.len(), colliders: d.physics.world.colliders.len(), scene: d.renderer.scene.children.length };
  });
const mems = [];
for (let round = 1; round <= 5; round++) {
  if (round > 1) {
    await page.evaluate(() => {
      const r = window.__dirt.race;
      r.config.timeLimitS = r.elapsedS + 0.5;
    });
    await page.waitForSelector('[data-screen="results"]:not([hidden])', { timeout: 120000 });
  }
  await page.click('[data-tap="again"]');
  await page.waitForSelector('[data-screen="spin"]:not([hidden])');
  await page.waitForSelector('.vspin-go.ready', { timeout: 60000 });
  await page.click('[data-tap="spin-go"]', { force: true });
  await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, { timeout: 60000, polling: 100 });
  await page.keyboard.down('ArrowUp');
  await simWait(1.5);
  await page.keyboard.up('ArrowUp');
  // Round 2 damage: dent + crack the player's car before measuring (no new GPU resources per hit), then
  // wreck it after measuring (bumpers fall into the scene) so the NEXT round proves Race Again cleans up.
  await page.evaluate(() => {
    const p = window.__dirt.player;
    p.addDamage(26, { x: 0.2, y: 0, z: 1 });
    p.addDamage(26, { x: -1, y: 0, z: 0.2 });
  });
  await simWait(0.3);
  mems.push(await mem());
  await page.evaluate(() => {
    const p = window.__dirt.player;
    p.addDamage(30, { x: 0, y: 0, z: 1 });
    p.addDamage(30, { x: 0, y: 0, z: -1 });
  });
  await simWait(0.5);
}
check(true, 'Race Again → new spin → race, 5 times (each car damaged, then wrecked)');
{
  const dm = await page.evaluate(() => ({ dmg: window.__dirt.player.damage, meter: document.querySelector('.dmg-meter b')?.textContent, shown: !document.querySelector('.dmg-meter')?.hidden }));
  check(dm.dmg === 100 && dm.meter === '100%' && dm.shown, `damage meter in the HUD follows the player's damage (${dm.meter}, visible ${dm.shown})`);
  await page.screenshot({ path: join(shots, 'r2-damage-ingame.png') });
}
console.log(`  info memory per race: ${mems.map((m) => `geo ${m.geo} tex ${m.tex} prog ${m.prog} bodies ${m.bodies} scene ${m.scene}`).join(' | ')}`);
// Different vehicle kinds have different geometry counts, so allow a little wobble but no growth trend.
const first = mems[0];
const last = mems[mems.length - 1];
const flat = (k, slack) => Math.max(...mems.map((m) => m[k])) - Math.min(...mems.map((m) => m[k])) <= slack;
check(flat('tex', 2) && flat('bodies', 0) && flat('colliders', 0) && flat('scene', 0) && last.geo - first.geo <= 12 && flat('geo', 24), 'no leak over 5 Race Agains (textures, geometries, bodies, scene objects flat)');

// Round 2: with Auto off (the default) slow frames never drop quality by themselves; after ~10 s under
// ~20 fps a one-time prompt asks. Lower → one level down, remembered; never asked again.
await page.keyboard.press('KeyP');
await page.click('[data-seg="quality"] [data-v="medium"]');
await page.click('[data-tap="resume"]');
const prompt = await page.evaluate(() => {
  const q = window.__dirt.quality;
  q.setMonitoring(true);
  let t = performance.now() + 5000;
  for (let i = 0; i < 6 * 16; i++) q.sample(62, (t += 62)); // ~6 s slow: not yet
  const early = !document.querySelector('.slow-prompt').hidden;
  for (let i = 0; i < 6 * 16; i++) q.sample(62, (t += 62)); // ~12 s slow
  return { early, shown: !document.querySelector('.slow-prompt').hidden, level: q.preset.level, drops: q.autoDrops };
});
check(!prompt.early && prompt.shown && prompt.level === 'medium' && prompt.drops === 0, `slow frames (Auto off) keep the level and show the one-time prompt after ~10 s (early ${prompt.early}, shown ${prompt.shown}, level ${prompt.level})`);
await page.screenshot({ path: join(shots, 'r2g-slow-prompt.png') });
await page.click('[data-tap="slow-lower"]');
const lowered = await page.evaluate(() => {
  const q = window.__dirt.quality;
  const s = JSON.parse(localStorage.getItem('dirtrace.settings.v1'));
  q.promptRaised = false; // a new session would start fresh: the saved answer alone must stop it
  let t = performance.now() + 5000;
  for (let i = 0; i < 20 * 16; i++) q.sample(62, (t += 62));
  return { level: q.preset.level, stored: s.quality, answer: s.slowPrompt, again: !document.querySelector('.slow-prompt').hidden };
});
check(lowered.level === 'low' && lowered.stored === 'low' && lowered.answer === 'lowered' && !lowered.again, `prompt "Lower" → ${lowered.level} (saved ${lowered.stored}, answer ${lowered.answer}), never asked again`);

// Quality auto-drop: slow frames while driving drop a level and persist it. Start from Medium with Auto
// on (via the settings screen, like a parent would), then feed the monitor 40 ms frames.
await page.keyboard.press('KeyP');
await page.click('[data-seg="quality"] [data-v="medium"]');
await page.click('[data-seg="quality"] [data-v="auto"]');
await page.click('[data-tap="resume"]');
const dropped = await page.evaluate(() => {
  const q = window.__dirt.quality;
  q.setMonitoring(true);
  if (q.preset.level !== 'medium') return { level: 'not medium: ' + q.preset.level, stored: '', drops: 0 };
  let t = performance.now() + 5000;
  for (let i = 0; i < 200; i++) q.sample(40, (t += 40));
  return { level: q.preset.level, stored: JSON.parse(localStorage.getItem('dirtrace.settings.v1')).quality, drops: q.autoDrops };
});
check(dropped.level === 'low' && dropped.stored === 'low' && dropped.drops >= 1, `slow frames auto-drop quality and persist it (medium → ${dropped.level}, saved ${dropped.stored})`);
const terr = await page.evaluate(() => {
  const d = window.__dirt;
  const q = d.quality;
  let t = performance.now() + 5000;
  for (let i = 0; i < 200; i++) q.sample(60, (t += 60));
  return d.world.terrainShading;
});
check(terr === 'simple', `still slow on Low → texture-free terrain (${terr})`);
await page.waitForTimeout(500);
await page.screenshot({ path: join(shots, 'terrain-simple.png') });

// Service worker registered + manifest present
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  return !!reg;
});
check(sw, 'service worker registered');
const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
check(manifest.display === 'standalone' && manifest.orientation === 'landscape', 'manifest standalone + landscape');

// Offline reload: SW precache should serve everything.
await page.waitForTimeout(1500);
await page.context().setOffline(true);
await page.reload({ waitUntil: 'load' });
const offlineOk = await page
  .waitForFunction(() => document.body.classList.contains('ready'), null, {
    timeout: 30000,
  })
  .then(
    () => true,
    () => false,
  );
check(offlineOk, 'game boots offline from the service worker cache');
await page.context().setOffline(false);

// Portrait overlay on a touch device
const touch = await browser.newContext({
  viewport: { width: 820, height: 1180 },
  hasTouch: true,
  isMobile: true,
});
const tp = await touch.newPage();
await tp.goto(`http://localhost:${PORT}/dirt-race/`, { timeout: 120000 }); // slow under software GL while the first page still renders
await tp.waitForTimeout(1500);
check(await tp.isVisible('#rotate'), 'portrait (touch) shows rotate overlay');
await touch.close();

// The real course is loaded with its zones, checkpoints, the end jump and the log-bridge shortcut.
const worldInfo = await page.evaluate(() => {
  const w = window.__dirt.world;
  return { zones: w.zones.map((z) => z.id).join(','), cps: w.checkpoints.length, len: Math.round(w.track.length), shortcuts: (w.shortcuts ?? []).length, jump: !!w.jump && w.jump.bonusS > w.jump.lipS };
});
check(worldInfo.zones === 'town,farm,mud,rocky,forest,canyon,snow,desert,river,finish,jump' && worldInfo.cps >= 14 && worldInfo.shortcuts === 1 && worldInfo.jump, `race course loaded: ${worldInfo.len} m, zones ${worldInfo.zones}, ${worldInfo.cps} checkpoints`);

// iOS gesture rule: Start, tapped while the course is still building, must call
// DeviceOrientationEvent.requestPermission() synchronously inside the click (fake iOS API, slowed CPU).
{
  const g = await browser.newPage({ viewport: { width: 1112, height: 834 }, deviceScaleFactor: 1 });
  await g.addInitScript(() => {
    try {
      localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: 'low', autoQuality: false, qualityVersion: 2, seenRotationTip: true }));
    } catch {}
    window.__perm = { calls: 0, inGesture: false };
    let inClick = false;
    document.addEventListener('click', () => (inClick = true), true);
    document.addEventListener('click', () => setTimeout(() => (inClick = false)), false);
    window.DeviceOrientationEvent.requestPermission = () => {
      window.__perm.calls++;
      window.__perm.whileLoading = !document.body.classList.contains('ready');
      window.__perm.inGesture = inClick && navigator.userActivation?.isActive !== false;
      return Promise.resolve('granted');
    };
  });
  const cdp = await g.context().newCDPSession(g);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await g.goto(`http://localhost:${PORT}/dirt-race/`, { waitUntil: 'commit' });
  // Generous timeouts: 4x CPU throttle on software GL is very slow and load-dependent (was flaky at 30–60 s).
  await g.waitForSelector('[data-screen="title"]:not([hidden])', { timeout: 180000 });
  await g.click('[data-tap="start"]', { timeout: 180000 });
  const perm = await g.evaluate(() => window.__perm);
  check(perm.calls === 1 && perm.inGesture, `Start asks for tilt permission synchronously in the tap (calls ${perm.calls}, in gesture ${perm.inGesture})`);
  // The course build yields only between its two halves, so whether the (headless) click lands before it
  // finishes depends on timing: informational.
  console.log(`  info Start was handled ${perm.whileLoading ? 'while the course was still building' : 'after the course finished building'}`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await g.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 180000 });
  check(await g.isEnabled('[data-tap="ready"]'), 'Ready enables once the course is built');
  await g.close();
}

// Round 2 settings migration: saved settings from before (no qualityVersion) move to Ultra once with Auto
// off; the default for a fresh install is Ultra too.
{
  const mg = await browser.newPage({ viewport: { width: 1112, height: 834 }, deviceScaleFactor: 1 });
  await mg.addInitScript(() => {
    globalThis.__dirtHold = true;
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: 'medium', autoQuality: true, sensitivity: 'high', seenRotationTip: true }));
  });
  await mg.goto(`http://localhost:${PORT}/dirt-race/`, { waitUntil: 'load', timeout: 120000 });
  await mg.waitForSelector('[data-screen="title"]:not([hidden])', { timeout: 60000 });
  const m1 = await mg.evaluate(() => JSON.parse(localStorage.getItem('dirtrace.settings.v1')));
  // A later choice (Low) is respected after a reload.
  await mg.evaluate(() => localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('dirtrace.settings.v1')), quality: 'low' })));
  await mg.reload({ waitUntil: 'load' });
  await mg.waitForSelector('[data-screen="title"]:not([hidden])', { timeout: 60000 });
  const m2 = await mg.evaluate(() => JSON.parse(localStorage.getItem('dirtrace.settings.v1')));
  check(m1.quality === 'ultra' && m1.autoQuality === false && m1.qualityVersion === 2 && m1.sensitivity === 'high' && m2.quality === 'low', `old settings migrate to Ultra once (got ${m1.quality}, auto ${m1.autoQuality}, other settings kept), later choice kept (${m2.quality})`);
  await mg.close();
}

// Forced fallback terrain (?terrain=simple) boots and renders without errors, never a black/pink world.
{
  const fb = await browser.newPage({ viewport: { width: 1112, height: 834 }, deviceScaleFactor: 1 });
  await fb.addInitScript(() => {
    try {
      localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: 'low', autoQuality: false, qualityVersion: 2, seenRotationTip: true }));
    } catch {}
  });
  const fbErr = [];
  fb.on('pageerror', (e) => fbErr.push(String(e)));
  await fb.goto(`http://localhost:${PORT}/dirt-race/?terrain=simple`, { waitUntil: 'load', timeout: 120000 });
  await fb.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 60000 });
  await fb.waitForTimeout(800);
  const px = await fb.evaluate(() => {
    const d = window.__dirt;
    d.renderer.render();
    const gl = d.renderer.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    // Brightest of a few ground pixels (the title camera orbits: one sample may land on a car or the road).
    let best = [0, 0, 0, 0];
    for (const fx of [0.08, 0.2, 0.8, 0.92]) {
      const buf = new Uint8Array(4);
      gl.readPixels(Math.floor(w * fx), Math.floor(h * 0.3), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      if (buf[0] + buf[1] + buf[2] > best[0] + best[1] + best[2]) best = [...buf];
    }
    return { shading: d.world.terrainShading, ground: best, errors: d.renderer.shaderErrors };
  });
  const [r, g, b] = px.ground;
  const sane = r + g + b > 60 && !(r > 200 && b > 200 && g < 80);
  check(px.shading === 'simple' && px.errors === 0 && fbErr.length === 0 && sane, `?terrain=simple fallback renders (shading ${px.shading}, ground pixel rgb(${r},${g},${b}))`);
  await fb.close();
}

const realErrors = errors.filter((e) => !/favicon/.test(e));
check(realErrors.length === 0, `no console errors${realErrors.length ? ': ' + realErrors.join(' | ') : ''}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
