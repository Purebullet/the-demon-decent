// Shared helpers: cheap hashes and a smooth 3D value noise.
float srHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float srNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(srHash(i), srHash(i + vec3(1, 0, 0)), u.x), mix(srHash(i + vec3(0, 1, 0)), srHash(i + vec3(1, 1, 0)), u.x), u.y);
  float b = mix(mix(srHash(i + vec3(0, 0, 1)), srHash(i + vec3(1, 0, 1)), u.x), mix(srHash(i + vec3(0, 1, 1)), srHash(i + vec3(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}
