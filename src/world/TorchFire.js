import * as THREE from 'three';
import { softDotTexture } from './Textures.js';

// A 3D flame: two nested teardrop volumes (a wide orange body and a narrow
// white-hot core), drawn additively so they read as glowing gas from any
// angle. The vertex shader licks and flickers them with 3D noise, and bends
// them by `lean` (in the flame's own space), more toward the tip: give it
// the opposite of the flame's motion and it trails behind like real fire.
// A few embers drift off the top, carried the same way.

const NOISE = /* glsl */ `
float tfHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float tfNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(tfHash(i), tfHash(i + vec3(1.0, 0.0, 0.0)), u.x), mix(tfHash(i + vec3(0.0, 1.0, 0.0)), tfHash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y);
  float b = mix(mix(tfHash(i + vec3(0.0, 0.0, 1.0)), tfHash(i + vec3(1.0, 0.0, 1.0)), u.x), mix(tfHash(i + vec3(0.0, 1.0, 1.0)), tfHash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}`;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uHeight;
uniform float uSeed;
uniform vec3 uLean;
varying float vH;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
${NOISE}
void main() {
  float h = clamp(position.y / uHeight, 0.0, 1.0);
  vec3 p = position;
  float t = uTime;
  float n = tfNoise(vec3(p.x * 18.0, p.y * 11.0 - t * 7.0, p.z * 18.0) + uSeed);
  p.xz *= 1.0 + (n - 0.5) * 0.9 * h;
  p.x += sin(t * 11.0 + h * 7.0 + uSeed) * 0.012 * h * h;
  p.z += cos(t * 9.3 + h * 6.0 + uSeed) * 0.01 * h * h;
  p.y *= 1.0 + 0.14 * sin(t * 13.0 + uSeed) * h + (n - 0.5) * 0.18 * h;
  p += uLean * pow(h, 1.6);
  vH = h;
  vP = position;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uSeed;
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uTip;
varying float vH;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
${NOISE}
void main() {
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float body = pow(facing, 1.4);
  // Tongues of flame torn up the body by rising noise.
  float tongue = tfNoise(vec3(vP.x * 40.0, vP.y * 26.0 - uTime * 9.0, vP.z * 40.0) + uSeed);
  float fade = 1.0 - smoothstep(0.45 + tongue * 0.35, 1.0, vH);
  vec3 c = mix(uHot, uMid, smoothstep(0.05, 0.55, vH + (1.0 - facing) * 0.35));
  c = mix(c, uTip, smoothstep(0.5, 0.95, vH));
  float a = body * fade * (0.75 + 0.5 * tongue) * smoothstep(0.0, 0.06, vH);
  gl_FragColor = vec4(c * a * uIntensity, a);
}`;

const _d = new THREE.Vector3();

// Teardrop profile: round at the base, drawn to a point at the top.
function teardrop(width, height, rings = 14, segs = 14) {
  const pts = [];
  for (let i = 0; i <= rings; i++) {
    const h = i / rings;
    const r = width * Math.pow(Math.sin(Math.PI * Math.pow(h, 0.5)), 0.85) * (1 - 0.3 * h);
    pts.push(new THREE.Vector2(Math.max(r, 1e-4), h * height));
  }
  return new THREE.LatheGeometry(pts, segs);
}

function layer(width, height, { hot, mid, tip, intensity, seed }) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: height },
      uSeed: { value: seed },
      uLean: { value: new THREE.Vector3() },
      uIntensity: { value: intensity },
      uHot: { value: new THREE.Color(hot) },
      uMid: { value: new THREE.Color(mid) },
      uTip: { value: new THREE.Color(tip) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(teardrop(width, height), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}

export class TorchFire {
  // height in metres; `embers` drift off the top (0 for none).
  constructor({ height = 0.26, width = 0.065, seed = 1.3, embers = 14, intensity = 1 } = {}) {
    this.group = new THREE.Group();
    this.height = height;
    this.outer = layer(width, height, { hot: 0xffd27a, mid: 0xff6a14, tip: 0x8a1404, intensity: 1.15 * intensity, seed });
    this.inner = layer(width * 0.55, height * 0.62, { hot: 0xfff6dc, mid: 0xffc04a, tip: 0xff6a14, intensity: 1.3 * intensity, seed: seed + 4.7 });
    this.inner.position.y = 0.004;
    this.group.add(this.outer, this.inner);
    this.lean = new THREE.Vector3();
    this.leanVel = new THREE.Vector3();
    this.leanTarget = new THREE.Vector3();
    this.drift = new THREE.Vector3();
    this.t = 0;
    this.embers = [];
    if (embers) {
      const geo = new THREE.BufferGeometry();
      this.emberPos = new Float32Array(embers * 3);
      this.emberCol = new Float32Array(embers * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(this.emberCol, 3));
      this.points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ size: 0.012, map: softDotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      );
      this.points.frustumCulled = false;
      this.points.renderOrder = 7;
      this.group.add(this.points);
      for (let i = 0; i < embers; i++) this.embers.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1 });
    }
  }

  // `drift` (flame space, m/s): the air the flame moves through, i.e. the
  // opposite of its own velocity. `up` (flame space, unit): world up.
  update(dt, time, drift = null, up = null) {
    this.t = time;
    this.leanTarget.set(0, 0, 0);
    if (drift) this.leanTarget.addScaledVector(drift, 0.022);
    if (up) {
      // Fire rises toward the sky, however the torch is tilted.
      this.leanTarget.x += up.x * this.height * 0.9;
      this.leanTarget.z += up.z * this.height * 0.9;
    }
    this.leanTarget.clampLength(0, this.height * 0.85);
    // A soft spring, so the flame swings and settles instead of snapping.
    const k = 70;
    const c = 11;
    _d.subVectors(this.leanTarget, this.lean);
    this.leanVel.addScaledVector(_d, k * dt).multiplyScalar(Math.max(0, 1 - c * dt));
    this.lean.addScaledVector(this.leanVel, dt);
    for (const m of [this.outer, this.inner]) {
      m.material.uniforms.uTime.value = time;
      m.material.uniforms.uLean.value.copy(this.lean);
    }
    if (drift) this.drift.copy(drift);
    if (this.points) this._embers(dt);
  }

  _embers(dt) {
    const H = this.height;
    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i];
      e.life -= dt;
      if (e.life <= 0) {
        e.max = e.life = 0.35 + Math.random() * 0.5;
        e.p.set((Math.random() - 0.5) * 0.03, H * (0.35 + Math.random() * 0.4), (Math.random() - 0.5) * 0.03);
        e.v.set((Math.random() - 0.5) * 0.08, 0.25 + Math.random() * 0.25, (Math.random() - 0.5) * 0.08);
      }
      e.v.addScaledVector(this.drift, dt * 1.2);
      e.p.addScaledVector(e.v, dt);
      const k = e.life / e.max;
      this.emberPos[i * 3] = e.p.x;
      this.emberPos[i * 3 + 1] = e.p.y;
      this.emberPos[i * 3 + 2] = e.p.z;
      this.emberCol[i * 3] = 1.0 * k;
      this.emberCol[i * 3 + 1] = 0.5 * k * k;
      this.emberCol[i * 3 + 2] = 0.12 * k * k;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  setIntensity(k) {
    this.group.visible = k > 0.01;
    this.group.scale.setScalar(Math.max(0.001, k));
  }
}
