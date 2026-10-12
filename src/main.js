import { Game } from './game/Game.js';
import { Assets } from './assets/AssetLibrary.js';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!webglAvailable()) {
  document.getElementById('title').style.display = 'none';
  document.getElementById('nogl').style.display = 'flex';
} else {
  // Load whatever AI-generated models exist before the lot is built.
  const status = document.getElementById('titleBest');
  status.textContent = 'Summoning\u2026';
  Assets.preload((done, total) => {
    status.textContent = `Summoning\u2026 ${done}/${total}`;
  }).then((loaded) => {
    if (loaded.length) console.info(`Loaded ${loaded.length} generated models`, loaded);
    const game = new Game(document.getElementById('game'));
    // Handy for debugging from the console.
    window.__demonDescent = game;
    requestAnimationFrame(() => {
      document.getElementById('fade').style.opacity = '0';
    });
  });
}
