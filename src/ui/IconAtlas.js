import * as THREE from 'three';
import { iconRect, CELL } from './icons.js';
import { makeCanvas } from '../world/Textures.js';

// The painted icon atlas (assets/icons/atlas.webp, see icons.js), loaded
// once at start. Read with fetch + createImageBitmap so it works inside
// Project 0's worker sandbox and never taints the HUD canvas.

export const IconAtlas = {
  image: null,
  textures: new Map(),

  async load(resolve = (p) => p) {
    try {
      const res = await fetch(resolve('assets/icons/atlas.webp'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.image = await createImageBitmap(await res.blob());
    } catch (e) {
      console.warn(`No icon atlas (${e.message}): icons are drawn plain`);
    }
  },

  has(id) {
    return !!this.image && !!iconRect(id);
  },

  // Draw icon `id` into a 2D context at (x, y), `size` px square.
  draw(g, id, x, y, size) {
    const r = iconRect(id);
    if (!r || !this.image) return false;
    g.drawImage(this.image, r.x, r.y, r.w, r.h, x, y, size, size);
    return true;
  },

  // One icon as a texture of its own (for sprites in the world).
  texture(id) {
    if (this.textures.has(id)) return this.textures.get(id);
    const c = makeCanvas(CELL, CELL);
    if (!this.draw(c.getContext('2d'), id, 0, 0, CELL)) return null;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(id, t);
    return t;
  },
};
