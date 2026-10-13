import * as THREE from 'three';

// The game talks to its surroundings through a small "host" object. This one
// wraps Project 0's `p0` sandbox: its renderer and camera, its input events,
// sound files, the lot's weekly score table, and package asset URLs.
//
// The camera trick: Project 0 clips a game to the lot's box on screen when
// its camera is outside the box. The descent spans caverns 90 m across, so
// the render camera stays at the lot's centre and the world is shifted
// around it each frame (see Game._render). `anchor` is that point.

export function createP0Host(p0) {
  p0.createRenderer?.({ antialias: false, powerPreference: 'high-performance' });
  p0.autoRender = false;
  p0.controls.mode = 'none';
  p0.controls.vertical = false;
  if (p0.bodies) p0.bodies.visible = false;

  const listeners = new Map();
  const emit = (type, e) => {
    for (const fn of listeners.get(type) || []) fn(e);
  };
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'pointerlock', 'resize']) {
    p0.on(type, (e) => emit(type, e || {}));
  }
  p0.on('table', (top) => emit('table', top));
  p0.on('reward', (r) => emit('reward', r));

  const lot = p0.lot;
  const anchor = new THREE.Vector3(0, Math.min(lot.height * 0.5, 4), 0);

  return {
    kind: 'p0',
    renderer: p0.renderer,
    camera: p0.camera,
    anchor,
    get width() {
      return p0.width;
    },
    get height() {
      return p0.height;
    },
    get pixelRatio() {
      return p0.pixelRatio || 1;
    },
    loop: (fn) => p0.loop(fn),
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    isDown: (code) => p0.input.isDown(code),
    get pointerLocked() {
      return !!p0.input.pointer?.locked;
    },
    lockPointer: () => p0.input.lockPointer(),
    unlockPointer: () => p0.input.unlockPointer(),
    asset: (path) => p0.asset(path),
    loading: (f, label) => p0.loading?.(f, label),
    hud: (text) => p0.hud(text),
    log: (...a) => p0.log(...a),
    sound: {
      play: (path, opts) => p0.sound.play(path, opts),
      stop: (id) => p0.sound.stop(id),
    },
    music: {
      play: (path, opts) => p0.music.play(path, opts),
      stop: () => p0.music.stop(),
      volume: (v) => p0.music.volume?.(v),
      get time() {
        return p0.music.time;
      },
    },
    // Scores: the deepest floor goes to the lot's weekly table.
    score: (n) => p0.score(n),
    get table() {
      return p0.table || [];
    },
    me: () => p0.me,
    exit: () => p0.exit(),
  };
}
