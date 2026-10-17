import * as THREE from 'three';
import { buildWeaponMesh, WEAPON_TYPES, RARITIES } from './Weapons.js';
import { SPELLS, SPELL_IDS, MAX_SPELL_LEVEL } from './Spells.js';
import { runeCircleTexture, softDotTexture, lightShaftTexture } from '../world/Textures.js';
import { C, burst } from '../world/Particles.js';
import { Assets } from '../assets/AssetLibrary.js';
import { RELICS, addRelic } from '../combat/Relics.js';
import { IconAtlas } from '../ui/IconAtlas.js';

// Loot on the cavern floor. Potions are taken by walking over them; weapons,
// spell sigils (abilities) and relics (attributes) are taken up with F, each
// with its own sound, and anything worth having that drops while you are
// there lands with a sound of its own.

// Within this of one, F takes it.
const REACH = 1.8;

const flaskBody = new THREE.SphereGeometry(0.16, 24, 16);
const flaskNeck = new THREE.CylinderGeometry(0.05, 0.06, 0.14, 16);

// How a dropped weapon shows its rarity (common first): its edges lit in the
// rarity's colour, a shaft of that light standing over it (taller and
// brighter the rarer), a ring on the floor, and sparks rising off the rarest.
const SHINE = [
  { rim: 0.45, shaft: 1.3, glow: 0.3, sparks: 0 },
  { rim: 0.7, shaft: 2.1, glow: 0.45, sparks: 2 },
  { rim: 0.9, shaft: 2.7, glow: 0.55, sparks: 4 },
  { rim: 1.15, shaft: 3.4, glow: 0.7, sparks: 7 },
  { rim: 1.5, shaft: 4.6, glow: 0.95, sparks: 12 },
];
const shaftGeo = new THREE.PlaneGeometry(0.9, 1).translate(0, 0.5, 0);

export class Pickups {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.time = 0;
    this.nearWeapon = null;
    this.nearItem = null;
    // Quiet while a floor is being laid out (Game lifts it once it is up):
    // only what drops in play makes a sound landing.
    this.quiet = true;
  }

  clear() {
    for (const it of this.items) this.scene.remove(it.mesh);
    this.items.length = 0;
  }

  _add(kind, x, z, mesh, extra = {}) {
    mesh.position.set(x, 0.7, z);
    this.scene.add(mesh);
    const it = { kind, mesh, x, z, t: Math.random() * 6, fresh: !this.quiet && kind !== 'potion', ...extra };
    this.items.push(it);
    return it;
  }

  addPotion(x, z) {
    const gen = Assets.instanceProp('potion');
    if (gen) return this._add('potion', x, z, gen);
    const g = new THREE.Group();
    const liquid = new THREE.MeshStandardMaterial({ color: 0x9a0010, emissive: 0xff1020, emissiveIntensity: 1.3, roughness: 0.2, transparent: true, opacity: 0.92 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x664444, roughness: 0.1, metalness: 0.3 });
    g.add(new THREE.Mesh(flaskBody, liquid));
    const neck = new THREE.Mesh(flaskNeck, glass);
    neck.position.y = 0.2;
    g.add(neck);
    return this._add('potion', x, z, g);
  }

  addWeapon(x, z, weapon) {
    const S = SHINE[weapon.rarity];
    const col = new THREE.Color(weapon.color);
    const g = new THREE.Group();
    const w = buildWeaponMesh(weapon, { rim: S ? S.rim : 0 });
    w.rotation.z = Math.PI / 2.4;
    w.position.y = -0.3;
    g.add(w);
    const ringMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.66;
    g.add(ring);
    let shaft = null;
    if (S) {
      // Stands on the floor and turns to face you (update()).
      shaft = new THREE.Mesh(shaftGeo, new THREE.MeshBasicMaterial({ map: lightShaftTexture(), color: col.clone().multiplyScalar(S.glow), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      shaft.scale.y = S.shaft;
      g.add(shaft);
    }
    return this._add('weapon', x, z, g, { weapon, shaft, sparks: S?.sparks ?? 0, glow: col });
  }

  // Your own sword, lying on the floor where the fall flung it.
  addStarter(x, z, weapon, yaw) {
    const g = new THREE.Group();
    const w = buildWeaponMesh(weapon);
    w.rotation.set(Math.PI / 2, 0, 0.6);
    w.position.y = 0.05;
    g.add(w);
    g.rotation.y = yaw;
    const it = this._add('weapon', x, z, g, { weapon, starter: true });
    g.position.y = 0;
    return it;
  }

  // A relic: its painted icon hanging in the air in a halo of its colour.
  addRelic(x, z, id) {
    const R = RELICS[id];
    const g = new THREE.Group();
    const col = new THREE.Color(R.color);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture(), color: col, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    halo.scale.set(1.5, 1.5, 1);
    g.add(halo);
    const tex = IconAtlas.texture(id);
    if (tex) {
      const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      icon.scale.set(0.85, 0.85, 1);
      g.add(icon);
    } else {
      g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.5 })));
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 64), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.62;
    g.add(ring);
    return this._add('relic', x, z, g, { relic: id, color: col, noSpin: true });
  }

  addSpell(x, z) {
    const g = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ map: runeCircleTexture('#c060ff'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), m);
    g.add(disc);
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), new THREE.MeshStandardMaterial({ color: 0x8030ff, emissive: 0xa050ff, emissiveIntensity: 2 }));
    g.add(core);
    return this._add('spell', x, z, g);
  }

  update(dt, ctx) {
    this.time += dt;
    const p = ctx.player.position;
    const run = ctx.player.run;
    this.nearWeapon = null;
    this.nearItem = null;
    let near = null;
    let nearest = REACH;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.fresh) {
        it.fresh = false;
        ctx.audio?.drop?.(it.mesh.position);
      }
      if (!it.starter) {
        it.mesh.position.y = 0.75 + Math.sin(it.t * 2.2) * 0.08;
        if (!it.noSpin) it.mesh.rotation.y += dt * (it.kind === 'spell' ? 1.6 : 0.9);
      }
      if (it.shaft) {
        // Kept still on the floor, square to the eye, while the weapon turns;
        // fading as you walk into it, so it never blinds you.
        it.shaft.position.y = -it.mesh.position.y;
        it.shaft.rotation.y = Math.atan2(p.x - it.x, p.z - it.z) - it.mesh.rotation.y;
        const near = Math.min(1, Math.max(0.12, (Math.hypot(p.x - it.x, p.z - it.z) - 0.4) / 1.8));
        it.shaft.material.opacity = (0.85 + Math.sin(it.t * 3.1) * 0.15) * near;
      }
      if (it.sparks && Math.random() < dt * it.sparks) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.2 + Math.random() * 0.4;
        ctx.fx.add.emit({ x: it.x + Math.cos(a) * r, y: 0.15 + Math.random() * 0.4, z: it.z + Math.sin(a) * r, vx: 0, vy: 0.9 + Math.random() * 0.6, vz: 0, life: 1.1, size: 0.09, sizeEnd: 0.01, color: it.glow, colorEnd: it.glow, drag: 0.4 });
      }
      if (it.kind === 'relic' && Math.random() < dt * 12) {
        ctx.fx.add.emit({ x: it.x + (Math.random() - 0.5) * 0.5, y: 0.4 + Math.random() * 0.6, z: it.z + (Math.random() - 0.5) * 0.5, vx: 0, vy: 0.7, vz: 0, life: 0.9, size: 0.12, sizeEnd: 0.02, color: it.color, colorEnd: C.violetDark, drag: 0.5 });
      }
      if (it.kind === 'potion' && Math.random() < dt * 4) {
        ctx.fx.add.emit({ x: it.x, y: 0.9, z: it.z, vx: (Math.random() - 0.5) * 0.3, vy: 0.6, vz: (Math.random() - 0.5) * 0.3, life: 0.8, size: 0.12, color: C.blood, colorEnd: C.bloodDark });
      }
      if (it.kind === 'spell' && Math.random() < dt * 10) {
        ctx.fx.add.emit({ x: it.x, y: 0.75, z: it.z, vx: (Math.random() - 0.5), vy: 0.8, vz: (Math.random() - 0.5), life: 0.9, size: 0.14, color: C.violet, colorEnd: C.violetDark });
      }
      const d = Math.hypot(p.x - it.x, p.z - it.z);
      if (ctx.player.dead) continue;
      if (it.kind === 'potion' && d < 1.1) {
        if (run.potions < run.potionCap) {
          run.potions++;
          this._take(i, ctx, 'Health potion');
        } else if (!it.warned) {
          it.warned = true;
          ctx.toast?.('Potions full');
        }
      } else if (it.kind !== 'potion' && d < nearest) {
        nearest = d;
        near = it;
      }
    }
    if (near?.kind === 'weapon') this.nearWeapon = near;
    else this.nearItem = near;
    if (this.nearItem && ctx.input.wasPressed('KeyF')) {
      const it = this.nearItem;
      const i = this.items.indexOf(it);
      if (it.kind === 'spell') this._take(i, ctx, grantSpellSigil(run), true);
      else {
        const R = RELICS[it.relic];
        const n = addRelic(run, it.relic);
        this._take(i, ctx, n > 1 ? `${R.name} deepens (x${n})` : `Relic: ${R.name}`, true);
        ctx.onRelic?.(it.relic, n);
      }
      ctx.input.pressed.delete('KeyF');
      this.nearItem = null;
    }
    if (this.nearWeapon && this.nearWeapon.starter && ctx.input.wasPressed('KeyF')) {
      const it = this.nearWeapon;
      ctx.player.armed = true;
      this.scene.remove(it.mesh);
      this.items.splice(this.items.indexOf(it), 1);
      ctx.audio?.pickup();
      ctx.toast?.(`${it.weapon.name} in hand`);
      this.nearWeapon = null;
    } else if (this.nearWeapon && ctx.input.wasPressed('KeyF')) {
      const it = this.nearWeapon;
      const old = run.weapon;
      ctx.player.setWeapon(it.weapon);
      this.scene.remove(it.mesh);
      this.items.splice(this.items.indexOf(it), 1);
      this.addWeapon(it.x + 0.4, it.z + 0.4, old);
      ctx.audio?.pickup();
      ctx.toast?.(`Took ${it.weapon.name}`);
      this.nearWeapon = null;
    }
  }

  weaponPrompt(run) {
    const item = this.nearItem;
    if (item?.kind === 'spell') return '<b>F</b> take the demon sigil';
    if (item?.kind === 'relic') {
      const R = RELICS[item.relic];
      return `<b>F</b> take the relic <span style="color:#${item.color.getHexString()}">${R.name}</span>`;
    }
    const it = this.nearWeapon;
    if (!it) return null;
    const w = it.weapon;
    const def = WEAPON_TYPES[w.type];
    if (it.starter) return `<b>F</b> take up your <span style="color:${w.color}">${w.name}</span>`;
    const R = RARITIES[w.rarity];
    const held = run.weapon;
    return `<b>F</b> take <span style="color:${w.color}">${w.name}</span> (${R ? `${R.name} ` : ''}${def.label}, ${w.damage} dmg) &mdash; holding <span style="color:${held.color}">${held.name}</span> (${held.damage})`;
  }

  // Taken: a burst of its light; `grand` (a sigil or a relic) with its own
  // sound and a ring of light going up round you.
  _take(i, ctx, label, grand = false) {
    const it = this.items[i];
    const col = it.color || (it.kind === 'spell' ? C.violet : C.emberHot);
    burst(ctx.fx.add, it.mesh.position, { count: it.color || grand ? 40 : 20, speed: it.color || grand ? 4 : 2.5, size: 0.12, life: 0.5, gravity: 0, color: col, colorEnd: it.kind === 'spell' ? C.violetDark : C.emberRed });
    if (grand) {
      const p = ctx.player.position;
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        ctx.fx.add.emit({ x: p.x + Math.cos(a) * 0.7, y: 0.2, z: p.z + Math.sin(a) * 0.7, vx: Math.cos(a) * 0.4, vy: 2.6 + Math.random(), vz: Math.sin(a) * 0.4, life: 0.9, size: 0.1, sizeEnd: 0.02, color: col, colorEnd: C.violetDark, drag: 0.6 });
      }
    }
    this.scene.remove(it.mesh);
    this.items.splice(i, 1);
    if (grand) ctx.audio?.acquire?.();
    else ctx.audio?.pickup();
    ctx.toast?.(label);
  }
}

// A sigil unlocks a spell you lack, else deepens one you have.
export function grantSpellSigil(run) {
  const locked = SPELL_IDS.filter((id) => run.spells[id] === 0);
  const upgradable = SPELL_IDS.filter((id) => run.spells[id] > 0 && run.spells[id] < MAX_SPELL_LEVEL);
  const pool = locked.length ? locked : upgradable;
  if (!pool.length) {
    run.dmgMul *= 1.05;
    return 'Demon sigil: +5% damage';
  }
  const id = pool[Math.floor(Math.random() * pool.length)];
  run.spells[id]++;
  return run.spells[id] === 1 ? `Spell learned: ${SPELLS[id].name} [${SPELLS[id].label}]` : `${SPELLS[id].name} rises to level ${run.spells[id]}`;
}
