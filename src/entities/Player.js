import * as THREE from 'three';
import { OBB } from '../physics/OBB.js';
import { queryHurtboxes } from '../physics/Hitbox.js';
import { WEAPON_TYPES, buildWeaponMesh, arcDirection, gripPose, bladeQuaternion, prepareArc } from './Weapons.js';
import { SPELLS, SPELL_IDS, castSpell } from './Spells.js';
import { C, burst } from '../world/Particles.js';
import { softDotTexture } from '../world/Textures.js';
import { makeFlame } from '../world/Shaders.js';
import { clamp } from '../core/rng.js';

// First-person demon hunter. WASD + mouse look. Left button: a tap swings a
// light attack, holding it draws the weapon back for a heavy blow released
// when you let go. Right button blocks (most of a blow from the front is
// turned aside). Space or Shift dodges (with invulnerability frames), E
// drinks a potion, 1/2/3 cast demon spells. No armour and no regeneration:
// health only returns from potions and Blood Siphon.

const EYE = 1.65;
const RADIUS = 0.4;
const WALK = 5.2;
// Speed of the step a blow carries you forward (decays to about 0.9 m).
const LUNGE = 7;
const DODGE_SPEED = 12.5;
const DODGE_TIME = 0.3;
const DODGE_IFRAMES = 0.26;
const DODGE_CD = 0.7;
const DRINK_TIME = 0.65;
const POTION_HEAL = 0.4;

// Resting guard: held low on the right, blade raised and leaning outward
// toward the top right of the view.
const IDLE_DIR = new THREE.Vector3(0.62, 0.76, -0.28).normalize();
const IDLE_AXIS = new THREE.Vector3(0.15, 0.1, 1).normalize();
const IDLE_POS = new THREE.Vector3(0.3, -0.48, -0.52);
// Block: the blade laid across the body, flat toward the enemy.
const BLOCK_DIR = new THREE.Vector3(-0.93, 0.3, -0.2).normalize();
const BLOCK_AXIS = new THREE.Vector3(0, 0.1, 1).normalize();
const BLOCK_POS = new THREE.Vector3(0.3, -0.32, -0.46);
const BLOCK_FRONT = 0.3; // cos of the half-angle a block covers (about 72 degrees)
const BLOCK_TAKEN = 0.2; // share of a blocked blow that still lands
// Heavy attack: hold longer than HOLD to draw back; full power after CHARGE_FULL.
const HOLD = 0.22;
const CHARGE_FULL = 0.75;
const HEAVY_ARC = prepareArc({ from: [0.35, 0.93, -0.05], to: [-0.6, -0.72, -0.55] });
// Drawn back: raised high on the right, blade straight up and a little back.
const CHARGE_DIR = new THREE.Vector3(0.35, 0.93, -0.05).normalize();
const CHARGE_POS = new THREE.Vector3(0.44, -0.44, -0.82);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _camQ = new THREE.Quaternion();
const _camP = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _dir = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _roll = new THREE.Quaternion();
const _fwd = new THREE.Vector3(0, 0, 1);
const TORCH_POS = new THREE.Vector3(-0.46, -0.48, -0.68);
const TORCH_ROT = new THREE.Euler(0.12, 0, -0.14);

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
    this.prevCamQ = new THREE.Quaternion();
    this.prevCamP = new THREE.Vector3();
    this.idleQuat = bladeQuaternion(IDLE_DIR, IDLE_AXIS, new THREE.Quaternion());
    this.blockQuat = bladeQuaternion(BLOCK_DIR, BLOCK_AXIS, new THREE.Quaternion());
    this.chargeQuat = bladeQuaternion(CHARGE_DIR, HEAVY_ARC.axis, new THREE.Quaternion());
    this.chargePos = CHARGE_POS.clone();

    // Viewmodel: weapon in the right hand, torch in the left.
    this.weaponPivot = new THREE.Group();
    viewRoot.add(this.weaponPivot);
    this.torch = this._buildTorch();
    viewRoot.add(this.torch);
    this.torchLight = new THREE.PointLight(0xffb070, 30, 16, 1.7);
    this.reset();
  }

  _buildTorch() {
    // Held low on the left, nearly upright, leaning a little in toward the
    // middle; the flame stands about level with the bottom third of the view.
    const g = new THREE.Group();
    g.position.copy(TORCH_POS);
    g.rotation.copy(TORCH_ROT);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.032, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x2c1c10, roughness: 0.95 }));
    stick.position.y = -0.1;
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.034, 0.12, 8), new THREE.MeshStandardMaterial({ color: 0x1a1008, roughness: 1 }));
    wrap.position.y = 0.24;
    // A living noise flame on the rag wrap, a soft glow around it.
    const flame = makeFlame({ height: 0.3, seed: 1.7, intensity: 1.15 });
    flame.position.y = 0.27;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: 0xff7a24, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.y = 0.42;
    glow.scale.set(0.46, 0.56, 1);
    g.add(stick, wrap, flame, glow);
    this.flame = flame;
    this.flameGlow = glow;
    return g;
  }

  reset() {
    this.dead = false;
    this.deathT = 0;
    this.swing = null;
    this.comboIndex = 0;
    this.queued = false;
    this.press = null;
    this.charge = null;
    this.blocking = false;
    this.blockK = 0;
    this.armed = true;
    this.torchLit = 1;
    this.torchRaise = 1;
    this.wake = 1;
    this.dodgeT = 0;
    this.dodgeCd = 0;
    this.dodgeDir = new THREE.Vector3();
    this.dash = null;
    this.invuln = 0;
    this.drinkT = 0;
    this.drinkHeal = 0;
    this.spellCd = { nova: 0, step: 0, siphon: 0 };
    this.siphonT = 0;
    this.siphonLeech = 0;
    this.hurtFlash = 0;
    this.shakeT = 0;
    this.bobT = 0;
    this.lavaT = 0;
    this.knock.set(0, 0, 0);
    this.vel.set(0, 0, 0);
  }

  attachRun(run) {
    this.run = run;
    this.setWeapon(run.weapon);
  }

  get health() {
    return this.run.health;
  }

  setWeapon(weapon) {
    this.run.weapon = weapon;
    this.weaponDef = WEAPON_TYPES[weapon.type];
    this.weaponPivot.clear();
    this.weaponMesh = buildWeaponMesh(weapon);
    this.weaponPivot.add(this.weaponMesh);
    const [b0, b1] = this.weaponDef.blade;
    this.hitCenter = new THREE.Vector3(0, (b0 + b1 + 0.2) / 2, 0);
    this.hitHalf = new THREE.Vector3(this.weaponDef.width, (b1 - b0 + 0.2) / 2, this.weaponDef.width);
    this.swing = null;
  }

  spawnAt(x, z, yaw) {
    this.position.set(x, 0, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.vel.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.swing = null;
    this.dash = null;
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
    this.shakeT = Math.max(0, this.shakeT - dt * 2.2);
    this.siphonT = Math.max(0, this.siphonT - dt);
    for (const id of SPELL_IDS) this.spellCd[id] = Math.max(0, this.spellCd[id] - dt);

    if (this.dead) {
      this.deathT += dt;
      this._updateCamera(dt);
      return;
    }

    if (ctx.combat) {
      for (const id of SPELL_IDS) if (input.wasPressed(SPELLS[id].key)) castSpell(id, this, ctx);
      if ((input.wasPressed('KeyE') || input.wasPressed('KeyR')) && this.drinkT <= 0) this.drinkPotion(ctx);
      if ((input.wasPressed('Space') || input.wasPressed('ShiftLeft') || input.wasPressed('ShiftRight')) && this.dodgeCd <= 0 && this.dodgeT <= 0 && !this.dash) {
        this.moveDirection(this.dodgeDir);
        if (this.dodgeDir.lengthSq() < 0.01) this.dodgeDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.dodgeT = DODGE_TIME;
        this.dodgeCd = DODGE_CD + DODGE_TIME;
        this.invuln = Math.max(this.invuln, DODGE_IFRAMES);
        ctx.audio?.dodge();
      }
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
    this.prevCamQ.copy(this.camera.quaternion);
    this.prevCamP.copy(this.camera.position);
  }

  _move(dt, ctx) {
    const dir = this.moveDirection(_dir);
    let speed = WALK;
    // Rooted while swinging: the blow's own lunge is the only movement.
    if (this.swing) speed = 0;
    else if (this.charge) speed *= 0.35;
    else if (this.blocking) speed *= 0.45;
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
      const strafe = this.input ? this.input.moveAxes().strafe : 0;
      roll = -strafe * 0.015;
    }
    cam.position.set(this.position.x, this.position.y + eye, this.position.z);
    const sh = this.shakeT * this.shakeT;
    const t = performance.now() * 0.05;
    cam.rotation.set(this.pitch + Math.sin(t * 1.3) * sh * 0.06, this.yaw + Math.sin(t * 1.7) * sh * 0.06, roll + Math.sin(t) * sh * 0.04, 'YXZ');
    cam.updateMatrixWorld();
    // The viewmodel scene mirrors the camera so weapon and torch stay in hand.
    this.viewRoot.position.copy(cam.position);
    this.viewRoot.quaternion.copy(cam.quaternion);
    this.viewRoot.updateMatrixWorld(true);
  }

  // ----------------------------------------------------------- combat ---

  // Left button: a tap is a light attack (queued if a swing is still
  // running); held past HOLD it draws back for a heavy one, released on let
  // go. Right button blocks.
  _attackInput(dt, ctx) {
    const input = ctx.input;
    if (!this.armed) {
      this.press = this.charge = null;
      this.blocking = false;
      return;
    }
    const lmb = input.mouseDown[0];
    if (input.mouseClicked[0] && !this.press) this.press = { t: 0 };
    if (this.press) {
      this.press.t += dt;
      if (!lmb) {
        if (this.charge) this._startSwing(ctx, true);
        else this.queued = true;
        this.press = null;
        this.charge = null;
      } else if (this.press.t > HOLD && !this.charge && !this.swing && this.drinkT <= 0) {
        this.charge = { t: 0, full: false };
        this.queued = false;
        ctx.audio?.charge?.();
      }
    }
    if (this.charge) {
      this.charge.t += dt;
      if (!this.charge.full && this.charge.t >= CHARGE_FULL) {
        this.charge.full = true;
        ctx.audio?.chargeFull?.();
      }
    }
    this.blocking = !!input.mouseDown[2] && !this.swing && !this.charge && this.drinkT <= 0 && this.dodgeT <= 0;
    if (!this.swing && !this.charge && !this.blocking && this.queued && this.drinkT <= 0) this._startSwing(ctx, false);
  }

  _startSwing(ctx, heavy = false) {
    const def = this.weaponDef;
    this.queued = false;
    const sp = this.run.speedMul;
    if (heavy) {
      const power = Math.min(1, this.charge.t / CHARGE_FULL);
      this.swing = {
        arc: HEAVY_ARC,
        heavy: true,
        power,
        W: 0.07,
        A: (def.active * 1.25) / sp,
        R: (def.recover * 1.25) / sp,
        from: { pos: this.weaponPivot.position.clone(), quat: this.weaponPivot.quaternion.clone() },
      };
    } else {
      const arc = def.prepared[this.comboIndex % def.prepared.length];
      this.comboIndex++;
      this.swing = { arc, heavy: false, power: 0, W: def.windup / sp, A: def.active / sp, R: def.recover / sp, from: null };
    }
    Object.assign(this.swing, { t: 0, prevK: 0, hitSet: new Set(), hit: false, sounded: false });
    ctx.audio?.swingStart?.();
  }

  _timings() {
    const s = this.swing;
    return { W: s.W, A: s.A, R: s.R };
  }

  // Side-to-side sway of a hand while walking: a roll about the view axis and
  // a little lateral drift, the two hands out of step like swinging arms.
  _sway(phase) {
    const walk = Math.min(1, (this.speedNow || 0) / WALK);
    return Math.sin(this.bobT + phase) * walk;
  }

  _updateWeapon(dt, ctx) {
    const s = this.swing;
    const pivot = this.weaponPivot;
    pivot.visible = this.armed;
    if (!s) {
      const t = performance.now() * 0.001;
      const sw = this._sway(0);
      this.blockK += ((this.blocking ? 1 : 0) - this.blockK) * Math.min(1, dt * 14);
      if (this.charge) {
        // Drawn back over the shoulder; trembling once fully charged.
        const k = easeOut(Math.min(1, this.charge.t / 0.3));
        pivot.position.lerpVectors(IDLE_POS, this.chargePos, k);
        pivot.quaternion.slerpQuaternions(this.idleQuat, this.chargeQuat, k);
        if (this.charge.full) {
          pivot.position.x += Math.sin(t * 70) * 0.004;
          pivot.position.y += Math.cos(t * 63) * 0.004;
        }
        return;
      }
      // Rest pose swaying side to side with the stride, eased into the block.
      pivot.position.set(IDLE_POS.x + sw * 0.03, IDLE_POS.y + Math.sin(t * 1.3) * 0.004, IDLE_POS.z);
      _roll.setFromAxisAngle(_fwd, -sw * 0.14);
      pivot.quaternion.copy(this.idleQuat).premultiply(_roll);
      if (this.blockK > 0.001) {
        pivot.position.lerp(BLOCK_POS, this.blockK);
        pivot.quaternion.slerp(this.blockQuat, this.blockK);
      }
      if (this.drinkT > 0) pivot.position.y -= 0.3;
      return;
    }
    const { W, A, R } = this._timings();
    s.t += dt;
    const arc = s.arc;
    if (s.t < W) {
      const k = easeOut(s.t / W);
      arcDirection(arc, 0, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      pivot.position.lerpVectors(s.from ? s.from.pos : IDLE_POS, _pos, k);
      pivot.quaternion.slerpQuaternions(s.from ? s.from.quat : this.idleQuat, _quat, k);
    } else if (s.t < W + A) {
      if (!s.sounded) {
        s.sounded = true;
        ctx.audio?.swing(s.heavy ? 'heavy' : this.run.weapon.type);
        // The blow carries you a step forward; a heavy one further.
        const lunge = LUNGE * (s.heavy ? 1.5 : 1);
        this.knock.x += Math.sin(this.yaw) * -lunge;
        this.knock.z += Math.cos(this.yaw) * -lunge;
      }
      const k = smooth((s.t - W) / A);
      this._sweep(s, s.prevK, k, ctx);
      s.prevK = k;
      arcDirection(arc, k, _v);
      gripPose(_v, arc.axis, pivot.position, pivot.quaternion);
    } else if (s.t < W + A + R) {
      if (s.prevK < 1) {
        this._sweep(s, s.prevK, 1, ctx);
        s.prevK = 1;
      }
      const k = easeInOut((s.t - W - A) / R);
      arcDirection(arc, 1, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      pivot.position.lerpVectors(_pos, IDLE_POS, k);
      pivot.quaternion.slerpQuaternions(_quat, this.idleQuat, k);
      // Combo: a buffered click cancels the tail of the recovery.
      if (this.queued && s.t - W - A > R * 0.75 && this.drinkT <= 0) this._startSwing(ctx, false);
    } else {
      this.swing = null;
    }
  }

  // Sweep the blade OBB from arc fraction k0 to k1, sub-stepping both the arc
  // and the camera motion since last frame, so a fast swing or a flick of the
  // mouse cannot tunnel through a target between frames.
  _sweep(s, k0, k1, ctx) {
    const arc = s.arc;
    const cam = this.camera;
    const camAngle = this.prevCamQ.angleTo(cam.quaternion);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(k1 - k0) * arc.angle, camAngle) / 0.09));
    const hits = [];
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const k = k0 + (k1 - k0) * f;
      _camQ.slerpQuaternions(this.prevCamQ, cam.quaternion, f);
      _camP.lerpVectors(this.prevCamP, cam.position, f);
      arcDirection(arc, k, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      _local.compose(_pos, _quat, _one);
      _world.compose(_camP, _camQ, _one).multiply(_local);
      this.blade.setFromMatrix(this.hitCenter, this.hitHalf, _world);
      queryHurtboxes(this.blade, ctx.enemies, s.hitSet, hits);
      if (ctx.props) queryHurtboxes(this.blade, ctx.props.targets, s.hitSet, hits);
    }
    if (hits.length) this._applyHits(hits, ctx);
  }

  _applyHits(hits, ctx) {
    // Urns and barrels just smash.
    const props = hits.filter((h) => h.target.isProp);
    if (props.length) {
      for (const h of props) h.target.smash(ctx, _v2.subVectors(h.target.position, this.position).setY(0).normalize());
      hits = hits.filter((h) => !h.target.isProp);
      if (!hits.length) {
        ctx.hitStop?.(0.03);
        return;
      }
    }
    const def = this.weaponDef;
    const w = this.run.weapon;
    const heavy = this.swing?.heavy;
    // A heavy blow: 1.6x damage, up to 2.4x fully charged; it staggers and
    // throws far harder.
    const mult = heavy ? 1.6 + 0.8 * this.swing.power : 1;
    let total = 0;
    for (const h of hits) {
      const e = h.target;
      const crit = h.part.multiplier > 1.2;
      const amount = Math.round(w.damage * this.run.dmgMul * mult * h.part.multiplier * (0.93 + Math.random() * 0.14));
      _v2.subVectors(e.position, this.position).setY(0).normalize();
      const dealt = e.takeHit(amount, _v2, def.knockback * (heavy ? 1.8 : 1), def.stagger * (heavy ? 2.5 : 1), ctx);
      total += dealt;
      ctx.onDamage?.(e, dealt, crit, h.point);
      burst(ctx.fx.alpha, h.point, { count: 18, speed: 3.5, color: C.blood, colorEnd: C.bloodDark, size: 0.1, life: 0.7 });
      burst(ctx.fx.add, h.point, { count: 8, speed: 5, size: 0.06, life: 0.25 });
    }
    if (total > 0) {
      ctx.hitStop?.(def.hitstop * (hits.length > 1 ? 1.4 : 1) * (heavy ? 1.7 : 1));
      ctx.audio?.hit(heavy ? 'heavy' : this.run.weapon.type);
      this.shake(heavy ? 0.3 : 0.12);
      if (this.siphonT > 0) this.heal(total * this.siphonLeech);
    }
  }

  _updateTorch(dt, ctx) {
    const t = performance.now() * 0.001;
    const f = 0.85 + Math.sin(t * 13) * 0.08 + Math.sin(t * 7.3) * 0.07;
    this.flame.userData.tick(t);
    const lit = this.torchLit;
    this.flame.scale.setScalar(Math.max(0.001, lit));
    this.flame.visible = lit > 0.01;
    this.flameGlow.material.opacity = (0.25 + (f - 0.7) * 0.5) * lit;
    // Swings side to side with the stride, out of step with the weapon.
    const sw = this._sway(Math.PI);
    this.torch.position.set(TORCH_POS.x + sw * 0.025, TORCH_POS.y - (1 - this.torchRaise) * 0.5, TORCH_POS.z);
    this.torch.rotation.set(TORCH_ROT.x, TORCH_ROT.y, TORCH_ROT.z - sw * 0.12);
    // World light rides with the torch.
    this.torch.getWorldPosition(_v);
    this.torchLight.position.copy(_v).add(_v2.set(0, 0.35, 0));
    this.torchLight.intensity = (ctx.torchIntensity ?? 30) * f * lit;
    this.torchLight.distance = ctx.torchRange ?? 16;
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
    this.run.potions--;
    this.drinkT = DRINK_TIME;
    this.drinkHeal = this.run.maxHealth * POTION_HEAL;
    this.swing = null;
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

  takeDamage(amount, from, knockback, ctx) {
    if (this.dead) return false;
    if (this.invuln > 0) {
      if (this.dodgeT > 0 || this.dash) ctx.onDodge?.();
      return false;
    }
    // A block turns most of a blow from the front aside.
    const fx = this.position.x - from.x;
    const fz = this.position.z - from.z;
    const fd = Math.hypot(fx, fz);
    if (this.blocking && this.blockK > 0.5 && fd > 0.3) {
      const dot = (fx * Math.sin(this.yaw) + fz * Math.cos(this.yaw)) / fd;
      if (dot > BLOCK_FRONT) {
        amount *= BLOCK_TAKEN;
        knockback *= 0.35;
        this.invuln = 0.2;
        ctx.audio?.block?.();
        this.shake(0.12);
        _v.set(this.position.x - Math.sin(this.yaw) * 0.7, this.position.y + 1.25, this.position.z - Math.cos(this.yaw) * 0.7);
        burst(ctx.fx.add, _v, { count: 22, speed: 5, size: 0.06, life: 0.3, color: C.spark, colorEnd: C.fireEdge });
        this.run.health -= Math.round(amount);
        this.knock.add(_v.set(fx / fd, 0, fz / fd).multiplyScalar(knockback));
        if (this.run.health <= 0) {
          this.run.health = 0;
          this.dead = true;
          this.deathT = 0;
          this.swing = null;
          ctx.audio?.playerDeath();
        }
        return true;
      }
    }
    amount = Math.round(amount);
    this.run.health -= amount;
    this.hurtFlash = Math.min(1, 0.45 + amount / 40);
    this.shake(0.2 + amount / 60);
    _v.set(this.position.x - from.x, 0, this.position.z - from.z);
    if (_v.lengthSq() > 1e-6) _v.normalize();
    this.knock.addScaledVector(_v, knockback);
    this.invuln = 0.2;
    ctx.audio?.hurt();
    ctx.onPlayerHurt?.(amount);
    if (this.run.health <= 0) {
      this.run.health = 0;
      this.dead = true;
      this.deathT = 0;
      this.swing = null;
      ctx.audio?.playerDeath();
    }
    return true;
  }
}

const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const smooth = (k) => k * k * (3 - 2 * k);
