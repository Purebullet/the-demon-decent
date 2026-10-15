import * as THREE from 'three';
import { C, burst, ring } from '../world/Particles.js';
import { damageMul } from '../game/Levels.js';

// Demon Spells: rare utility powers. Found as sigil drops or taken at the
// Magic Circle; each can be raised to level 3. Shade Step is everyone's
// dodge (Space, the way you are moving), known from the start; Hellfire Nova
// (Q) and Blood Siphon (R) have to be found, and can be called on as many
// times a floor as their level (once at level 1, twice at 2, three times at
// 3), each time after its cooldown.

export const SPELLS = {
  nova: {
    name: 'Hellfire Nova',
    key: 'KeyQ',
    label: 'Q',
    levels: [
      { cd: 12, dmg: 45, radius: 5 },
      { cd: 10, dmg: 70, radius: 6 },
      { cd: 8, dmg: 100, radius: 7 },
    ],
    describe: (l) => `Blast of hellfire around you: ${l.dmg} damage in ${l.radius} m, hurls demons back. ${l.cd}s cooldown.`,
  },
  step: {
    name: 'Shade Step',
    key: 'Space',
    label: 'SPACE',
    levels: [
      { cd: 1.4, dist: 4.5, invuln: 0.4 },
      { cd: 1.15, dist: 5.5, invuln: 0.5 },
      { cd: 0.9, dist: 6.5, invuln: 0.6, dmg: 35 },
    ],
    describe: (l) => `Space: become shadow and dash ${l.dist} m the way you are moving (back if you stand still), through enemies, untouchable for ${l.invuln}s${l.dmg ? `, cutting all you pass for ${l.dmg}` : ''}. ${l.cd}s cooldown.`,
  },
  siphon: {
    name: 'Blood Siphon',
    key: 'KeyR',
    label: 'R',
    levels: [
      { cd: 22, dur: 7, leech: 0.25 },
      { cd: 18, dur: 9, leech: 0.35 },
      { cd: 15, dur: 11, leech: 0.5 },
    ],
    describe: (l) => `For ${l.dur}s your blows drink: heal ${Math.round(l.leech * 100)}% of melee damage dealt. ${l.cd}s cooldown.`,
  },
};

export const SPELL_IDS = Object.keys(SPELLS);
export const MAX_SPELL_LEVEL = 3;

const tmp = new THREE.Vector3();

// Uses of a spell left on this floor (Shade Step has no limit).
export function spellUsesLeft(run, id) {
  if (id === 'step') return Infinity;
  return Math.max(0, (run.spells[id] || 0) - (run.spellUses?.[id] || 0));
}

export function castSpell(id, player, ctx) {
  const level = player.run.spells[id];
  if (!level || player.spellCd[id] > 0 || player.dead || spellUsesLeft(player.run, id) <= 0) return false;
  if (id !== 'step') (player.run.spellUses ||= {})[id] = (player.run.spellUses[id] || 0) + 1;
  const L = SPELLS[id].levels[level - 1];
  player.spellCd[id] = L.cd;
  const p = player.position;

  if (id === 'nova') {
    tmp.set(p.x, 0.4, p.z);
    ring(ctx.fx.add, tmp, L.radius, { count: 90, speed: L.radius * 2.8, size: 0.7, life: 0.55 });
    burst(ctx.fx.add, tmp.set(p.x, 1, p.z), { count: 50, speed: 7, size: 0.25, life: 0.6, up: 2 });
    ctx.flash?.(0xff5a1e, 14, 0.4);
    ctx.shake?.(0.35);
    ctx.audio?.nova();
    const dmg = L.dmg * damageMul(player.run);
    for (const e of ctx.enemies) {
      if (!e.alive || e.state === 'burrowed') continue;
      const dx = e.position.x - p.x;
      const dz = e.position.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > L.radius + e.radius) continue;
      if (!ctx.nav.hasLineOfSight(p.x, p.z, e.position.x, e.position.z)) continue;
      tmp.set(dx / (d || 1), 0, dz / (d || 1));
      const dealt = e.takeHit(dmg, tmp, 12, 90, ctx);
      ctx.onDamage?.(e, dealt, false, e.position);
    }
    return true;
  }

  if (id === 'step') {
    const dir = player.moveDirection(new THREE.Vector3());
    if (dir.lengthSq() < 0.01) dir.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    player.dash = { t: 0, dur: 0.18, vx: (dir.x * L.dist) / 0.18, vz: (dir.z * L.dist) / 0.18, ghost: true, dmg: L.dmg || 0, hit: new Set() };
    player.invuln = Math.max(player.invuln, L.invuln);
    burst(ctx.fx.add, tmp.set(p.x, 1, p.z), { count: 30, speed: 3, color: C.violet, colorEnd: C.violetDark, size: 0.3, life: 0.6, gravity: 0 });
    ctx.audio?.step();
    return true;
  }

  if (id === 'siphon') {
    player.siphonT = L.dur;
    player.siphonLeech = L.leech;
    burst(ctx.fx.add, tmp.set(p.x, 1, p.z), { count: 40, speed: 3, color: C.blood, colorEnd: C.bloodDark, size: 0.3, life: 0.8, gravity: 2 });
    ctx.audio?.siphon();
    return true;
  }
  return false;
}
