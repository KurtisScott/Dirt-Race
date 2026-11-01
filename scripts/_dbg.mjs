import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
await p.goto('http://localhost:4174/dirt-race/');
await p.waitForFunction(() => document.body.classList.contains('ready'));
await p.click('[data-tap="start"]'); await p.waitForTimeout(1500); await p.click('[data-tap="ready"]');
await p.keyboard.down('ArrowUp');
for (let i = 0; i < 6; i++) {
  await p.waitForTimeout(700);
  console.log(await p.evaluate(() => { const d = window.__dirt; return JSON.stringify({ sim: d.loop.simTime.toFixed(2), wall: (performance.now()/1000).toFixed(2), z: d.player.position.z.toFixed(2), sp: d.player.speed.toFixed(2), thr: d.input.state.throttle, en: d.input.enabled, frame: d.quality.avgFrameMs.toFixed(1) }); }));
}
await b.close();
