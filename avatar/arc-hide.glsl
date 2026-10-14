// The game copy of the lightning (the Game mesh in make-avatar.mjs):
// clips flash it for games, which draw the bare model. In the city the
// shaders strike the real bolts, so the copy stays out of sight.
void p0Surface(inout P0Surface s) {
  s.alpha = 0.0;
  discard;
}
