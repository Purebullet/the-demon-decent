// Renders the game's sound effects offline into small WAV files: Project 0's
// sandbox plays sound files but has no Web Audio to synthesize them live.
// Every sound is generated here from oscillators and filtered noise, so the
// game ships only its own audio.
//
//   node scripts/make-sounds.mjs <out-dir>

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

const SOUNDS = {
  swing_light: (o) => noise(o, { freq: 600, freqEnd: 2400, q: 1.4, attack: 0.04, decay: 0.15, gain: 0.4 }),
  swing_heavy: (o) => noise(o, { freq: 300, freqEnd: 1100, q: 1.4, attack: 0.05, decay: 0.24, gain: 0.45 }),
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
};

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

// A seamless 12 s drone: detuned saws through a low-pass, plus slow wind.
function drone() {
  const secs = 12;
  const o = track(secs);
  const lp = biquad('lowpass', 0.7);
  const wind = biquad('bandpass', 0.6);
  const n = o.length;
  // Frequencies chosen to complete whole cycles in 12 s, so the loop is seamless.
  const freqs = [41 + 1 / 12, 41.5 + 1 / 12, 61.5];
  const phases = freqs.map(() => 0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    freqs.forEach((f, k) => {
      phases[k] = (phases[k] + f / RATE) % 1;
      s += 2 * phases[k] - 1;
    });
    const t = i / RATE;
    const v = lp(s / 3, 160) * 0.55;
    const w = wind(rnd() * 2 - 1, 380 + 140 * Math.sin((2 * Math.PI * t) / secs)) * 0.5;
    o[i] = v + w;
  }
  // Crossfade the ends so filter state does not click at the loop point.
  const fade = Math.floor(RATE * 0.3);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    o[i] = o[i] * k + o[n - fade + i] * (1 - k);
  }
  return o.subarray(0, n - fade);
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
  return { count: Object.keys(SOUNDS).length + 1, bytes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || 'assets/sounds';
  const { count, bytes } = await makeSounds(out);
  console.log(`${count} sounds, ${(bytes / 1024).toFixed(0)} KB -> ${out}`);
}
