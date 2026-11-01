import * as THREE from 'three';
import type { VehicleParams, VehicleSpec, VehicleState } from './types';

/**
 * Visual model contract. `root` is placed at the chassis collider centre each frame;
 * `wheels[i]` (FL, FR, RL, RR) are positioned/rotated by the vehicle for suspension travel,
 * steering and spin. Each wheel object should be centred on its axle with the axle along local X.
 */
export interface VehicleModel {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  /**
   * Optional: called every frame after the wheels are placed, for extra animation (body lean, brake
   * lights). `state` (optional, added in vehicles M2) is the owning vehicle.
   */
  animate?(dt: number, state?: VehicleState): void;
  dispose(): void;
}

export type ModelBuilder = (spec: VehicleSpec, paint: number, params: VehicleParams) => VehicleModel;

const shared = {
  tyre: new THREE.MeshLambertMaterial({ color: 0x222222 }),
  rim: new THREE.MeshLambertMaterial({ color: 0xbfc5cc }),
  glass: new THREE.MeshLambertMaterial({ color: 0x223344 }),
  dark: new THREE.MeshLambertMaterial({ color: 0x2b2b2b }),
  light: new THREE.MeshBasicMaterial({ color: 0xfff6c8 }),
  tail: new THREE.MeshBasicMaterial({ color: 0xb01818 }),
};

/**
 * Low-poly placeholder (a pickup-ish shape for every kind, scaled to spec.size).
 * TODO(vehicles agent): replace with per-kind procedural models (sports, muscle, pickup, monster,
 * buggy, sedan) using the same VehicleModel contract. Keep each under ~1.5k triangles.
 */
export const buildPlaceholderModel: ModelBuilder = (spec, paint, p) => {
  const root = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.45, metalness: 0.2 });
  const { length: L, width: W, height: H } = spec.size;
  const hy = p.halfExtents.y;

  // Lower body slab
  const lower = new THREE.Mesh(new THREE.BoxGeometry(W, hy * 2, L), body);
  root.add(lower);
  // Cabin
  const cabH = H - hy * 2 - p.wheelRadius * 0.4;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, cabH, L * 0.32), body);
  cab.position.set(0, hy + cabH / 2, L * 0.05);
  root.add(cab);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, cabH * 0.55, L * 0.33), shared.glass);
  glass.position.set(0, hy + cabH * 0.62, L * 0.05);
  root.add(glass);
  // Bed rails (pickup look)
  const rail = new THREE.BoxGeometry(0.08, 0.35, L * 0.36);
  for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(rail, body);
    r.position.set(sx * (W / 2 - 0.04), hy + 0.17, -L * 0.29);
    root.add(r);
  }
  const tailgate = new THREE.Mesh(new THREE.BoxGeometry(W, 0.35, 0.08), body);
  tailgate.position.set(0, hy + 0.17, -L / 2 + 0.04);
  root.add(tailgate);
  // Lights (front = +Z)
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 0.05), shared.light);
    hl.position.set(sx * W * 0.33, hy * 0.4, L / 2 + 0.01);
    root.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.15, 0.05), shared.tail);
    tl.position.set(sx * W * 0.38, hy * 0.4, -L / 2 - 0.01);
    root.add(tl);
  }
  // Bumpers
  for (const sz of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(W * 1.02, 0.18, 0.15), shared.dark);
    b.position.set(0, -hy + 0.1, sz * (L / 2 + 0.05));
    root.add(b);
  }
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });

  // Wheels
  const r = p.wheelRadius;
  const tyreW = Math.max(0.25, r * 0.65);
  const tyreGeo = new THREE.CylinderGeometry(r, r, tyreW, 16).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(r * 0.55, r * 0.55, tyreW + 0.02, 8).rotateZ(Math.PI / 2);
  const wheels: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, shared.tyre);
    tyre.castShadow = true;
    w.add(tyre, new THREE.Mesh(rimGeo, shared.rim));
    root.add(w);
    wheels.push(w);
  }

  return {
    root,
    wheels,
    dispose() {
      body.dispose();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    },
  };
};
