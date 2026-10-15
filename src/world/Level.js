import * as THREE from 'three';
import { TILE } from './LevelData.js';
import { parseLevel, carveAlcoves, exitFacing } from './levelParser.js';
import { CollisionWorld } from '../physics/CollisionWorld.js';
import { runeCircleTexture } from './Textures.js';
import { lavaMaterial, portalMaterial, gateVeilMaterial, makeFlame } from './Shaders.js';
import { C, spawnFlame } from './Particles.js';
import { mulberry32 } from '../core/rng.js';
import { Assets } from '../assets/AssetLibrary.js';
import { lookFor } from './themes.js';
import { Dressing } from './Dressing.js';
import { Props } from './Props.js';
import { disposeTree } from '../core/dispose.js';

// Builds one cavern floor from its hand-authored map and runs its hazards.
// The scenery is dressed in the floor's look (Dressing.js, themes.js);
// collision and navigation come straight from the parsed tile grid, so what
// you see is what blocks you.

const SPIKE_PERIOD = 2.6;
const VENT_PERIOD = 4.2;
// The exit's hell-gate is drawn a little smaller than the model's size (it
// has to stand in a room).
const GATE_SCALE = 0.85;

export class Level {
  // `light`: fewer dynamic lights, for slow machines and software rendering.
  //
  // Braziers, lava and glowing set pieces are light *sources* (spots); only a
  // small pool of real point lights exists (POOL, plus the torch), and each
  // moment they go to the sources nearest the player, fading in as they are
  // handed over. Every lit pixel pays for every light in the scene, lit or
  // not, so this keeps a floor to four lights however many fires burn in it,
  // and the count never changes (no shader is ever recompiled for it).
  constructor(floorNumber, def, { light = false } = {}) {
    this.maxLights = light ? 2 : 9;
    this.maxBrazierLights = light ? 1 : 6;
    this.poolSize = light ? 1 : 3;
    this.spots = [];
    this.floor = floorNumber;
    this.def = def;
    this.data = parseLevel(def);
    const d = this.data;
    // Every floor gets two or three dead ends for its chests.
    carveAlcoves(d, d.floorTiles.length > 160 ? 3 : 2, mulberry32(floorNumber * 4111));
    this.nav = d.nav;
    this.world = new CollisionWorld({ grid: { cols: d.cols, rows: d.rows, solid: d.solid }, tileSize: TILE });
    this.group = new THREE.Group();
    this.exitOpen = false;
    this.portalT = 0;
    this.time = 0;
    this.depth = (floorNumber - 1) / 19;
    this.rand = mulberry32(floorNumber * 7919);
    this.look = lookFor(def, floorNumber, mulberry32(floorNumber * 7919 + 17));
    this.spikeTiles = d.spikes.map((s) => ({ ...s, phase: ((s.c + s.r) % 4) * 0.3, hitPlayer: false, hitEnemies: new Set(), lastCycle: -1 }));
    this.ventTiles = d.vents.map((v, i) => ({ ...v, phase: (i * 1.37) % VENT_PERIOD, tick: 0 }));
    this.lavaSet = new Set(d.lava.map((l) => l.r * d.cols + l.c));

    this.dressing = new Dressing(this, this.look, { light });
    // Beyond this the fog has swallowed everything (exp2 fog at 3%).
    this.viewRange = Math.sqrt(3.5) / Math.max(0.01, def.fog * (this.look.haze || 1));
    // How far anything can really be seen: past the torch's reach the rock is
    // unlit and the murk all but black, so nothing further is drawn (the
    // scenery's chunks, the demons, the camera's far plane).
    this.sight = Math.min(this.viewRange, def.light * 1.8);
    this.group.add(this.dressing.group);
    // The scenery standing on the floor is solid.
    for (const c of this.dressing.solids) this.world.addStatic(c);
    this._buildProps();
    this._buildHazards();
    this.props = new Props(this);
    this._buildGlowLights();
    this._buildExit();
    this._buildLightPool();
  }

  get spawn() {
    return this.data.spawn;
  }

  // Facing from the spawn toward the open side of the room.
  spawnYaw() {
    const s = this.data.spawn;
    let best = 0;
    let bestOpen = -1;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      let open = 0;
      for (let step = 1; step <= 5; step++) {
        const x = s.x - Math.sin(a) * step * TILE;
        const z = s.z - Math.cos(a) * step * TILE;
        if (this.world.isSolidAt(x, z)) break;
        open++;
      }
      if (open > bestOpen) {
        bestOpen = open;
        best = a;
      }
    }
    return best;
  }

  _buildProps() {
    const d = this.data;
    const iron = new THREE.MeshStandardMaterial({ color: 0x26221f, metalness: 0.8, roughness: 0.5 });
    const coal = new THREE.MeshStandardMaterial({ color: 0x331008, emissive: 0xff4a10, emissiveIntensity: 1.6 });
    this.braziers = [];
    const flame = this.look.flame;
    d.braziers.forEach((b, i) => {
      const generated = this.dressing._place('brazier', b.x, b.z, { yaw: this.rand() * Math.PI * 2 });
      const g = new THREE.Group();
      g.visible = !generated;
      g.position.set(b.x, 0, b.z);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.3, 0.35, 28, 1, true), iron);
      bowl.position.y = 1.15;
      const coals = new THREE.Mesh(new THREE.CircleGeometry(0.5, 28), coal);
      coals.rotation.x = -Math.PI / 2;
      coals.position.y = 1.22;
      g.add(bowl, coals);
      for (let k = 0; k < 3; k++) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.2, 10), iron);
        const a = (k / 3) * Math.PI * 2;
        leg.position.set(Math.cos(a) * 0.3, 0.55, Math.sin(a) * 0.3);
        leg.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
        g.add(leg);
      }
      this.group.add(g);
      const anchor = new THREE.Vector3(b.x, generated ? 1.08 : 1.25, b.z);
      const flame = makeFlame({ height: 1.25, seed: i * 1.7 });
      flame.position.copy(anchor);
      this.group.add(flame);
      this.braziers.push({ pos: anchor, flame });
      if (i < this.maxBrazierLights) this._spot({ color: flame, base: 18, distance: 14, decay: 1.6, x: b.x, y: 2.2, z: b.z, seed: i * 3.1 });
    });
  }

  _buildHazards() {
    const d = this.data;
    // Lava pools: one merged mesh.
    if (d.lava.length) {
      const geos = d.lava.map((l) => {
        const g = new THREE.PlaneGeometry(TILE, TILE);
        g.rotateX(-Math.PI / 2);
        g.translate(l.x, 0.03, l.z);
        return g;
      });
      const merged = mergePlanes(geos);
      this.lavaMat = lavaMaterial();
      this.group.add(new THREE.Mesh(merged, this.lavaMat));
      // A few lights over the largest pools.
      const step = Math.max(1, Math.floor(d.lava.length / 3));
      for (let i = 0; i < d.lava.length && this.spots.length < this.maxLights; i += step) {
        this._spot({ color: 0xff4a10, base: 14, distance: 12, decay: 1.5, x: d.lava[i].x, y: 1.2, z: d.lava[i].z, seed: i });
      }
    }

    // Spike traps: plate + instanced spikes animated per tile.
    if (this.spikeTiles.length) {
      const plateMat = new THREE.MeshStandardMaterial({ color: 0x1c1a19, metalness: 0.6, roughness: 0.6 });
      for (const t of this.spikeTiles) {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.92, 0.06, TILE * 0.92), plateMat);
        plate.position.set(t.x, 0.03, t.z);
        this.group.add(plate);
      }
      const spikeGeo = new THREE.ConeGeometry(0.09, 0.9, 6);
      spikeGeo.translate(0, 0.45, 0);
      const spikeMat = new THREE.MeshStandardMaterial({ color: 0x8a8580, metalness: 0.9, roughness: 0.3 });
      this.spikeMesh = new THREE.InstancedMesh(spikeGeo, spikeMat, this.spikeTiles.length * 9);
      this.spikeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this.spikeMesh);
    }

    // Fire vents: scorched grates that erupt on a cycle.
    if (this.ventTiles.length) {
      const grate = new THREE.MeshStandardMaterial({ color: 0x1a1210, emissive: 0xff3a00, emissiveIntensity: 0.3, roughness: 0.7 });
      for (const v of this.ventTiles) {
        const o = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.12, 28), grate.clone());
        o.position.set(v.x, 0.06, v.z);
        v.mesh = o;
        this.group.add(o);
      }
    }
  }

  // Light from the brightest glowing set pieces (crystals, rune stones), with
  // whatever light budget the braziers and lava left.
  _buildGlowLights() {
    const free = Math.min(this.maxLights - this.spots.length, this.maxLights > 2 ? 3 : 1);
    for (const [i, g] of this.dressing.lightSpots(Math.max(0, free)).entries()) {
      this._spot({ color: this.look.glow, base: 9, distance: 11, decay: 1.6, x: g.x, y: Math.max(1.2, g.y), z: g.z, seed: 10 + i * 2.3, slow: true });
    }
  }

  // A light source; the pool of real lights is shared out among them.
  _spot(o) {
    this.spots.push({ ...o, color: new THREE.Color(o.color), pos: new THREE.Vector3(o.x, o.y, o.z) });
  }

  _buildLightPool() {
    this.pool = [];
    for (let i = 0; i < this.poolSize; i++) {
      const light = new THREE.PointLight(0xff6020, 0, 12, 1.6);
      light.position.set(0, -50, 0);
      this.group.add(light);
      this.pool.push({ light, spot: null, fade: 0 });
    }
  }

  // Give the pool's lights to the sources nearest the player (the open
  // portal counts as one), each fading in as it arrives.
  _updateLightPool(dt, t, player) {
    const p = player.position;
    const exit = this.exitSpot;
    exit.base = 4 + this.portalT * 26 + Math.sin(t * 5) * 2;
    this.poolT = (this.poolT ?? 0) - dt;
    const want = this.poolT > 0 && this.poolWant ? this.poolWant : null;
    if (!want) {
      this.poolT = 0.25;
      const ranked = [...this.spots, exit].map((s) => ({ s, d: (s.pos.x - p.x) ** 2 + (s.pos.z - p.z) ** 2 - (s === exit ? this.portalT * 60 : 0) })).sort((a, b) => a.d - b.d);
      this.poolWant = ranked.slice(0, this.pool.length).map((r) => r.s);
    }
    this._assignPool(this.poolWant);
    for (const L of this.pool) {
      const s = L.spot;
      if (!s) continue;
      L.fade = Math.min(1, L.fade + dt * 3);
      const flicker = s.slow ? 0.8 + Math.sin(t * 1.3 + s.seed) * 0.2 : 0.85 + Math.sin(t * 9 + s.seed) * 0.08 + Math.sin(t * 23 + s.seed * 2) * 0.05;
      L.light.intensity = s.base * (s === exit ? 1 : flicker) * L.fade;
    }
  }

  // Keep lights on sources still wanted; hand the rest over.
  _assignPool(want) {
    const free = this.pool.filter((L) => !want.includes(L.spot));
    for (const s of want) {
      if (this.pool.some((L) => L.spot === s)) continue;
      const L = free.shift();
      if (!L) break;
      L.spot = s;
      L.fade = 0;
      L.light.position.copy(s.pos);
      L.light.color.copy(s.color);
      L.light.distance = s.distance;
      L.light.decay = s.decay;
    }
  }

  // The way out: the hell-gate standing on the exit tile, facing the way you
  // come, a veil of hellfire turning in its arch with embers drawn into it,
  // chained shut until the floor is cleared; walk through it to descend.
  // (Without the gate's model: the old vortex in the floor.)
  _buildExit() {
    const x = this.data.exit;
    const g = new THREE.Group();
    g.position.set(x.x, 0, x.z);
    const runeMat = new THREE.MeshBasicMaterial({ map: runeCircleTexture('#ff3a1a'), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
    const rune = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), runeMat);
    rune.rotation.x = -Math.PI / 2;
    rune.position.y = 0.07;
    this.exitRune = rune;
    const chainMat = new THREE.MeshStandardMaterial({ color: 0x3a1a14, metalness: 0.8, roughness: 0.4, emissive: 0x550800, emissiveIntensity: 1 });
    const chainLine = (from, to) => {
      const line = new THREE.Group();
      const d = to.clone().sub(from);
      const n = Math.round(d.length() / 0.17);
      for (let k = 0; k <= n; k++) {
        const link = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.03, 8, 16), chainMat);
        link.position.copy(from).addScaledVector(d, k / n);
        link.lookAt(link.position.clone().add(d));
        link.rotateZ((k % 2) * (Math.PI / 2));
        line.add(link);
      }
      return line;
    };
    this.seal = new THREE.Group();
    if (Assets.hasProp('gate')) {
      const [fx, fz] = exitFacing(this.data);
      // The model's front (its skulls) is its -X; the arch spans its Z.
      g.rotation.y = Math.atan2(fz, -fx);
      const gate = Assets.instanceProp('gate');
      const mat = this.dressing.mat('gate');
      gate.traverse((o) => {
        if (o.isMesh) o.material = mat;
      });
      gate.scale.multiplyScalar(GATE_SCALE);
      g.add(gate);
      const H = Assets.props.get('gate').entry.size * GATE_SCALE;
      const W = H * 0.42;
      const A = H * 0.58;
      // The veil, shaped to the arch, across the opening.
      const shape = new THREE.Shape();
      shape.moveTo(-W / 2, 0);
      shape.lineTo(W / 2, 0);
      shape.lineTo(W / 2, A - W / 2);
      shape.absarc(0, A - W / 2, W / 2, 0, Math.PI, false);
      shape.lineTo(-W / 2, 0);
      const geo = new THREE.ShapeGeometry(shape, 24);
      const p = geo.attributes.position;
      const uv = [];
      for (let i = 0; i < p.count; i++) uv.push(p.getX(i) / W + 0.5, p.getY(i) / A);
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.rotateY(Math.PI / 2);
      this.portalMat = gateVeilMaterial(W, A);
      const veil = new THREE.Mesh(geo, this.portalMat);
      veil.renderOrder = 3;
      g.add(veil);
      // Chains across the arch while the floor still lives.
      this.seal.add(chainLine(new THREE.Vector3(-0.25, 0.3, -W / 2), new THREE.Vector3(-0.25, A * 0.85, W / 2)));
      this.seal.add(chainLine(new THREE.Vector3(-0.25, 0.3, W / 2), new THREE.Vector3(-0.25, A * 0.85, -W / 2)));
      // The rune circle on the floor before it.
      rune.position.x = -2.2;
      g.add(rune);
      g.updateMatrixWorld(true);
      // Its two piers are solid.
      const side = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion);
      for (const k of [-1, 1]) this.world.addStatic({ x: x.x + side.x * k * (W / 2 + 0.75), z: x.z + side.z * k * (W / 2 + 0.75), r: 0.75 });
      this.gateFx = { o: new THREE.Vector3(x.x, 0, x.z), side, fwd: new THREE.Vector3(fx, 0, fz), w: W, h: A };
      this.exitSpot = { color: new THREE.Color(0xff3010), base: 4, distance: 10, decay: 1.6, pos: new THREE.Vector3(x.x + fx * 0.6, A * 0.5, x.z + fz * 0.6), seed: 0 };
    } else {
      this.portalMat = portalMaterial();
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.25, 72), this.portalMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05;
      g.add(disc, rune);
      for (const rot of [0.6, -0.6]) {
        const line = chainLine(new THREE.Vector3(-1.05, 0.15, 0), new THREE.Vector3(1.05, 0.15, 0));
        line.rotation.y = rot;
        this.seal.add(line);
      }
      this.exitSpot = { color: new THREE.Color(0xff3010), base: 4, distance: 9, decay: 1.6, pos: new THREE.Vector3(x.x, 1.2, x.z), seed: 0 };
    }
    g.add(this.seal);
    this.group.add(g);
    this.exitGroup = g;
  }

  openExit() {
    if (this.exitOpen) return;
    this.exitOpen = true;
    this.seal.visible = false;
  }

  isAtExit(pos) {
    const x = this.data.exit;
    return this.exitOpen && Math.hypot(pos.x - x.x, pos.z - x.z) < 1.2;
  }

  // Lava, spikes and vents hurt the player and enemies alike.
  update(dt, ctx) {
    this.time += dt;
    const t = this.time;
    this.dressing.cull(ctx.player.position.x, ctx.player.position.z, this.sight);
    this.dressing.tick(t);
    this.props.update(dt, ctx);
    if (this.lavaMat) this.lavaMat.uniforms.uTime.value = t;
    this.portalMat.uniforms.uTime.value = t;
    this.portalT = Math.min(1, this.portalT + (this.exitOpen ? dt * 0.8 : 0));
    this.portalMat.uniforms.uOpen.value = this.portalT;
    this.exitRune.rotation.z = t * (0.1 + this.portalT * 0.6);
    this.exitRune.material.opacity = 0.25 + this.portalT * 0.6;
    this._updateLightPool(dt, t, ctx.player);
    const ps = ctx.fx.add;
    for (const b of this.braziers) {
      b.flame.userData.tick(t);
      if (Math.random() < dt * 8) ps.emit({ x: b.pos.x + (Math.random() - 0.5) * 0.4, y: b.pos.y + 0.5, z: b.pos.z + (Math.random() - 0.5) * 0.4, vx: (Math.random() - 0.5) * 0.6, vy: 1.8 + Math.random() * 1.8, vz: (Math.random() - 0.5) * 0.6, life: 1.2 + Math.random(), size: 0.05, sizeEnd: 0.01, color: C.emberHot, colorEnd: C.emberRed, drag: 0.4, turbulence: 2.5 });
    }
    const G = this.gateFx;
    if (G) {
      // Embers drawn round and into the veil's eye (a few while it is sealed,
      // a storm once it opens), drifting out toward you; flames lick up from
      // the threshold once it is open.
      const near = (ctx.player.position.x - G.o.x) ** 2 + (ctx.player.position.z - G.o.z) ** 2 < 900;
      let n = near ? (this.exitOpen ? 55 : 10) * dt : 0;
      while (n > 0 && (n >= 1 || Math.random() < n)) {
        n--;
        const a = Math.random() * Math.PI * 2;
        const r = 0.35 + Math.random() * 0.65;
        const lx = Math.cos(a) * r * G.w * 0.5;
        const ly = G.h * 0.48 + Math.sin(a) * r * G.w * 0.55;
        if (ly < 0.1 || ly > G.h) continue;
        const sp = (this.exitOpen ? 1.8 : 0.6) * (0.6 + Math.random() * 0.6);
        const tx = -Math.sin(a) * sp - Math.cos(a) * sp * 0.4;
        const ty = Math.cos(a) * sp - Math.sin(a) * sp * 0.4;
        const out = (Math.random() - 0.3) * 0.5;
        ps.emit({
          x: G.o.x + G.side.x * lx + G.fwd.x * 0.1,
          y: ly,
          z: G.o.z + G.side.z * lx + G.fwd.z * 0.1,
          vx: G.side.x * tx + G.fwd.x * out,
          vy: ty,
          vz: G.side.z * tx + G.fwd.z * out,
          life: 0.7 + Math.random() * 0.6,
          size: this.exitOpen ? 0.07 : 0.05,
          sizeEnd: 0.01,
          color: C.emberHot,
          colorEnd: C.emberRed,
          drag: 1.2,
        });
      }
      if (this.exitOpen && near && Math.random() < dt * 10) {
        const k = (Math.random() - 0.5) * G.w * 0.8;
        spawnFlame(ps, { x: G.o.x + G.side.x * k, y: 0.05, z: G.o.z + G.side.z * k }, { size: 0.28, rise: 2.2, life: 0.9 });
      }
    } else if (this.exitOpen && Math.random() < dt * 25) {
      const x = this.data.exit;
      const a = Math.random() * 6.28;
      spawnFlame(ps, { x: x.x + Math.cos(a) * Math.random() * 1.1, y: 0.1, z: x.z + Math.sin(a) * Math.random() * 1.1 }, { size: 0.3, rise: 2.5, life: 1 });
    }

    const d = this.data;
    const player = ctx.player;
    const tuning = ctx.tuning;

    // Lava: damage over time, embers rising.
    if (d.lava.length) {
      if (Math.random() < dt * 14) {
        const l = d.lava[Math.floor(Math.random() * d.lava.length)];
        ps.emit({ x: l.x + (Math.random() - 0.5) * 2, y: 0.1, z: l.z + (Math.random() - 0.5) * 2, vy: 1 + Math.random(), life: 2, size: 0.08, color: C.emberHot, colorEnd: C.emberRed, turbulence: 2, drag: 0.3 });
      }
      if (!player.dead && !player.dash && this._onLava(player.position)) {
        player.lavaT -= dt;
        if (player.lavaT <= 0) {
          player.lavaT = 0.25;
          player.takeDamage(6 * tuning.dmg, player.position, 0, ctx);
        }
      }
      for (const e of ctx.enemies) {
        if (e.alive && !e.isBoss && e.state !== 'burrowed' && this._onLava(e.position)) {
          e._lavaT = (e._lavaT ?? 0) - dt;
          if (e._lavaT <= 0) {
            e._lavaT = 0.5;
            e.takeHit(e.maxHealth * 0.06, new THREE.Vector3(), 0, 0, ctx);
          }
        }
      }
    }

    // Spikes.
    if (this.spikeMesh) {
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3(1, 1, 1);
      let i = 0;
      for (const sp of this.spikeTiles) {
        const ct = (t + sp.phase) % SPIKE_PERIOD;
        const cycle = Math.floor((t + sp.phase) / SPIKE_PERIOD);
        let h = -0.9;
        if (ct > 1.4 && ct < 1.9) h = -0.72 + Math.sin(ct * 60) * 0.03;
        else if (ct >= 1.9 && ct < 2.45) h = Math.min(0, -0.72 + (ct - 1.9) * 12);
        else if (ct >= 2.45) h = -((ct - 2.45) / 0.15) * 0.9;
        const lethal = ct >= 1.95 && ct < 2.45;
        if (cycle !== sp.lastCycle) {
          sp.lastCycle = cycle;
          sp.hitPlayer = false;
          sp.hitEnemies.clear();
        }
        for (let k = 0; k < 9; k++) {
          p.set(sp.x + ((k % 3) - 1) * 0.55, h, sp.z + (Math.floor(k / 3) - 1) * 0.55);
          m.compose(p, q, s);
          this.spikeMesh.setMatrixAt(i++, m);
        }
        if (!lethal) continue;
        if (!sp.hitPlayer && this._onTile(player.position, sp, player.radius)) {
          if (player.takeDamage(18 * tuning.dmg, player.position, 0, ctx)) sp.hitPlayer = true;
        }
        for (const e of ctx.enemies) {
          if (e.alive && !e.isBoss && !sp.hitEnemies.has(e) && e.state !== 'burrowed' && this._onTile(e.position, sp, e.radius)) {
            sp.hitEnemies.add(e);
            e.takeHit(30, new THREE.Vector3(), 0, 40, ctx);
            ctx.onDamage?.(e, 30, false, e.position);
          }
        }
      }
      this.spikeMesh.instanceMatrix.needsUpdate = true;
    }

    // Vents.
    for (const v of this.ventTiles) {
      const ct = (t + v.phase) % VENT_PERIOD;
      const warn = ct > 2.6 && ct < 3.2;
      const erupt = ct >= 3.2;
      v.mesh.material.emissiveIntensity = erupt ? 2.5 : warn ? 0.8 + Math.sin(t * 40) * 0.4 : 0.3;
      if (warn && Math.random() < dt * 20) ctx.fx.alpha.emit({ x: v.x + (Math.random() - 0.5), y: 0.2, z: v.z + (Math.random() - 0.5), vy: 1.5, life: 1, size: 0.4, sizeEnd: 0.9, color: C.smoke, colorEnd: C.smoke, alpha: 0.6 });
      if (!erupt) continue;
      for (let k = 0; k < 4; k++) spawnFlame(ps, { x: v.x + (Math.random() - 0.5) * 1.1, y: 0.2, z: v.z + (Math.random() - 0.5) * 1.1 }, { size: 0.7, rise: 7, life: 0.55, spread: 0.3 });
      v.tick -= dt;
      if (v.tick > 0) continue;
      v.tick = 0.3;
      if (Math.hypot(player.position.x - v.x, player.position.z - v.z) < 1.2) player.takeDamage(14 * tuning.dmg, player.position, 2, ctx);
      for (const e of ctx.enemies) {
        if (e.alive && !e.isBoss && e.state !== 'burrowed' && Math.hypot(e.position.x - v.x, e.position.z - v.z) < 1.2) {
          e.takeHit(18, new THREE.Vector3(), 0, 10, ctx);
          ctx.onDamage?.(e, 18, false, e.position);
        }
      }
    }
  }

  _onLava(pos) {
    const c = Math.floor(pos.x / TILE);
    const r = Math.floor(pos.z / TILE);
    return this.lavaSet.has(r * this.data.cols + c);
  }

  _onTile(pos, tile, radius) {
    const half = TILE / 2 - 0.15 + radius * 0.5;
    return Math.abs(pos.x - tile.x) < half && Math.abs(pos.z - tile.z) < half;
  }

  // Frees what the floor made (its scenery's far-view copies too).
  dispose() {
    disposeTree(this.group, this.dressing?.geometries() || []);
  }
}

// Merge simple non-indexed-compatible plane geometries into one.
function mergePlanes(geos) {
  const pos = [];
  const uv = [];
  const idx = [];
  let base = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const u = g.attributes.uv.array;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    for (let i = 0; i < u.length; i++) uv.push(u[i]);
    for (const i of g.index.array) idx.push(i + base);
    base += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}
