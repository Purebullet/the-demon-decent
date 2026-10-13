// Paints the HUD icon atlas: renders every model listed in src/ui/icons.js
// in a headless browser (tools/icons.html) and saves
// assets/icons/atlas.webp (and a .png copy to look at in dist/).
//
//   npm run icons

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
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

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error('page:', m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/tools/icons.html`);
await page.waitForFunction(() => window.ready === true);
const url = await page.evaluate(() => window.makeIcons());
await browser.close();
server.close();

const png = Buffer.from(url.split(',')[1], 'base64');
await mkdir(join(root, 'dist'), { recursive: true });
await mkdir(join(root, 'assets/icons'), { recursive: true });
const pngPath = join(root, 'dist/icons-atlas.png');
await writeFile(pngPath, png);
const webp = join(root, 'assets/icons/atlas.webp');
execFileSync('python3', ['-c', `from PIL import Image; Image.open(${JSON.stringify(pngPath)}).save(${JSON.stringify(webp)}, 'WEBP', quality=88, method=6)`]);
console.log(`assets/icons/atlas.webp ${((await stat(webp)).size / 1024).toFixed(0)} KB (preview: dist/icons-atlas.png)`);
