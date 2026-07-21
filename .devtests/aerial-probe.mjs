/**
 * Elevated "drone" screenshots down a lamp-lit straight so pool coverage and
 * pool-to-pool overlap are actually visible (the chase cam foreshortens them).
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/aerial-probe.mjs [tag]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = process.argv[2] || 'after';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 1100, height: 620 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => window.shutoko.traffic?.setDensity(2));

const spots = [
  { name: 'wangan', route: 'wangan', frac: 0.2, up: 26, back: 30, pitch: -0.42 },
  { name: 'k1', route: 'k1', frac: 0.5, up: 22, back: 26, pitch: -0.4 },
];
for (const spot of spots) {
  await page.evaluate((s) => {
    const g = window.shutoko;
    const route = g.map.getRoute(s.route);
    const lane = g.map.sampleLane(s.route, route.length * s.frac, 0, 1);
    g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    g.physics.setSpeed(0);
    g.snapDrivingCamera();
    g.setNoclip(true);
    const h = lane.heading;
    const fx = Math.sin(h), fz = Math.cos(h);
    g.debug.position.set(lane.position.x - fx * s.back, lane.position.y + s.up, lane.position.z - fz * s.back);
    g.debug.yaw = h;
    g.debug.pitch = s.pitch;
  }, spot);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: join(OUT, `aerial-${TAG}-${spot.name}.png`) });
  await page.evaluate(() => window.shutoko.setNoclip(false));
}
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
