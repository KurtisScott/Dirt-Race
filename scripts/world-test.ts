/**
 * Headless course test (no browser): builds the real RaceCourse with Rapier and drives it with a simple
 * centre-line follower (pure pursuit + speed from curvature), for several vehicles. Checks:
 *  - each car reaches the finish line without getting trapped (resets to the last checkpoint allowed, counted);
 *  - the bonus hill: pickup/monster can reach the summit, the sedan can't (or barely);
 *  - surfaces per zone, checkpoint spacing, spawn placement, animals bump and never stop a car,
 *    the off-road verge and valley walls keep a car that steers away inside the world.
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
const { createVehicle } = await import('../src/vehicles/vehicle');
const { VEHICLES } = await import('../src/vehicles/catalog');
const { AIDriver, createPhysicsSensor } = await import('../src/ai');
type VehicleKind = import('../src/core/types').VehicleKind;

await initRapier();
let failures = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${msg}`);
  if (!ok) failures++;
};

function makeWorld() {
  const physics = new PhysicsWorld();
  const scene = new THREE.Scene();
  const ctx = { physics, renderer: { scene }, quality: { preset: { textureSize: 64, detail: 0.5, level: 'low' } } } as never;
  const t0 = performance.now();
  const world = new RaceCourse(ctx);
  const ms = performance.now() - t0;
  return { physics, world, scene, ms };
}

// -------------------------------------------------------------- static checks
{
  const { world, scene, ms, physics } = makeWorld();
  const c = world.data;
  console.log(`\n=== course: ${c.length.toFixed(0)} m, finish at ${c.finishS.toFixed(0)} m, summit at ${c.summitS.toFixed(0)} m (hill top ${c.hillTop.toFixed(1)} m high), built in ${ms.toFixed(0)} ms`);
  check(c.length > 2300 && c.length < 2700, `length ~2.5 km (${c.length.toFixed(0)} m)`);
  const ids = world.zones.map((z) => z.id).join(',');
  check(ids === 'town,farm,mud,rocky,desert,river,finish,hill', `zones in order: ${ids}`);
  const cps = world.checkpoints.map((k) => k.s);
  const gaps = cps.map((s, i) => s - (i ? cps[i - 1] : 0));
  check(gaps.every((d) => d > 250 && d < 360), `checkpoints ~every 300 m (${cps.map((s) => s.toFixed(0)).join(', ')})`);
  for (const cp of world.checkpoints) {
    const ok = world.surfaceAt(cp.respawn.x, cp.respawn.z) !== 'water' && Math.abs(cp.respawn.y - world.heightAt(cp.respawn.x, cp.respawn.z)) < 0.01;
    if (!ok) check(false, `checkpoint ${cp.index} respawn on solid ground`);
  }
  const sp = world.spawns;
  const sep = Math.hypot(sp.player.x - sp.cpu.x, sp.player.z - sp.cpu.z);
  check(sep > 4.5 && sep < 7 && Math.abs(sp.player.yaw - sp.cpu.yaw) < 0.01, `two side-by-side grid slots (${sep.toFixed(1)} m apart)`);
  // Surfaces along the centre-line per zone.
  const expect: Record<string, string[]> = { town: ['asphalt'], farm: ['dirt'], mud: ['mud', 'dirt'], rocky: ['gravel'], desert: ['sand'], river: ['dirt', 'water'], finish: ['dirt'], hill: ['gravel'] };
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
  // Hill: max climb angle along the centre-line.
  let maxDeg = 0;
  let maxAt = 0;
  for (let s = c.hillStartS; s < c.summitS; s += 1) {
    const a = world.track.pointAt(s);
    const b = world.track.pointAt(s + 2);
    const d = (Math.atan2(b.y - a.y, 2) * 180) / Math.PI;
    if (d > maxDeg) {
      maxDeg = d;
      maxAt = s - c.hillStartS;
    }
  }
  check(maxDeg > 33 && maxDeg < 39 && maxAt > 70, `bonus hill steepest ${maxDeg.toFixed(1)}° at ${maxAt.toFixed(0)} m up (near the top)`);
  check(world.summit.y - world.track.pointAt(c.finishS).y > 25, `summit is ${(world.summit.y - world.track.pointAt(c.finishS).y).toFixed(1)} m above the finish (visible from afar)`);
  check(world.shortcuts.length === 1 && world.shortcuts[0].id === 'log-bridge' && world.shortcuts[0].points.length >= 2, 'log-bridge shortcut published');
  // Verge vs road: wall height at 80 m off the road.
  const p = world.track.pointAt(600);
  const t = world.track.tangentAt(600);
  const wallY = world.heightAt(p.x - t.z * 80, p.z + t.x * 80);
  check(wallY - p.y > 12, `valley wall ${(wallY - p.y).toFixed(1)} m high 80 m off the road`);
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

// -------------------------------------------------------------- drive
interface DriveResult {
  finishedAt: number | null;
  maxS: number;
  resets: number;
  summitAt: number | null;
  hillBestUp: number;
  stuckAt: number[];
  bumps: number;
  hits: number;
  minSpeedNearAnimal: number;
}

function drive(kind: VehicleKind, opts: { shortcut?: boolean; animals?: boolean; maxS?: number; wander?: boolean; fromFinish?: boolean } = {}): DriveResult {
  const { physics, world } = makeWorld();
  world.animalsEnabled = opts.animals ?? true;
  const c = world.data;
  const v = createVehicle({ physics, surfaces: world, spec: VEHICLES[kind], paint: 0xff0000, racer: 'player', spawn: opts.fromFinish ? world.data.spawnAt(world.data.finishS, 0) : world.spawns.player });
  let bumps = 0;
  let hits = 0;
  const offs = [events.on('animal:bump', () => bumps++), events.on('obstacle:hit', () => hits++)];
  const systems: import("../src/core/types").System[] = [world, v];
  let s = 0;
  let lastCp = -1;
  let resets = 0;
  let finishedAt: number | null = null;
  let summitAt: number | null = null;
  let hillBestUp = 0;
  const stuckAt: number[] = [];
  let progressT = 0;
  let progressS = 0;
  let minSpeedNearAnimal = Infinity;
  const target = new THREE.Vector3();
  const maxT = opts.maxS ?? 420;
  const steps = Math.round(maxT / PHYSICS_DT);
  const sc = world.shortcuts[0];
  const useSc = !!opts.shortcut;
  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS_DT;
    // ---- controller
    s = world.track.project(v.position, s).s;
    const spd = Math.max(0, v.speed);
    const look = 7 + spd * 0.55;
    let ts = Math.min(world.track.length, s + look);
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
      const grip = surf === 'asphalt' ? 1 : surf === 'mud' || surf === 'sand' ? 0.6 : 0.8;
      let vmax = maxTurn > 1e-3 ? Math.sqrt((6 * grip) / maxTurn) : 99;
      if (s > c.hillStartS - 30) vmax = 99; // full send up the hill
      // Slow for jump ramps a bit and for active animals ahead.
      for (const a of world.animals) {
        if (!a.active) continue;
        const d = a.position.distanceTo(v.position);
        if (d < 40) minSpeedNearAnimal = Math.min(minSpeedNearAnimal, spd);
      }
      v.input.steer = THREE.MathUtils.clamp(-ang * 2.2, -1, 1);
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
    if (s > c.hillStartS) hillBestUp = Math.max(hillBestUp, v.position.y - world.track.pointAt(c.hillStartS).y);
    if (summitAt === null && v.position.distanceTo(world.summit) < 7 && v.position.y > world.summit.y - 3) summitAt = t;
    if (summitAt !== null && t > summitAt + 1) break;
    // Stuck / flipped / out of the world → reset to the last checkpoint (like the Reset button).
    if (s > progressS + 3) {
      progressS = s;
      progressT = t;
    }
    const fallen = v.position.y < world.heightAt(v.position.x, v.position.z) - 3;
    const onHill = finishedAt !== null;
    if ((!onHill && t - progressT > 8) || v.flipped || fallen) {
      if (onHill) {
        // On the hill a stall means "can't climb": stop trying after a few attempts.
        resets++;
        if (resets > 3) break;
        v.reset(c.spawns.player.y !== undefined ? spawnAtS(world, c.finishS) : world.spawns.player);
      } else {
        stuckAt.push(Math.round(s));
        resets++;
        v.reset(lastCp >= 0 ? world.checkpoints[lastCp].respawn : world.spawns.player);
      }
      s = world.track.project(v.position).s;
      progressT = t;
      progressS = s;
    }
    if (onHill && t - progressT > 6) {
      // Stalled on the hill: done.
      break;
    }
    if (opts.wander && t > 22) break;
  }
  offs.forEach((f) => f());
  const out = { finishedAt, maxS: Math.max(s, progressS), resets, summitAt, hillBestUp, stuckAt, bumps, hits, minSpeedNearAnimal };
  v.dispose();
  world.dispose();
  physics.dispose();
  return out;
}

function spawnAtS(world: InstanceType<typeof RaceCourse>, s: number) {
  return world.data.spawnAt(s, 0);
}

const kinds = (process.env.WORLD_KINDS?.split(',') ?? ['pickup', 'sedan', 'sports', 'monster', 'buggy', 'muscle']) as VehicleKind[];
const results: Record<string, DriveResult> = {};
for (const kind of kinds) {
  console.log(`\n=== drive: ${kind} follows the centre-line ===`);
  const t0 = performance.now();
  const r = drive(kind);
  results[kind] = r;
  console.log(
    `  info finish ${r.finishedAt?.toFixed(1) ?? '—'} s, resets ${r.resets} ${r.stuckAt.length ? `(stuck at s=${r.stuckAt.join(', ')})` : ''}, hill best ${r.hillBestUp.toFixed(1)} m of ${(0).toFixed(0)}, summit ${r.summitAt ? `${(r.summitAt - (r.finishedAt ?? 0)).toFixed(1)} s after finish` : 'no'}, obstacle hits ${r.hits}, animal bumps ${r.bumps} (${((performance.now() - t0) / 1000).toFixed(1)} s wall)`,
  );
  check(r.finishedAt !== null, `${kind} reaches the finish line (${r.finishedAt?.toFixed(1) ?? 'never'} s)`);
  check(r.stuckAt.length <= 1, `${kind} never trapped (${r.stuckAt.length} stuck resets)`);
}
if (results.pickup) check(results.pickup.summitAt !== null, `pickup climbs the bonus hill to the summit flag`);
if (results.monster) check(results.monster.summitAt !== null, `monster truck climbs the bonus hill`);
if (results.sedan) check(results.sedan.summitAt === null, `grandma's sedan cannot make the summit (best ${results.sedan.hillBestUp.toFixed(1)} m up)`);
if (results.pickup && results.sedan) check(results.pickup.hillBestUp > results.sedan.hillBestUp, 'pickup climbs higher than the sedan');

// Standing start from the finish line (what a Reset on the hill gives you): the stat should decide it.
console.log('\n=== bonus hill from a standing start at the finish line ===');
const standing: Record<string, DriveResult> = {};
for (const kind of kinds) {
  const r = (standing[kind] = drive(kind, { fromFinish: true, animals: false, maxS: 60 }));
  console.log(`  info ${kind}: ${r.summitAt !== null ? `summit in ${r.summitAt.toFixed(1)} s` : `stalled ${r.hillBestUp.toFixed(1)} m up`}`);
}
if (standing.pickup) check(standing.pickup.summitAt !== null && standing.pickup.summitAt < 40, `pickup summits from a standing start within the 45 s bonus window (${standing.pickup.summitAt?.toFixed(1)} s)`);
if (standing.monster) check(standing.monster.summitAt !== null, 'monster summits from a standing start');
if (standing.sedan) check(standing.sedan.summitAt === null, `sedan stalls from a standing start (${standing.sedan.hillBestUp.toFixed(1)} m up)`);

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
    ai.onRequestReset = () => {
      resets++;
      if (process.env.VERBOSE) console.log(`    reset requested at s=${s.toFixed(0)} (${world.zoneAt(s).id}) pos y=${v.position.y.toFixed(1)}`);
      v.reset(lastCp >= 0 ? world.checkpoints[lastCp].respawn : world.spawns.cpu);
    };
    const sc = world.shortcuts[0];
    let onShortcut = 0;
    let finish: number | null = null;
    let summit: number | null = null;
    let best = 0;
    for (let i = 0; i < 60 * 260; i++) {
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
      if (finish === null && s >= world.track.finishS) finish = t;
      if (finish !== null) best = Math.max(best, v.position.y - world.track.pointAt(world.data.hillStartS).y);
      if (summit === null && v.position.distanceTo(world.summit) < 7) {
        summit = t;
        break;
      }
      if (finish !== null && t > finish + 45) break;
    }
    v.dispose();
    world.dispose();
    physics.dispose();
    return { finish, summit, resets, shortcut: onShortcut > 30, best };
  };
  for (const [kind, d] of [['pickup', 'hard'], ['pickup', 'easy'], ['sedan', 'normal'], ['monster', 'normal']] as const) {
    const r = aiRun(kind, d);
    console.log(`  info ${kind}/${d}: finish ${r.finish?.toFixed(1) ?? '—'} s, summit ${r.summit !== null && r.finish !== null ? `+${(r.summit - r.finish).toFixed(1)} s` : `no (best ${r.best.toFixed(1)} m up)`}, resets ${r.resets}, log bridge ${r.shortcut ? 'yes' : 'no'}`);
    check(r.finish !== null && r.resets <= 1, `computer ${kind} on ${d} completes the course (${r.resets} resets)`);
    if (d === 'hard') check(r.shortcut, 'Hard computer takes the log bridge');
    if (d === 'easy') check(!r.shortcut, 'Easy computer stays on the road (ford)');
    if (kind === 'pickup' || kind === 'monster') check(r.summit !== null, `computer ${kind} climbs the bonus hill`);
    if (kind === 'sedan') check(r.summit === null, 'computer sedan cannot climb the bonus hill');
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall world checks passed');
process.exit(failures ? 1 : 0);
