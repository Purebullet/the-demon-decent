import test from 'node:test';
import assert from 'node:assert/strict';
import { newLevels, xpForKill, gainXp, spendPoint, xpToNext, damageMul, swingSpeedMul, takenMul, MAX_LEVEL, STAT_CAP, STAT_IDS } from '../src/game/Levels.js';
import { newRun } from '../src/game/Progression.js';
import { FLOORS } from '../src/world/LevelData.js';

const ENEMY = { g: 'ghoul', G: 'ghoul', c: 'fiend', b: 'brute', d: 'hound', m: 'witch' };

test('three of the first floor’s stalkers make the first level, not two', () => {
  const run = newLevels();
  const stalker = xpForKill({ typeKey: 'ghoul' }, 1);
  assert.equal(gainXp(run, stalker * 2), 0);
  assert.equal(gainXp(run, stalker), 1);
  assert.equal(run.level, 1);
  assert.equal(run.points, 1);
});

test('bigger demons, elites and bosses are worth more; summons less', () => {
  const xp = (e, f = 5) => xpForKill(e, f);
  assert.ok(xp({ typeKey: 'brute' }) > xp({ typeKey: 'fiend' }) && xp({ typeKey: 'fiend' }) > xp({ typeKey: 'ghoul' }));
  assert.equal(xp({ typeKey: 'brute', elite: true }), 2 * xp({ typeKey: 'brute' }));
  assert.ok(xp({ typeKey: 'ghoul', summoned: true }) < xp({ typeKey: 'ghoul' }));
  assert.ok(xp({ bossKey: 'azrakel' }, 20) > xp({ bossKey: 'gorvath' }, 10));
  assert.ok(xp({ typeKey: 'ghoul' }, 15) > xp({ typeKey: 'ghoul' }, 1));
});

test('ten points at most in each stat, thirty levels in all, and what they buy', () => {
  const run = newRun();
  assert.equal(gainXp(run, 1e7), MAX_LEVEL);
  assert.equal(run.level, MAX_LEVEL);
  assert.equal(gainXp(run, 1e5), 0);
  for (const id of STAT_IDS) {
    for (let k = 0; k < STAT_CAP; k++) assert.ok(spendPoint(run, id));
    assert.equal(spendPoint(run, id), false);
  }
  assert.equal(run.points, 0);
  assert.ok(Math.abs(damageMul(run) - 1.25) < 1e-9);
  assert.ok(Math.abs(takenMul(run) - 0.75) < 1e-9);
  assert.ok(Math.abs(swingSpeedMul(run) - 1.1) < 1e-9);
});

test('a full descent reaches level 30, and not before the deep floors', () => {
  const run = newLevels();
  let byFloor10 = 0;
  FLOORS.forEach((f, i) => {
    let xp = 0;
    for (const ch of (f.map || []).join('')) if (ENEMY[ch]) xp += xpForKill({ typeKey: ENEMY[ch] }, i + 1);
    if (f.boss) xp += xpForKill({ bossKey: f.boss }, i + 1);
    gainXp(run, xp);
    if (i + 1 === 10) byFloor10 = run.level;
  });
  assert.equal(run.level, MAX_LEVEL);
  assert.ok(byFloor10 > 10 && byFloor10 < 25, `level ${byFloor10} at floor 10`);
  assert.equal(xpToNext(0), 30);
});

test('a run carries 3 potions, and the Blood Well raises that to 4 at most', async () => {
  const { newRun, NODES, POTION_CAP, MAX_POTION_CAP } = await import('../src/game/Progression.js');
  const run = newRun();
  assert.equal(run.potionCap, 3);
  assert.equal(POTION_CAP, 3);
  assert.equal(MAX_POTION_CAP, 4);
  const gift = () => NODES.well.options(run)[1];
  gift().apply(run);
  assert.equal(run.potionCap, 4);
  run.potions = 1;
  assert.equal(gift().label, 'Fill every flask');
  gift().apply(run);
  assert.equal(run.potionCap, 4);
  assert.equal(run.potions, 4);
});
