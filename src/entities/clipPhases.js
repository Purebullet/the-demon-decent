// Shared by the rig script (scripts/rig.mjs), which authors the creatures'
// clips, and GltfCharacter, which plays them from the AI state.
//
// Every attack clip is one second long with its phases at fixed points:
// the telegraph runs from 0 to WINDUP, the blow lands between WINDUP and
// STRIKE, and the creature recovers until 1. The game maps each attack's own
// windup, strike and recover times onto those spans, so the claw visibly
// connects exactly while the strike volume is live, however the floor tunes
// the timings.
export const WINDUP = 0.42;
export const STRIKE = 0.6;

// Clip time (0..1) for an attack state and its progress k (0..1).
export function attackClipTime(state, k) {
  if (state === 'windup') return WINDUP * k;
  if (state === 'strike') return WINDUP + (STRIKE - WINDUP) * k;
  return STRIKE + (1 - STRIKE) * k;
}
