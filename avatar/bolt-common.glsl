// Written by scripts/make-avatar.mjs: how each lightning vertex carries its
// bolt, its distance along it and its ribbon edge, in its (object-space)
// normal; see boltEncode there. The vertex stage decodes it and hands it to
// the surface stage in vBolt = (bolt, along, edge).
#define BOLT_COUNT 24.0
// Bolts from BOLT_TRAIL_FIRST stream out of the base in flight, stored
// folded BOLT_FOLD m straight up against it; from BOLT_EXHAUST_FIRST they
// are the lift-off jet (the Exhaust mesh, shown by its clip).
#define BOLT_TRAIL_FIRST 11.0
#define BOLT_TRAIL_COUNT 8.0
#define BOLT_EXHAUST_FIRST 19.0
#define BOLT_FOLD 0.3
varying vec3 vBolt;
vec3 boltDecode(vec3 n) {
  n = normalize(n);
  float th = acos(clamp(n.y, -1.0, 1.0));
  float edge = step(1.5707963, th);
  float lo = mix(0.5, 1.691593, edge);
  float along = clamp((th - lo) / 0.950000, 0.0, 1.0);
  float bolt = floor(fract(atan(n.z, n.x) / 6.28318531 + 1.0) * BOLT_COUNT);
  return vec3(bolt, along, edge);
}
