import { Assets } from '../assets/AssetLibrary.js';

// Frees the GPU side (buffers, textures) of everything under `root` that was
// made for it: a floor's rock and props, its pickups, effects and demons'
// own parts. The loaded models' geometry and textures are shared by every
// floor and stay. Anything freed that is drawn again is simply uploaded
// again, so a shared cache (a particle texture) only costs that.
export function disposeTree(root, extra = []) {
  if (!root) return;
  const keep = Assets.shared();
  const geometries = new Set(extra);
  const textures = new Set();
  root.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      for (const k in m) if (m[k]?.isTexture) textures.add(m[k]);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u?.value?.isTexture) textures.add(u.value);
    }
  });
  for (const g of geometries) if (g && !keep.has(g)) g.dispose();
  for (const t of textures) if (!keep.has(t)) t.dispose();
}
