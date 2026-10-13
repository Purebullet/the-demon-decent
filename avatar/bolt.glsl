// When each bolt strikes: on its own rhythm it lashes out from the body,
// stutters, and is gone; a storm (an emote) or speed makes them strike more
// and stay longer. A white-hot core inside an electric-blue sheath.
void p0Surface(inout P0Surface s) {
  float id = floor(s.uv.x);
  float along = fract(s.uv.x);
  float across = abs(s.uv.y - 0.5) * 2.0;
  float rate = 0.7 + 0.6 * srHash(vec3(id, 3.0, 1.0));
  float phase = p0Time * rate + srHash(vec3(id, 9.0, 2.0));
  float cycle = floor(phase);
  float k = fract(phase);
  float window = clamp(0.2 + 0.5 * storm + 0.25 * p0Speed, 0.0, 0.95);
  // Not every cycle strikes.
  float strikes = step(0.45 - 0.45 * storm, srHash(vec3(id, cycle, 5.0)));
  float on = step(k, window) * strikes;
  // It reaches out from the body over the first part of its strike...
  float reach = clamp(k / max(0.02, window * 0.25), 0.0, 1.0);
  on *= step(along, reach);
  // ...and stutters while it holds.
  on *= step(0.3, srHash(vec3(id, floor(p0Time * 32.0), 3.0)));
  // Across the ribbon: a thin white-hot core, electric cyan round it, a
  // deep blue edge fading out (it has to read against the white city too).
  float core = 1.0 - smoothstep(0.0, 0.22, across);
  float glow = pow(1.0 - across, 1.6);
  vec3 col = mix(deep, tint, smoothstep(0.15, 0.75, 1.0 - across));
  col = mix(col, vec3(0.9, 0.98, 1.0), core);
  s.color = col;
  s.emissive = col * (0.4 + 1.2 * core);
  s.alpha = on * clamp(core + glow * 0.95, 0.0, 1.0) * (1.0 - along * 0.3);
}
