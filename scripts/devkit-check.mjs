// Runs dist/experience in Project 0's dev kit (the real sandbox) and reports
// whether it starts, its errors, frame times and the console, with
// screenshots in dist/devkit/. Software rendering, like Project 0's review.
//
//   npm run devkit            (in another terminal: serves the package on :5500)
//   node scripts/devkit-check.mjs --width 12 --depth 12 --height 19

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const [w, d, h] = [arg('width', 12), arg('depth', 12), arg('height', 19)];
const out = new URL('../dist/devkit/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, permissions: ['local-network-access'] });
const page = await ctx.newPage();
await page.goto(`https://project0.city/devkit?entry=http://localhost:5500/main.js&width=${w}&depth=${d}&height=${h}&players=1`, { timeout: 90000 });
const status = await page.evaluate(() => devkit.wait());
console.log('status:', status);
const device = page.locator('#device');
const report = async (label) => {
  const o = await page.evaluate(() => ({ errors: devkit.errors, frames: devkit.frames, console: devkit.console }));
  const f = o.frames || {};
  console.log(`[${label}] fps ${f.fps} avg ${f.avg} ms p95 ${f.p95} worst ${f.worst} over250 ${f.over250}`);
  if (o.errors?.length) console.log('errors:', JSON.stringify(o.errors).slice(0, 3000));
  await device.screenshot({ path: `${out}${label}.png` });
};
await page.waitForTimeout(4000);
await report('1-title');
if (status === 'started') {
  await page.evaluate(() => devkit.press('KeyW', 100));
  await page.waitForTimeout(5000);
  await report('2-surface');
  // Walk into the pit (slow in software rendering, so hold W a while).
  await page.evaluate(() => devkit.press('KeyW', 22000));
  await page.waitForTimeout(26000);
  await report('3-floor');
  console.log((await page.evaluate(() => devkit.console)).filter((l) => l.startsWith('log:') || l.startsWith('error')).join('\n'));
  console.log('review run:', JSON.stringify(await page.evaluate(() => devkit.review(14))).slice(0, 1500));
}
await browser.close();
