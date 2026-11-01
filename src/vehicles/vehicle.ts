import * as THREE from 'three';
import { events } from '../core/events';
import { InterpolatedPose } from '../core/interpolation';
import { clamp } from '../core/math';
import { Group, groups, RAPIER, type PhysicsWorld } from '../core/physics';
import type { DriveInput, RacerId, SpawnPoint, SurfaceType } from '../core/types';
import { SURFACES } from '../world/surfaces';
import type { SurfaceQuery } from '../world/types';
import type { ModelBuilder, VehicleModel } from './model';
import { buildVehicleModel } from './models/build';
import { paramsFromSpec } from './params';
import type { Vehicle, VehicleParams, VehicleSpec, WheelState } from './types';

export interface CreateVehicleOptions {
  physics: PhysicsWorld;
  /** Where to add the visual model (usually renderer.scene). Omit for headless tests. */
  parent?: THREE.Object3D;
  surfaces: SurfaceQuery;
  spec: VehicleSpec;
  paint: number;
  racer: RacerId;
  spawn: SpawnPoint;
  modelBuilder?: ModelBuilder;
  /** Override derived params (tuning/debug). */
  paramOverrides?: Partial<VehicleParams>;
}

const UP = new THREE.Vector3(0, 1, 0);
const FL = 0;
const FR = 1;
const RL = 2;
const RR = 3;
/** Below this forward speed (m/s) the brake pedal becomes reverse. */
const REVERSE_THRESHOLD = 0.6;
/** Natural slow-down when coasting (engine braking + rolling), m/s^2. */
const COAST_DECEL = 1.6;
/** Light aero drag coefficient: decel = AERO · v² (m/s², per kg-normalised). */
const AERO = 0.0005;
/**
 * Fraction of top speed lost on each surface by a car with off-road stat 1 (scaled by 1 − offroad,
 * so off-road 5 loses nothing). The sports car tops out ~45 km/h in mud; the monster truck is unaffected.
 */
const SURFACE_SPEED_PENALTY: Record<SurfaceType, number> = { asphalt: 0, dirt: 0.12, gravel: 0.18, mud: 0.7, sand: 0.5, water: 0.4 };

// Scratch objects (no per-frame allocation).
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

export function createVehicle(opts: CreateVehicleOptions): Vehicle {
  return new RaycastVehicle(opts);
}

/**
 * A car driven by Rapier's DynamicRayCastVehicleController with arcade assists:
 * speed-sensitive steering, rate-limited steering, roll assist, air leveling,
 * surface grip/drag, hill-climb boost, auto-reverse on brake at standstill.
 *
 * Chassis local axes: +Z forward, +Y up, +X left.
 */
class RaycastVehicle implements Vehicle {
  readonly racer: RacerId;
  readonly spec: VehicleSpec;
  readonly paint: number;
  readonly params: VehicleParams;
  input: DriveInput = { steer: 0, throttle: 0, brake: 0 };

  speed = 0;
  rpm = 0;
  steerAngle = 0;
  wheelsOnGround = 0;
  airTime = 0;
  surface: SurfaceType = 'asphalt';
  flipped = false;
  readonly wheels: WheelState[];
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly object: THREE.Object3D;

  private body: RAPIER.RigidBody;
  private controller: RAPIER.DynamicRayCastVehicleController;
  private pose: InterpolatedPose;
  private model: VehicleModel;
  private physics: PhysicsWorld;
  private surfaces: SurfaceQuery;
  private frozen = false;
  private reversing = false;
  private flippedTime = 0;
  private minAirVy = 0;
  private prevWheelRot = [0, 0, 0, 0];
  private currWheelRot = [0, 0, 0, 0];
  private prevSusp = [0, 0, 0, 0];
  private currSusp = [0, 0, 0, 0];
  private chassisHeightOffset: number;
  /** fadeTop / topSpeed, see engineForce. */
  private topSpeedComp = 1;
  /** Average raw SURFACES grip of grounded wheels (last step). */
  private avgSurfaceGrip = 1;

  constructor(o: CreateVehicleOptions) {
    this.racer = o.racer;
    this.spec = o.spec;
    this.paint = o.paint;
    this.physics = o.physics;
    this.surfaces = o.surfaces;
    const p = (this.params = { ...paramsFromSpec(o.spec), ...o.paramOverrides });
    const world = o.physics.world;

    // Solve a·(1 − (top/T)²) = AERO·top² + rolling + damping·top for T, so flat-asphalt top speed hits the target.
    const a = p.engineForce / p.mass;
    const resist = AERO * p.topSpeed ** 2 + SURFACES.asphalt.rolling + p.linearDamping * p.topSpeed;
    this.topSpeedComp = 1 / Math.sqrt(Math.max(0.2, 1 - resist / a));

    // ---- chassis
    this.chassisHeightOffset = p.suspensionRest + p.wheelRadius - p.wheelY + 0.05;
    const s = o.spawn;
    _q.setFromAxisAngle(UP, s.yaw);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(s.x, s.y + this.chassisHeightOffset, s.z)
        .setRotation(_q)
        .setLinearDamping(p.linearDamping)
        .setAngularDamping(p.angularDamping)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const he = p.halfExtents;
    const { length: L, width: W, height: H } = o.spec.size;
    const m = p.mass;
    // Inertia of the full visual box (bigger than the collider) → calmer rotations. Extra roll inertia for stability.
    const inertia = { x: (m / 12) * (H * H + L * L), y: (m / 12) * (W * W + L * L), z: (m / 12) * (W * W + H * H) * 1.6 };
    const col = world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(he.x - 0.08, he.y - 0.08, he.z - 0.08, 0.08)
        .setMassProperties(m, { x: 0, y: -p.comDrop, z: 0.05 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.5)
        .setRestitution(0.05)
        .setCollisionGroups(groups(Group.VEHICLE, 0xffff))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(m * 25),
      this.body,
    );
    o.physics.tag(col, { kind: 'vehicle', racer: o.racer });

    // A cab/roof collider so the car rests on its roof (and the roll assist can recover) instead of sinking its body.
    const roofH = Math.max(0.1, (H - he.y * 2 - p.wheelRadius * 0.4) / 2);
    const roof = world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(he.x * 0.8, roofH * 0.8, he.z * 0.35, 0.08)
        .setTranslation(0, he.y + roofH, 0.1)
        .setDensity(0)
        .setFriction(0.3)
        .setCollisionGroups(groups(Group.VEHICLE, 0xffff)),
      this.body,
    );
    o.physics.tag(roof, { kind: 'vehicle', racer: o.racer });

    // ---- wheels
    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const dir = { x: 0, y: -1, z: 0 };
    const axle = { x: -1, y: 0, z: 0 };
    const mounts = [
      { x: p.wheelX, y: p.wheelY, z: p.wheelZ },
      { x: -p.wheelX, y: p.wheelY, z: p.wheelZ },
      { x: p.wheelX, y: p.wheelY, z: -p.wheelZ },
      { x: -p.wheelX, y: p.wheelY, z: -p.wheelZ },
    ];
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      this.controller.addWheel(mounts[i], dir, axle, p.suspensionRest, p.wheelRadius);
      this.controller.setWheelMaxSuspensionTravel(i, p.suspensionTravel);
      this.controller.setWheelSuspensionStiffness(i, p.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(i, p.suspensionCompression);
      this.controller.setWheelSuspensionRelaxation(i, p.suspensionRelaxation);
      this.controller.setWheelMaxSuspensionForce(i, p.maxSuspensionForce);
      this.controller.setWheelFrictionSlip(i, p.frictionSlip);
      this.controller.setWheelSideFrictionStiffness(i, p.sideFrictionStiffness);
      this.wheels.push({ contact: false, point: new THREE.Vector3(), surface: 'asphalt', slip: 0, compression: 0 });
      this.currSusp[i] = this.prevSusp[i] = p.suspensionRest;
    }

    // ---- visuals
    this.model = (o.modelBuilder ?? buildVehicleModel)(o.spec, o.paint, p);
    this.object = this.model.root;
    o.parent?.add(this.object);
    this.pose = new InterpolatedPose(this.body);
    this.pose.apply(this.object, 1);
    this.syncRenderState();
  }

  get rigidBody(): RAPIER.RigidBody {
    return this.body;
  }

  // ------------------------------------------------------------------ physics

  fixedUpdate(dt: number): void {
    const p = this.params;
    const body = this.body;
    const ctrl = this.controller;
    const inp = this.frozen ? { steer: 0, throttle: 0, brake: 1 } : this.input;

    // Orientation basis from the physics pose.
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(-1, 0, 0).applyQuaternion(_q);
    const lv = body.linvel();
    _v.set(lv.x, lv.y, lv.z);
    const fwdSpeed = _v.dot(_fwd);
    const absSpeed = Math.abs(fwdSpeed);

    // Steep-climb blend 0..1 between 6° and 12° nose-up.
    const slopeK = clamp((Math.asin(clamp(_fwd.y, -1, 1)) * 57.3 - 6) / 6, 0, 1);

    // ---- surface + grip per wheel (from last step's contacts)
    let gripSum = 0;
    let surfGripSum = 0;
    let dragSum = 0;
    let rollSum = 0;
    let onGround = 0;
    const counts: Partial<Record<SurfaceType, number>> = {};
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const surf = w.contact ? w.surface : 'asphalt';
      const sp = SURFACES[surf];
      // Off-road ability softens grip loss and drag on loose surfaces.
      const loose = surf === 'asphalt' ? 0 : 1;
      const grip = 1 - (1 - sp.grip) * (1 - 0.55 * p.offroad * loose);
      // On steep slopes make sure the tyre limit sits above the hill-climb traction cap (see engineForce),
      // so the stat decides climbing instead of Rapier wheelspin (which collapses traction entirely).
      const slopeFs = slopeK > 0 ? slopeK * 2.2 * (p.climbTraction ?? 0.85) * (sp.grip / SURFACES.gravel.grip) : 0;
      ctrl.setWheelFrictionSlip(i, Math.max(p.frictionSlip * grip, slopeFs));
      if (w.contact) {
        onGround++;
        gripSum += grip;
        surfGripSum += sp.grip;
        dragSum += sp.drag * (1 - 0.7 * p.offroad * loose);
        rollSum += sp.rolling * (1 - 0.6 * p.offroad * loose);
        counts[surf] = (counts[surf] ?? 0) + 1;
      }
    }
    if (onGround) this.avgSurfaceGrip = surfGripSum / onGround;
    if (onGround) {
      let best: SurfaceType = this.surface;
      let bestN = 0;
      for (const k in counts) {
        const n = counts[k as SurfaceType]!;
        if (n > bestN) {
          bestN = n;
          best = k as SurfaceType;
        }
      }
      if (best !== this.surface) {
        this.surface = best;
        events.emit('vehicle:surface', { racer: this.racer, surface: best });
      }
    }

    // ---- steering: speed-sensitive max angle, rate-limited
    const speedT = clamp(absSpeed / p.topSpeed, 0, 1);
    const maxSteer = p.steerLow + (p.steerHigh - p.steerLow) * Math.sqrt(speedT);
    const targetSteer = -clamp(inp.steer, -1, 1) * maxSteer; // +X is left → right turn is negative angle
    const maxDelta = p.steerRate * dt;
    this.steerAngle += clamp(targetSteer - this.steerAngle, -maxDelta, maxDelta);
    ctrl.setWheelSteering(FL, this.steerAngle);
    ctrl.setWheelSteering(FR, this.steerAngle);

    // ---- gas / brake / reverse
    const throttle = clamp(inp.throttle, 0, 1);
    const brake = clamp(inp.brake, 0, 1);
    let engine = 0; // total engine force, N (negative = reverse)
    let brakeDecel = 0; // m/s^2
    if (throttle > 0.05) {
      if (fwdSpeed < -REVERSE_THRESHOLD) brakeDecel = p.brakeDecel * throttle;
      else {
        this.reversing = false;
        engine = this.engineForce(fwdSpeed, throttle);
      }
    } else if (brake > 0.05) {
      if (fwdSpeed > REVERSE_THRESHOLD && !this.reversing) brakeDecel = p.brakeDecel * brake;
      else {
        this.reversing = true;
        const fade = clamp(1 - -fwdSpeed / p.reverseSpeed, 0, 1);
        engine = -p.engineForce * 0.5 * brake * fade;
      }
    } else {
      if (absSpeed < 0.3) this.reversing = false;
      brakeDecel = COAST_DECEL;
    }

    const driven = p.drive === 'all' ? [FL, FR, RL, RR] : p.drive === 'front' ? [FL, FR] : [RL, RR];
    for (let i = 0; i < 4; i++) {
      ctrl.setWheelEngineForce(i, driven.includes(i) ? engine / driven.length : 0);
      // Rapier brake = max impulse per wheel per step.
      ctrl.setWheelBrake(i, (p.mass * brakeDecel * dt) / 4);
    }

    // ---- surface drag & rolling resistance (Rapier has none)
    if (onGround && absSpeed > 0.2) {
      const drag = dragSum / onGround;
      const roll = rollSum / onGround;
      const decel = drag * absSpeed + roll;
      const imp = p.mass * Math.min(decel, absSpeed / dt) * dt;
      body.applyImpulse({ x: -_fwd.x * Math.sign(fwdSpeed) * imp, y: 0, z: -_fwd.z * Math.sign(fwdSpeed) * imp }, true);
    }
    // Light aero drag everywhere.
    const aero = AERO * p.mass * fwdSpeed * absSpeed * dt;
    body.applyImpulse({ x: -_fwd.x * aero, y: -_fwd.y * aero, z: -_fwd.z * aero }, true);

    // ---- stability assists
    const av = body.angvel();
    _v2.set(av.x, av.y, av.z);
    const groundedRatio = onGround / 4;
    // Roll assist: PD controller on roll about the forward axis. Strong enough to stop
    // trivial flips, weak enough that big crashes can still tip the car (auto-reset handles that).
    _v.crossVectors(_up, UP); // axis * sin(tilt)
    const rollErr = _v.dot(_fwd);
    const rollRate = _v2.dot(_fwd);
    const tiltDeg = Math.acos(clamp(_up.y, -1, 1)) * 57.3;
    if (tiltDeg < 100) {
      const k = p.antiRoll * (0.4 + 0.6 * groundedRatio);
      const Iroll = (p.mass / 12) * (this.spec.size.width ** 2 + this.spec.size.height ** 2) * 1.6;
      const t = (rollErr * k - rollRate * 1.2) * Iroll * dt;
      body.applyTorqueImpulse({ x: _fwd.x * t, y: _fwd.y * t, z: _fwd.z * t }, true);
    }
    if (onGround === 0) {
      // Air control: slowly level pitch & roll so jumps land on the wheels.
      this.airTime += dt;
      this.minAirVy = Math.min(this.minAirVy, body.linvel().y);
      const Iair = (p.mass / 12) * (this.spec.size.length ** 2) * dt * p.airControl;
      const pitchErr = _v.dot(_right);
      const t = pitchErr * 2.5 * Iair;
      body.applyTorqueImpulse({ x: _right.x * t - _v2.x * Iair * 0.5, y: _right.y * t, z: _right.z * t - _v2.z * Iair * 0.5 }, true);
    }

    // Keep the steering rate & reversing logic honest at standstill on slopes.
    if (onGround >= 3 && throttle < 0.05 && brake < 0.05 && absSpeed < 0.5) {
      for (let i = 0; i < 4; i++) ctrl.setWheelBrake(i, (p.mass * 6 * dt) / 4);
    }

    // ---- run the ray-cast vehicle (applies suspension + tyre impulses to the chassis)
    ctrl.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(Group.VEHICLE, Group.GROUND | Group.STATIC | Group.DEBRIS), (c) => c.parent()?.handle !== body.handle);
  }

  /** Engine force (N) with top-speed fade, surface speed cap, hill-climb boost and slope traction limit. */
  private engineForce(fwdSpeed: number, throttle: number): number {
    const p = this.params;
    const v = Math.max(0, fwdSpeed);
    // Loose/deep surfaces cap the speed of cars with poor off-road ability (sports car bogs in mud).
    const top = p.topSpeed * (1 - SURFACE_SPEED_PENALTY[this.surface] * (1 - p.offroad));
    // Fade towards `fadeTop` (> top) so that, after aero drag + asphalt rolling resistance, the
    // equilibrium speed on flat asphalt lands on params.topSpeed (M1 was ~10% under).
    const fade = clamp(1 - (v / (top * this.topSpeedComp)) ** 2, 0, 1);
    // Nose-up pitch → more torque for good climbers (SPEC: hill climb stat).
    const slopeSin = clamp(_fwd.y, -1, 1);
    const climb = clamp(slopeSin / 0.574, 0, 1.2); // sin(35°) ≈ 0.574
    const boost = 1 + p.climbBoost * climb;
    // Strong launch, tapering mid-range (feels punchy for a kid without being twitchy).
    const launch = 1 + 0.35 * clamp(1 - v / 8, 0, 1);
    let f = p.engineForce * throttle * fade * boost * launch;
    // Slope traction limit: on a steep climb the tyres can only push mass·g·cos·μ. μ comes from the
    // hill-climb stat scaled by current surface grip (relative to gravel). Blended in from 6° to 12°.
    const slopeDeg = Math.asin(slopeSin) * 57.3;
    if (slopeDeg > 6) {
      // Raw surface grip (no off-road bonus): climbing is the hill-climb stat's job, not off-road's.
      const mu = (p.climbTraction ?? 0.85) * (this.avgSurfaceGrip / SURFACES.gravel.grip);
      const cap = p.mass * 9.81 * Math.sqrt(1 - slopeSin * slopeSin) * mu * throttle;
      const k = clamp((slopeDeg - 6) / 6, 0, 1);
      f = Math.min(f, f + (cap - f) * k);
      // Power limit on steep climbs (14° → 20°): sets the crawl speed, so run-up speed bleeds off.
      if (p.climbPower !== undefined && slopeDeg > 14) {
        const pk = clamp((slopeDeg - 14) / 6, 0, 1);
        const pcap = (p.mass * p.climbPower * throttle) / Math.max(v, 1.5);
        f = Math.min(f, f + (pcap - f) * pk);
      }
    }
    return f;
  }

  postPhysics(dt: number): void {
    const ctrl = this.controller;
    const body = this.body;
    this.pose.capture();
    this.speed = ctrl.currentVehicleSpeed();
    // currentVehicleSpeed is |v| signed by forward direction; prefer forward component for HUD.
    const r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    const lv = body.linvel();
    this.speed = lv.x * _fwd.x + lv.y * _fwd.y + lv.z * _fwd.z;

    let onGround = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.contact = ctrl.wheelIsInContact(i);
      this.prevSusp[i] = this.currSusp[i];
      this.currSusp[i] = ctrl.wheelSuspensionLength(i) ?? this.params.suspensionRest;
      this.prevWheelRot[i] = this.currWheelRot[i];
      this.currWheelRot[i] = ctrl.wheelRotation(i) ?? 0;
      w.compression = clamp((this.params.suspensionRest + this.params.suspensionTravel - this.currSusp[i]) / (2 * this.params.suspensionTravel), 0, 1);
      if (w.contact) {
        onGround++;
        const cp = ctrl.wheelContactPoint(i);
        if (cp) w.point.set(cp.x, cp.y, cp.z);
        const g = ctrl.wheelGroundObject(i);
        const tag = g ? this.physics.getTag(g.handle) : undefined;
        w.surface = tag?.kind === 'ground' && tag.surface ? tag.surface : this.surfaces.surfaceAt(w.point.x, w.point.z);
        const side = Math.abs(ctrl.wheelSideImpulse(i) ?? 0);
        const fwdImp = Math.abs(ctrl.wheelForwardImpulse(i) ?? 0);
        const load = Math.max(1, (ctrl.wheelSuspensionForce(i) ?? 0) * dt);
        w.slip = clamp((side + fwdImp * 0.5) / (load * this.params.frictionSlip) - 0.3, 0, 1);
      } else {
        w.slip = 0;
      }
    }

    // Landing detection
    if (onGround > 0 && this.wheelsOnGround === 0 && this.airTime > 0.25) {
      const impact = -this.minAirVy;
      if (impact > 3) events.emit('vehicle:landed', { racer: this.racer, impact });
    }
    if (onGround > 0) {
      this.airTime = 0;
      this.minAirVy = 0;
    }
    this.wheelsOnGround = onGround;

    // Flip detection: on side/roof and nearly stopped for 1.5 s.
    const upsideish = _up.y < 0.35;
    if (upsideish && Math.abs(this.speed) < 3) this.flippedTime += dt;
    else this.flippedTime = 0;
    const nowFlipped = this.flippedTime > 1.5;
    if (nowFlipped && !this.flipped) events.emit('vehicle:flipped', { racer: this.racer });
    this.flipped = nowFlipped;

    // RPM estimate for audio: speed within a pseudo gear + throttle load.
    const v = Math.abs(this.speed);
    const gearSpan = this.params.topSpeed / 4;
    const inGear = (v % gearSpan) / gearSpan;
    const gear = Math.min(3, Math.floor(v / gearSpan));
    const target = clamp(0.15 + (gear === 0 ? v / gearSpan : 0.35 + inGear * 0.6) * 0.85 + (onGround ? 0 : this.input.throttle * 0.3), 0, 1);
    this.rpm += (target - this.rpm) * 0.2;
  }

  // ------------------------------------------------------------------ render

  update(_dt: number, alpha: number): void {
    this.pose.apply(this.object, alpha);
    this.syncRenderState();
    for (let i = 0; i < 4; i++) {
      const w = this.model.wheels[i];
      const m = this.controller.wheelChassisConnectionPointCs(i);
      if (!m) continue;
      const susp = this.prevSusp[i] + (this.currSusp[i] - this.prevSusp[i]) * alpha;
      w.position.set(m.x, m.y - susp, m.z);
      const rot = this.prevWheelRot[i] + (this.currWheelRot[i] - this.prevWheelRot[i]) * alpha;
      // Steer about Y, then spin about the axle (X).
      w.rotation.set(rot, i < 2 ? this.steerAngle : 0, 0, 'YXZ');
    }
    this.model.animate?.(_dt, this);
  }

  private syncRenderState(): void {
    this.position.copy(this.pose.renderPos);
    this.quaternion.copy(this.pose.renderQuat);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
  }

  // ------------------------------------------------------------------ control

  reset(at: SpawnPoint): void {
    const b = this.body;
    _q.setFromAxisAngle(UP, at.yaw);
    b.setTranslation({ x: at.x, y: at.y + this.chassisHeightOffset + 0.3, z: at.z }, true);
    b.setRotation(_q, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.reversing = false;
    this.flipped = false;
    this.flippedTime = 0;
    this.airTime = 0;
    this.minAirVy = 0;
    this.pose.snap();
    this.syncRenderState();
    events.emit('vehicle:reset', { racer: this.racer });
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  dispose(): void {
    this.object.parent?.remove(this.object);
    this.model.dispose();
    this.physics.world.removeVehicleController(this.controller);
    this.physics.removeBody(this.body);
  }
}
