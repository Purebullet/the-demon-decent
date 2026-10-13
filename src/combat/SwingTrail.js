import * as THREE from 'three';

// The glowing wake a blade leaves through its arc, drawn in the viewmodel
// scene. Swings are analytic (a great-circle arc in camera space), so the
// ribbon is traced along the arc itself from `kFrom` to `kTo` rather than
// from frame samples: smooth at any frame rate. Its colour and brightness
// say how the swing was made: dull smoke when sluggish, ember for an
// ordinary blow, gold-white and brighter with every link of a Perfect Chain,
// white-hot on a counter.

const N = 28;
const _base = new THREE.Vector3();
const _tip = new THREE.Vector3();

const VERT = /* glsl */ `
attribute float aAlong;
attribute float aSide;
varying float vAlong;
varying float vSide;
void main() {
  vAlong = aAlong;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uEdge;
uniform float uAlpha;
varying float vAlong;
varying float vSide;
void main() {
  // Brightest at the leading edge and toward the tip; gone at the tail.
  float head = pow(vAlong, 1.6);
  float edge = smoothstep(0.0, 0.35, vSide) * (0.55 + 0.45 * vSide);
  float a = head * edge * uAlpha;
  vec3 c = mix(uEdge, uColor, pow(vAlong, 3.0) * vSide);
  gl_FragColor = vec4(c * a, a);
}`;

export class SwingTrail {
  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 2 * 3);
    const along = new Float32Array(N * 2);
    const side = new Float32Array(N * 2);
    const idx = [];
    for (let i = 0; i < N; i++) {
      along[i * 2] = along[i * 2 + 1] = i / (N - 1);
      side[i * 2] = 0;
      side[i * 2 + 1] = 1;
      if (i < N - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uColor: { value: new THREE.Color() }, uEdge: { value: new THREE.Color() }, uAlpha: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    this.fade = 0;
    this.alpha = 0;
  }

  // Trace the arc. `pose(k, base, tip)` fills the blade's inner and outer
  // points (viewmodel space) at arc fraction k.
  trace(kFrom, kTo, pose, style) {
    const span = Math.max(1e-4, kTo - kFrom);
    const p = this.pos;
    for (let i = 0; i < N; i++) {
      pose(kFrom + (span * i) / (N - 1), _base, _tip);
      const o = i * 6;
      p[o] = _base.x;
      p[o + 1] = _base.y;
      p[o + 2] = _base.z;
      p[o + 3] = _tip.x;
      p[o + 4] = _tip.y;
      p[o + 5] = _tip.z;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.material.uniforms.uColor.value.set(style.color);
    this.material.uniforms.uEdge.value.set(style.edge);
    this.alpha = style.glow;
    this.material.uniforms.uAlpha.value = this.alpha;
    this.fade = 1;
    this.mesh.visible = true;
  }

  // After the arc: the wake fades out where it was.
  update(dt) {
    if (!this.mesh.visible) return;
    this.fade -= dt * 7;
    this.material.uniforms.uAlpha.value = this.alpha * Math.max(0, this.fade);
    if (this.fade <= 0) this.mesh.visible = false;
  }
}

// Trail colours by how the swing was made.
export function trailStyle({ perfect, chain, sluggish, heavy, counter, glow }) {
  if (counter) return { color: '#fff4e0', edge: '#ff8a3a', glow: 1.0 };
  if (sluggish) return { color: '#6a5048', edge: '#2a1410', glow: 0.18 };
  if (perfect) return { color: chain >= 4 ? '#fffbe8' : '#ffe08a', edge: chain >= 3 ? '#ff9a2a' : '#ff6a14', glow };
  if (heavy) return { color: '#ff7a3a', edge: '#9a1404', glow: 0.55 };
  return { color: '#ffb070', edge: '#a42808', glow };
}
