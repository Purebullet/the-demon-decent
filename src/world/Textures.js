import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

// All textures are painted at runtime on canvases, so the game ships with no
// image assets and loads instantly. Results are cached by key.

const cache = new Map();

function cached(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

// A 2D canvas in a page, or an OffscreenCanvas inside Project 0's worker.
export function makeCanvas(w, h = w) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function canvas(size) {
  return makeCanvas(size);
}

// Value noise whose lattice wraps at `period`, so the textures tile.
function tileNoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (a, b) => {
    a = ((a % period) + period) % period;
    b = ((b % period) + period) % period;
    let n = (a * 374761393 + b * 668265263 + seed * 1442695041) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function tileFbm(x, y, period, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += tileNoise(x * f, y * f, p, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
    p *= 2;
  }
  return sum / norm;
}

// Ridged noise gives crack-like valleys.
function ridge(x, y, period, seed) {
  const n = tileFbm(x, y, period, 3, seed);
  return 1 - Math.abs(n * 2 - 1);
}

function paint(size, fn) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a = 255] = fn(x / size, y / size);
      const i = (y * size + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function toTexture(c, { repeat = 1, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Dark volcanic rock: albedo + matching bump map.
export function rockTextures(seed = 1, tint = [58, 50, 48]) {
  return cached(`rock${seed}${tint}`, () => {
    const P = 6;
    const field = (u, v) => {
      const n = tileFbm(u * P, v * P, P, 5, seed);
      const cr = ridge(u * P * 1.5, v * P * 1.5, P * 1.5, seed + 7);
      return { n, crack: Math.pow(cr, 10) };
    };
    const albedo = paint(256, (u, v) => {
      const { n, crack } = field(u, v);
      const k = 0.55 + n * 0.8 - crack * 0.55;
      return [tint[0] * k, tint[1] * k, tint[2] * k];
    });
    const bump = paint(256, (u, v) => {
      const { n, crack } = field(u, v);
      const h = Math.max(0, Math.min(1, n - crack * 0.6)) * 255;
      return [h, h, h];
    });
    return { map: toTexture(albedo), bump: toTexture(bump, { srgb: false }) };
  });
}

// Glowing vein map (black with molten cracks) for emissive channels.
export function emberVeinTexture(seed = 3, color = [255, 90, 20], sharpness = 14) {
  return cached(`vein${seed}${color}${sharpness}`, () => {
    const P = 4;
    const c = paint(256, (u, v) => {
      const cr = Math.pow(ridge(u * P, v * P, P, seed), sharpness);
      const w = tileFbm(u * P * 2, v * P * 2, P * 2, 2, seed + 3);
      const k = Math.min(1, cr * (0.6 + w));
      return [color[0] * k, color[1] * k, color[2] * k];
    });
    return toTexture(c);
  });
}

// Soft round sprite for particles and glows.
export function softDotTexture() {
  return cached('dot', () => {
    const c = canvas(64);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return toTexture(c, { srgb: false });
  });
}

// Billowing fog puff (alpha in the red channel is duplicated to all).
export function fogPuffTexture(seed = 11) {
  return cached(`fog${seed}`, () => {
    const c = paint(128, (u, v) => {
      const dx = u - 0.5;
      const dy = v - 0.5;
      const falloff = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2);
      const n = tileFbm(u * 4, v * 4, 4, 4, seed);
      const a = Math.pow(falloff, 1.6) * (0.35 + n * 0.9);
      return [255, 255, 255, Math.min(255, a * 255)];
    });
    const t = toTexture(c, { srgb: false });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

// Summoning circle with runes, for the Magic Circle node and portals.
export function runeCircleTexture(color = '#b04dff') {
  return cached(`rune${color}`, () => {
    const S = 512;
    const c = canvas(S);
    const ctx = c.getContext('2d');
    const r = mulberry32(42);
    ctx.translate(S / 2, S / 2);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 6;
    for (const rad of [240, 205, 120]) {
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Pentagram.
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + ((i * 2) % 5) * ((Math.PI * 2) / 5);
      const x = Math.cos(a) * 200;
      const y = Math.sin(a) * 200;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Glyph ring.
    ctx.lineWidth = 3;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.save();
      ctx.rotate(a);
      ctx.translate(0, -222);
      ctx.beginPath();
      const strokes = 2 + Math.floor(r() * 3);
      for (let s = 0; s < strokes; s++) {
        ctx.moveTo((r() - 0.5) * 18, (r() - 0.5) * 18);
        ctx.lineTo((r() - 0.5) * 18, (r() - 0.5) * 18);
      }
      ctx.stroke();
      ctx.restore();
    }
    const t = toTexture(c, { srgb: true });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

// Text panel (obelisk inscription). Not cached: content changes.
export function textTexture(lines, { width = 512, height = 512, color = '#ff5a2a', bg = '#120808' } = {}) {
  const c = makeCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = color;
  let y = height / 2 - ((lines.length - 1) * 60) / 2;
  for (const line of lines) {
    ctx.font = `${line.size || 44}px Georgia, 'Times New Roman', serif`;
    ctx.fillText(line.text, width / 2, y);
    y += line.gap || 60;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
