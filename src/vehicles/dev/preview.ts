/**
 * Dev-only vehicle preview (not part of the production build). Open via the dev server at
 * /src/vehicles/dev/preview.html?kind=sports&paint=1&view=34&q=medium. Used by scripts/vehicle-shots.mjs.
 */
import * as THREE from 'three';
import { VEHICLES, VEHICLE_KINDS } from '../catalog';
import { paramsFromSpec } from '../params';
import { buildVehicleModel } from '../models/build';
import { triangleCount } from '../models/kit';
import { renderVehicleThumbnails } from '../models/thumbnail';
import type { VehicleKind } from '../../core/types';
import { updateSettings } from '../../core/settings';

const q = new URLSearchParams(location.search);
const quality = (q.get('q') ?? 'medium') as 'low' | 'medium' | 'high';
updateSettings({ quality });
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = quality !== 'low';
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfe3f0);
scene.fog = new THREE.Fog(0xcfe3f0, 30, 90);
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x5a6b3a, 1.1));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
sun.position.set(-0.45, 0.75, 0.5).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -8;
sc.right = sc.top = 8;
sc.near = 1;
sc.far = 80;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x8a7a5a }));
ground.receiveShadow = true;
scene.add(ground);
const road = new THREE.Mesh(new THREE.PlaneGeometry(9, 200).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x55585c }));
road.position.y = 0.005;
road.receiveShadow = true;
scene.add(road);

const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 300);
const view = q.get('view') ?? '34';
const info = document.getElementById('info')!;

function show(kind: VehicleKind, paintIdx: number, x = 0, z = 0) {
  const spec = VEHICLES[kind];
  const p = paramsFromSpec(spec);
  const m = buildVehicleModel(spec, spec.paints[paintIdx % 3], p);
  // root sits at chassis centre; ground is groundOffset below it.
  const bb = new THREE.Box3().setFromObject(m.root);
  m.root.position.set(x, -bb.min.y, z);
  m.wheels[0].rotation.set(0, 0.3, 0, 'YXZ');
  m.wheels[1].rotation.set(0, 0.3, 0, 'YXZ');
  m.root.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true) : 0));
  scene.add(m.root);
  // ?damage=N: hit the car from a few directions until it reaches N% (dents, cracks, bumpers, grime).
  const dmg = Number(q.get('damage') ?? 0);
  if (dmg > 0) {
    const dirs = [
      { x: 0.15, y: -0.1, z: 1 },
      { x: 1, y: 0, z: 0.3 },
      { x: -0.3, y: 0, z: -1 },
      { x: -1, y: 0.1, z: 0.4 },
      { x: 0.2, y: 0, z: 1 },
    ];
    let total = 0;
    for (let i = 0; total < dmg; i++) {
      const a = Math.min(dmg - total, 14);
      total += a;
      m.applyDamage?.({ dir: dirs[i % dirs.length], amount: a }, total);
    }
    for (let i = 0; i < 120; i++) m.animate?.(1 / 60);
  }
  m.animate?.(0.016);
  const parts: Record<string, number> = {};
  m.root.traverse((o) => {
    const me = o as THREE.Mesh;
    if (!me.isMesh) return;
    const n = me.name || (me.parent && m.wheels.includes(me.parent.parent as THREE.Object3D) ? 'wheel' : me.type);
    parts[n] = (parts[n] ?? 0) + triangleCount(me);
  });
  console.log(kind, JSON.stringify(parts));
  return { m, tris: triangleCount(m.root), calls: m.root.children.length };
}

const kind = (q.get('kind') ?? 'sports') as VehicleKind | 'all' | 'thumbs';
const result: Record<string, number> = {};
if (kind === 'thumbs') {
  const thumbs = renderVehicleThumbnails();
  document.body.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px">' + thumbs.map((t) => `<img src="${t.url}" style="background:#345">`).join('') + '</div>';
} else if (kind === 'all') {
  VEHICLE_KINDS.forEach((k, i) => {
    const r = show(k, i, (i % 4) * 5.2 - 7.8, Math.floor(i / 4) * -9 + 13.5);
    result[k] = r.tris;
  });
  camera.position.set(24, 22, 34);
  camera.lookAt(0, 0.5, 0);
} else {
  const r = show(kind, Number(q.get('paint') ?? 0));
  result[kind] = r.tris;
  const L = Math.max(VEHICLES[kind].size.length, VEHICLES[kind].size.height * 1.6, 4);
  if (view === 'side') camera.position.set(L * 2.4, 1.2, 0);
  else if (view === 'rear') camera.position.set(-L * 1.4, L * 0.7, -L * 1.8);
  else if (view === 'top') camera.position.set(0.01, L * 3, 0);
  else camera.position.set(L * 1.45, L * 0.62, L * 1.75);
  const H = VEHICLES[kind].size.height;
  camera.lookAt(0, kind === 'monster' ? 1.3 : Math.max(0.65, H * 0.45), 0);
}
info.textContent = Object.entries(result).map(([k, t]) => `${k}: ${t} tris`).join('  ');
renderer.render(scene, camera);
renderer.render(scene, camera);
(window as unknown as { __preview: unknown }).__preview = { result, done: true };
