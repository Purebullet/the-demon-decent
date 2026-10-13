import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rockTextures, makeCanvas } from '../world/Textures.js';
import { mulberry32, fbm2 } from '../core/rng.js';

// The lot's street view: a hell-mouth diorama that stays inside the lot's
// box (origin at the middle of the floor, metres, +Y up). A volcanic mound
// torn open by a glowing pit, a ring of broken teeth leaning over it, ruined
// columns, billows of fog boiling up out of the hole, and gobs of lava it
// spits out now and then onto the slopes around it. The game itself lives inside, as an experience.
//
// Three levels of detail, as Project 0 asks (skill.md section 3):
//   LOD0  materials Rock, Ruin, Glow, Smoke; the Fog shader and the Lava nodes move (lot.json)
//   LOD1  the same shapes, simplified and static; materials Rock and Glow
//   LOD2  one mesh, one material, one 256 px texture

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
  return { S, hx, hz, rc, rb, hm };
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

function shards(dims, count, rnd, height) {
  const list = [];
  const cone = new THREE.ConeGeometry(1, 1, 5, 2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rnd() * 0.15;
    const r = dims.rc * (1.02 + rnd() * 0.25);
    const h = Math.min(height * 0.42, dims.S * (0.12 + rnd() * 0.22));
    const w = h * (0.12 + rnd() * 0.08);
    const lean = 0.25 + rnd() * 0.45;
    const g = placed(cone, {
      pos: [Math.cos(a) * r, dims.hm * 0.85 + h * 0.4, Math.sin(a) * r],
      rot: [-Math.sin(a) * lean, rnd() * 6, Math.cos(a) * lean],
      order: 'ZXY',
      scale: [w, h, w * (0.7 + rnd() * 0.5)],
    });
    list.push(g);
  }
  return list;
}

function columns(dims, count, rnd, detail) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + 0.4 + rnd() * 0.3;
    const edge = edgeRadius(a, dims.hx, dims.hz);
    const r = dims.rc + (edge - dims.rc) * 0.62;
    const h = dims.S * (0.1 + rnd() * 0.16);
    const rad = dims.S * 0.028;
    const g = new THREE.CylinderGeometry(rad * 0.92, rad, h, detail, 2);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) if (p.getY(k) > h / 2 - 0.01) p.setY(k, p.getY(k) - rnd() * h * 0.25);
    g.computeVertexNormals();
    const groundY = dims.hm * Math.pow(1 - (r - dims.rc) / (edge - dims.rc), 1.6) * 0.9;
    list.push(placed(g, { pos: [Math.cos(a) * r, groundY + h / 2 - 0.1, Math.sin(a) * r], rot: [0, rnd() * 6, 0] }));
    const base = new THREE.BoxGeometry(rad * 3.2, rad * 1.2, rad * 3.2);
    list.push(placed(base, { pos: [Math.cos(a) * r, groundY + rad * 0.3, Math.sin(a) * r], rot: [0, a, 0] }));
  }
  return list;
}

// Billows of fog boiling up out of the pit: puffs (spheres) that the Smoke
// shader lifts, swells and fades on a loop, each on its own phase. Every
// vertex carries its puff's phase in uv.x and the puff's radius in uv.y; the
// shader finds the puff's centre as position - normal * radius.
function fogPuffs(dims, count, rnd, detail) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * TAU;
    const r0 = dims.rb * Math.sqrt(rnd()) * 0.9;
    const rad = dims.S * (0.05 + rnd() * 0.05);
    const g = new THREE.IcosahedronGeometry(rad, detail);
    g.translate(Math.cos(a) * r0, rad + 0.3 + rnd() * 0.6, Math.sin(a) * r0);
    const phase = i / count + rnd() * 0.05;
    const uv = new Float32Array(g.attributes.position.count * 2);
    for (let k = 0; k < uv.length; k += 2) {
      uv[k] = phase % 1;
      uv[k + 1] = rad;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    list.push(g);
  }
  return list;
}

// Gobs of lava the build's script throws out of the pit (one node each).
export const LAVA_COUNT = 6;

function pitFloor(dims, segs) {
  const g = new THREE.CircleGeometry(dims.rb * 1.05, segs);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.26, 0);
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
  const ruin = rockTextures(266, [92, 84, 80]);
  const glowMap = glowTexture();
  return {
    rock: new THREE.MeshStandardMaterial({ name: 'Rock', map: rock.map, roughness: 0.95, metalness: 0 }),
    ruin: new THREE.MeshStandardMaterial({ name: 'Ruin', map: ruin.map, roughness: 0.9, metalness: 0 }),
    smoke: new THREE.MeshStandardMaterial({ name: 'Smoke', color: 0x2a2224, roughness: 1, metalness: 0, transparent: true, opacity: 0.6, depthWrite: false }),
    glow: new THREE.MeshStandardMaterial({ name: 'Glow', map: glowMap, emissive: 0xffffff, emissiveMap: glowMap, emissiveIntensity: 1.6, roughness: 0.6, color: 0x220400 }),
  };
}

function mesh(name, geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  return m;
}

export function buildLod0(width, depth, height) {
  const dims = shape(width, depth, height);
  const rnd = mulberry32(265);
  const M = materials();
  const root = new THREE.Group();
  root.name = 'HellMouth';
  const rock = merge([mound(dims, { segs: 160, rings: 18, lift: 0.1 }), ...shards(dims, 30, rnd, height)]);
  root.add(mesh('Ground', rock, M.rock));
  root.add(mesh('Ruins', merge(columns(dims, 7, rnd, 12)), M.ruin));
  root.add(mesh('Pit', prep(pitFloor(dims, 48)), M.glow));
  root.add(mesh('Fog', merge(fogPuffs(dims, 26, rnd, 2)), M.smoke));
  for (let i = 0; i < LAVA_COUNT; i++) {
    // Each gob sits at the lot's origin; the script moves the node.
    const g = new THREE.IcosahedronGeometry(dims.S * 0.016 + 0.12, 1);
    const m = mesh(`Lava${i}`, prep(g), M.glow);
    m.scale.setScalar(0.001);
    root.add(m);
  }
  return { root, dims };
}

export function buildLod1(width, depth, height) {
  const dims = shape(width, depth, height);
  const rnd = mulberry32(265);
  const M = materials();
  const root = new THREE.Group();
  root.name = 'HellMouth';
  // Rock and ruins share one material at this distance.
  const rock = merge([mound(dims, { segs: 56, rings: 7, lift: 0.35 }), ...shards(dims, 18, rnd, height), ...columns(dims, 7, rnd, 6)]);
  root.add(mesh('Ground', rock, M.rock));
  root.add(mesh('Glow', prep(pitFloor(dims, 20)), M.glow));
  return { root, dims };
}

export function buildLod2(width, depth, height) {
  const dims = shape(width, depth, height);
  const rnd = mulberry32(265);
  // One texture: dark rock on the left half, fire on the right.
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#16100e';
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
  const rockGeo = toHalf(mound(dims, { segs: 24, rings: 3, lift: 1.0 }), false);
  const fire = [pitFloor(dims, 10)].map((x) => toHalf(x, true));
  const spikes = shards(dims, 8, rnd, height).map((x) => toHalf(x, false));
  const root = new THREE.Group();
  root.name = 'HellMouth';
  root.add(mesh('HellMouth', mergeGeometries([rockGeo, ...spikes, ...fire]), mat));
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
export async function buildLot({ width, depth, height }) {
  const out = {};
  for (const [name, build] of [['lod0', buildLod0], ['lod1', buildLod1], ['lod2', buildLod2]]) {
    const { root, dims } = build(width, depth, height);
    const buf = await exportGlb(root);
    let s = '';
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    out[name] = { glb: btoa(s), stats: stats(root), dims: { rc: dims.rc, rb: dims.rb, hm: dims.hm } };
  }
  return out;
}
