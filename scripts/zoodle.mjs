#!/usr/bin/env node
// Zoodle 3D asset pipeline (server-side only: the API key spends Z-Coins, so
// it must never reach the browser or the game bundle).
//
//   node scripts/zoodle.mjs status                 what is generated, what is missing
//   node scripts/zoodle.mjs list                   your finished Zoodle creations
//   node scripts/zoodle.mjs pull ghoul=<id> ...    download existing creations into slots (free);
//                                                   a character's Zoodle animations come too, and
//                                                   one without any is saved as the static source
//                                                   that `npm run rig` rigs and animates
//   node scripts/zoodle.mjs pull                   re-download every prop recorded in assets/zoodle.json
//                                                   and every creature's source (ids in the manifest)
//   node scripts/zoodle.mjs objects [slot ...]     generate props from their text prompts
//   node scripts/zoodle.mjs batch [slot ...]       generate creatures from their approved concept images
//
// Creatures go through `npm run concepts` first: a concept image is made and
// approved for each one (assets/concepts/approved.json), and only approved
// images are sent here. Models are exported at the creature's medium-poly
// triangle budget (`tris` in the manifest; batch exports allow up to 20,000).
//
// Commands that cost coins only print a plan unless you add --spend.
// Slots and prompts live in src/assets/manifest.js. Generated GLBs are saved
// where the manifest says, and slot -> Zoodle id is recorded in
// assets/zoodle.json so models can be re-downloaded without paying again.
//
// The key is read from the ZOODLE_API_KEY environment variable (an
// environment secret in Claude Code on the web). Behind an HTTPS proxy, run
// with NODE_USE_ENV_PROXY=1 (`npm run zoodle` does) so fetch uses it.
// API reference: https://zoodle3d.com/api/v1/docs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CHARACTERS, PROPS } from '../src/assets/manifest.js';
import { RIGS } from './rigs.mjs';

const BASE = 'https://zoodle3d.com';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const RECORD = join(ROOT, 'assets/zoodle.json');
const APPROVED = join(ROOT, 'assets/concepts/approved.json');
const BATCH_ITEM_COST = 30;

// Batch image-to-3D: create a job (free), submit one image per request
// (30 Z-Coins each; a repeated clientRef in the same job is not charged
// again), close the job, poll it every 5-10 s.
const BATCH = {
  create: () => '/api/v1/batch/jobs',
  addItem: (job) => `/api/v1/batch/jobs/${job}/items`,
  close: (job) => `/api/v1/batch/jobs/${job}/close`,
  poll: (job) => `/api/v1/batch/jobs/${job}`,
  // Free; ?tris= is clamped to 1,000-20,000.
  model: (job, item, tris) => `/api/v1/batch/jobs/${job}/items/${item}/game-model?tris=${tris}`,
};

const args = process.argv.slice(2);
const command = args[0] || 'status';
const spend = args.includes('--spend');
const names = args.slice(1).filter((a) => !a.startsWith('--'));
const SLOTS = { ...CHARACTERS, ...PROPS };

// Zoodle animation names -> the clip slots the game plays.
const CLIP_SLOTS = {
  idle: /idle|breath|stand/i,
  walk: /walk|stride|prowl|creep/i,
  run: /run|sprint|charge|dash/i,
  attack: /attack|slash|swing|strike|punch|claw|smash|lunge|bite/i,
  hit: /hit|hurt|react|flinch|stagger/i,
  death: /death|die|dying|collapse|fall/i,
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function key() {
  const k = process.env.ZOODLE_API_KEY;
  if (!k) {
    console.error(
      'ZOODLE_API_KEY is not set.\n' +
        'Add it as a secret in your Claude Code environment settings (environment menu in the\n' +
        'session title bar > Edit > Network secrets, name ZOODLE_API_KEY), then start a new\n' +
        'session. Locally: ZOODLE_API_KEY=... node scripts/zoodle.mjs ' + command,
    );
    process.exit(1);
  }
  return k;
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const url = new URL(path, BASE);
  if (url.origin !== BASE) throw new Error(`Refusing to send the API key to ${url.origin}`);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${url.pathname} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function loadRecord() {
  try {
    return JSON.parse(await readFile(RECORD, 'utf8'));
  } catch {
    return { slots: {} };
  }
}

async function saveRecord(rec) {
  await writeFile(RECORD, `${JSON.stringify(rec, null, 2)}\n`);
}

async function exists(p) {
  try {
    await readFile(join(ROOT, p));
    return true;
  } catch {
    return false;
  }
}

async function saveFile(rel, data) {
  const path = join(ROOT, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  console.log(`  saved ${rel} (${(data.length / 1024).toFixed(0)} KB)`);
}

const save = (slot, glb) => saveFile(SLOTS[slot].model, glb);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (o, ...keys) => keys.map((k) => k.split('.').reduce((v, p) => v?.[p], o)).find((v) => v !== undefined);

// Named slots may be any slot (e.g. `objects azrakel` builds a character
// from its text prompt); with no names, the command's default pool.
function chooseSlots(pool) {
  const chosen = names.length ? names : Object.keys(pool);
  for (const n of chosen) if (!SLOTS[n]) throw new Error(`Unknown slot "${n}". Slots: ${Object.keys(SLOTS).join(', ')}`);
  return chosen;
}

// ---------------------------------------------------------------- commands

async function loadApproved() {
  try {
    return JSON.parse(await readFile(APPROVED, 'utf8'));
  } catch {
    return {};
  }
}

async function status() {
  const rec = await loadRecord();
  const approved = await loadApproved();
  console.log('slot          file                                   concept                         zoodle');
  for (const [slot, e] of Object.entries(SLOTS)) {
    const have = await exists(e.model);
    const concept = CHARACTERS[slot] ? approved[slot] || 'not approved' : '';
    const r = rec.slots[slot];
    console.log(`${slot.padEnd(13)} ${(have ? 'ok  ' : '--  ') + e.model.padEnd(35)} ${concept.padEnd(31)} ${r ? r.id || `job ${r.job}` : ''}`);
  }
}

async function list() {
  const data = await api('/api/v1/characters');
  for (const c of data.characters || []) console.log(`${String(c.id).padEnd(28)} ${c.name || ''}`);
}

async function pull() {
  const rec = await loadRecord();
  const pairs = names.length
    ? names.map((n) => n.split('=').map((v, i) => (i && /^\d+$/.test(v) ? Number(v) : v)))
    : [...Object.entries(rec.slots).map(([s, v]) => [s, v.id]), ...Object.values(RIGS).map((r) => [r.slot, r.zoodle])];
  if (!pairs.length) console.log('Nothing recorded yet. Use: pull ghoul=<zoodle id> ...');
  for (const [slot, id] of pairs) {
    if (!SLOTS[slot] || !id) throw new Error(`Use slot=<id>; slots: ${Object.keys(SLOTS).join(', ')}`);
    console.log(`${slot} <- ${id}`);
    const r = rec.slots[slot];
    if (r?.job && r.item && String(r.id) === String(id)) {
      // A batch creation: export it again at its triangle budget.
      await save(slot, await api(BATCH.model(r.job, r.item, SLOTS[slot].tris || 8000), { raw: true }));
      continue;
    }
    if (CHARACTERS[slot]) {
      if (await pullAnimations(slot, id)) continue;
      // No Zoodle animations: the static model is the rig script's source.
      const rig = Object.values(RIGS).find((x) => x.slot === slot);
      if (!rig) {
        console.log(`  ${slot} uses the ${CHARACTERS[slot].model} model; pull its creature instead`);
        continue;
      }
      await saveFile(rig.source, await api(`/api/v1/characters/${encodeURIComponent(id)}/game-model`, { raw: true }));
      console.log(`  now: npm run rig -- ${slot}`);
      continue;
    }
    await save(slot, await api(propModel(slot, id), { raw: true }));
    rec.slots[slot] = { ...rec.slots[slot], id };
    await saveRecord(rec);
  }
}

// Saves a character's finished Zoodle animations as <slot>-<clip>.glb, and
// the first one also as the rigged base model <slot>.glb.
async function pullAnimations(slot, id) {
  const { animations = [] } = await api(`/api/v1/characters/${encodeURIComponent(id)}/animations`);
  const taken = new Set();
  let base = false;
  for (const a of animations) {
    const text = `${a.name || ''} ${a.prompt || ''}`;
    const clip = Object.keys(CLIP_SLOTS).find((c) => !taken.has(c) && CLIP_SLOTS[c].test(text));
    if (!clip) continue;
    taken.add(clip);
    const glb = await api(a.glbUrl, { raw: true });
    await saveFile(`assets/models/${slot}-${clip}.glb`, glb);
    if (!base) {
      await save(slot, glb);
      base = true;
    }
  }
  if (taken.size) console.log(`  clips: ${[...taken].join(', ')}`);
  return taken.size;
}

// A prop's game model, decimated by Zoodle to the prop's budget (free).
const propModel = (slot, id) => {
  const t = SLOTS[slot].maxTris;
  return `/api/v1/characters/${encodeURIComponent(id)}/game-model${t ? `?maxTris=${t}` : ''}`;
};

async function objects() {
  const slots = chooseSlots(PROPS);
  const rec = await loadRecord();
  const todo = [];
  for (const s of slots) if (!(await exists(SLOTS[s].model)) || names.length) todo.push(s);
  console.log(`Objects to generate from prompts: ${todo.join(', ') || 'none'}`);
  if (!todo.length) return;
  if (!spend) {
    for (const s of todo) console.log(`  ${s}: "${SLOTS[s].prompt}"`);
    console.log('Dry run. Each object costs Z-Coins; add --spend to generate.');
    return;
  }
  // Submit at most 5 a minute (the API's creation limit), then poll them all.
  // A slot already submitted (recorded as pending) is picked up again rather
  // than paid for twice; a 503 (generator down, nothing charged) is retried.
  const pending = new Map();
  let submitted = 0;
  for (const s of todo) {
    const r = rec.slots[s];
    if (r?.source === 'objects' && r.status === 'pending') {
      pending.set(s, `/api/v1/objects/${encodeURIComponent(r.id)}`);
      continue;
    }
    let made;
    for (let attempt = 0; ; attempt++) {
      if (submitted || attempt) await sleep(attempt ? 60000 : 13000);
      try {
        // Prompts are 3-500 characters.
        made = await api('/api/v1/objects', { method: 'POST', body: { prompt: SLOTS[s].prompt.slice(0, 500), name: s, faceLimit: 10000 } });
        break;
      } catch (e) {
        if (!/-> 503/.test(e.message) || attempt >= 10) throw e;
        console.log(`${s}: generator unavailable, retrying in a minute`);
      }
    }
    submitted++;
    const id = pick(made, 'id', 'object.id', 'objectId');
    if (!id) throw new Error(`No object id in response: ${JSON.stringify(made).slice(0, 300)}`);
    console.log(`${s}: generating as ${id} (cost ${made.cost ?? '?'}, balance ${made.balance ?? '?'})`);
    rec.slots[s] = { id, source: 'objects', status: 'pending' };
    await saveRecord(rec);
    pending.set(s, pick(made, 'statusUrl', 'object.statusUrl') || `/api/v1/objects/${encodeURIComponent(id)}`);
  }
  for (let i = 0; pending.size; i++) {
    if (i > 240) throw new Error(`Timed out waiting for ${[...pending.keys()].join(', ')}; ids are recorded, run objects again to resume`);
    await sleep(8000);
    for (const [s, statusPath] of pending) {
      const obj = await api(statusPath);
      const st = pick(obj, 'status', 'object.status');
      if (st === 'failed' || st === 'error') {
        console.log(`${s}: generation failed: ${JSON.stringify(obj).slice(0, 300)}`);
        rec.slots[s].status = 'failed';
        pending.delete(s);
      } else if (st === 'completed') {
        console.log(`${s}: done`);
        await save(s, await api(propModel(s, rec.slots[s].id), { raw: true }));
        rec.slots[s].status = 'done';
        pending.delete(s);
      }
      await saveRecord(rec);
    }
  }
}

async function batch() {
  const approved = await loadApproved();
  const slots = chooseSlots(CHARACTERS);
  const unapproved = slots.filter((s) => !CHARACTERS[s] || !approved[s]);
  if (names.length && unapproved.length) throw new Error(`No approved concept image for: ${unapproved.join(', ')} (npm run concepts -- approve ${unapproved[0]}=<take>)`);
  const todo = [];
  for (const s of slots) if (approved[s] && (!(await exists(SLOTS[s].model)) || names.length)) todo.push(s);
  console.log(`Creatures to build from their approved concepts: ${todo.join(', ') || 'none'}`);
  if (!names.length && unapproved.length) console.log(`Waiting for approval: ${unapproved.join(', ')}`);
  if (!todo.length) return;
  if (!spend) {
    for (const s of todo) console.log(`  ${s}: ${approved[s]} -> ${SLOTS[s].model} (${SLOTS[s].tris} tris)`);
    console.log(`Dry run. This costs ${todo.length * BATCH_ITEM_COST} Z-Coins (${BATCH_ITEM_COST} per item, failures refunded); add --spend to run.`);
    return;
  }
  const rec = await loadRecord();
  const job = await api(BATCH.create(), { method: 'POST', body: { label: 'The Demon Descent creatures' } });
  const jobId = pick(job, 'jobId', 'id', 'job.id');
  if (!jobId) throw new Error(`No job id in response: ${JSON.stringify(job).slice(0, 300)}`);
  console.log(`batch job ${jobId}`);
  const run = Date.now().toString(36);
  const refs = {};
  for (const s of todo) {
    const clientRef = `demon-descent-${s}-${run}`;
    refs[clientRef] = s;
    const file = approved[s];
    const mime = MIME[file.split('.').pop().toLowerCase()];
    const imageBase64 = `data:${mime};base64,${(await readFile(join(ROOT, file))).toString('base64')}`;
    // Generate with headroom above the export budget, so the export is a
    // clean reduction rather than the generator's own floor.
    const faceLimit = Math.min(500000, SLOTS[s].tris * 3);
    const added = await api(BATCH.addItem(jobId), { method: 'POST', body: { imageBase64, clientRef, style: 'realistic', faceLimit } });
    const item = pick(added, 'itemId', 'items.0.itemId', 'item.id', 'items.0.id');
    rec.slots[s] = { source: 'batch', concept: file, job: jobId, item, clientRef, status: 'pending' };
    await saveRecord(rec);
    console.log(`  queued ${s}`);
  }
  await api(BATCH.close(jobId), { method: 'POST', body: {} });
  const done = new Set();
  for (let i = 0; done.size < todo.length; i++) {
    if (i > 360) throw new Error(`Timed out; job ${jobId} is recorded in assets/zoodle.json`);
    await sleep(6000);
    const state = await api(BATCH.poll(jobId));
    const items = pick(state, 'items', 'job.items') || [];
    for (const it of items) {
      const s = refs[it.clientRef];
      if (!s || done.has(s)) continue;
      const itemId = pick(it, 'itemId', 'id') || rec.slots[s].item;
      if (it.status === 'completed') {
        rec.slots[s] = { ...rec.slots[s], item: itemId, id: pick(it, 'characterId') || rec.slots[s].id, status: 'done' };
        await save(s, await api(BATCH.model(jobId, itemId, SLOTS[s].tris), { raw: true }));
        done.add(s);
      } else if (it.status === 'failed') {
        console.log(`  ${s} failed (refunded): ${it.error || ''}`);
        rec.slots[s] = { ...rec.slots[s], status: 'failed' };
        done.add(s);
      }
      await saveRecord(rec);
    }
    if (pick(state, 'done', 'job.done')) for (const s of todo) done.add(s);
    process.stdout.write(`  ${done.size}/${todo.length} finished\r`);
  }
  console.log('');
}

const COMMANDS = { status, list, pull, objects, batch };
if (!COMMANDS[command]) {
  console.error(`Unknown command "${command}". Use: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}
COMMANDS[command]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
