// Builds the game two ways:
//
//   dist/experience/  + dist/experience.zip   the Project 0 package: readable
//       ES modules (Project 0 bundles them itself), experience.json, the
//       generated models and the synthesized sounds.
//   dist/web/index.html                       a single-file page for any host.
//
//   node scripts/build.mjs             build both
//   node scripts/build.mjs --serve     dev page on http://localhost:5173
//   node scripts/build.mjs --devkit    build the package and serve it with CORS
//                                      on :5500 for Project 0's dev kit
//
// The packaging build refuses to run while any creature is missing its
// generated model (it would ship as a grey block); --allow-missing overrides
// that for a test build. The dev page and the dev kit only warn.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir, stat, readdir, copyFile, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, resolve, relative } from 'node:path';
import { makeSounds } from './make-sounds.mjs';
import { CHARACTERS, PROPS } from '../src/assets/manifest.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = join(root, 'dist');

// Only in the web build: page-only code that Project 0's sandbox must not see.
const WEB_ONLY = new Set(['src/main.js', 'src/platform/browserhost.js']);

const EXPERIENCE = {
  entry: 'main.js',
  name: 'The Demon Descent',
  description:
    'A first-person dark-fantasy roguelike of rhythm and steel. Step into the pit and fight down twenty floors of caverns: gaunt stalkers, shadow fiends, pyre witches, hellhounds, flame-horned brutes and two demon lords. Time your strikes into Perfect Chains, counter their wind-ups, break their guards, and hunt cursed relics. One life, no armour; your deepest floor goes on the weekly table.',
  maxPlayers: 8,
  credits: [
    { work: 'Game, code, sound and stand-in models', by: 'made for this lot; sounds synthesized in code' },
    { work: 'Music: "Infernal Crescendo" and "Blood in the Arena"', by: "provided by PureBullet, the lot's owner" },
  ],
};

async function listModels() {
  try {
    // lot-*.glb are for the street view only (scripts/make-lot.mjs); icon-*.glb
    // and relic-*.glb only for painting the HUD icons (npm run icons).
    return (await readdir(join(root, 'assets/models'))).filter((f) => f.endsWith('.glb') && !/^(lot|icon|relic)-/.test(f)).sort();
  } catch {
    return [];
  }
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function copyAssets(to) {
  const models = await listModels();
  await mkdir(join(to, 'assets/models'), { recursive: true });
  for (const f of models) await copyFile(join(root, 'assets/models', f), join(to, 'assets/models', f));
  await writeFile(join(to, 'assets/models/index.json'), JSON.stringify(models));
  await mkdir(join(to, 'assets/icons'), { recursive: true });
  await copyFile(join(root, 'assets/icons/atlas.webp'), join(to, 'assets/icons/atlas.webp'));
  const s = await makeSounds(join(to, 'assets/sounds'));
  // The songs, as they came.
  await mkdir(join(to, 'assets/music'), { recursive: true });
  for (const f of await readdir(join(root, 'assets/music'))) if (f.endsWith('.mp3')) await copyFile(join(root, 'assets/music', f), join(to, 'assets/music', f));
  return { models: models.length, sounds: s.count };
}

async function buildExperience() {
  const out = join(dist, 'experience');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  let files = 0;
  for (const file of await walk(join(root, 'src'))) {
    const rel = relative(root, file);
    // src/lot builds the street view (scripts/make-lot.mjs); the game never loads it.
    if (!rel.endsWith('.js') || WEB_ONLY.has(rel) || rel.startsWith('src/lot/')) continue;
    await mkdir(join(out, rel, '..'), { recursive: true });
    await copyFile(file, join(out, rel));
    files++;
  }
  await writeFile(join(out, 'main.js'), "// Project 0 entry: see src/experience.js.\nimport start from './src/experience.js';\n\nexport default start;\n");
  const models = await listModels();
  const credits = [...EXPERIENCE.credits];
  if (models.length) credits.push({ work: '3D models', by: 'generated with Zoodle (zoodle3d.com); creatures rigged and animated in code' });
  await writeFile(join(out, 'experience.json'), `${JSON.stringify({ ...EXPERIENCE, credits }, null, 2)}\n`);
  const a = await copyAssets(out);
  // Sound effects as MP3 (the looping drone stays WAV), and the game told so.
  const sounds = join(out, 'assets/sounds');
  for (const f of await readdir(sounds)) {
    if (!f.endsWith('.wav') || f === 'drone.wav') continue;
    const mp3 = join(sounds, f.replace(/\.wav$/, '.mp3'));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(sounds, f), '-ac', '1', '-b:a', '96k', mp3]);
    await rm(join(sounds, f));
  }
  await writeFile(join(out, 'src/core/soundFormat.js'), (await readFile(join(out, 'src/core/soundFormat.js'), 'utf8')).replace("SOUND_EXT = 'wav'", "SOUND_EXT = 'mp3'"));
  // PNG textures inside the models as JPEG: half the download. Cave scenery,
  // only ever seen by torchlight, also drops to 512 px textures; creatures,
  // weapons and the things you walk up to keep 1024.
  const close = new Set(['torch', 'potion', 'chest', 'gate', 'throne', 'statue', ...Object.keys(PROPS).filter((id) => PROPS[id].weapon)]);
  const small = Object.entries(PROPS).filter(([id, p]) => !close.has(id) && !p.lot && !p.icon && !p.relic).map(([, p]) => p.model.split('/').pop());
  execFileSync('python3', [join(root, 'scripts/shrink-textures.py'), `--small=${small.join(',')}`, join(out, 'assets/models')], { stdio: 'inherit' });
  await rm(join(dist, 'experience.zip'), { force: true });
  execFileSync('zip', ['-qr', join(dist, 'experience.zip'), '.'], { cwd: out });
  const zipSize = (await stat(join(dist, 'experience.zip'))).size;
  console.log(`dist/experience/  ${files + 1} modules, ${a.models} models, ${a.sounds} sounds; experience.zip ${(zipSize / 1024).toFixed(0)} KB`);
}

async function buildWeb() {
  const out = join(dist, 'web');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const result = await build({
    entryPoints: [join(root, 'src/main.js')],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2020',
    write: false,
    legalComments: 'none',
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  let html = await readFile(join(root, 'index.html'), 'utf8');
  html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
  html = html.replace('<script type="module" src="./src/main.js"></script>', () => `<script type="module">${js}</script>`);
  await writeFile(join(out, 'index.html'), html);
  const a = await copyAssets(out);
  console.log(`dist/web/index.html  ${(html.length / 1024).toFixed(0)} KB, ${a.models} models, ${a.sounds} sounds`);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.png': 'image/png', '.webp': 'image/webp' };

function serve(dir, port, { cors = false, dynamicIndex = false } = {}) {
  createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const headers = { 'Cache-Control': 'no-store', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) };
    if (dynamicIndex && url === '/assets/models/index.json') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await listModels()));
      return;
    }
    let file = normalize(join(dir, url === '/' ? 'index.html' : url));
    if (!file.startsWith(dir)) {
      res.writeHead(403, headers).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, headers).end('Not found');
    }
  }).listen(port, '127.0.0.1');
}

async function missingCreatures() {
  const missing = [];
  for (const [id, c] of Object.entries(CHARACTERS)) {
    try {
      await stat(join(root, c.model));
    } catch {
      missing.push(id);
    }
  }
  return missing;
}

const missing = await missingCreatures();
if (missing.length) {
  const msg = `No generated model yet for: ${missing.join(', ')} (npm run zoodle -- pull, then npm run rig).`;
  const packaging = !process.argv.includes('--serve') && !process.argv.includes('--devkit');
  if (packaging && !process.argv.includes('--allow-missing')) {
    console.error(`${msg}\nRefusing to package the game with placeholder blocks; add --allow-missing for a test build.`);
    process.exit(1);
  }
  console.warn(`${msg} They show as grey blocks.`);
}

if (process.argv.includes('--serve')) {
  await makeSounds(join(root, 'assets/sounds'));
  serve(root, Number(process.env.PORT) || 5173, { dynamicIndex: true });
  console.log('The Demon Descent: http://localhost:5173  (add ?floor=10 to jump to a floor; scores are not recorded)');
} else if (process.argv.includes('--devkit')) {
  await buildExperience();
  serve(join(dist, 'experience'), 5500, { cors: true });
  console.log('Open https://project0.city/devkit?entry=http://localhost:5500/main.js&width=24&depth=24&height=19');
} else {
  await buildExperience();
  await buildWeb();
}
