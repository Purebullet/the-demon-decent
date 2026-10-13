// When each bolt strikes. Standing still, now and then a short one flickers
// off the body or an arc runs round it; in flight the trail bolts pour out
// of the back almost without pause, more the faster you go; a storm (an
// emote) sets everything off. Vivid electric blue round a pale cyan core,
// saturated enough to read against the white city as well as the dark.
void p0Surface(inout P0Surface s) {
  float id = floor(vBolt.x + 0.5);
  float along = vBolt.y;
  float across = abs(vBolt.z - 0.5) * 2.0;
  float trail = step(BOLT_TRAIL_FIRST, id);
  float fly = smoothstep(0.03, 0.35, p0Speed);
  float rate = mix(0.55 + 0.4 * srHash(vec3(id, 3.0, 1.0)), 1.6 + 0.8 * srHash(vec3(id, 4.0, 1.0)), trail);
  float phase = p0Time * rate + srHash(vec3(id, 9.0, 2.0));
  float cycle = floor(phase);
  float k = fract(phase);
  float window = trail > 0.5 ? (0.55 + 0.35 * p0Speed) * fly : clamp(0.15 + 0.5 * storm + 0.1 * fly, 0.0, 0.95);
  float chance = trail > 0.5 ? 0.9 : 0.5 + 0.45 * storm;
  float strikes = step(1.0 - chance, srHash(vec3(id, cycle, 5.0)));
  float on = step(k, window) * strikes;
  // It reaches out from the body over the first part of its strike...
  float reach = clamp(k / max(0.02, window * 0.2), 0.0, 1.0);
  on *= step(along, reach);
  // ...and stutters while it holds.
  on *= step(0.1, srHash(vec3(id, floor(p0Time * 20.0), 3.0)));
  float core = 1.0 - smoothstep(0.0, 0.3, across);
  float body = 1.0 - smoothstep(0.35, 1.0, across);
  vec3 col = mix(deep, tint, body * 0.85);
  col = mix(col, vec3(0.78, 0.96, 1.0), core * 0.85);
  s.color = col;
  s.emissive = col * 0.35 * core;
  s.alpha = on * clamp(core + body * 0.95, 0.0, 1.0) * (1.0 - along * 0.25);
  // Gone means gone, even if the material were drawn opaque.
  if (s.alpha < 0.02) discard;
}
