import * as THREE from 'three';
import { TILE } from './LevelData.js';
import { parseLevel } from './levelParser.js';
import { CollisionWorld } from '../physics/CollisionWorld.js';
import { rockTextures, emberVeinTexture, runeCircleTexture } from './Textures.js';
import { lavaMaterial, portalMaterial } from './Shaders.js';
import { C, spawnFlame, burst } from './Particles.js';
import { mulberry32 } from '../core/rng.js';
import { Assets } from '../assets/AssetLibrary.js';

// Builds one cavern floor from its hand-authored map and runs its hazards.
// Visuals are instanced where possible; collision and navigation come
// straight from the parsed tile grid, so what you see is what blocks you.

const CEIL = 6.4;
const SPIKE_PERIOD = 2.6;
const VENT_PERIOD = 4.2;

function boulderGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  const r = mulberry32(seed);
  const bumps = Array.from({ length: 6 }, () => new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize());
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    let d = 1;
    for (const b of bumps) d += Math.max(0, n.dot(b)) ** 3 * 0.25 - 0.06;
    // Hash per position so shared vertices of the same corner move together.
    const h = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed) * 43758.5453;
    d += (h - Math.floor(h) - 0.5) * 0.12;
    v.copy(n).multiplyScalar(d);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export class Level {
  // `light`: fewer dynamic lights, for slow machines and software rendering.
  constructor(floorNumber, def, { light = false } = {}) {
    this.maxLights = light ? 2 : 7;
    this.maxBrazierLights = light ? 1 : 4;
    this.floor = floorNumber;
    this.def = def;
    this.data = parseLevel(def);
    const d = this.data;
    this.nav = d.nav;
    this.world = new CollisionWorld({ grid: { cols: d.cols, rows: d.rows, solid: d.solid }, tileSize: TILE });
    this.group = new THREE.Group();
    this.lights = [];
    this.exitOpen = false;
    this.portalT = 0;
    this.time = 0;
    this.depth = (floorNumber - 1) / 19;
    this.rand = mulberry32(floorNumber * 7919);
    this.spikeTiles = d.spikes.map((s) => ({ ...s, phase: ((s.c + s.r) % 4) * 0.3, hitPlayer: false, hitEnemies: new Set(), lastCycle: -1 }));
    this.ventTiles = d.vents.map((v, i) => ({ ...v, phase: (i * 1.37) % VENT_PERIOD, tick: 0 }));
    this.lavaSet = new Set(d.lava.map((l) => l.r * d.cols + l.c));

    this._buildRock();
    this._buildProps();
    this._buildHazards();
    this._buildExit();
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

  _rockMaterial(seed, darker = 1) {
    const deep = this.depth;
    const tint = [Math.round(62 + deep * 25), Math.round(52 - deep * 18), Math.round(48 - deep * 18)];
    const { map, bump } = rockTextures(seed, tint);
    return new THREE.MeshStandardMaterial({
      map,
      bumpMap: bump,
      bumpScale: 3,
      roughness: 0.95,
      color: new THREE.Color(darker, darker, darker),
      emissive: deep > 0.45 ? 0xffffff : 0x000000,
      emissiveMap: deep > 0.45 ? emberVeinTexture(17, [255, 60, 10], 18) : null,
      emissiveIntensity: deep > 0.45 ? (deep - 0.45) * 1.6 : 0,
    });
  }

  _buildRock() {
    const d = this.data;
    const W = d.cols * TILE;
    const H = d.rows * TILE;
    const r = this.rand;

    const floorMat = this._rockMaterial(3);
    floorMat.map = floorMat.map.clone();
    floorMat.map.repeat.set(W / 7, H / 7);
    floorMat.map.needsUpdate = true;
    floorMat.bumpMap = floorMat.bumpMap.clone();
    floorMat.bumpMap.repeat.set(W / 7, H / 7);
    floorMat.bumpMap.needsUpdate = true;
    if (floorMat.emissiveMap) {
      floorMat.emissiveMap = floorMat.emissiveMap.clone();
      floorMat.emissiveMap.repeat.set(W / 9, H / 9);
      floorMat.emissiveMap.needsUpdate = true;
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, H / 2);
    this.group.add(floor);

    const ceilMat = this._rockMaterial(5, 0.45);
    ceilMat.emissiveIntensity *= 0.3;
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, H), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(W / 2, CEIL, H / 2);
    this.group.add(ceil);

    // Boulder walls along every solid tile that borders open ground.
    const edge = [];
    for (let row = 0; row < d.rows; row++) {
      for (let c = 0; c < d.cols; c++) {
        const ch = d.tiles[row][c];
        if (ch !== '#') continue;
        let borders = false;
        for (let dr = -1; dr <= 1 && !borders; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (d.nav.isWalkable(c + dc, row + dr)) {
              borders = true;
              break;
            }
          }
        }
        if (borders) edge.push({ c, r: row });
      }
    }
    const wallMat = this._rockMaterial(1, 0.9);
    for (const k of ['map', 'bumpMap', 'emissiveMap']) {
      if (!wallMat[k]) continue;
      wallMat[k] = wallMat[k].clone();
      wallMat[k].repeat.set(3, 3);
      wallMat[k].needsUpdate = true;
    }
    // A generated cave rock replaces the stand-in boulders when present.
    let wallGeoMat = wallMat;
    let geos = [boulderGeometry(1), boulderGeometry(2), boulderGeometry(3)];
    const rock = Assets.propGeometry('rock');
    if (rock) {
      const g = rock.geometry.clone();
      g.computeBoundingBox();
      g.center();
      const sz = g.boundingBox.getSize(new THREE.Vector3());
      g.scale(2 / sz.x, 2 / sz.y, 2 / sz.z);
      geos = [g];
      wallGeoMat = rock.material;
    }
    const buckets = geos.map(() => []);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const t of edge) {
      const cx = (t.c + 0.5) * TILE;
      const cz = (t.r + 0.5) * TILE;
      for (let layer = 0; layer < 3; layer++) {
        p.set(cx + (r() - 0.5) * 0.4, layer === 0 ? 1.1 : layer === 1 ? 3.3 : 5.6, cz + (r() - 0.5) * 0.4);
        e.set((r() - 0.5) * 0.5, r() * Math.PI * 2, (r() - 0.5) * 0.5);
        q.setFromEuler(e);
        const w = 1.3 + r() * 0.35;
        s.set(w, 1.5 + r() * 0.6, w * (0.9 + r() * 0.2));
        m.compose(p, q, s);
        buckets[Math.floor(r() * geos.length)].push(m.clone());
      }
    }
    geos.forEach((g, i) => {
      const inst = new THREE.InstancedMesh(g, wallGeoMat, buckets[i].length);
      buckets[i].forEach((mm, k) => inst.setMatrixAt(k, mm));
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
    });

    // Stalactites and floor debris.
    const stal = [];
    const debris = [];
    for (const t of d.floorTiles) {
      if (r() < 0.22) {
        p.set(t.x + (r() - 0.5) * 1.6, CEIL - 0.1, t.z + (r() - 0.5) * 1.6);
        q.setFromEuler(e.set(0, r() * 6, 0));
        const k = 0.15 + r() * 0.25;
        s.set(k, 0.6 + r() * 1.8, k);
        stal.push(m.compose(p, q, s).clone());
      }
      if (r() < 0.35 && !this.lavaSet.has(t.r * d.cols + t.c)) {
        p.set(t.x + (r() - 0.5) * 1.7, 0.02, t.z + (r() - 0.5) * 1.7);
        q.setFromEuler(e.set(r() * 3, r() * 6, r() * 3));
        const k = 0.06 + r() * 0.16;
        s.set(k, k * 0.7, k);
        debris.push(m.compose(p, q, s).clone());
      }
    }
    // Base flush with the ceiling, point hanging down.
    const stalGeo = new THREE.ConeGeometry(1, 1, 6);
    stalGeo.rotateX(Math.PI);
    stalGeo.translate(0, -0.5, 0);
    const stalMesh = new THREE.InstancedMesh(stalGeo, wallMat, stal.length);
    stal.forEach((mm, k) => stalMesh.setMatrixAt(k, mm));
    const debrisMesh = new THREE.InstancedMesh(geos[0], wallGeoMat, debris.length);
    debris.forEach((mm, k) => debrisMesh.setMatrixAt(k, mm));
    this.group.add(stalMesh, debrisMesh);

    // Pillars.
    const pillarGeo = new THREE.CylinderGeometry(0.85, 1.1, CEIL, 9, 8);
    const pp = pillarGeo.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const y = pp.getY(i);
      const k = 1 + Math.sin(y * 3.1 + i) * 0.06 + Math.sin(y * 1.3) * 0.08;
      pp.setX(i, pp.getX(i) * k);
      pp.setZ(i, pp.getZ(i) * k);
    }
    pillarGeo.computeVertexNormals();
    for (const pl of d.pillars) {
      const o = Assets.instanceProp('pillar') || new THREE.Mesh(pillarGeo, wallMat);
      o.position.set(pl.x, o.isMesh ? CEIL / 2 : 0, pl.z);
      o.rotation.y = r() * 6;
      this.group.add(o);
    }

    // Skull piles, only when a generated model exists.
    if (Assets.hasProp('skulls')) {
      for (const t of d.floorTiles) {
        if (r() > 0.05 || this.lavaSet.has(t.r * d.cols + t.c)) continue;
        const o = Assets.instanceProp('skulls');
        o.position.set(t.x + (r() - 0.5) * 1.2, 0, t.z + (r() - 0.5) * 1.2);
        o.rotation.y = r() * 6;
        this.group.add(o);
      }
    }
  }

  _buildProps() {
    const d = this.data;
    const iron = new THREE.MeshStandardMaterial({ color: 0x26221f, metalness: 0.8, roughness: 0.5 });
    const coal = new THREE.MeshStandardMaterial({ color: 0x331008, emissive: 0xff4a10, emissiveIntensity: 1.6 });
    this.braziers = [];
    d.braziers.forEach((b, i) => {
      const generated = Assets.instanceProp('brazier');
      if (generated) {
        generated.position.set(b.x, 0, b.z);
        this.group.add(generated);
      }
      const g = new THREE.Group();
      g.visible = !generated;
      g.position.set(b.x, 0, b.z);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.3, 0.35, 12, 1, true), iron);
      bowl.position.y = 1.15;
      const coals = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), coal);
      coals.rotation.x = -Math.PI / 2;
      coals.position.y = 1.22;
      g.add(bowl, coals);
      for (let k = 0; k < 3; k++) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.2, 6), iron);
        const a = (k / 3) * Math.PI * 2;
        leg.position.set(Math.cos(a) * 0.3, 0.55, Math.sin(a) * 0.3);
        leg.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
        g.add(leg);
      }
      this.group.add(g);
      const anchor = new THREE.Vector3(b.x, 1.3, b.z);
      this.braziers.push({ pos: anchor });
      if (i < this.maxBrazierLights) {
        const l = new THREE.PointLight(0xff6a20, 18, 14, 1.6);
        l.position.set(b.x, 2.2, b.z);
        this.group.add(l);
        this.lights.push({ light: l, base: 18, seed: i * 3.1 });
      }
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
      for (let i = 0; i < d.lava.length && this.lights.length < this.maxLights; i += step) {
        const l = new THREE.PointLight(0xff4a10, 14, 12, 1.5);
        l.position.set(d.lava[i].x, 1.2, d.lava[i].z);
        this.group.add(l);
        this.lights.push({ light: l, base: 14, seed: i });
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
        const o = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.12, 10), grate.clone());
        o.position.set(v.x, 0.06, v.z);
        v.mesh = o;
        this.group.add(o);
      }
    }
  }

  _buildExit() {
    const x = this.data.exit;
    const g = new THREE.Group();
    g.position.set(x.x, 0, x.z);
    this.portalMat = portalMaterial();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.25, 40), this.portalMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.05;
    g.add(disc);
    const runeMat = new THREE.MeshBasicMaterial({ map: runeCircleTexture('#ff3a1a'), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
    const rune = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), runeMat);
    rune.rotation.x = -Math.PI / 2;
    rune.position.y = 0.07;
    g.add(rune);
    const rockMat = this._rockMaterial(7, 0.7);
    const r = mulberry32(99);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9 + r() * 0.9, 5), rockMat);
      s.position.set(Math.cos(a) * 1.55, 0.35, Math.sin(a) * 1.55);
      s.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4);
      g.add(s);
    }
    // Chains of the seal across the portal while the floor still lives.
    const chainMat = new THREE.MeshStandardMaterial({ color: 0x3a1a14, metalness: 0.8, roughness: 0.4, emissive: 0x550800, emissiveIntensity: 1 });
    this.seal = new THREE.Group();
    for (const rot of [0.6, -0.6]) {
      const line = new THREE.Group();
      line.rotation.y = rot;
      for (let k = -6; k <= 6; k++) {
        const link = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.03, 5, 10), chainMat);
        link.position.set(k * 0.17, 0.15, 0);
        link.rotation.set(0, Math.PI / 2, (k % 2) * (Math.PI / 2));
        line.add(link);
      }
      this.seal.add(line);
    }
    g.add(this.seal);
    this.exitLight = new THREE.PointLight(0xff3010, 4, 9, 1.6);
    this.exitLight.position.y = 1.2;
    g.add(this.exitLight);
    this.exitRune = rune;
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
    if (this.lavaMat) this.lavaMat.uniforms.uTime.value = t;
    this.portalMat.uniforms.uTime.value = t;
    this.portalT = Math.min(1, this.portalT + (this.exitOpen ? dt * 0.8 : 0));
    this.portalMat.uniforms.uOpen.value = this.portalT;
    this.exitRune.rotation.z = t * (0.1 + this.portalT * 0.6);
    this.exitRune.material.opacity = 0.25 + this.portalT * 0.6;
    this.exitLight.intensity = 4 + this.portalT * 26 + Math.sin(t * 5) * 2;
    for (const l of this.lights) {
      l.light.intensity = l.base * (0.85 + Math.sin(t * 9 + l.seed) * 0.08 + Math.sin(t * 23 + l.seed * 2) * 0.05);
    }
    const ps = ctx.fx.add;
    for (const b of this.braziers) {
      if (Math.random() < dt * 30) spawnFlame(ps, b.pos, { size: 0.55, rise: 2, spread: 0.5, life: 0.8 });
    }
    if (this.exitOpen && Math.random() < dt * 25) {
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
      if (!player.dead && player.dodgeT <= 0 && !player.dash && this._onLava(player.position)) {
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

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
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
