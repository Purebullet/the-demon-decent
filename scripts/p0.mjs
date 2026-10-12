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

const commands = {
  me: () => call('/api/agent/me'),
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
  submission: () => call(`/api/agent/submissions/${positional[0]}`),
};

if (!commands[cmd]) {
  console.error(`Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
await commands[cmd]();
