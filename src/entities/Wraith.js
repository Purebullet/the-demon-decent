import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Hurtbox } from '../physics/Hitbox.js';
import { softDotTexture } from '../world/Textures.js';
import { rand } from '../core/rng.js';

// The Grave Wraith: a ghoul with no body at all, only light. Its head, its
// chest, two long clawed arms and a tail that coils down into a whirl above
// the ground are drawn afresh every frame from particles (teal wisps, gold
// sparks, a dark smoke at its heart, two white eyes), so it streams and
// smears as it moves.
//
// It drifts round you, closing in to strike and hanging back while its
// blows come round again. Its blows:
//
//  - swipe   one arm raised and raked across in front of it.
//  - dive    it drifts back and up as it winds up, rises high, then
//            swoops forward and down through where you stand and out the
//            other side: anyone in its path is struck.
//  - grab    both arms spread wide, then it lunges; if it reaches you (not
//            your guard) it pours into you and is gone: held still for two
//            seconds, chilled by it a little at a time, the edges of your
//            sight full of its wisps (Hud.setGrip). Then it forms again a
//            few paces in front of you.

// How high it floats, how high it climbs before a dive, and how near you
// must come before it notices you.
const HOVER = 0.3;
const DIVE_HEIGHT = 3.8;
const WAKE = 15;
// The share of the dive's strike spent climbing (the rest is the swoop).
const RISE = 0.32;

// Linear colours (additive particles: the sum glows).
const TEAL = new THREE.Color(0.22, 0.95, 0.85);
const TEAL_HOT = new THREE.Color(0.75, 1.0, 1.0);
const TEAL_DIM = new THREE.Color(0.02, 0.22, 0.26);
const TEAL_DEEP = new THREE.Color(0.0, 0.08, 0.1);
const GOLD = new THREE.Color(1.5, 1.0, 0.35);
const WHITE = new THREE.Color(1, 1, 1);
const SMOKE = new THREE.Color(0.01, 0.035, 0.045);
// The haze round it, and its sparks (brighter than white allows: they sum).
const GLOW = new THREE.Color(0.06, 0.34, 0.33);
const GOLD_DIM = new THREE.Color(0.5, 0.22, 0.04);
const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
// Its right claw raised up and back for a swipe.
const SWIPE_UP = new THREE.Vector3(-1.0, 2.55, -0.35);
// Ribbons of light winding round it (each a point on a path that leaves a
// trail): two coiling down its tail, two circling its chest, two rising off
// its shoulders and streaming back over its head.
const STREAMERS = [
  { kind: 'coil', speed: 0.32, phase: 0 },
  { kind: 'coil', speed: 0.27, phase: 0.5 },
  { kind: 'orbit', speed: 2.6, phase: 0, r: 0.55, y: 1.8 },
  { kind: 'orbit', speed: -2.1, phase: 2, r: 0.62, y: 1.55 },
  { kind: 'rise', speed: 0.7, phase: 0, side: 1 },
  { kind: 'rise', speed: 0.62, phase: 0.45, side: -1 },
];

// One emit record, reused: it sheds near a thousand a second, and a fresh
// object for each would be that much garbage.
const E = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 0.1, sizeEnd: 0.03, color: null, colorEnd: null, alpha: 1, drag: 0.5, gravity: 0, turbulence: 0 };
function put(sys, p, vx, vy, vz, life, size, sizeEnd, color, colorEnd, alpha, drag, turbulence) {
  E.x = p.x;
  E.y = p.y;
  E.z = p.z;
  E.vx = vx;
  E.vy = vy;
  E.vz = vz;
  E.life = life;
  E.size = size;
  E.sizeEnd = sizeEnd;
  E.color = color;
  E.colorEnd = colorEnd;
  E.alpha = alpha;
  E.drag = drag;
  E.turbulence = turbulence;
  sys.emit(E);
}

const ease = (k) => k * k * (3 - 2 * k);
const easeOut = (k) => 1 - (1 - k) * (1 - k);

export const WRAITH_TYPE = {
  name: 'Grave Wraith',
  hp: 140,
  dmg: 10,
  speed: 3.6,
  radius: 0.45,
  poise: 40,
  mass: 0.8,
  role: 'swarmer',
  cooldown: 1.2,
  turnRate: 7,
  stride: 2,
  loot: { potion: 0, weapon: 0, spell: 0 },
  // Struck, it bleeds light, not blood.
  ichor: { color: TEAL_HOT, end: TEAL_DIM },
  buildModel: buildBody,
  attacks: [
    { name: 'swipe', windup: 0.42, strike: 0.2, recover: 0.55, dmg: 1, minRange: 0, maxRange: 2.7, volume: { c: [0, 1.5, 1.05], h: [1.1, 0.8, 0.95] }, lunge: 2.5, knockback: 3, weight: 1.6 },
    { name: 'dive', windup: 0.85, strike: 1.35, recover: 0.7, dmg: 1.4, minRange: 3, maxRange: 9.5, volume: null, knockback: 7, rest: 4, weight: 1.3 },
    { name: 'grab', windup: 0.8, strike: 0.3, recover: 0.6, dmg: 0.2, minRange: 0, maxRange: 4.2, volume: { c: [0, 1.5, 1.0], h: [0.8, 0.85, 1.0] }, lunge: 9, knockback: 0, latch: { dur: 2, dps: 0.4 }, rest: 8, weight: 1 },
  ],
};

// Its "model": no mesh at all, only the eyes (two glowing sprites) and a
// hurtbox round its head and chest. The rest is particles (Wraith._emit).
function buildBody() {
  const root = new THREE.Group();
  const eyes = [-1, 1].map((s) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
    sp.position.set(s * 0.075, 2.36, 0.17);
    sp.scale.setScalar(0.2);
    root.add(sp);
    return sp;
  });
  const hurt = new Hurtbox(root, new THREE.Vector3(0, 1.75, 0), new THREE.Vector3(0.45, 0.7, 0.42), { name: 'body' });
  return { root, eyes, mats: [], meshes: [], fire: [], bones: [], hurtboxes: [hurt], hitRadius: 0.9, height: 2.4, canRagdoll: false, ownDeath: false, j: {}, animate() {} };
}

export class Wraith extends Enemy {
  constructor(spawn, tuning) {
    super('wraith', spawn, tuning, WRAITH_TYPE);
    this.lift = HOVER;
    this.liftTo = HOVER;
    // Where its claws are (its own space), eased toward where they should be.
    this.hands = [new THREE.Vector3(-0.55, 1.45, 0.55), new THREE.Vector3(0.55, 1.45, 0.55)];
    this.acc = {};
    this.prev = new THREE.Vector3().copy(this.position);
    this.drift = new THREE.Vector3();
    this.gripK = 0;
    this.fade = 1;
    this.dive = null;
    this.t = 0;
    this._cy = 1;
    this._sy = 0;
    // Where each streamer was last frame (world), to draw its trail between.
    this.trail = STREAMERS.map(() => ({ at: new THREE.Vector3(), set: false }));
  }

  // ---------------------------------------------------------- behaviour ---

  update(dt, ctx) {
    const p = ctx.player;
    // It sees you coming from well off (it hangs in the open, glowing).
    if (this.state === 'dormant' && this.alive && !p.dead && Math.hypot(p.position.x - this.position.x, p.position.z - this.position.z) < WAKE) this.becomeAlert(ctx);
    super.update(dt, ctx);
    if (!this.alive) return;
    const a = this.attack;
    if (this.state === 'windup' && a) {
      const k = Math.min(1, this.stateT / Math.max(1e-3, this.stateDur));
      if (a.name === 'dive') {
        // Draws back and up, gathering itself.
        this.position.x -= Math.sin(this.yaw) * 2.4 * dt;
        this.position.z -= Math.cos(this.yaw) * 2.4 * dt;
        this.liftTo = HOVER + 0.8 * k;
      } else if (a.name === 'grab') this.liftTo = HOVER + 0.3 * k;
      else this.liftTo = HOVER;
    } else if (this.state !== 'strike') this.liftTo = HOVER;
  }

  // It flies: straight at you to strike, hanging back and circling while
  // its blows come round (no paths: walls and stones are nothing to it).
  _locomote(dt, ctx, dist) {
    const p = ctx.player.position;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    const l = Math.hypot(dx, dz) || 1;
    const ux = dx / l;
    const uz = dz / l;
    const ready = this.cooldown <= 0.3;
    const want = ready ? 1.7 : 4.4;
    const radial = THREE.MathUtils.clamp((dist - want) * 1.4, -1, 1);
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeSide *= -1;
      this.strafeT = rand(1.4, 2.8);
    }
    const side = (ready ? 0.2 : 0.6) * this.strafeSide;
    const sp = this.speed;
    const vx = (ux * radial - uz * side) * sp;
    const vz = (uz * radial + ux * side) * sp;
    const k = Math.min(1, dt * 3);
    this.vel.x += (vx - this.vel.x) * k;
    this.vel.z += (vz - this.vel.z) * k;
    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.z * dt;
    this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate);
    this.moveBlend = Math.min(1, Math.hypot(this.vel.x, this.vel.z) / sp);
  }

  _beginStrike(ctx) {
    const a = this.attack;
    if (a?.name !== 'dive') {
      super._beginStrike(ctx);
      return;
    }
    this.setState('strike', a.strike);
    this.dive = { from: this.position.clone(), to: new THREE.Vector3(), lift0: this.lift, aimed: false, hitAt: 0.6 };
    ctx.audio?.enemySwing(this.typeKey, this.position);
  }

  _updateStrike(dt, ctx) {
    const a = this.attack;
    if (a?.name !== 'dive') {
      super._updateStrike(dt, ctx);
      return;
    }
    const D = this.dive;
    const p = ctx.player;
    const k = Math.min(1, this.stateT / Math.max(1e-3, this.stateDur));
    if (k < RISE) {
      // Up into the air, keeping you in its sights.
      this.lift = D.lift0 + (DIVE_HEIGHT - D.lift0) * easeOut(k / RISE);
      this._turnToward(Math.atan2(p.position.x - this.position.x, p.position.z - this.position.z), dt, 8);
    } else {
      if (!D.aimed) {
        // Then down at where you are, and on past it.
        D.aimed = true;
        D.from.copy(this.position);
        const dx = p.position.x - this.position.x;
        const dz = p.position.z - this.position.z;
        const l = Math.hypot(dx, dz) || 1;
        const over = 2.6;
        D.to.set(p.position.x + (dx / l) * over, 0, p.position.z + (dz / l) * over);
        D.hitAt = l / (l + over);
        this.yaw = Math.atan2(dx, dz);
        ctx.audio?.whoosh?.(this.position);
      }
      const s = (k - RISE) / (1 - RISE);
      const e = s * s * (2 - s);
      this.position.x = D.from.x + (D.to.x - D.from.x) * e;
      this.position.z = D.from.z + (D.to.z - D.from.z) * e;
      // Down to chest height at you, then skimming up a little past.
      this.lift = e < D.hitAt ? DIVE_HEIGHT + (0.05 - DIVE_HEIGHT) * Math.pow(e / D.hitAt, 0.85) : 0.05 + 0.6 * ((e - D.hitAt) / Math.max(1e-3, 1 - D.hitAt));
      this.moveBlend = 1;
      if (!this.hitPlayer && !p.dead) {
        const d = Math.hypot(this.position.x - p.position.x, this.lift + 1.4 - (p.position.y + 1.1), this.position.z - p.position.z);
        if (d < 1.35) {
          this.hitPlayer = true;
          const landed = p.takeDamage(this.damage * a.dmg, this.position, a.knockback, ctx, this);
          // (Parried: thrown back, the dive is over.)
          if (this.state !== 'strike') return;
          if (landed === true) ctx.shake?.(0.35);
        }
      }
    }
    if (this.stateT >= this.stateDur) this.setState('recover', a.recover * Math.sqrt(this.tuning.windup));
  }

  // Its grab found you: it pours into you and is gone, holding you still.
  _latch(ctx, a) {
    const p = ctx.player;
    this.setState('latched', a.latch.dur);
    this.latchedOn = p;
    this.latchTick = 0.25;
    this.latchN = 0;
    p.pin(this, { still: true });
    this.hidden = true;
    for (const h of this.hurtboxes) h.obb.center.set(0, -999, 0);
    ctx.shake?.(0.3);
    ctx.audio?.telegraph?.(this.typeKey, this.position);
    // A rush of it into you.
    for (let i = 0; i < 90; i++) {
      const ang = rand(0, Math.PI * 2);
      const r = rand(0.8, 1.8);
      ctx.fx.add.emit({ x: p.position.x + Math.cos(ang) * r, y: rand(0.6, 2.4), z: p.position.z + Math.sin(ang) * r, vx: -Math.cos(ang) * r * 2, vy: 0, vz: -Math.sin(ang) * r * 2, life: rand(0.3, 0.6), size: rand(0.08, 0.18), sizeEnd: 0.03, color: TEAL_HOT, colorEnd: TEAL_DIM, drag: 1.5 });
    }
  }

  _updateLatch(dt, ctx) {
    const p = ctx.player;
    const a = this.attack;
    if (!a?.latch || p.dead || p.pinned?.by !== this) {
      this._reform(ctx, p);
      return;
    }
    this.position.set(p.position.x, 0, p.position.z);
    this.latchTick -= dt;
    if (this.latchTick <= 0) {
      this.latchTick = 0.3;
      // A cold seeping in: no blood, and a cry only now and then.
      p.maul(this.damage * a.latch.dps * 0.3, this.position, ctx, { chill: true, quiet: this.latchN++ % 3 !== 0 });
    }
    if (this.stateT >= this.stateDur) this._reform(ctx, p);
  }

  // Out of you again, a few paces in front, facing you.
  _reform(ctx, p) {
    this.hidden = false;
    this.position.set(p.position.x - Math.sin(p.yaw) * 2.6, 0, p.position.z - Math.cos(p.yaw) * 2.6);
    this.yaw = Math.atan2(p.position.x - this.position.x, p.position.z - this.position.z);
    this.vel.set(0, 0, 0);
    this.prev.copy(this.position);
    this.lift = HOVER;
    this.setState('recover', 0.9);
    for (let i = 0; i < 70; i++) {
      const ang = rand(0, Math.PI * 2);
      ctx.fx.add.emit({ x: this.position.x, y: rand(0.6, 2.4), z: this.position.z, vx: Math.cos(ang) * rand(1, 3), vy: rand(-0.5, 1), vz: Math.sin(ang) * rand(1, 3), life: rand(0.3, 0.7), size: rand(0.08, 0.18), sizeEnd: 0.03, color: TEAL_HOT, colorEnd: TEAL_DIM, drag: 2 });
    }
  }

  // Struck down: it comes apart into the air (no body, no blood).
  die(ctx) {
    this.alive = false;
    this.health = 0;
    this.status = {};
    this.hidden = false;
    ctx.director?.releaseToken(this);
    ctx.pathService?.cancel?.(this);
    this.attack = null;
    this.setState('dying', 1.6);
    for (let i = 0; i < 160; i++) {
      this._point(rand(0, 1), _p);
      ctx.fx.add.emit({ x: _p.x, y: _p.y, z: _p.z, vx: rand(-3, 3), vy: rand(0, 3), vz: rand(-3, 3), life: rand(0.6, 1.4), size: rand(0.08, 0.2), sizeEnd: 0.02, color: TEAL_HOT, colorEnd: TEAL_DEEP, drag: 1.2, turbulence: 3 });
    }
    ctx.audio?.death(this.typeKey, this.position);
    ctx.audio?.kill?.();
    ctx.shake?.(0.3);
    ctx.hitStop?.(0.08);
    ctx.onEnemyKilled?.(this);
  }

  _updateDying() {
    this.fade = Math.max(0, 1 - this.stateT / this.stateDur);
    if (this.stateT >= this.stateDur) this.removed = true;
  }

  // ------------------------------------------------------------- looks ---

  postUpdate(dt, ctx, time) {
    if (this.removed) return;
    if (!(this.state === 'strike' && this.attack?.name === 'dive')) this.lift += (this.liftTo - this.lift) * Math.min(1, dt * 4);
    this.root.position.y = this.lift + Math.sin(time * 1.7 + this.seed) * 0.08;
    this.root.rotation.y = this.yaw;
    this.drift.subVectors(this.position, this.prev).divideScalar(Math.max(1e-3, dt));
    this.prev.copy(this.position);
    this._cy = Math.cos(this.yaw);
    this._sy = Math.sin(this.yaw);
    this.t = time;
    this._pose(dt, time);
    this._emit(dt, ctx, time);
    // Its eyes, white-hot as it winds up a blow; gone with it.
    const wind = this.state === 'windup' ? Math.min(1, this.stateT / Math.max(1e-3, this.stateDur)) : 0;
    const eye = (1.4 + wind * 1.6 + this.flash * 1.5) * this.fade;
    for (const sp of this.model.eyes) {
      sp.visible = !this.hidden && this.fade > 0.05;
      sp.material.color.setRGB(0.75 * eye, eye, eye);
      sp.scale.setScalar(0.19 + 0.06 * wind);
    }
    this.root.updateMatrixWorld(true);
    if (this.alive && !this.hidden) for (const h of this.hurtboxes) h.update();
    this.gripK += ((this.state === 'latched' ? 1 : 0) - this.gripK) * Math.min(1, dt * (this.state === 'latched' ? 7 : 2.5));
  }

  // Where its claws should be, by what it is doing (its own space: x to its
  // left, y up from the ground, z ahead).
  _pose(dt, t) {
    const a = this.attack;
    const st = this.state;
    const k = this.stateDur > 0 ? Math.min(1, this.stateT / this.stateDur) : 0;
    const sway = Math.sin(t * 2.1 + this.seed) * 0.08;
    const L = _p.set(0.78, 1.72 + sway, 0.62);
    const R = _q.set(-0.78, 1.72 - sway, 0.62);
    let rate = 9;
    if (a && (st === 'windup' || st === 'strike')) {
      if (a.name === 'swipe') {
        // One arm (its right) drawn up and back, then raked across.
        if (st === 'windup') R.lerp(SWIPE_UP, ease(k));
        else {
          R.set(-1.0 + 1.7 * ease(k), 2.55 - 1.25 * ease(k), -0.35 + 1.5 * Math.sin(Math.PI * Math.min(1, k * 1.2)));
          rate = 30;
        }
      } else if (a.name === 'dive') {
        if (st === 'windup' || k < RISE) {
          // Swept back as it gathers itself and climbs.
          L.set(0.75, 2.3, -0.75);
          R.set(-0.75, 2.3, -0.75);
        } else {
          // Reaching ahead as it swoops.
          L.set(0.45, 1.75, 1.25);
          R.set(-0.45, 1.75, 1.25);
          rate = 20;
        }
      } else if (a.name === 'grab') {
        if (st === 'windup') {
          // Arms flung wide and up.
          L.set(1.3, 2.45, 0.15);
          R.set(-1.3, 2.45, 0.15);
        } else {
          L.set(0.32, 1.85, 1.5);
          R.set(-0.32, 1.85, 1.5);
          rate = 30;
        }
      }
    } else if (st === 'stagger') {
      L.set(0.8, 2.2, -0.5);
      R.set(-0.8, 2.2, -0.5);
      rate = 14;
    }
    const f = Math.min(1, dt * rate);
    this.hands[0].lerp(L, f);
    this.hands[1].lerp(R, f);
  }

  // A point of it in the world: its own space (x left, y up, z ahead).
  _w(lx, ly, lz, out) {
    out.x = this.position.x + lx * this._cy + lz * this._sy;
    out.y = this.root.position.y + ly;
    out.z = this.position.z - lx * this._sy + lz * this._cy;
    return out;
  }

  // Somewhere on its body, `u` from head (0) to the tip of its tail (1),
  // in the world (used for the burst it dies in).
  _point(u, out) {
    if (u < 0.3) return this._w(rand(-0.3, 0.3), 2.3 - u * 2.5, rand(-0.2, 0.2), out);
    const v = (u - 0.3) / 0.7;
    const r = this._spine(v, this.t, _s) * Math.sqrt(Math.random());
    const ang = rand(0, Math.PI * 2);
    return this._w(_s.x + Math.cos(ang) * r, _s.y, _s.z + Math.sin(ang) * r, out);
  }

  // The line its tail follows, `v` from the waist (0) to the tip (1), in
  // its own space: swaying side to side like a serpent, trailing back, and
  // thinning to nothing. Returns its thickness there.
  _spine(v, t, out) {
    out.set(0.3 * Math.sin(v * 5 - t * 2.4) * v, 1.4 - 1.22 * v + 0.12 * v * v * v, -0.05 - 0.8 * v * v);
    return 0.27 * (1 - v) + 0.03;
  }

  // Where streamer `S` is now, in the world.
  _streamer(S, t, out) {
    if (S.kind === 'coil') {
      // Winding down round its tail to the tip, and again from the waist.
      const v = (t * S.speed + S.phase) % 1;
      const ang = v * Math.PI * 7 + t * 3 + S.phase * 6;
      const r = this._spine(v, t, _s) + 0.07;
      return this._w(_s.x + Math.cos(ang) * r, _s.y, _s.z + Math.sin(ang) * r * 0.8, out);
    }
    if (S.kind === 'orbit') {
      const a = t * S.speed + S.phase;
      return this._w(Math.cos(a) * S.r, S.y + Math.sin(a * 1.7) * 0.25, Math.sin(a) * S.r * 0.8, out);
    }
    // Rising off a shoulder, curling up over the head and away behind.
    const v = (t * S.speed + S.phase) % 1;
    return this._w(S.side * (0.36 - 0.22 * v + 0.16 * Math.sin(v * 11 + t * 3)), 1.95 + 0.85 * v, 0.05 - 0.9 * v * v + 0.1 * Math.cos(v * 9), out);
  }

  // How many to emit this frame, at `rate` a second (carrying the rest).
  _n(key, rate, dt) {
    const a = (this.acc[key] || 0) + rate * dt;
    const n = Math.floor(a);
    this.acc[key] = a - n;
    return n;
  }

  _emit(dt, ctx, t) {
    const add = ctx.fx.add;
    const alpha = ctx.fx.alpha;
    if (this.hidden) {
      // Inside you: its wisps swirl round you.
      const p = ctx.player.position;
      for (let i = this._n('in', 70, dt); i > 0; i--) {
        const ang = rand(0, Math.PI * 2);
        const r = rand(1.0, 1.7);
        _p.set(p.x + Math.cos(ang) * r, p.y + rand(0.7, 2.3), p.z + Math.sin(ang) * r);
        put(add, _p, -Math.sin(ang) * 2.4, rand(-0.2, 0.4), Math.cos(ang) * 2.4, rand(0.4, 0.8), rand(0.08, 0.16), 0.03, TEAL, TEAL_DIM, 1, 0.6, 2);
      }
      return;
    }
    const fade = this.fade;
    const dying = !this.alive;
    const wind = this.state === 'windup' ? Math.min(1, this.stateT / Math.max(1e-3, this.stateDur)) : 0;
    // A blow just taken, or a blow being gathered: brighter, whiter.
    const heat = Math.min(1, wind * 0.6 + this.flash * 0.8);
    const core = _c.copy(TEAL).lerp(TEAL_HOT, heat);
    const gather = this.attack?.name === 'grab' && this.state === 'windup' ? 1 : 0;
    const out = dying ? 2.5 : 0;
    // Its particles move with it (most of its speed), so it holds its shape
    // as it flies; what trails (the tail's end, the wisps) keeps less.
    const dvx = dying ? 0 : this.drift.x;
    const dvz = dying ? 0 : this.drift.z;
    const cy = this._cy;
    const sy = this._sy;

    // A soft glow round it all (there is no bloom: this is its haze).
    for (let i = this._n('glow', 30 * fade, dt); i > 0; i--) {
      const u = Math.random();
      if (u < 0.3) this._w(rand(-0.1, 0.1), 2.3, 0.02, _p);
      else if (u < 0.7) this._w(rand(-0.15, 0.15), rand(1.5, 2.05), 0, _p);
      else this._point(rand(0.3, 0.75), _p);
      put(add, _p, dvx * 0.9, 0.1, dvz * 0.9, rand(0.5, 0.7), rand(0.95, 1.3), 1.4, GLOW, TEAL_DEEP, 0.55 * fade, 0.2, 0);
    }
    // Head.
    for (let i = this._n('head', 60 * fade, dt); i > 0; i--) {
      this._w(rand(-0.17, 0.17), 2.32 + rand(-0.16, 0.19), 0.05 + rand(-0.14, 0.14), _p);
      put(add, _p, dvx * 0.9 + rand(-0.25, 0.25) * (1 + out), rand(0.1, 0.4), dvz * 0.9 + rand(-0.25, 0.25) * (1 + out), rand(0.28, 0.45), rand(0.28, 0.4), 0.1, core, TEAL_DIM, 0.55, 0.3, 0.6);
    }
    // Its hood: wisps streaming back off the crown, like hair in water.
    for (let i = this._n('hood', 26 * fade, dt); i > 0; i--) {
      const a = rand(-1.3, 1.3);
      const lx = Math.sin(a) * 0.2;
      const lz = -Math.cos(a) * 0.12;
      this._w(lx, 2.42 + rand(-0.05, 0.12), lz, _p);
      const bz = -rand(0.5, 0.9);
      const bx = lx * 1.5;
      put(add, _p, dvx * 0.5 + bx * cy + bz * sy, rand(0.25, 0.6), dvz * 0.5 - bx * sy + bz * cy, rand(0.6, 0.9), rand(0.14, 0.2), 0.36, TEAL, TEAL_DEEP, 0.5, 0.5, 1.5);
    }
    // Chest, narrowing to the waist.
    for (let i = this._n('chest', 100 * fade, dt); i > 0; i--) {
      const u = Math.random();
      const r = (0.34 * (1 - u) + 0.17 * u) * Math.sqrt(Math.random());
      const ang = rand(0, Math.PI * 2);
      this._w(Math.cos(ang) * r * 1.15, 2.02 - 0.65 * u, -0.05 * u + Math.sin(ang) * r * 0.8, _p);
      const g = (gather ? -1.2 : 0.25) * (1 + out);
      put(add, _p, dvx * 0.9 + Math.cos(ang) * g, rand(0, 0.3), dvz * 0.9 + Math.sin(ang) * g, rand(0.28, 0.5), rand(0.26, 0.38), 0.08, core, TEAL_DIM, 0.5, 0.3, 0.8);
    }
    // The dark at its heart.
    for (let i = this._n('dark', 24 * fade, dt); i > 0; i--) {
      this._w(rand(-0.16, 0.16), rand(1.5, 2.25), rand(-0.12, 0.12), _p);
      put(alpha, _p, dvx * 0.9, 0.15, dvz * 0.9, rand(0.35, 0.6), 0.3, 0.42, SMOKE, SMOKE, 0.4, 0.3, 0);
    }
    // Arms: shoulder, bowed elbow, claws; four streaming fingers each.
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      const hx = this.hands[s].x;
      const hy = this.hands[s].y;
      const hz = this.hands[s].z;
      const sx = side * 0.4;
      const sy0 = 2.02;
      const ex = (sx + hx) * 0.5 + side * 0.28;
      const ey = (sy0 + hy) * 0.5 + 0.18;
      const ez = hz * 0.5 - 0.12;
      for (let i = this._n(`arm${s}`, 75 * fade, dt); i > 0; i--) {
        const u = Math.random();
        const a0 = (1 - u) * (1 - u);
        const a1 = 2 * (1 - u) * u;
        const a2 = u * u;
        const r = 0.08 * (1 - u) + 0.035;
        this._w(a0 * sx + a1 * ex + a2 * hx + rand(-r, r), a0 * sy0 + a1 * ey + a2 * hy + rand(-r, r), a1 * ez + a2 * hz + rand(-r, r), _p);
        put(add, _p, dvx * 0.95 + rand(-0.15, 0.15), rand(-0.1, 0.2), dvz * 0.95 + rand(-0.15, 0.15), rand(0.18, 0.34), rand(0.16, 0.24), 0.05, core, TEAL_DIM, 0.75, 0.3, 0.6);
      }
      // The claws: from the hand on, fanned out, hot at the tips.
      const fx = hx - ex;
      const fy = hy - ey;
      const fz = hz - ez;
      const fl = Math.hypot(fx, fy, fz) || 1;
      for (let i = this._n(`claw${s}`, 50 * fade, dt); i > 0; i--) {
        const finger = (Math.floor(Math.random() * 4) - 1.5) * 0.09;
        const along = rand(0, 0.4);
        this._w(hx + (fx / fl) * along + finger * side, hy + (fy / fl) * along - along * 0.25 + finger * 0.4, hz + (fz / fl) * along, _p);
        put(add, _p, dvx * 0.95, 0, dvz * 0.95, rand(0.14, 0.26), rand(0.1, 0.16), 0.03, along > 0.28 ? WHITE : TEAL_HOT, TEAL, 1, 0.3, 0);
      }
    }
    // The tail: thinning down from its waist in a serpent's sway, trailing
    // behind as it moves, its particles swirling round it.
    const spin = t * 3;
    for (let i = this._n('tail', 200 * fade, dt); i > 0; i--) {
      const v = Math.pow(Math.random(), 0.8);
      const r = this._spine(v, t, _s) * (0.55 + 0.45 * Math.random());
      const ang = rand(0, Math.PI * 2) + spin;
      this._w(_s.x + Math.cos(ang) * r, _s.y + rand(-0.04, 0.04), _s.z + Math.sin(ang) * r * 0.8, _p);
      // (The lower it is, the further it trails behind as it moves.)
      _p.x -= dvx * 0.1 * v;
      _p.z -= dvz * 0.1 * v;
      const keep = 0.9 - 0.45 * v;
      // Swirling round the spine: the tangent, turned into the world.
      const tan = 0.5 + r * 2.5;
      const lvx = -Math.sin(ang) * tan;
      const lvz = Math.cos(ang) * tan * 0.8;
      put(add, _p, dvx * keep + lvx * cy + lvz * sy + out * rand(-1, 1), rand(-0.05, 0.2), dvz * keep - lvx * sy + lvz * cy + out * rand(-1, 1), rand(0.3, 0.55), rand(0.2, 0.3) * (1 - v * 0.55), 0.04, core, TEAL_DEEP, 0.55, 0.5, 1);
    }
    // Long wisps streaming off its claws, head and the end of its tail.
    for (let i = this._n('wisp', 28 * fade, dt); i > 0; i--) {
      const pick = Math.random();
      if (pick < 0.5) {
        const h = this.hands[pick < 0.25 ? 0 : 1];
        this._w(h.x, h.y, h.z, _p);
      } else if (pick < 0.7) this._w(rand(-0.15, 0.15), 2.5, 0, _p);
      else this._point(rand(0.85, 1), _p);
      put(add, _p, dvx * 0.3 + rand(-0.4, 0.4), rand(0.2, 0.6), dvz * 0.3 + rand(-0.4, 0.4), rand(0.8, 1.3), rand(0.1, 0.14), 0.26, TEAL, TEAL_DEEP, 0.4, 0.9, 3);
    }
    // Its ribbons: each streamer's trail, laid from where it was to where
    // it is (a few points a frame, however long the frame).
    for (let k = 0; k < STREAMERS.length; k++) {
      this._streamer(STREAMERS[k], t, _q);
      const tr = this.trail[k];
      if (!tr.set || tr.at.distanceToSquared(_q) > 0.6) {
        tr.at.copy(_q);
        tr.set = true;
        continue;
      }
      const n = Math.min(5, Math.ceil(tr.at.distanceTo(_q) / 0.03));
      for (let j = 1; j <= n * fade; j++) {
        _p.lerpVectors(tr.at, _q, j / n);
        put(add, _p, dvx * 0.6, 0.05, dvz * 0.6, rand(0.4, 0.6), rand(0.08, 0.12), 0.02, TEAL, TEAL_DEEP, 0.75, 0.4, 0.4);
      }
      tr.at.copy(_q);
    }
    // Fine bright flecks all through it: the grain of the light.
    for (let i = this._n('fleck', 80 * fade, dt); i > 0; i--) {
      this._point(Math.random() * 0.9, _p);
      _p.x += rand(-0.18, 0.18);
      _p.z += rand(-0.18, 0.18);
      put(add, _p, dvx * 0.9 + rand(-0.2, 0.2), rand(0, 0.3), dvz * 0.9 + rand(-0.2, 0.2), rand(0.2, 0.4), rand(0.06, 0.1), 0.02, TEAL_HOT, TEAL, 1, 0.3, 1);
    }
    // Gold and white sparks in the haze.
    for (let i = this._n('spark', 46 * fade, dt); i > 0; i--) {
      this._point(Math.random(), _p);
      _p.x += rand(-0.3, 0.3);
      _p.z += rand(-0.3, 0.3);
      put(add, _p, dvx * 0.5 + rand(-0.4, 0.4), rand(0, 0.5), dvz * 0.5 + rand(-0.4, 0.4), rand(0.6, 1.1), rand(0.05, 0.09), 0.015, Math.random() < 0.7 ? GOLD : WHITE, GOLD_DIM, 1, 0.6, 2);
    }
    // Shadow of a grab gathering: wisps drawn in from all round to its arms.
    if (gather) {
      this._w(0, 1.9, 0.2, _t);
      for (let i = this._n('pull', 60, dt); i > 0; i--) {
        const ang = rand(0, Math.PI * 2);
        const r = rand(1.6, 2.6);
        this._w(Math.cos(ang) * r, rand(0.8, 2.8), Math.sin(ang) * r, _p);
        put(add, _p, (_t.x - _p.x) * 2.2, (_t.y - _p.y) * 2.2, (_t.z - _p.z) * 2.2, 0.45, 0.09, 0.03, TEAL_HOT, TEAL, 1, 0, 0);
      }
    }
  }
}
