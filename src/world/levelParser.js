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
