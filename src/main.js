import { Game } from './game/Game.js';
import { Assets } from './assets/AssetLibrary.js';
import { createBrowserHost } from './platform/browserhost.js';

// Entry for a plain web page (`npm run dev`, or the game on its own site).
// Project 0 uses src/experience.js instead.

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const status = document.getElementById('status');
if (!webglAvailable()) {
  status.textContent = 'WebGL is required. Try a recent desktop browser.';
} else {
  const host = createBrowserHost(document.getElementById('game'));
  const params = new URLSearchParams(location.search);
  const devFloor = Math.min(20, Math.max(0, parseInt(params.get('floor') || '0', 10) || 0));
  Assets.preload((done, total) => {
    status.textContent = `Summoning… ${done}/${total}`;
  }).then(async (loaded) => {
    if (loaded.length) console.info(`Loaded ${loaded.length} generated models`, loaded);
    const game = new Game(host, { devFloor });
    await game.ready();
    // Handy for debugging from the console.
    window.__demonDescent = game;
    status.remove();
  });
}
