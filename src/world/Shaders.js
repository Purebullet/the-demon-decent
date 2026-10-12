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
