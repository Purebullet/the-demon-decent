// Builds the lot's street view into dist/lot/: lod0.glb, lod1.glb, lod2.glb,
// lot.json with its shaders and script, and manifest.json.
//
//   node scripts/make-lot.mjs --width 12 --depth 12 --height 19
//
// Use the lot's real size from `npm run p0 -- me`. The geometry is built in
// a headless browser (Playwright) because its textures are painted on canvas.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
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

// A fresh folder, so no file a past build wrote is published by mistake.
await rm(out, { recursive: true, force: true });
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
const { rc, rb, hm, pool, hole, waves, lavaY } = lods.lod0.dims;
// A gob's splash: it opens as it lands, glows and crusts over, then sinks away.
const SPLAT = 0.15;
const REST = 3;
const FADE = 0.9;
const REACH = 1.7;
const landing = lods.lod0.landing;
const edge = Math.min(width, depth) / 2 - 0.5;
await writeFile(
  join(out, 'lot.json'),
  `${JSON.stringify(
    {
      materials: {
        Glow: { surface: 'glow.glsl', glow: 2 },
        Smoke: { vertex: 'fog-vertex.glsl', surface: 'fog.glsl', include: ['fog-common.glsl'], transparent: true, doubleSided: true, glow: 0.3, uniforms: { rise: +(height * 0.62).toFixed(2), spread: +(rc * 1.1).toFixed(2), puff: 1.6 } },
        Rock: { surface: 'rock.glsl', glow: 1, uniforms: { lip: +rc.toFixed(2), reach: +(rc * 2.1).toFixed(2), mound: +hm.toFixed(2), lake: +lavaY.toFixed(2), pool: +pool.toFixed(2) } },
        Lava: {
          vertex: 'lava-vertex.glsl',
          surface: 'lava.glsl',
          include: ['lava-common.glsl'],
          glow: 1.6,
          uniforms: { pool: +pool.toFixed(2), ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`splash${i}`, [0, 0, 0, -1]])) },
        },
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
  `// The mound and the spires, crags and broken pillars on it are one rock (one
// texture): a shade darker toward the tips, with molten cracks glowing near
// the crater's lip and up the bases of the pieces standing there. 3D noise,
// so the cracks wander across steep faces instead of streaking down them.
float rockHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float rockNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(rockHash(i), rockHash(i + vec3(1.0, 0.0, 0.0)), u.x), mix(rockHash(i + vec3(0.0, 1.0, 0.0)), rockHash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y);
  float b = mix(mix(rockHash(i + vec3(0.0, 0.0, 1.0)), rockHash(i + vec3(1.0, 0.0, 1.0)), u.x), mix(rockHash(i + vec3(0.0, 1.0, 1.0)), rockHash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}
void p0Surface(inout P0Surface s) {
  float r = length(s.position.xz);
  float y = s.position.y;
  // Patches the texture's tile can't repeat under, all a little darker than
  // the rock itself, never lighter: cold basalt, warmer scoria, grit, faint
  // bands across the slopes, and soot settled on the flats.
  float m1 = rockNoise(s.position * 0.13 + 4.0);
  float m2 = rockNoise(s.position * 0.42 + 9.0);
  float m3 = rockNoise(s.position * 1.9 + 2.0);
  vec3 tint = mix(vec3(0.62, 0.6, 0.63), vec3(0.95, 0.82, 0.74), smoothstep(0.3, 0.72, m1 * 0.7 + m2 * 0.3));
  s.color *= tint * (0.85 + 0.2 * m2) * (0.9 + 0.15 * m3);
  s.color *= 1.0 + 0.06 * sin(y * 2.4 + m1 * 9.0);
  float soot = smoothstep(0.8, 0.97, s.normal.y) * smoothstep(0.45, 0.75, m2);
  s.color *= 1.0 - 0.3 * soot;
  s.color *= 1.0 - 0.3 * smoothstep(mound * 1.2, mound * 2.6, y);
  float n = rockNoise(s.position * 1.3) * 0.6 + rockNoise(s.position * 3.7) * 0.4;
  float crack = smoothstep(0.05, 0.0, abs(n - 0.5));
  float near = smoothstep(reach, lip, r) * step(0.2, y) * (1.0 - smoothstep(mound * 1.05, mound * 1.45, y));
  // Heat running down the cracks toward the crater, in slow surges.
  float pulse = 0.65 + 0.35 * sin(p0Time * 1.6 + r * 0.9 + n * 4.0);
  s.emissive += vec3(1.0, 0.2, 0.02) * crack * near * pulse * 1.5;
  // Inside the crater: streams of molten rock pouring down its walls into
  // the lake, each a ribbon that wanders and throbs as it runs.
  float a = atan(s.position.z, s.position.x);
  float inside = (1.0 - smoothstep(lip * 0.95, lip * 1.05, r)) * step(lake - 0.1, y) * (1.0 - smoothstep(mound * 0.9, mound * 1.15, y)) * smoothstep(pool - 0.6, pool - 0.35, r);
  float lane = rockNoise(vec3(a * 4.0, 0.0, 3.1));
  float stream = smoothstep(0.58, 0.72, lane) * inside;
  float run = rockNoise(vec3(a * 9.0, y * 1.6 + p0Time * 1.3, 0.7));
  float hot = smoothstep(0.35, 0.75, run);
  s.emissive += mix(vec3(0.9, 0.12, 0.01), vec3(1.0, 0.55, 0.12), hot) * stream * (0.6 + 1.6 * hot);
  // Inside the lake's rim: the rocks standing in it glow only in a thin band
  // where the melt laps them, and the opening's throat below (in the far
  // view, where it is rock) stays dark.
  float sunk = 1.0 - smoothstep(pool - 0.6, pool - 0.35, r);
  float deep = sunk * (1.0 - smoothstep(lake - 0.45, lake - 0.2, y));
  s.emissive *= 1.0 - deep;
  s.color *= 1.0 - 0.85 * deep;
  s.emissive += vec3(0.9, 0.2, 0.02) * sunk * smoothstep(lake - 0.3, lake - 0.08, y) * (1.0 - smoothstep(lake, lake + 0.25, y)) * 0.7;
  // The lake's light on the crater wall just above it.
  s.emissive += vec3(1.0, 0.25, 0.03) * inside * (1.0 - smoothstep(lake, lake + 1.4, y)) * (0.5 + 0.2 * sin(p0Time * 1.3));
}
`,
);
await writeFile(
  join(out, 'lava-common.glsl'),
  `// Shared by the lava's two stages: noise, the palette, and the splashes.
// The Lava mesh is the lake (a ring at LAKE_Y round the opening), the throat
// under the opening, and a splash laid on the rock round every landing spot.
// The script names the splashes showing now, one per gob in the air:
// splashN = (x, y, z, seconds since it landed), or w < 0 for none.
const float LAKE_Y = ${lavaY.toFixed(2)};
const float HOLE_R = ${hole.toFixed(3)};
const float SPLAT = ${SPLAT.toFixed(2)};
const float REST = ${REST.toFixed(2)};
const float FADE = ${FADE.toFixed(2)};
const float REACH = ${REACH.toFixed(2)};
float lavaHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float lavaNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lavaHash(i), lavaHash(i + vec2(1.0, 0.0)), u.x), mix(lavaHash(i + vec2(0.0, 1.0)), lavaHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float lavaFbm(vec2 p) {
  return lavaNoise(p) * 0.55 + lavaNoise(p * 2.07 + 3.7) * 0.3 + lavaNoise(p * 4.3 - 1.3) * 0.15;
}
// How far the opening reaches at angle a: its edge wanders in and out.
float holeEdge(float a) {
  return HOLE_R * (1.0${waves.map(([f, amp, ph]) => ` + ${amp.toFixed(3)} * sin(${f.toFixed(1)} * a + ${ph.toFixed(3)})`).join('')});
}
// Molten rock by heat: dull red, orange, then yellow-white.
vec3 lavaHot(float heat) {
  vec3 hot = mix(vec3(0.55, 0.03, 0.005), vec3(1.0, 0.28, 0.03), smoothstep(0.2, 0.8, heat));
  return mix(hot, vec3(1.0, 0.75, 0.35), smoothstep(1.05, 1.6, heat));
}
// The showing splash nearest q (no two spots' splashes reach each other).
void lavaNearest(vec4 c, vec2 q, inout vec4 best, inout float bd) {
  if (c.w < 0.0) return;
  float d = distance(q, c.xz);
  if (d < bd) {
    bd = d;
    best = c;
  }
}
vec4 lavaSplash(vec2 q) {
  vec4 best = vec4(0.0, 0.0, 0.0, -1.0);
  float bd = REACH;
  lavaNearest(splash0, q, best, bd);
  lavaNearest(splash1, q, best, bd);
  lavaNearest(splash2, q, best, bd);
  lavaNearest(splash3, q, best, bd);
  lavaNearest(splash4, q, best, bd);
  lavaNearest(splash5, q, best, bd);
  return best;
}
`,
);
await writeFile(
  join(out, 'lava-vertex.glsl'),
  `// A splash stays folded to a point (nothing drawn) until its gob lands:
// then it bursts open over the rock, and at the end sinks into it.
vec3 p0Vertex(vec3 position, vec3 normal, vec2 uv) {
  if (length(position.xz) < pool + 0.3) return position;
  vec4 sp = lavaSplash(position.xz);
  if (sp.w < 0.0) return vec3(0.0, -1.0, 0.0);
  float open = 1.0 - pow(1.0 - clamp(sp.w / SPLAT, 0.0, 1.0), 3.0);
  float fade = clamp((sp.w - SPLAT - REST) / FADE, 0.0, 1.0);
  vec3 p = mix(sp.xyz, position, (0.15 + 0.85 * open) * (1.0 - 0.2 * fade));
  p.y -= fade * 0.12;
  return p;
}
`,
);
await writeFile(
  join(out, 'lava.glsl'),
  `// The lake of fire in the crater: a black crust broken into plates that
// drift in a slow whirl in toward the opening at its middle, molten rock
// blazing through every seam, rings of heat rippling outward, bubbles welling
// up and bursting, and the melt pouring over the opening's lip in falls that
// dim as they drop down the throat into the dark. The flow is two layers
// sliding along the whirl a little way and fading over each other in turn,
// so it moves for ever without winding itself up. Out on the slopes, the
// splashes of the gobs it spits glow, crust over from the edge and go out.

// The crust's pattern at q, carried a distance d along the flow.
float lavaLayer(vec2 q, vec2 flow, float d, float seed) {
  vec2 p = (q - flow * d) * 0.85 + seed;
  vec2 warp = vec2(lavaFbm(p * 0.7 + 1.3), lavaFbm(p * 0.7 + 7.9)) - 0.5;
  return lavaFbm(p + warp * 1.8);
}
// Noise round the opening, seamless all the way round.
float lavaAround(float a, float v, float freq) {
  float w = (a + 3.14159265) / 6.2831853;
  return mix(lavaNoise(vec2(a * freq, v)), lavaNoise(vec2((a - 6.2831853) * freq, v)), w);
}
void lavaLake(inout P0Surface s) {
  vec2 q = s.position.xz;
  float r = max(length(q), 0.001);
  float k = clamp(r / pool, 0.0, 1.0);
  float t = p0Time;
  // Round the opening and in toward it, faster nearer it.
  vec2 flow = (vec2(-q.y, q.x) / r * 0.8 - q / r * 0.45) * (0.5 + 0.9 * (1.0 - k));
  float ph = fract(t * 0.06);
  float ph2 = fract(t * 0.06 + 0.5);
  float n = mix(lavaLayer(q, flow, ph * 3.0, 0.0), lavaLayer(q, flow, ph2 * 3.0, 11.7), abs(1.0 - 2.0 * ph));
  // Seams where the crust breaks, wider toward the opening.
  float seam = 1.0 - smoothstep(0.0, 0.045 + 0.09 * (1.0 - k), abs(n - 0.5));
  float ripple = 0.5 + 0.5 * sin(r * 3.4 - t * 2.2 + n * 4.0);
  // The lip, where the crust tears apart and the melt runs over in streaks.
  float a = atan(q.y, q.x);
  float lip = smoothstep(0.75, 0.0, r - holeEdge(a));
  float pour = lavaAround(a, t * 0.9 + r * 2.0, 1.6);
  float heat = seam * (0.65 + 0.5 * ripple) + lip * (0.35 + 0.75 * smoothstep(0.35, 0.8, pour));
  // Bubbles: a few spots swell bright and burst.
  float b = lavaNoise(q * 1.6 + vec2(t * 0.25, -t * 0.18));
  heat += smoothstep(0.88, 0.97, b) * (0.5 + 0.5 * sin(t * 5.0 + b * 30.0)) * 0.9;
  heat = clamp(heat, 0.0, 1.6);
  // The crust: near black, a dull red warmth rippling across it.
  s.color = vec3(0.03, 0.008, 0.005) * (0.7 + 0.6 * n);
  s.roughness = 0.85;
  s.emissive = lavaHot(heat) * heat * (1.3 + 0.25 * p0Near) + vec3(0.22, 0.025, 0.0) * ripple * (1.0 - seam) * (0.4 + 0.6 * (1.0 - k));
}
// Down the opening: falls of melt over the lip, dimming as they drop, and
// below them only the dark, with the faintest throb of fire far down.
void lavaThroat(inout P0Surface s) {
  vec2 q = s.position.xz;
  float y = s.position.y;
  float t = p0Time;
  float depth = clamp(1.0 - y / LAKE_Y, 0.0, 1.0);
  float lane = lavaAround(atan(q.y, q.x), (y + t * 1.5) * 1.2, 1.4);
  float fall = smoothstep(0.5, 0.8, lane) * exp(-depth * 3.2);
  float heat = fall * 1.4 + exp(-depth * 7.0) * 0.6;
  s.color = vec3(0.012, 0.004, 0.003) * (1.0 - depth);
  s.roughness = 0.95;
  s.emissive = lavaHot(heat) * heat * 1.2;
  float far = 1.0 - clamp(length(q) / (holeEdge(atan(q.y, q.x)) * 1.2), 0.0, 1.0);
  s.emissive += vec3(0.3, 0.025, 0.0) * far * far * step(y, 0.05) * (0.4 + 0.2 * sin(t * 0.9));
}
// A gob's splash on the rock: molten as it lands, a crust closing in from
// its edge as it cools, the cracks in it the last to go dark.
void lavaSplashSurface(inout P0Surface s) {
  vec4 sp = lavaSplash(s.position.xz);
  float g = max(sp.w, 0.0);
  float d = clamp(distance(s.position.xz, sp.xz) / REACH, 0.0, 1.0);
  float rest = clamp((g - SPLAT) / REST, 0.0, 1.0);
  float fade = clamp((g - SPLAT - REST) / FADE, 0.0, 1.0);
  float n = lavaFbm(s.position.xz * 2.6 + sp.xz * 1.7 + vec2(0.0, g * 0.12));
  float seam = 1.0 - smoothstep(0.0, 0.07, abs(n - 0.5));
  float cool = clamp(rest * 1.25 + d * 0.9 - 0.35 + (n - 0.5) * 0.5, 0.0, 1.0);
  float heat = (1.0 - cool) * 1.1 + seam * (1.0 - smoothstep(0.55, 1.0, rest)) * 0.9 + (1.0 - smoothstep(0.0, 0.3, g)) * 0.5;
  heat = clamp(heat * (1.0 - fade), 0.0, 1.7);
  s.color = vec3(0.035, 0.012, 0.008) * (0.7 + 0.6 * n);
  s.roughness = mix(0.35, 0.9, cool);
  s.emissive = lavaHot(heat) * heat * (1.25 + 0.25 * p0Near);
}
void p0Surface(inout P0Surface s) {
  if (length(s.position.xz) > pool + 0.3) lavaSplashSurface(s);
  else if (s.position.y < LAKE_Y - 0.03) lavaThroat(s);
  else lavaLake(s);
}
`,
);
await writeFile(
  join(out, 'build.js'),
  `// Now and then the pit spits a gob of lava: it arcs up out of the opening
// and lands on the slope round it (on one of the measured spots below, which
// every throw reaches without passing through the horns, towers or pillars),
// bursts flat and is gone, and the splash it leaves (laid on the rock there
// when the lot was built) opens, glows, crusts over and sinks away: this
// script tells the Lava shader which splash shows and how old it is. Throws
// come from the world clock and a hash of the throw number, so every viewer
// sees the same ones.
const LAVA = 6
const PERIOD = 2.2
const FLIGHT = 1.6
const BURST = 0.1
const SPLAT = ${SPLAT}
const REST = ${REST}
const FADE = ${FADE}
const PIT = ${rb.toFixed(2)}
// Landing spots, [x, y, z], measured when the lot was built.
const SPOTS = [
${landing.map((s) => '  ' + JSON.stringify(s) + ',').join('\n')}
]
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
const LIFE = FLIGHT + SPLAT + REST + FADE
const GONE = [0.001, 0.001, 0.001]
const NONE = [0, 0, 0, -1]
export default function build(b) {
  b.loop((dt, t) => {
    for (let i = 0; i < LAVA; i++) {
      // Gob i flies on throws i, i + LAVA, ...; a throw starts every PERIOD s.
      const slot = Math.floor((t / PERIOD - i) / LAVA)
      const n = slot * LAVA + i
      const age = t - n * PERIOD
      if (hash(n * 3.1) < 0.3 || age < 0 || age > LIFE || !SPOTS.length) {
        b.node('Lava' + i, { scale: GONE })
        b.uniform('splash' + i, NONE)
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
        b.uniform('splash' + i, NONE)
        continue
      }
      // Landed: the gob bursts flat into its splash.
      const g = age - FLIGHT
      if (g < BURST) {
        const k = g / BURST
        b.node('Lava' + i, { position: [to[0], to[1] + 0.12 * (1 - k), to[2]], scale: [1 + k * 1.4, 1 - k * 0.9, 1 + k * 1.4] })
      } else {
        b.node('Lava' + i, { scale: GONE })
      }
      b.uniform('splash' + i, [to[0], to[1], to[2], g])
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
