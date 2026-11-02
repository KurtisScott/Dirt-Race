// Renders each vehicle (dev preview page) to screenshots/vehicle-<kind>.png via headless Chrome + Vite dev server.
// Usage: node scripts/vehicle-shots.mjs [kind|all|thumbs] [view] [quality]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const shots = fileURLToPath(new URL('../screenshots/', import.meta.url));
await mkdir(shots, { recursive: true });
const server = await createServer({ server: { port: 5199, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : process.env.VERBOSE && console.log(m.text())));
const arg = process.argv[2];
const view = process.argv[3] ?? '34';
const q = process.argv[4] ?? 'medium';
const ALL = ['sports', 'muscle', 'pickup', 'monster', 'buggy', 'sedan', 'rally', 'hatch', 'lifted', 'jeep', 'suv', 'van', 'bus', 'tractor', 'atv', 'trophy'];
const kinds = arg && arg !== 'each' ? arg.split(',') : ALL;
const damage = process.env.DAMAGE ?? '';
const prefix = process.env.PREFIX ?? 'vehicle-';
for (const kind of kinds) {
  for (const paint of process.env.PAINTS ? [0, 1, 2] : [Number(process.env.PAINT ?? 0)]) {
    await page.goto(`http://127.0.0.1:5199/src/vehicles/dev/preview.html?kind=${kind}&view=${view}&q=${q}&paint=${paint}${damage ? `&damage=${damage}` : ''}`);
    await page.waitForFunction(() => window.__preview?.done, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.__preview.result);
    const suffix = view === '34' ? '' : `-${view}`;
    const p = process.env.PAINTS ? `-p${paint}` : '';
    const d = damage ? `-dmg${damage}` : '';
    const name = kind === 'all' ? `${prefix}all${d}` : kind === 'thumbs' ? `${prefix}thumbs` : `${prefix}${kind}${suffix}${p}${d}`;
    await page.screenshot({ path: join(shots, `${name}.png`) });
    console.log(name, JSON.stringify(r));
  }
}
if (errors.length) console.log('ERRORS:', errors.join('\n'));
await browser.close();
await server.close();
