import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { buildBrute, buildArchfiend } from './EnemyModels.js';
import { angleDelta, rand } from '../core/rng.js';
import { C, burst, ring } from '../world/Particles.js';

// Floor 10: Gorvath, the Flame-Horned (the burning-horned demon of the
// reference art, grown huge). Floor 20: Azrakel, the Winged Archfiend (the
// winged demon with the torch staff standing behind it).
//
// Bosses skip the attack-token system and pick from a phase-dependent move
// list, never repeating a move three times in a row.

export const BOSS_TYPES = {
  gorvath: {
    name: 'Gorvath, the Flame-Horned',
    build: buildBrute,
    buildOptions: { boss: true },
    scale: 1.9,
    hp: 1500,
    dmg: 24,
    speed: 3.1,
    radius: 1.15,
    poise: 380,
    mass: 12,
    role: 'boss',
    cooldown: 0.9,
    turnRate: 2.6,
    stride: 0.9,
    loot: { potion: 1, weapon: 1, spell: 1 },
    summons: [
      { at: 0.66, spawn: ['ghoul', 'ghoul', 'ghoul', 'ghoul'] },
      { at: 0.33, spawn: ['ghoul', 'ghoul', 'fiend', 'ghoul', 'ghoul'] },
    ],
    attacks: [
      { name: 'slam', windup: 1.0, strike: 0.2, recover: 0.9, dmg: 1, minRange: 0, maxRange: 4.2, volume: { c: [0, 0.8, 1.7], h: [0.6, 1.0, 1.1] }, lunge: 2, knockback: 7, aoe: { at: [0, 2.0], radius: 4.5, dmg: 0.5 }, weight: 3 },
      { name: 'sweep', windup: 0.75, strike: 0.22, recover: 0.8, dmg: 0.85, minRange: 0, maxRange: 4.0, volume: { c: [0, 1.0, 1.3], h: [1.7, 0.7, 1.1] }, knockback: 12, weight: 3 },
      { name: 'charge', windup: 0.85, strike: 1.0, recover: 1.1, dmg: 1.2, minRange: 6, maxRange: 40, volume: { c: [0, 0.9, 0.9], h: [0.7, 0.9, 0.6] }, lunge: 14, knockback: 14, weight: 2 },
      { name: 'stomp', windup: 0.6, strike: 0.2, recover: 0.8, dmg: 0.7, minRange: 0, maxRange: 3.5, volume: null, aoe: { at: [0, 0], radius: 5, dmg: 0.7 }, weight: 1, behind: true },
    ],
  },
  azrakel: {
    name: 'Azrakel, the Winged Archfiend',
    build: buildArchfiend,
    scale: 1.45,
    hp: 3600,
    dmg: 26,
    speed: 3.3,
    radius: 1.25,
    poise: 650,
    mass: 15,
    role: 'boss',
    cooldown: 0.85,
    turnRate: 3,
    stride: 0.8,
    loot: { potion: 1, weapon: 0, spell: 0 },
    summons: [
      { at: 0.7, spawn: ['fiend', 'ghoul', 'ghoul', 'ghoul'] },
      { at: 0.4, spawn: ['fiend', 'fiend', 'brute', 'ghoul', 'ghoul'] },
    ],
    attacks: [
      { name: 'sweep', windup: 0.8, strike: 0.24, recover: 0.8, dmg: 1, minRange: 0, maxRange: 5, volume: { c: [0, 1.4, 1.8], h: [2.2, 1.0, 1.6] }, knockback: 10, weight: 3 },
      { name: 'volley', windup: 0.7, strike: 0.6, recover: 0.7, dmg: 0.6, minRange: 4, maxRange: 60, volume: null, weight: 3 },
      { name: 'gust', windup: 0.6, strike: 0.3, recover: 0.7, dmg: 0.35, minRange: 0, maxRange: 4.5, volume: { c: [0, 1.5, 3], h: [2.5, 1.5, 3] }, knockback: 16, weight: 2 },
      { name: 'leap', windup: 0.6, strike: 1.2, recover: 0.9, dmg: 1.2, minRange: 7, maxRange: 60, volume: null, aoe: { at: [0, 0], radius: 4, dmg: 1 }, weight: 2 },
      { name: 'rain', windup: 0.9, strike: 0.4, recover: 0.8, dmg: 0.65, minRange: 0, maxRange: 60, volume: null, weight: 3, minPhase: 3 },
    ],
  },
};

const tmp = new THREE.Vector3();

export class Boss extends Enemy {
  constructor(key, spawn, tuning) {
    super(key, spawn, tuning, BOSS_TYPES[key]);
    this.bossKey = key;
    this.isBoss = true;
    this.name = this.type.name;
    this.phase = 1;
    this.summonIndex = 0;
    this.lastMoves = [];
    this.flap = 0;
    // Lives in the scene, not under the rig, so removing the corpse never
    // changes the light count (which would recompile every shader).
    this.light = new THREE.PointLight(0xff5a1e, 6, 16, 1.6);
    this.lightHeight = key === 'azrakel' ? 3.6 : 2.6;
    this.yaw = Math.PI;
  }

  isEngaged() {
    return this.alive && this.state !== 'dormant' && this.state !== 'dying';
  }

  update(dt, ctx) {
    this.flap = Math.max(0, this.flap - dt * 1.5);
    if (this.alive) this._checkPhase(ctx);
    if (this.alive) this.light.intensity = 5 + Math.sin(ctx.time * 7) * 1.5 + (this.phase - 1) * 2;
    super.update(dt, ctx);
    this.light.position.set(this.position.x, this.root.position.y + this.lightHeight, this.position.z);
  }

  _checkPhase(ctx) {
    const frac = this.health / this.maxHealth;
    const next = this.bossKey === 'azrakel' ? (frac < 0.25 ? 3 : frac < 0.6 ? 2 : 1) : frac < 0.5 ? 2 : 1;
    if (next > this.phase) {
      this.phase = next;
      for (const e of this.emitters) e.rate *= 1.6;
      ctx.announce?.(this.bossKey === 'azrakel' ? (next === 3 ? 'Azrakel’s heart erupts!' : 'Azrakel takes to the air!') : 'Gorvath’s horns blaze!');
      ctx.shake?.(0.5);
      ctx.audio?.roar(this.position);
    }
    const s = this.type.summons[this.summonIndex];
    if (s && frac <= s.at) {
      this.summonIndex++;
      this._summon(ctx, s.spawn);
    }
  }

  _summon(ctx, list) {
    ctx.announce?.(`${this.name.split(',')[0]} calls the damned!`);
    ctx.audio?.roar(this.position);
    const p = ctx.player.position;
    list.forEach((type, i) => {
      // Rise from the ground at a ring around the player, out of reach.
      for (let tries = 0; tries < 12; tries++) {
        const a = (i / list.length) * Math.PI * 2 + rand(-0.4, 0.4);
        const r = rand(6, 10);
        const x = p.x + Math.sin(a) * r;
        const z = p.z + Math.cos(a) * r;
        if (!ctx.nav.isWalkable(ctx.nav.tileX(x), ctx.nav.tileZ(z))) continue;
        ctx.spawnEnemy(type, { x, z, burrowed: true }, true);
        break;
      }
    });
  }

  _considerAttack(dt, ctx, dist) {
    const player = ctx.player;
    if (player.dead || this.cooldown > 0) return;
    const behind = Math.abs(angleDelta(this.yaw, Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z))) > 1.6;
    const moves = this.type.attacks.filter((a) => {
      if (dist < a.minRange || dist > a.maxRange) return false;
      if (a.minPhase && this.phase < a.minPhase) return false;
      if (a.behind && !behind) return false;
      if (this.lastMoves.length >= 2 && this.lastMoves.every((m) => m === a.name)) return false;
      return true;
    });
    if (!moves.length) return;
    if (!behind && Math.abs(angleDelta(this.yaw, Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z))) > 0.6) return;
    let total = moves.reduce((s, a) => s + (a.weight || 1), 0);
    let roll = Math.random() * total;
    let pick = moves[0];
    for (const a of moves) {
      roll -= a.weight || 1;
      if (roll <= 0) {
        pick = a;
        break;
      }
    }
    this.lastMoves.push(pick.name);
    if (this.lastMoves.length > 2) this.lastMoves.shift();
    const phaseScale = this.phase === 1 ? 1 : this.phase === 2 ? 0.8 : 0.68;
    this._startAttack(pick, ctx, phaseScale);
    if (pick.name === 'leap') this.flap = 1;
  }

  _beginStrike(ctx) {
    super._beginStrike(ctx);
    const a = this.attack;
    const p = ctx.player.position;
    if (a.name === 'leap') {
      this.leapFrom = this.position.clone();
      // Land on where the player is now, announced by a ring.
      this.leapTo = new THREE.Vector3(p.x, 0, p.z);
      ctx.effects.telegraph(p.x, p.z, a.aoe.radius, a.strike, null);
      this.flap = 1;
    } else if (a.name === 'volley') {
      this.volleyLeft = this.phase === 1 ? 3 : this.phase === 2 ? 5 : 7;
      this.volleyT = 0;
    } else if (a.name === 'rain') {
      const n = 9 + this.phase * 2;
      for (let i = 0; i < n; i++) {
        const r = i === 0 ? 0 : rand(1.5, 8);
        const ang = rand(0, Math.PI * 2);
        const x = p.x + Math.sin(ang) * r;
        const z = p.z + Math.cos(ang) * r;
        if (!ctx.nav.isWalkable(ctx.nav.tileX(x), ctx.nav.tileZ(z))) continue;
        ctx.effects.fireStrike(x, z, 1.7, 0.9 + i * 0.12, this.damage * a.dmg, ctx);
      }
    } else if (a.name === 'gust') {
      this.flap = 1;
    }
  }

  _updateStrike(dt, ctx) {
    const a = this.attack;
    if (a.name === 'leap') {
      const k = Math.min(1, this.stateT / this.stateDur);
      this.position.x = this.leapFrom.x + (this.leapTo.x - this.leapFrom.x) * k;
      this.position.z = this.leapFrom.z + (this.leapTo.z - this.leapFrom.z) * k;
      this.root.position.y = Math.sin(k * Math.PI) * 7;
      this.flap = 1;
      if (k >= 1) {
        this.root.position.y = 0;
        ctx.world.resolve(this.position, this.radius);
        this._impact(ctx, a.aoe);
        this.setState('recover', a.recover);
      }
      return;
    }
    if (a.name === 'volley') {
      this.volleyT -= dt;
      if (this.volleyLeft > 0 && this.volleyT <= 0) {
        this.volleyLeft--;
        this.volleyT = 0.11;
        this.model.j.staffTip.getWorldPosition(tmp);
        const target = ctx.player.position.clone();
        target.y = 1.2;
        target.x += rand(-1.5, 1.5);
        target.z += rand(-1.5, 1.5);
        ctx.effects.fireball(tmp, target.sub(tmp), 12 + this.phase * 1.5, this.damage * a.dmg);
        ctx.audio?.fireball(tmp);
      }
    }
    if (a.name === 'charge') {
      // Crashing into a wall stuns him: the reward for dodging the charge.
      const f = a.lunge * dt;
      const before = this.position.clone();
      const hit = ctx.world.move(this.position, this.radius, Math.sin(this.yaw) * f, Math.cos(this.yaw) * f);
      const moved = before.distanceTo(this.position);
      if (hit && moved < f * 0.5) {
        ctx.shake?.(0.6);
        ctx.audio?.slam(this.position);
        burst(ctx.fx.alpha, tmp.set(this.position.x, 1.5, this.position.z), { count: 30, speed: 4, color: C.smoke, colorEnd: C.smoke, size: 0.6, life: 1.2, gravity: -1 });
        ctx.announce?.('Gorvath is stunned!');
        this.interrupt(ctx, 2.2);
        return;
      }
      const saved = a.lunge;
      a.lunge = 0;
      super._updateStrike(dt, ctx);
      a.lunge = saved;
      return;
    }
    if (a.name === 'gust' && this.stateT < dt * 1.5) {
      ring(ctx.fx.alpha, tmp.set(this.position.x, 0.5, this.position.z), 4, { count: 40, color: C.smoke, colorEnd: C.smoke, size: 1.0, speed: 10, life: 0.7 });
    }
    super._updateStrike(dt, ctx);
  }

  takeHit(amount, dir, knockback, stagger, ctx) {
    // Bosses barely budge.
    return super.takeHit(amount, dir, knockback * 0.15, stagger, ctx);
  }

  die(ctx) {
    super.die(ctx);
    ring(ctx.fx.add, tmp.set(this.position.x, 0.5, this.position.z), 8, { count: 120, speed: 14, size: 0.9, life: 1.2 });
    ctx.shake?.(1);
  }

  _updateDying(dt, ctx) {
    super._updateDying(dt, ctx);
    this.light.intensity *= Math.max(0, 1 - dt * 2);
  }
}
