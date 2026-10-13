import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOORS, BOSS_FLOORS } from '../src/world/LevelData.js';
import { parseLevel, validateLevel } from '../src/world/levelParser.js';

test('there are 20 floors with bosses on 10 and 20', () => {
  assert.equal(FLOORS.length, 20);
  assert.deepEqual(BOSS_FLOORS, [10, 20]);
});

test('every floor is playable: spawn, exit, and every enemy and potion reachable', () => {
  const problems = FLOORS.flatMap((f, i) => validateLevel(f, i));
  assert.deepEqual(problems, []);
});

test('hazards only appear on the deep floors (11+) and the final boss arena', () => {
  FLOORS.forEach((f, i) => {
    const lvl = parseLevel(f);
    const hazards = lvl.lava.length + lvl.spikes.length + lvl.vents.length;
    const burrowed = lvl.enemies.filter((e) => e.burrowed).length;
    if (i + 1 <= 10) {
      assert.equal(hazards, 0, `floor ${i + 1} has hazards`);
      assert.equal(burrowed, 0, `floor ${i + 1} has burrowed ambushers`);
    } else if (i + 1 < 20) {
      assert.ok(hazards > 0, `floor ${i + 1} should have hazards`);
      assert.ok(f.swarm, `floor ${i + 1} should use swarm behaviour`);
    }
  });
});

test('deep floors are faster and tighter, not just tougher', () => {
  for (let i = 11; i < 19; i++) {
    const a = FLOORS[i - 1];
    const b = FLOORS[i];
    assert.ok(b.speed >= a.speed, `speed regresses on floor ${i + 1}`);
    assert.ok(b.windup <= a.windup, `windup loosens on floor ${i + 1}`);
  }
  assert.ok(FLOORS[10].speed > FLOORS[8].speed);
  assert.ok(FLOORS[10].windup < FLOORS[8].windup);
});

test('every creature in the maps and boss summons has stats and a model slot', async () => {
  const { ENEMY_TYPES } = await import('../src/entities/EnemyTypes.js');
  const { BOSS_TYPES } = await import('../src/entities/Bosses.js');
  const { CHARACTERS } = await import('../src/assets/manifest.js');
  const used = new Set();
  for (const def of FLOORS) for (const e of parseLevel(def).enemies) used.add(e.type);
  for (const b of Object.values(BOSS_TYPES)) for (const s of b.summons) s.spawn.forEach((t) => used.add(t));
  for (const t of used) assert.ok(ENEMY_TYPES[t], `no stats for ${t}`);
  for (const t of [...Object.values(ENEMY_TYPES), ...Object.values(BOSS_TYPES)]) assert.ok(CHARACTERS[t.asset], `no model slot for ${t.name}`);
  assert.equal(Object.keys(CHARACTERS).length, 7);
});
