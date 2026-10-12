import * as THREE from 'three';

// Pooled CPU-simulated particles drawn as one THREE.Points per system.
// Used for rising embers, horn fire, green flame manes, blood, sparks and
// spell effects. Sizes are in world units with perspective attenuation.

const VERT = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 color;
uniform float uScale;
uniform float uFogDensity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = -mv.z;
  gl_PointSize = size * uScale / max(depth, 0.1);
  gl_Position = projectionMatrix * mv;
  float fogF = exp(-uFogDensity * uFogDensity * depth * depth);
  vColor = color;
  vAlpha = alpha * fogF;
}`;

const FRAG_ADD = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a = a * a * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}`;

const FRAG_ALPHA = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.2, d) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

export class ParticleSystem {
  constructor({ max = 3000, additive = true } = {}) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.turb = new Float32Array(max);
    this.time = 0;
    this.emitters = [];

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setAttribute('size', this.sizeAttr);
    geo.setAttribute('alpha', this.alphaAttr);
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uFogDensity: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: additive ? FRAG_ADD : FRAG_ALPHA,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 10 : 9;
  }

  setViewport(height, fovDeg) {
    this.material.uniforms.uScale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  setFogDensity(d) {
    this.material.uniforms.uFogDensity.value = d;
  }

  clear() {
    this.count = 0;
    this.emitters.length = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  emit(o) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = o.x;
    this.pos[i3 + 1] = o.y;
    this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx || 0;
    this.vel[i3 + 1] = o.vy || 0;
    this.vel[i3 + 2] = o.vz || 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life || 1;
    this.size0[i] = o.size ?? 0.2;
    this.size1[i] = o.sizeEnd ?? this.size0[i];
    const c = o.color;
    const ce = o.colorEnd || c;
    this.c0[i3] = c.r;
    this.c0[i3 + 1] = c.g;
    this.c0[i3 + 2] = c.b;
    this.c1[i3] = ce.r;
    this.c1[i3 + 1] = ce.g;
    this.c1[i3 + 2] = ce.b;
    this.a0[i] = o.alpha ?? 1;
    this.drag[i] = o.drag ?? 0.5;
    this.grav[i] = o.gravity ?? 0;
    this.turb[i] = o.turbulence ?? 0;
  }

  // Continuous emitter glued to an Object3D (horn tips, torches, the pit).
  // `spawn(ps, worldPos)` is called `rate` times per second.
  addEmitter(anchor, rate, spawn, offset = null) {
    const e = { anchor, rate, spawn, offset, acc: Math.random(), active: true };
    this.emitters.push(e);
    return e;
  }

  removeEmittersOf(anchorRoot) {
    this.emitters = this.emitters.filter((e) => {
      let o = e.anchor;
      while (o) {
        if (o === anchorRoot) return false;
        o = o.parent;
      }
      return true;
    });
  }

  update(dt) {
    this.time += dt;
    const wp = ParticleSystem._wp;
    for (const e of this.emitters) {
      if (!e.active) continue;
      e.acc += e.rate * dt;
      if (e.acc < 1) continue;
      if (e.offset) wp.copy(e.offset);
      else wp.set(0, 0, 0);
      // Without an anchor the offset is a fixed world position.
      if (e.anchor) e.anchor.localToWorld(wp);
      while (e.acc >= 1) {
        e.acc -= 1;
        e.spawn(this, wp);
      }
    }

    const t = this.time;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      const life = (this.life[i] += dt);
      if (life >= this.maxLife[i]) {
        // Swap-remove with the last live particle.
        n--;
        this._copy(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const k = life / this.maxLife[i];
      const drag = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= drag;
      this.vel[i3 + 1] = this.vel[i3 + 1] * drag + this.grav[i] * dt;
      this.vel[i3 + 2] *= drag;
      const tb = this.turb[i];
      if (tb > 0) {
        const ph = i * 1.7;
        this.vel[i3] += Math.sin(t * 2.3 + ph) * tb * dt;
        this.vel[i3 + 2] += Math.cos(t * 1.9 + ph * 1.3) * tb * dt;
      }
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * k;
      this.col[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * k;
      this.col[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * k;
      this.col[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * k;
      // Fade in quickly, fade out over the last 40% of life.
      const fade = Math.min(1, k * 8) * Math.min(1, (1 - k) / 0.4);
      this.alpha[i] = this.a0[i] * fade;
    }
    this.count = n;
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  _copy(from, to) {
    if (from === to) return;
    const f3 = from * 3;
    const t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.c0[t3 + k] = this.c0[f3 + k];
      this.c1[t3 + k] = this.c1[f3 + k];
      this.col[t3 + k] = this.col[f3 + k];
    }
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from];
    this.size1[to] = this.size1[from];
    this.size[to] = this.size[from];
    this.a0[to] = this.a0[from];
    this.alpha[to] = this.alpha[from];
    this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from];
    this.turb[to] = this.turb[from];
  }
}
ParticleSystem._wp = new THREE.Vector3();

// Shared colour constants for spawn callbacks.
export const C = {
  emberHot: new THREE.Color(1.0, 0.75, 0.3),
  emberRed: new THREE.Color(0.8, 0.12, 0.02),
  fireCore: new THREE.Color(1.0, 0.85, 0.45),
  fireEdge: new THREE.Color(0.9, 0.2, 0.02),
  fireBlue: new THREE.Color(0.35, 0.55, 1.0),
  greenCore: new THREE.Color(0.7, 1.0, 0.75),
  greenEdge: new THREE.Color(0.05, 0.6, 0.35),
  blood: new THREE.Color(0.35, 0.0, 0.0),
  bloodDark: new THREE.Color(0.12, 0.0, 0.0),
  spark: new THREE.Color(1.0, 0.9, 0.6),
  smoke: new THREE.Color(0.08, 0.06, 0.06),
  violet: new THREE.Color(0.75, 0.35, 1.0),
  violetDark: new THREE.Color(0.2, 0.0, 0.4),
  white: new THREE.Color(1, 1, 1),
};

// Common spawn helpers.
export function spawnFlame(ps, p, { core = C.fireCore, edge = C.fireEdge, size = 0.35, rise = 1.4, spread = 0.08, life = 0.7 } = {}) {
  ps.emit({
    x: p.x + (Math.random() - 0.5) * spread,
    y: p.y + (Math.random() - 0.5) * spread,
    z: p.z + (Math.random() - 0.5) * spread,
    vx: (Math.random() - 0.5) * 0.3,
    vy: rise * (0.6 + Math.random() * 0.6),
    vz: (Math.random() - 0.5) * 0.3,
    life: life * (0.6 + Math.random() * 0.6),
    size,
    sizeEnd: size * 0.2,
    color: core,
    colorEnd: edge,
    drag: 1.2,
    turbulence: 1.5,
  });
}

export function burst(ps, p, { count = 20, speed = 4, color = C.spark, colorEnd = C.fireEdge, size = 0.12, life = 0.5, gravity = -9, up = 1 } = {}) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = (Math.random() - 0.3) * up;
    const s = speed * (0.4 + Math.random() * 0.8);
    ps.emit({
      x: p.x,
      y: p.y,
      z: p.z,
      vx: Math.cos(a) * s,
      vy: e * s,
      vz: Math.sin(a) * s,
      life: life * (0.5 + Math.random()),
      size,
      sizeEnd: size * 0.3,
      color,
      colorEnd,
      drag: 1.5,
      gravity,
    });
  }
}

export function ring(ps, p, radius, { count = 60, color = C.fireCore, colorEnd = C.fireEdge, size = 0.5, life = 0.6, speed = 6 } = {}) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    ps.emit({
      x: p.x + Math.cos(a) * radius * 0.2,
      y: p.y + 0.3,
      z: p.z + Math.sin(a) * radius * 0.2,
      vx: Math.cos(a) * speed,
      vy: 0.6,
      vz: Math.sin(a) * speed,
      life,
      size,
      sizeEnd: size * 1.6,
      color,
      colorEnd,
      drag: 2.5,
    });
  }
}
