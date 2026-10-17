import * as THREE from 'three';
import { Boss } from './Bosses.js';
import { angleDelta, rand } from '../core/rng.js';
import { C, burst, ring } from '../world/Particles.js';

// Azrakel, the Archfiend: the last lord, at the bottom of the tenth floor.
// He is not a wall of health to be whittled down. He is quick, springy and
// hard to touch, and he is beaten by reading him:
//
//  - His hide turns blows aside. A blow does full harm only while he is
//    OPEN (he glows like a forge): in the moments after one of his own
//    attacks, when you parry him (raise your block just as a claw lands),
//    when he crashes down from a pounce, or when his dash ends in a pillar
//    or a wall. Otherwise it glances off for a sliver of its weight.
//  - He sees a swing coming: swing at him while he circles and he springs
//    clear, often straight back at you. Bait him, then punish.
//  - He keeps his distance and circles, then darts in: a string of claw
//    rakes (parry any one of them), a dash straight through you (step
//    aside, ideally with a pillar behind you), a pounce onto where you are
//    heading (its landing is marked: get out of the ring), his tail round
//    in a full circle if you get behind him (parry it, or step back).
//  - Leave him alone and his wounds knit: he heals while nothing touches
//    him, though never back past a turn of the fight.
//  - At two-thirds and one-third of his health the fight turns: he leaps
//    away and roars (untouchable meanwhile), and comes back quicker. From
//    the second turn he howls a shockwave across the arena (Shade Step
//    through it); in the last he chains his pounces and each landing sets
//    the floor round it burning.

// A blow that lands while he is not open.
const GLANCE = 0.15;
// Health fractions where the fight turns.
const TURNS = [0.66, 0.33];
// Untouched this long, his wounds start to knit, this much of his health a second.
const REGEN_AFTER = 7;
const REGEN_RATE = 0.012;
// The chance, by phase, that he springs clear of a swing he sees coming.
const DODGE = [0.5, 0.62, 0.72];
// By phase: how much quicker his wind-ups, and his feet.
const QUICK = [1, 0.85, 0.72];
const FAST = [1, 1.1, 1.2];
// How far off he likes to circle.
const RING = 6.2;
const OPEN_COL = new THREE.Color(1, 0.45, 0.06);
const _v = new THREE.Vector3();

export class Archfiend extends Boss {
  constructor(key, spawn, tuning) {
    super(key, spawn, tuning);
    this.openT = 0;
    this.dodgeCd = 0;
    this.tailCd = 0;
    this.sinceHit = 0;
    this.healing = false;
    this.plan = null;
    this.planT = 0;
    this.closing = false;
    this.chain = 0;
    this.baseSpeed = this.speed;
    this.leapH = 0;
    this.was = this.state;
    this.glanceT = -9;
    this.lightHeight = 3.0;
  }

  get atk() {
    return this._atk || (this._atk = Object.fromEntries(this.type.attacks.map((a) => [a.name, a])));
  }

  // He wakes with a roar before he moves.
  becomeAlert(ctx) {
    if (this.state !== 'dormant') return;
    super.becomeAlert(ctx);
    this.setState('intro', 2.1);
    ctx.audio?.bossRoar?.(this.position);
    ctx.shake?.(0.35);
  }

  // His own phases (the base boss's are not his).
  _checkPhase() {}

  update(dt, ctx) {
    this.openT = Math.max(0, this.openT - dt);
    this.tailCd -= dt;
    this.sinceHit += dt;
    super.update(dt, ctx);
    if (!this.alive) return;
    // What starts as a state is entered.
    if (this.state !== this.was) {
      this._entered(this.state, this.was, ctx);
      this.was = this.state;
    }
    const p = ctx.player.position;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    if (this.state === 'intro') this._updateRoar(dt, ctx, dx, dz, () => this.setState('chase'));
    else if (this.state === 'turning') this._updateTurn(dt, ctx, dx, dz);
    else if (this.state === 'springing') this._updateSpring(dt, ctx);
    this._regen(dt, ctx);
    this._embers(dt, ctx);
  }

  _entered(state, from, ctx) {
    if (state === 'recover' && from === 'strike') {
      // After a blow, a moment to gather himself: open.
      this._open(this.stateDur + 0.1 + (this.attack?.open || 0), ctx);
    } else if (state === 'stagger') {
      this._open(this.stateDur + 0.3, ctx);
    } else if (state === 'chase') {
      this.plan = null;
      this.closing = false;
    }
  }

  _open(t, ctx) {
    const was = this.openT;
    this.openT = Math.max(this.openT, t);
    if (was <= 0.05 && this.openT > 0.3) ctx.onCombat?.('open', _v.set(this.position.x, 2.2, this.position.z).clone());
  }

  // ---------------------------------------------------------- damage ---

  damageTakenMul() {
    const base = super.damageTakenMul();
    if (this.state === 'intro' || this.state === 'turning') return 0;
    if (this.openT > 0) return base;
    // Caught winding up: half his hide (a counter's own bonus on top).
    if (this.state === 'windup') return base * 0.6;
    return base * GLANCE;
  }

  takeHit(amount, dir, knockback, stagger, ctx, opts = {}) {
    if (!this.alive) return 0;
    const mul = this.damageTakenMul();
    if (mul <= 0) {
      if (!opts.proc) this._glance(ctx, opts.contact, true);
      return 0;
    }
    // A turn of the fight is not passed by a blow: it stops at the line.
    const floor = this.phase < 3 ? this.maxHealth * TURNS[this.phase - 1] : 0;
    if (floor > 0 && this.health - amount * mul < floor) amount = Math.max(0, (this.health - floor) / mul);
    const glancing = mul < 0.5 && !opts.proc;
    const dealt = super.takeHit(amount, dir, knockback, stagger, ctx, opts);
    this.sinceHit = 0;
    if (this.healing) this.healing = false;
    if (glancing) this._glance(ctx, opts.contact, false);
    if (floor > 0 && this.alive && this.health <= floor + 0.5) this._beginTurn(ctx);
    return dealt;
  }

  _glance(ctx, at, untouchable) {
    const pt = at || _v.set(this.position.x, 1.6, this.position.z);
    burst(ctx.fx.add, pt, { count: 18, speed: 5, color: C.spark, colorEnd: C.fireEdge, size: 0.07, life: 0.3 });
    if (ctx.time - this.glanceT > 0.6) {
      this.glanceT = ctx.time;
      ctx.audio?.block?.();
      ctx.onCombat?.(untouchable ? 'untouchable' : 'glance', pt.clone ? pt.clone() : pt);
    }
  }

  // Parried: he reels, wide open.
  parried(ctx) {
    if (!this.alive) return;
    this.flash = 0.6;
    this.comboN = 99;
    this.interrupt(ctx, 0.85);
    this._open(1.4, ctx);
    ctx.audio?.bossImpact?.(this.position);
  }

  // A dash into rock: stunned, and wide open for a good while.
  _wallStun(ctx) {
    super._wallStun(ctx);
    this.setState('stagger', 2.4);
    this._open(2.8, ctx);
    ctx.audio?.bossImpact?.(this.position);
  }

  // He sees a swing coming and springs clear, often straight back at you.
  onPlayerSwing(ctx, heavy) {
    if (!this.alive || this.openT > 0 || this.dodgeCd > 0) return;
    const late = this.state === 'recover' && this.stateT > this.stateDur * 0.7;
    if (this.state !== 'chase' && !late) return;
    if (this.distToPlayer > 4.8) return;
    if (Math.random() > DODGE[this.phase - 1] * (heavy ? 1.15 : 1)) return;
    this.dodgeCd = rand(0.9, 1.6) / FAST[this.phase - 1];
    const answer = Math.random() < 0.35 + this.phase * 0.12;
    const follow = answer ? (Math.random() < 0.55 ? this.atk.lunge : this.atk.rake) : null;
    const side = Math.random() < 0.5 ? -1 : 1;
    const away = Math.random() < 0.6 ? 1 : 0.35;
    this._evade(ctx, { side: away < 1 ? side : side * 0.4, away, speed: 13, dur: 0.42, follow, followScale: 0.55 * QUICK[this.phase - 1] });
    this.leapH = 0.9;
    this.cooldown = Math.max(this.cooldown, 0.3);
  }

  // ------------------------------------------------------- movement ---

  // He keeps a ring round you he can spring from, circling, and closes only
  // to strike (or when he cannot see you).
  _locomote(dt, ctx, dist) {
    const p = ctx.player.position;
    const px = this.position.x;
    const pz = this.position.z;
    this.speed = this.baseSpeed * FAST[this.phase - 1];
    const los = ctx.nav.hasLineOfSight(px, pz, p.x, p.z, this.radius * 0.9, true);
    if (this.closing || !los || dist > RING + 7) {
      super._locomote(dt, ctx, dist);
      return;
    }
    const ox = (px - p.x) / (dist || 1);
    const oz = (pz - p.z) / (dist || 1);
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = rand(0.7, 1.7);
      if (Math.random() < 0.5) this.strafeSide = -this.strafeSide;
    }
    const radial = dist < RING - 0.8 ? 1 : dist > RING + 0.8 ? -1 : 0;
    let vx = -oz * this.strafeSide + ox * radial;
    let vz = ox * this.strafeSide + oz * radial;
    const l = Math.hypot(vx, vz) || 1;
    vx /= l;
    vz /= l;
    const speed = this.speed * 0.62;
    const blend = 1 - Math.exp(-8 * dt);
    this.vel.x += (vx * speed - this.vel.x) * blend;
    this.vel.z += (vz * speed - this.vel.z) * blend;
    const bx = this.position.x;
    const bz = this.position.z;
    ctx.world.move(this.position, this.radius, this.vel.x * dt, this.vel.z * dt);
    // Run into rock while circling: go round the other way.
    if (Math.hypot(this.position.x - bx, this.position.z - bz) < speed * dt * 0.3) this.strafeSide = -this.strafeSide;
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.moveBlend += (Math.min(1, sp / this.baseSpeed) - this.moveBlend) * Math.min(1, dt * 8);
    this.walkPhase += sp * dt * this.type.stride;
    this._turnToward(Math.atan2(p.x - px, p.z - pz), dt, this.type.turnRate);
  }

  _considerAttack(dt, ctx, dist) {
    const player = ctx.player;
    if (player.dead) return;
    const p = player.position;
    const off = Math.abs(angleDelta(this.yaw, Math.atan2(p.x - this.position.x, p.z - this.position.z)));
    const quick = QUICK[this.phase - 1];
    // Behind him, close: the tail, at once.
    if (dist < 4.4 && off > 1.7 && this.tailCd <= 0) {
      this.tailCd = 3.2;
      this._startAttack(this.atk.tail, ctx, quick);
      return;
    }
    // A fumbled swing in his reach: the claws, at once.
    if (player.exposed && dist < 4 && off < 1) {
      this._startAttack(this.atk.rake, ctx, 0.5);
      return;
    }
    if (this.cooldown > 0) return;
    if (!this.plan) {
      const can = (a) => (!a.minPhase || this.phase >= a.minPhase) && (a.weight || 0) > 0;
      const opts = this.type.attacks.filter((a) => can(a) && !a.comboOnly && !a.behind && dist <= a.maxRange + (a.name === 'rake' ? 6 : 0) && dist >= a.minRange - (a.name === 'rake' ? 99 : 0));
      if (!opts.length) return;
      let roll = Math.random() * opts.reduce((s, a) => s + a.weight, 0);
      this.plan = opts[opts.length - 1];
      for (const a of opts) if ((roll -= a.weight) <= 0) {
        this.plan = a;
        break;
      }
      this.planT = 0;
    }
    this.planT += dt;
    const a = this.plan;
    if (a.name === 'rake') {
      // Close in for the claws (a sprint), and strike once in reach.
      this.closing = true;
      if (dist <= 3.1 && off < 0.6) this._go(a, ctx, quick);
      else if (this.planT > 2.6) this.plan = null;
      return;
    }
    if (dist < a.minRange || dist > a.maxRange) {
      if (this.planT > 1.5) this.plan = null;
      return;
    }
    if (off > 0.35 || !ctx.nav.hasLineOfSight(this.position.x, this.position.z, p.x, p.z, 0.5)) {
      if (this.planT > 1.8) this.plan = null;
      return;
    }
    this._go(a, ctx, quick);
  }

  _go(a, ctx, quick) {
    this.plan = null;
    this.closing = false;
    this.chain = 0;
    this._startAttack(a, ctx, quick);
  }

  // A rake's string runs one blow longer in the last phase.
  _updateStrike(dt, ctx) {
    const a = this.attack;
    if (a.name === 'pounce') return this._updatePounce(dt, ctx);
    if (a.spin) return this._updateTail(dt, ctx);
    if (a.wave) return this._updateHowl(dt, ctx);
    const c = a.combo;
    if (c && this.phase === 3) {
      const saved = c.max;
      c.max = saved + 1;
      super._updateStrike(dt, ctx);
      c.max = saved;
      return;
    }
    super._updateStrike(dt, ctx);
  }

  _beginStrike(ctx) {
    const a = this.attack;
    super._beginStrike(ctx);
    if (this.state !== 'strike') return;
    const p = ctx.player;
    if (a.name === 'pounce') {
      // Onto where you are heading: the spot marked, then he comes down.
      const lead = 0.35;
      let tx = p.position.x + p.vel.x * lead;
      let tz = p.position.z + p.vel.z * lead;
      if (!ctx.nav.isWalkable(ctx.nav.tileX(tx), ctx.nav.tileZ(tz))) {
        tx = p.position.x;
        tz = p.position.z;
      }
      this.leapFrom = this.position.clone();
      this.leapTo = new THREE.Vector3(tx, 0, tz);
      ctx.effects.telegraph(tx, tz, a.aoe.radius, a.strike, null);
      ctx.audio?.whoosh?.(this.position);
    } else if (a.wave) {
      // The howl: a ring of force out across the floor.
      this.waveHit = false;
      ctx.effects.quake?.(this.position.x, this.position.z, a.wave, 0.7);
      ctx.audio?.bossRoar?.(this.position);
      ctx.shake?.(0.5);
    } else if (a.spin) {
      this.spinFrom = this.yaw;
      ctx.audio?.whoosh?.(this.position);
    }
  }

  _updatePounce(dt, ctx) {
    const a = this.attack;
    const k = Math.min(1, this.stateT / this.stateDur);
    this.position.x = this.leapFrom.x + (this.leapTo.x - this.leapFrom.x) * k;
    this.position.z = this.leapFrom.z + (this.leapTo.z - this.leapFrom.z) * k;
    this.root.position.y = Math.sin(k * Math.PI) * 4.5;
    this.yaw = Math.atan2(this.leapTo.x - this.leapFrom.x, this.leapTo.z - this.leapFrom.z) || this.yaw;
    this.root.rotation.y = this.yaw;
    if (k < 1) return;
    this.root.position.y = 0;
    ctx.world.resolve(this.position, this.radius);
    this._impact(ctx, a.aoe);
    ctx.effects.quake?.(this.position.x, this.position.z, a.aoe.radius * 1.4, 0.75);
    ctx.audio?.bossImpact?.(this.position);
    // The last phase: the floor round his landing catches fire, and he may
    // spring again at once.
    if (this.phase === 3) {
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2 + rand(-0.2, 0.2);
        const x = this.position.x + Math.sin(ang) * 4.4;
        const z = this.position.z + Math.cos(ang) * 4.4;
        if (ctx.nav.isWalkable(ctx.nav.tileX(x), ctx.nav.tileZ(z))) ctx.effects.fireStrike(x, z, 1.5, 0.8, this.damage * 0.4, ctx);
      }
      if (this.chain < 2 && Math.random() < 0.6 && this.distToPlayer > a.minRange * 0.6) {
        this.chain++;
        this._startAttack(a, ctx, 0.5, true);
        return;
      }
    }
    this.setState('recover', a.recover * Math.sqrt(this.tuning.windup));
  }

  _updateTail(dt, ctx) {
    const a = this.attack;
    const k = Math.min(1, this.stateT / this.stateDur);
    // One whole turn, quickest in the middle.
    this.yaw = this.spinFrom + Math.PI * 2 * (k * k * (3 - 2 * k));
    this.root.rotation.y = this.yaw;
    const player = ctx.player;
    if (!this.hitPlayer && k > 0.25 && k < 0.85 && this.distToPlayer < a.maxRange + player.radius) {
      // The tail sweeps past where you stand.
      const toP = Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z);
      if (Math.abs(angleDelta(this.yaw + Math.PI, toP)) < 0.9) {
        this.hitPlayer = true;
        player.takeDamage(this.damage * a.dmg, this.position, a.knockback, ctx, this);
        if (this.state !== 'strike') return;
      }
    }
    if (k >= 1) this.setState('recover', a.recover);
  }

  _updateHowl(dt, ctx) {
    const a = this.attack;
    const k = Math.min(1, this.stateT / this.stateDur);
    const r = a.wave * (1 - (1 - k) * (1 - k));
    const player = ctx.player;
    const d = this.distToPlayer;
    if (!this.waveHit && Math.abs(d - r) < 0.8) {
      this.waveHit = true;
      // Unblockable force: only a Shade Step's moment of shadow passes it.
      player.takeDamage(this.damage * a.dmg, this.position, 9, ctx);
    }
    if (Math.random() < dt * 40) {
      const ang = Math.random() * Math.PI * 2;
      ctx.fx.alpha.emit({ x: this.position.x + Math.sin(ang) * r, y: 0.3, z: this.position.z + Math.cos(ang) * r, vy: 1.2, life: 0.5, size: 0.8, sizeEnd: 1.6, color: C.smoke, colorEnd: C.smoke, alpha: 0.4, drag: 2 });
    }
    if (k >= 1) this.setState('recover', a.recover);
  }

  // ------------------------------------------------- turns of the fight ---

  _beginTurn(ctx) {
    if (this.state === 'turning') return;
    ctx.director.releaseToken(this);
    this.attack = null;
    this.plan = null;
    this.openT = 0;
    this.leapH = 0;
    this.pose = null;
    // Away from you, across the arena, to roar.
    const p = ctx.player.position;
    let best = null;
    for (let i = 0; i < 16; i++) {
      const ang = Math.atan2(this.position.x - p.x, this.position.z - p.z) + rand(-1.1, 1.1);
      const r = rand(9, 13);
      const x = p.x + Math.sin(ang) * r;
      const z = p.z + Math.cos(ang) * r;
      if (!ctx.nav.isWalkable(ctx.nav.tileX(x), ctx.nav.tileZ(z))) continue;
      best = new THREE.Vector3(x, 0, z);
      break;
    }
    this.leapFrom = this.position.clone();
    this.leapTo = best || this.position.clone();
    this.turnStep = 0;
    this.setState('turning', 0.7);
    ctx.audio?.whoosh?.(this.position);
  }

  _updateTurn(dt, ctx, dx, dz) {
    if (this.turnStep === 0) {
      // The leap away.
      const k = Math.min(1, this.stateT / this.stateDur);
      this.position.x = this.leapFrom.x + (this.leapTo.x - this.leapFrom.x) * k;
      this.position.z = this.leapFrom.z + (this.leapTo.z - this.leapFrom.z) * k;
      this.root.position.y = Math.sin(k * Math.PI) * 3.5;
      this.pose = { name: 'hop', u: k, rate: 20 };
      this.moveBlend = 0;
      if (k >= 1) {
        this.root.position.y = 0;
        ctx.world.resolve(this.position, this.radius);
        ctx.effects.quake?.(this.position.x, this.position.z, 3.5, 0.5);
        this.turnStep = 1;
        this.stateT = 0;
        this.stateDur = 2.0;
        this.phase++;
        ctx.audio?.bossRoar?.(this.position);
        ctx.shake?.(0.6);
        ctx.announce?.(this.phase === 2 ? 'Azrakel’s mane catches fire!' : 'Azrakel is frenzied!', this.phase === 2 ? 'He howls now: Shade Step through the shockwave' : 'His pounces come in strings, and the floor burns where he lands');
        for (const e of this.emitters) e.rate *= 1.6;
        // A blast of force: it throws you back, it does not hurt.
        const p = ctx.player;
        const d = Math.hypot(p.position.x - this.position.x, p.position.z - this.position.z) || 1;
        if (d < 8) p.knock?.add?.(_v.set((p.position.x - this.position.x) / d, 0, (p.position.z - this.position.z) / d).multiplyScalar(9));
        ring(ctx.fx.add, _v.set(this.position.x, 0.4, this.position.z), 8, { count: 60, speed: 14, size: 0.5, life: 0.8 });
      }
      return;
    }
    this._updateRoar(dt, ctx, dx, dz, () => {
      this.cooldown = 0.4;
      this.setState('chase');
    });
  }

  _updateRoar(dt, ctx, dx, dz, done) {
    const k = Math.min(1, this.stateT / this.stateDur);
    this.pose = { name: 'roar', u: k, rate: 10 };
    this.moveBlend = Math.max(0, this.moveBlend - dt * 6);
    this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate * 0.5);
    if (Math.random() < dt * 25) {
      _v.set(this.position.x + Math.sin(this.yaw) * 1.2, 2.6, this.position.z + Math.cos(this.yaw) * 1.2);
      burst(ctx.fx.add, _v, { count: 2, speed: 3, color: C.fireCore, colorEnd: C.emberRed, size: 0.15, life: 0.6, up: 2 });
    }
    if (k >= 1) {
      this.pose = null;
      done();
    }
  }

  setState(s, dur = 0) {
    if (s !== 'turning' && s !== 'intro' && this.pose && (this.state === 'turning' || this.state === 'intro')) this.pose = null;
    super.setState(s, dur);
  }

  // Left alone, his wounds knit (never past a turn of the fight).
  _regen(dt, ctx) {
    if (this.sinceHit < REGEN_AFTER || this.state === 'turning' || this.state === 'intro' || this.state === 'dormant' || ctx.player.dead) return;
    const cap = this.phase === 1 ? this.maxHealth : this.maxHealth * TURNS[this.phase - 2];
    if (this.health >= cap) return;
    if (!this.healing) {
      this.healing = true;
      ctx.toast?.('Azrakel’s wounds knit while nothing touches him: press him!');
    }
    this.health = Math.min(cap, this.health + this.maxHealth * REGEN_RATE * dt);
    if (Math.random() < dt * 14) burst(ctx.fx.add, _v.set(this.position.x + rand(-0.8, 0.8), rand(0.5, 2.6), this.position.z + rand(-0.8, 0.8)), { count: 1, speed: 0.6, color: C.emberRed, colorEnd: C.fireEdge, size: 0.12, life: 0.9, up: 2 });
  }

  // Embers off his mane, more of them the further the fight has turned.
  _embers(dt, ctx) {
    if (this.phase < 2 || Math.random() > dt * (this.phase === 2 ? 18 : 34)) return;
    const head = this.model.bones?.find?.((b) => b.name === 'Neck');
    if (head) head.getWorldPosition(_v);
    else _v.set(this.position.x, 2.4, this.position.z);
    ctx.fx.add.emit({ x: _v.x + rand(-0.6, 0.6), y: _v.y + rand(0, 0.6), z: _v.z + rand(-0.6, 0.6), vy: 1.5 + Math.random(), life: 0.8, size: 0.14, sizeEnd: 0.03, color: C.fireCore, colorEnd: C.emberRed, turbulence: 1 });
  }

  // Open: he glows like iron in the forge.
  _applyTint(dt, ctx, time) {
    if (this.openT > 0 && this.alive && this.state !== 'windup' && this.flash < 0.1) {
      const k = 0.3 + 0.12 * Math.sin(time * 12);
      this._tinted = true;
      this.model.mats.forEach((m, i) => {
        const b = this.baseEmissive[i];
        m.emissive.copy(b.c).lerp(OPEN_COL, k);
        m.emissiveIntensity = b.i + k * 0.7;
      });
      return;
    }
    super._applyTint(dt, ctx, time);
  }
}
