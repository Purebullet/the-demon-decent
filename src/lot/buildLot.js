import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { rockTextures, makeCanvas } from '../world/Textures.js';
import { mulberry32, fbm2 } from '../core/rng.js';

// The lot's street view: a hell-mouth diorama that stays inside the lot's
// box (origin at the middle of the floor, metres, +Y up). A volcanic mound
// torn open by a crater holding a lake of fire, two colossal demon horns
// rising from its lip and curling over it, ruined hell towers and broken
// pillars on its slopes and jagged crags round the lip (their shapes
// generated with Zoodle, all of the mound's own rock), billows of fog boiling
// up out of the hole, and gobs of lava it spits out now and then, which land
// on the slopes, smoulder and go out. The game itself lives inside, as an experience.
//
// Three levels of detail, as Project 0 asks (skill.md section 3):
//   LOD0  materials Rock (the mound and the pieces), Lava, Glow, Smoke; the Fog
//         shader and the Lava nodes move (lot.json)
//   LOD1  every piece again, cut down by meshoptimizer, static: Rock and Glow
//         (the same shaders, as Project 0 gives LOD1 the materials it shares
//         by name with LOD0)
//   LOD2  one mesh, one material, one 256 px texture: the mound, the pit and
//         very light copies of the horns, towers and pillars

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
  dims.hole = dims.pool * HOLE;
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
      const x = ca * r;
      const z = sa * r;
      pos.push(x, y, z);
      // The texture's coordinates drift and swirl across the mound, so its
      // tile never lines up into a visible grid.
      const wx = (fbm2(x * 0.11 + 3.1, z * 0.11 - 1.7, 3, 21) - 0.5) * 4.5;
      const wz = (fbm2(x * 0.11 - 5.3, z * 0.11 + 2.9, 3, 22) - 0.5) * 4.5;
      uv.push((x + wx) / 3.3, (z + wz + y) / 3.3);
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
    const r0 = dims.pool * HOLE * Math.sqrt(rnd()) * 0.8;
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
const KINDS = ['horn', 'tower', 'crag', 'pillar-a', 'pillar-b', 'pillar-c'];

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

// Triangles per piece in LOD1 and LOD2 (the tall pieces only).
const LOD1_TRIS = { horn: 420, tower: 460, crag: 130, 'pillar-a': 300, 'pillar-b': 220, 'pillar-c': 300 };
const LOD2_TRIS = { horn: 44, tower: 44, crag: 0, 'pillar-a': 24, 'pillar-b': 0, 'pillar-c': 24 };

// Which way a piece leans or curls (the direction from the middle of its
// foot to the middle of its top, as an angle in its own x-z), so a horn can
// be turned to curl in over the crater.
function leanOf(g) {
  const p = g.attributes.position;
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const a = y < 0.15 ? lo : y > 0.85 ? hi : null;
    if (!a) continue;
    a[0] += p.getX(i);
    a[1] += p.getZ(i);
    a[2]++;
  }
  return Math.atan2(hi[1] / Math.max(1, hi[2]) - lo[1] / Math.max(1, lo[2]), hi[0] / Math.max(1, hi[2]) - lo[0] / Math.max(1, lo[2]));
}

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
    pieces[kind] = { high, lean: leanOf(high), low: lowPoly(high, LOD1_TRIS[kind]), far: LOD2_TRIS[kind] ? lowPoly(high, LOD2_TRIS[kind]) : null };
  }
  kitCache = { pieces };
  return kitCache;
}

// Where everything stands, decided once and shared by every LOD. Two
// colossal horns rise from the crater's lip at its ends, curling in over
// the lake of fire; ruined hell towers stand on the slopes toward the
// corners; broken pillars between them; a ring of jagged crags round the
// lip. Every piece keeps its own proportions (scaled whole, never
// stretched) and stays under the lot's roof. Heights come from the mound
// itself (a ray straight down), so nothing floats or sinks.
function placements(dims, height, groundAt, rnd) {
  const out = [];
  const fit = (h, y) => Math.max(0.5, Math.min(h, height - y - 0.4));
  const at = (x, z) => [x, groundAt(x, z), z];
  // The horns, on the lot's long axis.
  const long = dims.hz >= dims.hx;
  for (const side of [-1, 1]) {
    const r = dims.rc * 1.12;
    const x = long ? (rnd() - 0.5) * 1.2 : side * r;
    const z = long ? side * r : (rnd() - 0.5) * 1.2;
    const [, y] = at(x, z);
    const h = fit(height * 0.92, y);
    out.push({ kind: 'horn', pos: [x, y - h * 0.03, z], rot: [0, 0, 0], scale: [h, h, h], order: 'XYZ', faceIn: true });
  }
  // The towers, out toward the corners.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const a = Math.atan2(sz * dims.hz, sx * dims.hx);
    const edge = edgeRadius(a, dims.hx, dims.hz);
    const r = dims.rc + (edge - dims.rc) * (0.42 + rnd() * 0.12);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const [, y] = at(x, z);
    const h = fit(height * (0.6 + rnd() * 0.14), y);
    out.push({ kind: 'tower', pos: [x, y - 0.2, z], rot: [0, rnd() * TAU, 0], scale: [h, h, h], order: 'XYZ' });
  }
  // Jagged crags round the lip, between the horns.
  const ring = 14;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * TAU + rnd() * 0.15;
    const r = dims.rc * (1.0 + rnd() * 0.18);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const [, y] = at(x, z);
    const h = dims.S * (0.09 + rnd() * 0.07);
    const lean = rnd() * 0.2;
    out.push({ kind: 'crag', pos: [x, y - h * 0.08, z], rot: [-Math.sin(a) * lean, rnd() * TAU, Math.cos(a) * lean], scale: [h, h, h], order: 'ZXY' });
  }
  // Broken rocks round the opening in the lake, half sunk in the melt.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + (rnd() - 0.5) * 0.6;
    const r = Math.min(holeEdge(dims, a) * (1.3 + rnd() * 0.45), dims.pool - 0.9);
    const h = 0.8 + rnd() * 0.8;
    const lean = 0.15 + rnd() * 0.25;
    out.push({ kind: 'crag', pos: [Math.cos(a) * r, LAVA_Y - h * 0.5, Math.sin(a) * r], rot: [-Math.sin(a) * lean, rnd() * TAU, Math.cos(a) * lean], scale: [h * 1.25, h, h * 1.25], order: 'ZXY' });
  }
  // Broken pillars on the sides, between the towers.
  const kinds = ['pillar-a', 'pillar-c', 'pillar-b'];
  const spots = long ? [0, Math.PI, Math.PI * 0.5 + 0.35, Math.PI * 1.5 - 0.35] : [Math.PI * 0.5, Math.PI * 1.5, 0.35, Math.PI - 0.35];
  spots.forEach((a, i) => {
    const edge = edgeRadius(a, dims.hx, dims.hz);
    const r = dims.rc + (edge - dims.rc) * (0.5 + rnd() * 0.15);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const [, y] = at(x, z);
    const kind = kinds[i % 3];
    const h = fit(kind === 'pillar-b' ? height * 0.24 : height * (0.36 + rnd() * 0.1), y);
    const tilt = rnd() < 0.3 ? 0.05 + rnd() * 0.06 : 0;
    out.push({ kind, pos: [x, y - 0.15, z], rot: [tilt * Math.cos(a), rnd() * TAU, tilt * Math.sin(a)], scale: [h, h, h], order: 'YXZ' });
  });
  return out;
}

function piecesGeometry(list, pieces, which, dims) {
  const geos = [];
  for (const p of list) {
    const piece = pieces[p.kind];
    if (!piece?.[which]) continue;
    // A horn turned so that it curls in over the crater.
    const rot = p.faceIn ? [p.rot[0], piece.lean - Math.atan2(-p.pos[2], -p.pos[0]), p.rot[2]] : p.rot;
    const g = placed(piece[which], { pos: p.pos, rot, order: p.order, scale: p.scale });
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

// What a down ray from (x, top, z) first meets among meshes (front faces
// only, so a ray starting inside a pillar passes out through its floor):
// { y, n } with the face's normal, or null.
function drapeOnto(meshes) {
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const from = new THREE.Vector3();
  return (x, z, top) => {
    ray.set(from.set(x, top, z), down);
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? { y: hit.point.y, n: hit.face.normal.clone() } : null;
  };
}

// Whether a gob thrown from the hole to `to` (on any of the script's arcs,
// build.js) clears the horns, towers and pillars, and the mound until it
// comes down.
function arcClear(dims, to, ground, props) {
  const ray = new THREE.Raycaster();
  const a = Math.atan2(to[2], to[0]);
  const from = [Math.cos(a) * dims.rb * 0.4, 0.4, Math.sin(a) * dims.rb * 0.4];
  const at = (k, peak) => new THREE.Vector3(
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k + 4 * (peak - Math.max(from[1], to[1])) * k * (1 - k),
    from[2] + (to[2] - from[2]) * k,
  );
  const N = 28;
  for (const lift of [5, 8, 11]) {
    const peak = Math.max(to[1], 0) + lift;
    for (let i = 0; i < N; i++) {
      const p = at(i / N, peak);
      const q = at((i + 1) / N, peak);
      const d = q.clone().sub(p);
      ray.set(p, d.clone().normalize());
      ray.far = d.length();
      if (props && ray.intersectObject(props, false).length) return false;
      if (i < N - 2 && ray.intersectObject(ground, false).length) return false;
    }
  }
  return true;
}

// Where the pit's lava may land: points on the slope round the lip (or on a
// crag there) that a throw reaches without passing through anything, far
// enough apart that their splashes never overlap (the Lava shader tells one
// splash from another by where it is), with the exact height of what is there.
export const SPLASH_REACH = 1.6;
function landingSpots(dims, drape, ground, props, rnd) {
  const onGround = drapeOnto([ground]);
  const spots = [];
  for (let i = 0; i < 1200 && spots.length < 40; i++) {
    const a = rnd() * TAU;
    const r = dims.rc * (1.08 + rnd() * 0.8);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.abs(x) > dims.hx - SPLASH_REACH - 0.2 || Math.abs(z) > dims.hz - SPLASH_REACH - 0.2) continue;
    if (spots.some((s) => Math.hypot(s[0] - x, s[2] - z) < SPLASH_REACH * 2 + 0.3)) continue;
    const g = onGround(x, z, 100);
    const hit = g && drape(x, z, g.y + 1.4);
    if (!hit || hit.n.y < 0.5) continue;
    // Not where the rock is too broken to lie on (a splash would hang
    // down the face of a crag like a curtain).
    let rough = false;
    for (let j = 0; j < 12 && !rough; j++) {
      const b = (j / 12) * TAU;
      const h = drape(x + Math.cos(b) * 1.1, z + Math.sin(b) * 1.1, hit.y + 1.6);
      rough = !h || Math.abs(h.y - hit.y) > 0.9;
    }
    if (rough) continue;
    const to = [+x.toFixed(2), +hit.y.toFixed(2), +z.toFixed(2)];
    if (!arcClear(dims, to, ground, props)) continue;
    spots.push(to);
  }
  return spots;
}

// The splash a gob makes where it lands, laid onto whatever is there: the
// slope, a crag, the foot of a pillar. A blot with a ragged edge, a few
// fingers flung out, a tongue running on downhill and droplets round it,
// every point dropped onto the rock below it and lifted just off it (thicker
// in the middle). It stays folded away until the Lava shader opens it.
function splash(spot, drape, rnd) {
  const [cx, cy, cz] = spot;
  const top = cy + 1.6;
  const h = (x, z) => drape(x, z, top)?.y ?? cy;
  const e = 0.35;
  const gx = (h(cx + e, cz) - h(cx - e, cz)) / (2 * e);
  const gz = (h(cx, cz + e) - h(cx, cz - e)) / (2 * e);
  const downhill = Math.atan2(-gz, -gx);
  const tongue = Math.min(1.1, Math.hypot(gx, gz) * 1.4);
  const base = 0.5 + rnd() * 0.22;
  const ph = rnd() * TAU;
  const fingers = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => [rnd() * TAU, 0.35 + rnd() * 0.55]);
  const turn = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const edge = (a) => {
    let r = base * (0.88 + 0.16 * Math.sin(3 * a + ph) + 0.09 * Math.sin(7 * a + 2 * ph));
    r *= 1 + tongue * Math.pow(Math.max(0, Math.cos(a - downhill)), 4);
    for (const [fa, fl] of fingers) r += base * fl * Math.exp(-Math.pow(turn(a - fa) / 0.17, 2));
    return Math.min(r, SPLASH_REACH - 0.05);
  };
  const pos = [];
  const idx = [];
  const put = (x, z, thick) => {
    const hit = drape(x, z, top);
    const y = hit ? hit.y : cy;
    const n = hit && hit.n.y > 0.05 ? hit.n : new THREE.Vector3(0, 1, 0);
    const lift = 0.03 + thick;
    pos.push(x + n.x * lift, y + n.y * lift, z + n.z * lift);
    return pos.length / 3 - 1;
  };
  const SEGS = 20;
  const RINGS = 4;
  const c0 = put(cx, cz, 0.06);
  const rings = [];
  for (let i = 1; i <= RINGS; i++) {
    const f = i / RINGS;
    rings.push(Array.from({ length: SEGS }, (_, j) => {
      const a = (j / SEGS) * TAU;
      const r = edge(a) * f;
      return put(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.06 * (1 - f * f));
    }));
  }
  for (let j = 0; j < SEGS; j++) {
    const k = (j + 1) % SEGS;
    idx.push(c0, rings[0][k], rings[0][j]);
    for (let i = 0; i < RINGS - 1; i++) idx.push(rings[i][j], rings[i][k], rings[i + 1][k], rings[i][j], rings[i + 1][k], rings[i + 1][j]);
  }
  // Droplets flung past the edge.
  const drops = 3 + Math.floor(rnd() * 3);
  for (let d = 0; d < drops; d++) {
    const a = rnd() * TAU;
    const r = Math.min(edge(a) * (1.15 + rnd() * 0.5), SPLASH_REACH - 0.2);
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const size = 0.05 + rnd() * 0.1;
    const m = put(x, z, 0.015);
    const ring = Array.from({ length: 7 }, (_, j) => put(x + Math.cos((j / 7) * TAU) * size, z + Math.sin((j / 7) * TAU) * size, 0));
    for (let j = 0; j < 7; j++) idx.push(m, ring[(j + 1) % 7], ring[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return faceUp(g);
}

// Flip a geometry's winding if its first normal points down.
function faceUp(g) {
  if (g.attributes.normal.getY(0) >= 0) return g;
  const ix = g.index.array;
  for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]];
  g.computeVertexNormals();
  return g;
}

// The lake of fire filling the bottom of the crater: up the funnel to
// LAVA_Y, its edge tucked into the funnel's wall.
export const LAVA_Y = 1.3;
export function lavaRadius(dims) {
  const k = (LAVA_Y - 0.25) / (dims.hm - 0.25);
  return dims.rb + (dims.rc - dims.rb) * Math.pow(k, 0.7) + 0.35;
}
// The lake is a ring round the opening at its middle, where the melt pours
// over a broken lip and down a rough throat that widens below it into the
// dark. The opening's edge wanders in and out (a few waves round it, the
// same in the Lava shader, so the lip's glow follows the real edge).
export const HOLE = 0.31;
export const HOLE_WAVES = [[2, 0.11, 0.7], [3, 0.12, 2.6], [5, 0.08, 4.4], [8, 0.05, 1.3], [13, 0.03, 5.2]];
export function holeEdge(dims, a) {
  let k = 1;
  for (const [f, amp, ph] of HOLE_WAVES) k += amp * Math.sin(f * a + ph);
  return dims.hole * k;
}
// A ring of rows from the opening's edge out to the lake's rim.
function lakeRing(dims, segs) {
  const pool = lavaRadius(dims);
  const ROWS = 5;
  const pos = [];
  const idx = [];
  for (let j = 0; j <= segs; j++) {
    const a = (j / segs) * TAU;
    const r0 = holeEdge(dims, a);
    for (let i = 0; i < ROWS; i++) {
      const r = r0 + (pool - r0) * Math.pow(i / (ROWS - 1), 1.3);
      pos.push(Math.cos(a) * r, LAVA_Y, Math.sin(a) * r);
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < ROWS - 1; i++) {
      const p = j * ROWS + i;
      const q = (j + 1) * ROWS + i;
      idx.push(p, q, p + 1, q, q + 1, p + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return faceUp(g);
}
function throat(dims, segs, rnd = mulberry32(269)) {
  const h = dims.hole;
  // The lip rolls over and the wall falls away, widening under the lake;
  // every row but the lip's is pushed in and out a little, so the wall is
  // rough rock, not a turned bowl.
  const profile = [[1, LAVA_Y], [0.95, LAVA_Y - 0.08], [0.93, LAVA_Y - 0.25], [1.02, LAVA_Y * 0.62], [1.12, LAVA_Y * 0.32], [1.22, 0.02]];
  const P = profile.length;
  const pos = [];
  const idx = [];
  const rough = Array.from({ length: segs }, () => profile.map((_, i) => (i < 2 ? 0 : (rnd() - 0.5) * 0.22)));
  for (let j = 0; j <= segs; j++) {
    const a = (j / segs) * TAU;
    const edge = holeEdge(dims, a);
    profile.forEach(([k, y], i) => {
      const r = edge * k + rough[j % segs][i] * h;
      pos.push(Math.cos(a) * r, y + (i > 1 && i < P - 1 ? rough[j % segs][i] * 0.6 : 0), Math.sin(a) * r);
    });
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < P - 1; i++) {
      const a = j * P + i;
      const b = (j + 1) * P + i;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const wall = new THREE.BufferGeometry();
  wall.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  wall.setIndex(idx);
  wall.computeVertexNormals();
  // The wall faces in, toward the axis.
  if (wall.attributes.normal.getX(2) > 0) {
    const ix = wall.index.array;
    for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]];
    wall.computeVertexNormals();
  }
  // The floor far below, filling the wall's last row.
  const fpos = [0, 0.02, 0];
  const fidx = [];
  for (let j = 0; j < segs; j++) {
    const v = (j * P + P - 1) * 3;
    fpos.push(pos[v], 0.02, pos[v + 2]);
  }
  for (let j = 0; j < segs; j++) fidx.push(0, 1 + ((j + 1) % segs), 1 + j);
  const floor = new THREE.BufferGeometry();
  floor.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  floor.setIndex(fidx);
  floor.computeVertexNormals();
  return [wall, faceUp(floor)];
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
  // Where the lava lands, and the splash it leaves there, laid on the mound
  // and the pieces.
  const groundMesh = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial());
  groundMesh.updateMatrixWorld(true);
  propsMesh?.updateMatrixWorld(true);
  const surfaces = propsMesh ? [groundMesh, propsMesh] : [groundMesh];
  const drape = drapeOnto(surfaces);
  const landing = landingSpots(dims, drape, groundMesh, propsMesh, mulberry32(267));
  const splashRnd = mulberry32(268);
  const splashes = landing.map((spot) => splash(spot, drape, splashRnd));
  root.add(mesh('Pit', merge([lakeRing(dims, 96), ...throat(dims, 96), ...splashes]), M.lava));
  root.add(mesh('Fog', merge(fogPuffs(dims, 34, rnd)), M.smoke));
  for (let i = 0; i < LAVA_COUNT; i++) {
    // Each gob sits at the lot's origin; the script moves the node.
    const g = new THREE.IcosahedronGeometry(0.12 + dims.S * 0.004, 1);
    const m = mesh(`Lava${i}`, prep(g), M.glow);
    m.scale.setScalar(0.001);
    root.add(m);
  }
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
  const hole = throat(dims, 32).map(prep);
  root.add(mesh('Ground', mergeGeometries([ground, ...(pieces ? [pieces] : []), ...hole]), M.rock));
  root.add(mesh('Glow', prep(lakeRing(dims, 32)), M.glow));
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
  // The horns, towers and pillars as a few dozen triangles each (no crags).
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
  // Welded: the meshes are built unindexed (to merge freely), and sharing
  // the corners triangles have in common keeps the file well under budget.
  root.traverse((o) => {
    if (o.isMesh && !o.geometry.index) o.geometry = mergeVertices(o.geometry, 1e-5);
  });
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
    out[name] = { glb: btoa(s), stats: stats(root), dims: { rc: dims.rc, rb: dims.rb, hm: dims.hm, pool: dims.pool, hole: dims.hole, waves: HOLE_WAVES, lavaY: dims.lavaY }, landing };
  }
  return out;
}
