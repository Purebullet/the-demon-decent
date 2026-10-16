import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOORS, BOSS_FLOORS } from '../src/world/LevelData.js';
import { parseLevel, validateLevel } from '../src/world/levelParser.js';

test('there are 20 floors with bosses on 5, 10 and 20', () => {
  assert.equal(FLOORS.length, 20);
  assert.deepEqual(BOSS_FLOORS, [5, 10, 20]);
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
  assert.equal(Object.keys(CHARACTERS).length, 8);
});

test('every floor has a look, and every look dresses with props that exist', async () => {
  const { LOOKS } = await import('../src/world/themes.js');
  const { PROPS } = await import('../src/assets/manifest.js');
  for (const [i, def] of FLOORS.entries()) assert.ok(LOOKS[def.look], `floor ${i + 1} (${def.name}) has an unknown look "${def.look}"`);
  for (const [name, look] of Object.entries(LOOKS)) {
    for (const [id, , where] of look.decor) {
      assert.ok(PROPS[id], `${name}: no prop "${id}"`);
      assert.ok(['edge', 'wall', 'hang'].includes(where), `${name}: ${id} has unknown placement "${where}"`);
    }
    for (const id of [...look.pillars, ...Object.keys(look.walls)]) assert.ok(PROPS[id], `${name}: no prop "${id}"`);
    // Hanging props must leave room to walk under them.
    assert.ok(look.ceiling >= 6, `${name}: ceiling too low`);
  }
});

test('every floor has at least two dead ends for chests, and alcoves keep it playable', async () => {
  const { carveAlcoves } = await import('../src/world/levelParser.js');
  const { mulberry32 } = await import('../src/core/rng.js');
  FLOORS.forEach((f, i) => {
    const d = parseLevel(f);
    carveAlcoves(d, d.floorTiles.length > 160 ? 3 : 2, mulberry32((i + 1) * 4111));
    const ends = d.floorTiles.filter((t) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => d.nav.isWalkable(t.c + a, t.r + b)).length === 1);
    assert.ok(ends.length >= 2, `floor ${i + 1} has ${ends.length} dead ends`);
    // The outer border stays sealed.
    for (let c = 0; c < d.cols; c++) assert.ok(!d.nav.isWalkable(c, 0) && !d.nav.isWalkable(c, d.rows - 1));
  });
});

test('the Deep (floor 6 on) is tougher, and dressed in its own rock and props', async () => {
  const { floorDef, DEEP_FROM } = await import('../src/world/LevelData.js');
  const { DEEP } = await import('../src/world/themes.js');
  const { PROPS } = await import('../src/assets/manifest.js');
  assert.equal(DEEP_FROM, 6);
  assert.equal(floorDef(5), FLOORS[4]);
  const f6 = floorDef(6);
  assert.equal(f6.hp, FLOORS[5].hp * 1.5);
  assert.ok(Math.abs(f6.speed / FLOORS[5].speed - 1.05) < 1e-9);
  assert.ok(f6.cooldown < FLOORS[5].cooldown && f6.windup < FLOORS[5].windup);
  for (const id of [...Object.keys(DEEP.walls), ...DEEP.pillars, ...DEEP.decor.map(([id]) => id)]) assert.ok(PROPS[id], `no prop "${id}"`);
});

test('every non-boss floor runs one way, from spawn to exit', () => {
  FLOORS.forEach((f, i) => {
    if (f.boss) return;
    const d = parseLevel(f);
    assert.ok(d.exit.c - d.spawn.c > d.cols * 0.6, `floor ${i + 1}: the exit is not far along from the spawn`);
  });
});

test('nothing solid stands within three tiles of an exit (its gate stands there)', () => {
  FLOORS.forEach((f, i) => {
    if (f.boss) return;
    const d = parseLevel(f);
    for (const p of [...d.pillars, ...d.braziers]) {
      const c = Math.floor(p.x / 2);
      const r = Math.floor(p.z / 2);
      assert.ok(Math.max(Math.abs(c - d.exit.c), Math.abs(r - d.exit.r)) > 3, `floor ${i + 1}: something solid by the exit`);
    }
  });
});

test("floor 5 is the Sleeper's hall: a long candle corridor into a round arena", () => {
  const def = FLOORS[4];
  assert.equal(def.boss, 'sleeper');
  const level = parseLevel(def);
  const [c0, c1, r0, r1] = def.hall.corridor;
  // Half a minute or more to walk it.
  assert.ok(((c1 - c0 + 1) * 2) / 5.2 >= 30);
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) assert.ok(level.nav.isWalkable(c, r), `corridor ${c},${r}`);
  const [ac, ar, R] = def.hall.arena;
  assert.equal(level.boss.c, ac);
  assert.equal(level.boss.r, ar);
  for (let r = Math.ceil(ar - R); r <= ar + R; r++) {
    for (let c = Math.ceil(ac - R); c <= ac + R; c++) if ((c - ac) ** 2 + (r - ar) ** 2 <= (R - 0.5) ** 2) assert.ok(level.nav.isWalkable(c, r), `arena ${c},${r}`);
  }
  // The way out lies behind him, across the arena.
  assert.ok(level.exit.c > ac);
});
