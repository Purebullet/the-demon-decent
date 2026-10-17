import { NavGrid } from '../ai/NavGrid.js';
import { TILE } from './LevelData.js';

// Turns an ASCII floor into data the game can use: the solid grid (for
// collision), a NavGrid with terrain costs (for A*), and spawn lists.
// Pure and DOM-free so tests can validate every floor.

const SOLID = new Set(['#', 'o', 't']);
const ENEMY = { g: 'ghoul', G: 'ghoul', c: 'fiend', b: 'brute', d: 'hound', m: 'witch' };

// A* entry costs. Enemies will walk through hazards only when there is no
// sane alternative (and hunting packs on deep floors sometimes do).
export const TERRAIN_COST = { '~': 14, '^': 5, v: 5 };

export function parseLevel(def) {
  const raw = def.map;
  const width = Math.max(...raw.map((r) => r.length));
  // Pad ragged rows with rock and add a sealed one-tile border.
  const rows = ['#'.repeat(width + 2), ...raw.map((r) => '#' + r.padEnd(width, '#') + '#'), '#'.repeat(width + 2)];
  const cols = width + 2;
  const nRows = rows.length;

  const solid = new Uint8Array(cols * nRows);
  const nav = new NavGrid(cols, nRows, TILE);
  const level = {
    cols,
    rows: nRows,
    tiles: rows,
    solid,
    nav,
    spawn: null,
    exit: null,
    enemies: [],
    boss: null,
    potions: [],
    weapons: [],
    braziers: [],
    pillars: [],
    lava: [],
    spikes: [],
    vents: [],
    floorTiles: [],
  };

  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = rows[r][c];
      const i = r * cols + c;
      const x = (c + 0.5) * TILE;
      const z = (r + 0.5) * TILE;
      if (SOLID.has(ch)) {
        solid[i] = 1;
        if (ch === 'o') level.pillars.push({ c, r, x, z });
        if (ch === 't') level.braziers.push({ c, r, x, z });
        continue;
      }
      nav.walkable[i] = 1;
      nav.cost[i] = TERRAIN_COST[ch] ?? 1;
      level.floorTiles.push({ c, r, x, z });
      switch (ch) {
        case 'P':
          level.spawn = { c, r, x, z };
          break;
        case 'X':
          level.exit = { c, r, x, z };
          break;
        case 'B':
          level.boss = { c, r, x, z, type: def.boss };
          break;
        case 'h':
          level.potions.push({ c, r, x, z });
          break;
        case 'w':
          level.weapons.push({ c, r, x, z });
          break;
        case '~':
          level.lava.push({ c, r, x, z });
          break;
        case '^':
          level.spikes.push({ c, r, x, z });
          break;
        case 'v':
          level.vents.push({ c, r, x, z });
          break;
        default:
          if (ENEMY[ch]) level.enemies.push({ c, r, x, z, type: ENEMY[ch], burrowed: ch === 'G' });
      }
    }
  }
  return level;
}

// Returns a list of problems with a floor; empty means playable.
export function validateLevel(def, index) {
  const problems = [];
  const label = `Floor ${index + 1} (${def.name})`;
  let level;
  try {
    level = parseLevel(def);
  } catch (e) {
    return [`${label}: ${e.message}`];
  }
  const count = (ch) => def.map.join('').split(ch).length - 1;
  if (count('P') !== 1) problems.push(`${label}: needs exactly one P`);
  if (count('X') !== 1) problems.push(`${label}: needs exactly one X`);
  if (def.boss && count('B') !== 1) problems.push(`${label}: boss floor needs exactly one B`);
  if (!def.boss && count('B') !== 0) problems.push(`${label}: B on a non-boss floor`);
  if (!level.spawn || !level.exit) return problems;

  const { nav, spawn } = level;
  const reach = (t, what) => {
    const path = nav.findPath(spawn.c, spawn.r, t.c, t.r, { maxExpanded: 1e6 });
    if (!path) problems.push(`${label}: ${what} at (${t.c},${t.r}) is unreachable`);
  };
  reach(level.exit, 'exit');
  level.enemies.forEach((e) => reach(e, e.type));
  level.potions.forEach((p) => reach(p, 'potion'));
  if (level.boss) reach(level.boss, 'boss');
  if (level.enemies.length === 0 && !level.boss) problems.push(`${label}: no enemies`);
  return problems;
}

// Dead ends for treasure: where a floor has fewer than `want` dead-end
// passages, short alcoves (two tiles deep, one wide) are cut into solid rock
// off its passages and rooms, far from the spawn and from each other. They
// only add floor next to floor already reachable, so every check on the map
// still holds. Mutates the parsed level; deterministic per `rand`.
export function carveAlcoves(level, want, rand) {
  const { cols, rows, tiles, solid, nav } = level;
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? '#' : tiles[r][c]);
  const rock = (c, r) => c > 0 && r > 0 && c < cols - 1 && r < rows - 1 && at(c, r) === '#';
  const keep = [level.spawn, level.exit, level.boss].filter(Boolean);
  const ends = level.floorTiles.filter((t) => DIRS.filter(([dc, dr]) => nav.isWalkable(t.c + dc, t.r + dr)).length === 1);
  let need = Math.max(0, want - ends.length);
  const cands = [];
  for (const t of level.floorTiles) {
    if (at(t.c, t.r) !== '.' || keep.some((k) => Math.hypot(k.x - t.x, k.z - t.z) < 3 * TILE)) continue;
    for (const [dc, dr] of DIRS) {
      const a = [t.c + dc, t.r + dr];
      const b = [t.c + 2 * dc, t.r + 2 * dr];
      if (!rock(...a) || !rock(...b)) continue;
      // Rock all round the alcove but its mouth.
      let ok = true;
      for (const [c, r] of [a, b]) {
        for (let y = -1; y <= 1 && ok; y++) {
          for (let x = -1; x <= 1 && ok; x++) {
            const cc = c + x;
            const rr = r + y;
            if ((cc === t.c && rr === t.r) || (cc === a[0] && rr === a[1]) || (cc === b[0] && rr === b[1])) continue;
            if (Math.abs(cc - t.c) <= 1 && Math.abs(rr - t.r) <= 1) continue; // the mouth's own neighbours
            if (at(cc, rr) !== '#') ok = false;
          }
        }
      }
      if (ok) cands.push({ t, a, b, far: Math.hypot(t.x - level.spawn.x, t.z - level.spawn.z) + rand() * 6 });
    }
  }
  cands.sort((p, q) => q.far - p.far);
  const made = [];
  for (const k of cands) {
    if (need <= 0) break;
    const x = (k.b[0] + 0.5) * TILE;
    const z = (k.b[1] + 0.5) * TILE;
    if ([...made, ...ends].some((m) => Math.hypot(m.x - x, m.z - z) < 12)) continue;
    for (const [c, r] of [k.a, k.b]) {
      const i = r * cols + c;
      if (at(c, r) !== '#') continue;
      solid[i] = 0;
      nav.walkable[i] = 1;
      nav.cost[i] = 1;
      tiles[r] = tiles[r].slice(0, c) + '.' + tiles[r].slice(c + 1);
      level.floorTiles.push({ c, r, x: (c + 0.5) * TILE, z: (r + 0.5) * TILE });
    }
    made.push({ x, z });
    need--;
  }
  return made.length;
}

// Which way the exit faces: toward the most open ground beside it (where
// you come from), as [dc, dr].
export function exitFacing(level) {
  const x = level.exit;
  let face = [-1, 0];
  let most = -1;
  for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let open = 0;
    for (let s = 1; s <= 4; s++) if (level.nav.isWalkable(x.c + dc * s, x.r + dr * s)) open++;
    if (open > most) [face, most] = [[dc, dr], open];
  }
  return face;
}

// A secret in the floor's second passage. The main way through is the
// shortest walk from the spawn to the exit; where the map loops, blocking it
// somewhere (three tiles square: wider than any passage) turns the walk the
// other way round, and the longest stretch of another way not shared with
// the main one is the second passage.
// Halfway down it a niche one tile deep is cut into the rock (rock on every
// side but its mouth), and `level.secret` = { c, r, x, z, dir } records it
// (`dir`: from the niche out into the passage). False if the floor has no
// loop, or nowhere along it to cut.
export function carveSecret(level, rand) {
  const { cols, rows, tiles, solid, nav, spawn, exit } = level;
  if (!spawn || !exit) return false;
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const idx = (c, r) => r * cols + c;
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? '#' : tiles[r][c]);
  const open = (i) => nav.walkable[i] === 1;
  let closed = new Set();
  const route = () => {
    const parent = new Int32Array(cols * rows).fill(-2);
    const from = idx(spawn.c, spawn.r);
    const to = idx(exit.c, exit.r);
    parent[from] = -1;
    const q = [from];
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      if (i === to) break;
      const c = i % cols;
      const r = (i - c) / cols;
      for (const [dc, dr] of DIRS) {
        const j = idx(c + dc, r + dr);
        if (open(j) && !closed.has(j) && parent[j] === -2) {
          parent[j] = i;
          q.push(j);
        }
      }
    }
    if (parent[to] === -2) return null;
    const path = [];
    for (let i = to; i !== -1; i = parent[i]) path.push(i);
    return path.reverse();
  };
  const main = route();
  if (!main) return false;
  const onMain = new Set(main);
  const ends = new Set([main[0], main[main.length - 1]]);
  let other = [];
  for (const i of main.slice(3, -3)) {
    const c = i % cols;
    const r = (i - c) / cols;
    closed = new Set();
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) if (!ends.has(idx(c + x, r + y))) closed.add(idx(c + x, r + y));
    const alt = route();
    if (!alt) continue;
    const off = alt.filter((j) => !onMain.has(j));
    if (off.length > other.length) other = off;
  }
  if (other.length < 6) return false;
  // Along its middle stretch, the rock beside it.
  const rock = (c, r) => c > 0 && r > 0 && c < cols - 1 && r < rows - 1 && at(c, r) === '#';
  const cands = [];
  other.forEach((i, k) => {
    const c = i % cols;
    const r = (i - c) / cols;
    if (at(c, r) !== '.') return;
    const mid = 1 - Math.abs(k / (other.length - 1) - 0.5) * 2;
    if (mid < 0.35) return;
    for (const [dc, dr] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      // Rock all round the niche but its mouth: beside it, behind it, and
      // at the corners behind it.
      const ok = [
        [nc, nr],
        [nc + dc, nr + dr],
        [nc + dr, nr + dc],
        [nc - dr, nr - dc],
        [nc + dc + dr, nr + dr + dc],
        [nc + dc - dr, nr + dr - dc],
      ].every(([cc, rr]) => rock(cc, rr));
      if (ok) cands.push({ c: nc, r: nr, dir: [-dc, -dr], score: mid + rand() * 0.3 });
    }
  });
  if (!cands.length) return false;
  cands.sort((a, b) => b.score - a.score);
  const k = cands[0];
  const i = idx(k.c, k.r);
  solid[i] = 0;
  nav.walkable[i] = 1;
  nav.cost[i] = 1;
  tiles[k.r] = tiles[k.r].slice(0, k.c) + '.' + tiles[k.r].slice(k.c + 1);
  const x = (k.c + 0.5) * TILE;
  const z = (k.r + 0.5) * TILE;
  level.floorTiles.push({ c: k.c, r: k.r, x, z });
  // `passage`: the tiles of the way round it lies on (no demon waits there).
  level.secret = { c: k.c, r: k.r, x, z, dir: k.dir, passage: other };
  return true;
}
