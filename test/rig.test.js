import test from 'node:test';
import assert from 'node:assert/strict';
import { RIGS } from '../scripts/rigs.mjs';
import { clipsFor } from '../scripts/motions.mjs';
import { ENEMY_TYPES } from '../src/entities/EnemyTypes.js';
import { BOSS_TYPES } from '../src/entities/Bosses.js';
import { CHARACTERS } from '../src/assets/manifest.js';

test('every creature clip samples to finite poses', () => {
  for (const [id, def] of Object.entries(RIGS)) {
    for (const clip of clipsFor(def)) {
      for (let k = 0; k <= 20; k++) {
        const pose = clip.sample(k / 20);
        for (const [bone, v] of Object.entries(pose)) assert.ok(v.every(Number.isFinite), `${id} ${clip.name} ${bone} at ${k / 20}: ${v}`);
      }
    }
  }
});

test('every attack of every enemy and boss has a clip on its model', () => {
  const rigFor = (asset) => Object.values(RIGS).find((r) => r.out === CHARACTERS[asset].model);
  for (const t of [...Object.values(ENEMY_TYPES), ...Object.values(BOSS_TYPES)]) {
    const rig = rigFor(t.asset);
    assert.ok(rig, `${t.name}: no rig makes ${CHARACTERS[t.asset].model}`);
    for (const a of t.attacks) assert.ok(rig.attacks[a.name], `${t.name}: no clip for "${a.name}"`);
  }
});
