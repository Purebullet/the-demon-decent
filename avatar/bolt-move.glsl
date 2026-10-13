// Lays the lightning out and keeps it from holding still. The normal
// carries each vertex's bolt, distance along it and ribbon edge
// (bolt-common.glsl), handed on to the surface in vBolt.
//
// In flight the round leans nose first, so its base (-Y here) points back:
// the trail bolts unfurl out of it, longer the faster you go. The lift-off
// jet (the Exhaust mesh) is laid out already. The kinks are thrown
// somewhere new a few times a second, never at the ends that touch the body.
vec3 p0Vertex(vec3 position, vec3 normal, vec2 uv) {
  vec3 b = boltDecode(normal);
  vBolt = b;
  float id = b.x;
  float along = b.y;
  vec3 p = position;
  float seg = floor(along * 12.0 + 0.5);
  float rate = 7.0 + 12.0 * storm;
  float amp = sin(along * 3.14159) * (0.025 + 0.05 * storm);
  if (id >= BOLT_EXHAUST_FIRST) {
    rate = 14.0;
    amp = sin(along * 3.14159) * 0.07;
  } else if (id >= BOLT_TRAIL_FIRST) {
    vec3 root = p - vec3(0.0, along * BOLT_FOLD, 0.0);
    vec3 dir = normalize(vec3(root.x * 1.8, -1.0, root.z * 1.8));
    float len = (0.35 + 0.75 * p0Speed) * (0.75 + 0.5 * srHash(vec3(id, 2.0, 7.0)));
    p = root + dir * along * len;
    rate = 12.0;
    amp = sin(along * 3.14159) * (0.05 + 0.04 * p0Speed) * len;
  }
  float tick = floor(p0Time * rate + id * 1.37);
  vec3 kink = vec3(srHash(vec3(id, seg, tick)), srHash(vec3(id + 17.0, seg, tick)), srHash(vec3(id + 31.0, seg, tick))) * 2.0 - 1.0;
  return p + kink * amp;
}
