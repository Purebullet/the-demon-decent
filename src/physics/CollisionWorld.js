// Static world collision for characters, which are vertical cylinders and so
// reduce to circles on the XZ plane. Solids come from a tile grid (caverns),
// and from loose circles and axis-aligned boxes (surface ruins).

export class CollisionWorld {
  constructor({ grid = null, tileSize = 2, circles = [], boxes = [], boundRadius = 0, boundCenter = null } = {}) {
    this.grid = grid; // { cols, rows, solid: Uint8Array }
    this.tileSize = tileSize;
    this.circles = circles; // { x, z, r }
    this.boxes = boxes; // { minX, minZ, maxX, maxZ }
    this.boundRadius = boundRadius;
    this.boundCenter = boundCenter || { x: 0, z: 0 };
  }

  isSolidTile(c, r) {
    const g = this.grid;
    if (!g) return false;
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return true;
    return g.solid[r * g.cols + c] === 1;
  }

  isSolidAt(x, z) {
    return this.isSolidTile(Math.floor(x / this.tileSize), Math.floor(z / this.tileSize));
  }

  // Move a circle by (dx, dz), sliding along walls. Long moves are split into
  // sub-steps no longer than the radius so fast dashes cannot tunnel.
  move(pos, radius, dx, dz) {
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (radius * 0.75)));
    const sx = dx / steps;
    const sz = dz / steps;
    let hit = false;
    for (let i = 0; i < steps; i++) {
      pos.x += sx;
      pos.z += sz;
      if (this.resolve(pos, radius)) hit = true;
    }
    return hit;
  }

  resolve(pos, radius) {
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      if (this.grid) moved = this._resolveGrid(pos, radius) || moved;
      for (const b of this.boxes) moved = pushOutOfBox(pos, radius, b.minX, b.minZ, b.maxX, b.maxZ) || moved;
      for (const c of this.circles) moved = pushOutOfCircle(pos, radius, c.x, c.z, c.r) || moved;
      if (this.boundRadius > 0) {
        const dx = pos.x - this.boundCenter.x;
        const dz = pos.z - this.boundCenter.z;
        const d = Math.hypot(dx, dz);
        const max = this.boundRadius - radius;
        if (d > max) {
          pos.x = this.boundCenter.x + (dx / d) * max;
          pos.z = this.boundCenter.z + (dz / d) * max;
          moved = true;
        }
      }
      if (!moved) break;
      hit = true;
    }
    return hit;
  }

  _resolveGrid(pos, radius) {
    const t = this.tileSize;
    const c0 = Math.floor((pos.x - radius) / t);
    const c1 = Math.floor((pos.x + radius) / t);
    const r0 = Math.floor((pos.z - radius) / t);
    const r1 = Math.floor((pos.z + radius) / t);
    let moved = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!this.isSolidTile(c, r)) continue;
        moved = pushOutOfBox(pos, radius, c * t, r * t, (c + 1) * t, (r + 1) * t) || moved;
      }
    }
    return moved;
  }
}

export function pushOutOfBox(pos, radius, minX, minZ, maxX, maxZ) {
  const qx = Math.max(minX, Math.min(pos.x, maxX));
  const qz = Math.max(minZ, Math.min(pos.z, maxZ));
  const dx = pos.x - qx;
  const dz = pos.z - qz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return false;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    pos.x += (dx / d) * (radius - d);
    pos.z += (dz / d) * (radius - d);
    return true;
  }
  // Centre is inside the box: leave by the nearest face.
  const left = pos.x - minX;
  const right = maxX - pos.x;
  const top = pos.z - minZ;
  const bottom = maxZ - pos.z;
  const m = Math.min(left, right, top, bottom);
  if (m === left) pos.x = minX - radius;
  else if (m === right) pos.x = maxX + radius;
  else if (m === top) pos.z = minZ - radius;
  else pos.z = maxZ + radius;
  return true;
}

export function pushOutOfCircle(pos, radius, cx, cz, cr) {
  const dx = pos.x - cx;
  const dz = pos.z - cz;
  const min = radius + cr;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return false;
  const d = Math.sqrt(d2) || 1e-4;
  pos.x = cx + (dx / d) * min;
  pos.z = cz + (dz / d) * min;
  return true;
}
