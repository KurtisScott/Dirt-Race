// Screenshots of every course zone from the BUILT game (headless Chrome, software GL).
// Teleports the player's car along the course during a race and lets the chase camera settle.
// Usage: npm run build && node scripts/world-shots.mjs   (QUALITY=medium default; PORT env var)
// Writes screenshots/world-<zone>.png and prints draw calls / triangles per shot.
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

await page.goto(`http://localhost:${PORT}/dirt-race/${process.env.LEVEL ? `?level=${process.env.LEVEL}` : ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 60000 });
await page.click('[data-tap="start"]');
await page.waitForTimeout(1500);
await page.click('[data-tap="ready"]');
await page.waitForSelector('.vspin-go.ready', { timeout: 60000 });
await page.click('[data-tap="spin-go"]', { force: true });
await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, { timeout: 90000, polling: 100 });
await mkdir(shots, { recursive: true });

const simWait = async (seconds) => {
  const start = await page.evaluate(() => window.__dirt.loop.simTime);
  await page.waitForFunction((t) => window.__dirt.loop.simTime >= t, start + seconds, { timeout: 120000, polling: 100 });
};

// [name, s offset into zone (m) or absolute, lateral, extra]
const zones = process.env.ZONES?.split(',') ?? ['town', 'farm', 'mud', 'rocky', 'desert', 'river', 'finish', 'hill', 'bridge', 'animal'];
const stats = [];
for (const name of zones) {
  const where = await page.evaluate((name) => {
    const w = window.__dirt.world;
    const z = w.zones.find((zz) => zz.id === name);
    const d = w.data;
    let s;
    let back = 0;
    if (name === 'hill') s = d.finishS - 40;
    else if (name === 'finish') s = d.finishS - 70;
    else if (name === 'river') s = w.shortcuts[0].startS + 18;
    else if (name === 'bridge') s = w.shortcuts[0].startS - 2;
    else if (name === 'animal') s = 0;
    else if (name === 'mud') s = z.startS + 40;
    else if (name === 'rocky') s = d.ramps[0] ? w.track.project({ x: d.ramps[0].x, y: 0, z: d.ramps[0].z }).s - 35 : z.startS + 40;
    else if (name === 'farm') s = z.startS + 55;
    else s = (z ? z.startS : 0) + 20 + back;
    return { s };
  }, name);
  if (name === 'animal') {
    // Stage a deer crossing right in front of the car on the farm road.
    await page.evaluate(() => {
      const w = window.__dirt.world;
      const d = w.data;
      const z = w.zones.find((zz) => zz.id === 'farm');
      const s = z.startS + 150;
      const p = window.__dirt.player;
      p.reset(d.spawnAt(s - 26, 0));
      const sys = w.animalSys;
      const plan = { spot: { kind: 'deer', zone: 'farm', s }, side: 1, done: false, animals: sys.byKind.get('deer') };
      sys.plan = [plan];
      sys.stage(plan);
      for (const a of plan.animals) {
        a.state = 'crossing';
        a.stateT = 0;
      }
      window.__dirt.cameraSnap?.();
    });
    await simWait(0.9);
  } else {
    await page.evaluate(({ s, name }) => {
      const w = window.__dirt.world;
      const p = window.__dirt.player;
      // Keep the computer off-screen behind us.
      p.reset(w.data.spawnAt(s, name === 'bridge' ? 0 : -1.5));
    }, where);
    await page.keyboard.down('ArrowUp');
    await simWait(name === 'hill' ? 3.2 : name === 'mud' ? 2.5 : 1.6);
    await page.keyboard.up('ArrowUp');
  }
  if (name === 'bridge') {
    // Look at the bridge from the side: override the camera briefly.
    await page.evaluate(() => {
      const w = window.__dirt.world;
      const b = w.data.bridge;
      const r = w.data.river;
      const cam = window.__dirt.renderer.camera;
      const fx = Math.sin(b.yaw);
      const fz = Math.cos(b.yaw);
      window.__dirt.camera.override = (c) => {
        c.position.set(b.x - fz * 22 + fx * -10, b.y + 6, b.z + fx * 22 + fz * -10);
        c.lookAt(b.x, b.y, b.z);
        c.fov = 60;
        c.updateProjectionMatrix();
      };
      void r;
      void cam;
    });
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const d = window.__dirt;
    const p = d.player;
    return { calls: d.renderer.renderer.info.render.calls, tris: d.renderer.renderer.info.render.triangles, surf: p.surface, y: p.position.y, speed: p.speed };
  });
  await page.screenshot({ path: join(shots, `world-${name}.png`) });
  if (name === 'bridge') await page.evaluate(() => (window.__dirt.camera.override = null));
  stats.push({ name, ...info });
  console.log(`  ${name.padEnd(7)} drawCalls=${info.calls} tris=${(info.tris / 1000).toFixed(0)}k surface=${info.surf} speed=${(info.speed * 3.6).toFixed(0)} km/h`);
}

// ---- effects shots: water splash at the ford, hay scatter, finish confetti, summit celebration.
if (!process.env.ZONES || process.env.FX) {
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
  // Hay scatter + landing puff on the farm road.
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
  // Confetti at the finish gantry (camera looks at the gantry from the road).
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
  await page.evaluate(() => (window.__dirt.camera.override = null));
  await fxShot(
    'summit',
    () => {
      const d = window.__dirt;
      const w = d.world;
      const sm = w.summit;
      void sm;
      d.player.reset(w.data.spawnAt(w.track.summitS - 10, 0));
      d.camera.override = null;
      d.camera.snap();
      d.events.emit('race:summit', { racer: 'player' });
    },
    0.7,
  );
  await page.evaluate(() => (window.__dirt.camera.override = null));
}

// Overview from high above the course, looking at the hill.
await page.evaluate(() => {
  const w = window.__dirt.world;
  const sm = w.summit;
  window.__dirt.camera.override = (c) => {
    c.position.set(sm.x - 160, sm.y + 70, sm.z - 260);
    c.lookAt(sm.x, sm.y - 20, sm.z);
    c.fov = 55;
    c.updateProjectionMatrix();
  };
});
await page.waitForTimeout(500);
await page.screenshot({ path: join(shots, 'world-overview.png') });

const real = errors.filter((e) => !/favicon/.test(e));
console.log(real.length ? `errors: ${real.join(' | ')}` : '  no console errors');
const max = Math.max(...stats.map((s) => s.calls));
console.log(`  max draw calls ${max} (quality ${QUALITY})`);
await browser.close();
server.close();
process.exit(real.length ? 1 : 0);
