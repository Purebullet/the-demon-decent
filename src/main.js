import { Game } from './game/Game.js';

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
  const game = new Game(document.getElementById('game'));
  // Handy for debugging from the console.
  window.__demonDescent = game;
  requestAnimationFrame(() => {
    document.getElementById('fade').style.opacity = '0';
  });
}
