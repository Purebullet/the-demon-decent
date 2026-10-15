import { makeWeapon } from '../entities/Weapons.js';
import { SPELLS, SPELL_IDS, MAX_SPELL_LEVEL } from '../entities/Spells.js';
import { newLevels } from './Levels.js';

// Everything a run owns. Death throws this object away: permadeath means
// weapons, spells and every upgrade are gone, and you climb out at the
// surface with a rusted sword.

// Flasks a run can carry: three to start, four with the Blood Well's gift.
export const POTION_CAP = 3;
export const MAX_POTION_CAP = 4;

export function newRun() {
  return {
    floor: 0,
    deepest: 0,
    maxHealth: 100,
    health: 100,
    potions: 1,
    potionCap: POTION_CAP,
    dmgMul: 1,
    speedMul: 1,
    weapon: makeWeapon('sword'),
    // Shade Step (Space) is everyone's from the start.
    spells: { nova: 0, step: 1, siphon: 0 },
    // Learned skills (Phantom Step: dodge on a double tap) and carried relics
    // (id -> how many: combat/Relics.js).
    skills: {},
    relics: {},
    kills: 0,
    // Level, experience toward the next, unspent points and where they went
    // (game/Levels.js).
    ...newLevels(),
    best: { chain: 0, counters: 0, procs: 0 },
    startTime: performance.now(),
    dev: false,
  };
}

// The three sanctum nodes. Each offers two choices; take one node per visit.
export const NODES = {
  well: {
    title: 'The Blood Well',
    options: (run) => [
      { label: '+25 Max Health', apply: (r) => ((r.maxHealth += 25), (r.health += 25)) },
      run.potionCap < MAX_POTION_CAP
        ? { label: '+1 Potion Capacity (and a full flask)', apply: (r) => ((r.potionCap = Math.min(MAX_POTION_CAP, r.potionCap + 1)), (r.potions = Math.min(r.potionCap, r.potions + 1))) }
        : { label: 'Fill every flask', apply: (r) => (r.potions = r.potionCap) },
    ],
  },
  circle: {
    title: 'The Magic Circle',
    options: (run) => {
      const opts = [];
      for (const id of SPELL_IDS) {
        const lvl = run.spells[id];
        if (lvl >= MAX_SPELL_LEVEL) continue;
        const S = SPELLS[id];
        opts.push({
          label: lvl === 0 ? `Learn ${S.name} [${S.label}]` : `${S.name} to level ${lvl + 1}`,
          detail: S.describe(S.levels[lvl]),
          apply: (r) => r.spells[id]++,
        });
      }
      // Offer two at random.
      for (let i = opts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [opts[i], opts[j]] = [opts[j], opts[i]];
      }
      return opts.slice(0, 2);
    },
  },
  sigil: {
    title: 'The Burning Sigil',
    options: () => [
      { label: '+10% Weapon Damage', apply: (r) => (r.dmgMul *= 1.1) },
      { label: '+12% Attack Speed', apply: (r) => (r.speedMul *= 1.12) },
    ],
  },
};

// Records a reached floor; returns true if it is a new record.
export function recordDepth(scores, floor) {
  if (floor <= scores.best) return false;
  scores.best = floor;
  return true;
}
