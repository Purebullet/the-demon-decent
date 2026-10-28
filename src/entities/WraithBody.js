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

// ------------------------------------------------------------------------
// Its flesh: tubes laid along its spine and tail, its arms and fingers
// (their rings worked out each frame, Tubes.ring/build), drawn twice. The
// shell glows at its edges where you see it side-on, with fibres running
// along it, light flowing down them and glitter caught in it; the core,
// drawn first, is a dark haze through the middle, so it has a body you see
// into rather than an outline.

const SHELL_VERT = /* glsl */ `
attribute float glow;
uniform float uFogDensity;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
varying float vGlow;
varying float vFog;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vUv = uv;
  vGlow = glow;
  float depth = -mv.z;
  vFog = exp(-uFogDensity * uFogDensity * depth * depth) * smoothstep(0.15, 0.5, depth);
  gl_Position = projectionMatrix * mv;
}`;

const NOISE = /* glsl */ `
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

const SHELL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uFade;
uniform float uHeat;
uniform vec3 uColor;
uniform vec3 uHot;
uniform vec3 uGold;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
varying float vGlow;
varying float vFog;
${NOISE}
void main() {
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(1.0 - ndv, 2.2);
  float u = vUv.x;
  float v = vUv.y;
  // Smoke drifting through it: where it is thin, even its edge breaks up,
  // so its outline is ragged, not a clean line.
  float sm = vnoise2(vec2(v * 7.0 + sin(u * 1.3 + uTime * 0.5) * 1.2, u * 1.1 - uTime * 0.45));
  sm = sm * 0.65 + vnoise2(vec2(v * 15.0 - uTime * 0.2, u * 2.7 - uTime * 0.8)) * 0.35;
  float smoke = smoothstep(0.3, 0.78, sm);
  // Fibres running along it, twisting a little, light flowing down them.
  float vw = v * 22.0 + sin(u * 2.3 + uTime * 0.7) * 1.6;
  float fib = smoothstep(0.55, 0.92, vnoise2(vec2(vw, u * 1.3 - uTime * 0.55)));
  float fib2 = smoothstep(0.66, 0.96, vnoise2(vec2(v * 47.0 - u * 0.8, u * 2.4 - uTime * 0.9)));
  float flow = 0.5 + 0.5 * sin(u * 5.0 - uTime * 2.2 + v * 12.566);
  float a = rim * (0.1 + 0.8 * smoke) + (fib * 0.65 + fib2 * 0.45) * (0.25 + 0.75 * rim) * (0.3 + 0.7 * flow) * (0.25 + 0.75 * smoke) + 0.004;
  vec3 col = mix(uColor, uHot, clamp(rim * smoke * 0.55 + fib * 0.3 + vGlow + uHeat, 0.0, 1.0));
  // Glitter caught in it, white and gold, winking: round specks.
  vec2 gp = vec2(u * 30.0, v * 40.0);
  vec2 gc = floor(gp);
  float h = hash2(gc);
  vec2 off = vec2(hash2(gc + 3.1), hash2(gc + 7.7)) * 0.5 + 0.25;
  float dot2 = smoothstep(0.2, 0.0, length(fract(gp) - off));
  float g = step(0.965, hash2(gc + floor(uTime * 3.0 + h * 7.0))) * dot2;
  vec3 spark = mix(vec3(1.0), uGold, step(0.55, hash2(gc * 1.7))) * g * 1.6;
  gl_FragColor = vec4((col * a * (1.0 + vGlow) + spark) * uFade * vFog, 1.0);
}`;

const CORE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uFade;
uniform vec3 uDark;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
varying float vFog;
${NOISE}
void main() {
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  // Dark swirls through it, thickest through the middle.
  float n = vnoise2(vec2(vUv.y * 9.0 + sin(vUv.x * 1.7 + uTime * 0.4) * 2.0, vUv.x * 2.2 - uTime * 0.35));
  float a = pow(ndv, 1.2) * (0.42 + 0.4 * n) * uFade * vFog;
  gl_FragColor = vec4(uDark, a);
}`;

// The shell and core materials, shared by its tubes and its skull.
export function fleshMaterials() {
  const shell = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uHeat: { value: 0 },
      uFogDensity: { value: 0 },
      uColor: { value: new THREE.Color(0.16, 0.66, 0.58) },
      uHot: { value: new THREE.Color(0.7, 1.0, 0.94) },
      uGold: { value: new THREE.Color(1.4, 0.9, 0.35) },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const core = new THREE.ShaderMaterial({
    uniforms: { uTime: shell.uniforms.uTime, uFade: shell.uniforms.uFade, uFogDensity: shell.uniforms.uFogDensity, uDark: { value: new THREE.Color(0.006, 0.03, 0.045) } },
    vertexShader: SHELL_VERT,
    fragmentShader: CORE_FRAG,
    transparent: true,
    depthWrite: false,
  });
  return { shell, core };
}

// `specs`: one per tube, { rings, sides, len: metres along it (for its
// fibres), tip: how white-hot its last rings are }. Each frame its rings are
// set (`ring`: centre and two radii), then `build` lays them out round the
// line they make, turned smoothly along it (each ring's `S` and `B` axes are
// kept, for what sits on its surface).
export class Tubes {
  constructor(specs, mats) {
    this.specs = specs;
    let rings = 0;
    let verts = 0;
    for (const s of specs) {
      s.ring0 = rings;
      s.vert0 = verts;
      rings += s.rings;
      verts += s.rings * (s.sides + 1);
      s.cos = new Float32Array(s.sides + 1);
      s.sin = new Float32Array(s.sides + 1);
      for (let k = 0; k <= s.sides; k++) {
        s.cos[k] = Math.cos((k / s.sides) * Math.PI * 2);
        s.sin[k] = Math.sin((k / s.sides) * Math.PI * 2);
      }
    }
    this.c = new Float32Array(rings * 3);
    this.ra = new Float32Array(rings);
    this.rb = new Float32Array(rings);
    this.S = new Float32Array(rings * 3);
    this.B = new Float32Array(rings * 3);
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const glow = new Float32Array(verts);
    const index = [];
    for (const s of specs) {
      const n = s.sides + 1;
      for (let i = 0; i < s.rings; i++) {
        const f = i / (s.rings - 1);
        for (let k = 0; k < n; k++) {
          const v = s.vert0 + i * n + k;
          uv[v * 2] = f * s.len;
          uv[v * 2 + 1] = k / s.sides;
          glow[v] = (s.tip || 0) * Math.max(0, (f - 0.55) / 0.45) ** 2;
          if (i < s.rings - 1 && k < s.sides) {
            const a = v;
            const b = v + n;
            index.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    geo.setIndex(index);
    this.geometry = geo;
    this.shell = new THREE.Mesh(geo, mats.shell);
    this.core = new THREE.Mesh(geo, mats.core);
    for (const m of [this.shell, this.core]) m.frustumCulled = false;
    this.shell.renderOrder = 10;
    this.core.renderOrder = 9;
  }

  ring(tube, i, x, y, z, ra, rb) {
    const r = this.specs[tube].ring0 + i;
    this.c[r * 3] = x;
    this.c[r * 3 + 1] = y;
    this.c[r * 3 + 2] = z;
    this.ra[r] = ra;
    this.rb[r] = rb;
  }

  // Lays out tube `tube` from its rings; (sx, sy, sz) is which way its first
  // ring's `S` axis should point (as near as it can, square to the tube).
  // Its surface ripples and wavers (by the tube's `wob`, at time `t`), so
  // its outline is never a clean line.
  build(tube, sx, sy, sz, t = 0) {
    const s = this.specs[tube];
    const C = this.c;
    const S = this.S;
    const Bv = this.B;
    const pos = this.posAttr.array;
    const nrm = this.nrmAttr.array;
    const n = s.sides + 1;
    let px = sx;
    let py = sy;
    let pz = sz;
    for (let i = 0; i < s.rings; i++) {
      const r = s.ring0 + i;
      const a = (s.ring0 + Math.max(0, i - 1)) * 3;
      const b = (s.ring0 + Math.min(s.rings - 1, i + 1)) * 3;
      let tx = C[b] - C[a];
      let ty = C[b + 1] - C[a + 1];
      let tz = C[b + 2] - C[a + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      // (Carried on from the ring before, square to the tube here.)
      const d = px * tx + py * ty + pz * tz;
      px -= tx * d;
      py -= ty * d;
      pz -= tz * d;
      let pl = Math.hypot(px, py, pz);
      if (pl < 1e-4) {
        px = Math.abs(tx) < 0.9 ? 1 : 0;
        py = Math.abs(tx) < 0.9 ? 0 : 1;
        pz = 0;
        const d2 = px * tx + py * ty + pz * tz;
        px -= tx * d2;
        py -= ty * d2;
        pz -= tz * d2;
        pl = Math.hypot(px, py, pz);
      }
      px /= pl;
      py /= pl;
      pz /= pl;
      const bx = ty * pz - tz * py;
      const by = tz * px - tx * pz;
      const bz = tx * py - ty * px;
      S[r * 3] = px;
      S[r * 3 + 1] = py;
      S[r * 3 + 2] = pz;
      Bv[r * 3] = bx;
      Bv[r * 3 + 1] = by;
      Bv[r * 3 + 2] = bz;
      const cx = C[r * 3];
      const cy = C[r * 3 + 1];
      const cz = C[r * 3 + 2];
      const ra = this.ra[r];
      const rb = this.rb[r];
      const wob = s.wob || 0;
      for (let k = 0; k < n; k++) {
        const co = s.cos[k];
        const si = s.sin[k];
        const v = (s.vert0 + i * n + k) * 3;
        // (The seam's last vertex is its first: the same ripple.)
        const kk = k % s.sides;
        const w = wob ? 1 + wob * (Math.sin(kk * 2.3 + i * 0.71 + t * 2.1) * 0.6 + Math.sin(kk * 5.1 - i * 1.37 + t * 3.3) * 0.4) : 1;
        pos[v] = cx + (px * co * ra + bx * si * rb) * w;
        pos[v + 1] = cy + (py * co * ra + by * si * rb) * w;
        pos[v + 2] = cz + (pz * co * ra + bz * si * rb) * w;
        let nx = px * co * rb + bx * si * ra;
        let ny = py * co * rb + by * si * ra;
        let nz = pz * co * rb + bz * si * ra;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nrm[v] = nx / nl;
        nrm[v + 1] = ny / nl;
        nrm[v + 2] = nz / nl;
      }
    }
  }

  // A point on the surface of ring `r` (counted over all tubes), at angle
  // `a` round it and `k` times its radius out.
  surface(r, a, k, out) {
    const co = Math.cos(a) * k;
    const si = Math.sin(a) * k;
    const ra = this.ra[r];
    const rb = this.rb[r];
    return out.set(
      this.c[r * 3] + this.S[r * 3] * co * ra + this.B[r * 3] * si * rb,
      this.c[r * 3 + 1] + this.S[r * 3 + 1] * co * ra + this.B[r * 3 + 1] * si * rb,
      this.c[r * 3 + 2] + this.S[r * 3 + 2] * co * ra + this.B[r * 3 + 2] * si * rb,
    );
  }

  commit() {
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
  }
}

// ------------------------------------------------------------------------
// Its face, painted: a skull's, with a heavy brow slanting down over dark
// sockets, slanted white-hot eyes, the hole of the nose, cheekbones and a
// row of teeth with two long fangs; and its jaw apart, with fangs of its
// own, to open as it roars. Drawn on curved cards over the front of its
// skull, fading as you see them edge-on.

const FACE_VERT = /* glsl */ `
uniform float uFogDensity;
varying vec2 vUv;
varying float vFace;
varying float vFog;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFace = dot(normalize(normalMatrix * normal), normalize(-mv.xyz));
  float depth = -mv.z;
  vFog = exp(-uFogDensity * uFogDensity * depth * depth);
  gl_Position = projectionMatrix * mv;
}`;

const FACE_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uFade;
uniform float uHeat;
uniform float uOpacity;
varying vec2 vUv;
varying float vFace;
varying float vFog;
void main() {
  vec4 c = texture2D(map, vUv);
  float a = c.a * smoothstep(0.06, 0.42, vFace) * uFade * uOpacity;
  vec3 col = mix(c.rgb, vec3(0.85, 1.0, 1.0), uHeat * 0.35 * step(0.3, c.g));
  gl_FragColor = vec4(mix(vec3(0.0), col, vFog), a * mix(0.4, 1.0, vFog));
}`;

function canvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return [cv, cv.getContext('2d')];
}

// A tooth from its root line at `y`, pointing `dir` (1 down, -1 up).
function tooth(g, x, y, w, len, dir) {
  g.beginPath();
  g.moveTo(x - w / 2, y);
  g.quadraticCurveTo(x - w * 0.32, y + dir * len * 0.62, x + w * 0.08, y + dir * len);
  g.quadraticCurveTo(x + w * 0.34, y + dir * len * 0.55, x + w / 2, y);
  g.closePath();
  const gr = g.createLinearGradient(0, y, 0, y + dir * len);
  gr.addColorStop(0, 'rgba(150,225,215,0.95)');
  gr.addColorStop(1, 'rgba(240,255,252,1)');
  g.fillStyle = gr;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = 'rgba(0,18,24,0.75)';
  g.stroke();
}

function glowStroke(g, width, alpha, draw) {
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.shadowColor = 'rgba(70,255,220,0.9)';
  g.shadowBlur = 10;
  g.strokeStyle = `rgba(170,255,238,${alpha})`;
  g.lineWidth = width;
  g.beginPath();
  draw();
  g.stroke();
  g.restore();
}

function skullFace() {
  const [cv, g] = canvas(256, 256);
  const cx = 128;
  // The bone of the face, faint.
  const face = new Path2D();
  face.moveTo(cx - 112, 52);
  face.bezierCurveTo(cx - 120, 112, cx - 98, 150, cx - 62, 184);
  face.lineTo(cx + 62, 184);
  face.bezierCurveTo(cx + 98, 150, cx + 120, 112, cx + 112, 52);
  face.bezierCurveTo(cx + 60, 28, cx - 60, 28, cx - 112, 52);
  const fill = g.createRadialGradient(cx, 112, 10, cx, 112, 135);
  fill.addColorStop(0, 'rgba(80,200,186,0.42)');
  fill.addColorStop(1, 'rgba(80,200,186,0.06)');
  g.fillStyle = fill;
  g.fill(face);
  // Hollows under the cheekbones.
  for (const s of [-1, 1]) {
    const h = g.createRadialGradient(cx + s * 70, 158, 2, cx + s * 70, 158, 30);
    h.addColorStop(0, 'rgba(0,10,16,0.6)');
    h.addColorStop(1, 'rgba(0,10,16,0)');
    g.fillStyle = h;
    g.fillRect(cx + s * 70 - 32, 126, 64, 64);
  }
  // Sockets, slanting down to the middle, and the eyes burning in them.
  for (const s of [-1, 1]) {
    g.save();
    g.translate(cx + s * 46, 100);
    g.rotate(-s * 0.32);
    g.scale(1, 0.74);
    const so = g.createRadialGradient(0, 0, 4, 0, 0, 40);
    so.addColorStop(0, 'rgba(0,5,10,0.97)');
    so.addColorStop(0.72, 'rgba(0,8,14,0.88)');
    so.addColorStop(1, 'rgba(0,10,16,0)');
    g.fillStyle = so;
    g.beginPath();
    g.arc(0, 0, 40, 0, Math.PI * 2);
    g.fill();
    const e = g.createRadialGradient(0, 3, 1, 0, 3, 20);
    e.addColorStop(0, 'rgba(255,255,255,1)');
    e.addColorStop(0.4, 'rgba(215,252,255,0.97)');
    e.addColorStop(1, 'rgba(90,225,255,0)');
    g.fillStyle = e;
    g.beginPath();
    g.ellipse(0, 3, 20, 12, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // The nose: a dark hole, narrow at the top.
  g.beginPath();
  g.moveTo(cx, 124);
  g.bezierCurveTo(cx - 6, 134, cx - 16, 148, cx - 11, 158);
  g.quadraticCurveTo(cx - 4, 160, cx, 153);
  g.quadraticCurveTo(cx + 4, 160, cx + 11, 158);
  g.bezierCurveTo(cx + 16, 148, cx + 6, 134, cx, 124);
  g.fillStyle = 'rgba(0,8,14,0.93)';
  g.fill();
  // Brow, cheekbones and the line of the face.
  for (const s of [-1, 1]) {
    glowStroke(g, 8, 0.95, () => {
      g.moveTo(cx + s * 96, 62);
      g.quadraticCurveTo(cx + s * 58, 64, cx + s * 16, 88);
    });
    glowStroke(g, 5, 0.75, () => {
      g.moveTo(cx + s * 70, 126);
      g.quadraticCurveTo(cx + s * 92, 150, cx + s * 62, 180);
    });
    glowStroke(g, 4, 0.65, () => {
      g.moveTo(cx + s * 112, 54);
      g.bezierCurveTo(cx + s * 120, 112, cx + s * 98, 150, cx + s * 62, 184);
    });
  }
  glowStroke(g, 3, 0.6, () => {
    g.moveTo(cx - 62, 183);
    g.lineTo(cx + 62, 183);
  });
  // Upper teeth, the fangs long.
  for (const [x, w, len] of [
    [0, 0, 0],
    [6, 11, 18],
    [18, 11, 17],
    [34, 15, 52],
    [46, 11, 15],
    [56, 10, 11],
  ]) {
    if (!w) continue;
    for (const s of [-1, 1]) tooth(g, cx + s * x, 184, w, len, 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

function skullJaw() {
  const [cv, g] = canvas(256, 128);
  const cx = 128;
  const jaw = new Path2D();
  jaw.moveTo(cx - 64, 4);
  jaw.bezierCurveTo(cx - 68, 64, cx - 42, 112, cx, 118);
  jaw.bezierCurveTo(cx + 42, 112, cx + 68, 64, cx + 64, 4);
  jaw.closePath();
  const fill = g.createRadialGradient(cx, 60, 6, cx, 60, 80);
  fill.addColorStop(0, 'rgba(80,200,186,0.36)');
  fill.addColorStop(1, 'rgba(80,200,186,0.08)');
  g.fillStyle = fill;
  g.fill(jaw);
  glowStroke(g, 4, 0.7, () => {
    g.moveTo(cx - 64, 4);
    g.bezierCurveTo(cx - 68, 64, cx - 42, 112, cx, 118);
    g.bezierCurveTo(cx + 42, 112, cx + 68, 64, cx + 64, 4);
  });
  glowStroke(g, 3, 0.55, () => {
    g.moveTo(cx - 56, 46);
    g.lineTo(cx + 56, 46);
  });
  for (const [x, w, len] of [
    [6, 10, 14],
    [16, 10, 15],
    [29, 14, 40],
    [42, 10, 12],
    [52, 9, 9],
  ]) {
    for (const s of [-1, 1]) tooth(g, cx + s * x, 46, w, len, -1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

function darkMouth() {
  const [cv, g] = canvas(128, 128);
  const m = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  m.addColorStop(0, 'rgba(0,4,8,0.98)');
  m.addColorStop(0.7, 'rgba(0,6,10,0.85)');
  m.addColorStop(1, 'rgba(0,8,12,0)');
  g.fillStyle = m;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

function faceMaterial(map, fog) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, uFade: { value: 1 }, uHeat: { value: 0 }, uOpacity: { value: 1 }, uFogDensity: fog },
    vertexShader: FACE_VERT,
    fragmentShader: FACE_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

// A card `w` by `h`, bent back at its sides round a skull (`bend`), with
// its top edge at y = 0 when `hinge` is set (a jaw), else centred.
function card(w, h, bend, hinge) {
  const geo = new THREE.PlaneGeometry(w, h, 10, 6);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, -bend * x * x);
    if (hinge) p.setY(i, p.getY(i) - h / 2);
  }
  geo.computeVertexNormals();
  return geo;
}

// Its head: a skull shell (sharing the flesh materials) with the face, jaw
// and mouth cards on it. Head space: its middle at the origin, facing +z.
export function buildHead(mats) {
  const group = new THREE.Group();
  const sphere = new THREE.SphereGeometry(1, 20, 14);
  sphere.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(sphere.attributes.position.count), 1));
  // (Its skull is the shell alone: with the dark core too, seen from the
  // side it read as a helmet.)
  const skull = new THREE.Mesh(sphere, mats.shell);
  skull.position.set(0, 0.04, -0.07);
  skull.scale.set(0.135, 0.165, 0.24);
  skull.renderOrder = 10;
  const fog = mats.shell.uniforms.uFogDensity;
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.16), faceMaterial(darkMouth(), fog));
  mouth.position.set(0, -0.13, 0.13);
  mouth.renderOrder = 11;
  const face = new THREE.Mesh(card(0.3, 0.3, 2.4, false), faceMaterial(skullFace(), fog));
  face.position.set(0, -0.03, 0.175);
  face.renderOrder = 12;
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.082, 0.15);
  const jawCard = new THREE.Mesh(card(0.3, 0.15, 2.4, true), faceMaterial(skullJaw(), fog));
  jawCard.position.z = 0.02;
  jawCard.renderOrder = 12;
  jaw.add(jawCard);
  group.add(skull, mouth, face, jaw);
  return { group, face, jaw, jawCard, mouth, sphere };
}
