import * as THREE from 'three';
import { TILE } from './LevelData.js';
import { Assets } from '../assets/AssetLibrary.js';
import { Hurtbox } from '../physics/Hitbox.js';
import { softDotTexture } from './Textures.js';
import { C, burst } from './Particles.js';
import { rollWeapon } from '../entities/Weapons.js';
import { rollRelic } from '../combat/Relics.js';
import { mulberry32 } from '../core/rng.js';

// Things on a cavern floor you can do something with:
//
//   Chests sit at the ends of dead-end passages. F opens one: it jolts, a
//   burst of light, and one thing spills out in front of it (a relic, a
//   weapon, a potion or a demon sigil).
//   Breakables (burial urns, rotten barrels, crates, and in the Deep upright
//   coffins) stand in groups along the walls of the rooms, and much of the
//   dressing by the walls breaks too (bones, skulls, stakes, eggs, fungus,
//   crystals, pyres, statues: Dressing's FRAGILE). A blow smashes one into
//   flying pieces; some hold a potion. An urn holds slime that
//   coats the blade (Player.coat): block while it is coated and the blade
//   catches fire.
//
// Both block movement while whole (circles in the floor's collision world)
// and never sit inside another prop's footprint (Dressing.free/claim).

const CHEST_MAX = 3;
const CHEST_REACH = 1.8;
const CHEST_FRONT = Math.PI / 2;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const SLIME = new THREE.Color(0.45, 0.95, 0.2);
const SLIME_DARK = new THREE.Color(0.1, 0.35, 0.05);
// What else bursts out of a broken piece of dressing.
const SHARDS = {
  eggs: [SLIME, SLIME_DARK],
  fungus: [new THREE.Color(0.5, 1, 0.45), new THREE.Color(0.08, 0.3, 0.1)],
  crystal: [new THREE.Color(1, 0.4, 0.25), new THREE.Color(0.35, 0.05, 0.05)],
  pyre: [new THREE.Color(1, 0.6, 0.2), new THREE.Color(0.3, 0.05, 0)],
};
const GONE = new THREE.Matrix4().makeScale(0, 0, 0);
const PIECE = new THREE.IcosahedronGeometry(1, 0);

export class Props {
  constructor(level) {
    this.level = level;
    this.group = new THREE.Group();
    level.group.add(this.group);
    this.r = mulberry32(level.floor * 31337 + 5);
    this.chests = [];
    this.breakables = [];
    this.debris = [];
    this.nearChest = null;
    this.time = 0;
    this.glowMat = new THREE.SpriteMaterial({ map: softDotTexture(), color: 0xffb040, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
    this._occupied();
    if (Assets.hasProp('chest')) this._chests();
    this._breakables();
    this._fragile();
  }

  // Tiles that already hold something the map placed.
  _occupied() {
    const d = this.level.data;
    this.busy = new Set();
    for (const t of [d.spawn, d.exit, d.boss, ...d.enemies, ...d.potions, ...d.weapons, ...d.lava, ...d.spikes, ...d.vents].filter(Boolean)) {
      const c = t.c ?? Math.floor(t.x / TILE);
      const r = t.r ?? Math.floor(t.z / TILE);
      this.busy.add(r * d.cols + c);
    }
  }

  _solid(c, r) {
    return !this.level.data.nav.isWalkable(c, r);
  }

  // Dead ends: open tiles walled on three sides. Up to three, spread apart,
  // the farthest from where you arrive first.
  _chests() {
    const d = this.level.data;
    const dressing = this.level.dressing;
    const ends = [];
    for (const t of d.floorTiles) {
      if (this.busy.has(t.r * d.cols + t.c)) continue;
      const open = DIRS.filter(([dc, dr]) => !this._solid(t.c + dc, t.r + dr));
      if (open.length !== 1) continue;
      ends.push({ t, dir: open[0], far: Math.hypot(t.x - d.spawn.x, t.z - d.spawn.z) });
    }
    ends.sort((a, b) => b.far - a.far);
    for (const e of ends) {
      if (this.chests.length >= CHEST_MAX) break;
      if (this.chests.some((c) => Math.hypot(c.x - e.t.x, c.z - e.t.z) < 12)) continue;
      // A little out from the closed end (clear of the rock that closes it),
      // facing out along the passage.
      const [dc, dr] = e.dir;
      const x = e.t.x + dc * 0.3;
      const z = e.t.z + dr * 0.3;
      if (!dressing.free(x, z, 0.6)) continue;
      dressing.claim(x, z, 0.7);
      this._addChest(x, z, Math.atan2(dc, dr));
    }
  }

  _addChest(x, z, yaw) {
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    // The model's lock faces its -X: turned so it faces `yaw`, the way out
    // of the nook (where you come from).
    root.rotation.y = yaw + CHEST_FRONT;
    const mesh = Assets.instanceProp('chest', { own: true });
    root.add(mesh);
    // A faint golden glow so a chest reads in the dark.
    const glow = new THREE.Sprite(this.glowMat.clone());
    glow.position.y = 0.6;
    glow.scale.setScalar(1.6);
    root.add(glow);
    this.group.add(root);
    const circle = { x, z, r: 0.55 };
    this.level.world.circles.push(circle);
    this.chests.push({ x, z, yaw, root, mesh, glow, circle, opened: false, openT: -1 });
  }

  // Groups of one to three urns or barrels along the walls of rooms (never
  // in a one-tile passage, so nothing is ever blocked).
  _breakables() {
    const kinds = ['urn', 'barrel', 'crate', ...(this.level.look.deep ? ['coffin'] : [])].filter((id) => Assets.hasProp(id));
    if (!kinds.length) return;
    const d = this.level.data;
    const dressing = this.level.dressing;
    const r = this.r;
    const slots = dressing.slots.filter(({ t }) => {
      if (this.busy.has(t.r * d.cols + t.c)) return false;
      let open = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dc || dr) && !this._solid(t.c + dc, t.r + dr)) open++;
      return open >= 5 && dressing.clear(t.x, t.z, 2 * TILE);
    });
    const groups = Math.min(22, Math.round(slots.length * 0.16));
    for (let g = 0; g < groups && slots.length; g++) {
      const { t, dx, dz } = slots.splice(Math.floor(r() * slots.length), 1)[0];
      const id = kinds[Math.floor(r() * kinds.length)];
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const along = (k - (n - 1) / 2) * 0.75 + (r() - 0.5) * 0.2;
        const x = t.x + dx * 0.55 + dz * along;
        const z = t.z + dz * 0.55 + dx * along;
        const rad = id === 'coffin' ? 0.44 : 0.36;
        if (!dressing.free(x, z, rad + 0.05)) continue;
        dressing.claim(x, z, rad);
        this._addBreakable(id, x, z, 0.85 + r() * 0.3);
      }
    }
  }

  _addBreakable(id, x, z, scale) {
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    root.rotation.y = this.r() * Math.PI * 2;
    const mesh = Assets.instanceProp(id);
    const material = this.level.dressing.mat(id);
    mesh.traverse((o) => {
      if (o.isMesh) o.material = material;
    });
    mesh.scale.multiplyScalar(scale);
    root.add(mesh);
    this.group.add(root);
    root.updateMatrixWorld(true);
    const h = Assets.props.get(id).entry.size * scale;
    const hw = id === 'coffin' ? 0.45 : 0.38;
    const hb = new Hurtbox(root, new THREE.Vector3(0, h / 2, 0), new THREE.Vector3(hw, h / 2, hw), { name: 'prop' });
    hb.update();
    const circle = { x, z, r: id === 'coffin' ? 0.42 : 0.34 };
    this.level.world.circles.push(circle);
    this.breakables.push({
      isProp: true,
      id,
      root,
      material,
      height: h,
      circle,
      alive: true,
      position: root.position,
      hitRadius: 0.6,
      hurtboxes: [hb],
      smash: (ctx, dir) => this._smash(this.breakables.find((b) => b.root === root), ctx, dir),
    });
  }

  // The dressing's breakable pieces: each stays in its batch until a blow
  // takes it out.
  _fragile() {
    const dressing = this.level.dressing;
    for (const f of dressing.fragile) {
      if (!f.mm.inst) continue;
      const root = new THREE.Object3D();
      root.position.set(f.x, 0, f.z);
      root.updateMatrixWorld(true);
      const w = Math.max(0.25, f.r);
      const hb = new Hurtbox(root, new THREE.Vector3(0, f.h / 2, 0), new THREE.Vector3(w, f.h / 2, w), { name: 'prop' });
      hb.update();
      const b = { isProp: true, id: f.id, root, material: dressing.mat(f.id), height: Math.min(f.h, 2.5), solid: f.solid, mm: f.mm, alive: true, position: root.position, hitRadius: w + 0.25, hurtboxes: [hb] };
      b.smash = (ctx, dir) => this._smash(b, ctx, dir);
      this.breakables.push(b);
    }
  }

  // Burst into pieces thrown away from the blow; sometimes a potion inside.
  _smash(b, ctx, dir) {
    if (!b || !b.alive) return;
    b.alive = false;
    if (b.mm) {
      // Out of its batch.
      b.mm.inst.setMatrixAt(b.mm.index, GONE);
      b.mm.inst.instanceMatrix.needsUpdate = true;
      this.level.world.removeStatic(b.solid);
    } else {
      b.root.removeFromParent();
      const w = this.level.world.circles;
      w.splice(w.indexOf(b.circle), 1);
    }
    const p = b.position;
    for (let i = 0; i < 12; i++) {
      const piece = new THREE.Mesh(PIECE, b.material);
      const s = 0.035 + Math.random() * 0.06;
      piece.scale.set(s * (1 + Math.random()), s, s * (0.6 + Math.random()));
      piece.position.set(p.x + (Math.random() - 0.5) * 0.4, 0.2 + Math.random() * b.height * 0.8, p.z + (Math.random() - 0.5) * 0.4);
      this.group.add(piece);
      const sp = 2 + Math.random() * 4;
      const a = Math.random() * Math.PI * 2;
      this.debris.push({
        mesh: piece,
        vx: Math.cos(a) * sp * 0.5 + dir.x * sp,
        vy: 2 + Math.random() * 3.5,
        vz: Math.sin(a) * sp * 0.5 + dir.z * sp,
        spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
        t: 0,
        life: 3.5 + Math.random(),
      });
    }
    burst(ctx.fx.alpha, new THREE.Vector3(p.x, 0.6, p.z), { count: 26, speed: 2.2, color: C.smoke, colorEnd: C.smoke, size: 0.35, life: 0.9, gravity: 1 });
    if (b.id !== 'urn') burst(ctx.fx.alpha, new THREE.Vector3(p.x, 0.7, p.z), { count: b.id === 'coffin' ? 18 : 10, speed: 3, color: C.bone ?? C.smoke, colorEnd: C.smoke, size: 0.12, life: 0.9 });
    const shards = SHARDS[b.id];
    if (shards) burst(ctx.fx.alpha, new THREE.Vector3(p.x, Math.min(1.2, b.height * 0.5), p.z), { count: 24, speed: 2.6, color: shards[0], colorEnd: shards[1], size: 0.14, life: 1, gravity: -7 });
    ctx.audio?.smash?.(b.id);
    ctx.shake?.(0.08);
    // An urn holds slime (and only slime): it splashes out and coats the
    // blade that broke it.
    if (b.id === 'urn') {
      burst(ctx.fx.alpha, new THREE.Vector3(p.x, 0.55, p.z), { count: 34, speed: 3, color: SLIME, colorEnd: SLIME_DARK, size: 0.16, life: 0.9, gravity: -9 });
      ctx.player?.coat?.(ctx);
      return;
    }
    // Now and then a potion; spells are only ever found in chests.
    if (Math.random() < (b.mm ? 0.02 : 0.07)) ctx.pickups?.addPotion(p.x, p.z);
  }

  // Open: the chest jolts, light bursts out of it, and what it held spills
  // onto the floor in front of it.
  _open(c, ctx) {
    c.opened = true;
    c.openT = 0;
    ctx.audio?.chest?.();
    ctx.shake?.(0.1);
    const fx = Math.sin(c.yaw);
    const fz = Math.cos(c.yaw);
    const at = (k, side) => [c.x + fx * (1.1 + k * 0.2) + fz * side, c.z + fz * (1.1 + k * 0.2) - fx * side];
    const floor = this.level.floor;
    const run = ctx.player.run;
    // One thing per chest. The first chest of a run always holds a relic.
    const table = [
      ['relic', 0.3],
      ['weapon', 0.25],
      ['potion', 0.25],
      ['spell', 0.12],
    ];
    let pick = 'relic';
    if (Object.keys(run.relics || {}).length) {
      let roll = Math.random() * table.reduce((a, [, w]) => a + w, 0);
      for (const [kind, w] of table) {
        roll -= w;
        if (roll <= 0) {
          pick = kind;
          break;
        }
      }
    }
    const loot = [[pick]];
    loot.forEach(([kind], i) => {
      const [x, z] = at(i, (i - (loot.length - 1) / 2) * 0.8);
      if (kind === 'potion') ctx.pickups?.addPotion(x, z);
      else if (kind === 'spell') ctx.pickups?.addSpell(x, z);
      else if (kind === 'relic') ctx.pickups?.addRelic(x, z, rollRelic(run));
      else ctx.pickups?.addWeapon(x, z, rollWeapon(floor, 0.5));
    });
    burst(ctx.fx.add, new THREE.Vector3(c.x, 0.8, c.z), { count: 50, speed: 3.5, color: C.spark, colorEnd: C.fireEdge, size: 0.1, life: 1.1, gravity: -2 });
    ctx.toast?.({ relic: 'The chest held a relic', weapon: 'The chest held a weapon', potion: 'The chest held a potion', spell: 'The chest held a spell' }[pick]);
  }

  // The prompt to show, if a closed chest is within reach.
  prompt() {
    return this.nearChest ? '<b>F</b> open the chest' : null;
  }

  update(dt, ctx) {
    this.time += dt;
    const p = ctx.player.position;
    this.nearChest = null;
    let best = CHEST_REACH;
    for (const c of this.chests) {
      if (c.opened) {
        // A short jolt and flare, then the chest goes dark.
        if (c.openT >= 0 && c.openT < 1.2) {
          c.openT += dt;
          const k = c.openT;
          c.root.position.y = Math.max(0, Math.sin(k * 30) * 0.05 * (1 - k / 0.4));
          c.glow.material.opacity = 0.45 + Math.max(0, 1 - k) * 1.2;
          c.glow.scale.setScalar(1.6 + k * 2);
          if (k >= 1.2) c.glow.visible = false;
        }
        continue;
      }
      c.glow.material.opacity = 0.35 + Math.sin(this.time * 2.4 + c.x) * 0.12;
      if (Math.random() < dt * 3) ctx.fx.add.emit({ x: c.x + (Math.random() - 0.5) * 0.6, y: 0.5 + Math.random() * 0.4, z: c.z + (Math.random() - 0.5) * 0.6, vy: 0.5, life: 1.2, size: 0.05, color: C.spark, colorEnd: C.fireEdge, turbulence: 1 });
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < best) {
        best = d;
        this.nearChest = c;
      }
    }
    if (this.nearChest && !ctx.player.dead && ctx.input.wasPressed('KeyF') && !ctx.pickups?.nearWeapon) {
      this._open(this.nearChest, ctx);
      // The same press must not also take what just fell out.
      ctx.input.pressed.delete('KeyF');
    }

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.t += dt;
      const m = d.mesh;
      if (m.position.y > 0.05 || d.vy > 0) {
        d.vy -= 18 * dt;
        m.position.x += d.vx * dt;
        m.position.y += d.vy * dt;
        m.position.z += d.vz * dt;
        m.rotation.x += d.spin.x * dt;
        m.rotation.y += d.spin.y * dt;
        m.rotation.z += d.spin.z * dt;
        if (m.position.y < 0.05) {
          m.position.y = 0.05;
          d.vy = d.vy < -3 ? -d.vy * 0.3 : 0;
          d.vx *= 0.4;
          d.vz *= 0.4;
          d.spin.multiplyScalar(0.4);
        }
      }
      if (d.t > d.life) m.position.y -= dt * 0.3;
      if (d.t > d.life + 1) {
        m.removeFromParent();
        this.debris.splice(i, 1);
      }
    }
  }

  // Breakables still standing, for the blade to test against.
  get targets() {
    return this.breakables.filter((b) => b.alive);
  }
}
