import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Hurtbox } from '../physics/Hitbox.js';
import { softDotTexture } from '../world/Textures.js';
import { rand } from '../core/rng.js';
import { Strands, Tubes, fleshMaterials, buildHead, TONE_TEAL, TONE_GOLD, TONE_GLOW, PAINT_LIGHT, PAINT_MID, PAINT_DARK, PAINT_BRIGHT } from './WraithBody.js';

// The Grave Wraith: a ghoul with no body at all, only light (WraithBody.js).
// Its flesh is glowing tubes laid afresh every frame, bright at their edges
// and dark and swirling through the middle: a hunched chest flowing down
// into a tail that swings out into a wide whirl and trails behind it as it
// moves, long bony arms bent at the elbow, and hands of five hooked claws.
// Its skull juts forward, a face painted on it (slanted white-hot eyes in
// dark sockets, long fangs, a jaw that drops as it roars), and strands of
// light stream off it all: hair rising off the skull like flame, ribs,
// fibres over its body, tendrils trailing from its arms. Glitter (gold and
// violet in the tail) and a low mist drift off it.
//
// It drifts round you, closing in to strike and hanging back while its
// blows come round again. Its blows:
//
//  - swipe   one arm raised and raked across in front of it.
//  - dive    it drifts back and up as it winds up, rises high, then
//            swoops forward and down through where you stand and out the
//            other side: anyone in its path is struck.
//  - grab    both arms spread wide, then it lunges; if it reaches you (not
//            your guard) it pours into you and is gone: held still for two
//            seconds, chilled by it a little at a time, the edges of your
//            sight full of its wisps (Hud.setGrip). Then it forms again a
//            few paces in front of you.

// How high it floats, how high it climbs before a dive, and how near you
// must come before it notices you.
const HOVER = 0.3;
const DIVE_HEIGHT = 3.8;
const WAKE = 15;
// The share of the dive's strike spent climbing (the rest is the swoop).
const RISE = 0.32;

// Linear colours (additive: the sum glows).
const TEAL = new THREE.Color(0.3, 0.92, 0.82);
const TEAL_HOT = new THREE.Color(0.8, 1.0, 1.0);
const TEAL_DIM = new THREE.Color(0.03, 0.25, 0.25);
const TEAL_DEEP = new THREE.Color(0.0, 0.08, 0.1);
const GOLD = new THREE.Color(1.5, 1.0, 0.35);
const GOLD_DIM = new THREE.Color(0.5, 0.22, 0.04);
const VIOLET = new THREE.Color(0.8, 0.55, 1.3);
const WHITE = new THREE.Color(1, 1, 1);
const MIST = new THREE.Color(0.2, 0.4, 0.4);
const ASH = new THREE.Color(0.01, 0.02, 0.03);
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _t = new THREE.Vector3();
const _h = new THREE.Vector3();
const _f0 = new THREE.Vector3();
const _f1 = new THREE.Vector3();
// Its right claw raised up and back for a swipe.
const SWIPE_UP = new THREE.Vector3(-0.95, 2.6, -0.25);

// Its strands, by what they make of it.
const FIBRE = 0;
const HAIR = 1;
const RIB = 2;
const TENDRIL = 3;
const FRAY = 4;
const LIMB = 5;
// What a fraying wisp grows from (its spine and tail, its shoulders, an
// arm, its skull).
const ON_SPINE = 0;
const ON_YOKE = 1;
const ON_ARM = 2;
const ON_HEAD = 3;
// Its tubes: spine and tail, its shoulders, two arms, two palms, then five
// fingers a hand (the fifth the thumb).
const SPINE = 0;
const YOKE = 1;
const ARM = 2;
const PALM = 4;
const FINGER = 6;
const SPINE_RINGS = 52;
// The share of the spine that is neck and chest (the rest is tail).
const TORSO = 0.26;
// Arm bones (shoulder to elbow, elbow to wrist).
const UPPER = 0.62;
const FORE = 0.58;
// How far back in time its tail and hair can trail (seconds), in steps.
const LAG_STEP = 0.05;
const LAGS = 11;
const HIST = 72;

// One emit record, reused: it sheds hundreds a second, and a fresh object
// for each would be that much garbage.
const E = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 0.1, sizeEnd: 0.03, color: null, colorEnd: null, alpha: 1, drag: 0.5, gravity: 0, turbulence: 0 };
function put(sys, p, vx, vy, vz, life, size, sizeEnd, color, colorEnd, alpha, drag, turbulence) {
  E.x = p.x;
  E.y = p.y;
  E.z = p.z;
  E.vx = vx;
  E.vy = vy;
  E.vz = vz;
  E.life = life;
  E.size = size;
  E.sizeEnd = sizeEnd;
  E.color = color;
  E.colorEnd = colorEnd;
  E.alpha = alpha;
  E.drag = drag;
  E.turbulence = turbulence;
  sys.emit(E);
}

const ease = (k) => k * k * (3 - 2 * k);
const easeOut = (k) => 1 - (1 - k) * (1 - k);
const smooth = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
// Piecewise-linear through knots [[x, y], ...] (x rising).
const knots = (K, x) => {
  if (x <= K[0][0]) return K[0][1];
  for (let i = 1; i < K.length; i++) {
    if (x <= K[i][0]) {
      const f = (x - K[i - 1][0]) / (K[i][0] - K[i - 1][0]);
      return K[i - 1][1] + (K[i][1] - K[i - 1][1]) * ease(f);
    }
  }
  return K[K.length - 1][1];
};
// Its chest's width (side to side) and depth down the neck and chest.
const CHEST_W = [[0, 0.1], [0.2, 0.12], [0.45, 0.36], [0.75, 0.26], [1, 0.225]];
const CHEST_D = [[0, 0.1], [0.2, 0.12], [0.45, 0.25], [0.75, 0.19], [1, 0.21]];
// Catmull-Rom through four values.
const cr = (a, b, c, d, f) => {
  const f2 = f * f;
  return 0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (3 * b - a - 3 * c + d) * f2 * f);
};

export const WRAITH_TYPE = {
  name: 'Grave Wraith',
  hp: 140,
  dmg: 10,
  speed: 3.6,
  radius: 0.45,
  poise: 40,
  mass: 0.8,
  role: 'swarmer',
  cooldown: 1.2,
  turnRate: 7,
  stride: 2,
  loot: { potion: 0, weapon: 0, spell: 0 },
  // Struck, it bleeds light, not blood.
  ichor: { color: TEAL_HOT, end: TEAL_DIM },
  buildModel: buildBody,
  attacks: [
    { name: 'swipe', windup: 0.42, strike: 0.2, recover: 0.55, dmg: 1, minRange: 0, maxRange: 2.7, volume: { c: [0, 1.5, 1.05], h: [1.1, 0.8, 0.95] }, lunge: 2.5, knockback: 3, weight: 1.6 },
    { name: 'dive', windup: 0.85, strike: 1.35, recover: 0.7, dmg: 1.4, minRange: 3, maxRange: 9.5, volume: null, knockback: 7, rest: 4, weight: 1.3 },
    { name: 'grab', windup: 0.8, strike: 0.3, recover: 0.6, dmg: 0.2, minRange: 0, maxRange: 4.2, volume: { c: [0, 1.5, 1.0], h: [0.8, 0.85, 1.0] }, lunge: 9, knockback: 0, latch: { dur: 2, dps: 0.4 }, rest: 8, weight: 1 },
  ],
};

// Each of its strands, with what shapes it (Wraith._strands). Most weave
// (`f1`, `f2`, `p1`, `p2`), so none run straight alongside the next; the
// glow strands are wide, faint and soft, its haze.
function strandSpecs() {
  const r = Math.random;
  const S = [];
  const weave = () => ({ f1: rand(3, 7), f2: rand(5, 11), p1: r() * 6.3, p2: r() * 6.3 });
  // Fibres over its body, down into the tail; some come away near its end.
  for (let j = 0; j < 16; j++) S.push({ kind: FIBRE, n: 34, w0: rand(0.01, 0.018), w1: 0.003, a: rand(0.15, 0.35), tone: r() < 0.3 ? TONE_GOLD : TONE_TEAL, seed: r(), phi: r() * Math.PI * 2, k: rand(0.92, 1.25), twist: rand(1.5, 3.2), peel: r() < 0.4 ? rand(0.1, 0.45) : 0, ...weave() });
  for (let j = 0; j < 4; j++) S.push({ kind: FIBRE, n: 24, w0: rand(0.24, 0.32), w1: 0.06, a: 0.06, tone: TONE_GLOW, seed: r(), phi: r() * Math.PI * 2, k: rand(0.2, 0.5), twist: 2, peel: 0, ...weave() });
  // Hair, off the crown and the back of the skull, streaming up and back.
  for (let j = 0; j < 18; j++) S.push({ kind: HAIR, n: 20, w0: rand(0.01, 0.02), w1: 0.003, a: rand(0.2, 0.45), tone: r() < 0.12 ? TONE_GOLD : TONE_TEAL, seed: r(), lat: rand(-1, 1), up: rand(0.1, 0.9), back: rand(0.3, 1), len: rand(0.5, 1.15), ...weave() });
  for (let j = 0; j < 2; j++) S.push({ kind: HAIR, n: 14, w0: 0.26, w1: 0.06, a: 0.06, tone: TONE_GLOW, seed: r(), lat: rand(-0.6, 0.6), up: 0.5, back: 0.7, len: 0.9, ...weave() });
  // Ribs.
  for (const side of [1, -1]) for (let row = 0; row < 4; row++) S.push({ kind: RIB, side, row, n: 10, w0: 0.02, w1: 0.01, a: 0.3, tone: TONE_TEAL, seed: r() });
  // Wisps fraying off it everywhere, so no edge of it is a clean line: off
  // its body and tail, its shoulders, its arms and its skull.
  const fray = (on, extra, n) => {
    for (let j = 0; j < n; j++) S.push({ kind: FRAY, on, n: 6, w0: rand(0.01, 0.018), w1: 0.002, a: rand(0.2, 0.45), tone: r() < 0.1 ? TONE_GOLD : TONE_TEAL, seed: r(), s: 0.03 + 0.94 * r(), ang: r() * Math.PI * 2, len: rand(0.1, 0.28), ...weave(), ...extra() });
  };
  fray(ON_SPINE, () => ({}), 90);
  fray(ON_YOKE, () => ({}), 10);
  fray(ON_ARM, () => ({ hand: 0, len: rand(0.08, 0.2) }), 18);
  fray(ON_ARM, () => ({ hand: 1, len: rand(0.08, 0.2) }), 18);
  fray(ON_HEAD, () => {
    // (Over its crown, sides and back, not its face.)
    let x;
    let y;
    let z;
    do {
      x = rand(-1, 1);
      y = rand(-0.5, 1);
      z = rand(-1, 0.6);
    } while (Math.hypot(x, y, z) > 1 || Math.hypot(x, y, z) < 0.3 || (z > 0.2 && y < 0.5));
    const l = Math.hypot(x, y, z);
    return { dx: x / l, dy: y / l, dz: z / l };
  }, 20);
  // A few strands of light along its arms and over its shoulders.
  for (const hand of [0, 1]) for (let j = 0; j < 5; j++) S.push({ kind: LIMB, hand, n: 22, w0: rand(0.008, 0.014), w1: 0.004, a: rand(0.25, 0.5), tone: r() < 0.25 ? TONE_GOLD : TONE_TEAL, seed: r(), phi: r() * Math.PI * 2, k: rand(0.55, 1.3), twist: rand(-1.2, 1.2), ...weave() });
  // Tendrils trailing from the arms.
  for (const hand of [0, 1]) {
    const side = hand === 0 ? 1 : -1;
    for (let j = 0; j < 4; j++) S.push({ kind: TENDRIL, hand, side, at: 0.2 + j * 0.2, n: 16, w0: rand(0.01, 0.018), w1: 0.003, a: rand(0.2, 0.45), tone: r() < 0.3 ? TONE_GOLD : TONE_TEAL, seed: r(), len: rand(0.6, 1.3), out: rand(0.5, 1), up: rand(0.0, 0.7), back: rand(0.4, 1), curl: rand(0.15, 0.45), ...weave() });
  }
  return S;
}

// Its paint (Wraith._layBrush): wide brush strokes, the bulk of how it
// looks. Some run along its body and swirl down its tail (dark navy ones
// deep in it, teal ones over them, their ends peeling away), some along its
// arms and streaming back off them, its hair sweeping back over its crown,
// and its claws.
const BB_BODY = 0;
const BB_ARM = 1;
const BB_STREAM = 2;
const BB_HAIR = 3;
const BB_CLAW = 4;
const BB_YOKE = 5;
const BB_RIB = 6;
// About how thick its body is at `s` along its spine (for its strokes).
const thickAt = (s) => (s < TORSO ? 0.2 + 0.12 * Math.sin((Math.PI * s) / TORSO) : 0.215 * Math.pow(1 - (s - TORSO) / (1 - TORSO), 0.85) + 0.015);
function brushSpecs() {
  const r = Math.random;
  const B = [];
  const paint = (dark) => {
    const x = r();
    return x < dark ? PAINT_DARK : x < dark + (1 - dark) * 0.5 ? PAINT_MID : x < 0.96 ? PAINT_LIGHT : PAINT_BRIGHT;
  };
  for (let j = 0; j < 110; j++) {
    const s0 = Math.pow(r(), 0.8) * 0.9;
    const span = rand(0.12, 0.4);
    const k = rand(0.2, 1.15);
    const w = Math.min(0.22, Math.max(0.04, 0.75 * thickAt(Math.min(0.99, s0 + span / 2)) + 0.025)) * rand(0.75, 1.2);
    B.push({ kind: BB_BODY, n: 14, w0: w, w1: 0.004, a: rand(0.4, 0.75), tone: paint(k < 0.6 ? 0.55 : 0.12), seed: r(), rep: 1 + span * 4, s0, span, phi: r() * Math.PI * 2, twist: rand(-1.8, 1.8), k, peel: r() < 0.5 ? rand(0.1, 0.45) : 0 });
  }
  // Its neck and chest, gaunt, and its ribs across it.
  for (let j = 0; j < 46; j++) {
    const k = rand(0.45, 1.12);
    B.push({ kind: BB_BODY, n: 12, w0: rand(0.05, 0.1), w1: 0.004, a: rand(0.4, 0.75), tone: paint(k < 0.7 ? 0.4 : 0.1), seed: r(), rep: 1.5, s0: r() * 0.18, span: rand(0.08, 0.22), phi: r() * Math.PI * 2, twist: rand(-1.2, 1.2), k, peel: r() < 0.3 ? rand(0.05, 0.2) : 0 });
  }
  for (const side of [1, -1]) for (let row = 0; row < 5; row++) B.push({ kind: BB_RIB, side, row, n: 10, w0: rand(0.03, 0.045), w1: 0.004, a: rand(0.55, 0.85), tone: r() < 0.5 ? PAINT_LIGHT : PAINT_BRIGHT, seed: r(), rep: 1, fadeIn: false });
  for (const hand of [0, 1]) {
    const side = hand === 0 ? 1 : -1;
    for (let j = 0; j < 22; j++) {
      const s0 = r() * 0.6;
      B.push({ kind: BB_ARM, hand, n: 12, w0: rand(0.05, 0.09), w1: 0.004, a: rand(0.6, 0.9), tone: paint(0.15), seed: r(), rep: 2, s0, span: rand(0.35, 1 - s0), phi: r() * Math.PI * 2, twist: rand(-1.2, 1.2), k: rand(0.3, 1.2) });
    }
    for (let j = 0; j < 10; j++) B.push({ kind: BB_STREAM, hand, side, at: 0.1 + j * 0.09, n: 16, w0: rand(0.03, 0.055), w1: 0.002, a: rand(0.35, 0.65), tone: paint(0.1), seed: r(), rep: 3, len: rand(0.5, 1.3), out: rand(0.4, 1), up: rand(0.1, 0.8), back: rand(0.5, 1), curl: rand(0.1, 0.4), f1: rand(3, 6), f2: rand(4, 8), p1: r() * 6.3, p2: r() * 6.3 });
    for (let f = 0; f < 5; f++) B.push({ kind: BB_CLAW, hand, f, n: 7, w0: 0.032, w1: 0.006, a: 0.95, tone: PAINT_BRIGHT, seed: r(), rep: 0.6, fadeIn: false });
  }
  for (let j = 0; j < 12; j++) B.push({ kind: BB_YOKE, n: 10, w0: rand(0.06, 0.1), w1: 0.004, a: rand(0.6, 0.9), tone: paint(0.2), seed: r(), rep: 2, s0: r() * 0.5, span: rand(0.4, 0.6), phi: r() * Math.PI * 2, twist: rand(-1, 1), k: rand(0.4, 1.2) });
  // Hair: over the crown from above the brow and back off it, and from the
  // sides of the skull.
  for (let j = 0; j < 34; j++) B.push({ kind: BB_HAIR, n: 16, w0: rand(0.04, 0.075), w1: 0.003, a: rand(0.45, 0.85), tone: paint(0.12), seed: r(), rep: 2.5, lat: rand(-1, 1), th0: rand(0.35, 1.3), len: rand(0.45, 1.1), up: rand(0.15, 0.8), f1: rand(3, 6), f2: rand(4, 8), p1: r() * 6.3, p2: r() * 6.3 });
  return B;
}

// Its tubes (see SPINE and the rest).
function tubeSpecs() {
  // (Its shoulders and arms are mostly strands: their flesh is faint.)
  const T = [{ rings: SPINE_RINGS, sides: 14, len: 4, wob: 0.2, fur: 1 }, { rings: 11, sides: 10, len: 0.9, wob: 0.14, fur: 1, solid: 0.45 }];
  for (let h = 0; h < 2; h++) T.push({ rings: 22, sides: 9, len: 1.2, wob: 0.26, fur: 0.8, solid: 0.4 });
  for (let h = 0; h < 2; h++) T.push({ rings: 4, sides: 8, len: 0.12 });
  for (let h = 0; h < 2; h++) for (let f = 0; f < 5; f++) T.push({ rings: 7, sides: 6, len: 0.25, tip: 0.9 });
  return T;
}

// Its "model": the flesh (tubes and skull), the strands, its eyes (a glow
// over each painted eye) and a hurtbox round its chest and head.
function buildBody() {
  const root = new THREE.Group();
  const mats = fleshMaterials();
  const tubes = new Tubes(tubeSpecs(), mats);
  const strands = new Strands(strandSpecs());
  const brush = new Strands(brushSpecs(), { brush: true, share: strands.material.uniforms });
  const head = buildHead(mats);
  // (Its glowing shells are not drawn: they gave it glassy edges. Its paint
  // and the dark through its middle are its body now.)
  root.add(tubes.core, brush.mesh, strands.mesh, head.group);
  const eyes = [];
  const glows = [];
  for (const s of [1, -1]) {
    const sprite = (color) => new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
    const core = sprite(0xffffff);
    core.position.set(s * 0.054, 0.004, 0.19);
    core.scale.set(0.07, 0.04, 1);
    core.material.rotation = -s * 0.32;
    const glow = sprite(0x2a8cb0);
    glow.position.set(s * 0.054, 0.004, 0.185);
    glow.scale.setScalar(0.17);
    for (const sp of [glow, core]) sp.renderOrder = 13;
    head.group.add(glow, core);
    eyes.push(core);
    glows.push(glow);
  }
  const hurt = new Hurtbox(root, new THREE.Vector3(0, 1.8, 0.12), new THREE.Vector3(0.42, 0.62, 0.42), { name: 'body' });
  // (`mats` and the rest are what Enemy looks for on a model: it has none.)
  return { root, flesh: mats, tubes, strands, brush, head, eyes, glows, mats: [], meshes: [], fire: [], bones: [], hurtboxes: [hurt], hitRadius: 0.9, height: 2.4, canRagdoll: false, ownDeath: false, j: {}, animate() {} };
}

export class Wraith extends Enemy {
  constructor(spawn, tuning) {
    super('wraith', spawn, tuning, WRAITH_TYPE);
    this.lift = HOVER;
    this.liftTo = HOVER;
    // Where its claws are (its own space), eased toward where they should be.
    this.hands = [new THREE.Vector3(0.62, 1.55, 0.85), new THREE.Vector3(-0.66, 1.75, 0.8)];
    // How its fingers are curled (0 open, 1 clutching) and spread.
    this.curl = [0.5, 0.5];
    this.spread = [1, 1];
    // Its head: how far forward, its tilt, and its jaw.
    this.headZ = 0;
    this.headPitch = 0.16;
    this.jawOpen = 0.12;
    this.acc = {};
    this.prev = new THREE.Vector3().copy(this.position);
    this.drift = new THREE.Vector3();
    this.gripK = 0;
    this.fade = 1;
    this.dive = null;
    this.t = 0;
    this._cy = 1;
    this._sy = 0;
    this._dlx = 0;
    this._dlz = 0;
    this.tubes = this.model.tubes;
    this.strands = this.model.strands;
    this.brush = this.model.brush;
    this.head = this.model.head;
    // Where it has been (time, x, y, z, facing), for what trails behind.
    this.hist = new Float32Array(HIST * 5);
    this.histN = 0;
    this.histI = 0;
    // How far behind (its own space) each step back in time leaves a
    // strand, and how far it has turned since.
    this.lagX = new Float32Array(LAGS);
    this.lagY = new Float32Array(LAGS);
    this.lagZ = new Float32Array(LAGS);
    this.lagC = new Float32Array(LAGS).fill(1);
    this.lagS = new Float32Array(LAGS);
    // Each arm: shoulder, elbow, wrist, the way the hand points, across it
    // and up from its back (its own space, before trailing).
    this._A = [new Float32Array(18), new Float32Array(18)];
    // The ends its wisps peel off, and which strands carry gold.
    this.tips = [];
    this.tones = new Uint8Array(this.strands.count);
    for (const sp of this.strands.specs) {
      const last = sp.start + sp.n - 1;
      if ((sp.kind === HAIR || sp.kind === TENDRIL || sp.kind === FIBRE) && sp.tone !== TONE_GLOW) this.tips.push(last);
      this.tones.fill(sp.tone, sp.start, last + 1);
    }
    // The last ring of each finger: its claw tip.
    this.clawTips = [];
    for (let f = 0; f < 10; f++) {
      const s = this.tubes.specs[FINGER + f];
      this.clawTips.push(s.ring0 + s.rings - 1);
    }
  }

  // Taken off the field: its buffers go with it.
  dispose() {
    this.strands.dispose();
    this.brush.dispose();
    this.tubes.dispose();
    this.head.sphere.dispose();
  }

  // ---------------------------------------------------------- behaviour ---

  update(dt, ctx) {
    const p = ctx.player;
    // It sees you coming from well off (it hangs in the open, glowing).
    if (this.state === 'dormant' && this.alive && !p.dead && Math.hypot(p.position.x - this.position.x, p.position.z - this.position.z) < WAKE) this.becomeAlert(ctx);
    super.update(dt, ctx);
    if (!this.alive) return;
    const a = this.attack;
    if (this.state === 'windup' && a) {
      const k = Math.min(1, this.stateT / Math.max(1e-3, this.stateDur));
      if (a.name === 'dive') {
        // Draws back and up, gathering itself.
        this.position.x -= Math.sin(this.yaw) * 2.4 * dt;
        this.position.z -= Math.cos(this.yaw) * 2.4 * dt;
        this.liftTo = HOVER + 0.8 * k;
      } else if (a.name === 'grab') this.liftTo = HOVER + 0.3 * k;
      else this.liftTo = HOVER;
    } else if (this.state !== 'strike') this.liftTo = HOVER;
  }

  // It flies: straight at you to strike, hanging back and circling while
  // its blows come round (no paths: walls and stones are nothing to it).
  _locomote(dt, ctx, dist) {
    const p = ctx.player.position;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    const l = Math.hypot(dx, dz) || 1;
    const ux = dx / l;
    const uz = dz / l;
    const ready = this.cooldown <= 0.3;
    const want = ready ? 1.7 : 4.4;
    const radial = THREE.MathUtils.clamp((dist - want) * 1.4, -1, 1);
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeSide *= -1;
      this.strafeT = rand(1.4, 2.8);
    }
    const side = (ready ? 0.2 : 0.6) * this.strafeSide;
    const sp = this.speed;
    const vx = (ux * radial - uz * side) * sp;
    const vz = (uz * radial + ux * side) * sp;
    const k = Math.min(1, dt * 3);
    this.vel.x += (vx - this.vel.x) * k;
    this.vel.z += (vz - this.vel.z) * k;
    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.z * dt;
    this._turnToward(Math.atan2(dx, dz), dt, this.type.turnRate);
    this.moveBlend = Math.min(1, Math.hypot(this.vel.x, this.vel.z) / sp);
  }

  _beginStrike(ctx) {
    const a = this.attack;
    if (a?.name !== 'dive') {
      super._beginStrike(ctx);
      return;
    }
    this.setState('strike', a.strike);
    this.dive = { from: this.position.clone(), to: new THREE.Vector3(), lift0: this.lift, aimed: false, hitAt: 0.6 };
    ctx.audio?.enemySwing(this.typeKey, this.position);
  }

  _updateStrike(dt, ctx) {
    const a = this.attack;
    if (a?.name !== 'dive') {
      super._updateStrike(dt, ctx);
      return;
    }
    const D = this.dive;
    const p = ctx.player;
    const k = Math.min(1, this.stateT / Math.max(1e-3, this.stateDur));
    if (k < RISE) {
      // Up into the air, keeping you in its sights.
      this.lift = D.lift0 + (DIVE_HEIGHT - D.lift0) * easeOut(k / RISE);
      this._turnToward(Math.atan2(p.position.x - this.position.x, p.position.z - this.position.z), dt, 8);
    } else {
      if (!D.aimed) {
        // Then down at where you are, and on past it.
        D.aimed = true;
        D.from.copy(this.position);
        const dx = p.position.x - this.position.x;
        const dz = p.position.z - this.position.z;
        const l = Math.hypot(dx, dz) || 1;
        const over = 2.6;
        D.to.set(p.position.x + (dx / l) * over, 0, p.position.z + (dz / l) * over);
        D.hitAt = l / (l + over);
        this.yaw = Math.atan2(dx, dz);
        ctx.audio?.whoosh?.(this.position);
      }
      const s = (k - RISE) / (1 - RISE);
      const e = s * s * (2 - s);
      this.position.x = D.from.x + (D.to.x - D.from.x) * e;
      this.position.z = D.from.z + (D.to.z - D.from.z) * e;
      // Down to chest height at you, then skimming up a little past.
      this.lift = e < D.hitAt ? DIVE_HEIGHT + (0.05 - DIVE_HEIGHT) * Math.pow(e / D.hitAt, 0.85) : 0.05 + 0.6 * ((e - D.hitAt) / Math.max(1e-3, 1 - D.hitAt));
      this.moveBlend = 1;
      if (!this.hitPlayer && !p.dead) {
        const d = Math.hypot(this.position.x - p.position.x, this.lift + 1.4 - (p.position.y + 1.1), this.position.z - p.position.z);
        if (d < 1.35) {
          this.hitPlayer = true;
          const landed = p.takeDamage(this.damage * a.dmg, this.position, a.knockback, ctx, this);
          // (Parried: thrown back, the dive is over.)
          if (this.state !== 'strike') return;
          if (landed === true) ctx.shake?.(0.35);
        }
      }
    }
    if (this.stateT >= this.stateDur) this.setState('recover', a.recover * Math.sqrt(this.tuning.windup));
  }

  // Its grab found you: it pours into you and is gone, holding you still.
  _latch(ctx, a) {
    const p = ctx.player;
    this.setState('latched', a.latch.dur);
    this.latchedOn = p;
    this.latchTick = 0.25;
    this.latchN = 0;
    p.pin(this, { still: true });
    this.hidden = true;
    for (const h of this.hurtboxes) h.obb.center.set(0, -999, 0);
    ctx.shake?.(0.3);
    ctx.audio?.telegraph?.(this.typeKey, this.position);
    // A rush of it into you.
    for (let i = 0; i < 90; i++) {
      const ang = rand(0, Math.PI * 2);
      const r = rand(0.8, 1.8);
      _p.set(p.position.x + Math.cos(ang) * r, rand(0.6, 2.4), p.position.z + Math.sin(ang) * r);
      put(ctx.fx.add, _p, -Math.cos(ang) * r * 2, 0, -Math.sin(ang) * r * 2, rand(0.3, 0.6), rand(0.04, 0.07), 0.015, Math.random() < 0.25 ? GOLD : TEAL_HOT, TEAL_DIM, 1, 1.5, 0);
    }
  }

  _updateLatch(dt, ctx) {
    const p = ctx.player;
    const a = this.attack;
    if (!a?.latch || p.dead || p.pinned?.by !== this) {
      this._reform(ctx, p);
      return;
    }
    this.position.set(p.position.x, 0, p.position.z);
    this.latchTick -= dt;
    if (this.latchTick <= 0) {
      this.latchTick = 0.3;
      // A cold seeping in: no blood, and a cry only now and then.
      p.maul(this.damage * a.latch.dps * 0.3, this.position, ctx, { chill: true, quiet: this.latchN++ % 3 !== 0 });
    }
    if (this.stateT >= this.stateDur) this._reform(ctx, p);
  }

  // Out of you again, a few paces in front, facing you.
  _reform(ctx, p) {
    this.hidden = false;
    this.position.set(p.position.x - Math.sin(p.yaw) * 2.6, 0, p.position.z - Math.cos(p.yaw) * 2.6);
    this.yaw = Math.atan2(p.position.x - this.position.x, p.position.z - this.position.z);
    this.vel.set(0, 0, 0);
    this.prev.copy(this.position);
    this.lift = HOVER;
    // (Nothing of where it was trails after it.)
    this.histN = 0;
    this.setState('recover', 0.9);
    for (let i = 0; i < 90; i++) {
      const ang = rand(0, Math.PI * 2);
      _p.set(this.position.x, rand(0.6, 2.4), this.position.z);
      put(ctx.fx.add, _p, Math.cos(ang) * rand(1, 3), rand(-0.5, 1), Math.sin(ang) * rand(1, 3), rand(0.3, 0.7), rand(0.04, 0.07), 0.015, Math.random() < 0.25 ? GOLD : TEAL_HOT, TEAL_DIM, 1, 2, 0);
    }
  }

  // Struck down: it comes apart into the air (no body, no blood).
  die(ctx) {
    this.alive = false;
    this.health = 0;
    this.status = {};
    this.hidden = false;
    ctx.director?.releaseToken(this);
    ctx.pathService?.cancel?.(this);
    this.attack = null;
    this.setState('dying', 1.6);
    // A burst of its glitter (its strands come apart as it fades: _shape).
    for (let i = 0; i < 220; i++) {
      this._at((Math.random() * this.strands.count) | 0, _p);
      put(ctx.fx.add, _p, rand(-2.5, 2.5), rand(0, 2.5), rand(-2.5, 2.5), rand(0.6, 1.4), rand(0.03, 0.06), 0.01, Math.random() < 0.3 ? GOLD : TEAL_HOT, TEAL_DEEP, 1, 1.2, 3);
    }
    ctx.audio?.death(this.typeKey, this.position);
    ctx.audio?.kill?.();
    ctx.shake?.(0.3);
    ctx.hitStop?.(0.08);
    ctx.onEnemyKilled?.(this);
  }

  _updateDying() {
    this.fade = Math.max(0, 1 - this.stateT / this.stateDur);
    if (this.stateT >= this.stateDur) this.removed = true;
  }

  // ------------------------------------------------------------- looks ---

  postUpdate(dt, ctx, time) {
    if (this.removed) return;
    if (!(this.state === 'strike' && this.attack?.name === 'dive')) this.lift += (this.liftTo - this.lift) * Math.min(1, dt * 4);
    this.root.position.y = this.lift + Math.sin(time * 1.7 + this.seed) * 0.08;
    this.root.rotation.y = this.yaw;
    this.drift.subVectors(this.position, this.prev).divideScalar(Math.max(1e-3, dt));
    this.prev.copy(this.position);
    this._cy = Math.cos(this.yaw);
    this._sy = Math.sin(this.yaw);
    this.t = time;
    this._pose(dt, time);
    this._record(time);
    const M = this.model;
    const shown = !this.hidden && this.fade > 0.01;
    M.tubes.core.visible = M.strands.mesh.visible = M.brush.mesh.visible = M.head.group.visible = shown;
    // (It is laid out only while it can be seen: in front of you, or near
    // enough that some of it might be.)
    const pl = ctx.player;
    const dx = this.position.x - pl.position.x;
    const dz = this.position.z - pl.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const seen = d < 6 || -(Math.sin(pl.yaw) * dx + Math.cos(pl.yaw) * dz) / d > 0.1;
    if (shown && seen) {
      this._lags(time);
      this._layHead(time);
      this._layTubes(time);
      this._layStrands(time);
      this._layBrush(time);
      M.tubes.commit();
      M.strands.commit();
      M.brush.commit();
    }
    // Brighter and whiter as it gathers a blow, or is struck.
    const wind = this.state === 'windup' ? Math.min(1, this.stateT / Math.max(1e-3, this.stateDur)) : 0;
    const heat = Math.min(0.6, wind * 0.35 + this.flash * 0.6);
    const F = M.flesh.shell.uniforms;
    const U = M.strands.material.uniforms;
    F.uTime.value = U.uTime.value = time;
    F.uFade.value = U.uFade.value = this.fade;
    F.uHeat.value = U.uHeat.value = heat;
    // (Drawn to the same scale and fog as the particles.)
    const fu = ctx.fx.add.material.uniforms;
    U.uPixel.value = 1 / Math.max(1, fu.uScale.value);
    F.uFogDensity.value = U.uFogDensity.value = fu.uFogDensity.value;
    for (const m of [M.head.face, M.head.jawCard, M.head.mouth, M.head.profile, M.head.jawProfileCard]) {
      m.material.uniforms.uFade.value = this.fade;
      m.material.uniforms.uHeat.value = heat;
    }
    this._emit(dt, ctx, time);
    // Its eyes, white-hot as it winds up a blow; gone with it.
    const eye = (1.1 + wind * 1.4 + this.flash * 1.2) * this.fade;
    for (let i = 0; i < 2; i++) {
      const core = M.eyes[i];
      const glow = M.glows[i];
      core.material.color.setRGB(0.85 * eye, eye, eye);
      glow.material.color.setRGB(0.14 * eye, 0.5 * eye, 0.68 * eye);
      glow.scale.setScalar(0.16 + 0.1 * wind);
    }
    this.root.updateMatrixWorld(true);
    if (this.alive && !this.hidden) for (const h of this.hurtboxes) h.update();
    this.gripK += ((this.state === 'latched' ? 1 : 0) - this.gripK) * Math.min(1, dt * (this.state === 'latched' ? 7 : 2.5));
  }

  // Where its claws should be, how its fingers curl, and its head and jaw,
  // by what it is doing (its own space: x to its left, y up, z ahead).
  _pose(dt, t) {
    const a = this.attack;
    const st = this.state;
    const k = this.stateDur > 0 ? Math.min(1, this.stateT / this.stateDur) : 0;
    const sway = Math.sin(t * 2.1 + this.seed) * 0.06;
    // At rest: hunched, arms reaching for you, one higher, claws twitching.
    const L = _p.set(0.62, 1.55 + sway, 0.85);
    const R = _q.set(-0.66, 1.75 - sway, 0.8);
    let rate = 9;
    let cL = 0.55 + 0.15 * Math.sin(t * 1.3 + this.seed);
    let cR = 0.55 + 0.15 * Math.sin(t * 1.1 + 2);
    let spread = 1;
    let headZ = 0;
    let pitch = 0.16;
    let jaw = 0.1 + 0.05 * Math.sin(t * 1.7);
    if (a && (st === 'windup' || st === 'strike')) {
      if (a.name === 'swipe') {
        // One arm (its right) drawn up and back, then raked across.
        if (st === 'windup') {
          R.lerp(SWIPE_UP, ease(k));
          cR = 0.3;
          spread = 1.3;
          headZ = -0.04;
          pitch = 0.04;
          jaw = 0.2 + 0.35 * k;
        } else {
          R.set(-1.0 + 1.7 * ease(k), 2.55 - 1.25 * ease(k), -0.35 + 1.5 * Math.sin(Math.PI * Math.min(1, k * 1.2)));
          cR = 0.95;
          headZ = 0.1;
          jaw = 0.45;
          rate = 30;
        }
      } else if (a.name === 'dive') {
        if (st === 'windup' || k < RISE) {
          // Swept back as it gathers itself and climbs, roaring.
          L.set(0.8, 2.3, -0.75);
          R.set(-0.8, 2.3, -0.75);
          cL = cR = 0.6;
          pitch = -0.15;
          jaw = 0.6;
        } else {
          // Reaching ahead as it swoops, claws open.
          L.set(0.45, 1.75, 1.25);
          R.set(-0.45, 1.75, 1.25);
          cL = cR = 0.2;
          spread = 1.4;
          headZ = 0.12;
          pitch = 0.3;
          jaw = 0.65;
          rate = 20;
        }
      } else if (a.name === 'grab') {
        if (st === 'windup') {
          // Arms flung wide and up, claws spread, a long roar.
          L.set(1.35, 2.45, 0.15);
          R.set(-1.35, 2.45, 0.15);
          cL = cR = 0.12;
          spread = 1.5;
          headZ = -0.08;
          pitch = -0.12;
          jaw = 0.25 + 0.5 * k;
        } else {
          L.set(0.32, 1.85, 1.5);
          R.set(-0.32, 1.85, 1.5);
          cL = cR = 1.3;
          headZ = 0.15;
          jaw = 0.45;
          rate = 30;
        }
      }
    } else if (st === 'stagger') {
      L.set(0.8, 2.2, -0.5);
      R.set(-0.8, 2.2, -0.5);
      cL = cR = 0.8;
      headZ = -0.08;
      pitch = -0.2;
      jaw = 0.4;
      rate = 14;
    }
    const f = Math.min(1, dt * rate);
    this.hands[0].lerp(L, f);
    this.hands[1].lerp(R, f);
    const g = Math.min(1, dt * 10);
    this.curl[0] += (cL - this.curl[0]) * g;
    this.curl[1] += (cR - this.curl[1]) * g;
    this.spread[0] += (spread - this.spread[0]) * g;
    this.spread[1] += (spread - this.spread[1]) * g;
    const h = Math.min(1, dt * 8);
    this.headZ += (headZ - this.headZ) * h;
    this.headPitch += (pitch - this.headPitch) * h;
    this.jawOpen += (jaw - this.jawOpen) * Math.min(1, dt * 12);
  }

  // A point of it in the world: its own space (x left, y up, z ahead).
  _w(lx, ly, lz, out) {
    out.x = this.position.x + lx * this._cy + lz * this._sy;
    out.y = this.root.position.y + ly;
    out.z = this.position.z - lx * this._sy + lz * this._cy;
    return out;
  }

  // Strand point `k`, in the world.
  _at(k, out) {
    const p = this.strands.pts;
    return this._w(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], out);
  }

  // Somewhere on the surface of its spine and tail (`s0` and on, 0 the neck
  // and 1 the tail's tip), `k` times out, in the world.
  _onBody(s0, k, out) {
    const T = this.tubes;
    const s = s0 + (1 - s0) * Math.sqrt(Math.random());
    T.surface(T.specs[SPINE].ring0 + Math.round(s * (SPINE_RINGS - 1)), Math.random() * Math.PI * 2, k, out);
    this._w(out.x, out.y, out.z, out);
    return s;
  }

  // ------------------------------------------------- what trails behind ---

  // Where it has been (a sample every sixtieth of a second at most).
  _record(time) {
    const H = this.hist;
    if (this.histN && time - H[((this.histI - 1 + HIST) % HIST) * 5] < 0.015) return;
    const i = this.histI * 5;
    H[i] = time;
    H[i + 1] = this.position.x;
    H[i + 2] = this.root.position.y;
    H[i + 3] = this.position.z;
    H[i + 4] = this.yaw;
    this.histI = (this.histI + 1) % HIST;
    this.histN = Math.min(HIST, this.histN + 1);
  }

  // For each step back in time: where it was then, from where it is now
  // (in its own space, at most 3 m), and how far it has turned since.
  _lags(time) {
    const H = this.hist;
    const n = this.histN;
    const at = (j) => ((this.histI - 1 - j + HIST * 2) % HIST) * 5;
    let j = 0;
    for (let k = 0; k < LAGS; k++) {
      let ox = 0;
      let oy = 0;
      let oz = 0;
      let d = 0;
      if (k > 0 && n > 1) {
        const target = time - k * LAG_STEP;
        while (j < n - 1 && H[at(j)] > target) j++;
        const a = at(j);
        let hx = H[a + 1];
        let hy = H[a + 2];
        let hz = H[a + 3];
        let hyaw = H[a + 4];
        if (j > 0 && H[a] < target) {
          const b = at(j - 1);
          const w = (target - H[a]) / Math.max(1e-6, H[b] - H[a]);
          hx += (H[b + 1] - hx) * w;
          hy += (H[b + 2] - hy) * w;
          hz += (H[b + 3] - hz) * w;
          const dy = H[b + 4] - hyaw;
          hyaw += Math.atan2(Math.sin(dy), Math.cos(dy)) * w;
        }
        ox = hx - this.position.x;
        oy = hy - this.root.position.y;
        oz = hz - this.position.z;
        const l = Math.hypot(ox, oy, oz);
        if (l > 3) {
          ox *= 3 / l;
          oy *= 3 / l;
          oz *= 3 / l;
        }
        d = hyaw - this.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d)) * 0.85;
      }
      this.lagX[k] = ox * this._cy - oz * this._sy;
      this.lagY[k] = oy;
      this.lagZ[k] = ox * this._sy + oz * this._cy;
      this.lagC[k] = Math.cos(d);
      this.lagS[k] = Math.sin(d);
    }
  }

  // (x, y, z) of it as it was `L` seconds ago, where that is now, in `out`.
  _lag(x, y, z, L, out) {
    const f = Math.min(LAGS - 1.0001, Math.max(0, L / LAG_STEP));
    const k = f | 0;
    const w = f - k;
    const c = this.lagC[k] + (this.lagC[k + 1] - this.lagC[k]) * w;
    const s = this.lagS[k] + (this.lagS[k + 1] - this.lagS[k]) * w;
    return out.set(
      x * c + z * s + this.lagX[k] + (this.lagX[k + 1] - this.lagX[k]) * w,
      y + this.lagY[k] + (this.lagY[k + 1] - this.lagY[k]) * w,
      -x * s + z * c + this.lagZ[k] + (this.lagZ[k + 1] - this.lagZ[k]) * w,
    );
  }

  // Lays strand point `i` at (x, y, z) of it as it was `L` seconds ago.
  _place(i, x, y, z, L) {
    this._lag(x, y, z, L, _t);
    this.strands.set(i, _t.x, _t.y, _t.z);
  }

  // ----------------------------------------------------------- its body ---

  // Its head: thrust forward, tilted to look down at you (or thrown back
  // to roar), swaying; the jaw drops as it opens its mouth.
  _layHead(t) {
    const H = this.head;
    const g = H.group;
    g.scale.setScalar(1.3);
    g.position.set(0.02 * Math.sin(t * 0.7), 2.17 + 0.02 * Math.sin(t * 1.9 + this.seed), 0.56 + this.headZ);
    g.rotation.set(this.headPitch + 0.04 * Math.sin(t * 1.3), 0.06 * Math.sin(t * 0.6 + 1), 0.05 * Math.sin(t * 0.9));
    g.updateMatrix();
    const open = this.jawOpen + (1 - this.fade) * 0.4;
    H.jaw.position.y = -0.082 - open * 0.085;
    H.jaw.rotation.x = open * 0.3;
    H.jawSide.rotation.x = open * 0.55;
    H.mouth.scale.y = 0.6 + open * 1.1;
    H.mouth.material.uniforms.uOpacity.value = smooth(0.06, 0.35, open);
  }

  _layTubes(t) {
    const T = this.tubes;
    const swell = 1 + 1.2 * (1 - this.fade);
    // The spine: from under the skull down the neck, through the chest and
    // belly to the waist, then the tail.
    _h.set(0, -0.15, -0.07).applyMatrix4(this.head.group.matrix);
    const breathe = Math.sin(t * 2.2) * 0.03;
    const P = this._P || (this._P = new Float32Array(21));
    const key = (j, x, y, z) => {
      P[j * 3] = x;
      P[j * 3 + 1] = y;
      P[j * 3 + 2] = z;
    };
    key(0, _h.x, _h.y, _h.z);
    key(1, _h.x, _h.y, _h.z);
    key(2, 0, 1.99, 0.33 + this.headZ * 0.5);
    key(3, 0.015 * Math.sin(t * 0.8), 1.8 + breathe * 0.5, 0.2);
    key(4, 0.03 * Math.sin(t * 0.9 + 1), 1.56, 0.05);
    key(5, 0.03 * Math.sin(t * 0.9 + 2), 1.36, -0.05);
    key(6, P[15], P[16] - 0.2, P[17] - 0.05);
    this._spiral(0, t, _q);
    const ox = P[15] - _q.x;
    const oy = P[16] - _q.y;
    const oz = P[17] - _q.z;
    for (let i = 0; i < SPINE_RINGS; i++) {
      const s = i / (SPINE_RINGS - 1);
      let x;
      let y;
      let z;
      let ra;
      let rb;
      if (s <= TORSO) {
        const q = s / TORSO;
        const seg = Math.min(3, (q * 4) | 0);
        const f = q * 4 - seg;
        const j = seg * 3;
        x = cr(P[j], P[j + 3], P[j + 6], P[j + 9], f);
        y = cr(P[j + 1], P[j + 4], P[j + 7], P[j + 10], f);
        z = cr(P[j + 2], P[j + 5], P[j + 8], P[j + 11], f);
        ra = knots(CHEST_W, q) * (1 + breathe * smooth(0.3, 0.6, q));
        rb = knots(CHEST_D, q);
      } else {
        const v = (s - TORSO) / (1 - TORSO);
        this._spiral(v, t, _q);
        x = _q.x + ox;
        y = _q.y + oy;
        z = _q.z + oz;
        ra = rb = (0.215 * Math.pow(1 - v, 0.85) + 0.012) * (1 + 0.1 * Math.sin(v * 9 - t * 2.5));
      }
      this._lag(x, y, z, 0.01 + 0.45 * Math.pow(s, 1.3), _t);
      T.ring(SPINE, i, _t.x, _t.y, _t.z, ra * swell, rb * swell);
    }
    T.build(SPINE, 1, 0, 0, t);
    // Its shoulders: hunched, across its upper back from one to the other.
    const yr = T.specs[YOKE].rings;
    const sz = 0.24 + this.headZ * 0.3;
    for (let i = 0; i < yr; i++) {
      const u = i / (yr - 1);
      const x = (1 - 2 * u) * 0.46;
      const m = Math.sin(Math.PI * u);
      this._lag(x, 1.95 + 0.11 * m, sz - 0.07 * m, 0.01, _t);
      const r = (0.1 + 0.05 * m) * swell;
      T.ring(YOKE, i, _t.x, _t.y, _t.z, r, r * 0.85);
    }
    T.build(YOKE, 0, 1, 0, t);
    for (let hand = 0; hand < 2; hand++) this._layArm(hand, t, swell);
  }

  // The line its tail follows, from its waist (0) to the tip (1): down and
  // round in a wide whirl below it, tilted (its far side higher, so the whirl
  // shows from in front), the tip curling into the middle.
  _spiral(v, t, out) {
    const th = 3.6 + v * 2.5 * Math.PI + 0.35 * Math.sin(t * 0.8 + v * 3);
    const R = 0.12 + 0.95 * Math.sin(Math.PI * Math.min(1, Math.pow(v, 0.85)));
    const dn = smooth(0, 0.5, v);
    const cx = R * Math.sin(th) - 0.25 * dn;
    const cz = R * Math.cos(th) * 0.85 - 0.5 * dn;
    return out.set(cx, 1.46 - 1.02 * dn + 0.12 * v * v - 0.28 * (cz + 0.5 * dn) * dn, cz);
  }

  // An arm by two bones from the shoulder to where the hand should be (the
  // elbow out, down and back), the hand bent down at the wrist.
  _armFrame(hand) {
    const side = hand === 0 ? 1 : -1;
    const A = this._A[hand];
    const H = this.hands[hand];
    const sx = side * 0.44;
    const sy = 1.97;
    const sz = 0.24 + this.headZ * 0.3;
    let dx = H.x - sx;
    let dy = H.y - sy;
    let dz = H.z - sz;
    let d = Math.hypot(dx, dy, dz) || 1;
    dx /= d;
    dy /= d;
    dz /= d;
    d = Math.min(UPPER + FORE - 0.02, Math.max(0.3, d));
    let px = side * 0.8;
    let py = -0.45;
    let pz = -0.4;
    const dp = px * dx + py * dy + pz * dz;
    px -= dx * dp;
    py -= dy * dp;
    pz -= dz * dp;
    const pl = Math.hypot(px, py, pz) || 1;
    const along = (UPPER * UPPER - FORE * FORE + d * d) / (2 * d);
    const up = Math.sqrt(Math.max(0, UPPER * UPPER - along * along));
    A[0] = sx;
    A[1] = sy;
    A[2] = sz;
    A[3] = sx + dx * along + (px / pl) * up;
    A[4] = sy + dy * along + (py / pl) * up;
    A[5] = sz + dz * along + (pz / pl) * up;
    A[6] = sx + dx * d;
    A[7] = sy + dy * d;
    A[8] = sz + dz * d;
    let hx = A[6] - A[3];
    let hy = A[7] - A[4];
    let hz = A[8] - A[5];
    let hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl;
    hy = hy / hl - 0.3;
    hz /= hl;
    hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl;
    hy /= hl;
    hz /= hl;
    // Across the hand (the hand's way crossed with up), and up from its back.
    let qx = -hz;
    let qz = hx;
    const ql = Math.hypot(qx, qz);
    if (ql < 0.05) {
      qx = 1;
      qz = 0;
    } else {
      qx /= ql;
      qz /= ql;
    }
    A[9] = hx;
    A[10] = hy;
    A[11] = hz;
    A[12] = qx;
    A[13] = 0;
    A[14] = qz;
    A[15] = -qz * hy;
    A[16] = qz * hx - qx * hz;
    A[17] = qx * hy;
  }

  // A point on an arm, `u` from shoulder (0) through elbow (0.5) to wrist.
  _armPoint(A, u, out) {
    const k = u < 0.5 ? 0 : 3;
    const f = u < 0.5 ? u * 2 : u * 2 - 1;
    return out.set(A[k] + (A[k + 3] - A[k]) * f, A[k + 1] + (A[k + 4] - A[k + 1]) * f, A[k + 2] + (A[k + 5] - A[k + 2]) * f);
  }

  _layArm(hand, t, swell) {
    const T = this.tubes;
    const side = hand === 0 ? 1 : -1;
    this._armFrame(hand);
    const A = this._A[hand];
    const arm = ARM + hand;
    const rings = T.specs[arm].rings;
    for (let i = 0; i < rings; i++) {
      const u = i / (rings - 1);
      if (u > 0.4 && u < 0.6) {
        // (Round over the elbow.)
        const b = (u - 0.4) / 0.2;
        this._armPoint(A, 0.4, _p);
        this._armPoint(A, 0.6, _q);
        _p.multiplyScalar((1 - b) * (1 - b)).addScaledVector(_q, b * b);
        _p.x += 2 * (1 - b) * b * A[3];
        _p.y += 2 * (1 - b) * b * A[4];
        _p.z += 2 * (1 - b) * b * A[5];
      } else this._armPoint(A, u, _p);
      // (Bony: knobbed at the elbow and wrist, wasted between.)
      const r = (u < 0.5 ? 0.095 + (0.052 - 0.095) * u * 2 : 0.052 + (0.034 - 0.052) * (u * 2 - 1)) + 0.016 * Math.exp(-(((u - 0.5) / 0.06) ** 2)) + 0.01 * Math.exp(-(((u - 0.97) / 0.04) ** 2));
      this._lag(_p.x, _p.y, _p.z, 0.02 + 0.05 * u, _t);
      T.ring(arm, i, _t.x, _t.y, _t.z, r * swell, r * swell);
    }
    T.build(arm, 0, 1, 0, t);
    // The palm.
    const palm = PALM + hand;
    const W = [0.042, 0.054, 0.055, 0.05];
    for (let j = 0; j < 4; j++) {
      const f = (0.115 * j) / 3;
      this._lag(A[6] + A[9] * f, A[7] + A[10] * f, A[8] + A[11] * f, 0.07, _t);
      T.ring(palm, j, _t.x, _t.y, _t.z, W[j] * swell, 0.022 * swell);
    }
    T.build(palm, A[12], A[13], A[14]);
    // Four fingers and a thumb, fanned, hooked down toward the palm.
    const curl = this.curl[hand] * (1 - 0.6 * (1 - this.fade));
    const spread = this.spread[hand];
    const qx = A[12] * side;
    const qy = A[13] * side;
    const qz = A[14] * side;
    for (let f = 0; f < 5; f++) {
      const thumb = f === 4;
      let bx;
      let by;
      let bz;
      let dx;
      let dy;
      let dz;
      let len;
      if (thumb) {
        bx = A[6] + A[9] * 0.035 + qx * 0.05;
        by = A[7] + A[10] * 0.035 + qy * 0.05;
        bz = A[8] + A[11] * 0.035 + qz * 0.05;
        dx = A[9] * 0.55 + qx * 0.8 - A[15] * 0.15;
        dy = A[10] * 0.55 + qy * 0.8 - A[16] * 0.15;
        dz = A[11] * 0.55 + qz * 0.8 - A[17] * 0.15;
        len = 0.15;
      } else {
        const o = 0.042 - 0.028 * f;
        bx = A[6] + A[9] * 0.105 + qx * o;
        by = A[7] + A[10] * 0.105 + qy * o;
        bz = A[8] + A[11] * 0.105 + qz * o;
        const fan = (0.2 - 0.13 * f) * spread;
        dx = A[9] + qx * fan;
        dy = A[10] + qy * fan;
        dz = A[11] + qz * fan;
        len = [0.28, 0.32, 0.3, 0.24][f];
      }
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const tube = FINGER + hand * 5 + f;
      const n = T.specs[tube].rings;
      let x = bx;
      let y = by;
      let z = bz;
      for (let j = 0; j < n; j++) {
        if (j > 0) {
          const th = curl * (j / (n - 1)) * 1.75;
          const c = Math.cos(th);
          const s = Math.sin(th);
          const step = len / (n - 1);
          x += (dx * c - A[15] * s) * step;
          y += (dy * c - A[16] * s) * step;
          z += (dz * c - A[17] * s) * step;
        }
        const r = ((thumb ? 0.021 : 0.019) * (1 - 0.8 * (j / (n - 1))) + 0.003) * swell;
        this._lag(x, y, z, 0.07, _t);
        T.ring(tube, j, _t.x, _t.y, _t.z, r, r);
      }
      T.build(tube, A[12], A[13], A[14]);
    }
  }

  // ------------------------------------------------------- its strands ---

  // ------------------------------------------------------- its paint ---

  _layBrush(t) {
    const loose = 1 - this.fade;
    const B = this.brush;
    const T = this.tubes;
    for (const sp of B.specs) {
      const n = sp.n;
      if (sp.kind === BB_BODY || sp.kind === BB_ARM || sp.kind === BB_YOKE) {
        // Along its body (or an arm, or its shoulders), twisting round it,
        // the end of a body stroke peeling out and streaming back.
        for (let i = 0; i < n; i++) {
          const w = i / (n - 1);
          const s = Math.min(0.995, sp.s0 + sp.span * w);
          const a = sp.phi + sp.twist * w + 0.3 * Math.sin(t * 0.7 + sp.seed * 6 + w * 3);
          const k = sp.k * (1 + loose);
          if (sp.kind === BB_BODY) {
            const pe = (sp.peel + loose * 0.5) * w * w;
            this._spinePoint(s, a, k, pe * 0.6, _h);
            B.set(sp.start + i, _h.x, _h.y + pe * 0.35, _h.z - pe * 0.6);
          } else {
            this._tubePoint(sp.kind === BB_ARM ? ARM + sp.hand : YOKE, s, a, Math.max(0.2, k), _h);
            B.set(sp.start + i, _h.x, _h.y, _h.z);
          }
        }
      } else if (sp.kind === BB_RIB) {
        // Round its chest from the breastbone, dropping a little.
        const s0 = (0.4 + 0.085 * sp.row) * TORSO;
        for (let i = 0; i < n; i++) {
          const w = i / (n - 1);
          this._spinePoint(s0 + 0.015 * w, Math.PI / 2 - sp.side * (0.08 + 1.55 * w), 1.04 + loose, 0, _h);
          B.set(sp.start + i, _h.x, _h.y, _h.z);
        }
      } else if (sp.kind === BB_STREAM) {
        // Streaming back off an arm, curling up, rippling.
        const A = this._A[sp.hand];
        this._armPoint(A, sp.at, _f0);
        let dx = sp.side * sp.out;
        let dy = sp.up;
        let dz = -sp.back;
        const dl = Math.hypot(dx, dy, dz);
        dx /= dl;
        dy /= dl;
        dz /= dl;
        for (let i = 0; i < n; i++) {
          const w = i / (n - 1);
          const L = sp.len * w * (1 + loose);
          this._lag(_f0.x + dx * L + 0.12 * w * Math.sin(w * sp.f1 - t * 3.2 + sp.p1), _f0.y + dy * L + sp.curl * sp.len * w * w + 0.2 * w * Math.sin(w * sp.f2 * 0.8 - t * 2.8 + sp.p2), _f0.z + dz * L + 0.14 * w * Math.cos(w * sp.f1 * 0.9 - t * 2.4 + sp.p2), 0.05 + 0.3 * w, _t);
          B.set(sp.start + i, _t.x, _t.y, _t.z);
        }
      } else if (sp.kind === BB_HAIR) {
        // From above its brow, over its crown, then back off it and up,
        // rippling (head space, carried with its head).
        const m = this.head.group.matrix;
        const lat = sp.lat;
        const th1 = 2.35;
        for (let i = 0; i < n; i++) {
          const w = i / (n - 1);
          if (w < 0.4) {
            const th = sp.th0 + (th1 - sp.th0) * (w / 0.4);
            _h.set(lat * 0.135 * (0.55 + 0.45 * Math.sin(th)), 0.04 + 0.17 * Math.sin(th) * (1 - 0.25 * lat * lat), -0.07 + 0.25 * Math.cos(th));
          } else {
            const q = (w - 0.4) / 0.6;
            const L = sp.len * q * (1 + loose);
            const ex = lat * 0.135 * (0.55 + 0.45 * Math.sin(th1));
            const ey = 0.04 + 0.17 * Math.sin(th1) * (1 - 0.25 * lat * lat);
            const ez = -0.07 + 0.25 * Math.cos(th1);
            _h.set(ex + lat * L * 0.45 + 0.12 * L * Math.sin(q * sp.f1 - t * 3 + sp.p1), ey + sp.up * L * 0.8 + 0.1 * L * Math.sin(q * sp.f2 - t * 2.6 + sp.p2), ez - L * 0.9 + 0.08 * L * Math.cos(q * sp.f1 - t * 2 + sp.p2));
          }
          _h.applyMatrix4(m);
          this._lag(_h.x, _h.y, _h.z, 0.22 * w, _t);
          B.set(sp.start + i, _t.x, _t.y, _t.z);
        }
      } else {
        // A claw: along its finger.
        const sp2 = T.specs[FINGER + sp.hand * 5 + sp.f];
        const C = T.c;
        for (let i = 0; i < n; i++) {
          const r = sp2.ring0 + Math.min(sp2.rings - 1, i);
          B.set(sp.start + i, C[r * 3], C[r * 3 + 1], C[r * 3 + 2]);
        }
      }
    }
  }

  _layStrands(t) {
    const loose = 1 - this.fade;
    // Its flight, in its own space (what trails bends away from it).
    const dvx = Math.max(-12, Math.min(12, this.drift.x));
    const dvz = Math.max(-12, Math.min(12, this.drift.z));
    this._dlx = dvx * this._cy - dvz * this._sy;
    this._dlz = dvx * this._sy + dvz * this._cy;
    for (const sp of this.strands.specs) {
      if (sp.kind === FIBRE) this._fibre(sp, t, loose);
      else if (sp.kind === HAIR) this._hair(sp, t, loose);
      else if (sp.kind === RIB) this._rib(sp);
      else if (sp.kind === FRAY) this._fray(sp, t, loose);
      else if (sp.kind === LIMB) this._limb(sp, t, loose);
      else this._tendril(sp, t, loose);
    }
  }

  // A point on its spine's surface at `s` along it, `a` round it, `k`
  // times out plus `extra` metres, into `out` (already where it trails to).
  _spinePoint(s, a, k, extra, out) {
    const T = this.tubes;
    const r = s * (SPINE_RINGS - 1);
    const i0 = Math.min(SPINE_RINGS - 2, r | 0);
    const f = r - i0;
    const ring = T.specs[SPINE].ring0 + i0;
    T.surface(ring, a, k + extra / Math.max(0.03, T.ra[ring]), _p);
    T.surface(ring + 1, a, k + extra / Math.max(0.03, T.ra[ring + 1]), _q);
    return out.copy(_p).lerp(_q, f);
  }

  // Fibres over its body and down its tail, twisting and weaving; some come
  // away from the tail near its end.
  _fibre(sp, t, loose) {
    for (let i = 0; i < sp.n; i++) {
      const s = 0.07 + 0.93 * (i / (sp.n - 1));
      const a = sp.phi + sp.twist * Math.PI * s + 0.4 * Math.sin(s * sp.f1 + sp.p1 + t * 0.7);
      const k = sp.k + 0.12 * Math.sin(s * sp.f2 + sp.p2 - t * 1.1) + loose;
      this._spinePoint(s, a, k, sp.peel * smooth(0.7, 1, s), _h);
      this.strands.set(sp.start + i, _h.x, _h.y + loose * 0.6 * s, _h.z);
    }
  }

  // A point on tube `tube`'s surface at `s` along it, `a` round it, `k`
  // times out, into `out`.
  _tubePoint(tube, s, a, k, out) {
    const T = this.tubes;
    const sp = T.specs[tube];
    const r = s * (sp.rings - 1);
    const i0 = Math.min(sp.rings - 2, r | 0);
    const ring = sp.ring0 + i0;
    T.surface(ring, a, k, _p);
    T.surface(ring + 1, a, k, _q);
    return out.copy(_p).lerp(_q, r - i0);
  }

  // A wisp fraying off it: out of its surface, bending up and back (and
  // away from where it is going), rippling, longer where it is thicker.
  _fray(sp, t, loose) {
    let r;
    if (sp.on === ON_HEAD) {
      const m = this.head.group.matrix;
      _f0.set(sp.dx * 0.13, 0.04 + sp.dy * 0.16, -0.07 + sp.dz * 0.23).applyMatrix4(m);
      _f1.set(sp.dx * 0.2, 0.04 + sp.dy * 0.245, -0.07 + sp.dz * 0.35).applyMatrix4(m);
      r = 0.25;
    } else {
      const tube = sp.on === ON_SPINE ? SPINE : sp.on === ON_YOKE ? YOKE : ARM + sp.hand;
      const a = sp.ang + 0.25 * Math.sin(t * 0.8 + sp.p1);
      this._tubePoint(tube, sp.s, a, 0.9, _f0);
      this._tubePoint(tube, sp.s, a, 1.5, _f1);
      r = _f0.distanceTo(_f1) / 0.6;
    }
    let dx = _f1.x - _f0.x;
    let dy = _f1.y - _f0.y;
    let dz = _f1.z - _f0.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    // Out of it, bent up and back, and away from its flight.
    dx = (dx / dl) * 0.75 - this._dlx * 0.05;
    dy = (dy / dl) * 0.75 + 0.3;
    dz = (dz / dl) * 0.75 - 0.35 - this._dlz * 0.05;
    const L = sp.len * (0.45 + 2.2 * Math.min(0.32, r)) * (1 + loose);
    for (let i = 0; i < sp.n; i++) {
      const w = i / (sp.n - 1);
      const rip = L * w * 0.35;
      this.strands.set(sp.start + i, _f0.x + dx * L * w + rip * Math.sin(w * sp.f1 - t * 4 + sp.p1), _f0.y + dy * L * w + 0.25 * L * w * w + rip * 0.6 * Math.sin(w * sp.f2 - t * 3.3 + sp.p2), _f0.z + dz * L * w + rip * Math.cos(w * sp.f1 - t * 3.6 + sp.p2));
    }
  }

  // A strand along an arm (shoulder to wrist) or across its shoulders,
  // twisting round it and weaving in and out of its flesh.
  _limb(sp, t, loose) {
    const tube = sp.hand < 0 ? YOKE : ARM + sp.hand;
    for (let i = 0; i < sp.n; i++) {
      const s = 0.02 + 0.96 * (i / (sp.n - 1));
      const a = sp.phi + sp.twist * Math.PI * s + 0.35 * Math.sin(s * sp.f1 + sp.p1 + t * 0.9);
      const k = sp.k + 0.25 * Math.sin(s * sp.f2 + sp.p2 - t * 1.3) + loose;
      this._tubePoint(tube, s, a, Math.max(0.2, k), _h);
      this.strands.set(sp.start + i, _h.x, _h.y + loose * 0.4 * s, _h.z);
    }
  }

  // Ribs: curving round its chest from the breastbone, dropping a little.
  _rib(sp) {
    const s = (0.42 + 0.1 * sp.row) * TORSO;
    for (let i = 0; i < sp.n; i++) {
      const w = i / (sp.n - 1);
      this._spinePoint(s + 0.012 * w, Math.PI / 2 - sp.side * (0.05 + 1.45 * w), 1.05, 0, _h);
      this.strands.set(sp.start + i, _h.x, _h.y, _h.z);
    }
  }

  // Hair: from the crown and the back of its skull, streaming up and back
  // off it like flame, rippling (in head space, carried with its head).
  _hair(sp, t, loose) {
    const m = this.head.group.matrix;
    let rx = sp.lat * 0.9;
    let ry = sp.up;
    let rz = 0.1 - sp.back * 0.8;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx = (rx / rl) * 0.135;
    ry = 0.04 + (ry / rl) * 0.165;
    rz = -0.07 + (rz / rl) * 0.24;
    const L = sp.len * (1 + loose);
    for (let i = 0; i < sp.n; i++) {
      const w = i / (sp.n - 1);
      _h.set(
        rx + sp.lat * L * (0.35 * w + 0.2 * w * w) + 0.2 * L * w * Math.sin(w * sp.f1 * 1.4 - t * 3 + sp.p1),
        ry + L * (0.35 + 0.35 * sp.up) * w + 0.16 * L * w * Math.sin(w * sp.f2 - t * 2.6 + sp.p2),
        rz - L * (0.45 + 0.3 * sp.back) * w - L * 0.3 * w * w + 0.14 * L * w * Math.cos(w * sp.f1 - t * 2 + sp.p2),
      ).applyMatrix4(m);
      this._place(sp.start + i, _h.x, _h.y, _h.z, 0.25 * w);
    }
  }

  // Tendrils trailing off an arm: out, back and up, curling and rippling.
  _tendril(sp, t, loose) {
    const A = this._A[sp.hand];
    this._armPoint(A, sp.at, _h);
    const bx = _h.x;
    const by = _h.y;
    const bz = _h.z;
    let dx = sp.side * sp.out;
    let dy = sp.up;
    let dz = -sp.back;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl;
    dy /= dl;
    dz /= dl;
    for (let i = 0; i < sp.n; i++) {
      const w = i / (sp.n - 1);
      const L = sp.len * w;
      this._place(
        sp.start + i,
        bx + dx * L + 0.08 * w * Math.sin(w * sp.f1 - t * 3.4 + sp.p1),
        by + dy * L + sp.curl * sp.len * w * w + 0.16 * w * Math.sin(w * sp.f2 * 0.6 - t * 3 + sp.p2) + loose * 0.6 * w,
        bz + dz * L + 0.12 * w * Math.cos(w * sp.f1 * 0.7 - t * 2.6 + sp.p2),
        0.05 + 0.3 * w,
      );
    }
  }

  // ------------------------------------------------------- what it sheds ---

  // How many to emit this frame, at `rate` a second (carrying the rest).
  _n(key, rate, dt) {
    const a = (this.acc[key] || 0) + rate * dt;
    const n = Math.floor(a);
    this.acc[key] = a - n;
    return n;
  }

  _emit(dt, ctx, t) {
    const add = ctx.fx.add;
    if (this.hidden) {
      // Inside you: its wisps swirl round you.
      const p = ctx.player.position;
      for (let i = this._n('in', 70, dt); i > 0; i--) {
        const ang = rand(0, Math.PI * 2);
        const r = rand(1.0, 1.7);
        _p.set(p.x + Math.cos(ang) * r, p.y + rand(0.7, 2.3), p.z + Math.sin(ang) * r);
        put(add, _p, -Math.sin(ang) * 2.4, rand(-0.2, 0.4), Math.cos(ang) * 2.4, rand(0.4, 0.8), rand(0.035, 0.06), 0.015, Math.random() < 0.25 ? GOLD : TEAL_HOT, TEAL_DIM, 1, 0.6, 2);
      }
      return;
    }
    const fade = this.fade;
    const dvx = this.alive ? this.drift.x : 0;
    const dvz = this.alive ? this.drift.z : 0;
    // Glitter drifting off it: gold, violet and white off the tail.
    for (let i = this._n('glit', 330 * fade, dt); i > 0; i--) {
      let color;
      let end;
      if (Math.random() < 0.7) {
        const s = this._onBody(0.12, rand(0.2, 1.3), _p);
        const r = Math.random();
        color = s > 0.3 && r < 0.35 ? GOLD : s > 0.3 && r < 0.5 ? VIOLET : r < 0.75 ? WHITE : TEAL_HOT;
        end = color === GOLD ? GOLD_DIM : TEAL;
      } else {
        const k = (Math.random() * this.strands.count) | 0;
        this._at(k, _p);
        const gold = this.tones[k] === TONE_GOLD && Math.random() < 0.7;
        color = gold ? GOLD : Math.random() < 0.5 ? WHITE : TEAL_HOT;
        end = gold ? GOLD_DIM : TEAL;
      }
      put(add, _p, dvx * 0.6 + rand(-0.25, 0.25), rand(-0.05, 0.3), dvz * 0.6 + rand(-0.25, 0.25), rand(0.35, 0.8), rand(0.02, 0.036), 0.008, color, end, 1, 0.8, 1.2);
    }
    // Fine wisps streaming off its edges.
    for (let i = this._n('edge', 70 * fade, dt); i > 0; i--) {
      this._onBody(0.05, rand(1.0, 1.3), _p);
      put(add, _p, dvx * 0.4 + rand(-0.3, 0.3), rand(0.1, 0.45), dvz * 0.4 + rand(-0.3, 0.3), rand(0.4, 0.8), rand(0.03, 0.05), 0.07, TEAL, TEAL_DEEP, 0.55, 1, 2);
    }
    // Dark flakes of ash torn off its tail.
    for (let i = this._n('ash', 22 * fade, dt); i > 0; i--) {
      this._onBody(0.35, rand(1.0, 1.3), _p);
      put(ctx.fx.alpha, _p, dvx * 0.4 + rand(-0.8, 0.8), rand(0.2, 1.0), dvz * 0.4 + rand(-0.8, 0.8), rand(0.9, 1.6), rand(0.035, 0.06), 0.02, ASH, ASH, 0.85, 0.6, 2.5);
    }
    // A low mist rolling off its tail.
    for (let i = this._n('mist', 5 * fade, dt); i > 0; i--) {
      this._onBody(0.55, rand(0.3, 1), _p);
      put(ctx.fx.alpha, _p, dvx * 0.3 + rand(-0.15, 0.15), rand(0.02, 0.12), dvz * 0.3 + rand(-0.15, 0.15), rand(1.8, 2.6), rand(0.5, 0.8), rand(1.2, 1.7), MIST, TEAL_DEEP, 0.13, 0.6, 0.3);
    }
    // Wisps peeling off the ends of its hair, tendrils and tail.
    for (let i = this._n('wisp', 40 * fade, dt); i > 0; i--) {
      const k = this.tips[(Math.random() * this.tips.length) | 0] - ((Math.random() * 3) | 0);
      this._at(k, _p);
      put(add, _p, dvx * 0.3 + rand(-0.3, 0.3), rand(0.15, 0.5), dvz * 0.3 + rand(-0.3, 0.3), rand(0.7, 1.2), 0.035, 0.05, TEAL, TEAL_DEEP, 0.6, 0.9, 2.5);
    }
    // Its claws leave trails as they strike.
    const a = this.attack;
    if (this.state === 'strike' && a && (a.name !== 'dive' || this.stateT / Math.max(1e-3, this.stateDur) > RISE)) {
      const C = this.tubes.c;
      for (const r of this.clawTips) {
        this._w(C[r * 3], C[r * 3 + 1], C[r * 3 + 2], _p);
        put(add, _p, 0, 0, 0, 0.28, 0.05, 0.02, TEAL_HOT, TEAL, 1, 0, 0);
      }
    }
    // A grab gathering: wisps drawn in from all round to its arms.
    if (a?.name === 'grab' && this.state === 'windup') {
      this._w(0, 1.9, 0.2, _t);
      for (let i = this._n('pull', 60, dt); i > 0; i--) {
        const ang = rand(0, Math.PI * 2);
        const r = rand(1.6, 2.6);
        this._w(Math.cos(ang) * r, rand(0.8, 2.8), Math.sin(ang) * r, _p);
        put(add, _p, (_t.x - _p.x) * 2.2, (_t.y - _p.y) * 2.2, (_t.z - _p.z) * 2.2, 0.45, 0.05, 0.02, TEAL_HOT, TEAL, 1, 0, 0);
      }
    }
  }
}
