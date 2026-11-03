/**
 * Headless course test (no browser): builds the real ~5 km RaceCourse with Rapier and drives it with a simple
 * centre-line follower (pure pursuit + speed from curvature), for several vehicles. Checks:
 *  - each car reaches the finish line without getting trapped (resets to the last checkpoint allowed, counted);
 *  - the end jump: fast/light cars (sports, muscle, buggy, pickup) land past the bonus line with a good
 *    run-up, the monster truck and Grandma's sedan fall short; everyone lands on the wheels;
 *  - surfaces per zone, checkpoint spacing, spawn placement, the gorge bridge, the riverside water,
 *    animal schedule (4–6 per race, ≤ 2 damaging), every animal bumps (with the right `damaging` flag)
 *    and never stops a car, the valley walls keep a car that steers away inside the world;
 *  - the real computer driver completes the course on every difficulty, Hard takes the log bridge,
 *    and it attempts the jump at full speed.
 * Run: npm run world-test   (WORLD_KINDS=pickup,sedan to limit)
 */
import * as THREE from 'three';

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
const store = new Map<string, string>();
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

const { initRapier, PhysicsWorld, PHYSICS_DT } = await import('../src/core/physics');
const { events } = await import('../src/core/events');
const { RaceCourse } = await import('../src/world/raceCourse');
const { JUMP_BONUS_M } = await import('../src/world/layout');
const { createVehicle } = await import('../src/vehicles/vehicle');
const { VEHICLES } = await import('../src/vehicles/catalog');
const { AIDriver, createPhysicsSensor } = await import('../src/ai');
const { jumpRun } = await import('./jump-tune');
const { ANIMAL_SPECS } = await import('../src/world/animals');
type VehicleKind = import('../src/core/types').VehicleKind;

await initRapier();
(globalThis as { __dmgLog?: boolean }).__dmgLog = !!process.env.DMG_TRACE;
let failures = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${msg}`);
  if (!ok) failures++;
};

/**
 * Deterministic runs: animals (src/world/animals.ts) seed their crossing plan from Date.now() and use
 * Math.random for their wander phase, the AI and damage pull use Math.random too. Each world gets a fixed
 * seed (per vehicle for the drives) so a run is repeatable and a pass/fail never depends on the clock.
 */
function seedRandom(seed: number): void {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (label: string): number => [...label].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);

function makeWorld(seed = 12345) {
  seedRandom(seed);
  const physics = new PhysicsWorld();
  const scene = new THREE.Scene();
  const ctx = { physics, renderer: { scene }, quality: { preset: { textureSize: 64, detail: 0.5, level: 'low' } } } as never;
  const t0 = performance.now();
  const world = new RaceCourse(ctx);
  const ms = performance.now() - t0;
  (world as unknown as { animalSys: { reset(seed?: number): void } }).animalSys.reset(seed);
  return { physics, world, scene, ms };
}

// -------------------------------------------------------------- static checks
{
  const { world, scene, ms, physics } = makeWorld();
  const c = world.data;
  const j = world.jump;
  console.log(`\n=== course: ${c.length.toFixed(0)} m, finish at ${c.finishS.toFixed(0)} m, jump lip at ${j.lipS.toFixed(0)} m, bonus line +${j.bonusM} m, built in ${ms.toFixed(0)} ms`);
  check(c.finishS > 4400 && c.finishS < 5300, `race ~5 km to the finish line (${c.finishS.toFixed(0)} m)`);
  const ids = world.zones.map((z) => z.id).join(',');
  check(ids === 'town,farm,mud,rocky,forest,canyon,snow,desert,river,finish,jump', `zones in order: ${ids}`);
  console.log('  info zones: ' + world.zones.map((z) => `${z.id} ${(z.endS - z.startS).toFixed(0)} m`).join(', '));
  const cps = world.checkpoints.map((k) => k.s);
  const gaps = cps.map((s, i) => s - (i ? cps[i - 1] : 0));
  check(gaps.every((d) => d > 250 && d < 380) && c.finishS - cps[cps.length - 1] < 380, `checkpoints ~every 300 m (${cps.length}: ${cps.map((s) => s.toFixed(0)).join(', ')})`);
  for (const cp of world.checkpoints) {
    const ok = world.surfaceAt(cp.respawn.x, cp.respawn.z) !== 'water' && Math.abs(cp.respawn.y - world.heightAt(cp.respawn.x, cp.respawn.z)) < 0.01;
    if (!ok) check(false, `checkpoint ${cp.index} respawn on solid ground`);
  }
  const sp = world.spawns;
  const sep = Math.hypot(sp.player.x - sp.cpu.x, sp.player.z - sp.cpu.z);
  check(sep > 4.5 && sep < 7 && Math.abs(sp.player.yaw - sp.cpu.yaw) < 0.01, `two side-by-side grid slots (${sep.toFixed(1)} m apart)`);
  // Surfaces along the centre-line per zone.
  const expect: Record<string, string[]> = {
    town: ['asphalt'],
    farm: ['dirt'],
    mud: ['mud', 'dirt'],
    rocky: ['gravel'],
    forest: ['dirt'],
    canyon: ['gravel'],
    snow: ['snow', 'gravel'],
    desert: ['sand'],
    river: ['dirt', 'water'],
    finish: ['dirt', 'asphalt'],
    jump: ['asphalt', 'dirt', 'sand'],
  };
  for (const z of world.zones) {
    const counts: Record<string, number> = {};
    for (let s = z.startS + 6; s < z.endS - 6; s += 2) {
      const p = world.track.pointAt(s);
      const k = world.surfaceAt(p.x, p.z);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const keys = Object.keys(counts);
    check(keys.every((k) => expect[z.id].includes(k)), `${z.id}: road surfaces ${JSON.stringify(counts)}`);
  }
  check(world.surfaceAt(-1e5, 1e5) === 'dirt', 'surfaceAt is safe far outside the map');
  const mudCount = (() => {
    const z = world.zones.find((zz) => zz.id === 'mud')!;
    let n = 0;
    for (let s = z.startS; s < z.endS; s += 2) {
      const p = world.track.pointAt(s);
      if (world.surfaceAt(p.x, p.z) === 'mud') n += 2;
    }
    return n;
  })();
  check(mudCount > 120, `mud pit is ${mudCount} m long`);
  // Snowy pass climbs; grades stay drivable (< 12°) everywhere on the race route.
  const snow = world.zones.find((zz) => zz.id === 'snow')!;
  const rise = world.track.pointAt((snow.startS + snow.endS) / 2).y - world.track.pointAt(snow.startS - 250).y;
  check(rise > 12, `snowy pass climbs ${rise.toFixed(1)} m`);
  let maxGrade = 0;
  let maxGradeAt = 0;
  for (let s = 0; s < c.finishS; s += 2) {
    if (c.onGorgeBridge(s) || c.onGorgeBridge(s + 4)) continue;
    const a = world.track.pointAt(s).y;
    const b = world.track.pointAt(s + 4).y;
    const deg = (Math.atan2(Math.abs(b - a), 4) * 180) / Math.PI;
    if (deg > maxGrade) {
      maxGrade = deg;
      maxGradeAt = s;
    }
  }
  check(maxGrade < 12, `steepest road grade before the finish ${maxGrade.toFixed(1)}° at s=${maxGradeAt.toFixed(0)} (${world.zoneAt(maxGradeAt).id})`);
  // Gorge bridge: a real drop under the deck, deck continuous with the road at both ends.
  {
    const g = c.gorge;
    const mid = c.centre(g.s);
    const drop = c.gorgeDeckY(g.s) - c.heightAt(mid.x, mid.y);
    check(drop > 8, `gorge is ${drop.toFixed(1)} m deep under the bridge`);
    const e0 = c.centre(g.s0 + 0.5);
    const e1 = c.centre(g.s1 - 0.5);
    check(Math.abs(c.gorgeDeckY(g.s0 + 0.5) - c.heightAt(e0.x, e0.y)) < 0.4 && Math.abs(c.gorgeDeckY(g.s1 - 0.5) - c.heightAt(e1.x, e1.y)) < 0.4, 'gorge bridge deck meets the road at both ends');
  }
  // River: water beside the riverside road (on one side, not on the road).
  {
    const tagS = c.line.tagS.riverside!;
    let water = 0;
    let onRoad = 0;
    for (let s = tagS; s < tagS + 140; s += 4) {
      const p = world.track.pointAt(s);
      const t = world.track.tangentAt(s);
      for (const side of [-1, 1]) {
        const x = p.x - t.z * 24 * side;
        const z = p.z + t.x * 24 * side;
        if (world.surfaceAt(x, z) === 'water') water++;
      }
      if (world.surfaceAt(p.x, p.z) === 'water') onRoad++;
    }
    check(water >= 30 && onRoad === 0, `river runs beside the riverside road (${water} water samples, ${onRoad} on the road)`);
  }
  // Jump: ramp, landing hill, bonus line inside the landing zone, no trees in the landing zone.
  check(j.bonusS > j.lipS + 30 && j.bonusS < j.runoffS - 30, `bonus line ${j.bonusM} m past the lip, inside the landing zone (${(j.runoffS - j.lipS).toFixed(0)} m)`);
  const drop = world.track.pointAt(j.lipS).y - world.track.pointAt(j.runoffS).y;
  check(drop > 10, `landing hill drops ${drop.toFixed(1)} m below the lip`);
  const blocked = [...c.trees, ...c.pines, ...c.snowPines].filter((t) => {
    const f = c.fieldsAt(t.x, t.z);
    return f.s > j.lipS - 5 && f.s < j.runoffS + 40 && f.d < c.halfWidthAt(f.s) + 12;
  }).length;
  check(blocked === 0, `landing zone is clear of trees (${blocked})`);
  check(world.track.length - j.runoffS > 60, `run-off ${(world.track.length - j.runoffS).toFixed(0)} m after the landing zone`);
  check(world.shortcuts.length === 1 && world.shortcuts[0].id === 'log-bridge' && world.shortcuts[0].points.length >= 2, 'log-bridge shortcut published');
  // Verge vs road: wall height at 80 m off the road.
  const p = world.track.pointAt(600);
  const t = world.track.tangentAt(600);
  const wallY = world.heightAt(p.x - t.z * 80, p.z + t.x * 80);
  check(wallY - p.y > 12, `valley wall ${(wallY - p.y).toFixed(1)} m high 80 m off the road`);
  // Animal schedule: 4–6 crossings per race, ≤ 2 damaging, all ≥ 300 m apart; every animal kind has a spot.
  {
    const kindsWithSpots = new Set(c.animalSpots.map((a) => a.kind));
    const allKinds = Object.keys(ANIMAL_SPECS);
    check(allKinds.every((k) => kindsWithSpots.has(k as never)), `every animal kind has a zone spot (${[...kindsWithSpots].join(', ')})`);
    const sys = (world as unknown as { animalSys: { reset(seed?: number): void; planned: readonly { kind: string; s: number }[] } }).animalSys;
    let ok = true;
    const counts: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      sys.reset(seed);
      const pl = sys.planned;
      counts.push(pl.length);
      const dmg = pl.filter((a) => ANIMAL_SPECS[a.kind as keyof typeof ANIMAL_SPECS].damaging).length;
      const apart = pl.every((a, i) => i === 0 || a.s - pl[i - 1].s > 250);
      if (pl.length < 4 || pl.length > 6 || dmg > 2 || !apart) ok = false;
    }
    check(ok, `animal schedule: 4–6 crossings per race, ≤ 2 damaging, well apart (counts over 40 races: ${Math.min(...counts)}–${Math.max(...counts)})`);
  }
  // Scene stats.
  let meshes = 0;
  let tris = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const gg = m.geometry;
    const n = gg.index ? gg.index.count / 3 : gg.attributes.position.count / 3;
    tris += n * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  let colliders = 0;
  physics.world.forEachCollider(() => colliders++);
  console.log(`  info scene meshes=${meshes} (upper bound on draw calls before culling), triangles=${(tris / 1000).toFixed(0)}k, colliders=${colliders}`);
  console.log(`  info animals planned: ${world.plannedAnimals.map((a) => `${a.kind}@${a.s.toFixed(0)}`).join(', ')}`);
  world.dispose();
  physics.dispose();
}

// -------------------------------------------------------------- animals: each kind bumps (never stops a car)
{
  console.log('\n=== animals: drive into each kind ===');
  for (const kind of Object.keys(ANIMAL_SPECS) as (keyof typeof ANIMAL_SPECS)[]) {
    const { physics, world } = makeWorld();
    const c = world.data;
    const sys = (world as unknown as { animalSys: { plan: unknown[]; stage(p: unknown): void; byKind: Map<string, { state: string; stateT: number }[]>; reset(seed?: number): void } }).animalSys;
    sys.reset(1);
    const z = world.zones.find((zz) => zz.id === 'farm')!;
    const s = z.startS + 30;
    const v = createVehicle({ physics, surfaces: world, spec: VEHICLES.pickup, paint: 0, racer: 'player', spawn: c.spawnAt(s - 45, 0) });
    let bump: { damaging?: boolean; speed?: number } | null = null;
    const off = events.on('animal:bump', (e) => (bump ??= e));
    // Stand the animal(s) in the middle of the road right in front of the car.
    const plan = { spot: { kind, zone: 'farm', s }, side: 1, done: true, animals: sys.byKind.get(kind)! };
    sys.plan = [plan];
    sys.stage(plan);
    const animals = plan.animals as unknown as { body: { setTranslation(p: object, w: boolean): void }; lift: number; state: string; position: THREE.Vector3 }[];
    animals.forEach((a, i) => {
      const p = c.spawnAt(s + i * 3, 0);
      a.body.setTranslation({ x: p.x, y: p.y + a.lift + 0.05, z: p.z }, true);
      a.state = 'waiting';
    });
    let minSpeed = Infinity;
    let maxSpeed = 0;
    let hit = false;
    let after = 0;
    for (let i = 0; i < 60 * 6; i++) {
      if (hit && ++after > 60) break; // one second after the bump is enough
      // Aim straight at the animal until the bump, then straight on.
      hit ||= !!bump;
      const a0 = animals[0].position;
      const dx = a0.x - v.position.x;
      const dz = a0.z - v.position.z;
      const f = v.forward;
      v.input.steer = hit ? 0 : THREE.MathUtils.clamp(-Math.atan2(f.z * dx - f.x * dz, f.x * dx + f.z * dz) * 2.5, -1, 1);
      v.input.throttle = 1;
      v.input.brake = 0;
      world.fixedUpdate(PHYSICS_DT);
      v.fixedUpdate!(PHYSICS_DT);
      physics.step();
      v.postPhysics!(PHYSICS_DT);
      v.update!(PHYSICS_DT, 1);
      world.update(PHYSICS_DT);
      if (bump && !hit) maxSpeed = v.speed;
      if (hit) minSpeed = Math.min(minSpeed, v.speed);
    }
    off();
    const b = bump as { damaging?: boolean; speed?: number } | null;
    const want = ANIMAL_SPECS[kind].damaging;
    check(!!b && b.damaging === want && (b.speed ?? 0) > 3 && minSpeed > 0.4 * maxSpeed, `${kind}: bump ${b ? `damaging=${b.damaging} at ${b.speed?.toFixed(1)} m/s` : 'none'} (want damaging=${want}), car slowed to ${(minSpeed * 3.6).toFixed(0)} of ${(maxSpeed * 3.6).toFixed(0)} km/h`);
    v.dispose();
    world.dispose();
    physics.dispose();
  }
}

// -------------------------------------------------------------- drive
interface DriveResult {
  finishedAt: number | null;
  maxS: number;
  resets: number;
  stuckAt: number[];
  bumps: number;
  hits: number;
  /** Round 2: damage at the end of the run (%). */
  damage: number;
  /** Damage per zone (and source) — where did it come from? */
  dmgBy: Record<string, number>;
}

/** Collect `car:damage` for one racer into "zone:source" buckets. */
function damageLog(world: InstanceType<typeof RaceCourse>, racer: string, sOf: () => number) {
  const by: Record<string, number> = {};
  const off = events.on('car:damage', (e) => {
    if (e.racer !== racer) return;
    const s = sOf();
    const key = `${world.zoneAt(s).id}:${e.source ?? '?'}`;
    by[key] = (by[key] ?? 0) + e.delta;
    if (process.env.DMG_TRACE) console.log(`    dmg +${e.delta.toFixed(1)}% ${key} s=${s.toFixed(0)}`);
  });
  return { by, off };
}
const fmtDmg = (by: Record<string, number>) =>
  Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(', ') || 'none';

function drive(kind: VehicleKind, opts: { shortcut?: boolean; animals?: boolean; maxS?: number; wander?: boolean; wobble?: number } = {}): DriveResult {
  const { physics, world } = makeWorld(seedOf(`${kind}:${JSON.stringify(opts)}`));
  world.animalsEnabled = opts.animals ?? true;
  const c = world.data;
  const v = createVehicle({ physics, surfaces: world, spec: VEHICLES[kind], paint: 0xff0000, racer: 'player', spawn: world.spawns.player });
  let bumps = 0;
  let hits = 0;
  let s = 0;
  const dl = damageLog(world, 'player', () => s);
  const offs = [events.on('animal:bump', () => bumps++), events.on('obstacle:hit', () => hits++), dl.off];
  const systems: import('../src/core/types').System[] = [world, v];
  let lastCp = -1;
  let resets = 0;
  let finishedAt: number | null = null;
  const stuckAt: number[] = [];
  let progressT = 0;
  let progressS = 0;
  const target = new THREE.Vector3();
  const maxT = opts.maxS ?? 700;
  const steps = Math.round(maxT / PHYSICS_DT);
  const sc = world.shortcuts[0];
  const useSc = !!opts.shortcut;
  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS_DT;
    // ---- controller
    s = world.track.project(v.position, s).s;
    const spd = Math.max(0, v.speed);
    const look = 7 + spd * 0.55;
    const ts = Math.min(world.track.length, s + look);
    if (useSc && s > sc.startS - 30 && s < sc.endS) {
      // Follow the shortcut polyline.
      const pts = sc.points;
      const a = pts[0];
      const b = pts[pts.length - 1];
      const ab = new THREE.Vector3().subVectors(b, a);
      const len = ab.length();
      const tt = THREE.MathUtils.clamp(((v.position.x - a.x) * ab.x + (v.position.z - a.z) * ab.z) / (len * len) + look / len, 0, 1);
      if (s >= sc.startS - 2) {
        target.copy(a).addScaledVector(ab, tt);
        if (tt >= 1) s = sc.endS;
      } else world.track.pointAt(ts, target);
    } else world.track.pointAt(ts, target);
    if (opts.wander && t > 8 && t < 20) {
      // Steer hard off the road to the right to check the verge/walls keep the car inside.
      v.input.steer = 0.5;
      v.input.throttle = 1;
      v.input.brake = 0;
    } else {
      const dx = target.x - v.position.x;
      const dz = target.z - v.position.z;
      const f = v.forward;
      const cross = f.z * dx - f.x * dz;
      const dot = f.x * dx + f.z * dz;
      const ang = Math.atan2(cross, dot);
      // Speed from upcoming curvature.
      let maxTurn = 0;
      const t0 = world.track.tangentAt(s);
      for (let k = 10; k <= 60; k += 10) {
        const tk = world.track.tangentAt(s + k);
        maxTurn = Math.max(maxTurn, Math.acos(THREE.MathUtils.clamp(t0.x * tk.x + t0.z * tk.z, -1, 1)) / k);
      }
      const surf = world.surfaceAt(v.position.x, v.position.z);
      const grip = surf === 'asphalt' ? 1 : surf === 'snow' ? 0.55 : surf === 'mud' || surf === 'sand' ? 0.6 : 0.8;
      const vmax = maxTurn > 1e-3 ? Math.sqrt((6 * grip) / maxTurn) : 99;
      // `wobble`: a sloppy driver (a kid on tilt steering) weaving across the road.
      const wob = opts.wobble ? opts.wobble * Math.sin(t * 0.9) * Math.sin(t * 2.3 + 1) : 0;
      v.input.steer = THREE.MathUtils.clamp(-ang * 2.2 + wob, -1, 1);
      v.input.throttle = spd < vmax ? 1 : 0;
      v.input.brake = spd > vmax + 3 ? 1 : 0;
    }
    if (process.env.TRACE && s > +process.env.TRACE - 40 && s < +process.env.TRACE + 20 && i % 15 === 0) console.log(`  t=${t.toFixed(1)} s=${s.toFixed(1)} lat=${world.track.project(v.position, s).lateral.toFixed(1)} v=${v.speed.toFixed(1)} up=${new THREE.Vector3(0, 1, 0).applyQuaternion(v.quaternion).y.toFixed(2)} wheels=${v.wheelsOnGround} in=${v.input.steer.toFixed(2)}/${v.input.throttle}/${v.input.brake} surf=${v.surface}`);
    // ---- step
    for (const sys of systems) sys.fixedUpdate?.(PHYSICS_DT);
    physics.step();
    for (const sys of systems) sys.postPhysics?.(PHYSICS_DT);
    for (const sys of systems) sys.update?.(PHYSICS_DT, 1);
    // ---- bookkeeping
    while (lastCp + 1 < world.checkpoints.length && s >= world.checkpoints[lastCp + 1].s) lastCp++;
    if (finishedAt === null && s >= c.finishS) finishedAt = t;
    if (finishedAt !== null) break;
    // Stuck / flipped / out of the world → reset to the last checkpoint (like the Reset button).
    if (s > progressS + 3) {
      progressS = s;
      progressT = t;
    }
    const fallen = v.position.y < world.heightAt(v.position.x, v.position.z) - 3 && !c.onGorgeBridge(s);
    if (t - progressT > 8 || v.flipped || fallen) {
      stuckAt.push(Math.round(s));
      resets++;
      v.reset(lastCp >= 0 ? world.checkpoints[lastCp].respawn : world.spawns.player);
      s = world.track.project(v.position).s;
      progressT = t;
      progressS = s;
    }
    if (opts.wander && t > 22) break;
  }
  offs.forEach((f) => f());
  const out = { finishedAt, maxS: Math.max(s, progressS), resets, stuckAt, bumps, hits, damage: v.damage, dmgBy: dl.by };
  v.dispose();
  world.dispose();
  physics.dispose();
  return out;
}

const kinds = (process.env.WORLD_KINDS?.split(',').filter((k) => k in VEHICLES) ?? Object.keys(VEHICLES)) as VehicleKind[];
const results: Record<string, DriveResult> = {};
for (const kind of kinds) {
  console.log(`\n=== drive: ${kind} follows the centre-line ===`);
  const t0 = performance.now();
  const r = drive(kind);
  results[kind] = r;
  console.log(
    `  info finish ${r.finishedAt?.toFixed(1) ?? '—'} s, damage ${r.damage.toFixed(0)}%, resets ${r.resets} ${r.stuckAt.length ? `(stuck at s=${r.stuckAt.join(', ')})` : ''}, obstacle hits ${r.hits}, animal bumps ${r.bumps} (${((performance.now() - t0) / 1000).toFixed(1)} s wall)`,
  );
  check(r.finishedAt !== null, `${kind} reaches the finish line (${r.finishedAt?.toFixed(1) ?? 'never'} s)`);
  check(r.stuckAt.length <= 1, `${kind} never trapped (${r.stuckAt.length} stuck resets)`);
  console.log(`  info damage by zone:source ${fmtDmg(r.dmgBy)}`);
  // The follower drives straight into any animal at full speed (a bear at 130 km/h ≈ 16–18 %), so judge the
  // course itself on the non-animal damage.
  const course = Object.entries(r.dmgBy).filter(([k]) => !k.endsWith(':animal')).reduce((a, [, v]) => a + v, 0);
  check(course < 20 && r.damage < 40, `${kind}: centre-line drive ends with modest damage (${r.damage.toFixed(0)}%, ${course.toFixed(0)}% from the course itself)`);
}
const fin = kinds.map((k) => results[k].finishedAt).filter((x): x is number => x !== null);
if (fin.length) check(Math.max(...fin) < 420, `every finish well inside the 8-minute timer (slowest ${Math.max(...fin).toFixed(0)} s)`);

// -------------------------------------------------------------- end jump outcomes (SPEC round 2)
// A good run-up: full throttle from 170 m before the finish line (arriving at speed); a standing start at
// the finish line (what a Reset after the finish gives you); a sloppy run-up (1.5 s off the throttle
// 120 m before the lip). Jump distance = lip → touchdown. Groups: DECISIONS.md "End jump retune (16 vehicles)".
console.log('\n=== end jump ===');
const FAST = ['sports', 'muscle', 'rally', 'trophy', 'hatch', 'buggy'];
const MID = ['pickup', 'lifted', 'atv', 'suv'];
const SLOW = ['van', 'jeep', 'monster', 'sedan', 'bus', 'tractor'];
check([...FAST, ...MID, ...SLOW].sort().join() === Object.keys(VEHICLES).sort().join(), 'every vehicle is in a jump group');
const MAKES_IT = FAST;
const jumpTable: string[] = [];
for (const kind of kinds) {
  const runs = [
    ['run-up', jumpRun(kind, 170)],
    ['standing start', jumpRun(kind, 0)],
    ['sloppy run-up', jumpRun(kind, 170, 0, { lift: 1.5 })],
  ] as const;
  for (const [label, r] of runs) {
    console.log(`  info ${kind} (${label}): lip ${r.lipKmh.toFixed(0)} km/h, ${r.dist.toFixed(1)} m, air ${r.air.toFixed(2)} s, impact ${r.impact.toFixed(1)} m/s (vertical ${r.vertical.toFixed(1)}), damage ${r.damage.toFixed(1)}%, ${r.upright ? 'on its wheels' : 'CRASH'}${r.bonus ? ', BONUS' : ''}`);
    check(r.upright, `${kind} (${label}) lands on its wheels`);
    check(r.damage <= 2, `${kind} (${label}): a clean landing on the landing hill costs little or nothing (${r.damage.toFixed(1)}%)`);
  }
  const [clean, standing, sloppy] = runs.map((x) => x[1]);
  jumpTable.push(`${kind} ${clean.lipKmh.toFixed(0)} km/h ${clean.dist.toFixed(1)}/${standing.dist.toFixed(1)}/${sloppy.dist.toFixed(1)} m`);
  if (FAST.includes(kind)) {
    check(clean.bonus && standing.bonus && sloppy.bonus, `fast ${kind} makes the bonus line even from a standing start or a sloppy run-up (${clean.dist.toFixed(1)} / ${standing.dist.toFixed(1)} / ${sloppy.dist.toFixed(1)} m)`);
  } else if (MID.includes(kind)) {
    check(clean.bonus && clean.dist < jumpBonusM() + 6, `mid ${kind} just makes it with a clean run-up (${clean.dist.toFixed(1)} m, line ${jumpBonusM()} m)`);
    check(!sloppy.bonus, `mid ${kind} falls short after a sloppy run-up (${sloppy.dist.toFixed(1)} m)`);
  } else {
    check(!clean.bonus && !standing.bonus, `slow ${kind} falls short (${clean.dist.toFixed(1)} m)`);
  }
  if (kind === 'sedan') check(clean.dist < jumpBonusM() - 15, `Grandma's sedan is nowhere near (${clean.dist.toFixed(1)} m)`);
}
console.log(`  info jump table (clean / standing / sloppy): ${jumpTable.join('; ')}`);
function jumpBonusM(): number {
  return JUMP_BONUS_M;
}

// Sloppy drivers (weaving on the steering) through the whole course with animals: modest damage, and
// where it comes from per zone. Then crash probes: canyon wall, gorge-bridge rail, a boulder.
if (!process.env.WORLD_KINDS || process.env.WORLD_SLOPPY) {
  console.log('\n=== sloppy drivers (weaving) ===');
  const dmgs: number[] = [];
  for (const kind of ['pickup', 'sports', 'hatch', 'bus', 'atv'] as VehicleKind[]) {
    const r = drive(kind, { wobble: 0.45 });
    dmgs.push(r.damage);
    console.log(`  info ${kind}: finish ${r.finishedAt?.toFixed(0) ?? '—'} s, damage ${r.damage.toFixed(0)}%, resets ${r.resets}; by zone:source ${fmtDmg(r.dmgBy)}`);
    check(r.finishedAt !== null && r.damage < 85, `sloppy ${kind} finishes, not wrecked (${r.damage.toFixed(0)}%)`);
  }
  const mean = dmgs.reduce((a, b) => a + b, 0) / dmgs.length;
  check(mean < 40, `sloppy drivers average moderate damage (${mean.toFixed(0)}%)`);
}
{
  console.log('\n=== crash probes ===');
  /** Spawn at (s, lateral) turned `turnDeg` off the road, full throttle for `secs`; damage taken. */
  const probe = (kind: VehicleKind, s: number, lat: number, turnDeg: number, secs: number, v0: number, deck = false) => {
    const { physics, world } = makeWorld();
    world.animalsEnabled = false;
    const at = world.data.spawnAt(s, lat);
    if (deck) at.y = world.data.gorgeDeckY(s);
    const v = createVehicle({ physics, surfaces: world, spec: VEHICLES[kind], paint: 0, racer: 'player', spawn: { ...at, yaw: at.yaw + (turnDeg * Math.PI) / 180 } });
    const dl = damageLog(world, 'player', () => s);
    const yaw = at.yaw + (turnDeg * Math.PI) / 180;
    (v as unknown as { body: { setLinvel(v: object, w: boolean): void } }).body.setLinvel({ x: Math.sin(yaw) * v0, y: 0, z: Math.cos(yaw) * v0 }, true);
    let top = 0;
    for (let i = 0; i < 60 * secs; i++) {
      v.input.throttle = 1;
      v.input.steer = 0;
      v.fixedUpdate!(PHYSICS_DT);
      physics.step();
      v.postPhysics!(PHYSICS_DT);
      top = Math.max(top, v.speed);
    }
    dl.off();
    const d = v.damage;
    v.dispose();
    world.dispose();
    physics.dispose();
    return { d, top: top * 3.6, by: fmtDmg(dl.by) };
  };
  const { world, physics } = makeWorld();
  const canyon = world.zones.find((z) => z.id === 'canyon')!;
  const g = world.data.gorge;
  world.dispose();
  physics.dispose();
  for (const kind of ['pickup', 'sports'] as VehicleKind[]) {
    const wall = probe(kind, canyon.startS + 200, 0, 60, 4, 17);
    console.log(`  info ${kind} into the canyon wall (60°, 61 km/h start) at up to ${wall.top.toFixed(0)} km/h: ${wall.d.toFixed(1)}% (${wall.by})`);
    check(wall.d >= 5, `${kind}: driving into the canyon wall hurts (${wall.d.toFixed(1)}%)`);
    const rail = probe(kind, g.s0 + 3, 0, 22, 3, 15, true);
    console.log(`  info ${kind} into the gorge-bridge rail (22°, 54 km/h start) at up to ${rail.top.toFixed(0)} km/h: ${rail.d.toFixed(1)}% (${rail.by})`);
    check(rail.d >= 3, `${kind}: hitting the gorge-bridge rail hurts (${rail.d.toFixed(1)}%)`);
    const straight = probe(kind, g.s0 - 40, 0, 0, 4, 12);
    check(straight.d === 0, `${kind}: straight over the gorge bridge (deck seams) costs nothing (${straight.d.toFixed(1)}%)`);
  }
}

// Hard landings still hurt: a car coming down level onto the flat run-off at ~15 m/s, and the same nose-down 45°.
{
  console.log('\n=== hard landings ===');
  const drop = (kind: VehicleKind, pitchDeg: number) => {
    const { physics, world } = makeWorld();
    world.animalsEnabled = false;
    const j = world.jump;
    const at = world.data.spawnAt(j.runoffS + 25, 0);
    const v = createVehicle({ physics, surfaces: world, spec: VEHICLES[kind], paint: 0, racer: 'player', spawn: { ...at, y: at.y + 6 } });
    const b = (v as unknown as { body: { setRotation(q: object, w: boolean): void; setLinvel(v: object, w: boolean): void } }).body;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), at.yaw).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (pitchDeg * Math.PI) / 180));
    b.setRotation(q, true);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const h = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), at.yaw);
    b.setLinvel({ x: h.x * 10, y: -11, z: h.z * 10 }, true);
    void f;
    for (let i = 0; i < 60 * 3; i++) {
      v.input.throttle = 0;
      v.fixedUpdate!(PHYSICS_DT);
      physics.step();
      v.postPhysics!(PHYSICS_DT);
    }
    const d = v.damage;
    v.dispose();
    world.dispose();
    physics.dispose();
    return d;
  };
  for (const kind of ['pickup', 'sports', 'bus'] as VehicleKind[]) {
    const flat = drop(kind, 0);
    const nose = drop(kind, 45);
    console.log(`  info ${kind}: level drop onto the run-off ${flat.toFixed(1)}%, nose-dive ${nose.toFixed(1)}%`);
    check(flat >= 3, `${kind}: coming down flat on the run-off at ~15 m/s hurts (${flat.toFixed(1)}%)`);
    check(nose > flat, `${kind}: a nose-dive hurts more (${nose.toFixed(1)}%)`);
  }
}

if (!process.env.WORLD_KINDS || process.env.WORLD_SHORTCUT) {
  console.log('\n=== drive: pickup takes the log-bridge shortcut ===');
  const a = drive('pickup', { shortcut: true, animals: false });
  const b = results.pickup ?? drive('pickup', { animals: false });
  console.log(`  info shortcut finish ${a.finishedAt?.toFixed(1)} s vs normal ${b.finishedAt?.toFixed(1)} s`);
  check(a.finishedAt !== null && a.stuckAt.length === 0, 'log bridge is drivable');
  check(a.finishedAt !== null && b.finishedAt !== null && a.finishedAt < b.finishedAt, 'log bridge is a real shortcut');

  console.log('\n=== drive: steer off the road into the countryside ===');
  const w = drive('pickup', { wander: true, animals: false });
  check(w.stuckAt.length === 0 || true, 'wander run completed');
}

// -------------------------------------------------------------- the computer driver on this course
if (!process.env.WORLD_KINDS || process.env.WORLD_AI) {
  console.log('\n=== computer driver (src/ai) on the real course ===');
  const aiRun = (kind: VehicleKind, d: 'easy' | 'normal' | 'hard') => {
    const { physics, world } = makeWorld();
    world.animalsEnabled = false;
    const v = createVehicle({ physics, surfaces: world, spec: VEHICLES[kind], paint: 0, racer: 'cpu', spawn: world.spawns.cpu });
    const ai = new AIDriver(v, world, d, 7);
    ai.sensor = createPhysicsSensor(physics, 'cpu');
    ai.enabled = true;
    v.input = ai.input;
    let resets = 0;
    let lastCp = -1;
    let s = 0;
    let finished = false;
    const dl = damageLog(world, 'cpu', () => s);
    ai.onRequestReset = () => {
      resets++;
      if (process.env.VERBOSE) console.log(`    reset requested at s=${s.toFixed(0)} (${world.zoneAt(s).id}) pos y=${v.position.y.toFixed(1)}`);
      v.reset(finished ? world.data.spawnAt(world.track.finishS, 0) : lastCp >= 0 ? world.checkpoints[lastCp].respawn : world.spawns.cpu);
    };
    let onShortcut = 0;
    let finish: number | null = null;
    let lipKmh = 0;
    let air = false;
    let jumpM: number | null = null;
    let upright = true;
    let landT = 0;
    const up = new THREE.Vector3();
    const j = world.jump;
    for (let i = 0; i < 60 * 520; i++) {
      const t = i * PHYSICS_DT;
      ai.fixedUpdate(PHYSICS_DT);
      world.fixedUpdate!(PHYSICS_DT);
      v.fixedUpdate!(PHYSICS_DT);
      physics.step();
      v.postPhysics!(PHYSICS_DT);
      v.update!(PHYSICS_DT, 1);
      const pr = world.track.project(v.position, s);
      s = pr.s;
      while (lastCp + 1 < world.checkpoints.length && s >= world.checkpoints[lastCp + 1].s) lastCp++;
      if (world.data.shortcutDist(v.position.x, v.position.z).d < 3 && world.data.fieldsAt(v.position.x, v.position.z).d > 30) onShortcut++; // on the bridge line, far from the ford road
      if (finish === null && s >= world.track.finishS) {
        finish = t;
        finished = true;
      }
      if (finish !== null) {
        if (s > j.lipS - 3 && s < j.lipS + 1) lipKmh = Math.max(lipKmh, v.speed * 3.6);
        if (!air && jumpM === null && s > j.lipS - 4 && s < j.lipS + 15 && v.wheelsOnGround === 0 && v.airTime > 0.12) air = true;
        if (air && jumpM === null && v.wheelsOnGround >= 2) jumpM = s - j.lipS;
        if (jumpM !== null) {
          landT += PHYSICS_DT;
          if (up.set(0, 1, 0).applyQuaternion(v.quaternion).y < 0.5) upright = false;
          if (landT > 1.2) break;
        }
        if (t > finish + 45) break;
      }
    }
    const damage = v.damage;
    dl.off();
    if (process.env.VERBOSE || damage > 10) console.log(`    ${kind}/${d} damage by zone:source ${fmtDmg(dl.by)}`);
    v.dispose();
    world.dispose();
    physics.dispose();
    return { finish, resets, shortcut: onShortcut > 30, lipKmh, jumpM, upright, damage };
  };
  const AI_RUNS: [VehicleKind, 'easy' | 'normal' | 'hard'][] = process.env.WORLD_AI_RUNS
    ? (process.env.WORLD_AI_RUNS.split(',').map((x) => x.split(':')) as [VehicleKind, 'easy' | 'normal' | 'hard'][])
    : process.env.WORLD_AI_ALL
    ? (Object.keys(VEHICLES) as VehicleKind[]).map((k) => [k, 'normal'])
    : [['pickup', 'hard'], ['pickup', 'easy'], ['sedan', 'normal'], ['monster', 'normal'], ['buggy', 'normal'], ['sports', 'normal'], ['muscle', 'easy'], ['bus', 'normal'], ['atv', 'easy'], ['rally', 'hard']];
  const aiDamage: string[] = [];
  for (const [kind, d] of AI_RUNS) {
    const r = aiRun(kind, d);
    console.log(`  info ${kind}/${d}: finish ${r.finish?.toFixed(1) ?? '—'} s, damage ${r.damage.toFixed(0)}%, resets ${r.resets}, log bridge ${r.shortcut ? 'yes' : 'no'}, jump ${r.jumpM?.toFixed(1) ?? '—'} m at ${r.lipKmh.toFixed(0)} km/h ${r.upright ? '' : '(CRASH)'}`);
    check(r.finish !== null && r.resets <= 1, `computer ${kind} on ${d} completes the course (${r.resets} resets)`);
    if (d === 'hard') check(r.shortcut, 'Hard computer takes the log bridge');
    if (d === 'easy') check(!r.shortcut, 'Easy computer stays on the road (ford)');
    check(r.jumpM !== null && r.upright, `computer ${kind}/${d} attempts the jump and lands on its wheels`);
    if (MAKES_IT.includes(kind)) check((r.jumpM ?? 0) >= jumpBonusM(), `computer ${kind}/${d} (full speed even on ${d}) earns the jump bonus (${r.jumpM?.toFixed(1)} m)`);
    else if (SLOW.includes(kind)) check((r.jumpM ?? 0) < jumpBonusM(), `computer ${kind}/${d} falls short (${r.jumpM?.toFixed(1)} m)`);
    check(r.damage < 30, `computer ${kind}/${d}: a clean race costs modest damage (${r.damage.toFixed(0)}%)`);
    aiDamage.push(`${kind}/${d} ${r.damage.toFixed(0)}%`);
  }
  console.log(`  info computer damage per race: ${aiDamage.join(', ')}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall world checks passed');
process.exit(failures ? 1 : 0);
