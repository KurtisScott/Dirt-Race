/**
 * End-jump tuning harness (headless): each vehicle drives the finish straight + run-up flat out on the
 * centre-line, launches off the ramp, and we record lip speed, distance (lip → touchdown, along the
 * centre-line), airtime, landing impact and whether it stayed on its wheels.
 * Run: npx tsx scripts/jump-tune.ts [kinds]   (START=metres before the finish line, default 170;
 *      NOISE=steering wobble, DAMAGE=pre-damage %, LIFT=seconds off the throttle 120 m before the lip,
 *      HOLD=seconds of full throttle after touchdown — drives on into the run-off and the berm)
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
(globalThis as { __popLog?: boolean }).__popLog = !!process.env.POPLOG;
const data = new CourseData();

export interface JumpRun {
  kind: string;
  lipKmh: number;
  dist: number;
  air: number;
  /** Speed into the ground along its normal at touchdown (m/s) — what landing damage uses. */
  impact: number;
  /** Raw downward speed at touchdown (m/s). */
  vertical: number;
  /** Damage taken from take-off to 3 s after touchdown (%). */
  damage: number;
  upright: boolean;
  bonus: boolean;
}

/** `damage`: pre-damage the car (%); `lift`: lift off the throttle for this many seconds 120 m before the lip. */
export function jumpRun(kind: VehicleKind, startBefore = 170, steerNoise = 0, opts: { damage?: number; lift?: number; holdGas?: number } = {}): JumpRun {
  const physics = new PhysicsWorld();
  const scene = new THREE.Scene();
  const ctx = { physics, renderer: { scene }, quality: { preset: { textureSize: 64, detail: 0.5, level: 'low' } } } as never;
  const world = new RaceCourse(ctx, data);
  world.animalsEnabled = false;
  const j = world.jump;
  const s0 = world.track.finishS - startBefore;
  const v = createVehicle({ physics, surfaces: world, spec: VEHICLES[kind], paint: 0, racer: 'player', spawn: world.data.spawnAt(s0, 0) });
  if (opts.damage) v.addDamage(opts.damage);
  let liftT = 0;
  let impact = 0;
  let vertical = 0;
  let dmg0 = -1;
  const off = events.on('vehicle:landed', (e) => {
    if (e.racer !== 'player' || e.impact < impact) return;
    impact = e.impact;
    vertical = e.vertical ?? e.impact;
  });
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
    v.input.throttle = state === 'land' && landT > (opts.holdGas ?? 1.5) ? 0 : 1;
    if (opts.lift && s > j.lipS - 120 && liftT < opts.lift) {
      liftT += PHYSICS_DT;
      v.input.throttle = 0;
    }
    v.input.brake = 0;
    world.fixedUpdate(PHYSICS_DT);
    v.fixedUpdate!(PHYSICS_DT);
    physics.step();
    v.postPhysics!(PHYSICS_DT);
    v.update!(PHYSICS_DT, 1);
    up.set(0, 1, 0).applyQuaternion(v.quaternion);
    if (state === 'run') {
      if (s > j.lipS - 3) lipV = Math.max(lipV, v.speed);
      if (s > j.lipS - 4 && s < j.lipS + 15 && v.wheelsOnGround === 0 && v.airTime > 0.12) {
        state = 'air';
        dmg0 = v.damage;
      }
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
      if (landT > Math.max(3, (opts.holdGas ?? 0) + 2)) break;
    }
  }
  off();
  const damage = dmg0 >= 0 ? v.damage - dmg0 : 0;
  v.dispose();
  world.dispose();
  physics.dispose();
  const dist = landS ? landS - j.lipS : 0;
  return { kind, lipKmh: lipV * 3.6, dist, air: airT, impact, vertical, damage, upright, bonus: upright && dist >= j.bonusM };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kinds = (process.argv[2]?.split(',') ?? Object.keys(VEHICLES)) as VehicleKind[];
  const before = Number(process.env.START ?? 170);
  console.log(`bonus line ${data.jump.bonusM} m past the lip; start ${before} m before the finish (run-up ${(data.jump.footS - data.finishS).toFixed(0)} m)`);
  for (const k of kinds) {
    const r = jumpRun(k, before, Number(process.env.NOISE ?? 0), { damage: Number(process.env.DAMAGE ?? 0), lift: Number(process.env.LIFT ?? 0), holdGas: process.env.HOLD ? Number(process.env.HOLD) : undefined });
    console.log(`  ${k.padEnd(8)} lip ${r.lipKmh.toFixed(0).padStart(3)} km/h  jump ${r.dist.toFixed(1).padStart(5)} m  air ${r.air.toFixed(2)} s  impact ${r.impact.toFixed(1)} (vert ${r.vertical.toFixed(1)}) m/s  dmg ${r.damage.toFixed(1)}%  ${r.upright ? 'upright' : 'CRASH'}  ${r.bonus ? 'BONUS' : ''}`);
  }
}
