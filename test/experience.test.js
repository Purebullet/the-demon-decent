import test from 'node:test';
import assert from 'node:assert/strict';
import { newLevels, xpForKill, gainXp, spendPoint, xpToNext, damageMul, swingSpeedMul, takenMul, MAX_LEVEL, STAT_CAP, STAT_IDS } from '../src/game/Levels.js';
import { newRun } from '../src/game/Progression.js';
import { FLOORS } from '../src/world/LevelData.js';

const ENEMY = { g: 'ghoul', G: 'ghoul', c: 'fiend', b: 'brute', d: 'hound', m: 'witch' };

test('the first floor’s stalkers together make the first level, not five of them', () => {
  const run = newLevels();
  const stalker = xpForKill({ typeKey: 'ghoul' }, 1);
  assert.equal(gainXp(run, stalker * 5), 0);
  assert.equal(gainXp(run, stalker), 1);
  assert.equal(run.level, 1);
  assert.equal(run.points, 1);
});

test('bigger demons, elites and bosses are worth more; summons less', () => {
  const xp = (e, f = 5) => xpForKill(e, f);
  assert.ok(xp({ typeKey: 'brute' }) > xp({ typeKey: 'fiend' }) && xp({ typeKey: 'fiend' }) > xp({ typeKey: 'ghoul' }));
  assert.equal(xp({ typeKey: 'brute', elite: true }), 2 * xp({ typeKey: 'brute' }));
  assert.ok(xp({ typeKey: 'ghoul', summoned: true }) < xp({ typeKey: 'ghoul' }));
  assert.ok(xp({ bossKey: 'azrakel' }, 10) > xp({ bossKey: 'sleeper' }, 5));
  assert.ok(xp({ typeKey: 'ghoul' }, 9) > xp({ typeKey: 'ghoul' }, 1));
});

test('five points at most in each stat, ten levels in all, and what they buy', () => {
  const run = newRun();
  assert.equal(gainXp(run, 1e7), MAX_LEVEL);
  assert.equal(run.level, MAX_LEVEL);
  assert.equal(gainXp(run, 1e5), 0);
  let spent = 0;
  for (const id of STAT_IDS) {
    for (let k = 0; k < STAT_CAP && run.points > 0; k++, spent++) assert.ok(spendPoint(run, id));
  }
  assert.equal(spent, MAX_LEVEL);
  assert.equal(run.points, 0);
  assert.ok(Math.abs(damageMul(run) - 1.3) < 1e-9);
  assert.ok(Math.abs(takenMul(run) - 0.7) < 1e-9);
  assert.ok(Math.abs(swingSpeedMul(run) - 1) < 1e-9);
  const full = newRun();
  gainXp(full, 1e7);
  for (let k = 0; k < STAT_CAP; k++) spendPoint(full, 'agility');
  assert.equal(spendPoint(full, 'agility'), false);
  assert.ok(Math.abs(swingSpeedMul(full) - 1.25) < 1e-9);
});

test('levels come about once a floor: a few by the Sleeper, most by the last floor', () => {
  const run = newLevels();
  let bySleeper = 0;
  FLOORS.forEach((f, i) => {
    let xp = 0;
    for (const ch of (f.map || []).join('')) if (ENEMY[ch]) xp += xpForKill({ typeKey: ENEMY[ch] }, i + 1);
    if (f.boss && i + 1 < FLOORS.length) xp += xpForKill({ bossKey: f.boss }, i + 1);
    gainXp(run, xp);
    if (i + 1 === 5) bySleeper = run.level;
  });
  assert.ok(bySleeper >= 2 && bySleeper <= 5, `level ${bySleeper} after the Sleeper`);
  assert.ok(run.level >= 6 && run.level <= MAX_LEVEL, `level ${run.level} at the last floor`);
  assert.equal(xpToNext(0), 60);
});

test('a run carries 3 potions, the Blood Well raises that to 4 at most, then fills two', async () => {
  const { newRun, NODES, POTION_CAP, MAX_POTION_CAP } = await import('../src/game/Progression.js');
  const run = newRun();
  assert.equal(run.potionCap, 3);
  assert.equal(POTION_CAP, 3);
  assert.equal(MAX_POTION_CAP, 4);
  const gift = () => NODES.well.options(run)[1];
  gift().apply(run);
  assert.equal(run.potionCap, 4);
  run.potions = 1;
  assert.equal(gift().label, 'Fill two flasks');
  gift().apply(run);
  assert.equal(run.potionCap, 4);
  assert.equal(run.potions, 3);
  gift().apply(run);
  assert.equal(run.potions, 4);
});

test('a fallen run leaves the next half its level (rounded up), where its points went', async () => {
  const { legacyOf } = await import('../src/game/Levels.js');
  assert.deepEqual(legacyOf({ level: 7, stats: { attack: 4, defence: 2, agility: 1 } }), { level: 4, xp: 0, points: 0, stats: { attack: 2, defence: 1, agility: 1 } });
  assert.deepEqual(legacyOf({ level: 9, stats: { attack: 3, defence: 3, agility: 3 } }).stats, { attack: 2, defence: 2, agility: 1 });
  assert.equal(legacyOf({ level: 1, stats: { attack: 1, defence: 0, agility: 0 } }).level, 1);
  assert.equal(legacyOf({ level: 0, stats: { attack: 0, defence: 0, agility: 0 } }).level, 0);
  assert.equal(legacyOf({ level: 10, stats: { attack: 5, defence: 5, agility: 0 } }).level, 5);
  // Unspent points come through as points.
  assert.deepEqual(legacyOf({ level: 6, stats: { attack: 0, defence: 0, agility: 0 } }), { level: 3, xp: 0, points: 3, stats: { attack: 0, defence: 0, agility: 0 } });
});

test('spells: Q and R as many times a floor as their level; Shade Step without limit', async () => {
  const { spellUsesLeft } = await import('../src/entities/Spells.js');
  const run = { spells: { nova: 2, step: 1, siphon: 1 }, spellUses: { nova: 1, siphon: 1 } };
  assert.equal(spellUsesLeft(run, 'nova'), 1);
  assert.equal(spellUsesLeft(run, 'siphon'), 0);
  assert.equal(spellUsesLeft(run, 'step'), Infinity);
});

test('the Blood Well fills two flasks; the Sigil blesses each way once', async () => {
  const { newRun, NODES } = await import('../src/game/Progression.js');
  const run = newRun();
  run.potions = 0;
  NODES.well.options(run)[1].apply(run);
  assert.equal(run.potions, 2);
  const first = NODES.sigil.options(run);
  assert.equal(first.length, 2);
  first[0].apply(run);
  assert.equal(NODES.sigil.options(run).length, 1);
  NODES.sigil.options(run)[0].apply(run);
  assert.equal(NODES.sigil.options(run).length, 0);
});

test('no long dash anywhere in the game’s words', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))).flat();
  const files = (await walk(new URL('../src', import.meta.url).pathname)).filter((f) => f.endsWith('.js'));
  for (const f of files) assert.ok(!(await readFile(f, 'utf8')).includes('—'), `${f} has a long dash`);
});
