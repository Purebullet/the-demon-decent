import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { rockTextures, makeCanvas } from '../world/Textures.js';
import { mulberry32, fbm2 } from '../core/rng.js';

// The lot's street view: a hell-mouth diorama that stays inside the lot's
// box (origin at the middle of the floor, metres, +Y up). A volcanic mound
// torn open by a glowing pit, a ring of razor-sharp rock spires and crags
// leaning over it, three kinds of broken pillar standing on its slopes (their
// shapes generated with Zoodle, all of the mound's own rock), billows of fog boiling
// up out of the hole, and gobs of lava it spits out now and then, which land
// on the slopes, smoulder and go out. The game itself lives inside, as an experience.
//
// Three levels of detail, as Project 0 asks (skill.md section 3):
//   LOD0  materials Rock (the mound and the pieces), Glow, Smoke; the Fog
//         shader and the Lava nodes move (lot.json)
//   LOD1  every piece again, cut down by meshoptimizer, static: Rock and Glow
//         (the same shaders, as Project 0 gives LOD1 the materials it shares
//         by name with LOD0)
//   LOD2  one mesh, one material, one 256 px texture: the mound, the pit and
//         very light copies of the spires and pillars

const TAU = Math.PI * 2;

function prep(g) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
  if (!n.attributes.normal) n.computeVertexNormals();
  return n;
}

function merge(list) {
  return mergeGeometries(list.map(prep));
}

function placed(geo, { pos = [0, 0, 0], rot = [0, 0, 0], order = 'XYZ', scale = [1, 1, 1] }) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, order)),
    new THREE.Vector3(...scale),
  );
  return geo.clone().applyMatrix4(m);
}

// Superellipse boundary: a rounded rectangle that fills the lot's footprint.
function edgeRadius(a, hx, hz) {
  const p = 4;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return 1 / Math.pow(Math.pow(c / hx, p) + Math.pow(s / hz, p), 1 / p);
}

function shape(width, depth, height) {
  const S = Math.min(width, depth);
  const hx = width / 2 - 0.25;
  const hz = depth / 2 - 0.25;
  const rc = 0.27 * S; // crater lip
  const rb = 0.11 * S; // pit floor
  const hm = Math.min(0.2 * height, 0.3 * S, 6); // mound height at the lip
  const dims = { S, hx, hz, rc, rb, hm, lavaY: LAVA_Y };
  dims.pool = lavaRadius(dims);
  return dims;
}

// Mound + funnel + skirt as one radial mesh.
function mound(dims, { segs, rings, lift }) {
  const { hx, hz, rc, rb, hm } = dims;
  const pos = [];
  const uv = [];
  const idx = [];
  const funnelRings = Math.max(3, Math.round(rings * 0.6));
  const cols = segs + 1;
  // Each column: pit floor edge -> funnel -> lip -> slope -> edge -> skirt bottom.
  const rows = funnelRings + rings + 2;
  for (let j = 0; j <= segs; j++) {
    const a = (j / segs) * TAU;
    const jag = fbm2(Math.cos(a) * 2.5 + 7, Math.sin(a) * 2.5 + 7, 4, 3);
    const edge = edgeRadius(a, hx, hz);
    const lipR = rc * (0.92 + jag * 0.16);
    const lipY = hm * (0.85 + jag * 0.3);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const push = (r, y) => {
      pos.push(ca * r, y, sa * r);
      uv.push((ca * r) / 3, (sa * r) / 3 + y / 3);
    };
    for (let i = 0; i < funnelRings; i++) {
      const k = i / (funnelRings - 1);
      const r = rb + (lipR - rb) * Math.pow(k, 0.7) + (fbm2(a * 3, k * 4, 3, 5) - 0.5) * 0.12 * dims.S * k * (1 - k);
      push(r, 0.25 + (lipY - 0.25) * k);
    }
    for (let i = 1; i <= rings; i++) {
      const k = i / rings;
      const r = lipR + (edge - lipR) * k;
      const y = lift + (lipY - lift) * Math.pow(1 - k, 1.6) + (fbm2(ca * r * 0.4, sa * r * 0.4, 3, 9) - 0.5) * 0.4 * (1 - k) * k * 4;
      push(r, Math.max(lift, y));
    }
    push(edge, 0);
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < rows - 2; i++) {
      const a = j * (rows - 1) + i;
      const b = (j + 1) * (rows - 1) + i;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // (column j, profile i), (j + 1, i), (j, i + 1): faces point up on the
  // slope, toward the axis inside the funnel, and outward on the skirt.
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Billows of fog boiling up out of the pit: each puff is four crossed quads
// (three upright, one flat) that the Smoke shader lifts, swells and fades on
// a loop. A quad's UV holds its corner (the whole part) plus the puff's
// phase (the fraction), so the shader can find the puff's centre and keep
// all four quads of a puff together. PUFF is the quads' size as built.
export const PUFF = 1.6;
function fogPuffs(dims, count, rnd) {
  const list = [];
  const quad = new THREE.PlaneGeometry(PUFF, PUFF);
  for (let i = 0; i < count; i++) {
    const a = rnd() * TAU;
    const r0 = dims.rb * Math.sqrt(rnd()) * 0.85;
    const cx = Math.cos(a) * r0;
    const cz = Math.sin(a) * r0;
    const cy = PUFF * 0.5 + 0.3 + rnd() * 0.5;
    const phase = Math.min(0.995, (i / count + rnd() * 0.04) % 1);
    const spin = rnd() * Math.PI;
    const parts = [0, 1, 2].map((k) => placed(quad, { pos: [cx, cy, cz], rot: [0, spin + (k * Math.PI) / 3, 0] }));
    parts.push(placed(quad, { pos: [cx, cy, cz], rot: [-Math.PI / 2, 0, spin] }));
    for (const g of parts) {
      const uv = g.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) + phase);
      list.push(g);
    }
  }
  return list;
}

// Gobs of lava the build's script throws out of the pit (one node each).
export const LAVA_COUNT = 6;

// ---- Generated pieces ------------------------------------------------------

// The pieces from Zoodle (loaded by tools/lot.html into `models`), each
// normalized to stand on y = 0, centred, 1 tall. Only their shapes are used:
// they wear the mound's rock texture, so they read as the same stone.
const KINDS = ['spire', 'crag', 'pillar-a', 'pillar-b', 'pillar-c'];

// The rock texture laid on the placed pieces from the side each face looks
// toward (a box projection per triangle), as dense as on the mound: one
// repeat every 3 m.
function boxUv(geo) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(b.clone().sub(a));
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k);
      const y = pos.getY(i + k);
      const z = pos.getZ(i + k);
      const [u, v] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
      uv[(i + k) * 2] = u / 3;
      uv[(i + k) * 2 + 1] = v / 3;
    }
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

// A piece cut down to about `tris` triangles by meshoptimizer, welded on
// position alone and flat-shaded: crisp facets read better than smoothed
// lumps at a distance. Tiny loose bits are pruned.
function lowPoly(geo, tris) {
  const welded = new THREE.BufferGeometry();
  welded.setAttribute('position', geo.attributes.position.clone());
  const g = mergeVertices(welded, 1e-4);
  const pos = g.attributes.position.array;
  const idx = new Uint32Array(g.index.array);
  let [out] = MeshoptSimplifier.simplify(idx, pos, 3, tris * 3, 1, ['Prune']);
  if (out.length > tris * 3 * 1.3) [out] = MeshoptSimplifier.simplifySloppy(idx, pos, 3, null, tris * 3, 1);
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', g.attributes.position);
  r.setIndex(new THREE.BufferAttribute(out, 1));
  const flat = r.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

// Triangles per piece in LOD1 (all 42 pieces, about 8,500 in all) and LOD2
// (spires and pillars only).
const LOD1_TRIS = { spire: 220, crag: 130, 'pillar-a': 340, 'pillar-b': 240, 'pillar-c': 340 };
const LOD2_TRIS = { spire: 26, crag: 0, 'pillar-a': 30, 'pillar-b': 24, 'pillar-c': 30 };

function bakePiece(scene) {
  scene.updateMatrixWorld(true);
  const geos = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
    geos.push(g.index ? g.toNonIndexed() : g);
  });
  const g = geos.length === 1 ? geos[0] : mergeGeometries(geos);
  g.computeBoundingBox();
  const b = g.boundingBox;
  const k = 1 / (b.max.y - b.min.y);
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  g.scale(k, k, k);
  return g;
}

let kitCache = null;
async function kit(models) {
  if (kitCache) return kitCache;
  await MeshoptSimplifier.ready;
  const pieces = {};
  for (const kind of KINDS) {
    const m = models?.[kind];
    if (!m) continue;
    const high = bakePiece(m);
    pieces[kind] = { high, low: lowPoly(high, LOD1_TRIS[kind]), far: LOD2_TRIS[kind] ? lowPoly(high, LOD2_TRIS[kind]) : null };
  }
  kitCache = { pieces };
  return kitCache;
}

// Where everything stands, decided once and shared by LOD0 and LOD1:
// spires and crags in a ring at the crater's lip leaning in over the hole
// like broken teeth, a few crags scattered down the slopes, and the broken
// pillars spaced around the mound's skirt. Heights come from the mound
// itself (a ray straight down), so nothing floats or sinks.
function placements(dims, height, groundAt, rnd) {
  const out = [];
  // Tall pieces are stretched up rather than grown all over (slender, so
  // they fill the lot's height without crowding the crater), and never
  // reach past its roof.
  const tall = (h, y, slim) => {
    const hh = Math.min(h, height - y - 0.6);
    return [hh * slim, hh, hh * slim];
  };
  const ring = 26;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * TAU + rnd() * 0.12;
    const spire = i % 2 === 0 || rnd() < 0.25;
    const r = dims.rc * (spire ? 0.98 + rnd() * 0.16 : 1.05 + rnd() * 0.25);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = groundAt(x, z);
    // The crown of fangs round the lip: most of the lot's height, a few
    // shorter between them; crags at their feet.
    const h = spire ? height * (i % 4 === 0 ? 0.45 + rnd() * 0.15 : 0.6 + rnd() * 0.22) : dims.S * (0.07 + rnd() * 0.07);
    const lean = spire ? 0.06 + rnd() * 0.16 : rnd() * 0.25;
    const scale = spire ? tall(h, y, 0.55) : [h, h, h];
    out.push({ kind: spire ? 'spire' : 'crag', pos: [x, y - scale[1] * 0.06, z], rot: [-Math.sin(a) * lean, rnd() * TAU, Math.cos(a) * lean], scale, order: 'ZXY' });
  }
  for (let i = 0; i < 9; i++) {
    const a = rnd() * TAU;
    const edge = edgeRadius(a, dims.hx, dims.hz);
    const r = dims.rc * 1.35 + (edge - dims.rc * 1.35) * rnd() * 0.75;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = dims.S * (0.05 + rnd() * 0.06);
    out.push({ kind: 'crag', slope: true, pos: [x, groundAt(x, z) - h * 0.08, z], rot: [(rnd() - 0.5) * 0.3, rnd() * TAU, (rnd() - 0.5) * 0.3], scale: [h, h, h], order: 'XYZ' });
  }
  const kinds = ['pillar-a', 'pillar-b', 'pillar-c'];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.4 + rnd() * 0.3;
    const edge = edgeRadius(a, dims.hx, dims.hz);
    const r = dims.rc + (edge - dims.rc) * (0.55 + rnd() * 0.15);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const kind = kinds[i % 3];
    const y = groundAt(x, z);
    // Ruined columns standing as tall as the crown; the broken one shorter.
    const h = kind === 'pillar-b' ? height * (0.3 + rnd() * 0.12) : height * (0.55 + rnd() * 0.25);
    // A few lean as if about to topple.
    const tilt = rnd() < 0.35 ? 0.06 + rnd() * 0.08 : 0;
    out.push({ kind, pos: [x, y - 0.15, z], rot: [tilt * Math.cos(a), rnd() * TAU, tilt * Math.sin(a)], scale: tall(h, y, kind === 'pillar-b' ? 0.75 : 0.6), order: 'YXZ' });
  }
  return out;
}

function piecesGeometry(list, pieces, which, dims) {
  const geos = [];
  for (const p of list) {
    const piece = pieces[p.kind];
    if (!piece?.[which]) continue;
    const g = placed(piece[which], { pos: p.pos, rot: p.rot, order: p.order, scale: p.scale });
    // A big piece near the lot's side is drawn back inside it.
    g.computeBoundingBox();
    const b = g.boundingBox;
    const X = dims.hx + 0.2;
    const Z = dims.hz + 0.2;
    g.translate(Math.min(0, X - b.max.x) + Math.max(0, -X - b.min.x), 0, Math.min(0, Z - b.max.z) + Math.max(0, -Z - b.min.z));
    geos.push(g);
  }
  return geos.length ? boxUv(mergeGeometries(geos.map(prep))) : null;
}

// Ground height under (x, z), by a ray down onto a mound mesh.
function groundSampler(geo) {
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const from = new THREE.Vector3();
  return (x, z) => {
    ray.set(from.set(x, 100, z), down);
    const hit = ray.intersectObject(mesh, false)[0];
    return hit ? hit.point.y : 0;
  };
}

// Where the pit's lava may land: points on the open slope round the lip
// (not on top of a spire or pillar), with their exact height.
function landingSpots(dims, ground, propsMesh, rnd) {
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const spots = [];
  for (let i = 0; i < 160 && spots.length < 72; i++) {
    const a = rnd() * TAU;
    const r = dims.rc * (1.08 + rnd() * 0.75);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.abs(x) > dims.hx - 1 || Math.abs(z) > dims.hz - 1) continue;
    const y = ground(x, z);
    if (propsMesh) {
      ray.set(new THREE.Vector3(x, 100, z), down);
      const hit = ray.intersectObject(propsMesh, false)[0];
      if (hit && hit.point.y > y + 0.2) continue;
    }
    spots.push([+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)]);
  }
  return spots;
}

// The lake of fire filling the bottom of the crater: up the funnel to
// LAVA_Y, its edge tucked into the funnel's wall.
export const LAVA_Y = 1.3;
export function lavaRadius(dims) {
  const k = (LAVA_Y - 0.25) / (dims.hm - 0.25);
  return dims.rb + (dims.rc - dims.rb) * Math.pow(k, 0.7) + 0.35;
}
function pitFloor(dims, segs) {
  const g = new THREE.CircleGeometry(lavaRadius(dims), segs, 0, TAU);
  g.rotateX(-Math.PI / 2);
  g.translate(0, LAVA_Y, 0);
  return g;
}

function glowTexture(size = 64) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, '#ffe2a0');
  grad.addColorStop(0.5, '#ff6a18');
  grad.addColorStop(1, '#a01404');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function materials() {
  const rock = rockTextures(265, [58, 46, 44]);
  const glowMap = glowTexture();
  return {
    rock: new THREE.MeshStandardMaterial({ name: 'Rock', map: rock.map, roughness: 0.95, metalness: 0 }),
    smoke: new THREE.MeshStandardMaterial({ name: 'Smoke', color: 0x2a2224, roughness: 1, metalness: 0, transparent: true, opacity: 0.6, depthWrite: false }),
    glow: new THREE.MeshStandardMaterial({ name: 'Glow', map: glowMap, emissive: 0xffffff, emissiveMap: glowMap, emissiveIntensity: 1.6, roughness: 0.6, color: 0x220400 }),
    // The lake: its crust, seams and ripples are all its shader's (lava.glsl).
    lava: new THREE.MeshStandardMaterial({ name: 'Lava', color: 0x140302, emissive: 0xff5010, emissiveIntensity: 1, roughness: 0.9 }),
  };
}

function mesh(name, geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  return m;
}

export async function buildLod0(width, depth, height, models) {
  const dims = shape(width, depth, height);
  const rnd = mulberry32(265);
  const K = await kit(models);
  const M = materials();
  const root = new THREE.Group();
  root.name = 'HellMouth';
  const groundGeo = mound(dims, { segs: 160, rings: 18, lift: 0.1 });
  const ground = groundSampler(groundGeo);
  const list = placements(dims, height, ground, mulberry32(266));
  root.add(mesh('Ground', prep(groundGeo), M.rock));
  const props = piecesGeometry(list, K.pieces, 'high', dims);
  let propsMesh = null;
  if (props) root.add((propsMesh = mesh('Pieces', props, M.rock)));
  root.add(mesh('Pit', prep(pitFloor(dims, 72)), M.lava));
  root.add(mesh('Fog', merge(fogPuffs(dims, 34, rnd)), M.smoke));
  for (let i = 0; i < LAVA_COUNT; i++) {
    // Each gob sits at the lot's origin; the script moves the node.
    const g = new THREE.IcosahedronGeometry(0.12 + dims.S * 0.004, 1);
    const m = mesh(`Lava${i}`, prep(g), M.glow);
    m.scale.setScalar(0.001);
    root.add(m);
  }
  propsMesh?.updateMatrixWorld(true);
  const landing = landingSpots(dims, ground, propsMesh, mulberry32(267));
  return { root, dims, landing };
}

export async function buildLod1(width, depth, height, models) {
  const dims = shape(width, depth, height);
  const K = await kit(models);
  const M = materials();
  const root = new THREE.Group();
  root.name = 'HellMouth';
  // The mound and every piece in one mesh, on the rock texture.
  const groundHigh = mound(dims, { segs: 160, rings: 18, lift: 0.1 });
  const list = placements(dims, height, groundSampler(groundHigh), mulberry32(266));
  const ground = prep(mound(dims, { segs: 56, rings: 7, lift: 0.35 }));
  const pieces = piecesGeometry(list, K.pieces, 'low', dims);
  root.add(mesh('Ground', pieces ? mergeGeometries([ground, pieces]) : ground, M.rock));
  root.add(mesh('Glow', prep(pitFloor(dims, 20)), M.glow));
  return { root, dims };
}

export async function buildLod2(width, depth, height, models) {
  const dims = shape(width, depth, height);
  const K = await kit(models);
  // One texture: the mound's rock as its average colour on the left half (a
  // shade darker, as the whole build glows a little), fire on the right.
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.drawImage(rockTextures(265, [58, 46, 44]).map.image, 0, 0, 128, 256);
  const px = g.getImageData(0, 0, 128, 256).data;
  const avg = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) avg[k] += px[i + k];
  const n = px.length / 4;
  g.fillStyle = `rgb(${avg.map((v) => Math.round((v / n) * 0.8)).join(',')})`;
  g.fillRect(0, 0, 128, 256);
  const grad = g.createLinearGradient(128, 0, 256, 0);
  grad.addColorStop(0, '#ff8a2a');
  grad.addColorStop(1, '#c41a06');
  g.fillStyle = grad;
  g.fillRect(128, 0, 128, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ name: 'Rock', map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1, roughness: 0.95 });
  const toHalf = (geo, right) => {
    const p = prep(geo);
    const uv = p.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (right ? 0.52 : 0.02) + 0.46 * (((uv.getX(i) % 1) + 1) % 1), 0.5);
    return p;
  };
  const list = placements(dims, height, groundSampler(mound(dims, { segs: 160, rings: 18, lift: 0.1 })), mulberry32(266));
  const rockGeo = toHalf(mound(dims, { segs: 24, rings: 3, lift: 1.0 }), false);
  const fire = toHalf(pitFloor(dims, 10), true);
  // The spires and pillars as a few dozen triangles each (no crags).
  const pieces = piecesGeometry(list, K.pieces, 'far', dims);
  const parts = [rockGeo, fire];
  if (pieces) parts.push(toHalf(pieces, false));
  const root = new THREE.Group();
  root.name = 'HellMouth';
  root.add(mesh('HellMouth', mergeGeometries(parts), mat));
  return { root, dims };
}

export function stats(root) {
  let tris = 0;
  let draws = 0;
  const mats = new Set();
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    draws++;
    mats.add(o.material.name);
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return { tris: Math.round(tris), draws, materials: [...mats], min: box.min.toArray().map((v) => +v.toFixed(2)), max: box.max.toArray().map((v) => +v.toFixed(2)) };
}

export async function exportGlb(root) {
  const exporter = new GLTFExporter();
  return exporter.parseAsync(root, { binary: true, onlyVisible: true, includeCustomExtensions: false });
}

// Build all three; returns base64 GLBs plus stats (for scripts/make-lot.mjs).
export async function buildLot({ width, depth, height }, models = globalThis.lotModels) {
  const out = {};
  for (const [name, build] of [['lod0', buildLod0], ['lod1', buildLod1], ['lod2', buildLod2]]) {
    const { root, dims, landing } = await build(width, depth, height, models);
    const buf = await exportGlb(root);
    let s = '';
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    out[name] = { glb: btoa(s), stats: stats(root), dims: { rc: dims.rc, rb: dims.rb, hm: dims.hm, pool: dims.pool, lavaY: dims.lavaY }, landing };
  }
  return out;
}
