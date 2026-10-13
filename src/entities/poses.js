import { C, spawnFlame } from '../world/Particles.js';

// Shared by every creature model: how far into an attack its body is, and
// the flame emitters the manifest can put on bones.

// Attack pose weights from the AI state: raise (telegraph), swing (follow
// through).
export function attackWeights(e) {
  const s = e.state;
  if (!e.attack || (s !== 'windup' && s !== 'strike' && s !== 'recover')) return { raise: 0, swing: 0 };
  const k = Math.min(1, e.stateT / Math.max(0.001, e.stateDur));
  if (s === 'windup') return { raise: easeOut(k), swing: 0 };
  if (s === 'strike') return { raise: 1 - k, swing: easeOut(k) };
  return { raise: 0, swing: 1 - easeIn(k) };
}
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const easeIn = (k) => k * k;

export const FLAMES = {
  horn: (ps, p) => spawnFlame(ps, p, { size: 0.42, rise: 1.8, life: 0.55, spread: 0.12 }),
  hornBlue: (ps, p) => spawnFlame(ps, p, { core: C.fireBlue, edge: C.fireEdge, size: 0.24, rise: 1.3, life: 0.4 }),
  green: (ps, p) => spawnFlame(ps, p, { core: C.greenCore, edge: C.greenEdge, size: 0.34, rise: 1.6, life: 0.65, spread: 0.22 }),
  torch: (ps, p) => spawnFlame(ps, p, { size: 0.55, rise: 2.2, life: 0.7, spread: 0.25 }),
  heart: (ps, p) => spawnFlame(ps, p, { size: 0.4, rise: 1.0, life: 0.45, spread: 0.18 }),
  ember: (ps, p) => spawnFlame(ps, p, { core: C.emberHot, edge: C.emberRed, size: 0.16, rise: 1.6, life: 0.6, spread: 0.6 }),
};
