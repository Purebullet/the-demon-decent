#!/usr/bin/env node
// Lays out the non-boss floors as one main path rather than a maze: rooms
// strung left to right by short two-wide passages that wander up and down,
// a few side passages that dead-end in a one-tile nook (where chests,
// potions and weapon caches go), and one bypass that leaves a room and
// rejoins two rooms on, so not everything is a straight line. Pillars and
// braziers stand in the larger rooms off the line of travel; lava pools
// never close the way through.
//
// Each floor keeps exactly what its current map holds (how many of each
// demon, potion, cache, pillar, brazier and hazard tile): only the layout
// changes. Deterministic per floor; prints the maps, and with --write puts
// them into src/world/LevelData.js (still plain ASCII to edit by hand).
//
//   node scripts/make-maps.mjs [--write] [floor ...]
//
// A floor's `layout` (in LevelData) makes it bigger than the rest: its
// height in tiles (H), how many rooms, their widths and heights, and the
// lengths of the passages between them ([min, max] each).

import { readFile, writeFile } from 'node:fs/promises';
import { FLOORS } from '../src/world/LevelData.js';
import { parseLevel, validateLevel, carveAlcoves } from '../src/world/levelParser.js';
import { mulberry32 } from '../src/core/rng.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const only = args.filter((a) => /^\d+$/.test(a)).map(Number);

const H0 = 19;
const COUNT = ['g', 'G', 'c', 'b', 'd', 'm', 'h', 'w', 'o', 't', '~', '^', 'v'];

function compose(def) {
  const text = def.map.join('');
  const n = {};
  for (const ch of COUNT) n[ch] = text.split(ch).length - 1;
  return n;
}

function layout(def, floor, seed) {
  const r = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(r() * (b - a + 1));
  const n = compose(def);
  const foes = n.g + n.G + n.c + n.b + n.d + n.m;
  const S = def.layout || {};
  const H = S.H ?? H0;
  const N = S.rooms ?? Math.max(5, Math.min(7, 2 + Math.round(foes / 3)));

  // Rooms, left to right, wandering up and down.
  const rooms = [];
  let x = 2;
  let cy = Math.floor(H / 2);
  for (let i = 0; i < N; i++) {
    const w = i === 0 ? 4 : ri(...(S.w ?? [4, 6]));
    const h = i === 0 ? 4 : ri(...(S.h ?? [4, 5]));
    if (i > 0) cy += ri(-3, 3);
    const y = Math.max(3, Math.min(H - 4 - h, cy - Math.floor(h / 2)));
    cy = y + Math.floor(h / 2);
    rooms.push({ x, y, w, h });
    x += w + ri(...(S.gap ?? [3, 5]));
  }
  const W = x + 1;
  const g = Array.from({ length: H }, () => Array(W).fill('#'));
  const inside = (c, rr) => c > 0 && rr > 0 && c < W - 1 && rr < H - 1;
  const carve = (c, rr) => inside(c, rr) && (g[rr][c] = '.');
  const rect = (x0, y0, w, h) => {
    for (let rr = y0; rr < y0 + h; rr++) for (let c = x0; c < x0 + w; c++) carve(c, rr);
  };
  for (const R of rooms) rect(R.x, R.y, R.w, R.h);

  // The main path: two-wide passages from each room to the next.
  const pathTiles = new Set();
  const mark = (c, rr) => {
    carve(c, rr);
    pathTiles.add(rr * W + c);
  };
  for (let i = 0; i < N - 1; i++) {
    const a = rooms[i];
    const b = rooms[i + 1];
    const ya = ri(a.y, a.y + a.h - 2);
    const yb = ri(b.y, b.y + b.h - 2);
    const mx = ri(a.x + a.w, b.x - 2);
    for (let c = a.x + a.w - 1; c <= mx + 1; c++) for (const dy of [0, 1]) mark(c, ya + dy);
    for (let rr = Math.min(ya, yb); rr <= Math.max(ya, yb) + 1; rr++) for (const dx of [0, 1]) mark(mx + dx, rr);
    for (let c = mx; c <= b.x; c++) for (const dy of [0, 1]) mark(c, yb + dy);
  }
  const rock = (c, rr) => inside(c, rr) && g[rr][c] === '#';

  // One bypass: out of a room's top (or bottom), along, and down into the
  // room two on.
  const loops = [];
  for (let tries = 0; tries < 12 && !loops.length && N >= 4; tries++) {
    const k = ri(0, N - 3);
    const a = rooms[k];
    const b = rooms[k + 2];
    const span = rooms.slice(k, k + 3);
    for (const up of r() < 0.5 ? [true, false] : [false, true]) {
      const yLane = up ? Math.min(...span.map((R) => R.y)) - 3 : Math.max(...span.map((R) => R.y + R.h)) + 2;
      if (yLane < 1 || yLane > H - 2) continue;
      const ca = ri(a.x + 1, a.x + a.w - 2);
      const cb = ri(b.x + 1, b.x + b.w - 2);
      const ya = up ? a.y - 1 : a.y + a.h;
      const yb = up ? b.y - 1 : b.y + b.h;
      const cells = [];
      for (let rr = Math.min(ya, yLane); rr <= Math.max(ya, yLane); rr++) cells.push([ca, rr]);
      for (let c = ca; c <= cb; c++) cells.push([c, yLane]);
      for (let rr = Math.min(yb, yLane); rr <= Math.max(yb, yLane); rr++) cells.push([cb, rr]);
      // Only rock under the lane (the rooms' own edges aside).
      const ok = cells.every(([c, rr]) => inside(c, rr) && (g[rr][c] === '#' || (rr >= a.y && rr < a.y + a.h && c >= a.x && c < a.x + a.w) || (rr >= b.y && rr < b.y + b.h && c >= b.x && c < b.x + b.w)));
      const lane = cells.filter(([, rr]) => rr === yLane);
      const apart = lane.every(([c]) => [-1, 1].every((d) => rock(c, yLane + d) || (c === ca || c === cb)));
      if (!ok || !apart) continue;
      for (const [c, rr] of cells) carve(c, rr);
      loops.push({ ca, cb, yLane });
      break;
    }
  }

  // Dead ends: side passages off rooms, two wide then a one-tile nook.
  const nooks = [];
  const sideRooms = rooms.slice(1, -1).map((R, i) => ({ R, i: i + 1 })).sort(() => r() - 0.5);
  for (const { R } of sideRooms) {
    if (nooks.length >= 3) break;
    for (const up of r() < 0.5 ? [true, false] : [false, true]) {
      const c = ri(R.x + 1, R.x + R.w - 2);
      const len = ri(3, 4);
      const dir = up ? -1 : 1;
      const y0 = up ? R.y - 1 : R.y + R.h;
      const cells = [];
      for (let k = 0; k < len; k++) cells.push([c, y0 + dir * k]);
      // Rock all round it but its mouth, and a margin from everything else.
      const ok = cells.every(([cc, rr]) => {
        if (!rock(cc, rr)) return false;
        for (let y = -1; y <= 1; y++) for (let xx = -1; xx <= 1; xx++) {
          const ax = cc + xx;
          const ay = rr + y;
          if (cells.some(([p, q]) => p === ax && q === ay)) continue;
          if (ay === R.y - 1 + (up ? 1 : 0) || ay === R.y + R.h - (up ? 0 : 1)) continue; // the room it opens from
          if (!rock(ax, ay) && !(ay >= R.y && ay < R.y + R.h)) return false;
        }
        // Two tiles clear of any other passage, so passages never run side by side.
        for (const xx of [-2, 2]) if (inside(cc + xx, rr) && !rock(cc + xx, rr) && !(rr >= R.y && rr < R.y + R.h)) return false;
        return true;
      });
      if (!ok) continue;
      for (const [cc, rr] of cells) carve(cc, rr);
      // Widen the passage's first half (the nook at its end stays one wide).
      const side = c + 1 < R.x + R.w ? 1 : -1;
      for (let k = 0; k < Math.floor(len / 2); k++) {
        const [cc, rr] = cells[k];
        if (rock(cc + side, rr) && rock(cc + side * 2, rr)) carve(cc + side, rr);
      }
      nooks.push(cells[cells.length - 1]);
      break;
    }
  }

  // What stands on the map.
  const free = (c, rr) => g[rr]?.[c] === '.';
  const put = (c, rr, ch) => (g[rr][c] = ch);
  const roomTiles = (R, inset = 0) => {
    const out = [];
    for (let rr = R.y + inset; rr < R.y + R.h - inset; rr++) for (let c = R.x + inset; c < R.x + R.w - inset; c++) if (free(c, rr)) out.push([c, rr]);
    return out;
  };
  const pick = (list) => list.splice(Math.floor(r() * list.length), 1)[0];
  const start = rooms[0];
  const end = rooms[N - 1];
  put(start.x + 1, start.y + Math.floor(start.h / 2), 'P');
  const ex = [end.x + end.w - 2, end.y + Math.floor(end.h / 2)];
  put(ex[0], ex[1], 'X');

  // Is everything still connected (optionally treating lava as a wall)?
  const flood = (avoidLava = false) => {
    const sp = [start.x + 1, start.y + Math.floor(start.h / 2)];
    const seen = new Set([sp[1] * W + sp[0]]);
    const q = [sp];
    while (q.length) {
      const [c, rr] = q.pop();
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc;
        const yy = rr + dr;
        const ch = g[yy]?.[cc];
        if (!ch || ch === '#' || ch === 'o' || ch === 't' || (avoidLava && ch === '~')) continue;
        if (seen.has(yy * W + cc)) continue;
        seen.add(yy * W + cc);
        q.push([cc, yy]);
      }
    }
    return seen;
  };
  const openCount = () => g.flat().filter((ch) => ch !== '#' && ch !== 'o' && ch !== 't').length;
  const keepsConnected = (c, rr, ch) => {
    const before = g[rr][c];
    g[rr][c] = ch;
    const ok = flood().size === openCount() && (ch !== '~' || flood(true).has(ex[1] * W + ex[0]));
    if (!ok) g[rr][c] = before;
    return ok;
  };
  const nearDoor = (c, rr) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => pathTiles.has((rr + dr) * W + c + dc) && !pathTiles.has(rr * W + c));

  // Pillars and braziers in the bigger rooms, off the line of travel.
  const big = rooms.slice(1).filter((R) => R.w >= 5 && R.h >= 5);
  for (const ch of ['o', 't']) {
    let left = n[ch];
    for (let tries = 0; tries < 200 && left > 0 && big.length; tries++) {
      const R = big[Math.floor(r() * big.length)];
      const spots = ch === 'o' ? roomTiles(R, 1) : roomTiles(R).filter(([c, rr]) => c === R.x || c === R.x + R.w - 1 || rr === R.y || rr === R.y + R.h - 1);
      if (!spots.length) continue;
      const [c, rr] = spots[Math.floor(r() * spots.length)];
      // Never in the way of the exit's gate, nor where you arrive.
      const sp = [start.x + 1, start.y + Math.floor(start.h / 2)];
      if (Math.max(Math.abs(c - ex[0]), Math.abs(rr - ex[1])) <= 3 || Math.max(Math.abs(c - sp[0]), Math.abs(rr - sp[1])) <= 2) continue;
      if (pathTiles.has(rr * W + c) || nearDoor(c, rr)) continue;
      if (keepsConnected(c, rr, ch)) left--;
    }
  }

  // Lava pools in rooms (never the only way on), spikes across the
  // passages, vents in rooms.
  let lava = n['~'];
  for (let tries = 0; tries < 400 && lava > 0; tries++) {
    const R = rooms[ri(1, N - 1)];
    const t = roomTiles(R);
    if (!t.length) continue;
    // A pool: a tile and up to three of its neighbours.
    let [c, rr] = t[Math.floor(r() * t.length)];
    for (let k = 0, size = ri(2, 4); k < size && lava > 0; k++) {
      if (free(c, rr) && keepsConnected(c, rr, '~')) lava--;
      const [dc, dr] = [[1, 0], [-1, 0], [0, 1], [0, -1]][ri(0, 3)];
      if (free(c + dc, rr + dr)) [c, rr] = [c + dc, rr + dr];
    }
  }
  const corridor = [...pathTiles].map((k) => [k % W, Math.floor(k / W)]).filter(([c, rr]) => free(c, rr) && !rooms.some((R) => c >= R.x && c < R.x + R.w && rr >= R.y && rr < R.y + R.h));
  let spikes = n['^'];
  while (spikes > 0 && corridor.length) {
    const [c, rr] = pick(corridor);
    put(c, rr, '^');
    spikes--;
  }
  let vents = n.v;
  for (let tries = 0; tries < 200 && vents > 0; tries++) {
    const t = roomTiles(rooms[ri(1, N - 1)], 1);
    if (!t.length) continue;
    const [c, rr] = t[Math.floor(r() * t.length)];
    put(c, rr, 'v');
    vents--;
  }

  // Treasure in the nooks first: potions, then the weapon caches.
  const loot = [...Array(n.h).fill('h'), ...Array(n.w).fill('w')];
  for (const [c, rr] of nooks) if (loot.length && free(c, rr)) put(c, rr, loot.shift());
  while (loot.length) {
    const t = roomTiles(rooms[ri(1, N - 1)]);
    if (t.length) {
      const [c, rr] = t[Math.floor(r() * t.length)];
      put(c, rr, loot.shift());
    }
  }

  // Demons, more of them the further in; never in the first room.
  const foesList = [];
  for (const ch of ['g', 'G', 'c', 'd', 'm', 'b']) for (let k = 0; k < n[ch]; k++) foesList.push(ch);
  const weights = rooms.map((R, i) => (i === 0 ? 0 : R.w * R.h * (0.6 + i / N)));
  const total = weights.reduce((a, b) => a + b, 0);
  // Brutes and witches deeper in.
  foesList.sort((a, b) => 'gGcdmb'.indexOf(a) - 'gGcdmb'.indexOf(b));
  let acc = 0;
  foesList.forEach((ch, k) => {
    const want = ((k + 0.5) / foesList.length) * total;
    let i = 1;
    for (acc = 0, i = 0; i < N; i++) {
      acc += weights[i];
      if (acc >= want) break;
    }
    i = Math.max(1, Math.min(N - 1, i));
    for (let tries = 0; tries < 40; tries++) {
      const t = roomTiles(rooms[i]);
      if (t.length) {
        const [c, rr] = t[Math.floor(r() * t.length)];
        put(c, rr, ch);
        return;
      }
      i = Math.max(1, (i % (N - 1)) + 1);
    }
  });

  return { map: g.map((row) => row.join('')), rooms: N, loops: loops.length, nooks: nooks.length };
}

const out = [];
for (const [i, def] of FLOORS.entries()) {
  const floor = i + 1;
  if (def.boss || (only.length && !only.includes(floor))) continue;
  let made = null;
  for (let s = 0; s < 400 && !made; s++) {
    const m = layout(def, floor, floor * 7717 + s * 131);
    const trial = { ...def, map: m.map };
    if (validateLevel(trial, i).length) continue;
    if (m.loops < 1 || m.nooks < 2) continue;
    const d = parseLevel(trial);
    carveAlcoves(d, d.floorTiles.length > 160 ? 3 : 2, mulberry32(floor * 4111));
    const ends = d.floorTiles.filter((t) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => d.nav.isWalkable(t.c + a, t.r + b)).length === 1);
    if (ends.length < 2) continue;
    made = m;
  }
  if (!made) {
    console.error(`floor ${floor}: no layout found`);
    process.exitCode = 1;
    continue;
  }
  console.log(`\nFloor ${floor} (${def.name}): ${made.rooms} rooms, ${made.nooks} dead ends, ${made.loops} loop`);
  console.log(made.map.join('\n'));
  out.push([floor, made.map]);
}

if (write) {
  const file = new URL('../src/world/LevelData.js', import.meta.url);
  let src = await readFile(file, 'utf8');
  for (const [floor, map] of out) {
    const name = FLOORS[floor - 1].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(name: ['"]${name}['"],[\\s\\S]*?map: \\[)[\\s\\S]*?(\\n    \\],)`);
    if (!re.test(src)) throw new Error(`floor ${floor}: map not found in LevelData.js`);
    src = src.replace(re, (_, a, b) => `${a}\n${map.map((row) => `      '${row}',`).join('\n')}${b}`);
  }
  await writeFile(file, src);
  console.log(`\nWrote ${out.length} maps into src/world/LevelData.js`);
}
