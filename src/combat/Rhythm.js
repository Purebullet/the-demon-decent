// The rhythm of the blade. There is no stamina: what limits a fighter is
// timing. Every swing has a windup (W), the arc itself (A) and a recovery
// (R); the arc completes at W + A.
//
//   press inside the window around W + A  -> Perfect Chain: the next swing
//                                            flows out of this one at once,
//                                            harder, brighter, deeper, and
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
//
// The beat never moves: a perfect swing keeps the plain one's timings, so
// one steady rhythm per weapon (the ring round the crosshair fills to it,
// and burns gold in the window). And it is kept in real time: the freeze of
// a blow landing (hit-stop) holds the blade but not the beat, so a press on
// the rhythm is judged the same whether the last swing struck or missed.

// The window, in seconds either side of the moment the arc completes: it
// opens as the arc (and the ring) fills, a hair early for the eye's sake.
export const WINDOW_EARLY = 0.02;
export const WINDOW_LATE = 0.16;
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
  // `rt`: time since the swing began in real time (hit-stop and all); the
  // window opens by it and closes by the blade's own time, so a freeze
  // only ever makes it longer.
  if ((swing.rt ?? swing.t) < done - WINDOW_EARLY * widen) return 'mash';
  if (swing.t <= done + WINDOW_LATE * widen) return swing.fumbled ? 'late' : 'perfect';
  return 'late';
}

// How far the swing is toward its beat (0..1, the ring's fill), and whether
// a press now would be perfect (the ring burning gold).
export function beat(swing, widen = 1) {
  if (!swing || swing.bounced) return { fill: 0, window: false };
  const done = swing.W + swing.A;
  return { fill: Math.min(1, Math.max(0, (swing.rt ?? swing.t) / done)), window: classifyPress(swing, widen) === 'perfect' };
}

// Timings of a light swing from the weapon's base timings and how it began.
// `speed` is every other multiplier (attack-speed boons).
export function lightTiming(def, { sluggish = false, speed = 1 } = {}) {
  let W = def.windup * LIGHT_SPEED;
  let A = def.active * LIGHT_SPEED;
  let R = def.recover * LIGHT_SPEED;
  // (A perfect swing keeps these: the beat stays put however long the chain.)
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
