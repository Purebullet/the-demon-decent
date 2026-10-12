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
import { Boss } from '../entities/Bosses.js';
import { Pickups } from '../entities/Pickups.js';
import { rollWeapon } from '../entities/Weapons.js';
import { AIDirector } from '../ai/AIDirector.js';
import { PathService } from '../ai/NavGrid.js';
import { newRun, NODES, HighScore, recordDepth } from './Progression.js';
import { TRANSITIONS, nextAfterFloor } from './transitions.js';
import { Hud } from '../ui/Hud.js';
import { pushOutOfCircle } from '../physics/CollisionWorld.js';

// Owns the renderer, the run, and the state machine that moves the player
// between the surface lot, the 20 floors and the sanctums in between.

const PLAYING = new Set(['surface', 'floor', 'sanctum']);
const FROZEN_INPUT = { consumeMouse: () => ({ dx: 0, dy: 0 }), moveAxes: () => ({ forward: 0, strafe: 0 }), wasPressed: () => false, mouseClicked: [], mouseDown: [] };
const SURFACE_TUNING = { hp: 1, dmg: 1, speed: 1, windup: 1, cooldown: 1, attackers: 2, swarm: false, aggro: 10, loot: 1 };

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.2;
    this.renderer = r;

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

    this.input = new Input(canvas);
    this.audio = new Audio();
    this.hud = new Hud();
    this.fx = { add: new ParticleSystem({ max: 8000, additive: true }), alpha: new ParticleSystem({ max: 3000, additive: false }) };
    this.player = new Player(this.camera, this.viewRoot);
    this.scores = HighScore.load();
    this.run = null;
    this.params = new URLSearchParams(location.search);
    this.devFloor = Math.min(FLOOR_COUNT, Math.max(0, parseInt(this.params.get('floor') || '0', 10) || 0));
    this.time = 0;
    this.hitStopT = 0;
    this.paused = false;
    this.busy = false;
    this.flashT = 0;
    this.flashLight = new THREE.PointLight(0xff5a1e, 0, 16, 1.5);

    this.fsm = new StateMachine(this, TRANSITIONS);
    this.fsm
      .add('title', { enter: (g) => g._enterTitle(), update: (g, dt) => g._updateTitle(dt), exit: (g) => g.hud.show('title', false) })
      .add('surface', { enter: (g) => g._enterSurface(), update: (g, dt) => g._updateSurface(dt) })
      .add('floor', { enter: (g, p) => g._enterFloor(p), update: (g, dt) => g._updateFloor(dt), exit: (g) => g._exitFloor() })
      .add('sanctum', { enter: (g, p) => g._enterSanctum(p), update: (g, dt) => g._updateSanctum(dt), exit: (g) => g.hud.hideChoice() })
      .add('dead', { enter: (g) => g._enterEnd(false), update: (g, dt) => g._updateEnd(dt), exit: (g) => g.hud.show('death', false) })
      .add('victory', { enter: (g) => g._enterEnd(true), update: (g, dt) => g._updateEnd(dt), exit: (g) => g.hud.show('victory', false) });

    this.input.onLockChange = (locked) => {
      if (!locked && PLAYING.has(this.fsm.currentName) && !this.busy) {
        this.paused = true;
        this.hud.show('pause', true);
      } else if (locked) {
        this.paused = false;
        this.hud.show('pause', false);
      }
    };
    const resume = () => {
      this.audio.init();
      this.input.requestLock();
    };
    document.getElementById('pause').addEventListener('click', resume);
    document.getElementById('title').addEventListener('click', () => {
      if (!this.fsm.is('title') || this.busy) return;
      resume();
      this.goto('surface');
    });
    for (const id of ['death', 'victory']) {
      document.getElementById(id).addEventListener('click', () => {
        if (this.endT > 1.2 && !this.busy) {
          resume();
          this.goto('surface');
        }
      });
    }
    document.getElementById('choiceOptions').addEventListener('click', (e) => {
      const opt = e.target.closest('.opt');
      if (opt) this._pickOption([...opt.parentNode.children].indexOf(opt));
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') this.audio.setMuted(!this.audio.muted);
    });

    window.addEventListener('resize', () => this._resize());
    this._resize();
    this.fsm.change('title');
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    for (const c of [this.camera, this.viewCamera]) {
      c.aspect = w / h;
      c.updateProjectionMatrix();
    }
    const ph = h * this.renderer.getPixelRatio();
    this.fx.add.setViewport(ph, this.camera.fov);
    this.fx.alpha.setViewport(ph, this.camera.fov);
  }

  // Fade out, switch state, fade in. Guards against double triggers.
  async goto(name, params) {
    if (this.busy) return;
    this.busy = true;
    await this.hud.fade(true, 500);
    this.fsm.change(name, params);
    await this.hud.fade(false, 600);
    this.busy = false;
    // A state may queue a follow-up jump from its enter() (dev floor start).
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

  _ensureSurface() {
    if (this.surface) return;
    this.surface = new Surface();
  }

  _surfaceScene() {
    this._ensureSurface();
    const s = this._newScene({ fog: 0x0d0606, density: 0.022, background: 0x050203 });
    s.add(this.surface.group);
    this.surface.setScores(this.scores);
  }

  _enterTitle() {
    this._surfaceScene();
    this.hud.setPlaying(false);
    this.hud.show('title', true);
    const b = this.scores;
    document.getElementById('titleBest').innerHTML = b.best
      ? `Deepest descent: <b>Floor ${b.best}</b>${b.conquered ? ` &middot; Hell conquered &times;${b.conquered}` : ''}`
      : 'No soul has yet returned from the pit.';
    if (this.devFloor) document.getElementById('titleBest').innerHTML += `<br><span class="dev">Dev start: floor ${this.devFloor} (scores not recorded)</span>`;
    this.orbit = 0;
  }

  _updateTitle(dt) {
    this.orbit += dt * 0.06;
    const a = this.orbit;
    this.camera.position.set(Math.sin(a) * 24, 7.5, Math.cos(a) * 24);
    this.camera.lookAt(0, -1.5, 0);
    this.camera.updateMatrixWorld();
    this.viewRoot.visible = false;
    this.surface.update(dt, this.fx);
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
    this.hud.announce('Lot #1738', 'The pit waits. Step over the edge to descend.');
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
      floorLabel: 'Lot #1738 — The Surface',
      enemyLabel: '',
      best: this.scores.best,
      prompt: this.surface.nearPit(p.position) ? 'Step into the pit to begin your descent' : '',
    });
  }

  // ---------------------------------------------------------------- floor ---

  _enterFloor({ floor }) {
    const def = FLOORS[floor - 1];
    const run = this.run;
    run.floor = floor;
    run.deepest = Math.max(run.deepest, floor);
    if (!run.dev) {
      this.scores.last = floor;
      if (recordDepth(this.scores, floor)) this.newRecord = true;
      HighScore.save(this.scores);
    }
    const depth = (floor - 1) / 19;
    const fogColor = new THREE.Color(0x0a0505).lerp(new THREE.Color(0x1f0402), depth);
    const s = this._newScene({ fog: fogColor, density: def.fog, background: fogColor.getHex() });
    const level = new Level(floor, def);
    this.level = level;
    s.add(level.group);
    s.add(new THREE.HemisphereLight(new THREE.Color(0x4a3030).lerp(new THREE.Color(0x6a2010), depth), 0x0a0202, 0.75));

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
    this.hud.announce(`Floor ${floor}`, def.boss ? `${def.name}` : `${def.name}${deep ? ' — the Deep' : ''}`);
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
      best: this.scores.best,
      boss: this.boss && this.bossAnnounced && this.boss.alive ? this.boss : null,
      prompt,
    });
    this._updateCompass(alive);
  }

  // Arrow pointing at the open exit, or at the last few demons.
  _updateCompass(alive) {
    const el = document.getElementById('compass');
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
    if (!target || this.player.dead) {
      el.style.display = 'none';
      return;
    }
    const p = this.player.position;
    const ang = Math.atan2(target.x - p.x, target.z - p.z);
    // Player forward is yaw + PI in this convention.
    const rel = ang - (this.player.yaw + Math.PI);
    el.style.display = '';
    el.style.transform = `translateX(-50%) rotate(${-rel}rad)`;
    el.dataset.kind = this.level.exitOpen ? 'exit' : 'hunt';
  }

  _exitFloor() {
    document.getElementById('compass').style.display = 'none';
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
      if (this.input.wasPressed('Escape') || this.input.wasPressed('KeyQ')) this._closeChoice();
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
    this.hud.update(dt, p, this.run, { floorLabel: `Sanctum — before Floor ${sc.nextFloor}`, enemyLabel: '', best: this.scores.best, prompt });
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
    if (!run.dev) {
      this.scores.runs++;
      this.scores.last = run.floor;
      if (won) this.scores.conquered++;
      recordDepth(this.scores, run.floor);
      HighScore.save(this.scores);
    }
    this.hud.setPlaying(false);
    this.viewRoot.visible = false;
    const stats = `<div class="stats"><div><span>Floor reached</span><b>${run.floor}</b></div><div><span>Deepest ever</span><b>${this.scores.best || run.floor}</b></div><div><span>Demons slain</span><b>${run.kills}</b></div><div><span>Time</span><b>${time}</b></div></div>`;
    if (won) {
      document.getElementById('victoryText').innerHTML = `Azrakel has fallen. You climb out of the pit with nothing but the memory of it.${stats}`;
      this.hud.show('victory', true);
    } else {
      const name = FLOORS[run.floor - 1]?.name || '';
      document.getElementById('deathText').innerHTML = `Slain on floor ${run.floor} &mdash; ${name}.<br>Everything you carried is lost.${stats}`;
      this.hud.show('death', true);
    }
    this.run = null;
    this.endT = 0;
  }

  _updateEnd(dt) {
    this.endT += dt;
    if (this.endT > 1.2 && !this.busy && (this.input.mouseClicked[0] || this.input.wasPressed('Space') || this.input.wasPressed('Enter'))) {
      this.goto('surface');
    }
  }

  // ----------------------------------------------------------------- loop ---

  _frame = (now) => {
    requestAnimationFrame(this._frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
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
      this.hud.updateNumbers(dt, this.camera);
    }
    this.input.endFrame();
    this._render();
  };

  _render() {
    const r = this.renderer;
    r.autoClear = true;
    r.render(this.scene, this.camera);
    if (this.viewRoot.visible && this.run && !this.player.dead) {
      this.viewCamera.position.copy(this.camera.position);
      this.viewCamera.quaternion.copy(this.camera.quaternion);
      this.viewGlow.intensity = 6 * (0.85 + Math.sin(this.time * 13) * 0.1);
      r.autoClear = false;
      r.clearDepth();
      r.render(this.viewScene, this.viewCamera);
    }
  }
}
