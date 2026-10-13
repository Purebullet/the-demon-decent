// Written by scripts/make-avatar.mjs: how the lightning's UVs are packed.
// uv.x runs 0 to 1 along a bolt; uv.y = (2 x bolt + edge) / (2 x BOLT_COUNT - 1).
#define BOLT_COUNT 16.0
float boltId(vec2 uv) { return floor(uv.y * (2.0 * BOLT_COUNT - 1.0) * 0.5 + 0.01); }
// 0 on the ribbon's centre line, 1 at its edges.
float boltAcross(vec2 uv) { return abs(uv.y * (2.0 * BOLT_COUNT - 1.0) - 2.0 * boltId(uv) - 0.5) * 2.0; }
