import * as THREE from 'three';
import { TILE } from './LevelData.js';
import { Assets } from '../assets/AssetLibrary.js';
import { rockTextures, emberVeinTexture, softDotTexture } from './Textures.js';
import { mulberry32 } from '../core/rng.js';

// Dresses a cavern floor in its look (themes.js): the rock shell (floor,
// ceiling, walls of generated boulders), stalactites and rubble, set pieces on
// the map's pillar tiles, and props along the walls, from the ceiling and
// across the floor. Everything repeated is instanced, one draw per model per
// 12 m chunk of the map, so the renderer can skip what is behind you, and
// chunks lost in the fog are hidden altogether (`cull`). Scenery never
// blocks: collision and navigation come from the tile grid.

const CHUNK = 6 * TILE;

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
const GLOW = { crystal: 1.25, fungus: 1.2, eggs: 1.1, obelisk: 1.4, brazier: 1.2 };
// Footprint radius of each prop, as a fraction of its size: nothing is
// placed inside another's footprint (see free/claim).
const FOOT = { skulls: 0.7, ribcage: 0.42, remains: 0.5, stakes: 0.42, altar: 0.55, statue: 0.28, obelisk: 0.25, crystal: 0.42, fungus: 0.45, eggs: 0.5, stalagmite: 0.35, cage: 0.3, chains: 0.15 };
// Rock-like props take the full rock tint; the rest a softer one.
const ROCKY = new Set(['rock', 'slab', 'stalagmite', 'pillar']);

// A generated model's material made to sit in the cave: its painted colour
// tinted, no metal/roughness texture (the models' are glossy for a lit studio,
// not a torchlit cave), and the bright parts of its albedo glowing if asked.
export function sceneryMaterial(base, { tint = [1, 1, 1], metal = 0, rough = 0.9, glow = null, strength = 1.4 } = {}) {
  const m = base.clone();
  m.color.multiply(new THREE.Color(tint[0], tint[1], tint[2]));
  m.metalnessMap = null;
  m.roughnessMap = null;
  m.aoMap = null;
  m.metalness = metal;
  m.roughness = metal ? 0.55 : rough;
  if (glow !== null) {
    m.emissive = new THREE.Color(glow);
    m.emissiveMap = m.map;
    m.emissiveIntensity = strength;
  }
  m.needsUpdate = true;
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
    this._findEdges();
    for (const b of this.d.braziers) this.claim(b.x, b.z, 1.1);
    this._shell();
    this._hanging();
    this._rubble();
    this._pillars();
    this._exitGate();
    this._throne();
    this._decor();
    this._glowSprites();
    this._backing();
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
    for (const t of d.floorTiles) {
      if (hazard.has(t.r * d.cols + t.c)) continue;
      this.openTiles.push(t);
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
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex.map.clone(), bumpMap: floorTex.bump.clone(), bumpScale: 3, roughness: 0.95 });
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
    const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex.map, bumpMap: ceilTex.bump, bumpScale: 3, roughness: 1 });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, H), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(W / 2, this.ceiling, H / 2);
    this.group.add(floor, ceil);

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
      material.roughness = 1;
      shapes.push({ id, weight, ...u, material, list: [] });
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
    for (const sh of shapes) this._instances(sh.geometry, sh.material, sh.list);
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
      c = { group, x: (cx + 0.5) * CHUNK, z: (cz + 0.5) * CHUNK };
      this.chunks.set(key, c);
    }
    return c.group;
  }

  // One instanced mesh per chunk for a list of placements.
  _instances(geometry, material, list) {
    if (!list.length || !geometry || !material) return;
    const byChunk = new Map();
    for (const mm of list) {
      const g = this._chunk(mm.elements[12], mm.elements[14]);
      if (!byChunk.has(g)) byChunk.set(g, []);
      byChunk.get(g).push(mm);
    }
    for (const [g, part] of byChunk) {
      const inst = new THREE.InstancedMesh(geometry, material, part.length);
      part.forEach((mm, k) => inst.setMatrixAt(k, mm));
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      g.add(inst);
    }
  }

  // Hide the chunks the fog has swallowed (`range` metres from the viewer).
  cull(x, z, range) {
    const r2 = (range + CHUNK * 0.75) ** 2;
    for (const c of this.chunks.values()) c.group.visible = (c.x - x) ** 2 + (c.z - z) ** 2 < r2;
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
      geometry = new THREE.ConeGeometry(1, 1, 6).rotateX(Math.PI).translate(0, -0.5, 0);
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
    this._instances(this.rockShape.geometry, this.rockShape.material, list);
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

  // The map's pillar tiles: rock columns, or the look's set pieces.
  _pillars() {
    const r = this.r;
    const ids = this.look.pillars.filter((id) => Assets.hasProp(id));
    for (const pl of this.d.pillars) {
      this.claim(pl.x, pl.z, 1.2);
      const id = ids.length ? ids[Math.floor(r() * ids.length)] : null;
      const yaw = r() * Math.PI * 2;
      if (id === 'pillar') {
        // Grown to reach the vault: partly wider, partly taller.
        const size = Assets.props.get('pillar').entry.size;
        const k = Math.pow(this.ceiling / size, 0.55);
        this._place('pillar', pl.x, pl.z, { yaw, scale: k, stretchY: this.ceiling / (size * k) });
      }
      else if (id === 'crystal') this._place('crystal', pl.x, pl.z, { yaw, scale: 1.5 + r() * 0.4 });
      else if (id === 'stalagmite') this._place('stalagmite', pl.x, pl.z, { yaw, scale: 1.5 + r() * 0.5 });
      else if (id) this._place(id, pl.x, pl.z, { yaw, scale: 1 + r() * 0.15 });
      else {
        const g = new THREE.CylinderGeometry(0.85, 1.1, this.ceiling, 9, 8);
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
      const rad = this.foot(k.id, sc);
      if (k.where === 'open') {
        const t = this.openTiles[Math.floor(r() * this.openTiles.length)];
        if (!this.clear(t.x, t.z, 2 * TILE)) continue;
        p.set(t.x + (r() - 0.5) * 1.4, 0, t.z + (r() - 0.5) * 1.4);
        if (!this.free(p.x, p.z, rad + 0.3)) continue;
        this.claim(p.x, p.z, rad);
        add(k.id, m.compose(p, q.setFromAxisAngle(UP, r() * 6.28), s.setScalar(sc)).clone());
        continue;
      }
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
        q.setFromAxisAngle(UP, Math.atan2(-dx, -dz) + (r() - 0.5) * 0.3);
        add(k.id, m.compose(p, q, s.setScalar(sc)).clone());
        if (GLOW[k.id]) this.glows.push({ x: p.x, y: size * sc * 0.5, z: p.z, size: size * sc });
        continue;
      }
      // Along the foot of the wall.
      const inset = 0.6 + r() * 0.3;
      p.set(t.x + dx * inset + dz * along, 0, t.z + dz * inset + dx * along);
      if (!this.free(p.x, p.z, rad + 0.15)) continue;
      this.claim(p.x, p.z, rad);
      add(k.id, m.compose(p, q.setFromAxisAngle(UP, r() * 6.28), s.setScalar(sc)).clone());
      if (GLOW[k.id] && r() < 0.5) this.glows.push({ x: p.x, y: size * sc * 0.45, z: p.z, size: size * sc });
    }
    for (const [id, list] of buckets) this._instances(Assets.propGeometry(id).geometry, this.mat(id), list);
  }

  // The hell-gate stands behind the exit portal, facing the way in.
  _exitGate() {
    const x = this.d.exit;
    if (!x || !Assets.hasProp('gate')) return;
    const nav = this.d.nav;
    let best = null;
    let openBest = Infinity;
    for (const [dc, dr] of DIRS) {
      let open = 0;
      for (let step = 1; step <= 4; step++) if (nav.isWalkable(x.c + dc * step, x.r + dr * step)) open++;
      if (open < openBest) [best, openBest] = [[dc, dr], open];
    }
    const [dx, dz] = best;
    this.claim(x.x + dx * 1.7, x.z + dz * 1.7, 2.4);
    this.gate = this._place('gate', x.x + dx * 1.7, x.z + dz * 1.7, { yaw: Math.atan2(-dx, -dz), scale: Math.min(1, (this.ceiling - 0.4) / Assets.props.get('gate').entry.size) });
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
    }
  }

  // Solid black rock one tile behind the boulder walls, floor to vault, so
  // no gap between the boulders ever shows the void beyond the map.
  _backing() {
    const geo = new THREE.BoxGeometry(TILE, this.ceiling + 0.2, TILE);
    geo.translate(0, (this.ceiling + 0.2) / 2 - 0.1, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const m = new THREE.Matrix4();
    const d = this.d;
    const edge = new Set(this.wallTiles.map((t) => t.r * d.cols + t.c));
    const behind = new Set();
    for (const t of this.wallTiles) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const c = t.c + dc;
          const r = t.r + dr;
          if (c < 0 || r < 0 || c >= d.cols || r >= d.rows) continue;
          const k = r * d.cols + c;
          if (!edge.has(k) && !d.nav.isWalkable(c, r)) behind.add(k);
        }
      }
    }
    const list = [...behind].map((k) => m.makeTranslation(((k % d.cols) + 0.5) * TILE, 0, (Math.floor(k / d.cols) + 0.5) * TILE).clone());
    this._instances(geo, mat, list);
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
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uColor: { value: tint }, uLayer: { value: 0 } }]),
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
        varying vec3 vWorld;
        varying float vDepth;
        varying float vSlope;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1.0, 0.0)), u.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), u.x), u.y);
        }
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
    this.mist = heights.map((y, i) => {
      const mat = this.mistMat.clone();
      mat.uniforms.uLayer.value = i;
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      sheet.rotation.x = -Math.PI / 2;
      sheet.position.set(W / 2, y, H / 2);
      sheet.renderOrder = 2;
      this.group.add(sheet);
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
