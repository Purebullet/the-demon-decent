import * as THREE from 'three';
import { CollisionWorld } from '../physics/CollisionWorld.js';
import { rockTextures, fogPuffTexture, emberVeinTexture, softDotTexture, makeCanvas } from './Textures.js';
import { makeFlame, abyssMaterial } from './Shaders.js';
import { C, spawnFlame, burst } from './Particles.js';
import { mulberry32, fbm2 } from '../core/rng.js';
import { Assets } from '../assets/AssetLibrary.js';

// Lot #1738: a jagged hole to hell torn through a ring of dark-stone ruins.
// Dense fog clings to the pit's edge, embers stream up out of it, and a red
// glow pulses from the depths. Step over the edge to begin the descent.

export const PIT_RADIUS = 7;
const FALL_RADIUS = 5.6;
// The fall: a cavern shaft below the funnel, deep enough for five seconds.
export const SHAFT_BOTTOM = 230;
const LOT_RADIUS = 34;

export class Surface {
  constructor() {
    this.group = new THREE.Group();
    this.time = 0;
    this.spawn = { x: 0, z: 25, yaw: 0 };
    this.rand = mulberry32(1738);
    this.circles = [];
    // Where the buried reliquary can lie (in the lee of things: placeSecret).
    this.hides = [];
    const { map, bump } = rockTextures(1738, [64, 56, 54]);
    this.stoneTex = { map, bump };
    this.stone = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 3, roughness: 0.92, color: 0x8a817c });
    this.darkStone = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 3, roughness: 0.95, color: 0x4a4240 });

    this._sky();
    this._ground();
    this._pit();
    this._rimShards();
    this._ruins();
    this._deadTrees();
    this._gate();
    this._obelisk();
    this._fog();
    this._lights();
    this._reliquary();
    this.world = new CollisionWorld({ circles: this.circles, boundRadius: LOT_RADIUS });
  }

  _sky() {
    const g = new THREE.SphereGeometry(150, 32, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        varying vec3 vP; uniform float uTime;
        void main(){
          vec3 d = normalize(vP);
          float h = d.y;
          vec3 horizon = vec3(0.16, 0.035, 0.02);
          vec3 zenith = vec3(0.01, 0.008, 0.012);
          vec3 col = mix(horizon, zenith, smoothstep(-0.05, 0.55, h));
          float glow = exp(-abs(h) * 9.0) * (0.6 + 0.15 * sin(uTime * 1.3));
          col += vec3(0.35, 0.06, 0.02) * glow;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.skyMat = m;
    this.group.add(new THREE.Mesh(g, m));
  }

  _ground() {
    // A radial mesh from the crater lip out to the edge of the lot. The lip
    // is raised and torn by noise; colour bleeds red toward the pit.
    const rings = 40;
    const segs = 160;
    const inner = PIT_RADIUS;
    const outer = 70;
    const pos = [];
    const col = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const r = inner + (outer - inner) * t * t;
      for (let j = 0; j <= segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        let y = this._height(x, z, r, a);
        if (i === 0) y -= 0.8 + fbm2(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10, 4, 5) * 1.2;
        const lip = Math.max(0, 1 - (r - inner) / 4.5);
        pos.push(x, y, z);
        const heat = Math.pow(lip, 2.2);
        col.push(0.55 + heat * 0.7, 0.52 - heat * 0.1, 0.5 - heat * 0.15);
        uv.push(x / 6, z / 6);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * (segs + 1) + j;
        const b = a + segs + 1;
        // Counter-clockwise seen from above, so the faces point up.
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({
      map: this.stoneTex.map,
      bumpMap: this.stoneTex.bump,
      bumpScale: 3,
      vertexColors: true,
      roughness: 0.95,
      emissive: 0xffffff,
      emissiveMap: emberVeinTexture(29, [255, 70, 10], 20),
      emissiveIntensity: 0.25,
    });
    // Molten veins glow only near the lip: scale emissive by the vertex heat
    // that is baked into the red channel.
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= smoothstep(0.62, 1.2, vColor.r);',
      );
    };
    this.groundMat = m;
    this.group.add(new THREE.Mesh(g, m));
    this.heightAt = (x, z) => {
      const r = Math.max(inner, Math.hypot(x, z));
      return this._height(x, z, r, Math.atan2(z, x));
    };
  }

  // The ground caves in toward the hole, torn into a jagged edge.
  _height(x, z, r, a) {
    const jag = fbm2(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + 10, 4, 5);
    const lip = Math.max(0, 1 - (r - PIT_RADIUS) / 6);
    const rolling = (fbm2(x * 0.08, z * 0.08, 4, 2) - 0.5) * 1.2 * Math.min(1, (r - PIT_RADIUS) / 10);
    return rolling - Math.pow(lip, 1.6) * 1.3 + lip * lip * jag * 0.6;
  }

  _pit() {
    // Funnel walls dropping into the glow.
    const depth = 46;
    const g = new THREE.CylinderGeometry(PIT_RADIUS + 0.2, 5.2, depth, 96, 40, true);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const a = Math.atan2(v.z, v.x);
      const yN = (v.y + depth / 2) / depth;
      // Noise in metres both around and down the wall (the old one varied
      // with angle only, which carved it into vertical metal-looking flutes),
      // plus a few rough horizontal strata.
      const circ = a * PIT_RADIUS;
      const n = fbm2(circ * 0.32 + 3, v.y * 0.32, 4, 9);
      const strata = Math.sin(v.y * 1.4 + n * 4) * 0.035;
      const k = 1 + (n - 0.5) * 0.32 * (0.4 + yN) + strata;
      p.setXYZ(i, v.x * k, v.y, v.z * k);
    }
    g.computeVertexNormals();
    // Glow climbs the walls from the bottom.
    const grad = makeCanvas(4, 256);
    const ctx = grad.getContext('2d');
    const lg = ctx.createLinearGradient(0, 0, 0, 256);
    lg.addColorStop(0, '#000000');
    lg.addColorStop(0.35, '#200400');
    lg.addColorStop(0.75, '#5a1600');
    lg.addColorStop(1, '#a03008');
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, 4, 256);
    const gradTex = new THREE.CanvasTexture(grad);
    gradTex.colorSpace = THREE.SRGBColorSpace;
    // The rock texture tiles around and down the shaft (one copy stretched
    // over 46 m read as vertical metal ribs).
    const wallMap = this.stoneTex.map.clone();
    wallMap.repeat.set(10, 9);
    wallMap.needsUpdate = true;
    const wall = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ map: wallMap, color: 0x3a3030, roughness: 1, metalness: 0, side: THREE.BackSide, emissive: 0xffffff, emissiveMap: gradTex }),
    );
    wall.position.y = -depth / 2 + 0.2;
    this.group.add(wall);

    // Big soft glows inside the hole read as heat haze from any angle and are
    // hidden by the funnel walls everywhere else.
    // (Seen from above only: hidden once you fall in, see falling().)
    this.topGlows = [];
    for (const [y, size, op] of [[-5, 15, 0.55], [-16, 11, 0.7], [-30, 8, 0.9]]) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: 0xff4a12, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      glow.position.y = y;
      glow.scale.set(size, size, 1);
      this.group.add(glow);
      this.topGlows.push(glow);
    }

    this._shaft(depth);

    this.abyssMat = abyssMaterial();
    const abyss = new THREE.Mesh(new THREE.CircleGeometry(9, 48), this.abyssMat);
    abyss.rotation.x = -Math.PI / 2;
    abyss.position.y = -SHAFT_BOTTOM + 0.5;
    this.group.add(abyss);

    // Fake volumetric shaft of heat light rising out of the hole.
    const shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uPulse: { value: 1 } },
      vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vV; uniform float uTime; uniform float uPulse;
        void main(){
          float rim = pow(1.0 - abs(dot(vN, vV)), 1.5);
          float fade = smoothstep(1.0, 0.25, vUv.y) * smoothstep(0.0, 0.15, vUv.y);
          float flick = 0.85 + 0.15 * sin(vUv.y * 9.0 - uTime * 2.0);
          vec3 c = vec3(1.0, 0.28, 0.05) * (1.0 - rim) * fade * flick * 0.22 * uPulse;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.shaftMat = shaftMat;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 3.0, 30, 32, 1, true), shaftMat);
    shaft.position.y = -15.5;
    this.group.add(shaft);
    this.topGlows.push(shaft);
  }

  // Below the funnel the hole opens into a cavern shaft: ragged rock walls
  // that widen and pinch, ledges of rock jutting in, seams of lava glowing
  // through the walls, and the furnace light far below.
  _shaft(top) {
    const depth = SHAFT_BOTTOM - top + 4;
    const g = new THREE.CylinderGeometry(1, 1, depth, 64, 90, true);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const a = Math.atan2(v.z, v.x);
      const y = v.y;
      const n = fbm2(a * 2.2 + 11, y * 0.06, 4, 21);
      const n2 = fbm2(a * 6 + 3, y * 0.2, 3, 23);
      // Chambers and throats: the radius breathes with depth.
      const r = 5.5 + 3.5 * Math.sin(y * 0.045 + 1.3) + (n - 0.5) * 6 + (n2 - 0.5) * 1.6;
      p.setXYZ(i, Math.cos(a) * r, y, Math.sin(a) * r);
    }
    g.computeVertexNormals();
    const map = this.stoneTex.map.clone();
    map.repeat.set(8, 40);
    map.needsUpdate = true;
    const veins = emberVeinTexture(41, [255, 80, 20], 10).clone();
    veins.repeat.set(5, 22);
    veins.needsUpdate = true;
    const wall = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ map, color: 0x4a3a36, roughness: 1, metalness: 0, side: THREE.BackSide, emissive: 0xffffff, emissiveMap: veins, emissiveIntensity: 0.85 }),
    );
    wall.position.y = -top - depth / 2 + 2;
    this.group.add(wall);
    // Rock ledges jutting into the shaft, to rush past.
    const r = this.rand;
    const rock = new THREE.IcosahedronGeometry(1, 1);
    const rockMat = new THREE.MeshStandardMaterial({ map: this.stoneTex.map, color: 0x3a2e2a, roughness: 1 });
    const n = 26;
    const ledges = new THREE.InstancedMesh(rock, rockMat, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const y = -top - 8 - (i / n) * (SHAFT_BOTTOM - top - 20);
      const a = r() * Math.PI * 2;
      const rad = 4.5 + r() * 2.5;
      q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
      m.compose(new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad), q, new THREE.Vector3(1.5 + r() * 2, 0.8 + r(), 1.5 + r() * 2));
      ledges.setMatrixAt(i, m);
    }
    ledges.instanceMatrix.needsUpdate = true;
    this.group.add(ledges);
    // Pools of furnace light down the shaft.
    for (let i = 0; i < 6; i++) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: 0xff3a0a, transparent: true, opacity: 0.12 + i * 0.03, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      glow.position.y = -top - 25 - i * ((SHAFT_BOTTOM - top - 30) / 6);
      glow.scale.set(6, 6, 1);
      this.group.add(glow);
    }
  }

  _rimShards() {
    const r = this.rand;
    const geo = new THREE.ConeGeometry(1, 1, 5, 3);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setX(i, p.getX(i) * (0.8 + ((i * 37) % 7) / 14));
      p.setZ(i, p.getZ(i) * (0.8 + ((i * 53) % 5) / 10));
    }
    geo.computeVertexNormals();
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + r() * 0.1;
      // Leave the stair approach on the south side clear.
      if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.28) continue;
      const rad = PIT_RADIUS + 0.3 + r() * 2.2;
      const h = 1.2 + r() * 3.8 * (rad < PIT_RADIUS + 1.2 ? 1.3 : 0.8);
      const gen = Assets.instanceProp('shard');
      const s = gen || new THREE.Mesh(geo, this.darkStone);
      const sx = 0.35 + r() * 0.6;
      const sz = 0.35 + r() * 0.5;
      if (gen) s.scale.multiplyScalar(h / 4);
      else s.scale.set(sx, h, sz);
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      s.position.set(x, this.heightAt(x, z) + (gen ? -0.3 : h * 0.35), z);
      // Lean inward over the hole like broken teeth. 'ZXY' spins the shard
      // about its own axis first, then tilts it toward the centre.
      const lean = 0.25 + r() * 0.5;
      s.rotation.set(-Math.sin(a) * lean, r() * 6, Math.cos(a) * lean, 'ZXY');
      this.group.add(s);
    }
  }

  _column(x, z, h, broken = true) {
    const gen = Assets.instanceProp('column');
    if (gen) {
      gen.scale.multiplyScalar(h / 5);
      gen.position.set(x, this.heightAt(x, z) - 0.15, z);
      gen.rotation.y = this.rand() * 6;
      this.group.add(gen);
      this.circles.push({ x, z, r: 0.8 });
      return gen;
    }
    const g = new THREE.Group();
    const shaftGeo = new THREE.CylinderGeometry(0.55, 0.62, h, 24, 4);
    if (broken) {
      const p = shaftGeo.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > h / 2 - 0.01) p.setY(i, p.getY(i) - this.rand() * 0.7);
      shaftGeo.computeVertexNormals();
    }
    const shaft = new THREE.Mesh(shaftGeo, this.stone);
    shaft.position.y = h / 2 + 0.4;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.6), this.darkStone);
    base.position.y = 0.2;
    g.add(shaft, base);
    if (!broken) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 1.5), this.darkStone);
      cap.position.y = h + 0.6;
      g.add(cap);
    }
    g.position.set(x, this.heightAt(x, z) - 0.15, z);
    g.rotation.y = this.rand() * 6;
    this.group.add(g);
    this.circles.push({ x, z, r: 0.8 });
    return g;
  }

  _wall(x, z, len, h, rotY) {
    // What is left of a wall: broken columns and slabs of layered rock along
    // its line (stacked blocks only without those models).
    if (Assets.hasProp('column') && Assets.hasProp('slab')) {
      const c = Math.cos(rotY);
      const sn = Math.sin(rotY);
      const n = Math.max(2, Math.round(len / 2.2));
      for (let i = 0; i < n; i++) {
        const lx = -len / 2 + (len * (i + 0.5)) / n + (this.rand() - 0.5) * 0.6;
        const px = x + c * lx;
        const pz = z - sn * lx;
        const column = i % 2 === 0 || this.rand() < 0.3;
        const o = Assets.instanceProp(column ? 'column' : 'slab');
        const hh = h * (0.45 + this.rand() * 0.55) * (i === 0 || i === n - 1 ? 0.7 : 1);
        o.scale.multiplyScalar(column ? hh / 5.5 : hh / 3);
        o.position.set(px, this.heightAt(px, pz) - 0.15, pz);
        o.rotation.set((this.rand() - 0.5) * 0.08, rotY + this.rand() * Math.PI * 2, (this.rand() - 0.5) * 0.08);
        this.group.add(o);
        this.circles.push({ x: px, z: pz, r: column ? 0.8 : 1.0 });
        if (!column) this._hide(px, pz, 1.5);
      }
      return;
    }
    const g = new THREE.Group();
    const blocks = Math.ceil(len / 1.2);
    for (let i = 0; i < blocks; i++) {
      const bh = h * (0.35 + this.rand() * 0.65) * (i === 0 || i === blocks - 1 ? 0.6 : 1);
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.2, bh, 0.9), this.stone);
      b.position.set(-len / 2 + i * 1.2 + 0.6, bh / 2, 0);
      b.rotation.y = (this.rand() - 0.5) * 0.06;
      g.add(b);
    }
    g.position.set(x, this.heightAt(x, z) - 0.1, z);
    g.rotation.y = rotY;
    this.group.add(g);
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    for (let k = 0; k <= len; k += 1.1) {
      const lx = -len / 2 + k;
      this.circles.push({ x: x + c * lx, z: z - s * lx, r: 0.6 });
    }
  }

  _ruins() {
    const r = this.rand;
    // An outer ring of ruined colonnades, broken walls and scattered blocks.
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.2;
      if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.35) continue;
      const rad = 15 + r() * 3;
      this._column(Math.cos(a) * rad, Math.sin(a) * rad, 2 + r() * 5, r() > 0.25);
      this._hide(Math.cos(a) * rad, Math.sin(a) * rad, 1.4);
    }
    const walls = [
      [-17, -10, 8, 3.5, 0.9],
      [16, -12, 7, 4.2, -0.8],
      [-21, 6, 6, 2.8, 1.7],
      [22, 7, 9, 3.6, -1.5],
      [-6, -23, 10, 4.5, 0.1],
      [9, -22, 6, 3, -0.3],
    ];
    for (const w of walls) this._wall(...w);

    // Fallen columns and loose blocks. The walk from where you wake through
    // the gate to the pit stays clear: nothing within it, end to end.
    const onPath = (px, pz, pad = 0) => Math.abs(px) < 3.5 + pad && pz > 6;
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      const rad = 11 + r() * 14;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (onPath(x, z)) continue;
      const len = 3 + r() * 3;
      const yaw = r() * 6;
      // (A toppled column runs `len` along its yaw: test both ends too.)
      const ex = Math.cos(yaw) * len * 0.5;
      const ez = -Math.sin(yaw) * len * 0.5;
      if (onPath(x + ex, z + ez, 0.8) || onPath(x - ex, z - ez, 0.8)) continue;
      const gen = Assets.instanceProp('column');
      if (gen) {
        // A broken column toppled over, half sunk in the ash.
        const lie = new THREE.Group();
        gen.rotation.z = Math.PI / 2;
        gen.position.set(len * 0.5, 0, 0);
        lie.add(gen);
        lie.rotation.y = yaw;
        lie.position.set(x - Math.cos(yaw) * len * 0.5, this.heightAt(x, z) + 0.2, z + Math.sin(yaw) * len * 0.5);
        this.group.add(lie);
      } else {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, len, 24), this.stone);
        c.rotation.set(0, r() * 6, Math.PI / 2);
        c.position.set(x, this.heightAt(x, z) + 0.35, z);
        this.group.add(c);
      }
      this.circles.push({ x, z, r: 0.9 });
      // Alongside it (square to its length), on the side away from you.
      const side = Math.sin(yaw) * (x - this.spawn.x) + Math.cos(yaw) * (z - this.spawn.z) > 0 ? 1 : -1;
      this._hideAt(x + Math.sin(yaw) * 1.2 * side, z + Math.cos(yaw) * 1.2 * side);
    }
    const blockGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2;
      const rad = 10 + r() * 22;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (onPath(x, z)) continue;
      const s = 0.3 + r() * 0.8;
      // Boulders and the odd jagged shard (plain blocks only without them).
      const shard = r() < 0.25;
      const gen = Assets.instanceProp(shard ? 'shard' : 'rock');
      if (gen) {
        gen.scale.multiplyScalar(shard ? (s * 1.6) / 4 : (s * 1.5) / 2.6);
        gen.position.set(x, this.heightAt(x, z) - s * 0.15, z);
        gen.rotation.set((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5);
        this.group.add(gen);
      } else {
        const b = new THREE.Mesh(blockGeo, r() > 0.5 ? this.stone : this.darkStone);
        b.scale.set(s * (1 + r()), s, s * (1 + r() * 0.5));
        b.position.set(x, this.heightAt(x, z) + s * 0.3, z);
        b.rotation.set(r() * 0.4, r() * 6, r() * 0.4);
        this.group.add(b);
      }
      if (s > 0.7) this.circles.push({ x, z, r: s * 0.7 });
    }
    // Gravestones near the gate.
    for (let i = 0; i < 9; i++) {
      const x = (i % 2 ? 1 : -1) * (5 + r() * 9);
      const z = 15 + r() * 12;
      const h = 0.8 + r() * 0.6;
      const gen = Assets.instanceProp('gravestone');
      const g = gen || new THREE.Mesh(new THREE.BoxGeometry(0.6, h, 0.18), this.darkStone);
      if (gen) gen.scale.multiplyScalar(h / 1.2);
      g.position.set(x, this.heightAt(x, z) + (gen ? -0.1 : h / 2 - 0.1), z);
      g.rotation.set((r() - 0.5) * 0.3, r() * 0.6 - 0.3, (r() - 0.5) * 0.3);
      this.group.add(g);
      this.circles.push({ x, z, r: 0.4 });
      this._hide(x, z, 0.9);
    }
  }

  _deadTrees() {
    const bark = new THREE.MeshStandardMaterial({ color: 0x120c0a, roughness: 1 });
    const r = this.rand;
    const spots = [[-12, 18], [14, 16], [-25, -4], [26, -6], [-9, -28], [19, 24]];
    for (const [x, z] of spots) {
      const h = 4 + r() * 3;
      const gen = Assets.instanceProp('tree');
      if (gen) {
        gen.scale.multiplyScalar(h / 6);
        gen.position.set(x, this.heightAt(x, z) - 0.1, z);
        gen.rotation.y = r() * 6;
        this.group.add(gen);
        this.circles.push({ x, z, r: 0.5 });
        this._hide(x, z, 1.0);
        continue;
      }
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.35, h, 7), bark);
      trunk.position.y = h / 2;
      trunk.rotation.z = (r() - 0.5) * 0.2;
      tree.add(trunk);
      for (let b = 0; b < 6; b++) {
        const len = 1 + r() * 2;
        const br = new THREE.Mesh(new THREE.ConeGeometry(0.08, len, 5), bark);
        const y = h * (0.45 + r() * 0.5);
        const a = r() * Math.PI * 2;
        br.position.set(Math.cos(a) * len * 0.35, y, Math.sin(a) * len * 0.35);
        br.rotation.set(Math.sin(a) * 1.1, 0, -Math.cos(a) * 1.1);
        tree.add(br);
      }
      tree.position.set(x, this.heightAt(x, z) - 0.1, z);
      this.group.add(tree);
      this.circles.push({ x, z, r: 0.5 });
    }
  }

  _gate() {
    // A gateway frames the first view of the pit: the horned hell-gate the
    // floors below end in, here standing open in the ash (two stone piers
    // and a lintel only without its model).
    const z = 19;
    const horned = Assets.hasProp('gate');
    if (horned) {
      const SCALE = 1.55;
      const gate = Assets.instanceProp('gate');
      gate.scale.multiplyScalar(SCALE);
      // Its front (the skulls, -X) toward you as you come, the arch across.
      gate.rotation.y = Math.PI / 2;
      gate.position.set(0, this.heightAt(0, z) - 0.1, z);
      this.group.add(gate);
      const W = Assets.props.get('gate').entry.size * SCALE * 0.42;
      for (const s of [-1, 1]) this.circles.push({ x: s * (W / 2 + 1.0), z, r: 1.1 });
    }
    for (const s of [-1, 1]) {
      if (!horned) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(1.3, 6.5, 1.3), this.stone);
        p.position.set(s * 3, 3.1 + this.heightAt(s * 3, z), z);
        this.group.add(p);
        this.circles.push({ x: s * 3, z, r: 1.0 });
      }
      // Braziers either side.
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.3, 0.4, 28, 1, true), new THREE.MeshStandardMaterial({ color: 0x221e1c, metalness: 0.8, roughness: 0.5 }));
      bowl.position.set(s * 4.6, 1.3 + this.heightAt(s * 4.6, z - 1), z - 1);
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.2, 14), bowl.material);
      stand.position.set(s * 4.6, 0.6 + this.heightAt(s * 4.6, z - 1), z - 1);
      const gen = Assets.instanceProp('brazier');
      if (gen) {
        gen.position.set(s * 4.6, this.heightAt(s * 4.6, z - 1), z - 1);
        this.group.add(gen);
      } else this.group.add(bowl, stand);
      this.circles.push({ x: s * 4.6, z: z - 1, r: 0.5 });
      this.braziers = this.braziers || [];
      const coals = new THREE.Vector3(s * 4.6, (gen ? 1.08 : 1.42) + this.heightAt(s * 4.6, z - 1), z - 1);
      this.braziers.push(coals);
      const flame = makeFlame({ height: 1.25, seed: s + 4 });
      flame.position.copy(coals);
      this.group.add(flame);
      this.flames = this.flames || [];
      this.flames.push(flame);
    }
    if (horned) return;
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.9, 1.4), this.darkStone);
    lintel.position.set(-0.3, 6.6 + this.heightAt(0, z), z);
    lintel.rotation.z = 0.08;
    this.group.add(lintel);
  }

  _obelisk() {
    const x = 6.5;
    const z = 22.5;
    const g = new THREE.Group();
    // A cracked black obelisk carved with glowing runes, the week's deepest
    // inscribed on an iron-framed tablet bolted to its face (a plain stone
    // block and cap only without its model).
    let face = 0.36;
    let at = 2.4;
    const gen = Assets.instanceProp('obelisk');
    if (gen) {
      gen.scale.multiplyScalar(5.2 / 3.6);
      g.add(gen);
      g.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gen);
      face = box.max.z + 0.04;
      at = Math.min(2.5, box.max.y * 0.5);
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 4.4, 0.7), this.darkStone);
      body.position.y = 2.2;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.0, 4), this.darkStone);
      tip.position.y = 4.9;
      tip.rotation.y = Math.PI / 4;
      tip.scale.set(1, 1, 0.45);
      g.add(body, tip);
    }
    this.plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.0), plaqueMaterial());
    this.plaque.position.set(0, at, face);
    g.add(this.plaque);
    g.position.set(x, this.heightAt(x, z) - 0.1, z);
    // The tablet (on its plain face, the runes on its broad sides) turned
    // to where you wake, so the scores read straight on.
    g.rotation.y = Math.atan2(this.spawn.x - x, this.spawn.z - z);
    this.group.add(g);
    this.circles.push({ x, z, r: 1.1 });
    // Round its back, away from the tablet.
    this.hides.push({ x: x - Math.sin(g.rotation.y) * 1.5, z: z - Math.cos(g.rotation.y) * 1.5 });
  }

  // A hiding place in the lee of something at (x, z): on its far side from
  // where you wake, `off` metres out (kept off the path and out of the pit).
  _hide(x, z, off) {
    const dx = x - this.spawn.x;
    const dz = z - this.spawn.z;
    const l = Math.hypot(dx, dz) || 1;
    this._hideAt(x + (dx / l) * off, z + (dz / l) * off);
  }

  _hideAt(hx, hz) {
    const r = Math.hypot(hx, hz);
    if (r < PIT_RADIUS + 3.5 || r > LOT_RADIUS - 3) return;
    if (Math.abs(hx) < 4 && hz > 6) return;
    if (Math.hypot(hx - this.spawn.x, hz - this.spawn.z) < 7) return;
    if (this.hides.some((h) => Math.hypot(h.x - hx, h.z - hz) < 2.5)) return;
    this.hides.push({ x: hx, z: hz });
  }

  // The surface's secret: a reliquary half buried in the ash, somewhere new
  // each time you stand here (placeSecret). From afar only a spark now and
  // then gives it away; come close and embers glow through its seams and
  // something whispers. Dig it up (F) for a relic to carry down.
  _reliquary() {
    const g = new THREE.Group();
    const box = Assets.instanceProp('chest');
    if (box) {
      box.scale.multiplyScalar(0.62);
      // Sunk to its lid, tipped as the ash took it.
      box.position.y = -0.32;
      box.rotation.set(0.16, 0, -0.12);
      g.add(box);
    } else {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.55), this.darkStone);
      b.position.y = -0.05;
      b.rotation.set(0.16, 0, -0.12);
      g.add(b);
    }
    for (let i = 0; i < 3; i++) {
      const sk = Assets.instanceProp('skulls');
      if (!sk) break;
      sk.scale.multiplyScalar(0.28);
      const a = i * 2.1 + 0.4;
      sk.position.set(Math.cos(a) * 0.75, -0.06, Math.sin(a) * 0.6);
      sk.rotation.y = a * 1.7;
      g.add(sk);
    }
    const dot = softDotTexture();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(1.7);
    glow.position.y = 0.3;
    g.add(glow);
    g.visible = false;
    this.group.add(g);
    this.secret = { group: g, glow, x: 0, z: 0, k: 0, t: 0, found: false, near: false, woke: false, last: -1 };
  }

  // A new hiding place for this visit (never the last one).
  placeSecret() {
    const S = this.secret;
    // (Not inside anything solid: some of it was placed after the spot.)
    if (!this.hidesChecked) {
      this.hidesChecked = true;
      this.hides = this.hides.filter((h) => !this.circles.some((c) => Math.hypot(c.x - h.x, c.z - h.z) < c.r + 0.2));
    }
    if (!S || !this.hides.length) return;
    let i = Math.floor(Math.random() * this.hides.length);
    if (i === S.last && this.hides.length > 1) i = (i + 1 + Math.floor(Math.random() * (this.hides.length - 1))) % this.hides.length;
    S.last = i;
    const h = this.hides[i];
    S.x = h.x;
    S.z = h.z;
    S.k = 0;
    S.found = false;
    S.near = false;
    S.woke = false;
    S.group.position.set(h.x, this.heightAt(h.x, h.z), h.z);
    S.group.rotation.y = Math.random() * Math.PI * 2;
    S.group.visible = true;
  }

  hideSecret() {
    if (this.secret) this.secret.group.visible = false;
  }

  updateSecret(dt, ctx) {
    const S = this.secret;
    if (!S?.group.visible) return;
    S.t += dt;
    const p = ctx.player.position;
    const d = Math.hypot(p.x - S.x, p.z - S.z);
    const y = S.group.position.y;
    if (!S.found) {
      if (d < 8 && !S.woke) {
        S.woke = true;
        ctx.audio?.play?.('echo', { pos: new THREE.Vector3(S.x, y + 0.5, S.z), volume: 0.6, rate: 0.7, gap: 1 });
      }
      S.k = Math.max(0, Math.min(1, S.k + (d < 8 ? dt / 1.5 : -dt / 2)));
      // Far off, only a spark now and then.
      if (Math.random() < dt * (0.7 + 6 * S.k)) {
        const a = Math.random() * Math.PI * 2;
        ctx.fx.add.emit({ x: S.x + Math.cos(a) * 0.3, y: y + 0.15, z: S.z + Math.sin(a) * 0.3, vy: 0.7 + Math.random() * 0.6, life: 1.4, size: 0.05 + 0.03 * S.k, color: C.spark, colorEnd: C.emberRed, turbulence: 1.4 });
      }
    } else S.k = Math.max(0, S.k - dt / 0.8);
    const flick = 0.75 + 0.25 * Math.sin(S.t * 5.3) * Math.sin(S.t * 3.1 + 1);
    S.glow.material.opacity = 0.55 * S.k * flick;
    S.near = !S.found && d < 2.1 && !ctx.player.dead;
  }

  // Dug up: the relic it held (the caller gives it to the run).
  takeSecret(ctx) {
    const S = this.secret;
    S.found = true;
    S.near = false;
    const at = new THREE.Vector3(S.x, S.group.position.y + 0.3, S.z);
    burst(ctx.fx.add, at, { count: 60, speed: 3.5, color: C.spark, colorEnd: C.fireEdge, size: 0.1, life: 1.2, gravity: -2 });
    burst(ctx.fx.alpha, at, { count: 26, speed: 1.6, color: C.smoke, colorEnd: C.smoke, size: 0.7, life: 1.4, gravity: -0.5 });
    ctx.shake?.(0.15);
  }

  // The obelisk carries the week's deepest descents (each with the time it
  // took) and your own. `rows`: [{ name, floor, time }] best first; `mine`:
  // { floor, time } or null; `last`: the floor your last descent ended on.
  setScores({ rows = [], mine = null, last = 0 } = {}) {
    const sig = JSON.stringify([rows, mine, last]);
    if (sig === this.scoreSig) return;
    this.scoreSig = sig;
    const old = this.plaque.material.map;
    this.plaque.material.map = scoreTablet({ rows, mine, last });
    this.plaque.material.needsUpdate = true;
    old?.dispose();
  }

  _fog() {
    // Dense, slowly churning fog banks clinging to the pit's edge, plus a
    // thinner layer drifting across the whole lot.
    const tex = fogPuffTexture(11);
    this.fogSprites = [];
    const r = this.rand;
    // (Fewer, bigger banks: each is a full-screen layer of overdraw up close.)
    for (let i = 0; i < 36; i++) {
      const inner = i < 24;
      const a = r() * Math.PI * 2;
      const rad = inner ? PIT_RADIUS - 1 + r() * 7 : 12 + r() * 22;
      const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: inner ? 0.3 : 0.2, color: 0x2a1c1a });
      const s = new THREE.Sprite(m);
      const size = inner ? 8 + r() * 8 : 13 + r() * 10;
      s.scale.set(size, size * 0.55, 1);
      const y = inner ? 0.4 + r() * 2.2 : 0.6 + r() * 1.5;
      s.position.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
      this.group.add(s);
      this.fogSprites.push({ s, a, rad, y, speed: (r() - 0.5) * 0.06, inner, phase: r() * 10 });
    }
  }

  _lights() {
    this.hemi = new THREE.HemisphereLight(0x2c2a3a, 0x0a0303, 0.7);
    this.moon = new THREE.DirectionalLight(0x8090c0, 1.1);
    this.moon.position.set(-30, 40, 20);
    this.pitLight = new THREE.PointLight(0xff2a08, 90, 26, 1.6);
    this.pitLight.position.set(0, -2.5, 0);
    this.pitLight2 = new THREE.PointLight(0xff5a10, 40, 16, 1.7);
    this.pitLight2.position.set(0, 1.5, 0);
    this.braziersLights = this.braziers.map((b) => {
      const l = new THREE.PointLight(0xff7a30, 10, 12, 1.6);
      l.position.copy(b).add(new THREE.Vector3(0, 0.8, 0));
      return l;
    });
    this.group.add(this.hemi, this.moon, this.pitLight, this.pitLight2, ...this.braziersLights);
  }

  // Inside the hole the glows meant to be seen from above would fill the
  // screen: turn them off for the fall, and light the shaft from below.
  falling(on) {
    for (const g of this.topGlows) g.visible = !on;
    this.pitLight.position.y = on ? -SHAFT_BOTTOM + 20 : -2.5;
    this.pitLight.distance = on ? 120 : 26;
  }

  inPit(pos) {
    return Math.hypot(pos.x, pos.z) < FALL_RADIUS;
  }

  nearPit(pos) {
    return Math.hypot(pos.x, pos.z) < PIT_RADIUS + 3.5;
  }

  update(dt, fx) {
    this.time += dt;
    const t = this.time;
    // The depths breathe: a slow heartbeat with a flicker on top.
    const beat = Math.pow(Math.max(0, Math.sin(t * 1.4)), 6) * 0.6 + Math.pow(Math.max(0, Math.sin(t * 1.4 - 0.5)), 8) * 0.35;
    const pulse = 0.65 + beat + Math.sin(t * 13) * 0.04;
    this.pitLight.intensity = 90 * pulse;
    this.pitLight2.intensity = 40 * pulse;
    this.hemi.color.setRGB(0.17 + beat * 0.12, 0.16, 0.22);
    this.groundMat.emissiveIntensity = 0.7 + beat * 0.8;
    this.abyssMat.uniforms.uTime.value = t;
    this.shaftMat.uniforms.uTime.value = t;
    this.shaftMat.uniforms.uPulse.value = pulse;
    this.skyMat.uniforms.uTime.value = t;
    for (const l of this.braziersLights) l.intensity = 10 * (0.85 + Math.sin(t * 11 + l.position.x) * 0.1);

    for (const f of this.fogSprites) {
      f.a += f.speed * dt;
      f.s.position.x = Math.cos(f.a) * f.rad;
      f.s.position.z = Math.sin(f.a) * f.rad;
      f.s.position.y = f.y + Math.sin(t * 0.3 + f.phase) * 0.3;
      if (f.inner) {
        // Lit from below by the pit.
        const k = Math.max(0, 1 - (f.rad - PIT_RADIUS + 1) / 8) * pulse;
        f.s.material.color.setRGB(0.12 + k * 0.2, 0.09 + k * 0.03, 0.09 + k * 0.01);
      }
    }

    // Embers stream up out of the hole.
    const add = fx.add;
    const n = Math.floor(dt * 110 + Math.random());
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * (PIT_RADIUS - 0.8);
      add.emit({
        x: Math.cos(a) * rr,
        y: -6 + Math.random() * 5,
        z: Math.sin(a) * rr,
        vx: (Math.random() - 0.5) * 0.6,
        vy: 2 + Math.random() * 3,
        vz: (Math.random() - 0.5) * 0.6,
        life: 3 + Math.random() * 3,
        size: 0.06 + Math.random() * 0.1,
        sizeEnd: 0.02,
        color: C.emberHot,
        colorEnd: C.emberRed,
        drag: 0.15,
        turbulence: 2.5,
      });
    }
    for (const f of this.flames || []) f.userData.tick(this.time ?? performance.now() / 1000);
    // Sparks and a little smoke over the flames.
    for (const b of this.braziers) {
      if (Math.random() < dt * 9) add.emit({ x: b.x + (Math.random() - 0.5) * 0.4, y: b.y + 0.5, z: b.z + (Math.random() - 0.5) * 0.4, vx: (Math.random() - 0.5) * 0.6, vy: 1.8 + Math.random() * 1.8, vz: (Math.random() - 0.5) * 0.6, life: 1.2 + Math.random(), size: 0.05, sizeEnd: 0.01, color: C.emberHot, colorEnd: C.emberRed, drag: 0.4, turbulence: 2.5 });
      if (Math.random() < dt * 4) fx.alpha.emit({ x: b.x, y: b.y + 1.3, z: b.z, vy: 0.8, life: 2.5, size: 0.5, sizeEnd: 1.4, color: C.smoke, colorEnd: C.smoke, alpha: 0.35, drag: 0.2, turbulence: 0.6 });
    }
    // Ash drifting down across the lot.
    if (Math.random() < dt * 20) {
      fx.alpha.emit({ x: (Math.random() - 0.5) * 50, y: 12, z: (Math.random() - 0.5) * 50, vx: 0.4, vy: -0.6, life: 14, size: 0.08, color: C.smoke, colorEnd: C.smoke, alpha: 0.8, drag: 0, turbulence: 0.6 });
    }
  }
}

// The score tablet: a slab of dark iron in a riveted frame with spiked
// corners, a skull at its crown, the week's deepest descent engraved in
// molten gold and your own below a rule.
// The plaque's material: unlit, its picture sampled a little sharper than
// usual (a mip level finer), so the engraving still reads from a few
// paces back rather than going soft.
function plaqueMaterial() {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv, -0.8 )'));
  };
  m.customProgramCacheKey = () => 'plaque-sharp';
  return m;
}

// m:ss (h:mm:ss past the hour).
function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// The Hall of the Deepest: a dark basalt slab in a plain iron frame, the
// week's five deepest descents carved into it (who, how deep, how long it
// took), and your own beneath. Big, solid lettering with a dark edge (no
// wide glows): it has to read from across the clearing.
function scoreTablet({ rows, mine, last }) {
  const W = 1024;
  const H = 1280;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const serif = "Georgia, 'Times New Roman', serif";
  // Iron frame with cut corners.
  const cut = 56;
  const shape = (inset) => {
    const k = cut - inset * 0.6;
    g.beginPath();
    g.moveTo(inset + k, inset);
    g.lineTo(W - inset - k, inset);
    g.lineTo(W - inset, inset + k);
    g.lineTo(W - inset, H - inset - k);
    g.lineTo(W - inset - k, H - inset);
    g.lineTo(inset + k, H - inset);
    g.lineTo(inset, H - inset - k);
    g.lineTo(inset, inset + k);
    g.closePath();
  };
  const iron = g.createLinearGradient(0, 0, W, H);
  iron.addColorStop(0, '#4a3c36');
  iron.addColorStop(0.5, '#221a18');
  iron.addColorStop(1, '#100c0c');
  g.fillStyle = iron;
  shape(0);
  g.fill();
  // The basalt slab, warmed from below as if by the pit.
  const slab = g.createLinearGradient(0, 0, 0, H);
  slab.addColorStop(0, '#120807');
  slab.addColorStop(0.7, '#1a0907');
  slab.addColorStop(1, '#2a0d08');
  g.fillStyle = slab;
  shape(26);
  g.fill();
  // Grain in the stone.
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${0.1 + rnd() * 0.25})` : `rgba(150,60,30,${rnd() * 0.06})`;
    g.fillRect(40 + rnd() * (W - 80), 40 + rnd() * (H - 80), 1 + rnd() * 3, 1 + rnd() * 3);
  }
  // A single engraved border line.
  g.strokeStyle = '#7a3412';
  g.lineWidth = 5;
  shape(46);
  g.stroke();
  // Lettering: solid, warm, with a dark cut edge.
  const text = (t, x, y, { size = 48, color = '#f3d9a8', align = 'center', weight = '', ls = 0, max = W - 140 } = {}) => {
    g.font = `${weight}${size}px ${serif}`;
    if ('letterSpacing' in g) g.letterSpacing = `${ls}px`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    const wdt = g.measureText(t).width;
    const fit = Math.min(1, max / Math.max(1, wdt));
    g.save();
    g.translate(x, y);
    g.scale(fit, 1);
    g.lineJoin = 'round';
    g.lineWidth = Math.max(4, size * 0.12);
    g.strokeStyle = 'rgba(8,2,1,0.95)';
    g.strokeText(t, 0, 0);
    g.shadowColor = 'rgba(255,90,20,0.45)';
    g.shadowBlur = size * 0.18;
    g.fillStyle = color;
    g.fillText(t, 0, 0);
    g.restore();
    if ('letterSpacing' in g) g.letterSpacing = '0px';
  };
  const rule = (y, k = 1) => {
    const rg = g.createLinearGradient(110, 0, W - 110, 0);
    rg.addColorStop(0, 'rgba(255,120,30,0)');
    rg.addColorStop(0.5, `rgba(255,140,50,${0.85 * k})`);
    rg.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = rg;
    g.fillRect(110, y - 2, W - 220, 4);
  };
  // Header.
  text('HALL OF THE DEEPEST', W / 2, 124, { size: 64, weight: 'bold ', ls: 4, color: '#ffcf7a' });
  text('THIS WEEK', W / 2, 190, { size: 34, ls: 8, color: '#b07a54' });
  rule(232);
  // The five deepest: rank, name, then floor and time.
  const RANK = ['#ffd36a', '#e8e0d0', '#e0904a'];
  const top = rows.slice(0, 5);
  if (!top.length) {
    text('No soul has returned', W / 2, 420, { size: 54, color: '#e8c8a0' });
    text('yet', W / 2, 490, { size: 54, color: '#e8c8a0' });
  }
  top.forEach((r, k) => {
    const y = 300 + k * 128;
    const col = RANK[k] || '#c8a888';
    // Rank in a small diamond.
    g.save();
    g.translate(126, y + 6);
    g.rotate(Math.PI / 4);
    g.fillStyle = 'rgba(30,8,4,0.95)';
    g.strokeStyle = col;
    g.lineWidth = 5;
    g.fillRect(-30, -30, 60, 60);
    g.strokeRect(-30, -30, 60, 60);
    g.restore();
    text(String(k + 1), 126, y + 8, { size: 44, weight: 'bold ', color: col, max: 60 });
    text(String(r.name || 'Unknown').slice(0, 24), 196, y - 18, { size: k === 0 ? 58 : 52, align: 'left', color: k === 0 ? '#fff0cc' : '#f0dcc0', max: 620 });
    text(`FLOOR ${r.floor}`, 196, y + 34, { size: 36, align: 'left', ls: 3, color: col, max: 330 });
    text(r.time ? clock(r.time) : '-', W - 110, y + 34, { size: 40, align: 'right', color: r.time ? '#f3d9a8' : '#7a5a44', max: 260 });
  });
  // Your own.
  rule(H - 300, 0.7);
  text('YOUR DEEPEST', W / 2, H - 244, { size: 38, ls: 6, color: '#b07a54' });
  const mineLine = mine?.floor ? `Floor ${mine.floor}${mine.time ? `  ·  ${clock(mine.time)}` : ''}` : 'none yet';
  text(mineLine, W / 2, H - 172, { size: 66, weight: 'bold ', color: '#ffcf7a' });
  if (last) text(`Last descent ended on floor ${last}`, W / 2, H - 98, { size: 36, color: '#c89a70' });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}
