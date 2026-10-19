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
import { FLOORS, FLOOR_COUNT, floorDef, DEEP_FROM } from '../world/LevelData.js';
import { Effects } from '../world/Effects.js';
import { Player } from '../entities/Player.js';
import { Enemy } from '../entities/Enemy.js';
import { ENEMY_TYPES } from '../entities/EnemyTypes.js';
import { Boss, Sleeper } from '../entities/Bosses.js';
import { Archfiend } from '../entities/Archfiend.js';
import { Pickups } from '../entities/Pickups.js';
import { rollWeapon, makeWeapon, rememberWeapons, WEAPON_MODELS } from '../entities/Weapons.js';
import { AIDirector } from '../ai/AIDirector.js';
import { PathService } from '../ai/NavGrid.js';
import { newRun, NODES } from './Progression.js';
import { xpForKill, gainXp, spendPoint, legacyOf, STAT_IDS, LEVEL_STATS, STAT_CAP, MAX_LEVEL, LEVEL_HEAL } from './Levels.js';
import { TRANSITIONS, nextAfterFloor } from './transitions.js';
import { Hud, fmtTime, ANNOUNCE_HOLD } from '../ui/Hud.js';
import { pushOutOfCircle } from '../physics/CollisionWorld.js';
import { RELICS, rollRelic, relicPassive } from '../combat/Relics.js';
import { angleDelta } from '../core/rng.js';
import { disposeTree } from '../core/dispose.js';
import { Wounds, woundMaterials, prepareWounds } from '../combat/Wounds.js';

// The chance an elite demon carries a relic.
const ELITE_RELIC = 0.27;
// The lot's owner (Project 0 name, lower case): never paid a prize, never
// on the tables the game shows, and their runs post no scores.
const OWNER = 'purebullet';
// A table's rows without the owner's.
const players = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && !r.owner && String(r.name || '').trim().toLowerCase() !== OWNER);
// What the Deep's first floor says before it lets you in.
const DEEP_NOTICE = {
  title: 'Still being dug',
  lines: ['Floors 6 to 10 are in development.', 'You can play on to the end, but expect rough edges: layouts, demons and the last lord may still change, and some parts are unfinished.', 'Thank you for descending this far.'],
  button: 'Descend',
};

const ARMOR_HINT = 'A <b>gold</b> glow is an armoured blow: light hits won\u2019t stop it. <b>Block, dodge</b> or hit it heavy';

// Owns the run and the state machine that moves the player between the
// surface lot, the ten floors and the sanctums in between. Everything outside
// the game (renderer, input, sound, scores) comes from the host: Project 0's
// sandbox or a plain web page (src/platform).

const PLAYING = new Set(['surface', 'floor', 'sanctum']);
// The boss floors play "Blood in the Arena", unless they have songs of
// their own (SONG_FOR).
// Gorvath (floor 10) is fought to the Deep's own music.
// (Floor 5, the Sleeper's hall: "Shadows in the Hall" down the corridor,
// then "From Shadows to Thunder" once he is up: see _updateHall.)
const SONG_FOR = { 5: 'hall', 10: 'deep' };
// The Sleeper wakes while the arena's candles are still catching, round
// the room: this long after the first of them (the corridor's music fading
// away as he gets up).
const WAKE_AT = 0.9;
// The fall's torch goes out this far into it (of about 4.5 s).
const TORCH_OUT = 2.25;
const BOSS_TITLES = { sleeper: 'Warden of the fifth seal', azrakel: 'Lord of the last pit' };
// A finished descent's time goes on a table of its own, the quickest first
// (the weekly table keeps the deepest floor).
const DESCENT_BOARD = 'Fastest Descent';
// How long after the blow that levels you up before the choice opens.
const LEVEL_UP_DELAY = 0.7;
const LEVEL_UP_ARM = 0.6;

// How the 3D view is drawn, best first: how wide it renders (device pixels,
// never past the screen's own) and how many samples smooth its edges. The
// edges are always smoothed: multisampling where the machine has the room
// (it is costly on the high-precision target the world draws into, above
// all on laptop graphics), otherwise FXAA in the final pass, which costs
// next to nothing. It starts in the middle (START) and climbs while frames
// have time to spare, or steps down while they run long (_adaptQuality);
// the view never gets so small that its stretch to the screen shows as
// stair-steps, and the lower rungs give up the ground mist and some
// scenery instead.
const QUALITY = [
  { width: 1920, samples: 4 },
  { width: 1600, samples: 2 },
  { width: 1440, samples: 2 },
  { width: 1440, samples: 0 },
  { width: 1280, samples: 0 },
  { width: 1152, samples: 0 },
  { width: 1024, samples: 0 },
];
const START = 3;
// From this rung down there is no ground mist; further down, sparser scenery.
const NO_MIST = 5;
const SLOW = 6;
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
    this.maxSamples = msaaLimit(r);
    this.qualityLevel = START;
    this.sceneScale = this._sceneScaleAt(START);
    this.sceneTarget = this._sceneTargetWith(QUALITY[START].samples);
    this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blitScene = new THREE.Scene();
    const blit = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial(this.sceneTarget.texture));
    blit.frustumCulled = false;
    this.blitScene.add(blit);
    this.blit = blit;
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
    this.hitStopMax = 0;
    this.paused = false;
    this.busy = false;

    // Scores live in the host (the lot's weekly table on Project 0).
    host.on('reward', (r2) => {
      // The Sleeper's bounty, paid.
      if (r2?.kind === 'win') {
        if (r2.ok && r2.tokens > 0) {
          this.hud.toast(`The Sleeper's bounty: ${r2.tokens} tokens are yours`);
          this.audio.levelUp?.();
        }
        return;
      }
      if (r2?.kind !== 'score') return;
      // The answer to a descent's time, or to a floor reached.
      if (r2.board === DESCENT_BOARD || (this.pendingTime && r2.score === this.pendingTime)) {
        this.pendingTime = 0;
        if (r2.best) this.bestTime = r2.best;
        return;
      }
      if (r2.best && r2.best <= FLOOR_COUNT) this.best = Math.max(this.best, r2.best);
      this._refreshTitle();
    });
    host.on('table', (top) => {
      this.table = top || [];
      this._refreshTitle();
    });
    for (const row of this.table) if (row.you) this.best = Math.max(this.best, row.score);
    // The fastest descents this week (and this player's own best time).
    this.descent = [];
    this.bestTime = 0;
    this.pendingTime = 0;
    host.on('board', (b) => {
      if (b?.name === DESCENT_BOARD) this._setDescent(b.top);
    });
    this._setDescent(host.boards?.[DESCENT_BOARD]);

    this.fsm = new StateMachine(this, TRANSITIONS);
    this.fsm
      .add('title', { enter: (g) => g._enterTitle(), update: (g, dt) => g._updateTitle(dt), exit: (g) => g.hud.show('title', false) })
      .add('surface', { enter: (g) => g._enterSurface(), update: (g, dt) => g._updateSurface(dt) })
      .add('floor', { enter: (g, p) => g._enterFloor(p), update: (g, dt) => g._updateFloor(dt), exit: (g) => g._exitFloor() })
      .add('sanctum', { enter: (g, p) => g._enterSanctum(p), update: (g, dt) => g._updateSanctum(dt), exit: (g) => { g.hud.hideChoice(); g._closeMenu(); } })
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
    // The music starts with the game: the host plays it as soon as the
    // browser allows sound (on Project 0, the click that brought the player
    // in already has; otherwise the first click or key).
    this.audio.init();
    // Project 0's "How to play" box takes plain text: the keys are set in
    // Unicode bold so they stand out.
    host.hud(
      `${bold('WASD')} move · ${bold('Mouse')} aim · ${bold('Quick left click')} light attack · ${bold('Hold left click')} heavy attack (staggers) · ` +
        `${bold('Multiple hits')} chain attack · ${bold('Hit before it strikes')} double damage · ${bold('Right click')} block · ${bold('Space')} shade step (the way you move) · ${bold('Shift')} sprint · ${bold('E')} potion · ${bold('F')} take/use\n` +
        `Demon spells, once found: ${bold('Q')} Hellfire Nova · ${bold('R')} Blood Siphon\n` +
        'One life: die and you start again.',
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
    const tw = Math.max(1, Math.round(w * k));
    const th = Math.max(1, Math.round(h * k));
    this.sceneTarget.setSize(tw, th);
    // Stretched up to the screen: sharpen back a little of what the stretch
    // blurs (gently: sharpening brings back stair-steps too). Without
    // multisampling, FXAA smooths the edges instead.
    const u = this.blit.material.uniforms;
    u.uTexel.value.set(1 / tw, 1 / th);
    const fxaa = this.sceneTarget.samples === 0;
    u.uSharp.value = this.sceneScale < 0.95 ? Math.min(fxaa ? 0.12 : 0.25, (1 / this.sceneScale - 1) * 0.3) : 0;
    u.uFxaa.value = fxaa ? 1 : 0;
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
    // From here what drops is heard landing.
    if (this.pickups) this.pickups.quiet = false;
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
      // Every weapon a demon or a boss might drop (each its own textures),
      // and a relic (its sprites), all of which a boss drops at once.
      for (const id of Object.keys(WEAPON_MODELS)) this.pickups.addWeapon(0, 0, makeWeapon(id, 1));
      this.pickups.addRelic(0, 0, Object.keys(RELICS)[0]);
      for (const it of this.pickups.items.splice(before)) {
        it.mesh.removeFromParent();
        far(it.mesh);
      }
    }
    // The cuts, gashes and dents a blow leaves on a demon.
    for (const m of Object.values(woundMaterials())) far(new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), m));
    // The weapon in hand once a rare one is taken up.
    const held = this.player.previewWeapon(makeWeapon('swordBone', 2));
    held.position.set(0, -50, 0);
    this.viewRoot.add(held);
    staged.push(held);
    if (this.effects) {
      const t = this.effects.telegraph(0, 0, 1, 1e9, null);
      this.effects.items.splice(this.effects.items.indexOf(t), 1);
      t.group.removeFromParent();
      far(t.group);
      this.effects.fireball(new THREE.Vector3(0, -500, 0), new THREE.Vector3(1, 0, 0), 0, 0);
      // A blow on the floor (its crater, cracks, chunks), out of sight.
      this.effects.quake(0, 0, 3, 1, { y: -500 });
      const fb = this.effects.projectiles.pop();
      fb.mesh.removeFromParent();
      far(fb.mesh);
    }
    if (this.level) {
      // Boss summons and burrowed ambushers arrive mid-fight.
      const bodies = Object.keys(ENEMY_TYPES).map((type) => new Enemy(type, { x: 0, z: 0 }, this.level.def));
      for (const e of bodies) far(e.root);
      // Where a blow lands on each kind of body, worked out now rather than
      // on the first blow; and, once a session, a few blows struck on them
      // here, so the first real one runs ready code.
      for (const o of staged) prepareWounds(o);
      if (this.boss) prepareWounds(this.boss.root);
      if (this.wounds && !this.rehearsed) {
        this.rehearsed = true;
        this.wounds.rehearse(bodies);
      }
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
    // Whatever goes wrong building the next place, the black lifts: a
    // failed load is logged and play goes on as far as it can, never a
    // screen left dark for good.
    try {
      this.fsm.change(name, params);
      this.host.log(`[t] enter ${name}: ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      this.host.log(`[error] entering ${name}: ${err?.stack || err}`);
    }
    try {
      await this.warmUp();
    } catch (err) {
      this.compiling = false;
      this.host.log(`[error] warming up ${name}: ${err?.stack || err}`);
    }
    await this.hud.fade(false, 600);
    this.busy = false;
    const next = this.pendingGoto;
    this.pendingGoto = null;
    if (next) this.goto(next.name, next.params);
  }

  _newScene({ fog = 0x0b0606, density = 0.04, background = 0x050202 } = {}) {
    // The scene being left frees what it made (its GPU buffers and textures);
    // without this every floor visited stayed in video memory.
    disposeTree(this.scene);
    this.scene?.clear();
    this.camera.far = 300;
    this.camera.updateProjectionMatrix();
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
      hitStop: (s) => {
        if (s > this.hitStopT) this.hitStopT = this.hitStopMax = s;
      },
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
    this.surface.setScores({ best: this.best, last: this.lastFloor, top: players(this.table)[0] || null });
  }

  _refreshTitle() {
    this.hud.setTitleInfo({
      best: this.best,
      table: players(this.table),
      dev: this.devFloor ? `Dev start: floor ${this.devFloor} (scores not recorded)` : '',
      bounty: this._bounty(),
    });
  }

  // The prize for slaying the Sleeper, as the lot's rules set it: what the
  // player receives (the city keeps its fee, a tenth), or 0 when there is
  // none (or this player is the lot's owner).
  _bounty() {
    const G = this.host.game;
    if (!G || G.mode !== 'win' || !(G.prize > 0) || G.paused || this._isOwner()) return 0;
    return Math.round(G.prize * (1 - (G.fee ?? 0.1)) * 10) / 10;
  }

  // The lot's owner plays for nothing: known by name, or by a row of the
  // week's tables that is both theirs and the owner's.
  _isOwner() {
    const name = this.host.me?.()?.name;
    if (typeof name === 'string' && name.trim().toLowerCase() === OWNER) return true;
    const rows = [...(this.host.table || []), ...Object.values(this.host.boards || {}).flatMap((b) => b || [])];
    return rows.some((r) => r?.you && r?.owner);
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
    // Permadeath: a fresh run every time you stand on the surface, keeping
    // only half the level of the one that fell.
    this.run = newRun();
    if (this.legacy) {
      Object.assign(this.run, this.legacy);
      if (this.legacy.level) setTimeout(() => this.run?.level && this.hud.toast(`You rise again at level ${this.run.level}: half your strength kept`), 2600);
    }
    this.legacy = null;
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
      // Halfway down, the rushing air snuffs the torch: it gutters, goes
      // out with a hiss and a puff of smoke, and the rest of the way is dark.
      if (fall > TORCH_OUT && !this.torchOutT) {
        this.torchOutT = 0.001;
        this.audio.extinguish?.();
      }
      if (this.torchOutT) {
        const t = (this.torchOutT += dt);
        p.torchLit = Math.max(0, 1 - t / 0.55) * (0.55 + 0.45 * Math.abs(Math.sin(t * 37)));
        if (t < 0.9 && p.fire?.group) {
          const at = p.fire.group.getWorldPosition(new THREE.Vector3());
          for (let i = 0; i < 3; i++) this.fx.alpha.emit({ x: at.x, y: at.y, z: at.z, vx: (Math.random() - 0.5) * 0.6, vy: 2 + Math.random() * 3, vz: (Math.random() - 0.5) * 0.6, life: 0.8, size: 0.12, sizeEnd: 0.5, color: C.smoke, colorEnd: C.smoke, alpha: 0.5, drag: 0.5 });
        }
      }
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
      this.torchOutT = 0;
      this.surface.falling(true);
      this.hud.announcement = null;
      this.hud.update(dt, p, this.run, { floorLabel: '', enemyLabel: '', best: this.best, prompt: '' });
      this.audio.portal();
      this.audio.fadeMusic(2.5);
    }
    this.hud.update(dt, p, this.run, {
      floorLabel: `${this.lotLabel}: The Surface`,
      enemyLabel: '',
      best: this.best,
      prompt: this.surface.nearPit(p.position) ? 'Step into the pit to begin your descent' : '',
    });
  }

  // ---------------------------------------------------------------- floor ---

  _enterFloor({ floor, arrival = false }) {
    const def = floorDef(floor);
    const inDeep = floor >= DEEP_FROM;
    this.audio.music(SONG_FOR[floor] || (def.boss ? 'boss' : inDeep ? 'deep' : 'drone'));
    const run = this.run;
    // Each floor gives the spells their uses again.
    run.spellUses = {};
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
    this.hemi = new THREE.HemisphereLight(look.sky, look.earth, look.hemi);
    s.add(this.hemi);
    this.hallLit = 0;
    this.wakeT = -1;
    // Nothing past what the dark lets you see is drawn at all.
    this.camera.far = level.sight + 16;
    this.camera.updateProjectionMatrix();

    this.enemies = [];
    this.eliteCount = 0;
    this.effects = new Effects(s, this.fx);
    this.pickups = new Pickups(s);
    this.wounds = new Wounds(s);
    this.director = new AIDirector(level.nav, def);
    this.pathService = new PathService(level.nav, 8);
    this.boss = null;
    this.bossAnnounced = false;
    this.deadT = 0;
    this.levelUp = null;
    this.levelUpT = 0;

    this.ctx = this._baseCtx({
      world: level.world,
      ground: 'gravel',
      nav: level.nav,
      director: this.director,
      pathService: this.pathService,
      enemies: this.enemies,
      effects: this.effects,
      wounds: this.wounds,
      tuning: def,
      torchRange: def.light,
      onEnemyKilled: (e) => this._onEnemyKilled(e),
      pickups: this.pickups,
      props: level.props,
      spawnEnemy: (type, pos, emerge) => this._spawnEnemy(type, pos, emerge),
      onBossEvent: (kind, b) => this._onBossEvent(kind, b),
    });

    this.guide = makeGuideArrow();
    s.add(this.guide);
    this.guideT = 0;
    this.guideDir = null;

    for (const e of level.data.enemies) this._spawnEnemy(e.type, e);
    // Champions: from the third floor the demons nearest the gate are elites,
    // one of them (two from the Deep on), waiting where you must go.
    const champions = floor >= DEEP_FROM ? 2 : floor >= 3 ? 1 : 0;
    const gate = level.data.exit;
    if (champions && gate && !def.boss) {
      const near = this.enemies.filter((e) => e.state !== 'burrowed').sort((a, b) => Math.hypot(a.position.x - gate.x, a.position.z - gate.z) - Math.hypot(b.position.x - gate.x, b.position.z - gate.z));
      for (const e of near.slice(0, champions)) {
        e.makeElite();
        this.eliteCount++;
      }
    }
    if (level.data.boss) {
      const B = level.data.boss;
      const Kind = B.type === 'sleeper' ? Sleeper : B.type === 'azrakel' ? Archfiend : Boss;
      const b = new Kind(B.type, B, def);
      // He sleeps facing the way you come in.
      if (level.hall) b.yaw = Math.atan2(level.spawn.x - B.x, 0);
      this._addEnemy(b);
      s.add(b.light);
      this.boss = b;
      if (level.hall) level.hall.boss = b;
    }
    for (const p of level.data.potions) this.pickups.addPotion(p.x, p.z);
    for (const w of level.data.weapons) this.pickups.addWeapon(w.x, w.z, rollWeapon(floor, 0.6));

    const sp = level.spawn;
    this.player.spawnAt(sp.x, sp.z, level.spawnYaw());
    this.player.position.y = 0;
    this.player.dash = null;
    // (The Deep's first floor: what it says stays up longer, to be read.)
    const hold = floor === DEEP_FROM ? ANNOUNCE_HOLD + 3 : ANNOUNCE_HOLD;
    this.floorTitle = [`Floor ${floor}`, def.boss ? def.name : `${def.name}${inDeep ? ', in the Deep' : ''}`, hold];
    this.intro = null;
    this.renderer.toneMappingExposure = 1.2;
    // The Deep is still being dug: its first floor opens on a notice that
    // says so, and the floor's title waits until it has been read.
    this.notice = null;
    if (floor === DEEP_FROM && !arrival) {
      this.notice = { floor, hold };
      this.hud.showNotice(DEEP_NOTICE);
      this._openMenu();
    } else if (arrival) this._beginArrival(level);
    else this.hud.announce(...this.floorTitle);
    if (this.newRecord) {
      this.newRecord = false;
      setTimeout(() => this.hud.toast('New deepest descent!'), 1500);
    }
    if (floor > DEEP_FROM && !def.boss) {
      // Each floor below that: they grow worse again.
      setTimeout(() => {
        if (this.run?.floor === floor) this.hud.toast('Deeper still: the demons grow stronger and quicker');
      }, 3200);
    }
  }

  // Overlapping demons are pushed apart, the lighter one further, and kept
  // out of the rock.
  _separate(level) {
    const list = (this._sepList ||= []);
    list.length = 0;
    for (const e of this.enemies) if (e.alive && e.state !== 'burrowed' && e.state !== 'latched' && !e.hidden && e.root.position.y < 1) list.push(e);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const min = (a.radius + b.radius) * 0.95;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const nx = d2 > 1e-8 ? dx / d : Math.cos(i + j);
        const nz = d2 > 1e-8 ? dz / d : Math.sin(i + j);
        const ma = a.type.mass || 1;
        const mb = b.type.mass || 1;
        const over = min - d;
        a.position.x -= nx * over * (mb / (ma + mb));
        a.position.z -= nz * over * (mb / (ma + mb));
        b.position.x += nx * over * (ma / (ma + mb));
        b.position.z += nz * over * (ma / (ma + mb));
      }
    }
    for (const e of list) level.world.resolve(e.position, e.radius);
  }

  _addEnemy(e) {
    e.attachFx(this.fx);
    this.scene.add(e.root);
    this.enemies.push(e);
    return e;
  }

  _spawnEnemy(type, pos, emerge = false) {
    const e = new Enemy(type, pos, this.level.def);
    this._addEnemy(e);
    if (emerge) {
      // (A boss's summons: worth half the experience.)
      e.summoned = true;
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
    if (kind === 'swing') this._hint('rhythm', 'Click again <b>when the ring round your crosshair turns gold</b> for a Perfect hit');
    else if (kind === 'perfect' && chain >= 2) this._hint('chain', 'Keep the rhythm: each link of the chain strikes <b>harder</b> and wakes your relics');
    else if (kind === 'fumble') this._hint('fumble', 'Too soon: click <b>before the ring turns gold</b> and your next swing is sluggish and leaves you <b>exposed</b>');
    else if (kind === 'heavy') this._hint('heavy', 'A heavy blow cannot be stopped once it falls: <b>commit</b> to it');
    if (kind === 'perfect') {
      if (r) r.best.chain = Math.max(r.best.chain, chain);
      this.hud.rhythm('perfect', chain);
      if (chain >= 2) this.hud.callout(chain >= 5 ? `PERFECT ×${chain}: FLOW` : `PERFECT ×${chain}`, { color: chain >= 4 ? '#fff4d0' : '#ffd070', size: 0.8 + chain * 0.06 });
      else this.hud.callout('PERFECT', { color: '#ffd070', size: 0.75 });
    } else if (kind === 'fumble') {
      this.audio.fumble();
      this.hud.rhythm('fumble');
      this.hud.callout('TOO SOON', { color: '#c0503a', size: 0.62 });
    } else if (kind === 'sluggish') {
      this.hud.callout('SLUGGISH: EXPOSED', { color: '#8a6a60', size: 0.62 });
    } else if (kind === 'dodge') this.hud.rhythm('dodge');
  }

  _onCombat(kind) {
    const r = this.run;
    if (kind === 'clash') this._hint('guard', 'Guarded: wait for the ward to drop, or break it with an <b>axe</b> or a charged <b>mace</b>');
    else if (kind === 'counter') this._hint('counter', 'Counter: strike a demon <b>while it glows red</b> winding up and it <b>staggers</b>');
    if (kind === 'counter') {
      if (r) r.best.counters++;
      this.hud.callout('COUNTER', { color: '#ffb060', size: 1.15 });
      this.player.flash(0xffa040, 30, 0.18);
    } else if (kind === 'clash') this.hud.callout('GUARDED', { color: '#c05040', size: 0.85 });
    else if (kind === 'guardBreak') this.hud.callout('GUARD SHATTERED', { color: '#ff8a3a', size: 1.0 });
    else if (kind === 'latched') {
      this.hud.callout('STRIKE IT OFF', { color: '#ff5a3a', size: 1.0 });
      this._hint('latched', 'A hound has its jaws in you: <b>strike it</b> to throw it off, or step out of its <b>red cone</b> before it leaps');
    } else if (kind === 'shakenOff') this.hud.callout('THROWN OFF', { color: '#ffb060', size: 0.9 });
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
    else if (kind === 'open') {
      this.hud.callout('OPEN', { color: '#ffb040', size: 1.25 });
      this._hint('open', 'He glows like the forge: <b>strike now</b>, while he is open');
    } else if (kind === 'glance' || kind === 'untouchable') {
      if (this.time - (this.glanceT ?? -9) > 1.2) this.hud.callout(kind === 'glance' ? 'GLANCED' : 'UNTOUCHABLE', { color: '#9a8a80', size: 0.8 });
      this.glanceT = this.time;
      this._hint('glance', 'His hide turns blows aside. He is <b>open</b> after his own blows, when you <b>parry</b> him, when he lands a pounce, or when his dash hits a pillar');
    }
    else if (kind === 'grabbed') {
      this.hud.callout('SEIZED', { color: '#ff6a4a', size: 1.0 });
      this._hint('grab', 'His open hand is quicker than his axe: <b>Shade Step</b> out of its reach');
    }
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

  // The Sleeper's hall: once the arena's candles are all lit, the arena
  // brightens, the corridor's music fades and he wakes; when he is up and
  // has spoken, the fight's music starts.
  _updateHall(dt) {
    const level = this.level;
    const hall = level.hall;
    if (hall.domino >= WAKE_AT && this.wakeT < 0 && this.boss?.asleep) {
      this.wakeT = 0;
      this.audio.fadeMusic(1.5);
      this.boss.wake(this.ctx);
    }
    // Lit: the murk lifts and the whole arena can be seen.
    if (hall.litK !== this.hallLit) {
      this.hallLit = hall.litK;
      const k = hall.litK;
      const look = level.look;
      this.hemi.intensity = look.hemi * (1 + 4 * k);
      this.renderer.toneMappingExposure = 1.2 + 0.2 * k;
      this.fogBase = level.def.fog * (look.haze || 1) * (1 - 0.65 * k);
      level.sight = level.baseSight + (60 - level.baseSight) * k;
      this.camera.far = level.sight + 16;
      this.camera.updateProjectionMatrix();
    }
  }

  _onBossEvent(kind, b) {
    if (kind !== 'fight') return;
    this.audio.music('thunder');
    if (b.bossKey === 'sleeper') this._hint('sleeper', 'Nothing staggers <b>Vorgrath</b>: keep clear of his axe, or block it');
  }

  _onProc(id, P) {
    if (this.run) this.run.best.procs++;
    this._hint('proc', 'Relics wake on <b>perfect chains, counters and head hits</b>: fight in rhythm to set them off');
    this.hud.callout(P.name.toUpperCase(), { color: P.color, size: 1.05, proc: true });
  }

  _onEnemyKilled(e) {
    const run = this.run;
    run.kills++;
    // Experience; a level made opens the choice a moment later (_updateLevelUp).
    // (The last lord's death ends the descent: no perk to choose after it.)
    const last = e.isBoss && run.floor === FLOOR_COUNT;
    if (!last && gainXp(run, xpForKill(e, run.floor)) > 0) this._levelGained();
    const luck = this.level.def.loot;
    const loot = e.type.loot;
    const x = e.position.x;
    const z = e.position.z;
    const off = () => (Math.random() - 0.5) * 0.8;
    if (Math.random() < loot.potion * luck) this.pickups.addPotion(x + off(), z + off());
    if (Math.random() < loot.weapon * luck) this.pickups.addWeapon(x + off(), z + off(), rollWeapon(run.floor, e.isBoss ? 1 : 0));
    if (Math.random() < loot.spell * luck) this.pickups.addSpell(x + off(), z + off());
    // Elites sometimes carry relics (about one in four); bosses always do.
    if ((e.elite && Math.random() < ELITE_RELIC) || e.isBoss) this.pickups.addRelic(x + off(), z + off(), rollRelic(run));
    if (e.isBoss) {
      this.hud.announce(`${e.name.split(',')[0]} is slain`, 'The seal breaks');
      // Slaying the Sleeper is the lot's win: its prize goes to the player
      // (never to the lot's owner, nor on a dev start).
      if (e.bossKey === 'sleeper' && !run.dev && !run.won && !this._isOwner()) {
        run.won = true;
        this.host.win?.();
      }
      this.pickups.addPotion(x + 1.2, z);
      // The Sleeper's hall falls quiet for his last words; its gate goes up
      // and its fountain of blood rises.
      if (this.level.hall) {
        this.audio.fadeMusic(6);
        this.level.hall.onBossDown(x, z);
      }
    }
  }

  _updateFloor(dt) {
    // A notice up (the Deep's first floor): the floor holds still meanwhile.
    if (this._updateNotice(dt)) return;
    // Choosing what a level brings: the floor holds still meanwhile.
    if (this._updateLevelUp(dt)) return;
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
          else if (!this.hints?.has('tell')) this._hint('tell', 'It glows red as it winds up: <b>strike now to stagger it</b>, block, or step away');
        }
      }
    }

    // Demons never stand inside one another.
    this._separate(level);

    // Bodies push the player out (except when passing through as a shade,
    // or held in a giant's fist).
    if (!p.dash && !p.dead && !p.held && !p.air) {
      for (const e of this.enemies) {
        if (!e.alive || e.state === 'burrowed' || e.state === 'latched' || e.root.position.y > 1) continue;
        pushOutOfCircle(p.position, p.radius, e.position.x, e.position.z, e.radius);
      }
      level.world.resolve(p.position, p.radius);
    }

    for (const e of this.enemies) {
      const far = e.distToPlayer > Math.min(42, level.sight + 6) && !e.isBoss;
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
    this.wounds.update(dt);
    this.pickups.update(dt, ctx);

    const alive = this.enemies.filter((e) => e.alive);
    // The last lord down: the descent's clock stops.
    if (this.boss && !this.boss.alive && this.run.floor === FLOOR_COUNT && !this.run.finished) {
      this.run.finished = true;
      if (!this.run.dev) this.hud.toast(`Descent time ${fmtTime(this.run.time, true)}`);
    }
    if (!level.exitOpen && alive.length === 0) {
      level.openExit();
      this.audio.sealBreak();
      if (!this.boss) this.hud.announce('The seal breaks', 'Find the portal and descend');
    }
    if (this.boss && !this.bossAnnounced && this.boss.isEngaged()) {
      this.bossAnnounced = true;
      this.hud.announce(this.boss.name, BOSS_TITLES[this.boss.bossKey] || '');
      this.audio.roar(this.boss.position);
    }
    if (level.hall) this._updateHall(dt);

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

    let prompt = this.pickups.weaponPrompt(this.run) || level.props.prompt() || level.hall?.prompt();
    if (!prompt && level.exitOpen && !p.dead) prompt = 'The portal is open: descend';
    this.hud.update(dt, p, this.run, {
      floorLabel: `Floor ${this.run.floor} / ${FLOOR_COUNT}: ${level.def.name}`,
      enemyLabel: level.exitOpen ? 'Seal broken' : alive.length === 1 ? '1 demon remains' : `${alive.length} demons remain`,
      best: this.best,
      boss: this.boss && this.bossAnnounced && this.boss.alive ? this.boss : null,
      prompt,
      compass: this._compass(alive),
    });
  }

  // A level gained (they are few, and each one is a perk): time catches its
  // breath, a column of golden light rises round you, a third of your
  // wounds close, and a moment later the choice opens.
  _levelGained() {
    const run = this.run;
    const p = this.player;
    this.levelUpT = LEVEL_UP_DELAY + 0.3;
    run.health = Math.min(run.maxHealth, run.health + Math.round(run.maxHealth * LEVEL_HEAL));
    this.audio.levelUp?.();
    this.hud.callout(`LEVEL ${run.level}`, { color: '#ffe08a', size: 1.7 });
    this.hud.toast(`Level ${run.level}: a perk to choose, and your wounds close`);
    this.ctx?.hitStop?.(0.45);
    p.flash?.(0xffd27a, 40, 0.6);
    p.shake?.(0.15);
    const x = p.position.x;
    const z = p.position.z;
    const gold = new THREE.Color(1, 0.82, 0.4);
    const white = new THREE.Color(1, 0.97, 0.85);
    // A ring on the floor bursting outward, and sparks spiralling up.
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      this.fx.add.emit({ x: x + Math.cos(a) * 0.6, y: 0.15, z: z + Math.sin(a) * 0.6, vx: Math.cos(a) * 6, vy: 0.4, vz: Math.sin(a) * 6, life: 0.8, size: 0.22, sizeEnd: 0.04, color: white, colorEnd: gold, drag: 2.5 });
    }
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.7 + Math.random() * 0.6;
      this.fx.add.emit({ x: x + Math.cos(a) * r, y: Math.random() * 0.6, z: z + Math.sin(a) * r, vx: -Math.sin(a) * 1.6, vy: 2.5 + Math.random() * 3.5, vz: Math.cos(a) * 1.6, life: 1.2 + Math.random() * 0.8, size: 0.09, sizeEnd: 0.02, color: white, colorEnd: gold, drag: 0.6, turbulence: 0.8 });
    }
  }

  // A level gained: a moment after the blow that made it, everything stops
  // and a box asks where the point goes (1, 2, 3 or a click), one box per
  // point. Returns true while it is open.
  _updateLevelUp(dt) {
    const run = this.run;
    const p = this.player;
    if (!this.levelUp) {
      this.levelUpT = Math.max(0, this.levelUpT - dt);
      // (Not while a boss's death plays out: it waits until he is down.)
      if (!run?.points || this.levelUpT > 0 || this.busy || this.intro || p.dead || this.hud.panel || this.boss?.dyingScene?.()) return false;
      this.levelUp = true;
      p.swing = null;
      p.charge = null;
      p.press = null;
      p.blocking = false;
      this.hud.showLevelUp(this._levelUpInfo());
      this._openMenu();
      // A click meant as a blow must not pick a card: the cards wake only
      // once the box has been up a moment and the button has been let go.
      this.levelUpWait = LEVEL_UP_ARM;
      this.levelUpHeld = true;
      this.hud.setLevelArmed(false);
      this.audio.choose?.();
      return true;
    }
    this.input.consumeMouse();
    this.levelUpWait = Math.max(0, this.levelUpWait - dt);
    if (!this.input.mouseDown[0]) this.levelUpHeld = false;
    this.hud.setLevelArmed(this.levelUpWait <= 0 && !this.levelUpHeld);
    for (let i = 0; i < STAT_IDS.length; i++) {
      if (!this.input.wasPressed(`Digit${i + 1}`) || !spendPoint(run, STAT_IDS[i])) continue;
      const S = LEVEL_STATS[STAT_IDS[i]];
      this.audio.choose();
      this.hud.toast(`${S.name} ${run.stats[STAT_IDS[i]]}/${STAT_CAP}: ${S.text}`);
      if (run.points > 0) {
        this.hud.showLevelUp(this._levelUpInfo());
        return true;
      }
      this.levelUp = null;
      this.hud.hideLevelUp();
      this._closeMenu();
      return true;
    }
    return true;
  }

  // The notice on the Deep's first floor: Enter, Space, F or its button
  // closes it, then the floor's title and what the Deep holds are shown.
  // Returns true while it is up.
  _updateNotice(dt) {
    const n = this.notice;
    if (!n) return false;
    this.hud.update(dt, this.player, this.run, { floorLabel: `Floor ${this.run.floor} / ${FLOOR_COUNT}: ${this.level.def.name}`, enemyLabel: '', best: this.best, prompt: '' });
    // (A pause over it takes the screen; back from the pause, it returns.)
    if (!this.hud.panel) {
      this.hud.showNotice(DEEP_NOTICE);
      this._openMenu();
      return true;
    }
    const go = ['Enter', 'Space', 'KeyF', 'NumpadEnter'].some((k) => this.input.wasPressed(k));
    this.input.consumeMouse();
    if (!go) return true;
    this.notice = null;
    this.hud.hideNotice();
    this._closeMenu();
    this.audio.choose?.();
    this.hud.announce(...this.floorTitle);
    const floor = n.floor;
    setTimeout(() => {
      if (this.run?.floor === floor && this.fsm.currentName === 'floor') this.hud.announce('Into the Deep', 'Its demons are quicker, hunt in packs, lie in ambush; champions guard the gates', n.hold);
    }, (n.hold - 0.2) * 1000);
    return true;
  }

  // A menu over the game takes the mouse: with the pointer locked it moves
  // a cursor of the game's own from near the top of the screen (clear of the
  // choices, so a stray click picks nothing); without a lock, the page's.
  _openMenu() {
    this.uiMouse = true;
    if (this.input.locked) this.input.menuCursor(this.hud.w / 2, this.hud.h * 0.14, this.hud.w, this.hud.h);
  }

  _closeMenu() {
    if (!this.uiMouse) return;
    this.uiMouse = false;
    this.input.closeMenu();
    this.input.requestLock();
  }

  _levelUpInfo() {
    const run = this.run;
    return { level: run.level, points: run.points, max: run.level >= MAX_LEVEL, stats: STAT_IDS.map((id) => ({ id, ...LEVEL_STATS[id], have: run.stats[id], cap: STAT_CAP })) };
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
    if (this.notice) {
      this.notice = null;
      this.hud.hideNotice();
    }
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
      if (!options.length) this.hud.toast(NODES[focused.key].spent || 'Nothing stirs here.');
      else {
        this.choice = { node: focused, options };
        this.hud.showChoice(NODES[focused.key].title, options);
        this._openMenu();
      }
    }
    if (sc.atPortal(p.position) && !this.busy) {
      this.audio.portal();
      this.goto('floor', { floor: sc.nextFloor });
    }
    let prompt = '';
    if (this.choice) prompt = '';
    else if (sc.portalOpen) prompt = 'The way down is open';
    else if (focused) prompt = `<b>F</b> ${NODES[focused.key].title}`;
    else prompt = 'Approach an altar and press <b>F</b>';
    this.hud.update(dt, p, this.run, { floorLabel: `Sanctum, before Floor ${sc.nextFloor}`, enemyLabel: '', best: this.best, prompt });
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
    this._closeMenu();
  }

  // ------------------------------------------------------- death / victory ---

  _setDescent(top) {
    const rows = Array.isArray(top) ? top : [];
    for (const r of rows) if (r.you && r.score > 0) this.bestTime = this.bestTime ? Math.min(this.bestTime, r.score) : r.score;
    this.descent = players(rows);
    if (this.hud.endInfo?.time) this.hud.setEnd({ ...this.hud.endInfo, board: this.descent });
  }

  _enterEnd(won) {
    const run = this.run;
    // The weapons this run took in hand turn up more often in the next
    // (the more runs found one, the more often); the death screen shows
    // them all.
    const arsenal = rememberWeapons(run.found);
    this.lastFloor = run.floor;
    // The deepest floor reached goes on the lot's weekly table, and a
    // finished descent's time on the table of the fastest.
    // (Not the owner's: they stay off the tables.)
    const posts = !run.dev && !this._isOwner();
    if (posts) this.host.score(run.floor);
    let time = null;
    if (won && run.finished) {
      const ms = Math.max(1, Math.round(run.time * 1000));
      const prev = this.bestTime;
      const record = !run.dev && (!prev || ms < prev);
      if (posts) {
        this.pendingTime = ms;
        this.host.score(ms, { board: DESCENT_BOARD, lower: true });
      }
      if (record) this.bestTime = ms;
      time = { ms, best: this.bestTime || ms, record, prev };
    }
    this.hud.setPlaying(false);
    this.viewRoot.visible = false;
    const name = FLOORS[run.floor - 1]?.name || '';
    // Half the fallen run's level carries into the next.
    this.legacy = won ? null : legacyOf(run);
    const kept = this.legacy?.level || 0;
    this.hud.setEnd({
      won,
      time,
      board: this.descent,
      lines: won
        ? ['Azrakel has fallen. The descent is done.', time ? `${fmtTime(time.ms / 1000, true)} from the first floor to his death.` : 'You climb out of the pit with nothing but the memory of it.']
        : [`Slain on floor ${run.floor}: ${name}`, kept ? 'Everything you carried is lost, but not all your strength.' : 'Everything you carried is lost.'],
      // Half the level kept (the plaque under the verdict says so).
      rise: kept ? { level: kept, from: run.level, stats: { ...this.legacy.stats }, points: this.legacy.points } : null,
      floor: run.floor,
      floors: FLOORS.length,
      deepest: Math.max(this.best, run.floor),
      record: !run.dev && run.floor > (this.bestAtStart ?? 0),
      stats: won
        ? [
            ['skull', 'Demons slain', run.kills],
            ['chain', 'Longest chain', run.best?.chain || 0],
            ['blades', 'Counters', run.best?.counters || 0],
            ['shield', 'Parries', run.best?.parries || 0],
            ['gem', 'Relics', Object.values(run.relics || {}).reduce((a, b) => a + b, 0)],
            ['blades', 'Best weapon', run.bestWeapon?.name || run.weapon?.name || 'None', run.bestWeapon?.color],
          ]
        : [
            ['skull', 'Demons slain', run.kills],
            ['chain', 'Longest chain', run.best?.chain || 0],
            ['shield', 'Parries', run.best?.parries || 0],
            ['gem', 'Relics', Object.values(run.relics || {}).reduce((a, b) => a + b, 0)],
          ],
      // Every weapon found in the runs so far, best first (the death
      // screen's gallery).
      arsenal: won ? null : arsenal,
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
    // The weapons gallery scrolls: its arrows, the arrow keys (or A, D), the wheel.
    const inp = this.input;
    const step = (inp.wasPressed('ArrowRight') || inp.wasPressed('KeyD') ? 1 : 0) - (inp.wasPressed('ArrowLeft') || inp.wasPressed('KeyA') ? 1 : 0);
    this.wheelAcc = (this.wheelAcc || 0) + inp.wheel;
    let turn = 0;
    if (Math.abs(this.wheelAcc) >= 60) {
      turn = Math.sign(this.wheelAcc);
      this.wheelAcc = 0;
    }
    if (step || turn) this.hud.scrollArsenal(step || turn);
    // (A click on one of its arrows is not a click to rise again.)
    const onOther = inp.tapButton && inp.tapButton !== 'Space';
    const go = inp.wasPressed('Space') || inp.wasPressed('KeyR') || (!onOther && (inp.mouseClicked[0] || inp.taps.length));
    if (this.endT > 1.2 && !this.busy && go) {
      this.input.requestLock();
      this.goto('surface');
    }
  }

  // ----------------------------------------------------------------- loop ---

  _frame(rawDt) {
    const dt = Math.min(0.05, this._pace(rawDt));
    this._adaptQuality(rawDt);
    this.hud.touch = this.input.touch;
    // Taps on the on-screen buttons act as their keys.
    for (const t of this.input.taps) {
      const code = this.hud.buttonAt(t.x, t.y);
      if (!code) continue;
      if (this.hud.panel === 'levelup' && !this.hud.levelArmed) {
        this.input.claimTap?.();
        continue;
      }
      if (code === 'Mouse0') this.input.mouseClicked[0] = true;
      else this.input.pressed.add(code);
      this.input.tapButton = code;
      this.input.claimTap?.();
    }
    if (this.input.pressed.size || this.input.mouseClicked[0]) this.audio.init();
    this.audio.update(rawDt);
    // Play wants the pointer locked: a click wins it back (after a pause, or
    // if a browser refused it).
    const state = this.fsm.currentName;
    const menu = this.paused || this.uiMouse || !!this.hud.panel || !PLAYING.has(state);
    if ((this.paused || (!menu && !this.busy)) && (this.input.mouseClicked[0] || this.input.taps.length)) this.input.requestLock();

    if (!this.paused) {
      let wdt = dt;
      if (this.hitStopT > 0) {
        // The weight of a blow: time all but stops, then eases back up to
        // speed over the second half (no jolt as it lets go).
        const k = Math.min(1, (this.hitStopT / Math.max(1e-3, this.hitStopMax)) * 2);
        wdt = dt * (1 - 0.88 * k * k * (3 - 2 * k));
        this.hitStopT -= dt;
      }
      this.time += wdt;
      if (this.ctx) this.ctx.realDt = dt;
      this.fsm.update(wdt);
      // The descent's clock: play time from the first floor to the
      // Archfiend's death (menus, choices and loading stopped out).
      const run = this.run;
      if (run && !run.finished && run.floor >= 1 && !menu && !this.busy && (state === 'floor' || state === 'sanctum')) run.time = (run.time || 0) + dt;
      this.fx.add.update(wdt);
      this.fx.alpha.update(wdt);
      this.audio.listener = this.player.position;
      if (this.run && PLAYING.has(this.fsm.currentName)) {
        const frac = this.run.health / this.run.maxHealth;
        this.audio.setLowHealth(frac < 0.3 && !this.player.dead ? (0.3 - frac) / 0.3 : 0, dt);
      }
      this.hud.updateNumbers(dt);
    }
    // The sword cursor: over a menu only, never while you play.
    const cur = this.input.cursor;
    const own = menu && (!this.input.locked || cur === this.input.menu) && !this.input.touch;
    this.hud.setCursor(own, cur.x, cur.y);
    if (own !== this.ownCursor) {
      this.ownCursor = own;
      this.host.setCursor?.(own);
    }
    this.input.endFrame();
    this._render(dt);
  }

  // Holds the frame rate up. The 3D view's resolution (only it: the
  // interface stays sharp) steps down a rung while frames run long, and back
  // up when there is time to spare. Each 1.5 s window is judged by its median
  // frame, so a single hitch (a collection, a model's first draw) moves
  // nothing, and against the screen's own frame interval (the quickest frames
  // come at it: 16.7 ms at 60 Hz, 6.9 ms at 144 Hz), so a 60 Hz screen can
  // climb back up too. A rung that had to be left waits longer each time
  // before it is tried again. Slow machines also lose the ground mist, and
  // get sparser scenery from the next floor (`slow`).
  // Frame times wobble around the display's refresh (timer noise, the host's
  // own work), and stepping the world by the wobble makes steady motion
  // judder. A frame that spanned about a whole number of refreshes is
  // stepped by exactly that, the difference paid back a little each frame
  // so the game's clock still keeps to the real one.
  _pace(rawDt) {
    const r = this.quality?.refresh;
    if (!r || rawDt > 0.1) return rawDt;
    const k = Math.round(rawDt / r);
    if (k < 1 || k > 3 || Math.abs(rawDt - k * r) > r * 0.25) {
      this.paceDebt = 0;
      return rawDt;
    }
    this.paceDebt = (this.paceDebt || 0) + rawDt - k * r;
    const pay = this.paceDebt * 0.1;
    this.paceDebt -= pay;
    return k * r + pay;
  }

  _adaptQuality(rawDt) {
    // A hidden tab, or a floor being built: not a measure of anything.
    if (rawDt > 1 || this.busy || this.compiling) return;
    const q = (this.quality ||= { frames: [], t: 0, refresh: 1 / 60, good: 0, bad: 0, wait: 0, hold: 8 });
    q.frames.push(rawDt);
    q.t += rawDt;
    q.wait -= rawDt;
    if (q.t < 1.5) return;
    const f = q.frames.sort((a, b) => a - b);
    const median = f[f.length >> 1];
    const quick = f[Math.floor(f.length * 0.1)];
    q.refresh = Math.min(1 / 30, Math.max(1 / 240, Math.min(q.refresh * 1.01, quick)));
    q.frames.length = 0;
    q.t = 0;
    const level = this.qualityLevel;
    if (median > Math.max(1 / 45, q.refresh * 1.45)) {
      q.good = 0;
      if (++q.bad >= 2 && level < QUALITY.length - 1) {
        q.bad = 0;
        // Pushed off a rung soon after climbing to it: wait longer before
        // climbing again (8 s, doubling to 2 minutes).
        q.hold = q.wait > 0 ? Math.min(120, q.hold * 2) : 8;
        q.wait = q.hold;
        this._setQuality(level + 1);
      }
    } else if (median < q.refresh * 1.15) {
      q.bad = 0;
      if (++q.good >= 3 && level > 0 && q.wait <= 0) {
        q.good = 0;
        q.wait = 10;
        this._setQuality(level - 1);
      }
    } else {
      q.good = 0;
      q.bad = 0;
    }
    this.slow = this.qualityLevel >= SLOW ? 1 : 0;
    this.level?.dressing?.setMist?.(this.qualityLevel < NO_MIST);
  }

  // The view's width at a rung, as a fraction of the screen's.
  _sceneScaleAt(level) {
    return Math.min(1, QUALITY[level].width / Math.max(1, this.host.width * this.uiRatio));
  }

  // The target the world draws into, multisampled (as far as this machine
  // can for half-float colour) to smooth the edges of everything in it.
  _sceneTargetWith(samples) {
    return new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, samples: Math.min(samples, this.maxSamples) });
  }

  _setQuality(level) {
    this.qualityLevel = level;
    const samples = Math.min(QUALITY[level].samples, this.maxSamples);
    if (samples !== this.sceneTarget.samples) {
      this.sceneTarget.dispose();
      this.sceneTarget = this._sceneTargetWith(samples);
      this.blit.material.uniforms.tScene.value = this.sceneTarget.texture;
    }
    this.sceneScale = this._sceneScaleAt(level);
    this._resize();
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
      // (Brighter while the blade burns: its fire lights the hand.)
      this.viewGlow.intensity = 6 * (0.85 + Math.sin(this.time * 13) * 0.1) * this.player.torchLit * (1 + this.player.bladeFx.heat * 0.8);
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

// The largest multisample count this machine can give the half-float
// target the world draws into (0: none).
function msaaLimit(r) {
  try {
    const gl = r.getContext();
    const counts = gl.getInternalformatParameter?.(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
    return counts?.length ? Math.max(...counts) : 0;
  } catch {
    return 0;
  }
}

// The world, onto the screen: tone-mapped, and (when it was drawn smaller
// than the screen) sharpened back after the stretch, each pixel held within
// its neighbours' range so no edge gets a halo.
function blitMaterial(map) {
  return new THREE.ShaderMaterial({
    uniforms: { tScene: { value: map }, uTexel: { value: new THREE.Vector2(1, 1) }, uSharp: { value: 0 }, uFxaa: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene;
      uniform vec2 uTexel;
      uniform float uSharp;
      uniform float uFxaa;
      varying vec2 vUv;
      float luma(vec3 c) { return dot(c / (1.0 + c), vec3(0.299, 0.587, 0.114)); }
      // FXAA (the console variant): blend across an edge along its direction.
      vec3 fxaa(vec2 uv) {
        vec3 rgbM = texture2D(tScene, uv).rgb;
        float lNW = luma(texture2D(tScene, uv + vec2(-1.0, -1.0) * uTexel).rgb);
        float lNE = luma(texture2D(tScene, uv + vec2(1.0, -1.0) * uTexel).rgb);
        float lSW = luma(texture2D(tScene, uv + vec2(-1.0, 1.0) * uTexel).rgb);
        float lSE = luma(texture2D(tScene, uv + vec2(1.0, 1.0) * uTexel).rgb);
        float lM = luma(rgbM);
        float lo = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
        float hi = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
        if (hi - lo < max(0.0312, hi * 0.125)) return rgbM;
        vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
        float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
        dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uTexel;
        vec3 a = 0.5 * (texture2D(tScene, uv - dir / 6.0).rgb + texture2D(tScene, uv + dir / 6.0).rgb);
        vec3 b = a * 0.5 + 0.25 * (texture2D(tScene, uv - dir * 0.5).rgb + texture2D(tScene, uv + dir * 0.5).rgb);
        float lB = luma(b);
        return (lB < lo || lB > hi) ? a : b;
      }
      void main() {
        vec3 c = uFxaa > 0.5 ? fxaa(vUv) : texture2D(tScene, vUv).rgb;
        if (uSharp > 0.0) {
          vec3 n = texture2D(tScene, vUv + vec2(0.0, uTexel.y)).rgb;
          vec3 s = texture2D(tScene, vUv - vec2(0.0, uTexel.y)).rgb;
          vec3 e = texture2D(tScene, vUv + vec2(uTexel.x, 0.0)).rgb;
          vec3 w = texture2D(tScene, vUv - vec2(uTexel.x, 0.0)).rgb;
          vec3 lo = min(c, min(min(n, s), min(e, w)));
          vec3 hi = max(c, max(max(n, s), max(e, w)));
          c = clamp(c + (c - (n + s + e + w) * 0.25) * uSharp, lo, hi);
        }
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
  });
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
