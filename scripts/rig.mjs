#!/usr/bin/env node
// Rigs and animates the creatures. Zoodle's game models are static meshes;
// this turns each one into a skinned, animated GLB the game plays clips on.
//
//   node scripts/rig.mjs                 every creature in scripts/rigs.mjs
//   node scripts/rig.mjs witch hound     just these
//
// Source: assets/source/<rig>.glb, the static game model of the creature's
// Zoodle character (`npm run zoodle -- pull` downloads it, free). Output:
// the creature's model path in the manifest, holding:
//
//   - the mesh turned to face +Z, standing on y = 0, scaled to height 1
//     (the game scales it to the manifest height);
//   - a skeleton whose joints are placed in scripts/rigs.mjs and centred in
//     the limb they sit in (each joint is moved to the middle of the mesh's
//     cross-section there);
//   - skin weights: every vertex goes to the bones nearest to it (distance to
//     each bone's segment over the bone's thickness, inside the bone's
//     region), smoothed across the surface so joints bend softly;
//   - clips from scripts/motions.mjs, grounded so feet stay on the floor;
//   - hurtboxes measured from the mesh around head, torso, legs and arms,
//     and marker bones (horn tips, a staff's head) for the flames, stored in
//     the model root's extras.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as THREE from 'three';
import { readGlb, readAccessor, bufferViewBytes, GlbBuilder } from './glb.mjs';
import { RIGS, PLANS } from './rigs.mjs';
import { clipsFor } from './motions.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const FPS = 30;

// ------------------------------------------------------------------ mesh

function nodeMatrix(n) {
  const m = new THREE.Matrix4();
  if (n.matrix) return m.fromArray(n.matrix);
  const t = new THREE.Vector3(...(n.translation || [0, 0, 0]));
  const r = new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1]));
  const s = new THREE.Vector3(...(n.scale || [1, 1, 1]));
  return m.compose(t, r, s);
}

// The source's one mesh, in the rig frame: facing +Z, feet on y = 0,
// centred, height 1.
function loadMesh(glb, yaw) {
  const { json } = glb;
  let found = null;
  const walk = (i, parent) => {
    const n = json.nodes[i];
    const world = parent.clone().multiply(nodeMatrix(n));
    if (n.mesh !== undefined && !found) found = { mesh: json.meshes[n.mesh], world };
    for (const c of n.children || []) walk(c, world);
  };
  for (const i of json.scenes[json.scene || 0].nodes) walk(i, new THREE.Matrix4());
  if (!found) throw new Error('No mesh in source');
  if (found.mesh.primitives.length !== 1) throw new Error('Expected one primitive');
  const prim = found.mesh.primitives[0];
  const pos = readAccessor(glb, prim.attributes.POSITION);
  const nrm = readAccessor(glb, prim.attributes.NORMAL);
  const uv = readAccessor(glb, prim.attributes.TEXCOORD_0);
  const index = prim.indices !== undefined ? Uint32Array.from(readAccessor(glb, prim.indices)) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  const m = new THREE.Matrix4().makeRotationY(yaw).multiply(found.world);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < pos.length; i += 3) {
    v.fromArray(pos, i).applyMatrix4(m).toArray(pos, i);
    box.expandByPoint(v);
    v.fromArray(nrm, i).applyMatrix3(nm).normalize().toArray(nrm, i);
  }
  const k = 1 / (box.max.y - box.min.y);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - cx) * k;
    pos[i + 1] = (pos[i + 1] - box.min.y) * k;
    pos[i + 2] = (pos[i + 2] - cz) * k;
  }
  return { pos, nrm, uv, index, material: prim.material ?? 0, count: pos.length / 3 };
}

// Vertices that share a position (UV seams) are one point for weighting, and
// triangles give the neighbours used for smoothing.
function weld(mesh) {
  const ids = new Int32Array(mesh.count);
  const map = new Map();
  const points = [];
  for (let i = 0; i < mesh.count; i++) {
    const key = `${Math.round(mesh.pos[i * 3] * 1e4)},${Math.round(mesh.pos[i * 3 + 1] * 1e4)},${Math.round(mesh.pos[i * 3 + 2] * 1e4)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = points.length;
      map.set(key, id);
      points.push(new THREE.Vector3(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]));
    }
    ids[i] = id;
  }
  const nbr = points.map(() => new Set());
  for (let t = 0; t < mesh.index.length; t += 3) {
    const a = ids[mesh.index[t]];
    const b = ids[mesh.index[t + 1]];
    const c = ids[mesh.index[t + 2]];
    nbr[a].add(b).add(c);
    nbr[b].add(a).add(c);
    nbr[c].add(a).add(b);
  }
  for (let i = 0; i < nbr.length; i++) nbr[i].delete(i);
  return { ids, points, nbr: nbr.map((s) => [...s]) };
}

// --------------------------------------------------------------- skeleton

const mirrorName = (n) => (n.startsWith('Left') ? `Right${n.slice(4)}` : null);

function mirrorLimit(l) {
  if (!l) return l;
  const out = { ...l };
  if (l.x) out.x = [l.x[1] === undefined || l.x[1] === null ? -Infinity : -l.x[1], l.x[0] === undefined || l.x[0] === null ? Infinity : -l.x[0]];
  return out;
}

// Moves a joint to the middle of the mesh's cross-section through it
// (perpendicular to its bone), within radius r.
function snapJoint(p, dir, points, r) {
  const d = dir.clone().normalize();
  const c = new THREE.Vector3();
  const w = new THREE.Vector3();
  for (let it = 0; it < 4; it++) {
    c.set(0, 0, 0);
    let n = 0;
    for (const q of points) {
      w.subVectors(q, p);
      const along = w.dot(d);
      if (Math.abs(along) > 0.012) continue;
      w.addScaledVector(d, -along);
      if (w.lengthSq() > r * r) continue;
      c.add(w);
      n++;
    }
    if (n < 6) return false;
    p.addScaledVector(c, 1 / n);
  }
  return true;
}

function buildSkeleton(def, welded) {
  const plan = [...PLANS[def.plan], ...(def.extra || [])];
  const joints = { ...def.joints };
  for (const [name] of plan) {
    const m = mirrorName(name);
    if (m && joints[name] && !joints[m]) joints[m] = [-joints[name][0], joints[name][1], joints[name][2]];
  }
  const bones = [];
  const byName = new Map();
  for (const [name, parent, opts = {}] of plan) {
    const src = name.startsWith('Right') ? `Left${name.slice(5)}` : name;
    const at = opts.at || joints[name];
    if (!at) {
      if (opts.optional) continue;
      throw new Error(`${def.id}: no position for joint ${name}`);
    }
    if (parent && !byName.has(parent)) throw new Error(`${def.id}: ${name} before its parent ${parent}`);
    const b = {
      name,
      parent: parent ? byName.get(parent) : null,
      pos: new THREE.Vector3(...at),
      end: !!opts.end,
      marker: !!opts.marker,
      r: def.r?.[name] ?? def.r?.[src] ?? opts.r ?? 0.05,
      limit: def.limit?.[name] ?? (name !== src ? mirrorLimit(def.limit?.[src]) : undefined),
      children: [],
    };
    b.index = bones.length;
    if (b.parent) b.parent.children.push(b);
    bones.push(b);
    byName.set(name, b);
  }
  // Centre the joints named in `snap` (both sides) in their limb.
  for (const [name, r] of Object.entries(def.snap || {})) {
    for (const n of [name, mirrorName(name)].filter(Boolean)) {
      const b = byName.get(n);
      if (!b) continue;
      const next = b.children.find((c) => !c.marker);
      const dir = next ? next.pos.clone().sub(b.pos) : b.pos.clone().sub(b.parent.pos);
      if (!snapJoint(b.pos, dir, welded.points, r)) console.warn(`  ${def.id}: could not centre ${n}`);
    }
  }
  for (const b of bones) {
    const next = b.children.find((c) => !c.marker && !c.skip);
    b.deform = !b.end && !b.marker && b.parent !== null;
    b.seg = [b.pos, next ? next.pos : b.pos];
  }
  return { bones, byName };
}

// ------------------------------------------------------------------ weights

const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
function segDist(p, a, b) {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const l = _ab.lengthSq();
  const t = l > 1e-9 ? Math.max(0, Math.min(1, _ap.dot(_ab) / l)) : 0;
  return _ap.addScaledVector(_ab, -t).length();
}

function inLimit(l, p) {
  if (!l) return true;
  for (const [axis, i] of [['x', 0], ['y', 1], ['z', 2]]) {
    const r = l[axis];
    if (!r) continue;
    const v = p.getComponent(i);
    if ((r[0] !== undefined && r[0] !== null && v < r[0]) || (r[1] !== undefined && r[1] !== null && v > r[1])) return false;
  }
  return true;
}

// Parts that must never be joined by skin: a hand resting on a thigh was
// fused into one surface by the generator, and would pull a strand of
// triangles out of the leg when the arm moves.
const APART = {
  biped: [[/(Arm|ForeArm|Hand)$/, /^(Hips|.*UpLeg|.*Leg|.*Foot)$/]],
  beast: [[/^Tail/, /(UpLeg|Leg|Foot)$/], [/^Left(Arm|ForeArm|Hand)$/, /^Right(Arm|ForeArm|Hand)$/], [/^Left(UpLeg|Leg|Foot)$/, /^Right(UpLeg|Leg|Foot)$/]],
};

function skinWeights(def, skel, welded, mesh) {
  const deform = skel.bones.filter((b) => b.deform);
  const nb = skel.bones.length;
  const n = welded.points.length;
  const W = new Float32Array(n * nb);
  const allowed = new Uint8Array(n * nb);
  const locked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = welded.points[i];
    let total = 0;
    for (const b of deform) {
      if (!inLimit(b.limit, p)) continue;
      allowed[i * nb + b.index] = 1;
      const s = segDist(p, b.seg[0], b.seg[1]) / b.r + 0.05;
      const w = 1 / s ** 6;
      W[i * nb + b.index] = w;
      total += w;
    }
    if (!total) {
      // Outside every region: the nearest bone takes it regardless.
      let best = deform[0];
      let bd = Infinity;
      for (const b of deform) {
        const d = segDist(p, b.seg[0], b.seg[1]) / b.r;
        if (d < bd) [best, bd] = [b, d];
      }
      allowed[i * nb + best.index] = 1;
      W[i * nb + best.index] = 1;
      total = 1;
    }
    for (let j = 0; j < nb; j++) W[i * nb + j] /= total;
  }
  // Rigid parts: the vertices joined to `seed` through the surface without
  // leaving the `within` region (or simply those passing `test`).
  for (const rg of def.rigid || []) {
    const b = skel.byName.get(rg.bone);
    const take = new Uint8Array(n);
    if (rg.seed) {
      const seed = new THREE.Vector3(...rg.seed);
      let start = 0;
      for (let i = 1; i < n; i++) if (welded.points[i].distanceToSquared(seed) < welded.points[start].distanceToSquared(seed)) start = i;
      const queue = [start];
      take[start] = 1;
      while (queue.length) {
        const i = queue.pop();
        for (const j of welded.nbr[i]) {
          if (take[j] || !rg.within(welded.points[j])) continue;
          take[j] = 1;
          queue.push(j);
        }
      }
    } else for (let i = 0; i < n; i++) take[i] = rg.test(welded.points[i]) ? 1 : 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!take[i] || locked[i]) continue;
      W.fill(0, i * nb, (i + 1) * nb);
      W[i * nb + b.index] = 1;
      allowed[i * nb + b.index] = 1;
      locked[i] = 1;
      count++;
    }
    console.log(`  ${def.id}: ${count} vertices fixed to ${rg.bone}`);
  }
  // Cut the triangles that join parts kept apart, and smooth over what is left.
  const top = (i) => {
    let best = 0;
    for (let k = 1; k < nb; k++) if (W[i * nb + k] > W[i * nb + best]) best = k;
    return skel.bones[best].name;
  };
  const owner = Array.from({ length: n }, (_, i) => top(i));
  const pairs = [...(APART[def.plan] || []), ...(def.apart || [])];
  const kept = [];
  let cut = 0;
  for (let t = 0; t < mesh.index.length; t += 3) {
    const names = [0, 1, 2].map((k) => owner[welded.ids[mesh.index[t + k]]]);
    const split = pairs.some(([a, b]) => names.some((x) => a.test(x)) && names.some((y) => b.test(y)));
    if (split) cut++;
    else kept.push(mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]);
  }
  if (cut) {
    mesh.index = Uint32Array.from(kept);
    const nbr = welded.points.map(() => new Set());
    for (let t = 0; t < mesh.index.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => welded.ids[mesh.index[t + k]]);
      nbr[a].add(b).add(c);
      nbr[b].add(a).add(c);
      nbr[c].add(a).add(b);
    }
    const before = welded.nbr;
    welded.nbr = nbr.map((st, i) => [...st].filter((j) => j !== i));
    // Small pieces the cut left on the wrong side (a claw tip that sat on the
    // thigh) go back to the part they were joined to.
    const comp = new Int32Array(n).fill(-1);
    let moved = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (comp[s0] >= 0) continue;
      const members = [s0];
      comp[s0] = s0;
      for (let k = 0; k < members.length; k++) {
        for (const j of welded.nbr[members[k]]) {
          if (comp[j] < 0) {
            comp[j] = s0;
            members.push(j);
          }
        }
      }
      if (members.length > n * 0.015) continue;
      const votes = new Map();
      for (const i of members) for (const j of before[i]) if (comp[j] !== s0) votes.set(owner[j], (votes.get(owner[j]) || 0) + 1);
      if (!votes.size) continue;
      const bone = skel.byName.get([...votes].sort((a, b) => b[1] - a[1])[0][0]);
      for (const i of members) {
        W.fill(0, i * nb, (i + 1) * nb);
        W[i * nb + bone.index] = 1;
        allowed[i * nb + bone.index] = 1;
        locked[i] = 1;
      }
      moved += members.length;
    }
    console.log(`  ${def.id}: cut ${cut} triangles joining separate parts, ${moved} vertices rejoined`);
  }
  // Smooth across the surface so bends blend over a few rings of vertices.
  const tmp = new Float32Array(nb);
  for (let it = 0; it < (def.smooth ?? 6); it++) {
    const next = new Float32Array(W);
    for (let i = 0; i < n; i++) {
      if (locked[i]) continue;
      const nn = welded.nbr[i];
      if (!nn.length) continue;
      tmp.fill(0);
      for (const j of nn) for (let k = 0; k < nb; k++) tmp[k] += W[j * nb + k];
      let total = 0;
      for (let k = 0; k < nb; k++) {
        const v = allowed[i * nb + k] ? 0.5 * W[i * nb + k] + (0.5 * tmp[k]) / nn.length : 0;
        next[i * nb + k] = v;
        total += v;
      }
      if (total > 0) for (let k = 0; k < nb; k++) next[i * nb + k] /= total;
      else for (let k = 0; k < nb; k++) next[i * nb + k] = W[i * nb + k];
    }
    W.set(next);
  }
  // Four strongest influences per vertex.
  const joints = new Uint8Array(n * 4);
  const weights = new Float32Array(n * 4);
  const dominant = new Int32Array(n);
  const order = Array.from({ length: nb }, (_, k) => k);
  for (let i = 0; i < n; i++) {
    order.sort((a, b) => W[i * nb + b] - W[i * nb + a]);
    let total = 0;
    for (let k = 0; k < 4; k++) total += W[i * nb + order[k]];
    for (let k = 0; k < 4; k++) {
      joints[i * 4 + k] = order[k];
      weights[i * 4 + k] = total > 0 ? W[i * nb + order[k]] / total : k === 0 ? 1 : 0;
    }
    dominant[i] = order[0];
  }
  return { joints, weights, dominant };
}

// --------------------------------------------------------------- posing

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _t = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

// World matrices of every bone for a pose (rest = all identity rotations).
function poseWorld(skel, pose, out) {
  for (const b of skel.bones) {
    const r = pose[b.name] || [0, 0, 0];
    _q.setFromEuler(_e.set(r[0], r[1], r[2], 'YXZ'));
    _t.copy(b.pos);
    if (b.parent) _t.sub(b.parent.pos);
    const tr = pose[`${b.name}.p`];
    if (tr) _t.x += tr[0], _t.y += tr[1], _t.z += tr[2];
    const local = out[b.index].compose(_t, _q, _one);
    if (b.parent) local.premultiply(out[b.parent.index]);
  }
  return out;
}

// Lowest point of the posed mesh over a sample of vertices.
function lowest(skel, skin, welded, pose, sample, mats) {
  poseWorld(skel, pose, mats);
  const skinMats = mats.map((m, i) => m.clone().multiply(new THREE.Matrix4().makeTranslation(-skel.bones[i].pos.x, -skel.bones[i].pos.y, -skel.bones[i].pos.z)));
  let min = Infinity;
  const v = new THREE.Vector3();
  for (const i of sample) {
    const p = welded.points[i];
    let y = 0;
    for (let k = 0; k < 4; k++) {
      const w = skin.weights[i * 4 + k];
      if (!w) continue;
      v.copy(p).applyMatrix4(skinMats[skin.joints[i * 4 + k]]);
      y += v.y * w;
    }
    if (y < min) min = y;
  }
  return min;
}

function bakeClips(def, skel, skin, welded) {
  const mats = skel.bones.map(() => new THREE.Matrix4());
  const footBones = new Set(PLANS[def.plan].filter(([n]) => /Foot|Toe|Hand(?!Tip)/.test(n) && (def.plan === 'beast' || !/Hand/.test(n))).map(([n]) => n));
  const feet = [];
  const all = [];
  for (let i = 0; i < welded.points.length; i++) {
    if (footBones.has(skel.bones[skin.dominant[i]].name)) feet.push(i);
    if (i % 3 === 0) all.push(i);
  }
  const restFeet = lowest(skel, skin, welded, {}, feet, mats);
  const out = [];
  for (const clip of clipsFor(def)) {
    const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
    const poses = [];
    for (let f = 0; f < frames; f++) {
      const u = f / (frames - 1);
      const pose = clip.sample(clip.loop && f === frames - 1 ? 0 : u);
      const g = clip.ground?.(u);
      if (g) {
        const tr = pose['Root.p'] || (pose['Root.p'] = [0, 0, 0]);
        tr[1] = 0;
        const low = lowest(skel, skin, welded, pose, g === 'all' ? all : feet, mats);
        tr[1] = (g === 'all' ? 0.005 : restFeet) - low;
      }
      poses.push(pose);
    }
    out.push({ name: clip.name, duration: clip.duration, poses });
  }
  return out;
}

// -------------------------------------------------------------- hurtboxes

function hurtboxes(def, skel, skin, welded) {
  const groups = def.plan === 'biped'
    ? [
        { name: 'head', bone: 'Head', of: /^(Neck|Head|Hat)/, cut: 'above-neck', multiplier: 1.5 },
        { name: 'torso', bone: 'Chest', of: /^(Waist|Chest|.*Shoulder)$/, multiplier: 1 },
        { name: 'legs', bone: 'Hips', of: /^(Hips|.*UpLeg|.*Leg|.*Foot)$/, multiplier: 0.85 },
        { name: 'arm', bone: 'LeftForeArm', of: /^Left(ForeArm|Hand)$/, multiplier: 0.8 },
        { name: 'arm', bone: 'RightForeArm', of: /^Right(ForeArm|Hand)$/, multiplier: 0.8 },
      ]
    : [
        { name: 'head', bone: 'Head', of: /^Head$/, multiplier: 1.5 },
        { name: 'torso', bone: 'Chest', of: /^(Chest|Neck|.*Arm)$/, multiplier: 1 },
        { name: 'torso', bone: 'Hips', of: /^(Hips|Waist|.*UpLeg|Tail1)$/, multiplier: 1 },
        { name: 'legs', bone: 'Waist', of: /^(.*ForeArm|.*Hand|.*Leg|.*Foot)$/, multiplier: 0.85 },
      ];
  const out = [];
  for (const g of groups) {
    const box = new THREE.Box3();
    for (let i = 0; i < welded.points.length; i++) if (g.of.test(skel.bones[skin.dominant[i]].name)) box.expandByPoint(welded.points[i]);
    if (box.isEmpty()) continue;
    const anchor = skel.byName.get(g.bone);
    const c = box.getCenter(new THREE.Vector3()).sub(anchor.pos);
    const h = box.getSize(new THREE.Vector3()).multiplyScalar(0.45);
    out.push({ name: g.name, bone: g.bone, offset: c.toArray().map(r3), half: h.toArray().map(r3), multiplier: g.multiplier });
  }
  return out;
}

const r3 = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ write

function writeRigged(def, glb, mesh, skel, skin, welded, clips, boxes) {
  const g = new GlbBuilder();
  const j = g.json;
  j.asset.generator = 'The Demon Descent scripts/rig.mjs';
  const src = glb.json;
  // Textures and the material, as they were.
  j.images = (src.images || []).map((im, i) => ({ name: im.name || `image${i}`, mimeType: im.mimeType, bufferView: g.view(bufferViewBytes(glb, im.bufferView)) }));
  j.samplers = src.samplers;
  j.textures = src.textures;
  j.materials = [{ ...src.materials[mesh.material], name: def.id }];
  // Per-vertex skin from the welded points.
  const n = mesh.count;
  const J = new Uint8Array(n * 4);
  const Wt = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const w = welded.ids[i];
    J.set(skin.joints.subarray(w * 4, w * 4 + 4), i * 4);
    Wt.set(skin.weights.subarray(w * 4, w * 4 + 4), i * 4);
  }
  const index = n < 65536 ? Uint16Array.from(mesh.index) : mesh.index;
  const prim = {
    attributes: {
      POSITION: g.accessor(mesh.pos, 'VEC3', { target: 34962, minmax: true }),
      NORMAL: g.accessor(mesh.nrm, 'VEC3', { target: 34962 }),
      TEXCOORD_0: g.accessor(mesh.uv, 'VEC2', { target: 34962 }),
      JOINTS_0: g.accessor(J, 'VEC4', { target: 34962 }),
      WEIGHTS_0: g.accessor(Wt, 'VEC4', { target: 34962 }),
    },
    indices: g.accessor(index, 'SCALAR', { target: 34963 }),
    material: 0,
  };
  j.meshes = [{ name: def.id, primitives: [prim] }];
  // Nodes: 0 the model root, 1 the skinned mesh, 2.. the bones.
  const base = 2;
  const boneNodes = skel.bones.map((b) => {
    const t = b.pos.clone();
    if (b.parent) t.sub(b.parent.pos);
    const node = { name: b.name, translation: t.toArray().map((v) => Math.round(v * 1e5) / 1e5) };
    if (b.children.length) node.children = b.children.map((c) => base + c.index);
    return node;
  });
  const markers = Object.fromEntries(skel.bones.filter((b) => b.marker).map((b) => [b.name, b.parent.name]));
  j.nodes = [
    { name: def.id, children: [1, base], extras: { rig: { plan: def.plan, death: def.death || 'back', hurtboxes: boxes, markers } } },
    { name: `${def.id}-body`, mesh: 0, skin: 0 },
    ...boneNodes,
  ];
  const ibm = new Float32Array(skel.bones.length * 16);
  skel.bones.forEach((b, i) => new THREE.Matrix4().makeTranslation(-b.pos.x, -b.pos.y, -b.pos.z).toArray(ibm, i * 16));
  j.skins = [{ name: def.id, joints: skel.bones.map((b) => base + b.index), inverseBindMatrices: g.accessor(ibm, 'MAT4'), skeleton: base }];
  j.scenes = [{ nodes: [0] }];
  j.scene = 0;
  // Clips: rotation tracks for bones that move, translation for Root/Hips.
  j.animations = clips.map((clip) => {
    const frames = clip.poses.length;
    const times = Float32Array.from({ length: frames }, (_, f) => (f / (frames - 1)) * clip.duration);
    const input = g.accessor(times, 'SCALAR', { minmax: true });
    const samplers = [];
    const channels = [];
    for (const b of skel.bones) {
      const rots = clip.poses.map((p) => p[b.name]);
      if (rots.some((r) => r && (Math.abs(r[0]) > 1e-4 || Math.abs(r[1]) > 1e-4 || Math.abs(r[2]) > 1e-4))) {
        const q = new Float32Array(frames * 4);
        const prev = new THREE.Quaternion();
        rots.forEach((r = [0, 0, 0], f) => {
          _q.setFromEuler(_e.set(r[0], r[1], r[2], 'YXZ'));
          if (f && _q.dot(prev) < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
          prev.copy(_q);
          _q.toArray(q, f * 4);
        });
        samplers.push({ input, output: g.accessor(q, 'VEC4'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: base + b.index, path: 'rotation' } });
      }
      const trs = clip.poses.map((p) => p[`${b.name}.p`]);
      if (trs.some(Boolean)) {
        const rest = b.pos.clone();
        if (b.parent) rest.sub(b.parent.pos);
        const t = new Float32Array(frames * 3);
        trs.forEach((tr = [0, 0, 0], f) => {
          t[f * 3] = rest.x + tr[0];
          t[f * 3 + 1] = rest.y + tr[1];
          t[f * 3 + 2] = rest.z + tr[2];
        });
        samplers.push({ input, output: g.accessor(t, 'VEC3'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: base + b.index, path: 'translation' } });
      }
    }
    return { name: clip.name, samplers, channels };
  });
  return g.toBuffer();
}

// ------------------------------------------------------------------- main

async function rig(id) {
  const def = { id, ...RIGS[id] };
  const source = join(ROOT, def.source);
  let buf;
  try {
    buf = await readFile(source);
  } catch {
    console.log(`${id}: no ${def.source} (npm run zoodle -- pull ${def.slot}=${def.zoodle}) - skipped`);
    return;
  }
  const glb = readGlb(buf);
  const mesh = loadMesh(glb, def.yaw || 0);
  const welded = weld(mesh);
  const skel = buildSkeleton(def, welded);
  const skin = skinWeights(def, skel, welded, mesh);
  const clips = bakeClips(def, skel, skin, welded);
  const boxes = hurtboxes(def, skel, skin, welded);
  const out = writeRigged(def, glb, mesh, skel, skin, welded, clips, boxes);
  const path = join(ROOT, def.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, out);
  const joints = Object.fromEntries(skel.bones.filter((b) => process.argv.includes('--all') || !b.name.startsWith('Right')).map((b) => [b.name, b.pos.toArray().map(r3)]));
  if (process.argv.includes('--joints')) console.log(JSON.stringify(joints));
  console.log(`${id}: ${def.out} (${(out.length / 1024).toFixed(0)} KB, ${skel.bones.length} bones, ${mesh.index.length / 3} tris, clips: ${clips.map((c) => c.name).join(' ')})`);
}

const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const id of names.length ? names : Object.keys(RIGS)) {
  if (!RIGS[id]) throw new Error(`Unknown rig "${id}". Rigs: ${Object.keys(RIGS).join(', ')}`);
  await rig(id);
}
