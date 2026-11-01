/**
 * Headless driving test: no browser needed. Run: npm run physics-test
 * Simulates the pickup on flat ground + a ramp and prints metrics for tuning/regressions.
 * Exits non-zero if a basic expectation fails (flip on a turn, can't reverse, tunnels through ground...).
 */
import * as THREE from 'three';
import { initRapier, PhysicsWorld, RAPIER, PHYSICS_DT, Group, groups } from '../src/core/physics';
import { createVehicle } from '../src/vehicles/vehicle';
import { VEHICLES } from '../src/vehicles/catalog';
import type { VehicleKind } from '../src/core/types';

await initRapier();

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${msg}`);
  if (!ok) failures++;
};

function setup(kind: VehicleKind) {
  const physics = new PhysicsWorld();
  const g = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const col = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 2, 2000).setTranslation(0, -2, 0).setCollisionGroups(groups(Group.GROUND, 0xffff)), g);
  physics.tag(col, { kind: 'ground', surface: 'asphalt' });
  const v = createVehicle({ physics, surfaces: { surfaceAt: () => 'asphalt' }, spec: VEHICLES[kind], paint: 0, racer: 'player', spawn: { x: 0, y: 0, z: 0, yaw: 0 } });
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

for (const kind of (process.argv[2] ? [process.argv[2]] : ['pickup', 'sports', 'muscle', 'monster', 'buggy', 'sedan']) as VehicleKind[]) {
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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
