// Renders the game's sound effects offline into small WAV files: Project 0's
// sandbox plays sound files but has no Web Audio to synthesize them live.
// Every sound is generated here from oscillators and filtered noise, so the
// game ships only its own audio.
//
//   node scripts/make-sounds.mjs <out-dir>

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INTRO_SECONDS } from '../src/core/soundFormat.js';

const RATE = 22050;

// Deterministic noise so builds are reproducible.
let seed = 1738;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

function track(seconds) {
  return new Float32Array(Math.ceil(seconds * RATE));
}

// RBJ biquad with a per-sample cutoff.
function biquad(type, q) {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x, freq) => {
    const w = (2 * Math.PI * Math.min(freq, RATE * 0.45)) / RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0;
    let b1;
    let b2;
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

// Exponential attack/decay envelope, like the original Web Audio ramps.
function env(t, attack, decay) {
  if (t < attack) return Math.pow(t / attack, 2);
  const k = (t - attack) / decay;
  return k >= 1 ? 0 : Math.pow(1 - k, 3);
}

const sweep = (a, b, k) => a * Math.pow(b / a, Math.min(1, k));

function tone(out, { type = 'sine', freq = 220, freqEnd = freq, attack = 0.005, decay = 0.3, gain = 0.3, delay = 0, lp = 0 }) {
  const start = Math.floor(delay * RATE);
  const n = Math.floor((attack + decay) * RATE);
  const filter = lp ? biquad('lowpass', 0.7) : null;
  let phase = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / RATE;
    const f = sweep(freq, freqEnd, t / (attack + decay));
    phase += f / RATE;
    const p = phase % 1;
    let s;
    if (type === 'sine') s = Math.sin(p * 2 * Math.PI);
    else if (type === 'square') s = p < 0.5 ? 1 : -1;
    else if (type === 'triangle') s = 1 - 4 * Math.abs(p - 0.5);
    else s = 2 * p - 1;
    if (filter) s = filter(s, lp);
    out[start + i] += s * gain * env(t, attack, decay);
  }
}

function noise(out, { freq = 800, freqEnd = freq, q = 1, type = 'bandpass', attack = 0.005, decay = 0.2, gain = 0.4, delay = 0 }) {
  const start = Math.floor(delay * RATE);
  const n = Math.floor((attack + decay) * RATE);
  const filter = biquad(type, q);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / RATE;
    const f = sweep(freq, Math.max(20, freqEnd), t / (attack + decay));
    out[start + i] += filter(rnd() * 2 - 1, f) * gain * env(t, attack, decay) * (type === 'bandpass' ? 2.2 : 1);
  }
}

// A blade cutting the air: noise through a resonant band that sweeps up as
// the blade comes through and falls away after it (the swing's Doppler),
// under a bell of an envelope; a low push of the air shoved aside, and the
// hiss off the edge at the top of the sweep.
function swish(o, { dur = 0.22, f0 = 600, f1 = 2800, f2 = 900, peak = 0.55, q = 1.8, gain = 0.6, delay = 0, low = 0.5, edge = 0.25 }) {
  const start = Math.floor(delay * RATE);
  const n = Math.floor(dur * RATE);
  const bp = biquad('bandpass', q);
  const bp2 = biquad('bandpass', q * 1.5);
  const lp = biquad('lowpass', 0.8);
  const hp = biquad('highpass', 0.7);
  for (let i = 0; i < n && start + i < o.length; i++) {
    const k = i / n;
    const f = k < peak ? sweep(f0, f1, k / peak) : sweep(f1, f2, (k - peak) / (1 - peak));
    const e = k < peak ? Math.pow(k / peak, 1.6) : Math.pow(1 - (k - peak) / (1 - peak), 2);
    const x = rnd() * 2 - 1;
    const v = bp(x, f) * 2.4 + bp2(x, f * 1.6) * 1.2 + lp(x, 220 + 420 * e) * low + hp(x, 5200) * edge * e;
    o[start + i] += v * e * gain;
  }
}

// Saturate a whole sound: louder, denser, punchier.
function punch(o, drive = 2.2) {
  const t = Math.tanh(drive);
  for (let i = 0; i < o.length; i++) o[i] = Math.tanh(o[i] * drive) / t;
}

// The ring of steel as the blade turns through its cut.
function shing(o, { delay = 0.05, gain = 0.05, f = 2900 } = {}) {
  tone(o, { type: 'triangle', freq: f, freqEnd: f * 0.985, attack: 0.004, decay: 0.24, gain, delay });
  tone(o, { type: 'triangle', freq: f * 1.51, freqEnd: f * 1.49, attack: 0.004, decay: 0.16, gain: gain * 0.5, delay });
}

function lightSwing(o, k) {
  noise(o, { type: 'highpass', freq: 3000, decay: 0.008, gain: 0.25 });
  swish(o, { dur: 0.2 + 0.03 * k, f0: 450 + 100 * k, f1: 2600 + 500 * k, f2: 800, peak: 0.4, q: 4, gain: 0.8, low: 0.7, edge: 0.15 });
  shing(o, { delay: 0.06, gain: 0.05, f: 2700 + 300 * k });
  punch(o, 1.7);
}

function heavySwing(o, k) {
  swish(o, { dur: 0.34 + 0.04 * k, f0: 220, f1: 1200 + 200 * k, f2: 320, peak: 0.48, q: 3, gain: 0.9, low: 1.2, edge: 0.08 });
  tone(o, { freq: 80, freqEnd: 40, attack: 0.02, decay: 0.24, gain: 0.4, delay: 0.1 });
  punch(o, 1.9);
}

const SOUNDS = {
  // Light swings: three takes, so a flurry never repeats itself.
  swing_light_1: (o) => lightSwing(o, 0),
  swing_light_2: (o) => lightSwing(o, 0.5),
  swing_light_3: (o) => lightSwing(o, 1),
  // A Perfect Chain swing: a sharper, brighter cut, a crack at its start and
  // steel that rings on (played lower with every link of the chain).
  swing_perfect: (o) => {
    noise(o, { type: 'highpass', freq: 3500, decay: 0.012, gain: 0.45 });
    swish(o, { dur: 0.21, f0: 600, f1: 3600, f2: 1100, peak: 0.38, q: 4.5, gain: 0.85, low: 0.8, edge: 0.25 });
    shing(o, { delay: 0.05, gain: 0.08, f: 3100 });
    tone(o, { type: 'triangle', freq: 660, freqEnd: 640, attack: 0.01, decay: 0.45, gain: 0.06, delay: 0.04 });
    punch(o, 1.8);
  },
  // The chime of the timing itself, the moment a chain links.
  chain: (o) => {
    tone(o, { type: 'triangle', freq: 880, freqEnd: 870, attack: 0.002, decay: 0.4, gain: 0.16 });
    tone(o, { freq: 1320, freqEnd: 1310, attack: 0.002, decay: 0.3, gain: 0.08 });
    tone(o, { freq: 440, decay: 0.25, gain: 0.06 });
  },
  // A press too early: a dull wooden knock, the blade fumbled.
  fumble: (o) => {
    tone(o, { freq: 190, freqEnd: 120, decay: 0.07, gain: 0.3 });
    noise(o, { type: 'lowpass', freq: 900, decay: 0.05, gain: 0.25 });
  },
  // Counter-hit: a crack, a bass boom, and a clang that rings on.
  counter: (o) => {
    tone(o, { freq: 72, freqEnd: 30, attack: 0.003, decay: 0.6, gain: 0.85 });
    noise(o, { type: 'lowpass', freq: 4000, freqEnd: 260, decay: 0.28, gain: 0.7 });
    noise(o, { type: 'highpass', freq: 3200, decay: 0.03, gain: 0.5 });
    tone(o, { type: 'triangle', freq: 523, freqEnd: 500, decay: 0.5, gain: 0.1, delay: 0.01 });
    tone(o, { type: 'triangle', freq: 784, freqEnd: 760, decay: 0.35, gain: 0.06, delay: 0.01 });
  },
  // Steel thrown back off a guard: an ugly inharmonic clang and a scrape.
  clash: (o) => {
    for (const [f, g, d] of [[612, 0.2, 0.6], [931, 0.14, 0.45], [1447, 0.09, 0.35], [2210, 0.05, 0.25]]) tone(o, { type: 'triangle', freq: f, freqEnd: f * 0.98, decay: d, gain: g });
    noise(o, { type: 'highpass', freq: 2800, decay: 0.07, gain: 0.55 });
    noise(o, { freq: 2200, freqEnd: 900, q: 2.5, attack: 0.01, decay: 0.3, gain: 0.2, delay: 0.03 });
    tone(o, { freq: 120, freqEnd: 60, decay: 0.12, gain: 0.4 });
  },
  // A guard shattered: a crunch of breaking ward and a heavy thump.
  guard_break: (o) => {
    noise(o, { type: 'highpass', freq: 2400, decay: 0.12, gain: 0.6 });
    for (let i = 0; i < 6; i++) noise(o, { type: 'highpass', freq: 3000 + i * 400, decay: 0.03, gain: 0.3, delay: 0.02 + i * 0.03 });
    tone(o, { freq: 95, freqEnd: 35, decay: 0.45, gain: 0.7 });
    noise(o, { type: 'lowpass', freq: 1400, freqEnd: 120, decay: 0.4, gain: 0.5 });
  },
  // A ward of hellfire flaring up.
  guard_up: (o) => {
    noise(o, { type: 'lowpass', freq: 300, freqEnd: 1100, attack: 0.05, decay: 0.25, gain: 0.4 });
    tone(o, { type: 'saw', freq: 110, freqEnd: 140, attack: 0.03, decay: 0.3, gain: 0.12, lp: 700 });
  },
  // Procs.
  freeze: (o) => {
    noise(o, { freq: 4200, freqEnd: 2500, q: 3, attack: 0.01, decay: 0.45, gain: 0.35 });
    for (let i = 0; i < 5; i++) tone(o, { freq: 2200 + i * 330, decay: 0.12, gain: 0.05, delay: i * 0.04 });
    tone(o, { freq: 90, freqEnd: 60, decay: 0.2, gain: 0.3 });
  },
  shatter: (o) => {
    noise(o, { type: 'highpass', freq: 3500, decay: 0.25, gain: 0.55 });
    for (let i = 0; i < 8; i++) tone(o, { freq: 2400 + ((i * 577) % 1600), decay: 0.08, gain: 0.05, delay: 0.01 + i * 0.025 });
  },
  lifesteal: (o) => {
    noise(o, { freq: 300, freqEnd: 1600, q: 1.5, attack: 0.25, decay: 0.12, gain: 0.45 });
    tone(o, { freq: 180, freqEnd: 520, attack: 0.25, decay: 0.15, gain: 0.18 });
    tone(o, { freq: 60, freqEnd: 45, decay: 0.3, gain: 0.4, delay: 0.38 });
  },
  eruption: (o) => {
    noise(o, { type: 'lowpass', freq: 1600, freqEnd: 140, attack: 0.01, decay: 0.7, gain: 0.8 });
    tone(o, { freq: 55, freqEnd: 30, decay: 0.6, gain: 0.7 });
    noise(o, { freq: 900, freqEnd: 2600, q: 0.8, attack: 0.05, decay: 0.4, gain: 0.25 });
  },
  zap: (o) => {
    for (let i = 0; i < 6; i++) noise(o, { type: 'highpass', freq: 2500 + i * 300, decay: 0.03, gain: 0.45, delay: i * 0.022 });
    tone(o, { type: 'saw', freq: 1400, freqEnd: 160, decay: 0.18, gain: 0.18, lp: 5000 });
    tone(o, { freq: 70, freqEnd: 40, decay: 0.25, gain: 0.4, delay: 0.02 });
  },
  bleed: (o) => {
    squelch(o, { dur: 0.3, gain: 0.5, freq: 600 });
    noise(o, { freq: 2600, freqEnd: 900, q: 1, attack: 0.01, decay: 0.2, gain: 0.2 });
  },
  soulrend: (o) => {
    tone(o, { freq: 330, freqEnd: 110, attack: 0.05, decay: 0.8, gain: 0.2 });
    tone(o, { freq: 494, freqEnd: 165, attack: 0.05, decay: 0.7, gain: 0.12 });
    noise(o, { type: 'lowpass', freq: 1800, freqEnd: 100, decay: 0.7, gain: 0.7 });
    tone(o, { freq: 50, freqEnd: 28, decay: 0.7, gain: 0.7 });
  },
  echo: (o) => {
    noise(o, { freq: 1200, freqEnd: 2800, q: 1.2, attack: 0.04, decay: 0.2, gain: 0.35 });
    tone(o, { freq: 660, freqEnd: 600, attack: 0.02, decay: 0.4, gain: 0.08 });
    tone(o, { freq: 990, freqEnd: 900, attack: 0.02, decay: 0.3, gain: 0.05 });
  },
  // A relic taken: a dark rising chord with a shimmer.
  relic: (o) => {
    [196, 247, 294, 392].forEach((f, i) => tone(o, { type: 'triangle', freq: f, decay: 0.9, gain: 0.12, delay: i * 0.07 }));
    noise(o, { freq: 5000, freqEnd: 7000, q: 2, attack: 0.2, decay: 0.6, gain: 0.08 });
    tone(o, { freq: 98, decay: 1, gain: 0.2 });
  },
  swing_heavy_1: (o) => heavySwing(o, 0),
  swing_heavy_2: (o) => heavySwing(o, 1),
  hit_sword: (o) => {
    tone(o, { freq: 160, freqEnd: 40, decay: 0.18, gain: 0.55 });
    noise(o, { type: 'lowpass', freq: 3500, freqEnd: 300, decay: 0.12, gain: 0.5 });
    tone(o, { type: 'triangle', freq: 1800, freqEnd: 1500, decay: 0.1, gain: 0.06 });
  },
  // A blade through meat: a fast tearing hiss, a wet squelch that gurgles
  // (noise chopped by a fast wobble), and a dull thud underneath.
  flesh_1: (o) => flesh(o, 1),
  flesh_2: (o) => flesh(o, 0.82),
  flesh_3: (o) => flesh(o, 1.2),
  // The kill: a heavy body blow, bone cracking, a burst of spray, and a low
  // boom that rolls off.
  kill: (o) => {
    tone(o, { freq: 85, freqEnd: 28, attack: 0.004, decay: 0.7, gain: 0.8 });
    noise(o, { type: 'lowpass', freq: 2200, freqEnd: 120, decay: 0.35, gain: 0.7 });
    for (let i = 0; i < 4; i++) noise(o, { type: 'highpass', freq: 2500 + i * 600, decay: 0.025, gain: 0.35, delay: 0.03 + i * 0.035 });
    squelch(o, { delay: 0.06, dur: 0.45, gain: 0.55, freq: 700 });
    noise(o, { freq: 3000, freqEnd: 900, q: 0.8, attack: 0.02, decay: 0.5, gain: 0.25, delay: 0.08 });
  },
  // Steel on claw and bone: a ringing clang with a hard scrape.
  block: (o) => {
    tone(o, { type: 'triangle', freq: 1250, freqEnd: 1150, decay: 0.45, gain: 0.22 });
    tone(o, { type: 'triangle', freq: 1870, freqEnd: 1800, decay: 0.3, gain: 0.12 });
    tone(o, { freq: 140, freqEnd: 70, decay: 0.12, gain: 0.45 });
    noise(o, { type: 'highpass', freq: 3000, decay: 0.08, gain: 0.45 });
    noise(o, { freq: 2600, freqEnd: 1400, q: 2, attack: 0.01, decay: 0.2, gain: 0.2, delay: 0.02 });
  },
  // Pottery bursting: a hard crack and a spill of bright shards.
  smash_clay: (o) => {
    noise(o, { type: 'highpass', freq: 1800, decay: 0.06, gain: 0.6 });
    tone(o, { freq: 180, freqEnd: 70, decay: 0.12, gain: 0.4 });
    for (let i = 0; i < 9; i++) tone(o, { type: 'triangle', freq: 2200 + rnd() * 2500, decay: 0.05 + rnd() * 0.06, gain: 0.08, delay: 0.04 + rnd() * 0.35 });
    noise(o, { freq: 3500, freqEnd: 2000, q: 1.5, attack: 0.02, decay: 0.35, gain: 0.18, delay: 0.05 });
  },
  // Rotten wood splitting: a dull crunch and splinters.
  smash_wood: (o) => {
    tone(o, { freq: 120, freqEnd: 50, decay: 0.2, gain: 0.6 });
    noise(o, { type: 'lowpass', freq: 1500, freqEnd: 300, decay: 0.25, gain: 0.6 });
    for (let i = 0; i < 6; i++) noise(o, { freq: 900 + rnd() * 1200, q: 4, decay: 0.03, gain: 0.35, delay: 0.03 + rnd() * 0.25 });
  },
  // A heavy lid heaved open: a creak, a thud, a glint of treasure.
  chest: (o) => {
    tone(o, { type: 'sawtooth', freq: 160, freqEnd: 240, attack: 0.05, decay: 0.4, gain: 0.12, lp: 900 });
    noise(o, { freq: 700, freqEnd: 1100, q: 6, attack: 0.05, decay: 0.4, gain: 0.25 });
    tone(o, { freq: 90, freqEnd: 50, decay: 0.2, gain: 0.5, delay: 0.42 });
    [784, 988, 1175, 1568].forEach((f, i) => tone(o, { type: 'triangle', freq: f, decay: 0.5, gain: 0.08, delay: 0.5 + i * 0.07 }));
  },
  // Flint on steel: a sharp click and a spit of sparks.
  strike: (o) => {
    noise(o, { type: 'highpass', freq: 4500, decay: 0.03, gain: 0.7 });
    tone(o, { type: 'triangle', freq: 3200, freqEnd: 2600, decay: 0.05, gain: 0.12 });
    for (let i = 0; i < 5; i++) noise(o, { type: 'highpass', freq: 6000, decay: 0.012, gain: 0.25, delay: 0.03 + rnd() * 0.15 });
  },
  // The pitch-soaked rag catching: a soft rush that swells into a burn.
  ignite: (o) => {
    noise(o, { type: 'lowpass', freq: 300, freqEnd: 1800, attack: 0.25, decay: 0.6, gain: 0.55 });
    noise(o, { freq: 1200, freqEnd: 600, q: 0.6, attack: 0.1, decay: 0.8, gain: 0.2, delay: 0.1 });
    for (let i = 0; i < 8; i++) noise(o, { type: 'highpass', freq: 3000, decay: 0.01, gain: 0.2, delay: 0.3 + rnd() * 0.7 });
  },
  // Drawing back for a heavy blow: a low tightening rush.
  charge: (o) => {
    noise(o, { freq: 250, freqEnd: 900, q: 1.2, attack: 0.35, decay: 0.25, gain: 0.3 });
    tone(o, { type: 'sawtooth', freq: 55, freqEnd: 90, attack: 0.3, decay: 0.3, gain: 0.12, lp: 400 });
  },
  charge_full: (o) => {
    tone(o, { type: 'triangle', freq: 880, freqEnd: 1320, decay: 0.25, gain: 0.14 });
    noise(o, { type: 'highpass', freq: 4000, decay: 0.15, gain: 0.12 });
  },
  hit_heavy: (o) => {
    tone(o, { freq: 110, freqEnd: 38, decay: 0.22, gain: 0.65 });
    noise(o, { type: 'lowpass', freq: 1600, freqEnd: 200, decay: 0.16, gain: 0.55 });
  },
  hurt: (o) => {
    tone(o, { type: 'square', freq: 90, freqEnd: 50, decay: 0.2, gain: 0.25, lp: 600 });
    noise(o, { type: 'lowpass', freq: 900, freqEnd: 200, decay: 0.2, gain: 0.5 });
  },
  dodge: (o) => noise(o, { freq: 900, freqEnd: 300, q: 0.8, attack: 0.02, decay: 0.18, gain: 0.3 }),
  growl_ghoul: (o) => growl(o, 140),
  growl_fiend: (o) => growl(o, 95),
  growl_brute: (o) => growl(o, 60),
  telegraph_ghoul: (o) => tone(o, { type: 'sawtooth', freq: 176, freqEnd: 286, attack: 0.05, decay: 0.3, gain: 0.2, lp: 900 }),
  telegraph_fiend: (o) => tone(o, { type: 'sawtooth', freq: 120, freqEnd: 195, attack: 0.05, decay: 0.3, gain: 0.2, lp: 900 }),
  telegraph_brute: (o) => tone(o, { type: 'sawtooth', freq: 64, freqEnd: 104, attack: 0.05, decay: 0.35, gain: 0.25, lp: 900 }),
  enemy_swing: (o) => noise(o, { freq: 400, freqEnd: 1400, q: 1.2, attack: 0.03, decay: 0.2, gain: 0.35 }),
  death_ghoul: (o) => death(o, 160),
  death_fiend: (o) => death(o, 110),
  death_brute: (o) => death(o, 70),
  slam: (o) => {
    tone(o, { freq: 70, freqEnd: 28, attack: 0.005, decay: 0.7, gain: 0.75 });
    noise(o, { type: 'lowpass', freq: 700, freqEnd: 60, decay: 0.6, gain: 0.65 });
  },
  burst: (o) => noise(o, { freq: 1200, freqEnd: 200, q: 0.7, decay: 0.35, gain: 0.45 }),
  fireball: (o) => noise(o, { freq: 300, freqEnd: 1600, q: 0.8, attack: 0.05, decay: 0.3, gain: 0.35 }),
  roar: (o) => {
    tone(o, { type: 'sawtooth', freq: 70, freqEnd: 45, attack: 0.15, decay: 1.4, gain: 0.4, lp: 500 });
    tone(o, { type: 'sawtooth', freq: 105, freqEnd: 60, attack: 0.15, decay: 1.3, gain: 0.25, lp: 700 });
    noise(o, { freq: 300, freqEnd: 150, q: 2, attack: 0.2, decay: 1.2, gain: 0.35 });
  },
  nova: (o) => {
    tone(o, { freq: 90, freqEnd: 30, decay: 0.8, gain: 0.6 });
    noise(o, { freq: 2000, freqEnd: 200, q: 0.5, decay: 0.7, gain: 0.55 });
  },
  step: (o) => {
    tone(o, { freq: 200, freqEnd: 900, attack: 0.02, decay: 0.25, gain: 0.25 });
    noise(o, { freq: 3000, freqEnd: 600, q: 2, decay: 0.3, gain: 0.2 });
  },
  siphon: (o) => {
    for (let i = 0; i < 3; i++) tone(o, { freq: 60, freqEnd: 40, decay: 0.15, gain: 0.4, delay: i * 0.18 });
    tone(o, { type: 'triangle', freq: 300, freqEnd: 150, attack: 0.1, decay: 0.6, gain: 0.14 });
  },
  drink: (o) => {
    for (let i = 0; i < 3; i++) noise(o, { type: 'lowpass', freq: 500, freqEnd: 200, decay: 0.08, gain: 0.4, delay: i * 0.17 });
  },
  pickup: (o) => [523, 659, 784].forEach((f, i) => tone(o, { type: 'triangle', freq: f, decay: 0.25, gain: 0.14, delay: i * 0.06 })),
  choose: (o) => {
    [196, 247, 294, 392].forEach((f, i) => tone(o, { type: 'triangle', freq: f, decay: 0.8, gain: 0.14, delay: i * 0.1 }));
    tone(o, { freq: 60, freqEnd: 40, decay: 1.2, gain: 0.35 });
  },
  portal: (o) => {
    tone(o, { type: 'sawtooth', freq: 55, freqEnd: 30, attack: 0.3, decay: 1.6, gain: 0.3, lp: 300 });
    noise(o, { freq: 200, freqEnd: 2000, q: 1, attack: 0.6, decay: 1.0, gain: 0.3 });
  },
  seal: (o) => {
    tone(o, { type: 'triangle', freq: 220, freqEnd: 110, decay: 1.4, gain: 0.22 });
    noise(o, { freq: 4000, freqEnd: 800, q: 4, decay: 0.6, gain: 0.18 });
  },
  player_death: (o) => {
    tone(o, { type: 'sawtooth', freq: 110, freqEnd: 25, attack: 0.05, decay: 2.5, gain: 0.35, lp: 400 });
    noise(o, { type: 'lowpass', freq: 400, freqEnd: 40, decay: 2.0, gain: 0.45 });
  },
  heartbeat: (o) => {
    tone(o, { freq: 55, freqEnd: 40, decay: 0.16, gain: 0.6 });
    tone(o, { freq: 50, freqEnd: 36, decay: 0.2, gain: 0.5, delay: 0.22 });
  },
  // A parry: steel meeting steel cleanly, a bright ring that hangs, and a
  // low thump of the blow thrown back.
  parry: (o) => {
    for (const [f, g, d] of [[1046, 0.2, 0.9], [1568, 0.12, 0.7], [2093, 0.08, 0.5], [523, 0.1, 0.6]]) tone(o, { type: 'triangle', freq: f, freqEnd: f * 0.995, attack: 0.002, decay: d, gain: g });
    noise(o, { type: 'highpass', freq: 4200, decay: 0.05, gain: 0.6 });
    tone(o, { freq: 90, freqEnd: 45, decay: 0.2, gain: 0.55 });
  },
  // A demon hopping clear: a short rush of air and a scuff.
  whoosh: (o) => {
    noise(o, { freq: 500, freqEnd: 1500, q: 0.9, attack: 0.05, decay: 0.16, gain: 0.35 });
    noise(o, { type: 'lowpass', freq: 400, freqEnd: 120, decay: 0.08, gain: 0.25, delay: 0.12 });
  },
  // Vanishing into shadow: an indrawn breath of air under a falling hum.
  blink: (o) => {
    noise(o, { freq: 3000, freqEnd: 300, q: 1.2, attack: 0.12, decay: 0.12, gain: 0.4 });
    tone(o, { type: 'sawtooth', freq: 220, freqEnd: 55, attack: 0.05, decay: 0.35, gain: 0.18, lp: 900 });
    tone(o, { freq: 660, freqEnd: 110, attack: 0.02, decay: 0.3, gain: 0.08 });
  },
  // Slime bursting out of an urn and slopping over the blade.
  slime: (o) => {
    squelch(o, { dur: 0.35, gain: 0.7, freq: 500 });
    squelch(o, { delay: 0.12, dur: 0.3, gain: 0.45, freq: 800 });
    noise(o, { type: 'lowpass', freq: 600, freqEnd: 150, decay: 0.2, gain: 0.4 });
  },
  // A burning blade guttering out: a hiss and a puff.
  extinguish: (o) => {
    noise(o, { type: 'highpass', freq: 2500, attack: 0.02, decay: 0.5, gain: 0.35 });
    noise(o, { type: 'lowpass', freq: 500, freqEnd: 120, decay: 0.25, gain: 0.3 });
  },
  // The arm giving way under a block held too long.
  guard_drop: (o) => {
    tone(o, { type: 'triangle', freq: 700, freqEnd: 380, decay: 0.25, gain: 0.45 });
    noise(o, { type: 'lowpass', freq: 900, freqEnd: 200, decay: 0.15, gain: 1.1 });
  },
  // A burning blade through the air: a low roar of flame swept past.
  flame_swing: (o) => {
    swish(o, { dur: 0.32, f0: 200, f1: 900, f2: 300, peak: 0.45, q: 1.2, gain: 0.5, low: 1.2, edge: 0.05 });
    for (let i = 0; i < 6; i++) noise(o, { type: 'highpass', freq: 2500, decay: 0.01, gain: 0.12, delay: 0.05 + rnd() * 0.2 });
    punch(o, 1.8);
  },
  // Footsteps, three takes of each ground.
  ...steps('stone', (o, k) => {
    noise(o, { type: 'lowpass', freq: 420 + 80 * k, freqEnd: 140, decay: 0.07, gain: 0.7 });
    noise(o, { freq: 1700 + 400 * k, q: 1.3, decay: 0.045, gain: 0.18, delay: 0.005 });
    noise(o, { type: 'highpass', freq: 3500, decay: 0.006, gain: 0.12 });
  }),
  ...steps('gravel', (o, k) => {
    noise(o, { type: 'lowpass', freq: 380, freqEnd: 120, decay: 0.06, gain: 0.55 });
    for (let i = 0; i < 7; i++) noise(o, { freq: 1800 + rnd() * 2600, q: 3, decay: 0.012 + rnd() * 0.015, gain: 0.22, delay: 0.004 + rnd() * 0.09 + k * 0.004 });
  }),
  ...steps('wet', (o, k) => {
    noise(o, { type: 'lowpass', freq: 380, freqEnd: 130, decay: 0.06, gain: 0.5 });
    squelch(o, { dur: 0.14 + 0.03 * k, gain: 0.4, freq: 700 + 150 * k });
    noise(o, { freq: 1400 + 200 * k, freqEnd: 700, q: 1.2, attack: 0.01, decay: 0.12, gain: 0.25, delay: 0.02 });
  }),
  ...steps('bone', (o, k) => {
    noise(o, { type: 'lowpass', freq: 350, freqEnd: 120, decay: 0.05, gain: 0.45 });
    for (let i = 0; i < 3; i++) tone(o, { type: 'triangle', freq: 900 + rnd() * 900 + 120 * k, freqEnd: 700, decay: 0.03 + rnd() * 0.03, gain: 0.14, delay: i * (0.018 + rnd() * 0.02) });
    noise(o, { freq: 2600, q: 2, decay: 0.03, gain: 0.15, delay: 0.01 });
  }),
  ...steps('ash', (o, k) => {
    noise(o, { type: 'lowpass', freq: 1100 + 200 * k, freqEnd: 300, attack: 0.008, decay: 0.11, gain: 0.45 });
    for (let i = 0; i < 4; i++) noise(o, { freq: 1500 + rnd() * 1500, q: 2, decay: 0.02, gain: 0.08, delay: 0.01 + rnd() * 0.07 });
  }),
  ...steps('flesh', (o, k) => {
    noise(o, { type: 'lowpass', freq: 300, freqEnd: 100, decay: 0.08, gain: 0.55 });
    squelch(o, { dur: 0.18 + 0.03 * k, gain: 0.5, freq: 450 + 100 * k });
  }),
};

// Three takes of a footstep, all brought to the same level.
function steps(name, make) {
  const take = (k) => (o) => {
    make(o, k);
    let m = 0;
    for (const v of o) m = Math.max(m, Math.abs(v));
    for (let i = 0; i < o.length; i++) o[i] *= 0.7 / m;
  };
  return Object.fromEntries([0, 1, 2].map((k) => [`step_${name}_${k + 1}`, take(k)]));
}

function squelch(o, { delay = 0, dur = 0.2, gain = 0.5, freq = 900 }) {
  const start = Math.floor(delay * RATE);
  const n = Math.floor(dur * RATE);
  const f = biquad('bandpass', 2.5);
  for (let i = 0; i < n && start + i < o.length; i++) {
    const t = i / RATE;
    const wob = 0.5 + 0.5 * Math.sin(2 * Math.PI * (38 + 25 * rnd()) * t);
    const cutoff = freq * (0.6 + 0.8 * wob) * (1 - t / dur * 0.6);
    o[start + i] += f(rnd() * 2 - 1, cutoff) * gain * 2.5 * env(t, 0.01, dur) * wob;
  }
}

function flesh(o, k) {
  noise(o, { freq: 5000 * k, freqEnd: 1400 * k, q: 1.1, attack: 0.004, decay: 0.09, gain: 0.5 });
  squelch(o, { delay: 0.02, dur: 0.22, gain: 0.6, freq: 900 * k });
  tone(o, { freq: 120 * k, freqEnd: 45, decay: 0.16, gain: 0.5, delay: 0.01 });
  noise(o, { type: 'lowpass', freq: 1200 * k, freqEnd: 200, decay: 0.1, gain: 0.35, delay: 0.015 });
}

function growl(o, f) {
  tone(o, { type: 'sawtooth', freq: f, freqEnd: f * 0.7, attack: 0.08, decay: 0.55, gain: 0.3, lp: 700 });
  noise(o, { freq: f * 4, freqEnd: f * 2, q: 3, attack: 0.08, decay: 0.5, gain: 0.2 });
}

function death(o, f) {
  tone(o, { type: 'sawtooth', freq: f, freqEnd: f * 0.3, attack: 0.02, decay: 0.8, gain: 0.3, lp: 800 });
  noise(o, { type: 'lowpass', freq: 600, freqEnd: 80, decay: 0.5, gain: 0.4 });
}

// A seamless 12 s drone: detuned saws through a low-pass over a sub tone,
// swelling slowly, with a faint pair of beating tones far above. No noise at
// all: a noise layer here played as constant static.
function drone() {
  const secs = 12;
  const o = track(secs);
  const lp = biquad('lowpass', 0.7);
  const n = o.length;
  // Frequencies chosen to complete whole cycles in 12 s, so the loop is seamless.
  const freqs = [41 + 1 / 12, 41.5 + 1 / 12, 61.5];
  const phases = freqs.map(() => 0);
  const TAU = 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    let s = 0;
    freqs.forEach((f, k) => {
      phases[k] = (phases[k] + f / RATE) % 1;
      s += 2 * phases[k] - 1;
    });
    const t = i / RATE;
    const swell = 0.8 + 0.2 * Math.sin((TAU * t) / secs);
    const v = lp(s / 3, 160) * 0.55 * swell;
    const sub = Math.sin(TAU * 30.75 * t) * 0.18;
    const far = (Math.sin(TAU * (110 + 1 / 12) * t) + Math.sin(TAU * 110.5 * t)) * 0.025 * (0.6 + 0.4 * Math.sin((TAU * t) / 6));
    o[i] = v + sub + far;
  }
  // Crossfade the ends so filter state does not click at the loop point.
  const fade = Math.floor(RATE * 0.3);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    o[i] = o[i] * k + o[n - fade + i] * (1 - k);
  }
  return o.subarray(0, n - fade);
}

// ---- The intro song ------------------------------------------------------
//
// For the title and the surface, until you jump: the earth itself groaning
// (a low drone, a rumble and a throat-sung vowel slowly shifting over it),
// then a war drum, far apart at first, beating quicker and quicker, a
// higher drum and rattles joining it, until it runs into a driving loop
// (intro_loop) that plays on at that pace.

const SONG_BUILD = INTRO_SECONDS;
const BEAT_START = 1.5;
const BEAT_END = 0.25;
const LOOP = 8;

// The groaning earth: E1, its octave, a rumble, a vowel. Whole cycles in
// LOOP seconds, so the loop's copy of it loops seamlessly.
function earth(o, from, secs, swell = () => 1) {
  const f = 41.25;
  const n = Math.floor(secs * RATE);
  const lp = biquad('lowpass', 0.7);
  const rum = biquad('lowpass', 0.6);
  const vowel = biquad('bandpass', 4);
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  for (let i = 0; i < n; i++) {
    const t = from + i / RATE;
    p1 = (p1 + f / RATE) % 1;
    p2 = (p2 + (f * 2.004) / RATE) % 1;
    p3 = (p3 + (f * 2) / RATE) % 1;
    const saw = (2 * p1 - 1) * 0.6 + (2 * p2 - 1) * 0.4;
    let v = lp(saw, 140 + 90 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / LOOP))) * 0.55;
    v += Math.sin(2 * Math.PI * f * t) * 0.35;
    v += rum(rnd() * 2 - 1, 90) * 1.6;
    const throat = (2 * p3 - 1) * 0.5;
    v += vowel(throat, 380 + 260 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / LOOP + 1))) * 0.35;
    o[i] += v * swell(t);
  }
}

// A war drum: a deep skin whose pitch drops as it rings, a slap of the
// stick, and air.
function drum(o, at, { f0 = 95, f1 = 44, decay = 0.65, gain = 0.9, slap = 0.35 } = {}) {
  const start = Math.floor(at * RATE);
  const n = Math.floor((decay + 0.05) * RATE);
  const lp = biquad('lowpass', 0.7);
  let ph = 0;
  for (let i = 0; i < n && start + i < o.length; i++) {
    if (start + i < 0) continue;
    const t = i / RATE;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.05);
    ph += f / RATE;
    const env = Math.exp(-t / (decay * 0.35));
    o[start + i] += (Math.sin(2 * Math.PI * ph) * env + lp(rnd() * 2 - 1, 900) * Math.exp(-t / 0.02) * slap) * gain;
  }
}
const hiDrum = (o, at, gain = 0.4) => drum(o, at, { f0: 240, f1: 170, decay: 0.18, gain, slap: 0.6 });
function rattle(o, at, gain = 0.12) {
  noise(o, { type: 'highpass', freq: 5000, attack: 0.006, decay: 0.05, gain, delay: at });
}

function song() {
  // The build: the drum's beat shrinks from BEAT_START to BEAT_END seconds.
  const intro = track(SONG_BUILD + 1.5);
  earth(intro, 0, SONG_BUILD + 1.5, (t) => Math.min(1, t / 5) * (0.8 + 0.2 * Math.min(1, t / SONG_BUILD)));
  const lead = 6;
  const span = SONG_BUILD - lead;
  let t = lead;
  let k = 0;
  while (t < SONG_BUILD - 0.01) {
    const u = (t - lead) / span;
    const beat = BEAT_START * Math.pow(BEAT_END / BEAT_START, u);
    const accent = k % 4 === 0;
    drum(intro, t, { gain: (accent ? 0.95 : 0.7) * (0.6 + 0.4 * u), f0: accent ? 90 : 105, decay: accent ? 0.75 : 0.5 });
    if (u > 0.35) hiDrum(intro, t + beat / 2, 0.22 + 0.25 * u);
    if (u > 0.65) {
      rattle(intro, t + beat / 4, 0.06 + 0.1 * u);
      rattle(intro, t + (beat * 3) / 4, 0.06 + 0.1 * u);
    }
    t += beat;
    k++;
  }
  // The loop: the same earth and drums at the final pace, LOOP seconds that
  // join end to start (rendered with a second either side, then cut).
  const pad = 1;
  const whole = track(LOOP + 2 * pad);
  earth(whole, -pad, LOOP + 2 * pad);
  for (let b = -8; b < (LOOP + 2 * pad) / BEAT_END + 8; b++) {
    const at = pad + b * BEAT_END;
    const accent = ((b % 4) + 4) % 4 === 0;
    drum(whole, at, { gain: accent ? 1 : 0.72, f0: accent ? 90 : 105, decay: accent ? 0.75 : 0.5 });
    hiDrum(whole, at + BEAT_END / 2, 0.45);
    rattle(whole, at + BEAT_END / 4, 0.15);
    rattle(whole, at + (BEAT_END * 3) / 4, 0.15);
  }
  const loop = whole.slice(Math.floor(pad * RATE), Math.floor((pad + LOOP) * RATE));
  return { intro, loop };
}

function normalize(o, peak = 0.8) {
  let m = 0;
  for (const v of o) m = Math.max(m, Math.abs(v));
  if (m > peak) for (let i = 0; i < o.length; i++) o[i] *= peak / m;
  return o;
}

function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

export async function makeSounds(outDir) {
  await mkdir(outDir, { recursive: true });
  let bytes = 0;
  for (const [name, make] of Object.entries(SOUNDS)) {
    const o = track(3);
    make(o);
    // Trim trailing silence.
    let end = o.length;
    while (end > 1 && Math.abs(o[end - 1]) < 1e-4) end--;
    const data = wav(normalize(o.subarray(0, Math.min(o.length, end + 200))));
    bytes += data.length;
    await writeFile(join(outDir, `${name}.wav`), data);
  }
  const d = wav(normalize(drone(), 0.6));
  bytes += d.length;
  await writeFile(join(outDir, 'drone.wav'), d);
  const { intro, loop } = song();
  // Both at the same level, so the build runs straight into the loop.
  let peak = 0;
  for (const a of [intro, loop]) for (const v of a) peak = Math.max(peak, Math.abs(v));
  for (const [name, a] of [['intro', intro], ['intro_loop', loop]]) {
    for (let i = 0; i < a.length; i++) a[i] *= 0.85 / peak;
    const w = wav(a);
    bytes += w.length;
    await writeFile(join(outDir, `${name}.wav`), w);
  }
  return { count: Object.keys(SOUNDS).length + 3, bytes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || 'assets/sounds';
  const { count, bytes } = await makeSounds(out);
  console.log(`${count} sounds, ${(bytes / 1024).toFixed(0)} KB -> ${out}`);
}
