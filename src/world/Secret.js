import * as THREE from 'three';
import { Assets } from '../assets/AssetLibrary.js';
import { softDotTexture, makeCanvas } from './Textures.js';
import { burst } from './Particles.js';
import { rollRelic } from '../combat/Relics.js';

// A floor's secret: the Whispering Shrine. Halfway down the second passage
// (the other way round the floor's loop: levelParser.carveSecret) a niche is
// cut into the rock, and in it an old altar stands dark. Come within a few
// steps and it knows you: violet fire wakes over it, a circle of runes lights
// on the floor and something whispers. Touch it (F) and it gives: a relic
// spills out at your feet and every flask fills. Then the fire goes out.

const REVEAL = 7.5;
const REACH = 2.1;
const VIOLET = new THREE.Color(0.62, 0.3, 1.0);
const VIOLET_DEEP = new THREE.Color(0.18, 0.02, 0.35);
const PALE = new THREE.Color(0.92, 0.82, 1.0);

// A circle of runes, white on black (tinted and added when drawn).
let runeTex = null;
function runes() {
  if (runeTex) return runeTex;
  const S = 256;
  const cv = makeCanvas(S, S);
  const g = cv.getContext('2d');
  g.translate(S / 2, S / 2);
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineWidth = 3;
  for (const r of [118, 100, 46]) {
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  }
  // A seven-pointed star between the rings.
  g.lineWidth = 2.5;
  g.beginPath();
  for (let k = 0; k <= 7; k++) {
    const a = (k * 3 * Math.PI * 2) / 7 - Math.PI / 2;
    const p = [Math.cos(a) * 100, Math.sin(a) * 100];
    if (k) g.lineTo(...p);
    else g.moveTo(...p);
  }
  g.stroke();
  // Glyphs round the band: a few strokes each.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.lineWidth = 2.2;
  for (let k = 0; k < 21; k++) {
    g.save();
    g.rotate((k / 21) * Math.PI * 2);
    g.translate(0, -109);
    g.beginPath();
    for (let s = 0; s < 3; s++) {
      g.moveTo((rnd() - 0.5) * 9, (rnd() - 0.5) * 9);
      g.lineTo((rnd() - 0.5) * 9, (rnd() - 0.5) * 9);
    }
    g.stroke();
    g.restore();
  }
  runeTex = new THREE.CanvasTexture(cv);
  runeTex.colorSpace = THREE.SRGBColorSpace;
  return runeTex;
}

export class Shrine {
  // `s`: level.data.secret { x, z, dir } (dir: from the niche out).
  constructor(level, s) {
    this.level = level;
    const [dx, dz] = s.dir;
    this.dir = new THREE.Vector2(dx, dz);
    // The altar at the back of the niche; you stand at its mouth.
    this.x = s.x - dx * 0.35;
    this.z = s.z - dz * 0.35;
    this.k = 0; // how awake it is (0..1)
    this.spent = false;
    this.used = 0;
    this.t = 0;
    this.near = false;
    this.group = new THREE.Group();
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = Math.atan2(dx, dz);
    level.group.add(this.group);
    const altar = Assets.instanceProp('altar');
    let top = 1.1;
    if (altar) {
      const mat = level.dressing?.mat('altar');
      if (mat)
        altar.traverse((o) => {
          if (o.isMesh) o.material = mat;
        });
      altar.scale.multiplyScalar(0.85);
      this.group.add(altar);
      top = new THREE.Box3().setFromObject(altar).max.y;
    }
    level.world.circles.push({ x: this.x, z: this.z, r: 0.55 });
    // The fire over it: a soft violet glow round a pale core.
    const dot = softDotTexture();
    const sprite = (color, size, opacity) => {
      const m = new THREE.SpriteMaterial({ map: dot, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const sp = new THREE.Sprite(m);
      sp.scale.setScalar(size);
      sp.userData.peak = opacity;
      this.group.add(sp);
      return sp;
    };
    this.top = top;
    this.glow = sprite(VIOLET, 2.1, 0.5);
    this.core = sprite(PALE, 0.55, 0.95);
    this.glow.position.y = this.core.position.y = top + 0.45;
    // The circle of runes on the floor before it.
    this.sigil = new THREE.Mesh(
      new THREE.PlaneGeometry(2.1, 2.1),
      new THREE.MeshBasicMaterial({ map: runes(), color: VIOLET, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.sigil.rotation.x = -Math.PI / 2;
    this.sigil.position.set(0, 0.03, 0.75);
    this.group.add(this.sigil);
    this.light = null;
  }

  update(dt, ctx) {
    this.t += dt;
    const p = ctx.player.position;
    const d = Math.hypot(p.x - this.x, p.z - this.z);
    // It wakes as you come near (and stays awake once it has seen you).
    if (!this.spent && d < REVEAL && this.k === 0) {
      ctx.audio?.play?.('echo', { pos: new THREE.Vector3(this.x, 1.2, this.z), volume: 0.7, rate: 0.6, gap: 1 });
      ctx.toast?.('Something whispers from the rock…');
      this.level._spot({ color: 0x9a5cff, base: 0, distance: 9, decay: 1.4, x: this.x, y: this.top + 0.6, z: this.z, seed: 3.3 });
      this.light = this.level.spots[this.level.spots.length - 1];
    }
    const want = this.spent ? 0 : d < REVEAL || this.k > 0 ? 1 : 0;
    this.k = Math.max(0, Math.min(1, this.k + (want > this.k ? dt / 1.2 : -dt / 2.5)));
    if (this.spent && this.k === 0) this.k = -1; // out for good
    const k = Math.max(0, this.k);
    const flick = 0.85 + 0.15 * Math.sin(this.t * 7.3) * Math.sin(this.t * 4.1 + 1);
    const bob = Math.sin(this.t * 1.6) * 0.06;
    for (const s of [this.glow, this.core]) {
      s.material.opacity = s.userData.peak * k * flick;
      s.position.y = this.top + 0.45 + bob;
    }
    this.glow.scale.setScalar(2.1 * (0.9 + 0.1 * flick));
    this.sigil.material.opacity = (this.spent ? 0.12 * Math.min(1, this.used) : 0.75 * k) * (0.8 + 0.2 * Math.sin(this.t * 2.2));
    this.sigil.rotation.z = this.t * 0.15;
    if (this.light) this.light.base = 6 * k * flick;
    // Motes drifting up out of the fire, now and then a whisper.
    if (k > 0.3 && Math.random() < dt * 9 * k) {
      const a = Math.random() * Math.PI * 2;
      ctx.fx.add.emit({ x: this.x + Math.cos(a) * 0.5, y: this.top + 0.2, z: this.z + Math.sin(a) * 0.5, vy: 0.6 + Math.random() * 0.5, life: 1.6, size: 0.06, color: PALE, colorEnd: VIOLET, turbulence: 1.2 });
    }
    if (!this.spent && k > 0.9 && Math.random() < dt * 0.12) ctx.audio?.play?.('echo', { pos: new THREE.Vector3(this.x, 1.2, this.z), volume: 0.35, rate: 0.5 + Math.random() * 0.2, gap: 4 });
    if (this.spent) this.used = Math.min(1, this.used + dt);
    this.near = !this.spent && k > 0.5 && d < REACH && !ctx.player.dead;
  }

  // Touched: its gift, and the fire goes out.
  use(ctx) {
    this.spent = true;
    this.near = false;
    const run = ctx.player.run;
    const fx = this.x + this.dir.x * 1.25;
    const fz = this.z + this.dir.y * 1.25;
    ctx.pickups?.addRelic(fx, fz, rollRelic(run));
    run.potions = run.potionCap;
    if (run.best) run.best.secrets = (run.best.secrets || 0) + 1;
    ctx.audio?.play?.('soulrend', { pos: new THREE.Vector3(this.x, 1.2, this.z), volume: 0.9, gap: 0.5 });
    ctx.audio?.relic?.();
    ctx.shake?.(0.18);
    const at = new THREE.Vector3(this.x, this.top + 0.45, this.z);
    burst(ctx.fx.add, at, { count: 70, speed: 4, color: PALE, colorEnd: VIOLET, size: 0.12, life: 1.3, gravity: -1.5 });
    burst(ctx.fx.alpha, at.setY(0.4), { count: 30, speed: 2, color: VIOLET_DEEP, colorEnd: VIOLET_DEEP, size: 0.8, life: 1.6, gravity: -0.6 });
    ctx.announce?.('A secret: the Whispering Shrine');
    ctx.toast?.('It gives a relic, and fills every flask');
  }
}
