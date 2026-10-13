// Lightning that will not hold still: every few hundredths of a second each
// bolt's kinks are thrown somewhere new, never at the end touching the body.
// uv.x: the bolt's number plus how far along it (0 at the body, 1 at the
// end); the normal: which way it may be thrown.
vec3 p0Vertex(vec3 position, vec3 normal, vec2 uv) {
  float id = floor(uv.x);
  float along = fract(uv.x);
  float seg = floor(along * 12.0 + 0.5);
  float tick = floor(p0Time * (16.0 + 10.0 * storm) + id * 1.37);
  float amp = sin(along * 3.14159) * (0.05 + 0.07 * storm + 0.03 * p0Speed);
  vec3 side = cross(normal, vec3(0.0, 1.0, 0.0));
  side = dot(side, side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
  float a = srHash(vec3(id, seg, tick)) * 2.0 - 1.0;
  float b = srHash(vec3(id + 17.0, seg, tick)) * 2.0 - 1.0;
  return position + normal * a * amp + side * b * amp;
}
