/**
 * Headless driving test: no browser needed. Run: npm run physics-test
 * Simulates the pickup on flat ground + a ramp and prints metrics for tuning/regressions.
 * Exits non-zero if a basic expectation fails (flip on a turn, can't reverse, tunnels through ground...).
 */
import * as THREE from 'three';
import { initRapier, PhysicsWorld, RAPIER, PHYSICS_DT, Group, groups } from '../src/core/physics';
import { createVehicle } from '../src/vehicles/vehicle';
import { VEHICLES, VEHICLE_KINDS } from '../src/vehicles/catalog';
import { DAMAGE, impactDamage, landingDamage, performanceFactor } from '../src/vehicles/damage';
import { events } from '../src/core/events';
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
  // Dispose the vehicle with the world (it subscribes to bus events, which must not outlive it).
  const free = physics.dispose.bind(physics);
  physics.dispose = () => {
    v.dispose();
    free();
  };
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
const kmh = (ms: number) => (ms * 3.6).toFixed(0);
const upY = (q: THREE.Quaternion) => up.set(0, 1, 0).applyQuaternion(q).y;

const ONLY = process.argv[2];
/** The original six (the old bonus-hill personality checks are about these). */
const ALL: VehicleKind[] = ['pickup', 'sports', 'muscle', 'monster', 'buggy', 'sedan'];
/** All sixteen (Round 2). */
const EVERY: VehicleKind[] = [...VEHICLE_KINDS];
const SECTIONS = new Set(['personality', 'damage', 'jump']);
for (const kind of (SECTIONS.has(ONLY) ? [] : ONLY ? [ONLY as VehicleKind] : EVERY)) {
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
  // (surface speeds below cover all sixteen; the hill checks stay on the original six)
  console.log('\n=== personalities ===');
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
  const surfs: SurfaceType[] = ['asphalt', 'dirt', 'gravel', 'mud', 'sand', 'water', 'snow'];
  const sp: Record<string, Record<string, number>> = {};
  for (const k of EVERY) {
    sp[k] = {};
    for (const s of surfs) sp[k][s] = surfSpeed(k, s);
    console.log(`  ${k.padEnd(8)} ${surfs.map((s) => `${s} ${kmh(sp[k][s]).padStart(3)}`).join('  ')} km/h`);
  }
  const fastestOn = (s: SurfaceType, among: VehicleKind[] = ALL) => among.reduce((a, b) => (sp[b][s] > sp[a][s] ? b : a));
  check(fastestOn('asphalt', EVERY) === 'sports', `sports car is fastest on asphalt of all sixteen (${kmh(sp.sports.asphalt)} km/h)`);
  check(fastestOn('sand', EVERY) === 'trophy' || fastestOn('sand', EVERY) === 'buggy', `a desert machine is fastest on sand (${fastestOn('sand', EVERY)})`);
  check(Object.values(SURFACES).every((x) => x.grip >= SURFACES.snow.grip) && SURFACES.snow.grip < SURFACES.gravel.grip, `snow is the slipperiest surface (grip ${SURFACES.snow.grip} vs gravel ${SURFACES.gravel.grip})`);
  check(EVERY.every((k) => sp[k].snow > 40 / 3.6 && sp[k].snow < sp[k].asphalt), `every vehicle keeps going on snow, slower than on asphalt (slowest ${kmh(Math.min(...EVERY.map((k) => sp[k].snow)))} km/h)`);
  check(EVERY.every((k) => sp[k].asphalt > 20 && sp[k].mud > 6), `every vehicle keeps moving on every surface (slowest mud: ${kmh(Math.min(...EVERY.map((k) => sp[k].mud)))} km/h)`);
  check(sp.tractor.mud > sp.tractor.asphalt * 0.8 && sp.tractor.asphalt < sp.sedan.asphalt, `tractor: slowest on the road (${kmh(sp.tractor.asphalt)}) but unbothered by mud (${kmh(sp.tractor.mud)})`);
  check(sp.hatch.mud < sp.jeep.mud && sp.rally.gravel > sp.hatch.gravel, `hot hatch bogs in mud vs the 4x4 (${kmh(sp.hatch.mud)} vs ${kmh(sp.jeep.mud)}); rally car beats it on gravel`);
  check(sp.sports.mud < sp.sports.asphalt * 0.4, `sports car bogs in mud: ${kmh(sp.sports.mud)} km/h (< 40% of asphalt)`);
  check(sp.sports.mud < sp.monster.mud * 0.75 && sp.sports.mud < sp.pickup.mud, `sports in mud slower than monster (${kmh(sp.monster.mud)}) and pickup (${kmh(sp.pickup.mud)})`);
  check(fastestOn('sand') === 'buggy', `buggy is fastest on sand (${kmh(sp.buggy.sand)} km/h vs sports ${kmh(sp.sports.sand)})`);
  check(sp.buggy.sand > sp.buggy.asphalt * 0.85, `buggy keeps its speed on sand (${kmh(sp.buggy.sand)} of ${kmh(sp.buggy.asphalt)})`);
  check(sp.monster.mud > sp.monster.asphalt * 0.8, `monster truck shrugs off mud (${kmh(sp.monster.mud)} of ${kmh(sp.monster.asphalt)})`);
  check(ALL.every((k) => k === 'sedan' || sp[k].asphalt > sp.sedan.asphalt) || sp.sedan.asphalt <= sp.monster.asphalt + 0.5, `sedan is among the slowest on asphalt (${kmh(sp.sedan.asphalt)} km/h)`);

  /**
   * Bonus hill: 10 m flat gravel run-up from rest, then 20° and 28° for 30 m each, 36° for 40 m and a short 18° round-over, flat summit (≈ 48 m high).
   * `steep` = seconds spent on the 36° section (traction- and climb-power-limited, so it reflects the hill-climb stat). 60 s limit: the climb-3 cars crawl.
   * Returns climb time to the summit (or -1) and best height reached.
   */
  const hill = (kind: VehicleKind): { t: number; h: number; top: number; steep: number } => {
    const { physics, v, step } = setup(kind, 'gravel');
    const segs = [
      [20, 30],
      [28, 30],
      [36, 40],
      [18, 4], // short round-over like the real hill (a sharp 36°→flat lip high-centres low cars at crawl speed)
    ];
    let z = 10;
    let y = 0;
    let steepZ = 0;
    const w = 6;
    for (const [deg, len] of segs) {
      if (deg === 36) steepZ = z;
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
    step(60 * 60, (i) => {
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
    v.dispose();
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
  for (const k of EVERY) bn[k] = bounce(k);
  console.log(`  bounces: ${EVERY.map((k) => `${k} ${bn[k]}`).join('  ')}`);
  check(bn.buggy > bn.sedan && bn.buggy >= Math.max(...EVERY.filter((k) => k !== 'buggy').map((k) => bn[k])), 'buggy is the bounciest, sedan settles calmly');

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
  const cr = Object.fromEntries(EVERY.map((k) => [k, crawl(k)]));
  console.log(`  crawl over a log (top 0.5 m) at half throttle: ${EVERY.map((k) => `${k} ${cr[k] ? 'yes' : 'no'}`).join('  ')}`);
  check(cr.monster && cr.pickup && cr.lifted && cr.tractor && cr.jeep, 'monster truck, pickup, lifted pickup, tractor and 4x4 crawl over a log');
}

// ============================================================================ end jump (Round 2)
// A generic long jump: 220 m asphalt run-up from rest, a 15° × 10 m ramp (2.6 m lip), flat landing.
// Prints launch speed / distance / clean landing per vehicle as data for tuning the course's end ramp.
if (!ONLY || ONLY === 'jump') {
  console.log('\n=== end jump (220 m run-up, 15° ramp, 2.6 m lip) ===');
  const jump = (kind: VehicleKind) => {
    const { physics, v, step } = setup(kind, 'asphalt');
    const ang = (15 * Math.PI) / 180;
    const len = 10;
    const z0 = 220;
    const h = len * Math.sin(ang);
    const dz = len * Math.cos(ang);
    const w = 4;
    const pts = new Float32Array([-w, 0, z0, w, 0, z0, -w, 0, z0 + dz, w, 0, z0 + dz, -w, h, z0 + dz, w, h, z0 + dz]);
    const col = physics.world.createCollider(RAPIER.ColliderDesc.convexHull(pts)!.setCollisionGroups(groups(Group.GROUND, 0xffff)), physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
    physics.tag(col, { kind: 'ground', surface: 'asphalt' });
    step(60);
    v.input = { steer: 0, throttle: 1, brake: 0 };
    let launch = 0;
    let land = -1;
    let upright = false;
    let maxAir = 0;
    let airborne = false;
    const lip = z0 + dz;
    step(60 * 40, () => {
      // keep it straight
      const lat = v.position.x;
      v.input = { steer: Math.max(-1, Math.min(1, lat * 0.5)), throttle: land < 0 ? 1 : 0, brake: land < 0 ? 0 : 1 };
      if (!launch && v.position.z > lip - 0.5) launch = v.speed;
      maxAir = Math.max(maxAir, v.airTime);
      // (airTime resets in postPhysics on touchdown, so remember that we were flying)
      if (launch && land < 0 && airborne && v.wheelsOnGround >= 2) land = v.position.z - lip;
      airborne = v.airTime > 0.3;
      if (land >= 0 && Math.abs(v.speed) < 3 && !upright) upright = up.set(0, 1, 0).applyQuaternion(v.quaternion).y > 0.8;
    });
    const res = { launch, land, upright, air: maxAir, damage: v.damage };
    physics.dispose();
    return res;
  };
  const J: Record<string, ReturnType<typeof jump>> = {};
  for (const k of EVERY) {
    J[k] = jump(k);
    const st = VEHICLES[k].stats;
    console.log(`  ${k.padEnd(8)} jump ${st.jump} top ${st.topSpeed}: launch ${kmh(J[k].launch).padStart(3)} km/h, landed ${J[k].land.toFixed(1).padStart(5)} m past the lip, air ${J[k].air.toFixed(2)} s, ${J[k].upright ? 'upright' : 'CRASHED'}, damage ${J[k].damage.toFixed(0)}%`);
  }
  check(EVERY.every((k) => J[k].land > 0), 'every vehicle flies off the ramp and lands');
  const order = [...EVERY].sort((a, b) => J[a].land - J[b].land);
  check(order.slice(0, 3).includes('sedan'), `grandma's sedan is among the three shortest jumps (${order.slice(0, 3).join(', ')})`);
  // Higher jump stat → farther on average (the stat summarises speed + flight).
  const avg = (n: number) => {
    const ks = EVERY.filter((k) => VEHICLES[k].stats.jump === n);
    return ks.length ? ks.reduce((a, k) => a + J[k].land, 0) / ks.length : NaN;
  };
  const avgs = [1, 2, 3, 4, 5].map(avg);
  check(avgs.every((x, i) => i === 0 || x > avgs[i - 1]), `jump stat tracks distance: average by stat 1..5 = ${avgs.map((x) => x.toFixed(0)).join(' < ')} m`);
  check(EVERY.filter((k) => J[k].upright).length >= 13, `most vehicles land upright (${EVERY.filter((k) => J[k].upright).length}/16)`);
}

// ============================================================================ damage (Round 2)
if (!ONLY || ONLY === 'damage') {
  console.log('\n=== damage ===');
  // Rules (pure functions)
  check(impactDamage(DAMAGE.impactMin - 0.1) === 0 && impactDamage(3) === 0, `light bumps do nothing (below ${DAMAGE.impactMin} m/s)`);
  check(impactDamage(14) > 10 && impactDamage(14) < 25, `a 50 km/h head-on hit does ${impactDamage(14).toFixed(1)}%`);
  check(impactDamage(80) === DAMAGE.hitCap, `one hit is capped at ${DAMAGE.hitCap}%`);
  check(landingDamage(8, 9) === 0 && landingDamage(14, 9) > 5, `landings: soft = 0, hard = ${landingDamage(14, 9).toFixed(1)}%`);
  check(performanceFactor(0) === 1 && Math.abs(performanceFactor(100) - 0.75) < 1e-9 && performanceFactor(250) === 0.75, 'performance factor 1 → 0.75 at 100% (never lower)');

  /** Drive straight into an obstacle `dist` m ahead, released at `speed` m/s (no throttle). */
  const ram = (kind: VehicleKind, speed: number, obstacle: 'boulder' | 'hay' | 'wall') => {
    const { physics, v, step } = setup(kind);
    step(60);
    const body = (v as unknown as { rigidBody: RAPIER.RigidBody }).rigidBody;
    const z = 12;
    if (obstacle === 'hay') {
      const b = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, z));
      const c = physics.world.createCollider(RAPIER.ColliderDesc.cylinder(0.6, 0.7).setMass(60).setCollisionGroups(groups(Group.DEBRIS, 0xffff)), b);
      physics.tag(c, { kind: 'debris', name: 'hay bale' });
    } else {
      const c = physics.world.createCollider(
        (obstacle === 'wall' ? RAPIER.ColliderDesc.cuboid(6, 2, 1) : RAPIER.ColliderDesc.ball(1.2)).setTranslation(0, obstacle === 'wall' ? 1 : 0.8, z + 1).setCollisionGroups(groups(obstacle === 'wall' ? Group.GROUND : Group.STATIC, 0xffff)),
        physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
      );
      physics.tag(c, obstacle === 'wall' ? { kind: 'ground', surface: 'dirt' } : { kind: 'static', name: 'boulder' });
    }
    body.setLinvel({ x: 0, y: 0, z: speed }, true);
    v.input = { steer: 0, throttle: 0, brake: 0 };
    step(150);
    const d = v.damage;
    return { physics, v, step, d };
  };
  const slow = ram('pickup', 3, 'boulder');
  check(slow.d === 0, `pickup bumps a boulder at 11 km/h: ${slow.d.toFixed(1)}% (nothing)`);
  slow.physics.dispose();
  const hay = ram('sports', 20, 'hay');
  check(hay.d === 0, `sports car smashes a hay bale at 72 km/h: ${hay.d.toFixed(1)}% (nothing)`);
  hay.physics.dispose();
  const wall = ram('pickup', 16, 'wall');
  check(wall.d > 5 && wall.d <= DAMAGE.hitCap, `pickup into a terrain wall at 58 km/h: ${wall.d.toFixed(1)}%`);
  wall.physics.dispose();
  const hard = ram('pickup', 16, 'boulder');
  check(hard.d > 5, `pickup into a boulder at 58 km/h: ${hard.d.toFixed(1)}%`);
  // Persistence through Reset
  const before = hard.v.damage;
  hard.v.reset({ x: 0, y: 0, z: -30, yaw: 0 });
  hard.step(30);
  check(hard.v.damage === before, `damage persists through Reset (${hard.v.damage.toFixed(1)}%)`);
  hard.physics.dispose();
  // Tougher vehicles take less from the same hit
  const bus = ram('bus', 16, 'boulder');
  const sports = ram('sports', 16, 'boulder');
  check(bus.d < sports.d, `the bus shrugs off a hit the sports car feels (${bus.d.toFixed(1)}% vs ${sports.d.toFixed(1)}%)`);
  bus.physics.dispose();
  sports.physics.dispose();

  // Hard landing: drop from 7 m
  {
    const { physics, v, step } = setup('sedan', 'asphalt', 7);
    step(240);
    check(v.damage > 0, `sedan dropped from 7 m: ${v.damage.toFixed(1)}% (hard landing)`);
    physics.dispose();
    const soft = setup('buggy', 'asphalt', 1.2);
    soft.step(180);
    check(soft.v.damage === 0, 'buggy dropped from 1.2 m: no damage');
    soft.physics.dispose();
  }

  // Car vs car, head-on: the heavier car takes less
  {
    const physics = new PhysicsWorld();
    const g = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physics.tag(physics.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 2, 500).setTranslation(0, -2, 0).setCollisionGroups(groups(Group.GROUND, 0xffff)), g), { kind: 'ground', surface: 'asphalt' });
    const mk = (kind: VehicleKind, z: number, yaw: number, racer: 'player' | 'cpu') => createVehicle({ physics, surfaces: { surfaceAt: () => 'asphalt' }, spec: VEHICLES[kind], paint: 0, racer, spawn: { x: 0, y: 0, z, yaw } });
    const a = mk('hatch', 0, 0, 'player');
    const b = mk('bus', 30, Math.PI, 'cpu');
    const seen: { racer: string; damage: number; delta: number }[] = [];
    const off = events.on('car:damage', (e) => seen.push(e));
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        for (const v of [a, b]) v.fixedUpdate!(PHYSICS_DT);
        physics.step();
        for (const v of [a, b]) {
          v.postPhysics!(PHYSICS_DT);
          v.update!(PHYSICS_DT, 1);
        }
      }
    };
    run(60);
    (a as unknown as { rigidBody: RAPIER.RigidBody }).rigidBody.setLinvel({ x: 0, y: 0, z: 9 }, true);
    (b as unknown as { rigidBody: RAPIER.RigidBody }).rigidBody.setLinvel({ x: 0, y: 0, z: -9 }, true);
    run(150);
    off();
    check(a.damage > 0 && b.damage > 0 && a.damage > b.damage, `head-on at 65 km/h closing: hatch ${a.damage.toFixed(1)}%, bus ${b.damage.toFixed(1)}%`);
    check(seen.length > 0 && seen.every((e) => e.delta > 0 && e.damage <= 100), `'car:damage' events carry total + delta (${seen.length} events)`);
    a.dispose();
    b.dispose();
    physics.dispose();
  }

  // Animals: damaging ones dent, small ones only bump
  {
    const { physics, v, step } = setup('pickup');
    step(30);
    events.emit('animal:bump', { kind: 'duck', racer: 'player', x: v.position.x, z: v.position.z + 2, damaging: false, speed: 15 });
    check(v.damage === 0, 'bumping a duck: no damage');
    events.emit('animal:bump', { kind: 'bear', racer: 'player', x: v.position.x, z: v.position.z + 2, damaging: true, speed: 15 });
    check(v.damage > 5 && v.damage <= DAMAGE.animalCap, `bumping a bear at 54 km/h: ${v.damage.toFixed(1)}%`);
    events.emit('animal:bump', { kind: 'bear', racer: 'cpu', x: 0, z: 0, damaging: true, speed: 15 });
    check(v.damage <= DAMAGE.animalCap, "another racer's animal bump doesn't count");
    physics.dispose();
  }

  // Driving effect: top speed −25% at 100%, never stops; caps at 100
  {
    const top = (dmg: number) => {
      const { physics, v, step } = setup('pickup');
      step(30);
      if (dmg) v.addDamage(dmg);
      v.input = { steer: 0, throttle: 1, brake: 0 };
      let t30 = -1;
      step(60 * 15, (i) => {
        if (t30 < 0 && v.speed > 30 / 3.6) t30 = i * PHYSICS_DT;
      });
      const r = { top: v.speed, t30, damage: v.damage };
      physics.dispose();
      return r;
    };
    const t0 = top(0);
    const t50 = top(50);
    const t100 = top(100);
    const tOver = top(250);
    console.log(`  pickup top speed: 0% ${kmh(t0.top)} km/h (0-30 ${t0.t30.toFixed(2)} s), 50% ${kmh(t50.top)} (${t50.t30.toFixed(2)} s), 100% ${kmh(t100.top)} (${t100.t30.toFixed(2)} s)`);
    check(t100.top / t0.top > 0.7 && t100.top / t0.top < 0.82, `100% damage costs about a quarter of top speed (${((1 - t100.top / t0.top) * 100).toFixed(0)}%)`);
    check(t50.top < t0.top && t50.top > t100.top, 'top speed drops progressively with damage');
    check(t100.t30 > t0.t30 && t100.t30 > 0, `acceleration is slower but never zero (0-30 km/h ${t100.t30.toFixed(2)} s)`);
    check(tOver.damage === 100, `damage caps at 100% (${tOver.damage})`);
  }

  // Steering pull at 100%: drifts to one side with no steering input
  {
    const { physics, v, step } = setup('sedan');
    step(30);
    v.addDamage(100, { x: 1, y: 0, z: 0.3 });
    v.input = { steer: 0, throttle: 0.7, brake: 0 };
    step(60 * 8);
    const lat = v.position.x;
    check(Math.abs(lat) > 1 && Math.abs(lat) < 40, `a wrecked car pulls slightly to one side (${lat.toFixed(1)} m off line after 8 s)`);
    physics.dispose();
  }

  // Visuals: dents edit geometry in place (one crack decal at most), and dispose cleans up
  {
    const { physics, v } = setup('sedan');
    const obj = v.object;
    const meshes = () => {
      let n = 0;
      obj.traverse((o) => ((o as THREE.Mesh).isMesh ? n++ : 0));
      return n;
    };
    const n0 = meshes();
    const paint = obj.getObjectByName('paint') as THREE.Mesh;
    const pos0 = Float32Array.from(paint.geometry.attributes.position.array as Float32Array);
    for (let i = 0; i < 8; i++) v.addDamage(12, { x: Math.sin(i), y: 0, z: Math.cos(i) });
    const pos1 = paint.geometry.attributes.position.array as Float32Array;
    let moved = 0;
    let maxOff = 0;
    for (let i = 0; i < pos0.length; i += 3) {
      const d = Math.hypot(pos1[i] - pos0[i], pos1[i + 1] - pos0[i + 1], pos1[i + 2] - pos0[i + 2]);
      if (d > 1e-4) moved++;
      maxOff = Math.max(maxOff, d);
    }
    check(moved > 50 && maxOff <= 0.2001, `dents: ${moved} paint vertices moved, max ${maxOff.toFixed(3)} m (capped)`);
    check(!!obj.getObjectByName('crack'), 'cracked windscreen decal after heavy damage');
    const n1 = meshes();
    check(n1 - n0 <= 1, `no new meshes per hit (${n0} → ${n1}, crack decal only; fallen bumpers leave the car)`);
    check([...Array(pos1.length).keys()].every((i) => Number.isFinite(pos1[i])), 'dented geometry has no NaNs');
    physics.dispose();
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
