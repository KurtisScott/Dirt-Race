import * as THREE from 'three';
import { events } from '../core/events';
import { Group, groups, RAPIER, type PhysicsWorld } from '../core/physics';
import { rng } from '../core/math';
import type { RacerId } from '../core/types';
import type { AnimalSpot, CourseData } from './course';
import { paint } from './props';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Animals (SPEC, requested by Brooks): rare (4–6 per race on the 5 km course), zone-matched, cross the road
 * ahead of the leading car, bump cars rather than stop them, and scamper off on contact — never hurt.
 * Big ones (bear, moose, bull, boar, croc) are "damaging": their `animal:bump` carries `damaging: true`
 * and the relative impact speed, and the vehicles' damage system decides what that costs the car.
 *
 * Physics: each animal is a light DYNAMIC capsule with rotations locked (rabbit 3 kg … bull 250 kg vs.
 * cars 1–2 t). We steer it by setting its horizontal velocity, so a car simply shoves it aside (a bump for
 * the car, a tumble-free "boing" for the animal). Wheel rays don't hit ANIMAL, so cars never drive up onto them.
 */
export type AnimalKind = AnimalSpot['kind'];

/** What the AI/other modules may read about an animal (also on `world.animals`). */
export interface AnimalInfo {
  readonly kind: AnimalKind;
  /** Current position (ground level). */
  readonly position: THREE.Vector3;
  /** Rough radius for avoidance (m). */
  readonly radius: number;
  /** Currently on/near the course (false = hidden & parked). */
  readonly active: boolean;
  /** Horizontal velocity (m/s). */
  readonly velocity: THREE.Vector3;
  /** Big animal: hitting it damages the car. */
  readonly damaging: boolean;
}

interface Spec {
  mass: number;
  radius: number;
  halfHeight: number;
  /** Dash speed (m/s). */
  speed: number;
  /** Stride frequency per m/s. */
  stride: number;
  count: number;
  /** Damages the car on contact (SPEC round 2: bear, moose, bull, boar, crocodile). */
  damaging: boolean;
}

export const ANIMAL_SPECS: Record<AnimalKind, Spec> = {
  deer: { mass: 70, radius: 0.45, halfHeight: 0.5, speed: 7.5, stride: 0.9, count: 1, damaging: false },
  bear: { mass: 160, radius: 0.65, halfHeight: 0.35, speed: 4.5, stride: 1.1, count: 1, damaging: true },
  mouse: { mass: 6, radius: 0.22, halfHeight: 0.05, speed: 3.6, stride: 3.0, count: 1, damaging: false },
  duck: { mass: 3, radius: 0.22, halfHeight: 0.1, speed: 1.6, stride: 3.5, count: 4, damaging: false },
  croc: { mass: 120, radius: 0.45, halfHeight: 0.9, speed: 2.4, stride: 1.4, count: 1, damaging: true },
  moose: { mass: 220, radius: 0.6, halfHeight: 0.75, speed: 5.5, stride: 0.75, count: 1, damaging: true },
  boar: { mass: 80, radius: 0.4, halfHeight: 0.25, speed: 6, stride: 1.7, count: 1, damaging: true },
  bull: { mass: 250, radius: 0.65, halfHeight: 0.45, speed: 4.5, stride: 0.95, count: 1, damaging: true },
  cow: { mass: 200, radius: 0.6, halfHeight: 0.45, speed: 2.6, stride: 0.95, count: 2, damaging: false },
  goat: { mass: 40, radius: 0.32, halfHeight: 0.25, speed: 6, stride: 1.8, count: 2, damaging: false },
  rabbit: { mass: 3, radius: 0.2, halfHeight: 0.05, speed: 6.5, stride: 2.2, count: 2, damaging: false },
  camel: { mass: 220, radius: 0.6, halfHeight: 0.8, speed: 3.6, stride: 0.7, count: 1, damaging: false },
};
const SPECS = ANIMAL_SPECS;
/** Encounters per race (SPEC round 2: about 4–6 on the 5 km course), and at most this many damaging ones. */
const MIN_CROSSINGS = 4;
const MAX_CROSSINGS = 6;
const MAX_DAMAGING = 2;
/** Crossings are at least this far apart along the course (m). */
const MIN_GAP_M = 300;

type State = 'parked' | 'waiting' | 'crossing' | 'leaving' | 'fleeing';

class Animal implements AnimalInfo {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly radius: number;
  state: State = 'parked';
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  model: AnimalModel;
  /** Path: from → to across the road (world xz), heading. */
  from = new THREE.Vector2();
  to = new THREE.Vector2();
  /** Delay before this one follows the leader (ducklings). */
  delay = 0;
  phase = Math.random() * 6;
  freeT = 0;
  stateT = 0;
  spotS = 0;
  heading = 0;
  lastBump = -9;
  readonly damaging: boolean;
  constructor(
    readonly kind: AnimalKind,
    readonly spec: Spec,
    physics: PhysicsWorld,
    parent: THREE.Object3D,
  ) {
    this.radius = spec.radius * (kind === 'croc' ? 2.2 : 1.4);
    this.damaging = spec.damaging;
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -200, 0).lockRotations().setLinearDamping(0.5).setCanSleep(false).setEnabled(false),
    );
    // Croc capsule lies along Z (it's long and low).
    const desc = RAPIER.ColliderDesc.capsule(spec.halfHeight, spec.radius);
    if (kind === 'croc') desc.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    this.collider = physics.world.createCollider(
      desc
        .setMass(spec.mass)
        .setFriction(0.2)
        .setRestitution(0.3)
        .setCollisionGroups(groups(Group.ANIMAL, Group.GROUND | Group.STATIC | Group.VEHICLE | Group.DEBRIS))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    physics.tag(this.collider, { kind: 'animal', name: kind });
    this.model = buildAnimalModel(kind);
    this.model.root.visible = false;
    parent.add(this.model.root);
  }
  get active(): boolean {
    return this.state !== 'parked';
  }
  /** Offset of the body centre above the ground. */
  get lift(): number {
    return this.kind === 'croc' ? this.spec.radius : this.spec.halfHeight + this.spec.radius;
  }
}

export class Animals {
  readonly group = new THREE.Group();
  readonly list: Animal[] = [];
  private byKind = new Map<AnimalKind, Animal[]>();
  private byHandle = new Map<number, Animal>();
  private plan: { spot: AnimalSpot; side: number; done: boolean; animals: Animal[] }[] = [];
  private rand = rng(Date.now() & 0xffff);
  private time = 0;
  private racers: { racer: RacerId; body: RAPIER.RigidBody; s: number }[] = [];
  private scanT = 0;
  private offCollision: () => void;
  /** Turn crossings off (e.g. free drive / tests). Defaults on. */
  enabled = true;

  constructor(
    private physics: PhysicsWorld,
    private c: CourseData,
  ) {
    for (const k of Object.keys(SPECS) as AnimalKind[]) {
      const arr: Animal[] = [];
      for (let i = 0; i < SPECS[k].count; i++) {
        const a = new Animal(k, SPECS[k], physics, this.group);
        arr.push(a);
        this.list.push(a);
        this.byHandle.set(a.collider.handle, a);
      }
      this.byKind.set(k, arr);
    }
    this.offCollision = physics.onCollision((h1, h2, started) => {
      if (!started) return;
      const a = this.byHandle.get(h1) ?? this.byHandle.get(h2);
      if (!a) return;
      const other = physics.getTag(this.byHandle.has(h1) ? h2 : h1);
      if (other?.kind !== 'vehicle') return;
      if (this.time - a.lastBump < 1) return;
      a.lastBump = this.time;
      // Relative horizontal impact speed (car vs animal) at first contact.
      // `a.velocity` is the animal's velocity before this physics step (after the step it has already been shoved).
      const car = physics.world.getCollider(this.byHandle.has(h1) ? h2 : h1)?.parent();
      const cv = car?.linvel() ?? { x: 0, y: 0, z: 0 };
      const speed = Math.hypot(cv.x - a.velocity.x, cv.z - a.velocity.z);
      events.emit('animal:bump', { kind: a.kind, racer: other.racer as RacerId, x: a.position.x, z: a.position.z, damaging: a.damaging, speed });
      this.flee(a);
    });
    this.reset();
  }

  /** New race: pick 4–6 crossings from the zone-matched spots, park everything. */
  reset(seed?: number): void {
    if (seed !== undefined) this.rand = rng(seed);
    for (const a of this.list) this.park(a);
    const spots = [...this.c.animalSpots];
    // Shuffle, then take 4–6 that are well apart, use different animals and at most two big (damaging) ones.
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const want = MIN_CROSSINGS + Math.floor(this.rand() * (MAX_CROSSINGS - MIN_CROSSINGS + 1));
    const chosen: AnimalSpot[] = [];
    for (const sp of spots) {
      if (chosen.length >= want) break;
      if (chosen.some((c) => Math.abs(c.s - sp.s) < MIN_GAP_M || c.kind === sp.kind)) continue;
      if (SPECS[sp.kind].damaging && chosen.filter((c) => SPECS[c.kind].damaging).length >= MAX_DAMAGING) continue;
      chosen.push(sp);
    }
    chosen.sort((a, b) => a.s - b.s);
    this.plan = chosen.map((spot) => ({
      spot: { ...spot, s: spot.s + (this.rand() - 0.5) * 40 },
      side: this.rand() < 0.5 ? -1 : 1,
      done: false,
      animals: this.byKind.get(spot.kind)!,
    }));
  }

  /** Which crossings are planned this race (for tests/debug). */
  get planned(): readonly { kind: AnimalKind; s: number }[] {
    return this.plan.map((p) => ({ kind: p.spot.kind, s: p.spot.s }));
  }

  private park(a: Animal): void {
    a.state = 'parked';
    a.body.setEnabled(false);
    a.body.setTranslation({ x: 0, y: -200, z: 0 }, false);
    a.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    a.model.root.visible = false;
    a.position.set(0, -200, 0);
    a.velocity.set(0, 0, 0);
  }

  private flee(a: Animal): void {
    if (a.state === 'parked') return;
    a.state = 'fleeing';
    a.stateT = 0;
    a.freeT = 0.5; // let the bump play out physically before steering again
    // Run away from the road on whichever side is closer.
    const f = this.c.fieldsAt(a.position.x, a.position.z);
    const sp = this.c.spawnAt(f.s, 0);
    const side = f.lat >= 0 ? 1 : -1;
    const tx = -Math.cos(sp.yaw) * side; // right of travel = (−tz, tx) with t = (sin yaw, cos yaw)
    const tz = Math.sin(sp.yaw) * side;
    a.to.set(a.position.x + tx * 30, a.position.z + tz * 30);
  }

  private findRacers(): void {
    this.racers = [];
    this.physics.world.forEachCollider((col) => {
      const t = this.physics.getTag(col.handle);
      if (t?.kind !== 'vehicle') return;
      const body = col.parent();
      if (!body || this.racers.some((r) => r.body.handle === body.handle)) return;
      this.racers.push({ racer: t.racer as RacerId, body, s: 0 });
    });
  }

  fixedUpdate(dt: number): void {
    this.time += dt;
    this.scanT -= dt;
    if (this.scanT <= 0 || this.racers.some((r) => !this.physics.world.bodies.contains(r.body.handle))) {
      this.findRacers();
      this.scanT = 1;
    }
    // Leading car's progress and speed.
    let leadS = -Infinity;
    let leadV = 0;
    for (const r of this.racers) {
      const t = r.body.translation();
      r.s = this.c.track.project(new THREE.Vector3(t.x, t.y, t.z), r.s || undefined).s;
      if (r.s > leadS) {
        leadS = r.s;
        const v = r.body.linvel();
        leadV = Math.hypot(v.x, v.z);
      }
    }
    if (this.enabled && this.racers.length) {
      for (const p of this.plan) {
        if (p.done) continue;
        const gap = p.spot.s - leadS;
        if (gap < 140 && gap > 30 && p.animals[0].state === 'parked') this.stage(p);
        if (gap < -60) p.done = true;
        const lead = p.animals[0];
        // Dash when the car is ~2.4 s away (never closer than 22 m, so it's always avoidable).
        if (lead.state === 'waiting' && gap < Math.max(22, leadV * 2.4 + 8)) {
          for (const a of p.animals) {
            a.state = 'crossing';
            a.stateT = 0;
          }
          events.emit('animal:crossing', { kind: lead.kind, x: lead.position.x, z: lead.position.z });
        }
      }
    }
    for (const a of this.list) this.step(a, dt, leadS);
  }

  private stage(p: { spot: AnimalSpot; side: number; animals: Animal[] }): void {
    const s = p.spot.s;
    const hw = this.c.halfWidthAt(s);
    const start = this.c.spawnAt(s, p.side * (hw + 6));
    const end = this.c.spawnAt(s + 6, -p.side * (hw + 30));
    const herd = p.animals[0].kind === 'cow' || p.animals[0].kind === 'goat';
    p.animals.forEach((a, i) => {
      const back = i * (herd ? 2.4 : 0.9);
      const lat = p.side * (hw + 6 + back);
      const sp = this.c.spawnAt(s - i * 0.4, lat);
      a.from.set(sp.x, sp.z);
      a.to.set(end.x - (start.x - sp.x), end.z - (start.z - sp.z));
      a.delay = i * (herd ? 0.9 : 0.45);
      a.state = 'waiting';
      a.stateT = 0;
      a.freeT = 0;
      a.body.setEnabled(true);
      a.body.setTranslation({ x: sp.x, y: sp.y + a.lift + 0.05, z: sp.z }, true);
      a.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      a.heading = Math.atan2(a.to.x - sp.x, a.to.y - sp.z);
      a.model.root.visible = true;
      a.position.set(sp.x, sp.y, sp.z);
    });
  }

  private step(a: Animal, dt: number, leadS: number): void {
    if (a.state === 'parked') return;
    a.stateT += dt;
    const t = a.body.translation();
    const groundY = this.c.heightAt(t.x, t.z);
    a.position.set(t.x, Math.max(groundY, t.y - a.lift), t.z);
    // Safety: fell through / thrown far: park.
    if (t.y < groundY - 3 || a.stateT > 40) return this.park(a);
    // Despawn once the cars are well past and it's off the road.
    const f = this.c.fieldsAt(t.x, t.z);
    if ((a.state === 'leaving' || a.state === 'fleeing') && (leadS - f.s > 50 || a.stateT > 12) && f.d > this.c.halfWidthAt(f.s) + 8) return this.park(a);

    let speed = 0;
    if (a.state === 'waiting') {
      // Graze/fidget on the verge.
      speed = 0;
      a.heading += Math.sin(this.time * 0.7 + a.phase) * 0.004;
    } else if (a.state === 'crossing' || a.state === 'leaving' || a.state === 'fleeing') {
      if (a.state === 'crossing' && a.stateT < a.delay) speed = 0;
      else {
        const dx = a.to.x - t.x;
        const dz = a.to.y - t.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.5) return this.park(a);
        const want = Math.atan2(dx, dz);
        let dh = want - a.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        a.heading += THREE.MathUtils.clamp(dh, -6 * dt, 6 * dt);
        speed = a.spec.speed * (a.state === 'fleeing' ? 1.35 : 1);
        if (a.state === 'crossing' && f.d > this.c.halfWidthAt(f.s) + 4 && a.stateT > 2) a.state = 'leaving';
      }
    }
    // A car right on top of it: let physics push it around rather than steering it into the car (a
    // velocity-driven body would act like a wall and stop the car).
    for (const r of this.racers) {
      const p = r.body.translation();
      if ((p.x - t.x) ** 2 + (p.z - t.z) ** 2 < (a.radius + 3) ** 2) a.freeT = Math.max(a.freeT, 0.25);
    }
    if (a.freeT > 0) a.freeT -= dt;
    else {
      const v = a.body.linvel();
      const vx = Math.sin(a.heading) * speed;
      const vz = Math.cos(a.heading) * speed;
      // Snap gently to the terrain so it never floats off crests.
      const vy = t.y - a.lift > groundY + 0.3 ? v.y : Math.min(v.y, 0) + (groundY + a.lift - t.y) * 4;
      a.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    }
    const v = a.body.linvel();
    a.velocity.set(v.x, 0, v.z);
  }

  update(dt: number): void {
    for (const a of this.list) {
      if (a.state === 'parked') continue;
      const sp = a.velocity.length();
      a.phase += dt * (sp * a.spec.stride + (sp < 0.2 ? 0.8 : 0));
      a.model.root.position.copy(a.position);
      a.model.root.rotation.set(0, a.heading, 0);
      a.model.animate(a.phase, sp / a.spec.speed, this.time);
    }
  }

  dispose(): void {
    this.offCollision();
    for (const a of this.list) {
      this.physics.removeBody(a.body);
      a.model.dispose();
    }
  }
}

// ------------------------------------------------------------------ models

interface AnimalModel {
  root: THREE.Group;
  animate(phase: number, run: number, time: number): void;
  dispose(): void;
}

const MAT = new THREE.MeshLambertMaterial({ vertexColors: true });

function part(g: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0): THREE.BufferGeometry {
  g.scale(sx, sy, sz);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  return paint(ng, color, 0.08, 31);
}
const ball = (r: number, ws = 8, hs = 6): THREE.BufferGeometry => new THREE.SphereGeometry(r, ws, hs);
const box = (w: number, h: number, d: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d);
const cyl = (r0: number, r1: number, h: number, n = 6): THREE.BufferGeometry => new THREE.CylinderGeometry(r0, r1, h, n);

function mesh(parts: THREE.BufferGeometry[]): THREE.Mesh {
  const m = new THREE.Mesh(mergeGeometries(parts)!, MAT);
  m.castShadow = true;
  return m;
}

/** A quadruped: merged body + 4 legs pivoting at the hips. Forward = +Z. */
function quadruped(body: THREE.BufferGeometry[], leg: () => THREE.BufferGeometry, hips: [number, number, number][], swing: number): AnimalModel {
  const root = new THREE.Group();
  const b = mesh(body);
  root.add(b);
  const legs: THREE.Object3D[] = [];
  for (const [x, y, z] of hips) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    pivot.add(mesh([leg()]));
    root.add(pivot);
    legs.push(pivot);
  }
  return {
    root,
    animate(phase, run) {
      const a = swing * Math.min(1, 0.25 + run);
      // Diagonal gait: FL+RR together.
      legs[0].rotation.x = Math.sin(phase * Math.PI * 2) * a;
      legs[3].rotation.x = Math.sin(phase * Math.PI * 2) * a;
      legs[1].rotation.x = -Math.sin(phase * Math.PI * 2) * a;
      legs[2].rotation.x = -Math.sin(phase * Math.PI * 2) * a;
      b.position.y = Math.abs(Math.sin(phase * Math.PI * 2)) * 0.06 * run;
    },
    dispose() {
      root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    },
  };
}

function buildAnimalModel(kind: AnimalKind): AnimalModel {
  switch (kind) {
    case 'deer': {
      const fur = 0xa0673a;
      const belly = 0xe8d6b8;
      const parts = [
        part(ball(0.5, 10, 7), fur, 0, 1.15, 0, 0.75, 0.7, 1.6),
        part(ball(0.32, 8, 6), belly, 0, 1.0, 0.05, 0.85, 0.55, 1.5),
        part(cyl(0.13, 0.17, 0.6), fur, 0, 1.55, 0.62, 1, 1, 1, -0.6),
        part(ball(0.2, 8, 6), fur, 0, 1.85, 0.82, 0.85, 0.85, 1.35),
        part(ball(0.08, 6, 4), 0x2a1d16, 0, 1.8, 1.08),
        part(box(0.05, 0.22, 0.12), fur, 0.14, 2.02, 0.74),
        part(box(0.05, 0.22, 0.12), fur, -0.14, 2.02, 0.74),
        part(ball(0.1, 6, 4), 0xffffff, 0, 1.25, -0.78),
        // Antlers
        part(cyl(0.025, 0.03, 0.4), 0xd9c7a2, 0.1, 2.15, 0.78, 1, 1, 1, -0.3),
        part(cyl(0.025, 0.03, 0.4), 0xd9c7a2, -0.1, 2.15, 0.78, 1, 1, 1, -0.3),
        part(cyl(0.02, 0.025, 0.22), 0xd9c7a2, 0.18, 2.3, 0.72, 1, 1, 1, 0.8),
        part(cyl(0.02, 0.025, 0.22), 0xd9c7a2, -0.18, 2.3, 0.72, 1, 1, 1, 0.8),
      ];
      const leg = (): THREE.BufferGeometry => mergeGeometries([part(cyl(0.06, 0.045, 0.95), fur, 0, -0.47, 0), part(box(0.08, 0.08, 0.1), 0x2a1d16, 0, -0.95, 0.02)])!;
      return quadruped(parts, leg, [[0.2, 0.98, 0.5], [-0.2, 0.98, 0.5], [0.2, 0.98, -0.5], [-0.2, 0.98, -0.5]], 0.6);
    }
    case 'bear': {
      const fur = 0x5a3b24;
      const parts = [
        part(ball(0.6, 10, 8), fur, 0, 0.95, -0.05, 1.0, 0.85, 1.45),
        part(ball(0.4, 10, 7), fur, 0, 1.0, 0.85, 1, 0.95, 1),
        part(ball(0.18, 8, 6), 0xa9805a, 0, 0.9, 1.2, 1, 0.8, 1),
        part(ball(0.07, 6, 4), 0x1a1210, 0, 0.95, 1.36),
        part(ball(0.12, 6, 4), fur, 0.25, 1.35, 0.8),
        part(ball(0.12, 6, 4), fur, -0.25, 1.35, 0.8),
        part(ball(0.045, 6, 4), 0x111111, 0.14, 1.12, 1.15),
        part(ball(0.045, 6, 4), 0x111111, -0.14, 1.12, 1.15),
      ];
      const leg = (): THREE.BufferGeometry => part(cyl(0.17, 0.15, 0.62, 7), fur, 0, -0.31, 0);
      return quadruped(parts, leg, [[0.32, 0.62, 0.5], [-0.32, 0.62, 0.5], [0.32, 0.62, -0.55], [-0.32, 0.62, -0.55]], 0.5);
    }
    case 'mouse': {
      // A chunky, cartoon-sized field mouse (about 60 cm long, so a kid can spot it).
      const fur = 0x9b9089;
      const parts = [
        part(ball(0.2, 10, 7), fur, 0, 0.2, 0, 1, 0.9, 1.5),
        part(ball(0.13, 8, 6), fur, 0, 0.24, 0.3, 1, 0.95, 1.2),
        part(ball(0.035, 6, 4), 0xe58aa0, 0, 0.23, 0.46),
        part(cyl(0.1, 0.1, 0.02, 10), 0xe8a6b4, 0.11, 0.38, 0.24, 1, 1, 1, Math.PI / 2),
        part(cyl(0.1, 0.1, 0.02, 10), 0xe8a6b4, -0.11, 0.38, 0.24, 1, 1, 1, Math.PI / 2),
        part(ball(0.03, 6, 4), 0x111111, 0.07, 0.3, 0.38),
        part(ball(0.03, 6, 4), 0x111111, -0.07, 0.3, 0.38),
        part(cyl(0.015, 0.025, 0.5, 4), 0xd99aa6, 0, 0.16, -0.5, 1, 1, 1, Math.PI / 2 - 0.2),
      ];
      const leg = (): THREE.BufferGeometry => part(cyl(0.03, 0.03, 0.12, 4), 0xd99aa6, 0, -0.06, 0);
      return quadruped(parts, leg, [[0.1, 0.12, 0.15], [-0.1, 0.12, 0.15], [0.1, 0.12, -0.15], [-0.1, 0.12, -0.15]], 0.9);
    }
    case 'duck': {
      const root = new THREE.Group();
      const body = mesh([
        part(ball(0.2, 10, 7), 0xf4f1e6, 0, 0.25, 0, 1, 0.85, 1.35),
        part(ball(0.12, 8, 6), 0x2f7d4a, 0, 0.47, 0.18),
        part(box(0.1, 0.04, 0.14), 0xf2a521, 0, 0.45, 0.32),
        part(ball(0.025, 6, 4), 0x111111, 0.07, 0.5, 0.25),
        part(ball(0.025, 6, 4), 0x111111, -0.07, 0.5, 0.25),
        part(ball(0.1, 6, 4), 0xe6e1d0, 0, 0.3, -0.25, 1, 0.6, 1),
        part(box(0.06, 0.12, 0.04), 0xf2a521, 0.07, 0.06, 0),
        part(box(0.06, 0.12, 0.04), 0xf2a521, -0.07, 0.06, 0),
      ]);
      root.add(body);
      root.scale.setScalar(1.25);
      return {
        root,
        animate(phase, run) {
          body.rotation.z = Math.sin(phase * Math.PI * 2) * 0.22 * Math.min(1, 0.3 + run);
          body.position.y = Math.abs(Math.sin(phase * Math.PI * 2)) * 0.03;
        },
        dispose() {
          body.geometry.dispose();
        },
      };
    }
    case 'moose': {
      // Tall, dark, humped shoulders, long legs, big flat (palmate) antlers and a droopy nose.
      const fur = 0x4a3222;
      const dark = 0x2e1f15;
      const antler = 0xcbb58e;
      const parts = [
        part(ball(0.55, 10, 7), fur, 0, 1.75, -0.1, 0.8, 0.75, 1.55),
        part(ball(0.45, 8, 6), dark, 0, 2.0, 0.45, 0.85, 0.9, 0.9), // shoulder hump
        part(cyl(0.16, 0.2, 0.6), fur, 0, 2.05, 0.85, 1, 1, 1, -0.9),
        part(box(0.3, 0.32, 0.62), fur, 0, 2.15, 1.25, 1, 1, 1, 0.35), // long head
        part(ball(0.17, 8, 6), dark, 0, 1.98, 1.5, 1.1, 0.95, 1.1), // big droopy nose
        part(box(0.08, 0.32, 0.08), dark, 0, 1.75, 1.05), // dewlap
        part(ball(0.04, 6, 4), 0x111111, 0.14, 2.28, 1.2),
        part(ball(0.04, 6, 4), 0x111111, -0.14, 2.28, 1.2),
        part(box(0.06, 0.16, 0.2), fur, 0.2, 2.42, 1.05),
        part(box(0.06, 0.16, 0.2), fur, -0.2, 2.42, 1.05),
        // Palmate antlers: a flat paddle each side with tines.
        part(box(0.62, 0.06, 0.34), antler, 0.48, 2.55, 1.0, 1, 1, 1, 0),
        part(box(0.62, 0.06, 0.34), antler, -0.48, 2.55, 1.0, 1, 1, 1, 0),
        part(cyl(0.035, 0.04, 0.3), antler, 0.25, 2.45, 1.05),
        part(cyl(0.035, 0.04, 0.3), antler, -0.25, 2.45, 1.05),
      ];
      for (const sx of [-1, 1]) for (let t = 0; t < 4; t++) parts.push(part(box(0.05, 0.16, 0.05), antler, sx * (0.3 + t * 0.14), 2.65, 0.88 + (t % 2) * 0.14));
      parts.push(part(ball(0.08, 6, 4), dark, 0, 1.8, -0.98)); // stubby tail
      const leg = (): THREE.BufferGeometry => mergeGeometries([part(cyl(0.08, 0.06, 1.35), fur, 0, -0.67, 0), part(box(0.11, 0.1, 0.13), 0x1a1210, 0, -1.34, 0.02)])!;
      return quadruped(parts, leg, [[0.24, 1.42, 0.55], [-0.24, 1.42, 0.55], [0.24, 1.42, -0.6], [-0.24, 1.42, -0.6]], 0.55);
    }
    case 'boar': {
      // Stocky, dark bristly back, wedge head with a pink snout and white tusks.
      const fur = 0x5b4a3c;
      const parts = [
        part(ball(0.42, 10, 7), fur, 0, 0.62, 0, 0.85, 0.85, 1.45),
        part(box(0.12, 0.18, 1.0), 0x2c231c, 0, 1.0, 0.05), // bristle ridge
        part(cyl(0.1, 0.3, 0.55, 7), fur, 0, 0.62, 0.72, 1, 1, 1, Math.PI / 2), // wedge head
        part(cyl(0.11, 0.11, 0.06, 8), 0xc98a86, 0, 0.6, 1.0, 1, 1, 1, Math.PI / 2), // snout disc
        part(cyl(0.02, 0.035, 0.18, 4), 0xf4efe0, 0.1, 0.62, 0.95, 1, 1, 1, -0.6),
        part(cyl(0.02, 0.035, 0.18, 4), 0xf4efe0, -0.1, 0.62, 0.95, 1, 1, 1, -0.6),
        part(ball(0.035, 6, 4), 0x111111, 0.12, 0.76, 0.75),
        part(ball(0.035, 6, 4), 0x111111, -0.12, 0.76, 0.75),
        part(box(0.07, 0.16, 0.1), 0x3a2e25, 0.16, 0.92, 0.55),
        part(box(0.07, 0.16, 0.1), 0x3a2e25, -0.16, 0.92, 0.55),
        part(cyl(0.02, 0.02, 0.25, 4), 0x2c231c, 0, 0.7, -0.68, 1, 1, 1, 0.5),
      ];
      const leg = (): THREE.BufferGeometry => part(cyl(0.07, 0.055, 0.42, 5), 0x3a2e25, 0, -0.21, 0);
      return quadruped(parts, leg, [[0.18, 0.42, 0.35], [-0.18, 0.42, 0.35], [0.18, 0.42, -0.35], [-0.18, 0.42, -0.35]], 0.75);
    }
    case 'bull':
    case 'cow': {
      // Bull: black, wide horns, nose ring. Cow: white with black patches, pink udder, little horns.
      const bull = kind === 'bull';
      const hide = bull ? 0x2a2420 : 0xf2efe8;
      const patch = bull ? 0x1a1614 : 0x1f1c1a;
      const parts = [
        part(box(0.95, 0.85, 1.9), hide, 0, 1.15, 0),
        part(box(0.88, 0.2, 1.8), hide, 0, 1.62, 0),
        part(box(0.5, 0.55, 0.55), hide, 0, 1.38, 1.15, 1, 1, 1, 0.25), // head
        part(box(0.42, 0.3, 0.2), bull ? 0x4a3a33 : 0xe8a6a0, 0, 1.18, 1.45), // muzzle
        part(ball(0.035, 6, 4), 0x111111, 0.19, 1.5, 1.3),
        part(ball(0.035, 6, 4), 0x111111, -0.19, 1.5, 1.3),
        part(box(0.2, 0.08, 0.12), hide, 0.34, 1.55, 1.05),
        part(box(0.2, 0.08, 0.12), hide, -0.34, 1.55, 1.05),
        // Horns (the bull's sweep out sideways and up).
        part(cyl(0.035, 0.06, bull ? 0.5 : 0.22, 5).rotateZ(bull ? -1.0 : -0.3), 0xe9dfc4, bull ? 0.42 : 0.2, 1.72, 1.1),
        part(cyl(0.035, 0.06, bull ? 0.5 : 0.22, 5).rotateZ(bull ? 1.0 : 0.3), 0xe9dfc4, bull ? -0.42 : -0.2, 1.72, 1.1),
        part(cyl(0.02, 0.02, 0.5, 4), patch, 0, 1.2, -1.0, 1, 1, 1, 0.3), // tail
        part(ball(0.07, 5, 4), patch, 0, 0.95, -1.12),
      ];
      if (bull) {
        // A gold nose ring.
        parts.push(part(new THREE.TorusGeometry(0.08, 0.018, 4, 10), 0xe0b030, 0, 1.08, 1.56));
      } else {
        // Black patches (flattened blobs on the flanks and back) and a pink udder.
        for (const [x, y, z, sx] of [[0.47, 1.2, 0.3, 1], [-0.47, 1.05, -0.4, 1], [0.47, 1.0, -0.55, 0.8], [0, 1.72, 0.2, 1.1], [-0.47, 1.3, 0.45, 0.7]] as const)
          parts.push(part(ball(0.32, 7, 5), patch, x, y, z, 0.25, sx, sx * 1.2));
        parts.push(part(ball(0.18, 8, 6), 0xf0a8b4, 0, 0.72, -0.45, 1, 0.7, 1));
      }
      const leg = (): THREE.BufferGeometry => mergeGeometries([part(box(0.18, 0.78, 0.18), hide, 0, -0.39, 0), part(box(0.2, 0.12, 0.2), 0x2a2420, 0, -0.78, 0)])!;
      return quadruped(parts, leg, [[0.32, 0.82, 0.7], [-0.32, 0.82, 0.7], [0.32, 0.82, -0.7], [-0.32, 0.82, -0.7]], 0.45);
    }
    case 'goat': {
      // Small, pale, curved-back horns and a little beard.
      const fur = 0xe6e0d2;
      const parts = [
        part(ball(0.32, 8, 6), fur, 0, 0.78, 0, 0.8, 0.8, 1.45),
        part(cyl(0.08, 0.1, 0.35), fur, 0, 1.0, 0.42, 1, 1, 1, -0.5),
        part(box(0.2, 0.22, 0.34), fur, 0, 1.15, 0.6, 1, 1, 1, 0.4),
        part(box(0.06, 0.16, 0.06), 0x8a7f6c, 0, 0.98, 0.72), // beard
        part(ball(0.03, 6, 4), 0x111111, 0.09, 1.22, 0.62),
        part(ball(0.03, 6, 4), 0x111111, -0.09, 1.22, 0.62),
        part(cyl(0.02, 0.04, 0.28, 4), 0x6b6150, 0.07, 1.36, 0.48, 1, 1, 1, -1.1),
        part(cyl(0.02, 0.04, 0.28, 4), 0x6b6150, -0.07, 1.36, 0.48, 1, 1, 1, -1.1),
        part(box(0.14, 0.05, 0.08), fur, 0.15, 1.2, 0.5),
        part(box(0.14, 0.05, 0.08), fur, -0.15, 1.2, 0.5),
        part(box(0.06, 0.12, 0.06), fur, 0, 0.98, -0.45, 1, 1, 1, -0.6),
      ];
      const leg = (): THREE.BufferGeometry => mergeGeometries([part(cyl(0.04, 0.035, 0.55, 5), fur, 0, -0.27, 0), part(box(0.06, 0.06, 0.07), 0x3a332a, 0, -0.55, 0.01)])!;
      return quadruped(parts, leg, [[0.13, 0.58, 0.3], [-0.13, 0.58, 0.3], [0.13, 0.58, -0.3], [-0.13, 0.58, -0.3]], 0.7);
    }
    case 'rabbit': {
      // Cartoon-sized (≈ 70 cm) so it's visible: long ears, white puff tail; it hops.
      const fur = 0x9a7d62;
      const root = new THREE.Group();
      const body = mesh([
        part(ball(0.2, 10, 7), fur, 0, 0.26, 0, 1, 1, 1.35),
        part(ball(0.14, 8, 6), fur, 0, 0.44, 0.24),
        part(ball(0.06, 6, 4), 0xf3eee6, 0, 0.3, -0.27), // tail puff
        part(box(0.06, 0.32, 0.03), fur, 0.06, 0.66, 0.2, 1, 1, 1, -0.2),
        part(box(0.06, 0.32, 0.03), fur, -0.06, 0.66, 0.2, 1, 1, 1, -0.2),
        part(box(0.035, 0.26, 0.035), 0xe0a3a8, 0.06, 0.66, 0.218, 1, 1, 1, -0.2),
        part(box(0.035, 0.26, 0.035), 0xe0a3a8, -0.06, 0.66, 0.218, 1, 1, 1, -0.2),
        part(ball(0.025, 6, 4), 0x111111, 0.08, 0.47, 0.34),
        part(ball(0.025, 6, 4), 0x111111, -0.08, 0.47, 0.34),
        part(ball(0.022, 6, 4), 0xd77d8a, 0, 0.42, 0.37),
        part(box(0.07, 0.06, 0.24), fur, 0.11, 0.05, -0.05), // hind feet
        part(box(0.07, 0.06, 0.24), fur, -0.11, 0.05, -0.05),
        part(box(0.05, 0.14, 0.05), fur, 0.07, 0.08, 0.16), // front paws
        part(box(0.05, 0.14, 0.05), fur, -0.07, 0.08, 0.16),
      ]);
      root.add(body);
      root.scale.setScalar(1.6);
      return {
        root,
        animate(phase, run) {
          const hop = Math.max(0, Math.sin(phase * Math.PI * 2));
          body.position.y = hop * 0.18 * Math.min(1, run * 1.5);
          body.rotation.x = -Math.cos(phase * Math.PI * 2) * 0.18 * Math.min(1, run);
        },
        dispose() {
          body.geometry.dispose();
        },
      };
    }
    case 'camel': {
      // Tan, two humps, long curved neck held forward, knobbly long legs.
      const fur = 0xc89f64;
      const parts = [
        part(ball(0.55, 10, 7), fur, 0, 1.85, 0, 0.8, 0.6, 1.4),
        part(ball(0.33, 8, 6), fur, 0, 2.25, 0.32, 1, 1.1, 1),
        part(ball(0.33, 8, 6), fur, 0, 2.25, -0.38, 1, 1.1, 1),
        part(cyl(0.13, 0.17, 0.8), fur, 0, 1.95, 0.9, 1, 1, 1, 1.1), // neck going forward/down
        part(cyl(0.11, 0.13, 0.55), fur, 0, 2.3, 1.25, 1, 1, 1, -0.35), // neck curving up
        part(box(0.24, 0.24, 0.5), fur, 0, 2.55, 1.45), // head
        part(box(0.2, 0.16, 0.16), 0xa98250, 0, 2.48, 1.72), // muzzle
        part(ball(0.035, 6, 4), 0x111111, 0.12, 2.62, 1.45),
        part(ball(0.035, 6, 4), 0x111111, -0.12, 2.62, 1.45),
        part(box(0.06, 0.1, 0.06), fur, 0.11, 2.72, 1.3),
        part(box(0.06, 0.1, 0.06), fur, -0.11, 2.72, 1.3),
        part(cyl(0.02, 0.02, 0.5, 4), 0x7a5c33, 0, 1.75, -0.85, 1, 1, 1, 0.3),
      ];
      const leg = (): THREE.BufferGeometry =>
        mergeGeometries([part(cyl(0.07, 0.05, 1.45), fur, 0, -0.72, 0), part(ball(0.08, 6, 4), fur, 0, -0.75, 0), part(box(0.14, 0.06, 0.16), 0x8a6a40, 0, -1.44, 0.02)])!;
      return quadruped(parts, leg, [[0.24, 1.5, 0.5], [-0.24, 1.5, 0.5], [0.24, 1.5, -0.5], [-0.24, 1.5, -0.5]], 0.5);
    }
    case 'croc':
    default: {
      const skin = 0x4f6b2f;
      const root = new THREE.Group();
      const parts = [
        part(ball(0.45, 10, 6), skin, 0, 0.3, 0, 0.9, 0.5, 2.2),
        part(box(0.5, 0.18, 0.9), skin, 0, 0.28, 1.35),
        part(box(0.48, 0.08, 0.85), 0xd8d0a0, 0, 0.2, 1.38),
        part(ball(0.08, 6, 4), 0xe8e06a, 0.17, 0.45, 1.05),
        part(ball(0.08, 6, 4), 0xe8e06a, -0.17, 0.45, 1.05),
        part(ball(0.035, 6, 4), 0x111111, 0.17, 0.48, 1.11),
        part(ball(0.035, 6, 4), 0x111111, -0.17, 0.48, 1.11),
      ];
      // Back scutes
      for (let k = 0; k < 7; k++) parts.push(part(box(0.1, 0.08, 0.14), 0x3c5523, 0, 0.53, -0.8 + k * 0.25));
      const tail = new THREE.Group();
      tail.position.set(0, 0.3, -0.9);
      tail.add(mesh([part(cyl(0.05, 0.25, 1.6, 6), skin, 0, 0, -0.8, 1, 0.6, 1, Math.PI / 2)]));
      const leg = (): THREE.BufferGeometry => part(box(0.14, 0.3, 0.16), skin, 0.08, -0.12, 0);
      const q = quadruped(parts, leg, [[0.4, 0.3, 0.6], [-0.4, 0.3, 0.6], [0.4, 0.3, -0.6], [-0.4, 0.3, -0.6]], 0.7);
      q.root.add(tail);
      root.add(q.root);
      return {
        root,
        animate(phase, run, time) {
          q.animate(phase, run, time);
          tail.rotation.y = Math.sin(phase * Math.PI * 2) * 0.35 + Math.sin(time * 1.3) * 0.1;
        },
        dispose() {
          q.dispose();
        },
      };
    }
  }
}
