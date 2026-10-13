import { Vector3 } from 'three';

// Coordinates the horde so it fights like a group instead of a queue.
//
//  - Attack tokens: only `attackers` enemies may commit to a swing at once, so
//    early floors stay readable. Deep floors hand out more tokens.
//  - Roles: the nearest enemies engage head-on; the rest are sent to flank
//    slots behind and beside the player, routed by A* with a penalty on tiles
//    inside the player's view cone, so they come around pillars instead of
//    walking into the blade.
//  - Swarm (floors 11+): ghoul packs take evenly spaced slots on a ring around
//    the player and, once enough have closed in, lunge in a rapid sequence.

const tmp = new Vector3();

export class AIDirector {
  constructor(nav, tuning) {
    this.nav = nav;
    this.tuning = tuning;
    this.maxTokens = tuning.attackers;
    this.tokens = new Set();
    this.timer = 0;
    this.packCooldown = 3;
    this.viewPenalty = new Float32Array(nav.cols * nav.rows);
    this.occupancy = new Float32Array(nav.cols * nav.rows);
    // Bound once so it can be handed to A* without allocating per query.
    this.flankPenalty = (i) => this.viewPenalty[i] + this.occupancy[i];
    this.crowdPenalty = (i) => this.occupancy[i];
  }

  requestToken(enemy) {
    if (this.tokens.has(enemy)) return true;
    if (this.tokens.size >= this.maxTokens) return false;
    this.tokens.add(enemy);
    return true;
  }

  releaseToken(enemy) {
    this.tokens.delete(enemy);
  }

  update(dt, enemies, player) {
    for (const e of this.tokens) if (!e.alive || !e.isEngaged()) this.tokens.delete(e);
    this.packCooldown -= dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;

    const active = enemies.filter((e) => e.alive && e.isEngaged() && !e.isBoss);
    this._paintFields(active, player);
    if (!active.length) return;

    const px = player.position.x;
    const pz = player.position.z;
    for (const e of active) e._distSq = (e.position.x - px) ** 2 + (e.position.z - pz) ** 2;
    active.sort((a, b) => a._distSq - b._distSq);

    const fwdX = -Math.sin(player.yaw);
    const fwdZ = -Math.cos(player.yaw);
    const swarm = this.tuning.swarm;
    const engageCount = Math.max(1, Math.ceil(this.maxTokens * 0.6));

    // Ring slots for the pack, starting behind the player.
    const pack = swarm ? active.filter((e) => e.type.swarmer) : [];
    const ringR = 2.7;
    if (pack.length) {
      const base = Math.atan2(-fwdX, -fwdZ);
      const slots = pack.map((_, i) => base + (i / pack.length) * Math.PI * 2);
      // Greedy angular assignment so pack members do not cross paths.
      const free = slots.slice();
      for (const e of pack) {
        const a = Math.atan2(e.position.x - px, e.position.z - pz);
        let best = 0;
        let bestD = Infinity;
        free.forEach((s, i) => {
          const d = Math.abs(Math.atan2(Math.sin(s - a), Math.cos(s - a)));
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        const s = free.splice(best, 1)[0];
        this._setSlot(e, px + Math.sin(s) * ringR, pz + Math.cos(s) * ringR);
        e.role = 'surround';
      }
      // Synchronized lunge once the ring has closed.
      const closed = pack.filter((e) => e._distSq < 4.5 * 4.5);
      if (this.packCooldown <= 0 && closed.length >= 3) {
        this.packCooldown = 4.5 * this.tuning.cooldown;
        closed.forEach((e, i) => e.orderLunge(i * 0.18));
      }
    }

    let flankSide = 1;
    let engaged = 0;
    for (const e of active) {
      if (e.role === 'surround' && pack.includes(e)) continue;
      if (e.type.keepAway) {
        // Casters keep their own distance (Enemy._locomote).
        e.role = 'engage';
        continue;
      }
      if (engaged < engageCount || e._distSq < 3.2 * 3.2 || e.type.role === 'bruiser') {
        e.role = 'engage';
        engaged++;
        continue;
      }
      // Flank: a point behind-left or behind-right of where the player looks.
      e.role = 'flank';
      const ang = Math.atan2(-fwdX, -fwdZ) + flankSide * (0.6 + Math.random() * 0.5);
      flankSide = -flankSide;
      const r = 3.2;
      this._setSlot(e, px + Math.sin(ang) * r, pz + Math.cos(ang) * r);
    }
  }

  _setSlot(e, x, z) {
    // Keep slots on walkable ground.
    const nav = this.nav;
    let c = nav.tileX(x);
    let r = nav.tileZ(z);
    if (!nav.isWalkable(c, r)) {
      const n = nav.nearestWalkable(c, r, 3);
      if (n) {
        c = n.c;
        r = n.r;
        x = nav.centerX(c);
        z = nav.centerZ(r);
      }
    }
    e.slot.set(x, 0, z);
  }

  // Penalty fields consumed by A*: tiles the player is looking at (so
  // flankers route around) and tiles crowded by other enemies (so a group
  // spreads over parallel corridors instead of single-filing).
  _paintFields(active, player) {
    const nav = this.nav;
    const vp = this.viewPenalty;
    const occ = this.occupancy;
    vp.fill(0);
    occ.fill(0);
    const px = player.position.x;
    const pz = player.position.z;
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    const pc = nav.tileX(px);
    const pr = nav.tileZ(pz);
    const R = 6;
    for (let r = pr - R; r <= pr + R; r++) {
      for (let c = pc - R; c <= pc + R; c++) {
        if (!nav.isWalkable(c, r)) continue;
        const dx = nav.centerX(c) - px;
        const dz = nav.centerZ(r) - pz;
        const d = Math.hypot(dx, dz);
        if (d < 1.5 || d > R * nav.tileSize) continue;
        const dot = (dx * fx + dz * fz) / d;
        if (dot > 0.35) vp[r * nav.cols + c] = 6 * dot;
      }
    }
    for (const e of active) {
      tmp.copy(e.position);
      const c = nav.tileX(tmp.x);
      const r = nav.tileZ(tmp.z);
      if (nav.inBounds(c, r)) occ[r * nav.cols + c] += 1.5;
    }
  }
}
