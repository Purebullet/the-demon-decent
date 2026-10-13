// Lightning that will not hold still: every few hundredths of a second each
// bolt's kinks are thrown somewhere new, never at its ends (where it touches
// the body). The normal carries the bolt, the distance along it and the
// ribbon edge (bolt-common.glsl), handed on to the surface in vBolt.
vec3 p0Vertex(vec3 position, vec3 normal, vec2 uv) {
  vec3 b = boltDecode(normal);
  vBolt = b;
  float seg = floor(b.y * 12.0 + 0.5);
  float tick = floor(p0Time * (16.0 + 10.0 * storm) + b.x * 1.37);
  float amp = sin(b.y * 3.14159) * (0.05 + 0.07 * storm + 0.03 * p0Speed);
  vec3 kink = vec3(srHash(vec3(b.x, seg, tick)), srHash(vec3(b.x + 17.0, seg, tick)), srHash(vec3(b.x + 31.0, seg, tick))) * 2.0 - 1.0;
  return position + kink * amp;
}
