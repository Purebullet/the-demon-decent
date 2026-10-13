// Nothing in hell shines. Every lit material is made matte before it is
// first drawn (Game.warmUp runs each one through here): no metalness, no
// glossy roughness maps, roughness kept high, so the torch never paints a
// wet or chrome highlight on stone, flesh, bone or iron.
export function matte(m) {
  if (!m || !m.isMeshStandardMaterial || m.userData.matte) return m;
  m.userData.matte = true;
  if (m.metalness > 0.08 || m.metalnessMap || m.roughness < 0.82 || m.roughnessMap) {
    m.metalness = Math.min(m.metalness, 0.08);
    m.metalnessMap = null;
    m.roughness = Math.max(m.roughness, 0.82);
    m.roughnessMap = null;
    m.needsUpdate = true;
  }
  return m;
}
