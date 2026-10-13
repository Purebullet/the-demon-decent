#!/usr/bin/env node
// The Storm Round as a ZER0-G machine (lot 383): a hover racer built around
// the player's bullet.
//
//   node scripts/make-machine.mjs [source.glb]
//
// From the static Tripo model (assets/source/avatar-bullet.glb, not in git)
// it writes machine/model.glb. The bullet is the fuselage, laid on its side
// with its tip to +Z and its flat base (the main exhaust, glowing) straight
// back, resting on y = 0, its textures at 1,024 px and its circuit lines
// faintly lit. Built around it: swept wings out to two thruster pods, each
// ending in a round nozzle facing straight back, a tail fin, a cockpit
// canopy over the casing and neon strips down the pods. The machine's data
// (machine/entity.json, whose `thrusters` are printed here) and its card
// (machine/picture.png) are kept by hand; `npm run p0 -- machine machine`
// checks or sends the three.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { readGlb, readAccessor, bufferViewBytes, GlbBuilder } from './glb.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = process.argv[2] || join(ROOT, 'assets/source/avatar-bullet.glb');
const OUT = join(ROOT, 'machine');
const TEX = 1024;

const src = readGlb(await readFile(SRC));
const prim = src.json.meshes[0].primitives[0];
const pos = readAccessor(src, prim.attributes.POSITION);
const nrm = readAccessor(src, prim.attributes.NORMAL);
const uv = readAccessor(src, prim.attributes.TEXCOORD_0);
const index = readAccessor(src, prim.indices);

// Stood up, the bullet's tip is +Y. A quarter turn about X takes +Y to +Z:
// (x, y, z) -> (x, -z, y). Then down onto y = 0, centred on x and z.
const P = new Float32Array(pos.length);
const N = new Float32Array(nrm.length);
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) {
  P[i] = pos[i];
  P[i + 1] = -pos[i + 2];
  P[i + 2] = pos[i + 1];
  N[i] = nrm[i];
  N[i + 1] = -nrm[i + 2];
  N[i + 2] = nrm[i + 1];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], P[i + k]);
    max[k] = Math.max(max[k], P[i + k]);
  }
}
const shift = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) P[i + k] += shift[k];
const size = max.map((v, k) => v - min[k]);

// The exhaust: the round base, now facing -Z. Its radius, from the rearmost
// rear-facing vertices.
let r = 0;
const back = -size[2] / 2;
for (let i = 0; i < P.length; i += 3) if (N[i + 2] < -0.95 && P[i + 2] < back + 0.01) r = Math.max(r, Math.hypot(P[i], P[i + 1] - size[1] / 2));

// ---- The racer around it ---------------------------------------------------

const AXIS = size[1] / 2; // the fuselage's centre line, above the road
const BACK = back;
const POD = { x: 0.25, y: 0.068, r: 0.06, len: 0.54 };

// A flat slab between two outlines (top and bottom faces, four sides), from
// points given as [x, y, z]; flat-shaded.
function slab(top, bottom) {
  const tri = [];
  const quad = (a, b, c, d) => tri.push(a, b, c, a, c, d);
  const n = top.length;
  quad(...top);
  quad(...[...bottom].reverse());
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(bottom[i], bottom[j], top[j], top[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flat(), 3));
  // Wind every face outward from the slab's centre.
  const c = new THREE.Vector3();
  for (const p of [...top, ...bottom]) c.add(new THREE.Vector3(...p));
  c.divideScalar(2 * n);
  const P = g.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), nn = new THREE.Vector3(), m = new THREE.Vector3();
  for (let i = 0; i < P.count; i += 3) {
    a.fromBufferAttribute(P, i);
    b.fromBufferAttribute(P, i + 1);
    d.fromBufferAttribute(P, i + 2);
    nn.subVectors(b, a).cross(d.clone().sub(a));
    m.copy(a).add(b).add(d).divideScalar(3).sub(c);
    if (nn.dot(m) < 0) {
      P.setXYZ(i + 1, d.x, d.y, d.z);
      P.setXYZ(i + 2, b.x, b.y, b.z);
    }
  }
  g.computeVertexNormals();
  return g;
}
// A plate in the horizontal plane (x, z outline) at height y, `t` thick.
const plate = (pts, y, t) => slab(pts.map(([x, z]) => [x, y + t / 2, z]), pts.map(([x, z]) => [x, y - t / 2, z]));
// A plate in the vertical plane x = 0 (z, y outline), `t` thick.
const fin = (pts, t) => slab(pts.map(([z, y]) => [t / 2, y, z]), pts.map(([z, y]) => [-t / 2, y, z]));

// A thruster pod: a lathed nacelle along +Z, its nose rounded, its back a
// lipped bell around a flat, glowing nozzle face looking straight back.
function pod(side) {
  const L = POD.len / 2;
  const R = POD.r;
  const profile = [
    [R * 0.7, -L + 0.012],
    [R * 0.84, -L],
    [R * 0.96, -L + 0.02],
    [R, -L + 0.1],
    [R, 0.02],
    [R * 0.9, L - 0.12],
    [R * 0.62, L - 0.05],
    [R * 0.3, L - 0.012],
    [0, L],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const shell = new THREE.LatheGeometry(profile, 24).rotateX(Math.PI / 2);
  const nozzle = new THREE.CircleGeometry(R * 0.7, 24).rotateY(Math.PI).translate(0, 0, -L + 0.012);
  const at = (g) => g.translate(side * POD.x, POD.y, BACK + L);
  return { shell: at(shell), nozzle: at(nozzle), face: [side * POD.x, POD.y, BACK + 0.012, R * 0.7] };
}
const pods = [pod(-1), pod(1)];

// Swept wings from inside the fuselage out into the pods.
const wings = [-1, 1].map((s) =>
  plate(
    [
      [s * 0.08, BACK + 0.1],
      [s * 0.08, BACK + 0.44],
      [s * (POD.x - 0.03), BACK + 0.3],
      [s * (POD.x - 0.03), BACK + 0.05],
    ],
    0.088,
    0.016,
  ),
);
// A tail fin standing on the casing, swept back.
const top = AXIS + 0.118;
const tail = fin(
  [
    [BACK + 0.05, top - 0.02],
    [BACK + 0.3, top - 0.02],
    [BACK + 0.1, top + 0.11],
    [BACK - 0.01, top + 0.11],
  ],
  0.014,
);
// The cockpit canopy over the front of the casing.
const canopy = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.062, 0.05, 0.17).translate(0, top - 0.012, BACK + 0.36);
// Neon down the outer flank of each pod and along the fin's edge.
const neon = [
  ...[-1, 1].map((s) => new THREE.BoxGeometry(0.008, 0.012, 0.36).translate(s * (POD.x + POD.r - 0.002), POD.y + 0.01, BACK + 0.25)),
  // along the fin's leading edge, from its foot (front) up to its tip (back)
  new THREE.BoxGeometry(0.02, 0.01, Math.hypot(0.2, 0.13)).rotateX(Math.atan2(0.13, 0.2)).translate(0, top + 0.045, BACK + 0.2),
];
// The bullet's base burns too: a glowing core in the middle of its flat end.
const core = new THREE.CircleGeometry(r * 0.62, 32).rotateY(Math.PI).translate(0, AXIS, BACK - 0.002);

function merged(geos) {
  const list = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    if (!n.attributes.normal) n.computeVertexNormals();
    return n;
  });
  const m = mergeGeometries(list);
  return { position: m.attributes.position.array, normal: m.attributes.normal.array, count: m.attributes.position.count };
}
const parts = {
  lacquer: merged([...pods.map((p) => p.shell), ...wings, tail]),
  glass: merged([canopy]),
  neon: merged(neon),
  nozzle: merged([...pods.map((p) => p.nozzle), core]),
};

// Textures at TEX px, as JPEG.
const tmp = join(tmpdir(), `machine-${process.pid}`);
await mkdir(tmp, { recursive: true });
async function texture(i, quality) {
  const im = src.json.images[src.json.textures[i].source];
  const inPath = join(tmp, `in-${i}`);
  const outPath = join(tmp, `out-${i}.jpg`);
  await writeFile(inPath, bufferViewBytes(src, im.bufferView));
  execFileSync('python3', ['-c', `from PIL import Image; Image.open(${JSON.stringify(inPath)}).convert('RGB').resize((${TEX}, ${TEX}), Image.LANCZOS).save(${JSON.stringify(outPath)}, 'JPEG', quality=${quality}, optimize=True)`]);
  return readFile(outPath);
}
const pbr = src.json.materials[prim.material];
const texIndex = { color: pbr.pbrMetallicRoughness.baseColorTexture.index, orm: pbr.pbrMetallicRoughness.metallicRoughnessTexture.index, normal: pbr.normalTexture.index };

const g = new GlbBuilder();
const j = g.json;
j.asset.generator = 'The Demon Descent scripts/make-machine.mjs';
const A = (arr, type, o) => g.accessor(arr, type, o);
const shell = {
  attributes: { POSITION: A(P, 'VEC3', { target: 34962, minmax: true }), NORMAL: A(N, 'VEC3', { target: 34962 }), TEXCOORD_0: A(new Float32Array(uv), 'VEC2', { target: 34962 }) },
  indices: A(index.length < 65536 ? Uint16Array.from(index) : Uint32Array.from(index), 'SCALAR', { target: 34963 }),
  material: 0,
};
j.images = [];
for (const key of ['color', 'orm', 'normal']) {
  const bytes = await texture(texIndex[key], key === 'normal' ? 94 : 88);
  j.images.push({ name: key, mimeType: 'image/jpeg', bufferView: g.view(new Uint8Array(bytes)) });
}
j.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
j.textures = [0, 1, 2].map((s) => ({ source: s, sampler: 0 }));
j.materials = [
  {
    name: 'Storm Round',
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 1, roughnessFactor: 1 },
    normalTexture: { index: 2, scale: 1 },
    // Its own circuit lines glow faintly, electric blue.
    emissiveTexture: { index: 0 },
    emissiveFactor: [0.12, 0.3, 0.42],
  },
  // Deep blue lacquer over chrome: wings, pods and fin.
  { name: 'Lacquer', pbrMetallicRoughness: { baseColorFactor: [0.05, 0.16, 0.5, 1], metallicFactor: 0.6, roughnessFactor: 0.22 } },
  { name: 'Canopy', pbrMetallicRoughness: { baseColorFactor: [0.02, 0.06, 0.1, 1], metallicFactor: 0.2, roughnessFactor: 0.05 }, emissiveFactor: [0.02, 0.12, 0.18] },
  { name: 'Neon', pbrMetallicRoughness: { baseColorFactor: [0.05, 0.4, 0.55, 1], metallicFactor: 0, roughnessFactor: 0.5 }, emissiveFactor: [0.08, 0.62, 0.85] },
  { name: 'Nozzle', pbrMetallicRoughness: { baseColorFactor: [0.02, 0.2, 0.32, 1], metallicFactor: 0, roughnessFactor: 0.6 }, emissiveFactor: [0.05, 0.5, 0.78] },
];
const extra = ['lacquer', 'glass', 'neon', 'nozzle'].map((k, i) => ({
  attributes: { POSITION: A(new Float32Array(parts[k].position), 'VEC3', { target: 34962, minmax: true }), NORMAL: A(new Float32Array(parts[k].normal), 'VEC3', { target: 34962 }) },
  material: i + 1,
}));
j.meshes = [{ name: 'Storm Round', primitives: [shell, ...extra] }];
j.nodes = [{ name: 'Storm Round', mesh: 0 }];
j.scenes = [{ nodes: [0] }];
j.scene = 0;

await mkdir(OUT, { recursive: true });
const glb = g.toBuffer();
await writeFile(join(OUT, 'model.glb'), glb);
await rm(tmp, { recursive: true, force: true });
const tris = index.length / 3 + Object.values(parts).reduce((n, p) => n + p.count / 3, 0);
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (const arr of [P, ...Object.values(parts).map((p) => p.position)]) {
  for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], arr[i + k]);
    hi[k] = Math.max(hi[k], arr[i + k]);
  }
}
const round = (a) => a.map((v) => Math.round(v * 1000) / 1000);
const thrusters = [round([0, AXIS, BACK, r * 0.85]), ...pods.map((p) => round(p.face))];
console.log(`machine/model.glb  ${(glb.length / 1024).toFixed(0)} KB, ${tris} triangles, ${hi.map((v, k) => (v - lo[k]).toFixed(2)).join(' x ')} m, from y ${lo[1].toFixed(3)}`);
console.log(`"thrusters": ${JSON.stringify(thrusters)}`);
