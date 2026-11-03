import * as THREE from 'three';

/**
 * Round 2 photographic-style texture set (High/Ultra), generated at build time by scripts/gen-textures.ts
 * into public/tex/ (WebP, precached by the service worker for offline play):
 *  - terrain albedo + normal/height stacks: 12 layers each (world/course.ts LAYERS order)
 *  - asphalt albedo + normal/height
 *
 * Decoded through a 2D canvas into typed arrays (the most portable path on old iPad Safari: the images
 * are opaque RGB, so there is no premultiplied-alpha loss), then uploaded as DataArrayTextures. The CPU
 * copy is dropped right after the GPU upload.
 */
export const PBR_LAYER_COUNT = 12;

export interface PBRSet {
  size: number;
  albedo: THREE.DataArrayTexture;
  nh: THREE.DataArrayTexture;
  asphaltAlbedo: THREE.DataTexture;
  asphaltNH: THREE.DataTexture;
  dispose(): void;
}

const cache = new Map<number, Promise<PBRSet | null>>();

/** Load (once per size) the texture set; resolves null when unavailable (offline without cache, decode error). */
export function loadPBRSet(size: 512 | 1024, onProgress?: (f: number) => void): Promise<PBRSet | null> {
  let p = cache.get(size);
  if (!p) {
    p = load(size, onProgress).catch((e) => {
      console.warn('[world] PBR textures unavailable, using procedural layers', e);
      cache.delete(size);
      return null;
    });
    cache.set(size, p);
  }
  return p;
}

/** Forget a cached set (after disposing it). */
export function forgetPBRSet(size: number): void {
  cache.delete(size);
}

async function load(size: number, onProgress?: (f: number) => void): Promise<PBRSet> {
  if (typeof document === 'undefined' || typeof fetch !== 'function') throw new Error('no DOM');
  // Normal/height maps stay at 512 px even on Ultra (they are far less visible than albedo; saves ~50 MB of GPU memory).
  const NH = 512;
  const url = (name: string): string => new URL(`tex/${name}-${name.endsWith('-nh') ? NH : size}.webp`, document.baseURI).href;
  const names = ['terrain-albedo', 'terrain-nh', 'asphalt-albedo', 'asphalt-nh'];
  let done = 0;
  const images = await Promise.all(
    names.map(async (n) => {
      const img = await decode(url(n));
      onProgress?.(++done / names.length);
      return img;
    }),
  );
  const [ta, tn, aa, an] = images;
  const albedo = arrayTexture(ta, size, PBR_LAYER_COUNT, true);
  const nh = arrayTexture(tn, NH, PBR_LAYER_COUNT, false);
  const asphaltAlbedo = flatTexture(aa, size, true);
  const asphaltNH = flatTexture(an, NH, false);
  for (const i of images) if ('close' in i) i.close();
  return {
    size,
    albedo,
    nh,
    asphaltAlbedo,
    asphaltNH,
    dispose() {
      albedo.dispose();
      nh.dispose();
      asphaltAlbedo.dispose();
      asphaltNH.dispose();
    },
  };
}

async function decode(href: string): Promise<ImageBitmap | HTMLImageElement> {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`${href}: HTTP ${res.status}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to <img> */
    }
  }
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  return img;
}

type Src = ImageBitmap | HTMLImageElement;

/** Pixels of a rectangle of the image as RGBA bytes. */
function pixels(src: Src, sy: number, w: number, h: number, ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): Uint8ClampedArray {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, 0, sy, w, h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function canvas2d(w: number, h: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('no 2d canvas');
  return ctx;
}

function arrayTexture(src: Src, size: number, layers: number, srgb: boolean): THREE.DataArrayTexture {
  const ctx = canvas2d(size, size);
  const data = new Uint8Array(size * size * 4 * layers);
  for (let l = 0; l < layers; l++) data.set(pixels(src, l * size, size, size, ctx), l * size * size * 4);
  const tex = new THREE.DataArrayTexture(data, size, size, layers);
  setup(tex, srgb);
  return tex;
}

function flatTexture(src: Src, size: number, srgb: boolean): THREE.DataTexture {
  const ctx = canvas2d(size, size);
  const data = new Uint8Array(pixels(src, 0, size, size, ctx));
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  setup(tex, srgb);
  return tex;
}

function setup(tex: THREE.DataTexture | THREE.DataArrayTexture, srgb: boolean): void {
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  // Drop the CPU copy once it's on the GPU (tens of MB on Ultra). Never re-uploaded after that.
  tex.onUpdate = () => {
    (tex.image as { data: Uint8Array | null }).data = null;
    tex.onUpdate = null;
  };
}
