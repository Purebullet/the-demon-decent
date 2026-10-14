// Builds the player's Project 0 avatar, the Storm Round: a rifled bullet of
// circuit-etched steel humming with power, lightning striking off it.
//
//   node scripts/make-avatar.mjs [source.glb]
//
// From the static Tripo model (assets/source/avatar-bullet.glb, not in git)
// it writes avatar/avatar.glb and avatar/avatar-lod1.glb:
//
//   Avatar (origin at the feet)
//     Lean (at the centre, 0.9 m up: the clips lean it and move it)
//       Spin (the clips turn it about the round's long axis)
//         Shell      the bullet, 1.8 m tall, its own PBR textures (1024 px)
//       Lightning  short bolts off the body and arcs round it, and bolts
//                  that stream out of the back in flight. On Lean, not
//                  Spin: the round turns inside its lightning.
//       Exhaust    bolts pouring straight down out of the base, shown only
//                  while the round lifts off (its scale is 0 otherwise)
//       Game       the game copy of the body's bolts and of the trail,
//                  laid out streaming back (see below)
//   The lightning is crossed ribbons that avatar/bolt-move.glsl lays out
//   and makes crackle and avatar/bolt.glsl strikes and flickers.
//
//   A game that shows the avatar gets only this model and its clips, none
//   of the shaders. So the body's bolts are stored squashed into the middle
//   of the round, where a game never sees them, and bolt-move.glsl puts them
//   back out in the city. For games there is a plain copy of them and of
//   the trail (Game): all of it stored shrunk to a point, with a morph
//   target (shape) per group that brings it out, which the clips switch on
//   and off: crackling round the body at rest, streaming out of the back in
//   flight. In the city that copy is never drawn (avatar/arc-hide.glsl).
//   (Projects 0 allows an avatar 6 draw calls: Shell, Lightning, Exhaust
//   and Game are 4.)
//
// Clips: idle (a slow turn), fly (leaning nose first, spinning), fly_fast
// (tipped over to fly point first, rifling), ascend, descend, and the
// emotes' liftoff (Joy, and as wave and interact: it rises slowly on a jet
// of lightning, hovers and comes back down), nod, droop and overload.
// avatar/avatar.json and the shaders beside it are written by hand, except
// avatar/bolt-common.glsl (how the shaders decode each bolt), written here.
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
async function texture(i, size, quality, { bolt = false } = {}) {
  const im = src.json.images[src.json.textures[i].source];
  const inPath = join(tmp, `in-${i}`);
  const outPath = join(tmp, `out-${i}-${size}.jpg`);
  await writeFile(inPath, bufferViewBytes(src, im.bufferView));
  // The bolts' colour goes in a gap in the shell's atlas (BOLT_PATCH, clear
  // of every part of the shell): across the patch's height electric blue at
  // the edges, white-hot in the middle.
  const [px, py, pw, ph] = BOLT_PATCH.map((v) => Math.round(v * size));
  const paint = bolt
    ? `
for y in range(${ph}):
    d = abs((y + 0.5) / ${ph} * 2 - 1)
    core = max(0.0, 1 - d / 0.4) ** 1.4
    c = tuple(int(255 * (a + (b - a) * core)) for a, b in zip((0.1, 0.42, 1.0), (0.93, 0.99, 1.0)))
    for x in range(${pw}): im.putpixel((${px} + x, ${py} + y), c)`
    : '';
  execFileSync('python3', ['-c', `from PIL import Image\nim = Image.open(${JSON.stringify(inPath)}).convert('RGB').resize((${size}, ${size}), Image.LANCZOS)${paint}\nim.save(${JSON.stringify(outPath)}, 'JPEG', quality=${quality}, optimize=True)`]);
  return readFile(outPath);
}
// [x, y, w, h] of the atlas (0..1, y down) that no part of the shell uses,
// with room to spare round it, and where across it a bolt's ribbon samples.
const BOLT_PATCH = [208 / 1024, 504 / 1024, 24 / 1024, 64 / 1024];
const boltUv = (edge) => [BOLT_PATCH[0] + BOLT_PATCH[2] / 2, BOLT_PATCH[1] + BOLT_PATCH[3] * (0.08 + 0.84 * edge)];
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

// The bolts, by kind (in order, so the shaders can tell them by number):
//   tip     2  short sparks off the spiral point
//   side    6  short bolts striking out from the body
//   wrap    3  arcs from one point on the body round to another
//   trail   8  out of the base, behind it in flight, evenly round it (every
//              45 degrees, one length): in flight the round leans nose
//              first, so its base points back. At rest they are
//              stored folded flat up against the base (inside the bounds,
//              never drawn); bolt-move.glsl unfurls them as you fly.
//   exhaust 5  straight down out of the base, in their own mesh (Exhaust)
//              that only the lift-off clip scales up.
// Each is a jagged curve drawn as two ribbons crossed along it so it reads
// from any side. The shaders need to know, per vertex, which bolt it
// belongs to, how far along it, and which edge of its ribbon. That goes in
// the normal (the lightning is unlit, so it needs no other): its angle from
// straight up says how far along, its angle round says bolt and edge
// (boltDecode in bolt-common.glsl). Not the UVs: Project 0's optimisation
// (gltfpack) strips texture coordinates from a material without textures,
// and rescales them on the rest.
const KINDS = { tip: 2, side: 6, wrap: 3, trail: 8, exhaust: 5 };
const TRAIL_FIRST = KINDS.tip + KINDS.side + KINDS.wrap;
const EXHAUST_FIRST = TRAIL_FIRST + KINDS.trail;
const BOLTS = EXHAUST_FIRST + KINDS.exhaust;
const FOLD = 0.3;
// The body's bolts, as stored: shrunk SQUASH times toward the middle of the
// round (the tip's toward the tip, TIP_Y up, first), all well inside it.
const SQUASH = 0.15;
const TIP_Y = HALF - 0.05;
// The game copy (one mesh, Game, whose shapes the clips switch on and off):
// the body's bolts in six groups that strike in turn, each at one of
// VARIANTS turns round the body, and the trail in two groups, laid out
// TRAIL_LEN long as at a fair speed in the city.
const ARC_GROUPS = [
  [0, 5],
  [1, 8],
  [2, 9],
  [3, 6],
  [4, 10],
  [7],
];
const TRAIL_GROUPS = [
  [11, 13, 15, 17],
  [12, 14, 16, 18],
];
const TRAIL_LEN = 0.8;
const VARIANTS = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3];
const SHAPES = ARC_GROUPS.length * VARIANTS.length + TRAIL_GROUPS.length;

// Bolt, distance along (0..1) and edge (0/1) as a unit vector that
// survives coarse normal compression: the angle round Y picks the bolt (one
// sector each, wide); the angle from +Y says the edge (the upper or lower
// band) and the distance along within it, never near the poles, where the
// angle round would be unreliable.
const BAND = [0.5, 1.45];
const BAND2 = [Math.PI - 1.45, Math.PI - 0.5];
function boltEncode(bolt, along, edge) {
  const [a, b] = edge ? BAND2 : BAND;
  const th = a + along * (b - a);
  const ph = ((bolt + 0.5) / BOLTS) * Math.PI * 2;
  return new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
}

// Bolts `from` to `to` (exclusive). Exhaust bolts are made relative to
// the Exhaust node, at the middle of the base. laidOut: the trail bolts
// streaming back out of the base (the game copy) instead of folded.
function lightning(from, to, { laidOut = false } = {}) {
  const r = mulberry32(1738 + from);
  const P = [];
  const N = [];
  const U = [];
  const I = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let b = from; b < to; b++) {
    const th = (b / TRAIL_FIRST) * Math.PI * 2 + r() * 0.5;
    let start;
    let end;
    let ctrl;
    let len;
    const trail = b >= TRAIL_FIRST && b < EXHAUST_FIRST;
    const exhaust = b >= EXHAUST_FIRST;
    if (exhaust) {
      // A jet straight down, flaring a little.
      const a = ((b - EXHAUST_FIRST) / KINDS.exhaust) * Math.PI * 2 + r() * 0.5;
      start = new THREE.Vector3(Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08);
      len = 0.75 + r() * 0.3;
      end = start.clone().addScaledVector(new THREE.Vector3(Math.cos(a) * 0.28, -1, Math.sin(a) * 0.28).normalize(), len);
    } else if (b < KINDS.tip) {
      // Short sparks off the spiral point.
      start = new THREE.Vector3(0, HALF - 0.05, 0);
      len = 0.25 + r() * 0.15;
      end = start.clone().addScaledVector(new THREE.Vector3(Math.cos(th) * 0.9, 1, Math.sin(th) * 0.9).normalize(), len);
    } else if (b < KINDS.tip + KINDS.side) {
      // Short bolts out from the body.
      const y = -0.6 + r() * 1.25;
      start = new THREE.Vector3(Math.cos(th) * radiusAt(y) * 0.95, y, Math.sin(th) * radiusAt(y) * 0.95);
      const t2 = th + (r() - 0.5) * 0.9;
      len = 0.3 + r() * 0.25;
      end = start.clone().addScaledVector(new THREE.Vector3(Math.cos(t2), (r() - 0.4) * 0.9, Math.sin(t2)).normalize(), len);
    } else if (!trail) {
      // Round the body: from one point on it to another, bowing out a little.
      const y0 = -0.6 + r() * 1.2;
      const y1 = Math.max(-0.7, Math.min(0.7, y0 + (r() - 0.5) * 0.6));
      const t1 = th + (r() < 0.5 ? -1 : 1) * (1.2 + r() * 0.8);
      start = new THREE.Vector3(Math.cos(th) * radiusAt(y0), y0, Math.sin(th) * radiusAt(y0));
      end = new THREE.Vector3(Math.cos(t1) * radiusAt(y1), y1, Math.sin(t1) * radiusAt(y1));
      const tm = (th + t1) / 2;
      const ym = (y0 + y1) / 2;
      const rm = radiusAt(ym) + 0.1 + r() * 0.08;
      ctrl = new THREE.Vector3(Math.cos(tm) * rm * 1.5, ym, Math.sin(tm) * rm * 1.5);
      len = start.distanceTo(end);
    } else {
      // Out of the base, evenly round it: stored folded straight up against
      // it (or laid out as bolt-move.glsl lays them out in flight).
      const a = ((b - TRAIL_FIRST) / KINDS.trail) * Math.PI * 2;
      const y = -HALF + 0.04;
      start = new THREE.Vector3(Math.cos(a) * radiusAt(y) * 0.7, y, Math.sin(a) * radiusAt(y) * 0.7);
      len = laidOut ? TRAIL_LEN : FOLD;
      end = start.clone().addScaledVector(laidOut ? new THREE.Vector3(start.x * 1.8, -1, start.z * 1.8).normalize() : up, len);
    }
    if (!ctrl) {
      const out = new THREE.Vector3(start.x, 0, start.z).normalize();
      ctrl = start.clone().lerp(end, 0.5);
      if (!trail && !exhaust) ctrl.addScaledVector(out, len * 0.18).addScaledVector(up, (r() - 0.5) * len * 0.3);
    }
    const pts = [];
    for (let i = 0; i < BOLT_POINTS; i++) {
      const t = i / (BOLT_POINTS - 1);
      pts.push(new THREE.Vector3().copy(start).multiplyScalar((1 - t) * (1 - t)).addScaledVector(ctrl, 2 * t * (1 - t)).addScaledVector(end, t * t));
    }
    // Baked-in zigzag (the shader adds the live crackle on top); the trail
    // bolts get theirs in the shader, where they are laid out.
    if (!trail || laidOut) {
      for (let i = 1; i < BOLT_POINTS - 1; i++) {
        const t = i / (BOLT_POINTS - 1);
        const tan = pts[i + 1].clone().sub(pts[i - 1]).normalize();
        const side = new THREE.Vector3().crossVectors(tan, up);
        if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
        side.normalize();
        const lift = new THREE.Vector3().crossVectors(side, tan);
        const zig = (i % 2 ? 1 : -1) * len * (0.05 + r() * 0.05) * Math.sin(t * Math.PI);
        pts[i].addScaledVector(side, zig).addScaledVector(lift, (r() - 0.5) * len * 0.06);
      }
    }
    // Never below the feet (the avatar's bounds start there); the exhaust
    // only ever shows lifted off, the laid-out trail only in flight.
    if (!exhaust && !laidOut) for (const p of pts) p.y = Math.max(p.y, -HALF + 0.03);
    for (let i = 0; i < BOLT_POINTS; i++) {
      const t = i / (BOLT_POINTS - 1);
      const tan = pts[Math.min(BOLT_POINTS - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize();
      // Ribbon axes square to the bolt (for a trail bolt, horizontal, so
      // they stay square to it once it is laid out along the long axis).
      let a = new THREE.Vector3().crossVectors(tan, up);
      if (a.lengthSq() < 1e-4) a = new THREE.Vector3(start.x, 0, start.z);
      a.normalize();
      const c = new THREE.Vector3().crossVectors(tan, a).normalize();
      const w = 0.05 * (1 - 0.45 * t);
      const base = P.length / 3;
      for (const [axis, s] of [[a, -1], [a, 1], [c, -1], [c, 1]]) {
        const p = pts[i].clone().addScaledVector(axis, s * w);
        P.push(p.x, p.y, p.z);
        const n = boltEncode(b, t, s < 0 ? 0 : 1);
        N.push(n.x, n.y, n.z);
        U.push(...boltUv(s < 0 ? 0 : 1));
      }
      if (i > 0) {
        const prev = base - 4;
        for (const o of [0, 2]) I.push(prev + o, prev + o + 1, base + o, prev + o + 1, base + o + 1, base + o);
      }
    }
  }
  return { from, position: new Float32Array(P), normal: new Float32Array(N), uv: new Float32Array(U), index: new Uint16Array(I) };
}

// Each bolt is BOLT_POINTS rings of 4 vertices and (BOLT_POINTS - 1) * 12
// indices, one after another.
const BOLT_VERTS = BOLT_POINTS * 4;
const BOLT_INDICES = (BOLT_POINTS - 1) * 12;

// Some of `l`'s bolts as a mesh of their own.
function pick(l, ids) {
  const P = [];
  const N = [];
  const U = [];
  const I = [];
  ids.forEach((b, k) => {
    const v0 = (b - l.from) * BOLT_VERTS;
    P.push(...l.position.subarray(v0 * 3, (v0 + BOLT_VERTS) * 3));
    N.push(...l.normal.subarray(v0 * 3, (v0 + BOLT_VERTS) * 3));
    U.push(...l.uv.subarray(v0 * 2, (v0 + BOLT_VERTS) * 2));
    for (const i of l.index.subarray((b - l.from) * BOLT_INDICES, (b - l.from + 1) * BOLT_INDICES)) I.push(i - v0 + k * BOLT_VERTS);
  });
  return { position: new Float32Array(P), normal: new Float32Array(N), uv: new Float32Array(U), index: new Uint16Array(I) };
}

// The game copy as one mesh: stored shrunk SQUASH times into the middle of
// the round (nothing to see, but no triangle so small that Project 0's
// optimisation, gltfpack, would drop it), with a shape per arc group and
// turn round the body, and per trail group, that brings that group out.
function gameMesh(parts) {
  const count = parts.reduce((n, p) => n + p.position.length / 3, 0);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index = [];
  const shapes = [];
  const names = [];
  let v0 = 0;
  parts.forEach((p, k) => {
    const n = p.position.length / 3;
    for (let i = 0; i < n * 3; i++) position[v0 * 3 + i] = p.position[i] * SQUASH;
    normal.set(p.normal, v0 * 3);
    uv.set(p.uv, v0 * 2);
    for (const i of p.index) index.push(i + v0);
    const turns = k < ARC_GROUPS.length ? VARIANTS : [0];
    turns.forEach((a, t) => {
      const d = new Float32Array(count * 3);
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (let i = 0; i < n; i++) {
        const [x, y, z] = p.position.subarray(i * 3, i * 3 + 3);
        d.set([x * c + z * s - x * SQUASH, y - y * SQUASH, -x * s + z * c - z * SQUASH], (v0 + i) * 3);
      }
      shapes.push(d);
      names.push(k < ARC_GROUPS.length ? `arc${k}_${t}` : `trail${k - ARC_GROUPS.length}`);
    });
    v0 += n;
  });
  return { position, normal, uv, index: new Uint16Array(index), shapes, names };
}

// The body's bolts squashed into the round (bolt-move.glsl undoes it).
function squash(l) {
  const out = { ...l, position: l.position.slice() };
  for (let b = Math.max(l.from, 0); b < TRAIL_FIRST; b++) {
    const c = b < KINDS.tip ? TIP_Y : 0;
    for (let v = (b - l.from) * BOLT_VERTS; v < (b - l.from + 1) * BOLT_VERTS; v++) {
      out.position[v * 3] *= SQUASH;
      out.position[v * 3 + 1] = (out.position[v * 3 + 1] - c) * SQUASH;
      out.position[v * 3 + 2] *= SQUASH;
    }
  }
  return out;
}

// ---- Clips --------------------------------------------------------------------

// rot(k, t) -> [x, y, z]: x and z lean the round (Lean), y turns it about
// its own long axis (Spin), so a tipped-over round spins like a rifled
// bullet. move(k, t) -> [x, y, z]: Lean's offset. jet(k, t) -> 0..1: how
// far the Exhaust is shown (clips without one leave it hidden).
// arcs: the chance each Arc group strikes in each STRIKE window (0: none);
// trail: whether the trail streams (flickering). The game copy only: the
// weight of each of the Game mesh's SHAPES at each key.
const STRIKE = 0.7;
function effects(name, n, step, arcs, trail) {
  const W = new Float32Array(n * SHAPES);
  const base = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  ARC_GROUPS.forEach((_, g) => {
    const seed = base * 0.37 + g * 5.3;
    for (let i = 0; i < n; i++) {
      const t = i * step;
      const w = Math.floor(t / STRIKE);
      const h = (k) => hash01(seed + w * 3.71 + k * 0.913);
      // A strike: somewhere in its window, a fraction of a second long, at
      // one of the turns round the body, flickering.
      const start = w * STRIKE + h(1) * STRIKE * 0.5;
      const len = 0.16 + h(2) * 0.26;
      const on = h(0) < arcs && t >= start && t < start + len && hash01(seed + i * 1.37) < 0.85;
      if (on) W[i * SHAPES + g * VARIANTS.length + Math.floor(h(3) * VARIANTS.length)] = 1;
    }
  });
  TRAIL_GROUPS.forEach((_, g) => {
    const seed = base * 0.53 + g * 7.9;
    for (let i = 0; i < n; i++) if (trail && hash01(seed + i * 1.91) < 0.72) W[i * SHAPES + ARC_GROUPS.length * VARIANTS.length + g] = 1;
  });
  return W;
}
function clip(name, dur, rot, move = () => [0, 0, 0], { step = 1 / 15, jet = null, arcs = 0, trail = false } = {}) {
  const n = Math.round(dur / step) + 1;
  const times = new Float32Array(n);
  const lean = new Float32Array(n * 4);
  const spin = new Float32Array(n * 4);
  const T = new Float32Array(n * 3);
  const S = jet ? new Float32Array(n * 3) : null;
  const J = jet ? new Float32Array(n * 4) : null;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const t = Math.min(dur, i * step);
    times[i] = t;
    const [x, y, z] = rot(t / dur, t);
    new THREE.Quaternion().setFromEuler(new THREE.Euler(x, 0, z, 'XYZ')).toArray(lean, i * 4);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), y);
    // Keep consecutive keys on the same side, so a full turn turns.
    if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    prev = q;
    q.toArray(spin, i * 4);
    const m = move(t / dur, t);
    T.set([m[0], HALF + m[1], m[2]], i * 3);
    if (jet) {
      const k = Math.max(1e-4, jet(t / dur, t));
      // Flickers and lurches a little, so it crackles even where the shaders
      // don't run (a game drawing the bare model).
      const f = k * (0.85 + 0.3 * hash01(i * 7.1));
      S.set([k, f, k], i * 3);
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(i * 3.3) * TAU).toArray(J, i * 4);
    }
  }
  return { name, times, lean, spin, T, S, J, W: effects(name, n, step, arcs, trail), jitter: step };
}
const hash01 = (x) => {
  const v = Math.sin(x * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};
const TAU = Math.PI * 2;
const ease = (k) => k * k * (3 - 2 * k);
const smooth = (a, b, x) => ease(Math.min(1, Math.max(0, (x - a) / (b - a))));
// Lift-off: it dips, lights its jet, rises slowly about a metre, hovers,
// comes back down and the jet dies.
const LIFT = 4.2;
const liftoff = (name) =>
  clip(
    name,
    LIFT,
    (k, t) => [Math.sin(t * 2.3) * 0.04, (t / LIFT) * TAU, Math.cos(t * 1.9) * 0.04],
    (k, t) => [0, -0.06 * smooth(0, 0.25, t) * (1 - smooth(0.25, 0.6, t)) + 1.0 * (smooth(0.35, 2.1, t) - smooth(2.7, 3.9, t)) + 0.03 * Math.sin(t * 3) * smooth(0.6, 1.2, t) * (1 - smooth(3.4, 3.9, t)), 0],
    { step: 1 / 12, jet: (k, t) => smooth(0.1, 0.4, t) * (1 - smooth(3.75, 4.1, t)) },
  );
const CLIPS = [
  // A slow, steady turn: one revolution every 6 s.
  clip('idle', 6, (k) => [0, k * TAU, 0], undefined, { arcs: 0.75 }),
  // Leaning well into the flight, nose first, turning faster.
  clip('fly', 1.5, (k) => [0.85, k * TAU, 0], undefined, { arcs: 0.12, trail: true }),
  // Tipped right over to fly point first, rifling.
  clip('fly_fast', 0.6, (k) => [1.4, k * TAU, 0], undefined, { trail: true }),
  clip('ascend', 1, (k) => [0.12, k * TAU, 0], undefined, { arcs: 0.5 }),
  clip('descend', 1, (k) => [-0.25, -k * TAU, 0], undefined, { arcs: 0.5 }),
  // Joy (and the clips a game may play to show it off): lift-off.
  liftoff('liftoff'),
  liftoff('wave'),
  liftoff('interact'),
  // Approval: two nods.
  clip('nod', 1.0, (k) => [Math.sin(k * TAU * 2) * 0.28 * (1 - k * 0.3), 0, 0], undefined, { arcs: 0.7 }),
  // Sadness: sagging, slowly sinking and swaying.
  clip('droop', 2.4, (k) => [0.32 + Math.sin(k * TAU) * 0.04, Math.sin(k * TAU) * 0.15, 0.12], (k) => [0, -0.18 + Math.sin(k * TAU) * 0.03, 0]),
  // Indignation: overloaded, juddering with power.
  clip('overload', 1.2, (k, t) => [Math.sin(t * 61) * 0.07, k * TAU, Math.sin(t * 47) * 0.07], (k, t) => [Math.sin(t * 53) * 0.03, Math.abs(Math.sin(t * 9)) * 0.05, Math.cos(t * 59) * 0.03], { step: 1 / 30, arcs: 1 }),
];

// ---- Write --------------------------------------------------------------------

// withGame: the game copy of the lightning (games load the full avatar, so
// the far one, LOD1, goes without: its limits are 5,000 triangles and 3
// draw calls).
async function build(file, { tris, texSize, withGame }) {
  let index = idx;
  if (tris && idx.length / 3 > tris) {
    const target = tris * 3;
    let [out] = MeshoptSimplifier.simplify(new Uint32Array(idx), shell, 3, target, 0.02);
    if (out.length > target * 1.15) [out] = MeshoptSimplifier.simplify(new Uint32Array(idx), shell, 3, target, 0.08);
    index = out;
  }
  const bolts = lightning(0, EXHAUST_FIRST);
  const bolt = squash(bolts);
  const jet = lightning(EXHAUST_FIRST, BOLTS);
  const laid = lightning(TRAIL_FIRST, EXHAUST_FIRST, { laidOut: true });
  const game = withGame ? gameMesh([...ARC_GROUPS.map((ids) => pick(bolts, ids)), ...TRAIL_GROUPS.map((ids) => pick(laid, ids))]) : null;
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
  const jetPrim = {
    attributes: { POSITION: A(jet.position, 'VEC3', { target: 34962, minmax: true }), NORMAL: A(jet.normal, 'VEC3', { target: 34962 }), TEXCOORD_0: A(jet.uv, 'VEC2', { target: 34962 }) },
    indices: A(jet.index, 'SCALAR', { target: 34963 }),
    material: 1,
  };
  const gamePrim = game && {
    attributes: { POSITION: A(game.position, 'VEC3', { target: 34962, minmax: true }), NORMAL: A(game.normal, 'VEC3', { target: 34962 }), TEXCOORD_0: A(game.uv, 'VEC2', { target: 34962 }) },
    indices: A(game.index, 'SCALAR', { target: 34963 }),
    targets: game?.shapes.map((d) => ({ POSITION: A(d, 'VEC3', { target: 34962, minmax: true }) })),
    material: 2,
  };
  j.images = [];
  for (const key of ['color', 'orm', 'normal']) {
    const bytes = await texture(texIndex[key], texSize, key === 'normal' ? 94 : 88, { bolt: key === 'color' });
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
    // The lightning as a game draws it (the lift-off jet): glowing in the
    // colours of the bolt patch in the atlas. In the city its shaders
    // replace all that. Not marked unlit: gltfpack would drop the normals,
    // which carry what the shaders need.
    {
      name: 'Lightning',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
      emissiveTexture: { index: 0 },
      emissiveFactor: [1, 1, 1],
      alphaMode: 'BLEND',
      doubleSided: true,
    },
  ];
  // The game copy of the body's bolts and the trail: the same, and hidden
  // in the city.
  if (game) j.materials.push({ name: 'Arc', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true, extensions: { KHR_materials_unlit: {} } });
  if (game) j.extensionsUsed = ['KHR_materials_unlit'];
  j.meshes = [
    { name: 'Shell', primitives: [shellPrim] },
    { name: 'Lightning', primitives: [boltPrim] },
    { name: 'Exhaust', primitives: [jetPrim] },
  ];
  if (game) j.meshes.push({ name: 'Game', primitives: [gamePrim], weights: new Array(SHAPES).fill(0), extras: { targetNames: game.names } });
  // 0 Avatar, 1 Lean, 2 Spin, 3 Shell, 4 Lightning, 5 Exhaust, 6 Game.
  const GAME = 6;
  j.nodes = [
    { name: 'Avatar', children: [1] },
    { name: 'Lean', translation: [0, HALF, 0], children: [2, 4, 5, ...(game ? [GAME] : [])] },
    { name: 'Spin', children: [3] },
    { name: 'Shell', mesh: 0 },
    { name: 'Lightning', mesh: 1 },
    { name: 'Exhaust', mesh: 2, translation: [0, -HALF + 0.02, 0], scale: [1e-4, 1e-4, 1e-4] },
  ];
  if (game) j.nodes.push({ name: 'Game', mesh: 3 });
  j.scenes = [{ name: 'Storm Round', nodes: [0] }];
  j.scene = 0;
  j.animations = CLIPS.map((c) => {
    const input = A(c.times, 'SCALAR', { minmax: true });
    const samplers = [
      { input, output: A(c.lean, 'VEC4'), interpolation: 'LINEAR' },
      { input, output: A(c.T, 'VEC3'), interpolation: 'LINEAR' },
      { input, output: A(c.spin, 'VEC4'), interpolation: 'LINEAR' },
    ];
    const channels = [
      { sampler: 0, target: { node: 1, path: 'rotation' } },
      { sampler: 1, target: { node: 1, path: 'translation' } },
      { sampler: 2, target: { node: 2, path: 'rotation' } },
    ];
    if (c.S) {
      samplers.push({ input, output: A(c.S, 'VEC3'), interpolation: 'STEP' }, { input, output: A(c.J, 'VEC4'), interpolation: 'STEP' });
      channels.push({ sampler: 3, target: { node: 5, path: 'scale' } }, { sampler: 4, target: { node: 5, path: 'rotation' } });
    }
    if (game) {
      samplers.push({ input, output: A(c.W, 'SCALAR'), interpolation: 'STEP' });
      channels.push({ sampler: samplers.length - 1, target: { node: GAME, path: 'weights' } });
    }
    return { name: c.name, samplers, channels };
  });
  const buf = g.toBuffer();
  await writeFile(join(OUT, file), buf);
  return { file, bytes: buf.length, tris: (index.length + bolt.index.length + jet.index.length + (game?.index.length ?? 0)) / 3 };
}

await mkdir(OUT, { recursive: true });
await writeFile(
  join(OUT, 'bolt-common.glsl'),
  `// Written by scripts/make-avatar.mjs: how each lightning vertex carries its
// bolt, its distance along it and its ribbon edge, in its (object-space)
// normal; see boltEncode there. The vertex stage decodes it and hands it to
// the surface stage in vBolt = (bolt, along, edge).
#define BOLT_COUNT ${BOLTS}.0
// Bolts from BOLT_TRAIL_FIRST stream out of the base in flight, stored
// folded BOLT_FOLD m straight up against it; from BOLT_EXHAUST_FIRST they
// are the lift-off jet (the Exhaust mesh, shown by its clip).
#define BOLT_TRAIL_FIRST ${TRAIL_FIRST}.0
#define BOLT_TRAIL_COUNT ${KINDS.trail}.0
#define BOLT_EXHAUST_FIRST ${EXHAUST_FIRST}.0
#define BOLT_FOLD ${FOLD}
// The body's bolts (below BOLT_TRAIL_FIRST) are stored shrunk BOLT_SQUASH
// times toward the middle of the round (the tip's, the first BOLT_TIP_COUNT,
// toward the tip, BOLT_TIP_Y up), out of a game's sight.
#define BOLT_SQUASH ${SQUASH}
#define BOLT_TIP_COUNT ${KINDS.tip}.0
#define BOLT_TIP_Y ${TIP_Y.toFixed(4)}
#define BOLT_MIDDLE ${HALF.toFixed(4)}
varying vec3 vBolt;
vec3 boltDecode(vec3 n) {
  n = normalize(n);
  float th = acos(clamp(n.y, -1.0, 1.0));
  float edge = step(1.5707963, th);
  float lo = mix(${BAND[0]}, ${BAND2[0].toFixed(6)}, edge);
  float along = clamp((th - lo) / ${(BAND[1] - BAND[0]).toFixed(6)}, 0.0, 1.0);
  float bolt = floor(fract(atan(n.z, n.x) / 6.28318531 + 1.0) * BOLT_COUNT);
  return vec3(bolt, along, edge);
}
`,
);
const made = [await build('avatar.glb', { tris: 0, texSize: 1024, withGame: true }), await build('avatar-lod1.glb', { tris: 3800, texSize: 512, withGame: false })];
await rm(tmp, { recursive: true, force: true });
for (const m of made) console.log(`avatar/${m.file}  ${(m.bytes / 1024).toFixed(0)} KB, ${m.tris} triangles`);
