import * as THREE from 'three';
import { C, burst, ring, spawnFlame } from './Particles.js';
import { Quakes } from './Quake.js';

// Ground telegraphs, delayed fire strikes, and projectiles. Everything that
// can hurt the player here is announced first: a ring that fills up before
// the blow lands. Also the travelling and timed parts of procs: streams of
// stolen blood, lightning bolts, and blows that land a moment later.

const ringGeo = new THREE.RingGeometry(0.9, 1, 72);
const discGeo = new THREE.CircleGeometry(1, 72);
const orbGeo = new THREE.SphereGeometry(1, 24, 16);
const _t = new THREE.Vector3();
const _target = new THREE.Vector3();

export class Effects {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;
    this.items = [];
    this.projectiles = [];
    this.tasks = [];
    this.quakes = new Quakes(scene, fx);
  }

  // A heavy blow on the floor (world/Quake.js).
  quake(x, z, radius, power = 1, opts) {
    this.quakes.hit(x, z, radius, power, opts);
  }

  clear() {
    this.quakes.clear();
    for (const t of this.items) this.scene.remove(t.group);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.items.length = 0;
    this.projectiles.length = 0;
    this.tasks.length = 0;
  }

  // Run `fn` after `delay` seconds of game time (hit-stop slows it too).
  later(delay, fn) {
    this.tasks.push({ t: 0, dur: delay, done: fn });
  }

  // A stream flowing from `from` to `to()` (a moving target) along a rising
  // arc, a burst of particles at its head; `onArrive` fires when it lands.
  stream(from, to, { color = C.blood, bright = C.emberRed, dur = 0.5, onArrive } = {}) {
    const a = from.clone();
    this.tasks.push({
      t: 0,
      dur,
      done: onArrive,
      tick: (k) => {
        const b = to();
        const e = k * k * (3 - 2 * k);
        // Quadratic arc, lifted in the middle.
        const mx = (a.x + b.x) / 2;
        const my = Math.max(a.y, b.y) + 1.4;
        const mz = (a.z + b.z) / 2;
        const u = 1 - e;
        const x = u * u * a.x + 2 * u * e * mx + e * e * b.x;
        const y = u * u * a.y + 2 * u * e * my + e * e * b.y;
        const z = u * u * a.z + 2 * u * e * mz + e * e * b.z;
        for (let i = 0; i < 6; i++) {
          this.fx.add.emit({ x: x + (Math.random() - 0.5) * 0.2, y: y + (Math.random() - 0.5) * 0.2, z: z + (Math.random() - 0.5) * 0.2, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6, vz: (Math.random() - 0.5) * 0.6, life: 0.35, size: 0.22, sizeEnd: 0.04, color: bright, colorEnd: color, drag: 2 });
        }
      },
    });
  }

  // A jagged bolt of lightning from a to b that crackles twice.
  bolt(a, b, { color = C.white, edge = C.violet } = {}) {
    const from = a.clone();
    const to = b.clone();
    const draw = () => {
      const d = from.distanceTo(to);
      const kinks = 7;
      let px = from.x;
      let py = from.y;
      let pz = from.z;
      for (let i = 1; i <= kinks; i++) {
        const k = i / kinks;
        const j = i === kinks ? 0 : d * 0.08;
        const nx = from.x + (to.x - from.x) * k + (Math.random() - 0.5) * j;
        const ny = from.y + (to.y - from.y) * k + (Math.random() - 0.5) * j;
        const nz = from.z + (to.z - from.z) * k + (Math.random() - 0.5) * j;
        const n = Math.max(2, Math.ceil(Math.hypot(nx - px, ny - py, nz - pz) / 0.12));
        for (let q = 0; q < n; q++) {
          const f = q / n;
          this.fx.add.emit({ x: px + (nx - px) * f, y: py + (ny - py) * f, z: pz + (nz - pz) * f, life: 0.16, size: 0.16, sizeEnd: 0.05, color, colorEnd: edge, drag: 0 });
        }
        px = nx;
        py = ny;
        pz = nz;
      }
      burst(this.fx.add, to, { count: 10, speed: 4, color, colorEnd: edge, size: 0.08, life: 0.25 });
    };
    draw();
    this.later(0.06, draw);
  }

  // A ring + filling disc on the ground. `onDone` fires when it completes.
  telegraph(x, z, radius, duration, onDone, color = 0xff3a10) {
    const group = new THREE.Group();
    group.position.set(x, 0.06, z);
    group.rotation.x = -Math.PI / 2;
    const ringM = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const discM = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false });
    const r = new THREE.Mesh(ringGeo, ringM);
    r.scale.setScalar(radius);
    const d = new THREE.Mesh(discGeo, discM);
    d.scale.setScalar(0.01);
    group.add(r, d);
    this.scene.add(group);
    const item = { group, ring: r, disc: d, radius, t: 0, duration, onDone, mats: [ringM, discM] };
    this.items.push(item);
    return item;
  }

  // Fire falls on a spot after a warning; damages the player if inside.
  fireStrike(x, z, radius, delay, damage, ctx) {
    this.telegraph(x, z, radius, delay, () => {
      const p = new THREE.Vector3(x, 0.2, z);
      ring(this.fx.add, p, radius, { count: 30, speed: radius * 3, size: 0.5 });
      for (let i = 0; i < 26; i++) {
        spawnFlame(this.fx.add, { x: x + (Math.random() - 0.5) * radius, y: Math.random() * 2.5, z: z + (Math.random() - 0.5) * radius }, { size: 0.7, rise: 3, life: 0.6 });
      }
      ctx.audio?.burst(p);
      const pl = ctx.player;
      if (Math.hypot(pl.position.x - x, pl.position.z - z) < radius + pl.radius) pl.takeDamage(damage, p, 3, ctx);
    });
  }

  // `owner`: the caster, for a parried fireball to fly back at.
  fireball(origin, dir, speed, damage, { radius = 0.32, homing = 0.6, life = 4, owner = null } = {}) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
    const mesh = new THREE.Mesh(orbGeo, mat);
    mesh.scale.setScalar(radius);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    this.projectiles.push({ mesh, vel: dir.clone().normalize().multiplyScalar(speed), speed, damage, radius, homing, life, owner, reflected: false });
  }

  // A fireball parried: it flies back at whoever threw it, hotter.
  _reflect(p, ctx) {
    const o = p.owner;
    const to = o?.alive ? _t.set(o.position.x, (o.model?.height || 1.6) * 0.6 * (o.type?.scale || 1), o.position.z) : _t.copy(p.mesh.position).addScaledVector(p.vel, -1);
    p.vel.copy(to).sub(p.mesh.position).normalize().multiplyScalar(p.speed * 1.6);
    p.homing = 0;
    p.reflected = true;
    p.life = 3;
    p.mesh.material.color.setHex(0xfff0c0);
    ctx.player._parry(ctx, p.mesh.position, null);
  }

  update(dt, ctx) {
    this.quakes.update(dt);
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const t = this.tasks[i];
      t.t += dt;
      const k = Math.min(1, t.t / Math.max(1e-3, t.dur));
      t.tick?.(k);
      if (k >= 1) {
        this.tasks.splice(i, 1);
        t.done?.();
      }
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      const t = this.items[i];
      t.t += dt;
      const k = Math.min(1, t.t / t.duration);
      t.disc.scale.setScalar(Math.max(0.01, t.radius * k));
      t.mats[0].opacity = 0.5 + Math.sin(t.t * 20) * 0.3;
      if (k >= 1) {
        this.scene.remove(t.group);
        t.mats.forEach((m) => m.dispose());
        this.items.splice(i, 1);
        t.onDone?.();
      }
    }

    const pl = ctx.player;
    const target = _target.set(pl.position.x, 1.2, pl.position.z);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const pos = p.mesh.position;
      if (p.homing > 0) {
        const desired = _t.copy(target).sub(pos).normalize().multiplyScalar(p.speed);
        p.vel.lerp(desired, Math.min(1, p.homing * dt));
      }
      pos.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(p.radius * (0.9 + Math.sin(p.life * 30) * 0.15));
      spawnFlame(this.fx.add, pos, { size: 0.45, rise: 0.3, life: 0.35, spread: 0.15 });

      let explode = p.life <= 0 || pos.y < 0.1 || ctx.world.isSolidAt(pos.x, pos.z);
      if (!explode && !p.reflected && pl.overlapsSphere(pos, p.radius)) {
        if (pl.canParry(pos)) this._reflect(p, ctx);
        else {
          pl.takeDamage(p.damage, pos, 4, ctx);
          explode = true;
        }
      }
      if (!explode && p.reflected) {
        // Thrown back: it burns whatever demon it meets, twice over.
        for (const e of ctx.enemies) {
          if (!e.alive || e.hidden || e.state === 'burrowed') continue;
          const h = (e.model?.height || 1.6) * (e.type?.scale || 1);
          if (Math.hypot(e.position.x - pos.x, e.position.z - pos.z) > e.radius + p.radius + 0.2 || pos.y > h + 0.3) continue;
          const dir = _t.copy(p.vel).setY(0).normalize();
          const dealt = e.takeHit(p.damage * 2.5, dir, 4, 80, ctx, { contact: pos.clone(), force: 0.9 });
          ctx.onDamage?.(e, dealt, true, pos.clone(), 'counter');
          e.addStatus?.('burn', { dps: p.damage * 0.3, dur: 3 });
          explode = true;
          break;
        }
      }
      if (explode) {
        burst(this.fx.add, pos, { count: 22, speed: 5, color: C.fireCore, colorEnd: C.fireEdge, size: 0.2, life: 0.5 });
        ctx.audio?.burst(pos);
        this.scene.remove(p.mesh);
        p.mesh.material.dispose();
        this.projectiles.splice(i, 1);
      }
    }
  }
}
