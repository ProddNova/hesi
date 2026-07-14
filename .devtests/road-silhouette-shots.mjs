/**
 * Repeatable chase + elevated road-silhouette screenshots.
 *
 * The Route 11 shot is deliberately high and offset from the carriageway:
 * the long outer deck edge, fascia, paint and parapet expose individual
 * chords much more clearly than the normal chase camera. The C1 and R6
 * shots cover a tight curve and an S-bend with the same camera recipe.
 *
 * Run: node .devtests/road-silhouette-shots.mjs [suffix]
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer(async (request, response) => {
  try {
    const path = request.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
const errors = [];
page.on('dialog', (dialog) => dialog.accept());
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 10000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.evaluate(() => {
  const game = window.shutoko;
  game.setTrafficDisabled(true);
});
await page.addStyleTag({ content: '#game-shell > :not(#game-canvas) { visibility: hidden !important; }' });

const spots = [
  // Daiba-side bridge curve: matches the elevated, oblique failure view.
  { name: 'r11-daiba-broad-curve', route: 'r11_0', distance: 2350, back: 165, side: -105, up: 88, ahead: 55 },
  { name: 'c1-tight-curve', route: 'c1_0', fraction: 0.62, back: 105, side: -58, up: 62, ahead: 42 },
  { name: 'r6-s-bend', route: 'r6_3', distance: 1805, back: 120, side: 64, up: 70, ahead: 48 },
];

for (const spot of spots) {
  const missing = await page.evaluate((config) => {
    const game = window.shutoko;
    let route;
    try { route = game.map.getRoute(config.route); } catch { return config.route; }
    const distance = config.distance ?? route.length * config.fraction;
    if (game.debug.noclip) game.setNoclip(false);
    const lane = game.map.sampleLane(route.id, distance, 0, 1);
    game.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    game.physics.setSpeed(0);
    game.map.update(lane.position, performance.now() / 1000);
    game.snapDrivingCamera();
    return null;
  }, spot);
  if (missing) {
    console.log(`SKIP ${spot.name}: no route ${missing}`);
    continue;
  }
  await page.waitForTimeout(500);
  const chaseFilename = `S-${spot.name}-chase${SUFFIX}.png`;
  await page.screenshot({ path: join(OUT, chaseFilename) });

  await page.evaluate((config) => {
    const game = window.shutoko;
    const route = game.map.getRoute(config.route);
    const distance = config.distance ?? route.length * config.fraction;
    const frame = game.map._frameAt(route, distance);
    const target = game.map._frameAt(route, game.map._normalizeDistance(route, distance + config.ahead)).position;
    game.setNoclip(true);
    game.debug.position.copy(frame.position)
      .addScaledVector(frame.tangent, -config.back)
      .addScaledVector(frame.normal, config.side);
    game.debug.position.y += config.up;
    const look = target.clone().sub(game.debug.position).normalize();
    game.debug.yaw = Math.atan2(look.x, look.z);
    game.debug.pitch = Math.asin(Math.max(-1, Math.min(1, look.y)));
    game.map.update(frame.position, performance.now() / 1000);
  }, spot);
  await page.waitForTimeout(750);
  const filename = `S-${spot.name}${SUFFIX}.png`;
  await page.screenshot({ path: join(OUT, filename) });
  console.log(`shot ${chaseFilename} + ${filename}`);
}

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
