import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Hurtbox } from '../physics/Hitbox.js';
import { softDotTexture } from '../world/Textures.js';
import { rand } from '../core/rng.js';
import { Strands, TONE_TEAL, TONE_GOLD, TONE_HOT, TONE_GLOW } from './WraithBody.js';

// The Grave Wraith: a ghoul with no body at all, only light. It is drawn
// from strands (WraithBody.js) laid afresh every frame: a skull with
// slanted white eyes and hair streaming up off it like flame, a ribbed
// chest, long arms with hooked claws and tendrils trailing from them, and
// a tail that flows down out of its chest into a wide whirl, trailing
// behind it as it moves. Glitter (gold in the tail) runs along the strands
// and drifts off them.
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

// Linear colours (additive: the sum glows).
const TEAL = new THREE.Color(0.3, 0.92, 0.82);
const TEAL_HOT = new THREE.Color(0.8, 1.0, 1.0);
const TEAL_DIM = new THREE.Color(0.03, 0.25, 0.25);
const TEAL_DEEP = new THREE.Color(0.0, 0.08, 0.1);
const GOLD = new THREE.Color(1.5, 1.0, 0.35);
const GOLD_DIM = new THREE.Color(0.5, 0.22, 0.04);
const WHITE = new THREE.Color(1, 1, 1);
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _t = new THREE.Vector3();
// Its right claw raised up and back for a swipe.
const SWIPE_UP = new THREE.Vector3(-1.0, 2.55, -0.35);

// Its strands, by what they make of it.
const BODY = 0;
const HAIR = 1;
const FACE = 2;
const RIB = 3;
const ARM = 4;
const FINGER = 5;
const TENDRIL = 6;
const SKULL = 7;
// The share of a body strand that is chest (the rest is tail).
const TORSO = 0.2;
// How far back in time its tail and hair can trail (seconds), in steps.
const LAG_STEP = 0.05;
const LAGS = 11;
const HIST = 72;

// One emit record, reused: it sheds hundreds a second, and a fresh object
// for each would be that much garbage.
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
const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

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

// Each of its strands, with what shapes it (Wraith._shape). Most weave in
// and out of one another (`f1`, `f2`, `p1`, `p2`), so none run straight
// alongside the next; the glow strands are wide, faint and soft, its haze.
function strandSpecs() {
  const r = Math.random;
  const S = [];
  const weave = () => ({ f1: rand(3, 7), f2: rand(5, 11), p1: r() * 6.3, p2: r() * 6.3 });
  // Chest into tail: the bulk of it. Some come away from the tail near its end.
  for (let j = 0; j < 56; j++) S.push({ kind: BODY, n: 36, w0: rand(0.012, 0.03), w1: 0.005, a: rand(0.3, 0.7), aIn: 0.5, tone: r() < 0.3 ? TONE_GOLD : TONE_TEAL, seed: r(), rho: Math.sqrt(r()), phi: r() * Math.PI * 2, cross: rand(-2.6, 2.6), twist: rand(2.2, 3.8), peel: r() < 0.35 ? rand(0.15, 0.5) : 0, ...weave() });
  for (let j = 0; j < 7; j++) S.push({ kind: BODY, n: 24, w0: rand(0.22, 0.3), w1: 0.06, a: 0.15, tone: TONE_GLOW, seed: r(), rho: Math.sqrt(r()) * 0.5, phi: r() * Math.PI * 2, cross: 0, twist: 2.5, peel: 0, ...weave() });
  // The skull: arcs over its crown from temple to temple.
  for (let j = 0; j < 3; j++) S.push({ kind: SKULL, z: 0.07 - j * 0.08, n: 12, w0: 0.022, w1: 0.022, a: 0.55, tone: TONE_TEAL, seed: r(), fadeIn: false });
  // Hair: off the crown and the back of the skull, streaming up like flame.
  for (let j = 0; j < 20; j++) S.push({ kind: HAIR, n: 18, w0: rand(0.016, 0.03), w1: 0.004, a: rand(0.35, 0.8), tone: r() < 0.15 ? TONE_GOLD : TONE_TEAL, seed: r(), lat: rand(-1, 1), al: rand(1.0, 2.3), len: rand(0.5, 1.25), ...weave() });
  for (let j = 0; j < 3; j++) S.push({ kind: HAIR, n: 14, w0: 0.2, w1: 0.05, a: 0.13, tone: TONE_GLOW, seed: r(), lat: rand(-0.6, 0.6), al: 1.6, len: 0.8, ...weave() });
  // The face: brows, cheeks and jaw, the bone under the eyes.
  for (const side of [1, -1]) {
    S.push({ kind: FACE, part: 0, side, n: 7, w0: 0.03, w1: 0.016, a: 0.85, tone: TONE_HOT, seed: r(), fadeIn: false });
    S.push({ kind: FACE, part: 1, side, n: 10, w0: 0.026, w1: 0.012, a: 0.7, tone: TONE_TEAL, seed: r(), fadeIn: false });
    S.push({ kind: FACE, part: 2, side, n: 7, w0: 0.022, w1: 0.012, a: 0.6, tone: TONE_TEAL, seed: r() });
  }
  // Ribs.
  for (const side of [1, -1]) for (let row = 0; row < 4; row++) S.push({ kind: RIB, side, row, n: 9, w0: 0.024, w1: 0.01, a: 0.55, tone: TONE_TEAL, seed: r() });
  // Arms: the arm and its glow, four claws, tendrils trailing off it.
  for (const hand of [0, 1]) {
    const side = hand === 0 ? 1 : -1;
    for (let j = 0; j < 8; j++) S.push({ kind: ARM, hand, side, n: 16, w0: rand(0.02, 0.034), w1: 0.012, a: rand(0.4, 0.8), tone: TONE_TEAL, seed: r(), rho: Math.sqrt(r()), phi: r() * Math.PI * 2, ...weave() });
    S.push({ kind: ARM, hand, side, n: 12, w0: 0.2, w1: 0.1, a: 0.13, tone: TONE_GLOW, seed: r(), rho: 0, phi: 0, ...weave() });
    for (let f = 0; f < 4; f++) S.push({ kind: FINGER, hand, side, f, n: 9, w0: 0.024, w1: 0.004, a: 0.95, tone: TONE_HOT, seed: r(), fadeIn: false });
    for (let j = 0; j < 7; j++) S.push({ kind: TENDRIL, hand, side, at: 0.3 + j * 0.1, n: 16, w0: rand(0.014, 0.026), w1: 0.003, a: rand(0.35, 0.7), tone: r() < 0.3 ? TONE_GOLD : TONE_TEAL, seed: r(), len: rand(0.7, 1.4), out: rand(0.7, 1), up: rand(0.0, 0.7), back: rand(0.2, 0.7), curl: rand(0.15, 0.45), ...weave() });
  }
  return S;
}

// Its "model": its strands, its eyes (sprites: a slanted white-hot core
// and a blue glow each) and a hurtbox round its head and chest.
function buildBody() {
  const root = new THREE.Group();
  const strands = new Strands(strandSpecs());
  root.add(strands.mesh);
  const eye = (color, scale) => new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
  const eyes = [];
  const glows = [];
  for (const s of [1, -1]) {
    const core = eye(0xffffff);
    core.position.set(s * 0.068, 2.29, 0.18);
    core.scale.set(0.1, 0.055, 1);
    core.material.rotation = -s * 0.32;
    const glow = eye(0x2a8cb0);
    glow.position.set(s * 0.068, 2.29, 0.17);
    glow.scale.setScalar(0.2);
    root.add(glow, core);
    eyes.push(core);
    glows.push(glow);
  }
  const hurt = new Hurtbox(root, new THREE.Vector3(0, 1.75, 0), new THREE.Vector3(0.45, 0.7, 0.42), { name: 'body' });
  return { root, strands, eyes, glows, mats: [], meshes: [], fire: [], bones: [], hurtboxes: [hurt], hitRadius: 0.9, height: 2.4, canRagdoll: false, ownDeath: false, j: {}, animate() {} };
}

export class Wraith extends Enemy {
  constructor(spawn, tuning) {
    super('wraith', spawn, tuning, WRAITH_TYPE);
    this.lift = HOVER;
    this.liftTo = HOVER;
    // Where its claws are (its own space), eased toward where they should be.
    this.hands = [new THREE.Vector3(0.85, 1.98, 0.65), new THREE.Vector3(-0.8, 1.6, 0.8)];
    this.acc = {};
    this.prev = new THREE.Vector3().copy(this.position);
    this.drift = new THREE.Vector3();
    this.gripK = 0;
    this.fade = 1;
    this.dive = null;
    this.t = 0;
    this._cy = 1;
    this._sy = 0;
    this.strands = this.model.strands;
    // Where it has been (time, x, y, z, facing), for what trails behind.
    this.hist = new Float32Array(HIST * 5);
    this.histN = 0;
    this.histI = 0;
    // How far behind (its own space) each step back in time leaves a
    // strand, and how far it has turned since.
    this.lagX = new Float32Array(LAGS);
    this.lagY = new Float32Array(LAGS);
    this.lagZ = new Float32Array(LAGS);
    this.lagC = new Float32Array(LAGS).fill(1);
    this.lagS = new Float32Array(LAGS);
    // The ends its wisps peel off, its claw tips, and which strands carry gold.
    this.tips = [];
    this.clawTips = [];
    this.tones = new Uint8Array(this.strands.count);
    for (const sp of this.strands.specs) {
      const last = sp.start + sp.n - 1;
      if (sp.kind === FINGER) this.clawTips.push(last);
      else if ((sp.kind === HAIR || sp.kind === TENDRIL || sp.kind === BODY) && sp.tone !== TONE_GLOW) this.tips.push(last);
      this.tones.fill(sp.tone, sp.start, last + 1);
    }
  }

  // Taken off the field: its strands' buffers go with it.
  dispose() {
    this.strands.dispose();
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
      _p.set(p.position.x + Math.cos(ang) * r, rand(0.6, 2.4), p.position.z + Math.sin(ang) * r);
      put(ctx.fx.add, _p, -Math.cos(ang) * r * 2, 0, -Math.sin(ang) * r * 2, rand(0.3, 0.6), rand(0.04, 0.07), 0.015, Math.random() < 0.25 ? GOLD : TEAL_HOT, TEAL_DIM, 1, 1.5, 0);
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
    // (Nothing of where it was trails after it.)
    this.histN = 0;
    this.setState('recover', 0.9);
    for (let i = 0; i < 90; i++) {
      const ang = rand(0, Math.PI * 2);
      _p.set(this.position.x, rand(0.6, 2.4), this.position.z);
      put(ctx.fx.add, _p, Math.cos(ang) * rand(1, 3), rand(-0.5, 1), Math.sin(ang) * rand(1, 3), rand(0.3, 0.7), rand(0.04, 0.07), 0.015, Math.random() < 0.25 ? GOLD : TEAL_HOT, TEAL_DIM, 1, 2, 0);
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
    // A burst of its glitter (its strands come apart as it fades: _shape).
    for (let i = 0; i < 220; i++) {
      this._at((Math.random() * this.strands.count) | 0, _p);
      put(ctx.fx.add, _p, rand(-2.5, 2.5), rand(0, 2.5), rand(-2.5, 2.5), rand(0.6, 1.4), rand(0.03, 0.06), 0.01, Math.random() < 0.3 ? GOLD : TEAL_HOT, TEAL_DEEP, 1, 1.2, 3);
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
    this._record(time);
    const S = this.strands;
    S.mesh.visible = !this.hidden && this.fade > 0.01;
    // (Its strands are laid only while it can be seen: in front of you, or
    // near enough that some of it might be.)
    const pl = ctx.player;
    const dx = this.position.x - pl.position.x;
    const dz = this.position.z - pl.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const seen = d < 6 || -(Math.sin(pl.yaw) * dx + Math.cos(pl.yaw) * dz) / d > 0.1;
    if (S.mesh.visible && seen) {
      this._lags(time);
      this._shape(time);
      S.commit();
    }
    // Brighter and whiter as it gathers a blow, or is struck.
    const wind = this.state === 'windup' ? Math.min(1, this.stateT / Math.max(1e-3, this.stateDur)) : 0;
    const U = S.material.uniforms;
    U.uTime.value = time;
    U.uFade.value = this.fade;
    U.uHeat.value = Math.min(0.6, wind * 0.35 + this.flash * 0.6);
    // (Drawn to the same scale and fog as the particles.)
    const fu = ctx.fx.add.material.uniforms;
    U.uPixel.value = 1 / Math.max(1, fu.uScale.value);
    U.uFogDensity.value = fu.uFogDensity.value;
    this._emit(dt, ctx, time);
    // Its eyes, white-hot as it winds up a blow; gone with it.
    const eye = (1.2 + wind * 1.4 + this.flash * 1.2) * this.fade;
    for (let i = 0; i < 2; i++) {
      const core = this.model.eyes[i];
      const glow = this.model.glows[i];
      core.visible = glow.visible = !this.hidden && this.fade > 0.05;
      core.material.color.setRGB(0.85 * eye, eye, eye);
      glow.material.color.setRGB(0.14 * eye, 0.5 * eye, 0.68 * eye);
      glow.scale.setScalar(0.17 + 0.1 * wind);
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
    // At rest: arms out and forward, one higher, claws reaching for you.
    const L = _p.set(0.85, 1.98 + sway, 0.65);
    const R = _q.set(-0.8, 1.6 - sway, 0.8);
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
          L.set(0.8, 2.3, -0.75);
          R.set(-0.8, 2.3, -0.75);
        } else {
          // Reaching ahead as it swoops.
          L.set(0.45, 1.75, 1.25);
          R.set(-0.45, 1.75, 1.25);
          rate = 20;
        }
      } else if (a.name === 'grab') {
        if (st === 'windup') {
          // Arms flung wide and up.
          L.set(1.35, 2.45, 0.15);
          R.set(-1.35, 2.45, 0.15);
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

  // Strand point `k`, in the world.
  _at(k, out) {
    const p = this.strands.pts;
    return this._w(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], out);
  }

  // ------------------------------------------------- what trails behind ---

  // Where it has been (a sample every sixtieth of a second at most).
  _record(time) {
    const H = this.hist;
    if (this.histN && time - H[((this.histI - 1 + HIST) % HIST) * 5] < 0.015) return;
    const i = this.histI * 5;
    H[i] = time;
    H[i + 1] = this.position.x;
    H[i + 2] = this.root.position.y;
    H[i + 3] = this.position.z;
    H[i + 4] = this.yaw;
    this.histI = (this.histI + 1) % HIST;
    this.histN = Math.min(HIST, this.histN + 1);
  }

  // For each step back in time: where it was then, from where it is now
  // (in its own space, at most 3 m), and how far it has turned since.
  _lags(time) {
    const H = this.hist;
    const n = this.histN;
    const at = (j) => ((this.histI - 1 - j + HIST * 2) % HIST) * 5;
    let j = 0;
    for (let k = 0; k < LAGS; k++) {
      let ox = 0;
      let oy = 0;
      let oz = 0;
      let d = 0;
      if (k > 0 && n > 1) {
        const target = time - k * LAG_STEP;
        while (j < n - 1 && H[at(j)] > target) j++;
        const a = at(j);
        let hx = H[a + 1];
        let hy = H[a + 2];
        let hz = H[a + 3];
        let hyaw = H[a + 4];
        if (j > 0 && H[a] < target) {
          const b = at(j - 1);
          const w = (target - H[a]) / Math.max(1e-6, H[b] - H[a]);
          hx += (H[b + 1] - hx) * w;
          hy += (H[b + 2] - hy) * w;
          hz += (H[b + 3] - hz) * w;
          const dy = H[b + 4] - hyaw;
          hyaw += Math.atan2(Math.sin(dy), Math.cos(dy)) * w;
        }
        ox = hx - this.position.x;
        oy = hy - this.root.position.y;
        oz = hz - this.position.z;
        const l = Math.hypot(ox, oy, oz);
        if (l > 3) {
          ox *= 3 / l;
          oy *= 3 / l;
          oz *= 3 / l;
        }
        d = hyaw - this.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d)) * 0.85;
      }
      this.lagX[k] = ox * this._cy - oz * this._sy;
      this.lagY[k] = oy;
      this.lagZ[k] = ox * this._sy + oz * this._cy;
      this.lagC[k] = Math.cos(d);
      this.lagS[k] = Math.sin(d);
    }
  }

  // Lays strand point `i` at (x, y, z) of it as it was `L` seconds ago.
  _place(i, x, y, z, L) {
    const f = Math.min(LAGS - 1.0001, Math.max(0, L / LAG_STEP));
    const k = f | 0;
    const w = f - k;
    const c = this.lagC[k] + (this.lagC[k + 1] - this.lagC[k]) * w;
    const s = this.lagS[k] + (this.lagS[k + 1] - this.lagS[k]) * w;
    const ox = this.lagX[k] + (this.lagX[k + 1] - this.lagX[k]) * w;
    const oy = this.lagY[k] + (this.lagY[k + 1] - this.lagY[k]) * w;
    const oz = this.lagZ[k] + (this.lagZ[k + 1] - this.lagZ[k]) * w;
    this.strands.set(i, x * c + z * s + ox, y + oy, -x * s + z * c + oz);
  }

  // ------------------------------------------------------- its strands ---

  _shape(t) {
    const loose = 1 - this.fade;
    // Where its chest flows into its tail.
    this._spiral(0, t, _t);
    const t0x = _t.x;
    const t0y = _t.y;
    const t0z = _t.z;
    this._armFrame(0);
    this._armFrame(1);
    for (const sp of this.strands.specs) {
      if (sp.kind === BODY) this._bodyStrand(sp, t, loose, t0x, t0y, t0z);
      else if (sp.kind === HAIR) this._hairStrand(sp, t, loose);
      else if (sp.kind === FACE) this._faceStrand(sp, loose);
      else if (sp.kind === SKULL) this._skullStrand(sp, loose);
      else if (sp.kind === RIB) this._ribStrand(sp, t, loose);
      else if (sp.kind === ARM) this._armStrand(sp, t, loose);
      else if (sp.kind === FINGER) this._fingerStrand(sp, loose);
      else this._tendrilStrand(sp, t, loose);
    }
  }

  // The line its tail follows, from where its chest ends (0) to the tip
  // (1): down from its waist and round in a wide whirl below it, the tip
  // curling into the middle. Returns how thick the tail is there; leaves
  // which way round it is heading in `_th`.
  _spiral(v, t, out) {
    const th = 3.6 + v * 2.5 * Math.PI + 0.35 * Math.sin(t * 0.8 + v * 3);
    const R = 0.12 + 0.95 * Math.sin(Math.PI * Math.min(1, Math.pow(v, 0.85)));
    const dn = smooth(0, 0.5, v);
    const cx = R * Math.sin(th) - 0.25 * dn;
    const cz = R * Math.cos(th) * 0.85 - 0.5 * dn;
    // (Tilted, its far side higher, so the whirl shows from in front.)
    out.set(cx, 1.46 - 1.12 * dn + 0.12 * v * v - 0.28 * (cz + 0.5 * dn) * dn, cz);
    this._th = th;
    return 0.17 * Math.pow(1 - v, 0.9) + 0.015;
  }

  // Point `i` of `n` along a body strand, if it is in the tail: the tail's
  // line there [x, y, z, thickness, and which way out from the whirl's
  // middle], worked out once a frame for each length of strand.
  _spineAt(n, i, t) {
    const C = (this._spines ||= {});
    let c = C[n];
    if (!c || c.t !== t) {
      c = C[n] ||= { t: -1, a: new Float32Array(n * 6), v: new Float32Array(6) };
      c.t = t;
      for (let j = 0; j < n; j++) {
        const s = j / (n - 1);
        if (s < TORSO) continue;
        const th = this._spiral((s - TORSO) / (1 - TORSO), t, _q);
        const k = j * 6;
        c.a[k] = _q.x;
        c.a[k + 1] = _q.y;
        c.a[k + 2] = _q.z;
        c.a[k + 3] = th;
        c.a[k + 4] = Math.sin(this._th);
        c.a[k + 5] = Math.cos(this._th);
      }
    }
    return c.a.subarray(i * 6, i * 6 + 6);
  }

  // Chest into tail: down through its chest (crossing one another on the
  // way), then twisting round one another down the tail, weaving in and
  // out; some come away near its end.
  _bodyStrand(sp, t, loose, t0x, t0y, t0z) {
    const n = sp.n;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      let x;
      let y;
      let z;
      let thick;
      let m = 0;
      let rx = 0;
      let rz = 0;
      let tw;
      let pe = 0;
      if (s < TORSO) {
        const q = s / TORSO;
        const e = q * q * (3 - 2 * q);
        // (Swaying a little, broad at the shoulders.)
        x = t0x * e + 0.05 * Math.sin(q * Math.PI) * Math.sin(t * 0.9);
        y = 2.08 + (t0y - 2.08) * e;
        z = 0.02 + (t0z - 0.02) * e;
        thick = 0.34 + (0.185 - 0.34) * e;
        tw = sp.phi + q * sp.cross;
        m = -0.2 * (1 - q);
      } else {
        const v = (s - TORSO) / (1 - TORSO);
        // (The tail's line, worked out once a frame for every strand.)
        const c = this._spineAt(n, i, t);
        x = c[0];
        y = c[1];
        z = c[2];
        thick = c[3];
        rx = c[4];
        rz = c[5];
        m = smooth(0, 0.3, v);
        tw = sp.phi + sp.cross + v * sp.twist * Math.PI;
        pe = sp.peel * smooth(0.6, 1, v);
      }
      const rho = Math.min(1.3, Math.max(0, sp.rho + 0.4 * Math.sin(s * sp.f1 + sp.p1 + t * 0.7) + 0.16 * Math.sin(s * sp.f2 + sp.p2 - t * 1.1)));
      const o = rho * thick * (1 + 2 * loose);
      const ct = Math.cos(tw);
      const st = Math.sin(tw);
      x += (ct * 1.15 * (1 - m) + rx * ct * m) * o + rx * pe + 0.02 * Math.sin(t * 2.1 + s * 9 + sp.seed * 6);
      y += st * 0.8 * m * o + pe * 0.6 + 0.025 * Math.sin(t * 2.7 + s * 11 + sp.seed * 9) + loose * 0.7 * s;
      z += (st * 0.75 * (1 - m) + rz * ct * m) * o + rz * pe;
      this._place(sp.start + i, x, y, z, 0.02 + 0.45 * Math.pow(s, 1.3));
    }
  }

  // Hair: from the crown and the back of its skull (`lat` across it, `al`
  // how far back), along the skull a little, then streaming up off it like
  // flame, fanning out and rippling.
  _hairStrand(sp, t, loose) {
    const n = sp.n;
    const lat = sp.lat;
    const flare = 1 - 0.3 * lat * lat;
    const x0 = 0.15 * lat;
    const a1 = sp.al + (2.6 - sp.al) * 0.6;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      let x;
      let y;
      let z;
      if (u < 0.15) {
        const a = sp.al + (u / 0.15) * (a1 - sp.al);
        x = x0;
        y = 2.27 + 0.19 * Math.sin(a) * flare;
        z = 0.17 * Math.cos(a);
      } else {
        const w = (u - 0.15) / 0.85;
        x = x0 + lat * 0.45 * sp.len * w + 0.1 * w * Math.sin(w * sp.f1 - t * 3 + sp.p1);
        y = 2.27 + 0.19 * Math.sin(a1) * flare + sp.len * 0.9 * w + 0.07 * w * Math.sin(w * sp.f2 - t * 2.6 + sp.p2);
        z = 0.17 * Math.cos(a1) - 0.12 * w - sp.len * 0.3 * w * w + 0.06 * w * Math.cos(w * sp.f1 - t * 2 + sp.p2);
      }
      this._place(sp.start + i, x * (1 + loose), y + loose * 0.8 * u, z, 0.25 * u);
    }
  }

  // Its skull: an arc over the crown from temple to temple.
  _skullStrand(sp, loose) {
    const back = Math.max(0, -sp.z) * 2;
    for (let i = 0; i < sp.n; i++) {
      const a = Math.PI * (0.1 + 0.8 * (i / (sp.n - 1)));
      this._place(sp.start + i, 0.178 * (1 - back) * Math.cos(a) * (1 + loose), 2.27 + 0.19 * (1 - back * 0.5) * Math.sin(a) + loose * 0.5, sp.z, 0);
    }
  }

  // Its face: a brow slanting down to the middle over each eye, cheek and
  // jaw from the temple to the chin (its mouth the dark between), and the
  // bone under each eye.
  _faceStrand(sp, loose) {
    const n = sp.n;
    const s = sp.side * (1 + loose);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const v = 1 - u;
      let x;
      let y;
      let z;
      if (sp.part === 0) {
        x = 0.165 + (0.022 - 0.165) * u;
        y = 2.345 + (2.3 - 2.345) * u + 0.014 * Math.sin(Math.PI * u);
        z = 0.12 + (0.185 - 0.12) * u;
      } else if (sp.part === 1) {
        // (A curve through temple, cheek, jaw and chin.)
        const b0 = v * v * v;
        const b1 = 3 * v * v * u;
        const b2 = 3 * v * u * u;
        const b3 = u * u * u;
        x = b0 * 0.168 + b1 * 0.17 + b2 * 0.11 + b3 * 0.02;
        y = b0 * 2.34 + b1 * 2.14 + b2 * 2.0 + b3 * 1.99;
        z = b0 * 0.07 + b1 * 0.1 + b2 * 0.12 + b3 * 0.15;
      } else {
        x = v * v * 0.14 + 2 * v * u * 0.09 + u * u * 0.05;
        y = v * v * 2.265 + 2 * v * u * 2.22 + u * u * 2.14;
        z = v * v * 0.14 + 2 * v * u * 0.19 + u * u * 0.18;
      }
      this._place(sp.start + i, x * s, y + loose * 0.5, z, 0);
    }
  }

  // Ribs: curving round from its breastbone, rising and falling a little.
  _ribStrand(sp, t, loose) {
    const k = (1 - 0.1 * sp.row) * (1 + 0.03 * Math.sin(t * 2 + sp.row)) * (1 + loose);
    const y0 = 1.99 - 0.11 * sp.row;
    for (let i = 0; i < sp.n; i++) {
      const b = 0.12 + 1.5 * (i / (sp.n - 1));
      this._place(sp.start + i, sp.side * 0.3 * k * Math.sin(b), y0 - 0.07 * b, 0.2 * k * Math.cos(b), 0.02);
    }
  }

  // Shoulder, elbow (bowed out, up and back) and hand of each arm, which
  // way its forearm points, and across the hand.
  _armFrame(hand) {
    const side = hand === 0 ? 1 : -1;
    const H = this.hands[hand];
    const A = (this._A ||= [new Float32Array(15), new Float32Array(15)])[hand];
    A[0] = side * 0.34;
    A[1] = 2.06;
    A[2] = 0;
    A[3] = (A[0] + H.x) * 0.5 + side * 0.28;
    A[4] = (A[1] + H.y) * 0.5 + 0.16;
    A[5] = H.z * 0.5 - 0.14;
    A[6] = H.x;
    A[7] = H.y;
    A[8] = H.z;
    let fx = H.x - A[3];
    let fy = H.y - A[4];
    let fz = H.z - A[5];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    A[9] = fx;
    A[10] = fy;
    A[11] = fz;
    // (Across: the forearm crossed with up.)
    let qx = -fz;
    let qz = fx;
    const ql = Math.hypot(qx, qz);
    if (ql < 0.05) {
      qx = 1;
      qz = 0;
    } else {
      qx /= ql;
      qz /= ql;
    }
    A[12] = qx;
    A[13] = 0;
    A[14] = qz;
  }

  // A point on an arm, `u` from shoulder (0) to hand (1).
  _armPoint(A, u, out) {
    const a0 = (1 - u) * (1 - u);
    const a1 = 2 * (1 - u) * u;
    const a2 = u * u;
    return out.set(a0 * A[0] + a1 * A[3] + a2 * A[6], a0 * A[1] + a1 * A[4] + a2 * A[7], a0 * A[2] + a1 * A[5] + a2 * A[8]);
  }

  _armStrand(sp, t, loose) {
    const A = this._A[sp.hand];
    for (let i = 0; i < sp.n; i++) {
      const u = i / (sp.n - 1);
      this._armPoint(A, u, _q);
      const rho = sp.rho + 0.3 * Math.sin(u * sp.f1 + sp.p1 + t * 0.9);
      const o = (0.075 * (1 - u) + 0.028) * rho * (1 + 2 * loose);
      const tw = sp.phi + u * 2.2;
      this._place(sp.start + i, _q.x + 0.5 * Math.cos(tw) * o, _q.y + Math.cos(tw + 0.9) * o + 0.015 * Math.sin(t * 3 + u * 8 + sp.seed * 5), _q.z + Math.sin(tw) * o, 0.02 + 0.06 * u);
    }
  }

  // A claw: on from the hand, fanned across it, hooking down.
  _fingerStrand(sp, loose) {
    const A = this._A[sp.hand];
    const fan = (sp.f - 1.5) * 0.3 * (1 + loose);
    let dx = A[9] + A[12] * fan;
    let dy = A[10] - 0.2;
    let dz = A[11] + A[14] * fan;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    const len = sp.f === 1 || sp.f === 2 ? 0.38 : 0.3;
    const bx = A[6] - A[9] * 0.05;
    const by = A[7] - A[10] * 0.05;
    const bz = A[8] - A[11] * 0.05;
    for (let i = 0; i < sp.n; i++) {
      const w = i / (sp.n - 1);
      this._place(sp.start + i, bx + dx * w * len, by + dy * w * len - 0.16 * w * w, bz + dz * w * len, 0.06);
    }
  }

  // Tendrils trailing off an arm: out, back and up or down, rippling.
  _tendrilStrand(sp, t, loose) {
    const A = this._A[sp.hand];
    this._armPoint(A, sp.at, _t);
    let dx = sp.side * sp.out;
    let dy = sp.up;
    let dz = -sp.back;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl;
    dy /= dl;
    dz /= dl;
    for (let i = 0; i < sp.n; i++) {
      const w = i / (sp.n - 1);
      const L = sp.len * w;
      this._place(
        sp.start + i,
        _t.x + dx * L + 0.08 * w * Math.sin(w * sp.f1 - t * 3.4 + sp.p1),
        _t.y + dy * L + sp.curl * sp.len * w * w + 0.16 * w * Math.sin(w * sp.f2 * 0.6 - t * 3 + sp.p2) + loose * 0.6 * w,
        _t.z + dz * L + 0.12 * w * Math.cos(w * sp.f1 * 0.7 - t * 2.6 + sp.p2),
        0.05 + 0.3 * w,
      );
    }
  }

  // ------------------------------------------------------- what it sheds ---

  // How many to emit this frame, at `rate` a second (carrying the rest).
  _n(key, rate, dt) {
    const a = (this.acc[key] || 0) + rate * dt;
    const n = Math.floor(a);
    this.acc[key] = a - n;
    return n;
  }

  _emit(dt, ctx, t) {
    const add = ctx.fx.add;
    if (this.hidden) {
      // Inside you: its wisps swirl round you.
      const p = ctx.player.position;
      for (let i = this._n('in', 70, dt); i > 0; i--) {
        const ang = rand(0, Math.PI * 2);
        const r = rand(1.0, 1.7);
        _p.set(p.x + Math.cos(ang) * r, p.y + rand(0.7, 2.3), p.z + Math.sin(ang) * r);
        put(add, _p, -Math.sin(ang) * 2.4, rand(-0.2, 0.4), Math.cos(ang) * 2.4, rand(0.4, 0.8), rand(0.035, 0.06), 0.015, Math.random() < 0.25 ? GOLD : TEAL_HOT, TEAL_DIM, 1, 0.6, 2);
      }
      return;
    }
    const fade = this.fade;
    const S = this.strands;
    const dvx = this.alive ? this.drift.x : 0;
    const dvz = this.alive ? this.drift.z : 0;
    // Glitter drifting off its strands (gold off the gold-flecked ones).
    for (let i = this._n('glit', 260 * fade, dt); i > 0; i--) {
      const k = (Math.random() * S.count) | 0;
      this._at(k, _p);
      const gold = this.tones[k] === TONE_GOLD && Math.random() < 0.7;
      put(add, _p, dvx * 0.6 + rand(-0.25, 0.25), rand(-0.05, 0.3), dvz * 0.6 + rand(-0.25, 0.25), rand(0.35, 0.8), rand(0.02, 0.036), 0.008, gold ? GOLD : Math.random() < 0.5 ? WHITE : TEAL_HOT, gold ? GOLD_DIM : TEAL, 1, 0.8, 1.2);
    }
    // Wisps peeling off the ends of its hair, tendrils and tail.
    for (let i = this._n('wisp', 45 * fade, dt); i > 0; i--) {
      const k = this.tips[(Math.random() * this.tips.length) | 0] - ((Math.random() * 3) | 0);
      this._at(k, _p);
      put(add, _p, dvx * 0.3 + rand(-0.3, 0.3), rand(0.15, 0.5), dvz * 0.3 + rand(-0.3, 0.3), rand(0.7, 1.2), 0.035, 0.05, TEAL, TEAL_DEEP, 0.6, 0.9, 2.5);
    }
    // Its claws leave trails as they strike.
    const a = this.attack;
    if (this.state === 'strike' && a && (a.name !== 'dive' || this.stateT / Math.max(1e-3, this.stateDur) > RISE)) {
      for (const k of this.clawTips) {
        this._at(k, _p);
        put(add, _p, 0, 0, 0, 0.28, 0.05, 0.02, TEAL_HOT, TEAL, 1, 0, 0);
      }
    }
    // A grab gathering: wisps drawn in from all round to its arms.
    if (a?.name === 'grab' && this.state === 'windup') {
      this._w(0, 1.9, 0.2, _t);
      for (let i = this._n('pull', 60, dt); i > 0; i--) {
        const ang = rand(0, Math.PI * 2);
        const r = rand(1.6, 2.6);
        this._w(Math.cos(ang) * r, rand(0.8, 2.8), Math.sin(ang) * r, _p);
        put(add, _p, (_t.x - _p.x) * 2.2, (_t.y - _p.y) * 2.2, (_t.z - _p.z) * 2.2, 0.45, 0.05, 0.02, TEAL_HOT, TEAL, 1, 0, 0);
      }
    }
  }
}
