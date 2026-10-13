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
const C = {
  bone: '#d8c9a8',
  ash: '#8a7f76',
  ember: '#ff7a2a',
  blood: '#c41a10',
  light: '#ffcfa8',
  panel: 'rgba(12,3,3,0.82)',
  edge: '#5a1a10',
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
    // Painted at the screen's own resolution (up to 2x), so text is crisp.
    this.scale = Math.min(Math.max(1, this.host.pixelRatio || 1), 2);
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

  _text(g, text, x, y, { size = 16, color = C.bone, align = 'left', base = 'alphabetic', glow = null, weight = '' } = {}) {
    g.font = `${weight}${size}px ${SERIF}`;
    g.textAlign = align;
    g.textBaseline = base;
    g.shadowColor = glow || 'rgba(0,0,0,0.9)';
    g.shadowBlur = glow ? 18 : 4;
    g.fillStyle = color;
    g.fillText(text, x, y);
    g.shadowBlur = 0;
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

  _box(g, x, y, w, h, fill = C.panel, stroke = C.edge) {
    g.fillStyle = fill;
    g.fillRect(x, y, w, h);
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
  }

  _paintPlaying(g) {
    const { w, h } = this;
    const i = this.info;
    const r = i.run;
    const p = i.player;
    const small = w < 700;
    const pad = small ? 12 : 22;

    // Top corners (Project 0's own bar sits at the top centre).
    this._text(g, i.floorLabel || '', pad, 30, { size: small ? 13 : 15 });
    this._text(g, i.enemyLabel || '', w - pad, 30, { size: small ? 13 : 15, color: C.ember, align: 'right' });
    if (!small && i.best) this._text(g, `Deepest: Floor ${i.best}`, w - pad, 50, { size: 13, color: C.ash, align: 'right' });

    // Crosshair.
    g.fillStyle = 'rgba(255,200,160,0.85)';
    g.beginPath();
    g.arc(w / 2, h / 2, 3, 0, Math.PI * 2);
    g.fill();

    // Compass toward the exit or the last few demons.
    if (i.compass) {
      g.save();
      g.translate(w / 2, 88);
      g.rotate(i.compass.angle);
      g.fillStyle = i.compass.kind === 'exit' ? C.ember : '#d03030';
      g.shadowColor = 'rgba(255,90,20,0.9)';
      g.shadowBlur = 8;
      g.beginPath();
      g.moveTo(0, -14);
      g.lineTo(10, 10);
      g.lineTo(-10, 10);
      g.closePath();
      g.fill();
      g.restore();
    }

    // Boss bar.
    if (i.boss) {
      const bw = Math.min(620, w * 0.8);
      const bx = (w - bw) / 2;
      this._text(g, i.boss.name, w / 2, 126, { size: small ? 14 : 18, color: '#ffb38a', align: 'center', glow: 'rgba(255,60,20,0.8)' });
      this._box(g, bx, 134, bw, 12, 'rgba(20,4,4,0.85)', '#5a1a10');
      const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, '#6a0a04');
      grad.addColorStop(0.6, '#d4300c');
      grad.addColorStop(1, '#ff8a3a');
      g.fillStyle = grad;
      g.fillRect(bx + 1, 135, (bw - 2) * Math.max(0, i.boss.health / i.boss.maxHealth), 10);
    }

    // Health and potions, bottom left.
    const hw = Math.min(340, w * 0.42);
    const hy = h - pad - (this.touch ? 0 : 0) - 50;
    this._box(g, pad, hy, hw, 22, 'rgba(15,3,3,0.85)', '#4a1510');
    const frac = Math.max(0, r.health / r.maxHealth);
    const hg = g.createLinearGradient(0, hy, 0, hy + 22);
    hg.addColorStop(0, '#d2241a');
    hg.addColorStop(1, '#7a0a06');
    g.fillStyle = hg;
    g.fillRect(pad + 1, hy + 1, (hw - 2) * frac, 20);
    this._text(g, `${Math.ceil(r.health)} / ${r.maxHealth}`, pad + hw / 2, hy + 12, { size: 13, align: 'center', base: 'middle' });
    for (let k = 0; k < r.potionCap; k++) this._potionIcon(g, pad + k * 24, hy + 28, k < r.potions);
    this._text(g, 'E', pad + r.potionCap * 24 + 2, hy + 40, { size: 11, color: C.ash, base: 'middle' });
    let bx = pad + r.potionCap * 24 + 18;
    if (p.siphonT > 0) bx += this._tag(g, `Blood Siphon ${Math.ceil(p.siphonT)}s`, bx, hy + 40, '#ff6a5a') + 8;
    if (p.invuln > 0.25) this._tag(g, 'Invulnerable', bx, hy + 40, '#c9a0ff');

    // Weapon, bottom right.
    const wd = r.weapon;
    const dmg = Math.round(wd.damage * r.dmgMul);
    const wx = w - pad;
    this._text(g, wd.name, wx, h - pad - 22, { size: small ? 15 : 19, color: wd.color, align: 'right' });
    this._text(g, `${WEAPON_TYPES[wd.type].label} · ${dmg} dmg${r.speedMul > 1.001 ? ` · +${Math.round((r.speedMul - 1) * 100)}% speed` : ''}`, wx, h - pad - 4, { size: 13, color: C.ash, align: 'right' });

    // Spells, bottom centre.
    const sz = small ? 46 : 58;
    const total = SPELL_IDS.length * sz + (SPELL_IDS.length - 1) * 10;
    let sx = (w - total) / 2;
    const sy = h - pad - sz - (this.touch ? 92 : 0);
    for (const id of SPELL_IDS) {
      const lvl = r.spells[id];
      g.globalAlpha = lvl ? 1 : 0.3;
      this._box(g, sx, sy, sz, sz, 'rgba(20,6,4,0.8)', '#6a3a1a');
      if (lvl) {
        const cd = (p.spellCd[id] || 0) / SPELLS[id].levels[lvl - 1].cd;
        if (cd > 0) {
          g.fillStyle = 'rgba(0,0,0,0.72)';
          g.fillRect(sx + 1, sy + 1 + (sz - 2) * (1 - cd), sz - 2, (sz - 2) * cd);
        }
      }
      this._text(g, SPELLS[id].label, sx + 5, sy + 13, { size: 12, color: C.ember });
      const words = SPELLS[id].name.split(' ');
      words.forEach((wd2, k) => this._text(g, wd2, sx + sz / 2, sy + sz / 2 + (k - (words.length - 1) / 2) * 11, { size: small ? 8 : 9, align: 'center', base: 'middle' }));
      if (lvl) this._text(g, 'I'.repeat(lvl), sx + sz - 5, sy + sz - 4, { size: 10, color: '#ffcf8a', align: 'right' });
      g.globalAlpha = 1;
      if (this.touch && lvl) this.buttons.push({ x: sx + sz / 2, y: sy + sz / 2, r: sz / 2, code: SPELLS[id].key });
      sx += sz + 10;
    }

    // Prompt.
    if (i.prompt) {
      g.font = `16px ${SERIF}`;
      const plain = i.prompt.replace(/<[^>]+>/g, '').replace(/&mdash;/g, '—');
      const pw = Math.min(w - 20, g.measureText(plain).width + 30);
      this._box(g, (w - pw) / 2, h * 0.62 - 16, pw, 32, 'rgba(10,3,3,0.72)', '#4a1a10');
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
    this._text(g, a.text.toUpperCase(), this.w / 2, this.h * 0.28, { size, color: C.light, align: 'center', glow: 'rgba(255,60,10,0.9)' });
    if (a.sub) this._text(g, a.sub, this.w / 2, this.h * 0.28 + size * 0.85, { size: Math.max(14, size * 0.38), color: C.ash, align: 'center' });
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
      this._box(g, x, y - 14, tw, 28, 'rgba(12,3,3,0.8)', null);
      g.fillStyle = C.ember;
      g.fillRect(x, y - 14, 2, 28);
      this._rich(g, t.text, x + 12, y, 14, 'left');
      y += 34;
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
    this._text(g, 'THE DEMON DESCENT', w / 2, y, { size: big, color: '#ffd8b8', align: 'center', glow: 'rgba(255,50,10,0.95)' });
    y += big * 0.7;
    this._text(g, 'Twenty floors down. One life. No armour. No mercy.', w / 2, y, { size: Math.max(13, big * 0.24), color: C.ash, align: 'center' });
    y += big * 0.9;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 2.6);
    g.font = `${Math.max(16, big * 0.27)}px ${SERIF}`;
    const label = this.touch ? 'Tap to enter the pit' : 'Click to enter the pit';
    const bw = g.measureText(label).width + 48;
    g.shadowColor = `rgba(255,60,10,${0.4 + pulse * 0.4})`;
    g.shadowBlur = 24;
    this._box(g, (w - bw) / 2, y - 22, bw, 44, 'rgba(60,8,4,0.6)', '#8a2a14');
    g.shadowBlur = 0;
    this._text(g, label, w / 2, y, { size: Math.max(16, big * 0.27), color: C.light, align: 'center', base: 'middle' });
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
      this._text(g, "THIS WEEK'S DEEPEST", w / 2, y, { size: 12, color: C.ash, align: 'center' });
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
        ['Left click', 'attack', 'Space / Shift', 'dodge'],
        ['E', 'drink potion', '1 2 3', 'demon spells'],
        ['F', 'take / use', '', ''],
      ];
      let cy = Math.max(y + 20, h - 24 - rows.length * 19);
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
    this._text(g, 'PAUSED', this.w / 2, this.h * 0.45, { size: 44, color: C.light, align: 'center', glow: 'rgba(255,50,10,0.6)' });
    this._text(g, 'Click to return to the dark', this.w / 2, this.h * 0.45 + 40, { size: 15, color: C.ash, align: 'center' });
  }

  _paintChoice(g) {
    const { w, h } = this;
    this._dim(g, 0.55);
    const c = this.choice;
    this._text(g, c.title.toUpperCase(), w / 2, h * 0.3, { size: Math.min(36, w * 0.06), color: C.light, align: 'center', glow: 'rgba(255,60,10,0.8)' });
    const bw = Math.min(560, w - 30);
    let y = h * 0.3 + 30;
    c.options.forEach((o, k) => {
      const bh = o.detail ? 62 : 46;
      this._box(g, (w - bw) / 2, y, bw, bh, 'rgba(20,5,4,0.88)', '#6a2a14');
      this._text(g, String(k + 1), (w - bw) / 2 + 22, y + bh / 2, { size: 26, color: C.ember, align: 'center', base: 'middle' });
      this._text(g, o.label, (w - bw) / 2 + 46, y + (o.detail ? 22 : bh / 2), { size: 17, base: 'middle' });
      if (o.detail) this._wrap(g, o.detail, (w - bw) / 2 + 46, y + 42, bw - 60, 12, C.ash);
      this.buttons.push({ x: w / 2, y: y + bh / 2, w: bw, h: bh, code: `Digit${k + 1}`, rect: true });
      y += bh + 10;
    });
    this._text(g, this.touch ? 'Tap a blessing · only one altar may be woken' : 'Press 1 or 2 to choose · Q to step back · only one altar may be woken', w / 2, y + 22, { size: 13, color: C.ash, align: 'center' });
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
    this._text(g, won ? 'HELL IS CONQUERED' : 'YOU DIED', w / 2, h * 0.36, { size: won ? big * 0.75 : big, color: won ? '#ffd28a' : C.blood, align: 'center', glow: won ? 'rgba(255,120,0,0.8)' : 'rgba(255,0,0,0.6)' });
    let y = h * 0.36 + 40;
    for (const line of e.lines || []) {
      this._text(g, line, w / 2, y, { size: 17, align: 'center' });
      y += 24;
    }
    y += 18;
    const stats = e.stats || [];
    const colW = Math.min(150, (w - 40) / Math.max(1, stats.length));
    stats.forEach(([label, value], k) => {
      const x = w / 2 + (k - (stats.length - 1) / 2) * colW;
      this._text(g, label.toUpperCase(), x, y, { size: 11, color: C.ash, align: 'center' });
      this._text(g, String(value), x, y + 32, { size: 28, color: C.ember, align: 'center' });
    });
    if (e.ready) this._text(g, this.touch ? 'Tap to rise again at the surface' : 'Click to rise again at the surface', w / 2, y + 80, { size: 15, color: C.ash, align: 'center' });
  }
}
