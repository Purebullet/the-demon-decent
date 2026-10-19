import * as THREE from 'three';
import { RELICS } from './Relics.js';
import { C, burst, ring } from '../world/Particles.js';

// Procs: sudden magical escalations a blow can set off. They are never pure
// luck: each is tied to a trigger the player earns (a Perfect Chain, a
// counter-hit, a charged heavy blow, a heavy kill; see Relics.js), and the chance is
// multiplied by the swing's Perfect Chain (chainBonus().proc in Rhythm.js),
// so fighting in rhythm is what turns the slot machine.
//
//   chance = base x chainMultiplier x (1.25 on a counter-hit), at most 95%
//
// Each proc has an internal cooldown (icd) so it lands as an event, not as
// noise. Sources are the relics a run carries (a second copy of a relic
// raises its chances by half) and the weapon's own enchantment.

export const PROCS = {
  freeze: { name: 'Rime Burst', color: '#9fe4ff', icd: 3, run: freeze },
  lifesteal: { name: 'Blood Reaver', color: '#ff4a3a', icd: 0.4, run: lifesteal },
  hellfire: { name: 'Hellfire Eruption', color: '#ff8a2a', icd: 1.5, run: hellfire },
  lightning: { name: 'Storm Chain', color: '#a8c8ff', icd: 1.5, run: lightning },
  bleed: { name: 'Hemorrhage', color: '#e0202a', icd: 0.6, run: bleed },
  soulrend: { name: 'Soul Rend', color: '#7dffb0', icd: 1, run: soulrend },
  echo: { name: 'Phantom Echo', color: '#c4d8ff', icd: 1.2, run: echo },
};

// Weapon enchantments: a weapon of tier 1+ may carry one (Weapons.js).
export const ENCHANTS = {
  frost: { prefix: 'Frostbitten', proc: 'freeze', on: 'perfect', chance: 0.16 },
  serrated: { prefix: 'Serrated', proc: 'bleed', on: 'hit', chance: 0.14 },
  cinder: { prefix: 'Cinderforged', proc: 'hellfire', on: 'counter', chance: 0.45 },
  storm: { prefix: 'Stormcalled', proc: 'lightning', on: 'heavy', chance: 0.35 },
  thirst: { prefix: 'Bloodthirsty', proc: 'lifesteal', on: 'kill', chance: 0.3 },
};

export function procChance(base, { chainMul = 1, counter = false } = {}) {
  return Math.min(0.95, base * chainMul * (counter ? 1.25 : 1));
}

// Every proc the run can set off: relics first, then the weapon.
export function procSources(run) {
  const out = [];
  for (const [id, n] of Object.entries(run.relics || {})) {
    const R = RELICS[id];
    for (const p of R?.procs || []) out.push({ ...p, chance: p.chance * (1 + 0.5 * (n - 1)), from: R.name });
  }
  const en = run.weapon?.enchant && ENCHANTS[run.weapon.enchant];
  if (en) out.push({ proc: en.proc, on: en.on, chance: en.chance, from: run.weapon.name });
  return out;
}

export class ProcEngine {
  constructor() {
    this.ready = new Map(); // proc -> time it may fire again
  }

  reset() {
    this.ready.clear();
  }

  // ev: { triggers: Set, enemy, point, dir, chain, chainMul, counter,
  //       damage (this hit), weaponDamage, heavy }. Returns the procs fired.
  fire(ctx, run, ev, rand = Math.random) {
    const fired = [];
    const now = ctx.time || 0;
    for (const s of procSources(run)) {
      if (!ev.triggers.has(s.on) || fired.includes(s.proc)) continue;
      if (s.minChain && (ev.chain || 0) < s.minChain) continue;
      if ((this.ready.get(s.proc) || 0) > now) continue;
      if (rand() >= procChance(s.chance, ev)) continue;
      const P = PROCS[s.proc];
      this.ready.set(s.proc, now + P.icd);
      P.run(ctx, ev);
      fired.push(s.proc);
      ctx.onProc?.(s.proc, P, ev);
      ctx.audio?.proc?.(s.proc);
    }
    return fired;
  }
}

// ---- Effects -----------------------------------------------------------------

const tmp = new THREE.Vector3();
const ICE = new THREE.Color(0.75, 0.95, 1.0);
const ICE_DARK = new THREE.Color(0.15, 0.45, 0.8);
const SOUL = new THREE.Color(0.6, 1.0, 0.75);
const SOUL_DARK = new THREE.Color(0.0, 0.35, 0.18);
const BOLT = new THREE.Color(0.85, 0.92, 1.0);
const BOLT_EDGE = new THREE.Color(0.3, 0.45, 1.0);

const chestOf = (e, out) => out.set(e.position.x, (e.model?.height || 1.6) * 0.6 * (e.type?.scale || 1), e.position.z);

function dealTo(ctx, e, amount, from, { knockback = 2, stagger = 30 } = {}) {
  if (!e.alive) return 0;
  tmp.set(e.position.x - from.x, 0, e.position.z - from.z);
  if (tmp.lengthSq() < 1e-6) tmp.set(0, 0, 1);
  tmp.normalize();
  const dealt = e.takeHit(amount, tmp, knockback, stagger, ctx, { proc: true });
  ctx.onDamage?.(e, dealt, false, chestOf(e, new THREE.Vector3()), 'proc');
  return dealt;
}

// Frozen solid mid-motion; the next blow shatters the ice for extra damage.
function freeze(ctx, ev) {
  const e = ev.enemy;
  if (!e.alive) return;
  e.freeze?.(ctx, e.isBoss ? 0.8 : 2.4);
  const p = chestOf(e, new THREE.Vector3());
  burst(ctx.fx.add, p, { count: 26, speed: 4, color: ICE, colorEnd: ICE_DARK, size: 0.12, life: 0.6, gravity: -3 });
  ring(ctx.fx.add, tmp.set(e.position.x, 0.1, e.position.z), 2.2, { count: 18, color: ICE_DARK, colorEnd: ICE_DARK, size: 0.22, life: 0.45, speed: 5 });
  ctx.flash?.(0x7ad8ff, 8, 0.25);
}

// The blood is torn out of the dead and pours into you.
function lifesteal(ctx, ev) {
  const e = ev.enemy;
  const from = chestOf(e, new THREE.Vector3());
  const p = ctx.player;
  ctx.effects?.stream(from, () => tmp.set(p.position.x, 1.25, p.position.z), {
    color: C.blood,
    bright: new THREE.Color(1, 0.15, 0.08),
    dur: 0.5,
    onArrive: () => {
      p.heal(p.run.maxHealth * 0.12);
      p.healFlash = 1;
      ctx.flash?.(0xff2a1a, 6, 0.3);
    },
  });
  burst(ctx.fx.alpha, from, { count: 36, speed: 4.5, color: C.blood, colorEnd: C.bloodDark, size: 0.2, life: 0.8 });
}

// Hellfire bursts out of the wound and everything near it burns.
function hellfire(ctx, ev) {
  const at = ev.point.clone();
  const R = 3.4;
  ring(ctx.fx.add, tmp.set(at.x, 0.2, at.z), R, { count: 70, speed: R * 3, size: 0.6, life: 0.5 });
  burst(ctx.fx.add, at, { count: 60, speed: 7, color: C.fireCore, colorEnd: C.fireEdge, size: 0.3, life: 0.6, up: 2.5 });
  ctx.flash?.(0xff6a1a, 16, 0.35);
  ctx.shake?.(0.3);
  for (const e of ctx.enemies) {
    if (!e.alive || e.state === 'burrowed') continue;
    if (Math.hypot(e.position.x - at.x, e.position.z - at.z) > R + e.radius) continue;
    dealTo(ctx, e, ev.weaponDamage * 0.7, at, { knockback: 7, stagger: 60 });
    e.addStatus?.('burn', { dps: ev.weaponDamage * 0.12, dur: 3 });
  }
}

// Lightning leaps from the struck demon to up to three more within 7 m; with
// none near, it comes down on the same one.
function lightning(ctx, ev) {
  const first = ev.enemy;
  const hit = new Set([first]);
  let from = chestOf(first, new THREE.Vector3());
  let jumps = 0;
  for (let i = 0; i < 3; i++) {
    let best = null;
    let bd = 7;
    for (const e of ctx.enemies) {
      if (!e.alive || hit.has(e) || e.state === 'burrowed') continue;
      const d = Math.hypot(e.position.x - from.x, e.position.z - from.z);
      if (d < bd && ctx.nav?.hasLineOfSight(from.x, from.z, e.position.x, e.position.z) !== false) {
        bd = d;
        best = e;
      }
    }
    if (!best) break;
    hit.add(best);
    const to = chestOf(best, new THREE.Vector3());
    ctx.effects?.bolt(from, to, { color: BOLT, edge: BOLT_EDGE });
    dealTo(ctx, best, ev.weaponDamage * 0.6, from, { knockback: 1, stagger: 0 });
    best.interrupt?.(ctx, 0.45);
    from = to;
    jumps++;
  }
  if (!jumps && first.alive) {
    const p = chestOf(first, new THREE.Vector3());
    ctx.effects?.bolt(tmp.set(p.x + 0.6, p.y + 5, p.z - 0.4), p, { color: BOLT, edge: BOLT_EDGE });
    dealTo(ctx, first, ev.weaponDamage * 0.8, first.position, { knockback: 0, stagger: 0 });
    first.interrupt?.(ctx, 0.45);
  }
  ctx.flash?.(0x9ab8ff, 12, 0.18);
}

// A deep wound that keeps on bleeding.
function bleed(ctx, ev) {
  const e = ev.enemy;
  if (!e.alive) return;
  e.addStatus?.('bleed', { dps: ev.weaponDamage * 0.24, dur: 4 });
  burst(ctx.fx.alpha, ev.point, { count: 28, speed: 3.5, color: C.blood, colorEnd: C.bloodDark, size: 0.14, life: 0.9, gravity: -9 });
}

// The soul is ripped from the corpse and detonates.
function soulrend(ctx, ev) {
  const at = chestOf(ev.enemy, new THREE.Vector3());
  const R = 4.5;
  burst(ctx.fx.add, at, { count: 80, speed: 8, color: SOUL, colorEnd: SOUL_DARK, size: 0.32, life: 0.8, up: 2, gravity: 2 });
  ring(ctx.fx.add, tmp.set(at.x, 0.3, at.z), R, { count: 60, color: SOUL, colorEnd: SOUL_DARK, size: 0.55, life: 0.6, speed: R * 2.8 });
  ctx.flash?.(0x6aff9a, 14, 0.4);
  ctx.shake?.(0.4);
  for (const e of ctx.enemies) {
    if (!e.alive || e === ev.enemy || e.state === 'burrowed') continue;
    if (Math.hypot(e.position.x - at.x, e.position.z - at.z) > R + e.radius) continue;
    dealTo(ctx, e, ev.weaponDamage * 0.9, at, { knockback: 9, stagger: 80 });
    e.interrupt?.(ctx, 1.1);
  }
}

// A ghost of your blade follows the swing through the same demon.
function echo(ctx, ev) {
  const e = ev.enemy;
  const amount = ev.damage * 0.6;
  ctx.later?.(0.22, () => {
    if (!e.alive) return;
    const p = chestOf(e, new THREE.Vector3());
    for (let i = 0; i < 18; i++) {
      const k = i / 17 - 0.5;
      ctx.fx.add.emit({ x: p.x + k * 1.4, y: p.y + k * 0.7, z: p.z, vx: 0, vy: 0.3, vz: 0, life: 0.35, size: 0.3, sizeEnd: 0.05, color: new THREE.Color(0.85, 0.9, 1), colorEnd: new THREE.Color(0.3, 0.4, 1), drag: 3 });
    }
    dealTo(ctx, e, amount, ctx.player.position, { knockback: 2, stagger: 25 });
    ctx.audio?.proc?.('echoHit');
  });
}
