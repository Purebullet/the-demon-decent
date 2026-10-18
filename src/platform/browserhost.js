import * as THREE from 'three';

// The same host interface as p0host.js, for a plain web page: used for local
// development (`npm run dev`) and for hosting the game on its own site.
// Events are normalised to Project 0's shapes ({ code } for keys,
// { x, y, dx, dy, buttons, button, touch } for the pointer).

const SCORE_KEY = 'demonDescent.v1';
const BOARDS_KEY = 'demonDescent.boards.v1';

export function createBrowserHost(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 300);
  const listeners = new Map();
  const keys = new Set();
  const emit = (type, e) => {
    for (const fn of listeners.get(type) || []) fn(e);
  };

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    emit('resize', { width: window.innerWidth, height: window.innerHeight });
  };
  window.addEventListener('resize', resize);
  resize();

  const key = (type) => (e) => {
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    if (type === 'keydown') {
      if (e.repeat) return;
      keys.add(e.code);
    } else keys.delete(e.code);
    emit(type, { code: e.code, key: e.key, repeat: e.repeat });
  };
  window.addEventListener('keydown', key('keydown'));
  window.addEventListener('keyup', key('keyup'));
  window.addEventListener('blur', () => {
    for (const code of [...keys]) emit('keyup', { code });
    keys.clear();
  });
  const pointer = (type) => (e) => {
    const r = canvas.getBoundingClientRect();
    emit(type, { x: e.clientX - r.left, y: e.clientY - r.top, dx: e.movementX || 0, dy: e.movementY || 0, buttons: e.buttons, button: e.button, touch: e.pointerType === 'touch' });
  };
  canvas.addEventListener('pointerdown', pointer('pointerdown'));
  window.addEventListener('pointerup', pointer('pointerup'));
  window.addEventListener('pointermove', pointer('pointermove'));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => emit('pointerlock', { locked: document.pointerLockElement === canvas }));

  // Sound: decode package files once, play them through Web Audio.
  let ctx = null;
  const buffers = new Map();
  const audio = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  const decode = (path) => {
    if (!buffers.has(path)) {
      buffers.set(
        path,
        fetch(path)
          .then((r) => r.arrayBuffer())
          .then((b) => audio().decodeAudioData(b))
          .catch(() => null),
      );
    }
    return buffers.get(path);
  };
  // One music track at a time; a newer play() wins even if an older one is
  // still loading.
  let musicSrc = null;
  let musicTok = 0;
  const stopMusic = () => {
    musicTok++;
    musicSrc?.stop();
    musicSrc = null;
  };
  const playBuffer = async (path, { volume = 1, rate = 1, loop = false } = {}) => {
    const buf = await decode(path);
    if (!buf) return null;
    const c = audio();
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = volume;
    src.connect(g).connect(c.destination);
    src.start();
    src.gain = g;
    src.t0 = c.currentTime;
    return src;
  };

  let best = 0;
  let boards = {};
  try {
    boards = JSON.parse(localStorage.getItem(BOARDS_KEY) || '{}') || {};
  } catch {
    boards = {};
  }
  try {
    best = JSON.parse(localStorage.getItem(SCORE_KEY) || '{}').best || 0;
  } catch {
    // Storage unavailable: the best lives for this page only.
  }

  let last = performance.now();
  const loops = [];
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const fn of loops) fn(dt, now / 1000);
  };
  requestAnimationFrame(frame);

  return {
    kind: 'browser',
    renderer,
    camera,
    anchor: null,
    get width() {
      return window.innerWidth;
    },
    get height() {
      return window.innerHeight;
    },
    get pixelRatio() {
      return renderer.getPixelRatio();
    },
    loop: (fn) => loops.push(fn),
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    isDown: (code) => keys.has(code),
    get pointerLocked() {
      return document.pointerLockElement === canvas;
    },
    lockPointer: () => {
      audio();
      canvas.requestPointerLock?.()?.catch?.(() => {});
    },
    unlockPointer: () => document.exitPointerLock?.(),
    // The game draws its own (sword) cursor: hide the page's while it does.
    setCursor: (own) => {
      canvas.style.cursor = own ? 'none' : '';
    },
    asset: (path) => path,
    loading: () => {},
    hud: () => {},
    log: (...a) => console.log(...a),
    sound: { play: (path, opts) => void playBuffer(path, opts), stop: () => {} },
    music: {
      play: async (path, opts) => {
        stopMusic();
        const tok = musicTok;
        const src = await playBuffer(path, { ...opts, loop: opts?.loop ?? true });
        if (tok === musicTok) musicSrc = src;
        else src?.stop();
      },
      stop: stopMusic,
      volume: (v) => {
        if (musicSrc) musicSrc.gain.gain.value = v;
      },
      get time() {
        return musicSrc ? audio().currentTime - musicSrc.t0 : 0;
      },
    },
    score(n, opts) {
      if (opts?.board) {
        // A named table (the fastest descents): kept in this browser.
        const name = opts.board;
        const prev = boards[name]?.[0]?.score;
        if (prev === undefined || (opts.lower ? n < prev : n > prev)) {
          boards[name] = [{ uid: 'you', name: 'You', score: n, you: true }];
          try {
            localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
          } catch {
            // ignore
          }
        }
        emit('reward', { kind: 'score', ok: true, score: n, best: boards[name][0].score, board: name });
        emit('board', { name, top: boards[name] });
        return;
      }
      if (n > best) {
        best = n;
        try {
          localStorage.setItem(SCORE_KEY, JSON.stringify({ best }));
        } catch {
          // ignore
        }
      }
      emit('reward', { kind: 'score', ok: true, score: n, best });
    },
    get table() {
      return best ? [{ name: 'You', score: best, you: true }] : [];
    },
    get boards() {
      return boards;
    },
    // No prizes outside Project 0: a win is answered as a game without one.
    win() {
      emit('reward', { kind: 'win', ok: false });
    },
    game: null,
    me: () => ({ name: 'You' }),
    exit: () => {},
  };
}
