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
function keyed(u, keys) {
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1][0]) i++;
  const [t0, f0] = keys[i];
  const [t1, f1] = keys[i + 1];
  const k = smooth(clamp((u - t0) / Math.max(1e-6, t1 - t0)));
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
  const attacks = biped ? BIPED_ATTACKS : BEAST_ATTACKS;
  const feet = () => 'feet';
  const clips = [
    { name: 'idle', duration: 3, loop: true, sample: (u) => (biped ? bipedIdle : beastIdle)(u, def), ground: feet },
    { name: 'walk', duration: 1, loop: true, sample: (u) => gait(u, def.walk), ground: feet },
    { name: 'run', duration: 0.7, loop: true, sample: (u) => gait(u, def.run), ground: feet },
    { name: 'hit', duration: 0.6, sample: (u) => (biped ? bipedHit : beastHit)(u), ground: feet },
    { name: 'death', duration: 1.6, sample: (u) => (biped ? bipedDeath : beastDeath)(u, def), ground: (u) => (u < 0.5 ? 'feet' : 'all') },
  ];
  for (const [attack, motion] of Object.entries(def.attacks)) {
    const fn = attacks[motion];
    if (!fn) throw new Error(`No ${def.plan} motion "${motion}" (for ${attack})`);
    const airborne = motion === 'pounce' || motion === 'leap';
    clips.push({ name: attack, duration: 1, sample: (u) => fn(u, def), ground: (u) => (airborne && u > W && u < S ? null : 'feet') });
  }
  return clips;
}
