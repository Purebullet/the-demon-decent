// Grid navigation for the static cavern layouts: A* over an 8-connected tile
// grid with terrain costs (enemies route around lava and spike traps), an
// optional per-query penalty field (used by flankers to avoid the player's
// line of sight, and to spread a pack across different corridors), grid line
// of sight, and string-pulling to turn tile paths into natural walk lines.

const SQRT2 = Math.SQRT2;
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

class MinHeap {
  constructor() {
    this.ids = [];
    this.keys = [];
  }
  get size() {
    return this.ids.length;
  }
  clear() {
    this.ids.length = 0;
    this.keys.length = 0;
  }
  push(id, key) {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop() {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop();
    const lastKey = keys.pop();
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

export class NavGrid {
  constructor(cols, rows, tileSize = 2) {
    this.cols = cols;
    this.rows = rows;
    this.tileSize = tileSize;
    const n = cols * rows;
    this.walkable = new Uint8Array(n);
    this.cost = new Float32Array(n).fill(1);
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.openStamp = new Uint32Array(n);
    this.closedStamp = new Uint32Array(n);
    this.searchId = 0;
    this.heap = new MinHeap();
    this.lastExpanded = 0;
  }

  index(c, r) {
    return r * this.cols + c;
  }

  inBounds(c, r) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  isWalkable(c, r) {
    return this.inBounds(c, r) && this.walkable[r * this.cols + c] === 1;
  }

  tileX(x) {
    return Math.floor(x / this.tileSize);
  }

  tileZ(z) {
    return Math.floor(z / this.tileSize);
  }

  centerX(c) {
    return (c + 0.5) * this.tileSize;
  }

  centerZ(r) {
    return (r + 0.5) * this.tileSize;
  }

  // Closest walkable tile by expanding rings; used when a target stands on a
  // tile edge or a flank slot falls inside rock.
  nearestWalkable(c, r, maxRadius = 6) {
    if (this.isWalkable(c, r)) return { c, r };
    for (let rad = 1; rad <= maxRadius; rad++) {
      let best = null;
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          if (!this.isWalkable(c + dc, r + dr)) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) {
            bestD = d;
            best = { c: c + dc, r: r + dr };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // A* from tile (sc, sr) to (gc, gr). Returns an array of tile indices from
  // start to goal, or null. `penalty(idx)` adds a non-negative cost for
  // entering a tile, which keeps the octile heuristic admissible.
  findPath(sc, sr, gc, gr, { penalty = null, maxExpanded = 4000 } = {}) {
    if (!this.isWalkable(sc, sr)) {
      const s = this.nearestWalkable(sc, sr, 2);
      if (!s) return null;
      sc = s.c;
      sr = s.r;
    }
    if (!this.isWalkable(gc, gr)) {
      const g = this.nearestWalkable(gc, gr, 4);
      if (!g) return null;
      gc = g.c;
      gr = g.r;
    }
    const cols = this.cols;
    const start = sr * cols + sc;
    const goal = gr * cols + gc;
    if (start === goal) return [start];

    const id = ++this.searchId;
    const { g, parent, openStamp, closedStamp, heap, walkable, cost } = this;
    heap.clear();
    g[start] = 0;
    parent[start] = -1;
    openStamp[start] = id;
    heap.push(start, this._h(sc, sr, gc, gr));
    let expanded = 0;

    while (heap.size > 0) {
      const cur = heap.pop();
      if (closedStamp[cur] === id) continue;
      if (cur === goal) {
        this.lastExpanded = expanded;
        return this._reconstruct(goal);
      }
      closedStamp[cur] = id;
      if (++expanded > maxExpanded) break;

      const cc = cur % cols;
      const cr = (cur - cc) / cols;
      for (let d = 0; d < 8; d++) {
        const dir = DIRS[d];
        const nc = cc + dir[0];
        const nr = cr + dir[1];
        if (nc < 0 || nr < 0 || nc >= cols || nr >= this.rows) continue;
        const ni = nr * cols + nc;
        if (walkable[ni] !== 1 || closedStamp[ni] === id) continue;
        // No corner cutting: a diagonal step needs both orthogonal tiles open.
        if (dir[2] !== 1 && (walkable[cr * cols + nc] !== 1 || walkable[nr * cols + cc] !== 1)) continue;
        let step = dir[2] * cost[ni];
        if (penalty) step += penalty(ni);
        const ng = g[cur] + step;
        if (openStamp[ni] === id && ng >= g[ni]) continue;
        openStamp[ni] = id;
        g[ni] = ng;
        parent[ni] = cur;
        heap.push(ni, ng + this._h(nc, nr, gc, gr));
      }
    }
    this.lastExpanded = expanded;
    return null;
  }

  _h(c, r, gc, gr) {
    const dx = Math.abs(c - gc);
    const dy = Math.abs(r - gr);
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
  }

  _reconstruct(goal) {
    const out = [];
    let cur = goal;
    while (cur !== -1) {
      out.push(cur);
      cur = this.parent[cur];
    }
    return out.reverse();
  }

  // World-space convenience: returns smoothed waypoints [{x, z}] (excluding
  // the start point) or null.
  findPathWorld(fromX, fromZ, toX, toZ, opts = {}) {
    const tiles = this.findPath(this.tileX(fromX), this.tileZ(fromZ), this.tileX(toX), this.tileZ(toZ), opts);
    if (!tiles) return null;
    const pts = tiles.map((i) => {
      const c = i % this.cols;
      return { x: this.centerX(c), z: this.centerZ((i - c) / this.cols) };
    });
    // Use the exact goal position when it is on the goal tile.
    const last = pts[pts.length - 1];
    if (this.tileX(toX) === this.tileX(last.x) && this.tileZ(toZ) === this.tileZ(last.z)) {
      last.x = toX;
      last.z = toZ;
    }
    pts[0] = { x: fromX, z: fromZ };
    return this.smoothPath(pts, opts.clearance ?? 0.45).slice(1);
  }

  // Supercover grid traversal (Amanatides & Woo) between two world points.
  // With avoidHazards, tiles that cost more than plain floor also block, so
  // smoothed paths never cut across lava the A* deliberately walked around.
  segmentClear(x0, z0, x1, z1, avoidHazards = false) {
    const t = this.tileSize;
    let c = Math.floor(x0 / t);
    let r = Math.floor(z0 / t);
    const ce = Math.floor(x1 / t);
    const re = Math.floor(z1 / t);
    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepC = dx > 0 ? 1 : -1;
    const stepR = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(t / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(t / dz) : Infinity;
    let tMaxX = dx !== 0 ? ((stepC > 0 ? (c + 1) * t - x0 : x0 - c * t) / Math.abs(dx)) : Infinity;
    let tMaxZ = dz !== 0 ? ((stepR > 0 ? (r + 1) * t - z0 : z0 - r * t) / Math.abs(dz)) : Infinity;
    const blocked = (cc, rr) => !this.isWalkable(cc, rr) || (avoidHazards && this.cost[rr * this.cols + cc] > 1.01);

    if (blocked(c, r) && !(avoidHazards && this.isWalkable(c, r))) return false;
    let guard = this.cols + this.rows + 4;
    while ((c !== ce || r !== re) && guard-- > 0) {
      if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
        // Passing exactly through a corner: both neighbours must be open.
        if (blocked(c + stepC, r) || blocked(c, r + stepR)) return false;
        c += stepC;
        r += stepR;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      } else if (tMaxX < tMaxZ) {
        c += stepC;
        tMaxX += tDeltaX;
      } else {
        r += stepR;
        tMaxZ += tDeltaZ;
      }
      if (blocked(c, r)) return false;
    }
    return true;
  }

  // Line of sight with a body width: the centre line and two parallel lines
  // offset by `radius` must all be clear.
  hasLineOfSight(x0, z0, x1, z1, radius = 0, avoidHazards = false) {
    if (!this.segmentClear(x0, z0, x1, z1, avoidHazards)) return false;
    if (radius <= 0) return true;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const ox = (-dz / len) * radius;
    const oz = (dx / len) * radius;
    return (
      this.segmentClear(x0 + ox, z0 + oz, x1 + ox, z1 + oz, avoidHazards) &&
      this.segmentClear(x0 - ox, z0 - oz, x1 - ox, z1 - oz, avoidHazards)
    );
  }

  // Greedy string pulling: from each anchor, skip ahead to the furthest
  // waypoint still in clear line of sight.
  smoothPath(pts, clearance = 0.45) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let anchor = 0;
    while (anchor < pts.length - 1) {
      let next = anchor + 1;
      for (let j = pts.length - 1; j > anchor + 1; j--) {
        if (this.hasLineOfSight(pts[anchor].x, pts[anchor].z, pts[j].x, pts[j].z, clearance, true)) {
          next = j;
          break;
        }
      }
      out.push(pts[next]);
      anchor = next;
    }
    return out;
  }
}

// Spreads A* work over frames: each agent holds at most one pending request,
// and only `budget` searches run per frame, so a 30-strong swarm repathing at
// once never causes a hitch.
export class PathService {
  constructor(nav, budget = 6) {
    this.nav = nav;
    this.budget = budget;
    this.queue = [];
    this.pending = new Map();
  }

  request(agent, toX, toZ, opts = {}) {
    const existing = this.pending.get(agent);
    if (existing) {
      existing.toX = toX;
      existing.toZ = toZ;
      existing.opts = opts;
      return;
    }
    const req = { agent, toX, toZ, opts };
    this.pending.set(agent, req);
    this.queue.push(req);
  }

  cancel(agent) {
    const req = this.pending.get(agent);
    if (!req) return;
    this.pending.delete(agent);
    req.cancelled = true;
  }

  update() {
    let done = 0;
    while (done < this.budget && this.queue.length) {
      const req = this.queue.shift();
      if (req.cancelled) continue;
      this.pending.delete(req.agent);
      const a = req.agent;
      const path = this.nav.findPathWorld(a.position.x, a.position.z, req.toX, req.toZ, req.opts);
      a.onPath?.(path);
      done++;
    }
  }
}
