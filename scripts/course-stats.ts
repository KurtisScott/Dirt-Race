/**
 * Course build stats (headless): CourseData / RaceCourse build time, grid size, memory of the big arrays,
 * scene meshes/triangles, colliders, zone lengths. Run: npx tsx scripts/course-stats.ts
 */
import * as THREE from 'three';
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { initRapier, PhysicsWorld } = await import('../src/core/physics');
const { CourseData } = await import('../src/world/course');
const { RaceCourse } = await import('../src/world/raceCourse');
await initRapier();
const runs: number[][] = [];
let last: InstanceType<typeof RaceCourse> | null = null;
let scene = new THREE.Scene();
let physics = new PhysicsWorld();
for (let k = 0; k < 3; k++) {
  if (last) {
    last.dispose();
    physics.dispose();
  }
  physics = new PhysicsWorld();
  scene = new THREE.Scene();
  const t0 = performance.now();
  const data = new CourseData();
  const t1 = performance.now();
  const ctx = { physics, renderer: { scene }, quality: { preset: { textureSize: 512, detail: 0.75, level: 'medium' } } } as never;
  last = new RaceCourse(ctx, data);
  const t2 = performance.now();
  runs.push([t1 - t0, t2 - t1]);
}
const c = last!.data;
const best = runs.reduce((a, b) => (a[0] + a[1] < b[0] + b[1] ? a : b));
console.log(`build: CourseData ${best[0].toFixed(0)} ms + RaceCourse ${best[1].toFixed(0)} ms = ${(best[0] + best[1]).toFixed(0)} ms (best of 3, Node)`);
console.log(`course length ${c.length.toFixed(0)} m, finish ${c.finishS.toFixed(0)} m; grid ${c.NX}×${c.NZ} = ${((c.NX * c.NZ) / 1000).toFixed(0)}k nodes (${((c.NX - 1) * 2).toFixed(0)}×${((c.NZ - 1) * 2).toFixed(0)} m)`);
const gridMB = (c.NX * c.NZ * 16) / 1e6;
console.log(`grid arrays ~${gridMB.toFixed(1)} MB (+ 1 m surface map ~${((c.NX * c.NZ * 4) / 1e6).toFixed(1)} MB)`);
let meshes = 0;
let tris = 0;
let terrainTris = 0;
let gpuBytes = 0;
scene.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  meshes++;
  const gg = m.geometry;
  const n = gg.index ? gg.index.count / 3 : gg.attributes.position.count / 3;
  const t = n * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  tris += t;
  let inTerrain = false;
  for (let p: THREE.Object3D | null = m; p; p = p.parent) if (p.name === 'terrain') inTerrain = true;
  if (inTerrain) terrainTris += t;
  for (const a of Object.values(gg.attributes)) gpuBytes += (a as THREE.BufferAttribute).array.byteLength;
  if (gg.index) gpuBytes += gg.index.array.byteLength;
});
let colliders = 0;
physics.world.forEachCollider(() => colliders++);
console.log(`scene: ${meshes} meshes, ${(tris / 1000).toFixed(0)}k triangles (terrain ${(terrainTris / 1000).toFixed(0)}k), vertex+index buffers ${(gpuBytes / 1e6).toFixed(1)} MB, colliders ${colliders}`);
console.log('zones: ' + c.zones.map((z) => `${z.id} ${(z.endS - z.startS).toFixed(0)}`).join(', '));
const mem = process.memoryUsage();
console.log(`node heap ${(mem.heapUsed / 1e6).toFixed(0)} MB, rss ${(mem.rss / 1e6).toFixed(0)} MB`);
process.exit(0);
