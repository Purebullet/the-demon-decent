#!/usr/bin/env node
// Concept images for the creatures: the first step of the asset pipeline.
//
//   npm run concepts -- models                      image models your Google key can use
//   npm run concepts                                dry run: what would be made, and the cost
//   npm run concepts -- --spend                     one image per creature that has none yet
//   npm run concepts -- ghoul hound --spend         new takes of those creatures
//   npm run concepts -- ghoul --spend --note "..."  ... with an extra direction added to the prompt
//   npm run concepts -- approve ghoul=2 hound=1     pick the take each creature is built from
//   npm run concepts -- sheet                       contact sheet of every take (assets/concepts/index.html)
//
// Images come from Google's Gemini image models (generativelanguage
// .googleapis.com), using each creature's description in
// src/assets/manifest.js, and its reference art in assets/reference/ when it
// has one. Takes are saved as assets/concepts/<id>-<n>.png. Only approved
// takes go on to `npm run zoodle -- batch`, the paid image-to-3D step.
//
// The key is read from the GEMINI_API_KEY environment variable and never
// written anywhere. Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1
// (`npm run concepts` does).

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { CHARACTERS, conceptPrompt } from '../src/assets/manifest.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIR = join(ROOT, 'assets/concepts');
const APPROVED = join(DIR, 'approved.json');
// Google's list price for one ~1K image from its Flash image models (Oct 2026);
// the Pro image models cost several times more. Check the pricing page.
const EST_USD = 0.04;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(['--note', '--model']);
const words = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const command = ['models', 'approve', 'sheet'].includes(words[0]) ? words.shift() : 'make';
const spend = args.includes('--spend');

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    console.error(
      'GEMINI_API_KEY is not set. Create a key at https://aistudio.google.com/apikey and add it as an\n' +
        'environment secret named GEMINI_API_KEY (environment menu in the session title bar > Edit),\n' +
        'then start a new session.',
    );
    process.exit(1);
  }
  return k;
}

async function gemini(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function imageModels() {
  const out = [];
  let pageToken = '';
  do {
    const page = await gemini(`models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const m of page.models || []) {
      if (/image/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent')) out.push(m.name.replace(/^models\//, ''));
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return out;
}

// The model to use: --model, GEMINI_IMAGE_MODEL, else the newest Flash image
// model the key can see (cheaper than Pro, and good at following a reference).
async function chooseModel() {
  const wanted = flag('model') || process.env.GEMINI_IMAGE_MODEL;
  if (wanted) return wanted;
  const all = await imageModels();
  const rank = (n) => (/flash/.test(n) ? 2 : 0) + (/preview|exp/.test(n) ? 0 : 1);
  const best = all.sort((a, b) => rank(b) - rank(a) || b.localeCompare(a))[0];
  if (!best) throw new Error('This key can see no Gemini image models. Run `npm run concepts -- models`.');
  return best;
}

async function takes() {
  await mkdir(DIR, { recursive: true });
  const files = await readdir(DIR);
  const by = {};
  for (const f of files) {
    const m = /^([a-z]+)-(\d+)\.(png|jpe?g|webp)$/.exec(f);
    if (m) (by[m[1]] ||= []).push({ n: +m[2], file: f });
  }
  for (const list of Object.values(by)) list.sort((a, b) => a.n - b.n);
  return by;
}

async function loadApproved() {
  try {
    return JSON.parse(await readFile(APPROVED, 'utf8'));
  } catch {
    return {};
  }
}

function chosenIds() {
  for (const n of words) if (!CHARACTERS[n]) throw new Error(`Unknown creature "${n}". Creatures: ${Object.keys(CHARACTERS).join(', ')}`);
  return words.length ? words : Object.keys(CHARACTERS);
}

function promptFor(id, hasReference) {
  const note = flag('note');
  const lead = hasReference
    ? 'Redraw the creature in the attached reference image as a clean concept for a 3D model, keeping its design, colours and proportions. '
    : '';
  return `${lead}${conceptPrompt(id)}${note ? ` ${note}` : ''}`;
}

async function make() {
  const have = await takes();
  const ids = words.length ? chosenIds() : chosenIds().filter((id) => !have[id]);
  if (!ids.length) {
    console.log('Every creature has a concept image. Name creatures to make new takes.');
    return;
  }
  console.log(`Concept images to make: ${ids.join(', ')}`);
  if (!spend) {
    for (const id of ids) console.log(`\n${id}${CHARACTERS[id].reference ? ` (from ${CHARACTERS[id].reference})` : ''}:\n  ${promptFor(id, !!CHARACTERS[id].reference)}`);
    console.log(`\nDry run. ${ids.length} image(s), about $${(ids.length * EST_USD).toFixed(2)} on Google's paid tier; add --spend to make them.`);
    return;
  }
  const model = await chooseModel();
  console.log(`model: ${model}`);
  for (const id of ids) {
    const c = CHARACTERS[id];
    const parts = [{ text: promptFor(id, !!c.reference) }];
    if (c.reference) {
      const data = (await readFile(join(ROOT, c.reference))).toString('base64');
      parts.push({ inline_data: { mime_type: MIME[extname(c.reference).toLowerCase()], data } });
    }
    const res = await gemini(`models/${model}:generateContent`, {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: c.body === 'beast' ? '4:3' : '3:4' } },
    });
    const out = (res.candidates?.[0]?.content?.parts || []).map((p) => p.inlineData || p.inline_data).find((d) => d?.data);
    if (!out) {
      console.log(`  ${id}: no image returned (${res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason || 'unknown'})`);
      continue;
    }
    const n = (have[id]?.at(-1)?.n || 0) + 1;
    (have[id] ||= []).push({ n, file: '' });
    const ext = (out.mimeType || out.mime_type) === 'image/jpeg' ? 'jpg' : 'png';
    const file = `${id}-${n}.${ext}`;
    await writeFile(join(DIR, file), Buffer.from(out.data, 'base64'));
    console.log(`  saved assets/concepts/${file}`);
  }
  await sheet();
}

async function approve() {
  const have = await takes();
  const approved = await loadApproved();
  if (!words.length) throw new Error('Use: approve ghoul=2 hound=1 ...');
  for (const w of words) {
    const [id, n] = w.split('=');
    if (!CHARACTERS[id]) throw new Error(`Unknown creature "${id}"`);
    const take = (have[id] || []).find((t) => t.n === Number(n || have[id]?.at(-1)?.n));
    if (!take) throw new Error(`${id} has no take ${n}; takes: ${(have[id] || []).map((t) => t.n).join(', ') || 'none'}`);
    approved[id] = `assets/concepts/${take.file}`;
    console.log(`${id}: approved ${approved[id]}`);
  }
  await writeFile(APPROVED, `${JSON.stringify(approved, null, 2)}\n`);
  const waiting = Object.keys(CHARACTERS).filter((id) => !approved[id]);
  console.log(waiting.length ? `Still to approve: ${waiting.join(', ')}` : 'All creatures approved: next is `npm run zoodle -- batch`.');
}

// A page with every take, for looking them over side by side.
async function sheet() {
  const have = await takes();
  const approved = await loadApproved();
  const cards = Object.entries(CHARACTERS)
    .map(([id, c]) => {
      const imgs = (have[id] || [])
        .map((t) => {
          const ok = approved[id] === `assets/concepts/${t.file}`;
          return `<figure class="${ok ? 'ok' : ''}"><img src="${t.file}" alt="${c.name}, take ${t.n}"><figcaption>${id}=${t.n}${ok ? ' · approved' : ''}</figcaption></figure>`;
        })
        .join('');
      return `<section><h2>${c.name} <small>${id} · ${c.height} m · ${c.tris / 1000}k tris</small></h2><div class="row">${imgs || '<p>No image yet.</p>'}</div></section>`;
    })
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>Creature concepts</title>
<style>body{font:15px system-ui,sans-serif;background:#141012;color:#eee;margin:24px}h2{font-weight:600}small{color:#999;font-weight:400}
.row{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;border:2px solid #333;border-radius:6px;padding:6px;background:#1d1719}
figure.ok{border-color:#e05a2a}img{display:block;max-height:340px;max-width:100%}figcaption{font-family:monospace;margin-top:4px;color:#ccc}</style>
<h1>Creature concepts</h1><p>Approve one take per creature: <code>npm run concepts -- approve ghoul=1 ...</code></p>
${cards}\n`;
  await writeFile(join(DIR, 'index.html'), html);
  console.log('contact sheet: assets/concepts/index.html');
}

async function models() {
  for (const m of await imageModels()) console.log(m);
}

const COMMANDS = { make, approve, sheet, models };
COMMANDS[command]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
