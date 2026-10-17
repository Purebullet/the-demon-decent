import * as THREE from 'three';
import { C } from './Particles.js';

// A heavy blow on the floor: the Sleeper's axe biting into it, his stamp,
// and (smaller) every step he takes. Where it lands:
//   - a shockwave ring races out over the ground and fades;
//   - the floor caves in a little: a dark crater, cracks running out from
//     it that glow molten for a moment, then go dark, linger and fade;
//   - chunks of the floor fly up, bounce and settle;
//   - dust rolls out low along the ground, sparks spit from the cracks.
// `power` (0..1) scales all of it; a footstep is about a quarter.

const MARKS = 14;
const CHUNKS = 40;
const LINGER = 9;

const ringGeo = new THREE.RingGeometry(0.82, 1, 64);
const planeGeo = new THREE.PlaneGeometry(2, 2);
const chunkGeo = new THREE.IcosahedronGeometry(1, 0);
const DUST = new THREE.Color(0.22, 0.17, 0.14);
const DUST_END = new THREE.Color(0.1, 0.08, 0.07);
const SHOCK = new THREE.Color(1.0, 0.62, 0.3);

// The cracks (white lines, the alpha) and the crater (a soft dark middle).
let tex = null;
function textures() {
  if (tex) return tex;
  const S = 256;
  const mk = (draw) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    g.translate(S / 2, S / 2);
    draw(g);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const crack = (g, x, y, a, len, w, depth) => {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x, y);
    let px = x;
    let py = y;
    const steps = 6;
    for (let s = 1; s <= steps; s++) {
      a += (rnd() - 0.5) * 0.7;
      px += Math.cos(a) * (len / steps);
      py += Math.sin(a) * (len / steps);
      g.lineTo(px, py);
      if (depth > 0 && rnd() < 0.3) {
        g.stroke();
        crack(g, px, py, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6), len * 0.45, w * 0.6, depth - 1);
        g.lineWidth = w * (1 - s / (steps + 2));
        g.beginPath();
        g.moveTo(px, py);
      }
    }
    g.stroke();
  };
  tex = {
    cracks: mk((g) => {
      g.strokeStyle = '#fff';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const n = 11;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
        crack(g, Math.cos(a) * 14, Math.sin(a) * 14, a, 70 + rnd() * 45, 5, 2);
      }
      // A broken rim round the middle.
      g.lineWidth = 3;
      g.beginPath();
      for (let k = 0; k <= 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const r = 26 + (rnd() - 0.5) * 9;
        if (k) g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        else g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.stroke();
    }),
    crater: mk((g) => {
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 120);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.22, 'rgba(255,255,255,0.85)');
      grad.addColorStop(0.45, 'rgba(255,255,255,0.3)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(-128, -128, 256, 256);
    }),
  };
  return tex;
}

export class Quakes {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;
    this.marks = [];
    this.waves = [];
    this.chunks = [];
    this.chunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2c26, roughness: 1, metalness: 0, flatShading: true });
  }

  clear() {
    for (const m of this.marks) m.group.removeFromParent();
    for (const w of this.waves) w.mesh.removeFromParent();
    for (const c of this.chunks) c.mesh.removeFromParent();
    this.marks.length = this.waves.length = this.chunks.length = 0;
  }

  // The blow at (x, z), `radius` metres across its reach, `power` 0..1.
  // `y` lifts it all (a staged copy, out of sight, while a floor loads).
  hit(x, z, radius, power = 1, { y = 0 } = {}) {
    const T = textures();
    // The mark: crater, dark cracks, molten glow in the cracks.
    const size = radius * (0.55 + 0.25 * power);
    const group = new THREE.Group();
    group.position.set(x, y + 0.02 + this.marks.length * 0.001, z);
    group.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    const layer = (map, color, blending, opacity, scale, order) => {
      const mat = new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity, blending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 - order, polygonOffsetUnits: -2 - order });
      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.scale.setScalar(scale);
      mesh.renderOrder = 1 + order;
      group.add(mesh);
      return mat;
    };
    const crater = layer(T.crater, 0x000000, THREE.NormalBlending, 0.75 * Math.min(1, 0.5 + power), size * 0.55, 0);
    const dark = layer(T.cracks, 0x0c0604, THREE.NormalBlending, 0.92, size, 1);
    const glow = layer(T.cracks, 0xff6a1a, THREE.AdditiveBlending, 1.2 * power + 0.3, size, 2);
    this.scene.add(group);
    this.marks.push({ group, crater, dark, glow, t: 0, life: LINGER * (0.5 + power * 0.5), power, craterA: crater.opacity });
    while (this.marks.length > MARKS) this._dropMark(this.marks[0]);
    // The shockwave.
    if (power > 0.3) {
      const mat = new THREE.MeshBasicMaterial({ color: SHOCK, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, y + 0.08, z);
      mesh.scale.setScalar(0.3);
      this.scene.add(mesh);
      this.waves.push({ mesh, mat, t: 0, dur: 0.35 + radius * 0.04, radius: radius * 1.05 });
    }
    // Chunks of the floor thrown up.
    const n = Math.round(3 + power * 11);
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(chunkGeo, this.chunkMat);
      const s = (0.05 + Math.random() * 0.1) * (0.6 + power * 0.8);
      mesh.scale.set(s * (0.8 + Math.random() * 0.6), s * (0.6 + Math.random() * 0.5), s * (0.8 + Math.random() * 0.6));
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * size * 0.3;
      mesh.position.set(x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.scene.add(mesh);
      const sp = (1.5 + Math.random() * 3.5) * (0.5 + power);
      this.chunks.push({ mesh, s, v: new THREE.Vector3(Math.cos(a) * sp, (2 + Math.random() * 5) * (0.5 + power * 0.7), Math.sin(a) * sp), spin: new THREE.Vector3((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16), t: 0, life: 2.5 + Math.random() * 2, y0: y });
    }
    while (this.chunks.length > CHUNKS) this.chunks.shift().mesh.removeFromParent();
    if (y < -1) return;
    // Dust rolling out along the ground.
    const fx = this.fx;
    const dn = Math.round(6 + power * 22);
    for (let i = 0; i < dn; i++) {
      const a = (i / dn) * Math.PI * 2 + Math.random() * 0.3;
      const sp = (1.2 + Math.random() * 1.6) * (0.4 + radius * 0.5) * (0.4 + power * 0.6);
      fx.alpha.emit({ x: x + Math.cos(a) * 0.3, y: 0.25, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * sp, vy: 0.3 + Math.random() * 0.8, vz: Math.sin(a) * sp, life: 1.0 + Math.random() * 0.8, size: 0.45 + power * 0.5, sizeEnd: 1.1 + power * 1.1, color: DUST, colorEnd: DUST_END, alpha: 0.45, drag: 2.2, gravity: 0.2, turbulence: 0.6 });
    }
    // Sparks spat from the cracks.
    const sn = Math.round(power * 26);
    for (let i = 0; i < sn; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 4;
      fx.add.emit({ x: x + Math.cos(a) * size * 0.2, y: 0.15, z: z + Math.sin(a) * size * 0.2, vx: Math.cos(a) * sp * 0.6, vy: 2.5 + Math.random() * 4, vz: Math.sin(a) * sp * 0.6, life: 0.5 + Math.random() * 0.6, size: 0.07, sizeEnd: 0.02, color: C.spark, colorEnd: C.fireEdge, gravity: -11, drag: 0.3 });
    }
  }

  _dropMark(m) {
    m.group.removeFromParent();
    for (const mat of [m.crater, m.dark, m.glow]) mat.dispose();
    this.marks.splice(this.marks.indexOf(m), 1);
  }

  update(dt) {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const e = 1 - (1 - k) ** 2;
      w.mesh.scale.setScalar(0.3 + (w.radius - 0.3) * e);
      w.mat.opacity = 0.9 * (1 - k);
      if (k >= 1) {
        w.mesh.removeFromParent();
        w.mat.dispose();
        this.waves.splice(i, 1);
      }
    }
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      m.t += dt;
      // Molten for a moment, then dark; at the end of its time it fades.
      m.glow.opacity = Math.max(0, (1.2 * m.power + 0.3) * (1 - m.t / 1.6));
      const fade = Math.min(1, Math.max(0, (m.life - m.t) / 2));
      m.dark.opacity = 0.92 * fade;
      m.crater.opacity = m.craterA * fade;
      if (m.t >= m.life) this._dropMark(m);
    }
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      c.t += dt;
      const p = c.mesh.position;
      const floor = c.y0 + c.s * 0.6;
      if (p.y > floor || c.v.y > 0) {
        c.v.y -= 16 * dt;
        p.addScaledVector(c.v, dt);
        c.mesh.rotation.x += c.spin.x * dt;
        c.mesh.rotation.y += c.spin.y * dt;
        c.mesh.rotation.z += c.spin.z * dt;
        if (p.y < floor) {
          p.y = floor;
          c.v.y = Math.abs(c.v.y) > 2.5 ? -c.v.y * 0.3 : 0;
          c.v.x *= 0.45;
          c.v.z *= 0.45;
          c.spin.multiplyScalar(0.4);
        }
      }
      if (c.t > c.life - 1) p.y -= dt * 0.08;
      if (c.t > c.life) {
        c.mesh.removeFromParent();
        this.chunks.splice(i, 1);
      }
    }
  }
}
