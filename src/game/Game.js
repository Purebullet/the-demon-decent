import * as THREE from 'three';
import { Input } from '../core/Input.js';
import { Audio } from '../core/Audio.js';
import { StateMachine } from '../core/StateMachine.js';
import { ParticleSystem } from '../world/Particles.js';
import { Surface } from '../world/Surface.js';
import { Sanctum } from '../world/Sanctum.js';
import { Level } from '../world/Level.js';
import { FLOORS, FLOOR_COUNT } from '../world/LevelData.js';
import { Effects } from '../world/Effects.js';
import { Player } from '../entities/Player.js';
import { Enemy } from '../entities/Enemy.js';
import { ENEMY_TYPES } from '../entities/EnemyTypes.js';
import { Boss } from '../entities/Bosses.js';
import { Pickups } from '../entities/Pickups.js';
import { rollWeapon } from '../entities/Weapons.js';
import { AIDirector } from '../ai/AIDirector.js';
import { PathService } from '../ai/NavGrid.js';
import { newRun, NODES } from './Progression.js';
import { TRANSITIONS, nextAfterFloor } from './transitions.js';
import { Hud } from '../ui/Hud.js';
import { pushOutOfCircle } from '../physics/CollisionWorld.js';

// Owns the run and the state machine that moves the player between the
// surface lot, the 20 floors and the sanctums in between. Everything outside
// the game (renderer, input, sound, scores) comes from the host: Project 0's
// sandbox or a plain web page (src/platform).

const PLAYING = new Set(['surface', 'floor', 'sanctum']);
const FROZEN_INPUT = { consumeMouse: () => ({ dx: 0, dy: 0 }), moveAxes: () => ({ forward: 0, strafe: 0 }), wasPressed: () => false, mouseClicked: [], mouseDown: [] };
const SURFACE_TUNING = { hp: 1, dmg: 1, speed: 1, windup: 1, cooldown: 1, attackers: 2, swarm: false, aggro: 10, loot: 1 };

export class Game {
  constructor(host, { lotLabel = 'Lot #265', devFloor = 0 } = {}) {
    this.host = host;
    this.lotLabel = lotLabel;
    const r = host.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.2;
    this.renderer = r;
    this.pixelRatio = Math.min(host.pixelRatio || 1, 1, 1280 / Math.max(1, host.width));
    r.setPixelRatio(this.pixelRatio);
    this.slow = 0;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 300);
    this.viewCamera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
    this.viewScene = new THREE.Scene();
    this.viewRoot = new THREE.Group();
    this.viewScene.add(this.viewRoot);
    this.viewScene.add(new THREE.AmbientLight(0x6a4438, 1.1));
    const torchGlow = new THREE.PointLight(0xffa060, 6, 3, 1.4);
    torchGlow.position.set(-0.35, 0, -0.55);
    this.viewRoot.add(torchGlow);
    const rim = new THREE.DirectionalLight(0xff4020, 0.8);
    rim.position.set(1, -1, 0.5);
    this.viewRoot.add(rim);
    this.viewGlow = torchGlow;

    this.input = new Input(host);
    this.audio = new Audio(host);
    this.hud = new Hud(host);
    this.fx = { add: new ParticleSystem({ max: 8000, additive: true }), alpha: new ParticleSystem({ max: 3000, additive: false }) };
    this.player = new Player(this.camera, this.viewRoot);
    this.run = null;
    this.best = 0;
    this.lastFloor = 0;
    this.table = host.table || [];
    this.devFloor = devFloor;
    this.time = 0;
    this.hitStopT = 0;
    this.paused = false;
    this.busy = false;
    this.flashT = 0;
    this.flashLight = new THREE.PointLight(0xff5a1e, 0, 16, 1.5);

    // Scores live in the host (the lot's weekly table on Project 0).
    host.on('reward', (r2) => {
      if (r2?.kind === 'score' && r2.best) this.best = Math.max(this.best, r2.best);
      this._refreshTitle();
    });
    host.on('table', (top) => {
      this.table = top || [];
      this._refreshTitle();
    });
    for (const row of this.table) if (row.you) this.best = Math.max(this.best, row.score);

    this.fsm = new StateMachine(this, TRANSITIONS);
    this.fsm
      .add('title', { enter: (g) => g._enterTitle(), update: (g, dt) => g._updateTitle(dt), exit: (g) => g.hud.show('title', false) })
      .add('surface', { enter: (g) => g._enterSurface(), update: (g, dt) => g._updateSurface(dt) })
      .add('floor', { enter: (g, p) => g._enterFloor(p), update: (g, dt) => g._updateFloor(dt), exit: (g) => g._exitFloor() })
      .add('sanctum', { enter: (g, p) => g._enterSanctum(p), update: (g, dt) => g._updateSanctum(dt), exit: (g) => g.hud.hideChoice() })
      .add('dead', { enter: (g) => g._enterEnd(false), update: (g, dt) => g._updateEnd(dt), exit: (g) => g.hud.show('death', false) })
      .add('victory', { enter: (g) => g._enterEnd(true), update: (g, dt) => g._updateEnd(dt), exit: (g) => g.hud.show('victory', false) });

    this.input.onLockChange = (locked) => {
      if (!locked && PLAYING.has(this.fsm.currentName) && !this.busy && !this.input.touch) {
        this.paused = true;
        this.hud.show('pause', true);
      } else if (locked && this.paused) {
        this.paused = false;
        this.hud.show('pause', false);
      }
    };
    host.on('resize', () => this._resize());
    this._resize();
    this.fsm.change('title');
    host.hud(
      'WASD move · mouse aim · click attack · Space/Shift dodge · F potion · 1 2 3 spells · E take/use · M mute.\n' +
        'Twenty floors, one life: die and you start again at the surface. Your deepest floor goes on the weekly table.\n' +
        'Click or press any key for sound.',
    );
    host.loop((dt) => this._frame(dt));
  }

  _resize() {
    const w = Math.max(1, this.host.width);
    const h = Math.max(1, this.host.height);
    for (const c of [this.camera, this.viewCamera]) {
      c.aspect = w / h;
      c.updateProjectionMatrix();
    }
    const ph = h * this.renderer.getPixelRatio();
    this.fx.add.setViewport(ph, this.camera.fov);
    this.fx.alpha.setViewport(ph, this.camera.fov);
    this.hud.resize(w, h);
  }

  // Draw every kind of material once before the scene is shown, one per
  // frame, into a 4 x 4 pixel corner behind the black fade. Some renderers
  // (and the software renderer of Project 0's review) only really compile a
  // shader on its first draw, which would otherwise freeze a frame for
  // seconds when a floor opens or the first blood is spilled. Things that
  // appear later (loot, telegraphs, fireballs, summons, damage numbers) are
  // staged briefly so their shaders warm too.
  async warmUp() {
    this.compiling = true;
    const t0 = performance.now();
    const rc = this.host.camera || this.camera;
    const staged = this._stageExtras();
    const jobs = [];
    const seen = new Set();
    const textures = new Set();
    const collect = (scene, cam) => {
      scene.updateMatrixWorld(true);
      scene.traverse((o) => {
        if (!o.material || !(o.isMesh || o.isPoints || o.isSprite || o.isLine)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const t of [m.map, m.normalMap, m.emissiveMap, m.bumpMap, m.roughnessMap, m.metalnessMap]) if (t) textures.add(t);
          const key = [m.type, m.customProgramCacheKey?.(), m.vertexShader?.length, m.fragmentShader?.length, !!m.map, !!m.emissiveMap, !!m.bumpMap, !!m.normalMap, !!m.roughnessMap, !!m.metalnessMap, m.vertexColors, m.transparent, m.blending, m.side, m.fog, o.isInstancedMesh, o.isSkinnedMesh].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          jobs.push([o, scene, cam]);
        }
      });
    };
    collect(this.scene, rc);
    collect(this.viewScene, this.viewCamera);
    collect(this.hud.scene, this.hud.camera);
    const r = this.renderer;
    const nextFrame = () => new Promise((res) => setTimeout(res, 16));
    // Upload every texture too, not only the first per shader.
    for (const t of textures) {
      try {
        r.initTexture(t);
      } catch {
        // Uploading early is an optimisation only.
      }
    }
    for (const [o, scene, cam] of jobs) {
      this._drawAlone(r, o, scene, cam);
      await nextFrame();
    }
    for (const o of staged) o.removeFromParent();
    this.compiling = false;
    this.host.log(`[t] warm-up: ${jobs.length} programs in ${Math.round(performance.now() - t0)} ms`);
  }

  _drawAlone(r, obj, scene, cam) {
    const hidden = [];
    scene.traverse((o) => {
      if ((o.isMesh || o.isPoints || o.isSprite || o.isLine) && o !== obj && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    });
    const chain = [];
    for (let p = obj; p; p = p.parent) {
      if (!p.visible) {
        p.visible = true;
        chain.push(p);
      }
    }
    // Empty particle systems draw nothing: show one point for the warm-up.
    const range = obj.isPoints ? { ...obj.geometry.drawRange } : null;
    if (range && range.count === 0) obj.geometry.setDrawRange(0, 1);
    const culled = obj.frustumCulled;
    obj.frustumCulled = false;
    const size = r.getSize(new THREE.Vector2());
    r.setScissorTest(true);
    r.setScissor(0, 0, 4, 4);
    r.setViewport(0, 0, 4, 4);
    try {
      r.autoClear = false;
      r.render(scene, cam);
    } catch {
      // Warming is an optimisation; a failure here only costs a later hitch.
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    r.autoClear = true;
    obj.frustumCulled = culled;
    if (range && range.count === 0) obj.geometry.setDrawRange(range.start, range.count);
    for (const o of hidden) o.visible = true;
    for (const o of chain) o.visible = false;
  }

  // Things that show up mid-game, staged far away so warm-up draws them.
  _stageExtras() {
    const staged = [];
    const far = (o) => {
      o.position.set(0, -500, 0);
      this.scene.add(o);
      staged.push(o);
    };
    this.hud.damageNumber(new THREE.Vector3(0, -500, 0), 1, false);
    if (this.pickups) {
      const before = this.pickups.items.length;
      this.pickups.addPotion(0, 0);
      this.pickups.addSpell(0, 0);
      this.pickups.addWeapon(0, 0, rollWeapon(this.run?.floor || 1, 0));
      for (const it of this.pickups.items.splice(before)) {
        it.mesh.removeFromParent();
        far(it.mesh);
      }
    }
    if (this.effects) {
      const t = this.effects.telegraph(0, 0, 1, 1e9, null);
      this.effects.items.splice(this.effects.items.indexOf(t), 1);
      t.group.removeFromParent();
      far(t.group);
      this.effects.fireball(new THREE.Vector3(0, -500, 0), new THREE.Vector3(1, 0, 0), 0, 0);
      const fb = this.effects.projectiles.pop();
      fb.mesh.removeFromParent();
      far(fb.mesh);
    }
    if (this.level) {
      // Boss summons and burrowed ambushers arrive mid-fight.
      for (const type of Object.keys(ENEMY_TYPES)) far(new Enemy(type, { x: 0, z: 0 }, this.level.def).root);
    }
    return staged;
  }

  // First screen: compile, then lift the opening black.
  async ready() {
    await this.warmUp();
    this.hud.fade(false, 900);
  }

  // Fade out, switch state, compile, fade in. Guards against double triggers.
  async goto(name, params) {
    if (this.busy) return;
    this.busy = true;
    await this.hud.fade(true, 500);
    const t0 = performance.now();
    this.fsm.change(name, params);
    this.host.log(`[t] enter ${name}: ${Math.round(performance.now() - t0)} ms`);
    await this.warmUp();
    await this.hud.fade(false, 600);
    this.busy = false;
    const next = this.pendingGoto;
    this.pendingGoto = null;
    if (next) this.goto(next.name, next.params);
  }

  _newScene({ fog = 0x0b0606, density = 0.04, background = 0x050202 } = {}) {
    this.scene?.clear();
    const s = new THREE.Scene();
    s.background = new THREE.Color(background);
    s.fog = new THREE.FogExp2(fog, density);
    s.add(this.fx.add.points, this.fx.alpha.points, this.player.torchLight, this.flashLight);
    this.fx.add.clear();
    this.fx.alpha.clear();
    this.fx.add.setFogDensity(density);
    this.fx.alpha.setFogDensity(density);
    this.flashLight.intensity = 0;
    this.scene = s;
    this.hud.setWorld(s);
    return s;
  }

  // Shared callbacks handed to entities each frame.
  _baseCtx(extra) {
    return {
      time: 0,
      input: this.input,
      player: this.player,
      fx: this.fx,
      audio: this.audio,
      enemies: [],
      combat: true,
      torchIntensity: 30,
      torchRange: 16,
      tuning: SURFACE_TUNING,
      hitStop: (s) => (this.hitStopT = Math.max(this.hitStopT, s)),
      shake: (a) => this.player.shake(a),
      flash: (color, intensity, dur) => {
        this.flashLight.color.setHex(color);
        this.flashLight.position.copy(this.player.position).setY(1.5);
        this.flashLight.userData.base = intensity * 6;
        this.flashT = dur;
        this.flashDur = dur;
      },
      onDamage: (e, amount, crit, point) => this.hud.damageNumber(point || e.position, amount, crit),
      onPlayerHurt: () => {},
      onDodge: () => {},
      toast: (t) => this.hud.toast(t),
      announce: (t, sub) => this.hud.announce(t, sub),
      ...extra,
    };
  }

  // ---------------------------------------------------------------- title ---

  _surfaceScene() {
    if (!this.surface) this.surface = new Surface();
    const s = this._newScene({ fog: 0x0d0606, density: 0.022, background: 0x050203 });
    s.add(this.surface.group);
    this.surface.setScores({ best: this.best, last: this.lastFloor, top: this.table[0] || null });
  }

  _refreshTitle() {
    this.hud.setTitleInfo({
      best: this.best,
      table: this.table,
      dev: this.devFloor ? `Dev start: floor ${this.devFloor} (scores not recorded)` : '',
    });
  }

  _enterTitle() {
    this._surfaceScene();
    this.hud.setPlaying(false);
    this.hud.show('title', true);
    this._refreshTitle();
    this.viewRoot.visible = false;
    this.orbit = 0;
  }

  _updateTitle(dt) {
    this.orbit += dt * 0.06;
    const a = this.orbit;
    this.camera.position.set(Math.sin(a) * 24, 7.5, Math.cos(a) * 24);
    this.camera.lookAt(0, -1.5, 0);
    this.camera.updateMatrixWorld();
    this.surface.update(dt, this.fx);
    if ((this.input.mouseClicked[0] || this.input.taps.length || this.input.pressed.size) && !this.busy) {
      this.audio.init();
      this.input.requestLock();
      this.goto('surface');
    }
  }

  // -------------------------------------------------------------- surface ---

  _enterSurface() {
    this._surfaceScene();
    // Permadeath: a fresh run every time you stand on the surface.
    this.run = newRun();
    this.player.reset();
    this.player.attachRun(this.run);
    const sp = this.surface.spawn;
    this.player.spawnAt(sp.x, sp.z, sp.yaw);
    this.player.position.y = this.surface.heightAt(sp.x, sp.z);
    this.viewRoot.visible = true;
    this.hud.setPlaying(true);
    this.hud.show('title', false);
    this.falling = 0;
    this.ctx = this._baseCtx({ world: this.surface.world, combat: true });
    this.hud.announce(this.lotLabel, 'The pit waits. Step over the edge to descend.');
    if (this.devFloor) {
      this.run.dev = true;
      this.pendingGoto = { name: 'floor', params: { floor: this.devFloor } };
      this.devFloor = 0;
    }
  }

  _updateSurface(dt) {
    const p = this.player;
    const ctx = this.ctx;
    ctx.time = this.time;
    if (this.falling > 0) {
      // Over the edge: no control, just the drop.
      this.falling += dt;
      p.position.y -= dt * (4 + this.falling * 14);
      p.pitch = Math.max(-1.2, p.pitch - dt * 1.2);
      p.update(dt, { ...ctx, combat: false, input: FROZEN_INPUT });
      this.surface.update(dt, this.fx);
      return;
    }
    p.update(dt, ctx);
    const ground = this.surface.heightAt(p.position.x, p.position.z);
    p.position.y += (ground - p.position.y) * Math.min(1, dt * 12);
    this.surface.update(dt, this.fx);
    if (this.surface.inPit(p.position) && !this.busy) {
      this.falling = 0.001;
      this.audio.portal();
      this.goto('floor', { floor: 1 });
    }
    this.hud.update(dt, p, this.run, {
      floorLabel: `${this.lotLabel} — The Surface`,
      enemyLabel: '',
      best: this.best,
      prompt: this.surface.nearPit(p.position) ? 'Step into the pit to begin your descent' : '',
    });
  }

  // ---------------------------------------------------------------- floor ---

  _enterFloor({ floor }) {
    const def = FLOORS[floor - 1];
    const run = this.run;
    run.floor = floor;
    run.deepest = Math.max(run.deepest, floor);
    if (!run.dev && floor > this.best) {
      this.best = floor;
      if (floor > 1) this.newRecord = true;
    }
    // The floor's look sets the fog and the ambient light (world/themes.js).
    const level = new Level(floor, def, { light: this.slow > 0 });
    const look = level.look;
    const s = this._newScene({ fog: look.fog, density: def.fog * (look.haze || 1), background: look.fog });
    this.level = level;
    s.add(level.group);
    s.add(new THREE.HemisphereLight(look.sky, look.earth, look.hemi));

    this.enemies = [];
    this.effects = new Effects(s, this.fx);
    this.pickups = new Pickups(s);
    this.director = new AIDirector(level.nav, def);
    this.pathService = new PathService(level.nav, 8);
    this.boss = null;
    this.bossAnnounced = false;
    this.deadT = 0;

    this.ctx = this._baseCtx({
      world: level.world,
      nav: level.nav,
      director: this.director,
      pathService: this.pathService,
      enemies: this.enemies,
      effects: this.effects,
      tuning: def,
      torchRange: def.light,
      onEnemyKilled: (e) => this._onEnemyKilled(e),
      spawnEnemy: (type, pos, emerge) => this._spawnEnemy(type, pos, emerge),
    });

    for (const e of level.data.enemies) this._spawnEnemy(e.type, e);
    if (level.data.boss) {
      const b = new Boss(level.data.boss.type, level.data.boss, def);
      this._addEnemy(b);
      s.add(b.light);
      this.boss = b;
    }
    for (const p of level.data.potions) this.pickups.addPotion(p.x, p.z);
    for (const w of level.data.weapons) this.pickups.addWeapon(w.x, w.z, rollWeapon(floor, 0.6));

    const sp = level.spawn;
    this.player.spawnAt(sp.x, sp.z, level.spawnYaw());
    this.player.position.y = 0;
    this.player.dash = null;
    const deep = floor > 10 && !def.boss;
    this.hud.announce(`Floor ${floor}`, def.boss ? def.name : `${def.name}${deep ? ' — the Deep' : ''}`);
    if (this.newRecord) {
      this.newRecord = false;
      setTimeout(() => this.hud.toast('New deepest descent!'), 1500);
    }
  }

  _addEnemy(e) {
    e.attachFx(this.fx);
    this.scene.add(e.root);
    this.enemies.push(e);
    return e;
  }

  _spawnEnemy(type, pos, emerge = false) {
    const e = this._addEnemy(new Enemy(type, pos, this.level.def));
    if (emerge) {
      e.emerge(this.ctx);
      e.becomeAlert?.(this.ctx, false);
    }
    return e;
  }

  _onEnemyKilled(e) {
    const run = this.run;
    run.kills++;
    const luck = this.level.def.loot;
    const loot = e.type.loot;
    const x = e.position.x;
    const z = e.position.z;
    const off = () => (Math.random() - 0.5) * 0.8;
    if (Math.random() < loot.potion * luck) this.pickups.addPotion(x + off(), z + off());
    if (Math.random() < loot.weapon * luck) this.pickups.addWeapon(x + off(), z + off(), rollWeapon(run.floor, e.isBoss ? 1 : 0));
    if (Math.random() < loot.spell * luck) this.pickups.addSpell(x + off(), z + off());
    if (e.isBoss) {
      this.hud.announce(`${e.name.split(',')[0]} is slain`, 'The seal breaks');
      this.pickups.addPotion(x + 1.2, z);
    }
  }

  _updateFloor(dt) {
    const ctx = this.ctx;
    ctx.time = this.time;
    const p = this.player;
    const level = this.level;
    p.update(dt, ctx);

    this.pathService.update();
    this.director.update(dt, this.enemies, p);
    for (const e of this.enemies) e.update(dt, ctx);

    // Bodies push the player out (except when passing through as a shade).
    if (!p.dash && !p.dead) {
      for (const e of this.enemies) {
        if (!e.alive || e.state === 'burrowed' || e.root.position.y > 1) continue;
        pushOutOfCircle(p.position, p.radius, e.position.x, e.position.z, e.radius);
      }
      level.world.resolve(p.position, p.radius);
    }

    for (const e of this.enemies) {
      const far = e.distToPlayer > 42 && !e.isBoss;
      e.root.visible = !far && e.state !== 'burrowed';
      if (!far) e.postUpdate(dt, ctx, this.time);
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.removed) continue;
      this.scene.remove(e.root);
      this.fx.add.removeEmittersOf(e.root);
      this.enemies.splice(i, 1);
    }

    level.update(dt, ctx);
    this.effects.update(dt, ctx);
    this.pickups.update(dt, ctx);
    this._updateFlash(dt);

    const alive = this.enemies.filter((e) => e.alive);
    if (!level.exitOpen && alive.length === 0) {
      level.openExit();
      this.audio.sealBreak();
      if (!this.boss) this.hud.announce('The seal breaks', 'Find the portal and descend');
    }
    if (this.boss && !this.bossAnnounced && this.boss.isEngaged()) {
      this.bossAnnounced = true;
      this.hud.announce(this.boss.name, this.boss.bossKey === 'azrakel' ? 'Lord of the last pit' : 'Warden of the tenth seal');
      this.audio.roar(this.boss.position);
    }

    if (level.isAtExit(p.position) && !this.busy && !p.dead) {
      const next = nextAfterFloor(this.run.floor, FLOOR_COUNT);
      this.audio.portal();
      this.goto(next.state, next);
    }

    if (p.dead) {
      this.deadT += dt;
      if (this.deadT > 1.8 && !this.busy) this.goto('dead');
    }

    let prompt = this.pickups.weaponPrompt(this.run);
    if (!prompt && level.exitOpen && !p.dead) prompt = 'The portal is open — descend';
    this.hud.update(dt, p, this.run, {
      floorLabel: `Floor ${this.run.floor} / ${FLOOR_COUNT} — ${level.def.name}`,
      enemyLabel: level.exitOpen ? 'Seal broken' : alive.length === 1 ? '1 demon remains' : `${alive.length} demons remain`,
      best: this.best,
      boss: this.boss && this.bossAnnounced && this.boss.alive ? this.boss : null,
      prompt,
      compass: this._compass(alive),
    });
  }

  // Arrow toward the open exit, or toward the last few demons.
  _compass(alive) {
    let target = null;
    if (this.level.exitOpen) target = this.level.data.exit;
    else if (alive.length && alive.length <= 3) {
      let best = Infinity;
      for (const e of alive) {
        const d = e.position.distanceToSquared(this.player.position);
        if (d < best) {
          best = d;
          target = e.position;
        }
      }
    }
    if (!target || this.player.dead) return null;
    const p = this.player.position;
    const ang = Math.atan2(target.x - p.x, target.z - p.z);
    // Player forward is yaw + PI in this convention.
    return { angle: -(ang - (this.player.yaw + Math.PI)), kind: this.level.exitOpen ? 'exit' : 'hunt' };
  }

  _exitFloor() {
    this.effects?.clear();
    this.pickups?.clear();
    this.level?.dispose();
    this.hud.clearNumbers();
    this.enemies = [];
  }

  _updateFlash(dt) {
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flashLight.intensity = Math.max(0, (this.flashT / this.flashDur) * this.flashLight.userData.base);
    } else this.flashLight.intensity = 0;
  }

  // -------------------------------------------------------------- sanctum ---

  _enterSanctum({ next }) {
    const s = this._newScene({ fog: 0x0a0404, density: 0.035, background: 0x050202 });
    this.sanctum = new Sanctum(next);
    s.add(this.sanctum.group);
    this.player.spawnAt(this.sanctum.spawn.x, this.sanctum.spawn.z, 0);
    this.player.position.y = 0;
    this.choice = null;
    this.ctx = this._baseCtx({ world: this.sanctum.world, torchRange: 14 });
    this.hud.announce('Sanctum', `Wake one altar before Floor ${next}`);
  }

  _updateSanctum(dt) {
    const p = this.player;
    const sc = this.sanctum;
    this.ctx.time = this.time;
    if (this.choice) {
      const n = this.choice.options.length;
      for (let i = 0; i < n; i++) if (this.input.wasPressed(`Digit${i + 1}`)) this._pickOption(i);
      if (this.input.wasPressed('KeyQ') || this.input.wasPressed('Backspace')) this._closeChoice();
      // Look around but stay put while deciding.
      const { dx, dy } = this.input.consumeMouse();
      p.yaw -= dx;
      p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch - dy));
    } else {
      p.update(dt, this.ctx);
    }
    const focused = sc.focusedNode(this.camera);
    sc.update(dt, this.ctx, focused);
    this._updateFlash(dt);
    if (!this.choice && focused && this.input.wasPressed('KeyE')) {
      const options = NODES[focused.key].options(this.run);
      if (!options.length) this.hud.toast('The circle is silent: your spells are complete.');
      else {
        this.choice = { node: focused, options };
        this.hud.showChoice(NODES[focused.key].title, options);
      }
    }
    if (sc.atPortal(p.position) && !this.busy) {
      this.audio.portal();
      this.goto('floor', { floor: sc.nextFloor });
    }
    let prompt = '';
    if (sc.portalOpen) prompt = 'The way down is open';
    else if (focused) prompt = `<b>E</b> ${NODES[focused.key].title}`;
    else prompt = 'Approach an altar and press <b>E</b>';
    this.hud.update(dt, p, this.run, { floorLabel: `Sanctum — before Floor ${sc.nextFloor}`, enemyLabel: '', best: this.best, prompt });
  }

  _pickOption(i) {
    if (!this.choice) return;
    const opt = this.choice.options[i];
    if (!opt) return;
    opt.apply(this.run);
    this.sanctum.choose(this.choice.node);
    this.audio.choose();
    this.hud.toast(opt.label);
    this._closeChoice();
    if (this.player.weaponDef) this.player.setWeapon(this.run.weapon);
  }

  _closeChoice() {
    this.choice = null;
    this.hud.hideChoice();
  }

  // ------------------------------------------------------- death / victory ---

  _enterEnd(won) {
    const run = this.run;
    const secs = Math.round((performance.now() - run.startTime) / 1000);
    const time = `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
    this.lastFloor = run.floor;
    // The deepest floor reached goes on the lot's weekly table.
    if (!run.dev) this.host.score(run.floor);
    this.hud.setPlaying(false);
    this.viewRoot.visible = false;
    const name = FLOORS[run.floor - 1]?.name || '';
    this.hud.setEnd({
      lines: won
        ? ['Azrakel has fallen.', 'You climb out of the pit with nothing but the memory of it.']
        : [`Slain on floor ${run.floor} — ${name}.`, 'Everything you carried is lost.'],
      stats: [
        ['Floor reached', run.floor],
        ['Deepest', Math.max(this.best, run.floor)],
        ['Demons slain', run.kills],
        ['Time', time],
      ],
      ready: false,
    });
    this.hud.show(won ? 'victory' : 'death', true);
    this.input.host.unlockPointer?.();
    this.run = null;
    this.endT = 0;
  }

  _updateEnd(dt) {
    this.endT += dt;
    if (this.endT > 1.2 && !this.hud.endInfo.ready) this.hud.setEnd({ ...this.hud.endInfo, ready: true });
    const go = this.input.mouseClicked[0] || this.input.taps.length || this.input.wasPressed('Space') || this.input.wasPressed('KeyR');
    if (this.endT > 1.2 && !this.busy && go) {
      this.input.requestLock();
      this.goto('surface');
    }
  }

  // ----------------------------------------------------------------- loop ---

  _frame(rawDt) {
    const dt = Math.min(0.05, rawDt);
    this._adaptQuality(rawDt);
    this.hud.touch = this.input.touch;
    // Taps on the on-screen buttons act as their keys.
    for (const t of this.input.taps) {
      const code = this.hud.buttonAt(t.x, t.y);
      if (!code) continue;
      if (code === 'Mouse0') this.input.mouseClicked[0] = true;
      else this.input.pressed.add(code);
      this.input.claimTap?.();
    }
    if (this.input.wasPressed('KeyM')) this.audio.setMuted(!this.audio.muted);
    if (this.input.pressed.size || this.input.mouseClicked[0]) this.audio.init();
    if (this.paused && (this.input.mouseClicked[0] || this.input.taps.length)) this.input.requestLock();

    if (!this.paused) {
      let wdt = dt;
      if (this.hitStopT > 0) {
        this.hitStopT -= dt;
        wdt = dt * 0.12;
      }
      this.time += wdt;
      this.fsm.update(wdt);
      this.fx.add.update(wdt);
      this.fx.alpha.update(wdt);
      this.audio.listener = this.player.position;
      if (this.run && PLAYING.has(this.fsm.currentName)) {
        const frac = this.run.health / this.run.maxHealth;
        this.audio.setLowHealth(frac < 0.3 && !this.player.dead ? (0.3 - frac) / 0.3 : 0, dt);
      }
      this.hud.updateNumbers(dt);
    }
    this.input.endFrame();
    this._render(dt);
  }

  // Step resolution down on slow machines (and in software rendering).
  _adaptQuality(rawDt) {
    if (rawDt > 0.065) this.slow++;
    else this.slow = Math.max(0, this.slow - 0.25);
    if ((this.slow > 4 || rawDt > 0.25) && this.pixelRatio > 0.5) {
      this.pixelRatio = Math.max(0.5, this.pixelRatio * 0.75);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.slow = 0;
      this._resize();
    }
  }

  // The render camera stays at the host's anchor (inside the lot's box on
  // Project 0) and the world is shifted around it, so the game fills the
  // screen wherever the player walks.
  _render(dt) {
    const r = this.renderer;
    const cam = this.camera;
    const rc = this.host.camera || cam;
    const anchor = this.host.anchor;
    if (rc !== cam) {
      if (anchor) {
        this.scene.position.copy(anchor).sub(cam.position);
        rc.position.copy(anchor);
      } else rc.position.copy(cam.position);
      rc.quaternion.copy(cam.quaternion);
      if (rc.fov !== cam.fov || rc.aspect !== cam.aspect || rc.near !== cam.near || rc.far !== cam.far) {
        rc.fov = cam.fov;
        rc.aspect = cam.aspect;
        rc.near = cam.near;
        rc.far = cam.far;
        rc.updateProjectionMatrix();
      }
      rc.updateMatrixWorld();
    }
    r.autoClear = true;
    if (this.compiling) {
      // Behind the black fade: draw only the HUD while shaders compile.
      r.clear();
      r.autoClear = false;
      this.hud.render(r, dt);
      r.autoClear = true;
      if (anchor && rc !== cam) {
        this.scene.position.set(0, 0, 0);
        this.scene.updateMatrixWorld(true);
      }
      return;
    }
    r.render(this.scene, rc);
    if (this.viewRoot.visible && this.run && !this.player.dead) {
      this.viewRoot.position.copy(rc.position);
      this.viewRoot.quaternion.copy(rc.quaternion);
      this.viewRoot.updateMatrixWorld(true);
      this.viewCamera.position.copy(rc.position);
      this.viewCamera.quaternion.copy(rc.quaternion);
      this.viewGlow.intensity = 6 * (0.85 + Math.sin(this.time * 13) * 0.1);
      r.autoClear = false;
      r.clearDepth();
      r.render(this.viewScene, this.viewCamera);
    }
    r.autoClear = false;
    this.hud.render(r, dt);
    r.autoClear = true;
    if (anchor && rc !== cam) {
      // Back to game coordinates for next frame's logic.
      this.scene.position.set(0, 0, 0);
      this.scene.updateMatrixWorld(true);
    }
  }
}
