import * as THREE from 'three';
import type { GameContext } from '../core/context';
import { Group, groups, RAPIER } from '../core/physics';
import type { SpawnPoint, SurfaceType } from '../core/types';
import { PolylineTrack } from './polylineTrack';
import { SURFACE_COLORS } from './surfaces';
import type { Checkpoint, JumpInfo, World, Zone } from './types';

/**
 * Milestone-1 test level: flat field with an asphalt loop, a few speed bumps,
 * a jump ramp, a mud patch, a sand patch and some hay bales to knock over.
 * Implements the full `World` interface so race/ai/ui can be developed against it
 * before the real track exists.
 */
export class TestGround implements World {
  readonly track: PolylineTrack;
  readonly zones: Zone[];
  readonly checkpoints: Checkpoint[];
  readonly spawns: { player: SpawnPoint; cpu: SpawnPoint };
  readonly jump: JumpInfo;
  private group = new THREE.Group();
  private debris: { body: RAPIER.RigidBody; home: SpawnPoint }[] = [];
  private mudPatch = { x: 0, z: 0, r: 12 };
  private sandPatch = { x: 0, z: 0, r: 14 };
  private roadHalfWidth = 6;

  constructor(private ctx: GameContext) {
    // Oval-ish loop (open polyline that nearly closes) so AI/race code has a path to follow.
    // Ellipse 140 m x 220 m starting at the origin heading +Z, running anticlockwise seen from above.
    const ctrl: THREE.Vector3[] = [];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 * 0.96;
      ctrl.push(new THREE.Vector3(70 - Math.cos(a) * 70, 0, Math.sin(a) * 110));
    }
    this.track = PolylineTrack.fromControlPoints(ctrl, this.roadHalfWidth, 0);
    // Finish near the end of the loop; a nominal (ramp-less) "jump" lip just after it for the test level.
    Object.assign(this.track, { finishS: this.track.length * 0.95 });
    this.zones = [{ id: 'test', startS: 0, endS: this.track.length }];
    this.checkpoints = [];
    for (let s = 0, i = 0; s < this.track.length; s += 150, i++) this.checkpoints.push({ index: i, s, respawn: this.spawnOnTrack(s, 0) });

    const mud = this.track.pointAt(240);
    const sand = this.track.pointAt(340);
    this.mudPatch = { x: mud.x, z: mud.z, r: 12 };
    this.sandPatch = { x: sand.x, z: sand.z, r: 14 };
    this.spawns = { player: this.spawnOnTrack(8, -2.5), cpu: this.spawnOnTrack(8, 2.5) };
    const lipS = this.track.length * 0.955;
    this.jump = {
      lipS,
      bonusM: 20,
      bonusS: lipS + 20,
      runoffS: this.track.length * 0.99,
      markerStepM: 10,
      lip: this.track.pointAt(lipS),
      bonusLine: this.track.pointAt(lipS + 20),
    };

    ctx.renderer.scene.add(this.group);
    this.buildGround();
    this.buildRoad();
    this.buildPatches();
    this.buildBumps();
    this.buildRamp(this.spawnOnTrack(150, 0)); // on the road
    this.buildRamp({ x: -25, y: 0, z: 20, yaw: 0 }); // off to the side
    this.buildHay();
  }

  spawnOnTrack(s: number, lateral: number): SpawnPoint {
    const p = this.track.pointAt(s);
    const t = this.track.tangentAt(s);
    // right = (-tz, 0, tx)
    return { x: p.x - t.z * lateral, y: p.y, z: p.z + t.x * lateral, yaw: Math.atan2(t.x, t.z) };
  }

  surfaceAt(x: number, z: number): SurfaceType {
    const d = (p: { x: number; z: number }): number => Math.hypot(x - p.x, z - p.z);
    if (d(this.mudPatch) < this.mudPatch.r) return 'mud';
    if (d(this.sandPatch) < this.sandPatch.r) return 'sand';
    const { lateral } = this.track.project(new THREE.Vector3(x, 0, z));
    return Math.abs(lateral) <= this.roadHalfWidth ? 'asphalt' : 'dirt';
  }

  heightAt(): number {
    return 0;
  }

  zoneAt(): Zone {
    return this.zones[0];
  }

  resetDynamic(): void {
    for (const d of this.debris) {
      d.body.setTranslation({ x: d.home.x, y: d.home.y, z: d.home.z }, true);
      d.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.home.yaw), true);
      d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      d.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private debrisMeshes: { mesh: THREE.Object3D; body: RAPIER.RigidBody }[] = [];
  update(): void {
    // Debris is light and rarely moves; no interpolation needed for M1.
    for (const { mesh, body } of this.debrisMeshes) {
      if (body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  // ---------------------------------------------------------------- builders

  private staticBody(): RAPIER.RigidBody {
    return this.ctx.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  }

  private buildGround(): void {
    const { physics } = this.ctx;
    const size = 600;
    const body = this.staticBody();
    const col = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(size / 2, 2, size / 2)
        .setTranslation(0, -2, 0)
        .setFriction(0.9)
        .setCollisionGroups(groups(Group.GROUND, 0xffff)),
      body,
    );
    physics.tag(col, { kind: 'ground' });

    const geo = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ map: makeGrassTexture(this.ctx.quality.preset.textureSize) });
    mat.map!.repeat.set(size / 8, size / 8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildRoad(): void {
    // Flat ribbon a hair above the ground (visual only — physics ground is the flat field).
    const pos: number[] = [];
    const idx: number[] = [];
    const steps = Math.ceil(this.track.length / 2);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * this.track.length;
      this.track.pointAt(s, p);
      this.track.tangentAt(s, t);
      const w = this.roadHalfWidth;
      pos.push(p.x + t.z * w, 0.02, p.z - t.x * w, p.x - t.z * w, 0.02, p.z + t.x * w);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: SURFACE_COLORS.asphalt, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // Start line
    const sp = this.spawnOnTrack(12, 0);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(this.roadHalfWidth * 2, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    line.position.set(sp.x, 0.03, sp.z);
    line.rotation.y = sp.yaw;
    this.group.add(line);
  }

  private buildPatches(): void {
    for (const [patch, surf] of [
      [this.mudPatch, 'mud'],
      [this.sandPatch, 'sand'],
    ] as const) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(patch.r, 32).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: SURFACE_COLORS[surf] }));
      m.position.set(patch.x, 0.035, patch.z);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  private buildBumps(): void {
    const { physics } = this.ctx;
    const mat = new THREE.MeshLambertMaterial({ color: 0xd8b13a });
    // A row of speed bumps across the road on the first straight, and some rollers off-road.
    const placements: { s: number; lat: number; len: number }[] = [
      { s: 40, lat: 0, len: 12 },
      { s: 52, lat: 0, len: 12 },
      { s: 64, lat: 0, len: 12 },
    ];
    for (const b of placements) {
      const sp = this.spawnOnTrack(b.s, b.lat);
      const body = this.staticBody();
      const r = 0.35;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, sp.yaw, Math.PI / 2, 'YXZ'));
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.cylinder(b.len / 2, r)
          .setTranslation(sp.x, -0.15, sp.z)
          .setRotation(q)
          .setCollisionGroups(groups(Group.STATIC, 0xffff)),
        body,
      );
      physics.tag(col, { kind: 'static', name: 'bump' });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, b.len, 12), mat);
      mesh.position.set(sp.x, -0.15, sp.z);
      mesh.quaternion.copy(q);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    // Bumpy field off to the side (moguls) to exercise suspension.
    for (let i = 0; i < 18; i++) {
      const x = 40 + (i % 6) * 5 + ((i * 7) % 3);
      const z = 70 + Math.floor(i / 6) * 6;
      const r = 1.6 + (i % 3) * 0.4;
      const body = this.staticBody();
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.ball(r)
          .setTranslation(x, -r + 0.45, z)
          .setCollisionGroups(groups(Group.GROUND, 0xffff)),
        body,
      );
      physics.tag(col, { kind: 'ground', surface: 'dirt' });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x7d6a46 }));
      mesh.position.set(x, -r + 0.45, z);
      mesh.receiveShadow = mesh.castShadow = true;
      this.group.add(mesh);
    }
  }

  private buildRamp(sp: SpawnPoint): void {
    const at = new THREE.Vector3(sp.x, 0, sp.z);
    const yaw = sp.yaw;
    const { physics } = this.ctx;
    const w = 3.5; // half width
    const len = 10;
    const h = 1.8;
    // Wedge: rises along +Z (local), flush with ground at the leading edge.
    const v = [
      [-w, 0, 0],
      [w, 0, 0],
      [-w, 0, len],
      [w, 0, len],
      [-w, h, len],
      [w, h, len],
    ];
    const pts = new Float32Array(v.flat());
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const body = this.staticBody();
    const desc = RAPIER.ColliderDesc.convexHull(pts);
    if (!desc) return;
    const col = physics.world.createCollider(
      desc
        .setTranslation(at.x, at.y - 0.01, at.z)
        .setRotation(q)
        .setFriction(0.9)
        .setCollisionGroups(groups(Group.GROUND, 0xffff)),
      body,
    );
    physics.tag(col, { kind: 'ground', surface: 'asphalt' });

    const geo = new THREE.BufferGeometry();
    // prettier-ignore
    const tris = [0,4,1, 1,4,5, 2,3,4, 3,5,4, 0,2,4, 1,5,3, 0,1,2, 1,3,2];
    const arr: number[] = [];
    for (const i of tris) arr.push(...(v[i] as [number, number, number]));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xb07a3c, side: THREE.DoubleSide }));
    mesh.position.copy(at);
    mesh.quaternion.copy(q);
    mesh.castShadow = mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildHay(): void {
    const { physics } = this.ctx;
    const geo = new THREE.CylinderGeometry(0.6, 0.6, 1.2, 12).rotateZ(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0xe2c25a });
    for (let i = 0; i < 6; i++) {
      const sp = this.spawnOnTrack(90 + i * 4, (i % 2 ? 1 : -1) * 3.5);
      sp.y = 0.6;
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(sp.x, sp.y, sp.z)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp.yaw))
          .setLinearDamping(0.3)
          .setAngularDamping(0.5)
          .setCanSleep(true),
      );
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.cylinder(0.6, 0.6)
          .setRotation(q)
          .setMass(60)
          .setFriction(0.8)
          .setCollisionGroups(groups(Group.DEBRIS, 0xffff)),
        body,
      );
      physics.tag(col, { kind: 'debris', name: 'hay' });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.debris.push({ body, home: sp });
      this.debrisMeshes.push({ mesh, body });
    }
    this.update();
  }
}

/** Small tiling procedural grass texture (no downloads). */
function makeGrassTexture(size: number): THREE.CanvasTexture {
  const s = Math.min(256, size);
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f9a3f';
  g.fillRect(0, 0, s, s);
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < s * 6; i++) {
    const l = 38 + rnd() * 22;
    g.fillStyle = `hsl(${80 + rnd() * 25}, ${35 + rnd() * 20}%, ${l}%)`;
    g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2, 1 + rnd() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
