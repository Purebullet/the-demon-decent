// Builds the player's Project 0 avatar, the Storm Round: a rifled bullet of
// circuit-etched steel humming with power, lightning striking off it.
//
//   node scripts/make-avatar.mjs [source.glb]
//
// From the static Tripo model (assets/source/avatar-bullet.glb, not in git)
// it writes avatar/avatar.glb and avatar/avatar-lod1.glb:
//
//   Avatar (origin at the feet)
//     Body (at the centre, 0.9 m up: every clip turns and moves this)
//       Shell      the bullet, 1.8 m tall, its own PBR textures (1024 px)
//       Lightning  jagged bolts reaching off the body: crossed ribbons that
//                  avatar/bolt-move.glsl makes crackle and avatar/bolt.glsl
//                  strikes and flickers
//
// Clips (all on Body): idle (a slow turn), fly (leaning in, spinning),
// fly_fast (tipped over to fly point first, rifling), ascend, descend, and
// the emotes' surge, nod, droop and overload. avatar/avatar.json and the
// shaders beside it are written by hand.
//
// Publish with: npm run p0 -- avatar avatar   (validate first: --validate)

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readGlb, readAccessor, bufferViewBytes, GlbBuilder } from './glb.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = process.argv[2] || join(ROOT, 'assets/source/avatar-bullet.glb');
const OUT = join(ROOT, 'avatar');
const HEIGHT = 1.8;
const HALF = HEIGHT / 2;
const BOLTS = 12;
const BOLT_POINTS = 13;

// ---- Source -----------------------------------------------------------------

const src = readGlb(await readFile(SRC));
const prim = src.json.meshes[0].primitives[0];
const pos = readAccessor(src, prim.attributes.POSITION);
const nrm = readAccessor(src, prim.attributes.NORMAL);
const uv = readAccessor(src, prim.attributes.TEXCOORD_0);
const idx = readAccessor(src, prim.indices);

// Stand it up 1.8 m tall, centred on the Body (which sits 0.9 m up).
const box = new THREE.Box3();
for (let i = 0; i < pos.length; i += 3) box.expandByPoint(new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]));
const k = HEIGHT / (box.max.y - box.min.y);
const cx = (box.min.x + box.max.x) / 2;
const cz = (box.min.z + box.max.z) / 2;
const shell = new Float32Array(pos.length);
for (let i = 0; i < pos.length; i += 3) {
  shell[i] = (pos[i] - cx) * k;
  shell[i + 1] = (pos[i + 1] - box.min.y) * k - HALF;
  shell[i + 2] = (pos[i + 2] - cz) * k;
}

// Its radius at each height, for where the bolts leave the body.
const radius = new Float32Array(41);
for (let i = 0; i < shell.length; i += 3) {
  const b = Math.round(((shell[i + 1] + HALF) / HEIGHT) * 40);
  radius[b] = Math.max(radius[b], Math.hypot(shell[i], shell[i + 2]));
}
const radiusAt = (y) => radius[Math.max(0, Math.min(40, Math.round(((y + HALF) / HEIGHT) * 40)))];

// ---- Textures ---------------------------------------------------------------

const tmp = join(tmpdir(), `avatar-${process.pid}`);
await mkdir(tmp, { recursive: true });
async function texture(i, size, quality) {
  const im = src.json.images[src.json.textures[i].source];
  const inPath = join(tmp, `in-${i}`);
  const outPath = join(tmp, `out-${i}-${size}.jpg`);
  await writeFile(inPath, bufferViewBytes(src, im.bufferView));
  execFileSync('python3', ['-c', `from PIL import Image; Image.open(${JSON.stringify(inPath)}).convert('RGB').resize((${size}, ${size}), Image.LANCZOS).save(${JSON.stringify(outPath)}, 'JPEG', quality=${quality}, optimize=True)`]);
  return readFile(outPath);
}
const pbr = src.json.materials[prim.material];
const texIndex = { color: pbr.pbrMetallicRoughness.baseColorTexture.index, orm: pbr.pbrMetallicRoughness.metallicRoughnessTexture.index, normal: pbr.normalTexture.index };

// ---- Lightning ----------------------------------------------------------------

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each bolt: a jagged curve from a point on the body out into the air,
// drawn as two ribbons crossed along it (so it reads from any side). The
// shaders need to know, per vertex: which bolt (uv.x's whole part), how far
// along it (uv.x's fraction), which edge of its ribbon (uv.y), and which way
// it may be thrown when it crackles (the normal).
function lightning() {
  const r = mulberry32(1738);
  const P = [];
  const N = [];
  const U = [];
  const I = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let b = 0; b < BOLTS; b++) {
    let start;
    let dir;
    let len;
    const th = (b / BOLTS) * Math.PI * 2 + r() * 0.5;
    if (b < 2) {
      // From the spiral tip, up and out.
      start = new THREE.Vector3(0, HALF - 0.05, 0);
      dir = new THREE.Vector3(Math.cos(th) * 0.8, 1, Math.sin(th) * 0.8);
      len = 0.45 + r() * 0.3;
    } else if (b < 4) {
      // From the base, out low along the ground.
      const y = -HALF + 0.12;
      start = new THREE.Vector3(Math.cos(th) * radiusAt(y), y, Math.sin(th) * radiusAt(y));
      dir = new THREE.Vector3(Math.cos(th), -0.1, Math.sin(th));
      len = 0.5 + r() * 0.3;
    } else {
      // From the sides, arcing outward.
      const y = -0.75 + r() * 1.55;
      start = new THREE.Vector3(Math.cos(th) * radiusAt(y) * 0.95, y, Math.sin(th) * radiusAt(y) * 0.95);
      const t2 = th + (r() - 0.5) * 1.1;
      dir = new THREE.Vector3(Math.cos(t2), (r() - 0.4) * 1.1, Math.sin(t2));
      len = 0.5 + r() * 0.7;
    }
    dir.normalize();
    const end = start.clone().addScaledVector(dir, len);
    const out = new THREE.Vector3(start.x, 0, start.z).normalize();
    const ctrl = start.clone().lerp(end, 0.5).addScaledVector(out, len * 0.22).addScaledVector(up, (r() - 0.5) * len * 0.4);
    const pts = [];
    for (let i = 0; i < BOLT_POINTS; i++) {
      const t = i / (BOLT_POINTS - 1);
      const p = new THREE.Vector3()
        .copy(start).multiplyScalar((1 - t) * (1 - t))
        .addScaledVector(ctrl, 2 * t * (1 - t))
        .addScaledVector(end, t * t);
      pts.push(p);
    }
    // Baked-in zigzag (the shader adds the live crackle on top).
    for (let i = 1; i < BOLT_POINTS - 1; i++) {
      const t = i / (BOLT_POINTS - 1);
      const tan = pts[i + 1].clone().sub(pts[i - 1]).normalize();
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();
      if (side.lengthSq() < 0.5) side.set(1, 0, 0);
      const lift = new THREE.Vector3().crossVectors(side, tan);
      const zig = (i % 2 ? 1 : -1) * len * (0.04 + r() * 0.05) * Math.sin(t * Math.PI);
      pts[i].addScaledVector(side, zig).addScaledVector(lift, (r() - 0.5) * len * 0.06);
    }
    // Never below the feet (the avatar's bounds start there).
    for (const p of pts) p.y = Math.max(p.y, -HALF + 0.06);
    for (let i = 0; i < BOLT_POINTS; i++) {
      const t = i / (BOLT_POINTS - 1);
      const tan = pts[Math.min(BOLT_POINTS - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize();
      const a = new THREE.Vector3().crossVectors(tan, up);
      if (a.lengthSq() < 1e-4) a.set(1, 0, 0);
      a.normalize();
      const c = new THREE.Vector3().crossVectors(tan, a).normalize();
      const w = 0.075 * (1 - 0.5 * t);
      const base = P.length / 3;
      for (const [axis, s] of [[a, -1], [a, 1], [c, -1], [c, 1]]) {
        const p = pts[i].clone().addScaledVector(axis, s * w);
        P.push(p.x, p.y, p.z);
        N.push(a.x, a.y, a.z);
        U.push(b + t * 0.999, s < 0 ? 0 : 1);
      }
      if (i > 0) {
        const prev = base - 4;
        for (const o of [0, 2]) I.push(prev + o, prev + o + 1, base + o, prev + o + 1, base + o + 1, base + o);
      }
    }
  }
  return { position: new Float32Array(P), normal: new Float32Array(N), uv: new Float32Array(U), index: new Uint16Array(I) };
}

// ---- Clips --------------------------------------------------------------------

// Euler order XYZ: the turn about its own long axis comes first, then the
// lean, so a tipped-over round spins like a rifled bullet.
const qOf = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
// Keys every `step` s over `dur`: rot(t) -> [x, y, z] Euler, move(t) -> [x, y, z] offset.
function clip(name, dur, rot, move = () => [0, 0, 0], step = 1 / 15) {
  const n = Math.round(dur / step) + 1;
  const times = new Float32Array(n);
  const R = new Float32Array(n * 4);
  const T = new Float32Array(n * 3);
  let prev = null;
  for (let i = 0; i < n; i++) {
    const t = Math.min(dur, i * step);
    times[i] = t;
    const q = qOf(...rot(t / dur, t));
    // Keep consecutive keys on the same side, so a full turn turns.
    if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    prev = q;
    q.toArray(R, i * 4);
    const m = move(t / dur, t);
    T.set([m[0], HALF + m[1], m[2]], i * 3);
  }
  return { name, times, R, T };
}
const TAU = Math.PI * 2;
const ease = (k) => k * k * (3 - 2 * k);
const CLIPS = [
  // A slow, steady turn: one revolution every 6 s.
  clip('idle', 6, (k) => [0, k * TAU, 0]),
  // Leaning into the flight, turning faster.
  clip('fly', 1.5, (k) => [0.45, k * TAU, 0]),
  // Tipped right over to fly point first, rifling.
  clip('fly_fast', 0.6, (k) => [1.35, k * TAU, 0]),
  clip('ascend', 1, (k) => [0.12, k * TAU, 0]),
  clip('descend', 1, (k) => [-0.25, -k * TAU, 0]),
  // Joy: a leap and a double spin.
  clip('surge', 1.2, (k) => [0, ease(k) * TAU * 2, 0], (k) => [0, Math.sin(k * Math.PI) * 0.6, 0]),
  // Approval: two nods.
  clip('nod', 1.0, (k) => [Math.sin(k * TAU * 2) * 0.28 * (1 - k * 0.3), 0, 0]),
  // Sadness: sagging, slowly sinking and swaying.
  clip('droop', 2.4, (k) => [0.32 + Math.sin(k * TAU) * 0.04, Math.sin(k * TAU) * 0.15, 0.12], (k) => [0, -0.18 + Math.sin(k * TAU) * 0.03, 0]),
  // Indignation: overloaded, juddering with power.
  clip('overload', 1.2, (k, t) => [Math.sin(t * 61) * 0.07, k * TAU, Math.sin(t * 47) * 0.07], (k, t) => [Math.sin(t * 53) * 0.03, Math.abs(Math.sin(t * 9)) * 0.05, Math.cos(t * 59) * 0.03], 1 / 30),
];

// ---- Write --------------------------------------------------------------------

async function build(file, { tris, texSize }) {
  let index = idx;
  if (tris && idx.length / 3 > tris) {
    const target = tris * 3;
    let [out] = MeshoptSimplifier.simplify(new Uint32Array(idx), shell, 3, target, 0.02);
    if (out.length > target * 1.15) [out] = MeshoptSimplifier.simplify(new Uint32Array(idx), shell, 3, target, 0.08);
    index = out;
  }
  const bolt = lightning();
  const g = new GlbBuilder();
  const j = g.json;
  j.asset.generator = 'The Demon Descent scripts/make-avatar.mjs';
  const A = (arr, type, o) => g.accessor(arr, type, o);
  const shellPrim = {
    attributes: { POSITION: A(shell, 'VEC3', { target: 34962, minmax: true }), NORMAL: A(new Float32Array(nrm), 'VEC3', { target: 34962 }), TEXCOORD_0: A(new Float32Array(uv), 'VEC2', { target: 34962 }) },
    indices: A(Uint16Array.from(index), 'SCALAR', { target: 34963 }),
    material: 0,
  };
  const boltPrim = {
    attributes: { POSITION: A(bolt.position, 'VEC3', { target: 34962, minmax: true }), NORMAL: A(bolt.normal, 'VEC3', { target: 34962 }), TEXCOORD_0: A(bolt.uv, 'VEC2', { target: 34962 }) },
    indices: A(bolt.index, 'SCALAR', { target: 34963 }),
    material: 1,
  };
  j.images = [];
  for (const key of ['color', 'orm', 'normal']) {
    const bytes = await texture(texIndex[key], texSize, key === 'normal' ? 94 : 88);
    j.images.push({ name: key, mimeType: 'image/jpeg', bufferView: g.view(new Uint8Array(bytes)) });
  }
  j.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  j.textures = [0, 1, 2].map((s) => ({ source: s, sampler: 0 }));
  j.materials = [
    {
      name: 'Shell',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 1, roughnessFactor: 1 },
      normalTexture: { index: 2, scale: 1 },
    },
    {
      name: 'Lightning',
      pbrMetallicRoughness: { baseColorFactor: [0.7, 0.95, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      emissiveFactor: [0.5, 0.9, 1],
      alphaMode: 'BLEND',
      doubleSided: true,
    },
  ];
  j.meshes = [
    { name: 'Shell', primitives: [shellPrim] },
    { name: 'Lightning', primitives: [boltPrim] },
  ];
  j.nodes = [
    { name: 'Avatar', children: [1] },
    { name: 'Body', translation: [0, HALF, 0], children: [2, 3] },
    { name: 'Shell', mesh: 0 },
    { name: 'Lightning', mesh: 1 },
  ];
  j.scenes = [{ name: 'Storm Round', nodes: [0] }];
  j.scene = 0;
  j.animations = CLIPS.map((c) => {
    const input = A(c.times, 'SCALAR', { minmax: true });
    return {
      name: c.name,
      samplers: [
        { input, output: A(c.R, 'VEC4'), interpolation: 'LINEAR' },
        { input, output: A(c.T, 'VEC3'), interpolation: 'LINEAR' },
      ],
      channels: [
        { sampler: 0, target: { node: 1, path: 'rotation' } },
        { sampler: 1, target: { node: 1, path: 'translation' } },
      ],
    };
  });
  const buf = g.toBuffer();
  await writeFile(join(OUT, file), buf);
  return { file, bytes: buf.length, tris: index.length / 3 + bolt.index.length / 3 };
}

await mkdir(OUT, { recursive: true });
const made = [await build('avatar.glb', { tris: 0, texSize: 1024 }), await build('avatar-lod1.glb', { tris: 4300, texSize: 512 })];
await rm(tmp, { recursive: true, force: true });
for (const m of made) console.log(`avatar/${m.file}  ${(m.bytes / 1024).toFixed(0)} KB, ${m.tris} triangles`);
