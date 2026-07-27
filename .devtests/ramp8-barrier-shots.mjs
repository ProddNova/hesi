/**
 * Visual check for the Ramp 8 tall screen wall.
 *
 * Boots the real game (the player spawns on ramp_8) and shoots the chase view
 * plus two fixed exterior angles of the ramp edge, so the walled ramp can be
 * compared against the shipped parapet look.
 *
 * Needs a server on the repo root: node tools/hesi-editor/server.mjs
 * Run: node .devtests/ramp8-barrier-shots.mjs [--port 8081]
 */
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, '.devtests/shots');
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? process.argv[portArg + 1] : '8081';

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// Split routing: three/addons/ must come from the same node_modules tree, not
// from a blanket redirect to three.module.js (that kills mergeGeometries).
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const file = route.request().url().split(/three@[^/]+\//)[1];
  if (!file) return route.abort();
  const body = await readFile(join(ROOT, 'node_modules/three', file));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (dialog) => dialog.accept());
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

// Explicit /index.html: the editor dev server redirects bare `/` to the editor.
await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 120000 });
// Leave the boot menu: the world exists behind it, but nothing is rendered
// until a run starts (page.on('dialog') accepts the wipe-save confirm).
await page.click('#new-game-button');
// A new game starts inside the garage; drive out so the road scene renders.
await page.waitForTimeout(3000);
await page.evaluate(() => window.shutoko?.exitGarage?.());
await page.waitForFunction(() => window.shutoko?.mode === 'driving', null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);

const info = await page.evaluate(() => {
  const route = window.shutoko.map.routes.get('ramp_8');
  return { length: route.length, frameCount: route.surfaceFrames.length, routeId: window.shutoko.currentRoadInfo?.routeId || null };
});
console.log(`ramp_8 · ${info.length.toFixed(0)} m · ${info.frameCount} surface frames · player on ${info.routeId}`);

// Chase view — the game owns the camera every frame, so this is the honest
// angle to judge the edge from (and it is the one the player actually sees).
await page.waitForTimeout(2500);
await page.screenshot({ path: join(SHOTS, 'ramp8-barrier-chase.png') });

if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
console.log('shot written to .devtests/shots/ramp8-barrier-chase.png');
await browser.close();
