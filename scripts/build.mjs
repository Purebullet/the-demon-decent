// Build: bundles the game into one self-contained dist/index.html (no
// external requests, no asset files), ready to upload to a Project 0 lot or
// any static host.
// Dev:   `npm run dev` serves the repo as-is (ES modules + import map) on
//        http://localhost:5173 so edits show on reload.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir, stat, readdir, copyFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);

async function bundle() {
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
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await mkdir(join(root, 'dist/assets/models'), { recursive: true });
  await writeFile(join(root, 'dist/index.html'), html);
  console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB`);
  // Generated models ship next to the page; index.json tells the game which exist.
  const models = await listModels();
  for (const f of models) await copyFile(join(root, 'assets/models', f), join(root, 'dist/assets/models', f));
  await writeFile(join(root, 'dist/assets/models/index.json'), JSON.stringify(models));
  console.log(`dist/assets/models  ${models.length} model file(s)`);
}

async function listModels() {
  try {
    return (await readdir(join(root, 'assets/models'))).filter((f) => f.endsWith('.glb')).sort();
  } catch {
    return [];
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function serve(port = 5173) {
  createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/assets/models/index.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(await listModels()));
      return;
    }
    let file = normalize(join(root, url === '/' ? 'index.html' : url));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }).listen(port, () => console.log(`The Demon Descent: http://localhost:${port}  (add ?floor=10 to jump to a floor)`));
}

if (process.argv.includes('--serve')) serve(Number(process.env.PORT) || 5173);
else await bundle();
