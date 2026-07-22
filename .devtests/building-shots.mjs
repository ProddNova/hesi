/**
 * Elevated shots down each district plus the renderer's draw-call/triangle
 * cost at those spots — the visual half of the building-catalogue check
 * (js/building-types.js). Screenshots to .devtests/shots/.
 *
 * Run: node .devtests/building-shots.mjs [tag]
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };

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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1100, height: 620 }, deviceScaleFactor: 1.5, hasTouch: true });
// three + its addons come from the CDN in index.html; serve the copies in
// node_modules so the probe runs offline (addons keep their own paths — the
// map imports mergeGeometries from BufferGeometryUtils).
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/examples\/jsm\/(.+)$/);
  const file = addon ? `node_modules/three/examples/jsm/${addon[1]}` : 'node_modules/three/build/three.module.js';
  const body = await readFile(join(ROOT, file));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });

const spots = [
  { name: 'c1-canyon', route: 'c1', frac: 0.18, up: 16, back: 34, pitch: -0.12 },
  { name: 'c1-high', route: 'c1', frac: 0.52, up: 120, back: 210, pitch: -0.34 },
  { name: 'r9-mixed', route: 'r9', frac: 0.45, up: 18, back: 36, pitch: -0.14 },
  { name: 'k1-works', route: 'k1', frac: 0.5, up: 22, back: 34, pitch: -0.18 },
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
    g.debug.position.set(lane.position.x - Math.sin(h) * s.back, lane.position.y + s.up, lane.position.z - Math.cos(h) * s.back);
    g.debug.yaw = h;
    g.debug.pitch = s.pitch;
  }, spot);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(OUT, `buildings-${TAG}-${spot.name}.png`) });
  const info = await page.evaluate(() => {
    const render = window.shutoko?.renderer?.info?.render;
    const memory = window.shutoko?.renderer?.info?.memory;
    return render ? { calls: render.calls, triangles: render.triangles, geometries: memory?.geometries, textures: memory?.textures } : null;
  });
  console.log(`${spot.name.padEnd(12)}`, JSON.stringify(info));
  await page.evaluate(() => window.shutoko.setNoclip(false));
}
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
