// The Storm Round's shell: the pale channels and panels of its casing burn
// with power that pulses up them in waves; thin arcs of lightning skitter
// over the whole of it; a cold rim of light. `surge` (an emote) feeds or
// starves the power, `storm` sets how wild the crackle is; flying feeds it.
void p0Surface(inout P0Surface s) {
  vec3 base = s.color;
  float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
  // The casing's light parts are its channels, panels and circuit lines.
  float lit = smoothstep(0.16, 0.42, lum);
  float power = max(0.0, 1.0 + surge + 0.35 * p0Speed);
  float y = s.position.y;
  // Soft swells of power climbing the body: each fades in and out again
  // (a smooth bump, no edge where one ends and the next begins).
  float w = fract(y * 0.55 - p0Time * 0.6);
  float wave = smoothstep(0.0, 0.5, w) * smoothstep(1.0, 0.5, w);
  wave *= wave;
  float hum = 0.8 + 0.2 * sin(p0Time * 4.0 + y * 3.0);
  vec3 energy = mix(deep, tint, 0.6 + 0.4 * wave);
  s.emissive += energy * lit * (1.1 * hum + 1.3 * wave) * power;
  // Arcs: the ridges of a moving noise, sharpened to hairlines, lit in
  // bursts (more of them in a storm).
  float n = srNoise(s.position * 7.0 + vec3(0.0, -p0Time * 2.5, p0Time * 0.7));
  float ridge = pow(1.0 - abs(n * 2.0 - 1.0), 24.0);
  float burst = step(0.62 - 0.4 * storm, srHash(vec3(floor(p0Time * 9.0), floor(y * 3.0), 7.0)));
  s.emissive += vec3(0.75, 0.95, 1.0) * ridge * burst * (1.5 + 2.5 * storm) * power;
  // A cold rim.
  float rim = pow(1.0 - max(dot(s.normal, s.view), 0.0), 3.0);
  s.emissive += tint * rim * (0.5 + 0.6 * p0Speed) * power;
  // The channels read as glass, the casing as dark steel.
  s.color = mix(base * vec3(0.55, 0.65, 0.8), base * vec3(0.8, 1.0, 1.15), lit);
  s.roughness = mix(0.45, 0.18, lit);
  s.metalness = mix(0.85, 0.2, lit);
}
