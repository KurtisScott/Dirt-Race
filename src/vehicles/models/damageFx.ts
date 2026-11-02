import * as THREE from 'three';
import type { DamageHit } from '../model';

/**
 * Damage visuals for one procedural vehicle (SPEC Round 2 item 2):
 *  - dents: body-panel vertices near the hit are pushed in (with a little crumple noise), capped per vertex;
 *    dented triangles get flat normals so the crease catches the light,
 *  - scratches (bare metal / dark streaks) around each hit and road grime creeping up the paint with damage,
 *  - a cracked windscreen decal (two stages) fitted to the forward-facing glass,
 *  - bumpers that hang loose and then fall off (they stay on the road behind you).
 * Engine smoke lives in fx/ (it reads `vehicle.damage`).
 *
 * Everything edits the vehicle's own geometry in place. The only new GPU resources are the crack overlay
 * (one small geometry per car, created on the first crack and disposed with the car) and two shared crack
 * textures/materials created once for the whole app, so Race Again doesn't leak.
 */

export type BumperEnd = 'front' | 'rear';

interface MeshState {
  mesh: THREE.Mesh;
  orig: Float32Array;
  /** Per-vertex scratch amount (paint only). */
  scratch?: Float32Array;
  origColor?: Float32Array;
  isPaint: boolean;
}

interface Bumper {
  end: BumperEnd;
  pivot: THREE.Group;
  /** Rest pose (body ground space). */
  rest: THREE.Vector3;
  state: 'on' | 'hanging' | 'fallen';
  /** Hanging angle animation. */
  angle: number;
  target: number;
  sway: number;
  // falling (world space)
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  groundY: number;
  resting: boolean;
}

/** Where the loose end of a bumper hangs from: its +X (left) end, so the right end drops. */
const HANG_DEG = 24;
/** Per-vertex dent cap (m). */
const MAX_OFFSET = 0.2;

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const METAL = new THREE.Color(0xb8bdc3);
const PRIMER = new THREE.Color(0x2b2b2b);
const GRIME = new THREE.Color(0x5b4a34);

/** Deterministic hash of a position → [0, 1). Coincident vertices (creased normals) get the same value. */
function hash(x: number, y: number, z: number, k = 0): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 19.19) * 43758.5453;
  return s - Math.floor(s);
}

export class DamageFx {
  private meshes: MeshState[] = [];
  private paint: MeshState | null = null;
  private glass: THREE.Mesh | null;
  private centre = new THREE.Vector3();
  private yMin = 0;
  private yMax = 1;
  private bumpers: Bumper[] = [];
  private hits: Record<BumperEnd, number> = { front: 0, rear: 0 };
  private crack: { mesh: THREE.Mesh; tris: number[] } | null = null;
  private crackStage = 0;
  private fallen: THREE.Object3D[] = [];
  private inited = false;
  private hitDir = new THREE.Vector3();
  private hitP = new THREE.Vector3();

  constructor(
    private body: THREE.Group,
    bumperPivots: Partial<Record<BumperEnd, THREE.Group>>,
    /** World-space ground height under the car right now (lowest wheel bottom). */
    private groundAt: () => number,
  ) {
    this.glass = (body.children.find((o) => o.name === 'glass') as THREE.Mesh | undefined) ?? null;
    for (const end of ['front', 'rear'] as BumperEnd[]) {
      const pivot = bumperPivots[end];
      if (!pivot) continue;
      this.bumpers.push({
        end,
        pivot,
        rest: pivot.position.clone(),
        state: 'on',
        angle: 0,
        target: 0,
        sway: Math.random() * 6,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        groundY: 0,
        resting: false,
      });
    }
  }

  /** Lazily snapshot the original geometry (most cars never get dented). */
  private init(): void {
    if (this.inited) return;
    this.inited = true;
    for (const o of this.body.children) {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.name === 'crack') continue;
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const st: MeshState = { mesh, orig: Float32Array.from(pos.array as Float32Array), isPaint: mesh.name === 'paint' };
      if (st.isPaint) {
        const col = mesh.geometry.attributes.color as THREE.BufferAttribute | undefined;
        if (col) {
          st.origColor = Float32Array.from(col.array as Float32Array);
          st.scratch = new Float32Array(pos.count);
        }
        this.paint = st;
      }
      this.meshes.push(st);
    }
    const box = new THREE.Box3();
    if (this.paint) box.setFromBufferAttribute(this.paint.mesh.geometry.attributes.position as THREE.BufferAttribute);
    else box.setFromObject(this.body);
    box.getCenter(this.centre);
    this.yMin = box.min.y;
    this.yMax = box.max.y;
  }

  /** The body surface point furthest along `dir` (average of the outermost vertices). */
  private supportPoint(dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const src = this.paint ?? this.meshes[0];
    if (!src) return out.copy(this.centre);
    const a = src.orig;
    let best = -Infinity;
    for (let i = 0; i < a.length; i += 3) {
      const d = (a[i] - this.centre.x) * dir.x + (a[i + 1] - this.centre.y) * dir.y + (a[i + 2] - this.centre.z) * dir.z;
      if (d > best) best = d;
    }
    out.set(0, 0, 0);
    let n = 0;
    for (let i = 0; i < a.length; i += 3) {
      const d = (a[i] - this.centre.x) * dir.x + (a[i + 1] - this.centre.y) * dir.y + (a[i + 2] - this.centre.z) * dir.z;
      if (d >= best - 0.08) {
        out.x += a[i];
        out.y += a[i + 1];
        out.z += a[i + 2];
        n++;
      }
    }
    return n ? out.multiplyScalar(1 / n) : out.copy(this.centre);
  }

  apply(hit: DamageHit, total: number): void {
    this.init();
    const dir = this.hitDir.set(hit.dir.x, hit.dir.y, hit.dir.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const amount = Math.max(0, hit.amount);
    const end: BumperEnd = dir.z >= 0 ? 'front' : 'rear';
    if (Math.abs(dir.z) > 0.35) this.hits[end]++;

    // ---- dent
    const P = this.supportPoint(dir, this.hitP);
    const R = Math.min(1.1, 0.45 + amount * 0.025);
    const depth = Math.min(0.15, 0.025 + amount * 0.006);
    for (const st of this.meshes) this.dent(st, P, dir, R, depth, amount);
    this.recolor(total);

    // ---- windscreen
    const stage = total >= 55 ? 2 : total >= 25 ? 1 : 0;
    if (stage > this.crackStage) {
      this.crackStage = stage;
      this.ensureCrack();
      if (this.crack) this.crack.mesh.material = crackMaterial(stage);
    }
    if (this.crack) this.fitCrack();

    // ---- bumpers: the end that gets hit goes first; the other follows when the car is a wreck.
    for (const b of this.bumpers) {
      const hitHere = this.hits[b.end] > 0;
      const hangAt = hitHere ? 30 : 55;
      const fallAt = hitHere ? 62 : 85;
      if (b.state === 'on' && total >= hangAt) {
        b.state = 'hanging';
        b.target = (HANG_DEG * Math.PI) / 180;
      }
      if (b.state === 'hanging' && total >= fallAt) this.drop(b);
    }
  }

  private dent(st: MeshState, P: THREE.Vector3, dir: THREE.Vector3, R: number, depth: number, amount: number): void {
    const geo = st.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const o = st.orig;
    const R2 = R * R;
    let moved = false;
    const touched = new Uint8Array(pos.count / 3);
    for (let i = 0; i < pos.count; i++) {
      const k = i * 3;
      const dx = o[k] - P.x;
      const dy = o[k + 1] - P.y;
      const dz = o[k + 2] - P.z;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 >= R2) continue;
      const f = (1 - r2 / R2) ** 2;
      const h = hash(o[k], o[k + 1], o[k + 2]);
      const push = depth * f * (0.65 + 0.7 * h);
      // Push in along the hit, plus a little sideways crumple.
      const cr = depth * f * 0.35;
      let x = arr[k] - dir.x * push + (hash(o[k], o[k + 1], o[k + 2], 1) - 0.5) * cr;
      let y = arr[k + 1] - dir.y * push + (hash(o[k], o[k + 1], o[k + 2], 2) - 0.5) * cr;
      let z = arr[k + 2] - dir.z * push + (hash(o[k], o[k + 1], o[k + 2], 3) - 0.5) * cr;
      // Cap the total offset so repeated hits crumple rather than collapse the body.
      _v.set(x - o[k], y - o[k + 1], z - o[k + 2]);
      const len = _v.length();
      if (len > MAX_OFFSET) {
        _v.multiplyScalar(MAX_OFFSET / len);
        x = o[k] + _v.x;
        y = o[k + 1] + _v.y;
        z = o[k + 2] + _v.z;
      }
      arr[k] = x;
      arr[k + 1] = y;
      arr[k + 2] = z;
      touched[(i / 3) | 0] = 1;
      moved = true;
      if (st.scratch) {
        // Streaky scratches: bands along the body, strongest at the hit.
        const band = hash(Math.round(o[k + 1] * 22), Math.round(o[k + 2] * 3), 0, 4);
        const s = f * (band > 0.45 ? 0.95 : 0.3) * Math.min(1, 0.35 + amount / 12);
        if (s > st.scratch[i]) st.scratch[i] = s;
      }
    }
    if (!moved) return;
    pos.needsUpdate = true;
    // Flat normals on dented triangles (creases catch the light); the rest keep their smooth normals.
    const nor = geo.attributes.normal as THREE.BufferAttribute | undefined;
    if (nor && !geo.index) {
      const n = nor.array as Float32Array;
      for (let t = 0; t < touched.length; t++) {
        if (!touched[t]) continue;
        const k = t * 9;
        _a.set(arr[k], arr[k + 1], arr[k + 2]);
        _b.set(arr[k + 3], arr[k + 4], arr[k + 5]);
        _c.set(arr[k + 6], arr[k + 7], arr[k + 8]);
        _b.sub(_a);
        _c.sub(_a);
        _b.cross(_c);
        const l = _b.length();
        if (l < 1e-9) continue;
        _b.multiplyScalar(1 / l);
        for (let j = 0; j < 3; j++) {
          n[k + j * 3] = _b.x;
          n[k + j * 3 + 1] = _b.y;
          n[k + j * 3 + 2] = _b.z;
        }
      }
      nor.needsUpdate = true;
    }
    geo.computeBoundingSphere();
  }

  /** Paint colours = original → scratches → road grime that rises with total damage. */
  private recolor(total: number): void {
    const st = this.paint;
    if (!st?.origColor || !st.scratch) return;
    const col = st.mesh.geometry.attributes.color as THREE.BufferAttribute;
    const c = col.array as Float32Array;
    const o = st.origColor;
    const pos = st.orig;
    const d = Math.min(1, total / 100);
    const h = Math.max(0.3, this.yMax - this.yMin);
    for (let i = 0; i < st.scratch.length; i++) {
      const k = i * 3;
      _col.setRGB(o[k], o[k + 1], o[k + 2]);
      const s = st.scratch[i];
      if (s > 0) _col.lerp(hash(pos[k], pos[k + 1], pos[k + 2], 5) < 0.62 ? METAL : PRIMER, s * 0.8);
      // Grime: strongest low on the body, creeping higher as damage grows.
      const rel = (pos[k + 1] - this.yMin) / h;
      const g = d * 0.6 * Math.max(0, Math.min(1, (0.25 + d * 0.5 - rel) / 0.35));
      if (g > 0) _col.lerp(GRIME, g * (0.75 + 0.25 * hash(pos[k], pos[k + 1], pos[k + 2], 6)));
      c[k] = _col.r;
      c[k + 1] = _col.g;
      c[k + 2] = _col.b;
    }
    col.needsUpdate = true;
  }

  // ------------------------------------------------------------------ windscreen

  private ensureCrack(): void {
    if (this.crack || !this.glass) return;
    const pos = this.glass.geometry.attributes.position as THREE.BufferAttribute;
    if (this.glass.geometry.index) return;
    const a = pos.array as Float32Array;
    const tris: number[] = [];
    for (let t = 0; t < pos.count / 3; t++) {
      const k = t * 9;
      _a.set(a[k], a[k + 1], a[k + 2]);
      _b.set(a[k + 3], a[k + 4], a[k + 5]).sub(_a);
      _c.set(a[k + 6], a[k + 7], a[k + 8]).sub(_a);
      _b.cross(_c).normalize();
      const cz = (a[k + 2] + a[k + 5] + a[k + 8]) / 3;
      // Forward-facing glass in the front half = windscreen.
      if (_b.z > 0.4 && cz > this.centre.z - 0.3) tris.push(t);
    }
    if (!tris.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.length * 9), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(tris.length * 6), 2));
    const mesh = new THREE.Mesh(geo, crackMaterial(1));
    mesh.name = 'crack';
    mesh.renderOrder = 2;
    this.body.add(mesh);
    this.crack = { mesh, tris };
  }

  /** Copy the (possibly dented) windscreen triangles, nudged outward, with planar UVs over their extent. */
  private fitCrack(): void {
    const cr = this.crack;
    if (!cr || !this.glass) return;
    const a = (this.glass.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const p = cr.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const uv = cr.mesh.geometry.attributes.uv as THREE.BufferAttribute;
    const pa = p.array as Float32Array;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    cr.tris.forEach((t, j) => {
      const k = t * 9;
      _a.set(a[k], a[k + 1], a[k + 2]);
      _b.set(a[k + 3], a[k + 4], a[k + 5]).sub(_a);
      _c.set(a[k + 6], a[k + 7], a[k + 8]).sub(_a);
      _b.cross(_c).normalize().multiplyScalar(0.008);
      for (let v = 0; v < 3; v++) {
        const x = a[k + v * 3] + _b.x;
        const y = a[k + v * 3 + 1] + _b.y;
        const z = a[k + v * 3 + 2] + _b.z;
        pa.set([x, y, z], j * 9 + v * 3);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    });
    const ua = uv.array as Float32Array;
    for (let i = 0; i < p.count; i++) {
      ua[i * 2] = (pa[i * 3] - x0) / Math.max(0.01, x1 - x0);
      ua[i * 2 + 1] = (pa[i * 3 + 1] - y0) / Math.max(0.01, y1 - y0);
    }
    p.needsUpdate = true;
    uv.needsUpdate = true;
    cr.mesh.geometry.computeBoundingSphere();
  }

  // ------------------------------------------------------------------ bumpers

  private drop(b: Bumper): void {
    const scene = this.sceneRoot();
    b.state = 'fallen';
    if (!scene) {
      b.pivot.visible = false;
      return;
    }
    b.pivot.updateWorldMatrix(true, false);
    _m.copy(b.pivot.matrixWorld);
    b.pivot.removeFromParent();
    _m.decompose(b.pivot.position, b.pivot.quaternion, _s);
    scene.add(b.pivot);
    this.fallen.push(b.pivot);
    // Ground under the car right now (good enough for a second of tumbling on the road).
    b.groundY = this.groundAt();
    b.vel.set((Math.random() - 0.5) * 1.2, 1.2, (Math.random() - 0.5) * 1.2);
    b.spin.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4);
  }

  private sceneRoot(): THREE.Object3D | null {
    let o: THREE.Object3D | null = this.body;
    while (o?.parent) o = o.parent;
    return o && o !== this.body && (o as THREE.Scene).isScene ? o : (this.body.parent?.parent ?? null);
  }

  /** Per frame: swing hanging bumpers, let fallen ones tumble onto the road. */
  update(dt: number, speed: number): void {
    for (const b of this.bumpers) {
      if (b.state === 'hanging') {
        b.angle += (b.target - b.angle) * Math.min(1, dt * 6);
        b.sway += dt * (3 + Math.min(8, Math.abs(speed) * 0.4));
        const wobble = Math.sin(b.sway) * (0.04 + Math.min(0.08, Math.abs(speed) * 0.004));
        b.pivot.rotation.set(0.05, 0, b.angle + wobble);
      } else if (b.state === 'fallen' && !b.resting && b.pivot.parent) {
        b.vel.y -= 9.81 * dt;
        b.pivot.position.addScaledVector(b.vel, dt);
        _q.setFromEuler(new THREE.Euler(b.spin.x * dt, b.spin.y * dt, b.spin.z * dt));
        b.pivot.quaternion.multiply(_q);
        if (b.pivot.position.y <= b.groundY + 0.1) {
          b.pivot.position.y = b.groundY + 0.1;
          b.vel.y = -b.vel.y * 0.25;
          b.vel.x *= 0.5;
          b.vel.z *= 0.5;
          b.spin.multiplyScalar(0.4);
          if (Math.abs(b.vel.y) < 0.6) {
            // Settle lying flat on the road (keep its heading).
            b.resting = true;
            const e = new THREE.Euler().setFromQuaternion(b.pivot.quaternion, 'YXZ');
            b.pivot.rotation.set(0, e.y, 0.06, 'YXZ');
          }
        }
      }
    }
  }

  dispose(): void {
    for (const f of this.fallen) {
      f.removeFromParent();
      f.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
    }
    this.fallen = [];
    if (this.crack) {
      this.crack.mesh.removeFromParent();
      this.crack.mesh.geometry.dispose();
      this.crack = null;
    }
  }
}

// ------------------------------------------------------------------ crack textures (shared, made once)

let crackMats: [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial] | null = null;

/** Shared crack decal material for stage 1 (one star) or 2 (shattered). Never disposed (like the shared vehicle materials). */
export function crackMaterial(stage: number): THREE.MeshBasicMaterial {
  if (!crackMats) {
    const mk = (tex: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        toneMapped: false,
      });
    crackMats = [mk(crackTexture(1)), mk(crackTexture(2))];
    crackMats[0].name = 'crack-1';
    crackMats[1].name = 'crack-2';
  }
  return crackMats[stage >= 2 ? 1 : 0];
}

/** Procedural crack pattern (white lines, alpha) drawn into a DataTexture: works without a canvas. */
function crackTexture(stage: number): THREE.DataTexture {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  let seed = 1234 + stage;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const plot = (x: number, y: number, a: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= S || yi >= S) return;
    const i = (yi * S + xi) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.max(data[i + 3], Math.round(a * 255));
  };
  const line = (x0: number, y0: number, x1: number, y1: number, a: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= n; i++) {
      const t = i / Math.max(1, n);
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      plot(x, y, a);
      plot(x + 1, y, a * 0.45);
      plot(x, y + 1, a * 0.45);
    }
  };
  const star = (cx: number, cy: number, arms: number, len: number) => {
    const rings: [number, number][][] = [];
    for (let k = 0; k < arms; k++) {
      const ang = (k / arms) * Math.PI * 2 + rnd() * 0.5;
      let x = cx;
      let y = cy;
      let a = ang;
      const pts: [number, number][] = [[x, y]];
      const steps = 5 + Math.floor(rnd() * 4);
      for (let s = 0; s < steps; s++) {
        a += (rnd() - 0.5) * 0.6;
        const l = (len / steps) * (0.6 + rnd() * 0.8);
        const nx = x + Math.cos(a) * l;
        const ny = y + Math.sin(a) * l;
        line(x, y, nx, ny, 0.95 - s * 0.06);
        x = nx;
        y = ny;
        pts.push([x, y]);
        // Side branches.
        if (rnd() < 0.35) {
          const ba = a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6);
          line(x, y, x + Math.cos(ba) * l * 0.7, y + Math.sin(ba) * l * 0.7, 0.7);
        }
      }
      rings.push(pts);
    }
    // Concentric cracks joining neighbouring arms.
    for (const r of [1, 2]) {
      for (let k = 0; k < arms; k++) {
        const a = rings[k][Math.min(r, rings[k].length - 1)];
        const b = rings[(k + 1) % arms][Math.min(r, rings[(k + 1) % arms].length - 1)];
        if (rnd() < 0.8) line(a[0], a[1], b[0], b[1], 0.75);
      }
    }
    // Bright impact point.
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 9) plot(cx + dx, cy + dy, 0.9);
  };
  star(S * 0.3, S * 0.55, 9, S * 0.42);
  if (stage >= 2) {
    star(S * 0.72, S * 0.42, 8, S * 0.38);
    star(S * 0.52, S * 0.8, 6, S * 0.25);
    // A frosted haze of tiny cracks.
    for (let i = 0; i < 260; i++) {
      const x = rnd() * S;
      const y = rnd() * S;
      const a = rnd() * Math.PI;
      line(x, y, x + Math.cos(a) * 6, y + Math.sin(a) * 6, 0.35);
    }
  }
  const t = new THREE.DataTexture(data, S, S);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
