import * as THREE from 'three';
import { SPELLS, SPELL_IDS } from '../entities/Spells.js';
import { WEAPON_TYPES } from '../entities/Weapons.js';
import { makeCanvas } from '../world/Textures.js';
import { IconAtlas } from './IconAtlas.js';
import { RELICS } from '../combat/Relics.js';
import { PROCS, ENCHANTS } from '../combat/Procs.js';
import { MOMENTUM_MAX } from '../combat/Styles.js';
import { WINDOW_EARLY, WINDOW_LATE, CHAIN_MAX } from '../combat/Rhythm.js';
import { relicPassive } from '../combat/Relics.js';

// The interface, drawn over the 3D view. Project 0 runs the game in a worker
// with no DOM, so nothing here may touch the page.
//
// Two kinds of layer, so the screen never re-uploads a full-size texture
// every frame:
//
//   - One canvas the size of the screen holds everything that changes only
//     now and then (labels, frames, painted icons, the health frame, the
//     weapon panel, prompts, panels). It is repainted only when what it
//     shows changes.
//   - Everything that moves every frame is a small GPU quad with a shader
//     or a little canvas of its own: the rhythm ring around the crosshair,
//     the spell cooldown sweeps and their flashes, the health fill with its
//     trailing chip, the compass needle, combat callouts (PERFECT, COUNTER,
//     proc names), announcements and toasts.
//
// Layout is in a virtual 1280 x 720 screen scaled by `u`, so the interface
// keeps its size relative to the screen (about 1.5x at 1080p).

const SERIF = "Georgia, 'Times New Roman', serif";
// One look for every panel and label: charred black-red panels with grain,
// a dark iron frame lined in old blood with small horned corners, and text
// that glows softly out of the dark rather than sitting crisp on top of it.
const C = {
  bone: '#cdb796',
  ash: '#7d6c60',
  ember: '#e8642a',
  blood: '#b3180e',
  light: '#f2c79e',
  panel: 'rgba(14,4,3,0.86)',
  edge: '#6a1a10',
  iron: '#1e0c09',
};

// Skill slots along the bottom: the three demon spells, then Phantom Step.
const SLOTS = [...SPELL_IDS.map((id) => ({ id, icon: id })), { id: 'dodge', icon: 'dodge' }];

const FULL_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }';
const QUAD_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

const VIGNETTE_FRAG = `
  varying vec2 vUv;
  uniform float uHurt; uniform float uLow; uniform float uFade; uniform float uPulse; uniform float uHeal;
  void main(){
    vec2 c = vUv - 0.5;
    float edge = smoothstep(0.32, 0.75, length(c * vec2(1.4, 1.0)));
    vec3 col = mix(vec3(0.45, 0.0, 0.0), vec3(0.9, 0.12, 0.05), uHeal);
    float a = edge * (uHurt * 0.55 + uLow * (0.35 + 0.25 * uPulse) + uHeal * 0.35);
    a = a * (1.0 - uFade) + uFade;
    col = mix(col, vec3(0.0), uFade);
    gl_FragColor = vec4(col * (1.0 - uFade), a);
  }`;

// The rhythm ring: fills as the swing's arc nears completion and blazes gold
// inside the Perfect Chain window; pips round it count the chain.
const RING_FRAG = `
  varying vec2 vUv;
  uniform float uProg; uniform float uWin; uniform float uChain; uniform float uFumble;
  uniform float uPerfect; uniform float uAlpha; uniform float uTime; uniform float uHeavy;
  #define PI 3.14159265
  void main(){
    vec2 p = vUv - 0.5;
    float r = length(p);
    float ang = atan(p.x, p.y); // 0 at the top, clockwise
    float u = fract(ang / (2.0 * PI) + 1.0);
    float ringD = abs(r - 0.33);
    float ring = smoothstep(0.03, 0.012, ringD);
    vec3 col = vec3(0.0);
    float a = 0.0;
    // Faint track.
    a += ring * 0.16;
    col += ring * vec3(0.5, 0.15, 0.08) * 0.16;
    // Progress of the arc.
    float fill = ring * step(u, uProg);
    vec3 ember = mix(vec3(0.95, 0.35, 0.1), vec3(1.0, 0.85, 0.45), uProg);
    col += fill * ember * 0.9;
    a += fill * 0.85;
    // The window: the whole ring burns gold.
    float win = ring * uWin * (0.8 + 0.2 * sin(uTime * 40.0));
    col += win * vec3(1.0, 0.86, 0.45) * 1.4;
    a += win;
    // Perfect: a gold pulse rushing outward.
    float pr = 0.33 + (1.0 - uPerfect) * 0.16;
    float pulse = smoothstep(0.03, 0.0, abs(r - pr)) * uPerfect;
    col += pulse * vec3(1.0, 0.9, 0.6) * 1.6;
    a += pulse;
    // Fumble: the ring chokes dull red.
    float fum = smoothstep(0.05, 0.0, ringD) * uFumble;
    col = mix(col, vec3(0.45, 0.08, 0.05), uFumble * 0.8);
    a += fum * 0.6;
    // Chain pips around the ring.
    for (int i = 0; i < ${CHAIN_MAX}; i++) {
      float fi = float(i);
      float pa = (fi - ${(CHAIN_MAX - 1) / 2}.0) * 0.32;
      vec2 c = vec2(sin(pa), -cos(pa)) * 0.44;
      float d = length(p - c);
      float lit = step(fi + 0.5, uChain);
      float pip = smoothstep(0.028, 0.012, d);
      col += pip * mix(vec3(0.25, 0.08, 0.05), vec3(1.0, 0.82, 0.4) * 1.5, lit);
      a += pip * mix(0.35, 1.0, lit);
    }
    gl_FragColor = vec4(col * uAlpha, clamp(a, 0.0, 1.0) * uAlpha);
  }`;

// A skill slot's moving parts: the cooldown sweep (darkness peeling back
// clockwise with a bright edge), the flash of a cast, a pulse when it comes
// ready, and a red flinch when pressed too soon.
const SLOT_FRAG = `
  varying vec2 vUv;
  uniform float uCd; uniform float uFlash; uniform float uReady; uniform float uDenied; uniform vec3 uColor;
  #define PI 3.14159265
  void main(){
    vec2 p = vUv - 0.5;
    float ang = atan(p.x, p.y);
    float u = fract(ang / (2.0 * PI) + 1.0);
    float inside = step(abs(p.x), 0.5) * step(abs(p.y), 0.5);
    vec3 col = vec3(0.0);
    float a = 0.0;
    if (uCd > 0.0) {
      float dark = step(1.0 - uCd, u) * inside;
      a += dark * 0.72;
      float edge = smoothstep(0.02, 0.0, abs(u - (1.0 - uCd))) * step(0.05, length(p)) * inside;
      col += edge * vec3(1.0, 0.5, 0.2) * 0.9;
      a += edge * 0.6;
    }
    float r = length(p);
    float glow = smoothstep(0.75, 0.0, r) * uFlash;
    col += glow * uColor * 1.6;
    a += glow * 0.9;
    float rim = smoothstep(0.06, 0.0, abs(max(abs(p.x), abs(p.y)) - 0.47)) * uReady;
    col += rim * mix(uColor, vec3(1.0), 0.4) * 1.5;
    a += rim;
    col = mix(col, vec3(0.8, 0.05, 0.02), uDenied * 0.7);
    a = max(a, uDenied * 0.45 * inside);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }`;

// The blood in the health vial: a fill that sloshes, a pale chip that
// trails a blow away, a glow when healed and a pulse when low.
const HEALTH_FRAG = `
  varying vec2 vUv;
  uniform float uFrac; uniform float uChip; uniform float uHeal; uniform float uLow; uniform float uTime;
  float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main(){
    float x = vUv.x;
    float wave = sin(vUv.y * 9.0 + uTime * 3.0) * 0.004;
    float fill = step(x, uFrac + wave);
    float chip = step(uFrac + wave, x) * step(x, uChip);
    vec3 top = vec3(0.62, 0.06, 0.03);
    vec3 bot = vec3(0.18, 0.01, 0.01);
    vec3 col = mix(bot, top, smoothstep(0.0, 1.0, vUv.y));
    col += h21(floor(vUv * vec2(260.0, 18.0)) + floor(uTime * 6.0)) * 0.05;
    col += vec3(0.5, 0.05, 0.02) * uLow * (0.5 + 0.5 * sin(uTime * 7.0));
    col += vec3(1.0, 0.25, 0.1) * uHeal * 0.6;
    float edge = smoothstep(0.012, 0.0, abs(x - uFrac)) * fill;
    col += edge * vec3(1.0, 0.4, 0.2);
    vec3 c = col * fill + vec3(0.9, 0.55, 0.45) * chip * 0.7;
    float a = fill + chip * 0.8;
    gl_FragColor = vec4(c, a);
  }`;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Damage numbers' size as a share of the screen's height.
const NUM_W = 0.1;
const NUM_H = 0.04;

export class Hud {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
    this.canvas = makeCanvas(16, 16);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.quad = quad;
    this.vignette = new THREE.ShaderMaterial({
      vertexShader: FULL_VERT,
      fragmentShader: VIGNETTE_FRAG,
      uniforms: { uHurt: { value: 0 }, uLow: { value: 0 }, uFade: { value: 1 }, uPulse: { value: 0 }, uHeal: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const vq = new THREE.Mesh(quad, this.vignette);
    vq.frustumCulled = false;
    vq.renderOrder = 1;
    this.overlay = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.main = new THREE.Mesh(quad, this.overlay);
    this.main.frustumCulled = false;
    this.main.renderOrder = 2;
    this.scene.add(vq, this.main);

    // ---- GPU layers ----
    const shader = (frag, uniforms, order) => {
      const m = new THREE.Mesh(quad, new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: frag, uniforms, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      m.frustumCulled = false;
      m.renderOrder = order;
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    this.ring = shader(RING_FRAG, { uProg: { value: 0 }, uWin: { value: 0 }, uChain: { value: 0 }, uFumble: { value: 0 }, uPerfect: { value: 0 }, uAlpha: { value: 0 }, uTime: { value: 0 }, uHeavy: { value: 0 } }, 5);
    this.slotFx = SLOTS.map(() => ({ mesh: shader(SLOT_FRAG, { uCd: { value: 0 }, uFlash: { value: 0 }, uReady: { value: 0 }, uDenied: { value: 0 }, uColor: { value: new THREE.Color(1, 0.5, 0.2) } }, 4), ready: 0, denied: 0, lastCd: 0 }));
    this.healthFx = shader(HEALTH_FRAG, { uFrac: { value: 1 }, uChip: { value: 1 }, uHeal: { value: 0 }, uLow: { value: 0 }, uTime: { value: 0 } }, 3);
    this.chip = 1;
    this.chipHold = 0;
    this.compass = this._spriteLayer(64, 64, 6, (g) => this._paintNeedle(g));
    this.callouts = [0, 1, 2].map(() => ({ ...this._canvasLayer(768, 112, 7), t: 9, life: 0 }));
    this.announceL = this._canvasLayer(1400, 260, 7);
    this.toastL = this._canvasLayer(560, 260, 7);
    // A teaching hint above the skills, the first time a mechanic comes up.
    this.hintL = this._canvasLayer(1400, 110, 7);
    this.hintT = 0;
    // Numbers that sit on top of the GPU fills: health, cooldown seconds.
    this.topL = this._canvasLayer(1024, 256, 6);
    this.topSig = '';
    this.relicFlash = null;

    this.playing = false;
    this.panel = 'title';
    this.info = {};
    this.titleInfo = {};
    this.endInfo = null;
    this.choice = null;
    this.toasts = [];
    this.toastDirty = false;
    this.announcement = null;
    this.buttons = [];
    this.touch = false;
    this.hurt = 0;
    this.heal = 0;
    this.fadeValue = 1;
    this.fadeTarget = 1;
    this.fadeSpeed = 2;
    this.dirty = true;
    this.lastSig = '';
    this.paintT = 0;
    this.time = 0;
    this.numbers = [];
    this.world = null;
    this.rhythmFx = { perfect: 0, fumble: 0, chain: 0 };
    this.layout = null;
    this.resize(host.width, host.height);
  }

  // A layer with its own little canvas, drawn as a quad.
  _canvasLayer(w, h, order) {
    const canvas = makeCanvas(w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    const mesh = new THREE.Mesh(this.quad, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    this.scene.add(mesh);
    return { canvas, g: canvas.getContext('2d'), tex, mesh, cw: w, ch: h };
  }

  _spriteLayer(w, h, order, paint) {
    const l = this._canvasLayer(w, h, order);
    paint(l.g);
    l.tex.needsUpdate = true;
    return l;
  }

  resize(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    // Painted at about the screen's resolution (at most 1.25x, and never
    // wider than 2400 px): sharp enough, and cheap to re-upload.
    this.scale = Math.min(Math.max(1, this.host.pixelRatio || 1), 1.25, 2400 / this.w);
    // Interface scale: a 1280 x 720 layout grown to fit the screen.
    this.u = Math.max(0.75, Math.min(3, Math.min(this.w / 1280, this.h / 720)));
    this.vw = this.w / this.u;
    this.vh = this.h / this.u;
    this.canvas.width = Math.round(this.w * this.scale);
    this.canvas.height = Math.round(this.h * this.scale);
    this.texture.dispose();
    this.texture.image = this.canvas;
    this.texture.needsUpdate = true;
    this.camera.left = 0;
    this.camera.right = this.w;
    this.camera.top = this.h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
    this.main.position.set(this.w / 2, this.h / 2, 0);
    this.main.scale.set(this.w, this.h, 1);
    this.dirty = true;
    this.toastDirty = true;
    if (this.announcement) this._paintAnnouncementLayer();
  }

  // Place a quad at a rect given in virtual (layout) coordinates, y down.
  _place(mesh, x, y, w, h) {
    const u = this.u;
    mesh.position.set((x + w / 2) * u, this.h - (y + h / 2) * u, 0);
    mesh.scale.set(w * u, h * u, 1);
  }

  // ---- Game-facing API ------------------------------------------------------

  show(panel, on) {
    if (on) this.panel = panel;
    else if (this.panel === panel) this.panel = null;
    this.dirty = true;
  }

  setPlaying(on) {
    this.playing = on;
    this.dirty = true;
  }

  setTitleInfo(info) {
    this.titleInfo = info;
    this.dirty = true;
  }

  setEnd(info) {
    this.endInfo = info;
    this.dirty = true;
  }

  update(dt, player, run, info) {
    this.info = { player, run, ...info };
    this.hurt = Math.max(this.hurt - dt * 1.6, Math.min(0.9, player.hurtFlash));
    this.heal = Math.max(this.heal - dt * 2, Math.min(1, player.healFlash || 0));
  }

  toast(text) {
    this.toasts.push({ text, t: 0 });
    while (this.toasts.length > 4) this.toasts.shift();
    this.toastDirty = true;
  }

  announce(text, sub = '') {
    this.announcement = { text, sub, t: 0 };
    this._paintAnnouncementLayer();
  }

  // A short burst of text below the crosshair: PERFECT x3, COUNTER, a proc.
  callout(text, { color = C.light, size = 1, proc = false } = {}) {
    // Reuse the oldest slot.
    const c = this.callouts.reduce((a, b) => (a.t > b.t ? a : b));
    for (const o of this.callouts) o.order = (o.order ?? 0) + 1;
    c.order = 0;
    c.t = 0;
    c.life = proc ? 1.5 : 1.0;
    c.size = size;
    const g = c.g;
    g.clearRect(0, 0, c.cw, c.ch);
    const fs = Math.round(54 * size);
    g.font = `bold ${fs}px ${SERIF}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if ('letterSpacing' in g) g.letterSpacing = `${Math.round(fs * 0.12)}px`;
    g.shadowColor = proc ? color : 'rgba(160,20,0,0.95)';
    g.shadowBlur = 24;
    g.fillStyle = color;
    g.fillText(text, c.cw / 2, c.ch / 2);
    g.shadowBlur = 6;
    g.shadowColor = 'rgba(0,0,0,0.9)';
    g.fillText(text, c.cw / 2, c.ch / 2);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    c.tex.needsUpdate = true;
  }

  // A hint that stays a while (markup as in prompts).
  hint(markup) {
    const L = this.hintL;
    const g = L.g;
    g.clearRect(0, 0, L.cw, L.ch);
    g.font = `34px ${SERIF}`;
    const plain = markup.replace(/<[^>]+>/g, '');
    const tw = Math.min(L.cw - 10, g.measureText(plain).width + 70);
    this._box(g, (L.cw - tw) / 2, 12, tw, L.ch - 24, 'rgba(16,4,3,0.92)', '#8a3a18');
    this._rich(g, markup, L.cw / 2, L.ch / 2, 34);
    L.tex.needsUpdate = true;
    this.hintT = 6;
  }

  // Rhythm feedback on the ring: a perfect pulse, a fumbled choke.
  rhythm(kind, chain = 0) {
    if (kind === 'perfect') {
      this.rhythmFx.perfect = 1;
      this.rhythmFx.chain = chain;
    } else if (kind === 'fumble') this.rhythmFx.fumble = 1;
  }

  flashRelic(id) {
    this.relicFlash = { id, t: 0 };
    this.dirty = true;
  }

  // A spell pressed while it is still cooling down.
  denySlot(id) {
    const i = SLOTS.findIndex((s) => s.id === id);
    if (i >= 0) this.slotFx[i].denied = 1;
  }

  showChoice(title, options) {
    this.choice = { title, options };
    this.panel = 'choice';
    this.dirty = true;
  }

  hideChoice() {
    this.choice = null;
    if (this.panel === 'choice') this.panel = null;
    this.dirty = true;
  }

  // Fade to black (true) or back (false); resolves when done.
  fade(toBlack, ms = 450) {
    this.fadeTarget = toBlack ? 1 : 0;
    this.fadeSpeed = 1000 / ms;
    return new Promise((res) => setTimeout(res, ms));
  }

  // Which on-screen button (touch) is at a point, if any: returns a key code.
  buttonAt(x, y) {
    for (const b of this.buttons) {
      if (b.rect ? Math.abs(x - b.x) <= b.w / 2 && Math.abs(y - b.y) <= b.h / 2 : Math.hypot(x - b.x, y - b.y) <= b.r) return b.code;
    }
    return null;
  }

  // ---- Damage numbers: sprites in the world --------------------------------

  setWorld(scene) {
    this.clearNumbers();
    this.world = scene;
  }

  // kind: 'counter', 'perfect', 'proc', 'bleed', 'burn' or null.
  damageNumber(pos, amount, crit, kind = null) {
    if (amount <= 0 || !this.world) return;
    let n = this.numbers.find((x) => !x.live);
    if (!n) {
      if (this.numbers.length >= 28) n = this.numbers.reduce((a, b) => (a.t > b.t ? a : b));
      else {
        const canvas = makeCanvas(160, 64);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        // A fixed size on screen, however near or far the demon.
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false, sizeAttenuation: false });
        n = { canvas, tex, sprite: new THREE.Sprite(mat) };
        n.sprite.renderOrder = 20;
        this.numbers.push(n);
      }
    }
    const small = kind === 'bleed' || kind === 'burn';
    const big = kind === 'counter' ? 1.45 : crit ? 1.2 : kind === 'perfect' ? 1.1 : small ? 0.7 : 1;
    const col = { counter: '#ffe0a0', perfect: '#ffd070', proc: '#b8d8ff', bleed: '#d0202a', burn: '#ff8a3a' }[kind] || (crit ? '#ff5a2a' : '#ffd8b0');
    const g = n.canvas.getContext('2d');
    g.clearRect(0, 0, 160, 64);
    g.font = `bold ${Math.round(40 * Math.min(1.2, big))}px ${SERIF}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(40,0,0,0.9)';
    const txt = String(Math.round(amount));
    g.strokeText(txt, 80, 32);
    g.fillStyle = col;
    g.fillText(txt, 80, 32);
    n.tex.needsUpdate = true;
    n.live = true;
    n.t = 0;
    n.big = big;
    n.sprite.position.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + 0.4, pos.z + (Math.random() - 0.5) * 0.4);
    n.sprite.scale.set(NUM_W * big, NUM_H * big, 1);
    n.sprite.material.opacity = 1;
    if (n.sprite.parent !== this.world) this.world.add(n.sprite);
  }

  updateNumbers(dt) {
    for (const n of this.numbers) {
      if (!n.live) continue;
      n.t += dt;
      n.sprite.position.y += dt * 0.9;
      // A quick pop on appearing.
      const pop = 1 + 0.5 * Math.max(0, 1 - n.t / 0.12);
      n.sprite.scale.set(NUM_W * n.big * pop, NUM_H * n.big * pop, 1);
      n.sprite.material.opacity = Math.min(1, (0.95 - n.t) * 4);
      if (n.t > 0.95) {
        n.live = false;
        n.sprite.removeFromParent();
      }
    }
  }

  clearNumbers() {
    for (const n of this.numbers) {
      n.live = false;
      n.sprite.removeFromParent();
    }
  }

  // ---- Per-frame -----------------------------------------------------------

  render(renderer, dt) {
    this.time += dt;
    for (const t of this.toasts) t.t += dt;
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.t < 2.8);
    if (this.toasts.length !== before) this.toastDirty = true;
    if (this.announcement) {
      this.announcement.t += dt;
      if (this.announcement.t > 3.4) this.announcement = null;
    }
    const step = this.fadeSpeed * dt;
    this.fadeValue += Math.max(-step, Math.min(step, this.fadeTarget - this.fadeValue));
    const low = this._lowHealth();
    const V = this.vignette.uniforms;
    V.uHurt.value = this.playing ? this.hurt : 0;
    V.uLow.value = this.playing ? low : 0;
    V.uHeal.value = this.playing ? this.heal : 0;
    V.uPulse.value = 0.5 + 0.5 * Math.sin(this.time * 4);
    V.uFade.value = this.fadeValue;

    const animating = this.panel === 'title' || this.panel === 'death' || this.panel === 'victory' || this.relicFlash;
    const sig = this._signature();
    this.paintT -= dt;
    if ((this.dirty || sig !== this.lastSig || animating) && this.paintT <= 0) {
      this.lastSig = sig;
      this.dirty = false;
      this.paintT = 0.05;
      this._paint();
      this.texture.needsUpdate = true;
    }
    this._updateLayers(dt);
    renderer.render(this.scene, this.camera);
  }

  _lowHealth() {
    const r = this.info.run;
    if (!r || this.info.player?.dead) return 0;
    const f = r.health / r.maxHealth;
    return f < 0.3 ? (0.3 - f) / 0.3 : 0;
  }

  // Everything the big canvas shows, as a string: repaint when it changes.
  _signature() {
    const i = this.info;
    const r = i.run;
    const p = i.player;
    if (!this.playing || !r) return `${this.panel}`;
    const cds = p ? SPELL_IDS.map((id) => Math.ceil(p.spellCd[id] || 0)).join(',') : '';
    return [
      this.panel,
      Math.ceil(r.health),
      r.maxHealth,
      r.potions,
      r.potionCap,
      r.weapon.name,
      p?.armed,
      r.dmgMul.toFixed(2),
      r.speedMul.toFixed(2),
      JSON.stringify(r.spells),
      JSON.stringify(r.relics),
      r.skills?.phantomStep,
      cds,
      i.floorLabel,
      i.enemyLabel,
      i.best,
      i.prompt,
      i.boss ? Math.ceil((i.boss.health / i.boss.maxHealth) * 200) : '',
      i.compass?.kind || '',
      p?.siphonT > 0 ? Math.ceil(p.siphonT) : '',
      p?.invuln > 0.25,
      p?.wrathT > 0,
      Math.floor(p?.momentum || 0),
      this.touch,
      this.w,
      this.h,
    ].join('|');
  }

  // ---- GPU layers ------------------------------------------------------------

  _updateLayers(dt) {
    const i = this.info;
    const p = i.player;
    const r = i.run;
    const L = this.layout;
    // `shown`: the HUD is up; `play`: actually fighting (no panel over it).
    const shown = this.playing && !!r && !!p && !p.dead;
    const play = shown && this.panel !== 'choice' && this.panel !== 'pause';

    // Rhythm ring around the crosshair.
    const fx = this.rhythmFx;
    fx.perfect = Math.max(0, fx.perfect - dt * 3.5);
    fx.fumble = Math.max(0, fx.fumble - dt * 3);
    const R = this.ring.material.uniforms;
    const s = p?.swing;
    let alpha = 0;
    if (play && p.armed) {
      if (s && !s.bounced) {
        const done = s.W + s.A;
        const widen = relicPassive(r, 'window') ?? 1;
        R.uProg.value = clamp01(s.t / done);
        R.uWin.value = !s.fumbled && s.t >= done - WINDOW_EARLY * widen && s.t <= done + WINDOW_LATE * widen ? 1 : 0;
        alpha = 1;
      } else {
        R.uProg.value = 0;
        R.uWin.value = 0;
      }
      alpha = Math.max(alpha, fx.perfect, fx.fumble, (p.chain || 0) > 0 && s ? 1 : 0);
    }
    this.ringA = (this.ringA ?? 0) + (alpha - (this.ringA ?? 0)) * Math.min(1, dt * (alpha > (this.ringA ?? 0) ? 30 : 6));
    R.uAlpha.value = this.ringA;
    R.uChain.value = p?.chain || 0;
    R.uPerfect.value = fx.perfect;
    R.uFumble.value = fx.fumble;
    R.uTime.value = this.time;
    this.ring.visible = this.ringA > 0.01;
    const rs = 92;
    this._place(this.ring, this.vw / 2 - rs / 2, this.vh / 2 - rs / 2, rs, rs);

    // Skill slots.
    for (const [k, slot] of SLOTS.entries()) {
      const f = this.slotFx[k];
      const U = f.mesh.material.uniforms;
      const rect = L?.slots?.[k];
      f.mesh.visible = shown && !!rect;
      if (!f.mesh.visible) continue;
      let cd = 0;
      let cast = 0;
      if (slot.id === 'dodge') {
        cd = r.skills?.phantomStep ? clamp01(p.dodgeCd / 1.0) : 0;
        cast = p.dodgeT > 0 ? 1 : 0;
      } else {
        const lvl = r.spells[slot.id];
        cd = lvl ? clamp01((p.spellCd[slot.id] || 0) / SPELLS[slot.id].levels[lvl - 1].cd) : 0;
        cast = (p.spellCast?.[slot.id] || 0) / 0.6;
      }
      if (f.lastCd > 0 && cd === 0) f.ready = 1;
      f.lastCd = cd;
      f.ready = Math.max(0, f.ready - dt * 2);
      f.denied = Math.max(0, f.denied - dt * 4);
      U.uCd.value = cd;
      U.uFlash.value = clamp01(cast);
      U.uReady.value = f.ready * (0.6 + 0.4 * Math.sin(this.time * 20));
      U.uDenied.value = f.denied;
      U.uColor.value.set(slot.id === 'nova' ? '#ff7a24' : slot.id === 'step' ? '#b080ff' : slot.id === 'siphon' ? '#ff3a2a' : '#c8b8ff');
      // A cast swells the slot for a moment.
      const bump = 1 + 0.12 * clamp01(cast);
      this._place(f.mesh, rect.x + (rect.w * (1 - bump)) / 2, rect.y + (rect.h * (1 - bump)) / 2, rect.w * bump, rect.h * bump);
    }

    // Health: fill, trailing chip, heal glow, low pulse.
    const H = this.healthFx.material.uniforms;
    this.healthFx.visible = shown && !!L?.health;
    if (this.healthFx.visible) {
      const frac = clamp01(r.health / r.maxHealth);
      if (frac < this.chip) {
        this.chipHold -= dt;
        if (this.chipHold <= 0) this.chip = Math.max(frac, this.chip - dt * 0.6);
      } else {
        this.chip = frac;
        this.chipHold = 0.45;
      }
      if (frac < H.uFrac.value - 0.001) this.chipHold = 0.45;
      H.uFrac.value = frac;
      H.uChip.value = this.chip;
      H.uHeal.value = this.heal;
      H.uLow.value = this._lowHealth();
      H.uTime.value = this.time;
      const b = L.health;
      this._place(this.healthFx, b.x, b.y, b.w, b.h);
    }

    // Compass needle.
    const cmp = i.compass;
    this.compass.mesh.visible = play && !!cmp && !this.announcement;
    if (this.compass.mesh.visible) {
      const exit = cmp.kind === 'exit';
      const sz = exit ? 46 : 30;
      this._place(this.compass.mesh, this.vw / 2 - sz / 2, (exit ? 92 : 80) - sz / 2, sz, sz);
      this.compass.mesh.rotation.z = -cmp.angle;
      this.compass.mesh.material.color.set(exit ? '#ffb070' : '#c03020');
    }

    // Callouts, stacked under the crosshair, newest lowest.
    for (const c of this.callouts) {
      c.t += dt;
      const on = play && c.t < c.life;
      c.mesh.visible = on;
      if (!on) continue;
      const pop = 1 + 0.35 * Math.max(0, 1 - c.t / 0.12);
      const fade = Math.min(1, (c.life - c.t) / 0.35);
      const w = 440 * pop;
      const h = (440 * c.ch) / c.cw * pop;
      const y = this.vh / 2 + 70 + c.order * 38 - Math.min(c.t, 0.6) * 12;
      this._place(c.mesh, this.vw / 2 - w / 2, y - h / 2, w, h);
      c.mesh.material.opacity = fade;
    }

    // Announcement: fades in and out over its 3.4 s.
    const a = this.announcement;
    this.announceL.mesh.visible = !!a && this.panel !== 'title';
    if (a) {
      const k = a.t / 3.4;
      const w = Math.min(this.vw * 0.95, 900);
      const h = (w * this.announceL.ch) / this.announceL.cw;
      const grow = 1 + 0.04 * (1 - Math.min(1, a.t / 0.5));
      this._place(this.announceL.mesh, this.vw / 2 - (w * grow) / 2, this.vh * 0.2, w * grow, h * grow);
      this.announceL.mesh.material.opacity = Math.max(0, Math.min(1, a.t / 0.4) * Math.min(1, (1 - k) / 0.25));
    }

    // Numbers over the fills (health, cooldowns): repainted when they change.
    this.topL.mesh.visible = shown && !!L?.top;
    if (this.topL.mesh.visible) {
      const sig = `${Math.ceil(r.health)}/${r.maxHealth}|${SPELL_IDS.map((id) => (r.spells[id] ? Math.ceil(p.spellCd[id] || 0) : 0)).join(',')}|${this.w}x${this.h}`;
      if (sig !== this.topSig) {
        this.topSig = sig;
        this._paintTopLayer();
      }
      const T = L.top;
      this._place(this.topL.mesh, T.x, T.y, T.w, T.h);
    }

    // The hint, above the skills.
    this.hintT = Math.max(0, this.hintT - dt);
    this.hintL.mesh.visible = play && this.hintT > 0 && !!L?.slots?.length;
    if (this.hintL.mesh.visible) {
      const w = Math.min(this.vw * 0.92, 760);
      const h = (w * this.hintL.ch) / this.hintL.cw;
      const top = L.slots[0].y - 46 - h;
      this._place(this.hintL.mesh, this.vw / 2 - w / 2, top, w, h);
      this.hintL.mesh.material.opacity = Math.min(1, this.hintT / 0.5, (6 - this.hintT) / 0.3);
    }

    // Toasts, top right; repainted when they change and while fading.
    const fading = this.toasts.some((t) => t.t > 2.3);
    this.toastT = (this.toastT ?? 0) - dt;
    if (this.toastDirty || (fading && this.toastT <= 0)) {
      this.toastDirty = false;
      this.toastT = 0.08;
      this._paintToastLayer();
    }
    this.toastL.mesh.visible = this.toasts.length > 0 && this.panel !== 'title';
    if (this.toastL.mesh.visible) {
      const w = 340;
      const h = (w * this.toastL.ch) / this.toastL.cw;
      this._place(this.toastL.mesh, this.vw - 18 - w, 64, w, h);
    }
  }

  // Health and cooldown numbers, drawn over their GPU fills.
  _paintTopLayer() {
    const Lr = this.topL;
    const g = Lr.g;
    const T = this.layout.top;
    const k = Lr.cw / T.w;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, Lr.cw, Lr.ch);
    g.setTransform(k, 0, 0, (Lr.ch / T.h), -T.x * k, (-T.y * Lr.ch) / T.h);
    const r = this.info.run;
    const p = this.info.player;
    const H = this.layout.health;
    this._text(g, `${Math.ceil(r.health)} / ${r.maxHealth}`, H.x + H.w / 2, H.y + H.h / 2 + 0.5, { size: 13, ls: 1, color: C.light, align: 'center', base: 'middle', glow: 'rgba(0,0,0,1)' });
    SLOTS.forEach((slot, i) => {
      if (slot.id === 'dodge' || !r.spells[slot.id]) return;
      const cd = Math.ceil(p.spellCd[slot.id] || 0);
      const R = this.layout.slots[i];
      if (cd > 0) this._text(g, String(cd), R.x + R.w / 2, R.y + R.h / 2 + 1, { size: 26, color: C.light, align: 'center', base: 'middle', glow: 'rgba(0,0,0,1)' });
    });
    g.setTransform(1, 0, 0, 1, 0, 0);
    Lr.tex.needsUpdate = true;
  }

  _paintNeedle(g) {
    g.clearRect(0, 0, 64, 64);
    g.translate(32, 32);
    g.fillStyle = '#ffffff';
    g.strokeStyle = 'rgba(30,8,6,0.95)';
    g.lineWidth = 4;
    g.shadowColor = 'rgba(255,80,20,0.9)';
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(0, -24);
    g.lineTo(17, 18);
    g.lineTo(0, 8);
    g.lineTo(-17, 18);
    g.closePath();
    g.stroke();
    g.fill();
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  _paintAnnouncementLayer() {
    const L = this.announceL;
    const g = L.g;
    const a = this.announcement;
    g.clearRect(0, 0, L.cw, L.ch);
    if (!a) return;
    g.save();
    const size = 88;
    this._text(g, a.text.toUpperCase(), L.cw / 2, 110, { size, ls: size * 0.08, color: C.light, align: 'center', glow: 'rgba(190,30,0,0.95)' });
    this._divider(g, L.cw / 2, 140, Math.min(L.cw * 0.6, 760));
    if (a.sub) this._text(g, a.sub, L.cw / 2, 196, { size: 36, ls: 1, color: C.bone, align: 'center' });
    g.restore();
    L.tex.needsUpdate = true;
  }

  _paintToastLayer() {
    const L = this.toastL;
    const g = L.g;
    g.clearRect(0, 0, L.cw, L.ch);
    let y = 34;
    for (const t of this.toasts) {
      const a = Math.min(1, (2.8 - t.t) / 0.5);
      g.globalAlpha = Math.max(0, a);
      const plain = t.text.replace(/<[^>]+>/g, '');
      g.font = `24px ${SERIF}`;
      const tw = Math.min(L.cw - 8, g.measureText(plain).width + 36);
      const x = L.cw - 4 - tw;
      this._box(g, x, y - 25, tw, 50, C.panel, C.edge);
      this._rich(g, t.text, x + 18, y, 24, 'left');
      y += 60;
    }
    g.globalAlpha = 1;
    L.tex.needsUpdate = true;
  }

  // ---- Painting the big canvas -----------------------------------------------

  _paint() {
    const g = this.ctx;
    const s = this.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.buttons = [];
    // Panels lay out in real pixels; the playing HUD in the virtual screen.
    if (this.playing && this.info.run) {
      g.setTransform(s * this.u, 0, 0, s * this.u, 0, 0);
      this._paintPlaying(g);
    } else this.layout = null;
    g.setTransform(s * this.u, 0, 0, s * this.u, 0, 0);
    if (this.panel === 'title') this._paintTitle(g);
    else if (this.panel === 'pause') this._paintPause(g);
    else if (this.panel === 'choice' && this.choice) this._paintChoice(g);
    else if (this.panel === 'death' || this.panel === 'victory') this._paintEnd(g);
  }

  // Text glows softly out of the dark: a wide black-red halo under it (or the
  // given glow colour), never a hard edge. `ls` spaces the letters.
  _text(g, text, x, y, { size = 16, color = C.bone, align = 'left', base = 'alphabetic', glow = null, weight = '', ls = 0 } = {}) {
    g.font = `${weight}${size}px ${SERIF}`;
    g.textAlign = align;
    g.textBaseline = base;
    if ('letterSpacing' in g) g.letterSpacing = `${ls}px`;
    g.shadowColor = glow || 'rgba(30,0,0,0.95)';
    g.shadowBlur = glow ? 20 : Math.max(5, size * 0.45);
    g.fillStyle = color;
    g.fillText(text, x, y);
    g.shadowBlur = 0;
    if ('letterSpacing' in g) g.letterSpacing = '0px';
  }

  // Spaced small capitals for labels.
  _label(g, text, x, y, opts = {}) {
    this._text(g, text.toUpperCase(), x, y, { size: 12, color: C.ash, ls: 2, ...opts });
  }

  // Grain painted once: specks, pits and faint scratches, tiled over panels.
  _grain(g) {
    if (this.grain) return this.grain;
    const c = makeCanvas(96, 96);
    const x = c.getContext('2d');
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 900; i++) {
      x.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.15 + r() * 0.3})` : `rgba(120,30,20,${r() * 0.08})`;
      x.fillRect(r() * 96, r() * 96, 1 + r() * 2, 1 + r() * 2);
    }
    x.strokeStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 6; i++) {
      x.beginPath();
      const sx = r() * 96;
      const sy = r() * 96;
      x.moveTo(sx, sy);
      x.lineTo(sx + (r() - 0.5) * 50, sy + (r() - 0.5) * 20);
      x.stroke();
    }
    this.grain = g.createPattern(c, 'repeat');
    return this.grain;
  }

  // A ragged stroke of old blood with a small diamond at its middle.
  _divider(g, cx, y, w) {
    g.save();
    const grad = g.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    grad.addColorStop(0, 'rgba(120,20,10,0)');
    grad.addColorStop(0.5, 'rgba(150,26,14,0.9)');
    grad.addColorStop(1, 'rgba(120,20,10,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx - w / 2, y);
    for (let i = 0; i <= 24; i++) {
      const k = i / 24;
      g.lineTo(cx - w / 2 + k * w, y - 1.2 - Math.sin(k * 37) * 0.8 * Math.sin(k * Math.PI));
    }
    for (let i = 24; i >= 0; i--) {
      const k = i / 24;
      g.lineTo(cx - w / 2 + k * w, y + 1.2 + Math.cos(k * 29) * 0.8 * Math.sin(k * Math.PI));
    }
    g.fill();
    g.fillStyle = '#c0301a';
    g.shadowColor = 'rgba(255,60,20,0.8)';
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(cx, y - 5);
    g.lineTo(cx + 5, y);
    g.lineTo(cx, y + 5);
    g.lineTo(cx - 5, y);
    g.closePath();
    g.fill();
    g.restore();
  }

  // Tiny markup: <b>..</b> in ember, <span style="color:#hex">..</span>.
  _rich(g, markup, x, y, size, align = 'center') {
    const parts = [];
    const re = /<b>(.*?)<\/b>|<span style="color:([^"]+)">(.*?)<\/span>|([^<]+)|(<[^>]*>)/g;
    let m;
    while ((m = re.exec(markup))) {
      if (m[1] !== undefined) parts.push([m[1], C.ember]);
      else if (m[3] !== undefined) parts.push([m[3], m[2]]);
      else if (m[4] !== undefined) parts.push([m[4].replace(/&mdash;/g, '—').replace(/&middot;/g, '·').replace(/&times;/g, '×'), C.bone]);
    }
    g.font = `${size}px ${SERIF}`;
    const total = parts.reduce((w, [t]) => w + g.measureText(t).width, 0);
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    for (const [t, col] of parts) {
      this._text(g, t, cx, y, { size, color: col, base: 'middle' });
      cx += g.measureText(t).width;
    }
    return total;
  }

  // Every panel: charred fill with grain and a shadow falling away from it,
  // a dark iron frame lined with old blood, and small horns at the corners
  // of the larger ones. `stroke` null draws the fill only.
  _box(g, x, y, w, h, fill = C.panel, stroke = C.edge) {
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.85)';
    g.shadowBlur = 14;
    g.fillStyle = fill;
    g.fillRect(x, y, w, h);
    g.shadowBlur = 0;
    const dark = g.createLinearGradient(0, y, 0, y + h);
    dark.addColorStop(0, 'rgba(60,10,6,0.25)');
    dark.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = dark;
    g.fillRect(x, y, w, h);
    g.fillStyle = this._grain(g);
    g.fillRect(x, y, w, h);
    if (stroke) {
      g.lineWidth = 3;
      g.strokeStyle = C.iron;
      g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
      g.lineWidth = 1;
      g.strokeStyle = stroke;
      g.globalAlpha *= 0.85;
      g.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
      g.globalAlpha /= 0.85;
      if (h >= 26 && w >= 40) {
        g.fillStyle = stroke;
        const horn = Math.min(8, h * 0.22);
        for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
          g.beginPath();
          g.moveTo(cx - sx * 2, cy - sy * 2);
          g.lineTo(cx + sx * horn, cy + sy * 2);
          g.lineTo(cx + sx * 2, cy + sy * horn);
          g.closePath();
          g.fill();
        }
      }
    }
    g.restore();
  }

  // The playing HUD, in the virtual 1280 x 720 screen (vw x vh):
  //
  //   top left    floor and depth; your relics beneath
  //   top right   demons left, deepest floor; toasts below (own layer)
  //   top centre  boss bar; compass (own layer)
  //   centre      crosshair; rhythm ring and callouts (own layers)
  //   bottom      the skill row in the middle, the health vial centred under
  //               it with the potions to its left; the weapon bottom right
  _paintPlaying(g) {
    const w = this.vw;
    const h = this.vh;
    const i = this.info;
    const r = i.run;
    const p = i.player;
    const pad = 20;
    const L = (this.layout = { slots: [], health: null });

    // Top corners (Project 0's own bar sits at the top centre).
    this._text(g, (i.floorLabel || '').toUpperCase(), pad, 32, { size: 15, ls: 1.5, color: C.bone });
    this._text(g, (i.enemyLabel || '').toUpperCase(), w - pad, 32, { size: 15, ls: 1.5, color: C.ember, align: 'right', glow: 'rgba(120,20,0,0.9)' });
    if (i.best) this._label(g, `Deepest: Floor ${i.best}`, w - pad, 52, { size: 11, align: 'right' });

    // Relics, top left: painted icons with their stack counts.
    const relics = Object.entries(r.relics || {});
    if (relics.length) {
      this._label(g, 'Relics', pad, 58, { size: 10 });
      relics.forEach(([id, n], k) => {
        const x = pad + k * 44;
        const y = 66;
        this._box(g, x, y, 40, 40, 'rgba(10,3,3,0.7)', RELICS[id]?.color || C.edge);
        if (!IconAtlas.draw(g, id, x + 2, y + 2, 36)) this._text(g, RELICS[id]?.name[0] || '?', x + 20, y + 21, { size: 18, align: 'center', base: 'middle' });
        if (n > 1) this._text(g, `×${n}`, x + 37, y + 37, { size: 11, color: C.light, align: 'right' });
      });
    }

    // Crosshair.
    g.save();
    g.fillStyle = 'rgba(230,120,70,0.8)';
    g.shadowColor = 'rgba(80,0,0,1)';
    g.shadowBlur = 6;
    g.beginPath();
    g.arc(w / 2, h / 2, 2.5, 0, Math.PI * 2);
    g.fill();
    g.restore();

    if (i.compass?.kind === 'exit' && !this.announcement) this._label(g, 'The portal', w / 2, 132, { size: 12, color: C.ember, align: 'center', glow: 'rgba(160,30,0,0.9)' });

    // Boss bar.
    if (i.boss) {
      const bw = Math.min(680, w * 0.7);
      const bx = (w - bw) / 2;
      this._text(g, i.boss.name.toUpperCase(), w / 2, 140, { size: 18, ls: 2, color: '#f0b080', align: 'center', glow: 'rgba(200,30,0,0.9)' });
      this._box(g, bx, 148, bw, 14, 'rgba(20,4,4,0.85)', '#5a1a10');
      const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, '#6a0a04');
      grad.addColorStop(0.6, '#d4300c');
      grad.addColorStop(1, '#ff8a3a');
      g.fillStyle = grad;
      g.fillRect(bx + 1, 149, (bw - 2) * Math.max(0, i.boss.health / i.boss.maxHealth), 12);
    }

    // ---- Bottom centre: skills, then health beneath ----
    const sz = 66;
    const gap = 22;
    const total = SLOTS.length * sz + (SLOTS.length - 1) * gap;
    let sx = (w - total) / 2;
    const hy = h - pad - 26;
    const sy = hy - 30 - sz - (this.touch ? 80 : 0);
    for (const slot of SLOTS) {
      const isDodge = slot.id === 'dodge';
      const lvl = isDodge ? (r.skills?.phantomStep ? 1 : 0) : r.spells[slot.id];
      g.save();
      this._box(g, sx, sy, sz, sz, C.panel, lvl ? C.edge : '#2a0c08');
      g.globalAlpha = lvl ? 1 : 0.22;
      if (!IconAtlas.draw(g, slot.icon, sx + 4, sy + 4, sz - 8)) {
        const words = (isDodge ? 'Phantom Step' : SPELLS[slot.id].name).toUpperCase().split(' ');
        words.forEach((wd2, k) => this._text(g, wd2, sx + sz / 2, sy + sz / 2 + (k - (words.length - 1) / 2) * 11, { size: 8, ls: 1, align: 'center', base: 'middle' }));
      }
      g.globalAlpha = 1;
      if (!lvl) {
        // Not yet learned: a dark seal over it.
        g.fillStyle = 'rgba(6,2,2,0.45)';
        g.fillRect(sx + 3, sy + 3, sz - 6, sz - 6);
      }
      g.restore();
      // Key, level and name.
      this._text(g, isDodge ? 'A A' : SPELLS[slot.id].label, sx + 7, sy + 15, { size: 13, color: C.ember, glow: 'rgba(140,20,0,0.9)', weight: 'bold ' });
      if (lvl && !isDodge) this._text(g, 'I'.repeat(lvl), sx + sz - 7, sy + sz - 7, { size: 11, color: C.light, align: 'right' });
      const name = isDodge ? 'Phantom Step' : SPELLS[slot.id].name;
      this._text(g, name.toUpperCase(), sx + sz / 2, sy + sz + 13, { size: 8, ls: 0.5, color: lvl ? C.bone : C.ash, align: 'center' });
      L.slots.push({ x: sx + 3, y: sy + 3, w: sz - 6, h: sz - 6 });
      if (this.touch && lvl && !isDodge) this.buttons.push({ x: (sx + sz / 2) * this.u, y: (sy + sz / 2) * this.u, r: (sz / 2) * this.u, code: SPELLS[slot.id].key });
      sx += sz + gap;
    }

    // Health: an iron-framed vial of blood centred under the skills; the
    // blood itself is drawn on the GPU (fill, chip, glow).
    const hw = Math.min(520, w * 0.5);
    const hx = (w - hw) / 2;
    this._box(g, hx, hy, hw, 26, 'rgba(10,2,2,0.92)', C.edge);
    L.health = { x: hx + 5, y: hy + 5, w: hw - 10, h: 16 };
    // The layer the numbers ride on: the skills and the vial, 4:1.
    const tw = Math.max(hw + 40, total + 40, (hy + 30 - (sy - 6)) * 4);
    L.top = { x: (w - tw) / 2, y: hy + 30 - tw / 4, w: tw, h: tw / 4 };
    // Potions to the left of it, with the key.
    for (let k = 0; k < r.potionCap; k++) this._potionIcon(g, hx - 30 - k * 26, hy - 4, k < r.potions);
    this._text(g, 'E', hx - 34 - r.potionCap * 26, hy + 14, { size: 12, color: C.ash, base: 'middle', align: 'right' });
    // Buffs above the skills.
    const tags = [];
    if (p.siphonT > 0) tags.push([`Blood Siphon ${Math.ceil(p.siphonT)}s`, '#ff6a5a']);
    if (p.wrathT > 0) tags.push(['Wrath: next blow counters', '#ff7040']);
    if (p.invuln > 0.25) tags.push(['Invulnerable', '#c9a0ff']);
    if (tags.length) {
      g.font = `12px ${SERIF}`;
      const widths = tags.map(([t]) => g.measureText(t).width + 18);
      let tx = w / 2 - (widths.reduce((a, b) => a + b, 0) + (tags.length - 1) * 8) / 2;
      tags.forEach(([t, c], k) => {
        this._tag(g, t, tx, sy - 18, c);
        tx += widths[k] + 8;
      });
    }

    // Weapon, bottom right: its painted icon, name, kind and personality.
    const unarmed = p?.armed === false;
    const wd = unarmed ? { name: 'Unarmed', type: r.weapon.type, damage: 0, color: C.ash } : r.weapon;
    const def = WEAPON_TYPES[wd.type];
    const dmg = Math.round(wd.damage * r.dmgMul);
    const statLine = wd.damage ? `${def.label} · ${def.style} · ${dmg} dmg${r.speedMul > 1.001 ? ` · +${Math.round((r.speedMul - 1) * 100)}% speed` : ''}`.toUpperCase() : '';
    g.font = `18px ${SERIF}`;
    let need = g.measureText(wd.name).width;
    g.font = `10px ${SERIF}`;
    if ('letterSpacing' in g) g.letterSpacing = '1.5px';
    need = Math.max(need, g.measureText(statLine).width);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    const ww = Math.max(260, need + 108);
    const wh = 78;
    const wx = w - pad - ww;
    const wy = h - pad - wh;
    this._box(g, wx, wy, ww, wh, C.panel, C.edge);
    if (!unarmed) IconAtlas.draw(g, wd.type, wx + 6, wy + 6, wh - 12);
    const tx = wx + wh + 2;
    this._text(g, wd.name, tx, wy + 26, { size: 18, color: wd.color, glow: 'rgba(40,0,0,0.95)' });
    if (wd.damage) {
      this._label(g, statLine, tx, wy + 44, { size: 10, ls: 1.5 });
      const en = wd.enchant && ENCHANTS[wd.enchant];
      if (en) this._text(g, `${PROCS[en.proc].name} on ${en.on === 'hit' ? 'hits' : en.on === 'kill' ? 'kills' : en.on === 'crit' ? 'head hits' : en.on === 'counter' ? 'counters' : 'perfect chains'}`, tx, wy + 62, { size: 11, color: PROCS[en.proc].color });
      else if (wd.type === 'sword') {
        // Momentum: ten pips that heat up as the dance builds.
        const m = Math.floor(p.momentum || 0);
        for (let k = 0; k < MOMENTUM_MAX; k++) {
          g.fillStyle = k < m ? (k >= 7 ? '#ffd070' : '#ff7a2a') : 'rgba(80,20,12,0.6)';
          g.shadowColor = k < m ? 'rgba(255,120,30,0.9)' : 'transparent';
          g.shadowBlur = k < m ? 6 : 0;
          g.fillRect(tx + k * 12, wy + 56, 8, 8);
        }
        g.shadowBlur = 0;
      } else this._text(g, wd.type === 'axe' ? 'Shatters guards · sunders' : 'Crashes through · stuns', tx, wy + 62, { size: 11, color: C.ash });
    }

    // Prompt.
    if (i.prompt) {
      g.font = `18px ${SERIF}`;
      const plain = i.prompt.replace(/<[^>]+>/g, '').replace(/&mdash;/g, '—');
      const pw = Math.min(w - 20, g.measureText(plain).width + 36);
      this._box(g, (w - pw) / 2, h * 0.64 - 21, pw, 42, C.panel, C.edge);
      this._rich(g, i.prompt, w / 2, h * 0.64, 18);
    }

    // Touch controls.
    if (this.touch) this._paintTouch(g);
  }

  _tag(g, text, x, y, color) {
    g.font = `12px ${SERIF}`;
    const tw = g.measureText(text).width + 18;
    this._box(g, x, y - 11, tw, 22, 'rgba(10,3,3,0.75)', color);
    this._text(g, text, x + 9, y, { size: 12, color, base: 'middle' });
    return tw;
  }

  _paintTouch(g) {
    const { vw: w, vh: h, u } = this;
    const btn = (x, y, r, label, code) => {
      g.fillStyle = 'rgba(30,8,6,0.55)';
      g.strokeStyle = 'rgba(255,140,80,0.6)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      this._text(g, label, x, y, { size: 13, align: 'center', base: 'middle', color: C.light });
      this.buttons.push({ x: x * u, y: y * u, r: r * u, code });
    };
    const bx = w - 70;
    const by = h - 170;
    btn(bx, by, 34, 'STRIKE', 'Mouse0');
    if (this.info.run?.skills?.phantomStep) btn(bx - 80, by + 30, 28, 'DODGE', 'Space');
    btn(bx - 40, by - 75, 26, 'POTION', 'KeyE');
    btn(bx + 20, by - 80, 24, 'USE', 'KeyF');
  }

  // A little round-bellied flask: cork, neck, glass body with the blood-red
  // draught and a highlight; an empty one is dark glass.
  _potionIcon(g, x, y, full) {
    const cx = x + 10;
    g.save();
    g.lineWidth = 1.5;
    g.fillStyle = full ? '#8a5a32' : '#3a2a20';
    g.fillRect(cx - 3, y, 6, 4);
    g.fillStyle = full ? 'rgba(200,190,200,0.35)' : 'rgba(80,70,80,0.3)';
    g.strokeStyle = full ? '#d8c8c0' : '#4a3a38';
    g.beginPath();
    g.rect(cx - 2.5, y + 4, 5, 5);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(cx, y + 16, 8, 0, Math.PI * 2);
    g.fillStyle = full ? 'rgba(40,10,14,0.9)' : 'rgba(20,12,14,0.85)';
    g.fill();
    if (full) {
      const lg = g.createRadialGradient(cx - 2, y + 15, 1, cx, y + 17, 8);
      lg.addColorStop(0, '#ff5a4a');
      lg.addColorStop(0.6, '#c8141a');
      lg.addColorStop(1, '#5a0408');
      g.fillStyle = lg;
      g.beginPath();
      g.arc(cx, y + 16, 7, -0.15 * Math.PI, 1.15 * Math.PI, true);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = full ? '#e0c8c0' : '#4a3a38';
    g.beginPath();
    g.arc(cx, y + 16, 8, 0, Math.PI * 2);
    g.stroke();
    if (full) {
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.beginPath();
      g.ellipse(cx - 3.5, y + 13, 1.4, 2.6, -0.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  _dim(g, a = 0.72) {
    g.fillStyle = `rgba(4,1,1,${a})`;
    g.fillRect(0, 0, this.vw, this.vh);
  }

  _paintTitle(g) {
    const { vw: w, vh: h } = this;
    const grad = g.createRadialGradient(w / 2, h * 0.6, 0, w / 2, h * 0.6, Math.max(w, h) * 0.75);
    grad.addColorStop(0, 'rgba(40,4,2,0.1)');
    grad.addColorStop(1, 'rgba(4,1,1,0.78)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const big = Math.max(30, Math.min(88, w * 0.072));
    let y = h * 0.3;
    this._text(g, 'THE DEMON DESCENT', w / 2, y, { size: big, ls: big * 0.06, color: '#f4c8a0', align: 'center', glow: 'rgba(190,25,0,1)' });
    this._divider(g, w / 2, y + big * 0.3, Math.min(w * 0.6, big * 9));
    y += big * 0.75;
    this._text(g, 'Twenty floors down. One life. No armour. No mercy.', w / 2, y, { size: Math.max(13, big * 0.22), ls: 1, color: C.bone, align: 'center' });
    y += big * 0.9;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 2.6);
    g.font = `${Math.max(16, big * 0.27)}px ${SERIF}`;
    const label = this.touch ? 'Tap to enter the pit' : 'Click to enter the pit';
    const bw = g.measureText(label).width + 48;
    this._box(g, (w - bw) / 2, y - 24, bw, 48, `rgba(${40 + pulse * 30},6,4,0.88)`, '#8a2210');
    this._text(g, label.toUpperCase(), w / 2, y, { size: Math.max(14, big * 0.22), ls: 2, color: C.light, align: 'center', base: 'middle', glow: `rgba(200,40,0,${0.5 + pulse * 0.4})` });
    y += 50;
    const t = this.titleInfo;
    const best = t.best ? `Your deepest descent: Floor ${t.best}` : 'No soul has yet returned from the pit.';
    this._text(g, best, w / 2, y, { size: 15, align: 'center' });
    y += 22;
    if (t.dev) {
      this._text(g, t.dev, w / 2, y, { size: 13, color: '#c9a0ff', align: 'center' });
      y += 20;
    }
    // This week's deepest descents.
    const table = (t.table || []).slice(0, 5);
    if (table.length) {
      y += 8;
      this._label(g, "This week's deepest", w / 2, y, { align: 'center' });
      y += 18;
      table.forEach((row, k) => {
        this._text(g, `${k + 1}. ${row.name}`, w / 2 - 10, y, { size: 13, color: row.you ? C.ember : C.bone, align: 'right' });
        this._text(g, `Floor ${row.score}`, w / 2 + 10, y, { size: 13, color: row.you ? C.ember : C.bone });
        y += 17;
      });
    }
    // Controls.
    if (!this.touch && h > 420) {
      const rows = [
        ['W A S D', 'move', 'Mouse', 'aim'],
        ['Click / hold', 'light / heavy', 'Right button', 'block'],
        ['Click as it lands', 'Perfect Chain', 'Hit a wind-up', 'counter'],
        ['A A / D D', 'dodge (once learned)', '', ''],
        ['E', 'drink potion', '1 2 3', 'demon spells'],
        ['F', 'take / use', '', ''],
      ];
      let cy = Math.max(y + 20, h - 24 - rows.length * 19);
      this._box(g, w / 2 - 210, cy - 22, 420, rows.length * 19 + 18, 'rgba(10,2,2,0.7)', C.edge);
      for (const [a, b, c2, d] of rows) {
        this._text(g, a, w / 2 - 190, cy, { size: 13, color: C.bone });
        this._text(g, b, w / 2 - 80, cy, { size: 13, color: C.ash });
        this._text(g, c2, w / 2 + 30, cy, { size: 13, color: C.bone });
        this._text(g, d, w / 2 + 140, cy, { size: 13, color: C.ash });
        cy += 19;
      }
    }
  }

  _paintPause(g) {
    this._dim(g);
    const relics = Object.entries(this.info.run?.relics || {});
    const y0 = relics.length ? this.vh * 0.22 : this.vh * 0.45;
    const pw = Math.min(420, this.vw - 40);
    this._box(g, (this.vw - pw) / 2, y0 - 62, pw, 112, C.panel, C.edge);
    this._text(g, 'PAUSED', this.vw / 2, y0, { size: 40, ls: 4, color: C.light, align: 'center', glow: 'rgba(190,30,0,0.9)' });
    this._divider(g, this.vw / 2, y0 + 14, pw * 0.7);
    this._label(g, 'Click to return to the dark', this.vw / 2, y0 + 36, { align: 'center', color: C.bone });
    if (!relics.length) return;
    // Your relics, and what each one does.
    const bw = Math.min(640, this.vw - 40);
    const rowH = 52;
    const bx = (this.vw - bw) / 2;
    let y = y0 + 80;
    this._box(g, bx, y, bw, relics.length * rowH + 40, C.panel, C.edge);
    this._label(g, 'Relics carried', this.vw / 2, y + 24, { align: 'center', size: 12 });
    y += 36;
    for (const [id, n] of relics) {
      const R = RELICS[id];
      if (!R) continue;
      IconAtlas.draw(g, id, bx + 14, y + 2, 44);
      this._text(g, n > 1 ? `${R.name}  ×${n}` : R.name, bx + 70, y + 20, { size: 17, color: R.color });
      this._wrap(g, R.text, bx + 70, y + 40, bw - 90, 12, C.bone);
      y += rowH;
    }
  }

  _paintChoice(g) {
    const { vw: w, vh: h } = this;
    this._dim(g, 0.55);
    const c = this.choice;
    this._text(g, c.title.toUpperCase(), w / 2, h * 0.3, { size: Math.min(34, w * 0.06), ls: 3, color: C.light, align: 'center', glow: 'rgba(190,30,0,0.9)' });
    this._divider(g, w / 2, h * 0.3 + 12, Math.min(420, w * 0.6));
    const bw = Math.min(560, w - 30);
    let y = h * 0.3 + 30;
    c.options.forEach((o, k) => {
      const bh = o.detail ? 62 : 46;
      this._box(g, (w - bw) / 2, y, bw, bh, C.panel, C.edge);
      this._text(g, String(k + 1), (w - bw) / 2 + 22, y + bh / 2, { size: 26, color: C.ember, align: 'center', base: 'middle' });
      this._text(g, o.label, (w - bw) / 2 + 46, y + (o.detail ? 22 : bh / 2), { size: 17, base: 'middle' });
      if (o.detail) this._wrap(g, o.detail, (w - bw) / 2 + 46, y + 42, bw - 60, 12, C.ash);
      this.buttons.push({ x: (w / 2) * this.u, y: (y + bh / 2) * this.u, w: bw * this.u, h: bh * this.u, code: `Digit${k + 1}`, rect: true });
      y += bh + 10;
    });
    this._label(g, this.touch ? 'Tap a blessing · only one altar may be woken' : 'Press 1 or 2 to choose · Q to step back · only one altar may be woken', w / 2, y + 22, { size: 11, align: 'center' });
  }

  _wrap(g, text, x, y, maxW, size, color) {
    g.font = `${size}px ${SERIF}`;
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > maxW && line) {
        this._text(g, line, x, y, { size, color });
        y += size + 3;
        line = word;
      } else line = test;
    }
    if (line) this._text(g, line, x, y, { size, color });
  }

  _paintEnd(g) {
    const { vw: w, vh: h } = this;
    const won = this.panel === 'victory';
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, won ? 'rgba(80,30,0,0.5)' : 'rgba(60,0,0,0.55)');
    grad.addColorStop(1, won ? 'rgba(4,1,0,0.9)' : 'rgba(4,0,0,0.92)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const e = this.endInfo || {};
    const big = Math.max(40, Math.min(110, w * 0.09));
    this._text(g, won ? 'HELL IS CONQUERED' : 'YOU DIED', w / 2, h * 0.36, { size: won ? big * 0.75 : big, ls: big * 0.08, color: won ? '#ffd28a' : '#c01a0e', align: 'center', glow: won ? 'rgba(255,120,0,0.8)' : 'rgba(120,0,0,1)' });
    this._divider(g, w / 2, h * 0.36 + 16, Math.min(w * 0.6, big * 7));
    let y = h * 0.36 + 46;
    for (const line of e.lines || []) {
      this._text(g, line, w / 2, y, { size: 17, align: 'center' });
      y += 24;
    }
    y += 18;
    const stats = e.stats || [];
    const colW = Math.min(140, (w - 40) / Math.max(1, stats.length));
    stats.forEach(([label, value], k) => {
      const x = w / 2 + (k - (stats.length - 1) / 2) * colW;
      this._label(g, label, x, y, { size: 10, align: 'center' });
      this._text(g, String(value), x, y + 32, { size: 28, color: C.ember, align: 'center', glow: 'rgba(160,30,0,0.9)' });
    });
    if (e.ready) this._label(g, this.touch ? 'Tap to rise again at the surface' : 'Click to rise again at the surface', w / 2, y + 80, { size: 12, align: 'center', color: C.bone });
  }
}
