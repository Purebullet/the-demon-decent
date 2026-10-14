import * as THREE from 'three';
import { matte } from '../world/matte.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { C, burst } from '../world/Particles.js';
import { Input } from '../core/Input.js';
import { Audio } from '../core/Audio.js';
import { StateMachine } from '../core/StateMachine.js';
import { ParticleSystem } from '../world/Particles.js';
import { Surface, SHAFT_BOTTOM } from '../world/Surface.js';
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
import { RELICS, rollRelic, relicPassive } from '../combat/Relics.js';
import { angleDelta } from '../core/rng.js';

const ARMOR_HINT = 'A <b>gold</b> glow is an armoured blow: light hits won\u2019t stop it. <b>Block, dodge</b> or hit it heavy';

// Owns the run and the state machine that moves the player between the
// surface lot, the 20 floors and the sanctums in between. Everything outside
// the game (renderer, input, sound, scores) comes from the host: Project 0's
// sandbox or a plain web page (src/platform).

const PLAYING = new Set(['surface', 'floor', 'sanctum']);
const FROZEN_INPUT = { consumeMouse: () => ({ dx: 0, dy: 0 }), moveAxes: () => ({ forward: 0, strafe: 0 }), wasPressed: () => false, isDown: () => false, mouseClicked: [], mouseDown: [] };
const SURFACE_TUNING = { hp: 1, dmg: 1, speed: 1, windup: 1, cooldown: 1, attackers: 2, swarm: false, aggro: 10, loot: 1 };

export class Game {
  constructor(host, { lotLabel = 'The Demon Descent', devFloor = 0 } = {}) {
    this.host = host;
    this.lotLabel = lotLabel;
    const r = host.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.2;
    this.renderer = r;
    // The canvas runs at the screen's own resolution, so the interface is
    // sharp. The 3D view renders into a target at `sceneScale` of that (about
    // 1280 px wide, less on slow machines) and is upscaled underneath it.
    // Every clear is opaque black: Project 0's canvas is transparent, and a
    // see-through frame would show the city behind the game.
    r.setClearColor(0x000000, 1);
    this.uiRatio = Math.min(host.pixelRatio || 1, 2);
    r.setPixelRatio(this.uiRatio);
    this.sceneScale = Math.min(1, 1280 / Math.max(1, host.width * this.uiRatio));
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blitScene = new THREE.Scene();
    const blit = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: this.sceneTarget.texture, depthTest: false, depthWrite: false }));
    blit.frustumCulled = false;
    this.blitScene.add(blit);
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
      .add('sanctum', { enter: (g, p) => g._enterSanctum(p), update: (g, dt) => g._updateSanctum(dt), exit: (g) => { g.hud.hideChoice(); g.uiMouse = false; } })
      .add('dead', { enter: (g) => g._enterEnd(false), update: (g, dt) => g._updateEnd(dt), exit: (g) => g.hud.show('death', false) })
      .add('victory', { enter: (g) => g._enterEnd(true), update: (g, dt) => g._updateEnd(dt), exit: (g) => g.hud.show('victory', false) });

    this.input.onLockChange = (locked) => {
      // (While choosing at an altar the mouse is let go on purpose.)
      if (!locked && PLAYING.has(this.fsm.currentName) && !this.busy && !this.input.touch && !this.uiMouse) {
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
    // Project 0's "How to play" box takes plain text: the keys are set in
    // Unicode bold so they stand out.
    host.hud(
      `${bold('WASD')} move · ${bold('Mouse')} aim · ${bold('Quick left click')} light attack · ${bold('Hold left click')} heavy attack · ` +
        `${bold('Multiple hits')} chain attack · ${bold('Hit a wind-up')} stagger · ${bold('Right click')} block · ${bold('Shift')} sprint · ${bold('E')} potion · ${bold('F')} take/use\n` +
        `Once learned: ${bold('AA / DD')} dodge · ${bold('1 2 3')} demon spells\n` +
        'One life: die and you start again. Click or press any key for sound.',
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
    const k = this.uiRatio * this.sceneScale;
    this.sceneTarget.setSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
    const ph = h * k;
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
          matte(m);
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
      // The world draws into the scene target (a different shader variant
      // from drawing to the screen); the interface draws to the screen.
      const screen = scene === this.hud.scene;
      r.setRenderTarget(screen ? null : this.sceneTarget);
      this._drawAlone(r, o, scene, cam);
      r.setRenderTarget(null);
      if (screen) this._cover(r);
      await nextFrame();
    }
    this._drawAlone(r, this.blitScene.children[0], this.blitScene, this.blitCamera);
    this._cover(r);
    for (const o of staged) o.removeFromParent();
    this.compiling = false;
    this.host.log(`[t] warm-up: ${jobs.length} programs in ${Math.round(performance.now() - t0)} ms`);
  }

  // Project 0's canvas is see-through: a frame that only drew a warm-up
  // corner into it would show the city behind the game. Cover it in black
  // (and the interface, the fade on top) again at once.
  _cover(r) {
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.autoClear = false;
    this.hud.render(r, 0);
    r.autoClear = true;
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
    this.fogBase = density;
    // One point light rides with the player (the torch); flashes borrow it
    // rather than keeping a second light lit at zero, which every lit pixel
    // would still pay for.
    s.add(this.fx.add.points, this.fx.alpha.points, this.player.torchLight);
    this.fx.add.clear();
    this.fx.alpha.clear();
    this.fx.add.setFogDensity(density);
    this.fx.alpha.setFogDensity(density);
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
      flash: (color, intensity, dur) => this.player.flash(color, intensity * 6, dur),
      onDamage: (e, amount, crit, point, kind) => this.hud.damageNumber(point || e.position, amount, crit, kind),
      onPlayerHurt: (amount, angle = 0, opts = {}) => this.hud.playerHurt(amount, angle, { ...opts, max: this.run?.maxHealth || 100 }),
      onDodge: () => this.hud.callout('EVADED', { color: '#c9a0ff', size: 0.8 }),
      later: (delay, fn) => (this.effects ? this.effects.later(delay, fn) : setTimeout(fn, delay * 1000)),
      tells: 1,
      onRhythm: (kind, chain) => this._onRhythm(kind, chain),
      onSpellDenied: (id) => this.hud.denySlot(id),
      onCombat: (kind, point) => this._onCombat(kind, point),
      onProc: (id, P) => this._onProc(id, P),
      onRelic: (id, n) => {
        const R = RELICS[id];
        this.audio.relic();
        this.hud.announce(n > 1 ? `${R.name} ×${n}` : R.name, R.text);
        this.hud.flashRelic(id);
      },
      onSkill: () => {
        this.audio.relic();
        this.hud.announce('Phantom Step', 'Double-tap A or D to sidestep, S to leap back');
      },
      toast: (t) => this.hud.toast(t),
      announce: (t, sub) => this.hud.announce(t, sub),
      ...extra,
    };
  }

  // ---------------------------------------------------------------- title ---

  _surfaceScene() {
    if (!this.surface) this.surface = new Surface();
    this.surface.falling(false);
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
    this.audio.music('intro');
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
    this.bestAtStart = this.best;
    this.player.reset();
    this.player.attachRun(this.run);
    const sp = this.surface.spawn;
    this.player.spawnAt(sp.x, sp.z, sp.yaw);
    this.player.position.y = this.surface.heightAt(sp.x, sp.z);
    this.viewRoot.visible = true;
    this.hud.setPlaying(true);
    this.hud.show('title', false);
    this.falling = 0;
    this.audio.music('intro');
    this.ctx = this._baseCtx({ world: this.surface.world, combat: true, ground: 'gravel' });
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
      // Over the edge: five seconds of free fall down the cavern shaft, drawn
      // to its middle, spinning slowly, then the fade into floor 1.
      this.falling += dt;
      const fall = this.falling;
      p.position.y = Math.max(-SHAFT_BOTTOM + 6, p.position.y - dt * (5 + fall * 13));
      p.position.x += (0 - p.position.x) * Math.min(1, dt * 1.2);
      p.position.z += (0 - p.position.z) * Math.min(1, dt * 1.2);
      p.pitch = Math.max(-1.05, p.pitch - dt * 0.9);
      p.yaw += dt * 0.35;
      p.shake?.(0.04);
      p.update(dt, { ...ctx, combat: false, input: FROZEN_INPUT });
      this.surface.update(dt, this.fx);
      this.hud.update(dt, p, this.run, { floorLabel: '', enemyLabel: '', best: this.best, prompt: '' });
      if (fall > 4.5 && !this.busy) this.goto('floor', { floor: 1, arrival: true });
      return;
    }
    p.update(dt, ctx);
    const ground = this.surface.heightAt(p.position.x, p.position.z);
    p.position.y += (ground - p.position.y) * Math.min(1, dt * 12);
    this.surface.update(dt, this.fx);
    if (this.surface.inPit(p.position) && !this.busy) {
      this.falling = 0.001;
      this.surface.falling(true);
      this.hud.announcement = null;
      this.hud.update(dt, p, this.run, { floorLabel: '', enemyLabel: '', best: this.best, prompt: '' });
      this.audio.portal();
      this.audio.fadeMusic(2.5);
    }
    this.hud.update(dt, p, this.run, {
      floorLabel: `${this.lotLabel} — The Surface`,
      enemyLabel: '',
      best: this.best,
      prompt: this.surface.nearPit(p.position) ? 'Step into the pit to begin your descent' : '',
    });
  }

  // ---------------------------------------------------------------- floor ---

  _enterFloor({ floor, arrival = false }) {
    this.audio.music('drone');
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
    this.eliteCount = 0;
    this.effects = new Effects(s, this.fx);
    this.pickups = new Pickups(s);
    this.director = new AIDirector(level.nav, def);
    this.pathService = new PathService(level.nav, 8);
    this.boss = null;
    this.bossAnnounced = false;
    this.deadT = 0;

    this.ctx = this._baseCtx({
      world: level.world,
      ground: 'gravel',
      nav: level.nav,
      director: this.director,
      pathService: this.pathService,
      enemies: this.enemies,
      effects: this.effects,
      tuning: def,
      torchRange: def.light,
      onEnemyKilled: (e) => this._onEnemyKilled(e),
      pickups: this.pickups,
      props: level.props,
      spawnEnemy: (type, pos, emerge) => this._spawnEnemy(type, pos, emerge),
    });

    this.guide = makeGuideArrow();
    s.add(this.guide);
    this.guideT = 0;
    this.guideDir = null;

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
    this.floorTitle = [`Floor ${floor}`, def.boss ? def.name : `${def.name}${deep ? ' — the Deep' : ''}`];
    this.intro = null;
    this.renderer.toneMappingExposure = 1.2;
    if (arrival) this._beginArrival(level);
    else this.hud.announce(...this.floorTitle);
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
    const e = new Enemy(type, pos, this.level.def);
    // From floor 3 a few demons come as elites (never the summoned).
    if (!emerge && this.run.floor >= 3 && this.eliteCount < 2 && Math.random() < 0.1 + this.run.floor * 0.006) {
      e.makeElite();
      this.eliteCount++;
    }
    this._addEnemy(e);
    if (emerge) {
      e.emerge(this.ctx);
      e.becomeAlert?.(this.ctx, false);
    }
    return e;
  }

  // ---- Combat feedback: rhythm, counters, guards and procs on the HUD ----

  // Each mechanic is explained once a session, the first time it comes up.
  _hint(key, markup) {
    this.hints ||= new Set();
    if (this.hints.has(key)) return;
    this.hints.add(key);
    this.hud.hint(markup);
  }

  _onRhythm(kind, chain = 0) {
    const r = this.run;
    if (kind === 'swing') this._hint('rhythm', 'Click again <b>the instant your blade finishes its arc</b> for a Perfect Chain');
    else if (kind === 'perfect' && chain >= 2) this._hint('chain', 'Keep the rhythm: each link of the chain strikes <b>faster, harder</b> and wakes your relics');
    else if (kind === 'fumble') this._hint('fumble', 'Too early: mashing fumbles the next swing and leaves you <b>exposed</b>');
    else if (kind === 'heavy') this._hint('heavy', 'A heavy blow cannot be stopped once it falls: <b>commit</b> to it');
    if (kind === 'perfect') {
      if (r) r.best.chain = Math.max(r.best.chain, chain);
      this.hud.rhythm('perfect', chain);
      if (chain >= 2) this.hud.callout(chain >= 5 ? `PERFECT ×${chain} — FLOW` : `PERFECT ×${chain}`, { color: chain >= 4 ? '#fff4d0' : '#ffd070', size: 0.8 + chain * 0.06 });
      else this.hud.callout('PERFECT', { color: '#ffd070', size: 0.75 });
    } else if (kind === 'fumble') {
      this.audio.fumble();
      this.hud.rhythm('fumble');
    } else if (kind === 'sluggish') {
      this.hud.callout('SLUGGISH — EXPOSED', { color: '#8a6a60', size: 0.62 });
    } else if (kind === 'dodge') this.hud.rhythm('dodge');
  }

  _onCombat(kind) {
    const r = this.run;
    if (kind === 'clash') this._hint('guard', 'Guarded: wait for the ward to drop, or break it with an <b>axe</b> or a charged <b>mace</b>');
    else if (kind === 'counter') this._hint('counter', 'Counter-hit: strike a demon <b>while it glows red</b> winding up');
    if (kind === 'counter') {
      if (r) r.best.counters++;
      this.hud.callout('COUNTER', { color: '#ffb060', size: 1.15 });
      this.player.flash(0xffa040, 30, 0.18);
    } else if (kind === 'clash') this.hud.callout('GUARDED', { color: '#c05040', size: 0.85 });
    else if (kind === 'guardBreak') this.hud.callout('GUARD SHATTERED', { color: '#ff8a3a', size: 1.0 });
    else if (kind === 'crash') this.hud.callout('CRUSHED THROUGH', { color: '#ffa060', size: 0.95 });
    else if (kind === 'parry') {
      if (r) r.best.parries = (r.best.parries || 0) + 1;
      this.hud.callout('PARRY', { color: '#ffe6a0', size: 1.2 });
      this._hint('riposte', 'Parried: your <b>next blow is a counter</b>');
    } else if (kind === 'armored') {
      // Said at most once a second.
      if (this.time - (this.armoredT ?? -9) > 1) this.hud.callout('ARMORED', { color: '#ffb040', size: 0.8 });
      this.armoredT = this.time;
      this._hint('armor', ARMOR_HINT);
    } else if (kind === 'stunned') this.hud.callout('STUNNED', { color: '#ffd080', size: 1.0 });
    else if (kind === 'enrage') this.hud.callout('ENRAGED', { color: '#ff4020', size: 1.0 });
    else if (kind === 'blocked') this._hint('parry', 'Raise your block <b>just as a blow lands</b> to parry it (fireballs too)');
    else if (kind === 'coated') {
      this.hud.callout('SLIME-COATED', { color: '#8ef05a', size: 0.9 });
      this._hint('slime', 'Slime coats your blade: <b>raise your block</b> to set it alight');
    } else if (kind === 'ignite') this.hud.callout('FLAMING BLADE', { color: '#ffa040', size: 1.1 });
    else if (kind === 'refuel') this.hud.callout('THE FIRE FEEDS', { color: '#ffa040', size: 0.85 });
    else if (kind === 'extinguish') this.hud.toast('The flame on your blade dies');
    else if (kind === 'guardSpent') {
      this.hud.callout('GUARD BROKEN', { color: '#d05040', size: 0.8 });
      this._hint('guard3', 'A block holds for <b>3 seconds</b>: watch the bar under your aim');
    }
  }

  _onProc(id, P) {
    if (this.run) this.run.best.procs++;
    this._hint('proc', 'Relics wake on <b>perfect chains, counters and head hits</b>: fight in rhythm to set them off');
    this.hud.callout(P.name.toUpperCase(), { color: P.color, size: 1.05, proc: true });
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
    // Elites carry relics, and so do bosses.
    if ((e.elite && Math.random() < 0.7) || e.isBoss) this.pickups.addRelic(x + off(), z + off(), rollRelic(run));
    if (e.isBoss) {
      this.hud.announce(`${e.name.split(',')[0]} is slain`, 'The seal breaks');
      this.pickups.addPotion(x + 1.2, z);
    }
  }

  _updateFloor(dt) {
    const ctx = this.ctx;
    ctx.time = this.time;
    ctx.tells = relicPassive(this.run, 'tells') ?? 1;
    const p = this.player;
    const level = this.level;
    const intro = this._updateArrival(dt);
    p.update(dt, intro ? { ...ctx, combat: false, input: this.intro.look ? ctx.input : FROZEN_INPUT } : ctx);

    this.pathService.update();
    if (!intro) {
      this.director.update(dt, this.enemies, p);
      for (const e of this.enemies) {
        e.update(dt, ctx);
        if (e.state === 'windup' && e.distToPlayer < 4.5) {
          if (e.attack?.armor) this._hint('armor', ARMOR_HINT);
          else if (!this.hints?.has('tell')) this._hint('tell', 'It glows red as it winds up: <b>strike now to counter</b>, block, or step away');
        }
      }
    }

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
      e.root.visible = !far && e.state !== 'burrowed' && !e.hidden;
      if (!far) e.postUpdate(dt, ctx, this.time);
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.removed) continue;
      this.scene.remove(e.root);
      this.fx.add.removeEmittersOf(e.root);
      this.enemies.splice(i, 1);
    }

    // A burning blade lights the way: the murk draws back a little.
    const fog = this.scene.fog;
    if (fog) fog.density += (this.fogBase * (p.flameT > 0 ? 0.78 : 1) - fog.density) * Math.min(1, dt * 1.5);

    level.update(dt, ctx);
    this.effects.update(dt, ctx);
    this.pickups.update(dt, ctx);

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

    this._updateGuide(dt);
    if (intro) return;

    let prompt = this.pickups.weaponPrompt(this.run) || level.props.prompt();
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

  // Arriving at the bottom of the pit (floor 1 after the fall): you come to
  // in pitch darkness and push yourself up, then strike your torch alight,
  // each spark of the flint lighting the dark for an instant. Your sword
  // lies on the ground in front of you, flung there by the fall.
  _beginArrival(level) {
    const p = this.player;
    p.wake = 0;
    p.torchLit = 0;
    p.torchRaise = 0;
    p.armed = false;
    p.pitch = -0.42;
    this.renderer.toneMappingExposure = 0;
    const sp = level.spawn;
    const yaw = p.yaw;
    let d = 2.3;
    while (d > 0.8 && level.world.isSolidAt(sp.x - Math.sin(yaw) * d, sp.z - Math.cos(yaw) * d)) d -= 0.3;
    this.pickups.addStarter(sp.x - Math.sin(yaw) * d, sp.z - Math.cos(yaw) * d, this.run.weapon, yaw);
    // (A light kept at zero, where the light down the shaft used to be:
    // taking it out would change the light count and recompile shaders.)
    this.introLight = new THREE.PointLight(0xff3014, 0, 22, 1.3);
    this.introLight.position.set(sp.x, 7, sp.z);
    this.scene.add(this.introLight);
    this.intro = { t: 0, strikes: 0, lit: false, look: false };
  }

  // Returns true while the arrival is still playing.
  _updateArrival(dt) {
    const a = this.intro;
    if (!a) return false;
    const p = this.player;
    const r = this.renderer;
    // (It waits while the floor's shaders compile behind the black.)
    if (!this.compiling) a.t += dt;
    const t = a.t;
    const smooth = (k) => k * k * (3 - 2 * k);
    // Pitch black from the first frame: getting up off the floor unseen.
    p.wake = Math.min(1, smooth(Math.min(1, t / 1.6)));
    a.look = t > 1.6;
    r.toneMappingExposure = 0;
    this.introLight.intensity = 0;
    // The torch comes up, three strikes of the flint (each spark lights the
    // dark for an instant), and it catches.
    p.torchRaise = smooth(Math.min(1, Math.max(0, (t - 1.6) / 0.6)));
    const strikes = [2.3, 2.75, 3.2];
    while (a.strikes < strikes.length && t >= strikes[a.strikes]) {
      a.strikes++;
      this.audio.strike?.();
      const tip = p.camera.localToWorld(new THREE.Vector3(-0.42, -0.15, -0.7));
      burst(this.fx.add, tip, { count: 14, speed: 2.4, size: 0.05, life: 0.35, color: C.spark, colorEnd: C.fireEdge, gravity: -6 });
      p.shake(0.03);
    }
    const lightAt = 3.25;
    if (t >= lightAt && !a.lit) {
      a.lit = true;
      this.audio.ignite?.();
    }
    if (a.lit) {
      const k = Math.min(1, (t - lightAt) / 0.9);
      p.torchLit = smooth(k);
      r.toneMappingExposure = 1.2 * smooth(k);
    } else {
      const since = Math.min(...strikes.map((st) => (t >= st ? t - st : 9)));
      const spark = since < 0.14 ? 1 - since / 0.14 : 0;
      p.torchLit = 0.25 * spark;
      r.toneMappingExposure = 0.9 * spark;
    }
    this.hud.update(dt, p, this.run, { floorLabel: '', enemyLabel: '', best: this.best, prompt: '' });
    if (t >= lightAt + 1.2) {
      this.intro = null;
      r.toneMappingExposure = 1.2;
      this.hud.announce(...this.floorTitle);
      return false;
    }
    return true;
  }

  // Once the floor is cleared, a glowing arrow floats on the floor ahead of
  // you and points the way to the portal along the walkable path (A*, so it
  // turns corners instead of pointing into rock).
  _updateGuide(dt) {
    const g = this.guide;
    const p = this.player;
    const show = this.level.exitOpen && !p.dead;
    g.visible = show;
    if (!show) {
      this.guideAngle = null;
      return;
    }
    const x = this.level.data.exit;
    this.guideT -= dt;
    if (this.guideT <= 0 || !this.guidePath) {
      this.guideT = 0.25;
      this.guidePath = this.level.nav.findPathWorld(p.position.x, p.position.z, x.x, x.z) || [x];
    }
    // Aim at a point a fixed distance along the path from where you stand:
    // it slides smoothly round corners rather than hopping between nodes.
    const target = pointAlongPath(this.guidePath, p.position, 2.6) || x;
    const dist = Math.hypot(x.x - p.position.x, x.z - p.position.z);
    this.guideDir = { x: target.x - p.position.x, z: target.z - p.position.z, dist, target };
    const want = Math.atan2(this.guideDir.x, this.guideDir.z);
    // A damped turn toward the aim, and the arrow lies along it.
    if (this.guideAngle == null) this.guideAngle = want;
    this.guideAngle += angleDelta(this.guideAngle, want) * (1 - Math.exp(-7 * dt));
    const aheadWant = Math.max(0.6, Math.min(2.2, dist - 1));
    this.guideAhead = (this.guideAhead ?? aheadWant) + (aheadWant - (this.guideAhead ?? aheadWant)) * (1 - Math.exp(-5 * dt));
    const fade = Math.min(1, Math.max(0, (dist - 2.2) / 1.2));
    g.visible = fade > 0.01;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 3.2);
    const a = this.guideAngle;
    g.position.set(p.position.x + Math.sin(a) * this.guideAhead, 0.16 + pulse * 0.025, p.position.z + Math.cos(a) * this.guideAhead);
    g.rotation.y = a;
    g.material.opacity = (0.5 + pulse * 0.3) * fade;
  }

  // Arrow toward the open exit (along the path), or toward the last few demons.
  _compass(alive) {
    let target = null;
    if (this.level.exitOpen) target = this.guideDir?.target || this.level.data.exit;
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

  // -------------------------------------------------------------- sanctum ---

  _enterSanctum({ next }) {
    this.audio.music('drone');
    const s = this._newScene({ fog: 0x0a0404, density: 0.035, background: 0x050202 });
    this.sanctum = new Sanctum(next);
    s.add(this.sanctum.group);
    this.player.spawnAt(this.sanctum.spawn.x, this.sanctum.spawn.z, 0);
    this.player.position.y = 0;
    this.choice = null;
    this.ctx = this._baseCtx({ world: this.sanctum.world, torchRange: 14, ground: 'gravel' });
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
    if (!this.choice && focused && this.input.wasPressed('KeyF')) {
      const options = NODES[focused.key].options(this.run);
      if (!options.length) this.hud.toast('The circle is silent: your spells are complete.');
      else {
        this.choice = { node: focused, options };
        this.hud.showChoice(NODES[focused.key].title, options);
        // Let the mouse go so the options can be clicked.
        this.uiMouse = true;
        this.input.host.unlockPointer?.();
      }
    }
    if (sc.atPortal(p.position) && !this.busy) {
      this.audio.portal();
      this.goto('floor', { floor: sc.nextFloor });
    }
    let prompt = '';
    if (sc.portalOpen) prompt = 'The way down is open';
    else if (focused) prompt = `<b>F</b> ${NODES[focused.key].title}`;
    else prompt = 'Approach an altar and press <b>F</b>';
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
    if (this.uiMouse) {
      this.uiMouse = false;
      this.input.requestLock();
    }
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
      won,
      lines: won
        ? ['Azrakel has fallen.', 'You climb out of the pit with nothing but the memory of it.']
        : [`Slain on floor ${run.floor} — ${name}`, 'Everything you carried is lost.'],
      floor: run.floor,
      floors: FLOORS.length,
      deepest: Math.max(this.best, run.floor),
      record: !run.dev && run.floor > (this.bestAtStart ?? 0),
      stats: [
        ['skull', 'Demons slain', run.kills],
        ['chain', 'Longest chain', run.best?.chain || 0],
        ['blades', 'Counters', run.best?.counters || 0],
        ['shield', 'Parries', run.best?.parries || 0],
        ['gem', 'Relics', Object.values(run.relics || {}).reduce((a, b) => a + b, 0)],
        ['glass', 'Time', time],
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
    if (this.input.pressed.size || this.input.mouseClicked[0]) this.audio.init();
    this.audio.update(rawDt);
    if (this.paused && (this.input.mouseClicked[0] || this.input.taps.length)) this.input.requestLock();

    if (!this.paused) {
      let wdt = dt;
      if (this.hitStopT > 0) {
        this.hitStopT -= dt;
        wdt = dt * 0.12;
      }
      this.time += wdt;
      if (this.ctx) this.ctx.realDt = dt;
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
    const own = !this.input.locked && !this.input.touch;
    this.hud.setCursor(own, this.input.pointer.x, this.input.pointer.y);
    if (own !== this.ownCursor) {
      this.ownCursor = own;
      this.host.setCursor?.(own);
    }
    this.input.endFrame();
    this._render(dt);
  }

  // Holds the frame rate up. The 3D view's resolution (only it: the
  // interface stays sharp) steps down a little at a time while frames run
  // long, and back up when there is time to spare. Slow machines also lose
  // the ground mist, and get sparser scenery from the next floor (`slow`).
  _adaptQuality(rawDt) {
    // A hidden tab, or a floor being built: not a measure of anything.
    if (rawDt > 1 || this.busy || this.compiling) return;
    const q = (this.quality ||= { avg: 1 / 60, t: 0, good: 0, drops: 0 });
    q.avg += (Math.min(rawDt, 0.1) - q.avg) * 0.06;
    q.t += rawDt;
    if (q.t < 1.5) return;
    q.t = 0;
    const base = Math.min(1, 1280 / Math.max(1, this.host.width * this.uiRatio));
    if (q.avg > 1 / 45 && this.sceneScale > base * 0.52) {
      this.sceneScale = Math.max(base * 0.5, this.sceneScale * 0.85);
      q.drops++;
      q.good = 0;
      q.avg = 1 / 60;
      this.slow = q.drops >= 3 ? 1 : 0;
      this._resize();
    } else if (q.avg < 1 / 80 && this.sceneScale < base) {
      if (++q.good >= 4) {
        this.sceneScale = Math.min(base, this.sceneScale / 0.85);
        q.good = 0;
        this._resize();
      }
    } else q.good = 0;
    this.level?.dressing?.setMist?.(this.sceneScale > base * 0.7);
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
    r.setClearColor(0x000000, 1);
    r.autoClear = true;
    if (this.compiling) {
      // Behind the black fade: draw only the HUD while shaders compile.
      r.setRenderTarget(null);
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
    r.setRenderTarget(this.sceneTarget);
    r.render(this.scene, rc);
    if (this.viewRoot.visible && this.run && !this.player.dead) {
      this.viewRoot.position.copy(rc.position);
      this.viewRoot.quaternion.copy(rc.quaternion);
      this.viewRoot.updateMatrixWorld(true);
      this.viewCamera.position.copy(rc.position);
      this.viewCamera.quaternion.copy(rc.quaternion);
      this.viewGlow.intensity = 6 * (0.85 + Math.sin(this.time * 13) * 0.1) * this.player.torchLit;
      r.autoClear = false;
      r.clearDepth();
      r.render(this.viewScene, this.viewCamera);
    }
    r.setRenderTarget(null);
    r.autoClear = true;
    r.render(this.blitScene, this.blitCamera);
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

// A pair of glowing chevrons lying on the floor, pointing along +Z.
function makeGuideArrow() {
  const shape = new THREE.Shape();
  const chevron = (y) => {
    shape.moveTo(0, y + 0.55);
    shape.lineTo(0.5, y);
    shape.lineTo(0.3, y);
    shape.lineTo(0, y + 0.3);
    shape.lineTo(-0.3, y);
    shape.lineTo(-0.5, y);
    shape.lineTo(0, y + 0.55);
  };
  chevron(0);
  const geo = new THREE.ShapeGeometry(shape);
  const second = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 1.05), new THREE.Vector2(0.5, 0.5), new THREE.Vector2(0.3, 0.5), new THREE.Vector2(0, 0.8), new THREE.Vector2(-0.3, 0.5), new THREE.Vector2(-0.5, 0.5)]));
  const merged = mergeGeometries([geo, second]);
  merged.translate(0, -0.5, 0);
  merged.rotateX(Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7a24, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const m = new THREE.Mesh(merged, mat);
  m.visible = false;
  m.renderOrder = 4;
  return m;
}

// The point `ahead` metres along a path (a list of {x, z}) from the path
// point nearest `from`.
function pointAlongPath(path, from, ahead) {
  if (!path?.length) return null;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = (path[i].x - from.x) ** 2 + (path[i].z - from.z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  // Head for the nearest node if it still lies ahead, else the one after it.
  let start = best;
  if (best < path.length - 1) {
    const sx = path[best + 1].x - path[best].x;
    const sz = path[best + 1].z - path[best].z;
    if ((from.x - path[best].x) * sx + (from.z - path[best].z) * sz > 0) start = best + 1;
  }
  let px = from.x;
  let pz = from.z;
  let left = ahead;
  for (let i = start; i < path.length; i++) {
    const q = path[i];
    const d = Math.hypot(q.x - px, q.z - pz);
    if (d >= left) return { x: px + ((q.x - px) * left) / d, z: pz + ((q.z - pz) * left) / d };
    left -= d;
    px = q.x;
    pz = q.z;
  }
  return { x: px, z: pz };
}

// Text in Unicode sans-serif bold (letters and digits), for plain-text places.
function bold(text) {
  return [...text]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + c - 65);
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + c - 97);
      if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + c - 48);
      return ch;
    })
    .join('');
}
