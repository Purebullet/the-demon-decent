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
const edge = Math.min(width, depth) / 2 - 0.5;
await writeFile(
  join(out, 'lot.json'),
  `${JSON.stringify(
    {
      materials: {
        Glow: { surface: 'glow.glsl', glow: 2 },
        Smoke: { vertex: 'fog-vertex.glsl', surface: 'fog.glsl', include: 'fog-common.glsl', transparent: true, doubleSided: false, glow: 0.4, uniforms: { rise: +(height * 0.75).toFixed(2), spread: +(rc * 0.9).toFixed(2) } },
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
  `// Shared by the fog's two stages: where a puff is in its slow climb (0 just
// out of the pit, 1 dissolved high above it). uv.x is the puff's phase.
float fogAge(vec2 uv) {
  return fract(p0Time * 0.045 + uv.x);
}
float fogHash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
`,
);
await writeFile(
  join(out, 'fog-vertex.glsl'),
  `// Each puff climbs out of the pit, drifts outward and swells as it rises,
// its surface churning so it reads as billowing smoke, not a ball.
vec3 p0Vertex(vec3 position, vec3 normal, vec2 uv) {
  float k = fogAge(uv);
  vec3 centre = position - normal * uv.y;
  vec2 out2 = length(centre.xz) > 0.01 ? normalize(centre.xz) : vec2(1.0, 0.0);
  centre.xz += out2 * spread * k * k;
  centre.y += rise * k;
  float churn = 0.75 + 0.35 * sin(p0Time * 0.9 + dot(normal, vec3(5.1, 3.7, 4.3)) + uv.x * 40.0);
  float size = uv.y * (0.55 + 2.6 * k) * churn;
  return centre + normal * size;
}
`,
);
await writeFile(
  join(out, 'fog.glsl'),
  `// Dark smoke lit red from below, soft at its edges, thickest just out of
// the pit and thinning to nothing as it climbs.
void p0Surface(inout P0Surface s) {
  float k = fogAge(s.uv);
  float facing = max(dot(s.normal, s.view), 0.0);
  float edge = smoothstep(0.0, 0.6, facing);
  float life = smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(0.45, 1.0, k));
  s.alpha = 0.62 * edge * life;
  s.color = vec3(0.07, 0.055, 0.06);
  float under = pow(1.0 - k, 3.0) * (0.5 + 0.5 * max(-s.normal.y, 0.0));
  s.emissive = vec3(1.0, 0.22, 0.04) * under * (0.55 + 0.25 * sin(p0Time * 1.4));
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
  `// Now and then the pit spits a gob of lava: it arcs out of the hole, lands
// on the slope around it, cools and sinks away. Throws come from the world
// clock and a hash of the throw number, so every viewer sees the same ones.
const LAVA = 6
const PERIOD = 2.6
const FLIGHT = 1.7
const COOL = 2.2
const PIT = ${rb.toFixed(2)}
const LIP = ${rc.toFixed(2)}
const MOUND = ${hm.toFixed(2)}
const EDGE = ${edge.toFixed(2)}
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
// Height of the slope at distance r from the middle (the mound's profile).
const ground = (r) => {
  if (r <= LIP) return MOUND
  const k = Math.min(1, (r - LIP) / Math.max(0.1, EDGE - LIP))
  return MOUND * Math.pow(1 - k, 1.6) + 0.1
}
export default function build(b) {
  b.loop((dt, t) => {
    for (let i = 0; i < LAVA; i++) {
      // Gob i flies on throws i, i + LAVA, ...; a throw starts every PERIOD s.
      const slot = Math.floor((t / PERIOD - i) / LAVA)
      const n = slot * LAVA + i
      const start = n * PERIOD
      const age = t - start
      const skip = hash(n * 3.1) < 0.35
      if (skip || age < 0 || age > FLIGHT + COOL) {
        b.node('Lava' + i, { scale: [0.001, 0.001, 0.001] })
        continue
      }
      const a = hash(n) * Math.PI * 2
      const from = [Math.cos(a) * PIT * 0.4, 0.4, Math.sin(a) * PIT * 0.4]
      const dist = LIP * (1.05 + hash(n + 7.7) * 0.6)
      const to = [Math.cos(a) * dist, ground(dist), Math.sin(a) * dist]
      const peak = Math.max(to[1], 0) + 5 + hash(n + 2.2) * 6
      if (age <= FLIGHT) {
        const k = age / FLIGHT
        const y = from[1] + (to[1] - from[1]) * k + 4 * (peak - Math.max(from[1], to[1])) * k * (1 - k)
        const s = 1 + 0.25 * Math.sin(age * 18)
        b.node('Lava' + i, { position: [from[0] + (to[0] - from[0]) * k, y, from[2] + (to[2] - from[2]) * k], scale: [s, s * 1.3, s] })
      } else {
        // Landed: splats flat, then cools and sinks.
        const c = (age - FLIGHT) / COOL
        const w = 1.6 * (1 - c * 0.6)
        b.node('Lava' + i, { position: [to[0], to[1] - c * 0.3, to[2]], scale: [w, 0.35 * (1 - c), w] })
      }
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
