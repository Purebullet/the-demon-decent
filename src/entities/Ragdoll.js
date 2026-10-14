import * as THREE from 'three';

// A dead body's ragdoll: a point at every joint of its skeleton, held at its
// bones' lengths (the torso held near rigid, limbs free to fold), falling
// under gravity onto the floor, kept out of walls, and shoved aside by
// whoever walks into it. Each frame the skeleton is posed from the points:
// every bone turned to point at its child again, twisted to keep its side
// bone (a hip, a shoulder) where it is.
//
//   const rag = new Ragdoll(bones, height, { x, y, z })   at the moment of death
//   rag.step(dt, world, pushers)                          collide and settle
//   rag.apply()                                           pose the bones

const GRAVITY = 18;
const DAMPING = 0.985;
const ITERATIONS = 6;
const SETTLE = 0.0015; // m a step under which a body counts as still
const SLEEP_AFTER = 0.6; // s still before it stops simulating

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _c = new THREE.Vector3();
const _s = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();

// The trunk and where the limbs join it: held to each other almost rigidly.
const TRUNK = /^(Hips|Waist|Chest|Spine|Neck|LeftShoulder|RightShoulder|LeftUpLeg|RightUpLeg|LeftArm|RightArm|Tail$|Tail1)$/;
// The bone a trunk bone keeps pointing at, and the side bone it twists by.
const AIM = { Hips: ['Waist', 'Spine', 'Chest'], Chest: ['Neck', 'Head'], Waist: ['Chest'] };
const SIDE = { Hips: ['LeftUpLeg'], Waist: ['LeftUpLeg'], Chest: ['LeftShoulder', 'LeftArm'] };
const HEAVY = /^(Hips|Waist|Chest|Head)$/;
const END = /Top$|Tip$|Toe$|Snout$|End$/;

export class Ragdoll {
  // bones: the skeleton's bones, parents first. impulse: m/s at death.
  constructor(bones, height, impulse) {
    this.sink = 0;
    this.still = 0;
    this.asleep = false;
    const byName = new Map(bones.map((b) => [b.name, b]));
    // Every joint but the skeleton's root (which stays where the body stood).
    const nodes = bones.filter((b) => b.name !== 'Root');
    const index = new Map();
    this.p = [];
    nodes.forEach((b, i) => {
      index.set(b, i);
      const at = b.getWorldPosition(new THREE.Vector3());
      // The upper body is thrown harder along the blow, so it topples.
      const lift = Math.max(0, Math.min(1, at.y / height));
      const kick = 1 + lift * 0.9;
      const v = new THREE.Vector3(impulse.x * kick, impulse.y * (0.6 + 0.4 * lift), impulse.z * kick);
      v.x += (Math.random() - 0.5) * 0.8;
      v.z += (Math.random() - 0.5) * 0.8;
      this.p.push({
        bone: b,
        x: at.clone(),
        prev: at.clone().addScaledVector(v, -1 / 60),
        r: (HEAVY.test(b.name) ? 0.09 : END.test(b.name) ? 0.03 : 0.05) * height,
      });
    });
    // Bones and their lengths; the trunk bound tight; a little stiffness
    // over every joint so a limb folds but never through itself.
    this.links = [];
    const link = (i, j, k) => {
      if (i === undefined || j === undefined || i === j) return;
      this.links.push({ i, j, len: this.p[i].x.distanceTo(this.p[j].x), k });
    };
    for (const b of nodes) {
      const i = index.get(b);
      const parent = index.get(b.parent);
      link(i, parent, 1);
      const grand = index.get(b.parent?.parent);
      if (grand !== undefined) link(i, grand, TRUNK.test(b.name) && TRUNK.test(b.parent.name) ? 0.8 : 0.12);
    }
    const trunk = nodes.filter((b) => TRUNK.test(b.name)).map((b) => index.get(b));
    for (let a = 0; a < trunk.length; a++) for (let c = a + 1; c < trunk.length; c++) link(trunk[a], trunk[c], 0.9);
    // How each bone is turned from now on: rest direction to its child (and
    // to its side bone), rest world rotation.
    const pick = (b, names) => {
      for (const n of names || []) {
        const c = byName.get(n);
        if (c && index.has(c) && c !== b) return index.get(c);
      }
      return undefined;
    };
    this.drive = [];
    for (const b of nodes) {
      const i = index.get(b);
      const child = pick(b, AIM[b.name]) ?? b.children.map((c) => index.get(c)).find((c) => c !== undefined);
      if (child === undefined) continue;
      const side = pick(b, SIDE[b.name]);
      const d0 = this.p[child].x.clone().sub(this.p[i].x).normalize();
      let s0 = null;
      if (side !== undefined) {
        s0 = this.p[side].x.clone().sub(this.p[i].x);
        s0.addScaledVector(d0, -s0.dot(d0));
        s0 = s0.lengthSq() > 1e-8 ? s0.normalize() : null;
      }
      this.drive.push({ i, child, side, d0, s0, q0: b.getWorldQuaternion(new THREE.Quaternion()) });
    }
    // Bones nothing turns (the ends): they ride on their parent's pose.
    const driven = new Set(this.drive.map((D) => this.p[D.i].bone));
    for (const D of this.drive) D.riders = this.p[D.i].bone.children.filter((c) => c.isBone && !driven.has(c));
    this.root = index.get(byName.get('Hips')) ?? 0;
  }

  // world: the level's collision (walls); pushers: [{ x, z, r, h }] bodies
  // that shove it aside (the player).
  step(dt, world, pushers = []) {
    dt = Math.min(dt, 1 / 30);
    if (dt <= 0) return;
    const P = this.p;
    const hips = P[this.root].x;
    if (this.asleep) {
      // Woken by someone walking into it.
      if (!pushers.some((q) => Math.hypot(q.x - hips.x, q.z - hips.z) < q.r + 1.4)) return;
      this.asleep = false;
      this.still = 0;
    }
    let moved = 0;
    for (const n of P) {
      _a.subVectors(n.x, n.prev).multiplyScalar(DAMPING);
      n.prev.copy(n.x);
      n.x.add(_a);
      n.x.y -= GRAVITY * dt * dt;
    }
    for (let it = 0; it < ITERATIONS; it++) {
      for (const L of this.links) {
        const a = P[L.i].x;
        const b = P[L.j].x;
        _a.subVectors(b, a);
        const d = _a.length() || 1e-6;
        const k = ((d - L.len) / d) * 0.5 * L.k;
        a.addScaledVector(_a, k);
        b.addScaledVector(_a, -k);
      }
      for (const n of P) this._collide(n, pushers);
    }
    // Walls, and the friction of lying on the floor.
    for (const n of P) {
      if (world) {
        _b.copy(n.x);
        world.resolve(n.x, n.r);
        if (_b.x !== n.x.x || _b.z !== n.x.z) {
          n.prev.x = n.x.x;
          n.prev.z = n.x.z;
        }
      }
      if (n.x.y <= n.r + 1e-3) {
        n.prev.x += (n.x.x - n.prev.x) * 0.35;
        n.prev.z += (n.x.z - n.prev.z) * 0.35;
      }
      moved = Math.max(moved, n.x.distanceToSquared(n.prev));
    }
    this.still = Math.sqrt(moved) < SETTLE ? this.still + dt : 0;
    if (this.still > SLEEP_AFTER) this.asleep = true;
  }

  _collide(n, pushers) {
    if (n.x.y < n.r) n.x.y = n.r;
    for (const q of pushers) {
      if (n.x.y > q.h) continue;
      const dx = n.x.x - q.x;
      const dz = n.x.z - q.z;
      const d = Math.hypot(dx, dz);
      const min = q.r + n.r;
      if (d < min) {
        const s = d > 1e-4 ? (min - d) / d : 0;
        n.x.x += d > 1e-4 ? dx * s : min;
        n.x.z += d > 1e-4 ? dz * s : 0;
      }
    }
  }

  // Pose the skeleton from the points (sunk `sink` m into the floor at the end).
  apply() {
    const P = this.p;
    for (const D of this.drive) {
      const bone = P[D.i].bone;
      const parent = bone.parent;
      _a.subVectors(P[D.child].x, P[D.i].x).normalize();
      _q.setFromUnitVectors(D.d0, _a);
      if (D.s0) {
        _b.copy(D.s0).applyQuaternion(_q);
        _s.subVectors(P[D.side].x, P[D.i].x);
        _s.addScaledVector(_a, -_s.dot(_a));
        if (_s.lengthSq() > 1e-8) {
          _s.normalize();
          const angle = Math.atan2(_c.crossVectors(_b, _s).dot(_a), _b.dot(_s));
          _q.premultiply(_r.setFromAxisAngle(_a, angle));
        }
      }
      _q.multiply(D.q0);
      parent.matrixWorld.decompose(_pos, _pq, _scl);
      bone.quaternion.copy(_pq.invert().multiply(_q));
      if (D.i === this.root) {
        _a.copy(P[D.i].x);
        _a.y -= this.sink;
        bone.position.copy(parent.worldToLocal(_a));
      }
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
      for (const c of D.riders) c.updateMatrixWorld(true);
    }
  }

  // Where the body lies (its hips), for whoever wants to know.
  get centre() {
    return this.p[this.root].x;
  }
}
