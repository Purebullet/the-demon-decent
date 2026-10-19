import * as THREE from 'three';
import { C, burst, ring, spawnFlame } from './Particles.js';
import { Quakes } from './Quake.js';
import { makeFlame } from './Shaders.js';

// Ground telegraphs, delayed fire strikes, and projectiles. Everything that
// can hurt the player here is announced first: a ring that fills up before
// the blow lands. Also the travelling and timed parts of procs: streams of
// stolen blood, lightning bolts, and blows that land a moment later.

const ringGeo = new THREE.RingGeometry(0.9, 1, 72);

// A wedge on the ground for a blow that carries forward (a pounce, a lash):
// apex at the attacker, opening along +Z, `range` long and `half` radians
// either side. Drawn by CONE_FRAG: a bright rim, a fill sweeping out from
// the apex as the wind-up runs, and bands running outward.
const coneGeos = new Map();
function coneGeometry(range, half) {
  const key = `${range}|${half}`;
  let g = coneGeos.get(key);
  if (g) return g;
  const segs = 28;
  const pos = [0, 0, 0];
  for (let i = 0; i <= segs; i++) {
    const a = -half + (2 * half * i) / segs;
    pos.push(Math.sin(a) * range, 0, Math.cos(a) * range);
  }
  const idx = [];
  // Wound to face up (seen from above, as it lies on the floor).
  for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  coneGeos.set(key, g);
  return g;
}
const CONE_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const CONE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uFill;
uniform float uTime;
uniform float uRange;
uniform float uHalf;
uniform float uFade;
varying vec2 vP;
void main() {
  float r = length(vP) / uRange;
  float a = abs(atan(vP.x, vP.y)) / uHalf;
  float rim = max(smoothstep(0.92, 1.0, r), smoothstep(0.88, 1.0, a));
  float filled = step(r, uFill);
  float front = smoothstep(0.07, 0.0, abs(r - uFill)) * step(0.02, uFill);
  float bands = 0.5 + 0.5 * sin((r * 7.0 - uTime * 3.5) * 6.2831853);
  float k = 0.1 + filled * (0.22 + 0.1 * bands) + rim * 0.85 + front * 0.7;
  k *= smoothstep(0.0, 0.06, r) * uFade;
  gl_FragColor = vec4(uColor * k, k);
}`;
// Living shadow (the Shadow Fiend's lash and the orb it gathers into): smoke
// that boils (noise scrolled along it), torn edges, a violet rim and
// filaments of light crawling through it.
const SHADOW_NOISE = /* glsl */ `
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) { return sNoise(p) * 0.55 + sNoise(p * 2.1 + 3.7) * 0.3 + sNoise(p * 4.3 + 9.1) * 0.15; }
`;
const SHADOW_CORE = 'vec3(0.03, 0.0, 0.05)';
const SHADOW_GLOW = 'vec3(0.78, 0.32, 1.0)';
const WHIP_VERT = /* glsl */ `
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const WHIP_FRAG = /* glsl */ `
uniform float uTime;
uniform float uReveal;
uniform float uFade;
uniform float uSeed;
varying vec2 vUv;
${SHADOW_NOISE}
void main() {
  float along = vUv.x;
  float across = abs(vUv.y);
  float n = sFbm(vec2(along * 7.0 - uTime * 5.0 + uSeed, vUv.y * 1.8 + uTime * 1.7));
  float n2 = sFbm(vec2(along * 15.0 - uTime * 9.0, vUv.y * 3.0 - uTime * 2.0 + uSeed));
  // Torn, boiling edges.
  float edge = 0.6 + 0.4 * n;
  float body = smoothstep(edge, edge - 0.3, across);
  // Laid out from the hand as it flies.
  float shown = smoothstep(uReveal, uReveal - 0.08, along);
  // Eaten into tatters as it fades.
  float holes = smoothstep(uFade - 0.18, uFade + 0.05, n2 * 0.85 + 0.15 * (1.0 - along));
  float a = body * shown * holes;
  if (a < 0.02) discard;
  float rim = smoothstep(edge - 0.34, edge - 0.02, across);
  float fil = pow(1.0 - abs(sin((n * 3.0 + along * 4.0 - uTime * 7.0) * 3.14159)), 18.0);
  vec3 glow = ${SHADOW_GLOW};
  vec3 col = mix(${SHADOW_CORE}, glow * 1.35, rim * 0.9) + glow * fil * (1.0 - across) * 1.5 + vec3(1.0, 0.85, 1.0) * pow(fil, 4.0) * 0.6;
  gl_FragColor = vec4(col, min(1.0, a * 1.15));
}`;
const ORB_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vP = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const ORB_FRAG = /* glsl */ `
uniform float uTime;
uniform float uK;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
${SHADOW_NOISE}
void main() {
  float fr = pow(1.0 - abs(dot(vN, vV)), 2.6);
  float n = sFbm(vP.xy * 2.6 + vec2(uTime * 1.6, -uTime * 2.3) + vP.z * 1.7);
  // A ragged, writhing skin: the rim breaks up where the smoke thins.
  if (fr > 0.55 && n < 0.25 + 0.35 * fr) discard;
  vec3 glow = ${SHADOW_GLOW};
  float swirl = pow(n, 3.0);
  vec3 col = mix(${SHADOW_CORE} * 0.4, glow * 1.6, fr) + glow * swirl * 0.3 * (0.3 + fr);
  gl_FragColor = vec4(col, (0.9 + 0.1 * fr) * uK);
}`;
const WHIP_SEGS = 40;
const _wa = new THREE.Vector3();
const _wb = new THREE.Vector3();
const _wt = new THREE.Vector3();
const _wv = new THREE.Vector3();

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
    this.cones = [];
    this.whips = [];
    this.orbs = [];
    this.fires = [];
    this.quakes = new Quakes(scene, fx);
  }

  // A cone on the ground ahead of `owner` for as long as it winds up the
  // blow it is winding up now: it follows where the owner faces, fills
  // from the apex as the wind-up runs, and fades as the blow comes.
  cone(owner, { range, half, color = 0xff2a10 }) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uFill: { value: 0 }, uTime: { value: 0 }, uRange: { value: range }, uHalf: { value: half }, uFade: { value: 1 } },
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(coneGeometry(range, half), mat);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.position.set(owner.position.x, 0.05, owner.position.z);
    mesh.rotation.y = owner.yaw;
    this.scene.add(mesh);
    this.cones.push({ mesh, mat, owner, attack: owner.attack, out: -1 });
  }

  // A ball of shadow swelling in `bone` (a hand) while `owner` winds up the
  // blow it is winding up now; it shrinks away into the blow.
  shadowOrb(owner, bone, { size = 0.42 } = {}) {
    if (!bone) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: Math.random() * 10 }, uK: { value: 0 } },
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(orbGeo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.scale.setScalar(0.01);
    this.scene.add(mesh);
    this.orbs.push({ mesh, mat, owner, bone, attack: owner.attack, size, out: -1, s: 0.01 });
  }

  // A lash of living shadow thrown from `bone` (or `from`) along `dir`
  // (x, z) for `len` metres, falling to `endY`: it cracks out over a moment,
  // writhing, then tears apart. Drawn as a ribbon turned to the eye.
  shadowWhip(from, dir, len, { bone = null, endY = 0.9, dur = 0.7, wave = 0.42, width = 0.5 } = {}) {
    const n = WHIP_SEGS + 1;
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = [];
    for (let i = 0; i < n; i++) {
      uv[i * 4] = i / WHIP_SEGS;
      uv[i * 4 + 1] = -1;
      uv[i * 4 + 2] = i / WHIP_SEGS;
      uv[i * 4 + 3] = 1;
      if (i < WHIP_SEGS) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uReveal: { value: 0 }, uFade: { value: 0 }, uSeed: { value: Math.random() * 20 } },
      vertexShader: WHIP_VERT,
      fragmentShader: WHIP_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const l = Math.hypot(dir.x, dir.z) || 1;
    this.whips.push({ mesh, geo, mat, pos, bone, from: from.clone(), dx: dir.x / l, dz: dir.z / l, len, endY, dur, wave, width, t: 0, side: Math.random() < 0.5 ? -1 : 1 });
  }

  // Where the whip runs at time t: its centre line at k (0 hand .. 1 tip).
  _whipPoint(w, k, t, out) {
    const live = Math.min(1, t / w.dur);
    // A wave thrown down it from the hand, dying as it goes.
    const amp = w.wave * Math.sin(Math.PI * k) * (1 - 0.6 * live);
    const lat = w.side * amp * Math.sin(k * Math.PI * 2.4 - t * 24);
    const up = amp * 0.45 * Math.cos(k * Math.PI * 1.7 - t * 19);
    const y = w.from.y + (w.endY - w.from.y) * k * k;
    return out.set(w.from.x + w.dx * w.len * k - w.dz * lat, y + up, w.from.z + w.dz * w.len * k + w.dx * lat);
  }

  _updateShadow(dt, ctx) {
    const eye = ctx?.player ? _wv.set(ctx.player.position.x, ctx.player.position.y + 1.6, ctx.player.position.z) : null;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      const w = o.owner;
      o.mat.uniforms.uTime.value += dt;
      const winding = o.out < 0 && w.alive && w.state === 'windup' && w.attack === o.attack;
      let target = 0;
      if (winding) {
        const k = Math.min(1, w.stateT / Math.max(0.01, w.stateDur));
        target = o.size * (0.3 + 0.7 * k) * (1 + 0.1 * Math.sin(o.mat.uniforms.uTime.value * 23));
        o.mat.uniforms.uK.value = Math.min(1, 0.4 + k);
      } else {
        if (o.out < 0) o.out = 0;
        o.out += dt;
        o.mat.uniforms.uK.value = Math.max(0, 1 - o.out / 0.12);
      }
      o.s += (target - o.s) * Math.min(1, dt * (winding ? 10 : 30));
      o.bone.getWorldPosition(o.mesh.position);
      o.mesh.scale.setScalar(Math.max(0.001, o.s));
      if (o.out >= 0.12) {
        this.scene.remove(o.mesh);
        o.mat.dispose();
        this.orbs.splice(i, 1);
      }
    }
    for (let i = this.whips.length - 1; i >= 0; i--) {
      const w = this.whips[i];
      w.t += dt;
      const u = w.mat.uniforms;
      u.uTime.value = w.t;
      u.uReveal.value = Math.min(1.08, 1.08 * (1 - Math.pow(1 - Math.min(1, w.t / 0.16), 2)));
      u.uFade.value = Math.max(0, (w.t - 0.2) / (w.dur - 0.2)) * 1.15;
      if (w.bone) w.bone.getWorldPosition(w.from);
      const live = Math.min(1, w.t / w.dur);
      for (let s = 0; s <= WHIP_SEGS; s++) {
        const k = s / WHIP_SEGS;
        this._whipPoint(w, k, w.t, _wa);
        this._whipPoint(w, Math.min(1, k + 0.02), w.t, _wb);
        if (k >= 1) _wb.copy(_wa).add(_wt);
        _wt.subVectors(_wb, _wa);
        // Across the ribbon: square to its run and to the eye.
        if (eye) _wb.subVectors(eye, _wa);
        else _wb.set(0, 1, 0);
        _wb.crossVectors(_wt, _wb).normalize();
        const half = w.width * (1 - 0.72 * k + 0.12) * (1 + 0.5 * live) * 0.5;
        const o = s * 6;
        w.pos[o] = _wa.x - _wb.x * half;
        w.pos[o + 1] = _wa.y - _wb.y * half;
        w.pos[o + 2] = _wa.z - _wb.z * half;
        w.pos[o + 3] = _wa.x + _wb.x * half;
        w.pos[o + 4] = _wa.y + _wb.y * half;
        w.pos[o + 5] = _wa.z + _wb.z * half;
      }
      w.geo.attributes.position.needsUpdate = true;
      if (w.t >= w.dur) {
        this.scene.remove(w.mesh);
        w.geo.dispose();
        w.mat.dispose();
        this.whips.splice(i, 1);
      }
    }
  }

  // A demon on fire: real flames (world/Shaders.js makeFlame) riding
  // `bones` for as long as `owner.status.burn` lasts, dying down after
  // (also once it falls, so a corpse smoulders out instead of snapping
  // dark).
  bodyFire(owner, bones, size) {
    if (!bones.length || this.fires.some((f) => f.owner === owner)) return;
    const flames = [];
    const add = (b, h, lat, push) => {
      const f = makeFlame({ height: h, seed: Math.random() * 20, intensity: 1.35 });
      this.scene.add(f);
      flames.push({ f, b, h, lat, push, ph: Math.random() * 6.3 });
    };
    bones.forEach((b, i) => {
      // Licking up the near side of it, spread across its width...
      add(b, size * (0.6 + Math.random() * 0.35), (i % 2 ? 1 : -1) * (0.15 + Math.random() * 0.5), 0.8);
      // ...and a crown of taller ones off its back and head.
      add(b, size * (0.95 + Math.random() * 0.45), (Math.random() - 0.5) * 0.8, 0.35);
    });
    this.fires.push({ owner, flames, k: 0, t: 0 });
  }

  _updateFires(dt, ctx) {
    const eye = ctx?.player?.position;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const fire = this.fires[i];
      const on = fire.owner.alive && !!fire.owner.status?.burn;
      fire.t += dt;
      fire.k = Math.max(0, Math.min(1, fire.k + (on ? dt * 5 : -dt * 1.6)));
      // Out on the near side of the body, toward the eye: a flame stood at
      // a bone is inside the body, which hides all but its tip.
      const r = fire.owner.radius || 0.4;
      for (const fl of fire.flames) {
        const p = fl.f.position;
        fl.b.getWorldPosition(p);
        if (eye) {
          const dx = eye.x - p.x;
          const dz = eye.z - p.z;
          const l = Math.hypot(dx, dz) || 1;
          // Toward the eye by `push`, across the view by `lat` (of its radius).
          p.x += ((dx * fl.push + dz * fl.lat) / l) * r;
          p.z += ((dz * fl.push - dx * fl.lat) / l) * r;
        }
        p.y -= fl.h * (fl.push > 0.5 ? 0.25 : 0.05);
        const flick = 0.82 + 0.18 * Math.sin(fire.t * 11 + fl.ph) + 0.08 * Math.sin(fire.t * 23 + fl.ph * 2);
        fl.f.scale.set(fire.k * (0.9 + 0.1 * Math.sin(fire.t * 7 + fl.ph)), fire.k * flick, fire.k);
        fl.f.userData.tick(fire.t);
      }
      if (!on && fire.k <= 0) {
        for (const fl of fire.flames) {
          this.scene.remove(fl.f);
          fl.f.traverse((o) => {
            if (o.isMesh) {
              o.geometry.dispose();
              o.material.dispose();
            }
          });
        }
        this.fires.splice(i, 1);
      }
    }
  }

  // A heavy blow on the floor (world/Quake.js).
  quake(x, z, radius, power = 1, opts) {
    this.quakes.hit(x, z, radius, power, opts);
  }

  clear() {
    this.quakes.clear();
    for (const c of this.cones) {
      this.scene.remove(c.mesh);
      c.mat.dispose();
    }
    this.cones.length = 0;
    for (const o of this.orbs) {
      this.scene.remove(o.mesh);
      o.mat.dispose();
    }
    this.orbs.length = 0;
    for (const w of this.whips) {
      this.scene.remove(w.mesh);
      w.geo.dispose();
      w.mat.dispose();
    }
    this.whips.length = 0;
    for (const fire of this.fires) for (const fl of fire.flames) this.scene.remove(fl.f);
    this.fires.length = 0;
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
    this._updateShadow(dt, ctx);
    this._updateFires(dt, ctx);
    for (let i = this.cones.length - 1; i >= 0; i--) {
      const c = this.cones[i];
      const o = c.owner;
      const u = c.mat.uniforms;
      u.uTime.value += dt;
      const winding = c.out < 0 && o.alive && o.state === 'windup' && o.attack === c.attack;
      if (winding) {
        c.mesh.position.set(o.position.x, 0.05, o.position.z);
        c.mesh.rotation.y = o.yaw;
        u.uFill.value = Math.min(1, o.stateT / Math.max(0.01, o.stateDur));
        continue;
      }
      // The blow is coming (or it was cut short): a flash, then gone.
      if (c.out < 0) {
        c.out = 0;
        u.uFill.value = 1;
      }
      c.out += dt;
      u.uFade.value = Math.max(0, 1 - c.out / 0.22) * (c.out < 0.06 ? 1.6 : 1);
      if (c.out >= 0.22) {
        this.scene.remove(c.mesh);
        c.mat.dispose();
        this.cones.splice(i, 1);
      }
    }
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
