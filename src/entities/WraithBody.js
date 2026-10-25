import * as THREE from 'three';

// The Grave Wraith's body (Wraith.js): a few hundred thin strands of light,
// each a ribbon turned to face the eye, laid along a path the wraith works
// out afresh every frame (its tail's spiral, its arms, the hair streaming
// off its skull). Light flows along each strand toward its tip, and specks
// of glitter (gold in some) run with it, as in the painting it is drawn
// from: strands, not orbs.

const VERT = /* glsl */ `
attribute vec3 tangent;
attribute float side;
attribute vec4 strand; // u along it, width, seed, tone (0 teal, 1 gold flecks, 2 white-hot)
attribute float alpha;
uniform float uPixel;
uniform float uFogDensity;
varying float vU;
varying float vSide;
varying float vSeed;
varying float vTone;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 t = (modelViewMatrix * vec4(tangent, 0.0)).xyz;
  vec3 s = cross(t, mv.xyz);
  float sl = length(s);
  s = sl > 1e-7 ? s / sl : vec3(1.0, 0.0, 0.0);
  float depth = max(0.05, -mv.z);
  // Never thinner than a pixel and a half: further off, a strand is drawn
  // that wide and fainter instead, so it does not flicker.
  float w = strand.y;
  float minW = depth * uPixel * 1.5;
  float thin = w < minW ? w / minW : 1.0;
  w = max(w, minW);
  mv.xyz += s * side * w * 0.5;
  gl_Position = projectionMatrix * mv;
  vU = strand.x;
  vSide = side;
  vSeed = strand.z;
  vTone = strand.w;
  float near = smoothstep(0.2, 0.6, depth);
  vAlpha = alpha * thin * near * exp(-uFogDensity * uFogDensity * depth * depth);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uHeat;
uniform float uFade;
uniform vec3 uColor;
uniform vec3 uHot;
uniform vec3 uGold;
varying float vU;
varying float vSide;
varying float vSeed;
varying float vTone;
varying float vAlpha;
float hash(float n) { return fract(sin(n) * 43758.5453123); }
float vnoise(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
void main() {
  // Sharp in the middle, soft at the edges.
  float c = 1.0 - abs(vSide);
  float core = c * c;
  // Light flowing out along it, in streaks.
  float x = vU * 7.0 - uTime * 1.4 + vSeed * 31.0;
  float flow = vnoise(x) * 0.6 + vnoise(x * 2.3 + 11.0) * 0.4;
  flow = smoothstep(0.28, 0.9, flow);
  // Glitter running with it.
  float cell = floor(vU * 80.0 - uTime * 7.0 + vSeed * 57.0);
  float speck = step(0.88, hash(cell + vSeed * 13.0)) * smoothstep(0.35, 1.0, c);
  float glow = step(2.5, vTone);
  float hot = step(1.5, vTone) * (1.0 - glow);
  float gold = step(0.5, vTone) * (1.0 - hot - glow);
  // (A glow strand is wide and soft all across: the haze round it.)
  float shape = mix(core, c, glow);
  float a = shape * (0.25 + 0.75 * mix(flow, 0.6 + 0.4 * flow, glow)) * vAlpha * uFade;
  vec3 col = mix(uColor, uHot, clamp(flow * core * 0.45 * (1.0 - glow) + hot * 0.6 + uHeat, 0.0, 1.0));
  vec3 fleck = mix(vec3(1.0), uGold, gold) * speck * (1.0 - glow) * vAlpha * uFade * 1.6;
  gl_FragColor = vec4(col * a + fleck, 1.0);
}`;

export const TONE_TEAL = 0;
export const TONE_GOLD = 1;
export const TONE_HOT = 2;
export const TONE_GLOW = 3;

// `specs`: one per strand, { n: points, w0, w1: width at its root and tip,
// a: brightness, tone (TONE_*), seed }; anything else on them is the
// wraith's own.
// Each strand's points are written (its own space) with `set`, then
// `commit` turns them into ribbons.
export class Strands {
  constructor(specs) {
    this.specs = specs;
    let total = 0;
    for (const s of specs) {
      s.start = total;
      total += s.n;
    }
    this.count = total;
    // The points themselves (two vertices each, one either side).
    this.pts = new Float32Array(total * 3);
    const V = total * 2;
    const pos = new Float32Array(V * 3);
    const tan = new Float32Array(V * 3);
    const side = new Float32Array(V);
    const strand = new Float32Array(V * 4);
    const alpha = new Float32Array(V);
    const index = [];
    for (const s of specs) {
      for (let i = 0; i < s.n; i++) {
        const u = i / (s.n - 1);
        const p = s.start + i;
        // Fading in from its root and out to its tip, thinning as it goes.
        // (`aIn`: dimmer over its first quarter, rising to full.)
        const a = s.a * Math.min(1, u / 0.06 + (s.fadeIn === false ? 1 : 0)) * Math.min(1, (1 - u) / 0.22) * (s.aIn === undefined ? 1 : s.aIn + (1 - s.aIn) * Math.min(1, u / 0.25));
        const w = s.w0 + (s.w1 - s.w0) * u;
        for (let k = 0; k < 2; k++) {
          const v = p * 2 + k;
          side[v] = k ? 1 : -1;
          strand[v * 4] = u;
          strand[v * 4 + 1] = w;
          strand[v * 4 + 2] = s.seed;
          strand[v * 4 + 3] = s.tone;
          alpha[v] = a;
        }
        if (i < s.n - 1) {
          const a0 = p * 2;
          index.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.tanAttr = new THREE.BufferAttribute(tan, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('tangent', this.tanAttr);
    geo.setAttribute('side', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('strand', new THREE.BufferAttribute(strand, 4));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    geo.setIndex(index);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHeat: { value: 0 },
        uFade: { value: 1 },
        uPixel: { value: 0.002 },
        uFogDensity: { value: 0 },
        uColor: { value: new THREE.Color(0.2, 0.78, 0.68) },
        uHot: { value: new THREE.Color(0.78, 1.0, 0.95) },
        uGold: { value: new THREE.Color(1.4, 0.9, 0.35) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  set(i, x, y, z) {
    const p = this.pts;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
  }

  // Each point's two vertices, and which way the strand runs there.
  commit() {
    const p = this.pts;
    const pos = this.posAttr.array;
    const tan = this.tanAttr.array;
    for (const s of this.specs) {
      const last = s.start + s.n - 1;
      for (let i = s.start; i <= last; i++) {
        const a = Math.max(s.start, i - 1) * 3;
        const b = Math.min(last, i + 1) * 3;
        const tx = p[b] - p[a];
        const ty = p[b + 1] - p[a + 1];
        const tz = p[b + 2] - p[a + 2];
        const v = i * 6;
        pos[v] = pos[v + 3] = p[i * 3];
        pos[v + 1] = pos[v + 4] = p[i * 3 + 1];
        pos[v + 2] = pos[v + 5] = p[i * 3 + 2];
        tan[v] = tan[v + 3] = tx;
        tan[v + 1] = tan[v + 4] = ty;
        tan[v + 2] = tan[v + 5] = tz;
      }
    }
    this.posAttr.needsUpdate = true;
    this.tanAttr.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
