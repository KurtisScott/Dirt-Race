import * as THREE from 'three';
import type { GameContext } from '../core/context';
import { events } from '../core/events';
import { Group, groups, RAPIER } from '../core/physics';
import type { SpawnPoint, SurfaceType } from '../core/types';
import { Animals, type AnimalInfo } from './animals';
import { CourseData } from './course';
import { Obstacles } from './obstacles';
import {
  bigRampTemplate,
  bridgeTemplate,
  bushTemplate,
  cactusTemplate,
  ChunkMerger,
  fenceTemplate,
  gorgeBridgeTemplate,
  houseTemplate,
  logTemplate,
  pineTemplate,
  rampTemplate,
  rockTemplate,
  signPostsTemplate,
  snowPineTemplate,
  treeTemplate,
  tuftTemplate,
  type Template,
} from './props';
import { GORGE_DEPTH_M } from './layout';
import { loadJSON, saveJSON } from '../core/storage';
import { createTerrainCollider, createTerrainMesh, type TerrainHandles, type TerrainShading } from './terrain';
import { makeAsphaltTexture, makeBannerTexture, makeCheckerTexture, makeSignAtlas, makeWaterNormal, type SignCell } from './textures';
import type { Checkpoint, JumpInfo, World, Zone } from './types';
import type { TrackShortcut } from '../ai/types';

const GPU_KEY = 'dirtrace.gpu.v1';

/** Forced/remembered texture-free terrain (URL ?terrain=simple, or a previous shader failure). */
function terrainForcedSimple(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('terrain') === 'simple') return true;
  } catch {
    /* headless */
  }
  return loadJSON<{ terrainSimple?: boolean }>(GPU_KEY, {}).terrainSimple === true;
}

/**
 * The real ~5 km point-to-point course (SPEC "Track" + round 2). Implements `World`.
 *
 * Zones: town → farm → mud → rocky → forest → canyon (gorge bridge) → snowy pass → desert → river
 * (riverside + ford / log bridge) → finish straight → end jump (run-up, ramp, landing hill, run-off).
 * Physics: one heightfield (terrain incl. road, mud pit, river channel, gorge, landing hill, valley walls),
 * fixed boulders/logs/ramps/bridges/fence-posts, dynamic hay & cones, light dynamic animals.
 * Rendering: ~1 draw call per 80 m terrain chunk (texture-array splat), props merged per 120–160 m chunk,
 * instanced debris, a handful of unique meshes (water, banners, jump markers, bonus flags).
 */
export class RaceCourse implements World {
  readonly data: CourseData;
  readonly track: CourseData['track'];
  readonly zones: readonly Zone[];
  readonly checkpoints: readonly Checkpoint[];
  readonly spawns: { player: SpawnPoint; cpu: SpawnPoint };
  readonly jump: JumpInfo;
  /** Optional (AIWorldExtras): the log-bridge shortcut the Hard computer takes. */
  readonly shortcuts: readonly TrackShortcut[];
  /** Optional: animals on the course (AI treats active ones as obstacles). */
  readonly animals: readonly AnimalInfo[];

  private group = new THREE.Group();
  private terrain: TerrainHandles;
  private obstacles: Obstacles;
  private animalSys: Animals;
  water: THREE.Mesh | null = null;
  private waterNormal: THREE.Texture | null = null;
  flags: THREE.Mesh[] = [];
  private flagGeo: THREE.BufferGeometry | null = null;
  private flagBase: Float32Array | null = null;
  private time = 0;
  private disposables: { dispose(): void }[] = [];
  private offQuality: () => void;

  /** `data` may be pre-built (lets the loading screen show progress between the two halves of the build). */
  constructor(
    private ctx: GameContext,
    data?: CourseData,
  ) {
    const t0 = performance.now();
    const c = (this.data = data ?? new CourseData());
    this.track = c.track;
    this.zones = c.zones;
    this.checkpoints = c.checkpoints;
    this.spawns = c.spawns;
    this.jump = c.jump;
    const sc = c.shortcut;
    this.shortcuts = [{ id: sc.id, startS: sc.startS, endS: sc.endS, points: sc.points, halfWidth: sc.halfWidth, maxSpeed: sc.maxSpeed }];
    this.group.name = 'raceCourse';
    ctx.renderer.scene.add(this.group);

    // ---- physics
    createTerrainCollider(ctx.physics, c);
    this.buildStaticColliders();
    this.obstacles = new Obstacles(ctx.physics, c);
    this.animalSys = new Animals(ctx.physics, c);
    this.animals = this.animalSys.list;

    // ---- visuals
    const q = ctx.quality.preset;
    const texSize = q.textureSize >= 1024 ? 512 : 256;
    this.terrain = createTerrainMesh(c, texSize, this.wantedShading());
    this.group.add(this.terrain.mesh, this.obstacles.group, this.animalSys.group);
    this.buildRoad();
    this.buildProps(q.detail);
    this.buildWater();
    this.buildStartFinish();
    this.buildJump();
    this.applyQuality();
    const offs = [
      events.on('quality:changed', () => this.applyQuality()),
      // Still too slow on Low: drop the terrain to the texture-free shader for good.
      events.on('quality:slow', () => {
        if (this.terrain.shading !== 'simple') this.forceSimpleTerrain('slow on Low quality');
      }),
    ];
    this.offQuality = () => offs.forEach((f) => f());
    console.info(`[world] race course built in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  // ------------------------------------------------------------------ World

  surfaceAt(x: number, z: number): SurfaceType {
    return this.data.surfaceAt(x, z);
  }
  heightAt(x: number, z: number): number {
    return this.data.heightAt(x, z);
  }
  zoneAt(s: number): Zone {
    return this.data.zoneAt(s);
  }
  resetDynamic(): void {
    this.obstacles.reset();
    this.animalSys.reset();
  }

  fixedUpdate(dt: number): void {
    this.animalSys.fixedUpdate(dt);
  }

  update(dt: number): void {
    this.time += dt;
    this.checkTerrainShader();
    this.obstacles.update(dt);
    this.animalSys.update(dt);
    if (this.waterNormal) {
      this.waterNormal.offset.x = this.time * 0.02;
      this.waterNormal.offset.y = this.time * 0.035;
    }
    this.waveFlag();
  }

  dispose(): void {
    this.offQuality();
    this.obstacles.dispose();
    this.animalSys.dispose();
    this.terrain.dispose();
    for (const d of this.disposables) d.dispose();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.group.parent?.remove(this.group);
  }

  /** Turn animal crossings on/off (tests). */
  set animalsEnabled(on: boolean) {
    this.animalSys.enabled = on;
  }
  /** Planned animal crossings this race (debug/tests). */
  get plannedAnimals(): readonly { kind: string; s: number }[] {
    return this.animalSys.planned;
  }

  // ------------------------------------------------------------------ quality

  /** Current terrain shading mode ('full' | 'lite' | 'simple'), for tests and the debug readout. */
  get terrainShading(): TerrainShading {
    return this.terrain.shading;
  }

  /**
   * Terrain shading for the current quality: Low → lite splat, otherwise full. The texture-free 'simple'
   * shader is used when forced (?terrain=simple), when the splat shader failed before on this device
   * (remembered), or when the GPU can't do texture arrays.
   */
  private wantedShading(): TerrainShading {
    if (terrainForcedSimple()) return 'simple';
    return this.ctx.quality.preset.level === 'low' ? 'lite' : 'full';
  }

  private shaderChecked = false;
  /** After the first frame that drew the terrain, make sure its program compiled; else fall back. */
  private checkTerrainShader(): void {
    if (this.shaderChecked) return;
    const r = this.ctx.renderer as Partial<GameContext['renderer']>;
    if (typeof r.programReady !== 'function' || this.terrain.shading === 'simple') {
      this.shaderChecked = true;
      return;
    }
    const m = this.terrain.material;
    if (!r.programReady(m)) return; // not drawn yet
    this.shaderChecked = true;
    if (r.programFailed!(m)) this.forceSimpleTerrain('terrain shader failed to compile');
  }

  private forceSimpleTerrain(why: string): void {
    console.warn(`[world] terrain → simple shading (${why})`);
    this.terrain.setShading('simple');
    saveJSON(GPU_KEY, { terrainSimple: true });
  }

  private applyQuality(): void {
    const q = this.ctx.quality.preset;
    if (this.terrain.shading !== 'simple') this.terrain.setShading(this.wantedShading());
    // Decorative props: hide the tuft layer on Low; shadows from big props only with shadows on.
    this.group.traverse((o) => {
      const tag = o.userData.layer as string | undefined;
      if (tag === 'tufts') o.visible = q.detail >= 0.6;
      if (tag === 'bushes') o.visible = q.detail >= 0.5;
      // Small scattered rocks are pure decoration (no colliders): skipped on Low (~10 draw calls).
      if (tag === 'rocks') o.visible = q.detail >= 0.5;
    });
  }

  // ------------------------------------------------------------------ physics extras

  private buildStaticColliders(): void {
    const { physics } = this.ctx;
    const c = this.data;
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // End-jump ramp: a curved face approximated by convex wedge slices (asphalt grip).
    {
      const j = c.jump;
      const foot = c.spawnAt(j.footS, 0);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), foot.yaw);
      const prof = rampProfile(j.rampLen, j.rampHeight, j.rampDeg);
      const N = 8;
      const hw = j.halfWidth;
      for (let i = 0; i < N; i++) {
        const z0 = (i / N) * j.rampLen;
        const z1 = ((i + 1) / N) * j.rampLen;
        const y0 = prof(z0);
        const y1 = prof(z1);
        const v = new Float32Array([-hw, -0.4, z0, hw, -0.4, z0, -hw, -0.4, z1, hw, -0.4, z1, -hw, y0, z0, hw, y0, z0, -hw, y1, z1, hw, y1, z1]);
        const desc = RAPIER.ColliderDesc.convexHull(v);
        if (!desc) continue;
        const col = physics.world.createCollider(
          desc.setTranslation(foot.x, foot.y - 0.01, foot.z).setRotation(q).setFriction(0.9).setCollisionGroups(groups(Group.GROUND, 0xffff)),
          body,
        );
        physics.tag(col, { kind: 'ground', surface: 'asphalt' });
      }
    }
    // Gorge bridge: a tilted deck cuboid plus side rails (rails redirect like fences).
    {
      const { mid, q, len } = this.gorgeFrame();
      const g = c.gorge;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const deck = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(g.halfWidth, 0.3, len / 2)
          .setTranslation(mid.x - up.x * 0.3, mid.y - up.y * 0.3, mid.z - up.z * 0.3)
          .setRotation(q)
          .setFriction(0.9)
          .setCollisionGroups(groups(Group.GROUND, 0xffff)),
        body,
      );
      physics.tag(deck, { kind: 'ground', surface: 'dirt' });
      for (const sx of [-1, 1]) {
        const o = right.clone().multiplyScalar(sx * (g.halfWidth + 0.1)).addScaledVector(up, 0.55);
        const rail = physics.world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.08, 0.55, len / 2)
            .setTranslation(mid.x + o.x, mid.y + o.y, mid.z + o.z)
            .setRotation(q)
            .setFriction(0.1)
            .setRestitution(0.2)
            .setCollisionGroups(groups(Group.STATIC, Group.VEHICLE | Group.DEBRIS | Group.ANIMAL)),
          body,
        );
        physics.tag(rail, { kind: 'static', name: 'fence' });
      }
    }
    // Jump ramps (convex wedges, gravel surface).
    for (const r of c.ramps) {
      const v = new Float32Array([-r.halfWidth, -0.3, 0, r.halfWidth, -0.3, 0, -r.halfWidth, -0.3, r.length, r.halfWidth, -0.3, r.length, -r.halfWidth, r.height, r.length, r.halfWidth, r.height, r.length, -r.halfWidth, 0, 0, r.halfWidth, 0, 0]);
      const desc = RAPIER.ColliderDesc.convexHull(v);
      if (!desc) continue;
      const col = physics.world.createCollider(
        desc
          .setTranslation(r.x, r.y - 0.02, r.z)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.yaw))
          .setFriction(0.9)
          .setCollisionGroups(groups(Group.GROUND, 0xffff)),
        body,
      );
      physics.tag(col, { kind: 'ground', surface: 'asphalt' });
    }
    // Log bridge: deck + two entry ramps (trimesh-free: three cuboids/wedges).
    const b = c.bridge;
    const rampLen = 3;
    const deckLen = b.length - rampLen * 2;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const deck = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(b.halfWidth, 0.25, deckLen / 2)
        .setTranslation(b.x, b.y - 0.25, b.z)
        .setRotation(q)
        .setFriction(0.9)
        .setCollisionGroups(groups(Group.GROUND, 0xffff)),
      body,
    );
    physics.tag(deck, { kind: 'ground', surface: 'dirt' });
    for (const dir of [-1, 1]) {
      const end = new THREE.Vector3(b.x, 0, b.z).addScaledVector(fwd, dir * (deckLen / 2));
      const groundY = c.heightAt(end.x + fwd.x * dir * rampLen, end.z + fwd.z * dir * rampLen);
      const rise = Math.max(0.05, b.y - groundY);
      // Wedge in local space: z from 0 (deck end, top = rise) to rampLen*dir (ground).
      const hw = b.halfWidth;
      const z1 = dir * rampLen;
      const v = new Float32Array([-hw, -0.6, 0, hw, -0.6, 0, -hw, rise, 0, hw, rise, 0, -hw, -0.6, z1, hw, -0.6, z1, -hw, 0, z1, hw, 0, z1]);
      const desc = RAPIER.ColliderDesc.convexHull(v);
      if (!desc) continue;
      const col = physics.world.createCollider(
        desc
          .setTranslation(end.x, groundY, end.z)
          .setRotation(q)
          .setFriction(0.9)
          .setCollisionGroups(groups(Group.GROUND, 0xffff)),
        body,
      );
      physics.tag(col, { kind: 'ground', surface: 'dirt' });
    }
    // Potholes: shallow dips can't be cut into the 2 m heightfield, so each is a ring of two low
    // speed-bump halves (a sharp edge in, a sharp edge out) — the wheels drop and bounce.
    for (const p of c.potholes) {
      const r = 0.9 * p.scale;
      for (const side of [-1, 1]) {
        const off = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw)).multiplyScalar(side * r);
        const col = physics.world.createCollider(
          RAPIER.ColliderDesc.capsule(r * 0.7, 0.1)
            .setTranslation(p.x + off.x, c.heightAt(p.x + off.x, p.z + off.z) - 0.03, p.z + off.z)
            .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.yaw + Math.PI / 2, Math.PI / 2, 'YXZ')))
            .setCollisionGroups(groups(Group.STATIC, 0xffff)),
          body,
        );
        physics.tag(col, { kind: 'static', name: 'bump' });
      }
    }
    // Fence rails: thin boxes along each bay so cars bounce off gently (low friction).
    for (const f of c.fences) {
      const mx = (f.a.x + f.b.x) / 2;
      const mz = (f.a.y + f.b.y) / 2;
      const len = f.a.distanceTo(f.b);
      const yaw = Math.atan2(f.b.x - f.a.x, f.b.y - f.a.y);
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.06, 0.55, len / 2)
          .setTranslation(mx, (f.ya + f.yb) / 2 + 0.55, mz)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
          .setFriction(0.1)
          .setRestitution(0.2)
          .setCollisionGroups(groups(Group.STATIC, Group.VEHICLE | Group.DEBRIS | Group.ANIMAL)),
        body,
      );
      physics.tag(col, { kind: 'static', name: 'fence' });
    }
    // House walls (a car can't drive through a house).
    for (const h of c.houses) {
      const big = h.v >= 10;
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid((big ? 4.5 : 4) * h.scale, 2.5, (big ? 3.5 : 3) * h.scale)
          .setTranslation(h.x, h.y + 2.2, h.z)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.yaw))
          .setFriction(0.3)
          .setCollisionGroups(groups(Group.STATIC, 0xffff)),
        body,
      );
      physics.tag(col, { kind: 'static', name: 'wall' });
    }
    // Tree trunks near the road (cars stop against them; far ones are scenery only).
    for (const t of [...c.trees, ...c.pines]) {
      const f = c.fieldsAt(t.x, t.z);
      if (f.d > c.halfWidthAt(f.s) + 25) continue;
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.cylinder(1.5, 0.3 * t.scale)
          .setTranslation(t.x, t.y + 1.5, t.z)
          .setFriction(0.3)
          .setCollisionGroups(groups(Group.STATIC, Group.VEHICLE | Group.DEBRIS | Group.ANIMAL)),
        body,
      );
      physics.tag(col, { kind: 'static', name: 'tree' });
    }
  }

  // ------------------------------------------------------------------ visuals

  /** Centre, orientation and length of the gorge bridge deck (top surface). */
  private gorgeFrame(): { mid: THREE.Vector3; q: THREE.Quaternion; len: number } {
    const c = this.data;
    const g = c.gorge;
    const a2 = c.centre(g.s0);
    const b2 = c.centre(g.s1);
    const a = new THREE.Vector3(a2.x, g.y0, a2.y);
    const b = new THREE.Vector3(b2.x, g.y1, b2.y);
    const dir = b.clone().sub(a);
    const len = dir.length();
    dir.normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = -Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    return { mid: a.add(b).multiplyScalar(0.5), q, len };
  }

  /** Asphalt ribbons: through the town and along the end-jump run-up (other roads are terrain layers). */
  private buildRoad(): void {
    const c = this.data;
    const town = c.zone('town');
    const tex = makeAsphaltTexture(this.ctx.quality.preset.textureSize);
    this.disposables.push(tex);
    const mat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.disposables.push(mat);
    this.roadRibbon(0, town.endS + 6, -1, town.endS - 4, mat, 'asphalt');
    this.roadRibbon(c.finishS - 8, c.jump.footS + 0.5, c.finishS, Infinity, mat, 'asphalt-runup');
  }

  /** One asphalt ribbon from s0 to s1, narrowing in over 10 m after `fadeIn` and out after `fadeOut`. */
  private roadRibbon(s0: number, s1: number, fadeIn: number, fadeOut: number, mat: THREE.Material, name: string): void {
    const c = this.data;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const across = 8;
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    let row = 0;
    for (let s = s0; s <= s1 + 0.01; s += 2, row++) {
      c.track.pointAt(s, p);
      c.track.tangentAt(s, t);
      const hw = c.halfWidthAt(s) + 0.3;
      const fade = Math.min(s > fadeOut ? 1 - (s - fadeOut) / 10 : 1, s < fadeIn ? 1 - (fadeIn - s) / 10 : 1);
      for (let k = 0; k <= across; k++) {
        const u = k / across;
        const lat = (u * 2 - 1) * hw * Math.max(0.2, fade);
        const x = p.x - t.z * lat;
        const z = p.z + t.x * lat;
        pos.push(x, c.heightAt(x, z) + 0.04, z);
        uv.push(u, s / 12);
      }
      if (row > 0) {
        const a = (row - 1) * (across + 1);
        const b = row * (across + 1);
        for (let k = 0; k < across; k++) idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = name;
    this.group.add(mesh);
  }

  private buildProps(detail: number): void {
    const c = this.data;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.disposables.push(mat);
    const add = (meshes: THREE.Mesh[], layer: string): void => {
      for (const m of meshes) {
        m.userData.layer = layer;
        this.group.add(m);
      }
    };
    const variants = <T,>(n: number, f: (v: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

    // Big static props: trees, houses, boulders, rocks, fences, ramps, bridge → merged per 160 m chunk.
    const big = new ChunkMerger(160);
    const trees = variants(4, treeTemplate);
    const pines = variants(4, pineTemplate);
    const rocksT = variants(3, (v) => rockTemplate(v));
    // Boulders: v 0..2 grey (rocky hills, pass), 3..5 red sandstone (canyon).
    const boulderT = variants(6, (v) => rockTemplate(v % 3, v < 3 ? 0x9a8f80 : 0xa8664a));
    const snowPines = variants(4, snowPineTemplate);
    const cacti = variants(3, cactusTemplate);
    const houses: Record<number, Template> = {};
    for (const t of c.trees) big.add(trees[t.v % 4], t.x, t.y - 0.1, t.z, t.yaw, t.scale);
    for (const t of c.pines) big.add(pines[t.v % 4], t.x, t.y - 0.1, t.z, t.yaw, t.scale * 1.15);
    for (const h of c.houses) big.add((houses[h.v] ??= houseTemplate(h.v)), h.x, h.y - 0.2, h.z, h.yaw, h.v >= 10 ? 1 : h.scale);
    for (const t of c.snowPines) big.add(snowPines[t.v % 4], t.x, t.y - 0.1, t.z, t.yaw, t.scale * 1.15);
    for (const t of c.cacti) big.add(cacti[t.v % 3], t.x, t.y - 0.1, t.z, t.yaw, t.scale);
    for (const b of c.boulders) big.add(boulderT[b.v % 6], b.x, b.y - 0.25 * b.scale, b.z, b.yaw, b.scale * 1.1);
    for (const l of c.logs) big.add(logTemplate(l.radius, l.length), l.x, l.y - 0.05, l.z, l.yaw, 1);
    const fence = fenceTemplate();
    const fm = new THREE.Matrix4();
    for (const f of c.fences) {
      // Shear the bay so it follows the slope: x-axis spans a→b in 3D.
      const dx = f.b.x - f.a.x;
      const dz = f.b.y - f.a.y;
      const dy = f.yb - f.ya;
      const len = Math.hypot(dx, dz);
      fm.set(dx, 0, -dz / len, f.a.x, dy, 1, 0, f.ya, dz, 0, dx / len, f.a.y, 0, 0, 0, 1);
      big.add(fence, f.a.x, f.ya, f.a.y, 0, 1, 1, fm);
    }
    for (const r of c.ramps) big.add(rampTemplate(r.halfWidth, r.length, r.height, r.style), r.x, r.y - 0.02, r.z, r.yaw, 1);
    const b = c.bridge;
    big.add(bridgeTemplate(b.length, b.halfWidth, 0, 3), b.x, b.y, b.z, b.yaw, 1);
    {
      const { mid, q, len } = this.gorgeFrame();
      const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
      big.add(gorgeBridgeTemplate(len, c.gorge.halfWidth, GORGE_DEPTH_M + 2), mid.x, mid.y, mid.z, 0, 1, 1, m);
    }
    {
      const j = c.jump;
      const foot = c.spawnAt(j.footS, 0);
      big.add(bigRampTemplate(j.halfWidth, j.rampLen, j.rampHeight, j.rampDeg), foot.x, foot.y - 0.01, foot.z, foot.yaw, 1);
    }
    // Bridge ends ramp down to the ground: approximate by drawing it at deck height (ramps are short).
    add(big.build(mat, true), 'big');

    // Small props: rocks & bushes (no shadows), tufts (no shadows, hidden on Low).
    const small = new ChunkMerger(120);
    for (const r of c.rocks) small.add(rocksT[r.v % 3], r.x, r.y - 0.15, r.z, r.yaw, r.scale * 0.55);
    add(small.build(mat, false), 'rocks');
    const bushes = new ChunkMerger(160);
    const bushT = variants(4, (v) => bushTemplate(v, false));
    const dryT = variants(4, (v) => bushTemplate(v, true));
    for (const r of c.bushes) {
      const zid = c.zoneAt(c.fieldsAt(r.x, r.z).s).id;
      const desert = zid === 'desert' || zid === 'canyon';
      bushes.add((desert ? dryT : bushT)[r.v % 4], r.x, r.y - 0.1, r.z, r.yaw, r.scale);
    }
    add(bushes.build(mat, false), 'bushes');
    const tuftMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.disposables.push(tuftMat);
    const tufts = new ChunkMerger(120);
    const tuftT = variants(3, tuftTemplate);
    const keep = Math.max(0.35, detail);
    let k = 0;
    for (const t of c.tufts) {
      if ((k++ * 0.618) % 1 > keep) continue;
      tufts.add(tuftT[t.v % 3], t.x, t.y - 0.05, t.z, t.yaw, t.scale);
    }
    add(tufts.build(tuftMat, false), 'tufts');
  }

  /** River water: one ribbon along the river polyline at the water level (one draw call). */
  private buildWater(): void {
    const c = this.data;
    const r = c.river;
    const pts = r.points;
    const W = 9; // half-width: wider than the wet channel, the banks hide the rest
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    // Extend 10 m past both ends along the end directions (the channel tapers there).
    const ext = (i: number, j: number, d: number): THREE.Vector2 => pts[i].clone().add(pts[i].clone().sub(pts[j]).normalize().multiplyScalar(d));
    const line = [ext(0, 1, 10), ...pts, ext(pts.length - 1, pts.length - 2, 10)];
    const bs = [r.bs[0] - 10, ...r.bs, r.bs[r.bs.length - 1] + 10];
    for (let i = 0; i < line.length; i++) {
      const a = line[Math.max(0, i - 1)];
      const b = line[Math.min(line.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l;
      const nz = dx / l;
      for (const side of [-1, 1]) {
        pos.push(line[i].x + nx * W * side, r.water, line[i].y + nz * W * side);
        uv.push(((side + 1) * W) / 6, bs[i] / 6);
      }
      if (i > 0) {
        const k = (i - 1) * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); // counter-clockwise from above (front face up)
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Make sure every normal points up (whichever way the strip winds).
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const normal = makeWaterNormal(this.ctx.quality.preset.textureSize);
    this.waterNormal = normal;
    const mat = new THREE.MeshPhongMaterial({
      color: 0x3f7f9a,
      specular: 0xcfe8ff,
      shininess: 90,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.6, 0.6),
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.disposables.push(mat, normal);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    mesh.name = 'river';
    this.water = mesh;
    this.group.add(mesh);
  }

  private buildStartFinish(): void {
    const c = this.data;
    const checker = makeCheckerTexture();
    this.disposables.push(checker);
    const lineMat = new THREE.MeshLambertMaterial({ map: checker, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.disposables.push(lineMat);
    const gantry = (s: number, text: string, fg: [number, number, number], bg: [number, number, number]): void => {
      const sp = c.spawnAt(s, 0);
      const hw = c.halfWidthAt(s) + 1.2;
      // Painted line, draped on the ground.
      const lg = new THREE.PlaneGeometry(hw * 2, 1.4, 8, 1).rotateX(-Math.PI / 2);
      const pos = lg.attributes.position as THREE.BufferAttribute;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp.yaw);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyQuaternion(q);
        pos.setY(i, c.heightAt(sp.x + v.x, sp.z + v.z) - sp.y + 0.06);
      }
      const uvs = lg.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * hw * 1.6, uvs.getY(i) * 0.5);
      checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
      const line = new THREE.Mesh(lg, lineMat);
      line.position.set(sp.x, sp.y, sp.z);
      line.rotation.y = sp.yaw;
      line.receiveShadow = true;
      this.group.add(line);
      // Two posts + banner.
      const bh = 1.4;
      const banner = makeBannerTexture(text, fg, bg, true, 6, (hw * 2) / bh);
      this.disposables.push(banner);
      const parts: THREE.Mesh[] = [];
      const postMat = new THREE.MeshLambertMaterial({ color: 0xdedede });
      this.disposables.push(postMat);
      const H = 5.2;
      const g = new THREE.Group();
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, H + 1, 8), postMat);
        const lx = side * hw;
        const wx = sp.x - Math.cos(sp.yaw) * lx;
        const wz = sp.z + Math.sin(sp.yaw) * lx;
        post.position.set(lx, c.heightAt(wx, wz) - sp.y + (H + 1) / 2 - 0.5, 0);
        post.castShadow = true;
        parts.push(post);
      }
      const bannerMat = new THREE.MeshLambertMaterial({ map: banner, side: THREE.DoubleSide });
      this.disposables.push(bannerMat);
      const bm = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, bh), bannerMat);
      bm.position.set(0, H, 0);
      bm.castShadow = true;
      parts.push(bm);
      g.add(...parts);
      g.position.set(sp.x, sp.y, sp.z);
      g.rotation.y = sp.yaw + Math.PI; // banner faces the oncoming cars
      this.group.add(g);
    };
    gantry(14, 'START', [255, 255, 255], [200, 40, 40]);
    gantry(c.finishS, 'FINISH', [20, 20, 20], [250, 210, 40]);
    gantry(c.jump.footS - 30, 'BIG JUMP!', [255, 255, 255], [40, 110, 210]);
  }

  /**
   * End-jump dressing: painted distance lines every `markerStepM` across the landing zone, numbered boards
   * on both sides (one atlas texture, one draw call), and the gold bonus line with two tall gold posts and
   * waving flags (fog-free, so the bonus gate reads from the run-up).
   */
  private buildJump(): void {
    const c = this.data;
    const j = c.jump;
    const step = j.markerStepM;
    const hwRoad = c.halfWidthAt(j.lipS + 20);
    // ---- ground lines (vertex coloured, draped on the terrain)
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const white = new THREE.Color(0xf6f6f0);
    const gold = new THREE.Color(0xffc51a);
    const stripe = (s: number, width: number, color: THREE.Color, half: number): void => {
      const t = c.dirAt(s);
      const ctr = c.centre(s);
      const n = 16;
      const base = pos.length / 3;
      for (let k = 0; k <= n; k++) {
        const lat = -half + (2 * half * k) / n;
        for (const dz of [-width / 2, width / 2]) {
          const x = ctr.x + t.x * dz - t.y * lat;
          const z = ctr.y + t.y * dz + t.x * lat;
          pos.push(x, c.heightAt(x, z) + 0.06, z);
          col.push(color.r, color.g, color.b);
        }
        if (k > 0) {
          const a = base + (k - 1) * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // counter-clockwise from above
        }
      }
    };
    const maxD = j.runoffS - j.lipS;
    for (let d = step; d < maxD - 2; d += step) if (Math.abs(d - j.bonusM) > 0.5) stripe(j.lipS + d, 0.35, white, hwRoad + 2);
    stripe(j.bonusS, 1.0, gold, hwRoad + 4);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    lg.setIndex(idx);
    lg.computeVertexNormals();
    const lineMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.disposables.push(lineMat);
    const lines = new THREE.Mesh(lg, lineMat);
    lines.name = 'jump-lines';
    lines.receiveShadow = true;
    this.group.add(lines);

    // ---- numbered boards (atlas): "10" … plus the gold bonus number
    const marks: number[] = [];
    for (let d = step; d < maxD - 2; d += step) marks.push(d);
    if (!marks.includes(j.bonusM)) marks.push(j.bonusM);
    marks.sort((a, b) => a - b);
    const cells: SignCell[] = marks.map((d) =>
      d === j.bonusM ? { text: String(d), fg: [30, 20, 0], bg: [255, 205, 40], border: [200, 40, 30] } : { text: String(d), fg: [25, 25, 25], bg: [250, 250, 245], border: [40, 110, 210] },
    );
    const atlas = makeSignAtlas(cells, 4);
    this.disposables.push(atlas.texture);
    const S = 1.7; // board size (m)
    const Y0 = 0.7;
    const spos: number[] = [];
    const suv: number[] = [];
    const sidx: number[] = [];
    const posts = signPostsTemplate(S, Y0);
    const merger = new ChunkMerger(400);
    marks.forEach((d, i) => {
      const s = j.lipS + d;
      const t = c.dirAt(s);
      const ctr = c.centre(s);
      for (const side of [-1, 1]) {
        const lat = side * (hwRoad + 4.5);
        const x = ctr.x - t.y * lat;
        const z = ctr.y + t.x * lat;
        const y = c.heightAt(x, z);
        // Face back up the hill (toward the ramp) and turn 25° in toward the landing zone.
        const yaw = Math.atan2(-t.x, -t.y) - side * 0.45;
        merger.add(posts, x, y, z, yaw, 1);
        const fx = Math.cos(yaw);
        const fz = -Math.sin(yaw);
        const [u0, v0, u1, v1] = atlas.uv[i];
        const base = spos.length / 3;
        // Quad in the board plane (its normal is the board's +Z after the yaw).
        for (const [ax, ay, uu, vv] of [[-S / 2, Y0, u0, v0], [S / 2, Y0, u1, v0], [S / 2, Y0 + S, u1, v1], [-S / 2, Y0 + S, u0, v1]] as const) {
          spos.push(x + fx * ax, y + ay, z + fz * ax);
          suv.push(uu, vv);
        }
        sidx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    });
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(spos, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2));
    sg.setIndex(sidx);
    sg.computeVertexNormals();
    const signMat = new THREE.MeshLambertMaterial({ map: atlas.texture, side: THREE.DoubleSide });
    this.disposables.push(signMat);
    const signs = new THREE.Mesh(sg, signMat);
    signs.name = 'jump-signs';
    this.group.add(signs);
    const postMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.disposables.push(postMat);
    for (const m of merger.build(postMat, true)) this.group.add(m);

    // ---- bonus gate: two tall gold posts with waving gold flags and a "+1 BONUS" board between them
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xf0d26a, emissive: 0x3a2a00, fog: false });
    const ballMat = new THREE.MeshBasicMaterial({ color: 0xffe066, fog: false });
    const fg = new THREE.PlaneGeometry(3.2, 1.9, 10, 3).translate(1.6, 0, 0);
    this.flagGeo = fg;
    this.flagBase = new Float32Array(fg.attributes.position.array);
    const flagMat = new THREE.MeshLambertMaterial({ color: 0xffc51a, emissive: 0x6a4200, side: THREE.DoubleSide, fog: false });
    const poleGeo = new THREE.CylinderGeometry(0.16, 0.22, 10, 8);
    const ballGeo = new THREE.SphereGeometry(0.6, 12, 8);
    const t = c.dirAt(j.bonusS);
    const ctr = c.centre(j.bonusS);
    const yaw = Math.atan2(t.x, t.y);
    for (const side of [-1, 1]) {
      const lat = side * (hwRoad + 4.2);
      const x = ctr.x - t.y * lat;
      const z = ctr.y + t.x * lat;
      const y = c.heightAt(x, z);
      const g = new THREE.Group();
      g.position.set(x, y, z);
      g.rotation.y = yaw + Math.PI;
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = 5;
      pole.castShadow = true;
      const ball = new THREE.Mesh(ballGeo, ballMat);
      ball.position.y = 10.3;
      const flag = new THREE.Mesh(fg, flagMat);
      flag.position.set(0.15 * side, 8.9, 0);
      flag.rotation.y = side > 0 ? Math.PI : 0;
      flag.castShadow = true;
      this.flags.push(flag);
      g.add(pole, ball, flag);
      this.group.add(g);
    }
    const bw = (hwRoad + 4.2) * 2;
    const signTex = makeBannerTexture('+1 BONUS', [60, 30, 0], [255, 205, 40], false, 6, bw / 1.6);
    const bannerMat = new THREE.MeshLambertMaterial({ map: signTex, side: THREE.DoubleSide, fog: false });
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(bw, 1.6), bannerMat);
    banner.position.set(ctr.x, c.heightAt(ctr.x, ctr.y) + 7.2, ctr.y);
    banner.rotation.y = yaw + Math.PI;
    banner.castShadow = true;
    this.group.add(banner);
    this.disposables.push(poleMat, ballMat, flagMat, signTex, bannerMat, poleGeo, ballGeo);
  }

  private waveFlag(): void {
    if (!this.flagGeo || !this.flagBase) return;
    const pos = this.flagGeo.attributes.position as THREE.BufferAttribute;
    const b = this.flagBase;
    const t = this.time;
    for (let i = 0; i < pos.count; i++) {
      const x = b[i * 3];
      pos.setZ(i, Math.sin(x * 1.6 - t * 5) * 0.18 * (x / 3.2));
    }
    pos.needsUpdate = true;
  }
}

/** Height of the end-jump ramp face at z m from its foot: a circular arc reaching `deg` at the lip, scaled to `h`. */
export function rampProfile(len: number, h: number, deg: number): (z: number) => number {
  const th = (deg * Math.PI) / 180;
  const R = len / Math.sin(th);
  const yAt = (z: number): number => R - Math.sqrt(Math.max(0, R * R - z * z));
  const k = h / Math.max(1e-6, yAt(len));
  return (z) => yAt(THREE.MathUtils.clamp(z, 0, len)) * k;
}
