#!/usr/bin/env node
// Zoodle 3D asset pipeline (server-side only: the API key spends Z-Coins, so
// it must never reach the browser or the game bundle).
//
//   node scripts/zoodle.mjs status                 what is generated, what is missing
//   node scripts/zoodle.mjs list                   your finished Zoodle creations
//   node scripts/zoodle.mjs pull ghoul=<id> ...    download existing creations into slots (free)
//   node scripts/zoodle.mjs pull                   re-download every slot recorded in assets/zoodle.json
//   node scripts/zoodle.mjs objects [slot ...]     generate props from their text prompts
//   node scripts/zoodle.mjs batch [slot ...]       generate characters from the reference art
//
// Commands that cost coins only print a plan unless you add --spend.
// Slots and prompts live in src/assets/manifest.js. Generated GLBs are saved
// where the manifest says, and slot -> Zoodle id is recorded in
// assets/zoodle.json so models can be re-downloaded without paying again.
//
// The key is read from the ZOODLE_API_KEY environment variable (an
// environment secret in Claude Code on the web).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CHARACTERS, PROPS } from '../src/assets/manifest.js';

const BASE = 'https://zoodle3d.com';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const RECORD = join(ROOT, 'assets/zoodle.json');
const BATCH_ITEM_COST = 30;

// Batch API routes. The documented flow is: create a job, add items
// (imageBase64 + unique clientRef), close it, poll it. Check these against
// https://zoodle3d.com/api/v1/docs before the first paid run.
const BATCH = {
  create: () => '/api/v1/batch/jobs',
  addItem: (job) => `/api/v1/batch/jobs/${job}/items`,
  close: (job) => `/api/v1/batch/jobs/${job}/close`,
  poll: (job) => `/api/v1/batch/jobs/${job}`,
};

const args = process.argv.slice(2);
const command = args[0] || 'status';
const spend = args.includes('--spend');
const names = args.slice(1).filter((a) => !a.startsWith('--'));
const SLOTS = { ...CHARACTERS, ...PROPS };

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

async function save(slot, glb) {
  const path = join(ROOT, SLOTS[slot].model);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, glb);
  console.log(`  saved ${SLOTS[slot].model} (${(glb.length / 1024).toFixed(0)} KB)`);
}

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

async function status() {
  const rec = await loadRecord();
  console.log('slot          file                                   zoodle id');
  for (const [slot, e] of Object.entries(SLOTS)) {
    const have = await exists(e.model);
    console.log(`${slot.padEnd(13)} ${(have ? 'ok  ' : '--  ') + e.model.padEnd(35)} ${rec.slots[slot]?.id || ''}`);
  }
}

async function list() {
  const data = await api('/api/v1/characters');
  for (const c of data.characters || []) console.log(`${String(c.id).padEnd(28)} ${c.name || ''}`);
}

async function pull() {
  const rec = await loadRecord();
  const pairs = names.length ? names.map((n) => n.split('=')) : Object.entries(rec.slots).map(([s, v]) => [s, v.id]);
  if (!pairs.length) console.log('Nothing recorded yet. Use: pull ghoul=<zoodle id> ...');
  for (const [slot, id] of pairs) {
    if (!SLOTS[slot] || !id) throw new Error(`Use slot=<id>; slots: ${Object.keys(SLOTS).join(', ')}`);
    console.log(`${slot} <- ${id}`);
    await save(slot, await api(`/api/v1/characters/${encodeURIComponent(id)}/game-model`, { raw: true }));
    rec.slots[slot] = { ...rec.slots[slot], id };
    await saveRecord(rec);
  }
}

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
  for (const s of todo) {
    console.log(`${s}: generating`);
    const made = await api('/api/v1/objects', { method: 'POST', body: { prompt: SLOTS[s].prompt } });
    const id = pick(made, 'id', 'object.id', 'objectId');
    if (!id) throw new Error(`No object id in response: ${JSON.stringify(made).slice(0, 300)}`);
    rec.slots[s] = { id, source: 'objects', status: 'pending' };
    await saveRecord(rec);
    const statusPath = pick(made, 'statusUrl', 'object.statusUrl') || `/api/v1/objects/${encodeURIComponent(id)}`;
    let obj = made;
    for (let i = 0; ; i++) {
      const st = pick(obj, 'status', 'object.status');
      if (st === 'completed') break;
      if (st === 'failed' || st === 'error') throw new Error(`${s}: generation failed: ${JSON.stringify(obj).slice(0, 300)}`);
      if (i > 240) throw new Error(`${s}: timed out waiting; id ${id} is recorded, retry with: pull ${s}=${id}`);
      await sleep(5000);
      obj = await api(statusPath);
      process.stdout.write(`  ${pick(obj, 'status', 'object.status')}\r`);
    }
    const modelPath = pick(obj, 'gameModelUrl', 'object.gameModelUrl') || `/api/v1/characters/${encodeURIComponent(id)}/game-model`;
    await save(s, await api(modelPath, { raw: true }));
    rec.slots[s].status = 'done';
    await saveRecord(rec);
  }
}

async function batch() {
  const slots = chooseSlots(CHARACTERS).filter((s) => SLOTS[s].reference && (names.length || !SLOTS[s].fallback));
  const todo = [];
  for (const s of slots) if (!(await exists(SLOTS[s].model)) || names.length) todo.push(s);
  console.log(`Characters to generate from reference art: ${todo.join(', ') || 'none'}`);
  if (!todo.length) return;
  if (!spend) {
    for (const s of todo) console.log(`  ${s}: ${SLOTS[s].reference}`);
    console.log(`Dry run. This costs ${todo.length * BATCH_ITEM_COST} Z-Coins (${BATCH_ITEM_COST} per item, failures refunded); add --spend to run.`);
    return;
  }
  const rec = await loadRecord();
  const job = await api(BATCH.create(), { method: 'POST', body: {} });
  const jobId = pick(job, 'id', 'jobId', 'job.id');
  if (!jobId) throw new Error(`No job id in response: ${JSON.stringify(job).slice(0, 300)}`);
  console.log(`batch job ${jobId}`);
  const run = Date.now().toString(36);
  const refs = {};
  for (const s of todo) {
    const clientRef = `demon-descent-${s}-${run}`;
    refs[clientRef] = s;
    const imageBase64 = (await readFile(join(ROOT, SLOTS[s].reference))).toString('base64');
    await api(BATCH.addItem(jobId), { method: 'POST', body: { imageBase64, clientRef } });
    rec.slots[s] = { source: 'batch', job: jobId, clientRef, status: 'pending' };
    await saveRecord(rec);
    console.log(`  queued ${s}`);
  }
  await api(BATCH.close(jobId), { method: 'POST', body: {} });
  const done = new Set();
  for (let i = 0; done.size < todo.length; i++) {
    if (i > 360) throw new Error(`Timed out; job ${jobId} is recorded in assets/zoodle.json`);
    await sleep(5000);
    const state = await api(BATCH.poll(jobId));
    for (const item of pick(state, 'items', 'job.items') || []) {
      const s = refs[item.clientRef];
      if (!s || done.has(s)) continue;
      if (item.status === 'completed') {
        const id = pick(item, 'characterId', 'id');
        await save(s, await api(item.gameModelUrl || `/api/v1/characters/${encodeURIComponent(id)}/game-model`, { raw: true }));
        rec.slots[s] = { ...rec.slots[s], id, status: 'done' };
        done.add(s);
      } else if (item.status === 'failed') {
        console.log(`  ${s} failed (refunded): ${item.error || ''}`);
        rec.slots[s] = { ...rec.slots[s], status: 'failed' };
        done.add(s);
      }
      await saveRecord(rec);
    }
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
