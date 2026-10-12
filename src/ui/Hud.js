import * as THREE from 'three';
import { SPELLS, SPELL_IDS } from '../entities/Spells.js';
import { WEAPON_TYPES } from '../entities/Weapons.js';

// DOM overlay: health, potions, weapon, spell cooldowns, boss bar, prompts,
// floating damage numbers and the full-screen panels (title, pause, choice,
// death, victory). Writes to the DOM only when a value changes.

const $ = (id) => document.getElementById(id);
const tmp = new THREE.Vector3();

export class Hud {
  constructor() {
    this.el = {};
    for (const id of [
      'hud', 'hpFill', 'hpGhost', 'hpText', 'potions', 'weaponName', 'weaponStats', 'spells', 'floorLabel', 'enemyCount', 'bestLabel',
      'bossbar', 'bossName', 'bossFill', 'prompt', 'toasts', 'announce', 'dmgNumbers', 'vignette', 'lowhp', 'fade',
      'title', 'titleBest', 'pause', 'choice', 'choiceTitle', 'choiceOptions', 'death', 'deathText', 'victory', 'victoryText', 'buffs',
    ]) {
      this.el[id] = $(id);
    }
    this.cache = {};
    this.numbers = [];
    this.ghostHp = 1;
    this.spellEls = {};
    for (const id of SPELL_IDS) {
      const d = document.createElement('div');
      d.className = 'spell locked';
      d.innerHTML = `<div class="cd"></div><span class="key">${SPELLS[id].label}</span><span class="nm">${SPELLS[id].name}</span><span class="lv"></span>`;
      this.el.spells.appendChild(d);
      this.spellEls[id] = { root: d, cd: d.querySelector('.cd'), lv: d.querySelector('.lv') };
    }
  }

  _set(key, el, prop, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    if (prop === 'html') el.innerHTML = value;
    else if (prop === 'text') el.textContent = value;
    else el.style[prop] = value;
  }

  show(id, on) {
    this._set(`show_${id}`, this.el[id], 'display', on ? '' : 'none');
  }

  setPlaying(on) {
    this.show('hud', on);
  }

  update(dt, player, run, info) {
    const frac = Math.max(0, run.health / run.maxHealth);
    this.ghostHp = Math.max(frac, this.ghostHp - dt * 0.4);
    this._set('hp', this.el.hpFill, 'width', `${(frac * 100).toFixed(1)}%`);
    this._set('hpg', this.el.hpGhost, 'width', `${(this.ghostHp * 100).toFixed(1)}%`);
    this._set('hpt', this.el.hpText, 'text', `${Math.ceil(run.health)} / ${run.maxHealth}`);
    this._set('pot', this.el.potions, 'html', Array.from({ length: run.potionCap }, (_, i) => `<i class="flask${i < run.potions ? ' full' : ''}"></i>`).join(''));
    const w = run.weapon;
    this._set('wn', this.el.weaponName, 'html', `<span style="color:${w.color}">${w.name}</span>`);
    const dmg = Math.round(w.damage * run.dmgMul);
    this._set('ws', this.el.weaponStats, 'text', `${WEAPON_TYPES[w.type].label} · ${dmg} dmg${run.speedMul > 1.001 ? ` · +${Math.round((run.speedMul - 1) * 100)}% speed` : ''}`);
    for (const id of SPELL_IDS) {
      const s = this.spellEls[id];
      const lvl = run.spells[id];
      this._set(`sl_${id}`, s.root, 'className', lvl ? 'spell' : 'spell locked');
      this._set(`sv_${id}`, s.lv, 'text', lvl ? 'I'.repeat(lvl) : '');
      const cd = lvl ? player.spellCd[id] / SPELLS[id].levels[lvl - 1].cd : 0;
      this._set(`sc_${id}`, s.cd, 'height', `${Math.round(cd * 100)}%`);
    }
    this._set('floor', this.el.floorLabel, 'text', info.floorLabel || '');
    this._set('ec', this.el.enemyCount, 'text', info.enemyLabel || '');
    this._set('best', this.el.bestLabel, 'text', `Deepest: ${info.best ? `Floor ${info.best}` : '—'}`);
    const buffs = [];
    if (player.siphonT > 0) buffs.push(`<span class="buff blood">Blood Siphon ${player.siphonT.toFixed(0)}s</span>`);
    if (player.invuln > 0.25) buffs.push('<span class="buff shade">Invulnerable</span>');
    this._set('buffs', this.el.buffs, 'html', buffs.join(''));

    // Damage vignette and low-health pulse.
    this._set('vig', this.el.vignette, 'opacity', player.hurtFlash.toFixed(2));
    const low = frac < 0.3 && !player.dead ? (0.3 - frac) / 0.3 : 0;
    this._set('low', this.el.lowhp, 'opacity', (low * (0.6 + Math.sin(performance.now() * 0.006) * 0.4)).toFixed(2));

    if (info.boss) {
      this.show('bossbar', true);
      this._set('bn', this.el.bossName, 'text', info.boss.name);
      this._set('bf', this.el.bossFill, 'width', `${((info.boss.health / info.boss.maxHealth) * 100).toFixed(1)}%`);
    } else {
      this.show('bossbar', false);
    }
    this._set('prompt', this.el.prompt, 'html', info.prompt || '');
    this.show('prompt', !!info.prompt);
  }

  toast(text) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.innerHTML = text;
    this.el.toasts.appendChild(d);
    setTimeout(() => d.classList.add('out'), 2200);
    setTimeout(() => d.remove(), 2800);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  announce(text, sub = '') {
    const a = this.el.announce;
    a.innerHTML = `<div class="big">${text}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`;
    a.classList.remove('show');
    void a.offsetWidth;
    a.classList.add('show');
  }

  damageNumber(pos, amount, crit) {
    if (amount <= 0) return;
    const d = document.createElement('div');
    d.className = crit ? 'dmg crit' : 'dmg';
    d.textContent = Math.round(amount);
    this.el.dmgNumbers.appendChild(d);
    this.numbers.push({ d, pos: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.4, (Math.random() - 0.5) * 0.4)), t: 0 });
    if (this.numbers.length > 30) this.numbers.shift().d.remove();
  }

  updateNumbers(dt, camera) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.t += dt;
      n.pos.y += dt * 0.9;
      tmp.copy(n.pos).project(camera);
      if (n.t > 0.9 || tmp.z > 1) {
        n.d.remove();
        this.numbers.splice(i, 1);
        continue;
      }
      n.d.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -50%)`;
      n.d.style.opacity = String(Math.min(1, (0.9 - n.t) * 4));
    }
  }

  clearNumbers() {
    for (const n of this.numbers) n.d.remove();
    this.numbers.length = 0;
  }

  // Fade to black and back; returns a promise resolved at full black.
  fade(toBlack, ms = 450) {
    const f = this.el.fade;
    f.style.transition = `opacity ${ms}ms ease`;
    f.style.opacity = toBlack ? '1' : '0';
    return new Promise((res) => setTimeout(res, ms));
  }

  showChoice(title, options) {
    this.el.choiceTitle.textContent = title;
    this.el.choiceOptions.innerHTML = options
      .map((o, i) => `<div class="opt"><span class="key">${i + 1}</span><div><div class="lbl">${o.label}</div>${o.detail ? `<div class="det">${o.detail}</div>` : ''}</div></div>`)
      .join('');
    this.show('choice', true);
  }

  hideChoice() {
    this.show('choice', false);
  }
}
