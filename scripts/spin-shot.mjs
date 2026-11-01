// Spin screen screenshot + interaction check: screenshots/spin.png. Usage: node scripts/spin-shot.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const shots = fileURLToPath(new URL('../screenshots/', import.meta.url));
const server = await createServer({ server: { port: 5198, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1112, height: 834 }, deviceScaleFactor: 1, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errors.push(m.text()));
page.on('requestfailed', (r) => errors.push('requestfailed ' + r.url()));
page.on('response', (r) => r.status() === 404 && !/favicon/.test(r.url()) && errors.push('404 ' + r.url()));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${msg}`);
  if (!ok) failed = true;
};
await page.goto(`http://127.0.0.1:5198/src/ui/spin/dev.html?seed=${process.env.SEED ?? 7}&speed=1`);
await page.waitForSelector('[data-screen="spin"]');
await page.waitForTimeout(1300);
await page.screenshot({ path: join(shots, 'spin-mid.png') });
await page.waitForSelector('.spin-go.ready', { timeout: 30000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: join(shots, 'spin.png') });
const ticks = await page.evaluate(() => window.__spin.ticks);
check(ticks > 2, `reels ticked ${ticks} times (headless rAF is slow; ~36 on a real device)`);
const shown = await page.evaluate(() =>
  ['player', 'cpu'].map((r) => {
    const reel = document.querySelector(`[data-reel="${r}"]`);
    const box = reel.getBoundingClientRect();
    const card = [...reel.querySelectorAll('.spin-card')].find((c) => Math.abs(c.getBoundingClientRect().top - box.top - reel.clientTop) < 4);
    return card?.dataset.kind;
  }),
);
await page.tap('[data-tap="spin-go"]', { force: true });
await page.waitForFunction(() => window.__spin.done, null, { timeout: 5000 });
const r = await page.evaluate(() => window.__spin);
check(!!r.player && !!r.cpu, `GO resolves with picks: player=${r.player} cpu=${r.cpu}`);
check(shown[0] === r.player && shown[1] === r.cpu, `reels landed on the picked cards (${shown.join(', ')})`);
await page.waitForTimeout(400);
check(!(await page.$('[data-screen="spin"]')), 'spin overlay removed after GO');
// Small landscape (iPad split view / phone) layout sanity: no horizontal overflow.
await page.setViewportSize({ width: 740, height: 400 });
await page.goto(`http://127.0.0.1:5198/src/ui/spin/dev.html?seed=3&speed=6`);
await page.waitForSelector('.spin-go.ready', { timeout: 30000 });
await page.waitForTimeout(800);
await page.screenshot({ path: join(shots, 'spin-small.png') });
const overflow = await page.evaluate(() => { const r = document.querySelector('.spin-go').getBoundingClientRect(); return document.querySelector('.spin-wrap').scrollWidth > window.innerWidth + 1 || r.bottom > window.innerHeight; });
check(!overflow, 'fits a small landscape screen (GO fully visible)');
check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
