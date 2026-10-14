#!/usr/bin/env node
// The player's ZER0-G machine (lot 383): their own racer model, made ready
// for the game.
//
//   node scripts/make-machine.mjs [source.glb]
//
// From the static Tripo model (assets/source/major-bullet.glb, not in git)
// it writes machine/model.glb as the game asks for it: nose to +Z (the
// source's nose points to -X), resting on y = 0 and centred, under 15,000
// triangles (simplified with its UVs and normals kept), its texture at
// 1,024 px. It prints the exhaust it finds at the back, as `thrusters` for
// machine/entity.json. The data and the card (machine/picture.png) are kept
// by hand; `npm run p0 -- machine machine` checks or sends the three.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readGlb, readAccessor, bufferViewBytes, GlbBuilder } from './glb.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = process.argv[2] || join(ROOT, 'assets/source/major-bullet.glb');
const OUT = join(ROOT, 'machine');
const TEX = 1024;
const TRIS = 14000; // the game allows 15,000

const src = readGlb(await readFile(SRC));
const prim = src.json.meshes[0].primitives[0];
const pos = readAccessor(src, prim.attributes.POSITION);
const nrm = readAccessor(src, prim.attributes.NORMAL);
const uv = readAccessor(src, prim.attributes.TEXCOORD_0);
const index = readAccessor(src, prim.indices);

// A quarter turn about Y takes the nose from -X to +Z: (x, y, z) -> (z, y, -x).
// Then onto y = 0, centred on x and z.
const P = new Float32Array(pos.length);
const N = new Float32Array(nrm.length);
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) {
  P[i] = pos[i + 2];
  P[i + 1] = pos[i + 1];
  P[i + 2] = -pos[i];
  N[i] = nrm[i + 2];
  N[i + 1] = nrm[i + 1];
  N[i + 2] = -nrm[i];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], P[i + k]);
    max[k] = Math.max(max[k], P[i + k]);
  }
}
const shift = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) P[i + k] += shift[k];
const size = max.map((v, k) => v - min[k]);

// Under the triangle budget, keeping the texture's seams and the shading.
await MeshoptSimplifier.ready;
const attrs = new Float32Array((P.length / 3) * 5);
for (let v = 0; v < P.length / 3; v++) attrs.set([uv[v * 2], uv[v * 2 + 1], N[v * 3], N[v * 3 + 1], N[v * 3 + 2]], v * 5);
let tri = Uint32Array.from(index);
if (tri.length / 3 > TRIS) {
  for (const err of [0.01, 0.03, 0.08]) {
    const [out] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(index), P, 3, attrs, 5, [1, 1, 0.3, 0.3, 0.3], null, TRIS * 3, err);
    tri = out;
    if (tri.length / 3 <= TRIS) break;
  }
}
// Only the vertices still in use.
const used = new Int32Array(P.length / 3).fill(-1);
let count = 0;
for (const v of tri) if (used[v] < 0) used[v] = count++;
const P2 = new Float32Array(count * 3);
const N2 = new Float32Array(count * 3);
const U2 = new Float32Array(count * 2);
for (let v = 0; v < used.length; v++) {
  const u = used[v];
  if (u < 0) continue;
  P2.set(P.subarray(v * 3, v * 3 + 3), u * 3);
  N2.set(N.subarray(v * 3, v * 3 + 3), u * 3);
  U2.set(uv.subarray(v * 2, v * 2 + 2), u * 2);
}
const I2 = count < 65536 ? Uint16Array.from(tri, (v) => used[v]) : Uint32Array.from(tri, (v) => used[v]);

// The exhaust: the flat, rear-facing disc at the very back (faces looking
// straight back within a few centimetres of the tail), as a centre and a
// radius.
const back = -size[2] / 2;
let cx = 0;
let cy = 0;
let n = 0;
const disc = [];
for (let i = 0; i < I2.length; i += 3) {
  const a = I2[i] * 3;
  const b = I2[i + 1] * 3;
  const c = I2[i + 2] * 3;
  const z = (P2[a + 2] + P2[b + 2] + P2[c + 2]) / 3;
  const nz = (N2[a + 2] + N2[b + 2] + N2[c + 2]) / 3;
  if (nz < -0.9 && z < back + 0.06) {
    for (const v of [a, b, c]) disc.push([P2[v], P2[v + 1], P2[v + 2]]);
  }
}
for (const [x, y] of disc) {
  cx += x;
  cy += y;
  n++;
}
cx /= n || 1;
cy /= n || 1;
let r = 0;
let dz = 0;
for (const [x, y, z] of disc) {
  r = Math.max(r, Math.hypot(x - cx, y - cy));
  dz += z;
}
dz /= n || 1;

// The texture at TEX px, as JPEG.
const tmp = join(tmpdir(), `machine-${process.pid}`);
await mkdir(tmp, { recursive: true });
const mat = src.json.materials[prim.material];
const im = src.json.images[src.json.textures[mat.pbrMetallicRoughness.baseColorTexture.index].source];
await writeFile(join(tmp, 'in'), bufferViewBytes(src, im.bufferView));
execFileSync('python3', ['-c', `from PIL import Image; Image.open(${JSON.stringify(join(tmp, 'in'))}).convert('RGB').resize((${TEX}, ${TEX}), Image.LANCZOS).save(${JSON.stringify(join(tmp, 'out.jpg'))}, 'JPEG', quality=90, optimize=True)`]);

const g = new GlbBuilder();
const j = g.json;
j.asset.generator = 'The Demon Descent scripts/make-machine.mjs';
const A = (arr, type, o) => g.accessor(arr, type, o);
j.images = [{ name: 'color', mimeType: 'image/jpeg', bufferView: g.view(new Uint8Array(await readFile(join(tmp, 'out.jpg')))) }];
j.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
j.textures = [{ source: 0, sampler: 0 }];
j.materials = [
  {
    name: 'Major Bullet',
    pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: mat.pbrMetallicRoughness.metallicFactor ?? 0, roughnessFactor: mat.pbrMetallicRoughness.roughnessFactor ?? 0.5 },
    doubleSided: !!mat.doubleSided,
  },
];
j.meshes = [
  {
    name: 'Major Bullet',
    primitives: [
      {
        attributes: { POSITION: A(P2, 'VEC3', { target: 34962, minmax: true }), NORMAL: A(N2, 'VEC3', { target: 34962 }), TEXCOORD_0: A(U2, 'VEC2', { target: 34962 }) },
        indices: A(I2, 'SCALAR', { target: 34963 }),
        material: 0,
      },
    ],
  },
];
j.nodes = [{ name: 'Major Bullet', mesh: 0 }];
j.scenes = [{ nodes: [0] }];
j.scene = 0;

await mkdir(OUT, { recursive: true });
const glb = g.toBuffer();
await writeFile(join(OUT, 'model.glb'), glb);
await rm(tmp, { recursive: true, force: true });
const round = (a) => a.map((v) => Math.round(v * 1000) / 1000);
console.log(`machine/model.glb  ${(glb.length / 1024).toFixed(0)} KB, ${index.length / 3} -> ${I2.length / 3} triangles, ${size.map((v) => v.toFixed(2)).join(' x ')} m`);
console.log(n ? `exhaust: "thrusters": [${JSON.stringify(round([cx, cy, dz, r]))}]` : 'exhaust: no rear-facing disc found');
