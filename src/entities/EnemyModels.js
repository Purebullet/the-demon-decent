import * as THREE from 'three';
import { skinTexture, emberVeinTexture } from '../world/Textures.js';
import { Hurtbox } from '../physics/Hitbox.js';
import { C, spawnFlame } from '../world/Particles.js';

// Procedural, rigged enemy meshes modelled on the reference art:
//   Husk Ghoul       - the gaunt grey crouching ghoul
//   Chain Fiend      - the purple, green-flame-maned demon with a chain sickle
//   Flame-Horned Brute / Gorvath - the spiked brown demon with burning horns
//   Azrakel          - the winged, torch-bearing archfiend with a burning heart
//
// Every model faces +Z, stands on y = 0, and returns its joints, body-part
// hurtboxes, fire emitters and an animate() that poses the rig from the
// enemy's AI state.

const unit = {};
function geo(key, make) {
  if (!unit[key]) unit[key] = make();
  return unit[key];
}
const SPHERE = () => geo('sphere', () => new THREE.SphereGeometry(1, 14, 10));
const LOWSPHERE = () => geo('lowsphere', () => new THREE.IcosahedronGeometry(1, 1));
const BOX = () => geo('box', () => new THREE.BoxGeometry(1, 1, 1));
const CONE = () => geo('cone', () => new THREE.ConeGeometry(1, 1, 7));
const CYL = () => geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 10));
const TORUS = () => geo('torus', () => new THREE.TorusGeometry(1, 0.28, 6, 12));
const capsule = (r, l) => geo(`cap${r}_${l}`, () => new THREE.CapsuleGeometry(r, l, 4, 10));

export function hornGeometry(length, radius, bendX, bendZ, droop = 0) {
  return geo(`horn${length}_${radius}_${bendX}_${bendZ}_${droop}`, () => {
    const g = new THREE.ConeGeometry(radius, length, 8, 10);
    g.translate(0, length / 2, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = p.getY(i) / length;
      p.setX(i, p.getX(i) + bendX * t * t);
      p.setZ(i, p.getZ(i) + bendZ * t * t);
      p.setY(i, p.getY(i) - droop * t * t * t);
    }
    g.computeVertexNormals();
    return g;
  });
}

function sickleGeometry() {
  return geo('sickle', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.absarc(0, 0, 0.42, Math.PI * 0.05, Math.PI * 0.95, false);
    s.absarc(0.03, -0.05, 0.36, Math.PI * 0.92, Math.PI * 0.1, true);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.015, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.006, bevelSegments: 1 });
    g.translate(0, 0, -0.008);
    return g;
  });
}

function wingGeometry() {
  return geo('wing', () => {
    // A bat wing: arm bone out to a wrist, fingers fanning down, membrane
    // triangles between the fingertips with a scalloped trailing edge.
    const wrist = new THREE.Vector3(1.5, 0.9, -0.2);
    const tips = [
      new THREE.Vector3(3.1, 1.3, -0.4),
      new THREE.Vector3(3.0, 0.1, -0.35),
      new THREE.Vector3(2.4, -0.8, -0.3),
      new THREE.Vector3(1.4, -1.25, -0.2),
      new THREE.Vector3(0.35, -0.9, -0.05),
    ];
    const pos = [];
    const add = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const origin = new THREE.Vector3(0, 0, 0);
    add(origin, wrist, tips[4]);
    for (let i = 0; i < tips.length - 1; i++) {
      const a = tips[i];
      const b = tips[i + 1];
      // Scallop: pull the edge midpoint toward the wrist.
      const mid = a.clone().add(b).multiplyScalar(0.5).lerp(wrist, 0.28);
      add(wrist, a, mid);
      add(wrist, mid, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    g.userData.wrist = wrist;
    g.userData.tips = tips;
    return g;
  });
}

function mesh(g, m, parent, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  const o = new THREE.Mesh(g, m);
  o.position.set(p[0], p[1], p[2]);
  o.rotation.set(r[0], r[1], r[2]);
  o.scale.set(s[0], s[1], s[2]);
  parent.add(o);
  return o;
}

function joint(parent, p = [0, 0, 0], r = [0, 0, 0]) {
  const g = new THREE.Group();
  g.position.set(p[0], p[1], p[2]);
  g.rotation.set(r[0], r[1], r[2]);
  parent.add(g);
  return g;
}

// Limb segment: capsule hanging down from a joint.
function limb(parent, r, len, m, scale = [1, 1, 1]) {
  return mesh(capsule(r, len), m, parent, [0, -len / 2 - r * 0.3, 0], [0, 0, 0], scale);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const hb = (obj, c, h, name = 'body', multiplier = 1) => new Hurtbox(obj, V(...c), V(...h), { name, multiplier });

// Attack pose weights from the AI state: raise (telegraph), swing (follow
// through). Each model maps them onto its own joints.
export function attackWeights(e) {
  const s = e.state;
  if (!e.attack || (s !== 'windup' && s !== 'strike' && s !== 'recover')) return { raise: 0, swing: 0 };
  const k = Math.min(1, e.stateT / Math.max(0.001, e.stateDur));
  if (s === 'windup') return { raise: easeOut(k), swing: 0 };
  if (s === 'strike') return { raise: 1 - k, swing: easeOut(k) };
  return { raise: 0, swing: 1 - easeIn(k) };
}
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeIn = (k) => k * k;

function makeMats(defs) {
  const mats = {};
  for (const [k, v] of Object.entries(defs)) mats[k] = new THREE.MeshStandardMaterial(v);
  return mats;
}

const FLAMES = {
  horn: (ps, p) => spawnFlame(ps, p, { size: 0.42, rise: 1.8, life: 0.55, spread: 0.12 }),
  hornBlue: (ps, p) => spawnFlame(ps, p, { core: C.fireBlue, edge: C.fireEdge, size: 0.24, rise: 1.3, life: 0.4 }),
  green: (ps, p) => spawnFlame(ps, p, { core: C.greenCore, edge: C.greenEdge, size: 0.34, rise: 1.6, life: 0.65, spread: 0.22 }),
  torch: (ps, p) => spawnFlame(ps, p, { size: 0.55, rise: 2.2, life: 0.7, spread: 0.25 }),
  heart: (ps, p) => spawnFlame(ps, p, { size: 0.4, rise: 1.0, life: 0.45, spread: 0.18 }),
};

// ---------------------------------------------------------------- Ghoul ---

export function buildGhoul() {
  const m = makeMats({
    skin: { map: skinTexture(7, [168, 172, 180], [78, 74, 96], 0.5), roughness: 0.75 },
    dark: { color: 0x160909, roughness: 0.6 },
    eye: { color: 0xffffff, emissive: 0xd8ecff, emissiveIntensity: 2.2 },
    bone: { color: 0xb9b0a0, roughness: 0.5 },
  });
  const root = new THREE.Group();
  const body = joint(root);
  const hips = joint(body, [0, 0.58, 0]);
  const torso = joint(hips, [0, 0.02, 0], [0.55, 0, 0]);
  mesh(capsule(0.16, 0.34), m.skin, torso, [0, 0.3, 0], [0, 0, 0], [1.15, 1, 0.8]);
  mesh(SPHERE(), m.skin, torso, [0, 0.12, 0.06], [0, 0, 0], [0.15, 0.12, 0.12]);
  for (let i = 0; i < 4; i++) mesh(SPHERE(), m.skin, torso, [0, 0.14 + i * 0.12, -0.13], [0, 0, 0], [0.035, 0.035, 0.035]);
  const neck = joint(torso, [0, 0.56, 0.03], [-0.75, 0, 0]);
  const head = joint(neck, [0, 0.1, 0.04]);
  mesh(SPHERE(), m.skin, head, [0, 0.03, 0], [0, 0, 0], [0.15, 0.17, 0.16]);
  mesh(BOX(), m.skin, head, [0, 0.07, 0.12], [0.2, 0, 0], [0.22, 0.04, 0.06]);
  for (const s of [-1, 1]) {
    mesh(CONE(), m.skin, head, [s * 0.16, 0.07, -0.02], [0, 0, -s * 1.2], [0.05, 0.24, 0.025]);
    mesh(SPHERE(), m.eye, head, [s * 0.055, 0.03, 0.14], [0, 0, 0], [0.022, 0.02, 0.012]);
  }
  mesh(BOX(), m.dark, head, [0, -0.075, 0.125], [0, 0, 0], [0.1, 0.06, 0.05]);
  for (let i = -2; i <= 2; i++) mesh(CONE(), m.bone, head, [i * 0.018, -0.055, 0.15], [Math.PI, 0, 0], [0.008, 0.03, 0.008]);

  const j = { body, hips, torso, neck, head };
  for (const [s, side] of [[-1, 'L'], [1, 'R']]) {
    const sh = joint(torso, [s * 0.22, 0.48, 0.03], [-0.5, 0, s * 0.15]);
    limb(sh, 0.045, 0.26, m.skin);
    const el = joint(sh, [0, -0.33, 0], [-0.7, 0, 0]);
    mesh(SPHERE(), m.skin, el, [0, 0, 0], [0, 0, 0], [0.05, 0.05, 0.05]);
    limb(el, 0.04, 0.26, m.skin);
    const hand = joint(el, [0, -0.32, 0]);
    mesh(BOX(), m.skin, hand, [0, -0.04, 0], [0, 0, 0], [0.07, 0.08, 0.03]);
    for (let k = 0; k < 4; k++) mesh(CONE(), m.dark, hand, [(k - 1.5) * 0.02, -0.14, 0.01], [Math.PI, 0, 0], [0.012, 0.12, 0.012]);
    const hip = joint(hips, [s * 0.12, 0, 0], [-1.1, 0, s * -0.12]);
    limb(hip, 0.06, 0.28, m.skin);
    const knee = joint(hip, [0, -0.36, 0], [1.75, 0, 0]);
    mesh(SPHERE(), m.skin, knee, [0, 0, 0], [0, 0, 0], [0.065, 0.065, 0.065]);
    limb(knee, 0.05, 0.28, m.skin);
    const ankle = joint(knee, [0, -0.35, 0], [-0.65, 0, 0]);
    mesh(BOX(), m.skin, ankle, [0, -0.02, 0.07], [0, 0, 0], [0.09, 0.04, 0.22]);
    Object.assign(j, { [`sh${side}`]: sh, [`el${side}`]: el, [`hip${side}`]: hip, [`knee${side}`]: knee });
  }

  const hurtboxes = [
    hb(head, [0, 0.03, 0.02], [0.15, 0.18, 0.17], 'head', 1.6),
    hb(torso, [0, 0.3, 0], [0.22, 0.34, 0.18], 'torso', 1),
    hb(hips, [0, -0.18, 0.12], [0.22, 0.26, 0.24], 'legs', 0.85),
    hb(j.shL, [0, -0.2, 0], [0.07, 0.22, 0.07], 'arm', 0.8),
    hb(j.shR, [0, -0.2, 0], [0.07, 0.22, 0.07], 'arm', 0.8),
  ];

  function animate(e, dt, t) {
    const mv = e.moveBlend;
    const sw = Math.sin(e.walkPhase);
    const cw = Math.cos(e.walkPhase);
    const { raise, swing } = attackWeights(e);
    const breath = Math.sin(t * 3 + e.seed) * 0.04;
    body.position.y = Math.abs(sw) * 0.06 * mv;
    torso.rotation.x = 0.55 + 0.2 * mv + breath - 0.35 * raise + 0.45 * swing;
    neck.rotation.x = -0.75 - 0.2 * mv + 0.25 * raise - 0.3 * swing;
    head.rotation.z = Math.sin(t * 1.7 + e.seed) * 0.12;
    j.hipL.rotation.x = -1.1 + sw * 0.6 * mv;
    j.hipR.rotation.x = -1.1 - sw * 0.6 * mv;
    j.kneeL.rotation.x = 1.75 + Math.max(0, cw) * 0.5 * mv;
    j.kneeR.rotation.x = 1.75 + Math.max(0, -cw) * 0.5 * mv;
    // Arms reach forward past the hunched torso.
    const armR = -1.05 + sw * 0.5 * mv;
    const armL = -1.05 - sw * 0.5 * mv;
    // Both claws come up over the head, then rake down.
    j.shR.rotation.x = armR + raise * (-2.7 - armR) + swing * (-0.1 - armR);
    j.shL.rotation.x = armL + raise * (-2.4 - armL) + swing * (0.1 - armL);
    j.elR.rotation.x = -0.7 + raise * 0.5;
    j.elL.rotation.x = -0.7 + raise * 0.5;
    if (e.state === 'stagger') torso.rotation.x -= Math.sin(Math.min(1, e.stateT / e.stateDur) * Math.PI) * 0.7;
  }

  return { root, j, mats: Object.values(m), hurtboxes, fire: [], animate, height: 1.4, hitRadius: 0.9 };
}

// ---------------------------------------------------------- Chain Fiend ---

export function buildFiend() {
  const m = makeMats({
    skin: { map: skinTexture(19, [104, 76, 162], [58, 40, 112], 0.5), roughness: 0.7 },
    belly: { map: skinTexture(23, [176, 160, 118], [130, 110, 80], 0.3), roughness: 0.75 },
    bone: { color: 0xd8c9a0, roughness: 0.55 },
    cloth: { color: 0x3e2218, roughness: 0.95, side: THREE.DoubleSide },
    iron: { color: 0x2c2c32, metalness: 0.85, roughness: 0.4 },
    blade: { color: 0x3a3f44, metalness: 0.9, roughness: 0.25 },
    eye: { color: 0xffffff, emissive: 0x55ffe0, emissiveIntensity: 2.5 },
    flame: { color: 0x40ffa0, emissive: 0x20ff80, emissiveIntensity: 1.6, transparent: true, opacity: 0.55, depthWrite: false },
  });
  const root = new THREE.Group();
  const body = joint(root);
  const hips = joint(body, [0, 0.98, 0]);
  const torso = joint(hips, [0, 0.05, 0], [0.25, 0, 0]);
  mesh(SPHERE(), m.skin, torso, [0, 0.5, 0], [0, 0, 0], [0.36, 0.3, 0.26]);
  mesh(SPHERE(), m.belly, torso, [0, 0.47, 0.08], [0, 0, 0], [0.28, 0.24, 0.2]);
  mesh(capsule(0.2, 0.22), m.belly, torso, [0, 0.16, 0.03], [0, 0, 0], [1, 1, 0.8]);
  // Bone spikes along the back and shoulders.
  for (let i = 0; i < 5; i++) mesh(CONE(), m.bone, torso, [0, 0.25 + i * 0.12, -0.24], [-0.9, 0, 0], [0.035, 0.18, 0.035]);
  const neck = joint(torso, [0, 0.78, 0.06], [-0.25, 0, 0]);
  const head = joint(neck, [0, 0.12, 0.03]);
  mesh(SPHERE(), m.skin, head, [0, 0.02, 0.02], [0, 0, 0], [0.17, 0.16, 0.2]);
  mesh(BOX(), m.skin, head, [0, -0.07, 0.15], [0.15, 0, 0], [0.2, 0.09, 0.14]);
  mesh(BOX(), m.skin, head, [0, 0.08, 0.15], [0.35, 0, 0], [0.26, 0.05, 0.08]);
  for (let i = -2; i <= 2; i++) mesh(CONE(), m.bone, head, [i * 0.035, -0.12, 0.21], [Math.PI, 0, 0], [0.012, 0.05, 0.012]);
  const fire = [];
  for (const s of [-1, 1]) {
    mesh(SPHERE(), m.eye, head, [s * 0.07, 0.04, 0.19], [0, 0, 0], [0.025, 0.018, 0.015]);
    // Two pairs of swept-back horns.
    mesh(hornGeometry(0.55, 0.05, s * 0.08, -0.35), m.bone, head, [s * 0.09, 0.12, 0.02], [-0.4, 0, -s * 0.25]);
    mesh(hornGeometry(0.35, 0.035, s * 0.15, -0.15), m.bone, head, [s * 0.15, 0.05, 0], [-0.2, 0, -s * 0.9]);
  }
  // Green flame mane: translucent tongues + live particles.
  const mane = joint(head, [0, 0.1, -0.12]);
  const tongues = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 5 - 0.5) * 1.6;
    tongues.push(mesh(CONE(), m.flame, mane, [Math.sin(a) * 0.14, 0.18, -0.05 - Math.cos(a) * 0.05], [-0.5, 0, -a * 0.6], [0.08, 0.5, 0.06]));
    fire.push({ anchor: mane, offset: V(Math.sin(a) * 0.15, 0.2, -0.05), spawn: FLAMES.green, rate: 10 });
  }
  // Chains slung across the chest.
  for (let i = 0; i < 7; i++) {
    mesh(TORUS(), m.iron, torso, [-0.25 + i * 0.085, 0.62 - i * 0.07, 0.25], [0, (i % 2) * Math.PI / 2, 0.8], [0.035, 0.035, 0.035]);
  }

  const j = { body, hips, torso, neck, head, mane, tongues };
  for (const [s, side] of [[-1, 'L'], [1, 'R']]) {
    mesh(SPHERE(), m.skin, torso, [s * 0.36, 0.62, 0], [0, 0, 0], [0.16, 0.15, 0.15]);
    mesh(CONE(), m.bone, torso, [s * 0.42, 0.74, -0.05], [-0.3, 0, -s * 0.5], [0.04, 0.22, 0.04]);
    const sh = joint(torso, [s * 0.4, 0.6, 0], [-0.2, 0, s * 0.18]);
    limb(sh, 0.1, 0.24, m.skin);
    const el = joint(sh, [0, -0.38, 0], [-0.5, 0, 0]);
    limb(el, 0.085, 0.24, m.skin);
    mesh(TORUS(), m.iron, el, [0, -0.25, 0], [Math.PI / 2, 0, 0], [0.1, 0.1, 0.1]);
    mesh(TORUS(), m.iron, el, [0, -0.3, 0], [Math.PI / 2, 0, 0.3], [0.1, 0.1, 0.1]);
    const hand = joint(el, [0, -0.38, 0]);
    mesh(SPHERE(), m.skin, hand, [0, -0.03, 0], [0, 0, 0], [0.09, 0.1, 0.08]);
    for (let k = 0; k < 4; k++) mesh(CONE(), m.bone, hand, [(k - 1.5) * 0.04, -0.14, 0.05], [Math.PI * 0.8, 0, 0], [0.015, 0.1, 0.015]);
    const hip = joint(hips, [s * 0.16, 0, 0], [-0.35, 0, s * -0.08]);
    limb(hip, 0.12, 0.26, m.skin);
    const knee = joint(hip, [0, -0.42, 0], [0.9, 0, 0]);
    limb(knee, 0.09, 0.28, m.skin);
    const ankle = joint(knee, [0, -0.42, 0], [-0.55, 0, 0]);
    mesh(BOX(), m.skin, ankle, [0, -0.03, 0.08], [0, 0, 0], [0.13, 0.07, 0.26]);
    for (let k = 0; k < 3; k++) mesh(CONE(), m.bone, ankle, [(k - 1) * 0.045, -0.04, 0.23], [Math.PI / 2, 0, 0], [0.02, 0.09, 0.02]);
    Object.assign(j, { [`sh${side}`]: sh, [`el${side}`]: el, [`hand${side}`]: hand, [`hip${side}`]: hip, [`knee${side}`]: knee });
  }
  // Loincloth and belt with chain links.
  mesh(BOX(), m.cloth, hips, [0, -0.32, 0.17], [0.05, 0, 0], [0.4, 0.6, 0.02]);
  mesh(BOX(), m.cloth, hips, [0, -0.28, -0.15], [-0.05, 0, 0], [0.42, 0.5, 0.02]);
  mesh(TORUS(), m.iron, hips, [0, 0.02, 0], [Math.PI / 2, 0, 0], [0.27, 0.22, 0.25]);
  for (const s of [-1, 1]) mesh(SPHERE(), m.bone, hips, [s * 0.12, -0.02, 0.2], [0, 0, 0], [0.05, 0.06, 0.05]);

  // Kusarigama: chain from the right fist to a crescent sickle.
  const chain = joint(j.handR, [0, -0.08, 0.02]);
  const links = [];
  for (let i = 0; i < 8; i++) links.push(mesh(TORUS(), m.iron, chain, [0, -0.06 - i * 0.075, 0], [0, (i % 2) * Math.PI / 2, 0], [0.035, 0.05, 0.035]));
  const sickle = joint(chain, [0, -0.66, 0]);
  mesh(CYL(), m.cloth, sickle, [0, -0.12, 0], [0, 0, 0], [0.025, 0.26, 0.025]);
  mesh(sickleGeometry(), m.blade, sickle, [0, -0.24, 0], [0, Math.PI / 2, Math.PI * 0.55]);
  Object.assign(j, { chain, sickle, links });

  const hurtboxes = [
    hb(head, [0, 0.03, 0.05], [0.19, 0.2, 0.23], 'head', 1.5),
    hb(torso, [0, 0.45, 0], [0.4, 0.42, 0.28], 'torso', 1),
    hb(hips, [0, -0.35, 0.05], [0.3, 0.42, 0.25], 'legs', 0.85),
    hb(j.shL, [0, -0.25, 0], [0.12, 0.3, 0.12], 'arm', 0.8),
    hb(j.shR, [0, -0.25, 0], [0.12, 0.3, 0.12], 'arm', 0.8),
  ];

  function animate(e, dt, t) {
    const mv = e.moveBlend;
    const sw = Math.sin(e.walkPhase);
    const { raise, swing } = attackWeights(e);
    const lash = e.attack?.name === 'lash';
    body.position.y = Math.abs(sw) * 0.05 * mv;
    torso.rotation.x = 0.25 + 0.15 * mv - 0.2 * raise + 0.3 * swing + Math.sin(t * 2 + e.seed) * 0.03;
    torso.rotation.y = lash ? 0 : raise * 0.6 - swing * 0.8;
    j.hipL.rotation.x = -0.35 + sw * 0.55 * mv;
    j.hipR.rotation.x = -0.35 - sw * 0.55 * mv;
    j.kneeL.rotation.x = 0.9 + Math.max(0, Math.cos(e.walkPhase)) * 0.5 * mv;
    j.kneeR.rotation.x = 0.9 + Math.max(0, -Math.cos(e.walkPhase)) * 0.5 * mv;
    j.shL.rotation.x = -0.4 - sw * 0.4 * mv;
    // Right arm whirls the sickle overhead, then whips it out.
    const restR = -0.4 + sw * 0.4 * mv;
    j.shR.rotation.x = restR + raise * (-2.9 - restR) + swing * ((lash ? -1.5 : -1.2) - restR);
    j.shR.rotation.z = 0.18 + raise * 0.3 - swing * (lash ? 0 : 0.9);
    j.elR.rotation.x = -0.5 + raise * 0.3 + swing * 0.45;
    // Chain spins during the windup and extends on the strike.
    j.chain.rotation.y += dt * (2 + raise * 22);
    j.chain.rotation.x = raise * 1.2 + swing * 1.45;
    const extend = 1 + swing * (lash ? 4.5 : 3.2);
    j.chain.scale.set(1, extend, 1);
    j.sickle.scale.set(1, 1 / extend, 1);
    j.sickle.rotation.z = Math.sin(t * 2.2 + e.seed) * 0.2;
    for (const [i, tg] of j.tongues.entries()) tg.scale.y = 0.45 + Math.sin(t * 9 + i * 1.7) * 0.12;
    if (e.state === 'stagger') torso.rotation.x -= Math.sin(Math.min(1, e.stateT / e.stateDur) * Math.PI) * 0.55;
  }

  return { root, j, mats: Object.values(m), hurtboxes, fire, animate, height: 2.1, hitRadius: 1.2 };
}

// ------------------------------------------------- Flame-Horned Brute ---

export function buildBrute({ boss = false } = {}) {
  const m = makeMats({
    skin: {
      map: skinTexture(31, [104, 76, 60], [58, 38, 30], 0.5),
      emissiveMap: emberVeinTexture(5, [255, 80, 15], boss ? 12 : 18),
      emissive: 0xffffff,
      emissiveIntensity: boss ? 1.1 : 0.7,
      roughness: 0.8,
    },
    spike: { color: 0x2a1f19, roughness: 0.55 },
    leather: { color: 0x221c1a, roughness: 0.9, side: THREE.DoubleSide },
    iron: { color: 0x2a2a2e, metalness: 0.85, roughness: 0.45 },
    bone: { color: 0x3a2e26, roughness: 0.7 },
    eye: { color: 0xff3300, emissive: 0xff2200, emissiveIntensity: 3 },
    teeth: { color: 0xcfc3a8, roughness: 0.5 },
    heart: { color: 0xffaa33, emissive: 0xff5500, emissiveIntensity: 2.5 },
  });
  const root = new THREE.Group();
  const body = joint(root);
  const hips = joint(body, [0, 1.05, 0]);
  const torso = joint(hips, [0, 0.05, 0], [0.4, 0, 0]);
  mesh(SPHERE(), m.skin, torso, [0, 0.55, 0], [0, 0, 0], [0.5, 0.38, 0.34]);
  mesh(capsule(0.28, 0.25), m.skin, torso, [0, 0.18, 0.02], [0, 0, 0], [1.05, 1, 0.85]);
  const fire = [];
  if (boss) {
    // Gorvath's chest burns through its skin.
    mesh(SPHERE(), m.heart, torso, [0.05, 0.6, 0.3], [0, 0, 0], [0.09, 0.09, 0.05]);
    fire.push({ anchor: torso, offset: V(0.05, 0.62, 0.33), spawn: FLAMES.heart, rate: 14 });
  }
  // Spiked hide on shoulders and back.
  for (let i = 0; i < (boss ? 26 : 16); i++) {
    const a = (i / (boss ? 26 : 16)) * Math.PI * 2;
    const side = Math.cos(a) > 0 ? 1 : -1;
    mesh(CONE(), m.spike, torso, [side * (0.3 + Math.abs(Math.cos(a)) * 0.18), 0.6 + Math.sin(a) * 0.18, -0.1 - Math.abs(Math.sin(a * 2)) * 0.15], [-0.6 + Math.sin(a) * 0.4, 0, -side * (0.6 + Math.cos(a * 3) * 0.3)], [0.05, 0.28, 0.05]);
  }
  const neck = joint(torso, [0, 0.9, 0.12], [-0.4, 0, 0]);
  const head = joint(neck, [0, 0.1, 0.04]);
  mesh(SPHERE(), m.skin, head, [0, 0.04, 0], [0, 0, 0], [0.2, 0.22, 0.21]);
  mesh(BOX(), m.bone, head, [0, -0.1, 0.14], [0.1, 0, 0], [0.22, 0.08, 0.12]);
  for (let i = -3; i <= 3; i++) {
    mesh(CONE(), m.teeth, head, [i * 0.028, -0.06, 0.2], [Math.PI, 0, 0], [0.012, 0.05, 0.012]);
    mesh(CONE(), m.teeth, head, [i * 0.028, -0.13, 0.19], [0, 0, 0], [0.011, 0.04, 0.011]);
  }
  for (const s of [-1, 1]) {
    mesh(SPHERE(), m.eye, head, [s * 0.075, 0.06, 0.18], [0, 0, 0], [0.03, 0.022, 0.015]);
    const horn = joint(head, [s * 0.14, 0.14, 0], [-0.1, 0, -s * 0.9]);
    mesh(hornGeometry(0.75, 0.08, -s * 0.05, 0.05, -0.25), m.bone, horn);
    // Fire runs the length of each horn: blue at the root, orange above.
    fire.push({ anchor: horn, offset: V(0, 0.12, 0), spawn: FLAMES.hornBlue, rate: boss ? 26 : 16 });
    fire.push({ anchor: horn, offset: V(-s * 0.02, 0.4, 0.02), spawn: FLAMES.horn, rate: boss ? 36 : 24 });
    fire.push({ anchor: horn, offset: V(-s * 0.05, 0.7, 0.05), spawn: FLAMES.horn, rate: boss ? 36 : 24 });
  }

  const j = { body, hips, torso, neck, head };
  for (const [s, side] of [[-1, 'L'], [1, 'R']]) {
    mesh(SPHERE(), m.skin, torso, [s * 0.48, 0.7, 0], [0, 0, 0], [0.24, 0.22, 0.22]);
    const sh = joint(torso, [s * 0.52, 0.68, 0], [-0.3, 0, s * 0.3]);
    limb(sh, 0.14, 0.32, m.skin);
    const el = joint(sh, [0, -0.52, 0], [-0.6, 0, 0]);
    limb(el, 0.12, 0.3, m.skin);
    for (let k = 0; k < 4; k++) mesh(TORUS(), m.iron, el, [0, -0.1 - k * 0.07, 0], [Math.PI / 2, 0, k * 0.4], [0.13, 0.13, 0.13]);
    const hand = joint(el, [0, -0.48, 0]);
    mesh(SPHERE(), m.skin, hand, [0, -0.04, 0], [0, 0, 0], [0.12, 0.13, 0.1]);
    for (let k = 0; k < 4; k++) mesh(CONE(), m.spike, hand, [(k - 1.5) * 0.05, -0.18, 0.06], [Math.PI * 0.8, 0, 0], [0.02, 0.13, 0.02]);
    const hip = joint(hips, [s * 0.22, 0, 0], [-0.45, 0, s * -0.12]);
    limb(hip, 0.16, 0.3, m.skin);
    const knee = joint(hip, [0, -0.5, 0], [1.0, 0, 0]);
    limb(knee, 0.12, 0.3, m.skin);
    const ankle = joint(knee, [0, -0.48, 0], [-0.55, 0, 0]);
    mesh(BOX(), m.skin, ankle, [0, -0.04, 0.1], [0, 0, 0], [0.18, 0.09, 0.32]);
    for (let k = 0; k < 3; k++) mesh(CONE(), m.spike, ankle, [(k - 1) * 0.06, -0.05, 0.3], [Math.PI / 2, 0, 0], [0.025, 0.11, 0.025]);
    Object.assign(j, { [`sh${side}`]: sh, [`el${side}`]: el, [`hand${side}`]: hand, [`hip${side}`]: hip, [`knee${side}`]: knee });
  }
  // Leather skirt, chain belt and the great iron ring.
  mesh(geo('skirt', () => new THREE.CylinderGeometry(0.42, 0.58, 0.75, 12, 1, true)), m.leather, hips, [0, -0.32, 0]);
  mesh(TORUS(), m.iron, hips, [0, 0.02, 0], [Math.PI / 2, 0, 0], [0.42, 0.38, 0.3]);
  mesh(TORUS(), m.iron, hips, [0, -0.25, 0.42], [0, 0, 0], [0.15, 0.15, 0.15]);
  for (let k = 0; k < 6; k++) mesh(TORUS(), m.iron, hips, [0.0, -0.45 - k * 0.07, 0.43], [0, (k % 2) * Math.PI / 2, 0], [0.03, 0.045, 0.03]);

  // Bone club studded with spikes, in the right fist.
  const club = joint(j.handR, [0, -0.08, 0.02], [Math.PI / 2 + 0.2, 0, 0]);
  mesh(geo('club', () => new THREE.CylinderGeometry(0.07, 0.04, 1.3, 8)), m.bone, club, [0, 0.55, 0]);
  for (let k = 0; k < 8; k++) {
    const a = k * 2.1;
    mesh(CONE(), m.spike, club, [Math.cos(a) * 0.07, 0.75 + (k % 4) * 0.12, Math.sin(a) * 0.07], [Math.sin(a) * 1.4, 0, -Math.cos(a) * 1.4], [0.025, 0.14, 0.025]);
  }
  j.club = club;

  const hurtboxes = [
    hb(head, [0, 0.05, 0.03], [0.24, 0.26, 0.26], 'head', 1.5),
    hb(torso, [0, 0.45, 0], [0.55, 0.55, 0.36], 'torso', 1),
    hb(hips, [0, -0.45, 0], [0.42, 0.55, 0.32], 'legs', 0.85),
    hb(j.shL, [0, -0.35, 0], [0.16, 0.4, 0.16], 'arm', 0.75),
    hb(j.shR, [0, -0.35, 0], [0.16, 0.4, 0.16], 'arm', 0.75),
  ];

  function animate(e, dt, t) {
    const mv = e.moveBlend;
    const sw = Math.sin(e.walkPhase);
    const { raise, swing } = attackWeights(e);
    const name = e.attack?.name;
    const sweep = name === 'sweep' || name === 'charge';
    body.position.y = Math.abs(sw) * 0.05 * mv;
    torso.rotation.x = 0.4 + 0.1 * mv - (sweep ? 0.1 : 0.5) * raise + (sweep ? 0.2 : 0.7) * swing + Math.sin(t * 1.5 + e.seed) * 0.03;
    torso.rotation.y = sweep ? raise * 0.9 - swing * 1.1 : 0;
    neck.rotation.x = -0.4 + 0.3 * raise - 0.3 * swing;
    j.hipL.rotation.x = -0.45 + sw * 0.5 * mv;
    j.hipR.rotation.x = -0.45 - sw * 0.5 * mv;
    j.kneeL.rotation.x = 1.0 + Math.max(0, Math.cos(e.walkPhase)) * 0.45 * mv;
    j.kneeR.rotation.x = 1.0 + Math.max(0, -Math.cos(e.walkPhase)) * 0.45 * mv;
    const restR = -0.55 + sw * 0.35 * mv;
    if (sweep) {
      j.shR.rotation.x = restR + raise * (-1.4 - restR) + swing * (-1.3 - restR);
      j.shR.rotation.z = 0.3 + raise * 1.1 - swing * 1.6;
    } else {
      // Overhead slam: club raised behind the head, then driven down.
      j.shR.rotation.x = restR + raise * (-3.5 - restR) + swing * (-0.9 - restR);
      j.shR.rotation.z = 0.3;
    }
    j.shL.rotation.x = -0.55 - sw * 0.35 * mv + raise * -1.2 + swing * 0.6;
    j.elR.rotation.x = -0.6 + raise * 0.4;
    if (e.state === 'stagger') torso.rotation.x -= Math.sin(Math.min(1, e.stateT / e.stateDur) * Math.PI) * 0.5;
  }

  return { root, j, mats: Object.values(m), hurtboxes, fire, animate, height: 2.5, hitRadius: 1.6 };
}

// --------------------------------------------------- Azrakel (final) ---

export function buildArchfiend() {
  const m = makeMats({
    skin: {
      map: skinTexture(41, [120, 92, 76], [70, 50, 44], 0.5),
      emissiveMap: emberVeinTexture(9, [255, 70, 10], 16),
      emissive: 0xffffff,
      emissiveIntensity: 0.6,
      roughness: 0.8,
    },
    wing: { color: 0x3b2a22, roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.94 },
    wingBone: { color: 0x2a1f1a, roughness: 0.6 },
    horn: { color: 0x2e241e, roughness: 0.55 },
    cloth: { color: 0x1d1a1a, roughness: 0.95, side: THREE.DoubleSide },
    iron: { color: 0x2c2c30, metalness: 0.85, roughness: 0.4 },
    wood: { color: 0x2a1c12, roughness: 0.85 },
    eye: { color: 0xff4400, emissive: 0xff2200, emissiveIntensity: 3 },
    teeth: { color: 0xd6cab0, roughness: 0.5 },
    heart: { color: 0xffcc66, emissive: 0xff6a00, emissiveIntensity: 4 },
  });
  const root = new THREE.Group();
  const body = joint(root);
  const hips = joint(body, [0, 1.6, 0]);
  const torso = joint(hips, [0, 0.05, 0], [0.12, 0, 0]);
  mesh(capsule(0.3, 0.55), m.skin, torso, [0, 0.55, 0], [0, 0, 0], [1.2, 1, 0.75]);
  mesh(SPHERE(), m.skin, torso, [0, 0.92, 0], [0, 0, 0], [0.5, 0.3, 0.3]);
  // Ribs.
  for (let i = 0; i < 4; i++) mesh(TORUS(), m.skin, torso, [0, 0.45 + i * 0.12, 0.02], [Math.PI / 2, 0, 0], [0.3, 0.22, 0.1]);
  const heart = mesh(SPHERE(), m.heart, torso, [0.08, 0.82, 0.24], [0, 0, 0], [0.11, 0.11, 0.07]);
  const fire = [{ anchor: torso, offset: V(0.08, 0.84, 0.3), spawn: FLAMES.heart, rate: 26 }];
  const neck = joint(torso, [0, 1.15, 0.05], [-0.15, 0, 0]);
  const head = joint(neck, [0, 0.14, 0.03]);
  mesh(SPHERE(), m.skin, head, [0, 0.04, 0], [0, 0, 0], [0.2, 0.24, 0.21]);
  mesh(BOX(), m.skin, head, [0, -0.12, 0.12], [0.1, 0, 0], [0.2, 0.09, 0.13]);
  for (let i = -3; i <= 3; i++) mesh(CONE(), m.teeth, head, [i * 0.027, -0.1, 0.19], [Math.PI, 0, 0], [0.011, 0.05, 0.011]);
  for (const s of [-1, 1]) {
    mesh(SPHERE(), m.eye, head, [s * 0.075, 0.07, 0.18], [0, 0, 0], [0.028, 0.02, 0.014]);
    // Great sweeping horns: out, up, and hooking back in.
    const horn = joint(head, [s * 0.15, 0.17, -0.02], [-0.25, 0, -s * 1.15]);
    mesh(hornGeometry(1.25, 0.085, -s * 0.0, 0.0, -0.75), m.horn, horn, [0, 0, 0], [0, 0, 0]);
  }
  // Wings.
  const wingG = wingGeometry();
  const j = { body, hips, torso, neck, head, heart };
  for (const [s, side] of [[-1, 'L'], [1, 'R']]) {
    const w = joint(torso, [s * 0.2, 0.95, -0.25], [0, s * 0.35, 0]);
    const wm = mesh(wingG, m.wing, w);
    wm.scale.set(s * 1.25, 1.25, 1.25);
    // Finger bones along the membrane edges.
    const wrist = wingG.userData.wrist.clone().multiply(V(s * 1.25, 1.25, 1.25));
    const bone = (a, b, r) => {
      const len = a.distanceTo(b);
      const o = mesh(CYL(), m.wingBone, w, [0, 0, 0], [0, 0, 0], [r, len, r]);
      o.position.copy(a).add(b).multiplyScalar(0.5);
      o.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
    };
    bone(V(0, 0, 0), wrist, 0.05);
    for (const tip of wingG.userData.tips) bone(wrist, tip.clone().multiply(V(s * 1.25, 1.25, 1.25)), 0.025);
    mesh(CONE(), m.wingBone, w, [wrist.x, wrist.y + 0.12, wrist.z], [0, 0, -s * 0.3], [0.04, 0.25, 0.04]);
    j[`wing${side}`] = w;

    mesh(SPHERE(), m.skin, torso, [s * 0.46, 1.0, 0], [0, 0, 0], [0.18, 0.16, 0.16]);
    const sh = joint(torso, [s * 0.5, 0.98, 0], [-0.2, 0, s * 0.25]);
    limb(sh, 0.1, 0.5, m.skin);
    const el = joint(sh, [0, -0.66, 0], [-0.5, 0, 0]);
    limb(el, 0.085, 0.5, m.skin);
    for (let k = 0; k < 3; k++) mesh(TORUS(), m.iron, el, [0, -0.45 - k * 0.06, 0], [Math.PI / 2, 0, 0], [0.1, 0.1, 0.1]);
    const hand = joint(el, [0, -0.64, 0]);
    mesh(SPHERE(), m.skin, hand, [0, -0.04, 0], [0, 0, 0], [0.09, 0.11, 0.08]);
    for (let k = 0; k < 4; k++) mesh(CONE(), m.horn, hand, [(k - 1.5) * 0.04, -0.17, 0.04], [Math.PI * 0.85, 0, 0], [0.016, 0.13, 0.016]);
    const hip = joint(hips, [s * 0.2, 0, 0], [-0.1, 0, s * -0.06]);
    limb(hip, 0.13, 0.5, m.skin);
    const knee = joint(hip, [0, -0.72, 0], [0.4, 0, 0]);
    limb(knee, 0.1, 0.5, m.skin);
    const ankle = joint(knee, [0, -0.7, 0], [-0.3, 0, 0]);
    mesh(BOX(), m.skin, ankle, [0, -0.05, 0.1], [0, 0, 0], [0.16, 0.08, 0.32]);
    Object.assign(j, { [`sh${side}`]: sh, [`el${side}`]: el, [`hand${side}`]: hand, [`hip${side}`]: hip, [`knee${side}`]: knee });
  }
  // Ragged skirt and hanging chains.
  const skirtG = geo('raggedSkirt', () => {
    const g = new THREE.CylinderGeometry(0.42, 0.7, 1.3, 18, 3, true);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < -0.6) p.setY(i, p.getY(i) - ((i * 7919) % 5) * 0.08);
    }
    g.computeVertexNormals();
    return g;
  });
  mesh(skirtG, m.cloth, hips, [0, -0.55, 0]);
  mesh(TORUS(), m.iron, hips, [0, 0.05, 0], [Math.PI / 2, 0, 0], [0.42, 0.36, 0.3]);
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 6; k++) mesh(TORUS(), m.iron, hips, [-0.25 + c * 0.25, -0.1 - k * 0.08, 0.4], [0, (k % 2) * Math.PI / 2, 0], [0.035, 0.05, 0.035]);
  }

  // Torch staff in the right hand.
  const staff = joint(j.handR, [0, -0.1, 0.03], [Math.PI / 2 - 0.15, 0, 0]);
  mesh(geo('staff', () => new THREE.CylinderGeometry(0.04, 0.05, 3.0, 8)), m.wood, staff, [0, 0.6, 0]);
  for (let k = 0; k < 3; k++) mesh(TORUS(), m.iron, staff, [0, 1.85 + k * 0.08, 0], [Math.PI / 2, 0, 0], [0.07, 0.07, 0.07]);
  const staffTip = joint(staff, [0, 2.15, 0]);
  mesh(LOWSPHERE(), m.wood, staffTip, [0, -0.05, 0], [0, 0, 0], [0.12, 0.16, 0.12]);
  fire.push({ anchor: staffTip, offset: V(0, 0.1, 0), spawn: FLAMES.torch, rate: 40 });
  Object.assign(j, { staff, staffTip });

  const hurtboxes = [
    hb(head, [0, 0.05, 0.03], [0.24, 0.28, 0.25], 'head', 1.5),
    hb(torso, [0.08, 0.82, 0.22], [0.16, 0.16, 0.14], 'heart', 2.0),
    hb(torso, [0, 0.6, 0], [0.5, 0.65, 0.32], 'torso', 1),
    hb(hips, [0, -0.7, 0], [0.5, 0.9, 0.4], 'legs', 0.85),
    hb(j.shL, [0, -0.5, 0], [0.14, 0.6, 0.14], 'arm', 0.75),
    hb(j.shR, [0, -0.5, 0], [0.14, 0.6, 0.14], 'arm', 0.75),
  ];

  function animate(e, dt, t) {
    const mv = e.moveBlend;
    const sw = Math.sin(e.walkPhase);
    const { raise, swing } = attackWeights(e);
    const name = e.attack?.name;
    const flap = e.flap ?? 0;
    body.position.y = Math.abs(sw) * 0.06 * mv;
    torso.rotation.x = 0.12 + 0.08 * mv + Math.sin(t * 1.2) * 0.03;
    torso.rotation.y = 0;
    j.hipL.rotation.x = -0.1 + sw * 0.45 * mv;
    j.hipR.rotation.x = -0.1 - sw * 0.45 * mv;
    j.kneeL.rotation.x = 0.4 + Math.max(0, Math.cos(e.walkPhase)) * 0.5 * mv;
    j.kneeR.rotation.x = 0.4 + Math.max(0, -Math.cos(e.walkPhase)) * 0.5 * mv;
    // Wings breathe slowly and beat hard when Azrakel leaps or gusts.
    const beat = Math.sin(t * (1.4 + flap * 9)) * (0.15 + flap * 0.7);
    j.wingL.rotation.y = -0.35 - beat;
    j.wingR.rotation.y = 0.35 + beat;
    j.wingL.rotation.z = beat * 0.3;
    j.wingR.rotation.z = -beat * 0.3;
    const restR = -0.25 + sw * 0.25 * mv;
    if (name === 'sweep') {
      torso.rotation.y = raise * 0.8 - swing * 1.0;
      j.shR.rotation.x = restR + raise * (-1.5 - restR) + swing * (-1.4 - restR);
      j.shR.rotation.z = 0.25 + raise * 1.1 - swing * 1.5;
    } else if (name === 'volley' || name === 'rain') {
      j.shR.rotation.x = restR + raise * (-2.9 - restR) + swing * (-1.8 - restR);
      j.shR.rotation.z = 0.25;
    } else if (name === 'slam' || name === 'leap') {
      j.shR.rotation.x = restR + raise * (-3.3 - restR) + swing * (-0.8 - restR);
      j.shR.rotation.z = 0.25;
      torso.rotation.x += -0.3 * raise + 0.6 * swing;
    } else {
      j.shR.rotation.x = restR;
      j.shR.rotation.z = 0.25;
    }
    j.shL.rotation.x = -0.2 - sw * 0.25 * mv + (name === 'gust' ? raise * -1.8 + swing * -1.2 : 0);
    const pulse = 0.85 + Math.sin(t * (e.phase >= 2 ? 9 : 4)) * 0.2;
    j.heart.scale.setScalar(0.11 * pulse);
    if (e.state === 'stagger') torso.rotation.x -= Math.sin(Math.min(1, e.stateT / e.stateDur) * Math.PI) * 0.35;
  }

  return { root, j, mats: Object.values(m), hurtboxes, fire, animate, height: 3.4, hitRadius: 2.4 };
}
