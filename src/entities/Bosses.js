import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { angleDelta, rand } from '../core/rng.js';
import { C, burst, ring } from '../world/Particles.js';
import { StrikeVolume } from '../physics/Hitbox.js';
import { Assets } from '../assets/AssetLibrary.js';
import { sceneryMaterial } from '../world/Dressing.js';
import { VOICE_LINES, VOICE_FPS } from './voiceLines.js';

// Floor 5: Vorgrath, the Sleeper (Sleeper below). Floor 10, the last:
// Azrakel, the Archfiend (Archfiend.js).
//
// Bosses skip the attack-token system and pick from a phase-dependent move
// list, never repeating a move three times in a row.

export const BOSS_TYPES = {
  // Huge and patient: wide arcs of a great axe, an overhead chop that cracks
  // the floor, a stamp when you crowd him, a quick low kick at whoever
  // stands right under his nose, and a quicker grab: caught, you are held up
  // before his face, flung into the air and swatted with the axe. Get behind
  // him and he spins right round with the axe held out. In his fury (half
  // health) a chop can stamp straight after. Nothing staggers him (every
  // blow is armoured: dodge it, block it, or be elsewhere). About three
  // minutes of fighting.
  sleeper: {
    name: 'Vorgrath, the Sleeper',
    asset: 'sleeper',
    scale: 1,
    hp: 2625,
    dmg: 25,
    speed: 2.0,
    radius: 1.5,
    poise: Infinity,
    mass: 40,
    role: 'boss',
    guard: null,
    cooldown: 1.05,
    turnRate: 1.3,
    // Once a blow starts it goes where he aimed it: no turning after you.
    lockOnAttack: true,
    stride: 1.2,
    loot: { potion: 1, weapon: 1, spell: 1 },
    summons: [],
    attacks: [
      // `arc`: the axe's path round him (radians from straight ahead, his
      // right to his left) while the blow lands.
      { name: 'sweep', windup: 0.95, strike: 0.54, recover: 0.88, dmg: 1, minRange: 0, maxRange: 5.8, volume: null, arc: [-1.95, 1.95], knockback: 14, weight: 3, armor: true },
      // Often stamps straight after; `fury`: more often in his second phase.
      { name: 'chop', windup: 1.04, strike: 0.29, recover: 1.04, dmg: 1.35, minRange: 2, maxRange: 6.5, volume: { c: [-0.6, 1.4, 3.4], h: [1.1, 1.6, 2.0] }, lunge: 1.2, knockback: 10, aoe: { at: [-0.6, 3.9], radius: 3.0, dmg: 0.55 }, weight: 2, armor: true, combo: { next: 'stomp', chance: 0.4, windup: 0.55 }, fury: { combo: { next: 'stomp', chance: 0.75, windup: 0.5 } } },
      { name: 'stomp', windup: 0.77, strike: 0.23, recover: 0.77, dmg: 0.6, minRange: 0, maxRange: 3.4, volume: null, aoe: { at: [0, 0], radius: 4.2, dmg: 0.6 }, weight: 1, armor: true },
      // In front of him and close: a quick, low punt that turns after you as
      // it winds up (Sleeper._considerAttack). `track`: how fast (rad/s) he
      // turns after you through the blow, for all his axe stays put.
      { name: 'kick', windup: 0.3, strike: 0.18, recover: 0.64, dmg: 0.75, minRange: 0, maxRange: 4.3, volume: { c: [-0.3, 0.8, 2.9], h: [1.3, 0.9, 1.9] }, knockback: 16, weight: 0, armor: true, close: true, track: 1.8 },
      // Quicker than his axe, and his hand goes where you go: the left hand
      // lunges after you (see Sleeper: held, tossed, swatted).
      { name: 'grab', windup: 0.38, strike: 0.38, recover: 0.77, dmg: 0.25, minRange: 0, maxRange: 6, volume: null, lunge: 7.5, grab: true, weight: 3, armor: true, track: 2.6 },
      // Only after a grab: the axe across whatever he threw up, which it
      // meets as the axe comes round in front of him (SWAT_AT of the strike).
      { name: 'swat', windup: 0.11, strike: 0.36, recover: 0.85, dmg: 1.1, minRange: 0, maxRange: 99, volume: null, arc: [-1.95, 1.95], swat: true, knockback: 18, weight: 0, armor: true, behind: true },
      // Behind him: one full turn with the axe held out (Sleeper._considerAttack).
      { name: 'spin', windup: 0.29, strike: 0.68, recover: 0.77, dmg: 0.9, minRange: 0, maxRange: 9, volume: null, spin: true, knockback: 14, weight: 0, armor: true, behind: true },
    ],
  },
  // The last lord (floor 10), quick and hard to touch (see Archfiend.js):
  // his blows are claws in strings, a dash, a pounce, his tail and (later)
  // a howl. `open`: extra time he stays open after that blow.
  azrakel: {
    name: 'Azrakel, the Archfiend',
    asset: 'azrakel',
    scale: 1,
    hp: 4500,
    dmg: 36,
    speed: 6.4,
    radius: 1.0,
    poise: Infinity,
    mass: 14,
    role: 'boss',
    guard: null,
    cooldown: 0.85,
    turnRate: 7,
    stride: 1.25,
    hopClip: 'hop',
    loot: { potion: 1, weapon: 0, spell: 0 },
    summons: [],
    attacks: [
      { name: 'rake', windup: 0.4, strike: 0.16, recover: 0.55, dmg: 0.42, minRange: 0, maxRange: 3.6, volume: { c: [0, 1.2, 1.7], h: [1.6, 1.0, 1.3] }, lunge: 4, knockback: 4, weight: 3, combo: { next: 'rakeL', chance: 0.8, windup: 0.9, max: 2 } },
      { name: 'rakeL', windup: 0.4, strike: 0.16, recover: 0.6, dmg: 0.42, minRange: 0, maxRange: 3.6, volume: { c: [0, 1.2, 1.7], h: [1.6, 1.0, 1.3] }, lunge: 4, knockback: 4, weight: 0, comboOnly: true, combo: { next: 'rake', chance: 0.65, windup: 0.9, max: 2 } },
      // His dash: straight through you, and often straight back again.
      { name: 'lunge', windup: 0.5, strike: 0.42, recover: 0.95, dmg: 0.7, minRange: 3.2, maxRange: 10, volume: { c: [0, 1.0, 1.5], h: [1.0, 1.0, 1.0] }, lunge: 22, knockback: 9, charge: true, weight: 2, combo: { next: 'lungeBack', chance: 0.55, windup: 0.4, max: 1 } },
      { name: 'lungeBack', clip: 'lunge', windup: 0.5, strike: 0.42, recover: 1.0, dmg: 0.7, minRange: 0, maxRange: 14, volume: { c: [0, 1.0, 1.5], h: [1.0, 1.0, 1.0] }, lunge: 22, knockback: 9, charge: true, weight: 0, comboOnly: true },
      { name: 'pounce', windup: 0.6, strike: 0.75, recover: 1.0, dmg: 0.9, minRange: 5.5, maxRange: 16, volume: null, aoe: { at: [0, 0], radius: 3.0, dmg: 0.9 }, open: 0.4, weight: 2 },
      { name: 'tail', windup: 0.38, strike: 0.5, recover: 0.6, dmg: 0.55, minRange: 0, maxRange: 4.6, volume: null, spin: true, knockback: 10, weight: 0, behind: true },
      // Hellfire: the floor breaks open in fire under you and where you are
      // going, three times running (`waves`), each spot ringed a moment first.
      { name: 'hellfire', clip: 'howl', windup: 0.55, strike: 1.1, recover: 0.75, dmg: 0.55, minRange: 2.5, maxRange: 16, volume: null, eruption: { count: 4, spread: 2.6, radius: 1.7, delay: 0.6 }, waves: 3, weight: 1.6 },
      // In close: one whirling turn with every claw out, all round him.
      { name: 'whirl', clip: 'tail', windup: 0.36, strike: 0.5, recover: 0.7, dmg: 0.6, minRange: 0, maxRange: 4.3, volume: null, spin: true, around: true, close: true, knockback: 11, weight: 1.4 },
      { name: 'howl', windup: 0.8, strike: 0.7, recover: 0.9, dmg: 0.6, minRange: 0, maxRange: 9, volume: null, wave: 9, weight: 1.2, minPhase: 2 },
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
    this.light = new THREE.PointLight(0xff5a1e, 12, 18, 1.4);
    this.lightHeight = 2.6;
    this.yaw = Math.PI;
  }

  isEngaged() {
    return this.alive && this.state !== 'dormant' && this.state !== 'dying';
  }

  update(dt, ctx) {
    this.flap = Math.max(0, this.flap - dt * 1.5);
    if (this.alive) this._checkPhase(ctx);
    if (this.alive) this.light.intensity = 12 + Math.sin(ctx.time * 7) * 2.5 + (this.phase - 1) * 3;
    super.update(dt, ctx);
    // Hung in front of the body, so the face and chest catch it.
    const f = this.radius * 1.6;
    this.light.position.set(this.position.x + Math.sin(this.yaw) * f, this.root.position.y + this.lightHeight, this.position.z + Math.cos(this.yaw) * f);
  }

  _checkPhase(ctx) {
    const frac = this.health / this.maxHealth;
    const next = frac < 0.5 ? 2 : 1;
    if (next > this.phase) {
      this.phase = next;
      for (const e of this.emitters) e.rate *= 1.6;
      ctx.announce?.(`${this.name.split(',')[0]} is enraged!`);
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
      if (a.comboOnly || dist < a.minRange || dist > a.maxRange) return false;
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
        ctx.announce?.(`${this.name.split(',')[0]} is stunned!`);
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

  takeHit(amount, dir, knockback, stagger, ctx, opts) {
    // Bosses barely budge.
    return super.takeHit(amount, dir, knockback * 0.15, stagger, ctx, opts);
  }

  die(ctx) {
    super.die(ctx);
    // A shockwave along the floor (kept low and thin: a ring of big glowing
    // sprites sweeping through the view would cover the screen many times
    // over for a second).
    ring(ctx.fx.add, tmp.set(this.position.x, 0.25, this.position.z), 8, { count: 60, speed: 12, size: 0.45, life: 1.1 });
    ctx.shake?.(1);
  }

  _updateDying(dt, ctx) {
    super._updateDying(dt, ctx);
    this.light.intensity *= Math.max(0, 1 - dt * 2);
  }
}

// ------------------------------------------------------------- the Sleeper

// Seconds of quiet between his lines, at the least.
const VOICE_GAP = 3;
// Getting up off his throne (quickly: he is up while the candles are still
// catching round the hall), rearing back as he starts to speak, settling;
// then the fight is on, his words still going.
const RISE = 1.5;
const REAR = 2.2;
const SETTLE = 0.5;
// His death: struck to his knees; then, once his last words are spoken, down.
const KNEEL = 1.1;
const FALL = 0.85;
const LIE = 7;
// Hitting the floor: the whole hall shakes this long; the level he gave you
// waits this long after it.
const RUMBLE = 1.1;
const LEVEL_UP_HOLD = 2;
// "You truly think you can beat me?": a little under half his health.
const DEFEAT_AT = 0.46;
// His first grab of a fight: as soon as you are in reach of one (once he
// has been up a while), and quicker, longer and wider than the rest;
// once he has had you in his fist, grabs come less often.
const FIRST_GRAB_AFTER = 5;
const FIRST_GRAB = { windup: 0.3, lunge: 10, track: 4.5, maxRange: 7.5, first: true };
const GRAB_WEIGHT_AFTER = 1.5;
// Caught: held this long, then flung.
const HOLD = 1.1;
const FLING = 0.2;
// The swat meets you this far through its strike (the axe in front of him).
const SWAT_AT = 0.4;
// His quick kick: you this close and this nearly straight in front of him.
const KICK_RANGE = 4.3;
const KICK_CONE = 0.6;
// He catches you at most this many times a fight.
const GRABS = 3;
// How far forward the skull tips onto his jaw to close his mouth (radians),
// and how long a roar holds it open.
const MOUTH_SHUT = 0.42;
const ROAR_TIME = 1.1;
// How far it opens from shut (radians): a little as he speaks, more for a roar.
const MOUTH_TALK = 0.2;
const MOUTH_ROAR = 0.3;

const _v = new THREE.Vector3();
// Where his fist holds the haft: this far up it from the butt, as a share
// of its length.
const AXE_GRIP = 0.15;

// Vorgrath sleeps in the arena at the end of the candle hall until Game wakes
// him (once its candles are lit): he gets up, speaks (the intro), and the
// fight begins (ctx.onBossEvent('fight')). His recorded lines (voiceLines.js)
// are each spoken once at most, never within VOICE_GAP of another: the
// intro as he rises, "Defeat me" a while into the fight, "Clever" when you
// get behind him (he wheels round with a sweep), and his death line on his
// knees before he falls. His head tips back with the loudness of the line,
// which opens his mouth.
export class Sleeper extends Boss {
  constructor(key, spawn, tuning) {
    super(key, spawn, tuning);
    this.state = 'sleeping';
    this.pose = { name: 'sleep', u: 0, rate: 4 };
    this.voice = { used: new Set(), freeAt: 0, line: null, t0: 0, queued: null };
    this.talk = 0;
    this.talkK = 0;
    // His voice keeps to real time (not slowed by a hit's freeze), as the
    // recording plays.
    this.clock = 0;
    this.behindT = 0;
    this.fightT = 0;
    this.light.intensity = 0;
    // The axe's path: a box swung round him on a pivot. His grab: a box
    // before his left hand.
    this.arcPivot = new THREE.Object3D();
    this.root.add(this.arcPivot);
    this.arc = new StrikeVolume(this.arcPivot, new THREE.Vector3(0, 1.5, 3.3), new THREE.Vector3(1.4, 1.7, 2.3));
    this.grabVol = new StrikeVolume(this.root, new THREE.Vector3(0.5, 1.4, 3.2), new THREE.Vector3(2.0, 1.8, 2.4));
    // How often he has caught you (at most GRABS a fight).
    this.grabs = 0;
    this.leftHand = this.model.bones.find((b) => b.name === 'LeftHand') || this.root;
    this._holdAxe();
  }

  // The axe in his right fist: its haft runs out of the fist the way his
  // thumb points, its two blades across it, gripped near the butt.
  _holdAxe() {
    const hand = this.model.bones.find((b) => b.name === 'RightHand');
    const axe = Assets.instanceProp('sleeperAxe');
    if (!hand || !axe) return;
    // Its runes glow once he is up (asleep in the dark it shows nothing).
    this.axeMats = [];
    axe.traverse((o) => {
      if (!o.isMesh) return;
      o.material = sceneryMaterial(o.material, { tint: [1.1, 1.05, 1.05], glow: 0xff7a3a, strength: 0 });
      this.axeMats.push(o.material);
    });
    this.root.updateMatrixWorld(true);
    const holder = new THREE.Group();
    holder.scale.setScalar(1 / hand.getWorldScale(_v).x);
    // In the hook of his four curled fingers, under the palm by the
    // knuckles (hand-local, his height being 1). Set out from his body and
    // tipped head-down a little, so the haft runs through the hole his
    // fingers leave rather than along their inner edge (fitted against the
    // skinned fist in every clip; his grip is the same in all of them).
    holder.position.set(-0.069, -0.014, -0.024);
    holder.rotation.set(-0.094, -0.267, -0.004);
    // Turned so its bigger blade leads (faces the way he swings). The prop
    // stands on its butt, so it is slid down through the fist: the pommel
    // shows below it and he holds the handle a little above the end.
    axe.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
    const len = Assets.props.get('sleeperAxe')?.entry.size || 3.3;
    axe.position.set(0, 0, -len * AXE_GRIP);
    holder.add(axe);
    hand.add(holder);
    this.axe = axe;
  }

  isEngaged() {
    return this.alive && this.state !== 'sleeping' && this.state !== 'rising' && this.state !== 'dying';
  }

  get asleep() {
    return this.state === 'sleeping' || this.state === 'rising';
  }

  // Game: the candles are lit. He gets up.
  wake(ctx) {
    if (this.state !== 'sleeping') return;
    this.setState('rising');
    this.pose = { name: 'rise', u: 0, rate: 6 };
    ctx.audio?.bossRoar(this.position);
    this.roarT = ROAR_TIME;
    ctx.shake?.(0.25);
  }

  update(dt, ctx) {
    this.ctx = ctx;
    this.clock += ctx.realDt ?? dt;
    this._updateVoice(dt);
    const p = ctx.player.position;
    const toPlayer = Math.atan2(p.x - this.position.x, p.z - this.position.z);
    this.distToPlayer = Math.hypot(p.x - this.position.x, p.z - this.position.z);
    if (this.asleep) this.light.position.set(this.position.x + Math.sin(this.yaw) * 2.4, 3.2, this.position.z + Math.cos(this.yaw) * 2.4);
    if (this.state === 'sleeping') {
      this.stateT += dt;
      this.pose.u = (this.stateT / 4) % 1;
      this.root.rotation.y = this.yaw;
      return;
    }
    if (this.state === 'rising') {
      this._updateRise(dt, ctx, toPlayer);
      this.root.rotation.y = this.yaw;
      this.light.intensity = Math.min(6, this.stateT * 2);
      return;
    }
    if (this.state === 'holding' || this.state === 'flinging') {
      this._updateHold(dt, ctx, toPlayer);
      this.root.rotation.y = this.yaw;
      return;
    }
    super.update(dt, ctx);
    // A blow that follows you (`track`: his grab, his kick) turns after you
    // as it winds up and lands.
    const a = this.attack;
    if (this.alive && a?.track && (this.state === 'windup' || this.state === 'strike')) {
      this._turnToward(toPlayer, dt, a.track);
      this.root.rotation.y = this.yaw;
    }
    if (this.alive) {
      this.light.intensity = 6 + Math.sin(ctx.time * 2.3) * 1.2 + (this.phase - 1) * 2;
      this.fightT += dt;
      // A while into the fight, or once he is hurt: "Defeat me".
      if (this.health < this.maxHealth * DEFEAT_AT) this._say('defeat');
    }
  }

  _updateRise(dt, ctx, toPlayer) {
    const t = (this.stateT += dt);
    const speak = REAR;
    let u;
    if (t < RISE) u = 0.5 * (t / RISE);
    else if (t < RISE + speak) {
      // Up: he rears back, arms wide, and starts to speak.
      this._say('intro', true);
      u = 0.5 + 0.35 * ((t - RISE) / speak);
    } else u = 0.85 + 0.15 * Math.min(1, (t - RISE - speak) / SETTLE);
    this.pose.u = u;
    if (t > RISE * 0.5) this._turnToward(toPlayer, dt, 0.9);
    if (Math.abs(t - RISE * 0.45) < dt) {
      ctx.shake?.(0.3);
      burst(ctx.fx.alpha, _v.set(this.position.x, 0.4, this.position.z), { count: 40, speed: 3, color: C.smoke, colorEnd: C.smoke, size: 0.8, life: 1.4, gravity: -1 });
    }
    for (const m of this.axeMats || []) m.emissiveIntensity = Math.min(0.55, Math.max(0, (t - RISE) / speak) * 0.55);
    if (t >= RISE + speak + SETTLE) {
      this.pose = null;
      this.setState('chase');
      this.cooldown = 0.8;
      ctx.onBossEvent?.('fight', this);
    }
  }

  // ---- His voice ----

  // Speak a line if it has not been spoken and nothing was said in the last
  // VOICE_GAP seconds (or `force`, the intro). Returns whether it was.
  _say(id, force = false) {
    const v = this.voice;
    const line = VOICE_LINES[id];
    if (!line || v.used.has(id)) return false;
    const t = this.clock;
    if (!force && (t < v.freeAt || v.line)) return false;
    v.used.add(id);
    v.line = line;
    v.t0 = t;
    v.freeAt = t + line.duration + VOICE_GAP;
    this.ctx?.audio?.voice(line.file, line.duration);
    return true;
  }

  // The head follows the loudness of what he is saying; a line waiting for
  // its turn (his last words) is spoken as soon as it may be.
  _updateVoice(dt) {
    const v = this.voice;
    // (His last words wait only for him to finish what he is saying.)
    if (v.queued && !v.line && (this.clock >= v.freeAt || v.queued === 'death')) {
      const id = v.queued;
      v.queued = null;
      this._say(id, id === 'death');
    }
    let loud = 0;
    if (v.line) {
      const k = (this.clock - v.t0) * VOICE_FPS;
      const i = Math.floor(k);
      if (i >= v.line.env.length) v.line = null;
      else {
        const a = +v.line.env[i];
        const b = +(v.line.env[i + 1] ?? 0);
        loud = (a + (b - a) * (k - i)) / 9;
      }
    }
    this.talkK += (loud - this.talkK) * Math.min(1, dt * 16);
    // His mouth is carved wide open; at rest the skull is tipped forward
    // onto the jaw to shut it (MOUTH_SHUT), and his words and roars lift it.
    this.roarT = Math.max(0, (this.roarT || 0) - dt);
    const roar = Math.sin(Math.min(1, this.roarT / ROAR_TIME) * Math.PI);
    const words = Math.min(1, this.talkK * 1.3);
    this.talk = -MOUTH_SHUT + Math.max(MOUTH_TALK * words, MOUTH_ROAR * roar);
  }

  // ---- Fighting ----

  _considerAttack(dt, ctx, dist) {
    const player = ctx.player;
    if (player.dead) return;
    const off = Math.abs(angleDelta(this.yaw, Math.atan2(player.position.x - this.position.x, player.position.z - this.position.z)));
    // Behind him: "Clever...", and he spins right round with the axe held
    // out (whether or not he has got his breath back from his last blow).
    if (off > 1.75 && dist < 8.5) {
      this.behindT += dt;
      if (this.behindT > 0.3) {
        this.behindT = 0;
        this._say('clever');
        this._startAttack(this.type.attacks.find((a) => a.name === 'spin'), ctx, this.phase === 1 ? 1 : 0.85);
        this.lastMoves.push('spin');
        if (this.lastMoves.length > 2) this.lastMoves.shift();
        return;
      }
    } else this.behindT = Math.max(0, this.behindT - dt);
    // Not had you in his fist yet: he reaches for you as soon as he can.
    if (this.grabs === 0 && this.fightT > FIRST_GRAB_AFTER && this.cooldown <= 0 && dist <= FIRST_GRAB.maxRange && off < 1.0) {
      this.lastMoves.push('grab');
      if (this.lastMoves.length > 2) this.lastMoves.shift();
      this._startAttack({ ...this.type.attacks.find((a) => a.name === 'grab'), ...FIRST_GRAB }, ctx, 1);
      return;
    }
    // Close in front of him: usually the kick, quick off the mark and sooner
    // than anything else (never twice running; whether he will is settled
    // once per opening, `kickPass`).
    if (dist < KICK_RANGE && off < KICK_CONE && this.cooldown < 0.7 && this.lastMoves.at(-1) !== 'kick' && !this.kickPass) {
      this.lastMoves.push('kick');
      if (this.lastMoves.length > 2) this.lastMoves.shift();
      this._startAttack(this.type.attacks.find((a) => a.name === 'kick'), ctx, this.phase === 1 ? 1 : 0.85);
      return;
    }
    if (this.cooldown > 0 || off > 0.55) return;
    const moves = this.type.attacks.filter((a) => !a.behind && !a.close && !(a.grab && this.grabs >= GRABS) && dist >= a.minRange && dist <= a.maxRange && !(this.lastMoves.length >= 2 && this.lastMoves.every((m) => m === a.name)));
    if (!moves.length) return;
    const weight = (a) => (a.grab && this.grabs > 0 ? GRAB_WEIGHT_AFTER : a.weight || 1);
    let roll = Math.random() * moves.reduce((s, a) => s + weight(a), 0);
    let pick = moves[0];
    for (const a of moves) {
      roll -= weight(a);
      if (roll <= 0) {
        pick = a;
        break;
      }
    }
    this.lastMoves.push(pick.name);
    if (this.lastMoves.length > 2) this.lastMoves.shift();
    if (this.phase > 1 && pick.fury) pick = { ...pick, ...pick.fury };
    this._startAttack(pick, ctx, this.phase === 1 ? 1 : 0.82);
  }

  _startAttack(a, ctx, windupScale = 1, chained = false) {
    super._startAttack(a, ctx, windupScale, chained);
    this.kickPass = Math.random() < 0.3;
    // The reach of the sweep marked on the floor round him as it winds up.
    if ((a.arc && !a.swat) || a.spin) ctx.effects?.telegraph(this.position.x, this.position.z, 5.6, this.stateDur, null, 0xff6a20);
    else if (a.name === 'stomp') ctx.effects?.telegraph(this.position.x, this.position.z, a.aoe.radius, this.stateDur, null, 0xff6a20);
  }

  _updateStrike(dt, ctx) {
    const a = this.attack;
    const player = ctx.player;
    if (a?.grab) {
      // The hand closes on whoever is in it (a Shade Step slips it); his
      // first reaches further and wider.
      this.root.updateMatrixWorld(true);
      const vol = this.grabVol;
      if (a.first) {
        vol.localCenter.set(0.5, 1.4, 3.6);
        vol.localHalf.set(2.6, 2.2, 3.0);
      }
      const caught = !player.dead && !player.held && player.invuln <= 0 && player.overlapsOBB(vol.update());
      if (a.first) {
        vol.localCenter.set(0.5, 1.4, 3.2);
        vol.localHalf.set(2.0, 1.8, 2.4);
      }
      if (caught) {
        this._seize(ctx);
        return;
      }
    }
    if (a?.spin) {
      // One full turn through the strike, the axe out to his right.
      this.yaw += ((Math.PI * 2) / Math.max(0.1, this.stateDur)) * dt;
      this.root.rotation.y = this.yaw;
    }
    if (a?.swat && !this.hitPlayer && player.air && !player.dead && this.distToPlayer < 9 && this.stateT >= this.stateDur * SWAT_AT) {
      // Whatever he threw up is still in the air: it is swatted.
      this.hitPlayer = true;
      _v.set(player.position.x - this.position.x, 0, player.position.z - this.position.z).normalize();
      player.takeDamage(this.damage * a.dmg, this.position, 0, ctx, null);
      player.air.vx += _v.x * 9;
      player.air.vz += _v.z * 9;
      player.air.vy = Math.max(player.air.vy, 3);
      ctx.shake?.(0.6);
      ctx.audio?.bossImpact(this.position);
      burst(ctx.fx.alpha, _v.set(player.position.x, player.position.y + 1.2, player.position.z), { count: 40, speed: 5, color: C.blood, colorEnd: C.bloodDark, size: 0.2, life: 1 });
    }
    if (a?.arc || a?.spin) {
      const k = Math.min(1, this.stateT / Math.max(1e-3, this.stateDur));
      this.arcPivot.rotation.y = a.spin ? -1.25 : a.arc[0] + (a.arc[1] - a.arc[0]) * k;
      this.root.updateMatrixWorld(true);
      if (!this.hitPlayer && player.overlapsOBB(this.arc.update())) {
        this.hitPlayer = true;
        player.takeDamage(this.damage * a.dmg, this.position, a.knockback, ctx, this);
        if (this.state !== 'strike') return;
      }
      // Grit thrown up where the axe skims the floor.
      if (Math.random() < dt * 30) {
        const ang = this.yaw + this.arcPivot.rotation.y;
        burst(ctx.fx.alpha, _v.set(this.position.x + Math.sin(ang) * 4.6, 0.3, this.position.z + Math.cos(ang) * 4.6), { count: 4, speed: 2, color: C.smoke, colorEnd: C.smoke, size: 0.5, life: 0.8, gravity: -1 });
      }
    }
    super._updateStrike(dt, ctx);
  }

  // His axe or his foot coming down: the floor caves in round it, cracks run
  // out glowing, chunks fly, dust rolls (world/Quake.js), and the hall
  // shakes the harder the nearer you are.
  _impact(ctx, aoe) {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const x = this.position.x + s * aoe.at[1] + c * aoe.at[0];
    const z = this.position.z + c * aoe.at[1] - s * aoe.at[0];
    ctx.effects?.quake(x, z, aoe.radius, 1);
    ctx.audio?.bossImpact(_v.set(x, 0.2, z));
    const p = ctx.player;
    const d = Math.hypot(p.position.x - x, p.position.z - z);
    ctx.shake?.(Math.max(0.15, 0.95 - d * 0.06));
    if (d < aoe.radius + p.radius && !this.hitPlayer) p.takeDamage(this.damage * aoe.dmg, _v, 4, ctx);
  }

  postUpdate(dt, ctx, time) {
    super.postUpdate(dt, ctx, time);
    if (this.state === 'dying') this._ground(dt);
    this._feet(ctx);
  }

  // Dying, on his knees and then on his face, it is his body (not his bones)
  // that rests on the floor: the lowest of a sample of his skin's points is
  // kept on it, until he sinks away.
  _ground(dt) {
    if (this.sinking) return;
    if (!this.skin) {
      this.model.root.traverse((o) => {
        if (o.isSkinnedMesh && (!this.skin || o.geometry.attributes.position.count > this.skin.geometry.attributes.position.count)) this.skin = o;
      });
      if (!this.skin) return;
    }
    const mesh = this.skin;
    this.root.updateMatrixWorld(true);
    const n = mesh.geometry.attributes.position.count;
    let low = Infinity;
    for (let i = 0; i < n; i += 11) {
      mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld);
      if (_v.y < low) low = _v.y;
    }
    if (low === Infinity) return;
    const fix = -low * Math.min(1, dt * 12);
    this.groundY = (this.groundY || 0) + fix;
    this.root.position.y += fix;
  }

  // Each footfall (two to a stride of his walk, in step with it): the foot
  // that is down presses the floor in, the ground shakes (hard near him,
  // and felt anywhere in the hall) and it booms.
  _feet(ctx) {
    if (!this.alive || this.asleep || this.state === 'holding' || this.state === 'flinging') return;
    const half = Math.floor(this.walkPhase / Math.PI);
    if (this.lastHalf === undefined || half === this.lastHalf) {
      this.lastHalf = half;
      return;
    }
    this.lastHalf = half;
    if ((this.moveBlend || 0) < 0.12) return;
    this.feet ||= ['LeftFoot', 'RightFoot'].map((n) => this.model.bones.find((b) => b.name === n)).filter(Boolean);
    let x = this.position.x;
    let z = this.position.z;
    let low = Infinity;
    for (const f of this.feet) {
      f.getWorldPosition(_v);
      if (_v.y < low) [low, x, z] = [_v.y, _v.x, _v.z];
    }
    const p = ctx.player.position;
    const d = Math.hypot(p.x - x, p.z - z);
    ctx.effects?.quake(x, z, 1.5, 0.22);
    ctx.shake?.(Math.max(0.1, 0.45 - d * 0.018));
    ctx.audio?.bossStep(_v.set(x, 0.2, z));
  }

  // ---- His grab ----

  // Caught: the player is held up in his left fist before his face.
  _seize(ctx) {
    const p = ctx.player;
    p.seize(this);
    this.grabs++;
    this.setState('holding', HOLD);
    this.pose = { name: 'toss', u: 0, rate: 10 };
    this.squeezed = false;
    ctx.shake?.(0.35);
    ctx.audio?.bossRoar(this.position);
    this.roarT = ROAR_TIME;
    ctx.onCombat?.('grabbed');
  }

  _updateHold(dt, ctx, toPlayer) {
    const p = ctx.player;
    const t = (this.stateT += dt);
    this.cooldown -= dt;
    this.leftHand.getWorldPosition(_v);
    if (this.state === 'holding') {
      if (p.held) {
        // A little before his fist, at the height of it, looking at him.
        p.held.at.set(_v.x + Math.sin(this.yaw) * 0.6, Math.max(0, _v.y - 1.45), _v.z + Math.cos(this.yaw) * 0.6);
        const want = Math.atan2(-(this.position.x - p.position.x), -(this.position.z - p.position.z));
        p.yaw += Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw)) * Math.min(1, dt * 6);
      }
      // A crushing squeeze.
      if (t > 0.5 && !this.squeezed && p.held) {
        this.squeezed = true;
        p.held = null;
        p.takeDamage(this.damage * this.attack.dmg, this.position, 0, ctx, null);
        if (!p.dead) p.seize(this);
        burst(ctx.fx.alpha, _v.clone().setY(_v.y - 0.3), { count: 30, speed: 3, color: C.blood, colorEnd: C.bloodDark, size: 0.16, life: 0.9 });
      }
      if (p.dead || !p.held) {
        p.release?.();
        this.pose = null;
        this.setState('recover', 1);
        return;
      }
      if (t >= HOLD) {
        // Flung up into the air in front of him...
        p.toss(Math.sin(this.yaw) * 3.2, 9.5, Math.cos(this.yaw) * 3.2);
        this.setState('flinging', FLING);
        this.pose = { name: 'toss', u: 0, rate: 16 };
        ctx.audio?.bossSwing?.(this.position);
      }
      return;
    }
    // ...and, as it comes down, the axe.
    this.pose.u = 0.25 * Math.min(1, t / FLING);
    if (t >= FLING) {
      this.pose = null;
      this._startAttack(this.type.attacks.find((a) => a.name === 'swat'), ctx, 1);
    }
    void toPlayer;
  }

  // Phase two at half health: quicker to swing; nothing summoned.
  _checkPhase(ctx) {
    if (this.phase === 1 && this.health < this.maxHealth * 0.5) {
      this.phase = 2;
      ctx.announce?.('Vorgrath’s fury builds!');
      ctx.shake?.(0.4);
      ctx.audio?.bossRoar(this.position);
      this.roarT = ROAR_TIME;
    }
  }

  // ---- Nothing staggers him ----

  takeHit(amount, dir, knockback, stagger, ctx, opts) {
    // Asleep or rising, the blade glances off him.
    if (this.asleep) return 0;
    return Enemy.prototype.takeHit.call(this, amount, dir, 0, 0, ctx, opts);
  }

  interrupt() {}

  stumble() {}

  freeze() {}

  parried() {
    this.flash = 0.6;
  }

  // His death is a scene: nothing else (a level gained) interrupts it.
  // (And for a moment after he hits the floor.)
  dyingScene() {
    return this.state === 'dying' && (!this.landed || this.stateT - this.landedAt < LEVEL_UP_HOLD);
  }

  // His blows cannot be countered: there is no catching him in a wind-up.
  isWindingUp() {
    return false;
  }

  // ---- His death: to his knees, his last words, then down on his face ----

  die(ctx) {
    this.ctx = ctx;
    if (ctx.player.held?.by === this) ctx.player.release();
    super.die(ctx);
    this.setState('dying', Infinity);
    this.voice.queued = 'death';
    this._updateVoice(0);
    this.fallAt = null;
    this.deathU = 0;
  }

  _updateDying(dt, ctx) {
    for (const e of this.emitters) e.rate *= 1 - Math.min(1, dt * 3);
    this.light.intensity *= Math.max(0, 1 - dt * 0.6);
    const t = this.stateT;
    const v = this.voice;
    const spoken = v.used.has('death') && !v.line && !v.queued;
    if (t < KNEEL) this.deathU = 0.25 * (t / KNEEL);
    else if (this.fallAt === null) {
      // Swaying on his knees while he speaks his last.
      this.deathU = 0.485 + Math.sin((t - KNEEL) * 0.9 - Math.PI / 2) * 0.235;
      if (spoken || !VOICE_LINES.death) this.fallAt = t;
    }
    if (this.fallAt !== null) {
      // Down he goes, gathering speed like a felled tree.
      const k = Math.min(1, (t - this.fallAt) / FALL);
      this.deathU = 0.72 + 0.28 * k * k;
      if (k >= 1 && !this.landed) {
        this.landed = true;
        this.landedAt = t;
        this.rumbleT = RUMBLE;
        ctx.audio?.play?.('boss_fall', { volume: 1, gap: 1 });
        ctx.audio?.bossImpact?.(this.position);
        const fx = this.position.x + Math.sin(this.yaw) * 2.5;
        const fz = this.position.z + Math.cos(this.yaw) * 2.5;
        ctx.effects?.quake?.(fx, fz, 3.5, 1);
        burst(ctx.fx.alpha, _v.set(fx, 0.4, fz), { count: 90, speed: 5, color: C.smoke, colorEnd: C.smoke, size: 1.1, life: 1.8, gravity: -1 });
      }
      // The whole hall shakes with it, hard, for a good second.
      if (this.rumbleT > 0) {
        this.rumbleT = Math.max(0, this.rumbleT - (ctx.realDt ?? dt));
        const want = 1.2 * Math.sqrt(this.rumbleT / RUMBLE);
        if (ctx.player && ctx.player.shakeT < want) ctx.player.shakeT = want;
      }
      // Lies there, then sinks away.
      const sink = Math.max(0, t - this.fallAt - FALL - LIE) / 2;
      this.sinking = sink > 0;
      this.root.position.y = (this.groundY || 0) - sink * 2.5;
      if (sink >= 1) this.removed = true;
    } else this.root.position.y = this.groundY || 0;
  }
}
