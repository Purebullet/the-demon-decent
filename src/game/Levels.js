// Levels: every demon slain is experience, and each level gained is a point
// to put into Attack, Defence or Agility, ten at most in each, so thirty
// levels in all. Three of the gaunt stalkers on the first floor make the
// first level; bigger demons, elites and the lords below are worth more, and
// every kind is worth a little more the deeper it is met. A run's levels die
// with it, like everything else it carried.

export const MAX_LEVEL = 30;
export const STAT_CAP = 10;

// What a point buys.
export const LEVEL_STATS = {
  attack: { name: 'Attack', per: 0.025, text: '+2.5% damage', color: '#ff7a3a' },
  defence: { name: 'Defence', per: 0.025, text: '-2.5% damage taken', color: '#7ab0ff' },
  agility: { name: 'Agility', per: 0.01, text: '+1% attack speed', color: '#9aff7a' },
};
export const STAT_IDS = Object.keys(LEVEL_STATS);

// Experience for each kind of demon, before its depth.
const XP = { ghoul: 10, hound: 14, fiend: 18, witch: 20, brute: 35, gorvath: 250, azrakel: 500 };

export function newLevels() {
  return { level: 0, xp: 0, points: 0, stats: { attack: 0, defence: 0, agility: 0 } };
}

// Experience from level `level` to the next: 30, then 10 more each time.
export function xpToNext(level) {
  return 30 + 10 * level;
}

// What a slain demon is worth on a floor: twice for an elite, half for one
// a boss summoned.
export function xpForKill(e, floor) {
  const base = XP[e.bossKey || e.typeKey] ?? 10;
  const k = (e.elite ? 2 : 1) * (e.summoned ? 0.5 : 1) * (1 + 0.05 * Math.max(0, floor - 1));
  return Math.round(base * k);
}

// Add experience; returns how many levels it made (each one a point to spend).
export function gainXp(run, amount) {
  let gained = 0;
  if (run.level >= MAX_LEVEL) return 0;
  run.xp += amount;
  while (run.level < MAX_LEVEL && run.xp >= xpToNext(run.level)) {
    run.xp -= xpToNext(run.level);
    run.level++;
    run.points++;
    gained++;
  }
  if (run.level >= MAX_LEVEL) run.xp = 0;
  return gained;
}

// Spend a point; false if there is none, or that stat is full.
export function spendPoint(run, id) {
  if (run.points <= 0 || !LEVEL_STATS[id] || run.stats[id] >= STAT_CAP) return false;
  run.stats[id]++;
  run.points--;
  return true;
}

// What the run's points (and the sanctum's blessings) make of a blow dealt,
// a swing's speed, and a blow taken.
export const damageMul = (run) => run.dmgMul * (1 + LEVEL_STATS.attack.per * (run.stats?.attack || 0));
export const swingSpeedMul = (run) => run.speedMul * (1 + LEVEL_STATS.agility.per * (run.stats?.agility || 0));
export const takenMul = (run) => 1 - LEVEL_STATS.defence.per * (run.stats?.defence || 0);

// What a fallen run leaves the next: half its level (rounded down), kept
// where its points had gone as nearly as halving allows (each stat halved,
// the odd points to the stats that lost a half). Experience starts over.
export function legacyOf(run) {
  const keep = Math.floor((run.level || 0) / 2);
  const stats = { attack: 0, defence: 0, agility: 0 };
  const halves = STAT_IDS.map((id) => ({ id, half: (run.stats?.[id] || 0) / 2 }));
  let left = keep;
  for (const h of halves) {
    stats[h.id] = Math.min(Math.floor(h.half), left);
    left -= stats[h.id];
  }
  for (const h of halves) {
    if (left > 0 && h.half % 1 > 0 && stats[h.id] < STAT_CAP) {
      stats[h.id]++;
      left--;
    }
  }
  return { level: keep, xp: 0, points: left, stats };
}
