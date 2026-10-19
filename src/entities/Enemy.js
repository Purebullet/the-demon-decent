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
// An armoured blow glows gold, not red: it cannot be interrupted by a light
// blow, so it is to be dodged or blocked, not countered.
const ARMOR_TELL = new THREE.Color(0.95, 0.55, 0.08);
const ICE = new THREE.Color(0.45, 0.8, 1);
const BROKEN = new THREE.Color(1, 0.55, 0.1);
// A burning demon's glow, and the colours of the shadow fiend's lash.
const BURN = new THREE.Color(1, 0.42, 0.06);
// (Particle colours are linear: these come out a deep violet-black.)
const SHADOW = new THREE.Color(0.035, 0.006, 0.06);
const SOOT = new THREE.Color(0.012, 0.009, 0.009);
const SHADOW_DEEP = new THREE.Color(0.01, 0.0, 0.02);
const SHADOW_GLOW = new THREE.Color(0.85, 0.35, 1.0);
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpC = new THREE.Color();
const DORMANT = new Set(['dormant', 'burrowed', 'emerging', 'dying']);

// Every demon is tougher and hits harder than its base stats, and winds up
// longer: a fight is about reading a blow and answering it (a counter-hit
// in the windup, a block, a dodge), not trading hits.
const HP_SCALE = 1.3;
const BOSS_HP_SCALE = 1.15;
// Every creature's blows, spells and fire come from its damage: 1.8, less 10%.
const DAMAGE_SCALE = 1.8 * 0.9;
const WINDUP_SCALE = 1.35;
// A punish (a quick attack into a sluggish swing) winds up this much faster.
const PUNISH = 0.55;
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
//   burrowed -> emerging -> chase                    (ambushers, the Deep)
//   dormant  -> chase <-> windup -> strike -> recover -> chase
//                 ^         ^          |                  |
//                 |         +- combo --+ (next blow of a string)
//                 +------------- stagger <------------+ (poise broken)
//   chase -> evade -> chase | windup   (hops clear when stung; feints)
//   chase -> blink -> windup | chase   (vanishes and reappears elsewhere)
//   any -> dying
//
// Each kind fights its own way (EnemyTypes.js): strings of blows (`combo`),
// feinted lunges (`feint`), blows that cannot be interrupted (`armor`, a gold
// glow instead of red), bull charges that end in a wall (`charge`), hit and
// run (`skittish`), blinking (`blink`) and rage when wounded (`enrage`).
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
    this.dodgeCd = type.dodge ? rand(0.5, 1.5) : Infinity;
    this.leapH = 0;
    this.status = {};
    this.statusTick = 0;
    this.sunder = 0;
    this.sunderT = 0;
    this.brokenT = 0;
    this.stumbling = false;
    this.ward = null;
    this.tint = 0;
    // Fighting style state.
    this.comboN = 0;
    this.feinted = false;
    this.hits = [];
    this.evadeV = new THREE.Vector3();
    this.evadeFollow = null;
    this.blinkCd = type.blink ? rand(type.blink.cooldown[0], type.blink.cooldown[1]) * 0.5 : Infinity;
    this.blinkTo = new THREE.Vector3();
    this.hidden = false;
    this.blinked = false;
    this.enraged = false;
    this.strafeSide = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = rand(1.2, 2.6);
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

  // An elite (a champion at the gate): larger, tougher, harder-hitting and
  // quicker to strike, smouldering red and shedding embers; it may carry a
  // relic.
  makeElite() {
    this.elite = true;
    this.maxHealth = this.health = Math.round(this.maxHealth * 1.4);
    this.damage *= 1.2;
    this.windupMul = 0.82;
    this.cooldownMul = 0.75;
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
    if (this.leapH && s !== 'evade') this._land();
    // Let go of a latched player, whatever ends it (a blow, death, ice).
    if (this.state === 'latched' && s !== 'latched') {
      if (this.latchedOn?.pinned?.by === this) this.latchedOn.unpin();
      this.latchedOn = null;
      this.root.position.y = 0;
      this.pose = null;
    }
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
    this.blinkCd -= dt;
    this.dodgeCd -= dt;
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
        // Track the player while telegraphing; deep floors track harder. A
        // blow with a cone stops turning near its end (`lockAt` of the
        // wind-up), so a step aside at the last moment clears it.
        const locked = this.attack?.lockAt && this.stateT > this.stateDur * this.attack.lockAt;
        if (!this.type.lockOnAttack && !locked) this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate * 0.8 * this.tuning.speed);
        if (this.attack?.shadow) this._shadowGather(dt, ctx);
        this.moveBlend = Math.max(0, this.moveBlend - dt * 6);
        if (this.stateT >= this.stateDur) this._beginStrike(ctx);
        break;
      }
      case 'strike':
        this._updateStrike(dt, ctx);
        break;
      case 'latched':
        this._updateLatch(dt, ctx);
        break;
      case 'evade':
        this._updateEvade(dt, ctx, dx, dz);
        break;
      case 'blink':
        this._updateBlink(dt, ctx, dx, dz);
        break;
      case 'recover':
        this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate * 0.3);
        // A quick demon cuts its recovery short to punish a sluggish swing.
        if (this.stateT >= this.stateDur || (player.exposed && this.stateT > 0.1 && dist < 2.2 && this.type.attacks.some((a) => a.punish))) {
          this._endAttack(ctx);
          if (this.state === 'chase') this._considerAttack(dt, ctx, dist);
        }
        break;
      case 'stagger':
        // Reeling: a few unsteady steps back from the blow, slowing.
        if (this.stumbling && this.lastHit) {
          const s = Math.min(1, this.stateT / this.stateDur);
          const hx = this.lastHit.x;
          const hz = this.lastHit.z;
          const hl = Math.hypot(hx, hz) || 1;
          const sp = (2.6 * (1 - s) * (1 - s)) / Math.sqrt(this.type.mass || 1);
          const wob = Math.sin(this.stateT * 11 + this.seed * 7) * 0.5;
          ctx.world.move(this.position, this.radius, ((hx + hz * wob) / hl) * sp * dt, ((hz - hx * wob) / hl) * sp * dt);
        }
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
      col = this.attack?.armor ? ARMOR_TELL : TELL;
      k = Math.min(1, (0.25 + 0.75 * u * u) * 0.6 * tells) * (0.85 + 0.15 * Math.sin(time * 30)) * (this.attack?.armor ? 0.8 : 1);
    } else if (this.brokenT > 0 && this.alive) {
      col = BROKEN;
      k = 0.35 + 0.15 * Math.sin(time * 10);
    } else if (this.status.burn && this.alive) {
      // Firelight flickering over the skin under the flames (kept low: the
      // flames themselves carry it, a strong tint only gilds the whole body).
      col = BURN;
      k = 0.09 + 0.05 * Math.sin(time * 23 + this.seed * 5) + 0.03 * Math.sin(time * 37);
      boost = 0.7;
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
      // In reach and waiting for an opening: circle, never stand and wait to
      // be hit; too close, give a little ground.
      const range = this.type.attacks[0].maxRange;
      const hold = range * 0.6 + ctx.player.radius;
      if (engaging && dist < hold + 0.6) {
        this.strafeT -= dt;
        if (this.strafeT <= 0) {
          this.strafeT = rand(1.1, 2.4);
          if (Math.random() < 0.6) this.strafeSide = -this.strafeSide;
        }
        const ox = (px - ctx.player.position.x) / (dist || 1);
        const oz = (pz - ctx.player.position.z) / (dist || 1);
        const back = dist < hold - 0.35 ? 0.8 : dist > hold + 0.2 ? -0.5 : 0;
        vx = -oz * this.strafeSide + ox * back;
        vz = ox * this.strafeSide + oz * back;
        const l = Math.hypot(vx, vz) || 1;
        vx /= l;
        vz /= l;
        speed *= 0.42;
      }
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
        const a = this.type.attacks.find((x) => !x.comboOnly && dist >= x.minRange && dist <= x.maxRange) || this.type.attacks[0];
        if (dist <= Math.max(...this.type.attacks.map((x) => x.maxRange))) this._startAttack(a, ctx, 0.75);
      }
      return;
    }
    // Blinkers vanish and come back where you are not looking.
    if (this.type.blink && this.blinkCd <= 0 && this._tryBlink(ctx, dist)) return;
    // A sluggish, fumbled swing is an opening: every demon in reach takes it,
    // and one with a quick attack for it (the stalker's snap) strikes at once.
    const opening = player.exposed && dist <= this.type.attacks[0].maxRange + 0.6;
    const off = Math.abs(angleDelta(this.yaw, Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z)));
    if (opening) {
      const quick = this.type.attacks.find((a) => a.punish && dist <= a.maxRange + 0.4);
      if (quick && off < 1.4) {
        this._startAttack(quick, ctx, PUNISH);
        return;
      }
      this.cooldown = Math.min(this.cooldown, 0.08);
    }
    if (this.cooldown > 0) return;
    // Behind it, or pressed right up against it: what only that answers.
    const behind = off > 1.6 || dist < 1.3;
    const now = ctx.time ?? 0;
    const options = this.type.attacks.filter((a) => !a.comboOnly && dist >= a.minRange && dist <= a.maxRange && (!a.behind || behind) && !(a.rest && now < (this.restUntil?.[a.name] ?? -1)));
    if (!options.length) return;
    // Needs to be roughly facing (unless it strikes behind) and a clear line.
    const back = options.filter((a) => a.behind);
    if (off > 0.9 && !back.length) return;
    if (!ctx.nav.hasLineOfSight(this.position.x, this.position.z, player.position.x, player.position.z, 0.2)) return;
    // Casters pace themselves; attack tokens are for those who close in.
    if (!this.type.keepAway && !opening && !ctx.director.requestToken(this)) return;
    this._startAttack(pickWeighted(off > 0.9 ? back : options), ctx);
  }

  // `chained`: the next blow of a string (keeps its attack token).
  _startAttack(a, ctx, windupScale = 1, chained = false) {
    // (An attack with a `rest` is not chosen again for that long.)
    if (a.rest) (this.restUntil ||= {})[a.name] = (ctx.time ?? 0) + a.rest;
    if (!chained) {
      this.comboN = 0;
      this.feinted = false;
    }
    this.attack = a;
    this.hitPlayer = false;
    this.aoeDone = false;
    this.charged = 0;
    const rage = this.enraged ? this.type.enrage.windup : 1;
    this.setState('windup', a.windup * this.tuning.windup * windupScale * rage * WINDUP_SCALE * (this.windupMul || 1));
    ctx.audio?.telegraph(this.typeKey, this.position);
    // A blow that carries forward shows where on the ground.
    if (a.cone) ctx.effects?.cone?.(this, { range: a.cone.range * (this.type.scale || 1), half: a.cone.half });
    if (a.shadow) ctx.effects?.shadowOrb?.(this, this._lashHand(), { size: 0.55 * (this.type.scale || 1) });
  }

  // Is it in the middle of a blow that cannot be interrupted?
  armored() {
    return !!this.attack?.armor && (this.state === 'windup' || this.state === 'strike');
  }

  _beginStrike(ctx) {
    const a = this.attack;
    // A feint: the lunge never comes; it skips aside and goes again, faster.
    if (a.feint && !this.feinted && Math.random() < a.feint) {
      this.feinted = true;
      this._evade(ctx, { side: Math.random() < 0.5 ? -1 : 1, away: 0.3, speed: 6.5, dur: 0.3, follow: a, followScale: 0.5 });
      return;
    }
    this.setState('strike', a.strike);
    if (a.eruption) this._erupt(ctx, a);
    const v = a.volume;
    if (v) {
      this.strike.localCenter.set(v.c[0], v.c[1], v.c[2]);
      this.strike.localHalf.set(v.h[0], v.h[1], v.h[2]);
    }
    if (a.projectile) this._throw(ctx, a);
    else ctx.audio?.enemySwing(this.typeKey, this.position);
    if (a.shadow) this._shadowLash(ctx, a);
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
      ctx.effects.fireball(from, dir, p.speed * Math.sqrt(this.tuning.speed), this.damage * a.dmg, { homing: p.homing, owner: this });
    }
    ctx.audio?.fireball(from);
  }

  _updateStrike(dt, ctx) {
    const a = this.attack;
    if (a.lunge) {
      const f = a.lunge * dt * (this.enraged ? 1.15 : 1);
      const bx = this.position.x;
      const bz = this.position.z;
      ctx.world.move(this.position, this.radius, Math.sin(this.yaw) * f, Math.cos(this.yaw) * f);
      this.moveBlend = 1;
      this.walkPhase += dt * 8;
      // A charge that runs into rock: stunned, and wide open.
      if (a.charge) {
        const moved = Math.hypot(this.position.x - bx, this.position.z - bz);
        this.charged += moved;
        if (moved < f * 0.45 && this.stateT > 0.08) {
          this._wallStun(ctx);
          return;
        }
      }
    }
    this.root.rotation.y = this.yaw;
    const player = ctx.player;
    if (a.volume && !this.hitPlayer) {
      this.root.updateMatrixWorld(true);
      if (player.overlapsOBB(this.strike.update())) {
        this.hitPlayer = true;
        const blocked = player.blocking;
        const landed = player.takeDamage(this.damage * a.dmg, this.position, a.knockback, ctx, this);
        if (landed === true && a.ignite && !player.blocking) player.ignite?.(this.damage * a.ignite.dps, a.ignite.dur, ctx);
        // Its jaws closed on you (not on a raised guard): it hangs on.
        if (landed === true && a.latch && !blocked && !player.dead && !player.held && !player.air) {
          this._latch(ctx, a);
          return;
        }
        if (a.shadow && landed === true) this._shadowHit(ctx);
        // Parried: the blow is thrown back and the string is broken.
        if (this.state !== 'strike') return;
      }
    }
    if (a.aoe && !this.aoeDone && this.stateT >= this.stateDur * 0.5) {
      this.aoeDone = true;
      this._impact(ctx, a.aoe);
    }
    if (this.stateT >= this.stateDur) {
      // The next blow of a string, if the player is still in reach of it.
      const c = a.combo;
      if (c && this.comboN < (c.max || 1) && !player.dead && Math.random() < c.chance) {
        const next = this.type.attacks.find((x) => x.name === c.next);
        if (next && this.distToPlayer <= next.maxRange + 0.4) {
          this.comboN++;
          this._startAttack(next, ctx, c.windup ?? 0.7, true);
          return;
        }
      }
      this.setState('recover', a.recover * Math.sqrt(this.tuning.windup));
    }
  }

  _wallStun(ctx) {
    ctx.shake?.(0.5);
    ctx.audio?.slam(this.position);
    burst(ctx.fx.alpha, tmpV.set(this.position.x, 1.4 * (this.type.scale || 1), this.position.z), { count: 30, speed: 4, color: C.smoke, colorEnd: C.smoke, size: 0.6, life: 1.2, gravity: -1 });
    burst(ctx.fx.add, tmpV, { count: 24, speed: 6, color: C.spark, colorEnd: C.fireEdge, size: 0.08, life: 0.4 });
    ctx.onCombat?.('stunned', tmpV.clone());
    this.interrupt(ctx, 2.1);
    this.stumbling = true;
    this.brokenT = 2.1;
  }

  // Fire breaks out of the ground where the player stands and where they
  // are heading, each spot announced by a ring.
  _erupt(ctx, a) {
    const E = a.eruption;
    const p = ctx.player;
    const lead = E.delay * 0.8;
    const spots = [
      [p.position.x, p.position.z],
      [p.position.x + p.vel.x * lead, p.position.z + p.vel.z * lead],
    ];
    for (let i = 2; i < E.count; i++) {
      const ang = Math.random() * Math.PI * 2;
      spots.push([p.position.x + Math.sin(ang) * E.spread, p.position.z + Math.cos(ang) * E.spread]);
    }
    spots.forEach(([x, z], i) => {
      if (!ctx.nav.isWalkable(ctx.nav.tileX(x), ctx.nav.tileZ(z))) return;
      ctx.effects?.fireStrike(x, z, E.radius, E.delay + i * 0.12, this.damage * a.dmg, ctx);
    });
    ctx.audio?.burst(this.position);
  }

  // ---------------------------------------------------- evade & blink ---

  // A quick hop: away from the player (`away` 1) and/or aside (`side` +-1).
  // With `follow`, it goes straight into that attack afterwards.
  _evade(ctx, { side = 0, away = 1, speed = 7, dur = 0.38, follow = null, followScale = 1 } = {}) {
    const p = ctx.player.position;
    let tx = p.x - this.position.x;
    let tz = p.z - this.position.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    let vx = -tx * away - tz * side;
    let vz = -tz * away + tx * side;
    const vl = Math.hypot(vx, vz) || 1;
    this.evadeV.set((vx / vl) * speed, 0, (vz / vl) * speed);
    this.evadeFollow = follow;
    this.evadeScale = followScale;
    if (!follow) {
      ctx.director.releaseToken(this);
      this.attack = null;
    }
    this.setState('evade', dur);
    ctx.audio?.whoosh?.(this.position);
    burst(ctx.fx.alpha, tmpV.set(this.position.x, 0.15, this.position.z), { count: 10, speed: 2, color: C.smoke, colorEnd: C.smoke, size: 0.35, life: 0.6, gravity: -1 });
  }

  // Leaps back out of reach of a swing it sees coming: crouch, spring
  // up and back (the pounce clip's gather and flight), land; sometimes
  // straight into a pounce while you are still finishing the swing.
  _leapBack(ctx) {
    const D = this.type.dodge;
    this.dodgeCd = rand(D.cooldown[0], D.cooldown[1]);
    const pounce = Math.random() < D.pounce ? this.type.attacks.find((a) => a.name === 'pounce') : null;
    this._evade(ctx, { side: rand(-0.45, 0.45), away: 1, speed: 11.5, dur: 0.46, follow: pounce, followScale: 0.7 });
    this.leapH = 0.55;
    this.cooldown = Math.max(this.cooldown, 0.35);
  }

  _land() {
    this.leapH = 0;
    this.pose = null;
    this.root.position.y = 0;
  }

  _updateEvade(dt, ctx, dx, dz) {
    const k = Math.min(1, this.stateT / this.stateDur);
    const f = (1 - k) * 1.7 * dt;
    ctx.world.move(this.position, this.radius, this.evadeV.x * f, this.evadeV.z * f);
    if (this.leapH) {
      // Up and back in an arc, legs gathered under it.
      const a = Math.sin(Math.PI * Math.min(1, k * 1.15));
      this.root.position.y = this.leapH * Math.max(0, a);
      const hop = this.type.hopClip;
      this.pose = hop ? { name: hop, u: Math.min(1, k), rate: 20 } : { name: 'pounce', u: 0.36 + 0.26 * a, rate: 18 };
      this.moveBlend = 0;
      if (k >= 1) this._land();
    } else {
      this.moveBlend = 1;
      this.walkPhase += dt * 12;
    }
    this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate * 1.5);
    if (this.stateT < this.stateDur) return;
    const follow = this.evadeFollow;
    this.evadeFollow = null;
    if (follow && !ctx.player.dead) this._startAttack(follow, ctx, this.evadeScale, true);
    else {
      this.attack = null;
      this.setState('chase');
      this.cooldown = Math.max(this.cooldown, 0.3);
    }
  }

  // Vanish and reappear: behind the player (`behind`) to strike, or well
  // away from them (`away`) to keep casting.
  _tryBlink(ctx, dist) {
    const B = this.type.blink;
    const p = ctx.player;
    const nav = ctx.nav;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    let ok = false;
    if (B.mode === 'behind') {
      // Only when it is being watched from a distance.
      if (dist < B.range[0] || dist > B.range[1]) return false;
      const dot = ((this.position.x - p.position.x) * fx + (this.position.z - p.position.z) * fz) / (dist || 1);
      if (dot < 0.6) return false;
      for (let i = 0; i < 6 && !ok; i++) {
        const a = Math.atan2(-fx, -fz) + (i % 2 ? 1 : -1) * (0.3 + i * 0.2);
        const r = 2.1 + Math.random() * 0.4;
        this.blinkTo.set(p.position.x + Math.sin(a) * r, 0, p.position.z + Math.cos(a) * r);
        ok = nav.isWalkable(nav.tileX(this.blinkTo.x), nav.tileZ(this.blinkTo.z)) && nav.hasLineOfSight(p.position.x, p.position.z, this.blinkTo.x, this.blinkTo.z, 0.3);
      }
    } else {
      // Cornered: away to where it can cast again.
      if (dist > B.range[0]) return false;
      for (let i = 0; i < 10 && !ok; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = B.range[1] * (0.8 + Math.random() * 0.4);
        this.blinkTo.set(p.position.x + Math.sin(a) * r, 0, p.position.z + Math.cos(a) * r);
        ok = nav.isWalkable(nav.tileX(this.blinkTo.x), nav.tileZ(this.blinkTo.z)) && nav.hasLineOfSight(p.position.x, p.position.z, this.blinkTo.x, this.blinkTo.z, 0.3);
      }
    }
    if (!ok) {
      this.blinkCd = 1;
      return false;
    }
    this.blinkCd = rand(B.cooldown[0], B.cooldown[1]);
    ctx.director.releaseToken(this);
    this.attack = null;
    this.blinked = false;
    this.setState('blink', B.time || 0.5);
    this._blinkFx(ctx);
    return true;
  }

  _blinkFx(ctx) {
    const h = (this.model.height || 1.6) * (this.type.scale || 1);
    const at = tmpV.set(this.position.x, h * 0.5, this.position.z);
    burst(ctx.fx.alpha, at, { count: 26, speed: 3, color: C.smoke, colorEnd: C.smoke, size: 0.6, life: 0.9, gravity: -1 });
    burst(ctx.fx.add, at, { count: 22, speed: 4, color: C.violet, colorEnd: C.violetDark, size: 0.14, life: 0.5 });
    ctx.audio?.blink?.(this.position);
  }

  _updateBlink(dt, ctx, dx, dz) {
    const half = this.stateDur * 0.45;
    if (!this.hidden && this.stateT < half) {
      this.hidden = true;
      for (const e of this.emitters) e.active = false;
    }
    if (this.hidden && this.stateT >= half && !this.blinked) {
      this.blinked = true;
      this.position.copy(this.blinkTo);
      ctx.world.resolve?.(this.position, this.radius);
      this.yaw = Math.atan2(ctx.player.position.x - this.position.x, ctx.player.position.z - this.position.z);
      this.hidden = false;
      for (const e of this.emitters) e.active = true;
      this._blinkFx(ctx);
    }
    this.moveBlend = 0;
    if (this.stateT < this.stateDur) return;
    this.blinked = false;
    this.hidden = false;
    const B = this.type.blink;
    const a = B.then && this.type.attacks.find((x) => x.name === B.then);
    const dist = Math.hypot(ctx.player.position.x - this.position.x, ctx.player.position.z - this.position.z);
    if (a && dist <= a.maxRange + 0.5 && !ctx.player.dead) {
      ctx.director.requestToken(this);
      this._startAttack(a, ctx, B.thenWindup ?? 1);
    } else {
      this.setState('chase');
      this.cooldown = Math.min(this.cooldown, 0.4);
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

  // ------------------------------------------------- latch & shadow ---

  // Its jaws locked on the player: it hangs on, thrashing its head, biting
  // over and over, until its hold gives (`latch.dur`) or a blow throws it
  // off. The player is held in place meanwhile (Player.pin).
  _latch(ctx, a) {
    const p = ctx.player;
    let ox = this.position.x - p.position.x;
    let oz = this.position.z - p.position.z;
    const l = Math.hypot(ox, oz) || 1;
    // Its jaws at your chest, its body out in front of you (not around the
    // camera): you look down on it thrashing.
    const reach = p.radius + this.radius * (this.type.latchReach ?? 1.8);
    ox = (ox / l) * reach;
    oz = (oz / l) * reach;
    this.latchOff = { x: ox, z: oz };
    this.latchTick = 0.18;
    this.setState('latched', a.latch.dur);
    this.latchedOn = p;
    p.pin(this);
    ctx.shake?.(0.4);
    ctx.audio?.telegraph?.(this.typeKey, this.position);
    ctx.onCombat?.('latched', tmpV.set(p.position.x, 1.2, p.position.z).clone());
  }

  _updateLatch(dt, ctx) {
    const p = ctx.player;
    const a = this.attack;
    if (!a?.latch || p.dead || p.pinned?.by !== this) {
      this.setState('recover', 0.6);
      return;
    }
    if (this.stateT >= this.stateDur) {
      // Its hold gives: it drops off and springs clear.
      this._evade(ctx, { away: 1, speed: 8, dur: 0.32 });
      return;
    }
    // Hanging off the player, its head thrashing side to side.
    const t = this.stateT;
    this.position.set(p.position.x + this.latchOff.x, 0, p.position.z + this.latchOff.z);
    this.yaw = Math.atan2(-this.latchOff.x, -this.latchOff.z) + Math.sin(t * 17) * 0.32;
    this.root.position.y = 0.32 + 0.06 * Math.sin(t * 34);
    this.pose = { name: 'bite', u: 0.45 + 0.25 * Math.sin(t * 17), rate: 30 };
    this.moveBlend = 0;
    this.latchTick -= dt;
    if (this.latchTick <= 0) {
      this.latchTick = 0.3;
      p.maul(this.damage * a.latch.dps * 0.3, this.position, ctx);
      const at = tmpV.set(p.position.x + this.latchOff.x * 0.5, 1.05, p.position.z + this.latchOff.z * 0.5);
      for (let i = 0; i < 14; i++) ctx.fx.alpha.emit({ x: at.x, y: at.y, z: at.z, vx: rand(-2, 2), vy: rand(0, 2.5), vz: rand(-2, 2), life: rand(0.4, 0.8), size: rand(0.06, 0.12), sizeEnd: 0.03, color: C.blood, colorEnd: C.bloodDark, gravity: -9, drag: 1 });
    }
  }

  // Shadow gathering into it as it winds up a lash: dark smoke drawn in
  // from all round to the striking arm, violet sparks spiralling with it,
  // and shadow seeping up out of the ground at its feet.
  _shadowGather(dt, ctx) {
    const sc = this.type.scale || 1;
    const k = Math.min(1, this.stateT / Math.max(0.01, this.stateDur));
    const hand = this._handAt(tmpV2);
    const hx = hand.x;
    const hy = hand.y;
    const hz = hand.z;
    const n = Math.floor(dt * (50 + 90 * k) + Math.random());
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = rand(-0.6, 0.9);
      const r = rand(1.2, 2.2) * sc;
      const x = hx + Math.cos(a) * Math.cos(e) * r;
      const y = hy + Math.sin(e) * r;
      const z = hz + Math.sin(a) * Math.cos(e) * r;
      const life = rand(0.35, 0.55);
      // Dark smoke drawn in, curling round as it comes.
      const sw = rand(1.5, 3);
      ctx.fx.alpha.emit({ x, y, z, vx: (hx - x) / life - Math.sin(a) * sw, vy: (hy - y) / life, vz: (hz - z) / life + Math.cos(a) * sw, life, size: rand(0.3, 0.55) * sc, sizeEnd: 0.06, color: SHADOW, colorEnd: SHADOW_DEEP, drag: 0.4, turbulence: 0.8 });
      if (Math.random() < 0.45) {
        const sp = rand(2.5, 4);
        ctx.fx.add.emit({ x, y, z, vx: (hx - x) / life - Math.sin(a) * sp, vy: (hy - y) / life, vz: (hz - z) / life + Math.cos(a) * sp, life, size: rand(0.04, 0.08), sizeEnd: 0.01, color: SHADOW_GLOW, colorEnd: C.violetDark, drag: 1.2 });
      }
    }
    // Shadow seeping up out of the ground round its feet.
    if (Math.random() < dt * 30) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.2, 1.1) * sc;
      ctx.fx.alpha.emit({ x: this.position.x + Math.cos(a) * r, y: 0.1, z: this.position.z + Math.sin(a) * r, vx: 0, vy: rand(0.6, 1.4), vz: 0, life: rand(0.8, 1.3), size: rand(0.5, 0.9) * sc, sizeEnd: 0.2, color: SHADOW_DEEP, colorEnd: SHADOW, drag: 0.6, turbulence: 1.4 });
    }
  }

  // The striking hand (the right), and where it is now.
  _lashHand() {
    if (this._lashBone === undefined) this._lashBone = this.model.bones?.find((b) => /^right_?hand$/i.test(b.name)) || null;
    return this._lashBone;
  }

  _handAt(out) {
    const b = this._lashHand();
    if (b) return b.getWorldPosition(out);
    const sc = this.type.scale || 1;
    return out.set(this.position.x - Math.cos(this.yaw) * 0.55 * sc, 1.45 * sc, this.position.z + Math.sin(this.yaw) * 0.55 * sc);
  }

  // The lash itself: a whip of shadow torn out along the cone, writhing
  // tendrils splitting off it, a violet core of sparks down its length and
  // a burst of shadow where it ends.
  _shadowLash(ctx, a) {
    const sc = this.type.scale || 1;
    const len = (a.cone?.range || 4.5) * sc;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const from = this._handAt(tmpV2);
    // Thrown from the hand to the far end of the cone, down its middle.
    const tx = this.position.x + fx * len - from.x;
    const tz = this.position.z + fz * len - from.z;
    const run = Math.hypot(tx, tz) || len;
    const dx = tx / run;
    const dz = tz / run;
    // The whip itself: a ribbon of living shadow (world/Effects.js).
    ctx.effects?.shadowWhip?.(from, { x: dx, z: dz }, run, { bone: this._lashHand(), endY: 0.9, width: 0.6 * sc });
    // Smoke torn off it along its run, sparks shed from it.
    const steps = 18;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const x = from.x + dx * run * k;
      const z = from.z + dz * run * k;
      const y = from.y + (0.9 - from.y) * k * k;
      const delay = k * 0.16;
      for (let j = 0; j < 2; j++) ctx.fx.alpha.emit({ x: x + rand(-0.2, 0.2), y: y + rand(-0.2, 0.2), z: z + rand(-0.2, 0.2), vx: rand(-0.7, 0.7), vy: rand(0, 0.9), vz: rand(-0.7, 0.7), life: rand(0.5, 0.95) + delay, size: rand(0.3, 0.6) * (1 - k * 0.4), sizeEnd: 0.08, color: SHADOW, colorEnd: SHADOW_DEEP, drag: 1.4, turbulence: 1.6 });
      if (i % 2 === 0) ctx.fx.add.emit({ x, y, z, vx: dx * 4 + rand(-1, 1), vy: rand(-0.3, 1.2), vz: dz * 4 + rand(-1, 1), life: rand(0.25, 0.5), size: rand(0.06, 0.12), sizeEnd: 0.02, color: SHADOW_GLOW, colorEnd: C.violetDark, drag: 2 });
    }
    // Where it ends: a burst of shadow and violet sparks.
    const at = tmpV.set(from.x + dx * run, 0.9, from.z + dz * run);
    burst(ctx.fx.alpha, at, { count: 22, speed: 3.2, color: SHADOW, colorEnd: SHADOW_DEEP, size: 0.65, life: 0.9, gravity: 0.5 });
    burst(ctx.fx.add, at, { count: 18, speed: 5, color: SHADOW_GLOW, colorEnd: C.violetDark, size: 0.08, life: 0.45, gravity: -2 });
  }

  // The lash caught you: shadow clings and drags.
  _shadowHit(ctx) {
    const p = ctx.player.position;
    const at = tmpV.set(p.x, 1.1, p.z);
    burst(ctx.fx.alpha, at, { count: 30, speed: 2.5, color: SHADOW, colorEnd: SHADOW_DEEP, size: 0.6, life: 0.8, gravity: 0.3 });
    burst(ctx.fx.add, at, { count: 26, speed: 4, color: SHADOW_GLOW, colorEnd: C.violetDark, size: 0.1, life: 0.4 });
  }

  _endAttack(ctx) {
    ctx.director.releaseToken(this);
    this.attack = null;
    this.cooldown = this.type.cooldown * this.tuning.cooldown * rand(0.8, 1.25) * (this.enraged ? this.type.enrage.cooldown : 1) * (this.cooldownMul || 1);
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
    if (!this.alive || this.state === 'burrowed' || this.hidden) return 0;
    // Hanging on you: a blow throws it off, reeling.
    if (this.state === 'latched' && !opts.proc) {
      this.interrupt(ctx, 0.9);
      this.stumbling = true;
      ctx.onCombat?.('shakenOff', tmpV.set(this.position.x, 1.1, this.position.z).clone());
    }
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
    // Wounded deep enough, a raging kind goes berserk.
    const R = this.type.enrage;
    if (R && !this.enraged && this.health < this.maxHealth * R.at) this._enrage(ctx);
    this.poise += stagger;
    const threshold = this.type.poise * (1 - 0.1 * this.sunder);
    // An armoured blow carries through anything but a broken guard.
    const armored = this.armored() && !opts.heavy;
    if (armored) {
      this.poise = Math.min(this.poise, threshold * 0.9);
      if (!opts.proc) {
        burst(ctx.fx.add, opts.contact || tmpV.set(this.position.x, 1.2, this.position.z), { count: 14, speed: 4, color: C.emberHot, colorEnd: C.fireEdge, size: 0.07, life: 0.3 });
        ctx.onCombat?.('armored', opts.contact);
      }
      return amount;
    }
    if (this.poise >= threshold && this.state !== 'stagger' && this.state !== 'emerging' && this.state !== 'frozen') {
      // Poise broken: it stumbles back, plainly off its feet for a moment.
      this.poise = 0;
      this.interrupt(ctx, 0.85);
      this.stumbling = !this.isBoss;
      return amount;
    }
    if (opts.proc) return amount;
    // Hit-and-run kinds spring clear of a flurry.
    const S = this.type.skittish;
    if (S && (this.state === 'chase' || this.state === 'recover')) {
      const now = ctx.time || 0;
      this.hits.push(now);
      while (this.hits.length && now - this.hits[0] > S.window) this.hits.shift();
      if (this.hits.length >= S.hits && Math.random() < S.chance) {
        this.hits.length = 0;
        this._evade(ctx, { side: Math.random() < 0.5 ? -0.6 : 0.6, away: 1, speed: 8, dur: 0.42 });
        this.cooldown = Math.min(this.cooldown, rand(0.3, 0.8));
        return amount;
      }
    }
    if (this.canGuard() && this.guardCd <= 0 && this.guardPending < 0 && this.state === 'chase' && Math.random() < this.type.guard.chance * 0.5) {
      // Stung, a guarding demon gets its guard up.
      this.guardPending = 0.18;
    }
    return amount;
  }

  _enrage(ctx) {
    const R = this.type.enrage;
    this.enraged = true;
    this.speed *= R.speed;
    const red = new THREE.Color(0.9, 0.1, 0.02);
    this.baseEmissive = this.baseEmissive.map((b) => ({ c: b.c.clone().lerp(red, 0.35), i: b.i + 0.25 }));
    this._tinted = true;
    for (const e of this.emitters) e.rate *= 1.8;
    burst(ctx.fx.add, tmpV.set(this.position.x, (this.model.height || 1.6) * (this.type.scale || 1) * 0.8, this.position.z), { count: 40, speed: 5, color: C.fireCore, colorEnd: C.emberRed, size: 0.2, life: 0.7, up: 2 });
    ctx.audio?.roar?.(this.position);
    ctx.onCombat?.('enrage', tmpV.clone());
  }

  // A blow of its own turned aside at the last instant: thrown off balance,
  // wide open (Player.takeDamage, a parry).
  parried(ctx) {
    if (!this.alive) return;
    this.flash = 0.6;
    this.comboN = 99;
    if (this.isBoss) {
      this.setState('recover', 0.7);
      return;
    }
    this.interrupt(ctx, 1.1);
    this.stumbling = true;
    this.brokenT = Math.max(this.brokenT, 1.1);
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
    // Quick beasts may leap back out of reach instead.
    const D = this.type.dodge;
    if (D && this.alive && !this.hidden && this.dodgeCd <= 0 && (this.state === 'chase' || this.state === 'recover') && this.distToPlayer < D.range) {
      const p = ctx.player.position;
      const facing = Math.abs(angleDelta(this.yaw, Math.atan2(p.x - this.position.x, p.z - this.position.z))) < 1.4;
      if (facing && Math.random() < D.chance * (heavy ? 1.4 : 1)) {
        this._leapBack(ctx);
        return;
      }
    }
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
    const a = this.type.attacks.find((x) => dist >= x.minRange && dist <= x.maxRange && riposte(x));
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
    const a = this.type.attacks.find((x) => dist >= x.minRange && dist <= x.maxRange && riposte(x));
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
    if (!this.alive || this.state === 'emerging' || this.state === 'burrowed' || this.hidden) return;
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
      if (kind === 'burn') this._burnFx(dt, ctx);
      if (kind === 'bleed' && Math.random() < dt * 8) ctx.fx.alpha.emit({ x: this.position.x + rand(-0.2, 0.2), y: h, z: this.position.z + rand(-0.2, 0.2), vx: rand(-0.5, 0.5), vy: 0.5, vz: rand(-0.5, 0.5), life: 0.8, size: 0.09, color: C.blood, colorEnd: C.bloodDark, gravity: -9 });
      if (tick && this.alive) {
        const dealt = this.takeHit(st.dps * 0.5, tmpV.set(0, 0, 0), 0, 0, ctx, { proc: true });
        ctx.onDamage?.(this, dealt, false, tmpV.set(this.position.x, h + 0.3, this.position.z), kind);
        if (!this.alive) return;
      }
    }
  }

  // Ablaze: flames licking up all over it (from its bones, so they move
  // with it), bigger and hotter at its core, sparks spiralling up out of
  // the fire and a column of smoke above it.
  _burnFx(dt, ctx) {
    if (!this._bones) {
      this._bones = [];
      this.root.traverse((o) => {
        if (o.isBone) this._bones.push(o);
      });
    }
    const sc = this.type.scale || 1;
    const h = (this.model.height || 1.6) * sc;
    const bones = this._bones;
    // Real flames on its body: on the bones spread up it (no fingers, toes
    // or end nubs), from the hips to the head (world/Effects.js bodyFire).
    if (!this._fireBones) {
      const body = bones.filter((b) => !/finger|thumb|index|middle|ring|pinky|toe|end|tip|nub|jaw|eye|tongue|teeth|ear/i.test(b.name));
      this.root.updateMatrixWorld(true);
      const ys = body.map((b) => [b, b.getWorldPosition(tmpV).y - this.position.y]).sort((a, c) => a[1] - c[1]);
      const pickAt = [0.97, 0.35, 0.55, 0.7, 0.82, 0.45];
      const chosen = [];
      for (const q of pickAt) {
        const b = ys[Math.min(ys.length - 1, Math.floor(q * ys.length))]?.[0];
        if (b && !chosen.includes(b)) chosen.push(b);
      }
      this._fireBones = chosen;
    }
    ctx.effects?.bodyFire?.(this, this._fireBones, h * 0.62);
    const at = tmpV;
    const pick = () => {
      if (bones.length) {
        bones[Math.floor(Math.random() * bones.length)].getWorldPosition(at);
        at.x += rand(-0.12, 0.12) * sc;
        at.z += rand(-0.12, 0.12) * sc;
      } else at.set(this.position.x + rand(-0.3, 0.3) * sc, rand(0.2, h), this.position.z + rand(-0.3, 0.3) * sc);
      return at;
    };
    // Licks of flame shed off it, reddening as they rise.
    let n = Math.floor(dt * 36 + Math.random());
    for (let i = 0; i < n; i++) {
      const p = pick();
      ctx.fx.add.emit({ x: p.x, y: p.y, z: p.z, vx: rand(-0.3, 0.3), vy: rand(1.6, 2.8), vz: rand(-0.3, 0.3), life: rand(0.3, 0.55), size: rand(0.16, 0.3) * sc, sizeEnd: 0.03, color: C.fireEdge, colorEnd: C.emberRed, drag: 1.4, turbulence: 2.2 });
    }
    // Sparks thrown up, spiralling.
    n = Math.floor(dt * 30 + Math.random());
    for (let i = 0; i < n; i++) {
      const p = pick();
      const a = Math.random() * Math.PI * 2;
      ctx.fx.add.emit({ x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * rand(0.6, 1.6), vy: rand(2.5, 4.5), vz: Math.sin(a) * rand(0.6, 1.6), life: rand(0.6, 1.1), size: rand(0.035, 0.07), sizeEnd: 0.01, color: C.spark, colorEnd: C.emberRed, drag: 0.8, gravity: 1.5, turbulence: 3 });
    }
    // Black smoke rolling up off it.
    if (Math.random() < dt * 10) ctx.fx.alpha.emit({ x: this.position.x + rand(-0.3, 0.3) * sc, y: h * rand(0.9, 1.15), z: this.position.z + rand(-0.3, 0.3) * sc, vx: rand(-0.2, 0.2), vy: rand(1, 1.8), vz: rand(-0.2, 0.2), life: rand(1, 1.6), size: rand(0.4, 0.7) * sc, sizeEnd: 1.2 * sc, color: SOOT, colorEnd: SOOT, drag: 0.6, turbulence: 1.2 });
  }

  interrupt(ctx, dur) {
    if (this.state === 'frozen' || this.state === 'dying' || this.hidden) return;
    this.evadeFollow = null;
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
    // A rigged demon goes limp: a ragdoll, thrown along the killing blow, that
    // lies where it falls and shifts when walked into. A model with its own
    // death clip (a boss) is thrown, falls and flops (see _updateDying). Both
    // lie there for a while, then sink.
    this.ragdolled = !this.isBoss && !!this.model.canRagdoll;
    this.setState('dying', this.ragdolled ? RAGDOLL_TIME : this.model.ownDeath ? CORPSE_TIME : 1.6);
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
    if (this.ragdolled) this.model.startRagdoll({ x: this.rag.vx, y: this.rag.vy, z: this.rag.vz });
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
    if (this.ragdolled) {
      // The body is the ragdoll's now; the player shoves it walking through.
      const p = ctx.player;
      const pushers = p.dead ? [] : [{ x: p.position.x, z: p.position.z, r: 0.42, h: 1.1 }];
      const sink = Math.max(0, (this.stateT - (this.stateDur - 1.5)) / 1.5) * 1.5 * (this.type.scale || 1);
      this.model.stepRagdoll(dt, ctx.world, pushers, sink);
      if (k >= 1) this.removed = true;
      return;
    }
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

// How long a body stays on the floor (with its death clip, or as a ragdoll),
// sinking at the end.
const CORPSE_TIME = 9;
const RAGDOLL_TIME = 16;

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

// A random attack from a list, by `weight` (1 if not given).
function pickWeighted(list) {
  let total = 0;
  for (const a of list) total += a.weight || 1;
  let roll = Math.random() * total;
  for (const a of list) {
    roll -= a.weight || 1;
    if (roll <= 0) return a;
  }
  return list[list.length - 1];
}

// What a demon answers with off its guard: a plain blow, not a string's
// follow-up, a charge or a cast.
const riposte = (a) => !a.projectile && !a.comboOnly && !a.charge && !a.behind && !a.eruption;
