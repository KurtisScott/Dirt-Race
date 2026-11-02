// Screenshots of every course zone, the end jump and every animal from the BUILT game (headless Chrome, software GL).
// Teleports the player's car along the course during a race and lets the chase camera settle.
// Usage: npm run build && node scripts/world-shots.mjs
//   QUALITY=low|medium|high (default medium), PREFIX=world- (file prefix), PORT
//   ZONES=town,farm,…  (default: every zone shot)   FX=1 (with ZONES: also the effects shots)
//   JUMP=0 / ANIMALS=0 to skip those groups (with ZONES set, JUMP=1 / ANIMALS=1 add them), ANIMAL_KINDS=moose,boar to limit
// Writes screenshots/<PREFIX><name>.png and prints draw calls / triangles per shot.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const shots = fileURLToPath(new URL('../screenshots/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const PORT = Number(process.env.PORT ?? 4183);
const PREFIX = process.env.PREFIX ?? 'world-';
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (!url.startsWith('/dirt-race/')) return res.writeHead(302, { location: '/dirt-race/' }).end();
  const p = normalize(join(root, url.slice('/dirt-race/'.length) || 'index.html'));
  if (!p.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(PORT, r));
const executablePath = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((c) => existsSync(c));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1112, height: 834 }, deviceScaleFactor: 1 });
const QUALITY = process.env.QUALITY ?? 'medium';
await page.addInitScript((q) => {
  try {
    localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: q, autoQuality: false }));
  } catch {}
}, QUALITY);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (m.text().startsWith('[world]')) console.log('  ' + m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/dirt-race/${process.env.LEVEL ? `?level=${process.env.LEVEL}` : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 120000 });
console.log(`  load → ready ${((Date.now() - t0) / 1000).toFixed(1)} s (headless swiftshader)`);
await page.click('[data-tap="start"]');
await page.waitForTimeout(1500);
await page.click('[data-tap="ready"]');
await page.waitForSelector('.vspin-go.ready', { timeout: 60000 });
await page.click('[data-tap="spin-go"]', { force: true });
await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, { timeout: 90000, polling: 100 });
await mkdir(shots, { recursive: true });
// Animals would wander into the zone shots: off (the animal shots stage them by hand).
await page.evaluate(() => (window.__dirt.world.animalsEnabled = false));

const simWait = async (seconds) => {
  const start = await page.evaluate(() => window.__dirt.loop.simTime);
  await page.waitForFunction((t) => window.__dirt.loop.simTime >= t, start + seconds, { timeout: 180000, polling: 100 });
};
const stats = [];
const snap = async (name) => {
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const d = window.__dirt;
    const p = d.player;
    return { calls: d.renderer.renderer.info.render.calls, tris: d.renderer.renderer.info.render.triangles, surf: p.surface, speed: p.speed };
  });
  await page.screenshot({ path: join(shots, `${PREFIX}${name}.png`) });
  stats.push({ name, ...info });
  console.log(`  ${name.padEnd(14)} drawCalls=${String(info.calls).padStart(3)} tris=${(info.tris / 1000).toFixed(0).padStart(4)}k surface=${info.surf} speed=${(info.speed * 3.6).toFixed(0)} km/h`);
};
const override = (fn, arg) => page.evaluate(fn, arg);
/** Start a fresh race (the zone shots near the finish line finish the player's race and start its jump window). */
const freshRace = async () => {
  await page.evaluate(() => {
    window.__dirt.camera.override = null;
    window.__dirt.race.startCountdown();
  });
  await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, { timeout: 60000, polling: 100 });
  await simWait(1.2); // let the big "GO!" fade
};
const clearOverride = () => page.evaluate(() => (window.__dirt.camera.override = null));

// ---- zones: [name, where] — where is evaluated in the page to an s (m) along the track
const ZONE_SHOTS = {
  town: (w) => w.zones.find((z) => z.id === 'town').startS + 20,
  farm: (w) => w.zones.find((z) => z.id === 'farm').startS + 55,
  mud: (w) => w.zones.find((z) => z.id === 'mud').startS + 40,
  rocky: (w) => (w.data.ramps[0] ? w.track.project({ x: w.data.ramps[0].x, y: 0, z: w.data.ramps[0].z }).s - 35 : w.zones.find((z) => z.id === 'rocky').startS + 40),
  forest: (w) => w.zones.find((z) => z.id === 'forest').startS + 120,
  canyon: (w) => w.zones.find((z) => z.id === 'canyon').startS + 160,
  gorge: (w) => w.data.gorge.s0 - 30,
  snow: (w) => w.zones.find((z) => z.id === 'snow').startS + 80,
  desert: (w) => w.zones.find((z) => z.id === 'desert').startS + 200,
  riverside: (w) => w.data.line.tagS.riverside + 40,
  river: (w) => w.shortcuts[0].startS + 18,
  finish: (w) => w.data.finishS - 70,
  runup: (w) => w.data.finishS + 40,
};
const zones = process.env.ZONES?.split(',') ?? [...Object.keys(ZONE_SHOTS), 'bridge'];
for (const name of zones) {
  if (name === 'bridge') {
    // The log bridge from the side.
    await override(() => {
      const w = window.__dirt.world;
      const b = w.data.bridge;
      window.__dirt.player.reset(w.data.spawnAt(w.shortcuts[0].startS - 2, 0));
      const fx = Math.sin(b.yaw);
      const fz = Math.cos(b.yaw);
      window.__dirt.camera.override = (c) => {
        c.position.set(b.x - fz * 22 + fx * -10, b.y + 6, b.z + fx * 22 + fz * -10);
        c.lookAt(b.x, b.y, b.z);
        c.fov = 60;
        c.updateProjectionMatrix();
      };
    });
    await page.waitForTimeout(500);
    await snap('bridge');
    await clearOverride();
    continue;
  }
  const fn = ZONE_SHOTS[name];
  if (!fn) continue;
  const s = await page.evaluate(`(${fn.toString()})(window.__dirt.world)`);
  await page.evaluate(({ s, name }) => {
    const w = window.__dirt.world;
    window.__dirt.player.reset(w.data.spawnAt(s, name === 'gorge' ? 0 : -1.5));
  }, { s, name });
  await page.keyboard.down('ArrowUp');
  await simWait(name === 'mud' ? 2.5 : name === 'gorge' ? 2.2 : 1.6);
  await page.keyboard.up('ArrowUp');
  await snap(name);
}
if (zones.includes('gorge') || !process.env.ZONES) {
  // The gorge bridge from the side, down in the canyon.
  await override(() => {
    const w = window.__dirt.world;
    const c = w.data;
    const g = c.gorge;
    const m = c.centre(g.s);
    const t = c.dirAt(g.s);
    const y = c.gorgeDeckY(g.s);
    window.__dirt.player.reset(c.spawnAt(g.s0 - 6, 0));
    window.__dirt.camera.override = (cam) => {
      cam.position.set(m.x - t.y * 13 - t.x * 8, y - 4, m.y + t.x * 13 - t.y * 8);
      cam.lookAt(m.x, y - 3, m.y);
      cam.fov = 70;
      cam.updateProjectionMatrix();
    };
  });
  await page.waitForTimeout(500);
  await snap('gorge-bridge');
  await clearOverride();
}

// ---- the end jump: ramp, take-off, mid-air, landing zone markers, bonus gate
if (process.env.JUMP !== '0' && (!process.env.ZONES || process.env.JUMP)) {
  await freshRace();
  // Ramp from the side.
  await override(() => {
    const w = window.__dirt.world;
    const c = w.data;
    const j = c.jump;
    const s = j.footS + j.rampLen / 2;
    const m = c.centre(s);
    const t = c.dirAt(s);
    const y = w.track.pointAt(s).y;
    window.__dirt.player.reset(c.spawnAt(j.footS - 30, 0));
    window.__dirt.camera.override = (cam) => {
      cam.position.set(m.x - t.y * 22 - t.x * 14, y + 5, m.y + t.x * 22 - t.y * 14);
      cam.lookAt(m.x + t.x * 20, y, m.y + t.y * 20);
      cam.fov = 60;
      cam.updateProjectionMatrix();
    };
  });
  await page.waitForTimeout(500);
  await snap('jump-ramp');
  await clearOverride();
  // A real attempt: start on the finish straight, full gas, shoot mid-air and after landing (chase camera).
  await page.evaluate(() => {
    const w = window.__dirt.world;
    window.__dirt.player.reset(w.data.spawnAt(w.data.finishS - 150, 0));
    window.__dirt.camera.snap?.();
  });
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(
    () => {
      const d = window.__dirt;
      const j = d.world.jump;
      const s = d.race.progress.player.s;
      return s > j.lipS + 8 && d.player.wheelsOnGround === 0;
    },
    null,
    { timeout: 240000, polling: 50 },
  );
  await page.waitForFunction((t) => window.__dirt.loop.simTime >= t, (await page.evaluate(() => window.__dirt.loop.simTime)) + 0.7, { timeout: 60000, polling: 20 });
  await snap('jump-air');
  await page.waitForFunction(() => window.__dirt.race.progress.player.jump === 'done', null, { timeout: 120000, polling: 100 });
  await page.keyboard.up('ArrowUp');
  const jr = await page.evaluate(() => ({ m: window.__dirt.race.progress.player.jumpM, bonus: window.__dirt.race.progress.player.jumpBonus, crashed: window.__dirt.race.progress.player.jumpCrashed, kind: window.__dirt.player.spec.kind }));
  console.log(`  jump attempt (${jr.kind}): ${jr.m} m, bonus ${jr.bonus}, crashed ${jr.crashed}`);
  await simWait(0.4);
  await snap('jump-landed');
  // Landing zone: markers and the bonus gate, from the top of the landing hill.
  await override(() => {
    const w = window.__dirt.world;
    const c = w.data;
    const j = c.jump;
    const m = c.centre(j.lipS + 2);
    const t = c.dirAt(j.lipS + 2);
    const y = w.track.pointAt(j.lipS).y + j.rampHeight;
    const b = c.centre(j.lipS + 55);
    window.__dirt.camera.override = (cam) => {
      cam.position.set(m.x - t.y * 9, y + 4.5, m.y + t.x * 9);
      cam.lookAt(b.x, w.track.pointAt(j.lipS + 55).y, b.y);
      cam.fov = 62;
      cam.updateProjectionMatrix();
    };
  });
  await page.waitForTimeout(500);
  await snap('jump-landing');
  // Bonus celebration at the gate.
  await override(() => {
    const d = window.__dirt;
    const w = d.world;
    const j = w.jump;
    d.camera.override = null;
    d.player.reset(w.data.spawnAt(j.bonusS + 4, 0));
    d.camera.snap?.();
    d.events.emit('race:jump', { racer: 'player', distanceM: 74, bonus: true, crashed: false });
  });
  await simWait(0.8);
  await snap('jump-bonus');
}

// ---- animals: each kind standing on the road in its zone, seen from the side
if (process.env.ANIMALS !== '0' && (!process.env.ZONES || process.env.ANIMALS)) {
  await freshRace();
  const kinds = process.env.ANIMAL_KINDS?.split(',') ?? ['moose', 'boar', 'bull', 'cow', 'goat', 'rabbit', 'camel', 'deer', 'bear', 'croc', 'duck', 'mouse'];
  for (const kind of kinds) {
    await override((kind) => {
      const d = window.__dirt;
      const w = d.world;
      const c = w.data;
      const sys = w.animalSys;
      const spot = c.animalSpots.find((a) => a.kind === kind);
      const s = spot.s;
      d.player.reset(c.spawnAt(s - 20, -2));
      const plan = { spot: { kind, zone: spot.zone, s }, side: 1, done: true, animals: sys.byKind.get(kind) };
      sys.plan = [plan];
      sys.stage(plan);
      plan.animals.forEach((a, i) => {
        const p = c.spawnAt(s + i * 1.6, i * 1.4 - 0.5);
        a.body.setTranslation({ x: p.x, y: p.y + a.lift + 0.05, z: p.z }, true);
        a.state = 'waiting';
        a.heading = p.yaw + Math.PI / 2 + 0.5;
      });
      const big = { moose: 1.6, bull: 1.4, cow: 1.4, camel: 1.8, bear: 1.2, croc: 1.1, deer: 1.4, boar: 1, goat: 1, rabbit: 0.7, duck: 0.7, mouse: 0.6 }[kind] ?? 1;
      const m = c.centre(s);
      const t = c.dirAt(s);
      const y = w.track.pointAt(s).y;
      d.camera.override = (cam) => {
        cam.position.set(m.x - t.y * 4.2 * big - t.x * 3 * big, y + 1.4 * big, m.y + t.x * 4.2 * big - t.y * 3 * big);
        cam.lookAt(m.x + t.x * 0.8, y + 0.8 * big, m.y + t.y * 0.8);
        cam.fov = 55;
        cam.updateProjectionMatrix();
      };
    }, kind);
    await simWait(0.5);
    await snap(`animal-${kind}`);
    await page.evaluate(() => window.__dirt.world.resetDynamic());
    await clearOverride();
  }
}

// ---- effects shots: water splash at the ford, hay scatter, finish confetti.
if (!process.env.ZONES || process.env.FX) {
  await freshRace();
  const fxShot = async (name, setup, wait) => {
    await page.evaluate(setup);
    if (wait) await simWait(wait);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `fx-${name}.png`) });
    const n = await page.evaluate(() => ({ p: window.__dirt.fx.particles.count, d: window.__dirt.fx.debris.count, calls: window.__dirt.renderer.renderer.info.render.calls }));
    console.log(`  fx-${name.padEnd(8)} particles=${n.p} pieces=${n.d} drawCalls=${n.calls}`);
  };
  // Splash: find the first water cell on the centre-line and drive into it.
  const ford = await page.evaluate(() => {
    const w = window.__dirt.world;
    const z = w.zones.find((zz) => zz.id === 'river');
    for (let s = z.startS; s < z.endS; s += 1) {
      const p = w.track.pointAt(s);
      if (w.surfaceAt(p.x, p.z) === 'water') return s;
    }
    return z.startS + 30;
  });
  await page.evaluate((s) => window.__dirt.player.reset(window.__dirt.world.data.spawnAt(s - 14, 0)), ford);
  await page.keyboard.down('ArrowUp');
  await fxShot('splash', () => {}, 1.9);
  await page.keyboard.up('ArrowUp');
  await fxShot(
    'hay',
    () => {
      const d = window.__dirt;
      const w = d.world;
      const z = w.zones.find((zz) => zz.id === 'farm');
      d.player.reset(w.data.spawnAt(z.startS + 80, 0));
      const p = w.track.pointAt(z.startS + 88);
      d.events.emit('obstacle:hit', { kind: 'hay bale', racer: 'player', x: p.x, y: p.y + 0.6, z: p.z });
    },
    0.35,
  );
  await fxShot(
    'confetti',
    () => {
      const d = window.__dirt;
      const w = d.world;
      const s = w.track.finishS;
      d.player.reset(w.data.spawnAt(s - 2, 0));
      d.events.emit('race:finish', { racer: 'player', timeS: 120, winner: true });
      const p = w.track.pointAt(s);
      const t = w.track.tangentAt(s);
      d.camera.override = (c) => {
        c.position.set(p.x - t.x * 16, p.y + 3.5, p.z - t.z * 16);
        c.lookAt(p.x, p.y + 4, p.z);
        c.fov = 60;
        c.updateProjectionMatrix();
      };
    },
    1.0,
  );
  await clearOverride();
}

// Overview from high above the course.
if (!process.env.ZONES) {
  await page.evaluate(() => {
    const w = window.__dirt.world;
    const j = w.jump.lip;
    window.__dirt.camera.override = (c) => {
      c.position.set(j.x + 260, j.y + 260, j.z - 420);
      c.lookAt(j.x - 80, j.y - 40, j.z + 60);
      c.fov = 60;
      c.far = 4000;
      c.updateProjectionMatrix();
    };
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, `${PREFIX}overview.png`) });
}

const real = errors.filter((e) => !/favicon/.test(e));
console.log(real.length ? `errors: ${real.join(' | ')}` : '  no console errors');
const zoneStats = stats.filter((s) => !s.name.startsWith('animal-'));
const max = Math.max(...zoneStats.map((s) => s.calls));
console.log(`  max draw calls ${max} (quality ${QUALITY})`);
await browser.close();
server.close();
process.exit(real.length ? 1 : 0);
