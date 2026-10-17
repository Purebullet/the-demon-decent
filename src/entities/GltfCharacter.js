import * as THREE from 'three';
import { Assets } from '../assets/AssetLibrary.js';
import { Hurtbox, AnchoredHurtbox } from '../physics/Hitbox.js';
import { attackWeights, FLAMES } from './poses.js';
import { attackClipTime } from './clipPhases.js';
import { Ragdoll } from './Ragdoll.js';

// Wraps an AI-generated GLB creature for the game: root, joints, body-part
// hurtboxes, fire emitters and an animate() driven by the AI state.
//
// Rigged models (with a skeleton and clips, see scripts/rig.mjs): hurtboxes
// ride the head, chest, hips and forearm bones, sized from the mesh, and the
// AI state drives the clips. Clip time comes from the game, not the clock:
// walking and running follow the stride phase, so feet keep pace with the
// ground, and an attack clip follows its windup, strike and recovery, so a
// claw lands exactly while the strike volume is live.
//
// Static meshes (what Zoodle's game models are): a vertex-shader deformer
// bends the body around the hips, so the torso rears back on a telegraph,
// lunges through the strike, twists on sweeps, recoils when staggered, and
// the legs scissor while walking. Head and torso hurtboxes follow the same
// bend, so hits land where the body visibly is.

const norm = (s) => s.toLowerCase().replace(/^mixamorig[:_]?/, '').replace(/[\s:]/g, '');

const BONES = {
  head: /^head$|head(?!top|end|_end|nub)/,
  chest: /spine2|spine_?02|upperchest|chest|spine1|spine_?01|spine/,
  hips: /hips|pelvis/,
  lforearm: /left_?fore_?arm|l_?forearm|forearm_?l|lowerarm_?l|leftlowerarm/,
  rforearm: /right_?fore_?arm|r_?forearm|forearm_?r|lowerarm_?r|rightlowerarm/,
};

// Bend in character space: y up from the feet, +z forward. Pivot = hips.
const BEND_GLSL = /* glsl */ `
uniform mat4 uToChar;
uniform mat4 uFromChar;
uniform float uPivot;
uniform float uTop;
uniform float uBend;
uniform float uSway;
uniform float uTwist;
uniform float uStep;
uniform float uGait;
vec3 ddRotate(vec3 q, float y) {
  float k = smoothstep(uPivot, uTop, y);
  float a = uBend * k;
  q = vec3(q.x, q.y * cos(a) - q.z * sin(a), q.y * sin(a) + q.z * cos(a));
  float s = uSway * k;
  q = vec3(q.x * cos(s) - q.y * sin(s), q.x * sin(s) + q.y * cos(s), q.z);
  float w = uTwist * k;
  return vec3(q.x * cos(w) + q.z * sin(w), q.y, -q.x * sin(w) + q.z * cos(w));
}
vec3 ddBend(vec3 p) {
  float legs = 1.0 - smoothstep(0.0, uPivot, p.y);
  // Bipeds scissor left against right; four-legged beasts trot (diagonal pairs).
  float side = clamp(p.x / (uPivot * 0.3 + 1e-4), -1.0, 1.0) * mix(1.0, sign(p.z), uGait);
  p.z += uStep * side * legs;
  vec3 q = ddRotate(p - vec3(0.0, uPivot, 0.0), p.y);
  return q + vec3(0.0, uPivot, 0.0);
}`;

function installBend(mesh, toChar, U) {
  const fromChar = toChar.clone().invert();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U, { uToChar: { value: toChar }, uFromChar: { value: fromChar } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BEND_GLSL}`)
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
  float ddY = (uToChar * vec4(position, 1.0)).y;
  objectNormal = normalize(mat3(uFromChar) * ddRotate(mat3(uToChar) * objectNormal, ddY));`,
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = (uFromChar * vec4(ddBend((uToChar * vec4(transformed, 1.0)).xyz), 1.0)).xyz;');
    };
    m.customProgramCacheKey = () => 'demon-descent-bend';
    m.needsUpdate = true;
  }
}

// Dual-quaternion skinning: each bone's pull is a rotation and a move,
// blended as such (not as matrices), so a limb twisted or bent keeps its
// thickness instead of pinching like a sweet wrapper where two bones share
// the skin. Each frame the bones' transforms (in the mesh's own space) are
// turned into dual quaternions on the CPU and handed to the shader.
const DQ_GLSL = /* glsl */ `
uniform vec4 dqReal[DQ_BONES];
uniform vec4 dqDual[DQ_BONES];
vec3 dqRot(vec4 r, vec3 v) { return v + 2.0 * cross(r.xyz, cross(r.xyz, v) + r.w * v); }`;
const DQ_BLEND = /* glsl */ `
#ifdef USE_SKINNING
  ivec4 dqi = ivec4(skinIndex);
  vec4 dq0 = dqReal[dqi.x];
  vec4 dqR = skinWeight.x * dq0;
  vec4 dqD = skinWeight.x * dqDual[dqi.x];
  float dqw = dot(dq0, dqReal[dqi.y]) < 0.0 ? -skinWeight.y : skinWeight.y;
  dqR += dqw * dqReal[dqi.y]; dqD += dqw * dqDual[dqi.y];
  dqw = dot(dq0, dqReal[dqi.z]) < 0.0 ? -skinWeight.z : skinWeight.z;
  dqR += dqw * dqReal[dqi.z]; dqD += dqw * dqDual[dqi.z];
  dqw = dot(dq0, dqReal[dqi.w]) < 0.0 ? -skinWeight.w : skinWeight.w;
  dqR += dqw * dqReal[dqi.w]; dqD += dqw * dqDual[dqi.w];
  float dqLen = max(length(dqR), 1e-6);
  dqR /= dqLen;
  dqD /= dqLen;
  vec3 dqMove = 2.0 * (dqR.w * dqD.xyz - dqD.w * dqR.xyz + cross(dqR.xyz, dqD.xyz));
#endif`;
const DQ_NORMAL = /* glsl */ `
#ifdef USE_SKINNING
  objectNormal = dqRot(dqR, objectNormal);
  #ifdef USE_TANGENT
  objectTangent = dqRot(dqR, objectTangent);
  #endif
#endif`;
const DQ_VERTEX = /* glsl */ `
#ifdef USE_SKINNING
  transformed = dqRot(dqR, transformed) + dqMove;
#endif`;
const _dqM = new THREE.Matrix4();
const _dqP = new THREE.Vector3();
const _dqQ = new THREE.Quaternion();
const _dqS = new THREE.Vector3();

function installDualQuat(mesh) {
  const sk = mesh.skeleton;
  const nb = sk.bones.length;
  const real = new Float32Array(nb * 4);
  const dual = new Float32Array(nb * 4);
  const prev = mesh.onBeforeRender;
  mesh.onBeforeRender = function (...args) {
    prev?.apply(this, args);
    for (let i = 0; i < nb; i++) {
      _dqM.multiplyMatrices(mesh.bindMatrixInverse, sk.bones[i].matrixWorld).multiply(sk.boneInverses[i]).multiply(mesh.bindMatrix);
      _dqM.decompose(_dqP, _dqQ, _dqS);
      const { x: qx, y: qy, z: qz, w: qw } = _dqQ;
      const { x: tx, y: ty, z: tz } = _dqP;
      const o = i * 4;
      real[o] = qx;
      real[o + 1] = qy;
      real[o + 2] = qz;
      real[o + 3] = qw;
      // dual = (t, 0) q / 2
      dual[o] = 0.5 * (tx * qw + ty * qz - tz * qy);
      dual[o + 1] = 0.5 * (-tx * qz + ty * qw + tz * qx);
      dual[o + 2] = 0.5 * (tx * qy - ty * qx + tz * qw);
      dual[o + 3] = -0.5 * (tx * qx + ty * qy + tz * qz);
    }
  };
  const U = { dqReal: { value: real }, dqDual: { value: dual } };
  for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    const before = m.onBeforeCompile;
    const key = m.customProgramCacheKey;
    m.onBeforeCompile = (shader, renderer) => {
      before?.call(m, shader, renderer);
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <skinning_pars_vertex>', `#include <skinning_pars_vertex>\n#ifdef USE_SKINNING\n#define DQ_BONES ${nb}\n${DQ_GLSL}\n#endif`)
        .replace('#include <skinbase_vertex>', DQ_BLEND)
        .replace('#include <skinnormal_vertex>', DQ_NORMAL)
        .replace('#include <skinning_vertex>', DQ_VERTEX);
    };
    m.customProgramCacheKey = () => `${key ? key.call(m) : ''}|dq${nb}`;
    m.needsUpdate = true;
  }
}

export function buildGltfCharacter(id, rootScale = 1) {
  const inst = Assets.instantiateCharacter(id, rootScale);
  const H = inst.height;
  const beast = inst.entry.body === 'beast';
  const root = new THREE.Group();
  const pose = new THREE.Group();
  root.add(pose);
  pose.add(inst.inner);
  root.updateMatrixWorld(true);

  const bones = [];
  // The skin itself, for laying wounds on it (combat/Wounds.js).
  const meshes = [];
  inst.model.traverse((o) => {
    if (o.isBone) bones.push(o);
    if (o.isMesh) meshes.push(o);
  });
  const find = (pattern) => {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    return bones.find((b) => b.name === pattern) || bones.find((b) => re.test(norm(b.name))) || null;
  };
  if (inst.entry.dualQuat) for (const m of meshes) if (m.isSkinnedMesh && m.skeleton) installDualQuat(m);
  const head = find(BONES.head);
  const chest = find(BONES.chest);
  const hips = find(BONES.hips);
  const rigged = !!(head && chest && hips);
  const V = (x, y, z) => new THREE.Vector3(x * H, y * H, z * H);

  // Static meshes get the bend deformer.
  const U = {
    uPivot: { value: (beast ? 0.4 : 0.47) * H },
    uTop: { value: H },
    uBend: { value: 0 },
    uSway: { value: 0 },
    uTwist: { value: 0 },
    uStep: { value: 0 },
    uGait: { value: beast ? 1 : 0 },
  };
  if (!rigged) {
    const inv = new THREE.Matrix4().copy(pose.matrixWorld).invert();
    inst.model.traverse((o) => {
      if (o.isMesh && !o.isSkinnedMesh) installBend(o, new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld), U);
    });
  }

  // Same bend on the CPU, to move the hurtboxes and flame anchors with it.
  const bendPoint = (p, out) => {
    const pivot = U.uPivot.value;
    const k = THREE.MathUtils.smoothstep(p.y, pivot, U.uTop.value);
    out.set(p.x, p.y - pivot, p.z);
    const a = U.uBend.value * k;
    const s = U.uSway.value * k;
    const w = U.uTwist.value * k;
    let { x, y, z } = out;
    [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
    [x, y] = [x * Math.cos(s) - y * Math.sin(s), x * Math.sin(s) + y * Math.cos(s)];
    [x, z] = [x * Math.cos(w) + z * Math.sin(w), -x * Math.sin(w) + z * Math.cos(w)];
    return out.set(x, y + pivot, z);
  };

  let hurtboxes;
  const bentAnchors = [];
  if (rigged && inst.rig?.hurtboxes) {
    // Measured from the mesh by the rig script, in model units.
    const k = inst.unit;
    hurtboxes = inst.rig.hurtboxes
      .map((h) => {
        const b = find(h.bone);
        if (!b) return null;
        const v = (a) => new THREE.Vector3(a[0] * k, a[1] * k, a[2] * k);
        return new AnchoredHurtbox(b, root, v(h.offset), v(h.half), { name: h.name, multiplier: h.multiplier });
      })
      .filter(Boolean);
  } else if (rigged) {
    hurtboxes = [
      new AnchoredHurtbox(head, root, V(0, 0.03, 0.01), V(0.085, 0.09, 0.09), { name: 'head', multiplier: 1.5 }),
      new AnchoredHurtbox(chest, root, V(0, 0, 0), V(0.18, 0.15, 0.12), { name: 'torso' }),
      new AnchoredHurtbox(hips, root, V(0, -0.24, 0), V(0.15, 0.27, 0.11), { name: 'legs', multiplier: 0.85 }),
    ];
    for (const re of [BONES.lforearm, BONES.rforearm]) {
      const b = find(re);
      if (b) hurtboxes.push(new AnchoredHurtbox(b, root, V(0, 0, 0), V(0.06, 0.06, 0.06), { name: 'arm', multiplier: 0.8 }));
    }
  } else {
    // Boxes placed by body proportion; head and torso ride the bend.
    const bent = (rest) => {
      const a = new THREE.Object3D();
      a.position.copy(rest);
      pose.add(a);
      bentAnchors.push({ anchor: a, rest });
      return a;
    };
    if (beast) {
      // Head at the front end of the body, torso along it, legs under it.
      const b = new THREE.Box3().setFromObject(inst.inner);
      const front = b.max.z / H;
      const mid = (b.min.z + b.max.z) / 2 / H;
      const len = (b.max.z - b.min.z) / H;
      hurtboxes = [
        new AnchoredHurtbox(bent(V(0, 0.74, front - 0.16)), root, V(0, 0, 0), V(0.13, 0.13, 0.17), { name: 'head', multiplier: 1.5 }),
        new AnchoredHurtbox(bent(V(0, 0.6, mid)), root, V(0, 0, 0), V(0.18, 0.18, len * 0.32), { name: 'torso' }),
        new Hurtbox(pose, V(0, 0.22, mid), V(0.17, 0.22, len * 0.38), { name: 'legs', multiplier: 0.85 }),
      ];
    } else {
      hurtboxes = [
        new AnchoredHurtbox(bent(V(0, 0.9, 0.02)), root, V(0, 0, 0), V(0.1, 0.1, 0.11), { name: 'head', multiplier: 1.5 }),
        new AnchoredHurtbox(bent(V(0, 0.66, 0)), root, V(0, 0, 0), V(0.21, 0.17, 0.15), { name: 'torso' }),
        new Hurtbox(pose, V(0, 0.25, 0), V(0.17, 0.26, 0.13), { name: 'legs', multiplier: 0.85 }),
      ];
    }
  }

  // Flame anchors follow bones (or bent body points) each frame.
  const j = {};
  const fire = [];
  const anchors = [];
  for (const f of inst.entry.fire || []) {
    const anchor = new THREE.Object3D();
    pose.add(anchor);
    const bone = f.bone ? find(new RegExp(f.bone)) : null;
    anchors.push({ anchor, bone, offset: V(...(f.offset || [0, 0, 0])), rest: V(...(f.at || [0, 1, 0])) });
    if (f.name) j[f.name] = anchor;
    fire.push({ anchor, offset: null, spawn: FLAMES[f.kind] || FLAMES.horn, rate: f.rate || 20 });
  }
  if (!j.staffTip) {
    j.staffTip = new THREE.Object3D();
    j.staffTip.position.copy(V(0.25, 0.95, 0.15));
    pose.add(j.staffTip);
  }

  const mats = [];
  inst.model.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.emissive) mats.push(m);
  });

  // ---- Clips (rigged models only) ----
  // Every clip is played with time set by the game and blended by weights
  // that ease toward their targets, so changes of state never pop.
  const clips = inst.clips;
  const mixer = rigged && Object.keys(clips).length ? new THREE.AnimationMixer(inst.model) : null;
  const layers = new Map();
  const layerList = [];
  const layer = (name) => {
    if (!mixer || !clips[name]) return null;
    let l = layers.get(name);
    if (!l) {
      const action = mixer.clipAction(clips[name]);
      action.play();
      action.paused = true;
      action.setEffectiveWeight(0);
      l = { action, weight: 0, target: 0, time: 0, duration: clips[name].duration };
      layers.set(name, l);
      layerList.push(l);
    }
    return l;
  };
  // Every clip's action made now, as the floor loads, not the first time a
  // demon swings or dies mid-fight (each is a handful of allocations).
  if (mixer) for (const name of Object.keys(clips)) layer(name);
  const TAU = Math.PI * 2;
  const frac = (v) => v - Math.floor(v);

  function drive(e, dt, t) {
    for (let i = 0; i < layerList.length; i++) layerList[i].target = 0;
    const set = (name, u, w = 1) => {
      const l = layer(name);
      if (!l) return false;
      l.target += w;
      l.time = Math.min(0.999, Math.max(0, u)) * l.duration;
      return true;
    };
    let rate = 9;
    const k = Math.min(1, e.stateT / Math.max(1e-3, e.stateDur));
    const attacking = e.state === 'windup' || e.state === 'strike' || e.state === 'recover';
    if (e.state === 'dying') {
      rate = 14;
      // (`deathU`: a death the creature paces itself, the Sleeper's.)
      set('death', e.deathU ?? e.stateT / 1.6) || set('hit', 1);
    } else if (e.pose && clips[e.pose.name]) {
      // A clip the creature drives itself (asleep, rising): { name, u }.
      rate = e.pose.rate ?? 6;
      set(e.pose.name, e.pose.u);
    } else if (e.state === 'stagger') {
      rate = 16;
      // Stumbling: the legs stagger backwards under the hit pose.
      if (e.stumbling && clips.walk) {
        set('hit', k, 0.55);
        set('walk', frac(1 - e.stateT * 1.9 + e.seed), 0.45 * (1 - k * 0.6));
      } else set('hit', k);
    } else if (attacking && e.attack && (clips[e.attack.clip || e.attack.name] || clips.attack)) {
      rate = 14;
      const name = e.attack.clip || e.attack.name;
      set(clips[name] ? name : 'attack', attackClipTime(e.state, k));
    } else {
      // Idle, walk and run blended by speed; feet follow the stride phase.
      const mv = e.moveBlend;
      const stride = frac(e.walkPhase / TAU);
      const run = clips.run ? Math.min(1, Math.max(0, (mv - 0.5) / 0.3)) : 0;
      const walk = Math.min(1, mv / 0.25) * (1 - run);
      if (walk > 0) set('walk', stride, walk);
      if (run > 0) set('run', stride, run);
      set('idle', frac(t / (clips.idle?.duration || 3) + e.seed), Math.max(0, 1 - walk - run));
    }
    let total = 0;
    for (let i = 0; i < layerList.length; i++) {
      const l = layerList[i];
      l.weight += (l.target - l.weight) * Math.min(1, dt * rate);
      if (l.weight < 0.002 && l.target === 0) l.weight = 0;
      total += l.weight;
    }
    for (let i = 0; i < layerList.length; i++) {
      const l = layerList[i];
      const w = total > 0 ? l.weight / total : 0;
      l.action.enabled = w > 0;
      l.action.setEffectiveWeight(w);
      l.action.time = l.time;
    }
    mixer.update(0);
  }

  // Ragdoll flop over the death clip: head, arms, legs and tail keep swinging
  // loosely after the body hits the floor and settle like dead weight.
  const floppy = bones
    .filter((b) => /^(Neck|Head|Left|Right|Tail|Hat)/.test(b.name) && !/Toe|Tip|End|Horn|StaffTip|Heart/.test(b.name))
    .map((b, i) => ({ bone: b, phase: i * 1.7, axis: new THREE.Vector3(Math.sin(i * 2.3), Math.cos(i * 1.3) * 0.5, Math.cos(i * 2.3)).normalize(), amp: /Arm|Hand|Head|Tail/.test(b.name) ? 0.55 : 0.3 }));
  const _fq = new THREE.Quaternion();
  function flop(st) {
    // Strongest around the moment of impact (about 0.6 s into the fall).
    const after = Math.max(0, st - 0.45);
    const k = Math.exp(-after * 2.6) * Math.min(1, st / 0.3);
    if (k < 0.01) return;
    for (const f of floppy) {
      _fq.setFromAxisAngle(f.axis, Math.sin(st * 13 + f.phase) * f.amp * k);
      f.bone.quaternion.multiply(_fq);
    }
  }

  const ext = new THREE.Box3().setFromObject(inst.inner).getSize(new THREE.Vector3());
  const reach = Math.hypot(ext.x, ext.z) / 2;

  // ---- Hit reactions ----
  // Every blow kicks a spring per axis (pitch, roll, twist): the body tilts
  // away along the blow, twists with the blade's sweep, harder the higher
  // it lands; the chest and head follow through on a rig, the head snapping
  // hardest when it is the head that was struck. Underdamped, so a body
  // jolts, rocks back once and settles in about a third of a second.
  const SPRING_K = 320;
  const SPRING_C = 15;
  const spring = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, head: 0 };
  const _inv = new THREE.Quaternion();
  const _rq = new THREE.Quaternion();
  const _pq = new THREE.Quaternion();
  const _local = new THREE.Vector3();
  const _sweepL = new THREE.Vector3();
  function react(e, dir, contact, sweep, force) {
    _inv.copy(root.quaternion).invert();
    _local.set(dir.x, 0, dir.z).applyQuaternion(_inv);
    const len = Math.hypot(_local.x, _local.z);
    if (len > 1e-4) _local.multiplyScalar(1 / len);
    // Higher on the body = more leverage.
    let lever = 0.75;
    if (contact) {
      const y = (contact.y - root.position.y) / Math.max(0.5, H * root.scale.y);
      lever = 0.45 + Math.min(1, Math.max(0, y)) * 0.8;
      spring.head = Math.max(spring.head, y > 0.78 ? 1 : 0);
    }
    const mass = Math.sqrt(e.type?.mass || 1);
    const v = (2.2 + 3.2 * Math.min(1.5, force)) * lever / mass;
    spring.vx += _local.z * v;
    spring.vz += -_local.x * v;
    if (sweep) {
      _sweepL.copy(sweep).applyQuaternion(_inv);
      spring.vy += -_sweepL.x * v * 0.7;
    }
  }
  // Turn a bone by (pitch, twist, roll) about character-space axes, on top
  // of its animated pose. Clips only key the bones they move, so a bone the
  // mixer left alone this frame still holds last frame's turn: that is
  // undone first, so turns never pile up.
  const applied = new Map();
  const _e = new THREE.Euler();
  const _cq = new THREE.Quaternion();
  function turnBone(bone, x, y, z) {
    if (!bone) return;
    let rec = applied.get(bone);
    if (rec && bone.quaternion.equals(rec.out)) bone.quaternion.copy(rec.base);
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-4) {
      applied.delete(bone);
      return;
    }
    if (!rec) applied.set(bone, (rec = { base: new THREE.Quaternion(), out: new THREE.Quaternion() }));
    rec.base.copy(bone.quaternion);
    // Character-space turn, expressed in the bone's parent space.
    bone.parent.getWorldQuaternion(_pq);
    _cq.setFromEuler(_e.set(x, y, z, 'YXZ'));
    _rq.copy(root.quaternion).multiply(_cq).multiply(_inv.copy(root.quaternion).invert());
    _rq.premultiply(_inv.copy(_pq).invert()).multiply(_pq);
    bone.quaternion.premultiply(_rq);
    rec.out.copy(bone.quaternion);
  }

  // A rigged body goes limp when it dies: a ragdoll takes the skeleton over
  // from the clips (see Ragdoll.js) and the body lies where it fell.
  let rag = null;
  function startRagdoll(impulse) {
    root.updateMatrixWorld(true);
    rag = new Ragdoll(bones, H, impulse);
    // It can end up well away from where it stood: never culled for that.
    inst.model.traverse((o) => {
      if (o.isSkinnedMesh) o.frustumCulled = false;
    });
  }
  function stepRagdoll(dt, world, pushers, sink) {
    if (!rag) return;
    rag.sink = sink;
    rag.step(dt, world, pushers);
  }

  const tmp = new THREE.Vector3();
  function animate(e, dt, t) {
    // Frozen solid: the pose stays exactly where the ice caught it.
    if (e.state === 'frozen') return;
    if (rag) {
      rag.apply();
      return;
    }
    pose.rotation.set(0, 0, 0);
    if (rigged) pose.position.y = 0;
    const sdt = Math.min(dt, 1 / 30);
    spring.vx += (-SPRING_K * spring.x - SPRING_C * spring.vx) * sdt;
    spring.vy += (-SPRING_K * spring.y - SPRING_C * spring.vy) * sdt;
    spring.vz += (-SPRING_K * spring.z - SPRING_C * spring.vz) * sdt;
    spring.x += spring.vx * sdt;
    spring.y += spring.vy * sdt;
    spring.z += spring.vz * sdt;
    spring.head = Math.max(0, spring.head - dt * 3);
    const { raise, swing } = attackWeights(e);
    const attacking = e.state === 'windup' || e.state === 'strike' || e.state === 'recover';
    const mv = e.moveBlend;
    const stagger = e.state === 'stagger' ? Math.sin(Math.min(1, e.stateT / e.stateDur) * Math.PI) * (e.stumbling ? 1.8 : 1) : 0;
    const guard = e.state === 'guard' ? Math.min(1, e.stateT / 0.1) : 0;

    if (mixer) {
      drive(e, dt, t);
      if (e.state === 'dying') flop(e.stateT);
      // Attacks without a clip of their own still get a body lean; a guard
      // rears back behind it; a stumble lurches.
      pose.rotation.x = (attacking && !clips[e.attack?.clip || e.attack?.name] && !clips.attack ? -0.25 * raise + 0.4 * swing : 0) - 0.14 * guard - (e.stumbling ? 0.22 * stagger : 0);
    } else if (!rigged) {
      const sweep = /sweep|gust|lash|backhand/.test(e.attack?.clip || e.attack?.name || '');
      const sw = Math.sin(e.walkPhase);
      // A beast's whole body is above its hips: pitch it gently.
      const k = beast ? 0.45 : 1;
      U.uBend.value = k * (0.1 * mv + Math.sin(t * 1.6 + e.seed) * 0.025 - (sweep ? 0.15 : 0.4) * raise + (sweep ? 0.2 : 0.6) * swing - 0.5 * stagger);
      U.uTwist.value = sweep ? 0.55 * raise - 0.75 * swing : 0.12 * raise - 0.1 * swing;
      U.uSway.value = sw * 0.06 * mv;
      U.uStep.value = sw * 0.11 * H * mv;
      pose.position.y = Math.abs(sw) * 0.03 * H * mv;
      for (const b of bentAnchors) bendPoint(b.rest, b.anchor.position);
    }

    // A stumble reels: the body rocks from side to side, losing its footing,
    // and sags at the knees, settling as it finds its balance again.
    if (e.state === 'stagger' && e.stumbling) {
      const s = Math.min(1, e.stateT / Math.max(1e-3, e.stateDur));
      const wob = (1 - s) * (1 - s);
      pose.rotation.z += Math.sin(e.stateT * 11 + e.seed * 7) * 0.2 * wob;
      pose.rotation.x -= 0.12 * Math.sin(s * Math.PI);
      if (rigged) pose.position.y = -0.06 * H * Math.sin(s * Math.PI);
    }

    // The hit spring: a little on the whole body, the rest through the chest
    // and head of a rig.
    pose.rotation.x += spring.x * (mixer ? 0.35 : 1);
    pose.rotation.z = spring.z * (mixer ? 0.35 : 1);
    pose.rotation.y = spring.y * 0.5;
    // Speaking (`talk`, radians): the head tips back from the jaw, opening
    // the mouth (the Sleeper's jaw is one with his chest).
    const talk = e.talk || 0;
    if (mixer && (applied.size || talk || Math.abs(spring.x) + Math.abs(spring.y) + Math.abs(spring.z) > 1e-3)) {
      root.updateMatrixWorld(true);
      turnBone(chest, spring.x * 0.9, spring.y * 0.8, spring.z * 0.9);
      const hk = 0.5 + spring.head * 1.2;
      turnBone(head, spring.x * hk - talk, 0, spring.z * hk);
    }

    if (anchors.length) pose.updateMatrixWorld(true);
    for (const a of anchors) {
      if (a.bone) {
        a.bone.getWorldPosition(tmp);
        a.anchor.position.copy(pose.worldToLocal(tmp)).add(a.offset);
      } else bendPoint(a.rest, a.anchor.position);
    }
  }

  return {
    root,
    j,
    mats,
    hurtboxes,
    fire,
    animate,
    react,
    bones,
    meshes,
    height: H,
    // Long beasts reach further from their centre than they are tall.
    hitRadius: Math.max(H * 0.6, reach),
    ownDeath: !!clips.death && !!mixer,
    canRagdoll: rigged && !!mixer,
    startRagdoll,
    stepRagdoll,
    fallsForward: inst.rig?.death === 'forward',
    generated: true,
    rigged,
  };
}
