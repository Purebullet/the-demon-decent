import * as THREE from 'three';
import { SPELLS, SPELL_IDS } from '../entities/Spells.js';
import { WEAPON_TYPES } from '../entities/Weapons.js';
import { makeCanvas } from '../world/Textures.js';

// The whole interface is painted on one canvas and drawn over the 3D view as
// a screen quad: Project 0 runs the game in a worker with no DOM, so nothing
// here may touch the page. Health, potions, weapon, spells, boss bar,
// prompts, toasts, announcements, the compass and every full-screen panel
// (title, pause, choice, death, victory) live here. Damage numbers are small
// sprites in the world. A second quad does the hurt vignette and fades.
//
// The canvas is repainted only when what it shows changes (at most 20 times
// a second), so the texture upload stays cheap even in software rendering.

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

const VIGNETTE = {
  vertex: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragment: `
    varying vec2 vUv;
    uniform float uHurt; uniform float uLow; uniform float uFade; uniform float uPulse;
    void main(){
      vec2 c = vUv - 0.5;
      float edge = smoothstep(0.32, 0.75, length(c * vec2(1.4, 1.0)));
      vec3 col = vec3(0.45, 0.0, 0.0);
      float a = edge * (uHurt * 0.55 + uLow * (0.35 + 0.25 * uPulse));
      a = a * (1.0 - uFade) + uFade;
      col = mix(col, vec3(0.0), uFade);
      gl_FragColor = vec4(col * (1.0 - uFade), a);
    }`,
};

export class Hud {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.canvas = makeCanvas(16, 16);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    const quad = new THREE.PlaneGeometry(2, 2);
    this.vignette = new THREE.ShaderMaterial({
      vertexShader: VIGNETTE.vertex,
      fragmentShader: VIGNETTE.fragment,
      uniforms: { uHurt: { value: 0 }, uLow: { value: 0 }, uFade: { value: 1 }, uPulse: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const vq = new THREE.Mesh(quad, this.vignette);
    vq.frustumCulled = false;
    vq.renderOrder = 1;
    this.overlay = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const hq = new THREE.Mesh(quad, this.overlay);
    hq.frustumCulled = false;
    hq.renderOrder = 2;
    this.scene.add(vq, hq);

    this.playing = false;
    this.panel = 'title';
    this.info = {};
    this.titleInfo = {};
    this.endInfo = null;
    this.choice = null;
    this.toasts = [];
    this.announcement = null;
    this.buttons = [];
    this.touch = false;
    this.hurt = 0;
    this.fadeValue = 1;
    this.fadeTarget = 1;
    this.fadeSpeed = 2;
    this.dirty = true;
    this.lastSig = '';
    this.paintT = 0;
    this.time = 0;
    this.numbers = [];
    this.world = null;
    this.resize(host.width, host.height);
  }

  resize(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    // Painted at about the screen's resolution (at most 1.25x, and never
    // wider than 2400 px): sharp enough, and cheap to re-upload.
    this.scale = Math.min(Math.max(1, this.host.pixelRatio || 1), 1.25, 2400 / this.w);
    this.canvas.width = Math.round(this.w * this.scale);
    this.canvas.height = Math.round(this.h * this.scale);
    this.texture.dispose();
    this.texture.image = this.canvas;
    this.texture.needsUpdate = true;
    this.dirty = true;
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
  }

  toast(text) {
    this.toasts.push({ text, t: 0 });
    while (this.toasts.length > 4) this.toasts.shift();
    this.dirty = true;
  }

  announce(text, sub = '') {
    this.announcement = { text, sub, t: 0 };
    this.dirty = true;
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

  damageNumber(pos, amount, crit) {
    if (amount <= 0 || !this.world) return;
    let n = this.numbers.find((x) => !x.live);
    if (!n) {
      if (this.numbers.length >= 24) n = this.numbers.reduce((a, b) => (a.t > b.t ? a : b));
      else {
        const canvas = makeCanvas(128, 64);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
        n = { canvas, tex, sprite: new THREE.Sprite(mat) };
        n.sprite.renderOrder = 20;
        this.numbers.push(n);
      }
    }
    const g = n.canvas.getContext('2d');
    g.clearRect(0, 0, 128, 64);
    g.font = `bold ${crit ? 46 : 38}px ${SERIF}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(40,0,0,0.9)';
    const txt = String(Math.round(amount));
    g.strokeText(txt, 64, 32);
    g.fillStyle = crit ? '#ff5a2a' : '#ffd8b0';
    g.fillText(txt, 64, 32);
    n.tex.needsUpdate = true;
    n.live = true;
    n.t = 0;
    n.sprite.position.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + 0.5, pos.z + (Math.random() - 0.5) * 0.4);
    n.sprite.scale.set(crit ? 0.9 : 0.7, crit ? 0.45 : 0.35, 1);
    n.sprite.material.opacity = 1;
    if (n.sprite.parent !== this.world) this.world.add(n.sprite);
  }

  updateNumbers(dt) {
    for (const n of this.numbers) {
      if (!n.live) continue;
      n.t += dt;
      n.sprite.position.y += dt * 0.9;
      n.sprite.material.opacity = Math.min(1, (0.9 - n.t) * 4);
      if (n.t > 0.9) {
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
    this.toasts = this.toasts.filter((t) => t.t < 2.8);
    if (this.announcement) {
      this.announcement.t += dt;
      if (this.announcement.t > 3.4) this.announcement = null;
    }
    const step = this.fadeSpeed * dt;
    this.fadeValue += Math.max(-step, Math.min(step, this.fadeTarget - this.fadeValue));
    const low = this._lowHealth();
    this.vignette.uniforms.uHurt.value = this.playing ? this.hurt : 0;
    this.vignette.uniforms.uLow.value = this.playing ? low : 0;
    this.vignette.uniforms.uPulse.value = 0.5 + 0.5 * Math.sin(this.time * 4);
    this.vignette.uniforms.uFade.value = this.fadeValue;

    const animating = this.toasts.length || this.announcement || this.panel === 'title' || this.panel === 'death' || this.panel === 'victory';
    const sig = this._signature();
    this.paintT -= dt;
    if ((this.dirty || sig !== this.lastSig || animating) && this.paintT <= 0) {
      this.lastSig = sig;
      this.dirty = false;
      this.paintT = 0.05;
      this._paint();
      this.texture.needsUpdate = true;
    }
    renderer.render(this.scene, this.camera);
  }

  _lowHealth() {
    const r = this.info.run;
    if (!r || this.info.player?.dead) return 0;
    const f = r.health / r.maxHealth;
    return f < 0.3 ? (0.3 - f) / 0.3 : 0;
  }

  _signature() {
    const i = this.info;
    const r = i.run;
    const p = i.player;
    if (!this.playing || !r) return `${this.panel}`;
    const cds = p ? SPELL_IDS.map((id) => Math.ceil((p.spellCd[id] || 0) * 4)).join(',') : '';
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
      cds,
      i.floorLabel,
      i.enemyLabel,
      i.best,
      i.prompt,
      i.boss ? Math.ceil((i.boss.health / i.boss.maxHealth) * 200) : '',
      i.compass ? Math.round(i.compass.angle * 20) : '',
      p?.siphonT > 0 ? Math.ceil(p.siphonT) : '',
      p?.invuln > 0.25,
      this.touch,
    ].join('|');
  }

  // ---- Painting --------------------------------------------------------------

  _paint() {
    const g = this.ctx;
    const s = this.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(s, 0, 0, s, 0, 0);
    this.buttons = [];
    if (this.playing && this.info.run) this._paintPlaying(g);
    if (this.announcement) this._paintAnnouncement(g);
    if (this.toasts.length) this._paintToasts(g);
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

  _paintPlaying(g) {
    const { w, h } = this;
    const i = this.info;
    const r = i.run;
    const p = i.player;
    const small = w < 700;
    const pad = small ? 12 : 22;

    // Top corners (Project 0's own bar sits at the top centre).
    this._text(g, (i.floorLabel || '').toUpperCase(), pad, 30, { size: small ? 11 : 13, ls: 1.5, color: C.bone });
    this._text(g, (i.enemyLabel || '').toUpperCase(), w - pad, 30, { size: small ? 11 : 13, ls: 1.5, color: C.ember, align: 'right', glow: 'rgba(120,20,0,0.9)' });
    if (!small && i.best) this._label(g, `Deepest: Floor ${i.best}`, w - pad, 50, { size: 11, align: 'right' });

    // Crosshair.
    g.save();
    g.fillStyle = 'rgba(230,120,70,0.75)';
    g.shadowColor = 'rgba(80,0,0,1)';
    g.shadowBlur = 6;
    g.beginPath();
    g.arc(w / 2, h / 2, 2.5, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // Compass toward the exit or the last few demons.
    if (i.compass && !this.announcement) {
      const exit = i.compass.kind === 'exit';
      const big = exit ? 1.8 : 1;
      g.save();
      g.translate(w / 2, exit ? 104 : 88);
      g.rotate(i.compass.angle);
      g.fillStyle = exit ? '#c8441a' : '#9a1a10';
      g.strokeStyle = C.iron;
      g.lineWidth = 2;
      g.shadowColor = 'rgba(255,60,10,0.9)';
      g.shadowBlur = exit ? 16 : 8;
      g.beginPath();
      g.moveTo(0, -14 * big);
      g.lineTo(10 * big, 10 * big);
      g.lineTo(0, 4 * big);
      g.lineTo(-10 * big, 10 * big);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;
      g.stroke();
      g.restore();
      if (exit) this._label(g, 'The portal', w / 2, 146, { color: C.ember, align: 'center', glow: 'rgba(160,30,0,0.9)' });
    }

    // Boss bar.
    if (i.boss) {
      const bw = Math.min(620, w * 0.8);
      const bx = (w - bw) / 2;
      this._text(g, i.boss.name.toUpperCase(), w / 2, 126, { size: small ? 13 : 16, ls: 2, color: '#f0b080', align: 'center', glow: 'rgba(200,30,0,0.9)' });
      this._box(g, bx, 134, bw, 12, 'rgba(20,4,4,0.85)', '#5a1a10');
      const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, '#6a0a04');
      grad.addColorStop(0.6, '#d4300c');
      grad.addColorStop(1, '#ff8a3a');
      g.fillStyle = grad;
      g.fillRect(bx + 1, 135, (bw - 2) * Math.max(0, i.boss.health / i.boss.maxHealth), 10);
    }

    // Health and potions, bottom left.
    // Health: a vial of blood in an iron frame, its end ragged.
    const hw = Math.min(340, w * 0.42);
    const hy = h - pad - 52;
    this._box(g, pad, hy, hw, 24, 'rgba(10,2,2,0.9)', C.edge);
    const frac = Math.max(0, r.health / r.maxHealth);
    const fw = (hw - 10) * frac;
    if (fw > 0) {
      g.save();
      const hg = g.createLinearGradient(0, hy + 5, 0, hy + 19);
      hg.addColorStop(0, '#9a1408');
      hg.addColorStop(0.45, '#6e0a04');
      hg.addColorStop(1, '#320302');
      g.fillStyle = hg;
      g.shadowColor = 'rgba(200,20,0,0.6)';
      g.shadowBlur = 8;
      g.beginPath();
      g.moveTo(pad + 5, hy + 5);
      g.lineTo(pad + 5 + fw, hy + 5);
      for (let k = 1; k <= 4; k++) g.lineTo(pad + 5 + fw - (k % 2) * 3, hy + 5 + k * 3.5);
      g.lineTo(pad + 5, hy + 19);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = this._grain(g);
      g.fill();
      g.restore();
    }
    this._text(g, `${Math.ceil(r.health)} / ${r.maxHealth}`, pad + hw / 2, hy + 13, { size: 12, ls: 1, color: C.light, align: 'center', base: 'middle' });
    for (let k = 0; k < r.potionCap; k++) this._potionIcon(g, pad + k * 24, hy + 28, k < r.potions);
    this._text(g, 'E', pad + r.potionCap * 24 + 2, hy + 40, { size: 11, color: C.ash, base: 'middle' });
    let bx = pad + r.potionCap * 24 + 18;
    if (p.siphonT > 0) bx += this._tag(g, `Blood Siphon ${Math.ceil(p.siphonT)}s`, bx, hy + 40, '#ff6a5a') + 8;
    if (p.invuln > 0.25) this._tag(g, 'Invulnerable', bx, hy + 40, '#c9a0ff');

    // Weapon, bottom right (none until you take up your sword).
    const wd = p?.armed === false ? { name: 'Unarmed', type: r.weapon.type, damage: 0, color: C.ash } : r.weapon;
    const dmg = Math.round(wd.damage * r.dmgMul);
    const wx = w - pad;
    g.font = `${small ? 15 : 18}px ${SERIF}`;
    const ww = Math.max(150, g.measureText(wd.name).width + 34);
    this._box(g, wx - ww, h - pad - 46, ww, 46, C.panel, C.edge);
    this._text(g, wd.name, wx - 14, h - pad - 24, { size: small ? 15 : 18, color: wd.color, align: 'right', glow: 'rgba(40,0,0,0.95)' });
    if (wd.damage) this._label(g, `${WEAPON_TYPES[wd.type].label} · ${dmg} dmg${r.speedMul > 1.001 ? ` · +${Math.round((r.speedMul - 1) * 100)}% speed` : ''}`, wx - 14, h - pad - 9, { size: 10, align: 'right', ls: 1.5 });

    // Spells, bottom centre.
    const sz = small ? 46 : 58;
    const total = SPELL_IDS.length * sz + (SPELL_IDS.length - 1) * 10;
    let sx = (w - total) / 2;
    const sy = h - pad - sz - (this.touch ? 92 : 0);
    for (const id of SPELL_IDS) {
      const lvl = r.spells[id];
      g.globalAlpha = lvl ? 1 : 0.35;
      this._box(g, sx, sy, sz, sz, C.panel, lvl ? C.edge : '#3a1410');
      if (lvl) {
        const cd = (p.spellCd[id] || 0) / SPELLS[id].levels[lvl - 1].cd;
        if (cd > 0) {
          g.fillStyle = 'rgba(0,0,0,0.72)';
          g.fillRect(sx + 1, sy + 1 + (sz - 2) * (1 - cd), sz - 2, (sz - 2) * cd);
        }
      }
      this._text(g, SPELLS[id].label, sx + 8, sy + 16, { size: 12, color: C.ember, glow: 'rgba(140,20,0,0.9)' });
      const words = SPELLS[id].name.toUpperCase().split(' ');
      words.forEach((wd2, k) => this._text(g, wd2, sx + sz / 2, sy + sz / 2 + 2 + (k - (words.length - 1) / 2) * 11, { size: small ? 7 : 8, ls: 1, color: C.bone, align: 'center', base: 'middle' }));
      if (lvl) this._text(g, 'I'.repeat(lvl), sx + sz - 8, sy + sz - 7, { size: 10, color: C.light, align: 'right' });
      g.globalAlpha = 1;
      if (this.touch && lvl) this.buttons.push({ x: sx + sz / 2, y: sy + sz / 2, r: sz / 2, code: SPELLS[id].key });
      sx += sz + 10;
    }

    // Prompt.
    if (i.prompt) {
      g.font = `16px ${SERIF}`;
      const plain = i.prompt.replace(/<[^>]+>/g, '').replace(/&mdash;/g, '—');
      const pw = Math.min(w - 20, g.measureText(plain).width + 30);
      this._box(g, (w - pw) / 2, h * 0.62 - 18, pw, 36, C.panel, C.edge);
      this._rich(g, i.prompt, w / 2, h * 0.62, small ? 13 : 16);
    }

    // Touch controls.
    if (this.touch) this._paintTouch(g);
  }

  _tag(g, text, x, y, color) {
    g.font = `12px ${SERIF}`;
    const tw = g.measureText(text).width + 12;
    this._box(g, x, y - 10, tw, 20, 'rgba(10,3,3,0.7)', color);
    this._text(g, text, x + 6, y, { size: 12, color, base: 'middle' });
    return tw;
  }

  _paintTouch(g) {
    const { w, h } = this;
    const btn = (x, y, r, label, code) => {
      g.fillStyle = 'rgba(30,8,6,0.55)';
      g.strokeStyle = 'rgba(255,140,80,0.6)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      this._text(g, label, x, y, { size: 13, align: 'center', base: 'middle', color: C.light });
      this.buttons.push({ x, y, r, code });
    };
    const bx = w - 70;
    const by = h - 150;
    btn(bx, by, 34, 'STRIKE', 'Mouse0');
    btn(bx - 80, by + 30, 28, 'DODGE', 'Space');
    btn(bx - 40, by - 75, 26, 'POTION', 'KeyE');
    btn(bx + 20, by - 80, 24, 'USE', 'KeyF');
  }

  // A little round-bellied flask: cork, neck, glass body with the blood-red
  // draught and a highlight; an empty one is dark glass.
  _potionIcon(g, x, y, full) {
    const cx = x + 10;
    g.save();
    g.lineWidth = 1.5;
    // Cork and neck.
    g.fillStyle = full ? '#8a5a32' : '#3a2a20';
    g.fillRect(cx - 3, y, 6, 4);
    g.fillStyle = full ? 'rgba(200,190,200,0.35)' : 'rgba(80,70,80,0.3)';
    g.strokeStyle = full ? '#d8c8c0' : '#4a3a38';
    g.beginPath();
    g.rect(cx - 2.5, y + 4, 5, 5);
    g.fill();
    g.stroke();
    // Body.
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

  _paintAnnouncement(g) {
    const a = this.announcement;
    const k = a.t / 3.4;
    const alpha = Math.min(1, a.t / 0.4) * Math.min(1, (1 - k) / 0.25);
    g.globalAlpha = Math.max(0, alpha);
    const size = Math.max(26, Math.min(56, this.w * 0.05));
    this._text(g, a.text.toUpperCase(), this.w / 2, this.h * 0.28, { size, ls: size * 0.08, color: C.light, align: 'center', glow: 'rgba(190,30,0,0.95)' });
    this._divider(g, this.w / 2, this.h * 0.28 + size * 0.32, Math.min(this.w * 0.5, size * 8));
    if (a.sub) this._text(g, a.sub, this.w / 2, this.h * 0.28 + size * 0.85, { size: Math.max(13, size * 0.34), ls: 1, color: C.bone, align: 'center' });
    g.globalAlpha = 1;
  }

  _paintToasts(g) {
    let y = 70;
    for (const t of this.toasts) {
      const a = Math.min(1, (2.8 - t.t) / 0.5);
      g.globalAlpha = Math.max(0, a);
      const plain = t.text.replace(/<[^>]+>/g, '');
      g.font = `14px ${SERIF}`;
      const tw = g.measureText(plain).width + 24;
      const x = this.w - 22 - tw;
      this._box(g, x, y - 15, tw, 30, C.panel, C.edge);
      this._rich(g, t.text, x + 12, y, 14, 'left');
      y += 36;
    }
    g.globalAlpha = 1;
  }

  _dim(g, a = 0.72) {
    g.fillStyle = `rgba(4,1,1,${a})`;
    g.fillRect(0, 0, this.w, this.h);
  }

  _paintTitle(g) {
    const { w, h } = this;
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
        ['Space / Shift', 'dodge', '', ''],
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
    const pw = Math.min(420, this.w - 40);
    this._box(g, (this.w - pw) / 2, this.h * 0.45 - 62, pw, 112, C.panel, C.edge);
    this._text(g, 'PAUSED', this.w / 2, this.h * 0.45, { size: 40, ls: 4, color: C.light, align: 'center', glow: 'rgba(190,30,0,0.9)' });
    this._divider(g, this.w / 2, this.h * 0.45 + 14, pw * 0.7);
    this._label(g, 'Click to return to the dark', this.w / 2, this.h * 0.45 + 36, { align: 'center', color: C.bone });
  }

  _paintChoice(g) {
    const { w, h } = this;
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
      this.buttons.push({ x: w / 2, y: y + bh / 2, w: bw, h: bh, code: `Digit${k + 1}`, rect: true });
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
    const { w, h } = this;
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
    const colW = Math.min(150, (w - 40) / Math.max(1, stats.length));
    stats.forEach(([label, value], k) => {
      const x = w / 2 + (k - (stats.length - 1) / 2) * colW;
      this._label(g, label, x, y, { size: 10, align: 'center' });
      this._text(g, String(value), x, y + 32, { size: 28, color: C.ember, align: 'center', glow: 'rgba(160,30,0,0.9)' });
    });
    if (e.ready) this._label(g, this.touch ? 'Tap to rise again at the surface' : 'Click to rise again at the surface', w / 2, y + 80, { size: 12, align: 'center', color: C.bone });
  }
}
