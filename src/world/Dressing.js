import * as THREE from 'three';
import { TILE } from './LevelData.js';
import { Assets } from '../assets/AssetLibrary.js';
import { rockTextures, emberVeinTexture, softDotTexture } from './Textures.js';
import { mulberry32 } from '../core/rng.js';
import { exitFacing } from './levelParser.js';

// Dresses a cavern floor in its look (themes.js): the rock shell (floor,
// ceiling, walls of generated boulders), stalactites and rubble, set pieces on
// the map's pillar tiles, and props along the walls, from the ceiling and
// across the floor. Everything repeated is instanced, one draw per model per
// 12 m chunk of the map, so the renderer can skip what is behind you, and
// chunks lost in the fog are hidden altogether (`cull`). Scenery stands
// against the walls of the rooms, never in a passage or the open middle of
// the floor, and what stands on the floor is solid (`solids`, circles in the
// floor's collision world): you walk round it, not through it.

const CHUNK = 6 * TILE;
// Wall rock beyond this far (m) is drawn from a coarse copy of the model.
const LOD_NEAR = 14;

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// Iron props keep some metal; everything else is matte rock, bone and wood.
const METAL = {};
// Props whose bright parts glow in the floor's glow colour (a brazier's coals
// in its flame colour), and how strongly.
const GLOW = { crystal: 1.25, fungus: 1.2, eggs: 1.1, obelisk: 1.4, brazier: 1.2, obsidian: 1.1, idol: 1.3, pyre: 1.4 };
// Footprint radius of each prop, as a fraction of its size: nothing is
// placed inside another's footprint (see free/claim).
const FOOT = { skulls: 0.7, ribcage: 0.42, remains: 0.5, stakes: 0.42, altar: 0.55, statue: 0.28, obelisk: 0.25, crystal: 0.42, fungus: 0.45, eggs: 0.5, stalagmite: 0.35, cage: 0.3, chains: 0.15, idol: 0.38, anvil: 0.45, spikewall: 0.45, pyre: 0.45, obsidian: 0.4, basalt: 0.35 };
// Rock-like props take the full rock tint; the rest a softer one.
// Decor a blow breaks (Props._fragile): bones, skulls, stakes, eggs, fungus,
// crystals, pyres and statues. Rock, iron and altars stand.
const FRAGILE = new Set(['skulls', 'ribcage', 'remains', 'stakes', 'eggs', 'fungus', 'crystal', 'pyre', 'statue']);
// Props with a front: they are turned to face the open ground.
const FACED = new Set(['statue', 'altar', 'throne', 'idol', 'gravestone', 'obelisk']);
// Models whose front is not their +Z: the turn that brings it round.
const FRONT = { statue: Math.PI / 2, altar: Math.PI / 2 };

// A prop's footprint where it can be walked into (below head height): its
// half-widths across its own x and z, in metres at scale 1, measured off its
// mesh once.
const SHAPES = new Map();
function footprint(id) {
  if (SHAPES.has(id)) return SHAPES.get(id);
  const g = Assets.propGeometry(id)?.geometry;
  let hx = 0;
  let hz = 0;
  if (g) {
    const pos = g.attributes.position;
    let top = 0;
    for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > Math.min(2.2, top * 0.9)) continue;
      hx = Math.max(hx, Math.abs(pos.getX(i)));
      hz = Math.max(hz, Math.abs(pos.getZ(i)));
    }
  }
  const out = { x: hx, z: hz };
  SHAPES.set(id, out);
  return out;
}
const ROCKY = new Set(['rock', 'slab', 'stalagmite', 'pillar', 'obsidian', 'basalt']);

// A generated model's material made to sit in the cave: its painted colour
// tinted, no metal/roughness texture (the models' are glossy for a lit studio,
// not a torchlit cave), and the bright parts of its albedo glowing if asked.
export function sceneryMaterial(base, { tint = [1, 1, 1], glow = null, strength = 1.4 } = {}) {
  // Lambert: the same matte look as a rough standard material, at a fraction
  // of the cost per pixel (there is nothing in a cave to reflect).
  const m = new THREE.MeshLambertMaterial({
    map: base.map || null,
    normalMap: base.normalMap || null,
    color: base.color.clone().multiply(new THREE.Color(tint[0], tint[1], tint[2])),
    side: base.side,
    transparent: base.transparent,
    alphaTest: base.alphaTest,
  });
  if (base.normalMap) m.normalScale.copy(base.normalScale);
  if (glow !== null) {
    m.emissive = new THREE.Color(glow);
    m.emissiveMap = m.map;
    m.emissiveIntensity = strength;
  }
  m.name = base.name;
  return m;
}

// A boulder for the stand-in walls when no rock model was generated.
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
    const h = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed) * 43758.5453;
    d += (h - Math.floor(h) - 0.5) * 0.12;
    v.copy(n).multiplyScalar(d);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// A generated rock as a 2 x 2 x 2 block centred on the origin.
function unitRock(id) {
  const src = Assets.propGeometry(id);
  if (!src) return null;
  const g = src.geometry.clone();
  g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  const sz = g.boundingBox.getSize(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.scale(2 / sz.x, 2 / sz.y, 2 / sz.z);
  return { geometry: g, material: src.material };
}

function pickWeighted(r, list) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let roll = r() * total;
  for (const x of list) {
    roll -= x.weight;
    if (roll <= 0) return x;
  }
  return list[list.length - 1];
}

export class Dressing {
  // `light`: a sparser dressing for slow machines.
  constructor(level, look, { light = false } = {}) {
    this.level = level;
    this.look = light ? { ...look, density: look.density * 0.5, hang: look.hang * 0.5, rubble: look.rubble * 0.4 } : look;
    look = this.look;
    this.group = new THREE.Group();
    this.chunks = new Map();
    this.r = mulberry32(level.floor * 104729 + 7);
    this.mats = new Map();
    this.glows = [];
    this.d = level.data;
    this.ceiling = look.ceiling;
    this.taken = [];
    this.hung = [];
    this.solids = [];
    this.fragile = [];
    this._findEdges();
    for (const b of this.d.braziers) this.claim(b.x, b.z, 1.1);
    // The secret's niche and the ground before it are left bare.
    if (this.d.secret) this.claim(this.d.secret.x, this.d.secret.z, 1.6);
    this._shell();
    this._hanging();
    this._rubble();
    this._pillars();
    this._exitGate();
    this._throne();
    this._decor();
    this._glowSprites();
    this._mist();
  }

  // Room on the floor: is a circle of radius r at (x, z) clear of everything
  // placed so far? `claim` reserves it.
  free(x, z, r, list = this.taken) {
    return list.every((o) => (o.x - x) ** 2 + (o.z - z) ** 2 >= (o.r + r) ** 2);
  }

  claim(x, z, r, list = this.taken) {
    list.push({ x, z, r });
  }

  foot(id, scale = 1) {
    return Assets.props.get(id).entry.size * scale * (FOOT[id] ?? 0.32);
  }

  // How far a prop reaches from where it stands (its measured footprint, or
  // the rule of thumb where it has none).
  reach(id, scale = 1) {
    const f = footprint(id);
    return Math.max(this.foot(id, scale), Math.max(f.x, f.z) * scale * 0.9);
  }

  // What stops you walking into a prop: one circle for a roundish one; for a
  // long one (a row of stakes, a ribcage, a spiked wall) a chain of circles
  // along its length, as thick as it is.
  solidsFor(id, x, z, yaw, scale) {
    const f = footprint(id);
    const hx = f.x * scale;
    const hz = f.z * scale;
    const long = Math.max(hx, hz);
    const thick = Math.min(hx, hz);
    if (!long || long < thick * 1.4) return [{ x, z, r: Math.max(this.foot(id, scale) * 0.85, long * 0.92) }];
    const r = Math.max(0.3, thick * 0.95);
    const [ax, az] = hz >= hx ? [Math.sin(yaw), Math.cos(yaw)] : [Math.cos(yaw), -Math.sin(yaw)];
    const span = Math.max(0, long - r * 0.8);
    const n = Math.max(1, Math.ceil(span / (r * 0.9)));
    const out = [];
    for (let i = -n; i <= n; i++) {
      const t = (i / n) * span;
      out.push({ x: x + ax * t, z: z + az * t, r });
    }
    return out;
  }

  // Themed material for a prop, made once per floor.
  mat(id) {
    if (this.mats.has(id)) return this.mats.get(id);
    const src = Assets.propGeometry(id);
    if (!src) return null;
    const L = this.look;
    const soft = L.rock.map((v) => 0.45 + v * 0.75);
    const m = sceneryMaterial(src.material, {
      tint: ROCKY.has(id) ? L.rock : soft,
      metal: METAL[id] || 0,
      glow: GLOW[id] ? (id === 'brazier' ? L.flame : L.glow) : null,
      strength: GLOW[id] || 0,
    });
    this.mats.set(id, m);
    return m;
  }

  // Wall tiles that face open ground, and the open tiles along the walls
  // (with the direction of the wall), which is where props go.
  _findEdges() {
    const d = this.d;
    const nav = d.nav;
    this.wallTiles = [];
    for (let row = 0; row < d.rows; row++) {
      for (let c = 0; c < d.cols; c++) {
        if (d.tiles[row][c] !== '#') continue;
        let borders = false;
        for (let dr = -1; dr <= 1 && !borders; dr++) for (let dc = -1; dc <= 1; dc++) if (nav.isWalkable(c + dc, row + dr)) borders = true;
        if (borders) this.wallTiles.push({ c, r: row });
      }
    }
    // Keep the spawn, the exit and the hazards clear.
    const keep = [d.spawn, d.exit, ...(d.boss ? [d.boss] : [])].filter(Boolean);
    const hazard = new Set([...d.lava, ...d.spikes, ...d.vents].map((t) => t.r * d.cols + t.c));
    this.clear = (x, z, rad = 2.6 * TILE) => keep.every((k) => Math.hypot(k.x - x, k.z - z) > rad);
    this.slots = [];
    this.openTiles = [];
    // Room enough round a tile for something to stand by its wall: a passage
    // (two wide or less) is left clear.
    const roomy = (t) => {
      let n = 0;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) if (nav.isWalkable(t.c + dc, t.r + dr)) n++;
      return n >= 13;
    };
    for (const t of d.floorTiles) {
      if (hazard.has(t.r * d.cols + t.c)) continue;
      this.openTiles.push(t);
      if (!roomy(t)) continue;
      for (const [dc, dr] of DIRS) {
        const ch = d.tiles[t.r + dr]?.[t.c + dc];
        if (ch === '#') this.slots.push({ t, dx: dc, dz: dr });
      }
    }
  }

  _shell() {
    const d = this.d;
    const L = this.look;
    const r = this.r;
    const W = d.cols * TILE;
    const H = d.rows * TILE;
    const floorTex = rockTextures(3 + (this.level.floor % 4), L.ground);
    // Lambert, like the scenery: matte rock lit per pixel for less.
    // (A touch brighter: no sheen of its own any more.)
    const floorMat = new THREE.MeshLambertMaterial({ map: floorTex.map.clone(), bumpMap: floorTex.bump.clone(), bumpScale: 3, color: 0xffffff });
    floorMat.color.multiplyScalar(1.18);
    floorMat.map.repeat.set(W / 7, H / 7);
    floorMat.bumpMap.repeat.set(W / 7, H / 7);
    floorMat.map.needsUpdate = floorMat.bumpMap.needsUpdate = true;
    if (L.veins) {
      floorMat.emissive = new THREE.Color(0xffffff);
      floorMat.emissiveMap = emberVeinTexture(17, L.veins.slice(0, 3), 18).clone();
      floorMat.emissiveMap.repeat.set(W / 9, H / 9);
      floorMat.emissiveMap.needsUpdate = true;
      floorMat.emissiveIntensity = L.veins[3];
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, H / 2);

    const ceilTex = rockTextures(5, L.ground.map((v) => Math.round(v * 0.5)));
    const ceilMat = new THREE.MeshLambertMaterial({ map: ceilTex.map, bumpMap: ceilTex.bump, bumpScale: 3 });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, H), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(W / 2, this.ceiling, H / 2);
    this.group.add(floor, ceil);
    this.ceilMesh = ceil;

    // Walls: generated boulders and slabs stacked up to the ceiling along
    // every wall tile that faces open ground.
    const shapes = [];
    for (const [id, weight] of Object.entries(L.walls)) {
      const u = unitRock(id);
      if (!u || weight <= 0) continue;
      // The walls fill most of the screen: no normal map, the painted
      // texture carries their relief; darker than loose rocks, so a wall
      // right in the torchlight doesn't burn out.
      const material = this.mat(id).clone();
      material.normalMap = null;
      material.color.multiplyScalar(0.62);
      shapes.push({ id, weight, ...u, lod: clusterLod(u.geometry, 4), material, list: [] });
    }
    if (!shapes.length) {
      const fallback = rockTextures(1, L.ground);
      const material = new THREE.MeshStandardMaterial({ map: fallback.map, bumpMap: fallback.bump, bumpScale: 3, roughness: 0.95 });
      for (const s of [1, 2, 3]) shapes.push({ id: `boulder${s}`, weight: 1, geometry: boulderGeometry(s), material, list: [] });
    }
    this.rockShape = shapes[0];
    const layers = Math.max(3, Math.ceil((this.ceiling - 0.2) / 2.2));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const t of this.wallTiles) {
      // Set back into the rock, away from the open ground beside it, so the
      // boulders bulge into the room no further than you can walk.
      let bx = 0;
      let bz = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (this.d.nav.isWalkable(t.c + dc, t.r + dr)) {
            bx -= dc;
            bz -= dr;
          }
        }
      }
      const bl = Math.hypot(bx, bz) || 1;
      const cx = (t.c + 0.5) * TILE + (bx / bl) * 0.35;
      const cz = (t.r + 0.5) * TILE + (bz / bl) * 0.35;
      for (let layer = 0; layer < layers; layer++) {
        // Above head height, fewer and bigger rocks close the wall.
        const high = layer >= 2;
        if (high && (layer + t.c + t.r) % 2 && r() < 0.7) continue;
        const shape = pickWeighted(r, shapes);
        const slab = shape.id === 'slab';
        p.set(cx + (r() - 0.5) * 0.5, 1.1 + layer * 2.2 + (r() - 0.5) * 0.3, cz + (r() - 0.5) * 0.5);
        e.set((r() - 0.5) * (slab ? 0.25 : 0.5), r() * Math.PI * 2, (r() - 0.5) * (slab ? 0.25 : 0.5));
        q.setFromEuler(e);
        const k = high ? 1.35 : 1;
        const w = ((slab ? 1.15 : 1.3) + r() * 0.4) * k;
        s.set(w, ((slab ? 1.7 : 1.5) + r() * 0.6) * k, w * (0.85 + r() * 0.25));
        shape.list.push(m.compose(p, q, s).clone());
      }
    }
    for (const sh of shapes) this._instances(sh.geometry, sh.material, sh.list, sh.lod);
  }

  // The group for the chunk of the map around (x, z).
  _chunk(x, z) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const key = `${cx},${cz}`;
    let c = this.chunks.get(key);
    if (!c) {
      const group = new THREE.Group();
      this.group.add(group);
      c = { group, x: (cx + 0.5) * CHUNK, z: (cz + 0.5) * CHUNK, lods: [], far: false };
      this.chunks.set(key, c);
    }
    return c.group;
  }

  // One instanced mesh per chunk for a list of placements, switching to a
  // coarse copy of the model (`lod`, made here if not given) when its chunk
  // is far away.
  _instances(geometry, material, list, lod = undefined) {
    if (!list.length || !geometry || !material) return;
    if (lod === undefined) lod = this._lodOf(geometry);
    const byChunk = new Map();
    for (const mm of list) {
      const key = `${Math.floor(mm.elements[12] / CHUNK)},${Math.floor(mm.elements[14] / CHUNK)}`;
      this._chunk(mm.elements[12], mm.elements[14]);
      if (!byChunk.has(key)) byChunk.set(key, []);
      byChunk.get(key).push(mm);
    }
    for (const [key, part] of byChunk) {
      const c = this.chunks.get(key);
      const inst = new THREE.InstancedMesh(geometry, material, part.length);
      part.forEach((mm, k) => {
        inst.setMatrixAt(k, mm);
        // Where it went, for a piece that can be broken out of the batch.
        mm.inst = inst;
        mm.index = k;
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      c.group.add(inst);
      if (lod) c.lods.push({ inst, hi: geometry, lo: lod });
    }
  }

  _lodOf(geometry) {
    const tris = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    if (tris < 280) return null;
    this.lodCache ||= new Map();
    if (!this.lodCache.has(geometry)) this.lodCache.set(geometry, clusterLod(geometry, tris > 1500 ? 6 : 4));
    return this.lodCache.get(geometry);
  }

  // Every geometry the dressing made, drawn now or not (the far-view copies).
  geometries() {
    const out = [...(this.lodCache?.values() || [])];
    for (const c of this.chunks.values()) for (const l of c.lods) out.push(l.hi, l.lo);
    return out;
  }

  // Hide the chunks the fog has swallowed (`range` metres from the viewer),
  // and draw the far ones' walls coarse.
  cull(x, z, range) {
    const r2 = (range + CHUNK * 0.75) ** 2;
    // (`lodNear`: a floor can see further in full detail, the lit arena.)
    const near2 = ((this.lodNear ?? LOD_NEAR) + CHUNK * 0.7) ** 2;
    for (const c of this.chunks.values()) {
      const d2 = (c.x - x) ** 2 + (c.z - z) ** 2;
      c.group.visible = d2 < r2;
      const far = d2 > near2;
      if (far === c.far) continue;
      c.far = far;
      for (const l of c.lods) l.inst.geometry = far ? l.lo : l.hi;
    }
  }

  // The ground mist, off on slow machines.
  setMist(on) {
    for (const m of this.mistMeshes || []) m.visible = on;
  }

  // Stalactites: the generated stalagmite turned upside down.
  _hanging() {
    const r = this.r;
    const src = Assets.propGeometry('stalagmite');
    let geometry;
    let material;
    let size;
    if (src) {
      geometry = src.geometry.clone().rotateX(Math.PI);
      material = this.mat('stalagmite').clone();
      material.color.multiplyScalar(0.75);
      size = Assets.props.get('stalagmite').entry.size;
    } else {
      geometry = new THREE.ConeGeometry(1, 1, 10).rotateX(Math.PI).translate(0, -0.5, 0);
      material = this.rockShape.material;
      size = 1;
    }
    const list = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const room = this.ceiling - 3.2;
    for (const t of this.d.floorTiles) {
      if (r() > this.look.hang) continue;
      // Long fangs from the vault: 1.5 to 5 m.
      const k = Math.min((0.6 + r() * 1.5) * (src ? 1 : 1.8), room / size);
      p.set(t.x + (r() - 0.5) * 1.6, this.ceiling + 0.05, t.z + (r() - 0.5) * 1.6);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, r() * Math.PI * 2);
      s.set(k * (0.8 + r() * 0.4), k, k * (0.8 + r() * 0.4));
      if (!src) s.set(0.15 + r() * 0.25, k, 0.15 + r() * 0.25);
      list.push(m.compose(p, q, s).clone());
    }
    this._instances(geometry, material, list);
  }

  // Loose stones over the floor.
  _rubble() {
    const r = this.r;
    const list = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const t of this.openTiles) {
      if (r() > this.look.rubble) continue;
      p.set(t.x + (r() - 0.5) * 1.8, 0.02, t.z + (r() - 0.5) * 1.8);
      q.setFromEuler(e.set(r() * 3, r() * 6, r() * 3));
      const k = 0.06 + r() * 0.14;
      s.set(k, k * 0.6, k);
      list.push(m.compose(p, q, s).clone());
    }
    // Pebbles: the coarse rock is plenty, near or far.
    const pebble = this.rockShape.lod || this.rockShape.geometry;
    this._instances(pebble, this.rockShape.material, list, null);
  }

  // A prop placed whole (cloned, themed), or null when it was not generated.
  _place(id, x, z, { scale = 1, yaw = 0, y = 0, stretchY = 1 } = {}) {
    const o = Assets.instanceProp(id);
    if (!o) return null;
    const material = this.mat(id);
    o.traverse((c) => {
      if (c.isMesh) c.material = material;
    });
    o.position.set(x, y, z);
    o.rotation.y = yaw;
    o.scale.multiplyScalar(scale);
    o.scale.y *= stretchY;
    this._chunk(x, z).add(o);
    if (GLOW[id] && id !== 'brazier') this.glows.push({ x, y: y + Assets.props.get(id).entry.size * scale * 0.5, z, size: Assets.props.get(id).entry.size * scale });
    return o;
  }

  // The way from (x, z) with the most open ground in front of it.
  _openYaw(x, z) {
    const nav = this.d.nav;
    let best = 0;
    let most = -1;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      let open = 0;
      for (let step = 1; step <= 6; step++) {
        if (!nav.isWalkable(nav.tileX(x + Math.sin(a) * step * TILE), nav.tileZ(z + Math.cos(a) * step * TILE))) break;
        open++;
      }
      if (open > most) [most, best] = [open, a];
    }
    return best;
  }

  // The map's pillar tiles: rock columns, or the look's set pieces.
  _pillars() {
    const r = this.r;
    const ids = this.look.pillars.filter((id) => Assets.hasProp(id));
    for (const pl of this.d.pillars) {
      this.claim(pl.x, pl.z, 1.2);
      const id = ids.length ? ids[Math.floor(r() * ids.length)] : null;
      // A statue (or anything with a face) looks out over the open ground;
      // a plain column may turn any way.
      const yaw = FACED.has(id) ? this._openYaw(pl.x, pl.z) + (FRONT[id] || 0) : r() * Math.PI * 2;
      if (id === 'pillar' || id === 'ironSpire') {
        // Grown to reach the vault: partly wider, partly taller.
        const size = Assets.props.get(id).entry.size;
        const k = Math.pow(this.ceiling / size, 0.55);
        this._place(id, pl.x, pl.z, { yaw, scale: k, stretchY: this.ceiling / (size * k) });
      }
      else if (id === 'crystal') this._place('crystal', pl.x, pl.z, { yaw, scale: 1.5 + r() * 0.4 });
      else if (id === 'stalagmite') this._place('stalagmite', pl.x, pl.z, { yaw, scale: 1.5 + r() * 0.5 });
      else if (id === 'basalt') this._place('basalt', pl.x, pl.z, { yaw, scale: 1.8 + r() * 0.4 });
      else if (id) this._place(id, pl.x, pl.z, { yaw, scale: 1 + r() * 0.15 });
      else {
        const g = new THREE.CylinderGeometry(0.85, 1.1, this.ceiling, 16, 8);
        const o = new THREE.Mesh(g, this.rockShape.material);
        o.position.set(pl.x, this.ceiling / 2, pl.z);
        this._chunk(pl.x, pl.z).add(o);
      }
    }
  }

  // Props along the walls, on the floor and hanging from the ceiling.
  _decor() {
    const r = this.r;
    const L = this.look;
    const kinds = L.decor.filter(([id]) => Assets.hasProp(id)).map(([id, weight, where, scale]) => ({ id, weight, where, scale }));
    if (!kinds.length) return;
    const buckets = new Map();
    const add = (id, mm) => {
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(mm);
    };
    const used = new Set();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const UP = THREE.Object3D.DEFAULT_UP;
    const count = Math.round(this.slots.length * L.density);
    const slots = [...this.slots];
    for (let n = 0; n < count && slots.length; n++) {
      const k = pickWeighted(r, kinds);
      const size = Assets.props.get(k.id).entry.size;
      const sc = k.scale[0] + r() * (k.scale[1] - k.scale[0]);
      const rad = this.reach(k.id, sc);
      const slot = slots.splice(Math.floor(r() * slots.length), 1)[0];
      const { t, dx, dz } = slot;
      const key = `${t.c},${t.r}`;
      if (!this.clear(t.x, t.z)) continue;
      const along = (r() - 0.5) * 1.2;
      if (k.where === 'hang') {
        if (used.has(`h${key}`)) continue;
        used.add(`h${key}`);
        // Hung a little out from the wall, high enough to walk under.
        const x = t.x + dx * 0.2 + dz * along;
        const z = t.z + dz * 0.2 + dx * along;
        if (!this.free(x, z, 1.1, this.hung)) continue;
        this.claim(x, z, 1.1, this.hung);
        if (k.id === 'cage') {
          const bottom = Math.max(3.1, this.ceiling - size * sc - 1.6);
          p.set(x, bottom, z);
          add('cage', m.compose(p, q.setFromAxisAngle(UP, r() * 6.28), s.setScalar(sc)).clone());
          const gap = this.ceiling - (bottom + size * sc);
          if (gap > 0.2 && Assets.hasProp('chains')) {
            const cs = Assets.props.get('chains').entry.size;
            p.set(x, bottom + size * sc - 0.1, z);
            add('chains', m.compose(p, q, s.set(0.5, (gap + 0.2) / cs, 0.5)).clone());
          }
        } else {
          const len = Math.min(size * sc * 1.6, this.ceiling - 3.2);
          p.set(x, this.ceiling - len, z);
          add(k.id, m.compose(p, q.setFromAxisAngle(UP, r() * 6.28), s.set(sc, len / size, sc)).clone());
        }
        continue;
      }
      if (k.where === 'wall') {
        // Big pieces keep further from where you arrive and leave.
        if (used.has(key) || !this.clear(t.x, t.z, 3.5 * TILE)) continue;
        // Backed into the rock, facing into the room.
        p.set(t.x + dx * 0.8 + dz * along * 0.3, 0, t.z + dz * 0.8 + dx * along * 0.3);
        if (!this.free(p.x, p.z, rad + 0.2)) continue;
        used.add(key);
        this.claim(p.x, p.z, rad);
        const yaw = Math.atan2(-dx, -dz) + (FRONT[k.id] || 0) + (r() - 0.5) * 0.3;
        const solids = this.solidsFor(k.id, p.x, p.z, yaw, sc);
        this.solids.push(...solids);
        q.setFromAxisAngle(UP, yaw);
        const mm = m.compose(p, q, s.setScalar(sc)).clone();
        add(k.id, mm);
        const fr = FRAGILE.has(k.id) ? { id: k.id, mm, solids, x: p.x, z: p.z, r: rad, h: size * sc } : null;
        if (fr) this.fragile.push(fr);
        if (GLOW[k.id]) {
          // (Its glow goes out with it if it is smashed: Props._smash.)
          const gl = { x: p.x, y: size * sc * 0.5, z: p.z, size: size * sc };
          this.glows.push(gl);
          if (fr) fr.glow = gl;
        }
        continue;
      }
      // Along the foot of the wall.
      const inset = 0.6 + r() * 0.3;
      p.set(t.x + dx * inset + dz * along, 0, t.z + dz * inset + dx * along);
      if (!this.free(p.x, p.z, rad + 0.15)) continue;
      this.claim(p.x, p.z, rad);
      const yaw = r() * 6.28;
      const solids = this.solidsFor(k.id, p.x, p.z, yaw, sc);
      this.solids.push(...solids);
      const mm = m.compose(p, q.setFromAxisAngle(UP, yaw), s.setScalar(sc)).clone();
      add(k.id, mm);
      const fr = FRAGILE.has(k.id) ? { id: k.id, mm, solids, x: p.x, z: p.z, r: rad, h: size * sc } : null;
      if (fr) this.fragile.push(fr);
      if (GLOW[k.id] && r() < 0.5) {
        const gl = { x: p.x, y: size * sc * 0.45, z: p.z, size: size * sc };
        this.glows.push(gl);
        if (fr) fr.glow = gl;
      }
    }
    for (const [id, list] of buckets) this._instances(Assets.propGeometry(id).geometry, this.mat(id), list);
  }

  // The exit's hell-gate (Level.js) stands on the exit tile: nothing else
  // goes where it stands.
  _exitGate() {
    const x = this.d.exit;
    if (!x) return;
    const [fx, fz] = exitFacing(this.d);
    this.claim(x.x, x.z, 2.8);
    this.claim(x.x + fx * 2.2, x.z + fz * 2.2, 1.6);
  }

  // Azrakel's throne, against the wall behind where he waits.
  _throne() {
    const b = this.d.boss;
    if (!b || this.level.def.look !== 'throne' || !Assets.hasProp('throne')) return;
    const sp = this.d.spawn;
    const away = new THREE.Vector2(b.x - sp.x, b.z - sp.z).normalize();
    let best = null;
    let bestScore = Infinity;
    for (const sl of this.slots) {
      const toSlot = new THREE.Vector2(sl.t.x - b.x, sl.t.z - b.z);
      const dist = toSlot.length();
      const score = dist - toSlot.normalize().dot(away) * 6;
      if (dist > 3 && score < bestScore) [best, bestScore] = [sl, score];
    }
    if (!best) return;
    const { t, dx, dz } = best;
    this.claim(t.x + dx * 0.4, t.z + dz * 0.4, 2.2);
    this._place('throne', t.x + dx * 0.4, t.z + dz * 0.4, { yaw: Math.atan2(-dx, -dz), scale: 1.25 });
  }

  // Soft halos over everything that glows, and the brightest few as lights.
  _glowSprites() {
    if (!this.glows.length) return;
    const mat = new THREE.SpriteMaterial({ map: softDotTexture(), color: new THREE.Color(this.look.glow).multiplyScalar(0.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true });
    for (const g of this.glows) {
      const sp = new THREE.Sprite(mat);
      sp.position.set(g.x, g.y, g.z);
      sp.scale.setScalar(g.size * 1.5);
      this._chunk(g.x, g.z).add(sp);
      g.sprite = sp;
    }
  }

  // Ground mist: three drifting sheets of noise at knee, waist and chest
  // height that you wade through, thicker in the hollows, glowing faintly
  // with the floor's light, thinning out as they approach you so they never
  // smear across the view. One mesh, one draw each.
  _mist() {
    const d = this.d;
    const W = d.cols * TILE;
    const H = d.rows * TILE;
    // Pale ash-grey with a breath of the floor's glow in it.
    const tint = new THREE.Color(0x6a6468).lerp(new THREE.Color(this.look.glow), 0.08).multiplyScalar(0.5);
    this.mistMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uColor: { value: tint }, uLayer: { value: 0 }, uNoise: { value: null } }]),
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec3 vWorld;
        varying float vDepth;
        varying float vSlope;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vSlope = abs(normalize(cameraPosition - wp.xyz).y);
          vec4 mvPosition = viewMatrix * wp;
          vDepth = -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uLayer;
        uniform sampler2D uNoise;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vSlope;
        // Smooth value noise, tiling every 16 units, from a small texture.
        float n2(vec2 p) { return texture2D(uNoise, p / 16.0).r; }
        void main() {
          vec2 p = vWorld.xz * 0.11 + uLayer * 7.3;
          float t = uTime * (0.05 + uLayer * 0.02);
          float n = n2(p + vec2(t, t * 0.6)) * 0.65 + n2(p * 2.3 - vec2(t * 1.7, -t)) * 0.35;
          float wisp = smoothstep(0.38, 0.85, n);
          float near = smoothstep(0.6, 4.0, vDepth);
          // Seen edge-on a sheet would stack into a hard band: fade it out.
          float slope = smoothstep(0.04, 0.3, vSlope);
          float a = wisp * near * slope * (0.28 - uLayer * 0.05);
          gl_FragColor = vec4(uColor * (0.6 + 0.6 * n), a);
          #include <fog_fragment>
        }`,
    });
    const heights = [0.45, 1.25];
    const noise = mistNoise();
    this.mistMeshes = [];
    this.mist = heights.map((y, i) => {
      const mat = this.mistMat.clone();
      mat.uniforms.uLayer.value = i;
      mat.uniforms.uNoise.value = noise;
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      sheet.rotation.x = -Math.PI / 2;
      sheet.position.set(W / 2, y, H / 2);
      sheet.renderOrder = 2;
      this.group.add(sheet);
      this.mistMeshes.push(sheet);
      return mat;
    });
  }

  tick(t) {
    for (const m of this.mist || []) m.uniforms.uTime.value = t;
  }

  // Up to `n` glowing set pieces spread over the floor, for point lights.
  lightSpots(n) {
    const out = [];
    const sorted = [...this.glows].sort((a, b) => b.size - a.size);
    for (const g of sorted) {
      if (out.length >= n) break;
      if (out.every((o) => Math.hypot(o.x - g.x, o.z - g.z) > 14)) out.push(g);
    }
    return out;
  }
}

// A coarse copy of a model for far away: its vertices snapped together on a
// grid `cells` across the model's longest side, triangles that collapse
// dropped (vertex clustering). A 300-triangle boulder keeps about a third.
function clusterLod(geo, cells) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const n = pos.count;
  const index = geo.index ? geo.index.array : Array.from({ length: n }, (_, i) => i);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  const cell = Math.max(size.x, size.y, size.z) / cells;
  const ids = new Map();
  const sums = [];
  const of = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.floor((x - bb.min.x) / cell)},${Math.floor((y - bb.min.y) / cell)},${Math.floor((z - bb.min.z) / cell)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = sums.length;
      ids.set(key, id);
      sums.push({ x: 0, y: 0, z: 0, n: 0, u: uv ? uv.getX(i) : 0, v: uv ? uv.getY(i) : 0 });
    }
    const c = sums[id];
    c.x += x;
    c.y += y;
    c.z += z;
    c.n++;
    of[i] = id;
  }
  const tris = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = of[index[t]];
    const b = of[index[t + 1]];
    const c = of[index[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  // Flat-shaded: each triangle its own corners.
  const out = new Float32Array(tris.length * 3);
  const outUv = new Float32Array(tris.length * 2);
  tris.forEach((id, k) => {
    const c = sums[id];
    out[k * 3] = c.x / c.n;
    out[k * 3 + 1] = c.y / c.n;
    out[k * 3 + 2] = c.z / c.n;
    outUv[k * 2] = c.u;
    outUv[k * 2 + 1] = c.v;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Tiling value noise (64 x 64, smoothly interpolated by the sampler) for the
// ground mist.
let mistTex = null;
function mistNoise() {
  if (mistTex) return mistTex;
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  const rnd = mulberry32(911);
  const grid = Array.from({ length: 16 * 16 }, () => rnd());
  const at = (x, y) => grid[((y + 16) % 16) * 16 + ((x + 16) % 16)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const gx = (x / N) * 16;
      const gy = (y / N) * 16;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const fx = gx - ix;
      const fy = gy - iy;
      const ux = fx * fx * (3 - 2 * fx);
      const uy = fy * fy * (3 - 2 * fy);
      const v = (at(ix, iy) * (1 - ux) + at(ix + 1, iy) * ux) * (1 - uy) + (at(ix, iy + 1) * (1 - ux) + at(ix + 1, iy + 1) * ux) * uy;
      const k = (y * N + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = Math.round(v * 255);
      data[k + 3] = 255;
    }
  }
  mistTex = new THREE.DataTexture(data, N, N);
  mistTex.wrapS = mistTex.wrapT = THREE.RepeatWrapping;
  mistTex.magFilter = THREE.LinearFilter;
  mistTex.minFilter = THREE.LinearMipmapLinearFilter;
  mistTex.generateMipmaps = true;
  mistTex.needsUpdate = true;
  return mistTex;
}
