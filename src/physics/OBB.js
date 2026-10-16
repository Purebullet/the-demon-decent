import { Vector3 } from 'three';

// Oriented bounding box with a separating-axis test (Ericson, Real-Time
// Collision Detection, 4.4.1). Used for weapon blades, enemy body-part
// hurtboxes and enemy strike volumes.

const EPS = 1e-6;
const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
const AR = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
const tmp = new Vector3();
const tmp2 = new Vector3();
// Scratch for the tests (they run many times a frame mid-swing: nothing is
// allocated in them).
const AE = [0, 0, 0];
const BE = [0, 0, 0];
const T = [0, 0, 0];
const H = [0, 0, 0];

export class OBB {
  constructor() {
    this.center = new Vector3();
    this.half = new Vector3(0.5, 0.5, 0.5);
    this.axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  }

  // Place a box defined in an object's local space (center + half extents)
  // into world space using that object's world matrix. Scale is folded into
  // the half extents so the axes stay orthonormal.
  setFromMatrix(localCenter, localHalf, m) {
    const e = m.elements;
    this.center.copy(localCenter).applyMatrix4(m);
    const [ax, ay, az] = this.axes;
    ax.set(e[0], e[1], e[2]);
    ay.set(e[4], e[5], e[6]);
    az.set(e[8], e[9], e[10]);
    const sx = ax.length() || 1;
    const sy = ay.length() || 1;
    const sz = az.length() || 1;
    ax.divideScalar(sx);
    ay.divideScalar(sy);
    az.divideScalar(sz);
    this.half.set(localHalf.x * sx, localHalf.y * sy, localHalf.z * sz);
    return this;
  }

  // Build from explicit center, orthonormal axes and half extents.
  set(center, axisX, axisY, axisZ, half) {
    this.center.copy(center);
    this.axes[0].copy(axisX);
    this.axes[1].copy(axisY);
    this.axes[2].copy(axisZ);
    this.half.copy(half);
    return this;
  }

  copy(o) {
    this.center.copy(o.center);
    this.half.copy(o.half);
    for (let i = 0; i < 3; i++) this.axes[i].copy(o.axes[i]);
    return this;
  }

  boundingRadius() {
    return this.half.length();
  }

  closestPoint(p, target) {
    tmp.subVectors(p, this.center);
    target.copy(this.center);
    const h = H;
    h[0] = this.half.x;
    h[1] = this.half.y;
    h[2] = this.half.z;
    for (let i = 0; i < 3; i++) {
      let d = tmp.dot(this.axes[i]);
      if (d > h[i]) d = h[i];
      if (d < -h[i]) d = -h[i];
      target.addScaledVector(this.axes[i], d);
    }
    return target;
  }

  intersectsSphere(center, radius) {
    this.closestPoint(center, tmp2);
    return tmp2.distanceToSquared(center) <= radius * radius;
  }

  containsPoint(p) {
    tmp.subVectors(p, this.center);
    return (
      Math.abs(tmp.dot(this.axes[0])) <= this.half.x &&
      Math.abs(tmp.dot(this.axes[1])) <= this.half.y &&
      Math.abs(tmp.dot(this.axes[2])) <= this.half.z
    );
  }

  intersectsOBB(b) {
    const a = this;
    // Cheap sphere reject first. (Written out in full here and below: this
    // runs many times a frame mid-swing, and every small call that returned
    // a number would leave one behind for the collector.)
    const ah = a.half;
    const bh = b.half;
    const rr = Math.sqrt(ah.x * ah.x + ah.y * ah.y + ah.z * ah.z) + Math.sqrt(bh.x * bh.x + bh.y * bh.y + bh.z * bh.z);
    const dx = b.center.x - a.center.x;
    const dy = b.center.y - a.center.y;
    const dz = b.center.z - a.center.z;
    if (dx * dx + dy * dy + dz * dz > rr * rr) return false;

    const ae = AE;
    const be = BE;
    ae[0] = a.half.x;
    ae[1] = a.half.y;
    ae[2] = a.half.z;
    be[0] = b.half.x;
    be[1] = b.half.y;
    be[2] = b.half.z;
    for (let i = 0; i < 3; i++) {
      const u = a.axes[i];
      for (let j = 0; j < 3; j++) {
        const v = b.axes[j];
        const r = u.x * v.x + u.y * v.y + u.z * v.z;
        R[i][j] = r;
        AR[i][j] = Math.abs(r) + EPS;
      }
    }
    const t = T;
    for (let i = 0; i < 3; i++) {
      const u = a.axes[i];
      t[i] = dx * u.x + dy * u.y + dz * u.z;
    }
    let ra;
    let rb;

    for (let i = 0; i < 3; i++) {
      ra = ae[i];
      rb = be[0] * AR[i][0] + be[1] * AR[i][1] + be[2] * AR[i][2];
      if (Math.abs(t[i]) > ra + rb) return false;
    }
    for (let i = 0; i < 3; i++) {
      ra = ae[0] * AR[0][i] + ae[1] * AR[1][i] + ae[2] * AR[2][i];
      rb = be[i];
      if (Math.abs(t[0] * R[0][i] + t[1] * R[1][i] + t[2] * R[2][i]) > ra + rb) return false;
    }

    // A0 x B0..B2
    ra = ae[1] * AR[2][0] + ae[2] * AR[1][0];
    rb = be[1] * AR[0][2] + be[2] * AR[0][1];
    if (Math.abs(t[2] * R[1][0] - t[1] * R[2][0]) > ra + rb) return false;
    ra = ae[1] * AR[2][1] + ae[2] * AR[1][1];
    rb = be[0] * AR[0][2] + be[2] * AR[0][0];
    if (Math.abs(t[2] * R[1][1] - t[1] * R[2][1]) > ra + rb) return false;
    ra = ae[1] * AR[2][2] + ae[2] * AR[1][2];
    rb = be[0] * AR[0][1] + be[1] * AR[0][0];
    if (Math.abs(t[2] * R[1][2] - t[1] * R[2][2]) > ra + rb) return false;

    // A1 x B0..B2
    ra = ae[0] * AR[2][0] + ae[2] * AR[0][0];
    rb = be[1] * AR[1][2] + be[2] * AR[1][1];
    if (Math.abs(t[0] * R[2][0] - t[2] * R[0][0]) > ra + rb) return false;
    ra = ae[0] * AR[2][1] + ae[2] * AR[0][1];
    rb = be[0] * AR[1][2] + be[2] * AR[1][0];
    if (Math.abs(t[0] * R[2][1] - t[2] * R[0][1]) > ra + rb) return false;
    ra = ae[0] * AR[2][2] + ae[2] * AR[0][2];
    rb = be[0] * AR[1][1] + be[1] * AR[1][0];
    if (Math.abs(t[0] * R[2][2] - t[2] * R[0][2]) > ra + rb) return false;

    // A2 x B0..B2
    ra = ae[0] * AR[1][0] + ae[1] * AR[0][0];
    rb = be[1] * AR[2][2] + be[2] * AR[2][1];
    if (Math.abs(t[1] * R[0][0] - t[0] * R[1][0]) > ra + rb) return false;
    ra = ae[0] * AR[1][1] + ae[1] * AR[0][1];
    rb = be[0] * AR[2][2] + be[2] * AR[2][0];
    if (Math.abs(t[1] * R[0][1] - t[0] * R[1][1]) > ra + rb) return false;
    ra = ae[0] * AR[1][2] + ae[1] * AR[0][2];
    rb = be[0] * AR[2][1] + be[1] * AR[2][0];
    if (Math.abs(t[1] * R[0][2] - t[0] * R[1][2]) > ra + rb) return false;

    return true;
  }
}
