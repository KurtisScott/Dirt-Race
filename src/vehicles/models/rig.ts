import * as THREE from 'three';

/**
 * Animated "links" between the body and the (moving) wheels: shocks, A-arms, solid axles.
 * All links of a vehicle are one InstancedMesh (1 draw call), updated each frame from the wheel
 * positions the vehicle has just set. Endpoints are fixed points in chassis space or wheel-relative
 * offsets (non-spinning: only the wheel's position is used, plus the steer angle for front wheels).
 */
/** `fixed`: a point in body ground space (follows the body group). `wheel`: wheel centre + offset (offset follows steering unless noSteer). */
export type LinkEnd = { fixed: THREE.Vector3 } | { wheel: number; offset?: THREE.Vector3; noSteer?: boolean };
export interface Link {
  a: LinkEnd;
  b: LinkEnd;
  radius: number;
  color: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const Y = new THREE.Vector3(0, 1, 0);

export class LinkRig {
  readonly mesh: THREE.InstancedMesh;
  constructor(
    private links: Link[],
    private wheels: THREE.Object3D[],
    material: THREE.Material,
    /** The body group: fixed points are transformed by its matrix. */
    private body: THREE.Object3D,
  ) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.mesh = new THREE.InstancedMesh(geo, material, links.length);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    const c = new THREE.Color();
    links.forEach((l, i) => this.mesh.setColorAt(i, c.setHex(l.color)));
  }

  private end(e: LinkEnd, out: THREE.Vector3): THREE.Vector3 {
    if ('fixed' in e) return out.copy(e.fixed).applyMatrix4(this.body.matrix);
    const w = this.wheels[e.wheel];
    out.copy(w.position);
    if (e.offset) {
      // Rotate the offset by the steering yaw only (not the spin).
      const yaw = e.noSteer ? 0 : w.rotation.y;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      out.x += e.offset.x * c + e.offset.z * s;
      out.y += e.offset.y;
      out.z += -e.offset.x * s + e.offset.z * c;
    }
    return out;
  }

  update(): void {
    this.body.updateMatrix();
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      this.end(l.a, _a);
      this.end(l.b, _b);
      _d.subVectors(_b, _a);
      const len = _d.length();
      _q.setFromUnitVectors(Y, _d.multiplyScalar(1 / Math.max(1e-6, len)));
      _s.set(l.radius, len, l.radius);
      _m.compose(_a.add(_b).multiplyScalar(0.5), _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
