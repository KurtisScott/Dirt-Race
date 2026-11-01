// Generates PWA icons from an inline SVG (no downloads). Run: npm run icons
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(out, { recursive: true });

// A chunky truck on a dirt hill under a blue sky. `pad` shrinks the art for maskable safe zone.
const svg = (pad = 0) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f8ae0"/><stop offset="1" stop-color="#bfe0f5"/></linearGradient>
    <linearGradient id="dirt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9824a"/><stop offset="1" stop-color="#7a5230"/></linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#sky)"/>
  <circle cx="400" cy="110" r="48" fill="#fff3b0"/>
  <g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
    <path d="M0 360 Q140 300 260 340 T512 300 V512 H0Z" fill="#6fae45"/>
    <path d="M0 410 Q160 360 300 395 T512 380 V512 H0Z" fill="url(#dirt)"/>
    <g transform="translate(96 230) rotate(-6)">
      <rect x="0" y="60" width="300" height="70" rx="14" fill="#ff7a1a"/>
      <path d="M150 60 L170 10 H255 L285 60Z" fill="#ff7a1a"/>
      <path d="M178 22 H248 L268 58 H166Z" fill="#cfe9ff"/>
      <rect x="0" y="40" width="130" height="24" rx="6" fill="#d65a00"/>
      <rect x="282" y="78" width="22" height="16" rx="4" fill="#fff6c8"/>
      <circle cx="70" cy="135" r="42" fill="#222"/><circle cx="70" cy="135" r="18" fill="#c8ced6"/>
      <circle cx="235" cy="135" r="42" fill="#222"/><circle cx="235" cy="135" r="18" fill="#c8ced6"/>
    </g>
    <text x="256" y="490" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="74" text-anchor="middle" fill="#fff3d6" stroke="#7a3300" stroke-width="6" paint-order="stroke">DIRT RACE</text>
  </g>
</svg>`;

writeFileSync(out + 'icon.svg', svg());
const jobs = [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['apple-touch-icon.png', 180, 0],
  ['icon-maskable-512.png', 512, 56],
];
for (const [name, size, pad] of jobs) {
  await sharp(Buffer.from(svg(pad))).resize(size, size).png({ compressionLevel: 9 }).toFile(out + name);
}
console.log('icons written to public/icons');
