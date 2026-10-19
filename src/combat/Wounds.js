import * as THREE from 'three';
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
// (Exported for the warm-up, which draws each once before play.)
export function woundMaterials() {
  return materials();
}
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
const _e = new THREE.Euler();
const _inv = new THREE.Matrix4();

// A body, indexed once per model: each vertex's heaviest bone, the vertices
// and triangles each bone holds, and how far its vertices lie from it. A
// blow then only looks at the bones whose flesh reaches near it: a cut costs
// the same on a 31 000-vertex boss as on a hound, and nothing is allocated
// for it but the mark itself.
const indexed = new WeakMap();
const _w = new THREE.Vector3();
// Straight reads of an attribute's numbers (interleaved or not, packed into
// integers or not), for the loops below.
const RANGE = new Map([[Int8Array, 127], [Uint8Array, 255], [Int16Array, 32767], [Uint16Array, 65535], [Uint32Array, 4294967295]]);
function reader(attr) {
  const inter = !!attr.isInterleavedBufferAttribute;
  const array = inter ? attr.data.array : attr.array;
  return { array, stride: inter ? attr.data.stride : attr.itemSize, offset: inter ? attr.offset : 0, scale: attr.normalized ? 1 / (RANGE.get(array.constructor) || 1) : 1 };
}
function boneIndex(mesh) {
  let c = indexed.get(mesh.geometry);
  if (c) return c;
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const n = pos.count;
  // An unrigged body is all one piece, and never moves in its own space.
  const sk = mesh.isSkinnedMesh && mesh.skeleton;
  const nb = sk ? sk.bones.length : 1;
  const bone = new Uint8Array(n);
  const counts = new Uint32Array(nb);
  for (let i = 0; i < n; i++) {
    if (sk) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
      bone[i] = si.getComponent(i, best);
    }
    counts[bone[i]]++;
  }
  let verts = Array.from(counts, (k) => new Uint32Array(k));
  const fill = new Uint32Array(nb);
  for (let i = 0; i < n; i++) verts[bone[i]][fill[bone[i]]++] = i;
  // How far each bone's flesh lies from it (in its own space, as bound),
  // and each bone's list sorted along the line it is longest on: rough
  // posing moves a vertex with its bone alone, so where it lies in that
  // bone's space never changes, and a mark looks only at the slab of each
  // bone near the blow (a vast body has thousands a bone).
  const radius = new Float32Array(nb);
  const axis = new Uint8Array(nb);
  const keys = [];
  const local = sk ? new Float32Array(n * 3) : null;
  if (sk) {
    const toBone = sk.boneInverses.map((inv) => new THREE.Matrix4().multiplyMatrices(inv, mesh.bindMatrix));
    for (let i = 0; i < n; i++) {
      _w.fromBufferAttribute(pos, i).applyMatrix4(toBone[bone[i]]);
      local[i * 3] = _w.x;
      local[i * 3 + 1] = _w.y;
      local[i * 3 + 2] = _w.z;
      radius[bone[i]] = Math.max(radius[bone[i]], _w.length());
    }
    verts = verts.map((list, b) => {
      let ax = 0;
      let span = -1;
      for (let k = 0; k < 3; k++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = 0; j < list.length; j++) {
          const v = local[list[j] * 3 + k];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > span) {
          span = hi - lo;
          ax = k;
        }
      }
      axis[b] = ax;
      const sorted = Uint32Array.from(list).sort((i, j) => local[i * 3 + ax] - local[j * 3 + ax]);
      keys[b] = Float32Array.from(sorted, (i) => local[i * 3 + ax]);
      return sorted;
    });
  }
  // A thinned copy of each list (at most ~160 a bone) for finding where a
  // blow meets the skin: a vast body (the Sleeper's) otherwise has every
  // vertex near the ray posed and searched, twice, on every blow.
  const sparse = verts.map((list) => {
    const step = Math.max(1, Math.round(list.length / 160));
    if (step === 1) return list;
    const out = new Uint32Array(Math.ceil(list.length / step));
    for (let j = 0, k = 0; j < list.length; j += step) out[k++] = list[j];
    return out;
  });
  // A triangle is listed under each bone among its corners.
  const index = geo.index;
  const triCount = (index ? index.count : n) / 3;
  const lists = Array.from({ length: nb }, () => []);
  for (let t = 0; t < triCount; t++) {
    const a = bone[index ? index.getX(t * 3) : t * 3];
    const b = bone[index ? index.getX(t * 3 + 1) : t * 3 + 1];
    const d = bone[index ? index.getX(t * 3 + 2) : t * 3 + 2];
    lists[a].push(t);
    if (b !== a) lists[b].push(t);
    if (d !== a && d !== b) lists[d].push(t);
  }
  const tris = lists.map((l) => Uint32Array.from(l));
  // Each vertex's triangles (a cut takes only those round the flesh it
  // touches, not every triangle of the bones near the blow).
  const vtStart = new Uint32Array(n + 1);
  for (let t = 0; t < triCount * 3; t++) vtStart[(index ? index.getX(t) : t) + 1]++;
  for (let i = 0; i < n; i++) vtStart[i + 1] += vtStart[i];
  const vtList = new Uint32Array(triCount * 3);
  const vtFill = vtStart.slice(0, n);
  for (let t = 0; t < triCount * 3; t++) vtList[vtFill[index ? index.getX(t) : t]++] = (t / 3) | 0;
  c = {
    P: reader(pos),
    SI: sk ? reader(si) : null,
    SW: sk ? reader(sw) : null,
    rigid: !sk,
    bone,
    verts,
    sparse,
    tris,
    vtStart,
    vtList,
    radius,
    axis,
    keys,
    local,
    cand: new Uint32Array(n),
    nCand: 0,
    mats: sk ? sk.bones.map(() => new THREE.Matrix4()) : [],
    at: sk ? new Float32Array(n * 3) : Float32Array.from({ length: n * 3 }, (_, k) => pos.getComponent(Math.floor(k / 3), k % 3)),
    posed: new Float32Array(n * 3),
    posedMark: new Uint32Array(n),
    matMark: new Uint32Array(nb),
    near: new Uint8Array(n),
    stamp: new Uint32Array(triCount),
    mark: 0,
    wanted: [],
    touched: [],
  };
  indexed.set(geo, c);
  return c;
}

// Builds the index of every skinned body under `root` ahead of time (while
// a floor loads), so the first blow on each kind of demon costs no more than
// any other.
export function prepareWounds(root) {
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) boneIndex(o);
  });
}

// Pose roughly (each vertex by its heaviest bone alone, into c.at, mesh
// space) the flesh of the bones that reaches within r of the segment p-q
// (world, matrices current); those bones are left in c.wanted.
const _pq = new THREE.Vector3();
function roughPose(mesh, c, p, q, r, lists = c.verts) {
  c.wanted.length = 0;
  if (c.rigid) {
    c.wanted.push(0);
    return;
  }
  const sk = mesh.skeleton;
  const { array: pa, stride: ps, offset: po, scale: pk } = c.P;
  const scale = mesh.matrixWorld.getMaxScaleOnAxis();
  _pq.subVectors(q, p);
  const len2 = _pq.lengthSq();
  for (let b = 0; b < sk.bones.length; b++) {
    const list = lists[b];
    if (!list.length) continue;
    _w.setFromMatrixPosition(sk.bones[b].matrixWorld).sub(p);
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, _w.dot(_pq) / len2)) : 0;
    const reach = c.radius[b] * scale + r;
    if (_w.addScaledVector(_pq, -t).lengthSq() > reach * reach) continue;
    c.wanted.push(b);
    const m = c.mats[b].multiplyMatrices(mesh.bindMatrixInverse, sk.bones[b].matrixWorld).multiply(sk.boneInverses[b]).multiply(mesh.bindMatrix);
    const at = c.at;
    const e = m.elements;
    for (let j = 0; j < list.length; j++) {
      const i = list[j];
      const x = pa[i * ps + po] * pk;
      const y = pa[i * ps + po + 1] * pk;
      const z = pa[i * ps + po + 2] * pk;
      at[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      at[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      at[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  }
}

// Pose roughly (as roughPose) only the flesh within r of the world point p:
// of each bone near it, the slab of its sorted list about p, and of that
// what lies inside the ball (in the bone's own space). Those vertices are
// left in c.cand (c.nCand of them).
const _G = new THREE.Matrix4();
const _pl = new THREE.Vector3();
function windowPose(mesh, c, p, r) {
  let n = 0;
  const cand = c.cand;
  if (c.rigid) {
    const all = c.verts[0];
    for (let j = 0; j < all.length; j++) cand[n++] = all[j];
    c.nCand = n;
    return;
  }
  const sk = mesh.skeleton;
  const { array: pa, stride: ps, offset: po, scale: pk } = c.P;
  const scale = mesh.matrixWorld.getMaxScaleOnAxis();
  const at = c.at;
  for (let b = 0; b < sk.bones.length; b++) {
    const list = c.verts[b];
    if (!list.length) continue;
    const bw = sk.bones[b].matrixWorld;
    const reach = c.radius[b] * scale + r;
    if (_w.setFromMatrixPosition(bw).distanceToSquared(p) > reach * reach) continue;
    // From the bone's own space to the world, and p brought into it.
    _G.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).multiply(bw);
    const g = _G.elements;
    const minScale = Math.sqrt(Math.min(g[0] * g[0] + g[1] * g[1] + g[2] * g[2], g[4] * g[4] + g[5] * g[5] + g[6] * g[6], g[8] * g[8] + g[9] * g[9] + g[10] * g[10]));
    if (!(minScale > 1e-9)) continue;
    _pl.copy(p).applyMatrix4(_G.invert());
    const ax = c.axis[b];
    const mid = ax === 0 ? _pl.x : ax === 1 ? _pl.y : _pl.z;
    const rl = r / minScale;
    const keys = c.keys[b];
    // The first key at or past mid - rl, and the first past mid + rl.
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const k = (lo + hi) >> 1;
      if (keys[k] < mid - rl) lo = k + 1;
      else hi = k;
    }
    let end = lo;
    hi = keys.length;
    while (end < hi) {
      const k = (end + hi) >> 1;
      if (keys[k] <= mid + rl) end = k + 1;
      else hi = k;
    }
    if (end <= lo) continue;
    const m = c.mats[b].multiplyMatrices(mesh.bindMatrixInverse, bw).multiply(sk.boneInverses[b]).multiply(mesh.bindMatrix);
    const e = m.elements;
    const L = c.local;
    const lx = _pl.x;
    const ly = _pl.y;
    const lz = _pl.z;
    const rl2 = rl * rl;
    for (let j = lo; j < end; j++) {
      const i = list[j];
      const dx = L[i * 3] - lx;
      const dy = L[i * 3 + 1] - ly;
      const dz = L[i * 3 + 2] - lz;
      if (dx * dx + dy * dy + dz * dz > rl2) continue;
      cand[n++] = i;
      const x = pa[i * ps + po] * pk;
      const y = pa[i * ps + po + 1] * pk;
      const z = pa[i * ps + po + 2] * pk;
      at[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      at[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      at[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  }
  c.nCand = n;
}

// Where a ray from `o` along `d` first meets the body. A skinned body is
// not raycast triangle by triangle (that poses every triangle); the vertex
// nearest the ray, nearest its start, is taken from the flesh near the ray,
// roughly posed, then posed properly.
const _ol = new THREE.Vector3();
const _dl = new THREE.Vector3();
const _mid = new THREE.Vector3();
function surfaceHit(meshes, o, d, far) {
  let best = null;
  for (const mesh of meshes) {
    if (!mesh.isSkinnedMesh || !mesh.skeleton) {
      ray.set(o, d);
      ray.far = far;
      const h = ray.intersectObject(mesh, false)[0];
      if (h && (!best || h.distance < best.distance)) best = { point: h.point.clone(), object: mesh, distance: h.distance };
      continue;
    }
    const c = boneIndex(mesh);
    roughPose(mesh, c, o, _mid.copy(o).addScaledVector(d, far), 0.4, c.sparse);
    _inv.copy(mesh.matrixWorld).invert();
    _ol.copy(o).applyMatrix4(_inv);
    _dl.copy(o).add(d).applyMatrix4(_inv).sub(_ol);
    const unit = _dl.length();
    _dl.multiplyScalar(1 / unit);
    const farL = far * unit;
    const tol = 0.12 * unit;
    const at = c.at;
    // The closest any of it comes to the ray, then the first along the ray
    // of what comes about that close.
    let minPerp = Infinity;
    for (let w = 0; w < c.wanted.length; w++) {
      const list = c.sparse[c.wanted[w]];
      for (let j = 0; j < list.length; j++) {
        const i = list[j];
        _w.set(at[i * 3], at[i * 3 + 1], at[i * 3 + 2]).sub(_ol);
        const t = _w.dot(_dl);
        if (t < 0 || t > farL) continue;
        const p2 = _w.lengthSq() - t * t;
        if (p2 < minPerp) minPerp = p2;
      }
    }
    if (minPerp > (tol * 3) ** 2) continue;
    const limit = Math.max(minPerp * 4, tol * tol);
    let bestI = -1;
    let bestT = Infinity;
    for (let w = 0; w < c.wanted.length; w++) {
      const list = c.sparse[c.wanted[w]];
      for (let j = 0; j < list.length; j++) {
        const i = list[j];
        _w.set(at[i * 3], at[i * 3 + 1], at[i * 3 + 2]).sub(_ol);
        const t = _w.dot(_dl);
        if (t < 0 || t > farL || t >= bestT) continue;
        if (_w.lengthSq() - t * t <= limit) {
          bestT = t;
          bestI = i;
        }
      }
    }
    if (bestI < 0) continue;
    mesh.getVertexPosition(bestI, _w).applyMatrix4(mesh.matrixWorld);
    const distance = _w.distanceTo(o);
    if (!best || distance < best.distance) best = { point: _w.clone(), object: mesh, distance };
  }
  return best;
}

// A decal over a body's triangles as posed right now, put through `into`
// (world space to the space it will ride in). Only the flesh inside the decal's own box (a long thin one for a
// cut) is posed properly and only the triangles touching it are cut: the
// projector's box, in the mesh's space, tested first on the rough pose with
// a margin, then on the true one.
const keep = [];
const _projM = new THREE.Matrix4();
const _proj = new THREE.Matrix4();
const _toProj = new THREE.Matrix4();
const _toOut = new THREE.Matrix4();
function skinDecal(mesh, p, orientation, size, into) {
  mesh.updateMatrixWorld(true);
  const c = boneIndex(mesh);
  // As far as any corner of the box (and the margin the rough pose is
  // allowed) lies from its centre.
  windowPose(mesh, c, p, Math.hypot(size.x, size.y, size.z) / 2 + 0.2);
  // Mesh space to the projector's: x along the cut, y across it, z into the skin.
  _projM.makeRotationFromEuler(orientation).setPosition(p);
  _proj.copy(_projM).invert();
  _toProj.multiplyMatrices(_proj, mesh.matrixWorld);
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  const e = _toProj.elements;
  const inBox = (x, y, z, m) =>
    Math.abs(e[0] * x + e[4] * y + e[8] * z + e[12]) <= hx + m &&
    Math.abs(e[1] * x + e[5] * y + e[9] * z + e[13]) <= hy + m &&
    Math.abs(e[2] * x + e[6] * y + e[10] * z + e[14]) <= hz + m;
  const mark = (c.mark = (c.mark + 1) >>> 0 || 1);
  const { at, posed, posedMark, near, touched, mats, matMark } = c;
  // Posed properly: each bone's pull on the vertex by its weight, the bones'
  // matrices worked out once per mark as they are first needed.
  const sk = c.rigid ? null : mesh.skeleton;
  const { array: pa, stride: ps, offset: po, scale: pk } = c.P;
  const { array: ia, stride: is, offset: io } = c.SI || c.P;
  const { array: wa, stride: ws, offset: wo, scale: wk } = c.SW || c.P;
  const pose = (i) => {
    if (posedMark[i] === mark) return;
    posedMark[i] = mark;
    const px = pa[i * ps + po] * pk;
    const py = pa[i * ps + po + 1] * pk;
    const pz = pa[i * ps + po + 2] * pk;
    if (!sk) {
      posed[i * 3] = px;
      posed[i * 3 + 1] = py;
      posed[i * 3 + 2] = pz;
      return;
    }
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 4; k++) {
      const w = wa[i * ws + wo + k] * wk;
      if (!w) continue;
      const b = ia[i * is + io + k];
      if (matMark[b] !== mark) {
        matMark[b] = mark;
        mats[b].multiplyMatrices(mesh.bindMatrixInverse, sk.bones[b].matrixWorld).multiply(sk.boneInverses[b]).multiply(mesh.bindMatrix);
      }
      const m = mats[b].elements;
      x += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
      y += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
      z += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
    }
    posed[i * 3] = x;
    posed[i * 3 + 1] = y;
    posed[i * 3 + 2] = z;
  };
  touched.length = 0;
  const cand = c.cand;
  for (let j = 0; j < c.nCand; j++) {
    const i = cand[j];
    if (!inBox(at[i * 3], at[i * 3 + 1], at[i * 3 + 2], 0.1)) continue;
    pose(i);
    if (inBox(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2], 0.02)) {
      near[i] = 1;
      touched.push(i);
    }
  }
  const index = mesh.geometry.index;
  keep.length = 0;
  if (touched.length) {
    const { vtStart, vtList } = c;
    for (let q = 0; q < touched.length; q++) {
      const v = touched[q];
      for (let j = vtStart[v]; j < vtStart[v + 1]; j++) {
        const t = vtList[j];
        if (c.stamp[t] === mark) continue;
        c.stamp[t] = mark;
        const a = index ? index.getX(t * 3) : t * 3;
        const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const d = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        if (!near[a] && !near[b] && !near[d]) continue;
        pose(a);
        pose(b);
        pose(d);
        keep.push(posed[a * 3], posed[a * 3 + 1], posed[a * 3 + 2], posed[b * 3], posed[b * 3 + 1], posed[b * 3 + 2], posed[d * 3], posed[d * 3 + 1], posed[d * 3 + 2]);
      }
    }
  }
  for (let j = 0; j < touched.length; j++) near[touched[j]] = 0;
  if (!keep.length) return null;
  const decal = cutMark(keep, _toProj, _toOut.multiplyMatrices(into, _projM), size);
  return decal;
}

// The mark itself: each kept triangle taken into the projector's space,
// clipped to its box (Sutherland-Hodgman, plane by plane), fanned back into
// triangles with the box's face as the texture, and put through `toOut`.
// Everything but the finished geometry is scratch kept between marks.
const _pa = new Float64Array(3 * 12);
const _pb = new Float64Array(3 * 12);
let _outP = new Float32Array(3 * 3 * 256);
let _outU = new Float32Array(2 * 3 * 256);
function cutMark(tris, toProj, toOut, size) {
  const e = toProj.elements;
  const o = toOut.elements;
  const half = [size.x / 2, size.y / 2, size.z / 2];
  let n = 0;
  for (let t = 0; t < tris.length; t += 9) {
    let a = _pa;
    let b = _pb;
    for (let k = 0; k < 3; k++) {
      const x = tris[t + k * 3];
      const y = tris[t + k * 3 + 1];
      const z = tris[t + k * 3 + 2];
      a[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      a[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      a[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    let m = 3;
    for (let pl = 0; pl < 6 && m >= 3; pl++) {
      const axis = pl >> 1;
      const sign = pl & 1 ? -1 : 1;
      const lim = half[axis];
      let c = 0;
      for (let i = 0; i < m; i++) {
        const j = i + 1 === m ? 0 : i + 1;
        const di = sign * a[i * 3 + axis] - lim;
        const dj = sign * a[j * 3 + axis] - lim;
        if (di <= 0) {
          b[c * 3] = a[i * 3];
          b[c * 3 + 1] = a[i * 3 + 1];
          b[c * 3 + 2] = a[i * 3 + 2];
          c++;
        }
        if (di <= 0 !== dj <= 0) {
          const f = di / (di - dj);
          b[c * 3] = a[i * 3] + (a[j * 3] - a[i * 3]) * f;
          b[c * 3 + 1] = a[i * 3 + 1] + (a[j * 3 + 1] - a[i * 3 + 1]) * f;
          b[c * 3 + 2] = a[i * 3 + 2] + (a[j * 3 + 2] - a[i * 3 + 2]) * f;
          c++;
        }
      }
      m = c;
      const s2 = a;
      a = b;
      b = s2;
    }
    if (m < 3) continue;
    const need = n + (m - 2) * 3;
    if (need * 3 > _outP.length) {
      const P = new Float32Array(need * 6);
      P.set(_outP);
      _outP = P;
      const U = new Float32Array(need * 4);
      U.set(_outU);
      _outU = U;
    }
    for (let i = 1; i < m - 1; i++) {
      for (let q = 0; q < 3; q++) {
        const v = q ? i + q - 1 : 0;
        const x = a[v * 3];
        const y = a[v * 3 + 1];
        const z = a[v * 3 + 2];
        _outU[n * 2] = 0.5 + x / size.x;
        _outU[n * 2 + 1] = 0.5 + y / size.y;
        _outP[n * 3] = o[0] * x + o[4] * y + o[8] * z + o[12];
        _outP[n * 3 + 1] = o[1] * x + o[5] * y + o[9] * z + o[13];
        _outP[n * 3 + 2] = o[2] * x + o[6] * y + o[10] * z + o[14];
        n++;
      }
    }
  }
  if (!n) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(_outP.slice(0, n * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(_outU.slice(0, n * 2), 2));
  return geometry;
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
    const hit = surfaceHit(model.meshes, _o, _d, 2);
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
    // Riding the nearest bone (or the body itself on an unrigged one), cut
    // straight into its space (the body's matrices are current: see hit).
    let parent = model.root;
    let best = Infinity;
    for (const b of model.bones || []) {
      const d = _b.setFromMatrixPosition(b.matrixWorld).distanceToSquared(p);
      if (d < best) {
        best = d;
        parent = b;
      }
    }
    const geometry = skinDecal(skin, p, _e, _s.set(size[0], size[1], 0.3), _inv.copy(parent.matrixWorld).invert());
    if (!geometry) return;
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

  // Blows of every kind on bodies kept out of sight (while a floor loads),
  // wiped away after: the code a blow runs is compiled before the first
  // real one, which would otherwise stall the frame it lands in.
  rehearse(bodies) {
    const dir = new THREE.Vector3(0, 0, -1);
    const contact = new THREE.Vector3();
    for (const e of bodies) {
      const hb = e.hurtboxes?.[0];
      if (!hb) continue;
      e.model.root.updateMatrixWorld(true);
      hb.update();
      // (Enough of them, high and low, that the code is fully optimised by
      // the first real blow, not still warming up through the first fight.)
      for (const rise of [-0.3, 0, 0.3]) {
        for (const kind of ['sword', 'axe', 'mace']) {
          for (const heavy of [false, true]) {
            contact.copy(hb.obb.center);
            contact.y += rise * hb.obb.half.y;
            contact.z += 0.2;
            this.hit(e, kind, contact, dir, null, heavy);
          }
        }
      }
      for (const m of e.wounds || []) this._drop(m);
      e.wounds = [];
    }
    for (const c of this.chunks) c.mesh.removeFromParent();
    this.chunks.length = 0;
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
