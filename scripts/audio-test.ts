/**
 * Headless checks of the procedural audio generators (no browser): every one-shot, loop and engine
 * renders without NaN, isn't silent, doesn't clip, loops are seamless, and startup render cost is small.
 * Run: npx tsx scripts/audio-test.ts
 */
import { ENGINE_PROFILES, renderEngineLoop } from '../src/audio/engine.ts';
import { LOOPS, SFX, animalVoice } from '../src/audio/sfx.ts';
import { ANIMAL_SPECS } from '../src/world/animals.ts';
import { MENU_SONG, RACE_SONG, midi } from '../src/audio/music.ts';

let failed = 0;
const check = (ok: boolean, msg: string): void => {
  if (!ok) {
    failed++;
    console.log(` FAIL ${msg}`);
  }
};

function stats(b: Float32Array): { peak: number; rms: number; nan: boolean } {
  let peak = 0, s = 0, nan = false;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (!Number.isFinite(v)) nan = true;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    s += v * v;
  }
  return { peak, rms: Math.sqrt(s / b.length), nan };
}

/** Seam jump relative to typical sample-to-sample change: a click shows up as a large outlier. */
function seamRatio(b: Float32Array): number {
  let d = 0;
  for (let i = 1; i < b.length; i++) d += Math.abs(b[i] - b[i - 1]);
  const avg = d / (b.length - 1);
  return Math.abs(b[0] - b[b.length - 1]) / (avg || 1e-9);
}

const SR = 32000;
let totalMs = 0;
const time = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  totalMs += ms;
  return [r, ms];
};

console.log('one-shots');
for (const [name, gen] of Object.entries(SFX)) {
  const [b, ms] = time(() => gen(SR));
  const st = stats(b);
  console.log(`  ${name.padEnd(10)} ${(b.length / SR).toFixed(2)}s peak ${st.peak.toFixed(2)} rms ${st.rms.toFixed(3)} ${ms.toFixed(1)}ms`);
  check(!st.nan, `${name}: NaN`);
  check(st.peak <= 1.0, `${name}: clips (peak ${st.peak})`);
  check(st.rms > 0.01, `${name}: too quiet (rms ${st.rms})`);
  check(b.length < SR * 4, `${name}: too long`);
}

// Every animal on the course has its own voice (not the generic boing), and no two kinds share one.
{
  const voices = Object.keys(ANIMAL_SPECS).map((k) => [k, animalVoice(k)] as const);
  console.log(`animal voices: ${voices.map(([k, v]) => `${k}→${v}`).join(', ')}`);
  check(voices.every(([, v]) => v !== 'boing' && v in SFX), 'every animal kind has its own voice');
  check(new Set(voices.map(([, v]) => v)).size === voices.length, 'no two animal kinds share a voice');
}

console.log('loops (24 kHz)');
for (const [name, gen] of Object.entries(LOOPS)) {
  const [b, ms] = time(() => gen(24000));
  const st = stats(b);
  const seam = seamRatio(b);
  console.log(`  ${name.padEnd(10)} ${(b.length / 24000).toFixed(2)}s peak ${st.peak.toFixed(2)} rms ${st.rms.toFixed(3)} seam ${seam.toFixed(1)}x ${ms.toFixed(1)}ms`);
  check(!st.nan && st.peak <= 1 && st.rms > 0.05, `${name}: level (peak ${st.peak}, rms ${st.rms})`);
  check(seam < 8, `${name}: loop seam click (${seam.toFixed(1)}x avg step)`);
}

console.log('engines (24 kHz)');
for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
  const [b, ms] = time(() => renderEngineLoop(p, 24000, 3));
  const st = stats(b);
  const seam = seamRatio(b);
  console.log(`  ${id.padEnd(8)} ${(b.length / 24000).toFixed(2)}s peak ${st.peak.toFixed(2)} rms ${st.rms.toFixed(3)} seam ${seam.toFixed(1)}x ${ms.toFixed(1)}ms`);
  check(!st.nan && st.peak <= 1 && st.rms > 0.1, `${id}: level`);
  check(seam < 8, `${id}: loop seam click (${seam.toFixed(1)}x)`);
}

// Songs: every lead token parses, bars have 8 slots.
for (const song of [MENU_SONG, RACE_SONG]) {
  for (const s of song.sections) {
    if (s.lead) {
      check(s.lead.length === s.chords.length, 'lead bars = chord bars');
      for (const bar of s.lead) {
        const toks = bar.trim().split(/\s+/);
        check(toks.length === 8, `bar "${bar}" has ${toks.length} slots`);
        for (const t of toks) if (t !== '-' && t !== '.') midi(t);
      }
    }
  }
}

console.log(`total render ${totalMs.toFixed(0)} ms (Node; done in idle chunks after unlock in the game)`);
check(totalMs < 3000, 'startup render budget');
if (failed) {
  console.log(`audio-test: ${failed} failure(s)`);
  process.exit(1);
}
console.log('audio-test: all ok');
