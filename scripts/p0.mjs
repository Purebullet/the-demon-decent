#!/usr/bin/env node
// Project 0 publishing helper (https://project0.city/skill.md). Reads the
// player's key from the P0_KEY environment variable; never write it to a file.
//
//   npm run p0 -- me                                  your lots, sizes and budgets
//   npm run p0 -- status building|done [--lot 265]    the "being built" cubes on the lot
//   npm run p0 -- box subtle|normal [--color #ff3a10] the lot's glass box
//   npm run p0 -- validate-lot dist/lot               check lod0/1/2 + lot.json (free)
//   npm run p0 -- publish-lot dist/lot                publish the street view
//   npm run p0 -- validate-experience                 check dist/experience.zip (free)
//   npm run p0 -- publish-experience                  publish the game
//   npm run p0 -- avatar avatar [--validate] [--slot 2]  publish your avatar (a folder:
//                                                     avatar.glb, avatar-lod1.glb, avatar.json, *.glsl)
//   npm run p0 -- machine machine [--validate] [--game zer0-g]  your entity for another
//                                                     lot's game (entity.json, model.glb, picture.png)
//   npm run p0 -- bounty [--prize 11.12] [--min 600]  the lot's prize for slaying the Sleeper
//                                                     (a win, once a player); only if the pool covers it
//   npm run p0 -- event [--days 30]                   the ring of light and searchlights over the
//                                                     lot that announces it (needs that prize)
//   npm run p0 -- end-event                           take the ring down
//   npm run p0 -- check <url>                         poll a `check` URL a send answered with
//   npm run p0 -- submission <id>                     a review that answered 202

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const BASE = 'https://project0.city';
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const LOT = flag('lot', process.env.P0_LOT || '265');
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));

function key() {
  const k = process.env.P0_KEY;
  if (!k) {
    console.error('P0_KEY is not set: add your Project 0 key (in the game: Connect agent) as an environment secret named P0_KEY.');
    process.exit(1);
  }
  return k;
}

async function call(path, { method = 'GET', json, form } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : form,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  console.log(`${method} ${path} -> ${res.status}`);
  console.log(typeof body === 'string' ? body.slice(0, 2000) : JSON.stringify(body, null, 2).slice(0, 6000));
  if (!res.ok && res.status !== 202) process.exitCode = 1;
  return { status: res.status, body };
}

async function fileBlob(path, type = 'application/octet-stream') {
  return new Blob([await readFile(path)], { type });
}

async function lotForm(dir, withManifest) {
  const form = new FormData();
  for (const lod of ['lod0', 'lod1', 'lod2']) form.append(lod, await fileBlob(join(dir, `${lod}.glb`), 'model/gltf-binary'), `${lod}.glb`);
  // lot.json and the files it names (shaders, script).
  const files = await readdir(dir);
  for (const f of files) {
    if (f === 'lot.json' || f.endsWith('.glsl') || f.endsWith('.js')) form.append('file', await fileBlob(join(dir, f)), f);
  }
  if (withManifest) {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    form.append('manifest', JSON.stringify(manifest));
  }
  return form;
}

// The Sleeper's bounty: what the city's ring over the lot says. The prize is
// set so the player nets 10 tokens after the city's tenth.
const BOUNTY = {
  prize: 11.12,
  title: 'BEAT THE FLOOR 5 BOSS · WIN 10 TOKENS',
  text: 'Descend into The Demon Descent and slay Vorgrath, the Sleeper, on floor 5 to win 10 tokens. One prize per player.',
  color: '#ff4a10',
};

// The lot's prize rules and pool as the city shows them.
async function gameRules() {
  const res = await fetch(`${BASE}/api/lots/${LOT}/game`);
  return (await res.json()).game || {};
}

const commands = {
  me: () => call('/api/agent/me'),
  // A prize set above what the pool holds shuts everyone but the owner out,
  // so this sets it only once the pool covers it.
  bounty: async () => {
    const prize = Number(flag('prize', BOUNTY.prize));
    const G = await gameRules();
    if (!(G.pool >= prize)) {
      console.error(`The prize pool holds ${G.pool ?? 0} tokens, less than one prize (${prize}). Fill it first (in the game: your lot, Game & prizes).`);
      process.exitCode = 1;
      return;
    }
    return call(`/api/agent/lots/${LOT}/game`, { method: 'POST', json: { prize, mode: 'win', perPlayer: 'once', minSeconds: Number(flag('min', 600)), paused: false } });
  },
  event: async () => {
    const G = await gameRules();
    if (!(G.prize >= 10) || !(G.pool >= G.prize)) {
      console.error(`An event needs a prize of at least 10 tokens a winner and a pool that covers it (now: prize ${G.prize ?? 0}, pool ${G.pool ?? 0}). Run \`npm run p0 -- bounty\` once the pool is filled.`);
      process.exitCode = 1;
      return;
    }
    return call(`/api/agent/lots/${LOT}/event`, { method: 'POST', json: { title: BOUNTY.title, text: BOUNTY.text, days: Number(flag('days', 30)), color: BOUNTY.color } });
  },
  'end-event': () => call(`/api/agent/lots/${LOT}/event`, { method: 'DELETE' }),
  status: () => call(`/api/agent/lots/${LOT}/status`, { method: 'POST', json: { building: positional[0] !== 'done' } }),
  box: () => {
    const json = {};
    if (positional[0]) json.box = positional[0];
    if (flag('color')) json.color = flag('color') === 'null' ? null : flag('color');
    return call(`/api/agent/lots/${LOT}/box`, { method: 'POST', json });
  },
  'validate-lot': async () => call(`/api/agent/lots/${LOT}/validate`, { method: 'POST', form: await lotForm(positional[0] || 'dist/lot', false) }),
  'publish-lot': async () => call(`/api/agent/lots/${LOT}/publish`, { method: 'POST', form: await lotForm(positional[0] || 'dist/lot', true) }),
  'validate-experience': async () => {
    const form = new FormData();
    const zip = positional[0] || 'dist/experience.zip';
    form.append('package', await fileBlob(zip, 'application/zip'), basename(zip));
    return call(`/api/agent/lots/${LOT}/experience/validate`, { method: 'POST', form });
  },
  'publish-experience': async () => {
    const form = new FormData();
    const zip = positional[0] || 'dist/experience.zip';
    form.append('package', await fileBlob(zip, 'application/zip'), basename(zip));
    return call(`/api/agent/lots/${LOT}/experience`, { method: 'POST', form });
  },
  // Every file of the avatar package, at the top level.
  avatar: async () => {
    const dir = positional[0] || 'avatar';
    const form = new FormData();
    for (const f of (await readdir(dir)).sort()) {
      if (/^avatar(-lod1)?\.glb$|^avatar\.json$|\.(glsl|png|webp)$/.test(f)) form.append('file', await fileBlob(join(dir, f)), f);
    }
    const slot = flag('slot');
    const path = args.includes('--validate') ? '/api/agent/avatar/validate' : `/api/agent/avatar${slot ? `?slot=${slot}` : ''}`;
    return call(path, { method: 'POST', form });
  },
  // Your own entity for another lot's game (`--game`, default ZER0-G): its
  // entity.json, model.glb (+ model-lod1.glb) and picture.png.
  machine: async () => {
    const dir = positional[0] || 'machine';
    const game = flag('game', 'zer0-g');
    const form = new FormData();
    const type = { json: 'application/json', glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg' };
    for (const f of (await readdir(dir)).sort()) {
      if (/^entity\.json$|^model(-lod1)?\.glb$|^picture\.(png|jpg)$/.test(f)) form.append('file', await fileBlob(join(dir, f), type[f.split('.').pop()]), f);
    }
    return call(`/api/agent/games/${game}/entity${args.includes('--validate') ? '/validate' : ''}`, { method: 'POST', form });
  },
  check: () => call(new URL(positional[0], BASE).pathname),
  submission: () => call(`/api/agent/submissions/${positional[0]}`),
};

if (!commands[cmd]) {
  console.error(`Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
await commands[cmd]();
