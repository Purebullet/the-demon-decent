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

import { build } from 'esbuild';
import { readFile, writeFile, mkdir, stat, readdir, copyFile, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, resolve, relative } from 'node:path';
import { makeSounds } from './make-sounds.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = join(root, 'dist');

// Only in the web build: page-only code that Project 0's sandbox must not see.
const WEB_ONLY = new Set(['src/main.js', 'src/platform/browserhost.js']);

const EXPERIENCE = {
  entry: 'main.js',
  name: 'The Demon Descent',
  description:
    'A first-person dark-fantasy roguelike. Step into the pit and fight down twenty floors of caverns: ghouls, chain fiends, flame-horned brutes and two demon lords. One life, no armour; your deepest floor goes on the weekly table.',
  maxPlayers: 8,
  credits: [{ work: 'Game, code, sound and stand-in models', by: 'made for this lot; sounds synthesized in code' }],
};

async function listModels() {
  try {
    return (await readdir(join(root, 'assets/models'))).filter((f) => f.endsWith('.glb')).sort();
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
  const s = await makeSounds(join(to, 'assets/sounds'));
  return { models: models.length, sounds: s.count };
}

async function buildExperience() {
  const out = join(dist, 'experience');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  let files = 0;
  for (const file of await walk(join(root, 'src'))) {
    const rel = relative(root, file);
    if (!rel.endsWith('.js') || WEB_ONLY.has(rel)) continue;
    await mkdir(join(out, rel, '..'), { recursive: true });
    await copyFile(file, join(out, rel));
    files++;
  }
  await writeFile(join(out, 'main.js'), "// Project 0 entry: see src/experience.js.\nimport start from './src/experience.js';\n\nexport default start;\n");
  const models = await listModels();
  const credits = [...EXPERIENCE.credits];
  if (models.length) credits.push({ work: '3D models', by: 'generated with Zoodle (zoodle3d.com) from original concept art' });
  await writeFile(join(out, 'experience.json'), `${JSON.stringify({ ...EXPERIENCE, credits }, null, 2)}\n`);
  const a = await copyAssets(out);
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.png': 'image/png' };

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
