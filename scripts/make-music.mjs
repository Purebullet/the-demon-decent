// The intro song, rendered offline like the sound effects (make-sounds.mjs
// writes it): played on the title and the surface until you jump.
//
//   0-10 s   the earth: a deep drone on D, a rumble, a low horn calling a
//            slow phrase in D Phrygian (D Eb F G A Bb C), all in a cavern's
//            reverb
//   10-44 s  war drums, a slow heartbeat at first, quickening from 54 to 150
//            beats a minute; toms, rim clicks and shakers join as it speeds
//            up, a choir rises under the horn, the horn climbs an octave, and
//            a riser and a swell crest into ...
//   loop     ... eight bars at 150: the taiko groove with fills, a pulsing
//            bass, the horn's theme over choir chords. It loops seamlessly
//            until the jump.
//
// song() returns { intro, loop }: Float32Arrays at RATE, the intro running
// INTRO_SECONDS before the loop takes over (plus a tail that is cut off).

import { INTRO_SECONDS } from '../src/core/soundFormat.js';

export const RATE = 22050;
const INTRO = INTRO_SECONDS;
const BPM = 150;
const BEAT = 60 / BPM;
const BARS = 8;
export const LOOP_SECONDS = BARS * 4 * BEAT;

// Notes (Hz).
const N = { D1: 36.71, Eb1: 38.89, C1: 32.7, D2: 73.42, Eb2: 77.78, F2: 87.31, G2: 98, A2: 110, Bb2: 116.54, C2: 65.41, C3: 130.81, D3: 146.83, Eb3: 155.56, F3: 174.61, G3: 196, A3: 220, Bb3: 233.08, D4: 293.66 };

let seed = 666;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const white = () => rnd() * 2 - 1;

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
      b2 = b0;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    const a0 = 1 + alpha;
    const y = (b0 * x + b1 * x1 + b2 * x2 + 2 * cos * y1 - (1 - alpha) * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}
const saw = (ph) => 2 * (ph - Math.floor(ph)) - 1;

// A mix: what is heard dry, and what is sent to the reverb.
class Mix {
  constructor(seconds) {
    this.dry = new Float32Array(Math.ceil(seconds * RATE));
    this.wet = new Float32Array(this.dry.length);
  }
  add(i, v, send) {
    if (i < 0 || i >= this.dry.length) return;
    this.dry[i] += v;
    this.wet[i] += v * send;
  }
}

// ---- Instruments ------------------------------------------------------------

// The earth: a drone on f (two saws a breath apart and the octave, under a
// slowly breathing lowpass, over a sine), from..to s, loudness amp(t).
function drone(m, from, to, f, amp) {
  const lp = biquad('lowpass', 0.9);
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) {
    const t = i / RATE;
    p1 += f / RATE;
    p2 += (f * 1.004) / RATE;
    p3 += (f * 1.998) / RATE;
    const raw = saw(p1) * 0.5 + saw(p2) * 0.5 + saw(p3) * 0.35;
    const cut = 110 + 130 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / LOOP_SECONDS));
    const v = lp(raw, cut) * 0.55 + Math.sin(2 * Math.PI * f * t) * 0.5;
    m.add(i, v * amp(t) * 0.32, 0.35);
  }
}

// The ground groaning: deep, slow, brown noise.
function rumble(m, from, to, amp) {
  const lp = biquad('lowpass', 0.7);
  const lp2 = biquad('lowpass', 1.6);
  let b = 0;
  for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) {
    const t = i / RATE;
    b = b * 0.995 + white() * 0.1;
    const groan = 70 + 40 * Math.sin(t * 0.7) * Math.sin(t * 0.23);
    m.add(i, (lp(b, 90) * 1.4 + lp2(b, groan) * 0.8) * amp(t) * 0.07, 0.4);
  }
}

// A low horn: brassy saws, the filter opening at the attack, vibrato once held.
function horn(m, at, dur, f, gain, send = 0.45) {
  const lp = biquad('lowpass', 1.2);
  let p1 = 0;
  let p2 = 0;
  const n = Math.floor((dur + 0.6) * RATE);
  const s = Math.floor(at * RATE);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, Math.max(0, (t - 0.35) / 0.4));
    p1 += (f * vib) / RATE;
    p2 += (f * 1.006 * vib) / RATE;
    const a = Math.min(1, t / 0.12) * (t > dur ? Math.exp(-(t - dur) / 0.18) : 1);
    const bright = Math.min(1, t / 0.15) * (0.55 + 0.45 * Math.exp(-t / 0.6));
    const v = lp(saw(p1) + saw(p2) * 0.7, f * (1.6 + 7 * bright));
    m.add(s + i, v * a * gain, send);
  }
}

// A choir: voices on each note, through the formants of a dark "oh".
function choir(m, at, dur, notes, gain) {
  const s = Math.floor(at * RATE);
  const n = Math.floor((dur + 1.6) * RATE);
  for (const f of notes) {
    const forms = [
      [biquad('bandpass', 5), 480, 1],
      [biquad('bandpass', 7), 820, 0.55],
      [biquad('bandpass', 9), 2500, 0.18],
    ];
    const body = biquad('lowpass', 0.7);
    const ph = [rnd(), rnd(), rnd()];
    const det = [1, 1.0055, 0.9947];
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      let raw = 0;
      for (let k = 0; k < 3; k++) {
        ph[k] += (f * det[k] * (1 + 0.003 * Math.sin(t * (4.1 + k)))) / RATE;
        raw += saw(ph[k]);
      }
      let v = body(raw, 380) * 0.4;
      for (const [bp, ff, w] of forms) v += bp(raw, ff) * w;
      const a = Math.min(1, t / 1.3) * (t > dur ? Math.exp(-(t - dur) / 0.6) : 1);
      m.add(s + i, v * a * gain * 0.35, 0.7);
    }
  }
}

// A plucked bass note: a saw, its filter snapping shut.
function bass(m, at, dur, f, gain) {
  const lp = biquad('lowpass', 2);
  let p = 0;
  const s = Math.floor(at * RATE);
  for (let i = 0; i < Math.floor((dur + 0.08) * RATE); i++) {
    const t = i / RATE;
    p += f / RATE;
    const a = Math.min(1, t / 0.004) * Math.exp(-t / (dur * 0.9));
    const v = lp(saw(p) + Math.sin(2 * Math.PI * p) * 0.8, 120 + 900 * Math.exp(-t / 0.05));
    m.add(s + i, v * a * gain, 0.1);
  }
}

// A taiko: the skin's pitch drops as it rings, its wood body, the stick.
function taiko(m, at, gain, tune = 1) {
  const s = Math.floor(at * RATE);
  const bp = biquad('bandpass', 2);
  const hp = biquad('highpass', 0.7);
  let p = 0;
  let p2 = 0;
  for (let i = 0; i < Math.floor(1.3 * RATE); i++) {
    const t = i / RATE;
    const f = (52 + 120 * Math.exp(-t / 0.028)) * tune;
    p += f / RATE;
    p2 += (f * 1.58) / RATE;
    const x = white();
    const v = Math.sin(2 * Math.PI * p) * Math.exp(-t / 0.3) + Math.sin(2 * Math.PI * p2) * 0.25 * Math.exp(-t / 0.08) + bp(x, 210 * tune) * 1.2 * Math.exp(-t / 0.05) + hp(x, 1600) * 0.4 * Math.exp(-t / 0.01);
    m.add(s + i, v * gain, 0.3);
  }
}

// A tom, higher and shorter.
function tom(m, at, gain, f = 170) {
  const s = Math.floor(at * RATE);
  const bp = biquad('bandpass', 2.5);
  let p = 0;
  for (let i = 0; i < Math.floor(0.6 * RATE); i++) {
    const t = i / RATE;
    p += (f * (1 + 0.6 * Math.exp(-t / 0.02))) / RATE;
    const v = Math.sin(2 * Math.PI * p) * Math.exp(-t / 0.16) + bp(white(), f * 1.6) * 0.6 * Math.exp(-t / 0.04);
    m.add(s + i, v * gain, 0.3);
  }
}

// A rim: a clack of wood.
function rim(m, at, gain) {
  const s = Math.floor(at * RATE);
  const bp = biquad('bandpass', 6);
  for (let i = 0; i < Math.floor(0.08 * RATE); i++) {
    const t = i / RATE;
    m.add(s + i, (bp(white(), 2300) * 2 * Math.exp(-t / 0.008) + Math.sin(2 * Math.PI * 1150 * t) * 0.35 * Math.exp(-t / 0.014)) * gain, 0.2);
  }
}

// A shaker: a hiss of seeds.
function shaker(m, at, gain) {
  const s = Math.floor(at * RATE);
  const hp = biquad('highpass', 0.8);
  for (let i = 0; i < Math.floor(0.12 * RATE); i++) {
    const t = i / RATE;
    m.add(s + i, hp(white(), 6000) * Math.min(1, t / 0.008) * Math.exp(-t / 0.03) * gain, 0.15);
  }
}

// A boom from below: a long falling sine and a thump.
function boom(m, at, gain) {
  const s = Math.floor(at * RATE);
  const lp = biquad('lowpass', 0.7);
  let p = 0;
  for (let i = 0; i < Math.floor(2.2 * RATE); i++) {
    const t = i / RATE;
    p += (30 + 30 * Math.exp(-t / 0.15)) / RATE;
    m.add(s + i, (Math.sin(2 * Math.PI * p) * Math.exp(-t / 0.9) + lp(white(), 140) * 2 * Math.exp(-t / 0.06)) * gain, 0.35);
  }
}

// Noise rising in pitch and loudness from..to.
function riser(m, from, to, gain) {
  const bp = biquad('bandpass', 1.5);
  for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) {
    const k = (i / RATE - from) / (to - from);
    m.add(i, bp(white(), 250 * Math.pow(16, k)) * k * k * gain, 0.5);
  }
}

// A cymbal played backwards into the downbeat.
function swell(m, from, to, gain) {
  const hp = biquad('highpass', 0.7);
  for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) {
    const k = (i / RATE - from) / (to - from);
    m.add(i, hp(white(), 4500) * k * k * k * gain, 0.6);
  }
}

// ---- Reverb (Freeverb's combs and allpasses, mono) ---------------------------

function reverb(input, { room = 0.86, damp = 0.32 } = {}) {
  const out = new Float32Array(input.length);
  const combs = [557, 593, 641, 677, 723, 769, 811, 853].map((d) => ({ buf: new Float32Array(d), i: 0, store: 0 }));
  const aps = [278, 214, 113, 69].map((d) => ({ buf: new Float32Array(d), i: 0 }));
  for (let n = 0; n < input.length; n++) {
    const x = input[n] * 0.12;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.store = o * (1 - damp) + c.store * damp;
      c.buf[c.i] = x + c.store * room;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = y + b * 0.5;
      y = b - y;
      a.i = (a.i + 1) % a.buf.length;
    }
    out[n] = y;
  }
  return out;
}

function finish(m, wet = 0.9) {
  const r = reverb(m.wet);
  const out = new Float32Array(m.dry.length);
  // A gentle glue: loud hits round off, the quiet stays quiet.
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh((m.dry[i] + r[i] * wet) * 0.9) / 0.9;
  return out;
}

// The middle cycle of three, its end run into its start: the half second
// after the cycle crossfaded over its first half second, so where the loop
// wraps round it carries straight on.
function seamless(all, L, fade = 0.5) {
  const n = Math.floor(L * RATE);
  const f = Math.floor(fade * RATE);
  const out = all.slice(n, 2 * n);
  for (let i = 0; i < f; i++) {
    const k = i / f;
    out[i] = out[i] * Math.sin((k * Math.PI) / 2) + all[2 * n + i] * Math.cos((k * Math.PI) / 2);
  }
  return out;
}

// ---- The loop's eight bars ---------------------------------------------------

// Bars of D Phrygian: the chord over each bar, the bass note under it.
const CHORDS = [
  [N.D3, N.F3, N.A3],
  [N.D3, N.F3, N.A3],
  [N.Eb3, N.G3, N.Bb3],
  [N.D3, N.F3, N.A3],
  [N.D3, N.F3, N.A3],
  [N.D3, N.F3, N.Bb3],
  [N.C3, N.Eb3, N.G3],
  [N.Eb3, N.G3, N.Bb3],
];
const ROOTS = [N.D1, N.D1, N.Eb1, N.D1, N.D1, N.D1, N.C1, N.Eb1];
// The horn's theme over the eight bars: [beat, beats long, note].
const THEME = [
  [0, 3, N.D3], [3, 0.5, N.Eb3], [3.5, 0.5, N.F3], [4, 2, N.Eb3], [6, 2, N.D3],
  [8, 1.5, N.F3], [9.5, 0.5, N.G3], [10, 2, N.F3], [12, 1, N.Eb3], [13, 3, N.D3],
  [16, 3, N.D3], [19, 0.5, N.Eb3], [19.5, 0.5, N.F3], [20, 2, N.G3], [22, 2, N.A3],
  [24, 2, N.G3], [26, 1, N.F3], [27, 1, N.Eb3], [28, 4, N.D3],
];

// One cycle of the groove (drums, bass, horn, choir), starting at t0.
function groove(m, t0, { drums = 1, horn: hornGain = 0.13, choirGain = 0.5, bassGain = 0.32 } = {}) {
  for (let bar = 0; bar < BARS; bar++) {
    const b0 = t0 + bar * 4 * BEAT;
    const at = (beat) => b0 + beat * BEAT;
    const fill = bar === 3 || bar === 7;
    // Taiko: the downbeat hard, a push before three, and the backbeat.
    taiko(m, at(0), 0.95 * drums, 0.9);
    taiko(m, at(1.5), 0.55 * drums, 1.05);
    taiko(m, at(2), 0.75 * drums, 1);
    taiko(m, at(3), 0.6 * drums, 1.05);
    if (!fill) taiko(m, at(3.5), 0.4 * drums, 1.1);
    if (bar === 0 || bar === 4) boom(m, at(0), 0.7 * drums);
    tom(m, at(0.75), 0.25 * drums, 190);
    tom(m, at(2.5), 0.3 * drums, 165);
    if (fill) [[3, 230], [3.25, 200], [3.5, 170], [3.75, 140]].forEach(([b, f], k) => tom(m, at(b), (0.45 + k * 0.08) * drums, f));
    for (let e = 0; e < 8; e++) rim(m, at(e / 2), (e % 2 ? 0.28 : 0.16) * drums);
    for (let x = 0; x < 16; x++) shaker(m, at(x / 4), (x % 4 === 2 ? 0.22 : 0.12) * drums);
    // The bass on the eighths: the root, its octave on the and of two.
    for (let e = 0; e < 8; e++) bass(m, at(e / 2), BEAT * 0.45, e === 3 || e === 7 ? ROOTS[bar] * 2 : ROOTS[bar], bassGain * (e % 2 ? 0.7 : 1));
    choir(m, b0, 4 * BEAT, CHORDS[bar], choirGain);
  }
  for (const [beat, len, f] of THEME) horn(m, t0 + beat * BEAT, len * BEAT * 0.95, f, hornGain);
}

export function song() {
  // ---- The build ----
  const intro = new Mix(INTRO + 2);
  drone(intro, 0, INTRO + 2, N.D1, (t) => Math.min(1, t / 6) * (0.75 + 0.25 * Math.min(1, t / INTRO)));
  rumble(intro, 0, INTRO + 2, (t) => 0.6 + 0.4 * Math.sin(Math.min(1, t / 8) * Math.PI * 0.5));
  // The horn calls, slowly at first, then higher as the drums quicken.
  const phrase = (t, notes, gain) => {
    let at = t;
    for (const [len, f] of notes) {
      horn(intro, at, len * 0.94, f, gain);
      at += len;
    }
  };
  phrase(2.5, [[3, N.D2], [1.5, N.F2], [1.5, N.Eb2], [4, N.D2]], 0.16);
  phrase(13, [[2, N.D2], [1, N.F2], [1, N.G2], [1, N.F2], [1, N.Eb2], [3.5, N.D2]], 0.16);
  phrase(24, [[1.4, N.D3], [0.7, N.F3], [0.7, N.Eb3], [1.4, N.D3], [0.7, N.C3], [0.7, N.Eb3], [2.4, N.D3]], 0.13);
  phrase(33, [[0.9, N.D3], [0.45, N.F3], [0.45, N.G3], [0.45, N.F3], [0.45, N.Eb3], [0.9, N.D3], [0.45, N.C3], [0.45, N.Eb3], [1.8, N.D3]], 0.13);
  // The choir rises under it.
  choir(intro, 11, 8, [N.D3, N.A3], 0.35);
  choir(intro, 19, 6, [N.Eb3, N.Bb3], 0.38);
  choir(intro, 25, 5, [N.D3, N.F3, N.A3], 0.42);
  choir(intro, 30, 4, [N.D3, N.F3, N.Bb3], 0.45);
  choir(intro, 34, 4, [N.C3, N.Eb3, N.G3], 0.48);
  choir(intro, 38, 6, [N.Eb3, N.G3, N.Bb3], 0.52);
  // The drums: beats from 10 s quickening from 54 to 150 a minute, the grid
  // stretched a touch so that the beat after the last lands exactly on
  // INTRO, the loop's first.
  const start = 10;
  const gaps = [];
  let t = start;
  while (t < INTRO) {
    const k = Math.min(1, (t - start) / (INTRO - start));
    const gap = 60 / (54 + 96 * Math.pow(k, 1.7));
    gaps.push(gap);
    t += gap;
  }
  const sum = gaps.reduce((a, b) => a + b, 0);
  const stretch = (INTRO - start) / sum;
  t = start;
  boom(intro, start, 0.8);
  gaps.forEach((g0, n) => {
    const gap = g0 * stretch;
    const bpm = 60 / gap;
    const pos = n % 4;
    const bar = Math.floor(n / 4);
    const swell2 = Math.min(1, (t - start) / (INTRO - start));
    if (bpm < 78) {
      // A heartbeat: lub-dub.
      taiko(intro, t, 0.7 + 0.2 * (pos === 0), 0.9);
      taiko(intro, t + Math.min(0.24, gap * 0.28), 0.38, 1.05);
    } else {
      taiko(intro, t, (pos === 0 ? 0.95 : 0.65) * (0.75 + 0.25 * swell2), pos === 0 ? 0.9 : 1.02);
      if (pos % 2 === 1) tom(intro, t + gap / 2, 0.24, 180);
    }
    if (bpm >= 95) {
      rim(intro, t + gap / 2, 0.22 * swell2);
      if (bpm >= 110) for (let x = 0; x < 4; x++) shaker(intro, t + (x * gap) / 4, (x === 2 ? 0.2 : 0.1) * swell2);
    }
    if (bpm >= 120 && pos === 2) taiko(intro, t + gap / 2, 0.45, 1.1);
    if (bpm >= 110 && pos === 3 && bar % 4 === 3) [0, 0.25, 0.5, 0.75].forEach((f, k) => tom(intro, t + f * gap, 0.35 + 0.08 * k, 230 - 30 * k));
    if (bpm >= 100 && pos === 0 && bar % 4 === 0) boom(intro, t, 0.5);
    t += gap;
  });
  riser(intro, 37, INTRO, 0.32);
  swell(intro, 41, INTRO, 0.3);

  // ---- The loop ----
  // Three cycles, the middle one kept: its reverb carries the tail of the
  // one before, so the end runs into the start without a seam.
  const L = LOOP_SECONDS;
  const loop = new Mix(L * 3);
  drone(loop, 0, L * 3, N.D1, () => 1);
  rumble(loop, 0, L * 3, () => 0.8);
  for (let c = 0; c < 3; c++) groove(loop, c * L);
  const mixedLoop = seamless(finish(loop), L);
  // The build ends on the loop's downbeat: its last moments carry the
  // loop's opening boom and taiko, so the handover hits on the beat.
  groove(intro, INTRO, { drums: 1, horn: 0, choirGain: 0, bassGain: 0 });
  return { intro: finish(intro), loop: mixedLoop };
}
