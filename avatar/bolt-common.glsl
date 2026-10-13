// Written by scripts/make-avatar.mjs: how each lightning vertex carries its
// bolt, its distance along it and its ribbon edge, in its (object-space)
// normal; see boltEncode there. The vertex stage decodes it and hands it to
// the surface stage in vBolt = (bolt, along, edge).
#define BOLT_COUNT 16.0
#define BOLT_POLE 0.15
varying vec3 vBolt;
vec3 boltDecode(vec3 n) {
  n = normalize(n);
  float along = clamp((acos(clamp(n.y, -1.0, 1.0)) - BOLT_POLE) / (3.14159265 - 2.0 * BOLT_POLE), 0.0, 1.0);
  float u = fract(atan(n.z, n.x) / 6.28318531 + 1.0);
  float code = floor(u * 2.0 * BOLT_COUNT);
  float bolt = floor(code * 0.5);
  return vec3(bolt, along, code - 2.0 * bolt);
}
