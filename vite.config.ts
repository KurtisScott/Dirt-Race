import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Countdown voice clips Brooks records (public/audio/countdown-{3,2,1,go}.{m4a,mp3,wav,ogg}).
// Listed at build time so the game never probes for missing files at runtime (see src/audio/voice.ts).
const voiceDir = new URL('./public/audio/', import.meta.url);
const countdownVoice = existsSync(voiceDir) ? readdirSync(voiceDir).filter((f) => /^countdown-(3|2|1|go)\.(m4a|mp3|wav|ogg|aac)$/i.test(f)) : [];

export default defineConfig({
  // Relative base so the build works under any GitHub Pages subpath (e.g. /dirt-race/).
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COUNTDOWN_VOICE__: JSON.stringify(countdownVoice),
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    // Rapier's -compat build inlines its WASM as base64 (~4.7 MB raw, ~1.8 MB gzip). Splitting vendors
    // into their own chunks means a game-code update doesn't re-download physics/three.
    chunkSizeWarningLimit: 5000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge/ },
            { name: 'three', test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
  },
  server: { host: true },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Dirt Race',
        short_name: 'Dirt Race',
        description: 'Tilt-to-steer 3D racing for iPad',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'landscape',
        background_color: '#2b6cb0',
        theme_color: '#2b6cb0',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache everything the build emits, including the Rapier WASM (inlined in JS by -compat) and future audio/textures.
        globPatterns: ['**/*.{js,css,html,svg,png,webp,jpg,wasm,mp3,m4a,ogg,wav,aac,json,glb,bin,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
      devOptions: { enabled: false },
    }),
  ],
});
