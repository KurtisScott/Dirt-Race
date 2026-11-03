// Round 2 graphics screenshots from the BUILT game (headless Chrome, software GL): vehicle close-ups on the
// grid and on dirt (with dirt build-up), a damaged car with smoke, the spin screen and the title.
// Usage: npm run build && node scripts/look-shots.mjs
//   QUALITY=ultra|high|medium|low (default ultra), PREFIX=r2g- (file prefix → <PREFIX><quality>-<name>.png)
//   KINDS=sports,pickup,sedan,monster (close-up kinds), SHOTS=cars,damage,spin,title (default all)
// Rendering is held between shots (software GL is slow with the High/Ultra post chain).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const shots = fileURLToPath(new URL('../screenshots/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const PORT = Number(process.env.PORT ?? 4185);
const QUALITY = process.env.QUALITY ?? 'ultra';
const PREFIX = `${process.env.PREFIX ?? 'r2g-'}${QUALITY}-`;
const KINDS = (process.env.KINDS ?? 'sports,pickup,sedan,monster').split(',');
const SHOTS = (process.env.SHOTS ?? 'title,spin,cars,damage').split(',');
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
await page.addInitScript(() => (globalThis.__dirtHold = true));
await page.addInitScript((q) => {
  try {
    localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: q, autoQuality: false, qualityVersion: 2, seenRotationTip: true }));
  } catch {}
}, QUALITY);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await mkdir(shots, { recursive: true });

const renderFrames = (n = 2) =>
  page.evaluate(async (n) => {
    window.__dirt.renderer.hold = false;
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  }, n);
const hold = () => page.evaluate(() => (window.__dirt.renderer.hold = true));
const snap = async (name) => {
  await renderFrames(2);
  const info = await page.evaluate(() => ({ calls: window.__dirt.renderer.renderer.info.render.calls, tris: window.__dirt.renderer.renderer.info.render.triangles }));
  await page.screenshot({ path: join(shots, `${PREFIX}${name}.png`) });
  await hold();
  console.log(`  ${name.padEnd(20)} drawCalls=${info.calls} tris=${(info.tris / 1000).toFixed(0)}k`);
};
const simWait = async (seconds) => {
  const start = await page.evaluate(() => window.__dirt.loop.simTime);
  await page.waitForFunction((t) => window.__dirt.loop.simTime >= t, start + seconds, { timeout: 180000, polling: 100 });
};

const t0 = Date.now();
await page.goto(`http://localhost:${PORT}/dirt-race/`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 180000 });
console.log(`  load → ready ${((Date.now() - t0) / 1000).toFixed(1)} s (headless swiftshader, ${QUALITY})`);
if (SHOTS.includes('title')) {
  await page.waitForTimeout(800);
  await snap('title');
}
await page.click('[data-tap="start"]');
await page.waitForTimeout(1500);
await page.click('[data-tap="ready"]');
await page.waitForSelector('.vspin-go.ready', { timeout: 120000 });
if (SHOTS.includes('spin')) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(shots, `${PREFIX}spin.png`) });
  console.log('  spin');
}
await page.click('[data-tap="spin-go"]', { force: true });
await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, { timeout: 90000, polling: 100 });
await page.evaluate(() => (window.__dirt.world.animalsEnabled = false));

/** Rebuild both cars as `kind` (player) / `cpu`, start a race, park the player at s (lateral lat). */
const setup = async (kind, cpu, s, lat = 0) => {
  await page.evaluate(
    ({ kind, cpu }) => {
      const d = window.__dirt;
      const V = d.vehicles;
      d.flow.deps.spin = () => ({ player: { spec: V[kind], paint: V[kind].paints[0] }, cpu: { spec: V[cpu], paint: V[cpu].paints[1] } });
      d.camera.override = null;
      d.flow.prepare();
      d.race.startCountdown();
    },
    { kind, cpu },
  );
  await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, { timeout: 60000, polling: 100 });
  await page.evaluate(
    ({ s, lat }) => {
      const d = window.__dirt;
      d.player.reset(d.world.data.spawnAt(s, lat));
      d.cpu.reset(d.world.data.spawnAt(s + 40, -lat));
    },
    { s, lat },
  );
  await simWait(1.0);
};
/** Orbit camera around the player: angle from the car's nose (deg), distance, height. */
const orbit = (deg, dist, h, fov = 40) =>
  page.evaluate(
    ({ deg, dist, h, fov }) => {
      const d = window.__dirt;
      d.camera.override = (cam) => {
        const p = d.player.position;
        const f = d.player.forward;
        const a = (deg * Math.PI) / 180;
        const dx = f.x * Math.cos(a) - f.z * Math.sin(a);
        const dz = f.x * Math.sin(a) + f.z * Math.cos(a);
        cam.position.set(p.x + dx * dist, p.y + h, p.z + dz * dist);
        cam.lookAt(p.x, p.y + 0.15, p.z);
        cam.fov = fov;
        cam.updateProjectionMatrix();
      };
    },
    { deg, dist, h, fov },
  );
const setDirt = (v) =>
  page.evaluate((v) => {
    window.__dirt.player.object.traverse((o) => {
      const m = o.material;
      if (m?.userData?.dirt) m.userData.dirt.value = v;
    });
  }, v);

if (SHOTS.includes('cars')) {
  const town = await page.evaluate(() => window.__dirt.world.zones.find((z) => z.id === 'town').startS + 60);
  const farm = await page.evaluate(() => window.__dirt.world.zones.find((z) => z.id === 'farm').startS + 120);
  for (const [i, kind] of KINDS.entries()) {
    await setup(kind, KINDS[(i + 1) % KINDS.length], i % 2 ? farm : town, 0);
    if (i % 2) await setDirt(0.55);
    await orbit(38, 6.2, 1.5);
    await snap(`car-${kind}-front`);
    await orbit(150, 6.5, 1.8);
    await snap(`car-${kind}-rear`);
  }
}
if (SHOTS.includes('damage')) {
  const farm = await page.evaluate(() => window.__dirt.world.zones.find((z) => z.id === 'farm').startS + 60);
  await setup(KINDS[0], KINDS[1], farm, 0);
  await page.evaluate(() => {
    const p = window.__dirt.player;
    p.addDamage(30, { x: 0, y: 0, z: 1 });
    p.addDamage(30, { x: 1, y: 0.2, z: 0.3 });
    p.addDamage(25, { x: -0.6, y: 0, z: -1 });
  });
  await setDirt(0.4);
  await simWait(2.5); // smoke builds up
  await orbit(40, 6.5, 1.7);
  await snap('car-damaged');
}
console.log(errors.length ? `  console errors:\n    ${errors.slice(0, 8).join('\n    ')}` : '  no console errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
