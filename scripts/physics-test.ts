/**
 * Headless driving test: no browser needed. Run: npm run physics-test
 * Simulates the pickup on flat ground + a ramp and prints metrics for tuning/regressions.
 * Exits non-zero if a basic expectation fails (flip on a turn, can't reverse, tunnels through ground...).
 */
import * as THREE from 'three';
import { initRapier, PhysicsWorld, RAPIER, PHYSICS_DT, Group, groups } from '../src/core/physics';
import { createVehicle } from '../src/vehicles/vehicle';
import { VEHICLES } from '../src/vehicles/catalog';
import type { SurfaceType, VehicleKind } from '../src/core/types';
import { SURFACES } from '../src/world/surfaces';

await initRapier();

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${msg}`);
  if (!ok) failures++;
};

function setup(kind: VehicleKind, surface: SurfaceType = 'asphalt', spawnY = 0) {
  const physics = new PhysicsWorld();
  const g = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const col = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 2, 2000).setTranslation(0, -2, 0).setCollisionGroups(groups(Group.GROUND, 0xffff)), g);
  physics.tag(col, { kind: 'ground', surface });
  const v = createVehicle({ physics, surfaces: { surfaceAt: () => surface }, spec: VEHICLES[kind], paint: 0, racer: 'player', spawn: { x: 0, y: spawnY, z: 0, yaw: 0 } });
  const step = (n: number, each?: (i: number) => void) => {
    for (let i = 0; i < n; i++) {
      each?.(i);
      v.fixedUpdate!(PHYSICS_DT);
      physics.step();
      v.postPhysics!(PHYSICS_DT);
      v.update!(PHYSICS_DT, 1);
    }
  };
  return { physics, v, step };
}

const up = new THREE.Vector3();
const upY = (q: THREE.Quaternion) => up.set(0, 1, 0).applyQuaternion(q).y;

const ONLY = process.argv[2];
const ALL: VehicleKind[] = ['pickup', 'sports', 'muscle', 'monster', 'buggy', 'sedan'];
for (const kind of (ONLY === 'personality' ? [] : ONLY ? [ONLY as VehicleKind] : ALL)) {
  console.log(`\n=== ${kind} ===`);
  const { physics, v, step } = setup(kind);
  const p = (v as unknown as { params: { mass: number; topSpeed: number } }).params;

  // 1. Settle
  step(120);
  const restY = v.position.y;
  check(v.wheelsOnGround === 4 && restY > 0.3, `settles on 4 wheels (chassis y=${restY.toFixed(2)}, mass ${p.mass} kg)`);

  // 2. Accelerate
  let t100 = -1;
  v.input = { steer: 0, throttle: 1, brake: 0 };
  step(60 * 15, (i) => {
    if (t100 < 0 && v.speed * 3.6 >= 60) t100 = i * PHYSICS_DT;
  });
  const top = v.speed;
  check(top > p.topSpeed * 0.85, `top speed ${(top * 3.6).toFixed(0)} km/h (target ${(p.topSpeed * 3.6).toFixed(0)}), 0-60 km/h in ${t100.toFixed(1)} s`);

  // 3. Full-lock turn at top speed for 4 s: must not flip
  let minUp = 1;
  let yawRate = 0;
  v.input = { steer: 1, throttle: 1, brake: 0 };
  step(240, (i) => {
    minUp = Math.min(minUp, upY(v.quaternion));
    if (i > 120) yawRate = Math.max(yawRate, Math.abs((v as unknown as { rigidBody: RAPIER.RigidBody }).rigidBody.angvel().y));
  });
  const speedTurn = v.speed;
  const latG = (yawRate * Math.abs(speedTurn)) / 9.81;
  check(minUp > 0.8, `full-lock turn at speed: min up.y ${minUp.toFixed(3)} (roll ${(Math.acos(Math.min(1, minUp)) * 57.3).toFixed(1)}°), speed ${(speedTurn * 3.6).toFixed(0)} km/h, yaw ${(yawRate * 57.3).toFixed(0)}°/s, lat ${latG.toFixed(2)} g, radius ${(Math.abs(speedTurn) / Math.max(yawRate, 1e-3)).toFixed(0)} m`);

  // 3b. Tight turn at low speed (parking-lot): turning circle
  v.input = { steer: 0, throttle: 0, brake: 1 };
  step(240);
  v.input = { steer: 0, throttle: 0, brake: 0 };
  step(30);
  let lowYaw = 0;
  step(180, (i) => {
    v.input = { steer: -1, throttle: Math.abs(v.speed) < 6 ? 0.6 : 0, brake: 0 };
    if (i > 90) lowYaw = Math.max(lowYaw, Math.abs((v as unknown as { rigidBody: RAPIER.RigidBody }).rigidBody.angvel().y));
  });
  check(lowYaw > 0.4, `low-speed turn: speed ${(v.speed * 3.6).toFixed(0)} km/h, yaw ${(lowYaw * 57.3).toFixed(0)}°/s, radius ${(Math.abs(v.speed) / Math.max(lowYaw, 1e-3)).toFixed(1)} m`);
  v.input = { steer: 0, throttle: 1, brake: 0 };
  step(60 * 10);

  // 4. Slalom (quick left-right) at speed
  minUp = 1;
  step(360, (i) => {
    v.input = { steer: Math.floor(i / 45) % 2 ? 1 : -1, throttle: 1, brake: 0 };
    minUp = Math.min(minUp, upY(v.quaternion));
  });
  check(minUp > 0.75, `slalom: min up.y ${minUp.toFixed(3)}`);

  // 5. Brake to stop
  v.input = { steer: 0, throttle: 0, brake: 1 };
  const v0 = v.speed;
  let stopT = -1;
  step(60 * 8, (i) => {
    if (stopT < 0 && Math.abs(v.speed) < 0.6) stopT = i * PHYSICS_DT;
  });
  check(stopT > 0, `brakes from ${(v0 * 3.6).toFixed(0)} km/h to stop in ${stopT.toFixed(1)} s`);
  // keep holding: should now be reversing
  check(v.speed < -2, `holding brake at standstill reverses (speed ${(v.speed * 3.6).toFixed(1)} km/h)`);

  // 6. Release: coasts to stop and holds still
  v.input = { steer: 0, throttle: 0, brake: 0 };
  step(60 * 4);
  check(Math.abs(v.speed) < 0.3, `coasts to rest (speed ${v.speed.toFixed(2)})`);
  const yAfter = v.position.y;
  check(yAfter > 0.2, `no tunneling (chassis y=${yAfter.toFixed(2)})`);

  // 7. Ramp jump: build a ramp ahead and drive into it at speed
  const pos = v.position.clone();
  const fwd = v.forward.clone().setY(0).normalize();
  const rampAt = pos.clone().addScaledVector(fwd, 80);
  const yaw = Math.atan2(fwd.x, fwd.z);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const w = 3.5, len = 10, h = 1.8;
  const pts = new Float32Array([-w, 0, 0, w, 0, 0, -w, 0, len, w, 0, len, -w, h, len, w, h, len]);
  physics.world.createCollider(RAPIER.ColliderDesc.convexHull(pts)!.setTranslation(rampAt.x, -0.01, rampAt.z).setRotation(q).setCollisionGroups(groups(Group.GROUND, 0xffff)), physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  let maxAir = 0;
  let maxH = 0;
  minUp = 1;
  let landed = false;
  v.input = { steer: 0, throttle: 1, brake: 0 };
  step(60 * 10, () => {
    maxAir = Math.max(maxAir, v.airTime);
    maxH = Math.max(maxH, v.position.y);
    minUp = Math.min(minUp, upY(v.quaternion));
    if (maxAir > 0.3 && v.wheelsOnGround >= 2) landed = true;
  });
  check(maxAir > 0.3 && landed && minUp > 0.5 && upY(v.quaternion) > 0.9, `ramp jump: air ${maxAir.toFixed(2)} s, peak y ${maxH.toFixed(1)} m, min up.y ${minUp.toFixed(2)}, upright after: ${upY(v.quaternion).toFixed(2)}`);

  physics.dispose();
}

// ============================================================================ personalities (SPEC "Vehicles")
// Uses the real SURFACES table from world/surfaces.ts. Run alone with: npx tsx scripts/physics-test.ts personality
if (!ONLY || ONLY === 'personality') {
  console.log('\n=== personalities ===');
  const kmh = (ms: number) => (ms * 3.6).toFixed(0);
  console.log(`  surfaces: ${(Object.keys(SURFACES) as SurfaceType[]).map((k) => `${k} g${SURFACES[k].grip}/d${SURFACES[k].drag}/r${SURFACES[k].rolling}`).join('  ')}`);

  /** Speed after 12 s of full throttle from rest on a flat surface. */
  const surfSpeed = (kind: VehicleKind, surface: SurfaceType): number => {
    const { physics, v, step } = setup(kind, surface);
    step(60);
    v.input = { steer: 0, throttle: 1, brake: 0 };
    step(60 * 12);
    const sp = v.speed;
    physics.dispose();
    return sp;
  };
  const surfs: SurfaceType[] = ['asphalt', 'dirt', 'gravel', 'mud', 'sand', 'water'];
  const sp: Record<string, Record<string, number>> = {};
  for (const k of ALL) {
    sp[k] = {};
    for (const s of surfs) sp[k][s] = surfSpeed(k, s);
    console.log(`  ${k.padEnd(8)} ${surfs.map((s) => `${s} ${kmh(sp[k][s]).padStart(3)}`).join('  ')} km/h`);
  }
  const fastestOn = (s: SurfaceType) => ALL.reduce((a, b) => (sp[b][s] > sp[a][s] ? b : a));
  check(fastestOn('asphalt') === 'sports', `sports car is fastest on asphalt (${kmh(sp.sports.asphalt)} km/h)`);
  check(sp.sports.mud < sp.sports.asphalt * 0.4, `sports car bogs in mud: ${kmh(sp.sports.mud)} km/h (< 40% of asphalt)`);
  check(sp.sports.mud < sp.monster.mud * 0.75 && sp.sports.mud < sp.pickup.mud, `sports in mud slower than monster (${kmh(sp.monster.mud)}) and pickup (${kmh(sp.pickup.mud)})`);
  check(fastestOn('sand') === 'buggy', `buggy is fastest on sand (${kmh(sp.buggy.sand)} km/h vs sports ${kmh(sp.sports.sand)})`);
  check(sp.buggy.sand > sp.buggy.asphalt * 0.85, `buggy keeps its speed on sand (${kmh(sp.buggy.sand)} of ${kmh(sp.buggy.asphalt)})`);
  check(sp.monster.mud > sp.monster.asphalt * 0.8, `monster truck shrugs off mud (${kmh(sp.monster.mud)} of ${kmh(sp.monster.asphalt)})`);
  check(ALL.every((k) => k === 'sedan' || sp[k].asphalt > sp.sedan.asphalt) || sp.sedan.asphalt <= sp.monster.asphalt + 0.5, `sedan is among the slowest on asphalt (${kmh(sp.sedan.asphalt)} km/h)`);

  /**
   * Bonus hill: 10 m flat gravel run-up from rest, then 20° and 28° for 30 m each and 36° for 40 m, flat summit (≈ 48 m high).
   * `steep` = seconds spent on the 36° section (traction-limited, so it reflects the hill-climb stat).
   * Returns climb time to the summit (or -1) and best height reached.
   */
  const hill = (kind: VehicleKind): { t: number; h: number; top: number; steep: number } => {
    const { physics, v, step } = setup(kind, 'gravel');
    const segs = [
      [20, 30],
      [28, 30],
      [36, 40],
    ];
    let z = 10;
    let y = 0;
    let steepZ = 0;
    const w = 6;
    for (const [deg, len] of segs) {
      steepZ = z;
      const dz = len * Math.cos((deg * Math.PI) / 180);
      const dy = len * Math.sin((deg * Math.PI) / 180);
      const pts = new Float32Array([-w, -1, z, w, -1, z, -w, y, z, w, y, z, -w, -1, z + dz, w, -1, z + dz, -w, y + dy, z + dz, w, y + dy, z + dz]);
      const c = physics.world.createCollider(RAPIER.ColliderDesc.convexHull(pts)!.setCollisionGroups(groups(Group.GROUND, 0xffff)), physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
      physics.tag(c, { kind: 'ground', surface: 'gravel' });
      z += dz;
      y += dy;
    }
    const top = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(w, (y + 1) / 2, 20).setTranslation(0, (y - 1) / 2, z + 20).setCollisionGroups(groups(Group.GROUND, 0xffff)), physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
    physics.tag(top, { kind: 'ground', surface: 'gravel' });
    step(60);
    v.input = { steer: 0, throttle: 1, brake: 0 };
    let t = -1;
    let h = 0;
    let t0 = -1;
    step(60 * 30, (i) => {
      h = Math.max(h, v.position.y);
      if (t0 < 0 && v.position.z > steepZ) t0 = i * PHYSICS_DT;
      if (t < 0 && v.position.z > z + 2 && v.position.y > y) t = i * PHYSICS_DT;
    });
    physics.dispose();
    return { t, h, top: y, steep: t > 0 ? t - t0 : -1 };
  };
  const climb: Record<string, ReturnType<typeof hill>> = {};
  for (const k of ALL) {
    climb[k] = hill(k);
    console.log(`  hill ${k.padEnd(8)} ${climb[k].t > 0 ? `summit in ${climb[k].t.toFixed(1)} s (36° section ${climb[k].steep.toFixed(1)} s)` : `stuck at ${climb[k].h.toFixed(1)} of ${climb[k].top.toFixed(1)} m`}`);
  }
  /** Hill start: placed at rest on a 36° gravel slope (facing uphill), full throttle 4 s → metres climbed along the slope. */
  const hillStart = (kind: VehicleKind): number => {
    const physics = new PhysicsWorld();
    const ang = (36 * Math.PI) / 180;
    const q = { x: -Math.sin(ang / 2), y: 0, z: 0, w: Math.cos(ang / 2) }; // rotate about X: +Z rises
    const slope = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(10, 1, 200).setRotation(q).setTranslation(0, -Math.cos(ang), Math.sin(ang)).setCollisionGroups(groups(Group.GROUND, 0xffff)), physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
    physics.tag(slope, { kind: 'ground', surface: 'gravel' });
    const v = createVehicle({ physics, surfaces: { surfaceAt: () => 'gravel' }, spec: VEHICLES[kind], paint: 0, racer: 'player', spawn: { x: 0, y: 0.6, z: 0, yaw: 0 } });
    const body = (v as unknown as { rigidBody: RAPIER.RigidBody }).rigidBody;
    body.setRotation(q, true);
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        v.fixedUpdate!(PHYSICS_DT);
        physics.step();
        v.postPhysics!(PHYSICS_DT);
        v.update!(PHYSICS_DT, 1);
      }
    };
    run(40); // settle (hold-still brake keeps it parked)
    const start = v.position.clone();
    v.input = { steer: 0, throttle: 1, brake: 0 };
    run(240);
    const d = (v.position.z - start.z) / Math.cos(ang);
    physics.dispose();
    return d;
  };
  const hs = Object.fromEntries(ALL.map((k) => [k, hillStart(k)])) as Record<VehicleKind, number>;
  console.log(`  36° gravel hill start, 4 s: ${ALL.map((k) => `${k} ${hs[k].toFixed(1)} m`).join('  ')}`);
  check(ALL.every((k) => k === 'monster' || hs.monster > hs[k]), `monster truck climbs best from a hill start (${hs.monster.toFixed(1)} m)`);
  check(hs.sedan < 1, `sedan can't pull away on the 36° slope (${hs.sedan.toFixed(1)} m)`);
  check(hs.pickup > hs.buggy && hs.pickup > hs.muscle && hs.muscle > hs.sports, 'hill start order follows the hill-climb stat (pickup > buggy/muscle > sports)');
  check(climb.pickup.t > 0 && climb.buggy.t > 0 && climb.muscle.t > 0, 'pickup, buggy and muscle car make the summit');
  check(climb.pickup.steep <= climb.buggy.steep && climb.pickup.steep <= climb.muscle.steep, 'pickup (climb 4) beats buggy/muscle (climb 3) on the steep part');
  check(climb.sedan.t < 0, `grandma's sedan can't make the summit from a standing start (best ${climb.sedan.h.toFixed(1)} m)`);
  check(climb.sports.t < 0 || climb.sports.steep > climb.muscle.steep, `sports car struggles on the hill (${climb.sports.t > 0 ? climb.sports.steep.toFixed(1) + ' s on the steep part' : 'no summit'})`);

  /** Bounce: drop from 0.8 m, count suspension rebounds (vertical velocity sign changes > 0.3 m/s) in 3 s. */
  const bounce = (kind: VehicleKind): number => {
    const { physics, v, step } = setup(kind, 'sand', 0.8);
    const body = (v as unknown as { rigidBody: RAPIER.RigidBody }).rigidBody;
    let n = 0;
    let lastSign = 0;
    step(180, () => {
      const vy = body.linvel().y;
      if (Math.abs(vy) > 0.3) {
        const sgn = Math.sign(vy);
        if (lastSign && sgn !== lastSign) n++;
        lastSign = sgn;
      }
    });
    physics.dispose();
    return n;
  };
  const bn: Record<string, number> = {};
  for (const k of ALL) bn[k] = bounce(k);
  console.log(`  bounces: ${ALL.map((k) => `${k} ${bn[k]}`).join('  ')}`);
  check(bn.buggy > bn.sedan && bn.buggy >= Math.max(...ALL.filter((k) => k !== 'buggy').map((k) => bn[k])), 'buggy is the bounciest, sedan settles calmly');

  /** Crawl: from rest, drive at half throttle over a fixed log (half sunk) 8 m ahead. */
  const LOG_R = 0.3;
  const crawl = (kind: VehicleKind): boolean => {
    const { physics, v, step } = setup(kind, 'dirt');
    const log = physics.world.createCollider(RAPIER.ColliderDesc.capsule(4, LOG_R).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }).setTranslation(0, LOG_R - 0.1, 8).setCollisionGroups(groups(Group.STATIC, 0xffff)), physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
    physics.tag(log, { kind: "static", name: "log" });
    step(60);
    v.input = { steer: 0, throttle: 0.5, brake: 0 };
    let ok = false;
    step(60 * 8, () => {
      // Rear axle past the log, upright.
      if (v.position.z > 10 + VEHICLES[kind].size.length / 2 && up.set(0, 1, 0).applyQuaternion(v.quaternion).y > 0.8) ok = true;
    });
    physics.dispose();
    return ok;
  };
  const cr = Object.fromEntries(ALL.map((k) => [k, crawl(k)]));
  console.log(`  crawl over a log (top 0.5 m) at half throttle: ${ALL.map((k) => `${k} ${cr[k] ? 'yes' : 'no'}`).join('  ')}`);
  check(cr.monster && cr.pickup, 'monster truck and pickup crawl over a log');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
