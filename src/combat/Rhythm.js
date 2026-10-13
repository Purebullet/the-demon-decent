// The rhythm of the blade. There is no stamina: what limits a fighter is
// timing. Every swing has a windup (W), the arc itself (A) and a recovery
// (R); the arc completes at W + A.
//
//   press inside the window around W + A  -> Perfect Chain: the next swing
//                                            flows out of this one at once,
//                                            faster, brighter, deeper, and
//                                            more likely to proc
//   press any earlier (or during a heavy) -> fumble: thrown away, the chain
//                                            breaks, and the swing that
//                                            follows is sluggish and leaves
//                                            you open (you take more damage
//                                            and demons see the opening)
//   press later, in the recovery          -> an ordinary swing, at once
//   press with no swing running           -> an ordinary swing, at once
//
// Nothing is ever queued: a swing starts on the press that asks for it, or
// not at all. A swing that was fumbled cannot be chained perfectly, so
// mashing never stumbles into a Perfect Chain by luck.

// The window, in seconds either side of the moment the arc completes.
export const WINDOW_EARLY = 0.07;
export const WINDOW_LATE = 0.11;
export const CHAIN_MAX = 5;

// Light swings run at 75% of a weapon's base timings (a quarter faster).
export const LIGHT_SPEED = 0.75;

// Where a press lands relative to the swing in progress (`widen` scales the
// window, e.g. the Grim Metronome relic).
export function classifyPress(swing, widen = 1) {
  if (!swing) return 'idle';
  // A weapon thrown back by a guard is not yours until it settles. (A heavy
  // blow follows the same rule as a light one: presses during its windup and
  // arc are fumbles; a press as its arc completes is a perfect follow-through.)
  if (swing.bounced) return 'mash';
  const done = swing.W + swing.A;
  if (swing.t < done - WINDOW_EARLY * widen) return 'mash';
  if (swing.t <= done + WINDOW_LATE * widen) return swing.fumbled ? 'late' : 'perfect';
  return 'late';
}

// Timings of a light swing from the weapon's base timings and how it began.
// `speed` is every other multiplier (attack-speed boons, sword momentum).
export function lightTiming(def, { perfect = false, chain = 0, sluggish = false, speed = 1 } = {}) {
  let W = def.windup * LIGHT_SPEED;
  let A = def.active * LIGHT_SPEED;
  let R = def.recover * LIGHT_SPEED;
  if (perfect) {
    // Flowing out of the last arc: almost no windup, a quicker arc.
    const k = 1 - 0.04 * Math.min(chain, CHAIN_MAX);
    W *= 0.5 * k;
    A *= 0.9 * k;
  }
  if (sluggish) {
    W *= 1.6;
    A *= 1.15;
    R *= 1.45;
  }
  return { W: W / speed, A: A / speed, R: R / speed };
}

// What a Perfect Chain of `chain` links adds to a swing.
export function chainBonus(chain) {
  const c = Math.min(chain, CHAIN_MAX);
  return {
    damage: 1 + 0.06 * c,
    proc: 1 + 0.6 * c, // multiplies every proc chance
    glow: c ? 0.6 + 0.12 * c : 0.32, // weapon trail brightness
    pitch: 1 - 0.045 * c, // audio rate: deeper with each link
  };
}

// Damage taken while a sluggish swing is running.
export const EXPOSED_DAMAGE = 1.3;
