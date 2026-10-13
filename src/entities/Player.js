import * as THREE from 'three';
import { OBB } from '../physics/OBB.js';
import { queryHurtboxes } from '../physics/Hitbox.js';
import { WEAPON_TYPES, buildWeaponMesh, arcDirection, gripPose, bladeQuaternion, prepareArc } from './Weapons.js';
import { SPELLS, SPELL_IDS, castSpell } from './Spells.js';
import { C, burst } from '../world/Particles.js';
import { TorchFire } from '../world/TorchFire.js';
import { Assets } from '../assets/AssetLibrary.js';
import { clamp } from '../core/rng.js';
import { classifyPress, lightTiming, chainBonus, CHAIN_MAX, EXPOSED_DAMAGE } from '../combat/Rhythm.js';
import { MOMENTUM_MAX, MOMENTUM_DECAY_AFTER, momentumSpeed, STUMBLE, guardOutcome } from '../combat/Styles.js';
import { relicPassive } from '../combat/Relics.js';
import { ProcEngine } from '../combat/Procs.js';
import { SwingTrail, trailStyle } from '../combat/SwingTrail.js';

// First-person demon hunter. WASD + mouse look.
//
// Left button: a tap is a light attack, holding draws back a heavy one that
// lands when you let go. Right button blocks. E drinks a potion, 1/2/3 cast
// demon spells, and once learned, Phantom Step dodges on a double tap of
// A, D or S (or Space). No armour, no stamina, no regeneration.
//
// The fight runs on rhythm (combat/Rhythm.js): press again as an arc
// completes to flow into a Perfect Chain; press any earlier and the swing
// is fumbled, the next one sluggish and exposed. Nothing is queued. Light
// swings let you keep walking; a heavy blow roots you and cannot be undone.
// Blows landed in a demon's windup are counter-hits; blows on a raised guard
// bounce off (or break it: combat/Styles.js), and every weapon kind has its
// own personality. Hits can set off procs (combat/Procs.js) from relics.

const EYE = 1.65;
const RADIUS = 0.4;
const WALK = 5.2;
const DODGE_SPEED = 12.5;
const DODGE_TIME = 0.3;
const DODGE_IFRAMES = 0.26;
const DODGE_CD = 0.7;
const DRINK_TIME = 0.65;
const POTION_HEAL = 0.4;

// Resting guard: held low on the right, blade nearly upright, leaning just a
// little outward.
const IDLE_DIR = new THREE.Vector3(0.24, 0.94, -0.24).normalize();
const IDLE_AXIS = new THREE.Vector3(0.15, 0.1, 1).normalize();
const IDLE_POS = new THREE.Vector3(0.3, -0.48, -0.52);
// Block: the blade laid across the body, flat toward the enemy.
const BLOCK_DIR = new THREE.Vector3(-0.93, 0.3, -0.2).normalize();
const BLOCK_AXIS = new THREE.Vector3(0, 0.1, 1).normalize();
const BLOCK_POS = new THREE.Vector3(0.3, -0.32, -0.46);
const BLOCK_FRONT = 0.3; // cos of the half-angle a block covers (about 72 degrees)
const BLOCK_TAKEN = 0.2; // share of a blocked blow that still lands
// Heavy attack: a press held longer than HOLD draws back; full power after CHARGE_FULL.
const HOLD = 0.2;
const CHARGE_FULL = 0.75;
const HEAVY_ARC = prepareArc({ from: [0.35, 0.93, -0.05], to: [-0.6, -0.72, -0.55] });
// Drawn back: raised high on the right, blade straight up and a little back.
const CHARGE_DIR = new THREE.Vector3(0.35, 0.93, -0.05).normalize();
const CHARGE_POS = new THREE.Vector3(0.44, -0.44, -0.82);
// A weapon thrown back off a guard: how long until it is yours again.
const BOUNCE_TIME = 0.42;
// Phantom Step: two taps of a direction key within this long.
const DOUBLE_TAP = 0.28;
// The viewmodel is drawn with a narrower lens than the world (Game.js), so
// the blade on screen sits nearer the middle than the same camera-space
// point would in the world. Hit tests push it out by tan(world/2)/tan(view/2)
// so a blow lands exactly where the blade is seen.
const VIEW_FOV = 62;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _camQ = new THREE.Quaternion();
const _camP = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _az = new THREE.Vector3();
const _half = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _tilt = new THREE.Quaternion();
const _side = new THREE.Vector3(1, 0, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _wq = new THREE.Quaternion();
const TORCH_POS = new THREE.Vector3(-0.46, -0.45, -0.68);
const TORCH_ROT = new THREE.Euler(0.12, 0, -0.14);
// The torch model stands on its pommel this far below the hand; its flame
// burns on the rags held in the claw cage at the top.
const TORCH_BASE = -0.42;
const TORCH_RAGS = 0.9;

export class Player {
  constructor(camera, viewRoot) {
    this.camera = camera;
    this.viewRoot = viewRoot;
    this.position = new THREE.Vector3();
    this.radius = RADIUS;
    this.yaw = 0;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.knock = new THREE.Vector3();
    this.run = null;
    this.blade = new OBB();
    this.bladeSeg = { a: new THREE.Vector3(), b: new THREE.Vector3() };
    this.prevCamQ = new THREE.Quaternion();
    this.prevCamP = new THREE.Vector3();
    this.idleQuat = bladeQuaternion(IDLE_DIR, IDLE_AXIS, new THREE.Quaternion());
    this.blockQuat = bladeQuaternion(BLOCK_DIR, BLOCK_AXIS, new THREE.Quaternion());
    this.chargeQuat = bladeQuaternion(CHARGE_DIR, HEAVY_ARC.axis, new THREE.Quaternion());
    this.chargePos = CHARGE_POS.clone();
    this.procs = new ProcEngine();
    this.kick = { x: 0, z: 0, vx: 0, vz: 0 };

    // Viewmodel: weapon in the right hand, torch in the left.
    this.weaponPivot = new THREE.Group();
    viewRoot.add(this.weaponPivot);
    this.trail = new SwingTrail();
    viewRoot.add(this.trail.mesh);
    this.torch = this._buildTorch();
    viewRoot.add(this.torch);
    this.torchLight = new THREE.PointLight(0xffb070, 30, 16, 1.7);
    this.prevTorch = new THREE.Vector3();
    this.reset();
  }

  _buildTorch() {
    // Held low on the left, nearly upright, leaning a little in toward the
    // middle; the flame stands about level with the bottom third of the view.
    const g = new THREE.Group();
    g.position.copy(TORCH_POS);
    g.rotation.copy(TORCH_ROT);
    // The generated torch: a leather-bound shaft, a bone pommel and an iron
    // claw cage of rags. Without it, a plain stick and wrap.
    const model = Assets.instanceProp('torch');
    let rags = 0.25;
    if (model) {
      model.position.y = TORCH_BASE;
      g.add(model);
      rags = TORCH_BASE + (Assets.props.get('torch')?.entry.size ?? 0.72) * TORCH_RAGS;
    } else {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.032, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x2c1c10, roughness: 0.95 }));
      stick.position.y = -0.1;
      const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.034, 0.12, 8), new THREE.MeshStandardMaterial({ color: 0x1a1008, roughness: 1 }));
      wrap.position.y = 0.24;
      g.add(stick, wrap);
    }
    // A 3D flame on the rags that trails behind as the torch moves.
    this.fire = new TorchFire({ height: 0.26, width: 0.06, seed: 1.7 });
    this.fire.group.position.y = rags - 0.02;
    g.add(this.fire.group);
    this.flame = this.fire.group;
    this.flameY = rags;
    return g;
  }

  reset() {
    this.dead = false;
    this.deathT = 0;
    this.swing = null;
    this.comboIndex = 0;
    this.press = null;
    this.charge = null;
    this.chain = 0;
    this.fumbleNext = false;
    this.idleT = 0;
    this.blocking = false;
    this.blockK = 0;
    this.armed = true;
    this.torchLit = 1;
    this.torchRaise = 1;
    this.wake = 1;
    this.dodgeT = 0;
    this.dodgeCd = 0;
    this.dodgeDir = new THREE.Vector3();
    this.taps = {};
    this.dash = null;
    this.invuln = 0;
    this.staggerT = 0;
    this.staggerMax = 0;
    this.momentum = 0;
    this.momentumT = 0;
    this.wrathT = 0;
    this.drinkT = 0;
    this.drinkHeal = 0;
    this.spellCd = { nova: 0, step: 0, siphon: 0 };
    this.spellCast = { nova: 0, step: 0, siphon: 0 };
    this.siphonT = 0;
    this.siphonLeech = 0;
    this.hurtFlash = 0;
    this.healFlash = 0;
    this.shakeT = 0;
    this.bobT = 0;
    this.lavaT = 0;
    this.knock.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.kick.x = this.kick.z = this.kick.vx = this.kick.vz = 0;
    this.procs.reset();
  }

  attachRun(run) {
    this.run = run;
    this.setWeapon(run.weapon);
  }

  get health() {
    return this.run.health;
  }

  // A fumbled, sluggish swing leaves you open: demons take it.
  get exposed() {
    return !!this.swing?.sluggish && !this.dead;
  }

  setWeapon(weapon) {
    this.run.weapon = weapon;
    this.weaponDef = WEAPON_TYPES[weapon.type];
    this.weaponPivot.clear();
    this.weaponMesh = buildWeaponMesh(weapon, { own: true });
    this.weaponPivot.add(this.weaponMesh);
    this.weaponMats = [];
    this.weaponMesh.traverse((o) => {
      if (o.isMesh && o.material.emissive) this.weaponMats.push({ m: o.material, c: o.material.emissive.clone(), i: o.material.emissiveIntensity });
    });
    this.swing = null;
    this.momentum = 0;
    this.chain = 0;
    this._glow = this._glowSet = 0;
  }

  spawnAt(x, z, yaw) {
    this.position.set(x, 0, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.vel.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.swing = null;
    this.dash = null;
    this.staggerT = 0;
    this._updateCamera(0);
    this.prevCamQ.copy(this.camera.quaternion);
    this.prevCamP.copy(this.camera.position);
  }

  // Unit direction of current WASD input on the ground plane.
  moveDirection(out) {
    const { forward, strafe } = this.input ? this.input.moveAxes() : { forward: 0, strafe: 0 };
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    out.set(-s * forward + c * strafe, 0, -c * forward - s * strafe);
    if (out.lengthSq() > 0) out.normalize();
    return out;
  }

  // ----------------------------------------------------------- update ---

  update(dt, ctx) {
    const input = ctx.input;
    this.input = input;
    const { dx, dy } = input.consumeMouse();
    if (!this.dead) {
      this.yaw -= dx;
      this.pitch = clamp(this.pitch - dy, -1.45, 1.45);
    }

    this.invuln = Math.max(0, this.invuln - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.healFlash = Math.max(0, this.healFlash - dt * 2);
    this.shakeT = Math.max(0, this.shakeT - dt * 2.2);
    this.siphonT = Math.max(0, this.siphonT - dt);
    this.staggerT = Math.max(0, this.staggerT - dt);
    this.wrathT = Math.max(0, this.wrathT - dt);
    for (const id of SPELL_IDS) {
      this.spellCd[id] = Math.max(0, this.spellCd[id] - dt);
      this.spellCast[id] = Math.max(0, this.spellCast[id] - dt);
    }
    // Sword momentum bleeds off when you stop landing blows.
    this.momentumT += dt;
    if (this.momentum > 0 && this.momentumT > MOMENTUM_DECAY_AFTER) {
      this.momentum = Math.max(0, this.momentum - dt);
    }

    if (this.dead) {
      this.deathT += dt;
      this._updateCamera(dt);
      return;
    }

    if (ctx.combat) {
      for (const id of SPELL_IDS) {
        if (!input.wasPressed(SPELLS[id].key)) continue;
        if (castSpell(id, this, ctx)) this.spellCast[id] = 0.6;
        else if (this.run.spells[id]) ctx.onSpellDenied?.(id);
      }
      if ((input.wasPressed('KeyE') || input.wasPressed('KeyR')) && this.drinkT <= 0 && this.staggerT <= 0) this.drinkPotion(ctx);
      this._dodgeInput(ctx);
      this._attackInput(dt, ctx);
    }

    // Potion: heal over the drink.
    if (this.drinkT > 0) {
      const step = Math.min(dt, this.drinkT);
      this.drinkT -= step;
      this.heal((this.drinkHeal * step) / DRINK_TIME);
    }

    this._move(dt, ctx);
    this._updateCamera(dt);
    this._updateWeapon(dt, ctx);
    this._updateTorch(dt, ctx);
    this.trail.update(dt);
    this.prevCamQ.copy(this.camera.quaternion);
    this.prevCamP.copy(this.camera.position);
  }

  _move(dt, ctx) {
    const dir = this.moveDirection(_dir);
    let speed = WALK;
    // Light swings let you keep moving; a heavy blow roots you.
    const s = this.swing;
    if (s) speed *= s.heavy ? 0 : s.bounced ? 0.3 : s.sluggish ? 0.5 : 0.72;
    else if (this.charge) speed *= 0.35;
    else if (this.blocking) speed *= 0.45;
    if (this.staggerT > 0) speed *= 0.3;
    if (this.wake < 1) speed = 0;
    if (this.drinkT > 0) speed *= 0.45;
    const blend = 1 - Math.exp(-14 * dt);
    this.vel.x += (dir.x * speed - this.vel.x) * blend;
    this.vel.z += (dir.z * speed - this.vel.z) * blend;
    let mx = this.vel.x * dt;
    let mz = this.vel.z * dt;
    if (this.dodgeT > 0) {
      const k = this.dodgeT / DODGE_TIME;
      mx = this.dodgeDir.x * DODGE_SPEED * (0.5 + k * 0.7) * dt;
      mz = this.dodgeDir.z * DODGE_SPEED * (0.5 + k * 0.7) * dt;
      this.dodgeT -= dt;
    }
    if (this.dash) {
      this.dash.t += dt;
      mx = this.dash.vx * dt;
      mz = this.dash.vz * dt;
      if (this.dash.dmg) this._dashCut(ctx);
      ctx.fx.add.emit({ x: this.position.x, y: 1 + Math.random() * 0.6, z: this.position.z, vy: 0.5, life: 0.5, size: 0.5, sizeEnd: 0.1, color: C.violet, colorEnd: C.violetDark, drag: 2 });
      if (this.dash.t >= this.dash.dur) this.dash = null;
    }
    mx += this.knock.x * dt;
    mz += this.knock.z * dt;
    this.knock.multiplyScalar(Math.exp(-8 * dt));
    ctx.world.move(this.position, RADIUS, mx, mz);
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.bobT += sp * dt * 1.9;
    this.speedNow = sp;
  }

  _dashCut(ctx) {
    for (const e of ctx.enemies) {
      if (!e.alive || this.dash.hit.has(e)) continue;
      if (e.position.distanceTo(this.position) < e.radius + 1.2) {
        this.dash.hit.add(e);
        _v.subVectors(e.position, this.position).setY(0).normalize();
        const dealt = e.takeHit(this.dash.dmg * this.run.dmgMul, _v, 4, 40, ctx);
        ctx.onDamage?.(e, dealt, false, e.position);
      }
    }
  }

  _updateCamera(dt) {
    const cam = this.camera;
    let eye = EYE;
    let roll = 0;
    // A blow taken snaps the head back and to the side, then it settles.
    const kk = this.kick;
    if (dt > 0) {
      kk.vx += (-260 * kk.x - 18 * kk.vx) * Math.min(dt, 1 / 30);
      kk.vz += (-260 * kk.z - 18 * kk.vz) * Math.min(dt, 1 / 30);
      kk.x += kk.vx * Math.min(dt, 1 / 30);
      kk.z += kk.vz * Math.min(dt, 1 / 30);
    }
    if (this.dead) {
      const k = Math.min(1, this.deathT / 1.1);
      eye = EYE - (EYE - 0.35) * k * k;
      roll = k * 1.1;
    } else if (this.wake < 1) {
      // Getting up off the floor after the fall: lying on one side, then
      // pushing up onto a knee, then standing.
      const k = this.wake;
      const up = smooth(Math.min(1, k / 0.55));
      const stand = smooth(Math.max(0, (k - 0.55) / 0.45));
      eye = 0.28 + (0.95 - 0.28) * up + (EYE - 0.95) * stand;
      roll = (1 - up) * 1.25 + Math.sin(k * 9) * 0.03 * (1 - stand);
    } else {
      eye += Math.sin(this.bobT * 2) * 0.02 * Math.min(1, (this.speedNow || 0) / WALK);
      if (this.dodgeT > 0) eye -= 0.25 * Math.sin((this.dodgeT / DODGE_TIME) * Math.PI);
      if (this.staggerT > 0) eye -= 0.06 * Math.sin(Math.min(1, this.staggerT / Math.max(0.01, this.staggerMax)) * Math.PI);
      const strafe = this.input ? this.input.moveAxes().strafe : 0;
      roll = -strafe * 0.015;
    }
    cam.position.set(this.position.x, this.position.y + eye, this.position.z);
    const sh = this.shakeT * this.shakeT;
    const t = performance.now() * 0.05;
    cam.rotation.set(this.pitch + kk.x + Math.sin(t * 1.3) * sh * 0.06, this.yaw + Math.sin(t * 1.7) * sh * 0.06, roll + kk.z + Math.sin(t) * sh * 0.04, 'YXZ');
    cam.updateMatrixWorld();
    // The viewmodel scene mirrors the camera so weapon and torch stay in hand.
    this.viewRoot.position.copy(cam.position);
    this.viewRoot.quaternion.copy(cam.quaternion);
    this.viewRoot.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------ dodge ---

  // Phantom Step (a learned skill): a double tap of A or D sidesteps, of S
  // steps back; Space or Shift dodges the way you are moving.
  _dodgeInput(ctx) {
    if (!this.run.skills?.phantomStep) return;
    const now = performance.now() / 1000;
    let dir = null;
    for (const [code, x, z] of [['KeyA', -1, 0], ['KeyD', 1, 0], ['KeyS', 0, -1]]) {
      if (!ctx.input.wasPressed(code)) continue;
      if (now - (this.taps[code] ?? -9) < DOUBLE_TAP) {
        dir = this._local(x, z, _v);
        this.taps[code] = -9;
      } else this.taps[code] = now;
    }
    if (!dir && (ctx.input.wasPressed('Space') || ctx.input.wasPressed('ShiftLeft') || ctx.input.wasPressed('ShiftRight'))) {
      dir = this.moveDirection(_v);
      if (dir.lengthSq() < 0.01) this._local(0, -1, dir);
    }
    if (!dir || this.dodgeCd > 0 || this.dodgeT > 0 || this.dash || this.staggerT > 0 || this.charge) return;
    // Not out of a heavy blow or the strike of a light one; a recovery is fine.
    const s = this.swing;
    if (s && (s.heavy || s.bounced || s.t < s.W + s.A)) return;
    this._endSwing();
    this.press = null;
    this.dodgeDir.copy(dir);
    this.dodgeT = DODGE_TIME;
    this.dodgeCd = DODGE_CD + DODGE_TIME;
    this.invuln = Math.max(this.invuln, DODGE_IFRAMES);
    ctx.audio?.dodge();
    ctx.onRhythm?.('dodge');
  }

  // A direction relative to where you face: x right, z forward.
  _local(x, z, out) {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    return out.set(-s * z + c * x, 0, -c * z - s * x).normalize();
  }

  // ----------------------------------------------------------- combat ---

  // Left button. A press is judged where it falls in the swing (Rhythm.js):
  // a perfect press starts the next swing at once; an early one is a fumble;
  // otherwise it begins a press that becomes a light swing when released, or
  // draws back a heavy one if held. Right button blocks.
  _attackInput(dt, ctx) {
    const input = ctx.input;
    if (!this.armed) {
      this.press = this.charge = null;
      this.blocking = false;
      return;
    }
    const held = input.mouseDown[0];
    const free = this.staggerT <= 0 && this.drinkT <= 0 && !this.dash && this.dodgeT <= 0 && this.wake >= 1;
    if (input.mouseClicked[0] && free && !this.charge) this._onPress(ctx);
    if (this.press) {
      this.press.t += dt;
      if (!held) {
        this.press = null;
        this._startLight(ctx, { perfect: false });
      } else if (this.press.t >= HOLD) {
        this.press = null;
        this._beginCharge(ctx);
      }
    }
    if (this.charge) {
      this.charge.t += dt;
      if (!this.charge.full && this.charge.t >= CHARGE_FULL) {
        this.charge.full = true;
        ctx.audio?.chargeFull?.();
      }
      if (!held) this._startHeavy(ctx);
    }
    // Calm resets a fumble: wait a breath and your next swing is clean.
    if (!this.swing && !this.press && !this.charge) {
      this.idleT += dt;
      if (this.idleT > 0.45) this.fumbleNext = false;
    } else this.idleT = 0;
    // A block can cut a light swing's recovery short, never a heavy blow or a
    // light one still striking.
    const s = this.swing;
    const locked = s && (s.heavy || s.bounced || s.t < s.W + s.A);
    this.blocking = !!input.mouseDown[2] && !locked && !this.charge && !this.press && this.staggerT <= 0 && this.drinkT <= 0 && this.dodgeT <= 0;
    if (this.blocking && s) this._endSwing();
  }

  _onPress(ctx) {
    const widen = relicPassive(this.run, 'window') ?? 1;
    const kind = classifyPress(this.swing, widen);
    if (kind === 'mash') {
      // Too early: thrown away. The chain breaks and the next swing drags.
      this.swing.fumbled = true;
      this.fumbleNext = true;
      this.chain = 0;
      ctx.onRhythm?.('fumble');
      return;
    }
    if (kind === 'perfect') {
      this._startLight(ctx, { perfect: true });
      return;
    }
    // Idle, or late in a recovery: light on release, heavy if held.
    this.press = { t: 0 };
  }

  _swingSpeed() {
    const m = this.weaponDef === WEAPON_TYPES.sword ? momentumSpeed(this.momentum) : 1;
    return this.run.speedMul * m;
  }

  _currentPose() {
    return { pos: this.weaponPivot.position.clone(), quat: this.weaponPivot.quaternion.clone() };
  }

  _startLight(ctx, { perfect }) {
    const def = this.weaponDef;
    const sluggish = !perfect && (this.fumbleNext || !!this.swing?.fumbled);
    const chain = perfect ? Math.min(CHAIN_MAX, this.chain + 1) : 0;
    const T = lightTiming(def, { perfect, chain, sluggish, speed: this._swingSpeed() });
    const arc = def.prepared[this.comboIndex % def.prepared.length];
    this.comboIndex++;
    const from = this._currentPose();
    this._endSwing(true);
    this.chain = chain;
    this.fumbleNext = false;
    this.swing = { arc, heavy: false, power: 0, ...T, perfect, chain, sluggish, from };
    this._swingCommon(ctx);
    ctx.onRhythm?.(perfect ? 'perfect' : sluggish ? 'sluggish' : 'swing', chain);
  }

  _beginCharge(ctx) {
    this._endSwing(true);
    this.chain = 0;
    this.charge = { t: 0, full: false, from: this._currentPose() };
    ctx.audio?.charge?.();
    for (const e of ctx.enemies) e.onPlayerSwing?.(ctx, true);
  }

  _startHeavy(ctx) {
    const def = this.weaponDef;
    const sp = this._swingSpeed();
    const power = Math.min(1, this.charge.t / CHARGE_FULL);
    this.swing = {
      arc: HEAVY_ARC,
      heavy: true,
      power,
      W: 0.07,
      A: (def.active * 1.25) / sp,
      R: (def.recover * 1.25) / sp,
      perfect: false,
      chain: 0,
      sluggish: false,
      from: this._currentPose(),
    };
    this.charge = null;
    this.fumbleNext = false;
    this._swingCommon(ctx);
    ctx.onRhythm?.('heavy', 0, power);
  }

  _swingCommon(ctx) {
    Object.assign(this.swing, { t: 0, prevK: 0, hitSet: new Set(), hits: 0, sounded: false, fumbled: false, bounced: null, counter: false });
    ctx.audio?.swingStart?.();
    if (!this.swing.heavy) for (const e of ctx.enemies) e.onPlayerSwing?.(ctx, false);
  }

  // A swing ends: sword momentum grows with every swing that lands and is
  // lost on one that hits nothing. (`cut` = cut short by the next action.)
  _endSwing(cut = false) {
    const s = this.swing;
    if (!s) return;
    this.swing = null;
    if (this.weaponDef !== WEAPON_TYPES.sword || s.bounced) return;
    if (s.hits > 0) return;
    // Cut short before its arc even finished: neither landed nor missed.
    if (cut && s.t < s.W + s.A) return;
    if (this.momentum > 0) this.momentum = 0;
  }

  // Blade pose at arc fraction k: inner and outer blade points in viewmodel
  // space (for the trail).
  _bladePoints(arc, k, base, tip) {
    arcDirection(arc, k, _a);
    gripPose(_a, arc.axis, _b, _quat);
    const [b0, b1] = this.weaponDef.blade;
    base.copy(_b).addScaledVector(_a, b0 + 0.05);
    tip.copy(_b).addScaledVector(_a, b1 + 0.1);
  }

  // A hand swinging forward and back while walking, like an arm: -1 back,
  // 1 forward. The two hands are out of step.
  _sway(phase) {
    const walk = Math.min(1, (this.speedNow || 0) / WALK);
    return Math.sin(this.bobT + phase) * walk;
  }

  _updateWeapon(dt, ctx) {
    const s = this.swing;
    const pivot = this.weaponPivot;
    pivot.visible = this.armed;
    this._weaponGlow(dt);
    if (!s) {
      const t = performance.now() * 0.001;
      const sw = this._sway(0);
      this.blockK += ((this.blocking ? 1 : 0) - this.blockK) * Math.min(1, dt * 14);
      if (this.charge) {
        // Drawn back over the shoulder; trembling once fully charged.
        const k = easeOut(Math.min(1, this.charge.t / 0.3));
        pivot.position.lerpVectors(this.charge.from.pos, this.chargePos, k);
        pivot.quaternion.slerpQuaternions(this.charge.from.quat, this.chargeQuat, k);
        if (this.charge.full) {
          pivot.position.x += Math.sin(t * 70) * 0.004;
          pivot.position.y += Math.cos(t * 63) * 0.004;
        }
        return;
      }
      // Rest pose swinging forward and back with the stride (a little higher
      // and tipped forward at the front of the swing), eased into the block;
      // dipped and shaken while staggered.
      const st = this.staggerT > 0 ? Math.sin(Math.min(1, this.staggerT / Math.max(0.01, this.staggerMax)) * Math.PI) : 0;
      _v.set(IDLE_POS.x + st * 0.05, IDLE_POS.y + sw * 0.012 + Math.sin(t * 1.3) * 0.004 - st * 0.12, IDLE_POS.z - sw * 0.055);
      _tilt.setFromAxisAngle(_side, -sw * 0.12 + st * 0.5);
      _quat.copy(this.idleQuat).premultiply(_tilt);
      if (this.blockK > 0.001) {
        _v.lerp(BLOCK_POS, this.blockK);
        _quat.slerp(this.blockQuat, this.blockK);
      }
      if (this.drinkT > 0) _v.y -= 0.3;
      // Ease there from wherever the last swing (or a bounce) left the blade.
      const back = 1 - Math.exp(-22 * dt);
      pivot.position.lerp(_v, back);
      pivot.quaternion.slerp(_quat, back);
      return;
    }
    s.t += dt;
    const { W, A, R } = s;
    const arc = s.arc;
    if (s.bounced) {
      // Thrown back off the guard: the blade rebounds along its own arc,
      // shuddering, and only then comes home.
      const b = s.bounced;
      b.t += dt;
      const k1 = Math.min(1, b.t / 0.14);
      const kk = Math.max(0, b.k - 0.35 * easeOut(k1));
      arcDirection(arc, kk, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      const shudder = Math.sin(b.t * 70) * 0.012 * (1 - Math.min(1, b.t / BOUNCE_TIME));
      if (b.t > 0.14) {
        const k2 = easeInOut(Math.min(1, (b.t - 0.14) / (BOUNCE_TIME - 0.14)));
        _pos.lerp(IDLE_POS, k2);
        _quat.slerp(this.idleQuat, k2);
      }
      pivot.position.copy(_pos);
      pivot.position.x += shudder;
      pivot.quaternion.copy(_quat);
      if (b.t >= BOUNCE_TIME) this.swing = null;
      return;
    }
    if (s.t < W) {
      const k = easeOut(s.t / W);
      arcDirection(arc, 0, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      pivot.position.lerpVectors(s.from.pos, _pos, k);
      pivot.quaternion.slerpQuaternions(s.from.quat, _quat, k);
    } else if (s.t < W + A) {
      if (!s.sounded) {
        s.sounded = true;
        ctx.audio?.swing(s.heavy ? 'heavy' : this.run.weapon.type, { perfect: s.perfect, chain: s.chain, sluggish: s.sluggish });
      }
      const k = smooth((s.t - W) / A);
      this._sweep(s, s.prevK, k, ctx);
      if (!this.swing || s.bounced) return;
      s.prevK = k;
      arcDirection(arc, k, _v);
      gripPose(_v, arc.axis, pivot.position, pivot.quaternion);
      this._trail(s, k);
    } else if (s.t < W + A + R) {
      if (s.prevK < 1) {
        this._sweep(s, s.prevK, 1, ctx);
        if (!this.swing || s.bounced) return;
        s.prevK = 1;
        this._trail(s, 1);
      }
      const k = easeInOut((s.t - W - A) / R);
      arcDirection(arc, 1, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      pivot.position.lerpVectors(_pos, IDLE_POS, k);
      pivot.quaternion.slerpQuaternions(_quat, this.idleQuat, k);
    } else {
      this._endSwing();
    }
  }

  _trail(s, k) {
    const bonus = chainBonus(s.chain);
    const style = trailStyle({ perfect: s.perfect, chain: s.chain, sluggish: s.sluggish, heavy: s.heavy, counter: s.counter, glow: s.perfect ? bonus.glow : s.heavy ? 0.55 : 0.32 });
    this.trail.trace(Math.max(0, k - (s.heavy ? 0.6 : 0.5)), k, (kk, base, tip) => this._bladePoints(s.arc, kk, base, tip), style);
  }

  // Momentum shows in the blade: it heats as the dance builds.
  _weaponGlow(dt) {
    const m = this.weaponDef === WEAPON_TYPES.sword ? this.momentum / MOMENTUM_MAX : 0;
    const want = Math.max(m, this.wrathT > 0 ? 0.7 : 0);
    this._glow = (this._glow ?? 0) + (want - (this._glow ?? 0)) * Math.min(1, dt * 6);
    if (Math.abs(this._glow - (this._glowSet ?? 0)) < 0.01) return;
    this._glowSet = this._glow;
    for (const w of this.weaponMats) {
      w.m.emissive.copy(w.c).lerp(this.wrathT > 0 ? _wrathCol : _heatCol, Math.min(1, this._glow));
      w.m.emissiveIntensity = w.i + this._glow * 0.9;
    }
  }

  // Sweep the blade from arc fraction k0 to k1, sub-stepping both the arc
  // and the camera's motion since last frame, so neither a fast swing nor a
  // flick of the mouse can tunnel through a target. The blade is a thin box
  // around its own centre line (no fat hitboxes), placed where it is seen.
  _sweep(s, k0, k1, ctx) {
    const arc = s.arc;
    const cam = this.camera;
    const camAngle = this.prevCamQ.angleTo(cam.quaternion);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(k1 - k0) * arc.angle, camAngle) / 0.05));
    const lens = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(VIEW_FOV / 2));
    const [b0, b1] = this.weaponDef.blade;
    const r = this.weaponDef.width;
    const hits = [];
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const k = k0 + (k1 - k0) * f;
      _camQ.slerpQuaternions(this.prevCamQ, cam.quaternion, f);
      _camP.lerpVectors(this.prevCamP, cam.position, f);
      arcDirection(arc, k, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      // Blade centre line in camera space, pushed out to where it is seen,
      // then into the world.
      _a.copy(_pos).addScaledVector(_v, b0);
      _b.copy(_pos).addScaledVector(_v, b1 + 0.08);
      _a.x *= lens;
      _a.y *= lens;
      _b.x *= lens;
      _b.y *= lens;
      _a.applyQuaternion(_camQ).add(_camP);
      _b.applyQuaternion(_camQ).add(_camP);
      _mid.addVectors(_a, _b).multiplyScalar(0.5);
      _seg.subVectors(_b, _a);
      const len = _seg.length();
      _seg.divideScalar(len || 1);
      _ax.set(0, 1, 0).cross(_seg);
      if (_ax.lengthSq() < 1e-6) _ax.set(1, 0, 0);
      _ax.normalize();
      _az.crossVectors(_ax, _seg);
      this.blade.set(_mid, _ax, _seg, _az, _half.set(r, len / 2, r));
      this.bladeSeg.a.copy(_a);
      this.bladeSeg.b.copy(_b);
      queryHurtboxes(this.blade, ctx.enemies, s.hitSet, hits, this.bladeSeg);
      if (ctx.props) queryHurtboxes(this.blade, ctx.props.targets, s.hitSet, hits, this.bladeSeg);
      // Which way the blade is travelling (for blood and the body's flinch).
      if (s.lastMid) {
        _v2.subVectors(_mid, s.lastMid);
        if (_v2.lengthSq() > 1e-8) (s.travel ||= new THREE.Vector3()).copy(_v2).normalize();
      } else s.lastMid = new THREE.Vector3();
      s.lastMid.copy(_mid);
      if (hits.length) {
        this._applyHits(hits, ctx);
        hits.length = 0;
        if (!this.swing || s.bounced) return;
      }
    }
  }

  _applyHits(hits, ctx) {
    const s = this.swing;
    // Urns and barrels just smash.
    const props = hits.filter((h) => h.target.isProp);
    for (const h of props) h.target.smash(ctx, _v2.subVectors(h.target.position, this.position).setY(0).normalize());
    hits = hits.filter((h) => !h.target.isProp);
    if (!hits.length) {
      if (props.length) ctx.hitStop?.(0.03);
      return;
    }
    const def = this.weaponDef;
    const run = this.run;
    const w = run.weapon;
    const heavy = s.heavy;
    const bonus = chainBonus(s.chain);
    let total = 0;
    let anyCounter = false;
    let anyCrit = false;
    for (const h of hits) {
      const e = h.target;
      const dir = new THREE.Vector3().subVectors(e.position, this.position).setY(0).normalize();

      // A raised guard: the blow bounces off, unless the weapon breaks it.
      let guard = null;
      if (e.isGuardingAgainst?.(this.position)) {
        guard = guardOutcome(w.type, heavy, s.power);
        if (guard === 'bounce') {
          e.clash(ctx, h.point);
          this._bounce(ctx, h.point);
          return;
        }
        if (guard === 'shatter') {
          e.guardBreak(ctx, h.point);
          ctx.onCombat?.('guardBreak', h.point);
          ctx.audio?.guardBreak?.();
        } else {
          e.stumble(ctx, STUMBLE.heavy, dir);
          ctx.onCombat?.('crash', h.point);
          ctx.audio?.guardBreak?.();
        }
      }

      // Caught winding up: a counter-hit (the Wrathful Brand makes any blow one).
      const counter = !guard && (e.isWindingUp?.() || this.wrathT > 0);
      if (this.wrathT > 0 && counter) this.wrathT = 0;
      const crit = h.part.multiplier > 1.2;
      let amount = w.damage * run.dmgMul * h.part.multiplier * (0.93 + Math.random() * 0.14);
      if (heavy) amount *= 1.6 + 0.8 * s.power;
      if (s.perfect) amount *= bonus.damage * (1 + (relicPassive(run, 'perfectDamage') ?? 0));
      if (s.sluggish) amount *= 0.85;
      if (counter) amount *= heavy ? 2.5 : 2;
      if (guard === 'crash') amount *= 0.6;
      const force = (heavy ? 1 + s.power * 0.8 : 0.55) * (counter ? 1.5 : 1) * (w.type === 'mace' ? 1.3 : 1);
      const dealt = e.takeHit(amount, dir, def.knockback * (heavy ? 1.8 : 1) * (counter ? 1.4 : 1), def.stagger * (heavy ? 2.5 : 1), ctx, { heavy, contact: h.point, sweep: s.travel, force });
      total += dealt;
      s.hits++;
      ctx.onDamage?.(e, dealt, crit || counter, h.point, counter ? 'counter' : s.perfect ? 'perfect' : null);

      // Weapon personality.
      if (e.alive) {
        if (w.type === 'axe') e.applySunder?.(heavy ? 2 : 1, ctx);
        if (w.type === 'mace' && guard !== 'crash' && (!e.isBoss || heavy)) e.stumble?.(ctx, heavy ? STUMBLE.heavy : STUMBLE.light, dir);
        if (counter && e.state !== 'stagger' && (!e.isBoss || heavy)) e.interrupt?.(ctx, 0.9);
      }

      // Blood thrown along the blade's travel, sparks at the contact.
      const tv = s.travel || dir;
      for (let i = 0; i < (heavy ? 26 : 16); i++) {
        const sp = 2.5 + Math.random() * 3.5;
        ctx.fx.alpha.emit({ x: h.point.x, y: h.point.y, z: h.point.z, vx: tv.x * sp + (Math.random() - 0.5) * 2, vy: tv.y * sp + Math.random() * 2, vz: tv.z * sp + (Math.random() - 0.5) * 2, life: 0.5 + Math.random() * 0.5, size: 0.1, sizeEnd: 0.03, color: C.blood, colorEnd: C.bloodDark, gravity: -9, drag: 1.2 });
      }
      burst(ctx.fx.add, h.point, { count: counter ? 22 : 8, speed: counter ? 7 : 5, size: 0.06, life: 0.25 });

      // Procs: what this hit earned.
      const triggers = new Set(['hit']);
      if (s.perfect) triggers.add('perfect');
      if (counter) triggers.add('counter');
      if (crit) triggers.add('crit');
      if (heavy && s.power >= 0.99) triggers.add('heavy');
      if (!e.alive) {
        triggers.add('kill');
        if (heavy) triggers.add('heavyKill');
      }
      this.procs.fire(ctx, run, { triggers, enemy: e, point: h.point.clone(), dir, chain: s.chain, chainMul: bonus.proc, counter, damage: dealt, weaponDamage: w.damage * run.dmgMul, heavy });

      if (counter) {
        anyCounter = true;
        s.counter = true;
        ctx.onCombat?.('counter', h.point);
      }
      if (crit) anyCrit = true;
    }
    if (total > 0) {
      // Momentum: every landed swing adds to it (counted once per swing).
      if (w.type === 'sword' && s.hits === hits.length) {
        this.momentum = Math.min(MOMENTUM_MAX, this.momentum + 1);
        this.momentumT = 0;
      }
      let stop = def.hitstop * (hits.length > 1 ? 1.4 : 1) * (heavy ? 1.7 : 1) + (s.perfect ? 0.006 * s.chain : 0);
      if (anyCounter) stop = Math.max(stop, 0.14);
      ctx.hitStop?.(stop);
      ctx.audio?.hit(heavy ? 'heavy' : w.type, { counter: anyCounter, perfect: s.perfect, chain: s.chain, crit: anyCrit });
      this.shake(anyCounter ? 0.5 : heavy ? 0.3 : 0.12);
      if (this.siphonT > 0) this.heal(total * this.siphonLeech);
    }
  }

  // The blade rang off a guard: it is thrown back and you are left reeling.
  _bounce(ctx, at) {
    const s = this.swing;
    s.bounced = { t: 0, k: s.prevK };
    this.chain = 0;
    this.fumbleNext = false;
    if (this.weaponDef === WEAPON_TYPES.sword) this.momentum = 0;
    this.staggerT = this.staggerMax = BOUNCE_TIME + (s.heavy ? 0.25 : 0.12);
    ctx.hitStop?.(0.07);
    this.shake(0.28);
    this.kick.vz += (Math.random() < 0.5 ? -1 : 1) * 1.2;
    this.kick.vx += 0.8;
    ctx.audio?.clash?.();
    ctx.onCombat?.('clash', at);
  }

  _updateTorch(dt, ctx) {
    const t = performance.now() * 0.001;
    const f = 0.85 + Math.sin(t * 13) * 0.08 + Math.sin(t * 7.3) * 0.07;
    const lit = this.torchLit;
    // Swings forward and back with the stride, out of step with the weapon.
    const sw = this._sway(Math.PI);
    this.torch.position.set(TORCH_POS.x, TORCH_POS.y + sw * 0.012 - (1 - this.torchRaise) * 0.5, TORCH_POS.z - sw * 0.055);
    this.torch.rotation.set(TORCH_ROT.x - sw * 0.12, TORCH_ROT.y, TORCH_ROT.z);
    // The flame trails behind the torch's own motion (walking, turning,
    // swinging), and rises toward the sky however the torch is held.
    this.torch.updateMatrixWorld(true);
    this.fire.group.getWorldPosition(_v);
    this.fire.group.getWorldQuaternion(_wq).invert();
    if (dt > 0) {
      _v2.subVectors(_v, this.prevTorch).divideScalar(dt);
      if (_v2.lengthSq() > 400) _v2.set(0, 0, 0); // a teleport, not a motion
      _v2.negate().applyQuaternion(_wq);
    } else _v2.set(0, 0, 0);
    this.prevTorch.copy(_v);
    _up.set(0, 1, 0).applyQuaternion(_wq);
    this.fire.update(dt, t, _v2, _up);
    this.fire.setIntensity(lit);
    // World light rides with the torch.
    this.torch.getWorldPosition(_v);
    this.torchLight.position.copy(_v).add(_v2.set(0, this.flameY + 0.1, 0));
    this.torchLight.intensity = (ctx.torchIntensity ?? 30) * f * lit;
    this.torchLight.distance = (ctx.torchRange ?? 16) * (relicPassive(this.run || { relics: {} }, 'light') ?? 1);
  }

  // ---------------------------------------------------- health & hurt ---

  heal(amount) {
    this.run.health = Math.min(this.run.maxHealth, this.run.health + amount);
  }

  drinkPotion(ctx) {
    if (this.run.potions <= 0 || this.run.health >= this.run.maxHealth) {
      ctx.toast?.(this.run.potions <= 0 ? 'No potions' : 'Already at full health');
      return;
    }
    // Not in the middle of a blow.
    if (this.swing && (this.swing.heavy || this.swing.t < this.swing.W + this.swing.A)) return;
    this.run.potions--;
    this.drinkT = DRINK_TIME;
    this.drinkHeal = this.run.maxHealth * POTION_HEAL;
    this.swing = null;
    this.press = this.charge = null;
    ctx.audio?.drink();
  }

  shake(a) {
    this.shakeT = Math.min(1.2, this.shakeT + a);
  }

  // Player body: a capsule from 0.3 m to 1.5 m with radius 0.38.
  _closestOnBody(p, out) {
    out.set(this.position.x, clamp(p.y, this.position.y + 0.3, this.position.y + 1.5), this.position.z);
    return out;
  }

  overlapsOBB(obb) {
    obb.closestPoint(this._closestOnBody(obb.center, _seg), _v);
    this._closestOnBody(_v, _seg);
    return _v.distanceToSquared(_seg) <= 0.38 * 0.38;
  }

  overlapsSphere(c, r) {
    this._closestOnBody(c, _seg);
    return _seg.distanceToSquared(c) <= (r + 0.38) * (r + 0.38);
  }

  _die(ctx) {
    this.run.health = 0;
    this.dead = true;
    this.deathT = 0;
    this.swing = null;
    this.charge = this.press = null;
    ctx.audio?.playerDeath();
  }

  // A demon's blow. Blocked from the front, most of it is turned aside (a
  // crushing blow still breaks the block); otherwise it lands in full, more
  // when you are exposed, and staggers you: a light swing or a drawn-back
  // heavy is knocked out of your hands (a heavy already in its arc carries
  // through), and for a moment you can neither strike, block nor dodge.
  takeDamage(amount, from, knockback, ctx) {
    if (this.dead) return false;
    if (this.invuln > 0) {
      if (this.dodgeT > 0 || this.dash) ctx.onDodge?.();
      return false;
    }
    const armor = relicPassive(this.run, 'armor') ?? 0;
    const poise = relicPassive(this.run, 'poise') ?? 0;
    amount *= 1 - armor;
    const fx = this.position.x - from.x;
    const fz = this.position.z - from.z;
    const fd = Math.hypot(fx, fz);
    if (this.blocking && this.blockK > 0.5 && fd > 0.3) {
      const dot = (fx * Math.sin(this.yaw) + fz * Math.cos(this.yaw)) / fd;
      if (dot > BLOCK_FRONT) {
        amount *= BLOCK_TAKEN;
        const crushing = knockback > 6;
        knockback *= 0.35;
        this.invuln = 0.2;
        this.staggerT = this.staggerMax = crushing ? 0.4 : 0.12;
        ctx.audio?.block?.();
        this.shake(crushing ? 0.3 : 0.12);
        _v.set(this.position.x - Math.sin(this.yaw) * 0.7, this.position.y + 1.25, this.position.z - Math.cos(this.yaw) * 0.7);
        burst(ctx.fx.add, _v, { count: 22, speed: 5, size: 0.06, life: 0.3, color: C.spark, colorEnd: C.fireEdge });
        this.run.health -= Math.round(amount);
        this.knock.add(_v.set(fx / fd, 0, fz / fd).multiplyScalar(knockback));
        ctx.onCombat?.('blocked');
        if (this.run.health <= 0) this._die(ctx);
        return true;
      }
    }
    if (this.exposed) amount *= EXPOSED_DAMAGE;
    amount = Math.round(amount);
    this.run.health -= amount;
    this.hurtFlash = Math.min(1, 0.45 + amount / 40);
    this.shake(0.25 + amount / 50);
    _v.set(this.position.x - from.x, 0, this.position.z - from.z);
    if (_v.lengthSq() > 1e-6) _v.normalize();
    this.knock.addScaledVector(_v, knockback);
    this.invuln = 0.25;
    // Staggered.
    const st = clamp(0.24 + amount / 90, 0.28, 0.75) * (1 - poise);
    this.staggerT = this.staggerMax = Math.max(this.staggerT, st);
    const s = this.swing;
    if (s && !(s.heavy && s.t >= s.W)) {
      this._endSwing(true);
      this.swing = null;
    }
    this.charge = this.press = null;
    this.chain = 0;
    if (this.weaponDef === WEAPON_TYPES.sword) this.momentum = 0;
    // The head snaps away from the blow.
    const side = Math.sign(fx * Math.cos(this.yaw) - fz * Math.sin(this.yaw)) || 1;
    this.kick.vx += 1.4 + amount / 25;
    this.kick.vz += side * (1 + amount / 30);
    if (relicPassive(this.run, 'wrath')) this.wrathT = relicPassive(this.run, 'wrath');
    ctx.audio?.hurt();
    ctx.onPlayerHurt?.(amount);
    if (this.run.health <= 0) this._die(ctx);
    return true;
  }
}

const _heatCol = new THREE.Color(1, 0.45, 0.1);
const _wrathCol = new THREE.Color(1, 0.12, 0.04);
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const smooth = (k) => k * k * (3 - 2 * k);
