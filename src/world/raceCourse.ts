import * as THREE from 'three';
import type { GameContext } from '../core/context';
import { events } from '../core/events';
import { Group, groups, RAPIER } from '../core/physics';
import type { SpawnPoint, SurfaceType } from '../core/types';
import { Animals, type AnimalInfo } from './animals';
import { CourseData } from './course';
import { Obstacles } from './obstacles';
import {
  bridgeTemplate,
  bushTemplate,
  ChunkMerger,
  fenceTemplate,
  houseTemplate,
  pineTemplate,
  rampTemplate,
  rockTemplate,
  treeTemplate,
  tuftTemplate,
  type Template,
} from './props';
import { loadJSON, saveJSON } from '../core/storage';
import { createTerrainCollider, createTerrainMesh, type TerrainHandles, type TerrainShading } from './terrain';
import { makeAsphaltTexture, makeBannerTexture, makeCheckerTexture, makeWaterNormal } from './textures';
import type { Checkpoint, World, Zone } from './types';
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
 * The real ~2.4 km point-to-point course (SPEC "Track"). Implements `World`.
 *
 * Zones: town → farm → mud → rocky → desert → river → finish straight → bonus hill.
 * Physics: one heightfield (terrain incl. road, mud pit, river channel, hill, valley walls),
 * fixed boulders/ramps/bridge/fence-posts, dynamic hay & cones, light dynamic animals.
 * Rendering: ~1 draw call per 80 m terrain chunk (texture-array splat), props merged per 120 m chunk,
 * instanced debris, a handful of unique meshes (water, banners, flag).
 */
export class RaceCourse implements World {
  readonly data: CourseData;
  readonly track: CourseData['track'];
  readonly zones: readonly Zone[];
  readonly checkpoints: readonly Checkpoint[];
  readonly spawns: { player: SpawnPoint; cpu: SpawnPoint };
  readonly summit: THREE.Vector3;
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
  flag: THREE.Mesh | null = null;
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
    this.summit = c.summit.clone();
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
    this.buildSummitFlag();
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

  /** Asphalt ribbon through the town (the only textured road mesh; other roads are terrain layers). */
  private buildRoad(): void {
    const c = this.data;
    const town = c.zone('town');
    const s0 = 0;
    const s1 = town.endS + 6;
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
      const fade = s > town.endS - 4 ? 1 - (s - (town.endS - 4)) / 10 : 1;
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
    const tex = makeAsphaltTexture(this.ctx.quality.preset.textureSize);
    this.disposables.push(tex);
    const mat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.disposables.push(mat);
    // Split into ~120 m pieces for frustum culling.
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'asphalt';
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
    const boulderT = variants(3, (v) => rockTemplate(v, 0x9a8f80));
    const houses: Record<number, Template> = {};
    for (const t of c.trees) big.add(trees[t.v % 4], t.x, t.y - 0.1, t.z, t.yaw, t.scale);
    for (const t of c.pines) big.add(pines[t.v % 4], t.x, t.y - 0.1, t.z, t.yaw, t.scale * 1.15);
    for (const h of c.houses) big.add((houses[h.v] ??= houseTemplate(h.v)), h.x, h.y - 0.2, h.z, h.yaw, h.v >= 10 ? 1 : h.scale);
    for (const b of c.boulders) big.add(boulderT[b.v % 3], b.x, b.y - 0.25 * b.scale, b.z, b.yaw, b.scale * 1.1);
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
    for (const r of c.ramps) big.add(rampTemplate(r.halfWidth, r.length, r.height), r.x, r.y - 0.02, r.z, r.yaw, 1);
    const b = c.bridge;
    big.add(bridgeTemplate(b.length, b.halfWidth, 0, 3), b.x, b.y, b.z, b.yaw, 1);
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
      const desert = c.zoneAt(c.fieldsAt(r.x, r.z).s).id === 'desert';
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

  private buildWater(): void {
    const c = this.data;
    const r = c.river;
    const len = r.bMax - r.bMin + 24;
    const geo = new THREE.PlaneGeometry(22, len, 1, 1).rotateX(-Math.PI / 2);
    const normal = makeWaterNormal(this.ctx.quality.preset.textureSize);
    normal.repeat.set(22 / 6, len / 6);
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
    // Plane local X = across the river, local Z = along.
    const mid = (r.bMin + r.bMax) / 2;
    mesh.position.set(r.origin.x + r.along.x * mid, r.water, r.origin.y + r.along.y * mid);
    mesh.rotation.y = Math.atan2(r.across.x, r.across.y) - Math.PI / 2;
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
  }

  private buildSummitFlag(): void {
    const c = this.data;
    const s = this.summit;
    const g = new THREE.Group();
    g.position.copy(s);
    // A tall golden pole (visible from far away) with a golden flag and a beacon ball on top.
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xf0d26a, emissive: 0x3a2a00 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 14, 8), poleMat);
    pole.position.y = 7;
    pole.castShadow = true;
    const ballMat = new THREE.MeshBasicMaterial({ color: 0xffe066, fog: false }); // beacon: never fogged, so the summit reads from the start
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), ballMat);
    ball.position.y = 14.4;
    const fg = new THREE.PlaneGeometry(4.4, 2.6, 12, 4).translate(2.2, 0, 0);
    this.flagGeo = fg;
    this.flagBase = new Float32Array(fg.attributes.position.array);
    const flagMat = new THREE.MeshLambertMaterial({ color: 0xffc51a, emissive: 0x6a4200, side: THREE.DoubleSide, fog: false });
    const flag = new THREE.Mesh(fg, flagMat);
    flag.position.set(0.15, 12.4, 0);
    flag.castShadow = true;
    this.flag = flag;
    // A small "+1" sign at the base.
    const signTex = makeBannerTexture('+1 BONUS', [255, 255, 255], [40, 120, 200], false, 5, 3.6 / 0.9);
    const signMat = new THREE.MeshLambertMaterial({ map: signTex, side: THREE.DoubleSide });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), signMat);
    sign.position.set(0, 2.2, 0.3);
    const yaw = c.spawnAt(c.summitS, 0).yaw + Math.PI;
    g.rotation.y = yaw;
    g.add(pole, ball, flag, sign);
    this.group.add(g);
    this.disposables.push(poleMat, ballMat, flagMat, signTex, signMat);
  }

  private waveFlag(): void {
    if (!this.flagGeo || !this.flagBase) return;
    const pos = this.flagGeo.attributes.position as THREE.BufferAttribute;
    const b = this.flagBase;
    const t = this.time;
    for (let i = 0; i < pos.count; i++) {
      const x = b[i * 3];
      pos.setZ(i, Math.sin(x * 1.6 - t * 5) * 0.18 * (x / 4.4));
    }
    pos.needsUpdate = true;
  }
}
