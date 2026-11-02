/**
 * End-jump tuning harness (headless): each vehicle drives the finish straight + run-up flat out on the
 * centre-line, launches off the ramp, and we record lip speed, distance (lip → touchdown, along the
 * centre-line), airtime, landing impact and whether it stayed on its wheels.
 * Run: npx tsx scripts/jump-tune.ts [kinds]   (START=metres before the finish line, default 170)
 */
import * as THREE from 'three';
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { initRapier, PhysicsWorld, PHYSICS_DT } = await import('../src/core/physics');
const { events } = await import('../src/core/events');
const { CourseData } = await import('../src/world/course');
const { RaceCourse } = await import('../src/world/raceCourse');
const { createVehicle } = await import('../src/vehicles/vehicle');
const { VEHICLES } = await import('../src/vehicles/catalog');
type VehicleKind = import('../src/core/types').VehicleKind;
await initRapier();
const data = new CourseData();

export interface JumpRun {
  kind: string;
  lipKmh: number;
  dist: number;
  air: number;
  impact: number;
  upright: boolean;
  bonus: boolean;
}

export function jumpRun(kind: VehicleKind, startBefore = 170, steerNoise = 0): JumpRun {
  const physics = new PhysicsWorld();
  const scene = new THREE.Scene();
  const ctx = { physics, renderer: { scene }, quality: { preset: { textureSize: 64, detail: 0.5, level: 'low' } } } as never;
  const world = new RaceCourse(ctx, data);
  world.animalsEnabled = false;
  const j = world.jump;
  const s0 = world.track.finishS - startBefore;
  const v = createVehicle({ physics, surfaces: world, spec: VEHICLES[kind], paint: 0, racer: 'player', spawn: world.data.spawnAt(s0, 0) });
  let impact = 0;
  const off = events.on('vehicle:landed', (e) => (impact = Math.max(impact, e.impact)));
  let s = s0;
  let lipV = 0;
  let state: 'run' | 'air' | 'land' = 'run';
  let airT = 0;
  let landS = 0;
  let landT = 0;
  let upright = true;
  const target = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let i = 0; i < 60 * 40; i++) {
    s = world.track.project(v.position, s).s;
    world.track.pointAt(Math.min(world.track.length, s + 8 + Math.max(0, v.speed) * 0.5), target);
    const dx = target.x - v.position.x;
    const dz = target.z - v.position.z;
    const f = v.forward;
    const ang = Math.atan2(f.z * dx - f.x * dz, f.x * dx + f.z * dz);
    v.input.steer = THREE.MathUtils.clamp(-ang * 2.2 + (steerNoise ? Math.sin(i * 0.05) * steerNoise : 0), -1, 1);
    v.input.throttle = state === 'land' && landT > 1.5 ? 0 : 1;
    v.input.brake = 0;
    world.fixedUpdate(PHYSICS_DT);
    v.fixedUpdate!(PHYSICS_DT);
    physics.step();
    v.postPhysics!(PHYSICS_DT);
    v.update!(PHYSICS_DT, 1);
    up.set(0, 1, 0).applyQuaternion(v.quaternion);
    if (state === 'run') {
      if (s > j.lipS - 3) lipV = Math.max(lipV, v.speed);
      if (s > j.lipS - 4 && s < j.lipS + 15 && v.wheelsOnGround === 0 && v.airTime > 0.12) state = 'air';
      if (s > j.lipS + 25) break;
    } else if (state === 'air') {
      airT += PHYSICS_DT;
      if (v.wheelsOnGround >= 2) {
        state = 'land';
        landS = s;
      }
      if (airT > 8) break;
    } else {
      landT += PHYSICS_DT;
      if (up.y < 0.5 || v.flipped) upright = false;
      if (landT > 1.0 && !upright) break;
      if (landT > 3) break;
    }
  }
  off();
  v.dispose();
  world.dispose();
  physics.dispose();
  const dist = landS ? landS - j.lipS : 0;
  return { kind, lipKmh: lipV * 3.6, dist, air: airT, impact, upright, bonus: upright && dist >= j.bonusM };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kinds = (process.argv[2]?.split(',') ?? ['sports', 'muscle', 'buggy', 'pickup', 'monster', 'sedan']) as VehicleKind[];
  const before = Number(process.env.START ?? 170);
  console.log(`bonus line ${data.jump.bonusM} m past the lip; start ${before} m before the finish (run-up ${(data.jump.footS - data.finishS).toFixed(0)} m)`);
  for (const k of kinds) {
    const r = jumpRun(k, before, Number(process.env.NOISE ?? 0));
    console.log(`  ${k.padEnd(8)} lip ${r.lipKmh.toFixed(0).padStart(3)} km/h  jump ${r.dist.toFixed(1).padStart(5)} m  air ${r.air.toFixed(2)} s  impact ${r.impact.toFixed(1)} m/s  ${r.upright ? 'upright' : 'CRASH'}  ${r.bonus ? 'BONUS' : ''}`);
  }
}
