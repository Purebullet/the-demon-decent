import * as THREE from 'three';
import { buildWeaponMesh, WEAPON_TYPES } from './Weapons.js';
import { SPELLS, SPELL_IDS, MAX_SPELL_LEVEL } from './Spells.js';
import { runeCircleTexture } from '../world/Textures.js';
import { C, burst } from '../world/Particles.js';
import { Assets } from '../assets/AssetLibrary.js';

// Loot on the cavern floor. Potions and spell sigils are taken by walking
// over them; weapons need E so a good blade is never swapped by accident.

const flaskBody = new THREE.SphereGeometry(0.16, 14, 10);
const flaskNeck = new THREE.CylinderGeometry(0.05, 0.06, 0.14, 10);

export class Pickups {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.time = 0;
    this.nearWeapon = null;
  }

  clear() {
    for (const it of this.items) this.scene.remove(it.mesh);
    this.items.length = 0;
  }

  _add(kind, x, z, mesh, extra = {}) {
    mesh.position.set(x, 0.7, z);
    this.scene.add(mesh);
    const it = { kind, mesh, x, z, t: Math.random() * 6, ...extra };
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
    const g = new THREE.Group();
    const w = buildWeaponMesh(weapon);
    w.rotation.z = Math.PI / 2.4;
    w.position.y = -0.3;
    g.add(w);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(weapon.color), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.66;
    g.add(ring);
    return this._add('weapon', x, z, g, { weapon });
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
    let nearestW = 1.8;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      it.mesh.position.y = 0.75 + Math.sin(it.t * 2.2) * 0.08;
      it.mesh.rotation.y += dt * (it.kind === 'spell' ? 1.6 : 0.9);
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
      } else if (it.kind === 'spell' && d < 1.1) {
        const msg = grantSpellSigil(run);
        this._take(i, ctx, msg);
      } else if (it.kind === 'weapon' && d < nearestW) {
        nearestW = d;
        this.nearWeapon = it;
      }
    }
    if (this.nearWeapon && ctx.input.wasPressed('KeyE')) {
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
    const it = this.nearWeapon;
    if (!it) return null;
    const w = it.weapon;
    const def = WEAPON_TYPES[w.type];
    return `<b>E</b> take <span style="color:${w.color}">${w.name}</span> (${def.label}, ${w.damage} dmg) &mdash; holding ${run.weapon.name} (${run.weapon.damage})`;
  }

  _take(i, ctx, label) {
    const it = this.items[i];
    burst(ctx.fx.add, it.mesh.position, { count: 20, speed: 2.5, size: 0.12, life: 0.5, gravity: 0, color: it.kind === 'spell' ? C.violet : C.emberHot, colorEnd: it.kind === 'spell' ? C.violetDark : C.emberRed });
    this.scene.remove(it.mesh);
    this.items.splice(i, 1);
    ctx.audio?.pickup();
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
