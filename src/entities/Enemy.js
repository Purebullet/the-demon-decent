import * as THREE from 'three';
import { StrikeVolume } from '../physics/Hitbox.js';
import { ENEMY_TYPES } from './EnemyTypes.js';
import { C, burst, ring } from '../world/Particles.js';
import { angleDelta, rand } from '../core/rng.js';
import { buildGltfCharacter } from './GltfCharacter.js';
import { FLAMES } from './poses.js';
import { SUNDER_MAX, SUNDER_TIME, sunderDamage, GUARD_BROKEN } from '../combat/Styles.js';
import { runeCircleTexture } from '../world/Textures.js';

const WHITE = new THREE.Color(1, 0.86, 0.72);
const TELL = new THREE.Color(1, 0.22, 0.04);
const ICE = new THREE.Color(0.45, 0.8, 1);
const BROKEN = new THREE.Color(1, 0.55, 0.1);
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
const DORMANT = new Set(['dormant', 'burrowed', 'emerging', 'dying']);

// Every demon is tougher and hits harder than its base stats, and winds up
// longer: a fight is about reading a blow and answering it (a counter-hit
// in the windup, a block, a dodge), not trading hits.
const HP_SCALE = 1.3;
const BOSS_HP_SCALE = 1.15;
const DAMAGE_SCALE = 1.8;
const WINDUP_SCALE = 1.35;
// The answer to a blow on a raised guard comes quicker than a normal attack.
const RIPOSTE = 0.55;
// How long a guard takes to come up, and the arc it covers (cos of half-angle).
const GUARD_RAISE = 0.1;
const GUARD_FRONT = 0.35;
// Damage taken while frozen, and while a guard lies broken.
const FROZEN_TAKEN = 1.6;
const BROKEN_TAKEN = 1.5;

// One demon. Runs a small state machine:
//
//   burrowed -> emerging -> chase                    (ambushers, floors 11+)
//   dormant  -> chase <-> windup -> strike -> recover -> chase
//                 ^                                   |
//                 +------------- stagger <------------+ (poise broken)
//   any -> dying
//
// Movement in `chase` follows A* paths from the PathService toward a goal
// picked by the AIDirector role (engage / flank / surround), falling back to
// direct steering when there is clear line of sight.
export class Enemy {
  constructor(typeKey, spawn, tuning, type = ENEMY_TYPES[typeKey]) {
    this.typeKey = typeKey;
    this.type = type;
    this.tuning = tuning;
    // The AI-generated model (a plain block until its GLB exists).
    this.model = buildGltfCharacter(type.asset, type.scale || 1);
    this.root = this.model.root;
    if (type.scale) this.root.scale.setScalar(type.scale);
    this.position = this.root.position;
    this.position.set(spawn.x, 0, spawn.z);
    this.yaw = rand(0, Math.PI * 2);
    this.radius = type.radius;
    this.hitRadius = this.model.hitRadius * (type.scale || 1);
    this.hurtboxes = this.model.hurtboxes;
    this.maxHealth = Math.round(type.hp * tuning.hp * (type.role === 'boss' ? BOSS_HP_SCALE : HP_SCALE));
    this.health = this.maxHealth;
    this.damage = type.dmg * tuning.dmg * DAMAGE_SCALE;
    this.speed = type.speed * tuning.speed;
    this.alive = true;
    this.removed = false;
    this.isBoss = false;
    this.state = 'dormant';
    this.stateT = 0;
    this.stateDur = 0;
    this.role = 'engage';
    this.slot = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.path = null;
    this.pathIndex = 0;
    this.repathT = rand(0, 0.4);
    this.pathGoal = new THREE.Vector3(1e9, 0, 1e9);
    this.vel = new THREE.Vector3();
    this.knock = new THREE.Vector3();
    this.cooldown = rand(0.4, 1.4);
    this.attack = null;
    this.hitPlayer = false;
    this.aoeDone = false;
    this.poise = 0;
    this.flash = 0;
    this.moveBlend = 0;
    this.walkPhase = rand(0, 10);
    this.seed = rand(0, 100);
    this.lungeDelay = -1;
    // Guard, wounds and weapon marks.
    this.guardCd = rand(0.5, 2);
    this.guardPending = -1;
    this.status = {};
    this.statusTick = 0;
    this.sunder = 0;
    this.sunderT = 0;
    this.brokenT = 0;
    this.stumbling = false;
    this.ward = null;
    this.tint = 0;
    this.strike = new StrikeVolume(this.root, new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    this.emitters = [];
    this.baseEmissive = this.model.mats.map((m) => ({ c: m.emissive.clone(), i: m.emissiveIntensity }));
    this.root.traverse((o) => {
      if (o.isMesh) o.userData.enemy = this;
    });
    if (spawn.burrowed) {
      this.state = 'burrowed';
      this.root.position.y = -2.4;
      this.root.visible = false;
    }
    this.root.rotation.y = this.yaw;
  }

  attachFx(fx) {
    for (const f of this.model.fire) {
      const e = fx.add.addEmitter(f.anchor, f.rate, f.spawn, f.offset);
      e.active = this.state !== 'burrowed';
      this.emitters.push(e);
    }
    if (this.elite) {
      const e = fx.add.addEmitter(this.root, 16, FLAMES.ember, new THREE.Vector3(0, (this.model.height || 1.6) * 0.5, 0));
      e.active = this.state !== 'burrowed';
      this.emitters.push(e);
    }
  }

  // An elite: larger, far tougher, harder-hitting, smouldering red and
  // shedding embers, and it carries a relic.
  makeElite() {
    this.elite = true;
    this.maxHealth = this.health = Math.round(this.maxHealth * 2.1);
    this.damage *= 1.25;
    this.root.scale.multiplyScalar(1.12);
    this.radius *= 1.1;
    this.hitRadius *= 1.12;
    this.type = { ...this.type, poise: this.type.poise * 1.6, name: `Elite ${this.type.name}` };
    const red = new THREE.Color(0.6, 0.05, 0.02);
    this.baseEmissive = this.baseEmissive.map((b) => ({ c: b.c.clone().lerp(red, 0.4), i: b.i + 0.12 }));
    this._tinted = true;
  }

  // Burst out of the ground (ambushers, and summons called by bosses).
  emerge(ctx) {
    this.setState('emerging', 0.9);
    this.root.visible = true;
    for (const e of this.emitters) e.active = true;
    burst(ctx.fx.alpha, tmpV.set(this.position.x, 0.2, this.position.z), { count: 30, speed: 3, color: C.smoke, colorEnd: C.smoke, size: 0.5, life: 1.2, gravity: -2 });
    ctx.audio?.growl(this.typeKey, this.position);
    ctx.shake?.(0.15);
  }

  isEngaged() {
    return this.alive && !DORMANT.has(this.state);
  }

  setState(s, dur = 0) {
    this.state = s;
    this.stateT = 0;
    this.stateDur = dur;
  }

  onPath(path) {
    this.path = path;
    this.pathIndex = 0;
  }

  orderLunge(delay) {
    if (this.state === 'chase' && this.lungeDelay < 0) this.lungeDelay = delay;
  }

  becomeAlert(ctx, propagate = true) {
    if (this.state !== 'dormant') return;
    this.setState('chase');
    ctx.audio?.growl(this.typeKey, this.position);
    if (!propagate) return;
    // Hunting packs: one sighting wakes everything nearby.
    const r = ctx.tuning.swarm ? 16 : 9;
    for (const o of ctx.enemies) {
      if (o !== this && o.state === 'dormant' && o.position.distanceTo(this.position) < r) {
        o.becomeAlert(ctx, false);
      }
    }
  }

  // ------------------------------------------------------------- update ---

  update(dt, ctx) {
    const player = ctx.player;
    this.stateT += dt;
    this.flash = Math.max(0, this.flash - dt * 9);
    this.cooldown -= dt;
    this.poise = Math.max(0, this.poise - dt * this.type.poise * 0.3);
    const dx = player.position.x - this.position.x;
    const dz = player.position.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    this.distToPlayer = dist;
    if (this.alive) this._updateMarks(dt, ctx);
    if (this.guardPending >= 0) {
      this.guardPending -= dt;
      if (this.guardPending < 0 && (this.state === 'chase' || this.state === 'recover')) this.raiseGuard(ctx);
    }

    switch (this.state) {
      case 'dying':
        this._updateDying(dt, ctx);
        return;
      case 'burrowed':
        if (dist < 6.5 && !player.dead) this.emerge(ctx);
        return;
      case 'emerging': {
        const k = Math.min(1, this.stateT / this.stateDur);
        this.root.position.y = -2.4 * (1 - k) * (1 - k);
        this.yaw = Math.atan2(dx, dz);
        if (k >= 1) {
          this.root.position.y = 0;
          this.setState('chase');
          this.cooldown = 0.2;
        }
        break;
      }
      case 'dormant':
        if (!player.dead && (dist < 3.5 || (dist < ctx.tuning.aggro && this._canSee(ctx, player)))) this.becomeAlert(ctx);
        this.moveBlend = Math.max(0, this.moveBlend - dt * 4);
        break;
      case 'chase':
        this._locomote(dt, ctx, dist);
        this._considerAttack(dt, ctx, dist);
        break;
      case 'windup': {
        // Track the player while telegraphing; deep floors track harder.
        this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate * 0.8 * this.tuning.speed);
        this.moveBlend = Math.max(0, this.moveBlend - dt * 6);
        if (this.stateT >= this.stateDur) this._beginStrike(ctx);
        break;
      }
      case 'strike':
        this._updateStrike(dt, ctx);
        break;
      case 'recover':
        this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate * 0.3);
        if (this.stateT >= this.stateDur) this._endAttack(ctx);
        break;
      case 'stagger':
        if (this.stateT >= this.stateDur) {
          this.stumbling = false;
          this.setState('chase');
        }
        break;
      case 'frozen':
        // Locked in the ice mid-motion: no turning, no animation.
        if (this.stateT >= this.stateDur) this._thaw(ctx, false);
        return;
      case 'guard': {
        // Hold the guard toward the player, giving ground a little; when it
        // drops, answer at once if the player is in reach.
        this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate * 1.6);
        this.moveBlend = Math.max(0, this.moveBlend - dt * 6);
        if (dist < 2.2) ctx.world.move(this.position, this.radius, (-dx / (dist || 1)) * dt * 0.8, (-dz / (dist || 1)) * dt * 0.8);
        if (this.stateT >= this.stateDur) this._lowerGuard(ctx, dist);
        break;
      }
      default:
        break;
    }

    this._applyKnockback(dt, ctx);
    this.root.rotation.y = this.yaw;
  }

  // Called once per frame after all enemies moved (separation, animation,
  // hurtbox refresh).
  postUpdate(dt, ctx, time) {
    if (this.removed) return;
    this.model.animate(this, dt, time);
    this._applyTint(dt, ctx, time);
    if (this.ward) this._updateWard(dt, time);
    this.root.updateMatrixWorld(true);
    if (this.alive) for (const h of this.hurtboxes) h.update();
  }

  // Emissive tints, in order of importance: the white flash of a hit, the ice
  // of a freeze, the ember glow of a broken guard, and the red heat that
  // builds through a windup (the tell a counter-hit reads).
  _applyTint(dt, ctx, time) {
    let col = null;
    let k = 0;
    let boost = 1.3;
    const tells = ctx.tells || 1;
    if (this.state === 'frozen') {
      col = ICE;
      k = 0.75 + 0.1 * Math.sin(time * 6);
    } else if (this.state === 'windup' && this.alive) {
      const u = Math.min(1, this.stateT / Math.max(0.01, this.stateDur));
      col = TELL;
      k = Math.min(1, (0.25 + 0.75 * u * u) * 0.6 * tells) * (0.85 + 0.15 * Math.sin(time * 30));
    } else if (this.brokenT > 0 && this.alive) {
      col = BROKEN;
      k = 0.35 + 0.15 * Math.sin(time * 10);
    }
    if (this.flash > 0) {
      // The flash of a hit: a warm, quick, partial glare, not a white cut-out.
      col = col ? tmpC.copy(col).lerp(WHITE, this.flash * 0.7) : WHITE;
      k = Math.max(k, this.flash * 0.6);
      boost = 1;
    }
    if (!col && !this._tinted) return;
    this._tinted = !!col;
    this.model.mats.forEach((m, i) => {
      const b = this.baseEmissive[i];
      if (!col) {
        m.emissive.copy(b.c);
        m.emissiveIntensity = b.i;
        return;
      }
      m.emissive.copy(b.c).lerp(col, Math.min(1, k * 0.85));
      m.emissiveIntensity = b.i + k * boost;
    });
  }

  _updateWard(dt, time) {
    const w = this.ward;
    const on = this.state === 'guard' && this.alive;
    const raise = on ? Math.min(1, this.stateT / GUARD_RAISE) : 0;
    w.userData.k += ((on ? 1 : 0) - w.userData.k) * Math.min(1, dt * (on ? 18 : 6));
    this.wardFlash = Math.max(0, (this.wardFlash || 0) - dt * 4);
    const sh = w.userData.shatter || 0;
    w.userData.shatter = Math.max(0, sh - dt * 2.5);
    const k = w.userData.k;
    w.visible = k > 0.01 || sh > 0.01;
    if (!w.visible) return;
    w.material.opacity = Math.min(1, k * (0.55 + 0.25 * Math.sin(time * 9)) + this.wardFlash * 0.8 + sh * 0.6);
    w.rotation.z = time * 1.5;
    w.scale.setScalar(w.userData.size * (0.6 + 0.4 * raise + sh * 0.8));
  }

  _canSee(ctx, player) {
    return ctx.nav.hasLineOfSight(this.position.x, this.position.z, player.position.x, player.position.z);
  }

  _turnToward(target, dt, rate) {
    const d = angleDelta(this.yaw, target);
    const step = rate * dt;
    this.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  _goal(ctx, dist) {
    const p = ctx.player.position;
    if (this.role === 'flank' && dist > 2.6 && this.slot.distanceToSquared(this.position) > 1.0) return this.slot;
    if (this.role === 'surround' && dist > 1.0) return this.slot;
    return p;
  }

  _locomote(dt, ctx, dist) {
    const nav = ctx.nav;
    const goal = this._goal(ctx, dist);
    const px = this.position.x;
    const pz = this.position.z;
    let tx = goal.x;
    let tz = goal.z;

    const direct = nav.hasLineOfSight(px, pz, goal.x, goal.z, this.radius * 0.9, true);
    if (direct) {
      this.path = null;
    } else {
      this.repathT -= dt;
      const goalMoved = this.pathGoal.distanceToSquared(goal) > 2.25;
      if (this.repathT <= 0 || goalMoved || !this.path) {
        this.repathT = rand(0.4, 0.75);
        this.pathGoal.copy(goal);
        const penalty = this.role === 'flank' ? ctx.director.flankPenalty : ctx.director.crowdPenalty;
        ctx.pathService.request(this, goal.x, goal.z, { penalty });
      }
      if (this.path && this.pathIndex < this.path.length) {
        let wp = this.path[this.pathIndex];
        if ((wp.x - px) ** 2 + (wp.z - pz) ** 2 < 0.35 && this.pathIndex < this.path.length - 1) {
          this.pathIndex++;
          wp = this.path[this.pathIndex];
        }
        tx = wp.x;
        tz = wp.z;
      }
    }

    let vx = tx - px;
    let vz = tz - pz;
    const len = Math.hypot(vx, vz) || 1;
    vx /= len;
    vz /= len;
    let speed = this.speed;
    const engaging = goal === ctx.player.position;
    const keep = this.type.keepAway;
    if (keep) {
      // Casters hold a firing distance with a clear line, and back off when
      // the player closes in.
      const clear = dist < keep[1] && nav.hasLineOfSight(px, pz, ctx.player.position.x, ctx.player.position.z, 0.2);
      if (dist < keep[0]) {
        vx = (px - ctx.player.position.x) / (dist || 1);
        vz = (pz - ctx.player.position.z) / (dist || 1);
        speed *= 0.85;
      } else if (clear) {
        const side = this.seed > 50 ? 1 : -1;
        vx = (-(ctx.player.position.z - pz) / dist) * side;
        vz = ((ctx.player.position.x - px) / dist) * side;
        speed *= 0.25;
      }
    } else {
      const range = this.type.attacks[0].maxRange;
      if (engaging && dist < range * 0.6 + ctx.player.radius) speed = 0;
    }
    if (this.role === 'surround' && !engaging) {
      const toSlot = Math.hypot(this.slot.x - px, this.slot.z - pz);
      if (toSlot < 0.7) {
        // Hold the ring: circle-strafe around the player.
        const ox = px - ctx.player.position.x;
        const oz = pz - ctx.player.position.z;
        const ol = Math.hypot(ox, oz) || 1;
        const side = this.seed > 50 ? 1 : -1;
        vx = (-oz / ol) * side;
        vz = (ox / ol) * side;
        speed *= 0.35;
      }
    }

    // Separation from neighbours keeps packs from stacking.
    let sx = 0;
    let sz = 0;
    for (const o of ctx.enemies) {
      if (o === this || !o.alive || o.state === 'burrowed') continue;
      const ox = px - o.position.x;
      const oz = pz - o.position.z;
      const min = this.radius + o.radius + 0.35;
      const d2 = ox * ox + oz * oz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        sx += (ox / d) * (min - d);
        sz += (oz / d) * (min - d);
      }
    }
    const dvx = vx * speed + sx * 3;
    const dvz = vz * speed + sz * 3;
    const blend = 1 - Math.exp(-10 * dt);
    this.vel.x += (dvx - this.vel.x) * blend;
    this.vel.z += (dvz - this.vel.z) * blend;
    ctx.world.move(this.position, this.radius, this.vel.x * dt, this.vel.z * dt);

    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.moveBlend += (Math.min(1, sp / this.speed) - this.moveBlend) * Math.min(1, dt * 8);
    this.walkPhase += sp * dt * this.type.stride;
    // Casters keep their eyes (and staff) on the player while they reposition.
    const watch = dist < 5 || sp < 0.3 || (keep && dist < keep[1]);
    const face = watch ? Math.atan2(ctx.player.position.x - px, ctx.player.position.z - pz) : Math.atan2(this.vel.x, this.vel.z);
    this._turnToward(face, dt, this.type.turnRate * this.tuning.speed);
  }

  _considerAttack(dt, ctx, dist) {
    const player = ctx.player;
    if (player.dead) return;
    if (this.lungeDelay >= 0) {
      // Pack lunge ordered by the director: commit without waiting for a token.
      this.lungeDelay -= dt;
      if (this.lungeDelay < 0) {
        const a = this.type.attacks.find((x) => dist >= x.minRange && dist <= x.maxRange) || this.type.attacks[0];
        if (dist <= Math.max(...this.type.attacks.map((x) => x.maxRange))) this._startAttack(a, ctx, 0.75);
      }
      return;
    }
    // A sluggish, fumbled swing is an opening: every demon in reach takes it.
    const opening = player.exposed && dist <= this.type.attacks[0].maxRange + 0.6;
    if (opening) this.cooldown = Math.min(this.cooldown, 0.08);
    if (this.cooldown > 0) return;
    const options = this.type.attacks.filter((a) => dist >= a.minRange && dist <= a.maxRange);
    if (!options.length) return;
    // Needs to be roughly facing and have a clear line.
    if (Math.abs(angleDelta(this.yaw, Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z))) > 0.9) return;
    if (!ctx.nav.hasLineOfSight(this.position.x, this.position.z, player.position.x, player.position.z, 0.2)) return;
    // Casters pace themselves; attack tokens are for those who close in.
    if (!this.type.keepAway && !opening && !ctx.director.requestToken(this)) return;
    this._startAttack(options[Math.floor(Math.random() * options.length)], ctx);
  }

  _startAttack(a, ctx, windupScale = 1) {
    this.attack = a;
    this.hitPlayer = false;
    this.aoeDone = false;
    this.setState('windup', a.windup * this.tuning.windup * windupScale * WINDUP_SCALE);
    ctx.audio?.telegraph(this.typeKey, this.position);
  }

  _beginStrike(ctx) {
    const a = this.attack;
    this.setState('strike', a.strike);
    const v = a.volume;
    if (v) {
      this.strike.localCenter.set(v.c[0], v.c[1], v.c[2]);
      this.strike.localHalf.set(v.h[0], v.h[1], v.h[2]);
    }
    if (a.projectile) this._throw(ctx, a);
    else ctx.audio?.enemySwing(this.typeKey, this.position);
  }

  // Fireballs from the staff tip at the player's chest, fanned when several.
  _throw(ctx, a) {
    const p = a.projectile;
    const count = p.count + (ctx.tuning.swarm ? 2 : 0);
    const from = this.model.j.staffTip.getWorldPosition(new THREE.Vector3());
    const aim = ctx.player.position.clone();
    aim.y = 1.2;
    aim.sub(from);
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * p.spread;
      const dir = aim.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, off);
      ctx.effects.fireball(from, dir, p.speed * Math.sqrt(this.tuning.speed), this.damage * a.dmg, { homing: p.homing });
    }
    ctx.audio?.fireball(from);
  }

  _updateStrike(dt, ctx) {
    const a = this.attack;
    if (a.lunge) {
      const f = a.lunge * dt;
      ctx.world.move(this.position, this.radius, Math.sin(this.yaw) * f, Math.cos(this.yaw) * f);
      this.moveBlend = 1;
      this.walkPhase += dt * 8;
    }
    this.root.rotation.y = this.yaw;
    const player = ctx.player;
    if (a.volume && !this.hitPlayer) {
      this.root.updateMatrixWorld(true);
      if (player.overlapsOBB(this.strike.update())) {
        this.hitPlayer = true;
        player.takeDamage(this.damage * a.dmg, this.position, a.knockback, ctx);
      }
    }
    if (a.aoe && !this.aoeDone && this.stateT >= this.stateDur * 0.5) {
      this.aoeDone = true;
      this._impact(ctx, a.aoe);
    }
    if (this.stateT >= this.stateDur) {
      this.setState('recover', a.recover * Math.sqrt(this.tuning.windup));
    }
  }

  // Ground-slam shockwave around a point in front of the enemy.
  _impact(ctx, aoe) {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const scale = this.type.scale || 1;
    const x = this.position.x + (s * aoe.at[1] + c * aoe.at[0]) * scale;
    const z = this.position.z + (c * aoe.at[1] - s * aoe.at[0]) * scale;
    tmpV.set(x, 0.1, z);
    ring(ctx.fx.add, tmpV, aoe.radius, { count: 50, speed: aoe.radius * 2.6, size: 0.6 });
    burst(ctx.fx.alpha, tmpV, { count: 24, speed: 4, color: C.smoke, colorEnd: C.smoke, size: 0.6, life: 1, gravity: -1 });
    ctx.audio?.slam(tmpV);
    const p = ctx.player;
    const d = Math.hypot(p.position.x - x, p.position.z - z);
    ctx.shake?.(Math.max(0, 0.6 - d * 0.05));
    if (d < aoe.radius + p.radius && !this.hitPlayer) {
      p.takeDamage(this.damage * aoe.dmg, tmpV, 4, ctx);
    }
  }

  _endAttack(ctx) {
    ctx.director.releaseToken(this);
    this.attack = null;
    this.cooldown = this.type.cooldown * this.tuning.cooldown * rand(0.8, 1.25);
    this.setState('chase');
  }

  _applyKnockback(dt, ctx) {
    if (this.knock.lengthSq() < 1e-4) return;
    ctx.world.move(this.position, this.radius, this.knock.x * dt, this.knock.z * dt);
    this.knock.multiplyScalar(Math.exp(-7 * dt));
  }

  // ------------------------------------------------------------ damage ---

  // opts: { proc (a proc or wound, not a blow), heavy, contact (world point),
  //         sweep (blade travel direction, world), force (0..1+) }
  takeHit(amount, dir, knockback, stagger, ctx, opts = {}) {
    if (!this.alive || this.state === 'burrowed') return 0;
    amount *= this.damageTakenMul();
    if (this.state === 'frozen' && !opts.proc) {
      // The blow shatters the ice.
      this._thaw(ctx, true);
    }
    this.health -= amount;
    this.flash = opts.proc ? 0.5 : 1;
    this.lastHit = { x: dir.x, z: dir.z, knockback };
    // The body answers the angle and weight of the blow (GltfCharacter).
    if (!opts.proc || opts.force) this.model.react?.(this, dir, opts.contact, opts.sweep, opts.force ?? 0.5);
    const mass = this.type.mass || 1;
    this.knock.x += (dir.x * knockback) / mass;
    this.knock.z += (dir.z * knockback) / mass;
    if (this.health <= 0) {
      this.die(ctx);
      return amount;
    }
    if (this.state === 'dormant') this.becomeAlert(ctx);
    this.poise += stagger;
    const threshold = this.type.poise * (1 - 0.1 * this.sunder);
    if (this.poise >= threshold && this.state !== 'stagger' && this.state !== 'emerging' && this.state !== 'frozen') {
      this.poise = 0;
      this.interrupt(ctx, 0.7);
    } else if (!opts.proc && this.canGuard() && this.guardCd <= 0 && this.guardPending < 0 && this.state === 'chase' && Math.random() < this.type.guard.chance * 0.5) {
      // Stung, a guarding demon gets its guard up.
      this.guardPending = 0.18;
    }
    return amount;
  }

  // Sunder, frozen and a broken guard all open a demon up.
  damageTakenMul() {
    let m = sunderDamage(this.sunder);
    if (this.state === 'frozen') m *= FROZEN_TAKEN;
    if (this.brokenT > 0) m *= BROKEN_TAKEN;
    return m;
  }

  // ---------------------------------------------------- guard & clash ---

  canGuard() {
    return !!this.type.guard && this.alive;
  }

  // The player started a swing; a guarding demon that sees it coming may
  // raise its guard (after a moment to react: a fast enough blow beats it).
  onPlayerSwing(ctx, heavy) {
    if (!this.canGuard() || this.guardCd > 0 || this.guardPending >= 0) return;
    if (this.state !== 'chase' && this.state !== 'recover') return;
    if (this.distToPlayer > 3.6) return;
    const p = ctx.player.position;
    if (Math.abs(angleDelta(this.yaw, Math.atan2(p.x - this.position.x, p.z - this.position.z))) > 1.1) return;
    if (Math.random() < this.type.guard.chance * (heavy ? 1.3 : 1)) this.guardPending = 0.12;
  }

  raiseGuard(ctx) {
    const g = this.type.guard;
    ctx.director.releaseToken(this);
    this.attack = null;
    this.setState('guard', rand(g.dur[0], g.dur[1]));
    this.guardCd = g.cooldown;
    if (!this.ward) this.ward = makeWard(this);
    ctx.audio?.guardUp?.(this.position);
  }

  _lowerGuard(ctx, dist) {
    // Riposte if the player is still in reach.
    const a = this.type.attacks.find((x) => dist >= x.minRange && dist <= x.maxRange && !x.projectile);
    if (a && !ctx.player.dead) this._startAttack(a, ctx, RIPOSTE);
    else this.setState('chase');
  }

  // Is a blow from `from` (world point) caught on the guard?
  isGuardingAgainst(from) {
    if (this.state !== 'guard' || this.stateT < GUARD_RAISE) return false;
    const dx = from.x - this.position.x;
    const dz = from.z - this.position.z;
    const d = Math.hypot(dx, dz) || 1;
    return (Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dz) / d > GUARD_FRONT;
  }

  // A blow rang off the guard: hold it, then answer with a riposte.
  clash(ctx, at) {
    this.wardFlash = 1;
    this.flash = 0.4;
    burst(ctx.fx.add, at, { count: 26, speed: 6, color: C.spark, colorEnd: C.fireEdge, size: 0.07, life: 0.35 });
    const dist = this.distToPlayer;
    const a = this.type.attacks.find((x) => dist >= x.minRange && dist <= x.maxRange && !x.projectile);
    if (a) this._startAttack(a, ctx, RIPOSTE);
  }

  // An axe shatters the guard: the demon reels, wide open.
  guardBreak(ctx, at) {
    this.wardFlash = 1;
    if (this.ward) this.ward.userData.shatter = 1;
    burst(ctx.fx.add, at, { count: 50, speed: 8, color: C.fireCore, colorEnd: C.emberRed, size: 0.12, life: 0.6 });
    burst(ctx.fx.alpha, at, { count: 20, speed: 5, color: C.smoke, colorEnd: C.smoke, size: 0.3, life: 0.8, gravity: -2 });
    this.brokenT = GUARD_BROKEN + 1.2;
    this.interrupt(ctx, GUARD_BROKEN);
    this.guardCd = Math.max(this.guardCd, 4);
  }

  // A mace blow (or a charged one through a guard): a heavy stumble back.
  stumble(ctx, dur, dir) {
    if (!this.alive || this.state === 'emerging' || this.state === 'frozen') return;
    this.interrupt(ctx, dur);
    this.stumbling = true;
    const mass = this.type.mass || 1;
    this.knock.x += (dir.x * 6) / mass;
    this.knock.z += (dir.z * 6) / mass;
  }

  // ------------------------------------------------------ marks & ice ---

  // Wounds that keep hurting (bleed, burn), sunder stacks from an axe.
  addStatus(kind, { dps, dur }) {
    const s = this.status[kind];
    if (s) {
      s.dps = Math.max(s.dps, dps);
      s.t = Math.max(s.t, dur);
    } else this.status[kind] = { dps, t: dur };
  }

  applySunder(n, ctx) {
    this.sunder = Math.min(SUNDER_MAX, this.sunder + n);
    this.sunderT = SUNDER_TIME;
    burst(ctx.fx.add, tmpV.set(this.position.x, (this.model.height || 1.6) * 0.6 * (this.type.scale || 1), this.position.z), { count: 10 + n * 6, speed: 3, color: C.emberHot, colorEnd: C.emberRed, size: 0.08, life: 0.5 });
  }

  freeze(ctx, dur) {
    if (!this.alive || this.state === 'emerging' || this.state === 'burrowed') return;
    ctx.director.releaseToken(this);
    this.attack = null;
    this.lungeDelay = -1;
    this.setState('frozen', dur);
  }

  _thaw(ctx, shattered) {
    const p = tmpV.set(this.position.x, (this.model.height || 1.6) * 0.55 * (this.type.scale || 1), this.position.z);
    burst(ctx.fx.add, p, { count: shattered ? 46 : 16, speed: shattered ? 6 : 2, color: ICE, colorEnd: new THREE.Color(0.1, 0.3, 0.7), size: 0.14, life: 0.6, gravity: -8 });
    if (shattered) ctx.audio?.shatter?.(this.position);
    this.cooldown = Math.max(this.cooldown, 0.6);
    this.setState('chase');
  }

  _updateMarks(dt, ctx) {
    this.guardCd -= dt;
    this.brokenT = Math.max(0, this.brokenT - dt);
    if (this.sunder > 0) {
      this.sunderT -= dt;
      if (this.sunderT <= 0) this.sunder = 0;
    }
    if (this.state === 'frozen' && Math.random() < dt * 14) {
      const h = (this.model.height || 1.6) * (this.type.scale || 1);
      ctx.fx.add.emit({ x: this.position.x + rand(-0.4, 0.4), y: rand(0.2, h), z: this.position.z + rand(-0.4, 0.4), vy: -0.2, life: 0.6, size: 0.1, sizeEnd: 0.02, color: ICE, colorEnd: new THREE.Color(0.1, 0.3, 0.7), drag: 1 });
    }
    // Bleed and burn tick twice a second.
    this.statusTick -= dt;
    const tick = this.statusTick <= 0;
    if (tick) this.statusTick = 0.5;
    for (const [kind, st] of Object.entries(this.status)) {
      st.t -= dt;
      if (st.t <= 0) {
        delete this.status[kind];
        continue;
      }
      const h = (this.model.height || 1.6) * 0.6 * (this.type.scale || 1);
      if (kind === 'burn' && Math.random() < dt * 20) ctx.fx.add.emit({ x: this.position.x + rand(-0.3, 0.3), y: rand(0.3, h * 1.4), z: this.position.z + rand(-0.3, 0.3), vy: 1.6, life: 0.5, size: 0.3, sizeEnd: 0.05, color: C.fireCore, colorEnd: C.fireEdge, drag: 1.2 });
      if (kind === 'bleed' && Math.random() < dt * 8) ctx.fx.alpha.emit({ x: this.position.x + rand(-0.2, 0.2), y: h, z: this.position.z + rand(-0.2, 0.2), vx: rand(-0.5, 0.5), vy: 0.5, vz: rand(-0.5, 0.5), life: 0.8, size: 0.09, color: C.blood, colorEnd: C.bloodDark, gravity: -9 });
      if (tick && this.alive) {
        const dealt = this.takeHit(st.dps * 0.5, tmpV.set(0, 0, 0), 0, 0, ctx, { proc: true });
        ctx.onDamage?.(this, dealt, false, tmpV.set(this.position.x, h + 0.3, this.position.z), kind);
        if (!this.alive) return;
      }
    }
  }

  interrupt(ctx, dur) {
    if (this.state === 'frozen' || this.state === 'dying') return;
    ctx.director.releaseToken(this);
    this.attack = null;
    this.lungeDelay = -1;
    this.stumbling = false;
    this.cooldown = Math.max(this.cooldown, 0.4);
    this.setState('stagger', dur);
  }

  // Is the demon winding up a blow right now (a counter-hit window)?
  isWindingUp() {
    return this.state === 'windup';
  }

  die(ctx) {
    this.alive = false;
    this.health = 0;
    this.status = {};
    if (this.ward) this.ward.visible = false;
    ctx.director.releaseToken(this);
    ctx.pathService.cancel(this);
    this.attack = null;
    // A model with its own death clip is thrown along the killing blow, falls
    // and flops (see _updateDying), lies there for a while, then sinks.
    this.setState('dying', this.model.ownDeath ? CORPSE_TIME : 1.6);
    this.deathYaw = this.yaw;
    const hit = this.lastHit || { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw), knockback: 3 };
    const mass = this.isBoss ? 30 : this.type.mass || 1;
    const fling = (3 + hit.knockback * 0.5) / Math.sqrt(mass);
    this.rag = { vx: hit.x * fling, vz: hit.z * fling, vy: (this.isBoss ? 0 : 2.6) / Math.sqrt(mass), y: 0, landed: false };
    // Topple away from the blow: a body that falls backward turns its back
    // to the hit, one that falls forward faces along it.
    if (this.model.ownDeath && !this.isBoss && Math.hypot(hit.x, hit.z) > 0.1) {
      const along = Math.atan2(hit.x, hit.z);
      this.deathYaw = this.model.fallsForward ? along : along + Math.PI;
    }
    burst(ctx.fx.alpha, tmpV.set(this.position.x, 1, this.position.z), { count: 60, speed: 5, color: C.blood, colorEnd: C.bloodDark, size: 0.18, life: 1.1 });
    ctx.audio?.death(this.typeKey, this.position);
    ctx.audio?.kill?.();
    ctx.shake?.(this.isBoss ? 1 : 0.4);
    ctx.hitStop?.(0.09);
    ctx.onEnemyKilled?.(this);
  }

  _updateDying(dt, ctx) {
    const k = Math.min(1, this.stateT / this.stateDur);
    for (const e of this.emitters) e.rate *= 1 - Math.min(1, dt * 3);
    if (!this.model.ownDeath) {
      const fall = Math.min(1, this.stateT / 0.45);
      this.root.rotation.set(-fall * fall * 1.35, this.deathYaw, 0, 'YXZ');
      this.root.position.y = -Math.max(0, (k - 0.55) / 0.45) * 1.5 * (this.type.scale || 1);
      this._applyKnockback(dt, ctx);
      if (k >= 1) this.removed = true;
      return;
    }
    // Thrown by the blow: slides and hops along the floor (walls stop it),
    // bounces once, then lies where it fell until it sinks away.
    const r = this.rag;
    this.yaw += (this.deathYaw - this.yaw) * Math.min(1, dt * 10);
    this.root.rotation.set(0, this.yaw, 0);
    ctx.world.move(this.position, this.radius * 0.6, r.vx * dt, r.vz * dt);
    r.vy -= 22 * dt;
    r.y += r.vy * dt;
    if (r.y <= 0) {
      r.y = 0;
      if (Math.abs(r.vy) > 1.5) {
        r.vy = -r.vy * 0.28;
        if (!r.landed) ctx.shake?.(0.08);
        r.landed = true;
      } else r.vy = 0;
      const f = Math.exp(-7 * dt);
      r.vx *= f;
      r.vz *= f;
    }
    const sink = (this.stateT - (CORPSE_TIME - 1.5)) / 1.5;
    this.root.position.y = r.y - Math.max(0, sink) * 1.5 * (this.type.scale || 1);
    if (k >= 1) this.removed = true;
  }
}

// How long a body stays on the floor (with its death clip), sinking at the end.
const CORPSE_TIME = 9;

// The guard made visible: a burning ward of runes held before the chest.
const wardGeo = new THREE.PlaneGeometry(1, 1);
let wardTex = null;
function makeWard(e) {
  wardTex ||= runeCircleTexture('#ff4a1a');
  const mat = new THREE.MeshBasicMaterial({ map: wardTex, color: e.type.guard?.ward ? 0xff7a2a : 0xff3a1a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const m = new THREE.Mesh(wardGeo, mat);
  const h = e.model.height || 1.6;
  m.position.set(0, h * 0.58, (e.radius / (e.type.scale || 1)) + 0.25);
  m.userData = { k: 0, size: h * 0.62, shatter: 0 };
  m.visible = false;
  m.renderOrder = 6;
  e.root.add(m);
  return m;
}
