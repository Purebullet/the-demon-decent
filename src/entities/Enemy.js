import * as THREE from 'three';
import { StrikeVolume } from '../physics/Hitbox.js';
import { ENEMY_TYPES } from './EnemyTypes.js';
import { C, burst, ring } from '../world/Particles.js';
import { angleDelta, rand } from '../core/rng.js';
import { Assets } from '../assets/AssetLibrary.js';
import { buildGltfCharacter } from './GltfCharacter.js';

const WHITE = new THREE.Color(1, 1, 1);
const tmpV = new THREE.Vector3();
const DORMANT = new Set(['dormant', 'burrowed', 'emerging', 'dying']);

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
    // The AI-generated model when its GLB is present, else the stand-in.
    this.model = type.asset && Assets.hasCharacter(type.asset) ? buildGltfCharacter(type.asset, type.scale || 1) : type.build(type.buildOptions);
    this.root = this.model.root;
    if (type.scale) this.root.scale.setScalar(type.scale);
    this.position = this.root.position;
    this.position.set(spawn.x, 0, spawn.z);
    this.yaw = rand(0, Math.PI * 2);
    this.radius = type.radius;
    this.hitRadius = this.model.hitRadius * (type.scale || 1);
    this.hurtboxes = this.model.hurtboxes;
    this.maxHealth = Math.round(type.hp * tuning.hp);
    this.health = this.maxHealth;
    this.damage = type.dmg * tuning.dmg;
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
    this.flash = Math.max(0, this.flash - dt * 6);
    this.cooldown -= dt;
    this.poise = Math.max(0, this.poise - dt * this.type.poise * 0.3);
    const dx = player.position.x - this.position.x;
    const dz = player.position.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    this.distToPlayer = dist;

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
        if (this.stateT >= this.stateDur) this.setState('chase');
        break;
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
    if (this.flash > 0 || this._flashed) {
      this._flashed = this.flash > 0;
      const k = this.flash;
      this.model.mats.forEach((m, i) => {
        const b = this.baseEmissive[i];
        m.emissive.copy(b.c).lerp(WHITE, k * 0.8);
        m.emissiveIntensity = b.i + k * 1.2;
      });
    }
    this.root.updateMatrixWorld(true);
    if (this.alive) for (const h of this.hurtboxes) h.update();
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
    const range = this.type.attacks[0].maxRange;
    if (engaging && dist < range * 0.6 + ctx.player.radius) speed = 0;
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
    const face = dist < 5 || sp < 0.3 ? Math.atan2(ctx.player.position.x - px, ctx.player.position.z - pz) : Math.atan2(this.vel.x, this.vel.z);
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
    if (this.cooldown > 0) return;
    const options = this.type.attacks.filter((a) => dist >= a.minRange && dist <= a.maxRange);
    if (!options.length) return;
    // Needs to be roughly facing and have a clear line.
    if (Math.abs(angleDelta(this.yaw, Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z))) > 0.9) return;
    if (!ctx.nav.hasLineOfSight(this.position.x, this.position.z, player.position.x, player.position.z, 0.2)) return;
    if (!ctx.director.requestToken(this)) return;
    this._startAttack(options[Math.floor(Math.random() * options.length)], ctx);
  }

  _startAttack(a, ctx, windupScale = 1) {
    this.attack = a;
    this.hitPlayer = false;
    this.aoeDone = false;
    this.setState('windup', a.windup * this.tuning.windup * windupScale);
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
    ctx.audio?.enemySwing(this.typeKey, this.position);
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

  takeHit(amount, dir, knockback, stagger, ctx) {
    if (!this.alive || this.state === 'burrowed') return 0;
    this.health -= amount;
    this.flash = 1;
    const mass = this.type.mass || 1;
    this.knock.x += (dir.x * knockback) / mass;
    this.knock.z += (dir.z * knockback) / mass;
    if (this.health <= 0) {
      this.die(ctx);
      return amount;
    }
    if (this.state === 'dormant') this.becomeAlert(ctx);
    this.poise += stagger;
    if (this.poise >= this.type.poise && this.state !== 'stagger' && this.state !== 'emerging') {
      this.poise = 0;
      this.interrupt(ctx, 0.7);
    }
    return amount;
  }

  interrupt(ctx, dur) {
    ctx.director.releaseToken(this);
    this.attack = null;
    this.lungeDelay = -1;
    this.cooldown = Math.max(this.cooldown, 0.4);
    this.setState('stagger', dur);
  }

  die(ctx) {
    this.alive = false;
    this.health = 0;
    ctx.director.releaseToken(this);
    ctx.pathService.cancel(this);
    this.attack = null;
    this.setState('dying', 1.6);
    this.deathYaw = this.yaw;
    burst(ctx.fx.alpha, tmpV.set(this.position.x, 1, this.position.z), { count: 40, speed: 4, color: C.blood, colorEnd: C.bloodDark, size: 0.16, life: 0.9 });
    ctx.audio?.death(this.typeKey, this.position);
    ctx.onEnemyKilled?.(this);
  }

  _updateDying(dt, ctx) {
    const k = Math.min(1, this.stateT / this.stateDur);
    const fall = Math.min(1, this.stateT / 0.45);
    // Models with their own death clip fall by themselves.
    this.root.rotation.set(this.model.ownDeath ? 0 : -fall * fall * 1.35, this.deathYaw, 0, 'YXZ');
    this.root.position.y = -Math.max(0, (k - 0.55) / 0.45) * 1.5 * (this.type.scale || 1);
    for (const e of this.emitters) e.rate *= 1 - Math.min(1, dt * 3);
    this._applyKnockback(dt, ctx);
    if (k >= 1) this.removed = true;
  }
}
