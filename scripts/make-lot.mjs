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

// Live build: the pit and vortex pulse with hellfire, cracks glow near the
// lip, the vortex and the embers turn on the world clock.
const { rc, hm } = lods.lod0.dims;
await writeFile(
  join(out, 'lot.json'),
  `${JSON.stringify(
    {
      materials: {
        Glow: { surface: 'glow.glsl', glow: 2 },
        Rock: { surface: 'rock.glsl', glow: 1, uniforms: { lip: +rc.toFixed(2), reach: +(rc * 2.1).toFixed(2), mound: +hm.toFixed(2) } },
      },
      script: 'build.js',
    },
    null,
    2,
  )}\n`,
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
  `// The hellfire vortex turns and the embers circle it, the same for every viewer.
export default function build(b) {
  b.loop((dt, t) => {
    b.node('Vortex', { rotation: [0, t * 0.6, 0] })
    b.node('Embers', { rotation: [0, -t * 0.25, 0] })
  })
}
`,
);
await writeFile(
  join(out, 'manifest.json'),
  `${JSON.stringify(
    {
      name: 'The Demon Descent',
      description: 'A hell-mouth torn open in the city. Enter and fight down twenty floors of caverns: ghouls, chain fiends, flame-horned brutes and two demon lords. One life; your deepest floor goes on the weekly table.',
    },
    null,
    2,
  )}\n`,
);
console.log(`lot.json, shaders, build.js and manifest.json -> dist/lot (${width} x ${depth} x ${height} m)`);
