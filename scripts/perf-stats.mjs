// Round 2 performance table from the BUILT game: per quality level and zone, draw calls / triangles per
// frame (scene + shadow + post passes) and GPU memory actually allocated through WebGL (textures, render
// targets, renderbuffers, vertex/index buffers), tracked by wrapping the WebGL2 allocation calls.
// Software GL (SwiftShader) → frame times are NOT representative of an iPad; counts and memory are.
// Usage: npm run build && node scripts/perf-stats.mjs   (LEVELS=low,medium,high,ultra  ZONES=town,farm,…)
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const PORT = Number(process.env.PORT ?? 4187);
const LEVELS = (process.env.LEVELS ?? 'low,medium,high,ultra').split(',');
const ZONES = (process.env.ZONES ?? 'town,farm,forest,canyon,snow,desert,river,jump').split(',');
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

/** Installed in the page before anything runs: counts bytes allocated per WebGL object. */
function trackGPU() {
  globalThis.__dirtHold = true;
  const P = WebGL2RenderingContext.prototype;
  const bytes = new Map(); // object → bytes
  const bound = { tex: new Map(), buf: new Map(), rb: null };
  const gpu = (globalThis.__gpu = { textures: 0, buffers: 0, renderbuffers: 0 });
  const BPP = { 0x8058: 4, 0x8c43: 4, 0x881a: 8, 0x8814: 16, 0x822e: 4, 0x822d: 2, 0x8230: 8, 0x822f: 4, 0x88f0: 4, 0x81a6: 4, 0x8cac: 4, 0x81a5: 2, 0x8051: 4, 0x8229: 1, 0x822b: 2, 0x8c3a: 4, 0x8cad: 8, 0x1908: 4, 0x1907: 4, 0x8d62: 2 };
  const bpp = (fmt, type) => BPP[fmt] ?? (type === 0x140b ? 8 : type === 0x1406 ? 16 : 4);
  const list = (globalThis.__gpuList = []);
  const add = (kind, obj, n) => {
    list.push({ kind, n, live: obj, stack: (new Error().stack ?? '').split('\n').slice(3, 9).join(' | ').replace(/https?:\/\/[^ )]+\//g, '') });
    const prev = bytes.get(obj) ?? 0;
    bytes.set(obj, prev + n);
    gpu[kind] += n;
  };
  const wrap = (name, f) => {
    const o = P[name];
    P[name] = function (...a) {
      f.call(this, ...a);
      return o.apply(this, a);
    };
  };
  wrap('bindTexture', function (t, tex) {
    bound.tex.set(t, tex);
  });
  wrap('bindBuffer', function (t, b) {
    bound.buf.set(t, b);
  });
  wrap('bindRenderbuffer', function (t, rb) {
    bound.rb = rb;
  });
  const texOf = (target) => bound.tex.get(target >= 0x8515 && target <= 0x851a ? 0x8513 : target);
  wrap('texStorage2D', function (target, levels, fmt, w, h) {
    let n = 0;
    for (let l = 0; l < levels; l++) n += Math.max(1, w >> l) * Math.max(1, h >> l);
    add('textures', texOf(target), n * bpp(fmt) * (target === 0x8513 ? 6 : 1));
  });
  wrap('texStorage3D', function (target, levels, fmt, w, h, d) {
    let n = 0;
    for (let l = 0; l < levels; l++) n += Math.max(1, w >> l) * Math.max(1, h >> l) * (target === 0x8c1a ? d : Math.max(1, d >> l));
    add('textures', texOf(target), n * bpp(fmt));
  });
  wrap('texImage2D', function (target, level, fmt, a3, a4, a5, a6, a7) {
    if (typeof a3 === 'number' && typeof a4 === 'number') add('textures', texOf(target), a3 * a4 * bpp(fmt, a7));
    else if (a5 && a5.width) add('textures', texOf(target), a5.width * a5.height * 4);
  });
  wrap('texImage3D', function (target, level, fmt, w, h, d, b, f, type) {
    add('textures', texOf(target), w * h * d * bpp(fmt, type));
  });
  wrap('renderbufferStorage', function (t, fmt, w, h) {
    add('renderbuffers', bound.rb, w * h * bpp(fmt));
  });
  wrap('renderbufferStorageMultisample', function (t, s, fmt, w, h) {
    add('renderbuffers', bound.rb, w * h * bpp(fmt) * Math.max(1, s));
  });
  wrap('bufferData', function (target, a1) {
    const n = typeof a1 === 'number' ? a1 : (a1?.byteLength ?? 0);
    const b = bound.buf.get(target);
    const prev = bytes.get(b) ?? 0;
    gpu.buffers += n - prev;
    bytes.set(b, n);
  });
  const del = (kind) =>
    function (obj) {
      const n = bytes.get(obj) ?? 0;
      gpu[kind] -= n;
      for (const e of list) if (e.live === obj) e.dead = true;
      bytes.delete(obj);
    };
  wrap('deleteTexture', del('textures'));
  wrap('deleteBuffer', del('buffers'));
  wrap('deleteRenderbuffer', del('renderbuffers'));
}

const rows = [];
for (const level of LEVELS) {
  const page = await browser.newPage({ viewport: { width: 1112, height: 834 }, deviceScaleFactor: Number(process.env.DPR ?? 2) });
  await page.addInitScript(trackGPU);
  await page.addInitScript((q) => localStorage.setItem('dirtrace.settings.v1', JSON.stringify({ quality: q, autoQuality: false, qualityVersion: 2, seenRotationTip: true })), level);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/dirt-race/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 180000 });
  const loadS = (Date.now() - t0) / 1000;
  await page.click('[data-tap="start"]');
  await page.waitForTimeout(1200);
  await page.click('[data-tap="ready"]');
  await page.waitForSelector('.vspin-go.ready', { timeout: 120000 });
  await page.click('[data-tap="spin-go"]', { force: true });
  await page.waitForFunction(() => window.__dirt.race.phase === 'racing', null, { timeout: 90000, polling: 100 });
  await page.evaluate(() => (window.__dirt.world.animalsEnabled = false));
  for (const zone of ZONES) {
    const r = await page.evaluate(async (zone) => {
      const d = window.__dirt;
      const w = d.world;
      const s = zone === 'jump' ? w.jump.lipS - 60 : w.zones.find((z) => z.id === zone).startS + 120;
      d.player.reset(w.data.spawnAt(s, -1.5));
      d.renderer.hold = false;
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      const info = d.renderer.renderer.info;
      const out = { calls: info.render.calls, tris: info.render.triangles, tex: info.memory.textures, geo: info.memory.geometries, gpu: { ...globalThis.__gpu }, px: d.renderer.renderer.getPixelRatio() };
      d.renderer.hold = true;
      return out;
    }, zone);
    const mb = (n) => (n / 1048576).toFixed(0);
    rows.push({ level, zone, ...r });
    if (process.env.TOP && zone === ZONES[0]) {
      const top = await page.evaluate(() => globalThis.__gpuList.filter((e) => e.n > 4e6 && !e.dead).map((e) => `${(e.n / 1048576).toFixed(1)} MB ${e.kind} ${e.stack}`));
      console.log(top.join('\n'));
    }
    console.log(`${level.padEnd(6)} ${zone.padEnd(7)} calls ${String(r.calls).padStart(4)}  tris ${(r.tris / 1000).toFixed(0).padStart(5)}k  GPU tex ${mb(r.gpu.textures).padStart(4)} MB  rb ${mb(r.gpu.renderbuffers).padStart(3)} MB  buffers ${mb(r.gpu.buffers).padStart(3)} MB  total ${mb(r.gpu.textures + r.gpu.renderbuffers + r.gpu.buffers).padStart(4)} MB  (pixel ratio ${r.px})`);
  }
  console.log(`${level.padEnd(6)} load ${loadS.toFixed(1)} s (software GL)${errors.length ? '  ERRORS: ' + errors.join(' | ') : ''}`);
  await page.close();
}
await browser.close();
server.close();
