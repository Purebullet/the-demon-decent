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
// targets: iterable of { position: Vector3, hitRadius: number, hurtboxes: Hurtbox[], alive }
export function queryHurtboxes(obb, targets, hitSet, out = []) {
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
      out.push({ target, part: best, point: best.obb.center.clone() });
    }
  }
  return out;
}
