/**
 * Straight-down shots over a corridor, so which kerb the lamp row stands on is
 * unmistakable: the warm ribbon should hug the OUTER flank of each carriageway
 * and the median gap between the two decks should stay dark.
 *
 * Run: node .devtests/lamp-topdown-shot.mjs [suffix]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const SUFFIX = process.argv[2] ? `-${process.argv[2]}` : '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = createServer(async (request, response) => {
  try {
    const path = request.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
// Split CDN routing: three core vs three/addons (a blanket route hands the
// addons the core file and the world never finishes building).
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const addon = route.request().url().match(/examples\/jsm\/(.+)$/);
  const file = addon ? join(ROOT, 'node_modules/three/examples/jsm', addon[1]) : join(ROOT, 'node_modules/three/build/three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});
const page = await context.newPage();
const errors = [];
page.on('dialog', (dialog) => dialog.accept());
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.setTrafficDisabled(true));
await page.addStyleTag({ content: '#game-shell > :not(#game-canvas) { visibility: hidden !important; }' });

const spots = [
  { name: 'wangan-overhead', route: 'wangan_0', fraction: 0.35, up: 70 },
  { name: 'c1-overhead', route: 'c1_0', fraction: 0.40, up: 70 },
  { name: 'wangan-chase', route: 'wangan_0', fraction: 0.35, chase: true },
];

for (const spot of spots) {
  await page.evaluate((config) => {
    const game = window.shutoko;
    const route = game.map.getRoute(config.route);
    const distance = route.length * config.fraction;
    const lane = game.map.sampleLane(route.id, distance, 0, 1);
    game.setNoclip(false);
    game.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    game.physics.setSpeed(0);
    const frame = game.map._frameAt(route, distance);
    if (config.chase) { game.map.update(lane.position, performance.now() / 1000); game.snapDrivingCamera(); return; }
    game.setNoclip(true);
    game.debug.position.copy(frame.position);
    game.debug.position.y += config.up;
    game.debug.yaw = Math.atan2(frame.tangent.x, frame.tangent.z);
    game.debug.pitch = -1.45;
    game.map.update(frame.position, performance.now() / 1000);
  }, spot);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `L-${spot.name}${SUFFIX}.png`) });
  console.log(`shot L-${spot.name}${SUFFIX}.png`);
}

await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
