// What each kind of weapon does to a duel, beyond its damage.
//
//   Sword - Momentum & Flow. Every swing that lands builds momentum (up to
//           MOMENTUM_MAX); each point makes swings 4.5% faster. A swing
//           that hits nothing, or a blow you take, throws it all away, and
//           it bleeds off a point a second when you stop landing hits.
//   Axe   - Savagery & Sunder. Every hit sunders the demon (stacks up to
//           SUNDER_MAX, each +8% damage taken and a weaker stance), and an
//           axe shatters a guard outright instead of bouncing off it,
//           leaving the demon reeling and open.
//   Mace  - Impact & Domination. Any hit breaks whatever the demon was doing
//           and throws it into a heavy stumble; a charged blow crashes
//           straight through a guard. Bosses only stumble from heavy blows.

export const MOMENTUM_MAX = 10;
export const MOMENTUM_STEP = 0.045;
export const MOMENTUM_DECAY_AFTER = 3; // seconds without a hit before it bleeds off

export const momentumSpeed = (m) => 1 + MOMENTUM_STEP * Math.min(m, MOMENTUM_MAX);

export const SUNDER_MAX = 5;
export const SUNDER_TIME = 7; // seconds a sunder lasts after the last axe hit
export const sunderDamage = (stacks) => 1 + 0.08 * Math.min(stacks, SUNDER_MAX);

// Stumble lengths from a mace (seconds); a guard broken by an axe.
export const STUMBLE = { light: 0.75, heavy: 1.35 };
export const GUARD_BROKEN = 1.5;

// How a blow meets a raised guard: 'shatter' (axe), 'crash' (a charged mace
// blow), or 'bounce' (everything else).
export function guardOutcome(type, heavy, power) {
  if (type === 'axe') return 'shatter';
  if (type === 'mace' && heavy && power >= 0.5) return 'crash';
  return 'bounce';
}
