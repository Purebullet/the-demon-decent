import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPress, beat, lightTiming, chainBonus, WINDOW_EARLY, WINDOW_LATE, CHAIN_MAX, LIGHT_SPEED } from '../src/combat/Rhythm.js';
import { momentumDamage, MOMENTUM_MAX, sunderDamage, SUNDER_MAX, guardOutcome } from '../src/combat/Styles.js';
import { RELICS, RELIC_IDS, rollRelic, addRelic, relicPassive } from '../src/combat/Relics.js';
import { ProcEngine, procChance, procSources, PROCS, ENCHANTS } from '../src/combat/Procs.js';
import { WEAPON_TYPES, WEAPON_MODELS, RARITIES, makeWeapon, rollWeapon } from '../src/entities/Weapons.js';
import { PROPS } from '../src/assets/manifest.js';
import { ENEMY_TYPES } from '../src/entities/EnemyTypes.js';
import { BOSS_TYPES } from '../src/entities/Bosses.js';

const swing = (t, extra = {}) => ({ W: 0.2, A: 0.15, R: 0.4, t, ...extra });

test('a press is judged by where it falls in the swing', () => {
  const done = 0.35;
  assert.equal(classifyPress(null), 'idle');
  assert.equal(classifyPress(swing(0.05)), 'mash');
  assert.equal(classifyPress(swing(done - WINDOW_EARLY - 0.01)), 'mash');
  assert.equal(classifyPress(swing(done - WINDOW_EARLY + 0.005)), 'perfect');
  assert.equal(classifyPress(swing(done)), 'perfect');
  assert.equal(classifyPress(swing(done + WINDOW_LATE - 0.005)), 'perfect');
  assert.equal(classifyPress(swing(done + WINDOW_LATE + 0.02)), 'late');
});

test('mashing spoils the window: a fumbled swing never chains perfectly', () => {
  assert.equal(classifyPress(swing(0.35, { fumbled: true })), 'late');
  // A weapon thrown back off a guard is not yours until it settles.
  assert.equal(classifyPress(swing(0.35, { bounced: { t: 0 } })), 'mash');
});

test('a blow landing (hit-stop) holds the blade, not the beat', () => {
  const done = 0.35;
  // The blade was frozen for 60 ms of the 300 that passed: on the rhythm,
  // the press is as perfect as if the swing had missed.
  assert.equal(classifyPress(swing(0.24, { rt: 0.3 })), 'perfect');
  assert.equal(classifyPress(swing(0.24)), 'mash');
  // And the window closes by the blade's own time, so the freeze never
  // shortens it.
  assert.equal(classifyPress(swing(done + WINDOW_LATE - 0.01, { rt: done + WINDOW_LATE + 0.05 })), 'perfect');
});

test('the ring shows exactly what a press would be', () => {
  for (const t of [0.05, 0.2, 0.28, 0.35, 0.45, 0.6]) {
    const s = swing(t, { rt: t + 0.03 });
    assert.equal(beat(s).window, classifyPress(s) === 'perfect');
  }
  assert.equal(beat(swing(0.35)).fill, 1);
  assert.equal(beat(swing(0.35, { fumbled: true })).window, false);
});

test('a wider window (Grim Metronome) catches presses the plain one misses', () => {
  const t = 0.35 - WINDOW_EARLY - 0.02;
  assert.equal(classifyPress(swing(t)), 'mash');
  assert.equal(classifyPress(swing(t), 1.45), 'perfect');
});

test('light swings are a quarter faster; perfect ones keep the beat, sluggish ones slower', () => {
  const def = WEAPON_TYPES.sword;
  const plain = lightTiming(def);
  assert.ok(Math.abs(plain.W - def.windup * LIGHT_SPEED) < 1e-9);
  assert.ok(Math.abs(plain.A + plain.W + plain.R - (def.windup + def.active + def.recover) * 0.75) < 1e-9);
  // One steady rhythm: however long the chain, the arc completes on the
  // same beat.
  const perfect = lightTiming(def, { perfect: true, chain: 3 });
  assert.ok(Math.abs(perfect.W + perfect.A - (plain.W + plain.A)) < 1e-9);
  const slow = lightTiming(def, { sluggish: true });
  assert.ok(slow.W > plain.W * 1.4 && slow.R > plain.R * 1.3);
  const quick = lightTiming(def, { speed: 1.1 });
  assert.ok(quick.W < plain.W && quick.W > plain.W * 0.6);
});

test('a longer chain hits harder, glows brighter, sounds deeper and procs more', () => {
  let prev = chainBonus(0);
  for (let c = 1; c <= CHAIN_MAX; c++) {
    const b = chainBonus(c);
    assert.ok(b.damage > prev.damage && b.proc > prev.proc && b.glow > prev.glow && b.pitch < prev.pitch);
    prev = b;
  }
  assert.deepEqual(chainBonus(CHAIN_MAX + 3), chainBonus(CHAIN_MAX));
});

test('weapon personalities: momentum caps, sunder stacks cap, guards answer to the weapon', () => {
  assert.equal(momentumDamage(0), 1);
  assert.equal(momentumDamage(MOMENTUM_MAX + 5), momentumDamage(MOMENTUM_MAX));
  assert.equal(sunderDamage(SUNDER_MAX + 2), sunderDamage(SUNDER_MAX));
  assert.equal(guardOutcome('axe', false, 0), 'shatter');
  assert.equal(guardOutcome('sword', true, 1), 'bounce');
  assert.equal(guardOutcome('mace', false, 0), 'bounce');
  assert.equal(guardOutcome('mace', true, 0.8), 'crash');
  for (const t of Object.values(WEAPON_TYPES)) assert.ok(t.style && t.width > 0 && t.width <= 0.12);
});

test('dropped weapons: never the starting sword, always better, legendary twice as hard, rarer deeper', () => {
  const starter = makeWeapon('sword');
  assert.equal(starter.rarity, -1);
  for (const type of Object.keys(WEAPON_TYPES)) assert.equal(Object.values(WEAPON_MODELS).filter((m) => m.type === type).length, 4, type);
  for (const id of Object.keys(WEAPON_MODELS)) assert.ok(PROPS[id]?.weapon, `${id} has a weapon model`);
  const seen = new Set();
  const tally = (floor) => {
    const n = RARITIES.map(() => 0);
    for (let i = 0; i < 4000; i++) {
      const w = rollWeapon(floor);
      assert.ok(!WEAPON_MODELS[w.model].starter && WEAPON_MODELS[w.model].type === w.type);
      assert.ok(w.damage > starter.damage, `${w.name} hits harder than the ${starter.name}`);
      assert.equal(w.color, RARITIES[w.rarity].color);
      seen.add(w.model);
      n[w.rarity]++;
    }
    return n;
  };
  const shallow = tally(1);
  const deep = tally(20);
  // Anything can turn up anywhere; the rare ones far more often deep down.
  for (let k = 0; k < RARITIES.length; k++) assert.ok(shallow[k] > 0 && deep[k] > 0, RARITIES[k].name);
  assert.ok(deep[4] > shallow[4] * 4 && deep[3] > shallow[3] * 3 && deep[0] < shallow[0] / 2);
  assert.equal(seen.size, Object.keys(WEAPON_MODELS).length - 1);
  assert.equal(makeWeapon('swordBone', RARITIES.length - 1).damage, starter.damage * 2);
});

test('relics: every one does something, stacks deepen it, passives combine', () => {
  for (const id of RELIC_IDS) {
    const R = RELICS[id];
    assert.ok(R.name && R.text && (R.procs?.length || R.passive), id);
    for (const p of R.procs || []) assert.ok(PROCS[p.proc], `${id}: ${p.proc}`);
  }
  const run = { relics: {}, weapon: { name: 'x' } };
  assert.equal(addRelic(run, 'gorget'), 1);
  assert.equal(addRelic(run, 'gorget'), 2);
  assert.ok(Math.abs(relicPassive(run, 'armor') - (1 - 0.82 * 0.82)) < 1e-9);
  assert.equal(relicPassive(run, 'window'), null);
  addRelic(run, 'metronome');
  assert.equal(relicPassive(run, 'window'), 1.45);
  addRelic(run, 'rime');
  addRelic(run, 'rime');
  const rime = procSources(run).find((s) => s.proc === 'freeze');
  assert.ok(Math.abs(rime.chance - RELICS.rime.procs[0].chance * 1.5) < 1e-9);
});

test('rollRelic favours relics not yet carried', () => {
  const run = { relics: { rime: 1, fang: 1 } };
  let fresh = 0;
  let r = 0.3;
  const rand = () => ((r = (r * 9301 + 49297) % 233280), r / 233280);
  for (let i = 0; i < 400; i++) if (!run.relics[rollRelic(run, rand)]) fresh++;
  assert.ok(fresh > 300, `fresh ${fresh}`);
});

test('procs fire only on their trigger, scale with the chain, and respect cooldowns', () => {
  const fired = [];
  const run = { relics: { rime: 1 }, weapon: { name: 'w', enchant: 'serrated' } };
  const enemy = { alive: true, freeze: () => fired.push('freeze'), addStatus: () => fired.push('bleed'), position: { x: 0, z: 0 }, model: { height: 1.6 }, type: {} };
  const ctx = { time: 0, fx: { add: { emit() {} }, alpha: { emit() {} } }, flash() {}, onProc() {} };
  const engine = new ProcEngine();
  const ev = (triggers, chain = 0) => ({ triggers: new Set(triggers), enemy, point: { x: 0, y: 1, z: 0, clone() { return this; } }, chain, chainMul: chainBonus(chain).proc, weaponDamage: 20, damage: 20 });
  // A plain hit can only bleed (the enchant); a perfect hit can freeze.
  engine.fire(ctx, run, ev(['hit']), () => 0);
  assert.deepEqual(fired, ['bleed']);
  fired.length = 0;
  ctx.time = 10;
  engine.fire(ctx, run, ev(['hit', 'perfect'], 3), () => 0);
  assert.deepEqual(fired.sort(), ['bleed', 'freeze']);
  // Cooldown: an immediate repeat does not freeze again.
  fired.length = 0;
  engine.fire(ctx, run, ev(['perfect'], 3), () => 0);
  assert.deepEqual(fired, []);
  // A roll above the chance does nothing.
  ctx.time = 20;
  engine.fire(ctx, run, ev(['perfect'], 0), () => 0.99);
  assert.deepEqual(fired, []);
  assert.ok(procChance(0.2, { chainMul: chainBonus(5).proc, counter: true }) <= 0.95);
  assert.ok(procChance(0.2, { chainMul: chainBonus(3).proc }) > procChance(0.2, { chainMul: 1 }) * 2);
  for (const e of Object.values(ENCHANTS)) assert.ok(PROCS[e.proc] && e.prefix);
});

test('every demon fights its own way, and its strings and blinks are well formed', () => {
  for (const [key, t] of [...Object.entries(ENEMY_TYPES), ...Object.entries(BOSS_TYPES)]) {
    const names = new Set(t.attacks.map((a) => a.name));
    assert.ok(t.attacks.some((a) => !a.comboOnly), `${key}: nothing to open with`);
    for (const a of t.attacks) {
      if (a.combo) assert.ok(names.has(a.combo.next) && a.combo.chance > 0 && a.combo.chance < 1, `${key}.${a.name}: combo`);
      if (a.comboOnly) assert.ok(t.attacks.some((b) => b.combo?.next === a.name), `${key}.${a.name}: unreachable`);
      if (a.charge) assert.ok(a.lunge > 0 && a.volume, `${key}.${a.name}: a charge needs to move and to hit`);
      if (a.feint) assert.ok(a.feint > 0 && a.feint < 0.5, `${key}.${a.name}: feint`);
    }
    if (t.blink?.then) assert.ok(names.has(t.blink.then), `${key}: blink follow-up`);
    if (t.blink) assert.ok(['behind', 'away'].includes(t.blink.mode), `${key}: blink mode`);
  }
  // Something to learn on every kind of regular demon.
  const tricks = (t) => [t.skittish, t.blink, t.enrage, ...t.attacks.map((a) => a.combo || a.feint || a.armor || a.charge || a.eruption || a.ignite)].filter(Boolean).length;
  for (const [key, t] of Object.entries(ENEMY_TYPES)) assert.ok(tricks(t) >= 2, `${key} has too few tricks`);
});

test('the first demon has a quick, weaker attack besides its rake', () => {
  const g = ENEMY_TYPES.ghoul;
  const claw = g.attacks.find((a) => a.name === 'claw');
  const quick = g.attacks.filter((a) => a.windup < claw.windup * 0.6 && a.dmg < claw.dmg * 0.6 && a.maxRange >= 1.5);
  assert.ok(quick.length, 'no quick attack');
});

test('swings reach as far as they look and no further than a few metres', () => {
  for (const [k, t] of Object.entries(WEAPON_TYPES)) assert.ok(t.reach > t.blade[1] + 0.8 && t.reach < 3, k);
});
