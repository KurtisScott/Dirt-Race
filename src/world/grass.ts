import * as THREE from 'three';
import type { CourseData } from './course';
import { LAYER_SLOTS } from './course';
import { hash2 } from './noise';
import { windTime } from './vegetation';

/**
 * Round 2 (Ultra): real grass blades around the camera. One instanced draw call of small blade clumps
 * scattered on a fixed world-space jittered grid inside a disc ahead of the camera, wherever the terrain
 * is grassy (density from the course's own layer weights, cached in 16 m tiles). The disc is refilled when
 * the camera has moved a few metres; blades shrink away with distance so nothing pops. Wind bends the
 * tips; normals point up so blades light like the ground they grow from.
 */
const SPACING = 0.36; // m between clump sites
const RADIUS = 24; // m
const AHEAD = 12; // disc centre ahead of the camera, m
const TILE = 16; // density cache tile, m

export class GrassField {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private off: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private mat: THREE.MeshStandardMaterial;
  private centre = new THREE.Vector2(1e9, 1e9);
  private tiles = new Map<string, Float32Array>();
  private wts = new Float32Array(LAYER_SLOTS);
  private fwd = new THREE.Vector3();

  constructor(
    private c: CourseData,
    private max: number,
  ) {
    const base = clumpGeometry();
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.attributes.position);
    this.geo.setAttribute('normal', base.attributes.normal);
    this.geo.setAttribute('aTip', base.attributes.aTip);
    this.off = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aOff', this.off);
    this.geo.setAttribute('aCol', this.col);
    this.geo.instanceCount = 0;
    this.mat = makeGrassMaterial();
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'grass-blades';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  /** Refill around the camera when it has moved more than 3 m. */
  update(camera: THREE.Camera): void {
    camera.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    this.fwd.normalize();
    const cx = camera.position.x + this.fwd.x * AHEAD;
    const cz = camera.position.z + this.fwd.z * AHEAD;
    if (Math.hypot(cx - this.centre.x, cz - this.centre.y) < 3) return;
    this.centre.set(cx, cz);
    this.fill(cx, cz);
  }

  /** Grassiness 0..1 at (x, z), bilinear from 2 m samples cached per 16 m tile. */
  private density(x: number, z: number): number {
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    const key = `${tx},${tz}`;
    let t = this.tiles.get(key);
    if (!t) {
      const n = TILE / 2 + 1;
      t = new Float32Array(n * n);
      const c = this.c;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const wx = tx * TILE + i * 2;
          const wz = tz * TILE + j * 2;
          const h = c.heightAt(wx, wz);
          const slope = Math.hypot(c.heightAt(wx + 1, wz) - c.heightAt(wx - 1, wz), c.heightAt(wx, wz + 1) - c.heightAt(wx, wz - 1)) / 2;
          c.layerWeights(wx, wz, h, slope, this.wts);
          const w = this.wts;
          // grass, field (dry), forest floor (sparse); never on roads, sand, snow, rock, mud, river bed.
          t[i + j * n] = Math.max(0, Math.min(1, w[0] * 1.15 + w[7] * 0.9 + w[9] * 0.3 - w[8] * 3 - w[4] * 2 - w[3] * 2));
        }
      if (this.tiles.size > 400) this.tiles.clear();
      this.tiles.set(key, t);
    }
    const n = TILE / 2 + 1;
    const fx = (x - tx * TILE) / 2;
    const fz = (z - tz * TILE) / 2;
    const i = Math.min(n - 2, Math.floor(fx));
    const j = Math.min(n - 2, Math.floor(fz));
    const ax = fx - i;
    const az = fz - j;
    const a = t[i + j * n] * (1 - ax) + t[i + 1 + j * n] * ax;
    const b = t[i + (j + 1) * n] * (1 - ax) + t[i + 1 + (j + 1) * n] * ax;
    return a * (1 - az) + b * az;
  }

  private fill(cx: number, cz: number): void {
    const off = this.off.array as Float32Array;
    const col = this.col.array as Float32Array;
    const g0x = Math.floor((cx - RADIUS) / SPACING);
    const g1x = Math.ceil((cx + RADIUS) / SPACING);
    const g0z = Math.floor((cz - RADIUS) / SPACING);
    const g1z = Math.ceil((cz + RADIUS) / SPACING);
    const r2 = RADIUS * RADIUS;
    let n = 0;
    for (let gz = g0z; gz <= g1z && n < this.max; gz++) {
      for (let gx = g0x; gx <= g1x && n < this.max; gx++) {
        const h1 = hash2(gx, gz, 501);
        const x = (gx + h1) * SPACING;
        const z = (gz + hash2(gx, gz, 502)) * SPACING;
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz > r2) continue;
        const d = this.density(x, z);
        if (d < 0.08 || hash2(gx, gz, 503) > d * 1.15) continue;
        const k = n * 4;
        off[k] = x;
        off[k + 1] = this.c.heightAt(x, z) - 0.02;
        off[k + 2] = z;
        // Packed: floor(size·100)·8 + rotation (rotation < 2π < 8).
        off[k + 3] = Math.floor((0.55 + hash2(gx, gz, 505) * 0.75) * 100) * 8 + hash2(gx, gz, 504) * 6.28;
        // Colour: green with dry/yellow and dark variation (linear RGB).
        const dry = hash2(Math.floor(x / 3), Math.floor(z / 3), 506) * 0.5 + hash2(gx, gz, 507) * 0.5;
        const v = 0.75 + hash2(gx, gz, 508) * 0.5;
        col[n * 3] = (0.075 + dry * 0.09) * v;
        col[n * 3 + 1] = (0.13 + dry * 0.05) * v;
        col[n * 3 + 2] = (0.03 + dry * 0.01) * v;
        n++;
      }
    }
    this.geo.instanceCount = n;
    this.off.needsUpdate = true;
    this.col.needsUpdate = true;
    this.off.addUpdateRange(0, n * 4);
    this.col.addUpdateRange(0, n * 3);
  }

  get count(): number {
    return this.geo.instanceCount;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
  }
}

/** Five tapered, curved blades in a small clump (≈ 0.25–0.5 m tall before per-instance scaling). */
function clumpGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const tip: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < 5; b++) {
    const a = (b / 5) * Math.PI * 2 + hash2(b, 1, 9) * 0.8;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const r = 0.03 + hash2(b, 2, 9) * 0.05;
    const h = 0.28 + hash2(b, 3, 9) * 0.2;
    const lean = 0.08 + hash2(b, 4, 9) * 0.12;
    const w = 0.022;
    const bx = ca * r;
    const bz = sa * r;
    // Blade faces sideways to its lean direction.
    const px = -sa * w;
    const pz = ca * w;
    const base = pos.length / 3;
    const pt = (t: number, side: number): void => {
      const ww = (1 - t) * side;
      pos.push(bx + ca * lean * t * t + px * ww, h * t, bz + sa * lean * t * t + pz * ww);
      tip.push(t);
    };
    pt(0, -1);
    pt(0, 1);
    pt(0.55, -1);
    pt(0.55, 1);
    pt(1, 0);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const n = new Float32Array(pos.length);
  for (let i = 0; i < n.length; i += 3) n[i + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setAttribute('aTip', new THREE.Float32BufferAttribute(tip, 1));
  g.setIndex(idx);
  return g;
}

function makeGrassMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  m.name = 'grass-blades';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windTime;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aOff; attribute vec3 aCol; attribute float aTip;
        uniform float uTime; varying vec3 vGCol;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = position;
        {
          float q = floor(aOff.w / 8.0);
          float rot = aOff.w - q * 8.0;
          float size = q / 100.0;
          float d = distance(aOff.xz, cameraPosition.xz);
          size *= 1.0 - smoothstep(14.0, 24.0, d);
          float c = cos(rot), s = sin(rot);
          transformed.xz = mat2(c, -s, s, c) * transformed.xz;
          transformed *= size;
          float ph = aOff.x * 0.4 + aOff.z * 0.3;
          float gust = 0.55 + 0.45 * sin(uTime * 0.8 + aOff.x * 0.05);
          transformed.xz += vec2(sin(uTime * 2.1 + ph), cos(uTime * 1.7 + ph)) * aTip * aTip * 0.07 * gust * size;
          transformed += aOff.xyz;
          vGCol = aCol * (0.55 + 0.6 * aTip);
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n varying vec3 vGCol;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vGCol;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize( vNormal );');
  };
  m.customProgramCacheKey = () => 'dirt-race-grass-v1';
  return m;
}
