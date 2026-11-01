/**
 * Countdown voice slot (Brooks will record his own "3, 2, 1, GO!").
 *
 * HOW TO DROP FILES IN: put audio files named
 *     public/audio/countdown-3.m4a   public/audio/countdown-2.m4a
 *     public/audio/countdown-1.m4a   public/audio/countdown-go.m4a
 * (.m4a/AAC or .mp3 are best for iPad Safari; .wav/.ogg also accepted) and rebuild (`npm run build`).
 * vite.config.ts lists the files present at build time (`__COUNTDOWN_VOICE__`), so the game never
 * requests files that don't exist, and the service worker precaches them for offline play.
 * Any missing clip keeps its synth beep. Keep clips short (< 1 s), mono, trimmed so the word
 * starts immediately. The GO clip plays together with the horn (horn is ducked).
 *
 * Runtime override: `audio.setCountdownVoice({ '3': url, ... })`, or `setCountdownVoice(null)` for beeps.
 */
export type VoiceKey = '3' | '2' | '1' | 'go';
export const VOICE_KEYS: VoiceKey[] = ['3', '2', '1', 'go'];

/** Relative URLs of the countdown clips found in public/audio at build time. */
export function bundledVoiceUrls(): Partial<Record<VoiceKey, string>> {
  const out: Partial<Record<VoiceKey, string>> = {};
  const list = typeof __COUNTDOWN_VOICE__ !== 'undefined' ? __COUNTDOWN_VOICE__ : [];
  for (const file of list) {
    const m = /^countdown-(3|2|1|go)\./i.exec(file);
    // Relative to the page so it works under a GitHub Pages subpath (base: './').
    if (m) out[m[1].toLowerCase() as VoiceKey] = `audio/${file}`;
  }
  return out;
}

/** decodeAudioData with the callback form (older iOS Safari has no promise version). */
export function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

export async function loadVoice(ctx: BaseAudioContext, urls: Partial<Record<VoiceKey, string>>): Promise<Partial<Record<VoiceKey, AudioBuffer>>> {
  const out: Partial<Record<VoiceKey, AudioBuffer>> = {};
  await Promise.all(
    VOICE_KEYS.map(async (k) => {
      const url = urls[k];
      if (!url) return;
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        out[k] = await decode(ctx, await res.arrayBuffer());
      } catch (e) {
        console.warn(`[audio] countdown voice "${k}" could not be loaded, using beep`, e);
      }
    }),
  );
  return out;
}
