import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE } from './LevelData.js';
import { rockTextures } from './Textures.js';
import { Assets } from '../assets/AssetLibrary.js';
import { C, burst } from './Particles.js';
import { angleDelta } from '../core/rng.js';

// The Sleeper's hall (floor 5, `def.hall`): a long corridor of dressed stone,
// candle pedestals down both sides that light as you come up to them, stone
// columns and banners along the walls; then a round arena ringed with
// candelabra and columns, Vorgrath asleep on a nest of bones in the middle.
// Come up to the arena and its candles light one after another from either
// side of the way in round to the far side, the great ring of candles hung
// under the dome last; then the whole arena brightens (`litK`), seen in
// full detail, and `phase` becomes 'lit' (Game wakes him). Overhead: a
// ribbed barrel vault down the corridor, a ribbed dome over the arena.
//
// Every candle flame is one instance of two instanced quads (the flame and
// its halo): two draws for the lot, however many burn.

// The corridor's candles light this far ahead of you.
const AHEAD = 10;
// The arena's candles start to light this far (m) before you reach its
// edge; the last one lights this long after the first.
const EARLY = 7;
const DOMINO = 2.2;
const PEDESTAL_STEP = 3;
const COLUMN_STEP = 6;

const flameGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.42, 0);
const haloGeo = new THREE.PlaneGeometry(1, 1);

const VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute float aSeed;
  attribute float aSize;
  attribute float aLit;
  uniform float uHalo;
  varying vec2 vUv;
  varying float vSeed;
  varying float vLit;
  void main() {
    vUv = uv;
    vSeed = aSeed;
    vLit = aLit;
    vec4 c = modelViewMatrix * vec4(aPos, 1.0);
    float s = aSize * (uHalo > 0.5 ? 5.0 : 1.0) * (0.3 + 0.7 * min(aLit, 1.3));
    if (aLit <= 0.001) s = 0.0;
    gl_Position = projectionMatrix * (c + vec4(position.x * s * (uHalo > 0.5 ? 1.0 : 0.62), position.y * s, 0.0, 0.0));
  }`;

const FLAME_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed;
  varying float vLit;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) { return noise(p) * 0.6 + noise(p * 2.03) * 0.4; }
  void main() {
    vec2 uv = vUv;
    float t = uTime * 1.9 + vSeed * 17.0;
    float n = fbm(vec2(uv.x * 3.5, uv.y * 2.4 - t * 1.9));
    float n2 = fbm(vec2(uv.x * 7.0 + 3.1, uv.y * 4.0 - t * 3.1));
    float sway = (n - 0.5) * 0.3 * uv.y;
    vec2 p = vec2((uv.x - 0.5 - sway) * 2.0, uv.y);
    float width = mix(0.6, 0.02, pow(uv.y, 0.8)) * (0.85 + 0.3 * n2);
    float body = 1.0 - smoothstep(width * 0.5, width, abs(p.x));
    body *= smoothstep(0.0, 0.1, uv.y) * (1.0 - smoothstep(0.6 + 0.25 * n, 1.0, uv.y));
    float heat = body * (1.2 - uv.y) * (0.8 + 0.4 * n2);
    vec3 col = mix(vec3(0.75, 0.12, 0.0), vec3(1.0, 0.5, 0.08), smoothstep(0.1, 0.5, heat));
    col = mix(col, vec3(1.0, 0.9, 0.6), smoothstep(0.55, 0.95, heat));
    float a = clamp(heat * 1.7, 0.0, 1.0) * min(vLit, 1.0);
    gl_FragColor = vec4(col * a, a);
  }`;

const HALO_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed;
  varying float vLit;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float flick = 0.85 + 0.15 * sin(uTime * 9.0 + vSeed * 31.0) * sin(uTime * 5.3 + vSeed * 7.0);
    float a = pow(max(0.0, 1.0 - d), 2.2) * 0.32 * min(vLit, 1.0) * flick;
    gl_FragColor = vec4(vec3(1.0, 0.55, 0.22) * a, a);
  }`;

function flameMaterial(frag, uniforms) {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}

export class Hall {
  constructor(level) {
    this.level = level;
    this.dressing = level.dressing;
    const H = level.def.hall;
    const [c0, c1, r0, r1] = H.corridor;
    this.north = r0 * TILE;
    this.south = (r1 + 1) * TILE;
    this.x0 = c0 * TILE;
    this.x1 = (c1 + 1) * TILE;
    this.centre = new THREE.Vector3((H.arena[0] + 0.5) * TILE, 0, (H.arena[1] + 0.5) * TILE);
    this.radius = H.arena[2] * TILE;
    this.flames = [];
    this.pedestals = [];
    this.candelabra = [];
    this.phase = 'corridor';
    this.domino = -1;
    this.litK = 0;
    this.time = 0;
    this.ceiling = this.dressing.ceiling;
    const solid = (c, r) => !level.data.nav.isWalkable(c, r);
    this.solid = solid;

    // No flat roof here: the vault and the dome.
    if (this.dressing.ceilMesh) this.dressing.ceilMesh.visible = false;
    this._corridor();
    this._arena();
    this._roof();
    this._buildFlames();
  }

  // Instanced scenery (the dressing's chunked batches), solid where it stands.
  _put(id, list) {
    const src = Assets.propGeometry(id);
    if (src && list.length) this.dressing._instances(src.geometry, this.dressing.mat(id), list);
  }

  _matrix(x, y, z, yaw, scale) {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw), new THREE.Vector3(scale, scale, scale));
  }

  // A candle group (pedestal or candelabrum) at (x, z) turned `yaw`: its
  // flames, unlit, at the candle tips (`tips`: [x, y, z, size] in metres).
  _candles(x, z, yaw, tips) {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const group = { x, z, flames: [], lit: false };
    for (const [tx, ty, tz, size] of tips) {
      const f = { x: x + tx * c + tz * s, y: ty, z: z - tx * s + tz * c, size, seed: Math.random() * 10, lit: 0, target: 0 };
      group.flames.push(f);
      this.flames.push(f);
    }
    return group;
  }

  _corridor() {
    const d = this.dressing;
    const data = this.level.data;
    const world = this.level.world;
    const pedestals = [];
    const columns = [];
    const banners = [];
    const open = (x, z) => !this.solid(Math.floor(x / TILE), Math.floor(z / TILE));
    const P = Assets.props.get('candlePedestal')?.entry.size ?? 1.35;
    // The pedestal's candles: a tall one in the middle, two shorter beside it.
    // Measured off the model (its wick tops, at its 1.35 m): one tall
    // candle in the middle, six short ones round it.
    const k = P / 1.35;
    const tips = [
      [0.002, 1.35, 0.003, 0.3],
      [-0.053, 1.056, -0.2, 0.17],
      [-0.117, 1.035, 0.144, 0.17],
      [0.114, 1.026, -0.185, 0.17],
      [0.115, 1.023, 0.124, 0.17],
      [-0.051, 1.013, 0.173, 0.17],
      [-0.207, 1.008, 0.046, 0.17],
    ].map(([x, y, z, s]) => [x * k, y * k - 0.025, z * k, s]);
    for (let x = this.x0 + 1.5 * TILE; x < this.x1 - TILE; x += PEDESTAL_STEP * TILE) {
      for (const [z, wall] of [
        [this.north + 0.85, this.north - 0.5],
        [this.south - 0.85, this.south + 0.5],
      ]) {
        // Not across the mouth of a side passage.
        if (open(x, wall) || open(x + 1, wall) || open(x - 1, wall)) continue;
        const yaw = z < this.centre.z ? 0 : Math.PI;
        pedestals.push(this._matrix(x, 0, z, yaw, 1));
        d.claim(x, z, 0.55);
        world.addStatic({ x, z, r: 0.42 });
        this.pedestals.push(this._candles(x, z, yaw, tips));
      }
    }
    // Columns half sunk in the walls, a banner hung between each pair.
    const tall = Math.min(1.45, (this.ceiling - 0.5) / 9);
    for (let x = this.x0 + 3 * TILE; x < this.x1 - 2 * TILE; x += COLUMN_STEP * TILE) {
      for (const [z, wall, face] of [
        [this.north - 0.15, this.north - 0.5, 1],
        [this.south + 0.15, this.south + 0.5, -1],
      ]) {
        if (open(x, wall) || open(x + 1.5, wall) || open(x - 1.5, wall)) continue;
        columns.push(this._matrix(x, 0, z, Math.random() * Math.PI * 2, tall));
        world.addStatic({ x, z: z + face * 0.2, r: 0.45 });
        const bx = x + COLUMN_STEP * TILE * 0.5;
        if (bx < this.x1 - 3 * TILE && !open(bx, wall)) banners.push(this._matrix(bx, 3.6, z + face * 0.25, face > 0 ? Math.PI / 2 : -Math.PI / 2, 1));
      }
    }
    this._put('candlePedestal', pedestals);
    this._put('hallColumn', columns);
    this._put('banner', banners);
    void data;
  }

  _arena() {
    const d = this.dressing;
    const world = this.level.world;
    const c = this.centre;
    const exit = this.level.data.exit;
    const toExit = Math.atan2(exit.x - c.x, exit.z - c.z);
    // The way in: from the corridor's side.
    this.entry = Math.atan2(this.x1 - 4 - c.x, (this.north + this.south) / 2 - c.z);
    const gapIn = Math.asin(Math.min(1, ((this.south - this.north) / 2 + 2) / (this.radius - 2)));
    const A = Assets.props.get('candelabra')?.entry.size ?? 2.4;
    // Measured off the model (at its 2.4 m): the tall middle candle and
    // the four on its arms.
    const ka = A / 2.4;
    const tips = [
      [-0.038, 2.4, -0.003, 0.32],
      [0.273, 2.095, -0.295, 0.25],
      [-0.258, 2.087, -0.287, 0.25],
      [-0.267, 2.086, 0.3, 0.25],
      [0.262, 2.02, 0.267, 0.25],
    ].map(([x, y, z, s]) => [x * ka, y * ka - 0.03, z * ka, s]);
    const ring = this.radius - 2.2;
    const n = Math.round((Math.PI * 2 * ring) / 4.3);
    const stands = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.07;
      if (Math.abs(angleDelta(a, this.entry)) < gapIn || Math.abs(angleDelta(a, toExit)) < 0.36) continue;
      const x = c.x + Math.sin(a) * ring;
      const z = c.z + Math.cos(a) * ring;
      // The arms face into the arena.
      const yaw = a + Math.PI / 2;
      stands.push(this._matrix(x, 0, z, yaw, 1));
      d.claim(x, z, 0.6);
      world.addStatic({ x, z, r: 0.35 });
      const g = this._candles(x, z, yaw, tips);
      g.angle = a;
      g.delay = (Math.abs(angleDelta(a, this.entry)) / Math.PI) * DOMINO;
      this.candelabra.push(g);
    }
    this._put('candelabra', stands);
    // Great columns round the wall, a banner on each facing the middle.
    const columns = [];
    const banners = [];
    const tall = Math.min(1.75, (this.ceiling - 0.5) / 9);
    const cr = this.radius - 0.6;
    const m = 10;
    for (let k = 0; k < m; k++) {
      const a = ((k + 0.5) / m) * Math.PI * 2;
      if (Math.abs(angleDelta(a, this.entry)) < gapIn + 0.15 || Math.abs(angleDelta(a, toExit)) < 0.45) continue;
      const x = c.x + Math.sin(a) * cr;
      const z = c.z + Math.cos(a) * cr;
      columns.push(this._matrix(x, 0, z, Math.random() * Math.PI * 2, tall));
      world.addStatic({ x, z, r: 0.6 });
      const bx = c.x + Math.sin(a) * (cr - 0.7);
      const bz = c.z + Math.cos(a) * (cr - 0.7);
      banners.push(this._matrix(bx, 4.6, bz, Math.atan2(-Math.cos(a), Math.sin(a)) + Math.PI, 1.15));
    }
    this._put('hallColumn', columns);
    this._put('banner', banners);
    // His bed: a nest of bones in the middle.
    d._place('boneNest', c.x, c.z, { scale: 0.85, yaw: this.entry, stretchY: 0.45 });
    d.claim(c.x, c.z, 3);
  }

  // Overhead: a barrel vault down the corridor with an arch over each pair
  // of columns and a ridge along its crown; over the arena a dome with ribs
  // meeting at its crown, and a great iron ring of candles hung under it on
  // chains (the last of the arena's candles to light).
  _roof() {
    const top = this.ceiling;
    const c = this.centre;
    const tex = rockTextures(5, this.level.look.ground.map((v) => Math.round(v * 0.6)));
    const shell = (rx, ry) => {
      const m = new THREE.MeshLambertMaterial({ map: tex.map.clone(), bumpMap: tex.bump.clone(), bumpScale: 3, side: THREE.BackSide });
      for (const t of [m.map, m.bumpMap]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(rx, ry);
        t.needsUpdate = true;
      }
      return m;
    };
    const ribs = [];
    // The corridor's vault, wall to wall, as far as the arena's edge.
    const half = (this.south - this.north) / 2 + 0.6;
    const zc = (this.north + this.south) / 2;
    const xEnd = c.x - Math.sqrt(Math.max(0, this.radius ** 2 - half ** 2));
    const len = xEnd - this.x0;
    const vault = new THREE.CylinderGeometry(half, half, len, 28, 1, true, Math.PI, Math.PI).rotateZ(-Math.PI / 2).translate(this.x0 + len / 2, top, zc);
    this.level.group.add(new THREE.Mesh(vault, shell(len / 9, 2)));
    for (let x = this.x0 + 3 * TILE; x < xEnd - 1; x += COLUMN_STEP * TILE) {
      ribs.push(new THREE.TorusGeometry(half - 0.2, 0.32, 8, 28, Math.PI).rotateY(Math.PI / 2).translate(x, top, zc));
    }
    ribs.push(new THREE.BoxGeometry(len, 0.35, 0.55).translate(this.x0 + len / 2, top + half - 0.15, zc));
    // The arena's dome.
    const R = this.radius + 0.8;
    const H = 0.55;
    const dome = new THREE.SphereGeometry(R, 56, 20, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, H, 1).translate(c.x, top, c.z);
    this.level.group.add(new THREE.Mesh(dome, shell(10, 3)));
    for (let k = 0; k < 6; k++) ribs.push(new THREE.TorusGeometry(R - 0.25, 0.42, 8, 48, Math.PI).scale(1, H, 1).rotateY((k * Math.PI) / 6).translate(c.x, top, c.z));
    ribs.push(new THREE.TorusGeometry(R - 0.15, 0.5, 8, 72).rotateX(Math.PI / 2).translate(c.x, top, c.z));
    const ribMat = new THREE.MeshLambertMaterial({ map: tex.map, color: 0x9a8a90 });
    this.level.group.add(new THREE.Mesh(mergeGeometries(ribs.map((g) => g.toNonIndexed())), ribMat));
    for (const g of ribs) g.dispose();

    // The ring of candles hung from the crown.
    const ringY = top + 4;
    const ringR = 3.2;
    const crown = top + R * H - 0.3;
    const iron = new THREE.MeshLambertMaterial({ color: 0x2a2224 });
    const parts = [new THREE.TorusGeometry(ringR, 0.14, 8, 48).rotateX(Math.PI / 2).translate(c.x, ringY, c.z)];
    const n = 12;
    const tips = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = Math.sin(a) * ringR;
      const z = Math.cos(a) * ringR;
      parts.push(new THREE.CylinderGeometry(0.07, 0.08, 0.36, 8).translate(c.x + x, ringY + 0.25, c.z + z));
      tips.push([x, ringY + 0.42, z, 0.24]);
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const from = new THREE.Vector3(c.x + Math.sin(a) * ringR, ringY, c.z + Math.cos(a) * ringR);
      const to = new THREE.Vector3(c.x, crown, c.z);
      const chain = new THREE.CylinderGeometry(0.05, 0.05, from.distanceTo(to), 6).translate(0, from.distanceTo(to) / 2, 0);
      chain.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(THREE.Object3D.DEFAULT_UP, to.clone().sub(from).normalize()));
      parts.push(chain.translate(from.x, from.y, from.z));
    }
    this.level.group.add(new THREE.Mesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), iron));
    for (const g of parts) g.dispose();
    const ring = this._candles(c.x, c.z, 0, tips);
    ring.delay = DOMINO;
    this.candelabra.push(ring);
  }

  _buildFlames() {
    const n = this.flames.length;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    const size = new Float32Array(n);
    this.lit = new Float32Array(n);
    this.flames.forEach((f, i) => {
      pos.set([f.x, f.y, f.z], i * 3);
      seed[i] = f.seed;
      size[i] = f.size;
    });
    this.uniforms = { uTime: { value: 0 }, uHalo: { value: 0 } };
    this.litAttr = new THREE.InstancedBufferAttribute(this.lit, 1);
    this.litAttr.setUsage(THREE.DynamicDrawUsage);
    const make = (geo, frag, halo) => {
      const g = new THREE.InstancedBufferGeometry();
      g.index = geo.index;
      g.attributes.position = geo.attributes.position;
      g.attributes.uv = geo.attributes.uv;
      g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
      g.setAttribute('aLit', this.litAttr);
      g.instanceCount = n;
      const mat = flameMaterial(frag, { uTime: this.uniforms.uTime, uHalo: { value: halo ? 1 : 0 } });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = halo ? 4 : 5;
      this.level.group.add(mesh);
      return mesh;
    };
    this.haloMesh = make(haloGeo, HALO_FRAG, true);
    this.flameMesh = make(flameGeo, FLAME_FRAG, false);
  }

  // Light a candle group: its flames flare up, a puff of sparks, and its
  // light joins the floor's light sources.
  _light(g, ctx, { base = 7, distance = 9 } = {}) {
    if (g.lit) return;
    g.lit = true;
    for (const f of g.flames) f.target = 1;
    const top = g.flames[0];
    burst(ctx.fx.add, new THREE.Vector3(top.x, top.y + 0.1, top.z), { count: 10, speed: 1.4, color: C.emberHot, colorEnd: C.emberRed, size: 0.06, life: 0.6, gravity: 1 });
    ctx.audio?.play?.('flame_swing', { pos: new THREE.Vector3(top.x, top.y, top.z), volume: 0.35, gap: 0.06 });
    this.level._spot({ color: 0xffa050, base, distance, decay: 1.6, x: top.x, y: top.y + 0.4, z: top.z, seed: top.seed });
  }

  update(dt, ctx) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const p = ctx.player.position;
    // Down the corridor: the candles ahead light as you come.
    for (const g of this.pedestals) if (!g.lit && p.x > g.x - AHEAD) this._light(g, ctx);
    // Into the arena: the ring lights from the way in round to the far side.
    const near = Math.hypot(p.x - this.centre.x, p.z - this.centre.z) < this.radius + EARLY;
    if (this.domino < 0 && near) {
      this.domino = 0;
      this.phase = 'arena';
    }
    if (this.domino >= 0 && this.phase !== 'lit') {
      this.domino += dt;
      let all = true;
      for (const g of this.candelabra) {
        if (g.lit) continue;
        if (this.domino >= g.delay) this._light(g, ctx, { base: 10, distance: 12 });
        else all = false;
      }
      if (all && this.domino > DOMINO + 0.3) {
        this.phase = 'lit';
        // Everything in the arena in full detail from now on.
        this.dressing.lodNear = 90;
        // A great light over the whole arena, always given a real light.
        this.level._spot({ color: 0xffb27a, base: 150, distance: 70, decay: 1, x: this.centre.x, y: this.ceiling + 2, z: this.centre.z, seed: 0, slow: true, prio: 1e6 });
      }
    }
    if (this.phase === 'lit') this.litK = Math.min(1, this.litK + dt / 1.6);
    // Flames flare up as they catch, then settle.
    let changed = false;
    this.flames.forEach((f, i) => {
      if (f.target === f.lit) return;
      f.lit = Math.min(f.target, f.lit + dt * 2.6);
      this.lit[i] = f.lit < 1 ? f.lit * 1.3 : 1;
      changed = true;
    });
    if (changed) this.litAttr.needsUpdate = true;
  }
}
