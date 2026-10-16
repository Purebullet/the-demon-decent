import * as THREE from 'three';
import { SPELLS, SPELL_IDS, spellUsesLeft } from '../entities/Spells.js';
import { WEAPON_TYPES, RARITIES } from '../entities/Weapons.js';
import { xpToNext, MAX_LEVEL, damageMul, swingSpeedMul } from '../game/Levels.js';
import { makeCanvas } from '../world/Textures.js';
import { IconAtlas } from './IconAtlas.js';
import { RELICS, relicPassive } from '../combat/Relics.js';
import { PROCS, ENCHANTS } from '../combat/Procs.js';
import { MOMENTUM_MAX } from '../combat/Styles.js';
import { WINDOW_EARLY, WINDOW_LATE, CHAIN_MAX } from '../combat/Rhythm.js';

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
// A rounded rectangle path (without relying on the canvas's own roundRect).
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
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
// The Back buttons' glow and rim.
const BACK_HUE = { glow: 'rgba(200,50,0,0.85)', accent: '#a8401c' };

// Room left at the top of the screen for Project 0's own bar and labels
// (the lot's name, who is here), above the floor and demon counts.
const TOP = 46;

// Skill slots along the bottom: the three demon spells, then Phantom Step.
const SLOTS = SPELL_IDS.map((id) => ({ id, icon: id }));

const FULL_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }';
const QUAD_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

const VIGNETTE_FRAG = `
  varying vec2 vUv;
  uniform float uHurt; uniform float uLow; uniform float uFade; uniform float uPulse; uniform float uHeal;
  uniform vec2 uDir; uniform float uBlow;
  void main(){
    vec2 c = vUv - 0.5;
    float edge = smoothstep(0.32, 0.75, length(c * vec2(1.4, 1.0)));
    // A blow reddens the side it came from hardest.
    float side = max(0.0, dot(normalize(c + 1e-4), uDir));
    float blow = smoothstep(0.3, 0.75, length(c * vec2(1.4, 1.0))) * uBlow * (0.2 + 0.8 * side * side);
    vec3 col = mix(vec3(0.45, 0.0, 0.0), vec3(0.9, 0.12, 0.05), uHeal);
    float a = edge * (uHurt * 0.45 + uLow * (0.35 + 0.25 * uPulse) + uHeal * 0.35) + blow * 0.6;
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
  uniform float uFrac; uniform float uChip; uniform float uHeal; uniform float uLow; uniform float uTime; uniform float uHit;
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
    // Struck: the blood flares white-hot and the lost chip burns.
    col = mix(col, vec3(1.0, 0.78, 0.6), uHit * 0.55);
    vec3 chipCol = mix(vec3(0.75, 0.32, 0.18), vec3(1.0, 0.8, 0.5), uHit);
    vec3 c = col * fill + chipCol * chip;
    float a = fill + chip * 0.8;
    gl_FragColor = vec4(c, a);
  }`;

// Blood thrown across the lens by a blow: one splat of the atlas (four
// splats in a 2 x 2 grid), thick blood darker, thin spray brighter.
const SPLAT_FRAG = `
  varying vec2 vUv;
  uniform sampler2D uMap; uniform vec2 uCell; uniform float uAlpha; uniform float uRot;
  void main(){
    vec2 p = vUv - 0.5;
    float cs = cos(uRot), sn = sin(uRot);
    p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y) + 0.5;
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) discard;
    float m = texture2D(uMap, (p + uCell) * 0.5).r;
    float a = smoothstep(0.22, 0.42, m) * uAlpha;
    // Thin spray bright red, the thick of it near black.
    vec3 col = mix(vec3(0.46, 0.02, 0.01), vec3(0.11, 0.0, 0.0), smoothstep(0.45, 1.0, m));
    gl_FragColor = vec4(col, a * mix(0.7, 0.92, smoothstep(0.4, 0.9, m)));
  }`;

// A meter (the guard under the crosshair, the sprint over the health):
// fill, dark track, and a red flicker when it is about to run out.
const BAR_FRAG = `
  varying vec2 vUv;
  uniform float uFrac; uniform vec3 uColor; uniform vec3 uLow; uniform float uWarn; uniform float uAlpha; uniform float uTime;
  void main(){
    float inside = step(vUv.x, uFrac);
    float flash = uWarn * (0.55 + 0.45 * sin(uTime * 24.0));
    vec3 col = mix(uColor, uLow, clamp(uWarn * 1.4, 0.0, 1.0)) + vec3(0.4, 0.1, 0.05) * flash;
    float edge = smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y) * smoothstep(0.0, 0.02, vUv.x) * smoothstep(1.0, 0.98, vUv.x);
    vec3 c = mix(vec3(0.07, 0.02, 0.02), col, inside);
    gl_FragColor = vec4(c, (inside * 0.95 + (1.0 - inside) * 0.5) * edge * uAlpha);
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
      uniforms: { uHurt: { value: 0 }, uLow: { value: 0 }, uFade: { value: 1 }, uPulse: { value: 0 }, uHeal: { value: 0 }, uDir: { value: new THREE.Vector2(0, 1) }, uBlow: { value: 0 } },
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
    this.healthFx = shader(HEALTH_FRAG, { uFrac: { value: 1 }, uChip: { value: 1 }, uHeal: { value: 0 }, uLow: { value: 0 }, uTime: { value: 0 }, uHit: { value: 0 } }, 3);
    this.chip = 1;
    this.chipHold = 0;
    // The health vial is its own little group (frame, blood, numbers) so a
    // blow can shake it; and the amount lost rises off it.
    const bar = (color, low) => ({ mesh: shader(BAR_FRAG, { uFrac: { value: 1 }, uColor: { value: new THREE.Color(color) }, uLow: { value: new THREE.Color(low) }, uWarn: { value: 0 }, uAlpha: { value: 0 }, uTime: { value: 0 } }, 5), a: 0 });
    this.guardBar = bar('#d8c2a0', '#e02a10');
    this.sprintBar = bar('#7fc4ff', '#e02a10');
    this.healthBack = this._canvasLayer(16, 16, 2.5);
    this.healthTop = this._canvasLayer(16, 16, 4);
    this.lossL = this._canvasLayer(256, 96, 4);
    // Our own cursor, a small sword, for when the mouse is free (menus, the
    // pause, choosing at an altar).
    this.cursorL = this._spriteLayer(96, 96, 30, (g) => this._paintCursor(g));
    this.cursor = { on: false, x: 0, y: 0 };
    this.hoverCode = null;
    this.hpFx = { shake: 0, hit: 0, loss: 0, lossT: 9, sig: '', back: '' };
    // Blood on the lens.
    const atlas = new THREE.CanvasTexture(splatAtlas());
    atlas.generateMipmaps = false;
    atlas.minFilter = THREE.LinearFilter;
    this.splats = Array.from({ length: 7 }, () => ({
      mesh: shader(SPLAT_FRAG, { uMap: { value: atlas }, uCell: { value: new THREE.Vector2() }, uAlpha: { value: 0 }, uRot: { value: 0 } }, 1.5),
      t: 9,
      life: 1,
    }));
    this.compass = this._spriteLayer(64, 64, 6, (g) => this._paintNeedle(g));
    // The boss's health: a gradient quad over the bar the canvas paints.
    this.bossFill = this._spriteLayer(64, 4, 6, (g) => {
      const grad = g.createLinearGradient(0, 0, 64, 0);
      grad.addColorStop(0, '#6a0a04');
      grad.addColorStop(0.6, '#d4300c');
      grad.addColorStop(1, '#ff8a3a');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 4);
    });
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
    if (!info.ready) this.endShownAt = this.time;
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

  // A level gained: { level, points, stats: [{ id, name, text, color, per,
  // have, cap }] } (Game._levelUpInfo).
  showLevelUp(info) {
    this.levelInfo = info;
    this.panel = 'levelup';
    this.levelShownAt = this.time;
    this.dirty = true;
  }

  // The level-up cards wake (light up and take a click) only when armed.
  setLevelArmed(on) {
    if (on === this.levelArmed) return;
    this.levelArmed = on;
    this.dirty = true;
  }

  hideLevelUp() {
    this.levelInfo = null;
    if (this.panel === 'levelup') this.panel = null;
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

  // Where the mouse is, and whether to draw the sword cursor there. Over a
  // choice, the option under it lights up.
  setCursor(on, x, y) {
    const c = this.cursor;
    c.on = on;
    c.x = x;
    c.y = y;
    const code = on && (this.panel === 'choice' || this.panel === 'levelup' || this.panel === 'pause' || this.panel === 'death' || this.panel === 'victory') ? this.buttonAt(x, y) : null;
    if (code !== this.hoverCode) {
      this.hoverCode = code;
      this.dirty = true;
    }
  }

  _paintCursor(g) {
    g.clearRect(0, 0, 96, 96);
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Point at the top left (the hot spot), the hilt down and to the right.
    const tip = [5, 5];
    const guard = [56, 56];
    const end = [82, 82];
    const blade = () => {
      g.beginPath();
      g.moveTo(tip[0], tip[1]);
      g.lineTo(guard[0] - 6, guard[1] + 4);
      g.lineTo(guard[0] + 4, guard[1] - 6);
      g.closePath();
    };
    // A dark outline so it reads on light and dark alike, then an ember glow.
    g.shadowColor = 'rgba(255,70,10,0.9)';
    g.shadowBlur = 8;
    g.lineWidth = 5;
    g.strokeStyle = '#1a0806';
    blade();
    g.stroke();
    g.shadowBlur = 0;
    const steel = g.createLinearGradient(tip[0], tip[1], guard[0], guard[1]);
    steel.addColorStop(0, '#fff6e6');
    steel.addColorStop(0.6, '#c9c0b2');
    steel.addColorStop(1, '#8a8276');
    g.fillStyle = steel;
    blade();
    g.fill();
    // The fuller: a dark groove down the middle, a hot edge on one side.
    g.lineWidth = 1.4;
    g.strokeStyle = 'rgba(60,40,30,0.7)';
    g.beginPath();
    g.moveTo(tip[0] + 10, tip[1] + 10);
    g.lineTo(guard[0] - 4, guard[1] - 4);
    g.stroke();
    g.strokeStyle = 'rgba(255,120,40,0.9)';
    g.beginPath();
    g.moveTo(tip[0] + 2, tip[1] + 3);
    g.lineTo(guard[0] - 6, guard[1] + 3);
    g.stroke();
    // Crossguard, grip, pommel.
    g.lineWidth = 7;
    g.strokeStyle = '#1a0806';
    g.beginPath();
    g.moveTo(guard[0] - 13, guard[1] + 13);
    g.lineTo(guard[0] + 13, guard[1] - 13);
    g.stroke();
    g.lineWidth = 4;
    g.strokeStyle = '#7a1a0e';
    g.stroke();
    g.lineWidth = 7;
    g.strokeStyle = '#1a0806';
    g.beginPath();
    g.moveTo(guard[0] + 2, guard[1] + 2);
    g.lineTo(end[0] - 6, end[1] - 6);
    g.stroke();
    g.lineWidth = 4;
    g.strokeStyle = '#3a2416';
    g.stroke();
    g.fillStyle = '#1a0806';
    g.beginPath();
    g.arc(end[0] - 4, end[1] - 4, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e8441a';
    g.shadowColor = 'rgba(255,80,20,1)';
    g.shadowBlur = 6;
    g.beginPath();
    g.arc(end[0] - 4, end[1] - 4, 3.5, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // A demon's blow landed. `angle`: where it came from, relative to where
  // you face (0 ahead, positive to the right). The view reddens on that side,
  // blood is thrown across the lens, and the health vial jolts, flares and
  // sheds the amount lost.
  playerHurt(amount, angle, { blocked = false, burn = false, max = 100 } = {}) {
    const k = clamp01(amount / Math.max(1, max * 0.25));
    const F = this.hpFx;
    if (burn) {
      F.shake = Math.min(1.2, F.shake + 0.18);
      F.hit = Math.max(F.hit, 0.45);
      return;
    }
    F.shake = Math.min(1.2, F.shake + (blocked ? 0.35 : 0.65 + k * 0.5));
    F.hit = 1;
    F.loss = Math.round(amount);
    F.lossT = 0;
    F.lossX = this.vial ? this.vial.x + this.vial.w * clamp01(this.info.run ? this.info.run.health / this.info.run.maxHealth : 1) : 0;
    this._paintLoss(F.loss, blocked);
    if (blocked) return;
    this.blow = Math.min(1, 0.6 + k);
    this.vignette.uniforms.uDir.value.set(Math.sin(angle), Math.cos(angle));
    const n = 1 + (k > 0.3 ? 1 : 0) + (k > 0.65 ? 1 : 0);
    for (let i = 0; i < n; i++) this._splat(angle, k);
  }

  // One splat of blood near the edge on the side the blow came from (from
  // ahead, high on either side; never over the middle of the view).
  _splat(angle, k) {
    const sp = this.splats.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b));
    const sx = Math.sin(angle);
    const side = Math.abs(sx) > 0.35 ? Math.sign(sx) : Math.random() < 0.5 ? -1 : 1;
    const behind = Math.cos(angle) < -0.3;
    sp.x = side > 0 ? 0.84 + Math.random() * 0.2 : -0.04 + Math.random() * 0.2;
    sp.y = behind ? 0.55 + Math.random() * 0.45 : 0.08 + Math.random() * 0.8;
    sp.size = 0.26 + Math.random() * 0.12 + k * 0.1;
    sp.t = 0;
    sp.life = 1.9 + Math.random() * 0.8;
    const U = sp.mesh.material.uniforms;
    const cell = Math.floor(Math.random() * 4);
    U.uCell.value.set(cell % 2, Math.floor(cell / 2));
    U.uRot.value = Math.random() * Math.PI * 2;
  }

  _updateSplats(dt, shown) {
    for (const sp of this.splats) {
      sp.t += dt;
      const on = shown && sp.t < sp.life;
      sp.mesh.visible = on;
      if (!on) continue;
      const k = sp.t / sp.life;
      const a = Math.min(1, sp.t / 0.05) * (k < 0.45 ? 1 : 1 - (k - 0.45) / 0.55);
      sp.mesh.material.uniforms.uAlpha.value = a * 0.9;
      // It lands with a slap and runs a little.
      const s = this.vh * sp.size * (1 + 0.25 * Math.max(0, 1 - sp.t / 0.08) + 0.05 * k);
      this._place(sp.mesh, sp.x * this.vw - s / 2, sp.y * this.vh - s / 2 + k * this.vh * 0.035, s, s);
    }
  }

  // The vial: frame and numbers on small canvases, the blood on the GPU,
  // shaken together when you are struck.
  _updateVial(dt, shown, play) {
    const F = this.hpFx;
    const L = this.layout;
    F.shake = Math.max(0, F.shake - dt * 2.4);
    F.hit = Math.max(0, F.hit - dt * 3.5);
    F.lossT += dt;
    const vis = shown && !!L?.vial;
    this.healthBack.mesh.visible = this.healthTop.mesh.visible = vis;
    this.lossL.mesh.visible = vis && play && F.lossT < 1.1;
    if (!vis) return;
    const r = this.info.run;
    const V = (this.vial = L.vial);
    const R = { x: V.x - 14, y: V.y - 14, w: V.w + 28, h: V.h + 28 };
    const px = this.u * this.scale;
    const backSig = `${R.x}|${R.y}|${R.w}|${px}`;
    if (backSig !== F.back) {
      F.back = backSig;
      F.sig = '';
      for (const l of [this.healthBack, this.healthTop]) this._fit(l, R.w * px, R.h * px);
      const g = this._onLayer(this.healthBack, R);
      this._box(g, V.x, V.y, V.w, V.h, 'rgba(10,2,2,0.92)', C.edge);
      this.healthBack.tex.needsUpdate = true;
    }
    const sig = `${Math.ceil(r.health)}/${r.maxHealth}`;
    if (sig !== F.sig) {
      F.sig = sig;
      const g = this._onLayer(this.healthTop, R);
      this._text(g, `${Math.ceil(Math.max(0, r.health))} / ${r.maxHealth}`, V.x + V.w / 2, V.y + V.h / 2 + 0.5, { size: 13, ls: 1, color: C.light, align: 'center', base: 'middle', glow: 'rgba(0,0,0,1)' });
      this.healthTop.tex.needsUpdate = true;
    }
    const sh = F.shake * F.shake;
    const t = this.time;
    const ox = (Math.sin(t * 83) * 0.65 + Math.sin(t * 47) * 0.35) * sh * 10;
    const oy = Math.cos(t * 71) * sh * 4;
    this._place(this.healthBack.mesh, R.x + ox, R.y + oy, R.w, R.h);
    this._place(this.healthTop.mesh, R.x + ox, R.y + oy, R.w, R.h);
    const b = L.health;
    this._place(this.healthFx, b.x + ox, b.y + oy, b.w, b.h);
    this.healthFx.material.uniforms.uHit.value = F.hit;
    if (this.lossL.mesh.visible) {
      const k = F.lossT / 1.1;
      const w = 78;
      const h = (w * this.lossL.ch) / this.lossL.cw;
      this._place(this.lossL.mesh, F.lossX - w / 2 + ox, V.y - h * 0.9 - k * 26, w, h);
      this.lossL.mesh.material.opacity = Math.min(1, (1 - k) * 3);
    }
  }

  // The guard's strength under the crosshair while you block (flickering
  // red as it is about to give), and the sprint's over the health vial.
  _updateMeters(dt, play) {
    const p = this.info.player;
    const meter = (b, want, frac, warn, x, y, w, h) => {
      b.a += ((play && want ? 1 : 0) - b.a) * Math.min(1, dt * (want ? 14 : 4));
      b.mesh.visible = b.a > 0.01;
      if (!b.mesh.visible) return;
      const U = b.mesh.material.uniforms;
      U.uFrac.value = frac;
      U.uWarn.value = warn;
      U.uAlpha.value = b.a;
      U.uTime.value = this.time;
      this._place(b.mesh, x, y, w, h);
    };
    if (!p) return;
    const g = p.guard ?? 1;
    meter(this.guardBar, p.blocking || g < 0.999, g, p.guardSpent ? 1 : p.blocking ? clamp01((0.4 - g) / 0.25) : 0, this.vw / 2 - 60, this.vh / 2 + 30, 120, 7);
    const V = this.vial;
    const sp = p.sprint ?? 1;
    if (V) meter(this.sprintBar, sp < 0.999, sp, p.sprintSpent ? 1 : clamp01((0.3 - sp) / 0.2) * (p.sprinting ? 1 : 0), V.x + 6, V.y - 10, V.w - 12, 5);
  }

  _paintLoss(amount, blocked) {
    const L = this.lossL;
    const g = L.g;
    g.clearRect(0, 0, L.cw, L.ch);
    g.font = `bold 64px ${SERIF}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 8;
    g.strokeStyle = 'rgba(30,0,0,0.95)';
    g.strokeText(`-${amount}`, L.cw / 2, L.ch / 2);
    g.fillStyle = blocked ? '#c8a080' : '#ff3a22';
    g.shadowColor = 'rgba(255,40,10,0.8)';
    g.shadowBlur = blocked ? 0 : 16;
    g.fillText(`-${amount}`, L.cw / 2, L.ch / 2);
    g.shadowBlur = 0;
    L.tex.needsUpdate = true;
  }

  // Resize a canvas layer's canvas.
  _fit(L, w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (L.canvas.width === w && L.canvas.height === h) return;
    L.canvas.width = L.cw = w;
    L.canvas.height = L.ch = h;
    L.tex.dispose();
    L.tex.needsUpdate = true;
  }

  // Clear a layer and set it up to paint the virtual rect R.
  _onLayer(L, R) {
    const g = L.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, L.cw, L.ch);
    g.setTransform(L.cw / R.w, 0, 0, L.ch / R.h, (-R.x * L.cw) / R.w, (-R.y * L.ch) / R.h);
    return g;
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
    this.blow = Math.max(0, (this.blow || 0) - dt * 1.6);
    V.uBlow.value = this.playing ? this.blow : 0;

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
    // (Spell cooldowns have their own layer, and the boss's health its own
    // bar on the GPU: neither repaints the whole interface.)
    return [
      this.panel,
      r.potions,
      r.potionCap,
      r.weapon.name,
      r.weapon.rarity,
      r.level,
      r.points,
      Math.floor((r.xp / xpToNext(r.level)) * 100),
      r.weapon.damage,
      p?.armed,
      r.dmgMul.toFixed(2),
      r.speedMul.toFixed(2),
      JSON.stringify(r.stats),
      JSON.stringify(r.spells),
      JSON.stringify(r.spellUses || {}),
      JSON.stringify(r.relics),
      i.floorLabel,
      i.enemyLabel,
      i.best,
      i.prompt,
      i.boss?.name || '',
      i.compass?.kind || '',
      p?.siphonT > 0,
      p?.wrathT > 0,
      p?.burnT > 0,
      p?.flameT > 0,
      p?.coatT > 0,
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
      const lvl = r.spells[slot.id];
      // A spell just learned (or raised a level): its slot flashes a while.
      if (f.run === r && lvl > f.level) f.learned = 3.2;
      f.run = r;
      f.level = lvl;
      f.learned = Math.max(0, (f.learned || 0) - dt);
      const learn = f.learned > 0 ? Math.min(1, f.learned) * (0.45 + 0.55 * Math.abs(Math.sin(this.time * 6))) : 0;
      cd = lvl ? clamp01((p.spellCd[slot.id] || 0) / SPELLS[slot.id].levels[lvl - 1].cd) : 0;
      cast = (p.spellCast?.[slot.id] || 0) / 0.6;
      if (f.lastCd > 0 && cd === 0) f.ready = 1;
      f.lastCd = cd;
      f.ready = Math.max(0, f.ready - dt * 2);
      f.denied = Math.max(0, f.denied - dt * 4);
      U.uCd.value = cd;
      U.uFlash.value = Math.max(clamp01(cast), learn * 0.7);
      U.uReady.value = Math.max(f.ready * (0.6 + 0.4 * Math.sin(this.time * 20)), learn);
      U.uDenied.value = f.denied;
      U.uColor.value.set(slot.id === 'nova' ? '#ff7a24' : slot.id === 'step' ? '#b080ff' : slot.id === 'siphon' ? '#ff3a2a' : '#c8b8ff');
      // A cast swells the slot for a moment.
      const bump = 1 + 0.12 * clamp01(cast) + 0.1 * learn;
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
    }
    this._updateVial(dt, shown, play);
    this._updateMeters(dt, play);
    // The cursor: its tip on the mouse.
    const cur = this.cursor;
    this.cursorL.mesh.visible = cur.on;
    if (cur.on) {
      const s = 30;
      this._place(this.cursorL.mesh, cur.x / this.u - s * (5 / 96), cur.y / this.u - s * (5 / 96), s, s);
    }
    this._updateSplats(dt, shown);

    // Compass needle.
    // The boss's blood, as long as its share of the bar.
    const bb = L?.boss;
    this.bossFill.mesh.visible = shown && !!bb && !!i.boss;
    if (this.bossFill.mesh.visible) {
      const k = Math.max(0, Math.min(1, i.boss.health / i.boss.maxHealth));
      this._place(this.bossFill.mesh, bb.x, bb.y, Math.max(0.01, bb.w * k), bb.h);
    }

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
      const sig = `${SPELL_IDS.map((id) => (r.spells[id] ? Math.ceil(p.spellCd[id] || 0) : 0)).join(',')}|${this.w}x${this.h}`;
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
      this._place(this.toastL.mesh, this.vw - 18 - w, TOP + 64, w, h);
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
    SLOTS.forEach((slot, i) => {
      if (!r.spells[slot.id]) return;
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
    // As large as fits across the layer.
    const title = a.text.toUpperCase();
    const size = Math.min(88, (88 * (L.cw - 40)) / Math.max(1, this._measure(g, title, { size: 88, ls: 88 * 0.08 })));
    this._text(g, title, L.cw / 2, 110, { size, ls: size * 0.08, color: C.light, align: 'center', glow: 'rgba(190,30,0,0.95)' });
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
    else if (this.panel === 'levelup' && this.levelInfo) this._paintLevelUp(g);
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
    this._text(g, (i.floorLabel || '').toUpperCase(), pad, TOP + 32, { size: 15, ls: 1.5, color: C.bone });
    this._text(g, (i.enemyLabel || '').toUpperCase(), w - pad, TOP + 32, { size: 15, ls: 1.5, color: C.ember, align: 'right', glow: 'rgba(120,20,0,0.9)' });
    if (i.best) this._label(g, `Deepest: Floor ${i.best}`, w - pad, TOP + 52, { size: 11, align: 'right' });

    // Relics, top left: painted icons with their stack counts.
    const relics = Object.entries(r.relics || {});
    if (relics.length) {
      this._label(g, 'Relics', pad, TOP + 58, { size: 10 });
      relics.forEach(([id, n], k) => {
        const x = pad + k * 44;
        const y = TOP + 66;
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
      g.fillStyle = 'rgba(30,4,2,0.9)';
      g.fillRect(bx + 1, 149, bw - 2, 12);
      // (The blood in it is its own quad: _updateLayers.)
      this.layout.boss = { x: bx + 1, y: 149, w: bw - 2, h: 12 };
    } else if (this.layout) this.layout.boss = null;

    // The weapon card's width (it is drawn last, bottom right).
    const unarmed = p?.armed === false;
    const wd = unarmed ? { name: 'Unarmed', type: r.weapon.type, damage: 0, color: C.ash } : r.weapon;
    const def = WEAPON_TYPES[wd.type];
    const R = unarmed ? null : RARITIES[wd.rarity];
    const dmg = Math.round(wd.damage * damageMul(r));
    const spd = swingSpeedMul(r);
    const statLine = wd.damage ? `${R ? `${R.name} · ` : ''}${def.label} · ${def.style} · ${dmg} dmg${spd > 1.001 ? ` · +${Math.round((spd - 1) * 100)}% speed` : ''}`.toUpperCase() : '';
    g.font = `18px ${SERIF}`;
    let need = g.measureText(wd.name).width;
    g.font = `10px ${SERIF}`;
    if ('letterSpacing' in g) g.letterSpacing = '1.5px';
    need = Math.max(need, g.measureText(statLine).width);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    const ww = Math.max(260, need + 108);

    // ---- Bottom centre: skills, then health beneath ----
    const sz = 66;
    const gap = 22;
    const total = SLOTS.length * sz + (SLOTS.length - 1) * gap;
    const hy = h - pad - 26;
    // The vial centred under the skills, the potions and their key to its
    // left. On Project 0 its chat sits bottom left: all of it keeps to the
    // right of that (and left of the weapon), the vial shortened if it must.
    let hw = Math.min(520, w * 0.5);
    let hx = (w - hw) / 2;
    const lead = 52 + r.potionCap * 26;
    const chat = this.host?.kind === 'p0' ? 430 / this.u : 0;
    if (chat && hx - lead < chat + 10) {
      hx = chat + 10 + lead;
      hw = Math.max(200, Math.min(hw, w - pad - ww - 61 - hx));
    }
    const cx = hx + hw / 2;
    let sx = cx - total / 2;
    const sy = hy - 30 - sz - (this.touch ? 80 : 0);
    for (const slot of SLOTS) {
      const lvl = r.spells[slot.id];
      g.save();
      this._box(g, sx, sy, sz, sz, C.panel, lvl ? C.edge : '#2a0c08');
      g.globalAlpha = lvl ? 1 : 0.22;
      if (!IconAtlas.draw(g, slot.icon, sx + 4, sy + 4, sz - 8)) {
        const words = SPELLS[slot.id].name.toUpperCase().split(' ');
        words.forEach((wd2, k) => this._text(g, wd2, sx + sz / 2, sy + sz / 2 + (k - (words.length - 1) / 2) * 11, { size: 8, ls: 1, align: 'center', base: 'middle' }));
      }
      g.globalAlpha = 1;
      const left = lvl ? spellUsesLeft(r, slot.id) : 0;
      if (!lvl || left <= 0) {
        // Not yet learned, or spent for this floor: a dark seal over it.
        g.fillStyle = lvl ? 'rgba(6,2,2,0.62)' : 'rgba(6,2,2,0.45)';
        g.fillRect(sx + 3, sy + 3, sz - 6, sz - 6);
      }
      g.restore();
      // Key, level and name.
      this._text(g, SPELLS[slot.id].label, sx + 7, sy + 15, { size: 13, color: C.ember, glow: 'rgba(140,20,0,0.9)', weight: 'bold ' });
      if (lvl) this._text(g, 'I'.repeat(lvl), sx + sz - 7, sy + sz - 7, { size: 11, color: C.light, align: 'right' });
      // Uses left on this floor, one pip each.
      if (lvl && Number.isFinite(left)) {
        for (let u = 0; u < lvl; u++) {
          g.fillStyle = u < left ? C.ember : 'rgba(60,20,14,0.9)';
          g.beginPath();
          g.arc(sx + 10 + u * 9, sy + sz - 9, 3, 0, Math.PI * 2);
          g.fill();
        }
      }
      const name = SPELLS[slot.id].name;
      this._text(g, name.toUpperCase(), sx + sz / 2, sy + sz + 13, { size: 8, ls: 0.5, color: lvl ? C.bone : C.ash, align: 'center' });
      L.slots.push({ x: sx + 3, y: sy + 3, w: sz - 6, h: sz - 6 });
      if (this.touch && lvl) this.buttons.push({ x: (sx + sz / 2) * this.u, y: (sy + sz / 2) * this.u, r: (sz / 2) * this.u, code: SPELLS[slot.id].key });
      sx += sz + gap;
    }

    // Health: an iron-framed vial of blood centred under the skills; the
    // blood itself is drawn on the GPU (fill, chip, glow).
    L.vial = { x: hx, y: hy, w: hw, h: 26 };
    L.health = { x: hx + 5, y: hy + 5, w: hw - 10, h: 16 };
    // The layer the numbers ride on: the skills and the vial, 4:1.
    const tw = Math.max(hw + 40, total + 40, (hy + 30 - (sy - 6)) * 4);
    L.top = { x: cx - tw / 2, y: hy + 30 - tw / 4, w: tw, h: tw / 4 };
    // Experience: a thin gold seam under the vial, the level on a plate to
    // its right (lit while a point waits to be spent).
    const maxed = r.level >= MAX_LEVEL;
    const xf = maxed ? 1 : clamp01(r.xp / xpToNext(r.level));
    g.fillStyle = 'rgba(20,8,4,0.85)';
    g.fillRect(hx + 5, hy + 30, hw - 10, 5);
    if (xf > 0) {
      g.save();
      const xg = g.createLinearGradient(hx, 0, hx + hw, 0);
      xg.addColorStop(0, '#8a5a10');
      xg.addColorStop(1, '#ffd36a');
      g.fillStyle = xg;
      g.shadowColor = 'rgba(255,190,80,0.8)';
      g.shadowBlur = 6;
      g.fillRect(hx + 5, hy + 30, (hw - 10) * xf, 5);
      g.restore();
    }
    const lx = hx + hw + 30;
    const ly = hy + 15;
    g.save();
    g.translate(lx, ly);
    g.rotate(Math.PI / 4);
    g.fillStyle = 'rgba(26,8,5,0.95)';
    g.strokeStyle = r.points > 0 ? '#ffd36a' : '#8a5a2a';
    g.lineWidth = 2;
    g.shadowColor = r.points > 0 ? 'rgba(255,200,90,0.9)' : 'transparent';
    g.shadowBlur = r.points > 0 ? 12 : 0;
    g.fillRect(-15, -15, 30, 30);
    g.strokeRect(-15, -15, 30, 30);
    g.restore();
    this._text(g, String(r.level), lx, ly + 1, { size: 15, weight: 'bold ', color: '#ffe3a0', align: 'center', base: 'middle', glow: 'rgba(120,60,0,0.9)' });
    this._text(g, maxed ? 'MAX' : 'LV', lx, ly + 27, { size: 8, ls: 1.5, color: C.ash, align: 'center' });
    // Potions to the left of it, with the key.
    for (let k = 0; k < r.potionCap; k++) this._potionIcon(g, hx - 30 - k * 26, hy - 4, k < r.potions);
    this._key(g, 'E', hx - 40 - r.potionCap * 26, hy + 13);
    // Buffs above the skills.
    const tags = [];
    if (p.siphonT > 0) tags.push(['Blood Siphon', '#ff6a5a']);
    if (p.wrathT > 0) tags.push(['Next blow counters', '#ff7040']);
    if (p.burnT > 0) tags.push(['Burning: shade step (Space) to put it out', '#ff8a2a']);
    if (p.flameT > 0) tags.push(['Flaming blade', '#ff9a3a']);
    else if (p.coatT > 0) tags.push(['Slime-coated: block to ignite', '#8ef05a']);
    if (tags.length) {
      g.font = `12px ${SERIF}`;
      const widths = tags.map(([t]) => g.measureText(t).width + 18);
      let tx = cx - (widths.reduce((a, b) => a + b, 0) + (tags.length - 1) * 8) / 2;
      tags.forEach(([t, c], k) => {
        this._tag(g, t, tx, sy - 18, c);
        tx += widths[k] + 8;
      });
    }

    // Weapon, bottom right: its painted icon, name, kind and personality.
    const wh = 78;
    const wx = w - pad - ww;
    const wy = h - pad - wh;
    this._box(g, wx, wy, ww, wh, C.panel, C.edge);
    if (R) {
      // Its rarity: the icon backlit in the colour, a lit seam along the top.
      g.save();
      const glow = g.createRadialGradient(wx + wh / 2, wy + wh / 2, 2, wx + wh / 2, wy + wh / 2, wh * 0.5);
      glow.addColorStop(0, hexA(R.color, 0.45));
      glow.addColorStop(1, hexA(R.color, 0));
      g.fillStyle = glow;
      g.fillRect(wx + 4, wy + 4, wh - 8, wh - 8);
      g.fillStyle = R.color;
      g.shadowColor = R.color;
      g.shadowBlur = 8;
      g.fillRect(wx + 10, wy + 4, ww - 20, 2);
      g.restore();
    }
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

  // A key cap: the letter bold and bright on a dark plate, centred on x, y.
  _key(g, text, x, y) {
    g.font = `bold 15px ${SERIF}`;
    const kw = Math.max(24, g.measureText(text).width + 14);
    this._box(g, x - kw / 2, y - 12, kw, 24, 'rgba(26,8,5,0.95)', C.ember);
    this._text(g, text, x, y + 1, { size: 15, weight: 'bold ', color: C.light, align: 'center', base: 'middle', glow: 'rgba(200,50,0,0.85)' });
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
    btn(bx - 80, by + 30, 28, 'STEP', 'Space');
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
    // The button fits its words as they are drawn: capitals, spaced.
    const label = 'FALL INTO THE PIT';
    const ls = Math.max(14, big * 0.22);
    const bw = this._measure(g, label, { size: ls, ls: 2 }) + 64;
    const bh = Math.max(48, ls * 2.4);
    this._box(g, (w - bw) / 2, y - bh / 2, bw, bh, `rgba(${40 + pulse * 30},6,4,0.88)`, '#8a2210');
    this._text(g, label, w / 2, y, { size: ls, ls: 2, color: C.light, align: 'center', base: 'middle', glow: `rgba(200,40,0,${0.5 + pulse * 0.4})` });
    y += bh / 2 + 26;
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
    // Controls, in three columns (getting about, fighting, the demon
    // spells), each drawn as what you press: keys as keycaps, the mouse with
    // the button to use lit. On Project 0 the chat sits in the bottom left
    // corner: the panel keeps to the right of it.
    if (!this.touch && h > 420) this._paintControls(g, y);
  }

  _paintControls(g, top) {
    const { vw: w, vh: h } = this;
    const ROW = 31;
    const WHAT = { size: 13 };
    const cols = [
      {
        title: 'Move',
        rows: [
          [{ keys: ['W', 'A', 'S', 'D'] }, 'move'],
          [{ mouse: 'move' }, 'aim'],
          [{ keys: ['Shift'] }, 'sprint'],
          [{ keys: ['Space'] }, 'shade step'],
          [{ keys: ['E'] }, 'drink a potion'],
          [{ keys: ['F'] }, 'take / use'],
        ],
      },
      {
        title: 'Fight',
        rows: [
          [{ mouse: 'left' }, 'light attack'],
          [{ mouse: 'left', tag: 'HOLD' }, 'heavy attack'],
          [{ mouse: 'left', tag: '×3' }, 'chain attack'],
          [{ mouse: 'left', tag: '!' }, 'hit its wind-up: stagger'],
          [{ mouse: 'right' }, 'block'],
        ],
      },
      {
        title: 'Demon spells',
        rows: SPELL_IDS.map((id) => [{ keys: [SPELLS[id].label === 'SPACE' ? 'Space' : SPELLS[id].label] }, SPELLS[id].name]),
        note: 'Shade Step is yours from the start; find the others in chests and at the Magic Circle between floors.',
      },
    ];
    for (const col of cols) {
      col.iconW = Math.max(...col.rows.map(([ic]) => this._controlIcon(g, ic, 0, 0, false)));
      col.w = col.iconW + 12 + Math.max(...col.rows.map(([, d]) => this._measure(g, d, WHAT)), 0) + 30;
      col.w = Math.max(col.w, this._measure(g, col.title.toUpperCase(), { size: 11, ls: 2 }) + 30);
    }
    const spells = cols[2];
    spells.w = Math.max(spells.w, 200);
    const pw = cols.reduce((a, c) => a + c.w, 0) + 14;
    const ph = 38 + 6 * ROW + 10;
    // Clear of Project 0's chat (its width in screen pixels), unless the
    // screen is too narrow to keep it clear without shrinking the panel
    // past reading.
    const reserve = this.host?.kind === 'p0' ? 430 / this.u : 0;
    let left = reserve + 10;
    let room = w - left - 12;
    if (room < pw * 0.62) {
      left = 12;
      room = w - 24;
    }
    let cy = Math.max(top + 18, h - 14 - ph);
    const k = Math.max(0.5, Math.min(1, room / pw, (h - 8 - cy) / ph));
    if (cy + ph * k > h - 8) cy = h - 8 - ph * k;
    g.save();
    g.translate(left + (room - pw * k) / 2, cy);
    g.scale(k, k);
    this._box(g, 0, 0, pw, ph, 'rgba(10,2,2,0.74)', C.edge);
    let cx = 22;
    cols.forEach((col, n) => {
      this._label(g, col.title, cx, 24, { size: 11, color: n === 2 ? C.ember : C.ash });
      col.rows.forEach(([icon, what], r) => {
        const cyRow = 38 + r * ROW + ROW / 2;
        this._controlIcon(g, icon, cx, cyRow, true);
        this._text(g, what, cx + col.iconW + 12, cyRow, { ...WHAT, color: C.bone, base: 'middle' });
      });
      if (col.note) {
        const ny = 38 + col.rows.length * ROW + 12;
        this._wrapLines(g, col.note, cx, ny, col.w - 30, 11, C.ash, 15);
      }
      cx += col.w;
      if (n < cols.length - 1) {
        g.fillStyle = 'rgba(106,26,16,0.6)';
        g.fillRect(cx - 14, 14, 1, ph - 28);
      }
    });
    g.restore();
  }

  // Wrapped lines of text, `lh` apart.
  _wrapLines(g, text, x, y, maxW, size, color, lh) {
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (this._measure(g, test, { size }) > maxW && line) {
        this._text(g, line, x, y, { size, color });
        y += lh;
        line = word;
      } else line = test;
    }
    if (line) this._text(g, line, x, y, { size, color });
  }

  // A control as you press it: { keys: [...] } a row of keycaps, or
  // { mouse: 'left' | 'right' | 'move', tag } a mouse with that button lit
  // (`tag`: HOLD, ×3, or ! for a demon's wind-up). Drawn centred on y from
  // x; returns its width (with draw false, only measures).
  _controlIcon(g, icon, x, y, draw) {
    if (icon.keys) {
      let cx = x;
      icon.keys.forEach((label, i) => {
        if (i) cx += 3;
        cx += this._keycap(g, label, cx, y, draw);
      });
      return cx - x;
    }
    let width = this._mouseIcon(g, icon.mouse, x, y, draw);
    if (icon.tag) {
      const tagW = this._measure(g, icon.tag, { size: 10, weight: 'bold ', ls: 1 }) + 10;
      if (draw) {
        const tx = x + width + 5;
        g.save();
        g.fillStyle = icon.tag === '!' ? 'rgba(150,20,6,0.95)' : 'rgba(70,18,10,0.95)';
        g.strokeStyle = icon.tag === '!' ? '#ff6a2a' : '#a8401c';
        g.lineWidth = 1.5;
        g.beginPath();
        roundRect(g, tx, y - 8, tagW, 16, 8);
        g.fill();
        g.stroke();
        g.restore();
        this._text(g, icon.tag, tx + tagW / 2, y + 0.5, { size: 10, weight: 'bold ', ls: 1, color: icon.tag === '!' ? '#ffe0b0' : C.light, align: 'center', base: 'middle' });
      }
      width += 5 + tagW;
    }
    return width;
  }

  // A keycap: a dark key with a lit top face, its label on it.
  _keycap(g, label, x, y, draw) {
    const kh = 24;
    const kw = Math.max(kh, this._measure(g, label, { size: 12, weight: 'bold ' }) + 16);
    if (!draw) return kw;
    const top = y - kh / 2;
    g.save();
    g.fillStyle = '#0c0403';
    g.strokeStyle = '#5a1a10';
    g.lineWidth = 1.5;
    g.beginPath();
    roundRect(g, x, top, kw, kh, 5);
    g.fill();
    g.stroke();
    const face = g.createLinearGradient(0, top, 0, top + kh);
    face.addColorStop(0, '#4a1d16');
    face.addColorStop(1, '#271009');
    g.fillStyle = face;
    g.strokeStyle = 'rgba(255,180,130,0.22)';
    g.lineWidth = 1;
    g.beginPath();
    roundRect(g, x + 2.5, top + 1.5, kw - 5, kh - 6, 4);
    g.fill();
    g.stroke();
    g.restore();
    this._text(g, label, x + kw / 2, top + (kh - 4) / 2 + 0.5, { size: 12, weight: 'bold ', color: C.light, align: 'center', base: 'middle' });
    return kw;
  }

  // A mouse: two buttons over the body, the one to press lit; for 'move',
  // none lit and arrows either side.
  _mouseIcon(g, which, x, y, draw) {
    const mw = 18;
    const mh = 26;
    const pad = which === 'move' ? 11 : 0;
    if (!draw) return mw + pad * 2;
    const mx = x + pad;
    const top = y - mh / 2;
    g.save();
    g.fillStyle = '#1a0806';
    g.strokeStyle = '#7a2a18';
    g.lineWidth = 1.5;
    g.beginPath();
    roundRect(g, mx, top, mw, mh, 9);
    g.fill();
    g.stroke();
    // The lit button.
    if (which === 'left' || which === 'right') {
      g.save();
      g.beginPath();
      roundRect(g, mx, top, mw, mh, 9);
      g.clip();
      const bx = which === 'left' ? mx : mx + mw / 2;
      const lit = g.createLinearGradient(0, top, 0, top + mh * 0.45);
      lit.addColorStop(0, '#ffb070');
      lit.addColorStop(1, '#e8642a');
      g.fillStyle = lit;
      g.shadowColor = 'rgba(255,110,30,0.9)';
      g.shadowBlur = 8;
      g.fillRect(bx, top, mw / 2, mh * 0.42);
      g.restore();
    }
    // The split between the buttons and the line under them, and the wheel.
    g.strokeStyle = '#7a2a18';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(mx + mw / 2, top);
    g.lineTo(mx + mw / 2, top + mh * 0.42);
    g.moveTo(mx + 1, top + mh * 0.42);
    g.lineTo(mx + mw - 1, top + mh * 0.42);
    g.stroke();
    g.fillStyle = which === 'move' ? '#a8401c' : '#3a1410';
    g.beginPath();
    roundRect(g, mx + mw / 2 - 1.5, top + 4, 3, 6, 1.5);
    g.fill();
    if (which === 'move') {
      g.fillStyle = C.ember;
      // Arrows either side of it: moved, not clicked.
      for (const side of [-1, 1]) {
        const tip = side < 0 ? x : x + pad * 2 + mw;
        g.beginPath();
        g.moveTo(tip, y);
        g.lineTo(tip - side * 6, y - 4);
        g.lineTo(tip - side * 6, y + 4);
        g.closePath();
        g.fill();
      }
    }
    g.restore();
    return mw + pad * 2;
  }

  // How wide `text` is drawn at these settings (letter spacing included).
  _measure(g, text, { size = 16, weight = '', ls = 0 } = {}) {
    g.font = `${weight}${size}px ${SERIF}`;
    if ('letterSpacing' in g) g.letterSpacing = `${ls}px`;
    const wd = g.measureText(text).width + ('letterSpacing' in g ? 0 : ls * text.length);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    return wd;
  }

  _paintPause(g) {
    this._dim(g);
    const relics = Object.entries(this.info.run?.relics || {});
    const y0 = relics.length ? this.vh * 0.2 : this.vh * 0.4;
    const pw = Math.min(420, this.vw - 40);
    this._box(g, (this.vw - pw) / 2, y0 - 62, pw, 112, C.panel, C.edge);
    this._text(g, 'PAUSED', this.vw / 2, y0, { size: 40, ls: 4, color: C.light, align: 'center', glow: 'rgba(190,30,0,0.9)' });
    this._divider(g, this.vw / 2, y0 + 14, pw * 0.7);
    this._label(g, 'Click to return to the dark', this.vw / 2, y0 + 36, { align: 'center', color: C.bone });
    // Back into the game.
    this._backButton(g, this.vw / 2, y0 + 92, 'Back', 'Resume');
    if (!relics.length) return;
    // Your relics, and what each one does.
    const bw = Math.min(640, this.vw - 40);
    const rowH = 52;
    const bx = (this.vw - bw) / 2;
    let y = y0 + 132;
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
      const hot = this.hoverCode === `Digit${k + 1}`;
      this._box(g, (w - bw) / 2, y, bw, bh, hot ? 'rgba(70,14,8,0.95)' : C.panel, hot ? C.ember : C.edge);
      this._text(g, String(k + 1), (w - bw) / 2 + 22, y + bh / 2, { size: 26, color: C.ember, align: 'center', base: 'middle' });
      this._text(g, o.label, (w - bw) / 2 + 46, y + (o.detail ? 22 : bh / 2), { size: 17, base: 'middle' });
      if (o.detail) this._wrap(g, o.detail, (w - bw) / 2 + 46, y + 42, bw - 60, 12, C.ash);
      this.buttons.push({ x: (w / 2) * this.u, y: (y + bh / 2) * this.u, w: bw * this.u, h: bh * this.u, code: `Digit${k + 1}`, rect: true });
      y += bh + 10;
    });
    this._label(g, this.touch ? 'Tap a blessing · only one altar may be woken' : 'Click one (or press its number) · Q to step back · only one altar may be woken', w / 2, y + 22, { size: 11, align: 'center' });
    // Step away from the altar without choosing (as Q does).
    this._backButton(g, w / 2, y + 66, 'Back', 'KeyQ');
  }

  // A forged button that takes you back, centred on x, y: pressing it acts
  // as `code` (a key the game already answers, or 'Resume').
  _backButton(g, x, y, label, code) {
    const bw = 200;
    const bh = 46;
    const hot = this.hoverCode === code;
    this._button(g, x - bw / 2, y - bh / 2, bw, bh, label.toUpperCase(), hot, 0.5 + 0.5 * Math.sin(this.time * 3), BACK_HUE);
    // The arrow before the word.
    g.save();
    g.fillStyle = hot ? '#fff1dc' : C.ember;
    g.beginPath();
    g.moveTo(x - bw / 2 + 26, y);
    g.lineTo(x - bw / 2 + 38, y - 8);
    g.lineTo(x - bw / 2 + 38, y + 8);
    g.closePath();
    g.fill();
    g.restore();
    this.buttons.push({ x: x * this.u, y: y * this.u, w: bw * this.u, h: bh * this.u, code, rect: true });
  }

  // A level gained: three forged cards, Attack, Defence and Agility, each
  // with what a point buys, how much it has bought so far and ten pips.
  _paintLevelUp(g) {
    const { vw: w, vh: h } = this;
    const L = this.levelInfo;
    this._dim(g, 0.6);
    const ty = h * 0.24;
    this._text(g, `LEVEL ${L.level}`, w / 2, ty, { size: Math.min(46, w * 0.07), ls: 6, color: '#ffe3a0', align: 'center', glow: 'rgba(220,120,0,0.9)' });
    this._divider(g, w / 2, ty + 14, Math.min(420, w * 0.6));
    this._label(g, L.points > 1 ? `Choose where your strength grows · ${L.points} points to spend` : 'Choose where your strength grows', w / 2, ty + 40, { size: 12, align: 'center', color: C.bone });
    const n = L.stats.length;
    const gap = 20;
    const cw = Math.min(230, (w - 40 - gap * (n - 1)) / n);
    const ch = 196;
    let x = (w - (cw * n + gap * (n - 1))) / 2;
    const y = ty + 66;
    L.stats.forEach((S, k) => {
      const code = `Digit${k + 1}`;
      const full = S.have >= S.cap;
      const hot = !full && this.levelArmed && this.hoverCode === code;
      g.save();
      if (full) g.globalAlpha = 0.45;
      else if (!this.levelArmed) g.globalAlpha = 0.7;
      this._box(g, x, y, cw, ch, hot ? 'rgba(70,20,8,0.96)' : C.panel, hot ? S.color : C.edge);
      // A coloured seam and glow along the top, the stat's own.
      g.fillStyle = S.color;
      g.shadowColor = S.color;
      g.shadowBlur = hot ? 16 : 8;
      g.fillRect(x + 12, y + 5, cw - 24, 2);
      g.shadowBlur = 0;
      this._text(g, String(k + 1), x + 18, y + 32, { size: 22, weight: 'bold ', color: C.ember, align: 'center', base: 'middle', glow: 'rgba(140,20,0,0.9)' });
      this._text(g, S.name.toUpperCase(), x + cw / 2, y + 40, { size: 21, ls: 3, color: S.color, align: 'center', glow: 'rgba(0,0,0,1)' });
      this._text(g, S.text, x + cw / 2, y + 72, { size: 15, color: C.light, align: 'center' });
      const sign = S.id === 'defence' ? '-' : '+';
      const now = Math.round(S.per * S.have * 1000) / 10;
      this._label(g, S.have ? `Now ${sign}${now}%` : 'Untrained', x + cw / 2, y + 100, { size: 11, align: 'center', color: C.bone });
      // Ten pips: what has been put in.
      const pw = Math.min(14, (cw - 40) / S.cap - 4);
      let px = x + (cw - (S.cap * (pw + 4) - 4)) / 2;
      for (let i = 0; i < S.cap; i++) {
        g.fillStyle = i < S.have ? S.color : 'rgba(80,24,14,0.7)';
        g.shadowColor = i < S.have ? S.color : 'transparent';
        g.shadowBlur = i < S.have ? 6 : 0;
        g.fillRect(px, y + 122, pw, pw);
        px += pw + 4;
      }
      g.shadowBlur = 0;
      this._label(g, full ? 'Mastered' : `${S.have} / ${S.cap}`, x + cw / 2, y + 160, { size: 11, align: 'center', color: full ? S.color : C.ash });
      g.restore();
      if (!full) this.buttons.push({ x: (x + cw / 2) * this.u, y: (y + ch / 2) * this.u, w: cw * this.u, h: ch * this.u, code, rect: true });
      x += cw + gap;
    });
    this._label(g, this.touch ? 'Tap one' : 'Click one, or press 1, 2 or 3', w / 2, y + ch + 30, { size: 11, align: 'center' });
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

  // The end of a run: a sigil turning slowly behind the verdict, the cause
  // of it, and a framed panel: how deep you got (with the descent's twenty
  // floors as a gauge), and six stones, each with its own mark, for what you
  // did on the way. Then the way back up. Each part comes in after the last.
  _paintEnd(g) {
    const { vw: w, vh: h } = this;
    const e = this.endInfo || {};
    const won = this.panel === 'victory';
    const t = this.time - (this.endShownAt ?? this.time);
    const appear = (at, dur = 0.5) => Math.max(0, Math.min(1, (t - at) / dur));
    const hue = won ? { main: '#ffd28a', deep: 'rgba(255,140,20,', glow: 'rgba(255,120,0,0.85)', accent: '#ffb347', edge: '#8a5a10' } : { main: '#c8160c', deep: 'rgba(170,10,0,', glow: 'rgba(140,0,0,1)', accent: C.ember, edge: C.edge };

    // The dark, a pool of red at its heart.
    const grad = g.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.75);
    grad.addColorStop(0, won ? 'rgba(60,26,0,0.8)' : 'rgba(58,0,0,0.82)');
    grad.addColorStop(0.55, 'rgba(12,0,0,0.88)');
    grad.addColorStop(1, 'rgba(2,0,0,0.97)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    this._sigil(g, w / 2, h * 0.24, Math.min(w, h) * 0.3, this.time * 0.05, `${hue.deep}${0.16 * appear(0, 1.2)})`);
    this._embers(g, w, h, won);

    // The verdict.
    const big = Math.max(40, Math.min(104, w * 0.085));
    const ty = h * 0.22;
    g.save();
    g.globalAlpha = appear(0, 0.7);
    this._text(g, won ? 'HELL IS CONQUERED' : 'YOU DIED', w / 2, ty, { size: won ? big * 0.72 : big, ls: big * 0.1, color: hue.main, align: 'center', glow: hue.glow });
    this._ornament(g, w / 2, ty + big * 0.24, Math.min(w * 0.62, 760), hue.accent);
    const [cause, after] = e.lines || [];
    if (cause) this._text(g, cause, w / 2, ty + big * 0.24 + 40, { size: 21, color: C.light, align: 'center' });
    if (after) this._text(g, after, w / 2, ty + big * 0.24 + 66, { size: 15, color: C.ash, align: 'center' });
    g.restore();

    // The panel: depth on the left, the stones on the right.
    const pw = Math.min(900, w - 40);
    const ph = 214;
    const px = (w - pw) / 2;
    const py = ty + big * 0.24 + 96;
    g.save();
    g.globalAlpha = appear(0.45);
    this._frame(g, px, py, pw, ph, hue);
    const dw = Math.min(250, pw * 0.3);
    const dx = px + dw / 2 + 14;
    this._label(g, won ? 'The whole descent' : 'Depth reached', dx, py + 34, { size: 11, align: 'center', color: C.ash });
    this._text(g, String(e.floor ?? 0), dx - 10, py + 108, { size: 70, color: hue.accent, align: 'center', glow: hue.glow });
    this._text(g, `/ ${e.floors ?? 20}`, dx + 34, py + 108, { size: 20, color: C.ash });
    this._gauge(g, dx - (dw - 40) / 2, py + 132, dw - 40, e.floor ?? 0, e.deepest ?? 0, e.floors ?? 20, hue);
    if (e.record) this._badge(g, dx, py + 182, 'New deepest', hue);
    else this._label(g, `Deepest: Floor ${e.deepest ?? 0}`, dx, py + 186, { size: 11, align: 'center', color: C.bone });
    // The rule between the two halves.
    g.fillStyle = `${hue.deep}0.45)`;
    g.fillRect(px + dw + 26, py + 22, 1, ph - 44);
    const stats = e.stats || [];
    const gx = px + dw + 44;
    const gw = pw - dw - 66;
    const tw = (gw - 24) / 3;
    const th = (ph - 52) / 2;
    stats.forEach(([icon, label, value, color], k) => {
      const tx = gx + (k % 3) * (tw + 12);
      const tyy = py + 22 + Math.floor(k / 3) * (th + 8);
      g.save();
      g.globalAlpha *= appear(0.6 + k * 0.08, 0.4);
      this._tile(g, tx, tyy, tw, th, icon, label, value, hue, color);
      g.restore();
    });
    g.restore();

    // The way back up.
    const by = py + ph + 46;
    if (e.ready) {
      const a = Math.min(appear(1.2, 0.6), 1);
      const hot = this.hoverCode === 'Space';
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
      const label = won ? 'Return to the surface' : 'Rise again';
      g.save();
      g.globalAlpha = a;
      g.font = `bold 20px ${SERIF}`;
      const bw = Math.max(260, g.measureText(label.toUpperCase()).width + 90);
      this._button(g, w / 2 - bw / 2, by - 26, bw, 52, label.toUpperCase(), hot, pulse, hue);
      this._label(g, this.touch ? 'Tap to begin again at the surface' : 'Click, or press Space, to begin again at the surface', w / 2, by + 50, { size: 11, align: 'center', color: C.ash });
      g.restore();
      this.buttons.push({ x: (w / 2) * this.u, y: by * this.u, w: bw * this.u, h: 52 * this.u, code: 'Space', rect: true });
    }
  }

  // A ring of runes and a five-pointed star, turning.
  _sigil(g, x, y, r, angle, color) {
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.strokeStyle = color;
    g.lineWidth = 2;
    for (const k of [1, 0.86, 0.5]) {
      g.beginPath();
      g.arc(0, 0, r * k, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      const px = Math.cos(a) * r * 0.86;
      const py = Math.sin(a) * r * 0.86;
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.stroke();
    // Rune ticks between the outer rings.
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const l = i % 5 ? 0.06 : 0.12;
      g.beginPath();
      g.moveTo(Math.cos(a) * r * 0.88, Math.sin(a) * r * 0.88);
      g.lineTo(Math.cos(a) * r * (0.88 + l), Math.sin(a) * r * (0.88 + l));
      g.stroke();
    }
    g.restore();
  }

  // Ash and embers drifting up the screen.
  _embers(g, w, h, gold) {
    g.save();
    for (let i = 0; i < 46; i++) {
      const sx = ((i * 97.13) % 1) * w;
      const speed = 14 + ((i * 31.7) % 1) * 30;
      const y = h - ((this.time * speed + i * 53) % (h + 40)) + 20;
      const x = sx + Math.sin(this.time * 0.7 + i) * 18 + ((i * 0.618) % 1) * w * 0.9;
      const r = 0.8 + ((i * 7.31) % 1) * 1.8;
      const a = 0.25 + 0.5 * ((i * 3.7) % 1);
      g.fillStyle = gold ? `rgba(255,190,90,${a})` : `rgba(255,${70 + ((i * 13) % 60)},20,${a})`;
      g.beginPath();
      g.arc(x % w, y, r, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  // A rule that fades out at both ends, a diamond at its heart and two horns.
  _ornament(g, cx, y, w, color) {
    g.save();
    const grad = g.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(cx - w / 2, y - 1, w, 2);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(cx, y - 8);
    g.lineTo(cx + 8, y);
    g.lineTo(cx, y + 8);
    g.lineTo(cx - 8, y);
    g.closePath();
    g.fill();
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * 14, y);
      g.quadraticCurveTo(cx + s * 26, y - 9, cx + s * 40, y - 3);
      g.quadraticCurveTo(cx + s * 26, y - 4, cx + s * 14, y);
      g.fill();
      g.beginPath();
      g.arc(cx + s * 52, y, 2.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  // An iron-bound panel: dark plate, a double rim, studs and spiked corners.
  _frame(g, x, y, w, h, hue) {
    this._box(g, x, y, w, h, 'rgba(12,3,2,0.9)', hue.edge);
    g.save();
    g.strokeStyle = `${hue.deep}0.35)`;
    g.lineWidth = 1;
    g.strokeRect(x + 9.5, y + 9.5, w - 19, h - 19);
    g.fillStyle = hue.accent;
    for (const [cx, cy] of [[x + 9.5, y + 9.5], [x + w - 9.5, y + 9.5], [x + 9.5, y + h - 9.5], [x + w - 9.5, y + h - 9.5]]) {
      g.beginPath();
      g.arc(cx, cy, 2.6, 0, Math.PI * 2);
      g.fill();
    }
    // A spike out of the middle of the top and bottom edges.
    for (const [sy, d] of [[y, -1], [y + h, 1]]) {
      g.beginPath();
      g.moveTo(x + w / 2 - 12, sy);
      g.lineTo(x + w / 2, sy + d * 10);
      g.lineTo(x + w / 2 + 12, sy);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  // The descent's floors as a row of notches: the ones you went down lit,
  // the deepest you ever reached marked above.
  _gauge(g, x, y, w, floor, deepest, floors, hue) {
    const step = w / floors;
    g.save();
    for (let i = 0; i < floors; i++) {
      const gone = i < floor;
      g.fillStyle = gone ? hue.accent : 'rgba(120,60,40,0.35)';
      const bh = i % 5 === 4 ? 14 : 10;
      g.fillRect(x + i * step + 1, y + (14 - bh), Math.max(2, step - 3), bh);
    }
    if (deepest > 0) {
      const mx = x + (Math.min(deepest, floors) - 0.5) * step;
      g.fillStyle = '#f2c79e';
      g.beginPath();
      g.moveTo(mx - 5, y - 8);
      g.lineTo(mx + 5, y - 8);
      g.lineTo(mx, y - 2);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  // A small banner: a record set.
  _badge(g, cx, cy, text, hue) {
    g.save();
    g.font = `bold 12px ${SERIF}`;
    const tw = g.measureText(text.toUpperCase()).width + 30;
    g.fillStyle = hue.accent;
    g.beginPath();
    g.moveTo(cx - tw / 2 - 8, cy - 11);
    g.lineTo(cx + tw / 2 + 8, cy - 11);
    g.lineTo(cx + tw / 2, cy);
    g.lineTo(cx + tw / 2 + 8, cy + 11);
    g.lineTo(cx - tw / 2 - 8, cy + 11);
    g.lineTo(cx - tw / 2, cy);
    g.closePath();
    g.fill();
    g.restore();
    this._text(g, text.toUpperCase(), cx, cy + 1, { size: 12, weight: 'bold ', color: '#1a0503', align: 'center', base: 'middle', ls: 1.5 });
  }

  // One stone: its mark, the number, and what it counts.
  _tile(g, x, y, w, h, icon, label, value, hue, color = null) {
    g.save();
    g.fillStyle = 'rgba(30,8,5,0.75)';
    g.fillRect(x, y, w, h);
    g.strokeStyle = `${hue.deep}0.4)`;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.fillStyle = hue.accent;
    g.fillRect(x, y, 3, h);
    g.restore();
    const s = Math.min(34, h * 0.5);
    this._glyph(g, icon, x + 14 + s / 2, y + h / 2, s, hue.accent);
    // A long value (a weapon's name) shrinks to fit its stone.
    const text = String(value);
    const room = w - (26 + s) - 10;
    const size = Math.max(13, Math.min(28, (28 * room) / Math.max(1, this._measure(g, text, { size: 28 }))));
    this._text(g, text, x + 26 + s, y + h / 2 + 4, { size, color: color || C.light, glow: 'rgba(120,20,0,0.7)' });
    this._label(g, label, x + 26 + s, y + h / 2 + 22, { size: 10, color: C.ash });
  }

  // The marks on the stones, drawn as small silhouettes.
  _glyph(g, kind, cx, cy, s, color) {
    g.save();
    g.translate(cx, cy);
    g.scale(s / 32, s / 32);
    g.fillStyle = color;
    g.strokeStyle = color;
    g.lineWidth = 2.6;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (kind === 'skull') {
      g.beginPath();
      g.arc(0, -3, 11, Math.PI * 0.9, Math.PI * 2.1);
      g.lineTo(7, 10);
      g.lineTo(-7, 10);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(30,8,5,1)';
      g.beginPath();
      g.arc(-4.5, -2, 3.2, 0, Math.PI * 2);
      g.arc(4.5, -2, 3.2, 0, Math.PI * 2);
      g.fill();
      g.fillRect(-0.8, 3, 1.6, 4);
      g.fillRect(-4, 8, 1.2, 3);
      g.fillRect(2.8, 8, 1.2, 3);
    } else if (kind === 'chain') {
      for (const [dx, dy] of [[-6, 5], [6, -5]]) {
        g.save();
        g.translate(dx, dy);
        g.rotate(-Math.PI / 4);
        g.beginPath();
        g.ellipse(0, 0, 9, 5, 0, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    } else if (kind === 'blades') {
      for (const sgn of [-1, 1]) {
        g.save();
        g.rotate((sgn * Math.PI) / 4);
        g.beginPath();
        g.moveTo(0, -14);
        g.lineTo(2.5, -10);
        g.lineTo(2.5, 6);
        g.lineTo(-2.5, 6);
        g.lineTo(-2.5, -10);
        g.closePath();
        g.fill();
        g.fillRect(-6, 6, 12, 2.5);
        g.fillRect(-1.2, 8.5, 2.4, 6);
        g.restore();
      }
    } else if (kind === 'shield') {
      g.beginPath();
      g.moveTo(0, -13);
      g.lineTo(11, -9);
      g.lineTo(10, 2);
      g.quadraticCurveTo(7, 10, 0, 14);
      g.quadraticCurveTo(-7, 10, -10, 2);
      g.lineTo(-11, -9);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(30,8,5,1)';
      g.fillRect(-1, -9, 2, 18);
      g.fillRect(-7, -2, 14, 2);
    } else if (kind === 'gem') {
      g.beginPath();
      g.moveTo(-11, -4);
      g.lineTo(-6, -11);
      g.lineTo(6, -11);
      g.lineTo(11, -4);
      g.lineTo(0, 13);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(30,8,5,0.9)';
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(-11, -4);
      g.lineTo(11, -4);
      g.moveTo(-4, -4);
      g.lineTo(0, 13);
      g.lineTo(4, -4);
      g.stroke();
    } else if (kind === 'glass') {
      g.fillRect(-10, -14, 20, 3);
      g.fillRect(-10, 11, 20, 3);
      g.beginPath();
      g.moveTo(-7, -11);
      g.lineTo(7, -11);
      g.lineTo(1.5, 0);
      g.lineTo(7, 11);
      g.lineTo(-7, 11);
      g.lineTo(-1.5, 0);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(-4, 11);
      g.lineTo(4, 11);
      g.lineTo(0, 5);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  // A forged button: hammered plate, a glowing rim, the word in the middle.
  _button(g, x, y, w, h, label, hot, pulse, hue) {
    g.save();
    g.shadowColor = hue.glow;
    g.shadowBlur = hot ? 26 : 10 + pulse * 10;
    const fill = g.createLinearGradient(0, y, 0, y + h);
    fill.addColorStop(0, hot ? 'rgba(120,24,10,0.96)' : 'rgba(70,12,6,0.94)');
    fill.addColorStop(1, hot ? 'rgba(60,8,4,0.96)' : 'rgba(26,4,2,0.94)');
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(x + 14, y);
    g.lineTo(x + w - 14, y);
    g.lineTo(x + w, y + h / 2);
    g.lineTo(x + w - 14, y + h);
    g.lineTo(x + 14, y + h);
    g.lineTo(x, y + h / 2);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 1.5;
    g.strokeStyle = hot ? '#ffb070' : hue.accent;
    g.stroke();
    g.restore();
    this._text(g, label, x + w / 2, y + h / 2 + 1, { size: 20, weight: 'bold ', ls: 4, color: hot ? '#fff1dc' : C.light, align: 'center', base: 'middle', glow: hue.glow });
  }
}

// '#rrggbb' at alpha a, for canvas gradients.
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Four splats of blood, 2 x 2, as density in the red channel: a lumpy
// body of overlapping drops, fine spray thrown out round it (smaller the
// further it flew), a few thin streaks and a run or two dripping down.
function splatAtlas() {
  const S = 256;
  const c = makeCanvas(S * 2, S * 2);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S * 2, S * 2);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const drop = (x, y, r, a) => {
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  g.globalCompositeOperation = 'lighter';
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S;
    const oy = Math.floor(cell / 2) * S;
    g.save();
    g.beginPath();
    g.rect(ox, oy, S, S);
    g.clip();
    const cx = ox + S * 0.5 + gauss() * 10;
    const cy = oy + S * 0.44 + gauss() * 10;
    const big = 0.75 + rnd() * 0.5;
    // Body: many drops piled up, thickest in the middle.
    for (let i = 0; i < 60; i++) {
      const d = Math.abs(gauss()) * 34 * big;
      const a = rnd() * Math.PI * 2;
      drop(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.85, (3 + rnd() * 9) * big * (1 - d / (60 * big)), 0.32);
    }
    // Spray, finer with distance.
    for (let i = 0; i < 90; i++) {
      const a = rnd() * Math.PI * 2;
      const d = (36 + rnd() ** 1.6 * 80) * big;
      drop(cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.max(0.7, 3.4 - d / 30) * (0.5 + rnd()), 0.9);
    }
    // Streaks flung out from the body.
    for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2;
      const d0 = 26 * big;
      const len = (14 + rnd() * 30) * big;
      for (let k = 0; k <= len; k += 1.5) drop(cx + Math.cos(a) * (d0 + k), cy + Math.sin(a) * (d0 + k), 1.7 * (1 - k / len) + 0.3, 0.5);
    }
    // Runs.
    const runs = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < runs; i++) {
      const x = cx + gauss() * 18;
      const len = (30 + rnd() * 60) * big;
      const w = 1.6 + rnd() * 1.8;
      for (let y = 0; y < len; y += 1.5) drop(x + Math.sin(y * 0.07 + i) * 1.5, cy + 12 + y, w * (1 - (y / len) * 0.35), 0.45);
      drop(x, cy + 12 + len, w * 1.6, 0.9);
    }
    g.restore();
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}
