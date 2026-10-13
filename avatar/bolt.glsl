// When each bolt strikes.
//   Standing still: now and then one grows slowly out of the body (or runs
//   round it), crackles a moment and fades.
//   Flying: those stop; the trail bolts pour out of the back instead,
//   more the faster you go.
//   Lifting off (Joy, or a like): only the jet below (the Exhaust mesh,
//   which its clip shows and hides).
//   A storm (Indignation) sets the body's bolts off all together.
// Vivid electric blue round a pale cyan core, saturated enough to read
// against the white city as well as the dark.
void p0Surface(inout P0Surface s) {
  float id = floor(vBolt.x + 0.5);
  float along = vBolt.y;
  float across = abs(vBolt.z - 0.5) * 2.0;
  float exhaust = step(BOLT_EXHAUST_FIRST, id);
  float trail = step(BOLT_TRAIL_FIRST, id) * (1.0 - exhaust);
  float speed = smoothstep(0.03, 0.35, p0Speed);
  float lift = (abs(p0Emote - 1.0) < 0.5 || abs(p0Emote - 10.0) < 0.5) ? 1.0 : 0.0;
  float on = 1.0;
  float fade = 1.0;
  if (exhaust < 0.5) {
    float h1 = srHash(vec3(id, 3.0, 1.0));
    // The trail bolts share one beat, staggered evenly and out of order
    // round the base, so at any moment the lit ones are spread all round.
    float period = trail > 0.5 ? 0.5 : 1.8 + 1.4 * h1;
    float dur = trail > 0.5 ? period * (0.65 + 0.25 * p0Speed) : 0.75;
    float offset = trail > 0.5 ? fract((id - BOLT_TRAIL_FIRST) * 0.375) : srHash(vec3(id, 9.0, 2.0));
    float phase = p0Time / period + offset;
    float t = fract(phase) * period;
    float chance = trail > 0.5 ? speed : (0.35 + 0.6 * storm) * (1.0 - max(speed, lift));
    float strikes = step(1.0 - chance, srHash(vec3(id, floor(phase), 5.0)));
    // It grows out of the body (slowly, at rest), holds, and fades away.
    float grow = clamp(t / (trail > 0.5 ? 0.08 : 0.3), 0.0, 1.0);
    on = strikes * step(t, dur) * step(along, grow);
    fade = 1.0 - smoothstep(dur - 0.22, dur, t);
  }
  // A little stutter.
  on *= step(0.08, srHash(vec3(id, floor(p0Time * 18.0), 3.0)));
  float core = 1.0 - smoothstep(0.0, 0.3, across);
  float body = 1.0 - smoothstep(0.35, 1.0, across);
  vec3 col = mix(deep, tint, body * 0.85);
  col = mix(col, vec3(0.78, 0.96, 1.0), core * 0.85);
  s.color = col;
  s.emissive = col * 0.35 * core;
  s.alpha = on * fade * clamp(core + body * 0.95, 0.0, 1.0) * (1.0 - along * 0.25);
  // Gone means gone, even if the material were drawn opaque.
  if (s.alpha < 0.02) discard;
}
