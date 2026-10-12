import * as THREE from 'three';
import { C, burst, ring, spawnFlame } from './Particles.js';

// Ground telegraphs, delayed fire strikes, and projectiles. Everything that
// can hurt the player here is announced first: a ring that fills up before
// the blow lands.

const ringGeo = new THREE.RingGeometry(0.9, 1, 48);
const discGeo = new THREE.CircleGeometry(1, 48);
const orbGeo = new THREE.SphereGeometry(1, 12, 8);

export class Effects {
  constructor(scene, fx) {
    this.scene = scene;
    this.fx = fx;
    this.items = [];
    this.projectiles = [];
  }

  clear() {
    for (const t of this.items) this.scene.remove(t.group);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.items.length = 0;
    this.projectiles.length = 0;
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

  fireball(origin, dir, speed, damage, { radius = 0.32, homing = 0.6, life = 4 } = {}) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
    const mesh = new THREE.Mesh(orbGeo, mat);
    mesh.scale.setScalar(radius);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    this.projectiles.push({ mesh, vel: dir.clone().normalize().multiplyScalar(speed), speed, damage, radius, homing, life });
  }

  update(dt, ctx) {
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
    const target = new THREE.Vector3(pl.position.x, 1.2, pl.position.z);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const pos = p.mesh.position;
      if (p.homing > 0) {
        const desired = target.clone().sub(pos).normalize().multiplyScalar(p.speed);
        p.vel.lerp(desired, Math.min(1, p.homing * dt));
      }
      pos.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(p.radius * (0.9 + Math.sin(p.life * 30) * 0.15));
      spawnFlame(this.fx.add, pos, { size: 0.45, rise: 0.3, life: 0.35, spread: 0.15 });

      let explode = p.life <= 0 || pos.y < 0.1 || ctx.world.isSolidAt(pos.x, pos.z);
      if (!explode && pl.overlapsSphere(pos, p.radius)) {
        pl.takeDamage(p.damage, pos, 4, ctx);
        explode = true;
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
