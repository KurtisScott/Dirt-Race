/**
 * Browser entry for scripts/audio-render.mjs: renders sounds through the REAL Web Audio graph
 * (EngineVoice, Sequencer, buffer one-shots) with an OfflineAudioContext. Bundled by esbuild.
 */
import { EngineVoice, type EngineSoundId } from '../src/audio/engine';
import { MENU_SONG, RACE_SONG, Sequencer } from '../src/audio/music';
import { sfxBuffer, type LoopName, type SfxName } from '../src/audio/sfx';

const SR = 22050; // keeps the committed WAVs small; the game renders at the device rate

async function offline(seconds: number, build: (ctx: OfflineAudioContext, out: AudioNode) => void): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  build(ctx, out);
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

/** Engine: idle → full-throttle rev-up through "gears" → lift off → idle. */
function engineSweep(id: EngineSoundId) {
  return offline(6, (ctx, out) => {
    const e = new EngineVoice(ctx, id, out, 0, 24000);
    for (let t = 0; t <= 6; t += 1 / 30) {
      let rpm: number, thr: number;
      if (t < 1) [rpm, thr] = [0.15, 0];
      else if (t < 4.2) {
        const g = ((t - 1) / 3.2) * 3; // three gears
        rpm = 0.25 + (g % 1) * 0.7;
        thr = 1;
      } else if (t < 5) [rpm, thr] = [0.8 - (t - 4.2) * 0.7, 0];
      else [rpm, thr] = [0.15, 0];
      e.set(rpm, thr, t);
    }
  });
}

function oneShot(name: SfxName, seconds = 1.5) {
  return offline(seconds, (ctx, out) => {
    const s = ctx.createBufferSource();
    s.buffer = sfxBuffer(ctx, name, 32000);
    s.connect(out);
    s.start(0.02);
  });
}

function loopRender(name: LoopName, seconds = 3) {
  return offline(seconds, (ctx, out) => {
    const s = ctx.createBufferSource();
    s.buffer = sfxBuffer(ctx, `loop:${name}`, 24000);
    s.loop = true;
    s.connect(out);
    s.start(0);
  });
}

function countdown() {
  return offline(4.5, (ctx, out) => {
    const at = (name: SfxName, t: number, g = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = sfxBuffer(ctx, name, 32000);
      const gn = ctx.createGain();
      gn.gain.value = g;
      s.connect(gn).connect(out);
      s.start(t);
    };
    at('beep', 0.1, 0.55);
    at('beep', 1.1, 0.55);
    at('beep', 2.1, 0.55);
    at('beepHi', 3.1, 0.6);
    at('goHorn', 3.1, 0.55);
  });
}

function music(song: 'menu' | 'race', seconds: number) {
  return offline(seconds, (ctx, out) => {
    const seq = new Sequencer(ctx, song === 'menu' ? MENU_SONG : RACE_SONG, out, 0, 0.3);
    seq.pump(seconds);
  });
}

const jobs: Record<string, () => Promise<Float32Array>> = {
  'engine-v8-muscle': () => engineSweep('v8'),
  'engine-truck-pickup': () => engineSweep('truck'),
  'engine-monster': () => engineSweep('monster'),
  'engine-sport': () => engineSweep('sport'),
  'engine-buggy': () => engineSweep('buggy'),
  'engine-sedan-grandma': () => engineSweep('sedan'),
  countdown: countdown,
  cheer: () => oneShot('cheer', 3.4),
  fanfare: () => oneShot('fanfare', 2.3),
  'reel-land': () => oneShot('reelLand', 1.4),
  'land-hard': () => oneShot('landHard', 0.8),
  crash: () => oneShot('crash', 1.0),
  hay: () => oneShot('hay', 0.8),
  splash: () => oneShot('splash', 1.2),
  quack: () => oneShot('quack', 0.7),
  chomp: () => oneShot('chomp', 0.8),
  'loop-squeal': () => loopRender('squeal'),
  'loop-gravel': () => loopRender('gravel'),
  'loop-mud': () => loopRender('mud'),
  'music-menu': () => music('menu', 14),
  'music-race': () => music('race', 14),
};

(window as unknown as { renderAll: () => Promise<Record<string, number[]>> }).renderAll = async () => {
  const out: Record<string, number[]> = {};
  for (const [name, job] of Object.entries(jobs)) out[name] = Array.from(await job());
  return out;
};
(window as unknown as { SR: number }).SR = SR;
