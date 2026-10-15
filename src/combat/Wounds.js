import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { makeCanvas } from '../world/Textures.js';

// What a blow leaves on a demon's body, by weapon: a sword cuts a gash along
// its stroke; an axe hacks a deep wound and throws chunks of the body off;
// a mace leaves a dark dent. A mark is laid on the skin itself: a ray onto
// the posed body finds where the blow really met it, and the mark is cut
// from the skin round that spot as it stood at that instant (a decal over
// the posed triangles), so it wraps the body rather than sticking out of
// it. It rides the nearest bone, moving with the body and falling with it.
// A few per demon and a couple of dozen in all, so they never cost much.

const PER_BODY = 4;
const ALL = 24;
const CHUNKS = 30;

let mats = null;
function materials() {
  if (mats) return mats;
  const make = (paint) => {
    const c = makeCanvas(128, 128);
    paint(c.getContext('2d'));
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.35, metalness: 0, emissive: 0x2a0000, emissiveIntensity: 1 });
  };
  // A gash: a long tapering split, near black inside, wet red lips, ragged.
  const gash = (g, deep) => {
    g.save();
    g.translate(64, 64);
    const lip = (w, col) => {
      g.beginPath();
      g.moveTo(-60, 0);
      for (let x = -60; x <= 60; x += 6) g.lineTo(x, -w * Math.sin(((x + 60) / 120) * Math.PI) * (0.85 + Math.random() * 0.3));
      for (let x = 60; x >= -60; x -= 6) g.lineTo(x, w * Math.sin(((x + 60) / 120) * Math.PI) * (0.85 + Math.random() * 0.3));
      g.closePath();
      g.fillStyle = col;
      g.fill();
    };
    lip(deep ? 34 : 22, 'rgba(150,12,8,0.85)');
    lip(deep ? 24 : 13, 'rgba(90,4,4,0.95)');
    lip(deep ? 13 : 6, 'rgba(18,0,0,1)');
    g.restore();
  };
  // A dent: a dark crushed hollow, a bruised ring, the faint lit edge.
  const dent = (g) => {
    const r = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    r.addColorStop(0, 'rgba(10,0,2,0.95)');
    r.addColorStop(0.35, 'rgba(40,4,10,0.9)');
    r.addColorStop(0.65, 'rgba(90,20,40,0.6)');
    r.addColorStop(0.82, 'rgba(160,90,90,0.25)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
    // Cracks out from the middle.
    g.strokeStyle = 'rgba(20,0,0,0.8)';
    g.lineWidth = 2;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.random() * 0.5;
      g.beginPath();
      g.moveTo(64, 64);
      g.lineTo(64 + Math.cos(a) * (30 + Math.random() * 18), 64 + Math.sin(a) * (30 + Math.random() * 18));
      g.stroke();
    }
  };
  mats = { sword: make((g) => gash(g, false)), axe: make((g) => gash(g, true)), mace: make(dent) };
  return mats;
}

const chunkGeo = new THREE.IcosahedronGeometry(1, 0);
const ray = new THREE.Raycaster();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _s = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _l = new THREE.Vector3();
const _e = new THREE.Euler();
const _inv = new THREE.Matrix4();

// A decal over a skinned mesh's triangles as posed right now, in world
// space. Only the triangles near the spot are cut, from their posed corners.
function skinDecal(mesh, p, orientation, size) {
  const pos = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  mesh.updateMatrixWorld(true);
  _l.copy(p);
  mesh.worldToLocal(_l);
  const reach = Math.max(size.x, size.y, size.z) * 0.8 / Math.max(1e-6, mesh.matrixWorld.getMaxScaleOnAxis());
  const r2 = reach * reach;
  const posed = new Float32Array(pos.count * 3);
  const near = new Uint8Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, _v);
    posed[i * 3] = _v.x;
    posed[i * 3 + 1] = _v.y;
    posed[i * 3 + 2] = _v.z;
    near[i] = _v.distanceToSquared(_l) < r2 ? 1 : 0;
  }
  const keep = [];
  const n = index ? index.count : pos.count;
  for (let t = 0; t < n; t += 3) {
    const a = index ? index.getX(t) : t;
    const b = index ? index.getX(t + 1) : t + 1;
    const c = index ? index.getX(t + 2) : t + 2;
    if (!near[a] && !near[b] && !near[c]) continue;
    for (const k of [a, b, c]) keep.push(posed[k * 3], posed[k * 3 + 1], posed[k * 3 + 2]);
  }
  if (!keep.length) return null;
  const local = new THREE.BufferGeometry();
  local.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  const decal = new DecalGeometry({ geometry: local, matrixWorld: mesh.matrixWorld }, p, orientation, size);
  local.dispose();
  return decal.attributes.position.count ? decal : null;
}

export class Wounds {
  constructor(scene) {
    this.scene = scene;
    this.marks = [];
    this.chunks = [];
  }

  // A melee blow by a `kind` of weapon ('sword', 'axe', 'mace') landed on
  // demon `e` at `contact`, driven along `dir`, the edge travelling `sweep`.
  hit(e, kind, contact, dir, sweep, heavy) {
    const model = e.model;
    if (!model?.meshes?.length || !contact) return;
    // Out from the body's axis to where the blow met it: the ray comes back
    // in along that onto the skin.
    _n.set(contact.x - e.position.x, 0, contact.z - e.position.z);
    if (_n.lengthSq() < 1e-4) _n.set(-dir.x, 0, -dir.z);
    _n.normalize();
    _o.copy(contact).addScaledVector(_n, 0.9);
    ray.set(_o, _d.copy(_n).negate());
    ray.far = 2;
    model.root.updateMatrixWorld(true);
    const hit = ray.intersectObjects(model.meshes, false)[0];
    if (!hit) return;
    _p.copy(hit.point);
    // The surface faces out from the axis at that height.
    _n.set(_p.x - e.position.x, 0, _p.z - e.position.z).normalize();
    const along = sweep || dir;
    _a.set(along.x, along.y || 0, along.z);
    this._mark(e, kind, _p, _n, _a, heavy, hit.object);
    if (kind === 'axe') this._chunks(e, _p, _n, _a, heavy);
  }

  _mark(e, kind, p, n, along, heavy, skin) {
    const model = e.model;
    const size = kind === 'sword' ? [heavy ? 0.46 : 0.34, heavy ? 0.1 : 0.075] : kind === 'axe' ? [heavy ? 0.34 : 0.26, heavy ? 0.16 : 0.12] : [heavy ? 0.36 : 0.27, heavy ? 0.36 : 0.27];
    // The projector: facing into the skin, long along the stroke.
    _x.copy(along).addScaledVector(n, -along.dot(n));
    if (_x.lengthSq() < 1e-4) _x.set(-n.z, 0, n.x);
    _x.normalize();
    if (kind === 'mace') _x.applyAxisAngle(n, Math.random() * Math.PI);
    _y.crossVectors(n, _x).normalize();
    _m.makeBasis(_x, _y, n);
    _e.setFromRotationMatrix(_m);
    const geometry = skinDecal(skin, p, _e, _s.set(size[0], size[1], 0.3));
    if (!geometry) return;
    // Riding the nearest bone (or the body itself on an unrigged one).
    let parent = model.root;
    let best = Infinity;
    for (const b of model.bones || []) {
      const d = b.getWorldPosition(_b).distanceToSquared(p);
      if (d < best) {
        best = d;
        parent = b;
      }
    }
    parent.updateMatrixWorld(true);
    geometry.applyMatrix4(_inv.copy(parent.matrixWorld).invert());
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materials()[kind] || materials().sword);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    parent.add(mesh);
    const list = (e.wounds ||= []);
    list.push(mesh);
    this.marks.push(mesh);
    if (list.length > PER_BODY) this._drop(list.shift());
    if (this.marks.length > ALL) this._drop(this.marks[0]);
  }

  _drop(mesh) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
    const i = this.marks.indexOf(mesh);
    if (i >= 0) this.marks.splice(i, 1);
  }

  // Chunks of the body hacked off by an axe, thrown along the stroke.
  _chunks(e, p, n, along, heavy) {
    const skin = e.model.meshes.find((m) => m.material)?.material;
    const material = Array.isArray(skin) ? skin[0] : skin;
    if (!material) return;
    const count = heavy ? 6 : 3;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(chunkGeo, material);
      const s = 0.045 + Math.random() * (heavy ? 0.07 : 0.05);
      mesh.scale.set(s * (0.8 + Math.random() * 0.8), s * (0.6 + Math.random() * 0.6), s * (0.8 + Math.random() * 0.6));
      mesh.position.copy(p);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.scene.add(mesh);
      const sp = 2 + Math.random() * 3;
      this.chunks.push({
        mesh,
        size: s,
        v: new THREE.Vector3(along.x * sp + n.x * 1.6 + (Math.random() - 0.5) * 1.5, 1.5 + Math.random() * 3, along.z * sp + n.z * 1.6 + (Math.random() - 0.5) * 1.5),
        spin: new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18),
        t: 0,
        life: 5 + Math.random() * 2,
      });
    }
    while (this.chunks.length > CHUNKS) this.chunks.shift().mesh.removeFromParent();
  }

  update(dt) {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      c.t += dt;
      const m = c.mesh;
      if (m.position.y > c.size * 0.6 || c.v.y > 0) {
        c.v.y -= 13 * dt;
        m.position.addScaledVector(c.v, dt);
        m.rotation.x += c.spin.x * dt;
        m.rotation.y += c.spin.y * dt;
        m.rotation.z += c.spin.z * dt;
        if (m.position.y < c.size * 0.6) {
          // A wet thud and a short skid.
          m.position.y = c.size * 0.6;
          c.v.y = Math.abs(c.v.y) > 2 ? -c.v.y * 0.2 : 0;
          c.v.x *= 0.4;
          c.v.z *= 0.4;
          c.spin.multiplyScalar(0.3);
        }
      }
      // Sink away at the end.
      if (c.t > c.life - 1) m.position.y -= dt * 0.05;
      if (c.t > c.life) {
        m.removeFromParent();
        this.chunks.splice(i, 1);
      }
    }
  }
}
