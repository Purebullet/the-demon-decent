import * as THREE from 'three';
import { OBB } from '../physics/OBB.js';
import { queryHurtboxes } from '../physics/Hitbox.js';
import { WEAPON_TYPES, buildWeaponMesh, arcDirection, gripPose, bladeQuaternion, prepareArc, weaponReach, applyRim, betterWeapon } from './Weapons.js';
import { SPELLS, SPELL_IDS, castSpell } from './Spells.js';
import { C, burst } from '../world/Particles.js';
import { TorchFire } from '../world/TorchFire.js';
import { Assets } from '../assets/AssetLibrary.js';
import { clamp } from '../core/rng.js';
import { classifyPress, lightTiming, chainBonus, CHAIN_MAX, EXPOSED_DAMAGE } from '../combat/Rhythm.js';
import { MOMENTUM_MAX, MOMENTUM_DECAY_AFTER, momentumDamage, STUMBLE, guardOutcome } from '../combat/Styles.js';
import { relicPassive } from '../combat/Relics.js';
import { ProcEngine } from '../combat/Procs.js';
import { damageMul, swingSpeedMul, takenMul, lightStaggerChance } from '../game/Levels.js';
import { SwingTrail, trailStyle } from '../combat/SwingTrail.js';

// First-person demon hunter. WASD + mouse look.
//
// Left button: a tap is a light attack, holding draws back a heavy one that
// lands when you let go. Right button blocks (3 s at most), Shift sprints
// (2 s, refilling in 4). E drinks a potion, 1/2/3 cast demon spells, and
// once learned, Phantom Step dodges on a double tap of A, D or S (or
// Space). No armour, no regeneration.
//
// The fight runs on rhythm (combat/Rhythm.js): press again as an arc
// completes to flow into a Perfect Chain; press any earlier and the swing
// is fumbled, the next one sluggish and exposed. Nothing is queued. Light
// swings let you keep walking; a heavy blow roots you and cannot be undone.
// Blows landed in a demon's windup are counter-hits (they stagger it); blows on a raised guard
// bounce off (or break it: combat/Styles.js), and every weapon kind has its
// own personality. Hits can set off procs (combat/Procs.js) from relics.

const EYE = 1.65;
const RADIUS = 0.4;
const WALK = 5.2;
const DRINK_TIME = 0.65;
const POTION_HEAL = 0.2;

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
// Parry: a block raised this soon before a blow lands turns it aside
// entirely and throws the demon off balance (a fireball flies back at its
// caster). Not again until the block has been down a moment.
const PARRY_WINDOW = 0.2;
const PARRY_REARM = 0.35;
// A block holds for 3 s at most, then the arm gives: let go and raise it
// again once it has some strength back (it refills in 1.5 s).
const GUARD_TIME = 3;
const GUARD_REFILL = 1.5;
const GUARD_RAISE = 0.25;
// Shift sprints, for 2 s at most; it refills in 4 s (and once run dry, it
// has to refill completely before it works again).
const SPRINT = 1.6;
const SPRINT_TIME = 2;
const SPRINT_REFILL = 4;
// Slime from a smashed urn coats the blade until you raise the block: then
// it catches, a flaming blade for this long (harder blows that set demons
// burning, and the light reaches further).
const FLAME_TIME = 12;
const FLAME_DAMAGE = 1.25;
const FLAME_LIGHT = 1.45;
// Heavy attack: a press held longer than HOLD draws back; full power after CHARGE_FULL.
const HOLD = 0.28;
const CHARGE_FULL = 0.9;
const HEAVY_ARC = prepareArc({ from: [0.35, 0.93, -0.05], to: [-0.6, -0.72, -0.55] });
// Drawn back: raised high on the right, blade straight up and a little back.
const CHARGE_DIR = new THREE.Vector3(0.35, 0.93, -0.05).normalize();
const CHARGE_POS = new THREE.Vector3(0.44, -0.44, -0.82);
// A weapon thrown back off a guard: how long until it is yours again.
const BOUNCE_TIME = 0.42;
// Phantom Step: two taps of a direction key within this long.
// The viewmodel is drawn with a narrower lens than the world (Game.js), so
// the blade on screen sits nearer the middle than the same camera-space
// point would in the world. Hit tests push it out by tan(world/2)/tan(view/2)
// so a blow lands exactly where the blade is seen.
const VIEW_FOV = 62;
// Depth slices a swing is tested in, as multiples of the blade's own distance
// from the eye (see _sweep), and a little grace either side of the edge.
const SLICES = [1, 1.3, 1.65, 2.05, 2.5, 3.1, 3.8];
const BLADE_GRACE = 0.035;
// Leeway on the side the blade is travelling to (metres at the blade's own
// distance, so an angle): a blow still lands on a demon a little past where
// the swing ends, left or right as it sweeps.
const SWING_LEEWAY = 0.22;
// And across the view: a blade sweeping leftward also catches what stands
// up to this much further left (radians), rightward likewise; a straight
// chop down, nothing either side.
const SIDE_LEEWAY = 0.35;
// How brightly the weapon in hand shows its rarity at its edges (common first).
const HELD_RIM = [0.12, 0.2, 0.24, 0.3, 0.4];

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
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _d = new THREE.Vector3();
const _tm = new THREE.Vector3();
const _tv = new THREE.Vector3();
const _ga = new THREE.Vector3();
const _gb = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
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

// A heavy blow's weight against a demon's poise: enough to stagger any of
// them (not a lord, whose poise has no bottom).
const HEAVY_STAGGER = 1e6;

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
    // Held fast in a giant's fist ({ by, at }), or flung through the air
    // ({ vx, vy, vz }): see seize/toss.
    this.held = null;
    // Jaws locked on you (a hound's maul): { by }; and how hard the view
    // thrashes with it (eases off once it lets go).
    this.pinned = null;
    this.thrash = 0;
    this.air = null;
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
    this.bladeFx = this._buildBladeFx();
    this.torchLight = new THREE.PointLight(0xffb070, 30, 16, 1.7);
    this.prevTorch = new THREE.Vector3();
    this.flashFx = { color: new THREE.Color(), base: 0, t: 0, dur: 1 };
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
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.032, 0.7, 16), new THREE.MeshStandardMaterial({ color: 0x2c1c10, roughness: 0.95 }));
      stick.position.y = -0.1;
      const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.034, 0.12, 16), new THREE.MeshStandardMaterial({ color: 0x1a1008, roughness: 1 }));
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
    this.blockHeld = 0;
    this.parryOpen = false;
    this.parryCd = 0;
    this.guard = 1;
    this.guardSpent = false;
    this.coatT = 0;
    this.flameT = 0;
    this.sprint = 1;
    this.sprinting = false;
    this.sprintSpent = false;
    this.burnT = 0;
    this.burnDps = 0;
    this.burnTick = 0;
    this.armed = true;
    this.torchLit = 1;
    this.torchRaise = 1;
    this.wake = 1;
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
    this.jolt = 0;
    this.bobT = 0;
    this.stepN = 0;
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
    // The best blade the run has held, for the end of it.
    if (!this.run.bestWeapon || weapon.damage > this.run.bestWeapon.damage) this.run.bestWeapon = weapon;
    // Every weapon the run takes in hand (its best copy of each), for the
    // memory the next runs draw on (Weapons.rememberWeapons).
    if (weapon.rarity >= 0) {
      const found = (this.run.found ||= {});
      if (betterWeapon(weapon, found[weapon.model])) found[weapon.model] = weapon;
    }
    this.weaponDef = WEAPON_TYPES[weapon.type];
    // Where this one's blade (or head) is, from its own model.
    const { blade, steel } = weaponReach(weapon);
    this.bladeSpan = blade;
    this.weaponPivot.clear();
    this.weaponMesh = buildWeaponMesh(weapon, { own: true });
    this.weaponPivot.add(this.weaponMesh);
    this.weaponMats = [];
    const [b0, b1] = blade;
    this.weaponPivot.updateMatrixWorld(true);
    const fromPivot = new THREE.Matrix4().copy(this.weaponPivot.matrixWorld).invert();
    this.weaponMesh.traverse((o) => {
      if (o.isMesh && o.material.emissive) {
        const u = bladeMask(o.material, new THREE.Matrix4().multiplyMatrices(fromPivot, o.matrixWorld), steel);
        // Its rarity, faintly, along its edges.
        if (weapon.rarity >= 0) applyRim(o.material, weapon.color, HELD_RIM[weapon.rarity]);
        this.weaponMats.push({ m: o.material, c: o.material.emissive.clone(), i: o.material.emissiveIntensity, u });
      }
    });
    // Flames ride up the blade (or the head of an axe or mace).
    const tip = b1 - 0.1;
    const n = this.bladeFx.fires.length;
    this.bladeFx.fires.forEach((f, k) => {
      f.group.position.set(0, steel + (tip - steel) * (0.06 + (k / (n - 1)) * 0.9), 0);
      this.weaponPivot.add(f.group);
    });
    this.swing = null;
    this.momentum = 0;
    this.chain = 0;
    this._glow = this._glowSet = 0;
  }

  // A weapon dressed as setWeapon dresses the one in hand (its glow kept to
  // the blade, its rarity at its edges), without taking it up: the warm-up
  // draws one, so taking the first rare weapon doesn't stall on its shader.
  previewWeapon(weapon) {
    const mesh = buildWeaponMesh(weapon, { own: true });
    mesh.traverse((o) => {
      if (!o.isMesh || !o.material.emissive) return;
      bladeMask(o.material, new THREE.Matrix4(), 0);
      if (weapon.rarity >= 0) applyRim(o.material, weapon.color, HELD_RIM[weapon.rarity]);
    });
    return mesh;
  }

  spawnAt(x, z, yaw) {
    this.held = null;
    this.pinned = null;
    this.thrash = 0;
    this.air = null;
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

  // `dt` is game time, slowed while a blow's hit-stop holds; your own feet,
  // eyes and torch run on real time (`ctx.realDt`), so a hit freezes the
  // blade in the flesh, never your movement.
  update(dt, ctx) {
    const input = ctx.input;
    this.input = input;
    const real = ctx.realDt ?? dt;
    const { dx, dy } = input.consumeMouse();
    if (!this.dead) {
      this.yaw -= dx;
      this.pitch = clamp(this.pitch - dy, -1.45, 1.45);
    }
    this.jolt = Math.max(0, this.jolt - real * 2.8);

    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.healFlash = Math.max(0, this.healFlash - dt * 2);
    this.shakeT = Math.max(0, this.shakeT - dt * 2.2);
    if (this.pinned && (!this.pinned.by.alive || this.pinned.by.state !== 'latched')) this.pinned = null;
    this.thrash = this.pinned ? Math.min(1, this.thrash + dt * 8) : Math.max(0, this.thrash - dt * 3.5);
    this.siphonT = Math.max(0, this.siphonT - dt);
    this.staggerT = Math.max(0, this.staggerT - dt);
    this.wrathT = Math.max(0, this.wrathT - dt);
    if (this.flameT > 0) {
      this.flameT = Math.max(0, this.flameT - dt);
      if (this.flameT === 0) this._extinguish(ctx);
    }
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
      // Killed in the air: down to the floor.
      this.held = null;
      if (this.air || this.position.y > 0) this._updateAir(dt, ctx);
      this._updateCamera(real);
      return;
    }

    // In a giant's fist: no moving, no striking; you can still look round.
    // Flung: you fly until you land.
    if (this.held || this.air) {
      if (this.held) this.position.copy(this.held.at);
      else this._updateAir(dt, ctx);
      this.vel.set(0, 0, 0);
      this._updateCamera(real);
      this._updateWeapon(dt, ctx);
      return;
    }

    if (ctx.combat) {
      for (const id of SPELL_IDS) {
        if (id === 'step' || !input.wasPressed(SPELLS[id].key)) continue;
        if (castSpell(id, this, ctx)) this.spellCast[id] = 0.6;
        else if (this.run.spells[id]) ctx.onSpellDenied?.(id);
      }
      if (input.wasPressed('KeyE') && this.drinkT <= 0 && this.staggerT <= 0) this.drinkPotion(ctx);
      // Held by its jaws: no dodging out, but you can strike it off.
      if (!this.pinned) this._dodgeInput(ctx);
      this._attackInput(dt, ctx);
    }

    this._updateBurn(dt, ctx);

    // Potion: heal over the drink.
    if (this.drinkT > 0) {
      const step = Math.min(dt, this.drinkT);
      this.drinkT -= step;
      this.heal((this.drinkHeal * step) / DRINK_TIME);
    }

    if (this.pinned) this.vel.set(0, 0, 0);
    else this._move(real, ctx);
    this._updateCamera(real);
    this._updateWeapon(dt, ctx);
    this._updateBladeFx(real);
    this._updateTorch(real, ctx);
    this.trail.update(dt);
    this.prevCamQ.copy(this.camera.quaternion);
    this.prevCamP.copy(this.camera.position);
  }

  // Caught (by a boss's grab): whatever you were doing is cut short.
  seize(by) {
    this.held = { by, at: this.position.clone() };
    this.air = null;
    if (this.swing) this._endSwing(true);
    this.charge = null;
    this.press = null;
    this.blocking = false;
    this.dash = null;
  }

  // Latched on to (Enemy._latch): held where you stand, the view thrashing.
  pin(by) {
    this.pinned = { by };
    this.dash = null;
    this.blocking = false;
    this.knock.set(0, 0, 0);
  }

  unpin() {
    this.pinned = null;
  }

  // Bitten while held: straight through any guard, but it does not break
  // your swing (strike it off).
  maul(amount, from, ctx) {
    if (this.dead) return;
    const armor = relicPassive(this.run, 'armor') ?? 0;
    amount = Math.max(1, Math.round(amount * (1 - armor) * takenMul(this.run)));
    this.run.health -= amount;
    this.hurtFlash = Math.min(1, 0.4 + amount / 40);
    this.jolt = Math.min(1, this.jolt + 0.35);
    const fx = this.position.x - from.x;
    const fz = this.position.z - from.z;
    const angle = Math.atan2(-fx * Math.cos(this.yaw) + fz * Math.sin(this.yaw), fx * Math.sin(this.yaw) + fz * Math.cos(this.yaw));
    ctx.audio?.hurt();
    ctx.onPlayerHurt?.(amount, angle);
    if (this.run.health <= 0) this._die(ctx);
  }

  release() {
    this.held = null;
    if (this.position.y > 0) this.air = { vx: 0, vy: 0, vz: 0 };
  }

  // Thrown: up and away; you come down where you come down.
  toss(vx, vy, vz) {
    this.held = null;
    this.air = { vx, vy, vz };
  }

  _updateAir(dt, ctx) {
    const a = this.air || (this.air = { vx: 0, vy: 0, vz: 0 });
    ctx.world.move(this.position, RADIUS, a.vx * dt, a.vz * dt);
    this.position.y += a.vy * dt;
    a.vy -= 22 * dt;
    if (this.position.y <= 0) {
      this.position.y = 0;
      this.air = null;
      if (!this.dead) {
        this.shake(0.45);
        this.jolt = Math.min(1, this.jolt + 0.6);
        this.staggerT = this.staggerMax = 0.7;
        ctx.audio?.slam?.(this.position);
      }
    }
  }

  _move(dt, ctx) {
    const dir = this.moveDirection(_dir);
    let speed = WALK;
    // Sprint: Shift while moving freely (not striking, blocking, drawing a
    // heavy blow, drinking or reeling).
    const want = !!(this.input?.isDown('ShiftLeft') || this.input?.isDown('ShiftRight'));
    const free = dir.lengthSq() > 0 && !this.swing && !this.charge && !this.blocking && this.staggerT <= 0 && this.drinkT <= 0 && this.wake >= 1;
    this.sprinting = want && free && !this.sprintSpent && this.sprint > 0;
    if (this.sprinting) {
      this.sprint = Math.max(0, this.sprint - dt / SPRINT_TIME);
      if (this.sprint <= 0) this.sprintSpent = true;
      speed *= SPRINT;
    } else {
      this.sprint = Math.min(1, this.sprint + dt / SPRINT_REFILL);
      if (this.sprint >= 1) this.sprintSpent = false;
    }
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
    // A footfall at the bottom of each dip of the head, sounding of the
    // ground underfoot.
    const step = Math.floor((this.bobT * 2 + Math.PI / 2) / (2 * Math.PI));
    if (step !== this.stepN) {
      this.stepN = step;
      if (sp > 1.5 && !this.dash) ctx.audio?.footstep?.(ctx.ground, sp / WALK);
    }
  }

  _dashCut(ctx) {
    for (const e of ctx.enemies) {
      if (!e.alive || this.dash.hit.has(e)) continue;
      if (e.position.distanceTo(this.position) < e.radius + 1.2) {
        this.dash.hit.add(e);
        _v.subVectors(e.position, this.position).setY(0).normalize();
        const dealt = e.takeHit(this.dash.dmg * damageMul(this.run), _v, 4, 40, ctx);
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
      if (this.dash) eye -= 0.2 * Math.sin(Math.min(1, this.dash.t / this.dash.dur) * Math.PI);
      if (this.staggerT > 0) eye -= 0.06 * Math.sin(Math.min(1, this.staggerT / Math.max(0.01, this.staggerMax)) * Math.PI);
      const strafe = this.input ? this.input.moveAxes().strafe : 0;
      roll = -strafe * 0.015;
    }
    // A blow taken jolts the whole view: a hard, quick, irregular judder on
    // top of the head snapping back.
    const j = this.jolt * this.jolt;
    const tj = performance.now() * 0.001;
    const n1 = Math.sin(tj * 37) * 0.6 + Math.sin(tj * 61 + 1) * 0.4;
    const n2 = Math.sin(tj * 43 + 2) * 0.6 + Math.sin(tj * 71 + 3) * 0.4;
    const n3 = Math.sin(tj * 53 + 4);
    cam.position.set(this.position.x + n2 * j * 0.03, this.position.y + eye + n1 * j * 0.03, this.position.z);
    const sh = this.shakeT * this.shakeT;
    const t = performance.now() * 0.05;
    // Jaws on you: the view wrenched from side to side as it thrashes, and
    // pulled down to the thing hanging off you.
    const th = this.thrash;
    const tt = tj * 17;
    const thYaw = th > 0 ? (Math.sin(tt) * 0.085 + Math.sin(tt * 2.3 + 1) * 0.02) * th : 0;
    const thRoll = th > 0 ? Math.sin(tt + 0.7) * 0.11 * th : 0;
    if (th > 0) {
      const side = Math.sin(tt) * 0.06 * th;
      cam.position.x += Math.cos(this.yaw) * side;
      cam.position.z -= Math.sin(this.yaw) * side;
      cam.position.y -= 0.08 * th;
    }
    cam.rotation.set(this.pitch - 0.3 * th + kk.x + Math.sin(t * 1.3) * sh * 0.06 + n1 * j * 0.05, this.yaw + thYaw + Math.sin(t * 1.7) * sh * 0.06 + n2 * j * 0.05, roll + thRoll + kk.z + Math.sin(t) * sh * 0.04 + n3 * j * 0.07, 'YXZ');
    cam.updateMatrixWorld();
    // The viewmodel scene mirrors the camera so weapon and torch stay in hand.
    this.viewRoot.position.copy(cam.position);
    this.viewRoot.quaternion.copy(cam.quaternion);
    this.viewRoot.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------ dodge ---

  // Shade Step, everyone's dodge: Space dashes the way you are moving (WASD;
  // straight back if you stand still), through demons and untouchable for a
  // moment (Spells.js). Not out of a heavy blow or the strike of a light
  // one; a recovery is fine.
  _dodgeInput(ctx) {
    if (!ctx.input.wasPressed(SPELLS.step.key)) return;
    if (this.dash || this.staggerT > 0 || this.charge) return;
    const s = this.swing;
    if (s && (s.heavy || s.bounced || s.t < s.W + s.A)) return;
    if (!castSpell('step', this, ctx)) return;
    this.spellCast.step = 0.6;
    this._endSwing();
    this.press = null;
    this.burnT = 0;
    ctx.onRhythm?.('dodge');
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
    const free = this.staggerT <= 0 && this.drinkT <= 0 && !this.dash && this.wake >= 1;
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
    const was = this.blocking;
    // The guard gives after GUARD_TIME held (it only recovers once the button
    // is let go, so a blow knocking it down for a moment buys no time); it can
    // go up again once it has some strength back.
    if (!input.mouseDown[2] && this.guard >= GUARD_RAISE) this.guardSpent = false;
    this.blocking = !!input.mouseDown[2] && !this.guardSpent && !locked && !this.charge && !this.press && this.staggerT <= 0 && this.drinkT <= 0 && !this.dash;
    if (this.blocking) {
      this.guard = Math.max(0, this.guard - dt / GUARD_TIME);
      if (this.guard <= 0) {
        this.guardSpent = true;
        this.blocking = false;
        ctx.onCombat?.('guardSpent');
        ctx.audio?.guardDrop?.();
      }
    } else if (!input.mouseDown[2]) this.guard = Math.min(1, this.guard + dt / GUARD_REFILL);
    if (this.blocking && s) this._endSwing();
    // The parry window opens as a block goes up (if it has been down long
    // enough to re-arm).
    this.parryCd = Math.max(0, this.parryCd - dt);
    if (this.blocking && !was) {
      this.blockHeld = 0;
      this.parryOpen = this.parryCd <= 0;
      if (this.coatT > 0) this._ignite(ctx);
    } else if (this.blocking) this.blockHeld += dt;
    else if (was) this.parryCd = PARRY_REARM;
  }

  _onPress(ctx) {
    // Knocked back off a guard: the blade is not yours until it settles, and
    // a press then is simply not taken (it is no fault of timing).
    if (this.swing?.bounced) return;
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
    return swingSpeedMul(this.run);
  }

  _currentPose() {
    return { pos: this.weaponPivot.position.clone(), quat: this.weaponPivot.quaternion.clone() };
  }

  _startLight(ctx, { perfect }) {
    const def = this.weaponDef;
    const sluggish = !perfect && (this.fumbleNext || !!this.swing?.fumbled);
    const chain = perfect ? Math.min(CHAIN_MAX, this.chain + 1) : 0;
    const T = lightTiming(def, { sluggish, speed: this._swingSpeed() });
    const arc = def.prepared[this.comboIndex % def.prepared.length];
    this.comboIndex++;
    const from = this._currentPose();
    this._endSwing(true);
    // On the beat is not yet a Perfect hit: it becomes one only if it lands
    // on a demon (_applyHits); a swing off the beat breaks the chain.
    if (!perfect) this.chain = 0;
    this.fumbleNext = false;
    this.swing = { arc, heavy: false, power: 0, ...T, perfect: false, onBeat: perfect, chain, sluggish, from };
    this._swingCommon(ctx);
    ctx.onRhythm?.(perfect ? 'beat' : sluggish ? 'sluggish' : 'swing', chain);
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
      W: 0.12,
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
    Object.assign(this.swing, { t: 0, rt: 0, prevK: 0, hitSet: new Set(), hits: 0, sounded: false, fumbled: false, bounced: null, counter: false });
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
    const [b0, b1] = this.bladeSpan;
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
    s.rt += ctx.realDt ?? dt;
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
        ctx.audio?.swing(s.heavy ? 'heavy' : this.run.weapon.type, { perfect: s.perfect, chain: s.chain, sluggish: s.sluggish, flame: this.flameT > 0 });
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
    const flame = this.flameT > 0;
    const style = trailStyle({ perfect: s.perfect, chain: s.chain, sluggish: s.sluggish, heavy: s.heavy, counter: s.counter, flame, glow: s.perfect ? bonus.glow : s.heavy ? 0.55 : 0.32 });
    // A burning blade leaves a long sheet of fire behind it.
    this.trail.trace(Math.max(0, k - (flame ? 0.8 : s.heavy ? 0.6 : 0.5)), k, (kk, base, tip) => this._bladePoints(s.arc, kk, base, tip), style);
  }

  // Momentum shows in the blade: it heats as the dance builds.
  _weaponGlow(dt) {
    const m = this.weaponDef === WEAPON_TYPES.sword ? this.momentum / MOMENTUM_MAX : 0;
    const flame = this.flameT > 0;
    const slime = !flame && this.coatT > 0;
    // A burning blade glows like a coal from the guard to the tip, flickering.
    const flicker = flame ? 0.85 + Math.sin(performance.now() * 0.019) * 0.1 + Math.sin(performance.now() * 0.047) * 0.05 : 1;
    const want = flame ? 0.55 * flicker : slime ? 0.25 : Math.max(m, this.wrathT > 0 ? 0.7 : 0);
    const col = flame ? _flameCol : slime ? _slimeCol : this.wrathT > 0 ? _wrathCol : _heatCol;
    // The slime itself: the blade goes green while it is coated.
    this._coat = (this._coat ?? 0) + ((slime ? 1 : 0) - (this._coat ?? 0)) * Math.min(1, dt * 8);
    this._glow = (this._glow ?? 0) + (want - (this._glow ?? 0)) * Math.min(1, dt * 6);
    if (this._coat > 0.01) for (const w of this.weaponMats) w.u.uSlimeT.value += dt;
    const key = `${col.getHex()}|${this._glow.toFixed(2)}|${this._coat.toFixed(2)}`;
    if (key === this._glowKey) return;
    this._glowKey = key;
    for (const w of this.weaponMats) {
      w.m.emissive.copy(w.c).lerp(col, Math.min(1, this._glow));
      w.m.emissiveIntensity = w.i + this._glow * (flame ? 1.05 : 0.9);
      w.u.uSlime.value = this._coat * 0.8;
    }
  }

  // ------------------------------------------------- slime & flame ---

  // The flames along the blade (shown while it burns) and the slime that
  // drips off it (while it is coated), drawn with the viewmodel.
  _buildBladeFx() {
    // Fire the length of the blade, tallest at its root, shedding embers.
    const fires = [0, 1, 2, 3, 4, 5].map((k) => new TorchFire({ height: 0.32 - k * 0.025, width: 0.12 - k * 0.008, seed: 3.1 + k * 1.7, embers: 12, intensity: 1.6 }));
    for (const f of fires) f.setIntensity(0);
    // Slime drops: little glossy beads (lit, one draw for all) that swell on
    // the blade's edge, stretch as they hang and fall away.
    const N = 14;
    const drips = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshStandardMaterial({ color: 0x5ed82c, emissive: 0x0f3a06, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.92 }), N);
    drips.frustumCulled = false;
    drips.renderOrder = 7;
    drips.visible = false;
    this.viewRoot.add(drips);
    return { fires, drips, drops: Array.from({ length: N }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, age: 0, hang: 0, size: 0 })), heat: 0 };
  }

  // A smashed urn's slime: coats the blade (or feeds a fire already lit).
  // The coat stays on until a block sets it alight; only then does the
  // flame's time start running.
  coat(ctx) {
    if (this.flameT > 0) this.flameT = FLAME_TIME;
    else this.coatT = 1;
    ctx.audio?.slime?.();
    ctx.onCombat?.(this.flameT > 0 ? 'refuel' : 'coated');
  }

  _ignite(ctx) {
    this.flameT = FLAME_TIME;
    this.coatT = 0;
    ctx.audio?.ignite?.();
    this.flash(0xff8a2a, 40, 0.4);
    const at = this.camera.localToWorld(_v.set(0.3, -0.25, -0.8));
    burst(ctx.fx.add, at, { count: 40, speed: 3.5, color: C.fireCore, colorEnd: C.fireEdge, size: 0.12, life: 0.5, up: 1.5 });
    ctx.onCombat?.('ignite');
  }

  _extinguish(ctx) {
    const at = this.camera.localToWorld(_v.set(0.3, -0.25, -0.8));
    burst(ctx.fx.alpha, at, { count: 18, speed: 1.2, color: C.smoke, colorEnd: C.smoke, size: 0.25, life: 1, gravity: -1.5 });
    ctx.audio?.extinguish?.();
    ctx.onCombat?.('extinguish');
  }

  _updateBladeFx(dt) {
    const fx = this.bladeFx;
    const t = performance.now() * 0.001;
    // Flames: grow in, gutter in the last two seconds, out.
    const want = this.flameT > 0 ? Math.min(1, this.flameT / 2) * (0.9 + 0.1 * Math.sin(t * 17)) : 0;
    fx.heat += (want - fx.heat) * Math.min(1, dt * 8);
    this.weaponPivot.updateMatrixWorld(true);
    for (const f of fx.fires) {
      f.setIntensity(fx.heat);
      if (fx.heat <= 0.01) continue;
      // Like the torch: the flame trails its own motion and rises skyward.
      f.group.getWorldPosition(_v);
      f.group.getWorldQuaternion(_wq).invert();
      if (f.prev && dt > 0) {
        _v2.subVectors(_v, f.prev).divideScalar(dt);
        if (_v2.lengthSq() > 900) _v2.set(0, 0, 0);
        _v2.negate().applyQuaternion(_wq);
      } else _v2.set(0, 0, 0);
      (f.prev ||= new THREE.Vector3()).copy(_v);
      _up.set(0, 1, 0).applyQuaternion(_wq);
      f.update(dt, t, _v2, _up);
    }
    // Slime: drops gather on the blade and fall away.
    const coated = this.coatT > 0 && this.flameT <= 0;
    fx.drips.visible = coated || fx.drops.some((d) => d.life > 0);
    if (!fx.drips.visible) return;
    const [b0, b1] = this.bladeSpan;
    this.viewRoot.updateMatrixWorld(true);
    _q2.copy(this.viewRoot.quaternion).invert();
    const down = _v2.set(0, -1, 0).applyQuaternion(_q2);
    _q3.setFromUnitVectors(_UP, down);
    fx.drops.forEach((d, i) => {
      d.life -= dt;
      d.age += dt;
      if (d.life <= 0) {
        if (!coated || Math.random() > dt * 7) {
          fx.drips.setMatrixAt(i, _ZERO);
          return;
        }
        d.life = 0.9 + Math.random() * 0.5;
        d.age = 0;
        d.hang = 0.25 + Math.random() * 0.3;
        d.size = 0.005 + Math.random() * 0.004;
        d.spot = new THREE.Vector3((Math.random() - 0.5) * 0.025, b0 + (b1 - b0) * (0.15 + Math.random() * 0.85), 0);
        d.v.set(0, 0, 0);
      }
      let s = d.size;
      let stretch = 1;
      if (d.age < d.hang) {
        // Swelling on the blade, held by it (it moves with the swing).
        _v.copy(d.spot);
        this.weaponPivot.localToWorld(_v);
        this.viewRoot.worldToLocal(_v);
        d.p.copy(_v);
        const k = d.age / d.hang;
        s *= 0.4 + 0.6 * k;
        stretch = 1 + k * 0.8;
        d.p.addScaledVector(down, s * stretch * 0.6);
      } else {
        // Let go: falling, drawn out along the fall.
        d.v.addScaledVector(down, dt * 4);
        d.p.addScaledVector(d.v, dt);
        stretch = 1.4 + Math.min(1.2, d.v.length() * 0.6);
        s *= 0.9;
      }
      _m4.compose(d.p, _q3, _v3.set(s, s * stretch, s));
      fx.drips.setMatrixAt(i, _m4);
    });
    fx.drips.instanceMatrix.needsUpdate = true;
  }

  // Sweep the blade from arc fraction k0 to k1, sub-stepping both the arc
  // and the camera's motion since last frame, so neither a fast swing nor a
  // flick of the mouse can tunnel through a target.
  //
  // What counts is what you see. The weapon is drawn over the world, so on
  // screen it covers everything along the lines of sight behind it, out to
  // the weapon's reach. So the blade's centre line is first put where it is
  // seen (the viewmodel's narrower lens pushed out: see VIEW_FOV), then
  // carried out along those lines of sight in depth slices to the reach.
  // Each slice is a thin box around that stretch of the line of sight: a
  // demon is struck where the blade crosses it on screen, if it stands
  // within reach, with some leeway on the side the swing is heading to
  // (SWING_LEEWAY, SIDE_LEEWAY).
  _sweep(s, k0, k1, ctx) {
    const arc = s.arc;
    const cam = this.camera;
    const camAngle = this.prevCamQ.angleTo(cam.quaternion);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(k1 - k0) * arc.angle, camAngle) / 0.04));
    const lens = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(VIEW_FOV / 2));
    const def = this.weaponDef;
    const [b0, b1] = this.bladeSpan;
    const r = def.width + BLADE_GRACE;
    const reach = def.reach;
    const hits = [];
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const k = k0 + (k1 - k0) * f;
      _camQ.slerpQuaternions(this.prevCamQ, cam.quaternion, f);
      _camP.lerpVectors(this.prevCamP, cam.position, f);
      arcDirection(arc, k, _v);
      gripPose(_v, arc.axis, _pos, _quat);
      // Blade centre line in camera space, where it is seen, and which way
      // the swing carries it.
      _ca.copy(_pos).addScaledVector(_v, b0);
      _cb.copy(_pos).addScaledVector(_v, b1 + 0.08);
      _ca.x *= lens;
      _ca.y *= lens;
      _cb.x *= lens;
      _cb.y *= lens;
      _tv.crossVectors(arc.axis, _v);
      _tv.x *= lens;
      _tv.y *= lens;
      // The blade where it is, then (with leeway) turned about the eye
      // toward the side the swing is heading.
      const side = _tv.x / (Math.hypot(_tv.x, _tv.y) || 1);
      for (let ghost = 0; ghost < (Math.abs(side) > 0.05 ? 2 : 1); ghost++) {
        let a = _ca;
        let b = _cb;
        if (ghost) {
          a = _ga.copy(_ca).applyAxisAngle(_Y, -side * SIDE_LEEWAY);
          b = _gb.copy(_cb).applyAxisAngle(_Y, -side * SIDE_LEEWAY);
        }
        for (let j = 0; j < SLICES.length - 1; j++) {
          if (!this._slice(a, b, SLICES[j], SLICES[j + 1], r, reach, _tv)) continue;
          queryHurtboxes(this.blade, ctx.enemies, s.hitSet, hits, this.bladeSeg);
          if (ctx.props) queryHurtboxes(this.blade, ctx.props.targets, s.hitSet, hits, this.bladeSeg);
          if (j === 0 && !ghost) _tm.copy(this.blade.center);
        }
      }
      // Which way the blade is travelling (for blood and the body's flinch).
      if (s.lastMid) {
        _v2.subVectors(_tm, s.lastMid);
        if (_v2.lengthSq() > 1e-8) (s.travel ||= new THREE.Vector3()).copy(_v2).normalize();
      } else s.lastMid = new THREE.Vector3();
      s.lastMid.copy(_tm);
      if (hits.length) {
        this._applyHits(hits, ctx);
        hits.length = 0;
        if (!this.swing || s.bounced) return;
      }
    }
  }

  // One depth slice of the swept line of sight: the blade's camera-space
  // centre line a-b scaled out from the eye by s0..s1 (which keeps it on the
  // same pixels), cut off at the reach, as a box in the world (this.blade)
  // with its centre line (this.bladeSeg), stretched SWING_LEEWAY ahead
  // toward `travel` (the way the swing moves it). False if the slice is out
  // of reach.
  _slice(a, b, s0, s1, r, reach, travel) {
    const sm = (s0 + s1) / 2;
    // Clip the line at this depth to the sphere of reach round the eye.
    _d.subVectors(b, a);
    const lim = (reach / sm) ** 2;
    const A = _d.lengthSq();
    const B = 2 * a.dot(_d);
    const Cq = a.lengthSq() - lim;
    let t0 = 0;
    let t1 = 1;
    if (A < 1e-9) {
      if (Cq > 0) return false;
    } else {
      const disc = B * B - 4 * A * Cq;
      if (disc <= 0) return false;
      const q = Math.sqrt(disc);
      t0 = Math.max(0, (-B - q) / (2 * A));
      t1 = Math.min(1, (-B + q) / (2 * A));
      if (t1 - t0 < 0.02) return false;
    }
    _a.copy(a).addScaledVector(_d, t0).multiplyScalar(sm);
    _b.copy(a).addScaledVector(_d, t1).multiplyScalar(sm);
    _mid.addVectors(_a, _b).multiplyScalar(0.5);
    const along = _mid.length();
    _seg.subVectors(_b, _a);
    const len = _seg.length();
    _seg.divideScalar(len || 1);
    // Depth: along the line of sight, square to the blade.
    _az.copy(_mid).divideScalar(along || 1);
    _az.addScaledVector(_seg, -_az.dot(_seg));
    if (_az.lengthSq() < 1e-6) _az.set(0, 0, 1);
    _az.normalize();
    _ax.crossVectors(_seg, _az);
    const lead = SWING_LEEWAY * sm;
    _half.set(r * sm + lead / 2, len / 2, (along * (s1 - s0)) / (2 * sm) + r * sm);
    _mid.addScaledVector(_ax, travel.dot(_ax) >= 0 ? lead / 2 : -lead / 2);
    // Into the world.
    _mid.applyQuaternion(_camQ).add(_camP);
    _ax.applyQuaternion(_camQ);
    _seg.applyQuaternion(_camQ);
    _az.applyQuaternion(_camQ);
    this.blade.set(_mid, _ax, _seg, _az, _half);
    this.bladeSeg.a.copy(_a).applyQuaternion(_camQ).add(_camP);
    this.bladeSeg.b.copy(_b).applyQuaternion(_camQ).add(_camP);
    return true;
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

      // On the beat and it landed: now it is a Perfect hit (and the chain
      // grows).
      if (s.onBeat && !s.perfect) {
        s.perfect = true;
        this.chain = s.chain;
        ctx.onRhythm?.('perfect', s.chain);
      }

      // Caught winding up: a counter-hit (the Wrathful Brand makes any blow one).
      const counter = !guard && (e.isWindingUp?.() || this.wrathT > 0);
      if (this.wrathT > 0 && counter) this.wrathT = 0;
      const crit = h.part.multiplier > 1.2;
      let amount = w.damage * damageMul(run) * h.part.multiplier * (0.93 + Math.random() * 0.14);
      if (heavy) amount *= 1.6 + 0.8 * s.power;
      if (s.perfect) amount *= bonus.damage * (1 + (relicPassive(run, 'perfectDamage') ?? 0));
      if (s.sluggish) amount *= 0.85;
      if (w.type === 'sword') amount *= momentumDamage(this.momentum);
      if (guard === 'crash') amount *= 0.6;
      if (this.flameT > 0) amount *= FLAME_DAMAGE;
      const force = (heavy ? 1 + s.power * 0.8 : 0.55) * (counter ? 1.5 : 1) * (w.type === 'mace' ? 1.3 : 1);
      // Only a heavy blow staggers a demon (any but a lord), or any blow
      // that catches it winding up (a counter: no harder, but it breaks the
      // blow off); a light one otherwise only by chance: a mace's
      // sometimes, and anyone's with points in Attack
      // (Levels.lightStaggerChance).
      const staggers = heavy || counter || Math.random() < lightStaggerChance(run, w.type);
      const dealt = e.takeHit(amount, dir, def.knockback * (heavy ? 1.8 : 1) * (counter ? 1.4 : 1), heavy ? HEAVY_STAGGER : 0, ctx, { heavy, contact: h.point, sweep: s.travel, force });
      // The wound the weapon leaves: a cut, a hacked-out chunk, a dent.
      if (dealt > 0) ctx.wounds?.hit(e, w.type, h.point, dir, s.travel, heavy);
      total += dealt;
      s.hits++;
      ctx.onDamage?.(e, dealt, crit || counter, h.point, counter ? 'counter' : s.perfect ? 'perfect' : null);

      // Weapon personality.
      // An armoured blow (gold tell) shrugs off all but a heavy one.
      if (e.alive) {
        const armored = e.armored?.() && !heavy;
        if (w.type === 'axe') e.applySunder?.(heavy ? 2 : 1, ctx);
        // (A lord reels from nothing short of a heavy blow.)
        const reels = (!e.isBoss || heavy) && !armored && e.state !== 'stagger';
        // A counter breaks the blow off: it reels.
        if (counter && reels) e.interrupt?.(ctx, 0.9);
        else if (staggers && !heavy && reels && guard !== 'crash') e.stumble?.(ctx, STUMBLE.light, dir);
        else if (staggers && w.type === 'mace' && reels && guard !== 'crash') e.stumble?.(ctx, STUMBLE.heavy, dir);
        // Struck first by a staggering blow: one already falling but not yet
        // landed is knocked aside.
        else if (staggers && e.state === 'strike' && !e.hitPlayer && reels) e.interrupt?.(ctx, 0.45);
      }

      // Blood thrown along the blade's travel, sparks at the contact.
      const tv = s.travel || dir;
      for (let i = 0; i < (heavy ? 26 : 16); i++) {
        const sp = 2.5 + Math.random() * 3.5;
        ctx.fx.alpha.emit({ x: h.point.x, y: h.point.y, z: h.point.z, vx: tv.x * sp + (Math.random() - 0.5) * 2, vy: tv.y * sp + Math.random() * 2, vz: tv.z * sp + (Math.random() - 0.5) * 2, life: 0.5 + Math.random() * 0.5, size: 0.1, sizeEnd: 0.03, color: C.blood, colorEnd: C.bloodDark, gravity: -9, drag: 1.2 });
      }
      burst(ctx.fx.add, h.point, { count: counter ? 22 : 8, speed: counter ? 7 : 5, size: 0.06, life: 0.25 });
      // A burning blade sets them alight.
      if (this.flameT > 0 && e.alive) {
        e.addStatus?.('burn', { dps: w.damage * damageMul(run) * 0.18, dur: 3 });
        burst(ctx.fx.add, h.point, { count: 18, speed: 3, color: C.fireCore, colorEnd: C.fireEdge, size: 0.14, life: 0.45, up: 1.5 });
      }

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
      this.procs.fire(ctx, run, { triggers, enemy: e, point: h.point.clone(), dir, chain: s.chain, chainMul: bonus.proc, counter, damage: dealt, weaponDamage: w.damage * damageMul(run), heavy });

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
    const burning = this.bladeFx.heat;
    // (Dimmed while a hound hangs off you: its head is right at the flame
    // and would otherwise burn out white.)
    this.torchLight.intensity = (ctx.torchIntensity ?? 30) * f * lit * (1 + 0.6 * burning) * (1 - 0.6 * this.thrash);
    this.torchLight.distance = (ctx.torchRange ?? 16) * (relicPassive(this.run || { relics: {} }, 'light') ?? 1) * (1 + (FLAME_LIGHT - 1) * burning);
    const fl = this.flashFx;
    const k = fl.t > 0 ? fl.t / fl.dur : 0;
    fl.t = Math.max(0, fl.t - dt);
    this.torchLight.color.copy(_torchCol).lerp(_burnCol, burning * 0.5).lerp(fl.color, k * 0.85);
    this.torchLight.intensity += fl.base * k;
  }

  // A burst of light around you (a spell, a proc, a counter): the torch's
  // light flares in that colour and dies back.
  flash(color, intensity, dur) {
    this.flashFx.color.setHex(color);
    this.flashFx.base = intensity;
    this.flashFx.t = this.flashFx.dur = dur;
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

  // Is the block up, freshly, and facing `from`?
  canParry(from) {
    if (!this.blocking || !this.parryOpen || this.blockHeld > PARRY_WINDOW) return false;
    const fx = from.x - this.position.x;
    const fz = from.z - this.position.z;
    const d = Math.hypot(fx, fz) || 1;
    return -(fx * Math.sin(this.yaw) + fz * Math.cos(this.yaw)) / d > BLOCK_FRONT;
  }

  // Turned aside at the last instant: no damage, the attacker reels.
  _parry(ctx, from, source) {
    this.parryOpen = false;
    this.invuln = Math.max(this.invuln, 0.15);
    source?.parried?.(ctx);
    _v.set(this.position.x - Math.sin(this.yaw) * 0.7, this.position.y + 1.3, this.position.z - Math.cos(this.yaw) * 0.7);
    burst(ctx.fx.add, _v, { count: 40, speed: 7, size: 0.08, life: 0.4, color: C.spark, colorEnd: C.fireEdge });
    ctx.hitStop?.(0.12);
    this.shake(0.22);
    this.kick.vx -= 0.6;
    this.flash(0xffd090, 30, 0.2);
    ctx.audio?.parry?.();
    ctx.onCombat?.('parry', _v.clone());
    // A parry earns the next blow as a counter (and the chain survives).
    this.wrathT = Math.max(this.wrathT, 0.9);
  }

  // Set alight (a cinder hound's bite): burns for `dur` seconds; a dodge
  // puts it out.
  ignite(dps, dur, ctx) {
    this.burnDps = Math.max(this.burnDps * (this.burnT > 0 ? 1 : 0), dps);
    this.burnT = Math.max(this.burnT, dur);
    ctx.audio?.ignite?.();
  }

  _updateBurn(dt, ctx) {
    if (this.burnT <= 0 || this.dead) return;
    this.burnT -= dt;
    this.burnTick -= dt;
    // Flames licking up in front of the eyes.
    if (Math.random() < dt * 30) {
      const s = Math.sin(this.yaw);
      const c = Math.cos(this.yaw);
      const side = (Math.random() - 0.5) * 1.4;
      ctx.fx.add.emit({ x: this.position.x - s * 0.55 + c * side, y: this.position.y + 0.9 + Math.random() * 0.3, z: this.position.z - c * 0.55 - s * side, vy: 1.6, life: 0.45, size: 0.22, sizeEnd: 0.04, color: C.fireCore, colorEnd: C.fireEdge, drag: 1.5 });
    }
    if (this.burnTick > 0) return;
    this.burnTick = 0.5;
    const n = Math.max(1, Math.round(this.burnDps * 0.5));
    this.run.health -= n;
    this.hurtFlash = Math.max(this.hurtFlash, 0.3);
    ctx.onPlayerHurt?.(n, 0, { burn: true });
    if (this.run.health <= 0) this._die(ctx);
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
  takeDamage(amount, from, knockback, ctx, source = null) {
    if (this.dead) return false;
    if (this.invuln > 0) {
      if (this.dash) ctx.onDodge?.();
      return false;
    }
    if (source && this.canParry(from)) {
      this._parry(ctx, from, source);
      return 'parry';
    }
    const armor = relicPassive(this.run, 'armor') ?? 0;
    const poise = relicPassive(this.run, 'poise') ?? 0;
    // Relic armour, and the points put into Defence.
    amount *= (1 - armor) * takenMul(this.run);
    const fx = this.position.x - from.x;
    const fz = this.position.z - from.z;
    const fd = Math.hypot(fx, fz);
    // Where it came from, relative to where you face (0 ahead, + right).
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const angle = fd > 1e-3 ? Math.atan2(-fx * cy + fz * sy, fx * sy + fz * cy) : 0;
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
        this.jolt = Math.min(1, this.jolt + (crushing ? 0.5 : 0.25));
        ctx.onPlayerHurt?.(Math.round(amount), angle, { blocked: true });
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
    this.jolt = Math.min(1, this.jolt + 0.55 + amount / 40);
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
    ctx.onPlayerHurt?.(amount, angle);
    if (this.run.health <= 0) this._die(ctx);
    return true;
  }
}

const _heatCol = new THREE.Color(1, 0.45, 0.1);
const _flameCol = new THREE.Color(1, 0.3, 0.05);
const _slimeCol = new THREE.Color(0.35, 1, 0.15);
const _UP = new THREE.Vector3(0, 1, 0);
const _ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _q3 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _slimeBody = new THREE.Color(0.32, 0.75, 0.16);
const _q2 = new THREE.Quaternion();
const _torchCol = new THREE.Color(0xffb070);
const _burnCol = new THREE.Color(0xff6a1c);
const _wrathCol = new THREE.Color(1, 0.12, 0.04);
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const smooth = (k) => k * k * (3 - 2 * k);

// Keep a weapon's glow (momentum, wrath, flame) and its slime to the blade,
// or the head of an axe or mace, not the grip: a mask from how far along the
// weapon (in the pivot's space, where `from` is where the blade starts) each
// point lies.
function bladeMask(m, toPivot, from) {
  const u = { uToPivot: { value: toPivot }, uBladeFrom: { value: from }, uSlime: { value: 0 }, uSlimeCol: { value: _slimeBody }, uSlimeT: { value: 0 } };
  // Slime is wet and alive: streaks of thicker, brighter ooze sliding down
  // the blade over a darker film, glossy where it lies, faintly glowing.
  const slime = `
    float slimeK = uSlime * vBlade;
    vec3 slimeQ = vSlimeP * vec3(55.0, 22.0, 55.0) + vec3(0.0, uSlimeT * 1.1, 0.0);
    float slimeFlow = slimeNoise(slimeQ) * 0.65 + slimeNoise(slimeQ * 2.3 + 7.1) * 0.35;
    float slimeBlob = smoothstep(0.5, 0.78, slimeFlow);`;
  const noise = `
    float slimeHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float slimeNoise(vec3 p) {
      vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(slimeHash(i), slimeHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(slimeHash(i + vec3(0.0, 1.0, 0.0)), slimeHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                 mix(mix(slimeHash(i + vec3(0.0, 0.0, 1.0)), slimeHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(slimeHash(i + vec3(0.0, 1.0, 1.0)), slimeHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }`;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uToPivot;\nuniform float uBladeFrom;\nvarying float vBlade;\nvarying vec3 vSlimeP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSlimeP = (uToPivot * vec4(position, 1.0)).xyz;\nvBlade = smoothstep(uBladeFrom - 0.03, uBladeFrom + 0.1, vSlimeP.y);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uSlime;\nuniform vec3 uSlimeCol;\nuniform float uSlimeT;\nvarying float vBlade;\nvarying vec3 vSlimeP;${noise}`)
      .replace('#include <map_fragment>', `#include <map_fragment>${slime}\ndiffuseColor.rgb = mix(diffuseColor.rgb, mix(uSlimeCol * 0.32, uSlimeCol * 0.95, slimeBlob), slimeK);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, slimeK);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, slimeK);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vBlade;\ntotalEmissiveRadiance += uSlimeCol * (0.03 + 0.1 * slimeBlob) * slimeK;');
  };
  m.customProgramCacheKey = () => 'bladeMask';
  m.needsUpdate = true;
  return u;
}
