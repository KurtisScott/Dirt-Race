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
    localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: q, autoQuality: false }));
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
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 30000 });
check(await page.isVisible('[data-screen="title"]'), 'title screen visible');
await mkdir(shots, { recursive: true });
await page.screenshot({ path: join(shots, 'm1-title.png') });

await page.click('[data-tap="start"]');
await page.waitForSelector('[data-screen="calibrate"]:not([hidden])');
check(true, 'calibrate screen after Start');
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
check(true, 'spin screen shows both vehicles');
await page.screenshot({ path: join(shots, 'race-spin.png') });
await page.click('[data-tap="go"]');
check((await phase()) === 'countdown', "countdown after LET'S RACE");
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
      y: p.position.y,
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
check(p1.y > 0.2 && p1.y < 3, `car on the ground (y=${p1.y.toFixed(2)})`);
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

// Finish the race fast: shorten the clock, let it run out → results screen.
await page.evaluate(() => {
  const r = window.__dirt.race;
  r.config.timeLimitS = r.elapsedS + 1;
});
await page.waitForSelector('[data-screen="results"]:not([hidden])', {
  timeout: 120000,
});
const res = await page.evaluate(() => window.__dirt.race.lastResults);
check(
  !!res && res.racers.length === 2 && (res.reason === 'distance' || res.reason === 'tie' || res.reason === 'finish'),
  `results: winner ${res?.winner} (${res?.reason}), Brooks ${res?.racers[0].distanceM} m, Computer ${res?.racers[1].distanceM} m`,
);
await page.screenshot({ path: join(shots, 'race-results.png') });
await page.click('[data-tap="again"]');
await page.waitForSelector('[data-screen="spin"]:not([hidden])');
check(true, 'Race Again → new spin');
await page.click('[data-tap="go"]');
await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, {
  timeout: 60000,
  polling: 100,
});
check(true, 'second race starts');

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
await tp.goto(`http://localhost:${PORT}/dirt-race/`);
await tp.waitForTimeout(1500);
check(await tp.isVisible('#rotate'), 'portrait (touch) shows rotate overlay');
await touch.close();

const realErrors = errors.filter((e) => !/favicon/.test(e));
check(realErrors.length === 0, `no console errors${realErrors.length ? ': ' + realErrors.join(' | ') : ''}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
