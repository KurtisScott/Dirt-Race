import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * Keeps the previous and current physics pose of a rigid body so rendering can
 * interpolate between fixed steps (smooth motion at any frame rate).
 *
 * Usage: call `capture()` after every physics step (postPhysics) and
 * `apply(object, alpha)` once per rendered frame. Call `snap()` after teleports.
 */
export class InterpolatedPose {
  readonly prevPos = new THREE.Vector3();
  readonly currPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly currQuat = new THREE.Quaternion();
  /** The interpolated pose from the last `apply` (handy for cameras/HUD). */
  readonly renderPos = new THREE.Vector3();
  readonly renderQuat = new THREE.Quaternion();

  constructor(private body: RAPIER.RigidBody) {
    this.snap();
  }

  capture(): void {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  snap(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.renderPos.copy(this.currPos);
    this.renderQuat.copy(this.currQuat);
  }

  apply(object: THREE.Object3D | null, alpha: number): void {
    this.renderPos.lerpVectors(this.prevPos, this.currPos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    if (object) {
      object.position.copy(this.renderPos);
      object.quaternion.copy(this.renderQuat);
    }
  }
}
