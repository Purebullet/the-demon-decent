import { Vector3 } from 'three';
import { OBB } from './OBB.js';

// A hurtbox is an OBB glued to one bone/group of a character mesh. It follows
// the animated part every frame, so a blade only connects where the mesh
// actually is: duck under a swing, or catch a ghoul's head for a critical.
export class Hurtbox {
  constructor(object, center, half, { name = 'body', multiplier = 1 } = {}) {
    this.object = object;
    this.localCenter = new Vector3().copy(center);
    this.localHalf = new Vector3().copy(half);
    this.name = name;
    this.multiplier = multiplier;
    this.obb = new OBB();
  }

  update() {
    this.obb.setFromMatrix(this.localCenter, this.localHalf, this.object.matrixWorld);
  }
}

// A hurtbox that follows a bone's position but keeps the character's own
// orientation. Rigs from different generators use different bone axes, so
// orienting by the root keeps box sizes meaningful on any skeleton.
// `offset` and `half` are in the frame's local units (scaled with it).
export class AnchoredHurtbox {
  constructor(anchor, frame, offset, half, { name = 'body', multiplier = 1 } = {}) {
    this.anchor = anchor;
    this.frame = frame;
    this.offset = new Vector3().copy(offset);
    this.localHalf = new Vector3().copy(half);
    this.name = name;
    this.multiplier = multiplier;
    this.obb = new OBB();
    this._axes = [new Vector3(), new Vector3(), new Vector3()];
    this._p = new Vector3();
    this._h = new Vector3();
  }

  update() {
    const e = this.frame.matrixWorld.elements;
    const [ax, ay, az] = this._axes;
    ax.set(e[0], e[1], e[2]);
    ay.set(e[4], e[5], e[6]);
    az.set(e[8], e[9], e[10]);
    const sx = ax.length() || 1;
    const sy = ay.length() || 1;
    const sz = az.length() || 1;
    ax.divideScalar(sx);
    ay.divideScalar(sy);
    az.divideScalar(sz);
    this.anchor.getWorldPosition(this._p);
    this._p.addScaledVector(ax, this.offset.x * sx).addScaledVector(ay, this.offset.y * sy).addScaledVector(az, this.offset.z * sz);
    this._h.set(this.localHalf.x * sx, this.localHalf.y * sy, this.localHalf.z * sz);
    this.obb.set(this._p, ax, ay, az, this._h);
  }
}

// An attack volume defined in an attacker's local space (e.g. the sweep of a
// claw in front of a ghoul). Active only during strike frames.
export class StrikeVolume {
  constructor(object, center, half) {
    this.object = object;
    this.localCenter = new Vector3().copy(center);
    this.localHalf = new Vector3().copy(half);
    this.obb = new OBB();
  }

  update() {
    this.obb.setFromMatrix(this.localCenter, this.localHalf, this.object.matrixWorld);
    return this.obb;
  }
}

// Test one OBB (a weapon blade at some point of its swing) against every
// target's hurtboxes. Each target is hit at most once per swing (hitSet), and
// if several parts overlap the part with the highest multiplier wins.
//
// With `seg` (the blade's centre line, { a, b }), the hit's point is where the
// blade actually meets the body: the point on the line nearest the part's
// centre, pulled into the part. Without it, the part's centre.
//
// targets: iterable of { position: Vector3, hitRadius: number, hurtboxes: Hurtbox[], alive }
const _ab = new Vector3();
const _p = new Vector3();
export function contactPoint(seg, obb, out) {
  _ab.subVectors(seg.b, seg.a);
  const t = Math.max(0, Math.min(1, _p.subVectors(obb.center, seg.a).dot(_ab) / Math.max(1e-8, _ab.lengthSq())));
  _p.copy(seg.a).addScaledVector(_ab, t);
  return obb.closestPoint(_p, out);
}

export function queryHurtboxes(obb, targets, hitSet, out = [], seg = null) {
  const reach = obb.boundingRadius();
  for (const target of targets) {
    if (!target.alive || hitSet.has(target)) continue;
    // Broad phase: bounding spheres.
    const r = reach + target.hitRadius;
    const dx = target.position.x - obb.center.x;
    const dz = target.position.z - obb.center.z;
    if (dx * dx + dz * dz > r * r) continue;

    let best = null;
    for (const hb of target.hurtboxes) {
      if (obb.intersectsOBB(hb.obb) && (!best || hb.multiplier > best.multiplier)) best = hb;
    }
    if (best) {
      hitSet.add(target);
      out.push({ target, part: best, point: seg ? contactPoint(seg, best.obb, new Vector3()) : best.obb.center.clone() });
    }
  }
  return out;
}
