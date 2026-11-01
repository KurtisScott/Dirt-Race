// Renders sample sounds through Web Audio's OfflineAudioContext in headless Chrome, writes
// screenshots/audio/*.wav + waveform PNGs, and checks levels (no clipping, no silence, no dropouts).
// Usage: npm run audio-render
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(new URL('../screenshots/audio/', import.meta.url));
await mkdir(outDir, { recursive: true });

const bundle = await build({
  entryPoints: [join(here, 'audio-render-entry.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  define: { __COUNTDOWN_VOICE__: '[]', __APP_VERSION__: '"test"' },
});
const code = bundle.outputFiles[0].text;

const executablePath = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((c) => existsSync(c));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: code });
const t0 = Date.now();
const { data, SR } = await page.evaluate(async () => ({ data: await window.renderAll(), SR: window.SR }));
const renderMs = Date.now() - t0;
await browser.close();

function wav(samples, sr) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}

async function waveformPng(samples, file, title) {
  const W = 900, H = 160, cols = W;
  const per = Math.max(1, Math.floor(samples.length / cols));
  let path = '';
  for (let x = 0; x < cols; x++) {
    let lo = 0, hi = 0;
    for (let i = x * per; i < Math.min(samples.length, (x + 1) * per); i++) {
      if (samples[i] < lo) lo = samples[i];
      if (samples[i] > hi) hi = samples[i];
    }
    path += `M${x} ${(H / 2 - hi * (H / 2 - 4)).toFixed(1)}V${(H / 2 - lo * (H / 2 - 4)).toFixed(1)}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 22}">
    <rect width="100%" height="100%" fill="#10151c"/>
    <text x="8" y="16" fill="#cfd8dc" font-family="monospace" font-size="13">${title}</text>
    <g transform="translate(0,22)">
      <line x1="0" x2="${W}" y1="4" y2="4" stroke="#7a2e2e"/><line x1="0" x2="${W}" y1="${H - 4}" y2="${H - 4}" stroke="#7a2e2e"/>
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#2c3a47"/>
      <path d="${path}" stroke="#4fc3f7" stroke-width="1"/>
    </g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

let failed = false;
console.log(`rendered ${Object.keys(data).length} sounds via OfflineAudioContext in ${renderMs} ms`);
for (const [name, arr] of Object.entries(data)) {
  const s = Float32Array.from(arr);
  let peak = 0, sum = 0, clipped = 0, nan = 0;
  for (const v of s) {
    if (!Number.isFinite(v)) nan++;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / s.length);
  // Dropout check for loops/engines/music: no 100 ms window (after the first 150 ms) should be near-silent.
  let minWin = Infinity;
  const continuous = /^(engine|loop|music)/.test(name);
  if (continuous) {
    const w = Math.floor(SR * 0.1);
    for (let st = Math.floor(SR * 0.15); st + w <= s.length; st += w) {
      let e = 0;
      for (let i = st; i < st + w; i++) e += s[i] * s[i];
      minWin = Math.min(minWin, Math.sqrt(e / w));
    }
  }
  const dbfs = (x) => (20 * Math.log10(Math.max(x, 1e-9))).toFixed(1);
  const problems = [];
  if (nan) problems.push(`${nan} NaN`);
  if (clipped > 0) problems.push(`${clipped} clipped samples`);
  if (rms < 0.01) problems.push('near-silent');
  if (continuous && minWin < 0.005) problems.push(`dropout (min 100ms rms ${minWin.toFixed(4)})`);
  console.log(`${problems.length ? ' FAIL' : '  ok '} ${name.padEnd(22)} ${(s.length / SR).toFixed(1)}s peak ${dbfs(peak)} dBFS  rms ${dbfs(rms)} dBFS${continuous ? `  min-window ${dbfs(minWin)} dBFS` : ''}${problems.length ? '  ← ' + problems.join(', ') : ''}`);
  if (problems.length) failed = true;
  await writeFile(join(outDir, `${name}.wav`), wav(s, SR));
  await waveformPng(s, join(outDir, `${name}.png`), `${name}  peak ${dbfs(peak)} dBFS  rms ${dbfs(rms)} dBFS`);
}
if (errors.length) {
  console.log(' FAIL browser errors: ' + errors.join(' | '));
  failed = true;
}
console.log(`wrote WAV + PNG to ${outDir}`);
process.exit(failed ? 1 : 0);
