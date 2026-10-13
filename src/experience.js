import { Game } from './game/Game.js';
import { Assets } from './assets/AssetLibrary.js';
import { createP0Host } from './platform/p0host.js';

// Project 0 experience entry: start(p0) runs in the lot's sandbox when a
// player enters. Returns once the title screen can be drawn; shaders then
// compile over the first frames behind the opening black, and the surface
// lot orbits behind the title while the player reads.

export default async function start(p0) {
  const host = createP0Host(p0);
  await Assets.preload(null, (path) => p0.asset(path));
  const game = new Game(host);
  game.ready();
}
