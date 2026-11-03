import * as THREE from 'three';
import { events } from '../core/events';
import { Group, groups, RAPIER, type PhysicsWorld } from '../core/physics';
import type { RacerId } from '../core/types';
import type { CourseData, Placement } from './course';

/**
 * Dynamic debris (hay bales, cones) drawn with one InstancedMesh per kind, plus fixed boulders and fallen
 * logs (their visuals are merged into the course props). Debris sleeps until hit; only awake bodies update
 * their instance matrix. Emits 'obstacle:hit' (kind 'hay bale' / 'cone' / 'boulder' / 'log') when a vehicle hits one.
 */
interface Debris {
  body: RAPIER.RigidBody;
  home: THREE.Matrix4;
  homePos: THREE.Vector3;
  homeQuat: THREE.Quaternion;
  mesh: THREE.InstancedMesh;
  i: number;
  kind: string;
  lastHit: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

export class Obstacles {
  readonly group = new THREE.Group();
  private debris: Debris[] = [];
  private byHandle = new Map<number, Debris | { kind: string; pos: THREE.Vector3; lastHit: number }>();
  private hay!: THREE.InstancedMesh;
  private cones!: THREE.InstancedMesh;
  private time = 0;
  private offCollision: () => void;
  private vehicleRacer: (handle: number) => RacerId | null;

  constructor(
    private physics: PhysicsWorld,
    private c: CourseData,
  ) {
    this.vehicleRacer = (h) => {
      const t = physics.getTag(h);
      return t?.kind === 'vehicle' ? (t.racer as RacerId) : null;
    };
    this.buildHay(c.hay);
    this.buildCones(c.cones);
    this.buildBoulders(c.boulders);
    this.buildLogs();
    this.offCollision = physics.onCollision((h1, h2, started) => {
      if (!started) return;
      const r1 = this.vehicleRacer(h1);
      const r2 = this.vehicleRacer(h2);
      const racer = r1 ?? r2;
      if (!racer) return;
      const other = r1 ? h2 : h1;
      const d = this.byHandle.get(other);
      if (!d || this.time - d.lastHit < 0.6) return;
      d.lastHit = this.time;
      const pos = 'body' in d ? d.body.translation() : d.pos;
      events.emit('obstacle:hit', { kind: d.kind, racer, x: pos.x, y: pos.y, z: pos.z });
    });
  }

  private addDebris(mesh: THREE.InstancedMesh, i: number, kind: string, p: THREE.Vector3, q: THREE.Quaternion, col: RAPIER.ColliderDesc, mass: number): void {
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(q).setLinearDamping(0.4).setAngularDamping(0.8).setCanSleep(true).setSleeping(true),
    );
    const collider = this.physics.world.createCollider(
      col
        .setMass(mass)
        .setFriction(0.8)
        .setRestitution(0.1)
        .setCollisionGroups(groups(Group.DEBRIS, Group.GROUND | Group.STATIC | Group.VEHICLE | Group.DEBRIS | Group.ANIMAL))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    this.physics.tag(collider, { kind: 'debris', name: kind });
    const d: Debris = { body, home: new THREE.Matrix4().compose(p, q, _s), homePos: p.clone(), homeQuat: q.clone(), mesh, i, kind, lastHit: -9 };
    this.byHandle.set(collider.handle, d);
    this.debris.push(d);
    mesh.setMatrixAt(i, d.home);
  }

  private buildHay(list: Placement[]): void {
    // Round bale lying on its side (axis across), with darker end caps via vertex colours.
    const geo = new THREE.CylinderGeometry(0.65, 0.65, 1.2, 12, 1).rotateZ(Math.PI / 2);
    const cols = new Float32Array(geo.attributes.position.count * 3);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const end = Math.abs(pos.getX(i)) > 0.59 && Math.hypot(pos.getY(i), pos.getZ(i)) < 0.64;
      const c = new THREE.Color(end ? 0xc9a446 : 0xe3c463);
      cols.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.hay = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    this.hay.castShadow = true;
    this.hay.userData.surface = 'hay';
    this.hay.receiveShadow = true;
    this.hay.count = list.length;
    list.forEach((pl, i) => {
      // v = 1 → stacked on top of the previous two.
      const stacked = pl.v === 1;
      const p = new THREE.Vector3(pl.x, pl.y + 0.66 + (stacked ? 1.2 : 0), pl.z);
      if (stacked && i >= 2) {
        const a = list[i - 1];
        const b = list[i - 2];
        p.set((a.x + b.x) / 2, Math.max(a.y, b.y) + 0.66 + 1.1, (a.z + b.z) / 2);
      }
      const q = new THREE.Quaternion().setFromAxisAngle(UP, pl.yaw);
      const qc = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      this.addDebris(this.hay, i, 'hay bale', p, q, RAPIER.ColliderDesc.cylinder(0.6, 0.65).setRotation(qc), 45);
    });
    this.hay.instanceMatrix.needsUpdate = true;
    this.hay.computeBoundingSphere();
    this.hay.frustumCulled = false;
    this.group.add(this.hay);
  }

  private buildCones(list: Placement[]): void {
    const cone = new THREE.ConeGeometry(0.22, 0.75, 10).translate(0, 0.375 + 0.03, 0);
    const base = new THREE.BoxGeometry(0.5, 0.06, 0.5).translate(0, 0.03, 0);
    const band = new THREE.CylinderGeometry(0.13, 0.16, 0.12, 10).translate(0, 0.42, 0);
    const parts = [
      [cone, 0xff6a14],
      [base, 0xe35a10],
      [band, 0xf4f4f4],
    ] as const;
    const geos = parts.map(([g, c]) => {
      const n = g.attributes.position.count;
      const col = new THREE.Color(c);
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
      const gg = g.index ? g.toNonIndexed() : g;
      gg.setAttribute('color', new THREE.BufferAttribute(arr.slice(0, gg.attributes.position.count * 3), 3));
      if (g.index) {
        const arr2 = new Float32Array(gg.attributes.position.count * 3);
        for (let i = 0; i < gg.attributes.position.count; i++) arr2.set([col.r, col.g, col.b], i * 3);
        gg.setAttribute('color', new THREE.BufferAttribute(arr2, 3));
      }
      gg.deleteAttribute('uv');
      return gg;
    });
    const merged = mergeSimple(geos);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.cones = new THREE.InstancedMesh(merged, mat, Math.max(1, list.length));
    this.cones.castShadow = true;
    this.cones.userData.surface = 'plastic';
    this.cones.count = list.length;
    list.forEach((pl, i) => {
      const p = new THREE.Vector3(pl.x, pl.y + 0.02, pl.z);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, pl.yaw);
      // Collider: cone with a low centre so it tips and rolls convincingly.
      this.addDebris(this.cones, i, 'cone', p, q, RAPIER.ColliderDesc.cone(0.4, 0.24).setTranslation(0, 0.4, 0), 4);
    });
    this.cones.instanceMatrix.needsUpdate = true;
    this.cones.frustumCulled = false;
    this.group.add(this.cones);
  }

  private buildBoulders(list: Placement[]): void {
    // Physics: ball colliders for boulders near the road only (far ones are scenery).
    const fixed = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const b of list) {
      const f = this.c.fieldsAt(b.x, b.z);
      if (f.d > this.c.halfWidthAt(f.s) + 30) continue;
      const r = 1.05 * b.scale;
      const col = this.physics.world.createCollider(
        RAPIER.ColliderDesc.ball(r)
          .setTranslation(b.x, b.y + r * 0.35 - 0.2, b.z)
          .setFriction(0.6)
          .setCollisionGroups(groups(Group.STATIC, 0xffff))
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        fixed,
      );
      this.physics.tag(col, { kind: 'static', name: 'boulder' });
      this.byHandle.set(col.handle, { kind: 'boulder', pos: new THREE.Vector3(b.x, b.y, b.z), lastHit: -9 });
    }
  }

  private buildLogs(): void {
    const fixed = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    for (const l of this.c.logs) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, l.yaw).multiply(qz);
      const col = this.physics.world.createCollider(
        RAPIER.ColliderDesc.cylinder(l.length / 2, l.radius)
          .setTranslation(l.x, l.y + l.radius * 0.85, l.z)
          .setRotation(q)
          .setFriction(0.5)
          .setCollisionGroups(groups(Group.STATIC, 0xffff))
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        fixed,
      );
      this.physics.tag(col, { kind: 'static', name: 'log' });
      this.byHandle.set(col.handle, { kind: 'log', pos: new THREE.Vector3(l.x, l.y, l.z), lastHit: -9 });
    }
  }

  /** Put every bale & cone back where it started (race restart). */
  reset(): void {
    for (const d of this.debris) {
      d.body.setTranslation(d.homePos, false);
      d.body.setRotation(d.homeQuat, false);
      d.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      d.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      d.body.sleep();
      d.mesh.setMatrixAt(d.i, d.home);
    }
    this.hay.instanceMatrix.needsUpdate = true;
    this.cones.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.time += dt;
    let hay = false;
    let cone = false;
    for (const d of this.debris) {
      if (d.body.isSleeping()) continue;
      const t = d.body.translation();
      // Fell out of the world somehow: send it home quietly.
      if (t.y < -30) {
        d.body.setTranslation(d.homePos, false);
        d.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        continue;
      }
      const r = d.body.rotation();
      _m.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s);
      d.mesh.setMatrixAt(d.i, _m);
      if (d.mesh === this.hay) hay = true;
      else cone = true;
    }
    if (hay) this.hay.instanceMatrix.needsUpdate = true;
    if (cone) this.cones.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.offCollision();
    for (const d of this.debris) this.physics.removeBody(d.body);
    this.hay.geometry.dispose();
    this.cones.geometry.dispose();
  }
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nrm.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}
