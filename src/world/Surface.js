import * as THREE from 'three';
import { CollisionWorld } from '../physics/CollisionWorld.js';
import { rockTextures, fogPuffTexture, emberVeinTexture, softDotTexture, makeCanvas } from './Textures.js';
import { makeFlame, abyssMaterial } from './Shaders.js';
import { C, spawnFlame } from './Particles.js';
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

    // Fallen columns and loose blocks.
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      const rad = 11 + r() * 14;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (Math.abs(x) < 3 && z > 8) continue;
      const len = 3 + r() * 3;
      const gen = Assets.instanceProp('column');
      if (gen) {
        // A broken column toppled over, half sunk in the ash.
        gen.scale.multiplyScalar(len / 5.5);
        const yaw = r() * 6;
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
    }
    const blockGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2;
      const rad = 10 + r() * 22;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (Math.abs(x) < 3 && z > 8) continue;
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
    this.plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.9), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
    this.plaque.position.set(0, at, face);
    g.add(this.plaque);
    g.position.set(x, this.heightAt(x, z) - 0.1, z);
    // The tablet (on its plain face, the runes on its broad sides) turned
    // to where you wake, so the scores read straight on.
    g.rotation.y = Math.atan2(this.spawn.x - x, this.spawn.z - z);
    this.group.add(g);
    this.circles.push({ x, z, r: 1.1 });
  }

  // The obelisk carries the week's deepest descent and your own.
  setScores({ best = 0, last = 0, top = null } = {}) {
    const old = this.plaque.material.map;
    this.plaque.material.map = scoreTablet({ best, last, top });
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
function scoreTablet({ best, last, top }) {
  const W = 480;
  const H = 608;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const serif = "Georgia, 'Times New Roman', serif";
  // The frame: a dark iron border, bevelled, with a spike at each corner.
  const frame = g.createLinearGradient(0, 0, W, H);
  frame.addColorStop(0, '#5a4a44');
  frame.addColorStop(0.5, '#2a201e');
  frame.addColorStop(1, '#141010');
  g.fillStyle = frame;
  g.beginPath();
  const cut = 34;
  g.moveTo(cut, 0);
  g.lineTo(W - cut, 0);
  g.lineTo(W, cut);
  g.lineTo(W, H - cut);
  g.lineTo(W - cut, H);
  g.lineTo(cut, H);
  g.lineTo(0, H - cut);
  g.lineTo(0, cut);
  g.closePath();
  g.fill();
  // The slab inside, scorched toward its edges.
  const inset = 30;
  const slab = g.createRadialGradient(W / 2, H * 0.42, 20, W / 2, H / 2, H * 0.7);
  slab.addColorStop(0, '#2c0e08');
  slab.addColorStop(0.6, '#160605');
  slab.addColorStop(1, '#080202');
  g.fillStyle = slab;
  g.fillRect(inset, inset, W - inset * 2, H - inset * 2);
  g.strokeStyle = '#8a3a14';
  g.lineWidth = 3;
  g.strokeRect(inset + 8, inset + 8, W - (inset + 8) * 2, H - (inset + 8) * 2);
  g.strokeStyle = 'rgba(255,120,40,0.35)';
  g.lineWidth = 1;
  g.strokeRect(inset + 14, inset + 14, W - (inset + 14) * 2, H - (inset + 14) * 2);
  // Rivets round the frame.
  for (let i = 0; i < 6; i++) {
    for (const [x, y] of [[14 + ((W - 28) * i) / 5, 15], [14 + ((W - 28) * i) / 5, H - 15], [15, 14 + ((H - 28) * i) / 5], [W - 15, 14 + ((H - 28) * i) / 5]]) {
      const rv = g.createRadialGradient(x - 2, y - 2, 0, x, y, 6);
      rv.addColorStop(0, '#d8c8b8');
      rv.addColorStop(1, '#3a2a24');
      g.fillStyle = rv;
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
    }
  }
  // A skull at its crown.
  g.save();
  g.translate(W / 2, inset + 52);
  g.fillStyle = '#d8c4a4';
  g.shadowColor = 'rgba(255,90,20,0.8)';
  g.shadowBlur = 14;
  g.beginPath();
  g.arc(0, -4, 20, Math.PI, 0);
  g.lineTo(14, 16);
  g.lineTo(-14, 16);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  g.fillStyle = '#ff6a1a';
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.arc(sx * 8, 0, 5.5, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  // The engraving: gold that glows like metal fresh from the forge.
  const gold = (text, y, size, opts = {}) => {
    g.font = `${opts.bold ? 'bold ' : ''}${size}px ${serif}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const fit = Math.min(1, (W - inset * 2 - 40) / Math.max(1, g.measureText(text).width));
    g.save();
    g.translate(W / 2, y);
    g.scale(fit, 1);
    g.shadowColor = opts.glow || 'rgba(255,100,10,0.95)';
    g.shadowBlur = opts.blur ?? 18;
    const grad = g.createLinearGradient(0, -size / 2, 0, size / 2);
    grad.addColorStop(0, opts.top || '#fff2c4');
    grad.addColorStop(0.55, opts.mid || '#ffb347');
    grad.addColorStop(1, opts.bottom || '#c4560c');
    g.fillStyle = grad;
    g.fillText(text, 0, 0);
    g.restore();
  };
  const rule = (y) => {
    const rg = g.createLinearGradient(inset + 30, 0, W - inset - 30, 0);
    rg.addColorStop(0, 'rgba(255,120,30,0)');
    rg.addColorStop(0.5, 'rgba(255,140,40,0.9)');
    rg.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = rg;
    g.fillRect(inset + 30, y - 1, W - (inset + 30) * 2, 2);
    g.fillStyle = '#ffb347';
    g.beginPath();
    g.moveTo(W / 2, y - 6);
    g.lineTo(W / 2 + 6, y);
    g.lineTo(W / 2, y + 6);
    g.lineTo(W / 2 - 6, y);
    g.closePath();
    g.fill();
  };
  gold("THIS WEEK'S DEEPEST", inset + 112, 30, { blur: 10 });
  rule(inset + 136);
  gold(top ? `FLOOR ${top.score}` : 'NONE YET', inset + 205, top ? 78 : 56, { bold: true, blur: 26 });
  gold(top ? String(top.name).slice(0, 18) : 'no soul has returned', inset + 270, 34, { top: '#ffe6c8', mid: '#e8c8a0', bottom: '#a8805a', glow: 'rgba(200,80,10,0.7)', blur: 10 });
  rule(inset + 318);
  gold('YOUR DEEPEST', inset + 362, 24, { blur: 8 });
  gold(best ? `Floor ${best}` : 'none yet', inset + 404, 42, { bold: true, blur: 14 });
  if (last) gold(`Last descent: floor ${last}`, inset + 458, 26, { top: '#f0d8b8', mid: '#d0a878', bottom: '#8a6040', glow: 'rgba(160,60,10,0.6)', blur: 6 });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
