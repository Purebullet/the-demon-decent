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
    steel: 0.48, // where the bare steel starts, above the guard (for its glow)
    width: 0.055,
    reach: 2.55,
    style: 'Momentum',
    hitstop: 0.045,
    arcs: [
      { from: [1, 0.25, -0.3], to: [-1, -0.5, -0.45] },
      { from: [-1, 0.2, -0.3], to: [1, -0.5, -0.45] },
      { from: [0.45, 1, -0.1], to: [-0.2, -0.7, -0.7] },
    ],
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
  },
};

// Every weapon there is: a kind (its personality above) and a model of its
// own (assets/manifest.js). You fall with the Rusted Shortsword; the demons
// carry the rest, and only ever drop those.
export const WEAPON_MODELS = {
  sword: { type: 'sword', name: 'Rusted Shortsword', starter: true },
  swordBone: { type: 'sword', name: 'Bonebiter' },
  swordFlame: { type: 'sword', name: 'Flamberge' },
  swordGreat: { type: 'sword', name: 'Runed Greatsword' },
  axe: { type: 'axe', name: 'Bearded Axe' },
  axeTwin: { type: 'axe', name: 'Twin Crescent' },
  axeHeadsman: { type: 'axe', name: "Headsman's Axe" },
  axeHorn: { type: 'axe', name: 'Hornhook' },
  mace: { type: 'mace', name: 'Flanged Mace' },
  maceStar: { type: 'mace', name: 'Morning Star' },
  maceHammer: { type: 'mace', name: 'Skull Maul' },
  maceClub: { type: 'mace', name: 'Fanged Club' },
};

// How good a dropped weapon is, shown by the colour it is lit in (never the
// colour of the weapon itself): its damage over its kind's, and the chance it
// carries an enchantment. Legendary hits twice as hard.
export const RARITIES = [
  { name: 'Common', color: '#eeeae2', mult: 1.15, enchant: 0 },
  { name: 'Uncommon', color: '#4c94ff', mult: 1.3, enchant: 0.15 },
  { name: 'Rare', color: '#45e070', mult: 1.5, enchant: 0.3 },
  { name: 'Epic', color: '#bd5cff', mult: 1.72, enchant: 0.5 },
  { name: 'Legendary', color: '#ffc531', mult: 2, enchant: 0.75 },
];
const PLAIN = '#a89f94';

// The odds of each rarity (common first) on the first floor and the last:
// anything can turn up anywhere, the better ones more often the deeper.
const ODDS = [
  [55, 12],
  [28, 24],
  [12, 28],
  [4, 24],
  [1, 12],
];
const LAST_FLOOR = 20;

// rarity: an index into RARITIES, or -1 for the plain starting sword.
export function makeWeapon(model, rarity = -1, enchant = null) {
  const M = WEAPON_MODELS[model];
  const def = WEAPON_TYPES[M.type];
  const R = RARITIES[rarity];
  const E = enchant && ENCHANTS[enchant];
  return {
    model,
    type: M.type,
    rarity: R ? rarity : -1,
    name: E ? `${E.prefix} ${M.name}` : M.name,
    damage: Math.round(def.damage * (R ? R.mult : 1)),
    color: R ? R.color : PLAIN,
    enchant: E ? enchant : null,
  };
}

export function rollRarity(floor, luck = 0) {
  const k = Math.max(0, Math.min(1, (floor - 1) / (LAST_FLOOR - 1) + luck * 0.2));
  const w = ODDS.map(([a, b]) => a + (b - a) * k);
  let x = Math.random() * w.reduce((s, v) => s + v, 0);
  for (let i = 0; i < w.length; i++) if ((x -= w[i]) < 0) return i;
  return 0;
}

// A weapon a demon drops (or a chest holds) on a given floor: any model but
// the one you started with, its rarity rolled for the depth (`luck` tips the
// odds further: chests, bosses).
// The best weapon of the last run ended: the next runs turn it up more often.
export const weaponMemory = { favourite: null };
const FAVOURITE_ODDS = 0.35;

export function rollWeapon(floor, luck = 0) {
  const ids = Object.keys(WEAPON_MODELS).filter((id) => !WEAPON_MODELS[id].starter);
  const fav = weaponMemory.favourite;
  const model = fav && ids.includes(fav) && Math.random() < FAVOURITE_ODDS ? fav : ids[Math.floor(Math.random() * ids.length)];
  const rarity = rollRarity(floor, luck);
  const en = Object.keys(ENCHANTS);
  const enchant = Math.random() < RARITIES[rarity].enchant ? en[Math.floor(Math.random() * en.length)] : null;
  return makeWeapon(model, rarity, enchant);
}

// Where the weapon in hand strikes and glows, from its own model: `blade` the
// stretch of it (metres up from the grip) that lands a blow, `steel` where its
// glow starts (above a sword's guard; an axe's or mace's head).
export function weaponReach(weapon) {
  const def = WEAPON_TYPES[weapon.type];
  const shape = Assets.weaponShape(weapon.model ?? weapon.type);
  if (!shape) return { blade: def.blade, steel: def.steel ?? def.blade[0] };
  const sword = weapon.type === 'sword';
  return { blade: [sword ? 0.05 : shape.from - 0.05, shape.tip + 0.1], steel: shape.from + (sword ? 0.02 : 0) };
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

// A rarity's light on a weapon: its edges lit in the colour, strongest where
// the surface turns away from the eye, the weapon's own colours left as they
// are. Adds to whatever else the material's shader already does. Returns the
// uniform (its colour times strength), to change later.
export function applyRim(m, color, strength) {
  const u = { uRim: { value: new THREE.Color(color).multiplyScalar(strength) } };
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace('#include <aomap_fragment>', '{ float rim = 1.0 - abs(dot(normal, normalize(vViewPosition))); totalEmissiveRadiance += uRim * (rim * rim * rim); }\n#include <aomap_fragment>');
  };
  m.customProgramCacheKey = () => `${prevKey.call(m)}|rim`;
  m.needsUpdate = true;
  return u.uRim;
}

// Builds the weapon with its grip at the origin and the head along +Y.
// `own` gives it materials of its own (the one in your hand glows); `rim`
// lights its edges in its rarity's colour that strongly.
export function buildWeaponMesh(weapon, { own = false, rim = 0 } = {}) {
  const id = weapon.model ?? weapon.type;
  if (Assets.hasProp(id)) {
    const lit = rim > 0 && weapon.rarity >= 0;
    const w = Assets.instanceProp(id, { own: own || lit });
    w.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      if (lit) for (const m of Array.isArray(o.material) ? o.material : [o.material]) applyRim(m, weapon.color, rim);
    });
    return w;
  }
  // Without its model (tests, a model missing): a plain stand-in, grander
  // the rarer it is.
  const tier = Math.max(0, Math.min(3, weapon.rarity ?? 0));
  const g = new THREE.Group();
  const m = metal(tier);
  const add = (geo, mat, y, sx = 1, sy = 1, sz = 1, rz = 0) => {
    const o = new THREE.Mesh(geo, mat);
    o.position.y = y;
    o.scale.set(sx, sy, sz);
    o.rotation.z = rz;
    g.add(o);
    return o;
  };
  if (weapon.type === 'sword') {
    const len = 0.85 + tier * 0.08;
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
    s.quadraticCurveTo(0.12, -0.12, 0.26, -0.2 - tier * 0.02);
    s.quadraticCurveTo(0.22, 0.04, 0.26, 0.24 + tier * 0.02);
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
    const headR = 0.1 + tier * 0.015;
    add(new THREE.IcosahedronGeometry(headR, 0), m, 0.8);
    const spikes = tier >= 2 ? 10 : 6;
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
