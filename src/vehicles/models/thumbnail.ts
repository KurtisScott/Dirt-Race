import * as THREE from 'three';
import type { VehicleKind } from '../../core/types';
import { VEHICLES, VEHICLE_KINDS } from '../catalog';
import { paramsFromSpec } from '../params';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { look } from '../../core/look';
import { buildVehicleModel } from './build';

export interface VehicleThumbnail {
  kind: VehicleKind;
  paint: number;
  /** PNG data URL (transparent background). */
  url: string;
}

const cache = new Map<string, string>();

/**
 * Renders a 3/4 view of each vehicle to a PNG data URL (for the spin reel). Uses one short-lived
 * WebGL context which is released afterwards, so it costs nothing during the race. Results are cached.
 * Wheels are turned slightly for a lively pose.
 */
export function renderVehicleThumbnails(
  items: { kind: VehicleKind; paint?: number }[] = VEHICLE_KINDS.map((kind) => ({ kind })),
  size = 256,
): VehicleThumbnail[] {
  const todo = items.filter((it) => !cache.has(key(it.kind, it.paint ?? VEHICLES[it.kind].paints[0])));
  if (todo.length) {
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(size * 1.25);
      canvas.height = size;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(canvas.width, canvas.height, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      // Round 2 (High/Ultra): the PBR car materials need an environment to reflect — a soft studio room.
      let envRT: THREE.WebGLRenderTarget | null = null;
      if (look.pbr) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        envRT = pmrem.fromScene(room, 0.04);
        room.dispose();
        pmrem.dispose();
        scene.environment = envRT.texture;
        scene.environmentIntensity = 0.9;
      }
      scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b5a40, look.pbr ? 0.6 : 1.5));
      const sun = new THREE.DirectionalLight(0xfff3dd, 2.6);
      sun.position.set(-4, 7, 6);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xbfd8ff, 0.8);
      fill.position.set(5, 2, -3);
      scene.add(fill);
      // Soft contact shadow.
      const shadowTex = radialTexture();
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
      scene.add(shadow);
      const cam = new THREE.PerspectiveCamera(26, canvas.width / canvas.height, 0.1, 100);
      for (const it of todo) {
        const spec = VEHICLES[it.kind];
        const paint = it.paint ?? spec.paints[0];
        const p = paramsFromSpec(spec);
        const model = buildVehicleModel(spec, paint, p);
        model.wheels[0].rotation.set(0, 0.35, 0, 'YXZ');
        model.wheels[1].rotation.set(0, 0.35, 0, 'YXZ');
        // Sit the model on y = 0.
        const box = new THREE.Box3().setFromObject(model.root);
        model.root.position.y = -box.min.y;
        scene.add(model.root);
        const len = Math.max(spec.size.length, 3.6);
        const h = box.max.y - box.min.y;
        shadow.scale.set(spec.size.width * 1.9, 1, len * 1.25);
        shadow.position.y = 0.005;
        // 3/4 front view from the left-front, framed to the vehicle's size.
        const dist = Math.max(len, h * 1.5) * 1.95;
        cam.position.set(dist * 0.62, h * 0.55 + dist * 0.32, dist * 0.78);
        cam.lookAt(0, h * 0.42, 0);
        renderer.render(scene, cam);
        cache.set(key(it.kind, paint), canvas.toDataURL('image/png'));
        scene.remove(model.root);
        model.dispose();
      }
      shadowTex.dispose();
      envRT?.dispose();
    } catch (err) {
      console.warn('[vehicles] thumbnail render failed', err);
    } finally {
      renderer?.dispose();
      renderer?.forceContextLoss();
    }
  }
  return items.map((it) => {
    const paint = it.paint ?? VEHICLES[it.kind].paints[0];
    return { kind: it.kind, paint, url: cache.get(key(it.kind, paint)) ?? '' };
  });
}

function key(kind: VehicleKind, paint: number): string {
  return `${kind}:${paint}:${look.pbr ? 'pbr' : 'classic'}`;
}

function radialTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  r.addColorStop(0, 'rgba(0,0,0,0.55)');
  r.addColorStop(0.6, 'rgba(0,0,0,0.25)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
