import * as THREE from 'three';
import { emberVeinTexture } from '../world/Textures.js';
import { Assets } from '../assets/AssetLibrary.js';
import { ENCHANTS } from '../combat/Procs.js';

// Melee weapons. The player never has armour; these are all there is. Each
// kind has a personality (combat/Styles.js):
//
//   Sword - Momentum: quick alternating slashes that speed up while they land.
//   Axe   - Sunder: slow diagonal chops that tear defences away and shatter guards.
//   Mace  - Domination: crushing blows that knock a demon out of anything it does.
//
// `width` is the half-thickness of the blade's hit volume around its centre
// line: thin, so a blow lands only where the weapon visibly is. `reach` is how
// far from the eye a blow carries: a demon the blade crosses on screen is
// struck if it stands within it (Player._sweep).
//
// Swing arcs are given as start/end blade directions in camera space
// (x right, y up, -z forward). The blade sweeps the great-circle arc between
// them, which passes in front of the player because both have -z components.

export const WEAPON_TYPES = {
  sword: {
    label: 'Sword',
    damage: 22,
    // About a second a swing: committed blows, not spam.
    windup: 0.24,
    active: 0.2,
    recover: 0.56,
    knockback: 3,
    stagger: 28,
    blade: [0.05, 1.12], // hitbox span along the blade, metres from the grip
    width: 0.055,
    reach: 2.55,
    style: 'Momentum',
    hitstop: 0.045,
    arcs: [
      { from: [1, 0.25, -0.3], to: [-1, -0.5, -0.45] },
      { from: [-1, 0.2, -0.3], to: [1, -0.5, -0.45] },
      { from: [0.45, 1, -0.1], to: [-0.2, -0.7, -0.7] },
    ],
    names: ['Rusted Shortsword', 'Forged Longsword', 'Infernal Blade', 'Hellforged Greatsword'],
  },
  axe: {
    label: 'Axe',
    damage: 42,
    windup: 0.5,
    active: 0.24,
    recover: 0.72,
    knockback: 4.5,
    stagger: 55,
    blade: [0.55, 1.15],
    width: 0.1,
    reach: 2.65,
    style: 'Sunder',
    hitstop: 0.08,
    arcs: [
      { from: [0.75, 1, -0.15], to: [-0.45, -0.8, -0.55] },
      { from: [-0.75, 1, -0.15], to: [0.45, -0.8, -0.55] },
    ],
    names: ['Notched Hatchet', 'Forged Bearded Axe', 'Infernal Cleaver', 'Hellforged Executioner'],
  },
  mace: {
    label: 'Mace',
    damage: 30,
    windup: 0.4,
    active: 0.22,
    recover: 0.62,
    knockback: 9,
    stagger: 120,
    blade: [0.55, 1.0],
    width: 0.12,
    reach: 2.45,
    style: 'Domination',
    hitstop: 0.07,
    arcs: [
      { from: [0.15, 1, -0.12], to: [-0.05, -0.8, -0.6] },
      { from: [1, 0.1, -0.3], to: [-1, -0.45, -0.45] },
    ],
    names: ['Cracked Club', 'Forged Flanged Mace', 'Infernal Morningstar', 'Hellforged Maul'],
  },
};

export const TIER_MULT = [1, 1.22, 1.48, 1.8];
const TIER_COLOR = ['#a89f94', '#d9d4c8', '#ff8a3c', '#ff3c2a'];

export function makeWeapon(type, tier = 0, roll = 1, enchant = null) {
  const def = WEAPON_TYPES[type];
  const E = enchant && ENCHANTS[enchant];
  return {
    type,
    tier,
    name: E ? `${E.prefix} ${def.names[tier]}` : def.names[tier],
    damage: Math.round(def.damage * TIER_MULT[tier] * roll),
    color: TIER_COLOR[tier],
    enchant: E ? enchant : null,
  };
}

// Weapon drop for a given depth: deeper floors favour better tiers, and a
// forged weapon or better may carry an enchantment (a proc of its own).
export function rollWeapon(floor, luck = 0) {
  const types = Object.keys(WEAPON_TYPES);
  const type = types[Math.floor(Math.random() * types.length)];
  const base = (floor - 1) / 6 + luck;
  const tier = Math.max(0, Math.min(3, Math.floor(base + Math.random() * 1.2 - 0.2)));
  const ids = Object.keys(ENCHANTS);
  const enchant = tier >= 1 && Math.random() < 0.3 + tier * 0.15 ? ids[Math.floor(Math.random() * ids.length)] : null;
  return makeWeapon(type, tier, 0.92 + Math.random() * 0.16, enchant);
}

// ---- Swing geometry ---------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _m = new THREE.Matrix4();

// Pre-computes a swing arc: normalized endpoints, rotation axis and angle.
export function prepareArc(arc) {
  const from = new THREE.Vector3(...arc.from).normalize();
  const to = new THREE.Vector3(...arc.to).normalize();
  const axis = new THREE.Vector3().crossVectors(from, to).normalize();
  const angle = from.angleTo(to);
  return { from, to, axis, angle };
}

for (const def of Object.values(WEAPON_TYPES)) def.prepared = def.arcs.map(prepareArc);

// Blade direction at fraction k of the arc.
export function arcDirection(arc, k, target) {
  return target.copy(arc.from).applyAxisAngle(arc.axis, arc.angle * k);
}

// Orientation that points the weapon's +Y along `dir`, with the flat of the
// blade facing along the swing axis so the edge leads.
export function bladeQuaternion(dir, axis, target) {
  _a.copy(dir).normalize();
  _n.copy(axis).addScaledVector(_a, -axis.dot(_a)).normalize();
  _x.crossVectors(_a, _n);
  _m.makeBasis(_x, _a, _n);
  return target.setFromRotationMatrix(_m);
}

export const SHOULDER = new THREE.Vector3(0.12, -0.42, -0.05);
export const ARM = 0.36;

// Camera-space grip pose for a blade direction.
export function gripPose(dir, axis, pos, quat) {
  pos.copy(SHOULDER).addScaledVector(dir, ARM);
  bladeQuaternion(dir, axis, quat);
}

// ---- Viewmodel meshes -------------------------------------------------------

function metal(tier) {
  const glow = tier >= 2;
  return new THREE.MeshStandardMaterial({
    color: tier === 0 ? 0x7a726a : 0x9a9ca2,
    metalness: 0.05,
    roughness: 0.85,
    emissive: glow ? 0xffffff : 0x000000,
    emissiveMap: glow ? emberVeinTexture(13 + tier, tier === 3 ? [255, 40, 20] : [255, 120, 30], 8) : null,
    emissiveIntensity: glow ? 1.4 : 0,
  });
}

const wood = () => new THREE.MeshStandardMaterial({ color: 0x3b2618, roughness: 0.85 });
const leather = () => new THREE.MeshStandardMaterial({ color: 0x24160f, roughness: 0.9 });

// Builds the weapon with its grip at the origin and the head along +Y.
// `own` gives it materials of its own (the one in your hand glows).
export function buildWeaponMesh(weapon, { own = false } = {}) {
  // Generated weapon model; higher tiers smoulder.
  if (Assets.hasProp(weapon.type)) {
    const w = Assets.instanceProp(weapon.type, { own: own || weapon.tier >= 2 });
    w.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      if (weapon.tier >= 2 && o.material.emissive) {
        o.material.emissive.setHex(weapon.tier === 3 ? 0xff2a10 : 0xff7a20);
        o.material.emissiveIntensity = weapon.tier === 3 ? 0.5 : 0.3;
      }
    });
    w.scale.multiplyScalar(1 + weapon.tier * 0.05);
    return w;
  }
  const g = new THREE.Group();
  const m = metal(weapon.tier);
  const add = (geo, mat, y, sx = 1, sy = 1, sz = 1, rz = 0) => {
    const o = new THREE.Mesh(geo, mat);
    o.position.y = y;
    o.scale.set(sx, sy, sz);
    o.rotation.z = rz;
    g.add(o);
    return o;
  };
  if (weapon.type === 'sword') {
    const len = 0.85 + weapon.tier * 0.08;
    add(new THREE.CylinderGeometry(0.022, 0.026, 0.2, 8), leather(), -0.08);
    add(new THREE.SphereGeometry(0.035, 8, 6), m, -0.2);
    add(new THREE.BoxGeometry(0.24, 0.03, 0.045), m, 0.03);
    const blade = new THREE.BoxGeometry(0.06, len, 0.012);
    blade.translate(0, len / 2 + 0.045, 0);
    add(blade, m, 0);
    const tip = new THREE.ConeGeometry(0.0425, 0.14, 4);
    tip.rotateY(Math.PI / 4);
    tip.scale(1, 1, 0.28);
    add(tip, m, len + 0.045 + 0.07);
  } else if (weapon.type === 'axe') {
    add(new THREE.CylinderGeometry(0.025, 0.03, 1.15, 8), wood(), 0.42);
    const s = new THREE.Shape();
    s.moveTo(0, -0.08);
    s.quadraticCurveTo(0.12, -0.12, 0.26, -0.2 - weapon.tier * 0.02);
    s.quadraticCurveTo(0.22, 0.04, 0.26, 0.24 + weapon.tier * 0.02);
    s.quadraticCurveTo(0.12, 0.12, 0, 0.1);
    s.lineTo(0, -0.08);
    const head = new THREE.ExtrudeGeometry(s, { depth: 0.025, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.008, bevelSegments: 1 });
    head.translate(0.02, 0, -0.0125);
    // The swing moves the head toward -X in grip space: put the edge there.
    head.rotateY(Math.PI);
    add(head, m, 0.88);
    add(new THREE.BoxGeometry(0.07, 0.2, 0.06), m, 0.88);
  } else {
    add(new THREE.CylinderGeometry(0.026, 0.03, 0.9, 8), wood(), 0.3);
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 8), leather(), -0.05);
    const headR = 0.1 + weapon.tier * 0.015;
    add(new THREE.IcosahedronGeometry(headR, 0), m, 0.8);
    const spikes = weapon.tier >= 2 ? 10 : 6;
    for (let i = 0; i < spikes; i++) {
      const c = new THREE.ConeGeometry(0.025, 0.11, 5);
      c.translate(0, headR + 0.04, 0);
      const o = new THREE.Mesh(c, m);
      o.position.y = 0.8;
      o.rotation.set((i % 2) * 1.2 - 0.6, (i / spikes) * Math.PI * 2, i % 3 === 0 ? 1.57 : 0.7);
      g.add(o);
    }
  }
  g.traverse((o) => {
    if (o.isMesh) o.frustumCulled = false;
  });
  return g;
}
