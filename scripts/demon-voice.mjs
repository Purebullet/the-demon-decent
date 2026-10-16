#!/usr/bin/env node
// The floor-5 boss's voice: turns the recorded lines into a demon's and
// measures how loud each is moment to moment, so the game can move his head
// (his mouth opens as the head tips back) while he speaks.
//
//   node scripts/demon-voice.mjs
//
// Source: assets/source/voice/<line>.m4a (the recordings, kept out of git).
// Output: assets/voice/<line>.mp3 and src/entities/voiceLines.js.
//
// The voice: the recording pitched down by a fourth with its formants (a far
// bigger throat), an octave-down copy of it under that, a little grit, and
// the slap and tail of a stone hall.

import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = join(ROOT, 'assets/source/voice');
const OUT = join(ROOT, 'assets/voice');
// Envelope frames per second.
const FPS = 30;

const FILTER = [
  '[0:a]aformat=sample_rates=44100:channel_layouts=mono,highpass=f=80,lowpass=f=9000,asplit=2[a][b]',
  '[a]rubberband=pitch=0.74:formant=shifted:pitchq=quality[main]',
  '[b]rubberband=pitch=0.5:formant=shifted,lowpass=f=2400,volume=0.55[sub]',
  '[main][sub]amix=inputs=2:normalize=0',
  'bass=g=5:f=110',
  'asoftclip=type=tanh:threshold=0.6:output=0.9',
  'aecho=0.85:0.55:38|75|140:0.32|0.2|0.12',
  'loudnorm=I=-15:TP=-1.5:LRA=11',
  'apad=pad_dur=0.25',
].join(',');

mkdirSync(OUT, { recursive: true });
const lines = {};
for (const file of readdirSync(SRC).filter((f) => /\.(m4a|wav|mp3|ogg)$/.test(f)).sort()) {
  const id = basename(file).replace(/\.[^.]+$/, '');
  const out = join(OUT, `${id}.mp3`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(SRC, file), '-filter_complex', FILTER, '-ar', '44100', '-ac', '1', '-b:a', '96k', out]);
  // How loud, frame by frame: RMS of the processed line, scaled so speech
  // peaks near 9, with a floor so the reverb tail does not keep the mouth open.
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'f32le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 1 << 26 });
  const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const per = 8000 / FPS;
  const rms = [];
  for (let f = 0; f * per < s.length; f++) {
    let sum = 0;
    const i = Math.round(f * per);
    const end = Math.min(s.length, Math.round((f + 1) * per));
    for (let k = i; k < end; k++) sum += s[k] * s[k];
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const peak = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const env = rms.map((v) => Math.max(0, Math.min(9, Math.round(((v / peak - 0.18) / 0.82) * 9)))).join('');
  lines[id] = { file: `assets/voice/${id}.mp3`, duration: Math.round((s.length / 8000) * 100) / 100, env };
  console.log(`${id}: ${lines[id].duration}s`);
}

const body = Object.entries(lines)
  .map(([id, l]) => `  ${id}: {\n    file: '${l.file}',\n    duration: ${l.duration},\n    env:\n      '${l.env.match(/.{1,96}/g).join("' +\n      '")}',\n  },`)
  .join('\n');
writeFileSync(
  join(ROOT, 'src/entities/voiceLines.js'),
  `// Written by scripts/demon-voice.mjs: the boss's spoken lines, each with its
// loudness ${FPS} times a second (0-9), which moves his head as he speaks.
export const VOICE_FPS = ${FPS};
export const VOICE_LINES = {
${body}
};
`,
);
