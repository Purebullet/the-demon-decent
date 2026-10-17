// The creatures' animation clips, written as poses over time for the rig
// script (scripts/rig.mjs). A pose maps a bone name to an [x, y, z] rotation
// offset from the rest pose (radians, Euler order YXZ, axes of the model:
// +X the creature's left, +Y up, +Z forward), and 'Bone.p' to a translation.
//
// Every rest rotation is the identity, so the axes mean the same thing on
// every bone: +X rotation swings a hanging limb backward and tips the spine
// forward; Z rolls; Y turns. Motions are written for the left side; `R`
// mirrors them onto the right.
//
// Locomotion clips are one cycle of `u` in 0..1 and the game drives them from
// the creature's stride phase, so the feet keep pace with how far it moves.
// Attack clips put the telegraph, the blow and the recovery at the shared
// marks in src/entities/clipPhases.js.

import { WINDUP as W, STRIKE as S } from '../src/entities/clipPhases.js';

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (k) => k * k * (3 - 2 * k);

function add(pose, key, x = 0, y = 0, z = 0) {
  const a = pose[key] || (pose[key] = [0, 0, 0]);
  a[0] += x;
  a[1] += y;
  a[2] += z;
}
const C = (p, bone, x, y, z) => add(p, bone, x, y, z);
const L = (p, bone, x, y, z) => add(p, `Left${bone}`, x, y, z);
const R = (p, bone, x = 0, y = 0, z = 0) => add(p, `Right${bone}`, x, -y, -z);
const B = (p, bone, x, y, z) => {
  L(p, bone, x, y, z);
  R(p, bone, x, y, z);
};
const T = (p, bone, x, y, z) => add(p, `${bone}.p`, x, y, z);

function blend(a, b, k) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key] || [0, 0, 0];
    const y = b[key] || [0, 0, 0];
    out[key] = [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  }
  return out;
}

function make(fn) {
  const p = {};
  fn?.(p);
  return p;
}

// Key poses at times 0..1, eased between. `fn` writes a pose (null = rest).
// Keys [t, pose, ease]: the way into a key eases smoothly, or with 'in'
// gathers speed all the way to it (a blow landing), or with 'out' arrives
// fast and slows (a follow-through settling).
function keyed(u, keys) {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1][0]) i++;
  const [t0, f0] = keys[i];
  const [t1, f1, ease] = keys[i + 1];
  const r = clamp((u - t0) / Math.max(1e-6, t1 - t0));
  const k = ease === 'in' ? r * r * r : ease === 'out' ? 1 - (1 - r) ** 3 : smooth(r);
  return blend(make(f0), make(f1), k);
}

function merge(...poses) {
  const out = {};
  for (const p of poses) for (const [k, v] of Object.entries(p)) add(out, k, ...v);
  return out;
}

// ------------------------------------------------------------------ bipeds

function bipedIdle(u, d) {
  const a = TAU * u;
  const s = Math.sin(a);
  const i = { breath: 0.04, look: 0.18, ...d.idle };
  return make((p) => {
    C(p, 'Waist', (d.walk?.lean ?? 0) * 0.3 + i.breath * 0.3 * s, 0, 0);
    C(p, 'Chest', i.breath * s, 0, 0);
    C(p, 'Neck', -i.breath * 0.5 * s, i.look * 0.4 * Math.sin(a + 0.8), 0);
    C(p, 'Head', 0.04 * Math.sin(2 * a), i.look * Math.sin(a + 0.6), 0.04 * Math.sin(a));
    B(p, 'Shoulder', 0, 0, i.breath * 0.3 * s);
    B(p, 'Arm', 0.04 * Math.sin(a + 1), 0, 0.05 * s);
    B(p, 'ForeArm', -0.08 - 0.05 * s, 0, 0);
    B(p, 'Hand', 0, 0, 0.08 * Math.sin(2 * a));
    B(p, 'UpLeg', -0.04, 0, 0);
    B(p, 'Leg', 0.08, 0, 0);
    B(p, 'Foot', -0.04, 0, 0);
    hatSway(p, a, 0.12);
  });
}

// One stride: the left foot is planted at u = 0.25 (forward) and swings
// through at u = 0.75.
function bipedGait(u, g) {
  const a = TAU * u;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const liftL = Math.max(0, c);
  const liftR = Math.max(0, -c);
  return make((p) => {
    L(p, 'UpLeg', -g.stride * s - g.crouch, 0, 0);
    R(p, 'UpLeg', g.stride * s - g.crouch, 0, 0);
    L(p, 'Leg', g.knee * liftL + g.crouch * 1.6, 0, 0);
    R(p, 'Leg', g.knee * liftR + g.crouch * 1.6, 0, 0);
    L(p, 'Foot', -0.5 * g.knee * liftL + g.stride * 0.5 * s - g.crouch * 0.6, 0, 0);
    R(p, 'Foot', -0.5 * g.knee * liftR - g.stride * 0.5 * s - g.crouch * 0.6, 0, 0);
    C(p, 'Hips', 0, g.twist * s, g.sway * s);
    C(p, 'Waist', g.lean, -g.twist * 0.6 * s, -g.sway * 0.8 * s);
    C(p, 'Chest', g.lean * 0.4 + 0.03 * Math.cos(2 * a), -g.twist * 0.9 * s, 0);
    C(p, 'Neck', -g.lean * 0.5, g.twist * 0.5 * s, 0);
    C(p, 'Head', -g.lean * 0.6 - 0.04 * Math.cos(2 * a), g.twist * 0.4 * s, 0);
    L(p, 'Arm', g.arm * s, 0, g.armOut);
    R(p, 'Arm', -g.arm * s, 0, g.armOut);
    L(p, 'ForeArm', -g.elbow - g.elbow * 0.4 * Math.max(0, -s), 0, 0);
    R(p, 'ForeArm', -g.elbow - g.elbow * 0.4 * Math.max(0, s), 0, 0);
    hatSway(p, a, 0.18);
  });
}

function hatSway(p, a, k) {
  C(p, 'Hat', 0.3 * k * Math.sin(a - 0.6), 0, k * Math.sin(a - 0.9));
  C(p, 'HatTip', 0.5 * k * Math.sin(a - 1.4), 0, 1.4 * k * Math.sin(a - 1.6));
}

const BIPED_ATTACKS = {
  // One arm (the right) wound back and swept across the front.
  swipe: (u, d) =>
    keyed(u, [
      [0, null],
      [W * 0.85, (p) => {
        C(p, 'Waist', 0.05, -0.3, 0);
        C(p, 'Chest', -0.1, -0.45, 0);
        C(p, 'Head', 0, 0.35, 0);
        R(p, 'Arm', -0.2, 0.8, 1.2);
        R(p, 'ForeArm', -0.7, 0, 0);
        L(p, 'Arm', -0.4, 0, 0.3);
        L(p, 'ForeArm', -0.5, 0, 0);
        B(p, 'UpLeg', -0.2, 0, 0);
        B(p, 'Leg', 0.35, 0, 0);
      }],
      [W, (p) => {
        C(p, 'Waist', 0.05, -0.35, 0);
        C(p, 'Chest', -0.1, -0.5, 0);
        C(p, 'Head', 0, 0.4, 0);
        R(p, 'Arm', -0.25, 0.9, 1.25);
        R(p, 'ForeArm', -0.75, 0, 0);
        L(p, 'Arm', -0.4, 0, 0.3);
        L(p, 'ForeArm', -0.5, 0, 0);
        B(p, 'UpLeg', -0.22, 0, 0);
        B(p, 'Leg', 0.38, 0, 0);
      }],
      [(W + S) / 2, (p) => {
        C(p, 'Waist', 0.15, 0.05, 0);
        C(p, 'Chest', 0.1, 0.15, 0);
        R(p, 'Arm', -0.4, -0.5, 1.25);
        R(p, 'ForeArm', -0.25, 0, 0);
        L(p, 'Arm', -0.2, 0, 0.3);
        T(p, 'Hips', 0, 0, 0.03);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.25, 0.4, 0);
        C(p, 'Chest', 0.15, 0.5, 0);
        C(p, 'Head', 0, -0.35, 0);
        R(p, 'Arm', -0.3, -1.4, 1.0);
        R(p, 'ForeArm', -0.35, 0, 0);
        L(p, 'Arm', 0.2, 0, 0.4);
        B(p, 'UpLeg', -0.25, 0, 0);
        B(p, 'Leg', 0.4, 0, 0);
        T(p, 'Hips', 0, 0, 0.05);
      }],
      [0.78, (p) => {
        C(p, 'Waist', 0.2, 0.3, 0);
        C(p, 'Chest', 0.1, 0.35, 0);
        R(p, 'Arm', -0.2, -1.1, 0.8);
        R(p, 'ForeArm', -0.4, 0, 0);
        T(p, 'Hips', 0, 0, 0.04);
      }],
      [1, null],
    ]),

  // Both arms raised over the head and brought down together.
  slam: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', -0.3, 0, 0);
        C(p, 'Chest', -0.25, 0, 0);
        C(p, 'Neck', 0.15, 0, 0);
        C(p, 'Head', 0.2, 0, 0);
        B(p, 'Shoulder', 0, 0, 0.2);
        B(p, 'Arm', -2.1, 0, 0.2);
        B(p, 'ForeArm', -0.9, 0, 0);
        B(p, 'UpLeg', -0.1, 0, 0);
        B(p, 'Leg', 0.15, 0, 0);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.55, 0, 0);
        C(p, 'Chest', 0.35, 0, 0);
        C(p, 'Neck', -0.2, 0, 0);
        C(p, 'Head', -0.35, 0, 0);
        B(p, 'Arm', -0.95, 0, 0.15);
        B(p, 'ForeArm', -0.15, 0, 0);
        B(p, 'UpLeg', -0.45, 0, 0);
        B(p, 'Leg', 0.8, 0, 0);
        B(p, 'Foot', -0.35, 0, 0);
        T(p, 'Hips', 0, 0, 0.05);
      }],
      [0.8, (p) => {
        C(p, 'Waist', 0.45, 0, 0);
        C(p, 'Chest', 0.3, 0, 0);
        C(p, 'Head', -0.3, 0, 0);
        B(p, 'Arm', -0.8, 0, 0.15);
        B(p, 'ForeArm', -0.2, 0, 0);
        B(p, 'UpLeg', -0.4, 0, 0);
        B(p, 'Leg', 0.7, 0, 0);
        B(p, 'Foot', -0.3, 0, 0);
        T(p, 'Hips', 0, 0, 0.04);
      }],
      [1, null],
    ]),

  // The right arm cocked back, thrown forward, then yanked back (the pull).
  lash: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', -0.05, -0.25, 0);
        C(p, 'Chest', -0.1, -0.5, 0);
        C(p, 'Head', 0, 0.45, 0);
        R(p, 'Arm', 0.9, 0, 0.5);
        R(p, 'ForeArm', -1.5, 0, 0);
        L(p, 'Arm', -0.5, 0, 0.3);
        L(p, 'ForeArm', -0.4, 0, 0);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.2, 0.2, 0);
        C(p, 'Chest', 0.2, 0.4, 0);
        C(p, 'Head', 0, -0.4, 0);
        R(p, 'Arm', -1.55, -0.2, 0.15);
        R(p, 'ForeArm', -0.05, 0, 0);
        R(p, 'Hand', 0.3, 0, 0);
        L(p, 'Arm', 0.3, 0, 0.35);
        B(p, 'UpLeg', -0.25, 0, 0);
        B(p, 'Leg', 0.4, 0, 0);
        T(p, 'Hips', 0, 0, 0.06);
      }],
      [0.78, (p) => {
        C(p, 'Waist', -0.1, -0.2, 0);
        C(p, 'Chest', -0.15, -0.3, 0);
        R(p, 'Arm', 0.5, 0, 0.4);
        R(p, 'ForeArm', -1.3, 0, 0);
        R(p, 'Hand', -0.3, 0, 0);
        T(p, 'Hips', 0, 0, -0.03);
      }],
      [1, null],
    ]),

  // A spell thrown from the right hand (or the staff in it).
  cast: (u, d) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', -0.2, 0, 0);
        C(p, 'Chest', -0.15, -0.25, 0);
        C(p, 'Head', -0.1, 0.2, 0);
        if (d.staff) {
          // Staff lifted high and upright.
          R(p, 'Arm', -1.0, 0, 0.25);
          R(p, 'ForeArm', -0.5, 0, 0);
          R(p, 'Hand', 1.45, 0, 0);
        } else {
          R(p, 'Arm', -2.1, 0, 0.3);
          R(p, 'ForeArm', -0.6, 0, 0);
        }
        L(p, 'Arm', -0.9, 0, 0.6);
        L(p, 'ForeArm', -0.7, 0, 0);
        L(p, 'Hand', 0, 0, 0.4);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.25, 0, 0);
        C(p, 'Chest', 0.2, 0.2, 0);
        C(p, 'Head', 0.05, -0.15, 0);
        if (d.staff) {
          // The crystal thrust at the target.
          R(p, 'Arm', -0.75, 0, 0.1);
          R(p, 'ForeArm', -0.2, 0, 0);
          R(p, 'Hand', 1.85, 0, 0);
        } else {
          R(p, 'Arm', -1.4, 0, 0.05);
          R(p, 'ForeArm', -0.1, 0, 0);
          R(p, 'Hand', 0.4, 0, 0);
        }
        L(p, 'Arm', -0.4, 0, 0.3);
        B(p, 'UpLeg', -0.2, 0, 0);
        B(p, 'Leg', 0.3, 0, 0);
        T(p, 'Hips', 0, 0, 0.04);
      }],
      [0.8, (p) => {
        C(p, 'Waist', 0.15, 0, 0);
        C(p, 'Chest', 0.1, 0.1, 0);
        if (d.staff) {
          R(p, 'Arm', -0.6, 0, 0.1);
          R(p, 'ForeArm', -0.2, 0, 0);
          R(p, 'Hand', 0.9, 0, 0);
        } else R(p, 'Arm', -0.9, 0, 0.05);
      }],
      [1, null],
    ]),

  // Arms drawn in, then flung wide (a burst that throws you back).
  burst: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', 0.35, 0, 0);
        C(p, 'Chest', 0.25, 0, 0);
        C(p, 'Head', 0.2, 0, 0);
        B(p, 'Arm', -0.6, 0, -0.25);
        B(p, 'ForeArm', -1.5, 0, 0);
        B(p, 'UpLeg', -0.35, 0, 0);
        B(p, 'Leg', 0.6, 0, 0);
        B(p, 'Foot', -0.25, 0, 0);
      }],
      [S, (p) => {
        C(p, 'Waist', -0.3, 0, 0);
        C(p, 'Chest', -0.3, 0, 0);
        C(p, 'Head', -0.35, 0, 0);
        B(p, 'Arm', -0.3, 0, 1.45);
        B(p, 'ForeArm', -0.1, 0, 0);
        B(p, 'Hand', 0, 0, 0.4);
        hatKick(p);
      }],
      [0.8, (p) => {
        C(p, 'Waist', -0.15, 0, 0);
        C(p, 'Chest', -0.15, 0, 0);
        B(p, 'Arm', -0.2, 0, 0.9);
      }],
      [1, null],
    ]),

  // A staff lifted in both hands and driven down into the ground.
  staffSlam: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', -0.25, 0.2, 0);
        C(p, 'Chest', -0.2, 0.25, 0);
        C(p, 'Head', -0.15, -0.2, 0);
        R(p, 'Arm', -1.3, 0, 0.2);
        R(p, 'ForeArm', -0.6, 0, 0);
        R(p, 'Hand', 1.9, 0, 0);
        L(p, 'Arm', -1.5, -0.5, 0.2);
        L(p, 'ForeArm', -0.9, 0, 0);
        hatKick(p);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.4, 0, 0);
        C(p, 'Chest', 0.25, 0, 0);
        C(p, 'Head', -0.2, 0, 0);
        R(p, 'Arm', -0.35, 0, 0.1);
        R(p, 'ForeArm', -0.35, 0, 0);
        R(p, 'Hand', 0.7, 0, 0);
        L(p, 'Arm', -0.7, -0.4, 0.1);
        L(p, 'ForeArm', -0.6, 0, 0);
        B(p, 'UpLeg', -0.35, 0, 0);
        B(p, 'Leg', 0.6, 0, 0);
        B(p, 'Foot', -0.25, 0, 0);
        C(p, 'Hat', 0.2, 0, -0.1);
        C(p, 'HatTip', 0.4, 0, -0.3);
      }],
      [0.8, (p) => {
        C(p, 'Waist', 0.3, 0, 0);
        C(p, 'Chest', 0.2, 0, 0);
        R(p, 'Arm', -0.3, 0, 0.1);
        R(p, 'ForeArm', -0.3, 0, 0);
        R(p, 'Hand', 0.6, 0, 0);
        B(p, 'UpLeg', -0.3, 0, 0);
        B(p, 'Leg', 0.5, 0, 0);
      }],
      [1, null],
    ]),

  // The right foot raised high and stamped down.
  stomp: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        R(p, 'UpLeg', -1.15, 0, 0.15);
        R(p, 'Leg', 1.35, 0, 0);
        R(p, 'Foot', -0.2, 0, 0);
        L(p, 'UpLeg', -0.15, 0, 0);
        L(p, 'Leg', 0.25, 0, 0);
        C(p, 'Waist', -0.15, 0, -0.12);
        C(p, 'Chest', -0.1, 0, -0.05);
        B(p, 'Arm', 0, 0, 0.7);
        B(p, 'ForeArm', -0.5, 0, 0);
      }],
      [S, (p) => {
        R(p, 'UpLeg', -0.2, 0, 0.05);
        R(p, 'Leg', 0.35, 0, 0);
        L(p, 'UpLeg', -0.35, 0, 0);
        L(p, 'Leg', 0.6, 0, 0);
        B(p, 'Foot', -0.25, 0, 0);
        C(p, 'Waist', 0.35, 0, 0);
        C(p, 'Chest', 0.2, 0, 0);
        C(p, 'Head', -0.25, 0, 0);
        B(p, 'Arm', -0.4, 0, 0.9);
      }],
      [1, null],
    ]),

  // Head down and charging: the legs pump through the long strike.
  charge: (u, d) => {
    const lean = (p) => {
      C(p, 'Waist', 0.55, 0, 0);
      C(p, 'Chest', 0.25, 0, 0);
      C(p, 'Neck', -0.3, 0, 0);
      C(p, 'Head', -0.35, 0, 0);
      B(p, 'Arm', 0.5, 0, 0.35);
      B(p, 'ForeArm', -0.6, 0, 0);
    };
    if (u < W) return keyed(u / W, [[0, null], [1, (p) => (lean(p), B(p, 'UpLeg', -0.4, 0, 0), B(p, 'Leg', 0.7, 0, 0), B(p, 'Foot', -0.3, 0, 0))]]);
    if (u > S) return keyed((u - S) / (1 - S), [[0, lean], [1, null]]);
    const g = { ...d.run, lean: 0, arm: 0.3 };
    return merge(make(lean), bipedGait(((u - W) / (S - W)) * 3, g));
  },

  // Crouch, spring, tuck in the air, land.
  leap: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        B(p, 'UpLeg', -0.95, 0, 0);
        B(p, 'Leg', 1.55, 0, 0);
        B(p, 'Foot', -0.6, 0, 0);
        C(p, 'Waist', 0.5, 0, 0);
        C(p, 'Head', -0.3, 0, 0);
        B(p, 'Arm', 0.7, 0, 0.35);
        B(p, 'ForeArm', -0.5, 0, 0);
      }],
      [W + (S - W) * 0.35, (p) => {
        B(p, 'UpLeg', -1.2, 0, 0.1);
        B(p, 'Leg', 1.7, 0, 0);
        C(p, 'Waist', -0.2, 0, 0);
        C(p, 'Chest', -0.2, 0, 0);
        B(p, 'Arm', -2.5, 0, 0.5);
        B(p, 'ForeArm', -0.4, 0, 0);
      }],
      [S, (p) => {
        B(p, 'UpLeg', -0.7, 0, 0);
        B(p, 'Leg', 1.2, 0, 0);
        B(p, 'Foot', -0.45, 0, 0);
        C(p, 'Waist', 0.55, 0, 0);
        C(p, 'Head', -0.35, 0, 0);
        B(p, 'Arm', -0.7, 0, 0.7);
      }],
      [1, null],
    ]),
};

// The pose seen in a mirror: left for right (and turns and rolls reversed).
function mirror(pose) {
  const out = {};
  for (const [key, v] of Object.entries(pose)) {
    const k = key.startsWith('Left') ? `Right${key.slice(4)}` : key.startsWith('Right') ? `Left${key.slice(5)}` : key;
    out[k] = key.endsWith('.p') ? [-v[0], v[1], v[2]] : [v[0], -v[1], -v[2]];
  }
  return out;
}

// Azrakel, the Archfiend: a hunched, long-armed beast-lord, quick and
// springy. His blows are claws, his tail and his whole weight.
const LORD_ATTACKS = {
  // The left claw: the right's sweep, mirrored.
  swipeL: (u, d) => mirror(BIPED_ATTACKS.swipe(u, d)),
  // Coiled low, then a dash: both claws driven forward at the end of it.
  lunge: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', 0.45, 0, 0);
        C(p, 'Chest', 0.3, 0, 0);
        C(p, 'Neck', -0.35, 0, 0);
        C(p, 'Head', -0.3, 0, 0);
        B(p, 'Arm', 0.7, 0, 0.25);
        B(p, 'ForeArm', -0.9, 0, 0);
        B(p, 'UpLeg', -0.95, 0, 0);
        B(p, 'Leg', 1.45, 0, 0);
        B(p, 'Foot', -0.5, 0, 0);
        T(p, 'Hips', 0, -0.05, -0.04);
      }],
      [W + (S - W) * 0.4, (p) => {
        C(p, 'Waist', 0.6, 0, 0);
        C(p, 'Chest', 0.25, 0, 0);
        C(p, 'Head', -0.45, 0, 0);
        B(p, 'Arm', -0.9, 0, 0.15);
        B(p, 'ForeArm', -0.5, 0, 0);
        L(p, 'UpLeg', -0.9, 0, 0);
        L(p, 'Leg', 0.5, 0, 0);
        R(p, 'UpLeg', 0.4, 0, 0);
        R(p, 'Leg', 0.3, 0, 0);
        T(p, 'Hips', 0, -0.02, 0.06);
      }, 'in'],
      [S, (p) => {
        C(p, 'Waist', 0.65, 0, 0);
        C(p, 'Chest', 0.2, 0, 0);
        C(p, 'Head', -0.5, 0, 0);
        B(p, 'Arm', -1.6, 0, 0.1);
        B(p, 'ForeArm', -0.15, 0, 0);
        B(p, 'Hand', 0.4, 0, 0);
        L(p, 'UpLeg', 0.3, 0, 0);
        L(p, 'Leg', 0.4, 0, 0);
        R(p, 'UpLeg', -0.7, 0, 0);
        R(p, 'Leg', 0.9, 0, 0);
        T(p, 'Hips', 0, -0.04, 0.08);
      }, 'in'],
      [0.8, (p) => {
        C(p, 'Waist', 0.4, 0, 0);
        C(p, 'Head', -0.25, 0, 0);
        B(p, 'Arm', -0.8, 0, 0.2);
        B(p, 'ForeArm', -0.4, 0, 0);
        B(p, 'UpLeg', -0.5, 0, 0);
        B(p, 'Leg', 0.8, 0, 0);
        B(p, 'Foot', -0.3, 0, 0);
      }],
      [1, null],
    ]),
  // Crouched and wound up, then round on the spot (the game turns him)
  // with the arms flung out and the tail lashing flat across the floor.
  tailSpin: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', 0.35, -0.5, 0);
        C(p, 'Chest', 0.2, -0.4, 0);
        C(p, 'Head', -0.2, 0.6, 0);
        B(p, 'Arm', 0.3, 0, 0.6);
        B(p, 'ForeArm', -0.7, 0, 0);
        B(p, 'UpLeg', -0.7, 0, 0);
        B(p, 'Leg', 1.1, 0, 0);
        B(p, 'Foot', -0.4, 0, 0);
        C(p, 'Tail1', 0.15, -0.6, 0);
        C(p, 'Tail2', 0.05, -0.5, 0);
      }],
      [W + (S - W) * 0.3, (p) => {
        C(p, 'Waist', 0.3, 0.3, 0);
        C(p, 'Chest', 0.15, 0.3, 0);
        B(p, 'Arm', -0.3, 0, 1.2);
        B(p, 'ForeArm', -0.3, 0, 0);
        B(p, 'UpLeg', -0.5, 0, 0);
        B(p, 'Leg', 0.8, 0, 0);
        C(p, 'Tail1', 0.12, 0.5, 0);
        C(p, 'Tail2', 0.05, 0.4, 0);
        C(p, 'Tail3', 0.05, 0.3, 0);
      }, 'in'],
      [S, (p) => {
        C(p, 'Waist', 0.3, 0.4, 0);
        C(p, 'Chest', 0.15, 0.35, 0);
        B(p, 'Arm', -0.2, 0, 1.0);
        B(p, 'UpLeg', -0.5, 0, 0);
        B(p, 'Leg', 0.8, 0, 0);
        C(p, 'Tail1', 0.12, 0.7, 0);
        C(p, 'Tail2', 0.05, 0.6, 0);
        C(p, 'Tail3', 0.05, 0.4, 0);
      }],
      [0.82, (p) => {
        C(p, 'Waist', 0.2, 0.1, 0);
        B(p, 'Arm', 0, 0, 0.4);
        B(p, 'UpLeg', -0.3, 0, 0);
        B(p, 'Leg', 0.5, 0, 0);
        C(p, 'Tail1', 0.05, 0.2, 0);
      }],
      [1, null],
    ]),
};

// His other clips: a spring away (the game moves him and plays it by how
// far through the hop he is) and a roar at the sky between his phases.
const LORD_CLIPS = {
  hop: {
    duration: 1,
    ground: () => null,
    sample: (u) =>
      keyed(u, [
        [0, (p) => {
          B(p, 'UpLeg', -0.9, 0, 0);
          B(p, 'Leg', 1.5, 0, 0);
          B(p, 'Foot', -0.55, 0, 0);
          C(p, 'Waist', 0.4, 0, 0);
          B(p, 'Arm', 0.4, 0, 0.3);
          B(p, 'ForeArm', -0.8, 0, 0);
        }],
        [0.45, (p) => {
          B(p, 'UpLeg', -1.3, 0, 0.1);
          B(p, 'Leg', 1.9, 0, 0);
          B(p, 'Foot', -0.4, 0, 0);
          C(p, 'Waist', -0.25, 0, 0);
          C(p, 'Chest', -0.2, 0, 0);
          C(p, 'Head', 0.25, 0, 0);
          B(p, 'Arm', -0.5, 0, 0.9);
          B(p, 'ForeArm', -0.6, 0, 0);
          C(p, 'Tail1', 0.45, 0, 0);
          C(p, 'Tail2', 0.25, 0, 0);
        }],
        [1, (p) => {
          B(p, 'UpLeg', -0.8, 0, 0);
          B(p, 'Leg', 1.3, 0, 0);
          B(p, 'Foot', -0.45, 0, 0);
          C(p, 'Waist', 0.45, 0, 0);
          C(p, 'Head', -0.2, 0, 0);
          B(p, 'Arm', -0.3, 0, 0.5);
          B(p, 'ForeArm', -0.5, 0, 0);
        }],
      ]),
  },
  roar: {
    duration: 1.6,
    ground: () => 'feet',
    sample: (u) =>
      keyed(u, [
        [0, null],
        [0.25, (p) => {
          C(p, 'Waist', 0.4, 0, 0);
          C(p, 'Chest', 0.3, 0, 0);
          C(p, 'Head', 0.2, 0, 0);
          B(p, 'Arm', 0.4, 0, 0.1);
          B(p, 'ForeArm', -1.2, 0, 0);
          B(p, 'UpLeg', -0.5, 0, 0);
          B(p, 'Leg', 0.8, 0, 0);
        }],
        [0.42, (p) => {
          C(p, 'Waist', -0.45, 0, 0);
          C(p, 'Chest', -0.35, 0, 0);
          C(p, 'Neck', -0.3, 0, 0);
          C(p, 'Head', -0.5, 0, 0);
          B(p, 'Shoulder', 0, 0, 0.25);
          B(p, 'Arm', -0.6, 0, 1.4);
          B(p, 'ForeArm', -0.3, 0, 0);
          B(p, 'Hand', 0, 0, 0.4);
          C(p, 'Tail1', 0.4, 0, 0);
          C(p, 'Tail2', 0.3, 0, 0);
        }, 'out'],
        [0.8, (p) => {
          C(p, 'Waist', -0.4, 0, 0);
          C(p, 'Chest', -0.3, 0.05, 0);
          C(p, 'Neck', -0.25, 0, 0);
          C(p, 'Head', -0.45, 0.1, 0);
          B(p, 'Shoulder', 0, 0, 0.22);
          B(p, 'Arm', -0.55, 0, 1.3);
          B(p, 'ForeArm', -0.35, 0, 0);
          C(p, 'Tail1', 0.35, 0, 0);
        }],
        [1, null],
      ]),
  },
};

// The Sleeper's axe (in his right hand, its handle running out of the fist
// the way his thumb points) and the poses only he has. His arms are
// lowered from his model's T-pose in every clip (`armDrop`, see clipsFor).
const AXE_ATTACKS = {
  // A vast flat arc: the axe hauled back to the right, then swept round
  // across the whole front of him to the left, the body turning with it.
  axeSweep: (u) =>
    keyed(u, [
      [0, null],
      // Hauling back: the weight sinks, the axe goes round behind him.
      [0.18, (p) => {
        C(p, 'Waist', 0, -0.18, 0);
        C(p, 'Chest', -0.04, -0.22, 0);
        C(p, 'Head', 0, 0.2, 0);
        R(p, 'Arm', -0.1, 0.5, 0.6);
        R(p, 'ForeArm', -0.5, 0, 0);
        L(p, 'Arm', -0.05, 0, 0.3);
        B(p, 'UpLeg', -0.2, 0, 0);
        B(p, 'Leg', 0.35, 0, 0);
        T(p, 'Hips', 0, -0.03, 0);
      }],
      // Coiled to the full: the axe far round to his right, the free arm out.
      [W * 0.85, (p) => {
        C(p, 'Waist', 0.05, -0.32, 0);
        C(p, 'Chest', -0.06, -0.38, 0);
        C(p, 'Head', 0, 0.38, 0);
        R(p, 'Arm', -0.15, 0.9, 0.85);
        R(p, 'ForeArm', -0.55, 0, 0);
        R(p, 'Hand', 0, 0, 0.2);
        L(p, 'Arm', -0.15, -0.1, 0.5);
        L(p, 'ForeArm', -0.45, 0, 0);
        B(p, 'UpLeg', -0.32, 0, 0);
        B(p, 'Leg', 0.58, 0, 0);
        T(p, 'Hips', 0, -0.07, -0.02);
      }],
      // Held there a beat, straining.
      [W, (p) => {
        C(p, 'Waist', 0.05, -0.35, 0);
        C(p, 'Chest', -0.08, -0.41, 0);
        C(p, 'Head', 0, 0.4, 0);
        R(p, 'Arm', -0.15, 0.95, 0.88);
        R(p, 'ForeArm', -0.55, 0, 0);
        R(p, 'Hand', 0, 0, 0.22);
        L(p, 'Arm', -0.15, -0.1, 0.52);
        L(p, 'ForeArm', -0.45, 0, 0);
        B(p, 'UpLeg', -0.34, 0, 0);
        B(p, 'Leg', 0.6, 0, 0);
        T(p, 'Hips', 0, -0.075, -0.02);
      }, 'out'],
      // The arc, faster and faster, round to his left.
      [S, (p) => {
        C(p, 'Waist', 0.15, 0.36, 0);
        C(p, 'Chest', 0.12, 0.42, 0);
        C(p, 'Head', 0, -0.32, 0);
        R(p, 'Arm', -0.35, -0.85, 0.8);
        R(p, 'ForeArm', -0.15, 0, 0);
        R(p, 'Hand', 0, 0, -0.15);
        L(p, 'Arm', 0.25, 0, 0.4);
        B(p, 'UpLeg', -0.36, 0, 0);
        B(p, 'Leg', 0.62, 0, 0);
        T(p, 'Hips', 0, -0.08, 0.05);
      }, 'in'],
      // Carried on past by its own weight.
      [0.7, (p) => {
        C(p, 'Waist', 0.18, 0.44, 0);
        C(p, 'Chest', 0.16, 0.5, 0);
        C(p, 'Head', 0, -0.3, 0);
        R(p, 'Arm', -0.3, -1.0, 0.62);
        R(p, 'ForeArm', -0.2, 0, 0);
        L(p, 'Arm', 0.3, 0, 0.35);
        B(p, 'UpLeg', -0.38, 0, 0);
        B(p, 'Leg', 0.66, 0, 0);
        T(p, 'Hips', 0, -0.09, 0.06);
      }, 'out'],
      [0.88, (p) => {
        C(p, 'Waist', 0.08, 0.2, 0);
        C(p, 'Chest', 0.06, 0.22, 0);
        R(p, 'Arm', -0.2, -0.45, 0.35);
        R(p, 'ForeArm', -0.25, 0, 0);
        B(p, 'UpLeg', -0.15, 0, 0);
        B(p, 'Leg', 0.25, 0, 0);
        T(p, 'Hips', 0, -0.03, 0.02);
      }],
      [1, null],
    ]),

  // The axe raised high over his head and brought straight down in front.
  axeChop: (u) =>
    keyed(u, [
      [0, null],
      // The axe comes up.
      [0.2, (p) => {
        C(p, 'Waist', -0.12, 0.1, 0);
        C(p, 'Chest', -0.16, 0.06, 0);
        R(p, 'Shoulder', 0, 0, 0.25);
        R(p, 'Arm', -0.35, 0.1, 1.2);
        R(p, 'ForeArm', -0.9, 0, 0);
        L(p, 'Arm', -0.35, 0, 0.45);
        L(p, 'ForeArm', -0.4, 0, 0);
        B(p, 'UpLeg', -0.08, 0, 0);
        B(p, 'Leg', 0.12, 0, 0);
      }],
      // Reared right back, up on his toes, the axe high over his head.
      [W * 0.85, (p) => {
        C(p, 'Waist', -0.24, 0.12, 0);
        C(p, 'Chest', -0.26, 0.08, 0);
        C(p, 'Neck', 0.1, 0, 0);
        C(p, 'Head', 0.18, 0, 0);
        R(p, 'Shoulder', 0, 0, 0.35);
        R(p, 'Arm', -0.45, 0.15, 1.5);
        R(p, 'ForeArm', -1.2, 0, 0);
        R(p, 'Hand', -0.4, 0, 0);
        L(p, 'Arm', -0.6, 0, 0.55);
        L(p, 'ForeArm', -0.5, 0, 0);
        B(p, 'UpLeg', -0.06, 0, 0);
        B(p, 'Leg', 0.1, 0, 0);
        B(p, 'Foot', 0.15, 0, 0);
        T(p, 'Hips', 0, 0.025, -0.02);
      }],
      [W, (p) => {
        C(p, 'Waist', -0.26, 0.12, 0);
        C(p, 'Chest', -0.28, 0.08, 0);
        C(p, 'Neck', 0.1, 0, 0);
        C(p, 'Head', 0.2, 0, 0);
        R(p, 'Shoulder', 0, 0, 0.37);
        R(p, 'Arm', -0.47, 0.15, 1.55);
        R(p, 'ForeArm', -1.22, 0, 0);
        R(p, 'Hand', -0.42, 0, 0);
        L(p, 'Arm', -0.62, 0, 0.56);
        L(p, 'ForeArm', -0.5, 0, 0);
        B(p, 'UpLeg', -0.06, 0, 0);
        B(p, 'Leg', 0.1, 0, 0);
        B(p, 'Foot', 0.16, 0, 0);
        T(p, 'Hips', 0, 0.03, -0.02);
      }, 'out'],
      // Down with all of him behind it: a deep squat as it bites the floor.
      [S, (p) => {
        C(p, 'Waist', 0.52, 0, 0);
        C(p, 'Chest', 0.34, 0, 0);
        C(p, 'Neck', -0.15, 0, 0);
        C(p, 'Head', -0.3, 0, 0);
        R(p, 'Arm', -0.95, 0.1, 0.35);
        R(p, 'ForeArm', -0.1, 0, 0);
        R(p, 'Hand', 0.6, 0, 0);
        L(p, 'Arm', -0.3, 0, 0.42);
        L(p, 'ForeArm', -0.4, 0, 0);
        B(p, 'UpLeg', -0.55, 0, 0);
        B(p, 'Leg', 0.95, 0, 0);
        B(p, 'Foot', -0.4, 0, 0);
        T(p, 'Hips', 0, -0.12, 0.05);
      }, 'in'],
      // The jolt of it coming up through him.
      [0.68, (p) => {
        C(p, 'Waist', 0.6, 0, 0);
        C(p, 'Chest', 0.4, 0, 0);
        C(p, 'Neck', -0.15, 0, 0);
        C(p, 'Head', -0.25, 0, 0);
        R(p, 'Arm', -1.0, 0.1, 0.32);
        R(p, 'ForeArm', -0.1, 0, 0);
        R(p, 'Hand', 0.62, 0, 0);
        L(p, 'Arm', -0.25, 0, 0.4);
        L(p, 'ForeArm', -0.35, 0, 0);
        B(p, 'UpLeg', -0.6, 0, 0);
        B(p, 'Leg', 1.02, 0, 0);
        B(p, 'Foot', -0.42, 0, 0);
        T(p, 'Hips', 0, -0.14, 0.05);
      }, 'out'],
      [0.86, (p) => {
        C(p, 'Waist', 0.35, 0, 0);
        C(p, 'Chest', 0.2, 0, 0);
        C(p, 'Head', -0.15, 0, 0);
        R(p, 'Arm', -0.7, 0.1, 0.3);
        R(p, 'ForeArm', -0.2, 0, 0);
        R(p, 'Hand', 0.4, 0, 0);
        B(p, 'UpLeg', -0.35, 0, 0);
        B(p, 'Leg', 0.6, 0, 0);
        B(p, 'Foot', -0.25, 0, 0);
        T(p, 'Hips', 0, -0.06, 0.03);
      }],
      [1, null],
    ]),
};

// The Sleeper's grab, toss and spin (his free hand is his left).
const GRAB_HOLD = (p) => {
  C(p, 'Waist', -0.1, 0.1, 0);
  C(p, 'Chest', -0.15, 0.2, 0);
  C(p, 'Head', -0.2, -0.15, 0);
  L(p, 'Shoulder', 0, 0, 0.2);
  L(p, 'Arm', -1.6, -0.35, 0.35);
  L(p, 'ForeArm', -0.7, 0, 0);
  L(p, 'Hand', -0.3, 0, 0);
  R(p, 'Arm', 0.1, 0, 0.3);
  B(p, 'UpLeg', -0.15, 0, 0);
  B(p, 'Leg', 0.25, 0, 0);
};
Object.assign(AXE_ATTACKS, {
  // A lunge with the open left hand, low and quick, then the catch lifted
  // up before his face (where it is held: see the 'toss' clip).
  grab: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', -0.15, -0.3, 0);
        C(p, 'Chest', -0.1, -0.35, 0);
        L(p, 'Arm', -0.4, 0.3, 0.75);
        L(p, 'ForeArm', -0.5, 0, 0);
        B(p, 'UpLeg', -0.2, 0, 0);
        B(p, 'Leg', 0.35, 0, 0);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.45, 0.3, 0);
        C(p, 'Chest', 0.2, 0.35, 0);
        C(p, 'Head', -0.2, -0.2, 0);
        L(p, 'Shoulder', 0, 0, 0.15);
        L(p, 'Arm', -1.35, -0.35, 0.35);
        L(p, 'ForeArm', -0.15, 0, 0);
        L(p, 'Hand', 0.3, 0, 0);
        R(p, 'Arm', 0.3, 0, 0.3);
        B(p, 'UpLeg', -0.45, 0, 0);
        B(p, 'Leg', 0.75, 0, 0);
        B(p, 'Foot', -0.3, 0, 0);
        T(p, 'Hips', 0, 0, 0.06);
      }, 'in'],
      [1, GRAB_HOLD],
    ]),
  // The axe held straight out to his right while the whole of him spins
  // round (the game turns him): a ring of steel round him.
  axeSpin: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Waist', 0.1, -0.45, 0);
        C(p, 'Chest', 0, -0.5, 0);
        R(p, 'Shoulder', 0, 0.15, 0.2);
        R(p, 'Arm', -0.1, 0.45, 1.0);
        R(p, 'ForeArm', -0.2, 0, 0);
        L(p, 'Arm', -0.2, 0, 0.75);
        B(p, 'UpLeg', -0.35, 0, 0);
        B(p, 'Leg', 0.6, 0, 0);
        T(p, 'Hips', 0, -0.02, 0);
      }],
      [(W + S) / 2, (p) => {
        C(p, 'Waist', 0.15, 0.1, 0.05);
        C(p, 'Chest', 0.05, 0.15, 0.05);
        R(p, 'Shoulder', 0, 0, 0.25);
        R(p, 'Arm', -0.1, 0.05, 1.05);
        R(p, 'ForeArm', -0.1, 0, 0);
        L(p, 'Arm', -0.1, 0, 0.85);
        B(p, 'UpLeg', -0.3, 0, 0);
        B(p, 'Leg', 0.5, 0, 0);
        T(p, 'Hips', 0, -0.02, 0);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.15, 0.15, 0.05);
        C(p, 'Chest', 0.05, 0.2, 0.05);
        R(p, 'Shoulder', 0, 0, 0.25);
        R(p, 'Arm', -0.15, 0, 1.0);
        R(p, 'ForeArm', -0.1, 0, 0);
        L(p, 'Arm', -0.1, 0, 0.85);
        B(p, 'UpLeg', -0.3, 0, 0);
        B(p, 'Leg', 0.5, 0, 0);
      }],
      [0.82, (p) => {
        C(p, 'Waist', 0.1, 0.1, 0);
        R(p, 'Arm', -0.2, -0.2, 0.6);
        B(p, 'UpLeg', -0.15, 0, 0);
        B(p, 'Leg', 0.25, 0, 0);
      }],
      [1, null],
    ]),
});

// Asleep, slouched back in his throne: thighs level and knees fallen apart,
// shins straight down to the floor, his back sunk into the seat, forearms
// along its arms with the hands hanging off the ends, chin down on his chest
// and his head lolled to one side, breathing slow and deep.
function sleepPose(p, breath = 0) {
  T(p, 'Hips', 0, 0, -0.05);
  B(p, 'UpLeg', -1.5, 0, 0.22);
  B(p, 'Leg', 1.5, 0, 0);
  B(p, 'Foot', -0.05, 0, 0);
  C(p, 'Waist', -0.32 + breath * 0.03, 0, 0);
  C(p, 'Chest', -0.16 + breath * 0.05, 0, 0.04);
  // (His skull is tipped onto his jaw on top of this: the mouth shut.)
  C(p, 'Neck', 0.15, 0, 0);
  C(p, 'Head', 0.08 - breath * 0.04, 0, 0.2);
  B(p, 'Arm', -0.3, 0, 0.05);
  B(p, 'ForeArm', -1.15, 0, 0);
  B(p, 'Hand', 0.45, 0, 0);
}

const SLEEPER_CLIPS = {
  // Holding his catch before his face, then flinging it up into the air.
  toss: {
    duration: 1,
    ground: () => 'feet',
    sample: (u) =>
      keyed(u, [
        [0, GRAB_HOLD],
        [0.25, (p) => {
          C(p, 'Waist', -0.2, 0.1, 0);
          C(p, 'Chest', -0.3, 0.15, 0);
          C(p, 'Head', -0.4, 0, 0);
          L(p, 'Shoulder', 0, 0, 0.35);
          L(p, 'Arm', -2.5, -0.2, 0.3);
          L(p, 'ForeArm', -0.15, 0, 0);
          R(p, 'Arm', 0.1, 0.5, 0.6);
          B(p, 'UpLeg', -0.1, 0, 0);
          B(p, 'Leg', 0.15, 0, 0);
        }],
        [1, null],
      ]),
  },
  sleep: { duration: 4, loop: true, ground: () => 'all', sample: (u) => make((p) => sleepPose(p, Math.sin(TAU * u))) },
  // Waking: pushes himself up off his knees, stands, then rears back and
  // spreads his arms as he speaks (the intro), and settles.
  rise: {
    duration: 1,
    ground: (u) => (u < 0.32 ? 'all' : 'feet'),
    sample: (u) =>
      keyed(u, [
        [0, (p) => sleepPose(p)],
        [0.12, (p) => {
          sleepPose(p);
          C(p, 'Head', -0.3, 0, -0.18);
          C(p, 'Neck', -0.15, 0, 0);
        }],
        // Hands down hard on the throne's arms, leaning forward to rise.
        [0.2, (p) => {
          T(p, 'Hips', 0, 0, -0.03);
          B(p, 'UpLeg', -1.35, 0, 0.18);
          B(p, 'Leg', 1.45, 0, 0);
          B(p, 'Foot', -0.15, 0, 0);
          C(p, 'Waist', 0.25, 0, 0);
          C(p, 'Chest', 0.15, 0, 0);
          C(p, 'Head', -0.2, 0, 0);
          B(p, 'Arm', -0.1, 0, 0.15);
          B(p, 'ForeArm', -0.9, 0, 0);
          B(p, 'Hand', -0.4, 0, 0);
        }],
        [0.3, (p) => {
          T(p, 'Hips', 0, -0.06, 0);
          B(p, 'UpLeg', -0.95, 0, 0.1);
          B(p, 'Leg', 1.3, 0, 0);
          B(p, 'Foot', -0.3, 0, 0);
          C(p, 'Waist', 0.55, 0, 0);
          C(p, 'Chest', 0.3, 0, 0);
          C(p, 'Head', -0.2, 0, 0);
          B(p, 'Arm', -0.9, 0, 0);
          B(p, 'ForeArm', -0.3, 0, 0);
        }],
        [0.5, (p) => {
          B(p, 'UpLeg', -0.3, 0, 0);
          B(p, 'Leg', 0.45, 0, 0);
          C(p, 'Waist', 0.3, 0, 0);
          C(p, 'Chest', 0.15, 0, 0);
          C(p, 'Head', -0.1, 0, 0);
          B(p, 'Arm', -0.3, 0, 0.1);
        }],
        [0.62, (p) => {
          C(p, 'Waist', -0.18, 0, 0);
          C(p, 'Chest', -0.25, 0, 0);
          C(p, 'Neck', -0.15, 0, 0);
          C(p, 'Head', -0.3, 0, 0);
          B(p, 'Arm', -0.2, 0, 1.0);
          B(p, 'ForeArm', -0.5, 0, 0);
          B(p, 'UpLeg', -0.1, 0, 0.08);
          B(p, 'Leg', 0.15, 0, 0);
        }],
        [0.85, (p) => {
          C(p, 'Waist', -0.12, 0, 0);
          C(p, 'Chest', -0.2, 0, 0);
          C(p, 'Head', -0.15, 0, 0);
          B(p, 'Arm', -0.25, 0, 0.85);
          B(p, 'ForeArm', -0.6, 0, 0);
          B(p, 'UpLeg', -0.1, 0, 0.08);
          B(p, 'Leg', 0.15, 0, 0);
        }],
        [1, null],
      ]),
  },
};

// The Sleeper's death: struck to his knees, he kneels there swaying while he
// speaks his last (the game holds the middle of the clip for as long as the
// line runs), then pitches forward onto his face.
function kneelDeath(u) {
  const kneel = (p, sway = 0) => {
    T(p, 'Hips', 0, -0.12, 0);
    B(p, 'UpLeg', -0.25, 0, 0.1);
    B(p, 'Leg', 1.9, 0, 0);
    B(p, 'Foot', 0.6, 0, 0);
    C(p, 'Waist', 0.25, 0, sway * 0.05);
    C(p, 'Chest', 0.15, 0, sway * 0.04);
    C(p, 'Head', -0.15, 0, 0);
    B(p, 'Arm', 0.1, 0, -0.1);
    B(p, 'ForeArm', -0.3, 0, 0);
  };
  return keyed(u, [
    [0, null],
    [0.08, (p) => {
      C(p, 'Waist', -0.3, 0, 0.1);
      C(p, 'Chest', -0.3, 0, 0);
      C(p, 'Head', -0.45, 0.2, 0);
      B(p, 'Arm', 0.3, 0, 0.6);
      B(p, 'ForeArm', -0.4, 0, 0);
    }],
    [0.25, (p) => kneel(p, 0)],
    [0.45, (p) => kneel(p, 1)],
    [0.62, (p) => kneel(p, -1)],
    [0.72, (p) => kneel(p, 0)],
    [0.9, (p) => {
      C(p, 'Root', 1.45, 0, 0.1);
      B(p, 'UpLeg', -0.6, 0, 0.1);
      B(p, 'Leg', 1.2, 0, 0);
      C(p, 'Head', 0.25, 0.6, 0.1);
      B(p, 'Arm', -1.1, 0, 0.9);
      B(p, 'ForeArm', -0.2, 0, 0);
    }],
    [1, (p) => {
      C(p, 'Root', 1.5, 0, 0.12);
      B(p, 'UpLeg', -0.5, 0, 0.1);
      B(p, 'Leg', 1.0, 0, 0);
      C(p, 'Head', 0.2, 0.7, 0.1);
      B(p, 'Arm', -1.15, 0, 1.0);
      B(p, 'ForeArm', -0.2, 0, 0);
    }],
  ]);
}

function hatKick(p) {
  C(p, 'Hat', -0.25, 0, 0.1);
  C(p, 'HatTip', -0.3, 0, 0.35);
}

function bipedHit(u) {
  return keyed(u, [
    [0, null],
    [0.18, (p) => {
      C(p, 'Waist', -0.3, 0.12, 0.08);
      C(p, 'Chest', -0.25, 0.1, 0);
      C(p, 'Neck', -0.15, 0, 0);
      C(p, 'Head', -0.3, 0.25, 0.1);
      B(p, 'Arm', 0.3, 0, 0.45);
      B(p, 'ForeArm', -0.5, 0, 0);
      B(p, 'UpLeg', -0.15, 0, 0);
      B(p, 'Leg', 0.3, 0, 0);
      T(p, 'Hips', 0, 0, -0.05);
      hatKick(p);
    }],
    [1, null],
  ]);
}

function bipedDeath(u, d) {
  const back = d.death !== 'forward';
  return keyed(u, [
    [0, null],
    [0.15, (p) => {
      C(p, 'Waist', -0.35, 0, 0.1);
      C(p, 'Chest', -0.3, 0, 0);
      C(p, 'Head', -0.45, 0.2, 0);
      B(p, 'Arm', 0.4, 0, 0.6);
      B(p, 'ForeArm', -0.4, 0, 0);
      hatKick(p);
    }],
    [0.42, (p) => {
      B(p, 'UpLeg', -0.9, 0, 0.1);
      B(p, 'Leg', 1.6, 0, 0);
      B(p, 'Foot', -0.5, 0, 0);
      C(p, 'Waist', back ? 0.1 : 0.45, 0, 0.1);
      C(p, 'Chest', 0.1, 0, 0);
      C(p, 'Head', 0.35, 0.3, 0);
      B(p, 'Arm', -0.1, 0, 0.35);
      B(p, 'ForeArm', -0.3, 0, 0);
    }],
    [0.8, (p) => {
      C(p, 'Root', back ? -1.45 : 1.4, 0, 0.15);
      B(p, 'UpLeg', back ? -0.7 : -0.3, 0, 0.15);
      B(p, 'Leg', back ? 0.9 : 0.4, 0, 0);
      C(p, 'Waist', back ? -0.1 : 0.1, 0, 0);
      C(p, 'Head', back ? -0.4 : 0.2, 0.6, 0.1);
      B(p, 'Arm', back ? 0.2 : -1.0, 0, 1.0);
      B(p, 'ForeArm', -0.2, 0, 0);
      C(p, 'Hat', -0.4, 0, 0);
    }],
    [0.88, (p) => {
      C(p, 'Root', back ? -1.38 : 1.33, 0, 0.12);
      B(p, 'UpLeg', back ? -0.75 : -0.3, 0, 0.15);
      B(p, 'Leg', back ? 0.95 : 0.4, 0, 0);
      C(p, 'Head', back ? -0.35 : 0.25, 0.65, 0.1);
      B(p, 'Arm', back ? 0.25 : -1.05, 0, 1.05);
      B(p, 'ForeArm', -0.25, 0, 0);
      C(p, 'Hat', -0.4, 0, 0);
    }],
    [1, (p) => {
      C(p, 'Root', back ? -1.45 : 1.4, 0, 0.15);
      B(p, 'UpLeg', back ? -0.7 : -0.3, 0, 0.15);
      B(p, 'Leg', back ? 0.9 : 0.4, 0, 0);
      C(p, 'Head', back ? -0.4 : 0.2, 0.7, 0.1);
      B(p, 'Arm', back ? 0.2 : -1.0, 0, 1.1);
      B(p, 'ForeArm', -0.2, 0, 0);
      C(p, 'Hat', -0.4, 0, 0);
    }],
  ]);
}

// --------------------------------------------------------- four-legged beasts

function beastIdle(u, d) {
  const a = TAU * u;
  const s = Math.sin(a);
  return make((p) => {
    C(p, 'Chest', 0.02 * s, 0, 0);
    C(p, 'Waist', -0.015 * s, 0.02 * Math.sin(a + 1), 0);
    C(p, 'Neck', 0.04 * Math.sin(a + 0.5), 0.12 * Math.sin(a), 0);
    C(p, 'Head', 0.05 * Math.sin(2 * a), 0.18 * Math.sin(a + 0.4), 0.05 * Math.sin(a));
    tail(p, a, 0.12, 0.1);
    B(p, 'Arm', 0.02 * s, 0, 0);
  });
}

function tail(p, a, swing, lift) {
  C(p, 'Tail1', lift * Math.sin(a * 2), swing * Math.sin(a), 0);
  C(p, 'Tail2', lift * 0.7 * Math.sin(a * 2 - 0.7), swing * 1.2 * Math.sin(a - 0.7), 0);
  C(p, 'Tail3', lift * 0.5 * Math.sin(a * 2 - 1.4), swing * 1.4 * Math.sin(a - 1.4), 0);
}

// Trot (diagonal pairs) or gallop (`gallop`: front and hind pairs, a flexing
// spine). Phases per leg: left fore, right fore, left hind, right hind.
function beastGait(u, g) {
  const a = TAU * u;
  const ph = g.gallop ? [0, 0.45, Math.PI, Math.PI + 0.45] : [0, Math.PI, Math.PI, 0];
  return make((p) => {
    const legs = [
      ['Left', 'fore', ph[0]],
      ['Right', 'fore', ph[1]],
      ['Left', 'hind', ph[2]],
      ['Right', 'hind', ph[3]],
    ];
    for (const [side, end, off] of legs) {
      const t = a + off;
      const fwd = Math.sin(t);
      const lift = Math.max(0, Math.cos(t));
      if (end === 'fore') {
        add(p, `${side}Arm`, -g.stride * fwd, 0, 0);
        add(p, `${side}ForeArm`, g.knee * lift, 0, 0);
        add(p, `${side}Hand`, -g.knee * 0.6 * lift + g.stride * 0.4 * fwd, 0, 0);
      } else {
        add(p, `${side}UpLeg`, -g.stride * fwd, 0, 0);
        add(p, `${side}Leg`, g.knee * 0.8 * lift, 0, 0);
        add(p, `${side}Foot`, -g.knee * 0.9 * lift, 0, 0);
        add(p, `${side}Toe`, g.knee * 0.3 * lift, 0, 0);
      }
    }
    if (g.gallop) {
      // The back rounds as the legs gather and stretches as they reach.
      const flex = Math.sin(a + Math.PI / 2);
      C(p, 'Hips', g.flex * flex, 0, 0);
      C(p, 'Waist', -g.flex * 0.8 * flex, 0, 0);
      C(p, 'Chest', -g.flex * 0.6 * flex, 0, 0);
      C(p, 'Neck', g.flex * 0.9 * flex - g.lean, 0, 0);
      C(p, 'Head', -g.flex * 0.5 * flex, 0, 0);
      tail(p, a, 0.1, 0.25);
    } else {
      C(p, 'Hips', 0, 0.05 * Math.sin(a), 0.04 * Math.sin(a));
      C(p, 'Waist', 0, -0.04 * Math.sin(a), -0.02 * Math.sin(a));
      C(p, 'Chest', 0.02 * Math.cos(2 * a), -0.05 * Math.sin(a), 0);
      C(p, 'Neck', -g.lean + 0.05 * Math.cos(2 * a), 0.05 * Math.sin(a), 0);
      C(p, 'Head', -0.04 * Math.cos(2 * a), 0.03 * Math.sin(a), 0);
      tail(p, a, 0.25, 0.08);
    }
  });
}

const BEAST_ATTACKS = {
  bite: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Neck', -0.5, 0, 0);
        C(p, 'Head', -0.35, 0, 0);
        C(p, 'Chest', 0.12, 0, 0);
        B(p, 'Arm', 0.3, 0, 0);
        B(p, 'ForeArm', 0.25, 0, 0);
        B(p, 'UpLeg', 0.15, 0, 0);
        B(p, 'Leg', 0.25, 0, 0);
        B(p, 'Foot', -0.3, 0, 0);
        T(p, 'Hips', 0, 0, -0.05);
        C(p, 'Tail1', -0.3, 0, 0);
      }],
      [S, (p) => {
        C(p, 'Neck', 0.45, 0, 0);
        C(p, 'Head', 0.3, 0, 0);
        C(p, 'Chest', 0.05, 0, 0);
        B(p, 'Arm', -0.4, 0, 0);
        B(p, 'UpLeg', 0.3, 0, 0);
        T(p, 'Hips', 0, 0, 0.09);
        C(p, 'Tail1', 0.2, 0, 0);
      }],
      [0.8, (p) => {
        C(p, 'Neck', 0.25, 0.2, 0);
        C(p, 'Head', 0.15, 0.25, 0.2);
        T(p, 'Hips', 0, 0, 0.05);
      }],
      [1, null],
    ]),

  // Crouch on the haunches, spring, fly with the forelegs reaching, land.
  pounce: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        B(p, 'UpLeg', 0.45, 0, 0);
        B(p, 'Leg', 0.55, 0, 0);
        B(p, 'Foot', -0.75, 0, 0);
        B(p, 'Arm', 0.25, 0, 0);
        B(p, 'ForeArm', 0.45, 0, 0);
        B(p, 'Hand', -0.3, 0, 0);
        C(p, 'Neck', 0.15, 0, 0);
        C(p, 'Head', -0.25, 0, 0);
        T(p, 'Hips', 0, 0, -0.06);
        C(p, 'Tail1', -0.4, 0, 0);
      }],
      [W + (S - W) * 0.45, (p) => {
        C(p, 'Root', -0.25, 0, 0);
        T(p, 'Root', 0, 0.22, 0);
        B(p, 'Arm', -1.15, 0, 0);
        B(p, 'ForeArm', -0.2, 0, 0);
        B(p, 'Hand', 0.3, 0, 0);
        B(p, 'UpLeg', 0.95, 0, 0);
        B(p, 'Leg', -0.35, 0, 0);
        B(p, 'Foot', 0.4, 0, 0);
        C(p, 'Neck', -0.2, 0, 0);
        C(p, 'Head', 0.1, 0, 0);
        C(p, 'Tail1', 0.35, 0, 0);
      }],
      [S, (p) => {
        C(p, 'Root', 0.12, 0, 0);
        B(p, 'Arm', -0.55, 0, 0);
        B(p, 'ForeArm', 0.25, 0, 0);
        B(p, 'UpLeg', -0.35, 0, 0);
        B(p, 'Leg', 0.55, 0, 0);
        C(p, 'Neck', 0.35, 0, 0);
        C(p, 'Head', 0.2, 0, 0);
      }],
      [1, null],
    ]),

  // Rear up on the hind legs and rake down with the left forepaw.
  claw: (u) =>
    keyed(u, [
      [0, null],
      [W, (p) => {
        C(p, 'Hips', -0.12, 0, 0);
        C(p, 'Waist', -0.3, 0.1, 0);
        C(p, 'Chest', -0.2, 0.1, 0);
        C(p, 'Neck', 0.35, 0, 0);
        C(p, 'Head', 0.15, -0.2, 0);
        L(p, 'Arm', -1.25, 0, 0.3);
        L(p, 'ForeArm', 0.7, 0, 0);
        L(p, 'Hand', -0.5, 0, 0);
        R(p, 'Arm', -0.5, 0, 0);
        R(p, 'ForeArm', 0.5, 0, 0);
        B(p, 'UpLeg', 0.3, 0, 0);
        B(p, 'Leg', 0.2, 0, 0);
        B(p, 'Foot', -0.4, 0, 0);
      }],
      [S, (p) => {
        C(p, 'Waist', 0.12, -0.1, 0);
        C(p, 'Chest', 0.1, -0.15, 0);
        C(p, 'Neck', 0.1, 0, 0);
        C(p, 'Head', 0.1, 0.15, 0);
        L(p, 'Arm', -0.35, 0, -0.35);
        L(p, 'ForeArm', 0.15, 0, 0);
        R(p, 'Arm', -0.2, 0, 0);
        T(p, 'Hips', 0, 0, 0.08);
      }],
      [1, null],
    ]),
};

function beastHit(u) {
  return keyed(u, [
    [0, null],
    [0.18, (p) => {
      C(p, 'Waist', 0, 0.15, 0.12);
      C(p, 'Chest', 0.1, 0.2, 0.05);
      C(p, 'Neck', -0.35, 0.35, 0);
      C(p, 'Head', -0.2, 0.2, 0.25);
      B(p, 'UpLeg', 0.2, 0, 0);
      B(p, 'Leg', 0.25, 0, 0);
      T(p, 'Hips', 0, 0, -0.06);
      C(p, 'Tail1', -0.4, 0.3, 0);
    }],
    [1, null],
  ]);
}

function beastDeath(u) {
  return keyed(u, [
    [0, null],
    [0.15, (p) => {
      C(p, 'Neck', -0.45, 0.2, 0);
      C(p, 'Head', -0.3, 0.2, 0.2);
      C(p, 'Waist', 0, 0.1, 0.1);
    }],
    [0.4, (p) => {
      B(p, 'UpLeg', 0.45, 0, 0);
      B(p, 'Leg', 0.6, 0, 0);
      B(p, 'Foot', -0.5, 0, 0);
      B(p, 'Arm', 0.4, 0, 0);
      B(p, 'ForeArm', 0.6, 0, 0);
      C(p, 'Neck', 0.35, 0.2, 0);
      C(p, 'Head', 0.2, 0.2, 0);
    }],
    [0.8, (p) => {
      C(p, 'Root', 0, 0, 1.45);
      B(p, 'UpLeg', -0.2, 0, 0.25);
      B(p, 'Leg', 0.3, 0, 0);
      B(p, 'Arm', -0.4, 0, 0.25);
      B(p, 'ForeArm', 0.3, 0, 0);
      C(p, 'Neck', 0.1, 0.35, 0.2);
      C(p, 'Head', 0.25, 0.3, 0);
      C(p, 'Tail1', 0, 0.3, 0.2);
      C(p, 'Tail2', 0, 0.3, 0);
    }],
    [0.88, (p) => {
      C(p, 'Root', 0, 0, 1.38);
      B(p, 'UpLeg', -0.25, 0, 0.3);
      B(p, 'Leg', 0.35, 0, 0);
      B(p, 'Arm', -0.45, 0, 0.3);
      B(p, 'ForeArm', 0.35, 0, 0);
      C(p, 'Neck', 0.1, 0.4, 0.2);
      C(p, 'Head', 0.25, 0.35, 0);
      C(p, 'Tail1', 0, 0.35, 0.2);
    }],
    [1, (p) => {
      C(p, 'Root', 0, 0, 1.45);
      B(p, 'UpLeg', -0.2, 0, 0.3);
      B(p, 'Leg', 0.3, 0, 0);
      B(p, 'Arm', -0.4, 0, 0.3);
      B(p, 'ForeArm', 0.3, 0, 0);
      C(p, 'Neck', 0.1, 0.4, 0.2);
      C(p, 'Head', 0.3, 0.35, 0);
      C(p, 'Tail1', 0, 0.35, 0.2);
      C(p, 'Tail2', 0, 0.3, 0);
    }],
  ]);
}

// ------------------------------------------------------------------- clips

// Every clip a creature needs: { name, duration, loop, sample(u) -> pose,
// ground(u) -> 'feet' | 'all' | null }. Grounding (done by the rig script)
// lifts or drops the whole body so the lowest foot, or the lowest point of a
// fallen body, touches the floor: walking bobs by itself.
export function clipsFor(def) {
  const biped = def.plan === 'biped';
  const gait = biped ? bipedGait : beastGait;
  const attacks = biped ? { ...BIPED_ATTACKS, ...AXE_ATTACKS, ...LORD_ATTACKS } : BEAST_ATTACKS;
  const feet = () => 'feet';
  const death = def.deathMotion === 'kneelDeath' ? kneelDeath : (u) => (biped ? bipedDeath : beastDeath)(u, def);
  const clips = [
    { name: 'idle', duration: 3, loop: true, sample: (u) => (biped ? bipedIdle : beastIdle)(u, def), ground: feet },
    { name: 'walk', duration: 1, loop: true, sample: (u) => gait(u, def.walk), ground: feet },
    { name: 'run', duration: 0.7, loop: true, sample: (u) => gait(u, def.run), ground: feet },
    { name: 'hit', duration: 0.6, sample: (u) => (biped ? bipedHit : beastHit)(u), ground: feet },
    { name: 'death', duration: 1.6, sample: death, ground: (u) => (u < (def.deathMotion ? 0.12 : 0.5) ? 'feet' : 'all') },
  ];
  for (const [attack, motion] of Object.entries(def.attacks)) {
    const fn = attacks[motion];
    if (!fn) throw new Error(`No ${def.plan} motion "${motion}" (for ${attack})`);
    const airborne = motion === 'pounce' || motion === 'leap';
    clips.push({ name: attack, duration: 1, sample: (u) => fn(u, def), ground: (u) => (airborne && u > W && u < S ? null : 'feet') });
  }
  for (const name of def.clips || []) clips.push({ name, ...(SLEEPER_CLIPS[name] || LORD_CLIPS[name]) });
  // A biped with a tail (`def.tail`): it swings with every clip, slowly at
  // rest, with the stride in the gaits, and lags behind the blows.
  if (def.tail && biped) {
    const T = def.tail;
    for (const c of clips) {
      const sample = c.sample;
      const speed = c.name === 'run' ? 1 : c.name === 'walk' ? 1 : c.name === 'idle' ? 2 : 0.5;
      const swing = c.name === 'run' ? T.swing * 0.6 : c.name === 'death' ? 0 : T.swing;
      c.sample = (u) => {
        const p = sample(u);
        tail(p, TAU * u * speed, swing, T.lift);
        return p;
      };
    }
  }
  // A model rigged in a T-pose: its arms brought down to its sides in every
  // clip, the turn shared between the shoulder and the arm so neither
  // stretches the skin round it too far.
  // And whatever a clip asks of the arm, part of it is taken up at the
  // shoulder (raised or swung, the whole shoulder goes with it, as a real one
  // does) so the bulk round the joint is carried, not drawn out.
  if (def.armDrop) {
    const share = def.shoulderShare ?? [0, 0, 0];
    for (const c of clips) {
      const sample = c.sample;
      c.sample = (u) => {
        const p = sample(u);
        for (const side of ['Left', 'Right']) {
          const arm = p[`${side}Arm`];
          if (!arm) continue;
          const sh = (p[`${side}Shoulder`] ||= [0, 0, 0]);
          for (let k = 0; k < 3; k++) {
            sh[k] += arm[k] * share[k];
            arm[k] -= arm[k] * share[k];
          }
        }
        B(p, 'Shoulder', 0, 0, -def.armDrop * 0.3);
        B(p, 'Arm', 0, 0, -def.armDrop * 0.7);
        return p;
      };
    }
  }
  return clips;
}
