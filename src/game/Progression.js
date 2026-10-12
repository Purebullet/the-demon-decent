import { makeWeapon } from '../entities/Weapons.js';
import { SPELLS, SPELL_IDS, MAX_SPELL_LEVEL } from '../entities/Spells.js';

// Everything a run owns. Death throws this object away: permadeath means
// weapons, spells and every upgrade are gone, and you climb out at the
// surface with a rusted sword.

export function newRun() {
  return {
    floor: 0,
    deepest: 0,
    maxHealth: 100,
    health: 100,
    potions: 1,
    potionCap: 2,
    dmgMul: 1,
    speedMul: 1,
    weapon: makeWeapon('sword', 0),
    spells: { nova: 0, step: 0, siphon: 0 },
    kills: 0,
    startTime: performance.now(),
    dev: false,
  };
}

// The three sanctum nodes. Each offers two choices; take one node per visit.
export const NODES = {
  well: {
    title: 'The Blood Well',
    options: () => [
      { label: '+25 Max Health', apply: (r) => ((r.maxHealth += 25), (r.health += 25)) },
      { label: '+1 Potion Capacity (and a full flask)', apply: (r) => (r.potionCap++, (r.potions = Math.min(r.potionCap, r.potions + 1))) },
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
      { label: '+15% Weapon Damage', apply: (r) => (r.dmgMul *= 1.15) },
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
