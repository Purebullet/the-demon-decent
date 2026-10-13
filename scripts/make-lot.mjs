// Builds the lot's street view into dist/lot/: lod0.glb, lod1.glb, lod2.glb,
// lot.json with its shaders and script, and manifest.json.
//
//   node scripts/make-lot.mjs --width 12 --depth 12 --height 19
//
// Use the lot's real size from `npm run p0 -- me`. The geometry is built in
// a headless browser (Playwright) because its textures are painted on canvas.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(new URL('..', import.meta.url).pathname);
const out = join(root, 'dist/lot');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const width = arg('width', 12);
const depth = arg('depth', 12);
const height = arg('height', 19);

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const server = createServer(async (req, res) => {
  const file = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error('page:', m.text()); });
await page.goto(`http://127.0.0.1:${port}/tools/lot.html`);
await page.waitForFunction(() => window.ready === true);
const lods = await page.evaluate((d) => window.buildLot(d), { width, depth, height });
await browser.close();
server.close();

await mkdir(out, { recursive: true });
const inside = (s) =>
  s.min[0] >= -width / 2 - 1e-3 && s.max[0] <= width / 2 + 1e-3 && s.min[2] >= -depth / 2 - 1e-3 && s.max[2] <= depth / 2 + 1e-3 && s.min[1] >= -1e-3 && s.max[1] <= height + 1e-3;
for (const [name, l] of Object.entries(lods)) {
  const buf = Buffer.from(l.glb, 'base64');
  await writeFile(join(out, `${name}.glb`), buf);
  const s = l.stats;
  console.log(`${name}.glb  ${(buf.length / 1024).toFixed(0)} KB  ${s.tris} tris  ${s.draws} draws  ${s.materials.join('/')}  box ${s.min} .. ${s.max} ${inside(s) ? 'inside the lot' : 'OUTSIDE THE LOT'}`);
  if (!inside(s)) process.exitCode = 1;
}

// Live build: the pit pulses with hellfire, cracks glow near the lip, fog
// billows up out of the hole and lava spits out of it onto the slopes, all
// on the world clock so every viewer sees the same.
const { rc, rb, hm } = lods.lod0.dims;
const landing = lods.lod0.landing;
const edge = Math.min(width, depth) / 2 - 0.5;
await writeFile(
  join(out, 'lot.json'),
  `${JSON.stringify(
    {
      materials: {
        Glow: { surface: 'glow.glsl', glow: 2 },
        Smoke: { vertex: 'fog-vertex.glsl', surface: 'fog.glsl', include: ['fog-common.glsl'], transparent: true, doubleSided: true, glow: 0.3, uniforms: { rise: +(height * 0.62).toFixed(2), spread: +(rc * 1.1).toFixed(2), puff: 1.6 } },
        Rock: { surface: 'rock.glsl', glow: 1, uniforms: { lip: +rc.toFixed(2), reach: +(rc * 2.1).toFixed(2), mound: +hm.toFixed(2) } },
      },
      script: 'build.js',
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  join(out, 'fog-common.glsl'),
  `// Shared by the fog's two stages. Each puff is four crossed quads; a
// vertex's UV is its quad corner (whole part) plus the puff's phase
// (fraction). vLocal is the corner (0..1) for the soft round edge, vAge the
// puff's age through its climb (0 out of the pit, 1 gone).
varying vec2 vLocal;
varying float vAge;
varying float vSeed;
float fogHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float fogNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fogHash(i), fogHash(i + vec2(1.0, 0.0)), u.x), mix(fogHash(i + vec2(0.0, 1.0)), fogHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`,
);
await writeFile(
  join(out, 'fog-vertex.glsl'),
  `// Puffs climb out of the pit slowly, swelling and drifting outward and
// turning as they rise, then thin away; the cycle repeats on the world clock.
vec3 p0Vertex(vec3 position, vec3 normal, vec2 uv) {
  float phase = fract(uv.x);
  vec2 corner = vec2(floor(uv.x + 0.001), floor(uv.y + 0.5));
  vec3 n = normalize(normal);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 t = abs(n.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : normalize(cross(up, n));
  vec3 b = abs(n.y) > 0.9 ? vec3(0.0, 0.0, -1.0) : up;
  vec3 offset = t * (corner.x - 0.5) + b * (corner.y - 0.5);
  vec3 centre = position - offset * puff;
  float k = fract(p0Time * 0.038 + phase);
  vAge = k;
  vLocal = corner;
  vSeed = phase * 37.0;
  vec2 dir = length(centre.xz) > 0.01 ? normalize(centre.xz) : vec2(cos(phase * 40.0), sin(phase * 40.0));
  centre.xz += dir * spread * k * (0.6 + 0.4 * k);
  centre.y += rise * k * (0.8 + 0.2 * k);
  // Turn the puff slowly so its quads never line up edge-on for long.
  float a = p0Time * 0.12 + phase * 6.28;
  mat2 r = mat2(cos(a), -sin(a), sin(a), cos(a));
  offset.xz = r * offset.xz;
  float size = puff * (1.0 + 4.2 * k);
  return centre + offset * size;
}
`,
);
await writeFile(
  join(out, 'fog.glsl'),
  `// Soft, torn edges of dark smoke, lit red from the pit beneath while it is
// low, thinning to nothing as it climbs.
void p0Surface(inout P0Surface s) {
  vec2 c = vLocal - 0.5;
  float d = length(c) * 2.0;
  float n = fogNoise(vLocal * 3.0 + vec2(vSeed, p0Time * 0.15)) * 0.65 + fogNoise(vLocal * 7.0 - vec2(p0Time * 0.2, vSeed)) * 0.35;
  float shape = smoothstep(1.0, 0.25, d + (n - 0.5) * 0.7);
  float life = smoothstep(0.0, 0.1, vAge) * (1.0 - smoothstep(0.5, 1.0, vAge));
  s.alpha = shape * life * (0.32 + 0.25 * n);
  s.color = vec3(0.055, 0.045, 0.05);
  float glow = pow(1.0 - vAge, 2.5);
  s.emissive = vec3(0.9, 0.16, 0.03) * glow * (0.35 + 0.5 * n) * (0.8 + 0.2 * sin(p0Time * 1.3 + vSeed));
}
`,
);
await writeFile(
  join(out, 'glow.glsl'),
  `// Hellfire: bands of heat climbing the vortex, pulsing with the world clock.
void p0Surface(inout P0Surface s) {
  float band = pow(0.5 + 0.5 * sin(s.position.y * 1.3 - p0Time * 2.2), 4.0);
  float pulse = 0.78 + 0.22 * sin(p0Time * 1.4) + p0Near * 0.25;
  vec3 hot = mix(vec3(1.0, 0.22, 0.03), vec3(1.0, 0.72, 0.3), band);
  s.color = vec3(0.05, 0.01, 0.0);
  s.emissive = hot * (0.9 + band * 1.6) * pulse;
}
`,
);
await writeFile(
  join(out, 'rock.glsl'),
  `// Molten cracks in the rock, brightest at the crater's lip.
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
void p0Surface(inout P0Surface s) {
  float r = length(s.position.xz);
  float n = vnoise(s.position.xz * 1.3) * 0.6 + vnoise(s.position.xz * 3.7 + s.position.y) * 0.4;
  float crack = smoothstep(0.06, 0.0, abs(n - 0.5));
  float near = smoothstep(reach, lip, r) * step(0.2, s.position.y) * (1.0 - smoothstep(mound * 1.2, mound * 1.6, s.position.y));
  float pulse = 0.7 + 0.3 * sin(p0Time * 1.4 - r * 0.8);
  s.emissive += vec3(1.0, 0.2, 0.02) * crack * near * pulse * 1.6;
}
`,
);
await writeFile(
  join(out, 'build.js'),
  `// Now and then the pit spits a gob of lava: it arcs out of the hole and
// lands on the slope around it (on one of the measured spots below, so it
// sits exactly on the rock), splats, smoulders there for a few seconds and
// shrinks away. Throws come from the world clock and a hash of the throw
// number, so every viewer sees the same ones.
const LAVA = 6
const PERIOD = 2.2
const FLIGHT = 1.6
const SPLAT = 0.15
const REST = 2.6
const FADE = 0.7
const PIT = ${rb.toFixed(2)}
// Landing spots on the slopes, [x, y, z], measured when the lot was built.
const SPOTS = [
${landing.map((s) => '  ' + JSON.stringify(s) + ',').join('\n')}
]
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
const LIFE = FLIGHT + SPLAT + REST + FADE
export default function build(b) {
  b.loop((dt, t) => {
    for (let i = 0; i < LAVA; i++) {
      // Gob i flies on throws i, i + LAVA, ...; a throw starts every PERIOD s.
      const slot = Math.floor((t / PERIOD - i) / LAVA)
      const n = slot * LAVA + i
      const age = t - n * PERIOD
      if (hash(n * 3.1) < 0.3 || age < 0 || age > LIFE || !SPOTS.length) {
        b.node('Lava' + i, { scale: [0.001, 0.001, 0.001] })
        continue
      }
      const to = SPOTS[Math.floor(hash(n) * SPOTS.length)]
      const a = Math.atan2(to[2], to[0])
      const from = [Math.cos(a) * PIT * 0.4, 0.4, Math.sin(a) * PIT * 0.4]
      const peak = Math.max(to[1], 0) + 5 + hash(n + 2.2) * 6
      if (age <= FLIGHT) {
        const k = age / FLIGHT
        const y = from[1] + (to[1] - from[1]) * k + 4 * (peak - Math.max(from[1], to[1])) * k * (1 - k)
        const s = 1 + 0.25 * Math.sin(age * 18)
        b.node('Lava' + i, { position: [from[0] + (to[0] - from[0]) * k, y, from[2] + (to[2] - from[2]) * k], scale: [s, s * 1.3, s] })
        continue
      }
      // On the ground: a quick splat, a puddle that smoulders and slowly
      // shrinks, then goes out.
      const g = age - FLIGHT
      let w
      let hgt
      if (g < SPLAT) {
        const k = g / SPLAT
        w = 1 + k * 0.9
        hgt = 1 - k * 0.7
      } else if (g < SPLAT + REST) {
        const k = (g - SPLAT) / REST
        w = 1.9 - k * 0.4 + Math.sin(g * 6) * 0.03
        hgt = 0.3 - k * 0.08
      } else {
        const k = (g - SPLAT - REST) / FADE
        w = 1.5 * (1 - k)
        hgt = 0.22 * (1 - k)
      }
      b.node('Lava' + i, { position: [to[0], to[1] + 0.02, to[2]], scale: [Math.max(0.001, w), Math.max(0.001, hgt), Math.max(0.001, w)] })
    }
  })
}
`,
);
await writeFile(
  join(out, 'manifest.json'),
  `${JSON.stringify(
    {
      name: 'The Demon Descent',
      description: 'A hell-mouth torn open in the city. Enter and fight down twenty floors of caverns: gaunt stalkers, shadow fiends, pyre witches, hellhounds, flame-horned brutes and two demon lords. One life; your deepest floor goes on the weekly table.',
    },
    null,
    2,
  )}\n`,
);
console.log(`lot.json, shaders, build.js and manifest.json -> dist/lot (${width} x ${depth} x ${height} m)`);
