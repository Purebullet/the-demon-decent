import * as THREE from 'three';
import { CollisionWorld } from '../physics/CollisionWorld.js';
import { rockTextures, runeCircleTexture } from './Textures.js';
import { bloodMaterial, portalMaterial } from './Shaders.js';
import { C, spawnFlame } from './Particles.js';
import { mulberry32 } from '../core/rng.js';
import { Assets } from '../assets/AssetLibrary.js';

// The safe chamber between floors. No enemies, no healing: three altars, and
// you may wake only one of them before the way down opens.
//
//   The Blood Well     - max health or potion capacity
//   The Magic Circle   - learn or deepen a demon spell
//   The Burning Sigil  - weapon damage or attack speed

const R = 11;

export class Sanctum {
  constructor(nextFloor) {
    this.nextFloor = nextFloor;
    this.group = new THREE.Group();
    this.time = 0;
    this.chosen = null;
    this.portalOpen = false;
    this.portalT = 0;
    this.spawn = { x: 0, z: 8.5 };
    this.portalPos = new THREE.Vector3(0, 0, -7.5);
    const rr = mulberry32(nextFloor * 31);

    const { map, bump } = rockTextures(21, [56, 44, 42]);
    const floorMap = map.clone();
    floorMap.repeat.set(5, 5);
    floorMap.needsUpdate = true;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 1, 96), new THREE.MeshStandardMaterial({ map: floorMap, bumpMap: bump, bumpScale: 2, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    this.group.add(floor);

    // Ring of columns and rubble walls.
    const stone = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 3, roughness: 0.9, color: 0x9a8f88 });
    const circles = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const h = 5 + rr() * 3;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, h, 24), stone);
      col.position.set(Math.cos(a) * R, h / 2, Math.sin(a) * R);
      this.group.add(col);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(4.6, 9, 1.4), stone);
      const b = a + Math.PI / 16;
      wall.position.set(Math.cos(b) * (R + 0.9), 4.5, Math.sin(b) * (R + 0.9));
      wall.rotation.y = -b + Math.PI / 2;
      this.group.add(wall);
    }
    const dome = new THREE.Mesh(new THREE.SphereGeometry(R + 2, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0c0606, side: THREE.BackSide, roughness: 1 }));
    dome.position.y = 6;
    this.group.add(dome);

    // Candles for a little warmth.
    this.candles = [];
    const wax = new THREE.MeshStandardMaterial({ color: 0xd9ceb5, roughness: 0.6 });
    for (let i = 0; i < 22; i++) {
      const a = rr() * Math.PI * 2;
      const r = 8.5 + rr() * 1.8;
      const h = 0.15 + rr() * 0.35;
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 14), wax);
      c.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      this.group.add(c);
      this.candles.push(new THREE.Vector3(c.position.x, h + 0.05, c.position.z));
    }

    this.nodes = [this._bloodWell(-5.2, -1.8), this._magicCircle(0, -3), this._burningSigil(5.2, -1.8)];
    for (const n of this.nodes) circles.push({ x: n.pos.x, z: n.pos.z, r: n.radius });
    this._portal();

    this.world = new CollisionWorld({ circles, boundRadius: R - 0.6 });
    this.ambient = new THREE.HemisphereLight(0x553333, 0x100404, 0.7);
    this.group.add(this.ambient);
  }

  _node(key, x, z, color, radius) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    this.group.add(g);
    const light = new THREE.PointLight(color, 16, 9, 1.6);
    light.position.set(0, 2, 0);
    g.add(light);
    return { key, group: g, pos: new THREE.Vector3(x, 0, z), light, radius, baseLight: 16, alive: true };
  }

  _bloodWell(x, z) {
    const n = this._node('well', x, z, 0xff1a1a, 1.4);
    const stone = new THREE.MeshStandardMaterial({ color: 0x3a3230, roughness: 0.9 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.28, 18, 56), stone);
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.75;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.75, 56, 1, true), stone);
    wall.position.y = 0.37;
    this.wellMat = bloodMaterial();
    const blood = new THREE.Mesh(new THREE.CircleGeometry(1.0, 64), this.wellMat);
    blood.rotation.x = -Math.PI / 2;
    blood.position.y = 0.62;
    const gen = Assets.instanceProp('well');
    if (gen) {
      n.group.add(gen, blood);
      blood.position.y = 0.72;
      blood.scale.setScalar(0.9);
      return Object.assign(n, { emit: () => {} }, this._wellEmitter(n, x, z));
    }
    n.group.add(rim, wall, blood);
    // Iron frame and chain.
    const iron = new THREE.MeshStandardMaterial({ color: 0x2a2626, metalness: 0.8, roughness: 0.5 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 2.6, 14), iron);
      post.position.set(s * 1.25, 1.3, 0);
      n.group.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 14), iron);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 2.55;
    n.group.add(bar);
    return Object.assign(n, this._wellEmitter(n, x, z));
  }

  _wellEmitter(n, x, z) {
    return {
      emit: (ps) => {
        if (Math.random() < 0.5) ps.emit({ x: x + (Math.random() - 0.5) * 1.6, y: 0.7, z: z + (Math.random() - 0.5) * 1.6, vy: 0.6 + Math.random(), life: 1.4, size: 0.1, color: C.blood, colorEnd: C.bloodDark, turbulence: 0.8 });
      },
    };
  }

  _magicCircle(x, z) {
    const n = this._node('circle', x, z, 0xa040ff, 1.6);
    const m = new THREE.MeshBasicMaterial({ map: runeCircleTexture('#b04dff'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), m);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.04;
    n.group.add(disc);
    n.disc = disc;
    const shardMat = new THREE.MeshStandardMaterial({ color: 0x4010a0, emissive: 0x9040ff, emissiveIntensity: 1.8 });
    n.shards = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), shardMat);
      n.group.add(s);
      n.shards.push(s);
    }
    n.emit = (ps) => {
      const a = Math.random() * Math.PI * 2;
      ps.emit({ x: x + Math.cos(a) * 1.5, y: 0.1, z: z + Math.sin(a) * 1.5, vy: 1.2, life: 1.2, size: 0.12, color: C.violet, colorEnd: C.violetDark });
    };
    return n;
  }

  _burningSigil(x, z) {
    const n = this._node('sigil', x, z, 0xff7a20, 1.2);
    const iron = new THREE.MeshStandardMaterial({ color: 0x1e1a18, metalness: 0.7, roughness: 0.5 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 0.5, 28), iron);
    base.position.y = 0.25;
    n.group.add(base);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x331a0a, emissive: 0xff5a10, emissiveIntensity: 1.8, metalness: 0.5, roughness: 0.4 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.06, 12, 80), ringMat);
    ring.position.y = 2.0;
    const glyph = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 2.0),
      new THREE.MeshBasicMaterial({ map: runeCircleTexture('#ff6a1a'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    glyph.position.y = 2.0;
    n.group.add(ring, glyph);
    n.ring = ring;
    n.glyph = glyph;
    n.emit = (ps) => {
      // A point on the spinning ring, in world space.
      const a = Math.random() * Math.PI * 2;
      const ry = ring.rotation.y;
      spawnFlame(ps, { x: x + Math.cos(a) * Math.cos(ry), y: 2 + Math.sin(a), z: z - Math.cos(a) * Math.sin(ry) }, { size: 0.32, rise: 1.2, life: 0.6 });
    };
    return n;
  }

  // The way down: a circle of hellfire swirling in the floor at the far end
  // (clear of the altars' circles). Once an altar is woken it opens; step
  // onto it and you drop through (Game._updateSanctum).
  _portal() {
    const g = new THREE.Group();
    g.position.copy(this.portalPos);
    this.portalMat = portalMaterial();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.5, 72), this.portalMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.05;
    g.add(disc);
    this.portalLight = new THREE.PointLight(0xff3010, 0, 10, 1.5);
    this.portalLight.position.y = 1.5;
    g.add(this.portalLight);
    this.group.add(g);
  }

  // The node the player is looking at, within reach.
  focusedNode(camera) {
    if (this.chosen) return null;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    let best = null;
    let bestScore = 0.86;
    for (const n of this.nodes) {
      const to = new THREE.Vector3(n.pos.x - camera.position.x, 1.0 - camera.position.y, n.pos.z - camera.position.z);
      const d = to.length();
      if (d > 4.5) continue;
      const score = to.normalize().dot(fwd) + (d < 2.4 ? 0.2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return best;
  }

  choose(node) {
    this.chosen = node.key;
    this.portalOpen = true;
    for (const n of this.nodes) n.alive = n === node;
  }

  atPortal(pos) {
    return this.portalOpen && Math.hypot(pos.x - this.portalPos.x, pos.z - this.portalPos.z) < 1.3;
  }

  update(dt, ctx, focused) {
    this.time += dt;
    const t = this.time;
    this.wellMat.uniforms.uTime.value = t;
    this.portalMat.uniforms.uTime.value = t;
    this.portalT = Math.min(1, this.portalT + (this.portalOpen ? dt : 0));
    this.portalMat.uniforms.uOpen.value = this.portalT;
    this.portalLight.intensity = this.portalT * 22;
    const ps = ctx.fx.add;
    for (const n of this.nodes) {
      const target = n.alive ? n.baseLight * (n === focused ? 1.6 : 1) : 0;
      n.light.intensity += (target * (0.9 + Math.sin(t * 6 + n.pos.x) * 0.1) - n.light.intensity) * Math.min(1, dt * 4);
      if (n.alive && !this.chosen && Math.random() < dt * 30) n.emit(ps, t);
      if (n.key === 'circle') {
        n.disc.rotation.z = t * 0.25;
        n.shards.forEach((s, i) => {
          const a = t * 0.8 + (i / n.shards.length) * Math.PI * 2;
          s.position.set(Math.cos(a) * 1.3, 1.2 + Math.sin(t * 2 + i) * 0.25, Math.sin(a) * 1.3);
          s.rotation.y = t * 2;
          s.visible = n.alive || !this.chosen;
        });
      }
      if (n.key === 'sigil') {
        n.ring.rotation.y = t * 0.6;
        n.glyph.rotation.y = t * 0.6;
        n.ring.material.emissiveIntensity = n.alive || !this.chosen ? 1.8 : 0.1;
      }
    }
    for (const c of this.candles) if (Math.random() < dt * 4) spawnFlame(ps, c, { size: 0.12, rise: 0.4, life: 0.4, spread: 0.01 });
    if (this.portalOpen && Math.random() < dt * 25) {
      const a = Math.random() * 6.28;
      spawnFlame(ps, { x: this.portalPos.x + Math.cos(a) * Math.random() * 1.3, y: 0.1, z: this.portalPos.z + Math.sin(a) * Math.random() * 1.3 }, { size: 0.3, rise: 2.5, life: 1 });
    }
  }
}
