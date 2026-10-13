import * as THREE from 'three';

// Animated surface shaders: molten lava, the exit vortex, and the blood
// well. All respect scene fog.

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}`;

const VERT = /* glsl */ `
#include <fog_pars_vertex>
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

function make(frag, uniforms = {}, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }, uniforms]),
    vertexShader: VERT,
    fragmentShader: frag,
    fog: true,
    ...opts,
  });
}

export function lavaMaterial() {
  return make(/* glsl */ `
    #include <fog_pars_fragment>
    uniform float uTime;
    varying vec3 vWorld;
    ${NOISE}
    void main() {
      vec2 p = vWorld.xz * 0.35;
      float n = fbm(p + vec2(uTime * 0.05, uTime * 0.03));
      float n2 = fbm(p * 2.1 - vec2(uTime * 0.08, -uTime * 0.04) + n);
      float heat = smoothstep(0.32, 0.85, n * 0.65 + n2 * 0.55);
      vec3 col = mix(vec3(0.18, 0.015, 0.0), vec3(1.0, 0.38, 0.03), heat);
      col += vec3(1.0, 0.85, 0.4) * pow(heat, 5.0) * 0.9;
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`);
}

export function portalMaterial() {
  return make(
    /* glsl */ `
    #include <fog_pars_fragment>
    uniform float uTime;
    uniform float uOpen;
    varying vec2 vUv;
    ${NOISE}
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c) * 2.0;
      if (r > 1.0) discard;
      float a = atan(c.y, c.x);
      float swirl = a + r * 6.0 - uTime * (0.8 + uOpen * 2.5);
      float n = fbm(vec2(cos(swirl), sin(swirl)) * 2.0 + r * 3.0 - uTime * 0.4);
      float core = smoothstep(1.0, 0.0, r);
      vec3 sealed = vec3(0.25, 0.02, 0.01) * (0.4 + n * 0.6);
      vec3 open = mix(vec3(0.9, 0.2, 0.02), vec3(1.0, 0.85, 0.5), pow(core, 3.0)) * (0.5 + n * 0.9);
      open = mix(open, vec3(0.0), smoothstep(0.15, 0.0, r) * 0.9);
      vec3 col = mix(sealed, open, uOpen);
      float edge = smoothstep(1.0, 0.85, r);
      gl_FragColor = vec4(col * edge, 1.0);
      #include <fog_fragment>
    }`,
    { uOpen: { value: 0 } },
  );
}

export function bloodMaterial() {
  return make(/* glsl */ `
    #include <fog_pars_fragment>
    uniform float uTime;
    varying vec2 vUv;
    ${NOISE}
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c) * 2.0;
      float ripple = sin(r * 18.0 - uTime * 2.5) * 0.5 + 0.5;
      float n = fbm(vUv * 6.0 + uTime * 0.1);
      vec3 col = mix(vec3(0.18, 0.0, 0.01), vec3(0.75, 0.02, 0.04), n * 0.7 + ripple * 0.3 * (1.0 - r));
      col += vec3(1.0, 0.3, 0.3) * pow(ripple, 12.0) * 0.25 * (1.0 - r);
      gl_FragColor = vec4(col, 1.0);
      #include <fog_fragment>
    }`);
}

// Heat glow seen at the bottom of the surface pit.
export function abyssMaterial() {
  return make(
    /* glsl */ `
    #include <fog_pars_fragment>
    uniform float uTime;
    varying vec2 vUv;
    ${NOISE}
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c) * 2.0;
      float a = atan(c.y, c.x);
      float n = fbm(vec2(a * 1.5 + uTime * 0.1, r * 4.0 - uTime * 0.5));
      float pulse = 0.75 + 0.25 * sin(uTime * 1.6);
      vec3 col = mix(vec3(1.0, 0.55, 0.12), vec3(0.45, 0.02, 0.0), smoothstep(0.0, 1.0, r));
      col *= (0.55 + n * 0.8) * pulse;
      gl_FragColor = vec4(col * smoothstep(1.0, 0.6, r), 1.0);
    }`,
    {},
    { fog: false },
  );
}

// A living flame: a camera-facing quad (any orientation of the mesh) whose
// teardrop shape is torn upward by scrolling noise, white-hot at the root,
// orange, then red at the licking tips. Additive, no depth write. `uSeed`
// keeps neighbouring flames out of step; `uIntensity` brightens or dims it.
export function flameMaterial({ seed = 0, intensity = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSeed: { value: seed }, uIntensity: { value: intensity } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Billboard: the quad's corners laid out in view space around its centre.
        vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        gl_Position = projectionMatrix * (centre + vec4(position.xy * scale, 0.0, 0.0));
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uSeed;
      uniform float uIntensity;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      // Three octaves are plenty for a flame (and cheap up close).
      float fbm(vec2 p) { return noise(p) * 0.55 + noise(p * 2.03) * 0.3 + noise(p * 4.1) * 0.15; }
      void main() {
        vec2 uv = vUv;
        float t = uTime * 1.6 + uSeed * 17.0;
        // Noise scrolling upward bends and tears the flame.
        float n = fbm(vec2(uv.x * 3.5, uv.y * 2.4 - t * 1.9));
        float n2 = fbm(vec2(uv.x * 7.0 + 3.1, uv.y * 4.0 - t * 3.1));
        float sway = (n - 0.5) * 0.35 * uv.y;
        vec2 p = vec2((uv.x - 0.5 - sway) * 2.0, uv.y);
        // Teardrop: wide and round at the root, pinched to a point at the top.
        float width = mix(0.62, 0.02, pow(uv.y, 0.9)) * (0.8 + 0.4 * n2);
        float body = 1.0 - smoothstep(width * 0.55, width, abs(p.x));
        body *= smoothstep(0.0, 0.12, uv.y) * (1.0 - smoothstep(0.55 + 0.3 * n, 1.0, uv.y));
        float heat = body * (1.15 - uv.y) * (0.75 + 0.5 * n2);
        vec3 col = mix(vec3(0.7, 0.06, 0.0), vec3(1.0, 0.42, 0.05), smoothstep(0.1, 0.5, heat));
        col = mix(col, vec3(1.0, 0.86, 0.55), smoothstep(0.55, 0.95, heat));
        float a = clamp(heat * 1.6, 0.0, 1.0) * uIntensity;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
}

// A flame object: two crossed noise flames (one smaller, hotter, inside the
// other). Update `flame.userData.tick(time)` each frame.
export function makeFlame({ height = 0.6, seed = Math.random() * 10, intensity = 1 } = {}) {
  const g = new THREE.Group();
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flameMaterial({ seed, intensity }));
  outer.scale.set(height * 0.62, height, 1);
  outer.position.y = height * 0.42;
  const inner = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flameMaterial({ seed: seed + 3.3, intensity: intensity * 0.9 }));
  inner.scale.set(height * 0.4, height * 0.7, 1);
  inner.position.y = height * 0.3;
  for (const m of [outer, inner]) {
    m.frustumCulled = false;
    m.renderOrder = 5;
    g.add(m);
  }
  g.userData.tick = (t) => {
    outer.material.uniforms.uTime.value = t;
    inner.material.uniforms.uTime.value = t;
  };
  return g;
}
